// NAME: Coverflux
// AUTHOR: yInfra
// DESCRIPTION: Turns everything above the playbar into a beat-locked visualizer that morphs the cover art along beat-locked loops that always move forward and land on the original.
// VERSION: 2.6.0

(function Coverflux() {
  "use strict";
  const S = window.Spicetify;
  if (!(S && S.Player && S.Player.addEventListener && S.Playbar && S.Playbar.Button && S.LocalStorage && S.Platform)) {
    setTimeout(Coverflux, 300);
    return;
  }
  if (window.__coverfluxLoaded) return;
  window.__coverfluxLoaded = true;

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */
  const SETTINGS_KEY = "coverflux:settings";
  const TEMPO_KEY = "coverflux:tempo"; // per-track tempo-feel overrides
  const DEFAULTS = { source: "track", intensity: 0.75, mode: "auto", showInfo: true, syncMs: 0, frame: "full" };
  const loadJSON = (k, def) => { try { return Object.assign({}, def, JSON.parse(S.LocalStorage.get(k) || "{}")); } catch (_) { return Object.assign({}, def); } };
  const settings = loadJSON(SETTINGS_KEY, DEFAULTS);
  // Modes Auto may pick from. One enabled mode = that mode, fixed. (Migrates the old single `mode` setting.)
  if (!Array.isArray(settings.modes)) settings.modes = PRESET_KEYS().includes(settings.mode) ? [settings.mode] : PRESET_KEYS();
  settings.modes = PRESET_KEYS().filter((k) => settings.modes.includes(k));
  if (!settings.modes.length) settings.modes = PRESET_KEYS();
  delete settings.mode;
  const tempoOverrides = loadJSON(TEMPO_KEY, {});
  const saveSettings = () => { try { S.LocalStorage.set(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} };
  const saveTempo = () => {
    const keys = Object.keys(tempoOverrides);
    if (keys.length > 300) delete tempoOverrides[keys[0]];
    try { S.LocalStorage.set(TEMPO_KEY, JSON.stringify(tempoOverrides)); } catch (_) {}
  };

  // One morph character at a time. `fill` = how far the sharp, mirrored cover spreads beyond its square while morphing.
  function PRESET_KEYS() { return ["liquid", "vortex", "ripple", "prism", "kaleido", "mandala", "fractal", "tunnel"]; }
  const PRESETS = {
    liquid:  { label: "Liquid",  mode: 0, fill: 3.0,  desc: "Marmorstrom, fließt eine Periode weiter" },
    vortex:  { label: "Vortex",  mode: 1, fill: 3.0,  desc: "Ringe drehen volle Runden" },
    ripple:  { label: "Ripple",  mode: 2, fill: 1.6,  desc: "Wasser zieht quer durchs Bild" },
    prism:   { label: "Prism",   mode: 4, fill: 1.8,  desc: "Geriffeltes Glas, Regenbogenkanten" },
    kaleido: { label: "Kaleido", mode: 5, fill: 3.0,  desc: "Faltet sich von innen nach außen" },
    mandala: { label: "Mandala", mode: 6, fill: 3.0,  desc: "Kaleido auf einer Spirale" },
    fractal: { label: "Fractal", mode: 7, fill: 3.0,  desc: "Faltet sich Stufe für Stufe" },
    tunnel:  { label: "Tunnel",  mode: 8, fill: 0.15, desc: "Droste-Tauchgang ins Cover" },
  };
  // Auto mode picks from these depending on the energy of the current song section.
  const CALM_POOL = ["liquid", "ripple", "kaleido", "mandala", "prism"];
  const LOUD_POOL = ["kaleido", "fractal", "vortex", "tunnel", "mandala", "liquid", "prism"];
  const CYCLE_BARS = 16; // one full loop away from the cover and back onto it

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  // progress inside one beat: a steady glide plus a surge right on the beat – never stands still
  const beatEase = (fr, k, b) => (1 - b) * fr + b * (1 - Math.pow(1 - fr, k));
  const smooth01 = (x) => { const t = clamp(x); return t * t * (3 - 2 * t); };
  const follow = (cur, target, up, down, dt) => cur + (target - cur) * (1 - Math.exp(-(target > cur ? up : down) * dt));
  const hashStr = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  const mulberry = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const imageUrl = (u) => {
    if (!u || typeof u !== "string") return null;
    if (/^[0-9a-f]{40}$/i.test(u)) return "https://i.scdn.co/image/" + u; // bare image id (context metadata)
    if (u.startsWith("spotify:image:")) return "https://i.scdn.co/image/" + u.slice("spotify:image:".length);
    if (u.startsWith("spotify:mosaic:")) {
      const ids = u.slice("spotify:mosaic:".length).split(/[:,]/);
      return ids.length ? "https://i.scdn.co/image/" + ids[0] : null;
    }
    return u;
  };
  const largest = (images) => {
    if (!Array.isArray(images) || !images.length) return null;
    const sorted = images.slice().sort((a, b) => (b.width || b.height || 0) - (a.width || a.height || 0));
    return sorted[0].url || sorted[0].uri || null;
  };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  /* ------------------------------------------------------------------ */
  /* Audio model – Spotify audio analysis, with honest synthetic fallback */
  /* ------------------------------------------------------------------ */
  function buildSynthetic(uri, durationSec) {
    const rnd = mulberry(hashStr(uri || "x"));
    const tempo = 96 + Math.floor(rnd() * 30);
    const beatLen = 60 / tempo;
    const dur = Math.max(30, durationSec || 210);
    const beats = [], bars = [], sections = [], segments = [];
    for (let t = 0, i = 0; t < dur; t += beatLen, i++) {
      beats.push({ start: t, duration: beatLen, confidence: 0.6 });
      if (i % 4 === 0) bars.push({ start: t, duration: beatLen * 4, confidence: 0.6 });
    }
    const secLen = beatLen * 4 * 16;
    const shape = [-17, -10, -6, -13, -5, -19, -7, -9];
    for (let t = 0, i = 0; t < dur; t += secLen, i++) {
      sections.push({ start: t, duration: Math.min(secLen, dur - t), loudness: shape[i % shape.length] + rnd() * 2, tempo });
    }
    let si = 0;
    for (let t = 0; t < dur; t += beatLen / 2) {
      while (si < sections.length - 1 && sections[si + 1].start <= t) si++;
      const base = sections[si].loudness;
      const onBeat = Math.abs((t / beatLen) % 1) < 0.01;
      const max = base + (onBeat ? 3 : -2) + rnd() * 2;
      segments.push({
        start: t, duration: beatLen / 2, loudness_start: max - 8 - rnd() * 4, loudness_max: max,
        loudness_max_time: 0.02, timbre: [0, rnd() * 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      });
    }
    return { synthetic: true, track: { tempo, loudness: -9, duration: dur, time_signature: 4 }, beats, bars, sections, segments };
  }

  // Binary search: index of the last item with start <= t (or -1).
  function lastStart(list, t) {
    if (!list || !list.length || list[0].start > t) return -1;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (list[m].start <= t) lo = m; else hi = m - 1; }
    return lo;
  }

  class AudioModel {
    constructor() { this.cache = new Map(); this.a = null; this.uri = null; this.synthetic = true; }

    async load(uri, durationSec) {
      this.uri = uri;
      if (!uri) { this.set(buildSynthetic("none", durationSec)); return; }
      if (this.cache.has(uri)) { this.set(this.cache.get(uri)); return; }
      this.set(buildSynthetic(uri, durationSec)); // immediate, replaced when real data arrives
      let data = null;
      try {
        if (typeof S.getAudioData === "function") data = await withTimeout(S.getAudioData(uri), 9000);
      } catch (_) { data = null; }
      if (this.uri !== uri) return;
      const ok = data && Array.isArray(data.segments) && data.segments.length > 8 && Array.isArray(data.beats) && data.beats.length > 8;
      const analysis = ok ? data : buildSynthetic(uri, durationSec);
      if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(uri, analysis);
      this.set(analysis);
    }

    set(a) {
      this.a = a;
      this.synthetic = !!a.synthetic;
      this.si = 0; this.sei = 0; this.bpi = 0;
      const segs = a.segments;
      // Per-track adaptive loudness range (10th..96th percentile of segment peaks)
      const peaks = segs.map((s) => s.loudness_max).sort((x, y) => x - y);
      this.lo = peaks[Math.floor(peaks.length * 0.1)] ?? -30;
      this.hi = peaks[Math.floor(peaks.length * 0.96)] ?? -4;
      if (this.hi - this.lo < 6) this.lo = this.hi - 6;
      const secL = (a.sections || []).map((s) => s.loudness).sort((x, y) => x - y);
      this.secLo = secL.length ? secL[0] : -20;
      this.secHi = secL.length ? secL[secL.length - 1] : -5;
      if (this.secHi - this.secLo < 4) this.secLo = this.secHi - 4;

      // ---- beat grid ------------------------------------------------
      this.beats = a.beats;
      this.spotifyTempo = (a.track && a.track.tempo) || 0;
      // tempo of the grid we actually follow: median beat length (Spotify's headline number is sometimes off)
      const durs = this.beats.map((b) => b.duration).filter((d) => d > 0.15 && d < 2.5).sort((x, y) => x - y);
      this.beatLen = durs.length ? durs[durs.length >> 1] : 60 / (this.spotifyTempo || 120);
      this.tempo = 60 / this.beatLen;
      this.spotifyBpb = clamp(Math.round((a.track && a.track.time_signature) || 4), 3, 7);
      this.bpb = this.spotifyBpb;
      const bars = a.bars && a.bars.length ? a.bars : null;
      this._d0 = bars ? this.nearestBeat(bars[0].start) : 0;
      this.shift = 0; this.autoPh = 0; this.onB = null;
      // Each song section starts a fresh morph cycle on its first downbeat.
      this.secAnchor = (a.sections || []).map((s) => {
        let t = s.start;
        if (bars) {
          const i = lastStart(bars, s.start + 0.25);
          const cands = [bars[Math.max(0, i)], bars[Math.min(bars.length - 1, i + 1)]];
          t = cands.reduce((best, b) => (Math.abs(b.start - s.start) < Math.abs(best.start - s.start) ? b : best)).start;
        }
        return this.nearestBeat(t);
      });

      // ---- accent per beat: strongest attack of a segment starting near the beat ----
      const acc = new Float32Array(this.beats.length);
      let j = 0;
      for (let i = 0; i < this.beats.length; i++) {
        const bt = this.beats[i].start;
        while (j < segs.length && segs[j].start < bt - 0.07) j++;
        let best = 0;
        for (let k = j; k < segs.length && segs[k].start <= bt + 0.07; k++) {
          const s = segs[k];
          const att = clamp((s.loudness_max - s.loudness_start) / 20) * (0.3 + 0.7 * this.norm(s.loudness_max));
          if (att > best) best = att;
        }
        acc[i] = best;
      }
      const sorted = Array.from(acc).sort((x, y) => x - y);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
      for (let i = 0; i < acc.length; i++) acc[i] = clamp(acc[i] / Math.max(p95, 1e-3));
      this.acc = acc;
      this.grid = this.synthetic ? null : this.checkGrid(segs);
      this.autoMult = this.synthetic ? 1 : this.detectFeel();
      if (!this.synthetic) this.autoPh = this.bestPhase(this.autoMult);
      if (this.grid) console.info("[Coverflux] Raster:", this.describe(), this.grid);
      this._fa = null; this._csi = 0;
    }

    // Where felt beat 0 sits on Spotify's beat grid: first downbeat + half-beat fix + felt phase (auto or tapped).
    get d0() {
      const o = tempoOverrides[this.uri];
      let ph = this.autoPh;
      if (o && typeof o === "object") ph = o.ph || 0;
      else if (typeof o === "number" && o !== this.autoMult) ph = 0;
      return this._d0 + this.shift + ph;
    }

    // ---- grid checks (all from Spotify's own segment data, no audio access needed) ----
    checkGrid(segs) {
      const B = this.beats, n = B.length;
      if (n < 24 || !segs.length) return null;
      // onset strength per segment: loudness attack + timbre change
      const nd = 12, mean = new Float32Array(nd), sd = new Float32Array(nd);
      const tv = (g, d) => (g.timbre && g.timbre[d]) || 0;
      for (const g of segs) for (let d = 0; d < nd; d++) mean[d] += tv(g, d) / segs.length;
      for (const g of segs) for (let d = 0; d < nd; d++) sd[d] += Math.pow(tv(g, d) - mean[d], 2) / segs.length;
      for (let d = 0; d < nd; d++) sd[d] = Math.sqrt(sd[d]) || 1;
      const z = segs.map((g) => Array.from({ length: nd }, (_, d) => (tv(g, d) - mean[d]) / sd[d]));
      const nov = segs.map((g, i) => {
        if (!i) return 0;
        let x = 0; for (let d = 0; d < nd; d++) x += Math.pow(z[i][d] - z[i - 1][d], 2);
        return Math.sqrt(x);
      });
      const novS = nov.slice().sort((x, y) => x - y), novP = novS[Math.floor(novS.length * 0.9)] || 1;
      const on = segs.map((g, i) => 0.6 * clamp((g.loudness_max - g.loudness_start) / 18) * (0.3 + 0.7 * this.norm(g.loudness_max)) + 0.4 * clamp(nov[i] / novP));
      const onsetNear = (t, w) => {
        let best = 0;
        for (let i = Math.max(0, lastStart(segs, t - w)); i < segs.length && segs[i].start <= t + w; i++) if (segs[i].start >= t - w && on[i] > best) best = on[i];
        return best;
      };
      // 1) is Spotify's grid sitting on the off-beat? onsets on the beats vs. halfway between them
      let sOn = 0, sOff = 0;
      const onB = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const w = Math.min(0.06, 0.2 * B[i].duration);
        onB[i] = onsetNear(B[i].start, w);
        sOn += onB[i]; sOff += onsetNear(B[i].start + 0.5 * B[i].duration, w);
      }
      const offRatio = sOff / Math.max(sOn, 1e-3);
      if (offRatio > 1.6) this.shift = 0.5;
      // 2) duple or triple meter? beat-synchronous timbre+chroma self-similarity and accent correlation at 2/3/4/6 beats
      const feat = [];
      let j = 0;
      for (let i = 0; i < n; i++) {
        const t0 = B[i].start, t1 = t0 + B[i].duration, f = new Float32Array(24);
        while (j < segs.length && segs[j].start + segs[j].duration <= t0) j++;
        let wsum = 0;
        for (let k = j; k < segs.length && segs[k].start < t1; k++) {
          const g = segs[k], w = Math.max(0, Math.min(t1, g.start + g.duration) - Math.max(t0, g.start));
          if (w <= 0) continue;
          for (let d = 0; d < 12; d++) { f[d] += w * z[k][d]; f[12 + d] += w * ((g.pitches && g.pitches[d]) || 0); }
          wsum += w;
        }
        if (wsum > 0) for (let d = 0; d < 24; d++) f[d] /= wsum;
        feat.push(f);
      }
      const cm = new Float32Array(24);
      for (const f of feat) for (let d = 0; d < 24; d++) cm[d] += f[d] / n;
      for (const f of feat) for (let d = 0; d < 24; d++) f[d] -= cm[d];
      const cos = (a, b) => { let ab = 0, aa = 0, bb = 0; for (let d = 0; d < 24; d++) { ab += a[d] * b[d]; aa += a[d] * a[d]; bb += b[d] * b[d]; } return ab / (Math.sqrt(aa * bb) || 1); };
      const acc = this.acc;
      let am = 0; for (let i = 0; i < n; i++) am += acc[i] / n;
      let av = 0; for (let i = 0; i < n; i++) av += Math.pow(acc[i] - am, 2);
      const sim = (k) => { let x = 0; for (let i = 0; i + k < n; i++) x += cos(feat[i], feat[i + k]); return x / Math.max(1, n - k); };
      const ac = (k) => { let x = 0; for (let i = 0; i + k < n; i++) x += (acc[i] - am) * (acc[i + k] - am); return x / Math.max(av, 1e-6); };
      const S = {}; for (const k of [2, 3, 4, 6]) S[k] = sim(k) + 0.5 * ac(k);
      const tripleScore = (S[3] + S[6]) / 2 - (S[2] + S[4]) / 2;
      const spotifyTriple = this.spotifyBpb === 3 || this.spotifyBpb === 6;
      const triple = spotifyTriple ? tripleScore > -0.08 : tripleScore > 0.08;
      if (triple && !spotifyTriple) this.bpb = 3;
      if (!triple && spotifyTriple) this.bpb = 4;
      this.onB = onB;
      return { offRatio: +offRatio.toFixed(2), tripleScore: +tripleScore.toFixed(3), triple };
    }

    // For half/third time: which of the Spotify beats is the felt one? (strongest onsets, slight preference for the bar line)
    bestPhase(m) {
      if (!(m >= 2) || !this.onB) return 0;
      const n = this.beats.length, base = Math.round(this._d0 + this.shift);
      let best = 0, bestS = -1;
      for (let o = 0; o < m; o++) {
        let x = 0, c = 0;
        for (let i = base + o; i < n; i += m) if (i >= 0) { x += this.onB[i] + 0.5 * this.acc[i]; c++; }
        const sc = (c ? x / c : 0) * (o === 0 ? 1.12 : 1);
        if (sc > bestS) { bestS = sc; best = o; }
      }
      return best;
    }

    describe() {
      const m = this.mult(), g = this.grid;
      return "Spotify " + Math.round(this.spotifyTempo) + " BPM " + this.spotifyBpb + "/4 · Raster " + Math.round(this.tempo) + " BPM" +
        (g ? (g.triple ? " · Dreiertakt" : " · Zweiertakt") + (this.shift ? " · um ½ Schlag korrigiert" : "") : "") +
        " → gefühlt " + Math.round(this.tempo / m) + " BPM";
    }

    // Section starts in felt beats (cached per tempo feel).
    feltAnchors(m) {
      const d0 = this.d0;
      if (this._fa && this._faM === m && this._faD === d0) return this._fa;
      const arr = [];
      for (const b of this.secAnchor) { const f = Math.round((b - d0) / m); if (!arr.length || f > arr[arr.length - 1]) arr.push(f); }
      if (!arr.length || arr[0] > 0) arr.unshift(0);
      this._fa = { arr, total: (this.beats.length - d0) / m }; this._faM = m; this._faD = d0;
      return this._fa;
    }

    // Splits every section into ~CYCLE_BARS-bar cycles (whole bars, last one ends on the next section start).
    // u = progress 0..1: steady glide plus a surge on every beat (ease).
    cycleAt(F, m, ease) {
      const { arr, total } = this.feltAnchors(m);
      const bpb = this.bpb;
      if (F < arr[0]) return { id: "pre", u: 0, len: 4 * CYCLE_BARS };
      let si = this._csi || 0;
      if (si >= arr.length || arr[si] > F) si = 0;
      while (si < arr.length - 1 && arr[si + 1] <= F) si++;
      this._csi = si;
      const Fa = arr[si], Fb = si < arr.length - 1 ? arr[si + 1] : Math.max(total, F + 1);
      const Nb = Math.max(1, Math.round((Fb - Fa) / bpb));
      const n = Math.max(1, Math.round(Nb / CYCLE_BARS));
      const rel = (F - Fa) / bpb;
      const edge = (k) => (k >= n ? (Fb - Fa) / bpb : Math.round((k * Nb) / n));
      let k = clamp(Math.floor((rel * n) / Nb), 0, n - 1);
      while (k > 0 && rel < edge(k)) k--;
      while (k < n - 1 && rel >= edge(k + 1)) k++;
      const start = Fa + edge(k) * bpb, len = Math.max(1, (edge(k + 1) - edge(k)) * bpb);
      const local = clamp(F - start, 0, len);
      const kk = Math.floor(local), fr = local - kk;
      return { id: si + ":" + k, u: clamp((kk + ease(fr)) / len), len };
    }

    // Spotify often reports double time for songs that *feel* half as fast.
    // Returns how many Spotify beats make one felt beat (2 = halve, 0.5 = double).
    // The felt pulse stays <= 140 BPM and must fit the meter: triple meter is never halved (every second
    // pulse would land between the beats) – it goes to one pulse per bar instead.
    detectFeel() {
      const T = this.tempo, triple = this.grid && this.grid.triple;
      const cands = triple ? [1, 3, 0.5] : [1, 2, 0.5, 4];
      const lo = triple ? 40 : 55, hi = 140;
      const dist = (m) => Math.abs(Math.log2(T / m / 100));
      const pool = cands.filter((m) => T / m >= lo && T / m <= hi);
      return (pool.length ? pool : cands).reduce((b, m) => (dist(m) < dist(b) ? m : b));
    }

    mult(uri) {
      const o = tempoOverrides[uri || this.uri];
      if (o && typeof o === "object" && o.m > 0.2 && o.m < 8) return o.m;
      return o === 0.5 || o === 1 || o === 2 || o === 3 ? o : this.autoMult || 1;
    }

    nearestBeat(t) {
      const b = this.beats;
      const i = lastStart(b, t);
      if (i < 0) return 0;
      if (i < b.length - 1 && Math.abs(b[i + 1].start - t) < Math.abs(b[i].start - t)) return i + 1;
      return i;
    }

    // Continuous position on the Spotify beat grid (beat index + fraction).
    beatPos(t) {
      const b = this.beats;
      if (!b || !b.length) return t * 2;
      if (t < b[0].start) return (t - b[0].start) / Math.max(b[0].duration, 0.2);
      let i = clamp(this.bpi, 0, b.length - 1);
      if (b[i].start > t || (i < b.length - 1 && b[i + 1].start <= t && b[Math.min(b.length - 1, i + 8)].start <= t)) i = lastStart(b, t);
      while (i < b.length - 1 && b[i + 1].start <= t) i++;
      this.bpi = i;
      const be = b[i];
      const frac = (t - be.start) / Math.max(be.duration, 0.05);
      return i + (i < b.length - 1 ? Math.min(frac, 1) : frac);
    }

    accentAt(beatIndex) {
      const i = Math.round(beatIndex);
      return this.acc && i >= 0 && i < this.acc.length ? this.acc[i] : 0.5;
    }

    seek(list, cursor, t) {
      if (!list || !list.length) return -1;
      let i = clamp(cursor, 0, list.length - 1);
      if (list[i].start > t) return lastStart(list, t);
      while (i < list.length - 1 && list[i + 1].start <= t) i++;
      return i;
    }

    norm(db) { return clamp((db - this.lo) / (this.hi - this.lo)); }

    sample(t) {
      const a = this.a;
      const out = { loud: 0, section: 0, sectionLoud: 0.5 };
      if (!a) return out;
      const si = this.seek(a.segments, this.si, t);
      if (si >= 0) {
        this.si = si;
        const s = a.segments[si], nx = a.segments[si + 1];
        const dt = t - s.start, lmt = s.loudness_max_time || 0;
        let db;
        if (dt < lmt) db = lerp(s.loudness_start, s.loudness_max, dt / Math.max(lmt, 1e-3));
        else db = lerp(s.loudness_max, nx ? nx.loudness_start : s.loudness_max - 12, clamp((dt - lmt) / Math.max(s.duration - lmt, 1e-3)));
        out.loud = this.norm(db);
      }
      const sei = this.seek(a.sections, this.sei, t);
      if (sei >= 0) {
        this.sei = sei;
        out.section = sei;
        out.sectionLoud = clamp((a.sections[sei].loudness - this.secLo) / (this.secHi - this.secLo));
      }
      return out;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Shaders                                                             */
  /* ------------------------------------------------------------------ */
  const VERT = `#version 300 es
  in vec2 aPos; out vec2 vUv;
  void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

  // Scene: every pixel is a point with its own clock. One cycle (uPhi 0→1, ~8 bars) carries each point along a
  // closed loop – a full turn, one mirror period of drift, one Droste period, an orbit – that only ever moves
  // forward and lands exactly where it started. Points start and land at slightly different moments (lag field),
  // which is what bends the picture into spirals, streams and folds. Nothing accumulates, nothing rewinds.
  const SCENE = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uImgA, uImgB, uPrev;
  uniform vec2 uRes;
  uniform float uFrame, uAct, uMix, uSquare, uPhi, uDepth, uGate, uLag, uFillK, uFlow, uPulse, uSeed, uSegs, uHue, uTrail, uGlow, uDisp, uTurns, uDir;
  uniform int uMode;
  const float TAU = 6.2831853, PI = 3.14159265;
  mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,s,-s,c); }
  vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
  vec3 hueShift(vec3 c, float a){ const vec3 k = vec3(0.57735); float ca=cos(a); return c*ca + cross(k,c)*sin(a) + k*dot(k,c)*(1.0-ca); }
  vec2 clampLen(vec2 v, float m){ float l = length(v); return l > m ? v*(m/l) : v; }

  vec2 gGx, gGy; float gShade, gSpec, gEdge, gRim, gE, gF, gDiag; vec2 gDispV, gMask, gQs;

  vec2 mirror(vec2 q){ return 1.0 - abs(1.0 - mod(q, 2.0)); }
  vec3 img(vec2 m){ return mix(textureGrad(uImgA, m, gGx, gGy).rgb, textureGrad(uImgB, m, gGx, gGy).rgb, uMix); }
  vec3 imgLod(vec2 m, float l){ return mix(textureLod(uImgA, m, l).rgb, textureLod(uImgB, m, l).rgb, uMix); }
  // cover space q: [0,1]^2 is the cover square. Outside: blurred ambient – unless fill spreads the sharp mirrored cover.
  vec3 cover(vec2 q, float fill){
    vec2 m = mirror(q);
    // full mode: the mask travels with the morph; square mode: it stays put on screen (warps can fold far points inside)
    vec2 qm = mix(q + gMask, gQs, uFrame);
    float d = max(abs(qm.x-0.5), abs(qm.y-0.5)) - 0.5;
    float soft = 0.002 + 0.12*clamp(fill, 0.0, 1.0);
    // square mode: the cover keeps its square, its edge goes soft and wobbles with the morph
    d += uFrame*gE*0.035*sin(qm.x*9.0 + uFlow*0.7)*sin(qm.y*8.0 - uFlow*0.6 + uSeed);
    soft = mix(soft, 0.006 + 0.06*gE, uFrame);
    float mask = smoothstep(-soft, soft, d - fill);
    vec3 c = img(m);
    if (mask > 0.0) {
      float dd = max(d - fill, 0.0);
      vec3 amb = imgLod(m, 6.0) * (0.10 + 0.32*exp(-dd*1.6)) * (1.0 - 0.75*exp(-dd*9.0));
      // square mode: a darker, blurred mirror everywhere that glows out of the cover edge instead of a shadow gap
      vec3 glow = imgLod(m, 5.0) * (0.11 + 0.34*exp(-dd*2.2)) + imgLod(m, 7.0) * 0.18*exp(-dd*4.0)*(1.0 + gE);
      amb = mix(amb, glow, uFrame);
      c = mix(c, amb, mask);
    }
    return c;
  }
  vec3 colorAt(vec2 w, vec2 gx, vec2 gy, float fill){
    float lim = 6.0/(uRes.y*uSquare);
    gGx = clampLen(gx/uSquare, lim); gGy = clampLen(gy/uSquare, lim);
    vec2 q = w/uSquare + 0.5;
    vec3 c;
    if (uDisp > 0.0005) {
      vec2 dv = (gDispV + (q-0.5)*0.15*gE)*uDisp;
      c = vec3(cover(q+dv, fill).r, cover(q, fill).g, cover(q-dv, fill).b);
    } else c = cover(q, fill);
    if (uGlow > 0.001) c += max(imgLod(mirror(q), 3.5) - 0.55, 0.0) * uGlow;
    return c;
  }

  // a point's own progress through the cycle: starts later and lands later the larger lam is, always within the cycle
  float prog(float lam){ float x = clamp((uPhi - uLag*lam)/(1.0 - uLag), 0.0, 1.0); return mix(x, x*x*(3.0-2.0*x), 0.5); }
  float envOf(float x){ return smoothstep(0.0, 0.2, x)*(1.0 - smoothstep(0.8, 1.0, x)); }
  float sweep(vec2 p, float ang){ return clamp(0.5 + 0.5*dot(p, vec2(cos(ang), sin(ang)))/gDiag, 0.0, 1.0); }

  /* ---- morph characters ---- */
  vec2 liquidRaw(vec2 p, float A){
    vec2 w = p; float t = uFlow*0.42 + uSeed; float amp = A*0.6;
    for (int i=1; i<=6; i++){ float fi = float(i);
      w.x += amp/fi * sin(fi*1.9*w.y + t*(0.55+0.12*fi) + 1.3*fi + uSeed);
      w.y += amp/fi * cos(fi*1.6*w.x - t*(0.48+0.10*fi) - 0.7*fi);
    }
    w += A*0.045*vec2(sin(w.y*9.0 + t*1.3), cos(w.x*8.0 - t*1.1));
    return w;
  }
  // marble stream: the whole mirrored plane drifts one full period in one direction, each region on its own clock
  vec2 mLiquid(vec2 p){
    float lam = clamp(0.5 + 0.22*sin(p.x*2.3 + uSeed) + 0.16*sin(p.y*2.9 - uSeed*1.7), 0.0, 1.0);
    float ph = prog(lam);
    gE = envOf(ph)*uDepth;
    float drift = abs(uTurns) > 0.5 ? 1.0 : 0.0;
    gF = max(gE*1.4, drift*sin(PI*ph));
    float da = floor(fract(uSeed*0.37)*8.0);   // one of 8 lattice directions, so a full drift is exactly one mirror period
    vec2 dir = vec2(cos(da*PI*0.25), sin(da*PI*0.25)); dir = floor(dir*1.5 + 0.5)/max(abs(floor(dir.x*1.5+0.5)), max(abs(floor(dir.y*1.5+0.5)), 1.0));
    gMask = dir*(drift*ph*2.0);          // the cover square travels with the drift and lands one mirror period on
    return liquidRaw(p, gE) - liquidRaw(vec2(0.0), gE) - dir*(drift*ph*2.0*uSquare);
  }
  // vortex: every ring makes the same number of full turns, the eye leads, the rim catches up
  vec2 mVortex(vec2 p){
    float r = length(p);
    float ph = prog(smoothstep(0.0, 1.0, r/gDiag));
    gE = envOf(ph)*uDepth;
    gF = max(gE, sin(PI*ph)*step(0.5, abs(uTurns)));
    vec2 w = rot(TAU*uTurns*ph)*p;
    return w * (1.0 - 0.32*gE*exp(-r*r*5.0));
  }
  // water: the surface sweeps in from one side and leaves on the other
  vec2 mWater(vec2 p){
    float ph = prog(sweep(p, uSeed*1.7));
    float A = envOf(ph)*uDepth; gE = A; gF = A*1.5;
    float t = uFlow*0.55 + uSeed;
    vec2 g = vec2(0.0);
    for (int i=0; i<7; i++){ float fi = float(i);
      float an = fi*2.39996 + uSeed;
      vec2 d = vec2(cos(an), sin(an));
      float k = 5.0 + fi*2.7;
      g += cos(dot(p,d)*k + t*(1.1 + 0.23*fi) + fi) * d / (1.0 + 0.45*fi);
    }
    g += 0.8*vec2(sin(p.y*2.2 + t*0.4), cos(p.x*1.9 - t*0.35));
    vec3 n = normalize(vec3(-g*A*0.55, 1.0));
    vec3 L = normalize(vec3(-0.45, 0.6, 1.0));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    gSpec = pow(max(dot(n,H), 0.0), 90.0) * A * 1.4;
    gShade = 1.0 + (dot(n,L) - L.z) * 1.1;
    return p + g*A*0.05;
  }

  void voronoi(vec2 g, float seed, out vec2 id, out vec2 ctr, out float edge){
    vec2 ip = floor(g), fp = fract(g); float d1 = 9.0, d2 = 9.0; vec2 bo = vec2(0.0), bp = vec2(0.0);
    for (int j=-1; j<=1; j++) for (int i=-1; i<=1; i++){
      vec2 o = vec2(float(i), float(j));
      vec2 pt = o + 0.12 + 0.76*hash22(ip + o + seed);
      float d = length(pt - fp);
      if (d < d1){ d2 = d1; d1 = d; bo = o; bp = pt; } else if (d < d2) d2 = d;
    }
    id = ip + bo; ctr = ip + bp; edge = d2 - d1;
  }
  // shatter: each shard spins a full turn and flies one orbit on its own clock, then clicks back into place
  vec2 mShatter(vec2 p){
    float sc = 3.0 + 1.6*fract(uSeed*0.37);
    vec2 id, ctr; float e;
    voronoi(p*sc, floor(uSeed*10.0), id, ctr, e);
    vec2 h = hash22(id + uSeed*3.7);
    vec2 c = ctr/sc;
    float ph = prog(clamp(0.65*h.x + 0.35*length(c)/gDiag, 0.0, 1.0));
    float s = sin(PI*ph);
    gE = envOf(ph)*uDepth;
    float th0 = h.y*TAU;
    float R = (0.04 + 0.16*uDepth)*(0.4 + h.x);
    vec2 orbit = R*(vec2(cos(th0 + TAU*ph), sin(th0 + TAU*ph)) - vec2(cos(th0), sin(th0)));
    float ang = TAU*uTurns*(h.y > 0.5 ? 1.0 : -1.0)*ph + 0.5*gE*(h.x - 0.5);
    float crack = clamp(max(abs(uTurns)*s, gE*3.0), 0.0, 1.0)*uGate;
    gEdge = (1.0 - smoothstep(0.0, 0.04, e))*crack;
    gRim = (1.0 - smoothstep(0.04, 0.08, e))*smoothstep(0.02, 0.05, e)*crack;
    gDispV = (h - 0.5)*1.2;
    gF = max(gE*1.5, s);
    return c + rot(ang)*(p - c - orbit)*(1.0 + 0.3*gE*(h.y - 0.5));
  }
  // prism: fluted glass – straight refracting ribs with rainbow edges, slowly turning a quarter
  vec2 mPrism(vec2 p){
    float an = uSeed*1.3 + uDir*0.5*PI*uPhi;
    vec2 n = vec2(cos(an), sin(an)), t2 = vec2(-n.y, n.x);
    float ph = prog(sweep(p, an + 0.5*PI));
    gE = envOf(ph)*uDepth;
    float freq = 6.0 + 4.0*fract(uSeed*0.61);
    float tt = dot(p, n)*freq - uFlow*0.25;
    float f = fract(tt) - 0.5;
    float aa = fwidth(tt)*1.5;
    float fs = f*(1.0 - smoothstep(0.5 - aa, 0.5, abs(f)));
    float lens = sin(dot(p, t2)*2.2 + uFlow*0.3);
    gDispV = n*fs*gE*1.2;
    gShade = 1.0 + fs*0.55*gE;
    gRim = smoothstep(0.36, 0.5, abs(f))*smoothstep(0.0, 0.15, gE)*0.8;
    gF = gE*1.4;
    return p + n*(fs*1.4/freq + lens*0.05)*gE;
  }

  vec2 kfold(vec2 q, float N, float off){
    float r = length(q); float a = atan(q.y, q.x);
    float seg = TAU/N; a = mod(a, seg); a = abs(a - 0.5*seg);
    a += off;
    return r*vec2(cos(a), sin(a));
  }
  // kaleido / mandala: every point slides from its own place to its mirrored place – folding spreads outward from
  // the centre, and unfolds in the same outward order. The pattern keeps turning forward the whole time.
  vec2 mKaleido(vec2 p, bool mandala){
    float r = length(p);
    float ph = prog(clamp(r/gDiag, 0.0, 1.0));
    float en = envOf(ph);
    gE = en*uDepth;
    float b = en*clamp(0.45 + uDepth*0.9, 0.0, 1.0);
    float chi = uDir*PI*uPhi;
    float off = uSeed*0.53 + uDir*PI*0.7*uPhi + 0.06*sin(uFlow*TAU/8.0);
    vec2 k = rot(chi)*kfold(rot(-chi)*p, uSegs, off);
    if (mandala) {
      float rk = length(k) + 0.015; float ak = atan(k.y, k.x);
      float m = (log(rk) + uFlow*0.09)/1.1;
      float tri = 1.0 - abs(1.0 - mod(m, 2.0));
      ak += 0.3*sin(m*PI);
      k = 0.12*exp(tri*1.1)*vec2(cos(ak), sin(ak));
    } else {
      k *= 1.0 - 0.14*b;
      k = rot(0.55*gE*r)*k;
    }
    gF = b;
    return mix(p, k, b);
  }
  // fractal: folds itself in stage by stage, and lets go in the same order (first in, first out)
  vec2 mFractal(vec2 p){
    float r = length(p);
    float ph = prog(clamp(r/gDiag, 0.0, 1.0));
    float en = envOf(ph);
    gE = en*uDepth;
    float amt = clamp(0.5 + uDepth*0.8, 0.0, 1.0);
    float inP = clamp(ph/0.42, 0.0, 1.0), outP = clamp((ph - 0.58)/0.42, 0.0, 1.0);
    vec2 w = p;
    for (int i=0; i<5; i++){ float fi = float(i);
      float wi = smoothstep(0.0, 1.0, clamp(inP*5.5 - fi, 0.0, 1.0))*(1.0 - smoothstep(0.0, 1.0, clamp(outP*5.5 - fi, 0.0, 1.0)))*amt;
      vec2 f = abs(w) - vec2(0.27, 0.15)*(1.0 + 0.2*sin(uFlow*0.785 + fi));
      f = rot(0.5 + 0.3*sin(uFlow*0.393 + uSeed + fi*0.7) + uDir*0.6*uPhi) * f * 1.16;
      w = mix(w, f, wi);
    }
    gF = max(gE, amt*en);
    return w;
  }
  // tunnel: Droste dive – the cover inside the cover. Zooms in the whole cycle; ends exactly one period deeper.
  vec2 mTunnel(vec2 p){
    float x = uPhi; float ph = x*x*x*(x*(x*6.0-15.0)+10.0);
    float s = envOf(ph);
    gE = s*uDepth;
    float Pmax = log(400.0);
    float P = mix(Pmax, log(2.3), smoothstep(0.0, 1.0, s));
    float off = Pmax*(ph + smoothstep(0.6, 1.0, ph));
    float r = max(length(p), 1e-5); float a = atan(p.y, p.x);
    float lrMax = log(1.2);
    float lr = lrMax - mod(lrMax - log(r) + off, P);
    a += s*1.1*(lr - lrMax);
    gF = s;
    return exp(lr)*vec2(cos(a), sin(a));
  }

  void main(){
    float asp = uRes.x/uRes.y;
    gDiag = 0.5*length(vec2(asp, 1.0));
    vec2 p = (vUv-0.5)*vec2(asp, 1.0);
    p *= 1.0 - 0.028*uPulse;              // centred punch on the beat
    gQs = p/uSquare + 0.5;
    gShade = 1.0; gSpec = 0.0; gEdge = 0.0; gRim = 0.0; gE = 0.0; gF = 0.0; gDispV = vec2(0.0); gMask = vec2(0.0);
    vec2 w;
    if (uMode == 0) w = mLiquid(p);
    else if (uMode == 1) w = mVortex(p);
    else if (uMode == 2) w = mWater(p);
    else if (uMode == 3) w = mShatter(p);
    else if (uMode == 4) w = mPrism(p);
    else if (uMode == 5) w = mKaleido(p, false);
    else if (uMode == 6) w = mKaleido(p, true);
    else if (uMode == 7) w = mFractal(p);
    else w = mTunnel(p);
    w = mix(p, w, uGate);                 // gate: mode switch / pause glide every point home

    vec2 dx = dFdx(w), dy = dFdy(w);
    if (uMode <= 1) { // liquid folds catch the light
      float px = 1.0/uRes.y;
      float J = (dx.x*dy.y - dx.y*dy.x)/(px*px);
      gShade *= 1.0 + gE*(0.6*exp(-abs(J)*2.2) - 0.07);
    }
    vec3 c = colorAt(w, dx, dy, uFillK*uAct*(1.0 - uFrame));
    c *= gShade;
    c += gSpec*vec3(1.0, 0.98, 0.94);
    c = mix(c, c*0.1, gEdge*0.85);
    c += gRim*0.32*(0.6 + c);
    c = hueShift(c, uHue);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.0 + 0.22*gE);
    c *= 1.0 + 0.07*uPulse;
    c = max(c, 0.0);
    o = vec4(mix(c, texture(uPrev, vUv).rgb, uTrail), 1.0);
  }`;

  const PRESENT = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uSrc; uniform vec2 uRes;
  void main(){
    vec3 c = texture(uSrc, vUv).rgb;
    float asp = uRes.x/uRes.y;
    c *= mix(0.62, 1.0, smoothstep(1.25, 0.35, length((vUv-0.5)*vec2(asp, 1.0))));
    vec2 f = gl_FragCoord.xy;
    float n = fract(sin(dot(f, vec2(12.9898, 78.233)))*43758.5453);
    o = vec4(c + (n - 0.5)/160.0, 1.0); // static dither against banding
  }`;

  /* ------------------------------------------------------------------ */
  /* Renderer                                                            */
  /* ------------------------------------------------------------------ */
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
      if (!gl) throw new Error("WebGL2 not available");
      this.gl = gl;
      this.half = !!gl.getExtension("EXT_color_buffer_float");
      this.scene = this.program(VERT, SCENE);
      this.present = this.program(VERT, PRESENT);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.imgA = this.placeholder();
      this.imgB = this.imgA;
      this.targets = null;
      this.w = this.h = 0;
      this.needsInit = true;
    }

    program(vs, fs) {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Shader: " + gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, "aPos");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Link: " + gl.getProgramInfoLog(p));
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
      }
      return { p, u };
    }

    placeholder() {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([18, 18, 20, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    }

    uploadImage(img) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      return t;
    }

    pushImage(tex) {
      if (this.imgA !== this.imgB && this.imgA) this.gl.deleteTexture(this.imgA);
      this.imgA = this.imgB;
      this.imgB = tex;
    }

    makeTarget(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && this.half) {
        this.half = false;
        gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
        return this.makeTarget(w, h);
      }
      return { tex, fb };
    }

    resize(w, h) {
      if (w === this.w && h === this.h) return;
      const gl = this.gl;
      this.w = w; this.h = h;
      this.canvas.width = w; this.canvas.height = h;
      if (this.targets) for (const t of this.targets) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
      this.targets = [this.makeTarget(w, h), this.makeTarget(w, h)];
      this.needsInit = true;
    }

    render(f) {
      const gl = this.gl;
      if (!this.targets) return;
      const [src, dst] = this.targets;
      gl.bindVertexArray(this.vao);
      gl.viewport(0, 0, this.w, this.h);

      const P = this.scene;
      gl.useProgram(P.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(P.u.uPrev, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.imgA); gl.uniform1i(P.u.uImgA, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.imgB); gl.uniform1i(P.u.uImgB, 2);
      gl.uniform2f(P.u.uRes, this.w, this.h);
      if (P.u.uMode) gl.uniform1i(P.u.uMode, f.mode);
      for (const k of ["Frame", "Act", "Mix", "Square", "Phi", "Depth", "Gate", "Lag", "FillK", "Flow", "Pulse", "Seed", "Segs", "Hue", "Trail", "Glow", "Disp", "Turns", "Dir"]) {
        const loc = P.u["u" + k];
        if (loc) gl.uniform1f(loc, k === "Trail" && this.needsInit ? 0 : f[k.toLowerCase()]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.needsInit = false;

      const D = this.present;
      gl.useProgram(D.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst.tex); gl.uniform1i(D.u.uSrc, 0);
      gl.uniform2f(D.u.uRes, this.w, this.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this.targets = [dst, src];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Cover sources                                                       */
  /* ------------------------------------------------------------------ */
  const contextCoverCache = new Map();

  function trackCover(data) {
    const item = data && (data.item || data.track);
    if (!item) return null;
    const md = item.metadata || {};
    return imageUrl(md.image_xlarge_url || md.image_large_url || md.image_url || largest(item.images) || largest(item.album && item.album.images));
  }

  async function contextCover(data) {
    const ctx = (data && data.context) || {};
    const uri = ctx.uri || (data && data.context_uri) || "";
    if (!uri) return null;
    if (contextCoverCache.has(uri)) return contextCoverCache.get(uri);
    let url = null;
    const md = ctx.metadata || (data && data.context_metadata) || {};
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
          const id = uri.split(":").pop();
          const m = await withTimeout(S.CosmosAsync.get("https://api.spotify.com/v1/playlists/" + id + "?fields=images"), 6000);
          url = imageUrl(largest(m.images));
        } catch (_) {}
      }
    }
    if (!url && type === "album") url = trackCover(data);
    if (url) contextCoverCache.set(uri, url);
    return url;
  }

  // spotify:localfileimage: (local files) refuses CORS mode but is still usable by WebGL without it.
  function loadImage(url) {
    return loadImageMode(url, true).catch(() => loadImageMode(url, false));
  }
  function loadImageMode(url, cors) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (cors) img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed"));
      img.src = url;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Styles + DOM                                                        */
  /* ------------------------------------------------------------------ */
  const ICON = '<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z"/><path d="M4.2 9.6c1.3-2.9 2.6-2.9 3.8 0s2.5 2.9 3.8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 6.1c.9-.9 1.9-.9 3 0s2.1.9 3 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/></svg>';

  const style = document.createElement("style");
  style.id = "coverflux-style";
  style.textContent = `
  #coverflux{--cf-accent:#e8e3d9;position:fixed;inset:0 0 90px 0;z-index:999;background:#0b0b0c;overflow:hidden;
    opacity:0;visibility:hidden;transition:opacity .45s cubic-bezier(.2,.7,.2,1),visibility 0s linear .45s;
    font-family:var(--font-family,"SpotifyMixUI",CircularSp,system-ui,sans-serif);color:#f3efe8;}
  #coverflux.cf-open{opacity:1;visibility:visible;transition:opacity .45s cubic-bezier(.2,.7,.2,1),visibility 0s;}
  #coverflux-glow{position:fixed;left:0;right:0;bottom:0;height:90px;z-index:1000;pointer-events:none;opacity:0;
    transition:opacity .45s cubic-bezier(.2,.7,.2,1);mix-blend-mode:screen;}
  #coverflux-glow.cf-open{opacity:1}
  #coverflux-glow canvas{position:absolute;left:0;width:100%;top:0;height:100%;display:block;
    -webkit-mask-image:linear-gradient(to bottom,#000 0,rgba(0,0,0,.5) 22%,rgba(0,0,0,.14) 55%,transparent 100%);
            mask-image:linear-gradient(to bottom,#000 0,rgba(0,0,0,.5) 22%,rgba(0,0,0,.14) 55%,transparent 100%);}
  #coverflux-glow::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.14) 20%,rgba(255,255,255,.2) 50%,rgba(255,255,255,.14) 80%,transparent);}
  #coverflux canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  #coverflux .cf-drag{position:absolute;left:0;right:0;top:0;height:40px;-webkit-app-region:drag}
  #coverflux.cf-idle{cursor:none}
  #coverflux .cf-chrome{transition:opacity .5s ease, transform .5s cubic-bezier(.2,.7,.2,1)}
  #coverflux.cf-idle .cf-chrome{opacity:0;transform:translateY(6px);pointer-events:none}
  #coverflux .cf-info{position:absolute;left:32px;bottom:26px;max-width:min(40vw,520px);pointer-events:none;
    text-shadow:0 1px 18px rgba(0,0,0,.55)}
  #coverflux .cf-title{font-size:clamp(20px,2.3vw,34px);font-weight:700;letter-spacing:-.02em;line-height:1.05;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #coverflux .cf-artist{margin-top:6px;font-size:13px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;opacity:.72;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #coverflux .cf-info.cf-swap .cf-title,#coverflux .cf-info.cf-swap .cf-artist{animation:cf-in .9s cubic-bezier(.2,.7,.2,1) both}
  #coverflux .cf-info.cf-swap .cf-artist{animation-delay:.08s}
  #coverflux.cf-noinfo .cf-info{display:none}
  @keyframes cf-in{from{opacity:0;transform:translateY(10px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
  /* controls: one slim glass bar, details live in two popover panels */
  #coverflux{--cf-glass:rgba(16,16,18,.68);--cf-line:rgba(255,255,255,.08);--cf-text:#f3efe8;--cf-mute:rgba(243,239,232,.56);
    --cf-ease:cubic-bezier(.2,.8,.2,1)}
  #coverflux button{all:unset;cursor:pointer;box-sizing:border-box}
  #coverflux .cf-controls{position:absolute;right:24px;bottom:22px;display:flex;align-items:center;gap:2px;padding:5px;
    border-radius:999px;background:var(--cf-glass);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);
    box-shadow:inset 0 0 0 1px var(--cf-line),0 12px 32px rgba(0,0,0,.32);-webkit-app-region:no-drag}
  #coverflux .cf-sep{width:1px;height:16px;margin:0 5px;background:var(--cf-line)}
  #coverflux .cf-seg{display:flex;position:relative;border-radius:999px;background:rgba(255,255,255,.05);padding:2px}
  #coverflux .cf-seg button{position:relative;z-index:1;padding:6px 12px;font-size:12px;font-weight:600;border-radius:999px;color:var(--cf-mute);
    transition:color .2s ease}
  #coverflux .cf-seg button:hover{color:var(--cf-text)}
  #coverflux .cf-seg button[aria-checked="true"]{color:#111}
  #coverflux .cf-seg .cf-thumb{position:absolute;top:2px;bottom:2px;border-radius:999px;background:var(--cf-accent);
    transition:left .35s var(--cf-ease),width .35s var(--cf-ease)}
  #coverflux .cf-chip{display:flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:999px;font-size:12px;font-weight:600;
    color:var(--cf-text);font-variant-numeric:tabular-nums;transition:background .2s ease}
  #coverflux .cf-chip:hover,#coverflux .cf-chip[aria-expanded="true"]{background:rgba(255,255,255,.09)}
  #coverflux .cf-chip small{font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--cf-mute)}
  #coverflux .cf-icon{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:rgba(243,239,232,.78);
    transition:background .2s ease,color .2s ease,transform .25s var(--cf-ease)}
  #coverflux .cf-icon:hover{background:rgba(255,255,255,.09);color:#fff}
  #coverflux .cf-icon svg{display:block}
  #coverflux .cf-frame .cf-i-sq{display:none}
  #coverflux .cf-frame[aria-pressed="true"] .cf-i-sq{display:block}
  #coverflux .cf-frame[aria-pressed="true"] .cf-i-full{display:none}
  #coverflux .cf-close:hover{transform:rotate(90deg)}
  #coverflux .cf-dot{width:6px;height:6px;border-radius:50%;background:#7a7a7a;flex:none;
    transform:scale(calc(1 + var(--cf-beat, 0) * .9));will-change:transform}
  #coverflux .cf-dot.cf-live{background:var(--cf-accent);box-shadow:0 0 10px var(--cf-accent)}

  #coverflux .cf-panel{position:absolute;right:24px;bottom:72px;width:min(372px,calc(100% - 48px));padding:14px;border-radius:18px;
    background:var(--cf-glass);backdrop-filter:blur(24px) saturate(1.5);-webkit-backdrop-filter:blur(24px) saturate(1.5);
    box-shadow:inset 0 0 0 1px var(--cf-line),0 18px 48px rgba(0,0,0,.4);-webkit-app-region:no-drag;
    opacity:0;transform:translateY(8px) scale(.985);transform-origin:bottom right;pointer-events:none;visibility:hidden;
    transition:opacity .18s ease,transform .22s var(--cf-ease),visibility 0s linear .22s}
  #coverflux .cf-panel.cf-on{opacity:1;transform:none;pointer-events:auto;visibility:visible;transition:opacity .18s ease,transform .22s var(--cf-ease),visibility 0s}
  #coverflux .cf-ph{display:flex;align-items:baseline;gap:10px;margin:2px 2px 12px}
  #coverflux .cf-ph b{font-size:13px;font-weight:700;letter-spacing:-.01em}
  #coverflux .cf-ph small{flex:1;font-size:11px;color:var(--cf-mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #coverflux .cf-detect{margin:-6px 2px 12px;font-size:11px;line-height:1.45;color:var(--cf-mute)}
  #coverflux .cf-link{font-size:11px;font-weight:600;color:var(--cf-mute);padding:2px 4px;border-radius:6px}
  #coverflux .cf-link:hover{color:var(--cf-text)}
  #coverflux .cf-tiles{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  #coverflux .cf-tile{position:relative;display:block;padding:10px 34px 10px 12px;border-radius:12px;background:rgba(255,255,255,.035);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);transition:background .2s ease,box-shadow .2s ease}
  #coverflux .cf-tile:hover{background:rgba(255,255,255,.07)}
  #coverflux .cf-tile b{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:650;color:var(--cf-mute);transition:color .2s ease}
  #coverflux .cf-tile span{display:block;margin-top:3px;font-size:11px;line-height:1.35;color:rgba(243,239,232,.4)}
  #coverflux .cf-tile i{position:absolute;right:11px;top:11px;width:16px;height:16px;border-radius:50%;
    box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.22);display:grid;place-items:center;transition:background .2s ease,box-shadow .2s ease}
  #coverflux .cf-tile i svg{opacity:0;transform:scale(.6);transition:opacity .15s ease,transform .2s var(--cf-ease)}
  #coverflux .cf-tile[aria-pressed="true"]{background:color-mix(in srgb,var(--cf-accent) 12%,transparent);
    box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--cf-accent) 38%,transparent)}
  #coverflux .cf-tile[aria-pressed="true"] b{color:var(--cf-text)}
  #coverflux .cf-tile[aria-pressed="true"] span{color:var(--cf-mute)}
  #coverflux .cf-tile[aria-pressed="true"] i{background:var(--cf-accent);box-shadow:none;color:#111}
  #coverflux .cf-tile[aria-pressed="true"] i svg{opacity:1;transform:none}
  #coverflux .cf-tile.cf-running b::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--cf-accent);
    box-shadow:0 0 8px var(--cf-accent);animation:cf-breathe 1.6s ease-in-out infinite}
  @keyframes cf-breathe{50%{opacity:.35}}
  #coverflux .cf-row{display:flex;align-items:center;gap:12px;margin-top:12px;padding:10px 4px 0;border-top:1px solid var(--cf-line);
    font-size:12px;font-weight:600;color:var(--cf-mute)}
  #coverflux .cf-row input{flex:1}
  #coverflux .cf-val{min-width:52px;text-align:right;font-variant-numeric:tabular-nums;color:var(--cf-text);font-size:12px}
  #coverflux input[type=range]{-webkit-appearance:none;appearance:none;height:3px;border-radius:3px;cursor:pointer;
    background:linear-gradient(90deg,var(--cf-accent) var(--v,70%),rgba(255,255,255,.16) var(--v,70%))}
  #coverflux input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#f3efe8;
    box-shadow:0 0 0 4px rgba(255,255,255,.08),0 2px 6px rgba(0,0,0,.3);transition:transform .15s ease}
  #coverflux input[type=range]:hover::-webkit-slider-thumb{transform:scale(1.15)}
  #coverflux .cf-ratio{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;padding:3px;border-radius:12px;background:rgba(255,255,255,.04)}
  #coverflux .cf-ratio button{text-align:center;padding:7px 0;border-radius:9px;font-size:12px;font-weight:650;color:var(--cf-mute);
    transition:background .2s ease,color .2s ease}
  #coverflux .cf-ratio button:hover{color:var(--cf-text)}
  #coverflux .cf-ratio button[aria-checked="true"]{background:var(--cf-accent);color:#111}
  #coverflux .cf-tap{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;width:100%;height:68px;margin-top:8px;
    border-radius:12px;background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);
    font-size:14px;font-weight:700;letter-spacing:.02em;transition:background .25s ease,transform .12s ease}
  #coverflux .cf-tap small{font-size:11px;font-weight:500;color:var(--cf-mute)}
  #coverflux .cf-tap:hover{background:rgba(255,255,255,.07)}
  #coverflux .cf-tap.cf-hit{background:color-mix(in srgb,var(--cf-accent) 28%,transparent);transform:scale(.985);transition:none}
  #coverflux button:focus-visible,#coverflux input:focus-visible{outline:2px solid var(--cf-accent);outline-offset:2px}
  #coverflux .cf-note{position:absolute;right:28px;bottom:74px;font-size:11px;color:rgba(243,239,232,.7);opacity:0;transition:opacity .4s ease;pointer-events:none}
  #coverflux .cf-note.cf-show{opacity:1}
  #coverflux .cf-error{position:absolute;inset:0;display:none;place-items:center;font-size:14px;color:rgba(243,239,232,.7)}
  #coverflux.cf-failed .cf-error{display:grid}
  @media (max-width:900px){#coverflux .cf-chip small{display:none}#coverflux .cf-info{max-width:30vw}}
  @media (prefers-reduced-motion:reduce){#coverflux,#coverflux .cf-chrome,#coverflux .cf-panel{transition:none}
    #coverflux .cf-tile.cf-running b::after{animation:none}}
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "coverflux";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Coverflux Visualizer");
  root.innerHTML = `
    <canvas aria-hidden="true"></canvas>
    <div class="cf-drag"></div>
    <div class="cf-error">WebGL2 ist hier nicht verfügbar – Visualizer kann nicht starten.</div>
    <div class="cf-info cf-chrome"><div class="cf-title"></div><div class="cf-artist"></div></div>
    <div class="cf-note cf-chrome"></div>
    <div class="cf-panel cf-chrome" data-panel="modes" role="dialog" aria-label="Modi">
      <div class="cf-ph"><b>Modi</b><small class="cf-modes-hint"></small><button class="cf-link cf-all">Alle</button></div>
      <div class="cf-tiles">${PRESET_KEYS().map((k) => `<button class="cf-tile" data-k="${k}" aria-pressed="true" title="Klicken: in Auto an/aus · Doppelklick: nur diesen Modus"><b>${PRESETS[k].label}</b><span>${PRESETS[k].desc}</span><i><svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.2l2 2L8 3"/></svg></i></button>`).join("")}</div>
      <label class="cf-row">Intensität <input class="cf-intensity" type="range" min="0" max="100" aria-label="Intensität"><span class="cf-val cf-intv"></span></label>
    </div>
    <div class="cf-panel cf-chrome" data-panel="tempo" role="dialog" aria-label="Tempo">
      <div class="cf-ph"><b>Tempo</b></div>
      <p class="cf-detect"></p>
      <div class="cf-ratio" role="radiogroup" aria-label="Tempo-Gefühl">
        <button role="radio" data-r="auto">Auto</button><button role="radio" data-r="2" title="halbes Tempo">½</button><button role="radio" data-r="1">1×</button><button role="radio" data-r="0.5" title="doppeltes Tempo">2×</button><button role="radio" data-r="3" title="ein Puls pro Dreiertakt">⅓</button>
      </div>
      <button class="cf-tap" aria-label="Tempo tappen">Tap<small>im Takt klicken oder T drücken · mind. 4×</small></button>
      <label class="cf-row" title="Verschiebt die Visuals gegenüber dem Ton. Plus = früher. Tasten [ und ]">Sync <input class="cf-syncr" type="range" min="-250" max="250" step="10" aria-label="Sync-Versatz"><span class="cf-val cf-syncv"></span></label>
    </div>
    <div class="cf-controls cf-chrome">
      <div class="cf-seg" role="radiogroup" aria-label="Bildquelle">
        <span class="cf-thumb"></span>
        <button role="radio" data-src="track">Song</button>
        <button role="radio" data-src="context">Playlist</button>
      </div>
      <span class="cf-sep"></span>
      <button class="cf-chip cf-modes" data-open="modes" aria-haspopup="dialog" aria-expanded="false"><small class="cf-modes-k">Auto</small><span class="cf-modes-v"></span></button>
      <button class="cf-chip cf-bpm" data-open="tempo" aria-haspopup="dialog" aria-expanded="false"><span class="cf-dot"></span><span class="cf-bpmv">– BPM</span><small class="cf-bpmm"></small></button>
      <button class="cf-icon cf-frame" aria-pressed="false" aria-label="Quadrat-Modus">
        <svg class="cf-i-full" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9"/></svg>
        <svg class="cf-i-sq" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x=".75" y=".75" width="12.5" height="12.5" rx="3" stroke-opacity=".35"/></svg>
      </button>
      <button class="cf-icon cf-close" aria-label="Visualizer schließen" title="Schließen (Esc)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
      </button>
    </div>`;
  document.body.appendChild(root);
  // OLED-style reflection: the bottom edge of the visual spills, mirrored and blurred, onto the black playbar
  const glowEl = document.createElement("div");
  glowEl.id = "coverflux-glow";
  glowEl.setAttribute("aria-hidden", "true");
  const glowCv = document.createElement("canvas");
  glowEl.appendChild(glowCv);
  document.body.appendChild(glowEl);
  const glowCtx = glowCv.getContext("2d", { alpha: false });
  const glowTmp = document.createElement("canvas");
  const glowTmpCtx = glowTmp.getContext("2d", { alpha: false });
  const GLOW_W = 320, GLOW_PAD = 12, GLOW_BLUR = 4;
  // Mirror at exactly 1:1 scale: the row touching the playbar is the bottom row of the visual, x lines up pixel for pixel.
  // Blur happens inside the canvas on an edge-padded copy, so it can't pull the reflection away from the edge.
  function drawGlow(src) {
    const rw = root.clientWidth, rh = root.clientHeight, gh = glowEl.clientHeight;
    if (!glowCtx || !glowTmpCtx || !src.width || !src.height || !rw || !rh || !gh) return;
    const W = GLOW_W, H = Math.max(4, Math.round(W * gh / rw)), P = GLOW_PAD;
    if (glowCv.width !== W || glowCv.height !== H) { glowCv.width = W; glowCv.height = H; glowTmp.width = W + 2 * P; glowTmp.height = H + 2 * P; }
    const strip = Math.min(src.height, Math.max(1, Math.round(gh * src.height / rh)));
    try {
      const t = glowTmpCtx;
      t.setTransform(1, 0, 0, -1, 0, P + H + P); // mirror: source bottom row lands at y = P (the playbar edge)
      t.drawImage(src, 0, src.height - strip, src.width, strip, P, P, W, H);
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.drawImage(glowTmp, P, P, W, 1, P, 0, W, P); // pad above the edge with the edge row itself
      t.drawImage(glowTmp, P, P + H - 1, W, 1, P, P + H, W, P); // and below the far end
      t.drawImage(glowTmp, P, 0, 1, H + 2 * P, 0, 0, P, H + 2 * P); // pad left/right with the outer columns
      t.drawImage(glowTmp, P + W - 1, 0, 1, H + 2 * P, P + W, 0, P, H + 2 * P);
      glowCtx.filter = "blur(" + GLOW_BLUR + "px) saturate(1.5) brightness(1.25)";
      glowCtx.drawImage(glowTmp, -P, -P);
      glowCtx.filter = "none";
    } catch (_) {}
  }


  const $ = (sel) => root.querySelector(sel);
  const canvas = $("canvas");
  const elTitle = $(".cf-title"), elArtist = $(".cf-artist"), elInfo = $(".cf-info");
  const elInt = $(".cf-intensity"), elIntV = $(".cf-intv"), elNote = $(".cf-note");
  const tiles = Array.from(root.querySelectorAll(".cf-tile")), ratioButtons = Array.from(root.querySelectorAll(".cf-ratio button"));
  const elModesK = $(".cf-modes-k"), elModesV = $(".cf-modes-v"), elModesHint = $(".cf-modes-hint"), elDetect = $(".cf-detect");
  const panels = Array.from(root.querySelectorAll(".cf-panel")), openers = Array.from(root.querySelectorAll("[data-open]"));
  const elSync = $(".cf-syncr"), elSyncV = $(".cf-syncv");
  const elFrame = $(".cf-frame");
  const elBpm = $(".cf-bpm"), elBpmV = $(".cf-bpmv"), elBpmM = $(".cf-bpmm"), elDot = $(".cf-dot");
  const segButtons = Array.from(root.querySelectorAll(".cf-seg button"));
  const thumb = $(".cf-thumb");

  function syncControls() {
    segButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === settings.source)));
    const active = segButtons.find((b) => b.dataset.src === settings.source);
    if (active && active.offsetWidth) { thumb.style.left = active.offsetLeft + "px"; thumb.style.width = active.offsetWidth + "px"; }
    elInt.value = Math.round(settings.intensity * 100);
    elInt.style.setProperty("--v", elInt.value + "%");
    elIntV.textContent = elInt.value + " %";
    elSync.value = settings.syncMs;
    elSync.style.setProperty("--v", ((settings.syncMs + 250) / 5) + "%");
    elSyncV.textContent = (settings.syncMs > 0 ? "+" : "") + settings.syncMs + " ms";
    root.classList.toggle("cf-noinfo", !settings.showInfo);
    elFrame.setAttribute("aria-pressed", String(settings.frame === "square"));
    elFrame.title = settings.frame === "square" ? "Quadrat – klicken für gespiegeltes Vollbild" : "Vollbild – klicken, damit das Cover ein Quadrat bleibt";
    syncModes();
  }

  // mode chip + tiles: which modes are on, which one is running right now
  function syncModes() {
    const on = settings.modes, all = on.length === PRESET_KEYS().length;
    tiles.forEach((t) => {
      t.setAttribute("aria-pressed", String(on.includes(t.dataset.k)));
      t.classList.toggle("cf-running", t.dataset.k === state.presetKey && isOpen);
    });
    elModesK.textContent = on.length === 1 ? "Fix" : "Auto";
    elModesV.textContent = (PRESETS[state.presetKey] || PRESETS[on[0]]).label;
    elModesHint.textContent = on.length === 1 ? "Nur " + PRESETS[on[0]].label + " · Klicken fügt Modi hinzu" : all ? "Auto wechselt zwischen allen Modi" : "Auto wechselt zwischen " + on.length + " Modi";
  }

  // popover panels
  let openPanel = null;
  function setPanel(name) {
    openPanel = name && name !== openPanel ? name : null;
    panels.forEach((p) => p.classList.toggle("cf-on", p.dataset.panel === openPanel));
    openers.forEach((b) => b.setAttribute("aria-expanded", String(b.dataset.open === openPanel)));
    if (openPanel === "tempo") refreshStatus();
  }
  openers.forEach((b) => b.addEventListener("click", () => setPanel(b.dataset.open)));
  root.addEventListener("pointerdown", (e) => { if (openPanel && !e.target.closest(".cf-panel,[data-open]")) setPanel(null); });

  function setModes(next) {
    settings.modes = PRESET_KEYS().filter((k) => next.includes(k));
    saveSettings(); syncModes();
    if (!settings.modes.includes(state.presetKey)) state.pending = true; // glide home, then start an enabled mode
  }
  tiles.forEach((t) => {
    t.addEventListener("click", () => {
      const k = t.dataset.k, on = settings.modes;
      if (on.includes(k)) {
        if (on.length === 1) { note("Mindestens ein Modus bleibt an"); return; }
        setModes(on.filter((x) => x !== k));
      } else setModes(on.concat(k));
    });
    t.addEventListener("dblclick", () => {
      const k = t.dataset.k;
      const solo = settings.modes.length === 1 && settings.modes[0] === k;
      setModes(solo ? PRESET_KEYS() : [k]);
      note(solo ? "Auto: alle Modi" : "Nur " + PRESETS[k].label);
    });
  });
  $(".cf-all").addEventListener("click", () => setModes(PRESET_KEYS()));
  ratioButtons.forEach((b) => b.addEventListener("click", () => {
    const uri = audio.uri;
    if (!uri) return;
    if (b.dataset.r === "auto") delete tempoOverrides[uri]; else tempoOverrides[uri] = +b.dataset.r;
    saveTempo(); refreshStatus(); state.pending = true;
    note(b.dataset.r === "auto" ? "Tempo: automatisch erkannt" : "Tempo für diesen Song fixiert");
  }));

  let noteTimer = 0;
  function note(text) {
    elNote.textContent = text;
    elNote.classList.add("cf-show");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => elNote.classList.remove("cf-show"), 3200);
  }

  segButtons.forEach((b) => b.addEventListener("click", () => {
    if (settings.source === b.dataset.src) return;
    settings.source = b.dataset.src; saveSettings(); syncControls(); refreshCover(true);
  }));
  elInt.addEventListener("input", () => { settings.intensity = elInt.value / 100; elInt.style.setProperty("--v", elInt.value + "%"); elIntV.textContent = elInt.value + " %"; saveSettings(); });
  const setSync = (ms) => { settings.syncMs = clamp(Math.round(ms / 10) * 10, -250, 250); saveSettings(); syncControls(); };
  elSync.addEventListener("input", () => setSync(+elSync.value));
  elFrame.addEventListener("click", () => { settings.frame = settings.frame === "square" ? "full" : "square"; saveSettings(); syncControls(); });
  // Tap tempo: the final safety net. Taps are measured on Spotify's beat grid, so tempo drift in the song is kept.
  const elTap = $(".cf-tap");
  let taps = [], tapHit = 0;
  function tap() {
    const uri = audio.uri;
    if (!uri || audio.synthetic) { note("Tap braucht die Spotify-Analyse"); return; }
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1].now > 2200) taps = [];
    const pos = state.pos + (state.playing ? (now - state.posAt) / 1000 : 0) + settings.syncMs / 1000;
    taps.push({ now, B: audio.beatPos(pos) });
    if (taps.length > 16) taps.shift();
    elTap.classList.add("cf-hit"); clearTimeout(tapHit); tapHit = setTimeout(() => elTap.classList.remove("cf-hit"), 90);
    if (taps.length < 4) { note("Tap " + taps.length + " … weiter im Takt"); return; }
    const d = [];
    for (let i = 1; i < taps.length; i++) d.push(taps[i].B - taps[i - 1].B);
    d.sort((x, y) => x - y);
    const r = d[d.length >> 1];
    if (!(r > 0.2)) return;
    // snap to a clean ratio of the grid when close, else keep the tapped ratio (Spotify's grid is off)
    let m = r;
    for (const c of [0.5, 1, 2, 3, 4, 1.5]) if (Math.abs(Math.log2(r / c)) < 0.12) { m = c; break; }
    m = Math.round(m * 100) / 100;
    // phase: circular mean of the taps on the felt grid
    const base = audio._d0 + audio.shift;
    let sx = 0, sy = 0;
    for (const t of taps) { const a = 2 * Math.PI * ((t.B - base) / m); sx += Math.cos(a); sy += Math.sin(a); }
    const phFelt = Math.atan2(sy, sx) / (2 * Math.PI); // -0.5..0.5 felt beats
    const prev = audio.mult();
    tempoOverrides[uri] = { m, ph: Math.round(phFelt * m * 1000) / 1000 };
    saveTempo(); refreshStatus();
    if (Math.abs(prev - m) > 1e-3) { state.cycleId = null; state.dissolve = Math.max(state.dissolve, 0.6); }
    note("Tap: " + Math.round(audio.tempo / m) + " BPM · Beat gesetzt");
  }
  elTap.addEventListener("click", tap);

  $(".cf-close").addEventListener("click", () => close());

  // idle chrome
  let idleTimer = 0;
  function wake() {
    root.classList.remove("cf-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!openPanel && !root.matches(":focus-within") && !root.querySelector(".cf-controls:hover")) root.classList.add("cf-idle"); else wake(); }, 2600);
  }
  root.addEventListener("pointermove", wake);
  root.addEventListener("pointerdown", wake);
  root.addEventListener("keydown", wake);

  /* ------------------------------------------------------------------ */
  /* Layout: cover everything except the bottom playbar                  */
  /* ------------------------------------------------------------------ */
  function playbarTop() {
    const bar = document.querySelector('.Root__now-playing-bar, [data-testid="now-playing-bar"], footer[data-testposition="now-playing-bar"], .main-nowPlayingBar-container');
    if (!bar) return window.innerHeight - 90;
    const r = bar.getBoundingClientRect();
    return r.height > 0 ? r.top : window.innerHeight - 90;
  }
  function layout() {
    const bottom = Math.max(0, Math.round(window.innerHeight - playbarTop()));
    root.style.bottom = bottom + "px";
    glowEl.style.height = Math.max(40, bottom) + "px";
    const w = root.clientWidth, h = root.clientHeight;
    if (!renderer || !w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(dpr, 1.5, Math.sqrt(2400000 / (w * h)));
    renderer.resize(Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
  }
  window.addEventListener("resize", () => { if (isOpen) layout(); });

  /* ------------------------------------------------------------------ */
  /* State + main loop                                                   */
  /* ------------------------------------------------------------------ */
  let renderer = null;
  const audio = new AudioModel();
  const state = {
    energyFast: 0, energySlow: 0, gate: 0, frameMix: settings.frame === "square" ? 1 : 0, env: 0, pulse: 0, mix: 1, dissolve: 0,
    presetKey: "liquid", seed: 0, segs: 8, dir: 1, turns: 0, lag: 0.35, cycScale: 1, pending: false,
    cycleId: null, cycleLen: 32, cycleU: 0, felt: 0, flow: 0, forceU: null,
    pos: 0, posAt: 0, playing: false, lastSync: 0, time: 0,
  };
  let isOpen = false, raf = 0, lastNow = 0, layoutTick = 0;
  const envOf = (x) => smooth01(x / 0.2) * (1 - smooth01((x - 0.8) / 0.2));

  // Latched once per cycle, while every point is home – so switching never shows.
  function startCycle(id, len) {
    const on = settings.modes;
    let key = on[0];
    if (on.length > 1) {
      // energy decides between the calm and the loud characters – among the ones that are switched on
      let pool = (state.energySlow > 0.5 ? LOUD_POOL : CALM_POOL).filter((k) => on.includes(k));
      if (pool.length < 2) pool = on;
      let i = hashStr((audio.uri || "x") + ":" + id) % pool.length;
      if (pool[i] === state.presetKey) i = (i + 1) % pool.length;
      key = pool[i];
    }
    const h = hashStr((audio.uri || "x") + ":" + id + ":" + key);
    const E = clamp(state.energySlow * 1.15);
    const rm = reducedMotion.matches;
    state.presetKey = key;
    state.seed = (h % 1000) / 37;
    state.segs = [6, 8, 10, 12][h % 4];
    state.dir = h & 16 ? 1 : -1;
    state.cycleLen = len;
    state.cycScale = clamp((len - 4) / 12); // very short sections only breathe a little
    const spins = !rm && state.cycScale > 0.6;
    state.turns = !spins ? 0 : key === "vortex" ? state.dir * (E > 0.7 ? 2 : 1) : E > 0.42 ? state.dir : 0;
    state.lag = rm ? 0.08 : 0.12 + 0.1 * E;
    syncModes();
  }

  function syncPosition(now) {
    let p = 0, playing = false;
    try { p = (S.Player.getProgress() || 0) / 1000; } catch (_) {}
    try { playing = !!S.Player.isPlaying(); } catch (_) {}
    const predicted = state.pos + (state.playing ? (now - state.posAt) / 1000 : 0);
    const err = p - predicted;
    // small errors are eased out (no visible jumps), big ones (seek, pause) snap – and dissolve
    if (!state.lastSync || Math.abs(err) > 0.3 || playing !== state.playing) {
      if (state.lastSync && Math.abs(err) > 0.3) state.dissolve = 1;
      state.pos = p;
    } else state.pos = predicted + err * 0.35;
    state.posAt = now;
    state.playing = playing;
    state.lastSync = now;
  }

  function frame(now) {
    if (!isOpen) return;
    raf = requestAnimationFrame(frame);
    const dt = clamp((now - (lastNow || now)) / 1000, 0, 0.1);
    lastNow = now;
    state.time += dt;

    if (now - state.lastSync > 250) syncPosition(now);
    const pos = state.pos + (state.playing ? (now - state.posAt) / 1000 : 0) + settings.syncMs / 1000;
    const a = audio.sample(pos);
    const live = state.playing;
    const rm = reducedMotion.matches;
    const I = settings.intensity * (rm ? 0.4 : 1);

    const loud = live ? a.loud : 0;
    state.energyFast = follow(state.energyFast, loud, 14, 3.5, dt);
    state.energySlow = follow(state.energySlow, live ? loud * 0.55 + a.sectionLoud * 0.45 : 0, 0.9, 0.55, dt);

    // ---- beat clock: felt beats; ~8-bar cycles fitted into each song section, every point home on its downbeats ----
    const m = audio.mult();
    const F = (audio.beatPos(pos) - audio.d0) / m;
    const eS = clamp(state.energySlow * 1.2);
    const ease = (fr) => beatEase(fr, lerp(2.5, 4.5, eS), lerp(0.3, 0.6, eS)); // calm: mostly glide, loud: harder surge
    const cyc = audio.cycleAt(F, m, ease);
    if (cyc.id !== state.cycleId) { state.cycleId = cyc.id; startCycle(cyc.id, cyc.len); }
    const u = state.forceU != null ? clamp(state.forceU) : cyc.u;
    state.cycleU = u;
    state.felt = F;
    const Fi = Math.floor(F), Ff = F - Fi;
    if (live) state.flow = Fi + ease(Ff);
    elDot.style.setProperty("--cf-beat", live && !rm ? Math.exp(-Ff * 7).toFixed(3) : "0");

    // gate: glides every point home for a manual mode change or a pause, then back out
    if (state.pending || !live) {
      state.gate = Math.max(0, state.gate - dt * (state.pending ? 2.5 : 0.8));
      if (state.pending && state.gate === 0) { startCycle(state.cycleId, state.cycleLen); state.pending = false; }
    } else state.gate = Math.min(1, state.gate + dt * 0.7);
    const gate = smooth01(state.gate);

    const E = clamp(state.energySlow * 1.15);
    const depth = I * (0.3 + 0.7 * E) * state.cycScale; // the calmer, the closer to the original
    const env = envOf(u) * depth * gate;
    state.env = env;
    state.dissolve *= Math.exp(-dt / 0.3);
    state.mix = Math.min(1, state.mix + dt / 1.8);
    state.frameMix += clamp((settings.frame === "square" ? 1 : 0) - state.frameMix, -dt * 1.6, dt * 1.6); // eased toggle

    const accent = audio.accentAt(Fi * m + audio.d0);
    const downbeat = ((Fi % audio.bpb) + audio.bpb) % audio.bpb === 0 ? 1.25 : 1;
    state.pulse = live && !rm ? Math.exp(-Ff * 5.5) * (0.35 + 0.65 * accent) * downbeat * (0.3 + 0.7 * state.energyFast) * settings.intensity * (0.45 + 0.55 * clamp(env * 2)) : 0;

    if (++layoutTick % 60 === 0) layout();

    const P = PRESETS[state.presetKey];
    const asp = renderer.w / renderer.h;
    // how far the sharp mirrored cover spreads around the square: one smooth swell per cycle, not per pixel
    const act = smooth01((u - 0.06) / 0.18) * smooth01((0.94 - u) / 0.18) * clamp(depth * 2.2) * gate;
    renderer.render({
      frame: smooth01(state.frameMix), act, mode: P.mode, mix: state.mix, square: Math.min(0.8, 0.86 * asp),
      phi: u, depth: depth * gate, gate, lag: state.lag, fillk: P.fill, flow: state.flow, pulse: state.pulse,
      seed: state.seed, segs: state.segs, turns: state.turns, dir: state.dir,
      hue: state.dir * env * 0.4, glow: env * 0.5, disp: P.mode === 4 ? 0.1 : env * 0.004,
      trail: rm ? 0 : Math.max(0.08 + 0.3 * clamp(env * 1.3), 0.88 * state.dissolve),
    });
    drawGlow(canvas); // same frame as the WebGL draw, so the buffer is still readable
  }

  /* ------------------------------------------------------------------ */
  /* Track / cover handling                                              */
  /* ------------------------------------------------------------------ */
  let coverToken = 0, currentCoverUrl = null, currentTrackUri = null;

  async function refreshCover(force) {
    const data = S.Player.data;
    if (!data) return;
    const token = ++coverToken;
    let url = null;
    if (settings.source === "context") {
      url = await contextCover(data);
      if (!url && token === coverToken) note("Kein Playlist-Cover verfügbar – zeige Song-Cover");
    }
    if (!url) url = trackCover(data);
    if (token !== coverToken || !url) return;
    if (url === currentCoverUrl && !force) return;
    try {
      const img = await loadImage(url);
      if (token !== coverToken || !renderer) return;
      currentCoverUrl = url;
      renderer.pushImage(renderer.uploadImage(img));
      state.mix = 0;
      extractAccent();
    } catch (e) {
      console.warn("[Coverflux] cover load failed", e);
    }
  }

  async function extractAccent() {
    try {
      const uri = S.Player.data && S.Player.data.item && S.Player.data.item.uri;
      if (!S.colorExtractor || !uri) return;
      const c = await S.colorExtractor(uri);
      const col = c && (c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT);
      if (col) root.style.setProperty("--cf-accent", col);
    } catch (_) {}
  }

  function refreshInfo() {
    const item = S.Player.data && (S.Player.data.item || S.Player.data.track);
    if (!item) return;
    const md = item.metadata || {};
    const title = md.title || item.name || "";
    const artist = md.artist_name || (item.artists && item.artists.map((x) => x.name).join(", ")) || "";
    if (elTitle.textContent === title && elArtist.textContent === artist) return;
    elTitle.textContent = title;
    elArtist.textContent = artist;
    elInfo.classList.remove("cf-swap"); void elInfo.offsetWidth; elInfo.classList.add("cf-swap");
  }

  function refreshStatus() {
    const live = !audio.synthetic;
    const m = audio.mult();
    const o = tempoOverrides[audio.uri];
    const ratio = m === 2 ? "½" : m === 3 ? "⅓" : m === 0.5 ? "2×" : m === 4 ? "¼" : m === 1 ? "1×" : "";
    elDot.classList.toggle("cf-live", live);
    elBpmV.textContent = Math.round(audio.tempo / m) + " BPM";
    elBpmM.textContent = !live ? "sim" : typeof o === "object" ? "tap" : o !== undefined ? ratio : "";
    elBpm.title = live ? "Tempo – der Punkt blinkt auf jedem Beat" : "Keine Audio-Analyse – simulierter Takt";
    const cur = o === undefined ? "auto" : typeof o === "number" ? String(o) : "";
    ratioButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.r === cur)));
    elDetect.textContent = live ? audio.describe() : "Keine Spotify-Analyse – simulierter Takt";
    elDetect.title = elDetect.textContent;
  }

  async function onTrack() {
    const data = S.Player.data;
    const item = data && (data.item || data.track);
    const uri = item && item.uri;
    refreshInfo();
    if (uri !== currentTrackUri) {
      currentTrackUri = uri;
      state.cycleId = null; state.dissolve = 1;
      let dur = 0; try { dur = (S.Player.getDuration() || 0) / 1000; } catch (_) {}
      audio.load(uri, dur).then(refreshStatus);
      refreshStatus();
    }
    if (isOpen) refreshCover(false);
  }

  S.Player.addEventListener("songchange", () => { state.lastSync = 0; onTrack(); });
  S.Player.addEventListener("onplaypause", () => { state.lastSync = 0; });

  /* ------------------------------------------------------------------ */
  /* Open / close                                                        */
  /* ------------------------------------------------------------------ */
  function ensureRenderer() {
    if (renderer) return true;
    try {
      renderer = new Renderer(canvas);
      return true;
    } catch (e) {
      console.error("[Coverflux]", e);
      root.classList.add("cf-failed");
      return false;
    }
  }

  function onKey(e) {
    if (!isOpen) return;
    if (e.key === "Escape") { e.stopPropagation(); if (openPanel) setPanel(null); else close(); }
    else if ((e.key === "t" || e.key === "T") && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || "")) { e.stopPropagation(); tap(); }
    else if ((e.key === "[" || e.key === "]") && !/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || "")) {
      e.stopPropagation();
      setSync(settings.syncMs + (e.key === "]" ? 10 : -10));
      note("Sync " + (settings.syncMs > 0 ? "+" : "") + settings.syncMs + " ms");
    }
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    root.classList.add("cf-open");
    glowEl.classList.add("cf-open");
    root.style.bottom = Math.max(0, Math.round(window.innerHeight - playbarTop())) + "px";
    if (ensureRenderer()) {
      layout();
      renderer.needsInit = true;
      state.gate = 0; state.pending = false; state.cycleId = null;
      lastNow = 0; state.lastSync = 0;
      currentCoverUrl = null;
      onTrack();
      refreshCover(true);
      raf = requestAnimationFrame(frame);
    }
    requestAnimationFrame(syncControls);
    wake();
    document.addEventListener("keydown", onKey, true);
    button.active = true;
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    cancelAnimationFrame(raf);
    root.classList.remove("cf-open", "cf-idle");
    setPanel(null);
    glowEl.classList.remove("cf-open");
    document.removeEventListener("keydown", onKey, true);
    button.active = false;
  }

  // Registers on the right side of the playbar, next to the lyrics (karaoke) button.
  const button = new S.Playbar.Button("Coverflux Visualizer", ICON, () => (isOpen ? close() : open()), false, false, true);
  const labelButton = () => {
    const el = button.element;
    if (el && el.setAttribute) { el.setAttribute("aria-label", "Coverflux Visualizer"); el.setAttribute("data-testid", "coverflux-button"); }
  };
  labelButton(); setTimeout(labelButton, 1500);

  syncControls();
  onTrack();
  window.Coverflux = { open, close, toggle: () => (isOpen ? close() : open()), state, settings, audio, presets: PRESETS };
})();
