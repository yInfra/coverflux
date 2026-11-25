// NAME: Coverflux
// AUTHOR: yInfra
// DESCRIPTION: Turns everything above the playbar into a beat-locked visualizer that morphs the cover art along beat-locked loops that always move forward and land on the original.
// VERSION: 2.1.0

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
  const DEFAULTS = { source: "track", intensity: 0.75, mode: "auto", showInfo: true, syncMs: 0 };
  const loadJSON = (k, def) => { try { return Object.assign({}, def, JSON.parse(S.LocalStorage.get(k) || "{}")); } catch (_) { return Object.assign({}, def); } };
  const settings = loadJSON(SETTINGS_KEY, DEFAULTS);
  if (!PRESET_KEYS().includes(settings.mode) && settings.mode !== "auto") settings.mode = "auto";
  const tempoOverrides = loadJSON(TEMPO_KEY, {});
  const saveSettings = () => { try { S.LocalStorage.set(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} };
  const saveTempo = () => {
    const keys = Object.keys(tempoOverrides);
    if (keys.length > 300) delete tempoOverrides[keys[0]];
    try { S.LocalStorage.set(TEMPO_KEY, JSON.stringify(tempoOverrides)); } catch (_) {}
  };

  // One morph character at a time. `fill` = how far the sharp, mirrored cover spreads beyond its square while morphing.
  function PRESET_KEYS() { return ["liquid", "vortex", "ripple", "shatter", "prism", "kaleido", "mandala", "fractal", "tunnel"]; }
  const PRESETS = {
    liquid:  { label: "Liquid",  mode: 0, fill: 3.0 },
    vortex:  { label: "Vortex",  mode: 1, fill: 3.0 },
    ripple:  { label: "Ripple",  mode: 2, fill: 1.6 },
    shatter: { label: "Shatter", mode: 3, fill: 2.0 },
    prism:   { label: "Prism",   mode: 4, fill: 1.8 },
    kaleido: { label: "Kaleido", mode: 5, fill: 3.0 },
    mandala: { label: "Mandala", mode: 6, fill: 3.0 },
    fractal: { label: "Fractal", mode: 7, fill: 3.0 },
    tunnel:  { label: "Tunnel",  mode: 8, fill: 0.15 },
  };
  // Auto mode picks from these depending on the energy of the current song section.
  const CALM_POOL = ["liquid", "ripple", "kaleido", "mandala", "prism"];
  const LOUD_POOL = ["kaleido", "fractal", "vortex", "shatter", "tunnel", "mandala", "liquid", "prism"];
  const CYCLE_BARS = 8; // one full loop away from the cover and back onto it

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
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
      this.tempo = (a.track && a.track.tempo) || (this.beats.length > 1 ? 60 / ((this.beats[this.beats.length - 1].start - this.beats[0].start) / (this.beats.length - 1)) : 120);
      this.bpb = clamp(Math.round((a.track && a.track.time_signature) || 4), 3, 7);
      const bars = a.bars && a.bars.length ? a.bars : null;
      this.d0 = bars ? this.nearestBeat(bars[0].start) : 0;
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
      this.autoMult = this.synthetic ? 1 : this.detectFeel();
      this._fa = null; this._csi = 0;
    }

    // Section starts in felt beats (cached per tempo feel).
    feltAnchors(m) {
      if (this._fa && this._faM === m) return this._fa;
      const arr = [];
      for (const b of this.secAnchor) { const f = Math.round((b - this.d0) / m); if (!arr.length || f > arr[arr.length - 1]) arr.push(f); }
      if (!arr.length || arr[0] > 0) arr.unshift(0);
      this._fa = { arr, total: (this.beats.length - this.d0) / m }; this._faM = m;
      return this._fa;
    }

    // Splits every section into ~CYCLE_BARS-bar cycles (whole bars, last one ends on the next section start).
    // u = beat-stepped progress 0..1: each beat pushes forward, eased by kE.
    cycleAt(F, m, kE) {
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
      return { id: si + ":" + k, u: clamp((kk + 1 - Math.pow(1 - fr, kE)) / len), len };
    }

    // Spotify often reports double time for songs that *feel* half as fast.
    // Returns how many Spotify beats make one felt beat (2 = halve, 0.5 = double).
    detectFeel() {
      const tempo = this.tempo, acc = this.acc;
      if (tempo < 58) return 0.5;
      if (tempo < 112) return 1;
      let even = 0, odd = 0, ne = 0, no = 0;
      for (let i = 0; i < acc.length; i++) {
        if (((i - this.d0) % 2 + 2) % 2 === 0) { even += acc[i]; ne++; } else { odd += acc[i]; no++; }
      }
      const ratio = (even / Math.max(ne, 1) + 0.02) / (odd / Math.max(no, 1) + 0.02);
      this.parity = ratio;
      if (tempo >= 152) return ratio > 0.75 ? 2 : 1;
      if (tempo >= 128 && ratio > 1.22) return 2;
      if (ratio > 1.55) return 2;
      return 1;
    }

    mult(uri) {
      const o = tempoOverrides[uri || this.uri];
      return o === 0.5 || o === 1 || o === 2 ? o : this.autoMult || 1;
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
  uniform float uAct, uMix, uSquare, uPhi, uDepth, uGate, uLag, uFillK, uFlow, uPulse, uSeed, uSegs, uHue, uTrail, uGlow, uDisp, uTurns, uDir;
  uniform int uMode;
  const float TAU = 6.2831853, PI = 3.14159265;
  mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,s,-s,c); }
  vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
  vec3 hueShift(vec3 c, float a){ const vec3 k = vec3(0.57735); float ca=cos(a); return c*ca + cross(k,c)*sin(a) + k*dot(k,c)*(1.0-ca); }
  vec2 clampLen(vec2 v, float m){ float l = length(v); return l > m ? v*(m/l) : v; }

  vec2 gGx, gGy; float gShade, gSpec, gEdge, gRim, gE, gF, gDiag; vec2 gDispV, gMask;

  vec2 mirror(vec2 q){ return 1.0 - abs(1.0 - mod(q, 2.0)); }
  vec3 img(vec2 m){ return mix(textureGrad(uImgA, m, gGx, gGy).rgb, textureGrad(uImgB, m, gGx, gGy).rgb, uMix); }
  vec3 imgLod(vec2 m, float l){ return mix(textureLod(uImgA, m, l).rgb, textureLod(uImgB, m, l).rgb, uMix); }
  // cover space q: [0,1]^2 is the cover square. Outside: blurred ambient – unless fill spreads the sharp mirrored cover.
  vec3 cover(vec2 q, float fill){
    vec2 m = mirror(q);
    vec2 qm = q + gMask;
    float d = max(abs(qm.x-0.5), abs(qm.y-0.5)) - 0.5;
    float soft = 0.002 + 0.12*clamp(fill, 0.0, 1.0);
    float mask = smoothstep(-soft, soft, d - fill);
    vec3 c = img(m);
    if (mask > 0.0) {
      float dd = max(d - fill, 0.0);
      vec3 amb = imgLod(m, 6.0) * (0.10 + 0.32*exp(-dd*1.6)) * (1.0 - 0.75*exp(-dd*9.0));
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
  float prog(float lam){ float x = clamp((uPhi - uLag*lam)/(1.0 - uLag), 0.0, 1.0); return x*x*x*(x*(x*6.0-15.0)+10.0); }
  float envOf(float x){ return smoothstep(0.0, 0.3, x)*(1.0 - smoothstep(0.7, 1.0, x)); }
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
    float chi = uDir*0.5*PI*uPhi;
    float off = uSeed*0.53 + uDir*PI*0.35*uPhi + 0.06*sin(uFlow*TAU/8.0);
    vec2 k = rot(chi)*kfold(rot(-chi)*p, uSegs, off);
    if (mandala) {
      float rk = length(k) + 0.015; float ak = atan(k.y, k.x);
      float m = (log(rk) + uFlow*0.12)/1.1;
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
    vec3 c = colorAt(w, dx, dy, uFillK*uAct);
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
      for (const k of ["Act", "Mix", "Square", "Phi", "Depth", "Gate", "Lag", "FillK", "Flow", "Pulse", "Seed", "Segs", "Hue", "Trail", "Glow", "Disp", "Turns", "Dir"]) {
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
  #coverflux .cf-controls{position:absolute;right:24px;bottom:22px;display:flex;align-items:center;gap:4px;padding:6px;
    border-radius:999px;background:rgba(14,14,15,.52);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 10px 30px rgba(0,0,0,.35);-webkit-app-region:no-drag}
  #coverflux .cf-seg{display:flex;position:relative;border-radius:999px;background:rgba(255,255,255,.06);padding:2px}
  #coverflux button{all:unset;cursor:pointer;box-sizing:border-box}
  #coverflux .cf-seg button{position:relative;z-index:1;padding:6px 12px;font-size:12px;font-weight:600;border-radius:999px;color:rgba(243,239,232,.62);
    transition:color .2s ease}
  #coverflux .cf-seg button[aria-checked="true"]{color:#111}
  #coverflux .cf-seg .cf-thumb{position:absolute;top:2px;bottom:2px;border-radius:999px;background:var(--cf-accent);
    transition:left .35s cubic-bezier(.3,.8,.2,1),width .35s cubic-bezier(.3,.8,.2,1)}
  #coverflux .cf-field{display:flex;align-items:center;gap:8px;padding:0 9px;height:30px;font-size:11px;font-weight:600;letter-spacing:.06em;
    text-transform:uppercase;color:rgba(243,239,232,.55)}
  #coverflux select{all:unset;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:#f3efe8;padding-right:14px;
    background:linear-gradient(45deg,transparent 50%,currentColor 50%) right 4px center/4px 4px no-repeat,
      linear-gradient(-45deg,transparent 50%,currentColor 50%) right 0 center/4px 4px no-repeat}
  #coverflux select option{background:#1c1c1e;color:#f3efe8}
  #coverflux input[type=range]{-webkit-appearance:none;appearance:none;width:84px;height:3px;border-radius:3px;cursor:pointer;
    background:linear-gradient(90deg,var(--cf-accent) var(--v,70%),rgba(255,255,255,.18) var(--v,70%))}
  #coverflux input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#f3efe8;
    box-shadow:0 0 0 4px rgba(255,255,255,.08);transition:transform .15s ease}
  #coverflux input[type=range]:hover::-webkit-slider-thumb{transform:scale(1.2)}
  #coverflux .cf-sync input{width:64px}
  #coverflux .cf-val{min-width:44px;font-variant-numeric:tabular-nums;letter-spacing:0;text-transform:none;color:#f3efe8;font-size:11px}
  #coverflux .cf-bpm{display:flex;align-items:center;gap:7px;height:30px;padding:0 11px;border-radius:999px;font-size:12px;font-weight:600;
    font-variant-numeric:tabular-nums;color:#f3efe8;transition:background .2s ease}
  #coverflux .cf-bpm:hover{background:rgba(255,255,255,.08)}
  #coverflux .cf-bpm small{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:rgba(243,239,232,.5)}
  #coverflux .cf-dot{width:6px;height:6px;border-radius:50%;background:#7a7a7a;flex:none}
  #coverflux .cf-dot.cf-live{background:var(--cf-accent);box-shadow:0 0 10px var(--cf-accent)}
  #coverflux .cf-close{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:rgba(243,239,232,.75);
    transition:background .2s ease,color .2s ease,transform .2s ease}
  #coverflux .cf-close:hover{background:rgba(255,255,255,.1);color:#fff;transform:rotate(90deg)}
  #coverflux button:focus-visible,#coverflux select:focus-visible,#coverflux input:focus-visible{outline:2px solid var(--cf-accent);outline-offset:2px}
  #coverflux .cf-note{position:absolute;right:28px;bottom:74px;font-size:11px;color:rgba(243,239,232,.7);opacity:0;transition:opacity .4s ease;pointer-events:none}
  #coverflux .cf-note.cf-show{opacity:1}
  #coverflux .cf-error{position:absolute;inset:0;display:none;place-items:center;font-size:14px;color:rgba(243,239,232,.7)}
  #coverflux.cf-failed .cf-error{display:grid}
  @media (max-width:1100px){#coverflux .cf-sync{display:none}}
  @media (max-width:900px){#coverflux .cf-field.cf-int{display:none}#coverflux .cf-info{max-width:30vw}}
  @media (prefers-reduced-motion:reduce){#coverflux,#coverflux .cf-chrome{transition:none}}
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
    <div class="cf-controls cf-chrome">
      <div class="cf-seg" role="radiogroup" aria-label="Bildquelle">
        <span class="cf-thumb"></span>
        <button role="radio" data-src="track">Song</button>
        <button role="radio" data-src="context">Playlist</button>
      </div>
      <label class="cf-field">Modus
        <select class="cf-mode" aria-label="Modus">
          <option value="auto">Auto</option>
          ${PRESET_KEYS().map((k) => `<option value="${k}">${PRESETS[k].label}</option>`).join("")}
        </select>
      </label>
      <label class="cf-field cf-int">Intensität <input class="cf-intensity" type="range" min="0" max="100" aria-label="Intensität"></label>
      <label class="cf-field cf-sync" title="Verschiebt die Visuals gegenüber dem Ton. Plus = früher. Tasten [ und ]">Sync
        <input class="cf-syncr" type="range" min="-250" max="250" step="10" aria-label="Sync-Versatz"><span class="cf-val cf-syncv"></span></label>
      <button class="cf-bpm" aria-label="Tempo-Gefühl umschalten"><span class="cf-dot"></span><span class="cf-bpmv">– BPM</span><small class="cf-bpmm"></small></button>
      <button class="cf-close" aria-label="Visualizer schließen" title="Schließen (Esc)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
      </button>
    </div>`;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const canvas = $("canvas");
  const elTitle = $(".cf-title"), elArtist = $(".cf-artist"), elInfo = $(".cf-info");
  const elMode = $(".cf-mode"), elInt = $(".cf-intensity"), elNote = $(".cf-note");
  const elSync = $(".cf-syncr"), elSyncV = $(".cf-syncv");
  const elBpm = $(".cf-bpm"), elBpmV = $(".cf-bpmv"), elBpmM = $(".cf-bpmm"), elDot = $(".cf-dot");
  const segButtons = Array.from(root.querySelectorAll(".cf-seg button"));
  const thumb = $(".cf-thumb");

  function syncControls() {
    segButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === settings.source)));
    const active = segButtons.find((b) => b.dataset.src === settings.source);
    if (active && active.offsetWidth) { thumb.style.left = active.offsetLeft + "px"; thumb.style.width = active.offsetWidth + "px"; }
    elMode.value = settings.mode;
    elInt.value = Math.round(settings.intensity * 100);
    elInt.style.setProperty("--v", elInt.value + "%");
    elSync.value = settings.syncMs;
    elSync.style.setProperty("--v", ((settings.syncMs + 250) / 5) + "%");
    elSyncV.textContent = (settings.syncMs > 0 ? "+" : "") + settings.syncMs + " ms";
    root.classList.toggle("cf-noinfo", !settings.showInfo);
  }

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
  elMode.addEventListener("change", () => { settings.mode = elMode.value; saveSettings(); state.pending = true; });
  elInt.addEventListener("input", () => { settings.intensity = elInt.value / 100; elInt.style.setProperty("--v", elInt.value + "%"); saveSettings(); });
  const setSync = (ms) => { settings.syncMs = clamp(Math.round(ms / 10) * 10, -250, 250); saveSettings(); syncControls(); };
  elSync.addEventListener("input", () => setSync(+elSync.value));
  elBpm.addEventListener("click", () => {
    const uri = audio.uri;
    if (!uri) return;
    // cycle: Auto -> halbe -> normal -> doppelte -> Auto
    const order = [undefined, 2, 1, 0.5];
    const cur = tempoOverrides[uri];
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (next === undefined) delete tempoOverrides[uri]; else tempoOverrides[uri] = next;
    saveTempo(); refreshStatus(); state.pending = true;
    note(next === undefined ? "Tempo: automatisch erkannt" : "Tempo für diesen Song fixiert");
  });
  $(".cf-close").addEventListener("click", () => close());

  // idle chrome
  let idleTimer = 0;
  function wake() {
    root.classList.remove("cf-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!root.matches(":focus-within") && !root.querySelector(".cf-controls:hover")) root.classList.add("cf-idle"); else wake(); }, 2600);
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
    energyFast: 0, energySlow: 0, gate: 0, env: 0, pulse: 0, mix: 1, dissolve: 0,
    presetKey: "liquid", seed: 0, segs: 8, dir: 1, turns: 0, lag: 0.35, cycScale: 1, pending: false,
    cycleId: null, cycleLen: 32, cycleU: 0, felt: 0, flow: 0, forceU: null,
    pos: 0, posAt: 0, playing: false, lastSync: 0, time: 0,
  };
  let isOpen = false, raf = 0, lastNow = 0, layoutTick = 0;
  const envOf = (x) => smooth01(x / 0.3) * (1 - smooth01((x - 0.7) / 0.3));

  // Latched once per cycle, while every point is home – so switching never shows.
  function startCycle(id, len) {
    let key = settings.mode;
    if (key === "auto" || !PRESETS[key]) {
      const pool = state.energySlow > 0.5 ? LOUD_POOL : CALM_POOL;
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
    state.lag = rm ? 0.1 : 0.18 + 0.14 * E;
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
    const kE = lerp(1.6, 4.0, clamp(state.energySlow * 1.2)); // calm: smooth glide, loud: hard push on every beat
    const cyc = audio.cycleAt(F, m, kE);
    if (cyc.id !== state.cycleId) { state.cycleId = cyc.id; startCycle(cyc.id, cyc.len); }
    const u = state.forceU != null ? clamp(state.forceU) : cyc.u;
    state.cycleU = u;
    state.felt = F;
    const Fi = Math.floor(F), Ff = F - Fi;
    if (live) state.flow = Fi + 1 - Math.pow(1 - Ff, kE);

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

    const accent = audio.accentAt(Fi * m + audio.d0);
    const downbeat = ((Fi % audio.bpb) + audio.bpb) % audio.bpb === 0 ? 1.25 : 1;
    state.pulse = live && !rm ? Math.exp(-Ff * 5.5) * (0.35 + 0.65 * accent) * downbeat * (0.3 + 0.7 * state.energyFast) * settings.intensity * (0.45 + 0.55 * clamp(env * 2)) : 0;

    if (++layoutTick % 60 === 0) layout();

    const P = PRESETS[state.presetKey];
    const asp = renderer.w / renderer.h;
    // how far the sharp mirrored cover spreads around the square: one smooth swell per cycle, not per pixel
    const act = smooth01((u - 0.12) / 0.3) * smooth01((0.88 - u) / 0.3) * clamp(depth * 2.2) * gate;
    renderer.render({
      act, mode: P.mode, mix: state.mix, square: Math.min(0.8, 0.86 * asp),
      phi: u, depth: depth * gate, gate, lag: state.lag, fillk: P.fill, flow: state.flow, pulse: state.pulse,
      seed: state.seed, segs: state.segs, turns: state.turns, dir: state.dir,
      hue: state.dir * env * 0.4, glow: env * 0.5, disp: P.mode === 4 ? 0.1 : env * 0.004,
      trail: rm ? 0 : Math.max(0.08 + 0.3 * clamp(env * 1.3), 0.88 * state.dissolve),
    });
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
    const fixed = tempoOverrides[audio.uri] !== undefined;
    elDot.classList.toggle("cf-live", live);
    elBpmV.textContent = Math.round(audio.tempo / m) + " BPM";
    elBpmM.textContent = !live ? "simuliert" : fixed ? (m === 2 ? "½ fix" : m === 0.5 ? "2× fix" : "1× fix") : m !== 1 ? (m === 2 ? "auto ½" : "auto 2×") : "auto";
    elBpm.title = (live
      ? "Spotify-Analyse: Beats, Takte und Abschnitte des Songs steuern die Visuals."
      : "Keine Audio-Analyse verfügbar – die Bewegung folgt einem simulierten Takt, nicht der echten Musik.")
      + "\nSpotify meldet " + Math.round(audio.tempo) + " BPM. Klicken: Auto → halbes → normales → doppeltes Tempo (wird pro Song gespeichert).";
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
    if (e.key === "Escape") { e.stopPropagation(); close(); }
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
