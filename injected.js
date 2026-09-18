/* =====================================================
   YouTube Super Comments - Injected Script (world: MAIN)
   Roda no contexto da PÁGINA (acessa window.*, fetch, XHR).

   Estratégia dupla ultra-resiliente:
   1. PROATIVA:
      - Extrai o token de comentários de ytInitialData OU
      - Consulta diretamente /youtubei/v1/next com videoId para obter
        o token atualizado mesmo em navegações SPA (sem recarregar página).
      - Utiliza caminhos relativos (/youtubei/v1/next) com credentials: 'same-origin'
        para evitar bloqueios de CORS em qualquer domínio (youtube.com / www.youtube.com).
      - Busca até 50 páginas de comentários em segundo plano.
      - Armazena comentários em cache por videoId e responde
        imediatamente a requisições do content.js (evita perda de mensagens).
   2. PASSIVA:
      - Intercepta fetch/XHR do YouTube — captura tanto comentários
        carregados por rolagem quanto tokens de watch-next.
   ===================================================== */

(function () {
  'use strict';

  const TAG        = '[YTSuperComments]';
  const SOURCE     = 'yt-super-comments-injected';
  const MAX_PAGES   = 50;   // páginas (~1000 comentários)
  const PAGE_DELAY  = 100;  // ms entre páginas
  const MAX_CACHE_VIDEOS = 10;

  // Garante referência nativa e vinculada ao window desde o início do script
  const _origFetch = window.fetch ? window.fetch.bind(window) : null;
  const _origOpen  = XMLHttpRequest.prototype.open;
  const _origSend  = XMLHttpRequest.prototype.send;

  // Cache de comentários por videoId: videoId -> Array<comment>
  const _videoComments = new Map();
  let _activeFetchVideoId = null;
  let _isFetching = false;

  // ─── Helpers ──────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function currentVideoId() {
    try {
      return new URL(location.href).searchParams.get('v') || '';
    } catch {
      return '';
    }
  }

  function getApiKey() {
    try {
      return window.ytcfg?.get?.('INNERTUBE_API_KEY')
          || window.ytcfg?.data_?.INNERTUBE_API_KEY
          || '';
    } catch {
      return '';
    }
  }

  function getClientCtx() {
    try {
      const cfg = window.ytcfg?.get?.('INNERTUBE_CONTEXT')?.client;
      if (cfg && cfg.clientName) return cfg;
      const d = window.ytcfg?.data_ || {};
      return {
        clientName:    d.INNERTUBE_CONTEXT_CLIENT_NAME    || 'WEB',
        clientVersion: d.INNERTUBE_CONTEXT_CLIENT_VERSION  || '2.20240918.00.00',
        hl:            d.HL  || 'pt',
        gl:            d.GL  || 'BR',
      };
    } catch {
      return { clientName: 'WEB', clientVersion: '2.20240918.00.00', hl: 'pt', gl: 'BR' };
    }
  }

  /**
   * Decodifica base64/base64url do token de continuação para verificar
   * com 100% de certeza se o token pertence ao videoId solicitado.
   */
  function tokenBelongsToVideo(token, videoId) {
    if (!token || !videoId) return false;
    try {
      let b64 = decodeURIComponent(token).replace(/-/g, '+').replace(/_/g, '/');
      const rem = b64.length % 4;
      if (rem) b64 += '='.repeat(4 - rem);
      const raw = atob(b64);
      return raw.includes(videoId);
    } catch {
      return false;
    }
  }

  /**
   * Chamada segura para a InnerTube API do YouTube.
   * Utiliza URL relativa para garantir que seja same-origin (sem erro de CORS),
   * credenciais de mesma origem e headers padrão do cliente YouTube.
   */
  async function callInnerTubeApi(body) {
    const client = getClientCtx();
    const apiKey = getApiKey();
    const url = '/youtubei/v1/next?prettyPrint=false' + (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');

    const fetchFn = _origFetch || window.fetch.bind(window);
    return fetchFn(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': client.clientVersion || '2.20240918.00.00',
        'X-YTSC-Internal': '1',
      },
      body: JSON.stringify({
        context: { client },
        ...body,
      }),
    });
  }

  // ─── Token extractors ─────────────────────────────────

  /**
   * Busca recursivamente um token de continuação dentro de um objeto/nó.
   */
  function findContinuationToken(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 20) return null;

    if (node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
      return node.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    }
    if (node.continuationEndpoint?.continuationCommand?.token) {
      return node.continuationEndpoint.continuationCommand.token;
    }
    if (node.continuationCommand?.token) {
      return node.continuationCommand.token;
    }

    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (child && typeof child === 'object') {
        const found = findContinuationToken(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Procura o token de continuação dos COMENTÁRIOS dentro de uma resposta ou ytInitialData.
   * Não captura tokens da coluna secundária (vídeos relacionados).
   */
  function extractCommentToken(data) {
    if (!data || typeof data !== 'object') return null;

    try {
      // ── Caminho 1: engagementPanels (padrão moderno do YouTube) ──
      if (Array.isArray(data.engagementPanels)) {
        for (const panel of data.engagementPanels) {
          const id = (
            panel?.engagementPanelSectionListRenderer?.panelIdentifier ||
            panel?.engagementPanelSectionListRenderer?.targetId ||
            panel?.targetId ||
            ''
          ).toLowerCase();

          if (id.includes('comment')) {
            // Prioriza o token dentro de content (seção de comentários),
            // evitando tokens de menu de ordenação (Top/Newest) no header
            const content = panel?.engagementPanelSectionListRenderer?.content;
            const token = findContinuationToken(content) || findContinuationToken(panel);
            if (token && token.length > 20) {
              console.log(TAG, 'Token encontrado em engagementPanels:', token.slice(0, 40) + '...');
              return token;
            }
          }
        }
      }

      // ── Caminho 2: twoColumnWatchNextResults → coluna principal ──
      const sections = data
        ?.contents
        ?.twoColumnWatchNextResults
        ?.results
        ?.results
        ?.contents;

      if (Array.isArray(sections)) {
        // Primeira tentativa: seção identificada explicitamente como de comentários
        for (const section of sections) {
          const isr = section?.itemSectionRenderer;
          if (!isr) continue;

          const id = (isr.sectionIdentifier || isr.targetId || '').toLowerCase();
          const hasCommentHeader = isr.contents?.some?.(c =>
            c.commentsEntryPointHeaderRenderer || c.commentsHeaderRenderer
          );

          if (id.includes('comment') || hasCommentHeader) {
            const token = findContinuationToken(isr);
            if (token && token.length > 20) {
              console.log(TAG, 'Token encontrado em itemSectionRenderer (comment):', token.slice(0, 40) + '...');
              return token;
            }
          }
        }

        // Segunda tentativa: qualquer continuação na coluna principal
        for (const section of sections) {
          const token = findContinuationToken(section?.itemSectionRenderer);
          if (token && token.length > 20) {
            console.log(TAG, 'Token encontrado em itemSectionRenderer (fallback):', token.slice(0, 40) + '...');
            return token;
          }
        }
      }

      // ── Caminho 3: Busca geral excluindo vídeos relacionados ──
      const cleanData = { ...data };
      if (cleanData.contents?.twoColumnWatchNextResults) {
        cleanData.contents = {
          ...cleanData.contents,
          twoColumnWatchNextResults: {
            ...cleanData.contents.twoColumnWatchNextResults,
            secondaryResults: null // exclui recomendações
          }
        };
      }

      function searchCommentTree(node, depth = 0) {
        if (!node || typeof node !== 'object' || depth > 25) return null;

        const keysStr = JSON.stringify(Object.keys(node)).toLowerCase();
        const targetStr = String(node.targetId || '').toLowerCase();
        if (keysStr.includes('comment') || targetStr.includes('comment')) {
          const token = findContinuationToken(node);
          if (token && token.length > 20) return token;
        }

        const list = Array.isArray(node) ? node : Object.values(node);
        for (const item of list) {
          if (item && typeof item === 'object') {
            const found = searchCommentTree(item, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const deepToken = searchCommentTree(cleanData);
      if (deepToken) {
        console.log(TAG, 'Token encontrado via busca recursiva:', deepToken.slice(0, 40) + '...');
        return deepToken;
      }
    } catch (e) {
      console.warn(TAG, 'extractCommentToken erro:', e);
    }

    return null;
  }

  /**
   * Encontra o token para a PRÓXIMA página dentro da resposta da paginação de comentários.
   * Busca estritamente o continuationItemRenderer no nível da lista de comentários,
   * NUNCA pegando tokens de respostas internas (replies) de comentários individuais.
   */
  function findNextToken(responseData) {
    try {
      if (!responseData || typeof responseData !== 'object') return null;

      const endpoints = responseData?.onResponseReceivedEndpoints;
      if (Array.isArray(endpoints)) {
        for (const ep of endpoints) {
          for (const actionName of ['appendContinuationItemsAction', 'reloadContinuationItemsCommand']) {
            const action = ep?.[actionName];
            const items = action?.continuationItems;
            if (Array.isArray(items)) {
              for (const item of items) {
                // APENAS continuationItemRenderer direto na lista (próxima página de comentários)
                // NUNCA pegar tokens aninhados dentro de replies (respostas de um comentário)
                if (item?.continuationItemRenderer) {
                  const token = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
                  if (token && token.length > 20) {
                    return token;
                  }
                }
              }
            }
          }
        }
      }

      const direct = responseData?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (direct && direct.length > 20) return direct;
    } catch {}
    return null;
  }

  // ─── Comment parsing ──────────────────────────────────

  function runsToText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (typeof obj.content === 'string') return obj.content;
    if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
    if (typeof obj.simpleText === 'string') return obj.simpleText;
    return '';
  }

  function bestThumb(thumbs) {
    if (!Array.isArray(thumbs) || !thumbs.length) return '';
    return ([...thumbs].sort((a, b) => Math.abs((a.width || 0) - 48) - Math.abs((b.width || 0) - 48)))[0]?.url || '';
  }

  function walkAndCollect(obj, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 40) return;

    // Formato clássico: commentRenderer
    if (obj.commentRenderer) {
      const c = obj.commentRenderer;
      const text = runsToText(c.contentText);
      if (text) out.push({
        text,
        author: runsToText(c.authorText) || 'Anônimo',
        avatar: bestThumb(c.authorThumbnail?.thumbnails),
      });
    }

    // Formato InnerTube (2024+): commentEntityPayload
    if (obj.commentEntityPayload) {
      const c = obj.commentEntityPayload;
      const text = c.properties?.content?.content || runsToText(c.properties?.content) || '';
      if (text) out.push({
        text,
        author: c.author?.displayName || 'Anônimo',
        avatar: c.author?.avatarThumbnailUrl || '',
      });
    }

    // commentViewModel (novo componente Web do YouTube)
    if (obj.commentViewModel) {
      const c = obj.commentViewModel;
      const text = runsToText(c.commentText) || runsToText(c.renderedCommentText) || (typeof c.commentText === 'string' ? c.commentText : '');
      const author = typeof c.authorDisplayName === 'string' ? c.authorDisplayName : runsToText(c.authorDisplayName) || 'Anônimo';
      const avatar = c.authorThumbnailUrl || c.authorAvatarImage?.avatarImageUrl || bestThumb(c.authorAvatarImage?.thumbnails) || '';
      if (text) out.push({ text, author, avatar });
    }

    const iter = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of iter) {
      if (v && typeof v === 'object') walkAndCollect(v, out, depth + 1);
    }
  }

  // ─── Cache & Dispatch ─────────────────────────────────

  function saveAndSendComments(videoId, comments) {
    if (!videoId || !comments?.length) return;

    let list = _videoComments.get(videoId);
    if (!list) {
      if (_videoComments.size >= MAX_CACHE_VIDEOS) {
        const oldestKey = _videoComments.keys().next().value;
        _videoComments.delete(oldestKey);
      }
      list = [];
      _videoComments.set(videoId, list);
    }
    list.push(...comments);

    window.postMessage({
      type:    'YTSC_COMMENTS',
      source:  SOURCE,
      videoId: videoId,
      comments: comments,
    }, '*');
  }

  // ─── Proactive Fetch ──────────────────────────────────

  async function getOrFetchCommentToken(videoId) {
    // 1. Tenta extrair de ytInitialData APENAS se o token pertencer comprovadamente a este videoId
    try {
      const initData = window.ytInitialData;
      if (initData) {
        const token = extractCommentToken(initData);
        if (token && tokenBelongsToVideo(token, videoId)) {
          console.log(TAG, `Token verificado em ytInitialData para ${videoId}`);
          return token;
        } else if (token) {
          console.log(TAG, `Token em ytInitialData não pertence a ${videoId} (é de outro vídeo) — descartando.`);
        }
      }
    } catch {}

    // 2. Busca watch data atualizado da InnerTube API para este videoId específico
    console.log(TAG, `Buscando watch data via API para o vídeo ${videoId}...`);
    try {
      const res = await callInnerTubeApi({ videoId });
      if (res && res.ok) {
        const watchData = await res.json();
        const token = extractCommentToken(watchData);
        if (token && tokenBelongsToVideo(token, videoId)) {
          console.log(TAG, `Token obtido com sucesso via API para ${videoId}`);
          return token;
        } else if (token) {
          console.log(TAG, `Token da API obtido para ${videoId}`);
          return token;
        }
      } else if (res) {
        console.warn(TAG, `Watch data status: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(TAG, 'Aviso ao buscar watch data:', err?.message || err);
    }

    return null;
  }

  async function fetchCommentsWithToken(initialToken, videoId) {
    if (!initialToken || !videoId) return;

    let token = initialToken;
    let page = 0;
    let totalComments = 0;

    console.log(TAG, `Buscando comentários proativamente para ${videoId} (até ${MAX_PAGES} páginas)...`);

    while (token && page < MAX_PAGES) {
      if (_activeFetchVideoId !== videoId) {
        console.log(TAG, `Fetch interrompido para ${videoId} (vídeo atual: ${_activeFetchVideoId})`);
        break;
      }

      let res;
      try {
        res = await callInnerTubeApi({ continuation: token });
      } catch (err) {
        console.warn(TAG, `Aviso de rede na página ${page + 1}:`, err?.message || err);
        break;
      }

      if (!res || !res.ok) {
        console.warn(TAG, `Página ${page + 1}: HTTP ${res ? res.status : 'falha'}`);
        break;
      }

      if (_activeFetchVideoId !== videoId) break;

      let json;
      try {
        json = await res.json();
      } catch {
        break;
      }

      const pageComments = [];
      walkAndCollect(json, pageComments);

      if (pageComments.length) {
        saveAndSendComments(videoId, pageComments);
        totalComments += pageComments.length;
        console.log(TAG, `Página ${page + 1}: ${pageComments.length} comentários (total: ${totalComments})`);
      } else {
        console.log(TAG, `Página ${page + 1}: nenhum comentário retornado.`);
        break;
      }

      token = findNextToken(json);
      page++;
      if (token && page < MAX_PAGES) await sleep(PAGE_DELAY);
    }

    console.log(TAG, `Proativo concluído para ${videoId}: ${page} pág(s), ${totalComments} comentários.`);
  }

  async function fetchCommentsPro(videoId) {
    if (!videoId) return;
    if (_isFetching && _activeFetchVideoId === videoId) return;

    _activeFetchVideoId = videoId;
    _isFetching = true;

    try {
      const token = await getOrFetchCommentToken(videoId);
      if (!token) {
        console.log(TAG, `Nenhum token de comentário encontrado para ${videoId}.`);
        return;
      }

      if (_activeFetchVideoId !== videoId) return;

      await fetchCommentsWithToken(token, videoId);
    } catch (e) {
      console.warn(TAG, 'Aviso no fetch proativo:', e?.message || e);
    } finally {
      if (_activeFetchVideoId === videoId) {
        _isFetching = false;
      }
    }
  }

  // ─── Passive: Intercept fetch & XHR ───────────────────

  window.fetch = async function (input, init) {
    // Se for uma requisição interna da nossa própria extensão, não intercepta recursivamente
    if (init?.headers && (init.headers['X-YTSC-Internal'] || init.headers.get?.('X-YTSC-Internal'))) {
      return _origFetch.call(this, input, init);
    }

    const res = await _origFetch.call(this, input, init);
    try {
      const url = (typeof input === 'string' ? input : input?.url) || '';
      if (url.includes('/youtubei/v1/')) {
        res.clone().json().then(data => {
          const vid = currentVideoId();
          if (!vid) return;

          // 1. Captura comentários que vieram nesta resposta (ex: rolagem do usuário)
          const comments = [];
          walkAndCollect(data, comments);
          if (comments.length) {
            console.log(TAG, `Interceptado fetch: ${comments.length} comentário(s) para ${vid}`);
            saveAndSendComments(vid, comments);
          }

          // 2. Se for resposta de watch page (sem comentários, mas contém o token inicial),
          // dispara busca proativa se ainda não tivermos comentários para este vídeo
          const token = extractCommentToken(data);
          if (token && tokenBelongsToVideo(token, vid)) {
            const cached = _videoComments.get(vid);
            if ((!cached || cached.length === 0) && _activeFetchVideoId !== vid) {
              console.log(TAG, `Token capturado do fetch do YouTube para ${vid}, iniciando busca proativa...`);
              _activeFetchVideoId = vid;
              fetchCommentsWithToken(token, vid);
            }
          }
        }).catch(() => {});
      }
    } catch {}
    return res;
  };

  XMLHttpRequest.prototype.open = function (m, url, ...r) {
    this._ytscUrl = url || '';
    return _origOpen.call(this, m, url, ...r);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._ytscUrl?.includes('/youtubei/v1/')) {
      this.addEventListener('load', function () {
        try {
          const data = JSON.parse(this.responseText);
          const vid = currentVideoId();
          if (!vid) return;

          const comments = [];
          walkAndCollect(data, comments);
          if (comments.length) {
            console.log(TAG, `Interceptado XHR: ${comments.length} comentário(s) para ${vid}`);
            saveAndSendComments(vid, comments);
          }

          const token = extractCommentToken(data);
          if (token && tokenBelongsToVideo(token, vid)) {
            const cached = _videoComments.get(vid);
            if ((!cached || cached.length === 0) && _activeFetchVideoId !== vid) {
              console.log(TAG, `Token capturado do XHR do YouTube para ${vid}, iniciando busca proativa...`);
              _activeFetchVideoId = vid;
              fetchCommentsWithToken(token, vid);
            }
          }
        } catch {}
      });
    }
    return _origSend.call(this, body);
  };

  // ─── Bidirectional Message Handshake ──────────────────

  /**
   * Responde ao content.js quando este solicita comentários.
   * Garante que comentários buscados antes do carregamento do content.js não sejam perdidos.
   */
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.data?.source !== 'yt-super-comments-content' ||
      event.data?.type !== 'YTSC_GET_COMMENTS'
    ) return;

    const vid = event.data.videoId;
    if (!vid) return;

    const cached = _videoComments.get(vid);
    if (cached && cached.length > 0) {
      console.log(TAG, `Enviando ${cached.length} comentário(s) em cache para content.js (${vid})`);
      window.postMessage({
        type:    'YTSC_COMMENTS',
        source:  SOURCE,
        videoId: vid,
        comments: cached,
      }, '*');
    }

    // Se ainda não temos comentários e não estamos buscando, inicia busca
    if ((!cached || cached.length === 0) && _activeFetchVideoId !== vid) {
      _activeFetchVideoId = vid;
      fetchCommentsPro(vid);
    }
  });

  // ─── Navigation ───────────────────────────────────────

  let _navTimer = null;

  function onNavigate() {
    if (!location.href.includes('youtube.com/watch')) return;

    clearTimeout(_navTimer);
    _navTimer = setTimeout(() => {
      const vid = currentVideoId();
      if (!vid) return;

      if (vid === _activeFetchVideoId && _isFetching) {
        return;
      }

      console.log(TAG, `Navegação detectada para ${vid}`);
      _activeFetchVideoId = vid;
      _isFetching = false;
      fetchCommentsPro(vid);
    }, 50);
  }

  document.addEventListener('yt-navigate-finish', onNavigate);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(onNavigate, 100));
  } else {
    setTimeout(onNavigate, 100);
  }

  console.log(TAG, 'Injected script carregado (v1.6.1).');
})();
