// Coverflux for the web – runs the visualizer in any modern browser, no Spotify involved:
//   · play audio files (exact offline beat analysis, cover from the file's tags),
//   · follow a shared tab / system audio or the microphone live (real-time beat tracking).
// Everything stays on the device; nothing is uploaded.
(function CoverfluxWeb() {
  "use strict";
  const engine = coverfluxBeatFactory();
  const lang = (navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en";
  const T = (de, en) => (lang === "de" ? de : en);
  const AUDIO_EXT = /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|webm)$/i;
  const REPO = "https://github.com/yInfra/coverflux";

  const listeners = {};
  const emit = (ev, ...a) => (listeners[ev] || []).forEach((cb) => { try { cb(...a); } catch (e) { console.error(e); } });

  /* ------------------------------------------------------------------ */
  /* Sources                                                             */
  /* ------------------------------------------------------------------ */
  const demoTrack = { uri: "demo", title: "Coverflux", artist: T("Demo · wähle eine Quelle", "Demo · pick a source"), duration: 0 };
  let source = { kind: "demo", track: demoTrack, cover: null, analysis: null, t0: performance.now() };
  let audioEl = null, queue = [], qi = -1, userCover = null;
  let liveCtx = null, liveStream = null, liveNode = null, liveTimer = 0, live = null, samplesIn = 0, lastChunkAt = 0;

  const host = {
    name: "web",
    closable: false,
    library: false,
    keyTarget: document,
    storage: {
      get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
    },
    position() {
      if (source.kind === "file" && audioEl) return { pos: audioEl.currentTime, playing: !audioEl.paused };
      if (source.kind === "live") return { pos: samplesIn / engine.SR + (performance.now() - lastChunkAt) / 1000, playing: true };
      return { pos: ((performance.now() - source.t0) / 1000) % 200, playing: true };
    },
    track: () => source.track,
    getAnalysis: async (uri) => (uri === source.track.uri ? source.analysis : null),
    trackCover: async () => userCover || source.cover || generatedCover(source.track),
    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
  };

  function setSource(next) {
    source = next;
    emit("track");
    syncChip();
  }

  /* ---- files: exact analysis ---- */
  let worker = null;
  function analyse(mono) {
    try {
      if (!worker) {
        const src = coverfluxBeatFactory.toString() + "\nconst E = coverfluxBeatFactory();\nonmessage = (e) => { try { postMessage({ ok: true, a: E.analyze(e.data) }); } catch (err) { postMessage({ ok: false, err: String(err) }); } };";
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      }
      return new Promise((res, rej) => {
        worker.onmessage = (e) => (e.data.ok ? res(e.data.a) : rej(new Error(e.data.err)));
        worker.onerror = (e) => { e.preventDefault(); worker = null; try { res(engine.analyze(mono)); } catch (err) { rej(err); } };
        worker.postMessage(mono);
      });
    } catch (_) {
      return Promise.resolve(engine.analyze(mono));
    }
  }
  async function decode(buf) {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ab = await new AC(1, 1, engine.SR).decodeAudioData(buf);
    const ch = []; for (let i = 0; i < ab.numberOfChannels; i++) ch.push(ab.getChannelData(i));
    return { mono: engine.toMono22k(ch, ab.sampleRate), duration: ab.duration };
  }

  async function playFiles(files) {
    const list = Array.from(files || []).filter((f) => AUDIO_EXT.test(f.name) || /^audio\//.test(f.type));
    if (!list.length) { toast(T("Keine Audiodatei gefunden", "No audio file found")); return; }
    queue = list; qi = -1;
    await nextFile();
  }
  async function nextFile(step = 1) {
    if (!queue.length) return;
    qi = (qi + step + queue.length) % queue.length;
    const f = queue[qi];
    stopLive();
    hideStart();
    busy(T("Analysiere ", "Analysing ") + f.name + " …");
    try {
      const buf = await f.arrayBuffer();
      const tags = readTags(buf);
      const { mono, duration } = await decode(buf.slice(0));
      const analysis = await analyse(mono);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.addEventListener("ended", () => nextFile(1));
        for (const ev of ["play", "pause", "seeked"]) audioEl.addEventListener(ev, () => { emit("playpause"); syncChip(); });
      }
      if (audioEl.src) URL.revokeObjectURL(audioEl.src);
      audioEl.src = URL.createObjectURL(f);
      const fromName = splitName(f.name);
      const cover = tags.picture ? await blobImage(tags.picture) : null;
      userCover = null;
      setSource({ kind: "file", track: { uri: "file:" + f.name + ":" + f.size, title: tags.title || fromName.title, artist: tags.artist || fromName.artist, duration }, cover, analysis });
      busy(null);
      try { await audioEl.play(); } catch (_) { toast(T("Zum Abspielen tippen", "Tap to play")); }
    } catch (e) {
      console.error(e);
      busy(null);
      toast(T("Datei konnte nicht gelesen werden: ", "Could not read file: ") + f.name);
    }
  }

  /* ---- live: microphone or shared tab / system audio ---- */
  async function startLive(kind) {
    const noProc = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream;
    try {
      if (kind === "mic") stream = await navigator.mediaDevices.getUserMedia({ audio: noProc });
      else {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: Object.assign({ suppressLocalAudioPlayback: false }, noProc), systemAudio: "include", selfBrowserSurface: "exclude" });
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach((t) => t.stop());
          toast(T("Kein Ton geteilt – beim Teilen „Audio teilen“ anhaken", "No audio shared – tick “Share audio” when sharing"), 6000);
          return;
        }
      }
    } catch (e) {
      toast(kind === "mic" ? T("Kein Zugriff aufs Mikrofon", "No microphone access") : T("Teilen abgebrochen", "Sharing cancelled"));
      return;
    }
    stopLive();
    if (audioEl) audioEl.pause();
    hideStart();
    liveStream = stream;
    let ctx;
    try { ctx = new AudioContext({ sampleRate: engine.SR }); } catch (_) { ctx = new AudioContext(); }
    liveCtx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    live = engine.createLive(); samplesIn = 0; lastChunkAt = performance.now();
    proc.onaudioprocess = (e) => {
      let x = e.inputBuffer.getChannelData(0);
      x = ctx.sampleRate === engine.SR ? new Float32Array(x) : engine.toMono22k([x], ctx.sampleRate);
      live.push(x);
      samplesIn += x.length; lastChunkAt = performance.now();
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    liveNode = { src, proc, mute };
    const uri = "live:" + kind + ":" + Date.now();
    setSource({ kind: "live", liveKind: kind, track: { uri, title: kind === "mic" ? T("Mikrofon", "Microphone") : T("Tab- oder Systemton", "Tab or system audio"), artist: T("Live · Beat wird erkannt …", "Live · finding the beat …"), duration: 0 }, cover: null, analysis: null });
    liveTimer = setInterval(() => {
      const a = live && live.update();
      if (!a) return;
      source.analysis = a;
      if (source.track.artist.includes("…")) { source.track = Object.assign({}, source.track, { artist: "Live · " + Math.round(live.tempo) + " BPM" }); emit("track"); }
      emit("analysis", source.track.uri, a);
    }, 500);
    for (const t of stream.getTracks()) t.addEventListener("ended", () => { if (liveStream === stream) { stopLive(); showStart(); } });
  }
  function stopLive() {
    clearInterval(liveTimer); liveTimer = 0;
    if (liveNode) { try { liveNode.src.disconnect(); liveNode.proc.disconnect(); } catch (_) {} liveNode = null; }
    if (liveStream) { liveStream.getTracks().forEach((t) => t.stop()); liveStream = null; }
    if (liveCtx) { liveCtx.close().catch(() => {}); liveCtx = null; }
    live = null;
  }

  /* ------------------------------------------------------------------ */
  /* Tags: ID3v2 (MP3) and FLAC – title, artist, embedded picture        */
  /* ------------------------------------------------------------------ */
  function readTags(buf) {
    const u = new Uint8Array(buf, 0, Math.min(buf.byteLength, 8 << 20));
    try {
      if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) return id3(u);
      if (u[0] === 0x66 && u[1] === 0x4c && u[2] === 0x61 && u[3] === 0x43) return flac(u);
    } catch (e) { console.warn("[Coverflux] tags", e); }
    return {};
  }
  const syncsafe = (u, p) => (u[p] << 21) | (u[p + 1] << 14) | (u[p + 2] << 7) | u[p + 3];
  const be32 = (u, p) => ((u[p] << 24) | (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3]) >>> 0;
  const le32 = (u, p) => (u[p] | (u[p + 1] << 8) | (u[p + 2] << 16) | (u[p + 3] << 24)) >>> 0;
  function text(enc, bytes) {
    const label = enc === 0 ? "iso-8859-1" : enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : "utf-8";
    return new TextDecoder(label).decode(bytes).replace(/\0+$/g, "").split("\0")[0].trim();
  }
  function id3(u) {
    const v = u[3], size = syncsafe(u, 6), out = {};
    let p = 10;
    if (u[5] & 0x40) p += v === 4 ? syncsafe(u, 10) : be32(u, 10) + 4;
    while (p + 10 < Math.min(u.length, size + 10)) {
      const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = v === 4 ? syncsafe(u, p + 4) : be32(u, p + 4);
      if (len <= 0 || p + 10 + len > u.length) break;
      const body = u.subarray(p + 10, p + 10 + len);
      if (id === "TIT2") out.title = text(body[0], body.subarray(1));
      else if (id === "TPE1") out.artist = text(body[0], body.subarray(1));
      else if (id === "APIC" && !out.picture) {
        const enc = body[0];
        let q = 1; while (q < body.length && body[q]) q++;
        const mime = new TextDecoder("iso-8859-1").decode(body.subarray(1, q)) || "image/jpeg";
        q += 2; // NUL + picture type
        if (enc === 1 || enc === 2) { while (q + 1 < body.length && (body[q] || body[q + 1])) q += 2; q += 2; } else { while (q < body.length && body[q]) q++; q++; }
        out.picture = new Blob([body.slice(q)], { type: mime.includes("/") ? mime : "image/" + mime.toLowerCase() });
      }
      p += 10 + len;
    }
    return out;
  }
  function flac(u) {
    const out = {};
    let p = 4, last = false;
    while (!last && p + 4 <= u.length) {
      last = (u[p] & 0x80) !== 0;
      const type = u[p] & 0x7f, len = (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3], b = p + 4;
      if (type === 4) { // vorbis comments
        let q = b + 4 + le32(u, b); const n = le32(u, q); q += 4;
        for (let i = 0; i < n && q < b + len; i++) {
          const l = le32(u, q); const kv = new TextDecoder().decode(u.subarray(q + 4, q + 4 + l)); q += 4 + l;
          const eq = kv.indexOf("="), k = kv.slice(0, eq).toUpperCase(), val = kv.slice(eq + 1);
          if (k === "TITLE" && !out.title) out.title = val;
          if (k === "ARTIST" && !out.artist) out.artist = val;
        }
      } else if (type === 6 && !out.picture) { // picture
        let q = b + 4; const ml = be32(u, q); const mime = new TextDecoder().decode(u.subarray(q + 4, q + 4 + ml)); q += 4 + ml;
        const dl = be32(u, q); q += 4 + dl + 16; const pl = be32(u, q); q += 4;
        out.picture = new Blob([u.slice(q, q + pl)], { type: mime || "image/jpeg" });
      }
      p = b + len;
    }
    return out;
  }
  // "Artist - Title.mp3" / "Site.App - Title - Artist.mp3"
  function splitName(name) {
    const parts = name.replace(AUDIO_EXT, "").split(/\s+[-–]\s+/).map((x) => x.trim()).filter((x) => x && !/\.(app|com|net|io|to|cc)$|^(spotidown|y2mate|savefrom)/i.test(x));
    if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(" – ") };
    return { title: parts[0] || name, artist: "" };
  }
  function blobImage(blob) {
    return new Promise((res) => {
      const img = new Image(), url = URL.createObjectURL(blob);
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    });
  }

  // a cover for sources without one: deterministic soft-geometry art from the title
  const coverCache = new Map();
  function generatedCover(track) {
    const key = (track && (track.title + "|" + track.artist)) || "coverflux";
    if (coverCache.has(key)) return coverCache.get(key);
    let h = 2166136261; for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
    const S = 1024, c = document.createElement("canvas"); c.width = c.height = S;
    const g = c.getContext("2d"), hue = rnd() * 360;
    const bg = g.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, `hsl(${hue},55%,14%)`); bg.addColorStop(1, `hsl(${(hue + 50) % 360},60%,26%)`);
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < 7; i++) {
      const x = rnd() * S, y = rnd() * S, r = S * (0.12 + rnd() * 0.32), hh = (hue + (rnd() - 0.5) * 140 + 360) % 360;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `hsla(${hh},85%,62%,0.55)`); rg.addColorStop(1, `hsla(${hh},85%,50%,0)`);
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = "source-over";
    g.strokeStyle = "rgba(255,255,255,.7)"; g.lineWidth = 10;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(S / 2, S / 2, S * (0.16 + i * 0.1), rnd() * 6, rnd() * 6 + 2 + rnd() * 3); g.stroke(); }
    g.fillStyle = "rgba(255,255,255,.92)"; g.font = `600 ${S * 0.075}px system-ui, sans-serif`; g.textAlign = "center";
    g.fillText(((track && track.title) || "Coverflux").slice(0, 22), S / 2, S * 0.9);
    coverCache.set(key, c);
    return c;
  }

  /* ------------------------------------------------------------------ */
  /* Start screen, source chip, drag & drop                              */
  /* ------------------------------------------------------------------ */
  const css = document.createElement("style");
  css.textContent = `
  #cfw{--glass:rgba(14,14,16,.62);--line:rgba(255,255,255,.1);--text:#f3efe8;--mute:rgba(243,239,232,.6);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
  #cfw button{all:unset;cursor:pointer;box-sizing:border-box}
  #cfw button:focus-visible{outline:2px solid var(--cf-accent,#e8e3d9);outline-offset:3px;border-radius:12px}
  #cfw-start{position:fixed;inset:0;z-index:1001;display:grid;place-items:center;padding:16px;background:radial-gradient(120% 90% at 50% 40%,rgba(8,8,10,.25),rgba(8,8,10,.72));
    transition:opacity .5s ease,visibility 0s linear .5s}
  #cfw-start.cfw-hide{opacity:0;visibility:hidden;pointer-events:none}
  .cfw-card{box-sizing:border-box;width:min(560px,100%);padding:34px 30px 22px;border-radius:24px;background:var(--glass);backdrop-filter:blur(26px) saturate(1.5);-webkit-backdrop-filter:blur(26px) saturate(1.5);
    box-shadow:inset 0 0 0 1px var(--line),0 30px 80px rgba(0,0,0,.45)}
  .cfw-card h1{margin:0;font-size:clamp(34px,6vw,52px);font-weight:700;letter-spacing:-.035em;line-height:1}
  .cfw-card h1 span{font-weight:300;opacity:.55}
  .cfw-lede{margin:12px 0 26px;font-size:16px;line-height:1.5;color:var(--mute);max-width:42ch}
  .cfw-src{display:grid;gap:8px}
  #cfw .cfw-src button{display:grid;grid-template-columns:40px 1fr auto;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.05);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);transition:background .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
  #cfw .cfw-src button:hover{background:rgba(255,255,255,.1);transform:translateY(-1px)}
  .cfw-src i{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,.08)}
  .cfw-src b{display:block;font-size:15px;font-weight:650}
  .cfw-src small{display:block;margin-top:2px;font-size:12.5px;color:var(--mute)}
  .cfw-src em{font-style:normal;font-size:18px;opacity:.4}
  .cfw-foot{margin:20px 2px 0;font-size:12px;line-height:1.6;color:var(--mute)}
  .cfw-foot a{color:var(--text);text-decoration:none;border-bottom:1px solid rgba(255,255,255,.25)}
  .cfw-foot a:hover{border-color:var(--text)}
  #cfw-chip{position:fixed;left:24px;top:20px;z-index:1000;display:flex;align-items:center;gap:2px;padding:5px;border-radius:999px;background:var(--glass);
    backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);box-shadow:inset 0 0 0 1px var(--line);transition:opacity .5s ease}
  #cfw-chip.cfw-hide,#coverflux.cf-idle ~ #cfw #cfw-chip{opacity:0;pointer-events:none}
  #cfw-chip button{height:30px;min-width:30px;padding:0 11px;border-radius:999px;display:flex;align-items:center;justify-content:center;gap:7px;font-size:12px;font-weight:600;transition:background .2s ease}
  #cfw-chip button:hover{background:rgba(255,255,255,.1)}
  #cfw-chip .cfw-live{width:7px;height:7px;border-radius:50%;background:#ff5a4f;box-shadow:0 0 10px #ff5a4f}
  #cfw-chip [hidden]{display:none}
  #cfw-drop{position:fixed;inset:12px;z-index:1002;border-radius:22px;border:2px dashed rgba(255,255,255,.5);display:grid;place-items:center;font-size:20px;font-weight:600;
    background:rgba(10,10,12,.55);backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .2s ease}
  #cfw-drop.cfw-on{opacity:1}
  #cfw-toast{position:fixed;left:50%;bottom:28px;z-index:1003;transform:translate(-50%,10px);padding:10px 16px;border-radius:12px;background:var(--glass);
    backdrop-filter:blur(18px);box-shadow:inset 0 0 0 1px var(--line);font-size:13px;opacity:0;transition:opacity .25s ease,transform .25s ease;pointer-events:none;max-width:calc(100% - 32px)}
  #cfw-toast.cfw-on{opacity:1;transform:translate(-50%,0)}
  @media (max-width:600px){.cfw-card{padding:26px 18px 16px;border-radius:20px}#cfw .cfw-src button{grid-template-columns:36px 1fr;padding:12px}.cfw-src em{display:none}
    #cfw-chip{left:16px;top:14px}#cfw-chip .cfw-name{max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
  @media (prefers-reduced-motion:reduce){#cfw-start,#cfw-chip,.cfw-src button{transition:none}}
  `;
  document.head.appendChild(css);

  const ic = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ui = document.createElement("div");
  ui.id = "cfw";
  ui.innerHTML = `
    <div id="cfw-start" role="dialog" aria-label="Coverflux">
      <div class="cfw-card">
        <h1>Cover<span>flux</span></h1>
        <p class="cfw-lede">${T("Albumcover, im Takt durch Kaleidoskope, hyperbolische Kacheln und Droste-Spiralen gefaltet – und immer wieder zurück zum Original.", "Album art folded to the beat through kaleidoscopes, hyperbolic tilings and Droste spirals – and always back to the original.")}</p>
        <div class="cfw-src">
          <button data-src="file">${"<i>" + ic('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>') + "</i>"}<span><b>${T("Datei abspielen", "Play a file")}</b><small>${T("MP3, FLAC, WAV, OGG – exakte Beat-Analyse, auch per Drag & Drop", "MP3, FLAC, WAV, OGG – exact beat analysis, drag & drop works too")}</small></span><em>→</em></button>
          <button data-src="tab">${"<i>" + ic('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>') + "</i>"}<span><b>${T("Tab- oder Systemton", "Tab or system audio")}</b><small>${T("z. B. Spotify im Browser – live, beim Teilen „Audio teilen“ anhaken", "e.g. Spotify in the browser – live, tick “Share audio”")}</small></span><em>→</em></button>
          <button data-src="mic">${"<i>" + ic('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>') + "</i>"}<span><b>${T("Mikrofon", "Microphone")}</b><small>${T("Musik im Raum – live", "Music in the room – live")}</small></span><em>→</em></button>
        </div>
        <p class="cfw-foot">${T("Läuft komplett im Browser, nichts wird hochgeladen.", "Runs entirely in your browser, nothing is uploaded.")} <a href="${REPO}" target="_blank" rel="noopener">GitHub</a> · <a href="${REPO}#spotify-desktop" target="_blank" rel="noopener">${T("Für Spotify Desktop", "For Spotify Desktop")}</a></p>
      </div>
    </div>
    <div id="cfw-chip" class="cfw-hide">
      <button class="cfw-source" title="${T("Quelle wechseln", "Change source")}"><span class="cfw-live" hidden></span><span class="cfw-name"></span></button>
      <button class="cfw-prev" title="${T("Vorheriger", "Previous")}" aria-label="${T("Vorheriger", "Previous")}" hidden>${ic('<path d="M19 20L9 12l10-8zM5 19V5"/>')}</button>
      <button class="cfw-play" title="${T("Abspielen/Pause (Leertaste)", "Play/pause (space)")}" aria-label="Play/Pause" hidden></button>
      <button class="cfw-next" title="${T("Nächster", "Next")}" aria-label="${T("Nächster", "Next")}" hidden>${ic('<path d="M5 4l10 8-10 8zM19 5v14"/>')}</button>
      <button class="cfw-img" title="${T("Eigenes Bild als Cover", "Use your own image as cover")}" aria-label="${T("Bild wählen", "Choose image")}">${ic('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>')}</button>
    </div>
    <div id="cfw-drop">${T("Loslassen zum Abspielen", "Drop to play")}</div>
    <div id="cfw-toast" role="status" aria-live="polite"></div>
    <input id="cfw-files" type="file" accept="audio/*,.mp3,.flac,.wav,.ogg,.opus,.m4a" multiple hidden>
    <input id="cfw-image" type="file" accept="image/*" hidden>`;
  document.body.appendChild(ui);
  const $ = (s) => ui.querySelector(s);
  const PLAY = ic('<path d="M7 4l13 8-13 8z"/>'), PAUSE = ic('<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>');

  function hideStart() { $("#cfw-start").classList.add("cfw-hide"); $("#cfw-chip").classList.remove("cfw-hide"); }
  function showStart() { $("#cfw-start").classList.remove("cfw-hide"); $("#cfw-chip").classList.add("cfw-hide"); }
  let toastTimer = 0;
  function toast(msg, ms = 3200) { const t = $("#cfw-toast"); t.textContent = msg; t.classList.add("cfw-on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("cfw-on"), ms); }
  function busy(msg) { if (msg) { const t = $("#cfw-toast"); t.textContent = msg; t.classList.add("cfw-on"); clearTimeout(toastTimer); } else $("#cfw-toast").classList.remove("cfw-on"); }
  function syncChip() {
    const file = source.kind === "file", liveOn = source.kind === "live";
    $(".cfw-name").textContent = source.kind === "demo" ? T("Quelle wählen", "Pick a source") : source.track.title + (source.track.artist && file ? " · " + source.track.artist : "");
    $(".cfw-live").hidden = !liveOn;
    $(".cfw-play").hidden = !file;
    $(".cfw-prev").hidden = $(".cfw-next").hidden = !(file && queue.length > 1);
    $(".cfw-play").innerHTML = audioEl && !audioEl.paused ? PAUSE : PLAY;
  }

  ui.querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.src === "file") $("#cfw-files").click();
    else startLive(b.dataset.src);
  }));
  $("#cfw-files").addEventListener("change", (e) => { playFiles(e.target.files); e.target.value = ""; });
  $("#cfw-image").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    userCover = await blobImage(f);
    if (cf) cf.refresh(); emit("track");
  });
  $(".cfw-source").addEventListener("click", showStart);
  $(".cfw-img").addEventListener("click", () => $("#cfw-image").click());
  $(".cfw-play").addEventListener("click", () => { if (audioEl) audioEl.paused ? audioEl.play() : audioEl.pause(); });
  $(".cfw-prev").addEventListener("click", () => nextFile(-1));
  $(".cfw-next").addEventListener("click", () => nextFile(1));
  $("#cfw-start").addEventListener("click", (e) => { if (e.target.id === "cfw-start" && source.kind !== "demo") hideStart(); });
  document.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || "")) return;
    if (e.key === " " && audioEl && source.kind === "file") { e.preventDefault(); audioEl.paused ? audioEl.play() : audioEl.pause(); }
    if (e.key === "Escape" && source.kind !== "demo" && $("#cfw-start").classList.contains("cfw-hide") === false) hideStart();
  });
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("#cfw-drop").classList.add("cfw-on"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#cfw-drop").classList.remove("cfw-on"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; $("#cfw-drop").classList.remove("cfw-on");
    const files = Array.from(e.dataTransfer.files || []);
    const img = files.find((f) => /^image\//.test(f.type));
    if (img && !files.some((f) => AUDIO_EXT.test(f.name))) { blobImage(img).then((im) => { userCover = im; emit("track"); }); return; }
    playFiles(files);
  });

  const cf = createCoverflux(host);
  cf.open();
  window.Coverflux = Object.assign(cf, { web: { playFiles, startLive, stopLive, get source() { return source; } } });
})();
