/* =====================================================
   YouTube Super Comments - Injected Script (world: MAIN)
   Roda no contexto da PÁGINA (acessa window.*, fetch, XHR).

   Estratégia dupla:
   1. PROATIVA: extrai o token de comentários de ytInitialData e
      chama diretamente a InnerTube API /youtubei/v1/next
      — o usuário NÃO precisa rolar.
   2. PASSIVA: intercepta fetch/XHR — captura automaticamente
      qualquer resposta do YouTube que contenha comentários
      (inclusive quando o usuário rola).
   ===================================================== */

(function () {
  'use strict';

  const TAG       = '[YTSuperComments]';
  const SOURCE    = 'yt-super-comments-injected';
  const MAX_PAGES  = 50;   // páginas (~1000 comentários)
  const PAGE_DELAY = 300; // ms entre páginas

  // ─── InnerTube helpers ────────────────────────────────

  function getApiKey() {
    try {
      return window.ytcfg?.get?.('INNERTUBE_API_KEY')
          || window.ytcfg?.data_?.INNERTUBE_API_KEY
          || '';
    } catch { return ''; }
  }

  function getClientCtx() {
    try {
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

  // ─── Token extractor ──────────────────────────────────
  /**
   * Procura o token de continuação dos COMENTÁRIOS dentro de ytInitialData.
   * Busca somente na coluna principal (results), nunca na coluna secundária
   * (secondaryResults), para não pegar tokens de "vídeos relacionados".
   *
   * Identifica a seção de comentários por:
   *  A) sectionIdentifier que contém "comment"
   *  B) presença de commentsEntryPointHeaderRenderer na seção
   *  C) fallback: qualquer continuationItemRenderer na coluna principal
   */
  function extractCommentToken(data) {
    try {
      // ── Caminho 1: twoColumnWatchNextResults → coluna principal ──
      const sections = data
        ?.contents
        ?.twoColumnWatchNextResults
        ?.results
        ?.results
        ?.contents;

      if (Array.isArray(sections)) {
        // Primeira passagem: seções explicitamente identificadas como comentários
        for (const section of sections) {
          const isr = section?.itemSectionRenderer;
          if (!isr?.contents) continue;

          const isCommentSection =
            isr.sectionIdentifier?.includes('comment') ||
            isr.contents.some(c => c.commentsEntryPointHeaderRenderer);

          if (!isCommentSection) continue;

          for (const item of isr.contents) {
            const token = item?.continuationItemRenderer
              ?.continuationEndpoint?.continuationCommand?.token;
            if (token?.length > 20) {
              console.log(TAG, 'Token (path A) encontrado:', token.slice(0, 40) + '...');
              return token;
            }
          }
        }

        // Segunda passagem: qualquer continuationItemRenderer na coluna principal
        // (fallback — em alguns layouts o sectionIdentifier não existe)
        for (const section of sections) {
          const isr = section?.itemSectionRenderer;
          if (!isr?.contents) continue;
          for (const item of isr.contents) {
            const token = item?.continuationItemRenderer
              ?.continuationEndpoint?.continuationCommand?.token;
            if (token?.length > 20) {
              console.log(TAG, 'Token (path B fallback) encontrado:', token.slice(0, 40) + '...');
              return token;
            }
          }
        }
      }

      // ── Caminho 2: engagementPanels (layout alternativo) ──
      const panels = data?.engagementPanels;
      if (Array.isArray(panels)) {
        for (const panel of panels) {
          const id = panel?.engagementPanelSectionListRenderer?.panelIdentifier || '';
          if (!id.includes('comment')) continue;

          const items = panel
            ?.engagementPanelSectionListRenderer
            ?.content
            ?.sectionListRenderer
            ?.contents;

          if (!Array.isArray(items)) continue;

          for (const item of items) {
            const token = item?.itemSectionRenderer
              ?.contents?.[0]
              ?.continuationItemRenderer
              ?.continuationEndpoint?.continuationCommand?.token;
            if (token?.length > 20) {
              console.log(TAG, 'Token (path C engagementPanel) encontrado:', token.slice(0, 40) + '...');
              return token;
            }
          }
        }
      }
    } catch (e) {
      console.warn(TAG, 'extractCommentToken erro:', e);
    }

    console.warn(TAG, 'Nenhum token de comentário encontrado em ytInitialData.');
    return null;
  }

  /**
   * Encontra o token para a PRÓXIMA página dentro da resposta da API.
   */
  function findNextToken(responseData) {
    try {
      // Resposta de continuação de comentários
      const endpoints = responseData?.onResponseReceivedEndpoints;
      if (Array.isArray(endpoints)) {
        for (const ep of endpoints) {
          const items =
            ep?.appendContinuationItemsAction?.continuationItems ||
            ep?.reloadContinuationItemsCommand?.continuationItems;

          if (!Array.isArray(items)) continue;
          for (const item of items) {
            const token = item?.continuationItemRenderer
              ?.continuationEndpoint?.continuationCommand?.token;
            if (token?.length > 20) return token;
          }
        }
      }
    } catch {}
    return null;
  }

  // ─── Comment parsing ──────────────────────────────────

  function runsToText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
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

    // Formato novo (2024+): commentEntityPayload
    if (obj.commentEntityPayload) {
      const c = obj.commentEntityPayload;
      const text = c.properties?.content?.content || '';
      if (text) out.push({
        text,
        author: c.author?.displayName || 'Anônimo',
        avatar: c.author?.avatarThumbnailUrl || '',
      });
    }

    // commentViewModel (outro formato novo)
    if (obj.commentViewModel) {
      const c = obj.commentViewModel;
      const text = c.commentText || runsToText(c.renderedCommentText) || '';
      if (text) out.push({
        text,
        author: c.authorDisplayName || 'Anônimo',
        avatar: c.authorThumbnailUrl || '',
      });
    }

    const iter = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of iter) {
      if (v && typeof v === 'object') walkAndCollect(v, out, depth + 1);
    }
  }

  // ─── Send to content.js ───────────────────────────────

  function sendComments(comments) {
    if (!comments?.length) return;
    window.postMessage({ type: 'YTSC_COMMENTS', source: SOURCE, comments }, '*');
  }

  // ─── Passive: intercept fetch + XHR ───────────────────
  // Captura qualquer resposta de API que contenha comentários
  // (dispara quando o usuário rola até a seção de comentários).

  const _origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await _origFetch.call(this, input, init);
    try {
      const url = (typeof input === 'string' ? input : input?.url) || '';
      if (url.includes('/youtubei/v1/')) {
        res.clone().json().then(data => {
          const comments = [];
          walkAndCollect(data, comments);
          if (comments.length) {
            console.log(TAG, `Interceptado fetch: ${comments.length} comentário(s)`);
            sendComments(comments);
          }
        }).catch(() => {});
      }
    } catch {}
    return res;
  };

  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (m, url, ...r) {
    this._ytscUrl = url || '';
    return _origOpen.call(this, m, url, ...r);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._ytscUrl?.includes('/youtubei/v1/')) {
      this.addEventListener('load', function () {
        try {
          const data = JSON.parse(this.responseText);
          const comments = [];
          walkAndCollect(data, comments);
          if (comments.length) {
            console.log(TAG, `Interceptado XHR: ${comments.length} comentário(s)`);
            sendComments(comments);
          }
        } catch {}
      });
    }
    return _origSend.call(this, body);
  };

  // ─── Proactive fetch ──────────────────────────────────

  let _fetching = false;

  async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function fetchCommentsPro() {
    if (_fetching) return;
    _fetching = true;

    try {
      // Aguarda ytInitialData estar disponível (YouTube injeta no HTML, mas
      // o objeto só fica pronto depois que os scripts da página executam).
      let data = null;
      for (let i = 0; i < 20; i++) {     // até 10s de espera
        await sleep(500);
        data = window.ytInitialData;
        if (data?.contents) break;
      }

      if (!data?.contents) {
        console.warn(TAG, 'ytInitialData não disponível após espera.');
        _fetching = false;
        return;
      }

      const apiKey = getApiKey();
      if (!apiKey) {
        console.warn(TAG, 'INNERTUBE_API_KEY não encontrado.');
        _fetching = false;
        return;
      }

      let token = extractCommentToken(data);
      if (!token) {
        console.warn(TAG, 'Token de comentários não encontrado em ytInitialData.');
        _fetching = false;
        return;
      }

      const client = getClientCtx();
      console.log(TAG, `Buscando comentários proativamente (até ${MAX_PAGES} páginas)...`);

      let page = 0;
      let totalComments = 0;

      while (token && page < MAX_PAGES) {
        const url = `https://www.youtube.com/youtubei/v1/next?key=${apiKey}&prettyPrint=false`;
        const res = await _origFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: { client },
            continuation: token,
          }),
        });

        if (!res.ok) {
          console.warn(TAG, `Página ${page + 1}: HTTP ${res.status}`);
          break;
        }

        const json = await res.json();
        const pageComments = [];
        walkAndCollect(json, pageComments);

        if (pageComments.length) {
          sendComments(pageComments);
          totalComments += pageComments.length;
          console.log(TAG, `Página ${page + 1}: ${pageComments.length} comentários (total: ${totalComments})`);
        } else {
          console.log(TAG, `Página ${page + 1}: nenhum comentário extraído.`);
          break;
        }

        token = findNextToken(json);
        page++;
        if (token && page < MAX_PAGES) await sleep(PAGE_DELAY);
      }

      console.log(TAG, `Proativo concluído: ${page} pág(s), ${totalComments} comentários no total.`);
    } catch (e) {
      console.error(TAG, 'Erro no fetch proativo:', e);
    } finally {
      _fetching = false;
    }
  }

  // ─── Navigation ───────────────────────────────────────
  // Controla qual vídeo já foi (ou está sendo) buscado para
  // evitar disparar fetchCommentsPro() duas vezes no mesmo vídeo.

  let _lastFetchedVideoId = null;
  let _navTimer = null;

  function getVideoId() {
    try { return new URL(location.href).searchParams.get('v'); } catch { return null; }
  }

  function onNavigate() {
    if (!location.href.includes('youtube.com/watch')) return;

    // Debounce: aguarda 200ms para descartar eventos duplicados
    clearTimeout(_navTimer);
    _navTimer = setTimeout(() => {
      const vid = getVideoId();
      if (!vid) return;
      if (vid === _lastFetchedVideoId && _fetching) {
        console.log(TAG, `Vídeo ${vid} já está sendo buscado — ignorando duplicata.`);
        return;
      }
      _lastFetchedVideoId = vid;
      _fetching = false; // reseta para novo vídeo
      fetchCommentsPro();
    }, 200);
  }

  document.addEventListener('yt-navigate-finish', onNavigate);

  // Disparo inicial (quando a extensão é carregada com o vídeo já aberto)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(onNavigate, 100));
  } else {
    setTimeout(onNavigate, 100);
  }

  console.log(TAG, 'Injected script carregado (v1.3).');
})();
