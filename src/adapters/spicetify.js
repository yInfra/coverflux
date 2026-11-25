// NAME: Coverflux
// AUTHOR: yInfra
// DESCRIPTION: Turns everything above the playbar into a beat-locked visualizer that morphs the cover art through mathematical mappings and always lands back on the original.
// VERSION: 3.1.0

// Spicetify host adapter: feeds the Coverflux core from Spotify Desktop (player, metadata, covers, Spotify's
// audio analysis, LocalStorage) and adds the button next to the lyrics button in the playbar.
(function CoverfluxSpicetify() {
  "use strict";
  const S = window.Spicetify;
  if (!(S && S.Player && S.Player.addEventListener && S.Playbar && S.Playbar.Button && S.LocalStorage && S.Platform)) {
    setTimeout(CoverfluxSpicetify, 300);
    return;
  }
  if (window.__coverfluxLoaded) return;
  window.__coverfluxLoaded = true;

  const ICON = '<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z"/><path d="M4.2 9.6c1.3-2.9 2.6-2.9 3.8 0s2.5 2.9 3.8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 6.1c.9-.9 1.9-.9 3 0s2.1.9 3 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/></svg>';

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const largest = (imgs) => (Array.isArray(imgs) && imgs.length ? imgs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0].url : null);
  // spotify:image:<id> -> https URL; everything else as is
  const imageUrl = (u) => (!u ? null : u.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + u.slice(14) : u);

  const current = () => S.Player.data && (S.Player.data.item || S.Player.data.track);

  function trackMeta(item) {
    if (!item) return null;
    const md = item.metadata || {};
    const uri = item.uri || "";
    let title = md.title || item.name || "", artist = md.artist_name || (item.artists && item.artists.map((x) => x.name).join(", ")) || "";
    if (/^spotify:local:/.test(uri) && (!title || !artist)) {
      // spotify:local:<artist>:<album>:<title>:<seconds>
      const p = uri.split(":").slice(2).map((x) => { try { return decodeURIComponent(x.replace(/\+/g, " ")); } catch (_) { return x; } });
      artist = artist || p[0] || ""; title = title || p[2] || "";
    }
    let duration = 0;
    try { duration = (S.Player.getDuration() || 0) / 1000; } catch (_) {}
    return { uri, title, artist, duration, local: /^spotify:local:/.test(uri) };
  }

  function trackCover() {
    const item = current();
    if (!item) return null;
    const md = item.metadata || {};
    return imageUrl(md.image_xlarge_url || md.image_large_url || md.image_url || largest(item.images) || largest(item.album && item.album.images));
  }

  const contextCache = new Map();
  async function contextCover() {
    const data = S.Player.data || {};
    const ctx = data.context || {};
    const uri = ctx.uri || data.context_uri || "";
    if (!uri) return null;
    if (contextCache.has(uri)) return contextCache.get(uri);
    let url = null;
    const md = ctx.metadata || data.context_metadata || {};
    for (const k of ["image_xlarge_url", "image_large_url", "image_url"]) if (md[k]) { url = imageUrl(md[k]); break; }
    const type = uri.split(":")[1];
    if (!url && type === "playlist") {
      try {
        const api = S.Platform.PlaylistAPI;
        if (api && api.getMetadata) {
          const m = await withTimeout(api.getMetadata(uri), 6000);
          url = imageUrl(largest(m.images) || (m.image && m.image.url) || m.picture);
        }
      } catch (_) {}
      if (!url && S.CosmosAsync) {
        try {
          const m = await withTimeout(S.CosmosAsync.get("https://api.spotify.com/v1/playlists/" + uri.split(":").pop() + "?fields=images"), 6000);
          url = imageUrl(largest(m.images));
        } catch (_) {}
      }
    }
    if (!url && type === "album") url = trackCover();
    if (url) contextCache.set(uri, url);
    return url;
  }

  function bottomInset() {
    const bar = document.querySelector('.Root__now-playing-bar, [data-testid="now-playing-bar"], footer[data-testposition="now-playing-bar"], .main-nowPlayingBar-container');
    if (!bar) return 90;
    const r = bar.getBoundingClientRect();
    return r.height > 0 ? window.innerHeight - r.top : 90;
  }

  const host = {
    name: "spicetify",
    playbarGlow: true,
    storage: { get: (k) => S.LocalStorage.get(k), set: (k, v) => S.LocalStorage.set(k, v) },
    position: () => ({ pos: (S.Player.getProgress() || 0) / 1000, playing: !!S.Player.isPlaying() }),
    track: () => trackMeta(current()),
    // Spotify has no analysis for local files – the core then uses its own library analysis
    getAnalysis: (uri) => (/^spotify:local:/.test(uri) || typeof S.getAudioData !== "function" ? null : S.getAudioData(uri)),
    trackCover: async () => trackCover(),
    contextCover,
    accent: async () => {
      const item = current();
      if (!S.colorExtractor || !item || !item.uri) return null;
      const c = await S.colorExtractor(item.uri);
      return c && (c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT);
    },
    on(event, cb) {
      if (event === "track") S.Player.addEventListener("songchange", cb);
      else if (event === "playpause") S.Player.addEventListener("onplaypause", cb);
    },
    bottomInset,
    mountToggle(toggle) {
      // right side of the playbar, next to the lyrics (karaoke) button
      const button = new S.Playbar.Button("Coverflux Visualizer", ICON, toggle, false, false, true);
      const label = () => {
        const el = button.element;
        if (el && el.setAttribute) { el.setAttribute("aria-label", "Coverflux Visualizer"); el.setAttribute("data-testid", "coverflux-button"); }
      };
      label(); setTimeout(label, 1500);
      return button;
    },
  };

  window.Coverflux = createCoverflux(host);
})();
