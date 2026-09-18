/* =====================================================
   YouTube Super Comments - Content Script (world: ISOLATED)
   
   Receives comments from injected.js via window.postMessage,
   then overlays them on the YouTube player at the exact
   cited timestamp using requestAnimationFrame sync.
   ===================================================== */

(function () {
  'use strict';

  // ─── Configuration ────────────────────────────────────
  const CONFIG = {
    displayDuration:  6000,   // ms — how long each card stays visible
    maxVisibleCards:  4,      // max cards visible at once
    timestampWindow:  2,      // ±seconds tolerance for triggering a card
    progressBarEnabled: true,
    debug: false,
  };

  // ─── State ────────────────────────────────────────────
  const state = {
    enabled: true,
    comments: [],             // [{author, avatar, text, seconds, formatted}]
    shownMap: new Map(),      // key → timestamp when last shown (for cooldown)
    lastVideoId: null,
    videoEl: null,
    overlayEl: null,
    rafHandle: null,
    lastCheckedSecond: -1,
    suppressUntil: 0,         // epoch ms — skip showing cards until this time (popup seek)
    seekFromPopup: false,     // flag to distinguish popup seek from user scrub
  };

  // ─── Debug ────────────────────────────────────────────
  const log = (...a) => CONFIG.debug && console.log('[YTSuperComments]', ...a);

  // ─── Timestamp Utilities ──────────────────────────────

  /** Parses "MM:SS" / "HH:MM:SS" → total seconds. Returns null if invalid. */
  function parseTimestamp(str) {
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) {
      const [m, s] = parts;
      return (s >= 60 || s < 0 || m < 0) ? null : m * 60 + s;
    }
    if (parts.length === 3) {
      const [h, m, s] = parts;
      return (s >= 60 || m >= 60 || h < 0) ? null : h * 3600 + m * 60 + s;
    }
    return null;
  }

  /** Returns all timestamps found in a text string. */
  function extractTimestamps(text) {
    const regex = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
    const results = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
      const secs = parseTimestamp(m[1]);
      if (secs !== null && secs >= 0) {
        results.push({ formatted: m[1], seconds: secs });
      }
    }
    return results;
  }

  /** Unique key for a (timestamp + comment) pair. */
  function commentKey(seconds, text) {
    return `${seconds}::${text.slice(0, 60)}`;
  }

  /** Wraps timestamp strings in the comment text with a highlight span. */
  function highlightText(text) {
    const esc = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return esc.replace(
      /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g,
      '<span class="ytsc-ts-highlight">$1</span>'
    );
  }

  /** Returns 1-2 uppercase initials from a display name. */
  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2)
      .map(w => w[0]).join('').toUpperCase() || '?';
  }

  // ─── Comment Ingestion ────────────────────────────────

  /**
   * Receives raw comment objects from injected.js and indexes them by timestamp.
   * Each comment may generate multiple entries (one per timestamp found in it).
   */
  function ingestComments(rawComments, fromVideoId) {
    if (!Array.isArray(rawComments)) return;

    // Reject batches that belong to a different video (stale from previous page)
    if (fromVideoId && fromVideoId !== state.lastVideoId) {
      log(`Ignoring ${rawComments.length} comment(s) from video ${fromVideoId} (current: ${state.lastVideoId})`);
      return;
    }

    const existingKeys = new Set(
      state.comments.map(c => commentKey(c.seconds, c.text))
    );
    let added = 0;

    rawComments.forEach(raw => {
      const text = (raw.text || '').trim();
      if (text.length < 3) return;

      const timestamps = extractTimestamps(text);
      if (timestamps.length === 0) return;

      timestamps.forEach(ts => {
        const key = commentKey(ts.seconds, text);
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          state.comments.push({
            author:    raw.author    || 'Anônimo',
            avatar:    raw.avatar    || '',
            text,
            seconds:   ts.seconds,
            formatted: ts.formatted,
          });
          added++;
        }
      });
    });

    if (added > 0) {
      log(`Ingested ${added} new entries. Total: ${state.comments.length}`);
      notifyPopup();
    }
  }

  function notifyPopup() {
    chrome.runtime.sendMessage({
      type:       'COMMENTS_UPDATED',
      count:      state.comments.length,
      videoId:    state.lastVideoId,
    }).catch(() => {});
  }

  // ─── Overlay ──────────────────────────────────────────

  function createOverlay() {
    removeOverlay();
    const player = document.querySelector('.html5-video-player');
    if (!player) return false;
    const el = document.createElement('div');
    el.id = 'ytsc-overlay';
    el.setAttribute('aria-live', 'polite');
    player.appendChild(el);
    state.overlayEl = el;
    return true;
  }

  function removeOverlay() {
    state.overlayEl?.remove();
    state.overlayEl = null;
    document.getElementById('ytsc-overlay')?.remove();
  }

  function makeFallbackAvatar(name) {
    const d = document.createElement('div');
    d.className = 'ytsc-avatar-fallback';
    d.textContent = initials(name);
    return d;
  }

  function showComment(comment) {
    if (!state.overlayEl || !state.enabled) return;

    // Evict oldest NON-paused card if at limit
    const all = [...state.overlayEl.querySelectorAll('.ytsc-comment-card:not(.ytsc-fadeout)')];
    const nonPaused = all.filter(c => !c.classList.contains('ytsc-paused') && !c.classList.contains('ytsc-expanded'));
    if (all.length >= CONFIG.maxVisibleCards && nonPaused.length > 0) dismissCard(nonPaused[0]);

    // Card
    const card = document.createElement('div');
    card.className = 'ytsc-comment-card';

    // Avatar
    let avatarEl;
    if (comment.avatar?.startsWith('http')) {
      avatarEl = document.createElement('img');
      avatarEl.className = 'ytsc-avatar';
      avatarEl.src = comment.avatar;
      avatarEl.alt = comment.author;
      avatarEl.onerror = () => avatarEl.replaceWith(makeFallbackAvatar(comment.author));
    } else {
      avatarEl = makeFallbackAvatar(comment.author);
    }

    // Content
    const content = document.createElement('div');
    content.className = 'ytsc-content';

    const header = document.createElement('div');
    header.className = 'ytsc-header';

    const authorEl = document.createElement('span');
    authorEl.className = 'ytsc-author';
    authorEl.textContent = comment.author;

    const badge = document.createElement('span');
    badge.className = 'ytsc-timestamp-badge';
    badge.textContent = comment.formatted;

    const expandHint = document.createElement('span');
    expandHint.className = 'ytsc-expand-hint';
    expandHint.textContent = '\u2194';

    const pauseIcon = document.createElement('span');
    pauseIcon.className = 'ytsc-pause-icon';
    pauseIcon.textContent = '\u23f8';

    // Close button — top-right corner, appears on hover/pause/expand
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ytsc-close-btn';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Fechar';
    closeBtn.setAttribute('aria-label', 'Fechar comentário');

    header.appendChild(authorEl);
    header.appendChild(badge);
    header.appendChild(expandHint);

    const textEl = document.createElement('div');
    textEl.className = 'ytsc-text';
    textEl.innerHTML = highlightText(comment.text);

    content.appendChild(header);
    content.appendChild(textEl);

    // Progress bar (animation-based so it can be CSS-paused)
    const pw = document.createElement('div');
    pw.className = 'ytsc-progress';
    const pb = document.createElement('div');
    pb.className = 'ytsc-progress-bar';
    pw.appendChild(pb);
    content.appendChild(pw);

    card.appendChild(closeBtn);   // absolute top-right
    card.appendChild(pauseIcon);  // absolute bottom-right
    card.appendChild(avatarEl);
    card.appendChild(content);
    state.overlayEl.appendChild(card);

    // Set animation duration on progress bar
    pb.style.animationDuration = `${CONFIG.displayDuration}ms`;

    // Track timing for hover-pause
    card._ytscShownAt  = Date.now();
    card._ytscDuration = CONFIG.displayDuration;
    card._ytscTimer    = setTimeout(() => dismissCard(card), CONFIG.displayDuration);

    // ── Hover: pause card (timer + progress bar) ──────────
    card.addEventListener('mouseenter', () => {
      if (card.classList.contains('ytsc-expanded')) return; // already pinned
      const elapsed   = Date.now() - card._ytscShownAt;
      card._ytscRemaining = Math.max(600, card._ytscDuration - elapsed);
      clearTimeout(card._ytscTimer);
      card.classList.add('ytsc-paused'); // CSS pauses the progress animation
    });

    card.addEventListener('mouseleave', () => {
      if (card.classList.contains('ytsc-expanded')) return; // stay pinned
      card.classList.remove('ytsc-paused');
      // Restart timer with remaining time
      card._ytscShownAt  = Date.now();
      card._ytscDuration = card._ytscRemaining;
      card._ytscTimer    = setTimeout(() => dismissCard(card), card._ytscRemaining);
      // Resume progress bar from ~current position
      pb.style.animationDuration = `${card._ytscRemaining}ms`;
    });

    // ── Click: expand card (show full text) ───────────────
    card.addEventListener('click', (e) => {
      if (e.target === closeBtn) return; // handled by closeBtn listener
      if (card.classList.contains('ytsc-expanded')) return;
      // Expand: pin card, show full text
      clearTimeout(card._ytscTimer);
      card.classList.remove('ytsc-paused');
      card.classList.add('ytsc-expanded');
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissCard(card);
    });
  }

  function dismissCard(card) {
    if (!card || card.classList.contains('ytsc-fadeout')) return;
    clearTimeout(card._ytscTimer);
    card.classList.add('ytsc-fadeout');
    setTimeout(() => card.remove(), 600);
  }

  // ─── Sync Loop ────────────────────────────────────────

  function syncLoop() {
    state.rafHandle = requestAnimationFrame(syncLoop);
    if (!state.enabled || !state.videoEl || !state.overlayEl) return;

    // Suppress cards briefly after a popup-triggered seek
    if (Date.now() < state.suppressUntil) return;

    const currentSecond = Math.floor(state.videoEl.currentTime);
    if (currentSecond === state.lastCheckedSecond) return;
    state.lastCheckedSecond = currentSecond;

    state.comments.forEach(c => {
      if (Math.abs(c.seconds - currentSecond) > CONFIG.timestampWindow) return;
      const key = commentKey(c.seconds, c.text);
      const lastShown = state.shownMap.get(key);
      if (lastShown && Date.now() - lastShown < 30000) return; // 30s cooldown
      state.shownMap.set(key, Date.now());
      showComment(c);
    });
  }

  function handleSeeked() {
    if (state.seekFromPopup) {
      // Popup-triggered seek: keep shownMap intact, just suppress new cards briefly
      state.seekFromPopup  = false;
      state.suppressUntil  = Date.now() + 2500;
      state.lastCheckedSecond = -1;
      return;
    }
    // Normal user scrub: reset everything
    state.shownMap.clear();
    state.lastCheckedSecond = -1;
  }

  // ─── Video / Player Bootstrap ─────────────────────────

  function findVideo() {
    return (
      document.querySelector('.html5-video-player video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video')
    );
  }

  function startSync() {
    if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
    state.videoEl?.removeEventListener('seeked', handleSeeked);
    state.videoEl = findVideo();
    if (state.videoEl) state.videoEl.addEventListener('seeked', handleSeeked);
    syncLoop();
  }

  function stopSync() {
    if (state.rafHandle) { cancelAnimationFrame(state.rafHandle); state.rafHandle = null; }
    state.videoEl?.removeEventListener('seeked', handleSeeked);
  }

  function initForVideo(videoId) {
    log('Init for video:', videoId);
    state.comments    = [];
    state.shownMap.clear();
    state.lastCheckedSecond = -1;

    const tryInit = (attempts = 0) => {
      const playerReady = createOverlay();
      state.videoEl = findVideo();

      if (!playerReady || !state.videoEl) {
        if (attempts < 25) setTimeout(() => tryInit(attempts + 1), 100);
        return;
      }
      if (state.videoEl) state.videoEl.addEventListener('seeked', handleSeeked);
      startSync();
    };
    tryInit(0); // Imediato sem 800ms de atraso
  }

  function teardown() {
    stopSync();
    document.querySelectorAll('.ytsc-comment-card').forEach(el => el.remove());
    removeOverlay();
    state.comments    = [];
    state.shownMap.clear();
    state.lastCheckedSecond = -1;
    state.videoEl = null;
  }

  // ─── YouTube SPA Navigation ───────────────────────────

  function requestComments(videoId) {
    if (!videoId) return;
    window.postMessage({
      type:    'YTSC_GET_COMMENTS',
      source:  'yt-super-comments-content',
      videoId: videoId,
    }, '*');
  }

  function onNavigate() {
    const params = new URLSearchParams(location.search);
    const videoId = params.get('v');
    if (!videoId) {
      if (state.lastVideoId) { teardown(); state.lastVideoId = null; }
      return;
    }
    if (videoId !== state.lastVideoId) {
      teardown();
      // Set IMMEDIATELY so ingestComments() doesn't reject proactive
      // comments that arrive from injected.js before initForVideo() runs.
      state.lastVideoId = videoId;
      initForVideo(videoId);
      requestComments(videoId);
    }
  }

  document.addEventListener('yt-navigate-finish', onNavigate);

  // URL-change polling fallback
  let _lastHref = location.href;
  setInterval(() => {
    if (location.href !== _lastHref) {
      _lastHref = location.href;
      onNavigate();
    }
  }, 200);

  // ─── Message Bus ──────────────────────────────────────

  /** Receive comments from injected.js running in MAIN world */
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.data?.source !== 'yt-super-comments-injected' ||
      event.data?.type   !== 'YTSC_COMMENTS'
    ) return;
    ingestComments(event.data.comments, event.data.videoId);
  });

  /** Receive commands from popup.js */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_STATUS') {
      sendResponse({
        enabled:      state.enabled,
        commentCount: state.comments.length,
        videoId:      state.lastVideoId,
        comments: state.comments.map(c => ({
          author:    c.author,
          text:      c.text.slice(0, 120),
          formatted: c.formatted,
          seconds:   c.seconds,
        })),
      });
      return true;
    }

    if (msg.type === 'SET_ENABLED') {
      state.enabled = msg.value;
      chrome.storage.local.set({ enabled: msg.value });
      if (!msg.value) {
        state.overlayEl?.querySelectorAll('.ytsc-comment-card').forEach(dismissCard);
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'SEEK_TO') {
      if (state.videoEl) {
        state.seekFromPopup = true;  // flag so handleSeeked knows this came from popup
        state.videoEl.currentTime = msg.seconds;
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'SET_DURATION') {
      CONFIG.displayDuration = msg.value;
      chrome.storage.local.set({ displayDuration: msg.value });
      sendResponse({ ok: true });
      return true;
    }
  });

  // ─── Restore settings & boot ──────────────────────────
  chrome.storage.local.get(['enabled', 'displayDuration'], (r) => {
    if (r.enabled !== undefined)   state.enabled = r.enabled;
    if (r.displayDuration)         CONFIG.displayDuration = r.displayDuration;
  });

  onNavigate();
  if (state.lastVideoId) {
    requestComments(state.lastVideoId);
  }
  log('Content script loaded (v1.6).');
})();
