/* =====================================================
   YouTube Super Comments - Injected Script (world: MAIN)
   Runs in the PAGE context so it can access:
     window.ytInitialData, window.ytcfg, window.fetch
   
   Strategy:
   1. Intercept fetch + XHR to capture any /youtubei/v1/ response
      that contains comments automatically (when YT loads them).
   2. On every video navigation: proactively call InnerTube /next
      with the comment continuation token extracted from ytInitialData,
      paginating through multiple pages to get all comments.
   3. Send collected comments to content.js via window.postMessage.
   ===================================================== */

(function () {
  'use strict';

  const SOURCE_TAG = 'yt-super-comments-injected';
  const MAX_PAGES  = 8;   // Max pagination pages to fetch proactively
  const PAGE_DELAY = 300; // ms between pagination requests

  // ─── InnerTube Helpers ────────────────────────────────

  /** Gets the InnerTube API key from ytcfg */
  function getApiKey() {
    try {
      return (
        window.ytcfg?.get?.('INNERTUBE_API_KEY') ||
        window.ytcfg?.data_?.INNERTUBE_API_KEY ||
        ''
      );
    } catch { return ''; }
  }

  /** Gets the InnerTube client context for API requests */
  function getClientContext() {
    try {
      const cfg = window.ytcfg?.data_ || {};
      return {
        clientName:    cfg.INNERTUBE_CONTEXT_CLIENT_NAME  || 'WEB',
        clientVersion: cfg.INNERTUBE_CONTEXT_CLIENT_VERSION || '2.20240918.00.00',
        hl:            cfg.HL || navigator.language?.slice(0, 2) || 'en',
        gl:            cfg.GL || 'US',
      };
    } catch {
      return { clientName: 'WEB', clientVersion: '2.20240918.00.00', hl: 'en', gl: 'US' };
    }
  }

  /**
   * Recursively walks an object to find comment continuation tokens.
   * YouTube puts them in different places depending on the version.
   */
  function findCommentToken(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 25) return null;

    // Pattern A: continuationCommand with token (most common)
    if (typeof obj.token === 'string' && obj.request === 'CONTINUATION_REQUEST_TYPE_BROWSE') {
      return obj.token;
    }

    // Pattern B: direct token on continuationCommand for comments
    if (typeof obj.token === 'string' && obj.targetId &&
        (obj.targetId.includes('comment') || obj.targetId === 'engagement-panel-comments-section')) {
      return obj.token;
    }

    // Pattern C: reloadContinuationItemsCommand
    if (obj.reloadContinuationItemsCommand?.token &&
        (obj.reloadContinuationItemsCommand.targetId?.includes('comment') ||
         obj.reloadContinuationItemsCommand.slot === 'RELOAD_CONTINUATION_SLOT_HEADER')) {
      return obj.reloadContinuationItemsCommand.token;
    }

    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of vals) {
      if (v && typeof v === 'object') {
        const found = findCommentToken(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Extracts the first comment-section continuation token from ytInitialData.
   * Tries multiple known paths before falling back to recursive search.
   */
  function extractInitialToken(initialData) {
    try {
      // Path A: twoColumnWatchNextResults (standard watch page)
      const contents = initialData
        ?.contents
        ?.twoColumnWatchNextResults
        ?.results
        ?.results
        ?.contents;

      if (Array.isArray(contents)) {
        for (const section of contents) {
          // itemSectionRenderer that is the comments section
          const items = section?.itemSectionRenderer?.contents;
          if (!items) continue;
          for (const item of items) {
            const token = item?.continuationItemRenderer
              ?.continuationEndpoint
              ?.continuationCommand
              ?.token;
            if (token) return token;
          }
        }
      }

      // Path B: engagementPanels (alternate layout)
      const panels = initialData?.engagementPanels;
      if (Array.isArray(panels)) {
        for (const panel of panels) {
          const token = findCommentToken(panel, 0);
          if (token) return token;
        }
      }
    } catch {}

    // Fallback: deep recursive search
    return findCommentToken(initialData, 0);
  }

  // ─── Comment Parsing ──────────────────────────────────

  /** Converts a YouTube "runs" text object to a plain string */
  function runsToText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
    return '';
  }

  /** Picks the best-resolution thumbnail URL from an array */
  function bestThumb(thumbnails) {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return '';
    // Prefer 48px or close
    const sorted = [...thumbnails].sort((a, b) => Math.abs((a.width || 0) - 48) - Math.abs((b.width || 0) - 48));
    return sorted[0]?.url || '';
  }

  /**
   * Recursively walks an API response object and collects comment objects.
   * Handles both old (commentRenderer) and new (commentEntityPayload) formats.
   */
  function walkAndCollect(obj, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 35) return;

    // ── Format A: Classic commentRenderer ──
    if (obj.commentRenderer) {
      const c = obj.commentRenderer;
      const text   = runsToText(c.contentText);
      const author = runsToText(c.authorText) || 'Anônimo';
      const avatar = bestThumb(c.authorThumbnail?.thumbnails);
      if (text) out.push({ text, author, avatar });
    }

    // ── Format B: New commentEntityPayload (2024+) ──
    if (obj.commentEntityPayload) {
      const c    = obj.commentEntityPayload;
      const text = c.properties?.content?.content || '';
      const author = c.author?.displayName || 'Anônimo';
      const avatar = c.author?.avatarThumbnailUrl || '';
      if (text) out.push({ text, author, avatar });
    }

    // ── Format C: engagementPanelSectionListRenderer with comments ──
    if (obj.commentViewModel) {
      const c    = obj.commentViewModel;
      const text = c.commentText || runsToText(c.renderedCommentText) || '';
      const author = c.authorDisplayName || 'Anônimo';
      const avatar = c.authorThumbnailUrl || '';
      if (text) out.push({ text, author, avatar });
    }

    // Recurse
    const iter = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of iter) {
      if (v && typeof v === 'object') walkAndCollect(v, out, depth + 1);
    }
  }

  /**
   * Finds the next continuation token inside an API response
   * (for paginating to the next page of comments).
   */
  function findNextToken(responseData) {
    // Look for continuationItemRenderer at top level of the response
    try {
      const items = responseData
        ?.onResponseReceivedEndpoints?.[0]
        ?.appendContinuationItemsAction
        ?.continuationItems;

      if (Array.isArray(items)) {
        for (const item of items) {
          const token = item?.continuationItemRenderer
            ?.continuationEndpoint
            ?.continuationCommand
            ?.token;
          if (token) return token;
        }
      }
    } catch {}

    // Fallback: recursive search (slower)
    return findCommentToken(responseData, 0);
  }

  // ─── Sending Comments ─────────────────────────────────

  function sendComments(comments) {
    if (!comments || comments.length === 0) return;
    window.postMessage({
      type:     'YTSC_COMMENTS',
      source:   SOURCE_TAG,
      comments: comments,
    }, '*');
  }

  // ─── Proactive InnerTube Fetch ────────────────────────

  let _activeFetch = false; // Prevent concurrent fetches

  /**
   * Proactively fetches comments for the current video using InnerTube API.
   * Paginates through up to MAX_PAGES pages.
   */
  async function fetchCommentsProactively() {
    if (_activeFetch) return;
    _activeFetch = true;

    try {
      const apiKey = getApiKey();
      if (!apiKey) { _activeFetch = false; return; }

      // Wait a bit for ytInitialData to be populated by YouTube
      await sleep(1500);

      const initialData = window.ytInitialData;
      if (!initialData) { _activeFetch = false; return; }

      let token = extractInitialToken(initialData);
      if (!token) {
        console.log('[YTSuperComments] No initial comment token found in ytInitialData');
        _activeFetch = false;
        return;
      }

      console.log('[YTSuperComments] Starting proactive comment fetch...');
      const client = getClientContext();
      let page = 0;

      while (token && page < MAX_PAGES) {
        try {
          const url = `https://www.youtube.com/youtubei/v1/next?key=${apiKey}&prettyPrint=false`;
          const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context: { client },
              continuation: token,
            }),
          });

          if (!res.ok) break;
          const data = await res.json();

          // Parse comments from this page
          const pageComments = [];
          walkAndCollect(data, pageComments);
          if (pageComments.length > 0) {
            sendComments(pageComments);
            console.log(`[YTSuperComments] Page ${page + 1}: ${pageComments.length} comments`);
          }

          // Get next page token
          token = findNextToken(data);
          page++;

          if (token && page < MAX_PAGES) await sleep(PAGE_DELAY);
        } catch (e) {
          console.log('[YTSuperComments] Fetch error:', e);
          break;
        }
      }

      console.log(`[YTSuperComments] Done. Fetched ${page} page(s).`);
    } catch (e) {
      console.log('[YTSuperComments] Proactive fetch failed:', e);
    } finally {
      _activeFetch = false;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Intercept fetch (passive capture) ───────────────
  // Captures comments from ANY YouTube API call that returns comment data,
  // e.g. when the user naturally scrolls to comments or loads more.

  const _origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await _origFetch.call(this, input, init);
    try {
      const url = (typeof input === 'string' ? input : input?.url) || '';
      if (url.includes('/youtubei/v1/')) {
        const clone = response.clone();
        clone.json().then(data => {
          const comments = [];
          walkAndCollect(data, comments);
          if (comments.length > 0) sendComments(comments);
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  // ─── Intercept XHR (fallback) ─────────────────────────
  const _origXHROpen = XMLHttpRequest.prototype.open;
  const _origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ytscUrl = url || '';
    return _origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._ytscUrl?.includes('/youtubei/v1/')) {
      this.addEventListener('load', function () {
        try {
          const data = JSON.parse(this.responseText);
          const comments = [];
          walkAndCollect(data, comments);
          if (comments.length > 0) sendComments(comments);
        } catch {}
      });
    }
    return _origXHRSend.call(this, body);
  };

  // ─── Navigation Listener ──────────────────────────────
  // YouTube is a SPA. Listen for navigation events to re-trigger fetch.

  function onVideoNavigate() {
    _activeFetch = false; // allow new fetch
    // Small delay to let ytInitialData update for new video
    setTimeout(fetchCommentsProactively, 500);
  }

  document.addEventListener('yt-navigate-finish', onVideoNavigate);

  // Initial load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onVideoNavigate);
  } else {
    onVideoNavigate();
  }

})();
