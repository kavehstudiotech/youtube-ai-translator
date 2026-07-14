/*
 * inject-main.js  —  runs in the page's MAIN world.
 *
 * YouTube no longer serves /api/timedtext to arbitrary callers: the URL in
 * ytInitialPlayerResponse lacks the `pot` (proof-of-origin) token and returns
 * an empty 200. The ONLY caller that gets a valid token is YouTube's own player.
 *
 * Strategy: hook fetch + XHR so we capture the exact timedtext URL the player
 * requests (with a valid pot). On request from the isolated script we briefly
 * enable a caption track to force that fetch, capture the URL, then turn the
 * native track back off. The isolated script re-fetches the captured URL as
 * json3 to get the full transcript.
 */
(() => {
  const REQ = 'ytfa-req';
  const RES = 'ytfa-res';

  let lastTimedText = null;
  const waiters = [];

  function normalizeToJson3(u) {
    try {
      const url = new URL(u, location.origin);
      if (!url.pathname.includes('/api/timedtext')) return null;
      url.searchParams.set('fmt', 'json3');
      return url.toString();
    } catch (_) {
      return null;
    }
  }

  function capture(u) {
    const n = normalizeToJson3(u);
    if (!n) return;
    lastTimedText = n;
    while (waiters.length) {
      try {
        waiters.shift()(n);
      } catch (_) {}
    }
  }

  // --- hook fetch ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const u = typeof input === 'string' ? input : input && input.url;
      if (u && String(u).includes('/api/timedtext')) capture(u);
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  // --- hook XHR ---
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url && String(url).includes('/api/timedtext')) capture(url);
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  function waitForUrl(timeout) {
    return new Promise((resolve) => {
      if (lastTimedText) return resolve(lastTimedText);
      const w = (u) => resolve(u);
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        resolve(lastTimedText);
      }, timeout);
    });
  }

  function getContext() {
    const player = document.getElementById('movie_player');
    let resp = null;
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        resp = player.getPlayerResponse();
      } catch (_) {}
    }
    resp = resp || window.ytInitialPlayerResponse || null;
    const videoId = resp?.videoDetails?.videoId || null;
    const respTracks =
      resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return { player, videoId, respTracks };
  }

  function pickTrack(list) {
    if (!list || !list.length) return null;
    return (
      list.find((t) => t.kind !== 'asr' && (t.languageCode || '').startsWith('en')) ||
      list.find((t) => t.kind !== 'asr') ||
      list.find((t) => (t.languageCode || '').startsWith('en')) ||
      list[0]
    );
  }

  async function captureCaptionUrl(player) {
    // Prefer the player's own tracklist for setOption (correct object shape).
    let tracklist = [];
    try {
      tracklist = player.getOption('captions', 'tracklist') || [];
    } catch (_) {}

    if (!tracklist.length) {
      // Captions module may not be loaded yet — nudge it and retry.
      try {
        player.loadModule && player.loadModule('captions');
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 600));
      try {
        tracklist = player.getOption('captions', 'tracklist') || [];
      } catch (_) {}
    }

    const track = pickTrack(tracklist);
    if (!track) return { url: lastTimedText, track: null };

    lastTimedText = null;
    let url = null;
    try {
      player.setOption('captions', 'track', track); // forces the player to fetch
      url = await waitForUrl(5000);
    } catch (_) {}
    // Turn the native caption overlay back off (we render our own).
    try {
      player.setOption('captions', 'track', {});
    } catch (_) {}

    return { url: url || lastTimedText, track };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== REQ || data.type !== 'GET_CAPTIONS') return;

    const { player, videoId, respTracks } = getContext();
    if (!player || !respTracks.length) {
      window.postMessage(
        { channel: RES, reqId: data.reqId, videoId, url: null, tracks: [] },
        '*'
      );
      return;
    }

    const { url, track } = await captureCaptionUrl(player);
    window.postMessage(
      {
        channel: RES,
        reqId: data.reqId,
        videoId,
        url,
        lang: track?.languageCode || null,
        tracks: respTracks.map((t) => ({
          lang: t.languageCode,
          kind: t.kind || 'manual',
        })),
      },
      '*'
    );
  });
})();
