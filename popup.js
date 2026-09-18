/* =====================================================
   YouTube Super Comments - Popup Script v1.3
   ===================================================== */

(function () {
  'use strict';

  const toggleEl     = document.getElementById('enable-toggle');
  const statusDot    = document.getElementById('status-dot');
  const statusText   = document.getElementById('status-text');
  const commentCount = document.getElementById('comment-count');
  const commentList  = document.getElementById('comment-list');
  const videoLabel   = document.getElementById('video-label');
  const durSel       = document.getElementById('dur');
  const refreshBtn   = document.getElementById('refresh-btn');

  async function getStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.includes('youtube.com/watch')) { setIdle(); return; }

      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }).catch(() => null);
      if (!resp) { setIdle(); return; }

      toggleEl.checked = resp.enabled;

      if (resp.videoId) {
        videoLabel.textContent = `ID: ${resp.videoId}`;
        statusDot.className   = `dot ${resp.enabled ? 'active' : 'inactive'}`;
        statusText.textContent = resp.enabled
          ? 'Extensão ativa — monitorando comentários'
          : 'Extensão pausada';
      } else {
        setIdle(); return;
      }

      const n = resp.commentCount || 0;
      commentCount.textContent = `${n} comentário${n !== 1 ? 's' : ''}`;
      renderList(resp.comments || [], tab.id);

      chrome.storage.local.get(['displayDuration'], r => {
        if (r.displayDuration) durSel.value = String(r.displayDuration);
      });
    } catch {
      setIdle();
    }
  }

  function setIdle() {
    statusDot.className    = 'dot idle';
    statusText.textContent = 'Abra um vídeo do YouTube';
    videoLabel.textContent = 'Nenhum vídeo detectado';
    commentCount.textContent = '0 comentários';
    renderList([], null);
  }

  function renderList(comments, tabId) {
    if (!comments?.length) {
      commentList.innerHTML = `
        <div class="empty">
          <div class="empty-icon">💬</div>
          <div class="empty-title">Nenhum comentário encontrado</div>
          <div class="empty-sub">Abra um vídeo do YouTube e aguarde<br>os comentários serem carregados.</div>
        </div>`;
      return;
    }

    const sorted = [...comments].sort((a, b) => a.seconds - b.seconds);
    commentList.innerHTML = '';

    sorted.forEach(c => {
      const item = document.createElement('div');
      item.className = 'c-item';
      item.title = `Ir para ${c.formatted} no vídeo`;
      item.innerHTML = `
        <span class="c-time">⏱ ${esc(c.formatted)}</span>
        <div class="c-body">
          <div class="c-author">${esc(c.author)}</div>
          <div class="c-text">${esc(c.text)}</div>
        </div>
        <span class="c-arrow">›</span>
      `;

      item.addEventListener('click', async () => {
        if (!tabId) return;
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'SEEK_TO', seconds: c.seconds });
          item.style.borderColor = 'rgba(124,92,255,0.7)';
          setTimeout(() => { item.style.borderColor = ''; }, 800);
        } catch {}
      });

      commentList.appendChild(item);
    });
  }

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Events ──────────────────────────────────────────

  toggleEl.addEventListener('change', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', value: toggleEl.checked });
      statusDot.className    = `dot ${toggleEl.checked ? 'active' : 'inactive'}`;
      statusText.textContent = toggleEl.checked
        ? 'Extensão ativa — monitorando comentários'
        : 'Extensão pausada';
    } catch {}
  });

  durSel.addEventListener('change', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_DURATION', value: parseInt(durSel.value, 10) });
    } catch {}
  });

  refreshBtn.addEventListener('click', () => {
    refreshBtn.textContent = '↻ Atualizando...';
    getStatus().finally(() => setTimeout(() => { refreshBtn.textContent = '↻ Atualizar'; }, 700));
  });

  getStatus();
})();
