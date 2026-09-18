/* =====================================================
   YouTube Super Comments - Popup Script
   ===================================================== */

(function () {
  'use strict';

  const toggleEl      = document.getElementById('enable-toggle');
  const statusDot     = document.getElementById('status-dot');
  const statusText    = document.getElementById('status-text');
  const commentCount  = document.getElementById('comment-count');
  const commentList   = document.getElementById('comment-list');
  const videoLabel    = document.getElementById('video-label');
  const durationSel   = document.getElementById('duration-select');
  const refreshBtn    = document.getElementById('refresh-btn');

  /**
   * Queries the active YouTube tab's content script for current status.
   */
  async function getStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
        setNotOnVideo();
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      if (!response) {
        setNotOnVideo();
        return;
      }

      // Update toggle state
      toggleEl.checked = response.enabled;

      // Update status
      if (response.videoId) {
        videoLabel.textContent = `ID: ${response.videoId}`;
        statusDot.className = `status-dot ${response.enabled ? 'active' : 'inactive'}`;
        statusText.textContent = response.enabled
          ? 'Extensão ativa — monitorando comentários'
          : 'Extensão pausada';
      } else {
        setNotOnVideo();
        return;
      }

      // Update count
      const count = response.commentCount || 0;
      commentCount.textContent = `${count} comentário${count !== 1 ? 's' : ''}`;

      // Render comment list
      renderComments(response.comments || [], tab.id);

      // Restore saved duration setting
      chrome.storage.local.get(['displayDuration'], (result) => {
        if (result.displayDuration) {
          durationSel.value = String(result.displayDuration);
        }
      });

    } catch (err) {
      setNotOnVideo();
    }
  }

  function setNotOnVideo() {
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Abra um vídeo do YouTube';
    videoLabel.textContent = 'Nenhum vídeo detectado';
    commentCount.textContent = '0 comentários';
    renderComments([], null);
  }

  /**
   * Renders the list of timestamp comments in the popup.
   */
  function renderComments(comments, tabId) {
    if (!comments || comments.length === 0) {
      commentList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">💬</div>
          <div class="empty-state-title">Nenhum comentário encontrado</div>
          <div class="empty-state-subtitle">Abra um vídeo do YouTube e aguarde os<br>comentários carregarem na página.</div>
        </div>
      `;
      return;
    }

    // Sort by timestamp ascending
    const sorted = [...comments].sort((a, b) => a.seconds - b.seconds);

    commentList.innerHTML = '';
    sorted.forEach(c => {
      const item = document.createElement('div');
      item.className = 'comment-item';
      item.title = `Ir para ${c.formatted} no vídeo`;

      item.innerHTML = `
        <span class="item-badge">⏱ ${c.formatted}</span>
        <div class="item-content">
          <div class="item-author">${escapeHtml(c.author)}</div>
          <div class="item-text">${escapeHtml(c.text)}</div>
        </div>
        <span class="item-arrow">›</span>
      `;

      // Click to seek video to timestamp
      item.addEventListener('click', async () => {
        if (!tabId) return;
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'SEEK_TO', seconds: c.seconds });
          // Visually indicate click
          item.style.borderColor = 'rgba(255,60,60,0.6)';
          setTimeout(() => { item.style.borderColor = ''; }, 800);
        } catch {}
      });

      commentList.appendChild(item);
    });
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Event Listeners ──────────────────────────────────

  // Enable/Disable toggle
  toggleEl.addEventListener('change', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', value: toggleEl.checked });

      statusDot.className = `status-dot ${toggleEl.checked ? 'active' : 'inactive'}`;
      statusText.textContent = toggleEl.checked
        ? 'Extensão ativa — monitorando comentários'
        : 'Extensão pausada';
    } catch {}
  });

  // Duration change
  durationSel.addEventListener('change', async () => {
    const val = parseInt(durationSel.value, 10);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_DURATION', value: val });
    } catch {}
  });

  // Refresh button
  refreshBtn.addEventListener('click', () => {
    refreshBtn.textContent = '↻ Atualizando...';
    getStatus().finally(() => {
      setTimeout(() => { refreshBtn.textContent = '↻ Atualizar'; }, 800);
    });
  });

  // ─── Init ─────────────────────────────────────────────
  getStatus();

})();
