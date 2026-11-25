// NAME: Coverflux
// AUTHOR: yInfra
// DESCRIPTION: Turns everything above the playbar into an audio-reactive visualizer that morphs the current cover art – and breathes back to the original image in calm passages.
// VERSION: 1.0.0

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
  const DEFAULTS = { source: "track", intensity: 0.7, mode: "auto", showInfo: true };
  const settings = (() => {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(S.LocalStorage.get(SETTINGS_KEY) || "{}"));
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  })();
  const saveSettings = () => {
    try { S.LocalStorage.set(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  };

  // Morph presets. Weights: [liquid, vortex, tunnel, ripple, shatter, kaleido]
  const PRESETS = {
    liquid:  { label: "Liquid",   w: [1.0, 0.25, 0.0, 0.0, 0.0, 0.0] },
    vortex:  { label: "Vortex",   w: [0.3, 1.0, 0.35, 0.0, 0.0, 0.0] },
    tunnel:  { label: "Tunnel",   w: [0.2, 0.35, 1.0, 0.3, 0.0, 0.0] },
    ripple:  { label: "Ripple",   w: [0.45, 0.0, 0.0, 1.0, 0.0, 0.0] },
    shatter: { label: "Shatter",  w: [0.3, 0.0, 0.0, 0.0, 1.0, 0.0] },
    kaleido: { label: "Kaleido",  w: [0.35, 0.45, 0.0, 0.0, 0.0, 1.0] },
    prism:   { label: "Prism",    w: [0.5, 0.0, 0.45, 0.0, 0.35, 0.55] },
  };
  const AUTO_ORDER = ["liquid", "vortex", "shatter", "tunnel", "kaleido", "ripple", "prism"];

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const follow = (cur, target, up, down, dt) => {
    const rate = target > cur ? up : down;
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  };
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

  /* ------------------------------------------------------------------ */
  /* Audio model – Spotify audio analysis, with honest synthetic fallback */
  /* ------------------------------------------------------------------ */
  function buildSynthetic(uri, durationSec) {
    const rnd = mulberry(hashStr(uri || "x"));
    const tempo = 96 + Math.floor(rnd() * 40);
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
      const pitches = Array.from({ length: 12 }, () => rnd() * 0.4);
      pitches[(si * 5 + (onBeat ? 0 : 7)) % 12] = 1;
      segments.push({
        start: t, duration: beatLen / 2, loudness_start: max - 8 - rnd() * 4, loudness_max: max,
        loudness_max_time: 0.02, pitches, timbre: [0, rnd() * 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      });
    }
    return { synthetic: true, track: { tempo, loudness: -9, duration: dur }, beats, bars, sections, segments };
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
      const ok = data && Array.isArray(data.segments) && data.segments.length > 8 && Array.isArray(data.beats);
      const analysis = ok ? data : buildSynthetic(uri, durationSec);
      if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(uri, analysis);
      this.set(analysis);
    }

    set(a) {
      this.a = a;
      this.synthetic = !!a.synthetic;
      this.si = 0; this.bi = 0; this.bri = 0; this.sei = 0;
      // Per-track adaptive loudness range (10th..96th percentile of segment peaks)
      const peaks = a.segments.map((s) => s.loudness_max).sort((x, y) => x - y);
      this.lo = peaks[Math.floor(peaks.length * 0.1)] ?? -30;
      this.hi = peaks[Math.floor(peaks.length * 0.96)] ?? -4;
      if (this.hi - this.lo < 6) this.lo = this.hi - 6;
      const secL = (a.sections || []).map((s) => s.loudness).sort((x, y) => x - y);
      this.secLo = secL.length ? secL[0] : -20;
      this.secHi = secL.length ? secL[secL.length - 1] : -5;
      if (this.secHi - this.secLo < 4) this.secLo = this.secHi - 4;
      const timb = a.segments.map((s) => (s.timbre ? s.timbre[1] : 0)).sort((x, y) => x - y);
      this.brLo = timb[Math.floor(timb.length * 0.1)] ?? -50;
      this.brHi = timb[Math.floor(timb.length * 0.9)] ?? 100;
    }

    // Find index of last item with start <= t, using a moving cursor (fast for monotonic time)
    seek(list, cursor, t) {
      if (!list || !list.length) return -1;
      let i = clamp(cursor, 0, list.length - 1);
      if (list[i].start > t) {
        // jumped backwards: binary search
        let lo = 0, hi = list.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (list[m].start <= t) lo = m; else hi = m - 1; }
        return list[lo].start <= t ? lo : -1;
      }
      while (i < list.length - 1 && list[i + 1].start <= t) i++;
      if (i - cursor > 64) { /* fine */ }
      return i;
    }

    norm(db) { return clamp((db - this.lo) / (this.hi - this.lo)); }

    sample(t) {
      const a = this.a;
      const out = { loud: 0, beat: 0, bar: 0, onset: 0, section: 0, sectionLoud: 0.5, barIndex: 0, beatIndex: 0, pitch: 0, bright: 0.5, tempo: 120 };
      if (!a) return out;
      out.tempo = (a.track && a.track.tempo) || 120;

      const si = this.seek(a.segments, this.si, t);
      if (si >= 0) {
        this.si = si;
        const s = a.segments[si];
        const nx = a.segments[si + 1];
        const dt = t - s.start;
        let db;
        const lmt = s.loudness_max_time || 0;
        if (dt < lmt) db = lerp(s.loudness_start, s.loudness_max, dt / Math.max(lmt, 1e-3));
        else {
          const end = nx ? nx.loudness_start : s.loudness_max - 12;
          db = lerp(s.loudness_max, end, clamp((dt - lmt) / Math.max(s.duration - lmt, 1e-3)));
        }
        out.loud = this.norm(db);
        const attack = clamp((s.loudness_max - s.loudness_start) / 18);
        out.onset = attack * Math.exp(-dt * 9) * this.norm(s.loudness_max);
        if (s.pitches) {
          let best = 0; for (let k = 1; k < 12; k++) if (s.pitches[k] > s.pitches[best]) best = k;
          out.pitch = best;
        }
        if (s.timbre) out.bright = clamp((s.timbre[1] - this.brLo) / Math.max(this.brHi - this.brLo, 1));
      }
      const bi = this.seek(a.beats, this.bi, t);
      if (bi >= 0) {
        this.bi = bi;
        const b = a.beats[bi];
        const ph = (t - b.start) / Math.max(b.duration, 0.05);
        out.beat = Math.exp(-ph * 4.5) * clamp(0.45 + (b.confidence || 0) * 0.8);
        out.beatIndex = bi;
      }
      const bri = this.seek(a.bars, this.bri, t);
      if (bri >= 0) {
        this.bri = bri;
        const b = a.bars[bri];
        out.bar = Math.exp(-((t - b.start) / Math.max(b.duration, 0.2)) * 3);
        out.barIndex = bri;
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

  const COMMON = `
  float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y); }
  float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }
  vec2 curl(vec2 p){ float e=0.02;
    float n1=fbm(p+vec2(0,e)), n2=fbm(p-vec2(0,e)), n3=fbm(p+vec2(e,0)), n4=fbm(p-vec2(e,0));
    return vec2(n1-n2, -(n3-n4))/(2.0*e); }
  vec3 hueShift(vec3 c, float a){ const vec3 k = vec3(0.57735); float ca=cos(a);
    return c*ca + cross(k,c)*sin(a) + k*dot(k,c)*(1.0-ca); }
  `;

  const TARGET = `
  vec3 target(vec2 uv){
    float asp = uRes.x/uRes.y;
    vec2 p = (uv-0.5)*vec2(asp,1.0);
    vec2 q = p/uSquare + 0.5;                  // cover space
    vec2 m = 1.0 - abs(1.0 - mod(q, 2.0));      // mirrored continuation
    float d = max(abs(q.x-0.5), abs(q.y-0.5)) - 0.5; // >0 outside cover
    vec3 sharpC = mix(textureLod(uImgA, clamp(q,0.0,1.0), 0.0).rgb, textureLod(uImgB, clamp(q,0.0,1.0), 0.0).rgb, uMix);
    vec3 blurC  = mix(textureLod(uImgA, m, 6.0).rgb, textureLod(uImgB, m, 6.0).rgb, uMix);
    float shadow = 1.0 - 0.75*exp(-max(d,0.0)*9.0);
    vec3 amb = blurC * (0.10 + 0.32*exp(-max(d,0.0)*1.6)) * shadow;
    return mix(sharpC, amb, smoothstep(-0.0015, 0.0015, d));
  }
  `;

  // Feedback pass: warps the previous frame and pulls it back toward the original cover.
  const FEEDBACK = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uPrev, uImgA, uImgB;
  uniform vec2 uRes;
  uniform float uTime, uDt, uMix, uEnergy, uBeat, uBar, uOnset, uRestore, uAmount, uHue, uBeatCount, uTrans, uSquare, uSeed, uSharp;
  uniform float uW[6];
  ${COMMON}
  ${TARGET}
  void main(){
    float asp = uRes.x/uRes.y;
    vec2 p = (vUv-0.5)*vec2(asp,1.0);
    float r = length(p);
    float t = uTime;
    vec2 v = vec2(0.0);
    // 0 liquid: curl-noise flow
    v += uW[0] * curl(p*1.6 + vec2(t*0.07, -t*0.05) + uSeed) * 0.22;
    // 1 vortex: swirl around center
    float dir = sin(uSeed*7.0) > 0.0 ? 1.0 : -1.0;
    v += uW[1] * dir * vec2(-p.y, p.x) * (0.9 + 1.6*uBeat) * exp(-r*1.2);
    // 2 tunnel: zoom inward with a twist
    v += uW[2] * (p * (0.25 + 0.9*uBeat) + vec2(-p.y,p.x)*0.35*dir);
    // 3 ripple: waves emitted on beats
    v += uW[3] * (p/(r+1e-3)) * sin(r*26.0 - t*7.0) * (0.25 + 1.8*uBeat);
    // 4 shatter: cells jump on each beat, bands glitch on onsets
    vec2 cell = floor(p*vec2(5.0,5.0) + uSeed);
    vec2 h = vec2(hash(cell + uBeatCount), hash(cell*1.7 + uBeatCount + 3.1)) - 0.5;
    float band = floor(vUv.y*36.0);
    float g = step(0.86, hash(vec2(band, uBeatCount)));
    v += uW[4] * (h * 3.2 * uBeat + vec2((hash(vec2(band, uBeatCount+9.0))-0.5) * 9.0 * g * uOnset, 0.0));
    // song transition swirl
    v += uTrans * vec2(-p.y, p.x) * 2.2 * exp(-r*0.8);

    vec2 sp = p - v * uAmount * uDt;
    vec2 suv = sp/vec2(asp,1.0) + 0.5;
    vec3 prev = texture(uPrev, suv).rgb;
    // unsharp mask: counteracts the blur of repeated bilinear resampling -> crisp, inky edges instead of mush
    vec2 px = 1.0/uRes;
    vec3 nb = texture(uPrev, suv+vec2(px.x,0.0)).rgb + texture(uPrev, suv-vec2(px.x,0.0)).rgb
            + texture(uPrev, suv+vec2(0.0,px.y)).rgb + texture(uPrev, suv-vec2(0.0,px.y)).rgb;
    prev = clamp(prev + (prev - nb*0.25) * uSharp, 0.0, 1.0);
    prev = hueShift(prev, uHue*uDt);
    // keep contrast from washing out under repeated resampling
    prev = clamp(mix(prev, prev*prev*(3.0-2.0*prev), 0.004*uAmount), 0.0, 1.0);
    vec3 tgt = target(vUv);
    o = vec4(mix(prev, tgt, uRestore), 1.0);
  }`;

  // Display pass: non-accumulating effects (kaleidoscope, punch, chroma split, glow, grain).
  const DISPLAY = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uFb, uImgA, uImgB;
  uniform vec2 uRes;
  uniform float uTime, uKale, uBeat, uOnset, uMorph, uSegs, uGlow, uClean, uMix, uSquare, uSeed, uBeatCount, uWarp, uTrail;
  uniform float uW[6];
  ${COMMON}
  ${TARGET}
  void main(){
    float asp = uRes.x/uRes.y;
    vec2 p = (vUv-0.5)*vec2(asp,1.0);
    if (uKale > 0.001) {
      float r = length(p); float a = atan(p.y, p.x);
      float seg = 6.2831853/uSegs;
      float ka = mod(a + uTime*0.06, seg); ka = abs(ka - seg*0.5) + uTime*0.04 + uSeed;
      // fold into a wedge that stays inside the cover and slowly sweeps across it
      vec2 k = r*0.5*vec2(cos(ka), sin(ka));
      p = mix(p, k, uKale);
    }
    p *= 1.0 - uBeat*0.022*uMorph;
    vec2 uv = p/vec2(asp,1.0) + 0.5;
    vec2 d = (uv-0.5);
    float ca = (0.0008 + uOnset*0.010 + uBeat*0.004) * uMorph;
    vec3 c;
    c.r = texture(uFb, uv + d*ca*2.0).r;
    c.g = texture(uFb, uv).g;
    c.b = texture(uFb, uv - d*ca*2.0).b;
    if (uGlow > 0.001) {
      vec3 acc = vec3(0.0);
      vec2 px = 1.0/uRes;
      for (int i=0;i<8;i++){
        float an = float(i)*0.785398;
        vec3 s = texture(uFb, uv + vec2(cos(an),sin(an))*px*14.0).rgb;
        acc += max(s - 0.68, 0.0);
      }
      c += acc/8.0 * uGlow * 0.9;
    }
    // direct layer: the crisp original cover, bent by a live (non-accumulating) field.
    // Keeps real image detail on screen while the feedback layer adds the liquid trails.
    if (uTrail < 0.999) {
      float r = length(p);
      vec2 f = vec2(0.0);
      f += (0.35 + uW[0]) * curl(p*1.6 + vec2(uTime*0.13, -uTime*0.09) + uSeed) * 0.075;
      f += (0.4 + 0.6*uW[0]) * curl(p*4.2 - vec2(uTime*0.21, uTime*0.17) + uSeed*1.7) * 0.022 * (0.4 + uBeat);
      f -= p * uBeat * 0.06; // breath on the kick
      float ang = uW[1] * (0.10 + 0.32*uBeat) * (exp(-r*2.6) - 0.25) * (sin(uSeed*7.0) > 0.0 ? 1.0 : -1.0);
      f += vec2(cos(ang)*p.x - sin(ang)*p.y, sin(ang)*p.x + cos(ang)*p.y) - p;
      f += uW[2] * (-p) * (0.05 + 0.18*uBeat);
      f += uW[3] * (p/(r+1e-3)) * sin(r*28.0 - uTime*6.0) * (0.01 + 0.035*uBeat);
      vec2 cell = floor(p*5.0 + uSeed);
      f += uW[4] * (vec2(hash(cell + uBeatCount), hash(cell*1.7 + uBeatCount + 3.1)) - 0.5) * 0.12 * uBeat;
      vec2 wuv = (p + f*uWarp)/vec2(asp,1.0) + 0.5;
      vec2 cd = (wuv-0.5)*ca*2.0;
      vec3 dc = vec3(target(wuv+cd).r, target(wuv).g, target(wuv-cd).b);
      c = mix(dc, c, uTrail);
    }
    // calm moments: let the untouched, pixel-sharp cover shine through
    if (uClean > 0.001) c = mix(c, target(vUv), uClean);
    c *= 1.0 + uBeat*0.10*uMorph;
    float vig = smoothstep(1.25, 0.35, length((vUv-0.5)*vec2(asp,1.0)));
    c *= mix(0.62, 1.0, vig);
    c += (hash(vUv*uRes + fract(uTime*7.0)*311.0) - 0.5) * 0.028;
    o = vec4(c, 1.0);
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
      this.fbProg = this.program(VERT, FEEDBACK);
      this.dpProg = this.program(VERT, DISPLAY);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      for (const prog of [this.fbProg, this.dpProg]) {
        const loc = gl.getAttribLocation(prog.p, "aPos");
        if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
      }
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
        const name = info.name.replace(/\[0\]$/, "");
        u[name] = gl.getUniformLocation(p, info.name);
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
      return t;
    }

    pushImage(tex) {
      const gl = this.gl;
      if (this.imgA !== this.imgB && this.imgA) gl.deleteTexture(this.imgA);
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
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
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

      // feedback
      const P = this.fbProg;
      gl.useProgram(P.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(P.u.uPrev, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.imgA); gl.uniform1i(P.u.uImgA, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.imgB); gl.uniform1i(P.u.uImgB, 2);
      gl.uniform2f(P.u.uRes, this.w, this.h);
      const set = (name, v) => { if (P.u[name]) gl.uniform1f(P.u[name], v); };
      set("uTime", f.time); set("uDt", f.dt); set("uMix", f.mix); set("uEnergy", f.energy);
      set("uBeat", f.beat); set("uBar", f.bar); set("uOnset", f.onset);
      set("uRestore", this.needsInit ? 1 : f.restore);
      set("uAmount", f.amount); set("uHue", f.hue); set("uBeatCount", f.beatCount);
      set("uTrans", f.trans); set("uSquare", f.square); set("uSeed", f.seed); set("uSharp", f.sharp);
      if (P.u.uW) gl.uniform1fv(P.u.uW, f.w);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.needsInit = false;

      // display
      const D = this.dpProg;
      gl.useProgram(D.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst.tex); gl.uniform1i(D.u.uFb, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.imgA); gl.uniform1i(D.u.uImgA, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.imgB); gl.uniform1i(D.u.uImgB, 2);
      gl.uniform2f(D.u.uRes, this.w, this.h);
      const setD = (name, v) => { if (D.u[name]) gl.uniform1f(D.u[name], v); };
      setD("uTime", f.time); setD("uKale", f.kale); setD("uBeat", f.beat); setD("uOnset", f.onset);
      setD("uMorph", f.morph); setD("uSegs", f.segs); setD("uGlow", f.glow);
      setD("uClean", f.clean); setD("uMix", f.mix); setD("uSquare", f.square); setD("uSeed", f.seed); setD("uBeatCount", f.beatCount); setD("uWarp", f.warp); setD("uTrail", f.trail);
      if (D.u.uW) gl.uniform1fv(D.u.uW, f.w);
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

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
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
  #coverflux .cf-info{position:absolute;left:32px;bottom:26px;max-width:min(46vw,560px);pointer-events:none;
    text-shadow:0 1px 18px rgba(0,0,0,.55)}
  #coverflux .cf-title{font-size:clamp(20px,2.3vw,34px);font-weight:700;letter-spacing:-.02em;line-height:1.05;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #coverflux .cf-artist{margin-top:6px;font-size:13px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;opacity:.72;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #coverflux .cf-info.cf-swap .cf-title,#coverflux .cf-info.cf-swap .cf-artist{animation:cf-in .9s cubic-bezier(.2,.7,.2,1) both}
  #coverflux .cf-info.cf-swap .cf-artist{animation-delay:.08s}
  #coverflux.cf-noinfo .cf-info{display:none}
  @keyframes cf-in{from{opacity:0;transform:translateY(10px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
  #coverflux .cf-controls{position:absolute;right:24px;bottom:22px;display:flex;align-items:center;gap:6px;padding:6px;
    border-radius:999px;background:rgba(14,14,15,.52);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 10px 30px rgba(0,0,0,.35);-webkit-app-region:no-drag}
  #coverflux .cf-seg{display:flex;position:relative;border-radius:999px;background:rgba(255,255,255,.06);padding:2px}
  #coverflux button{all:unset;cursor:pointer;box-sizing:border-box}
  #coverflux .cf-seg button{position:relative;z-index:1;padding:6px 12px;font-size:12px;font-weight:600;border-radius:999px;color:rgba(243,239,232,.62);
    transition:color .2s ease}
  #coverflux .cf-seg button[aria-checked="true"]{color:#111}
  #coverflux .cf-seg .cf-thumb{position:absolute;top:2px;bottom:2px;border-radius:999px;background:var(--cf-accent);
    transition:left .35s cubic-bezier(.3,.8,.2,1),width .35s cubic-bezier(.3,.8,.2,1)}
  #coverflux .cf-field{display:flex;align-items:center;gap:8px;padding:0 10px;height:30px;font-size:11px;font-weight:600;letter-spacing:.06em;
    text-transform:uppercase;color:rgba(243,239,232,.55)}
  #coverflux select{all:unset;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:#f3efe8;padding-right:14px;
    background:linear-gradient(45deg,transparent 50%,currentColor 50%) right 4px center/4px 4px no-repeat,
      linear-gradient(-45deg,transparent 50%,currentColor 50%) right 0 center/4px 4px no-repeat}
  #coverflux select option{background:#1c1c1e;color:#f3efe8}
  #coverflux input[type=range]{-webkit-appearance:none;appearance:none;width:96px;height:3px;border-radius:3px;cursor:pointer;
    background:linear-gradient(90deg,var(--cf-accent) var(--v,70%),rgba(255,255,255,.18) var(--v,70%))}
  #coverflux input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#f3efe8;
    box-shadow:0 0 0 4px rgba(255,255,255,.08);transition:transform .15s ease}
  #coverflux input[type=range]:hover::-webkit-slider-thumb{transform:scale(1.2)}
  #coverflux .cf-status{display:flex;align-items:center;gap:6px;padding:0 8px;font-size:11px;color:rgba(243,239,232,.5);white-space:nowrap}
  #coverflux .cf-dot{width:6px;height:6px;border-radius:50%;background:#7a7a7a}
  #coverflux .cf-dot.cf-live{background:var(--cf-accent);box-shadow:0 0 10px var(--cf-accent);animation:cf-pulse 1.6s ease-in-out infinite}
  @keyframes cf-pulse{50%{opacity:.45}}
  #coverflux .cf-close{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:rgba(243,239,232,.75);
    transition:background .2s ease,color .2s ease,transform .2s ease}
  #coverflux .cf-close:hover{background:rgba(255,255,255,.1);color:#fff;transform:rotate(90deg)}
  #coverflux button:focus-visible,#coverflux select:focus-visible,#coverflux input:focus-visible{outline:2px solid var(--cf-accent);outline-offset:2px}
  #coverflux .cf-note{position:absolute;right:28px;bottom:74px;font-size:11px;color:rgba(243,239,232,.6);opacity:0;transition:opacity .4s ease;pointer-events:none}
  #coverflux .cf-note.cf-show{opacity:1}
  #coverflux .cf-error{position:absolute;inset:0;display:none;place-items:center;font-size:14px;color:rgba(243,239,232,.7)}
  #coverflux.cf-failed .cf-error{display:grid}
  @media (max-width:860px){#coverflux .cf-field.cf-int, #coverflux .cf-status{display:none}}
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
          ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("")}
        </select>
      </label>
      <label class="cf-field cf-int">Intensität <input class="cf-intensity" type="range" min="0" max="100" aria-label="Intensität"></label>
      <span class="cf-status" title=""><span class="cf-dot"></span><span class="cf-status-text"></span></span>
      <button class="cf-close" aria-label="Visualizer schließen" title="Schließen (Esc)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
      </button>
    </div>`;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const canvas = $("canvas");
  const elTitle = $(".cf-title"), elArtist = $(".cf-artist"), elInfo = $(".cf-info");
  const elMode = $(".cf-mode"), elInt = $(".cf-intensity"), elNote = $(".cf-note");
  const elDot = $(".cf-dot"), elStatus = $(".cf-status-text"), elStatusWrap = $(".cf-status");
  const segButtons = Array.from(root.querySelectorAll(".cf-seg button"));
  const thumb = $(".cf-thumb");

  function syncControls() {
    segButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === settings.source)));
    const active = segButtons.find((b) => b.dataset.src === settings.source);
    if (active && active.offsetWidth) { thumb.style.left = active.offsetLeft + "px"; thumb.style.width = active.offsetWidth + "px"; }
    elMode.value = settings.mode;
    elInt.value = Math.round(settings.intensity * 100);
    elInt.style.setProperty("--v", elInt.value + "%");
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
  elMode.addEventListener("change", () => { settings.mode = elMode.value; saveSettings(); state.forcePreset = true; });
  elInt.addEventListener("input", () => { settings.intensity = elInt.value / 100; elInt.style.setProperty("--v", elInt.value + "%"); saveSettings(); });
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
    energyFast: 0, energySlow: 0, beat: 0, onset: 0, bar: 0, returnPulse: 1, trans: 0,
    mix: 1, mixFrom: 0, lastSection: -1, lastBar: -1, beatCount: 0, lastBeat: -1,
    w: [1, 0, 0, 0, 0, 0], targetW: [1, 0, 0, 0, 0, 0], presetKey: "liquid", seed: 0, hueDir: 1,
    pos: 0, posAt: 0, playing: false, lastSync: 0, time: 0, forcePreset: true, restoreRate: 0, amount: 0, morph: 0, clean: 0,
  };
  let isOpen = false, raf = 0, lastNow = 0, layoutTick = 0;

  function choosePreset(sectionIdx) {
    let key = settings.mode;
    if (key === "auto" || !PRESETS[key]) {
      const base = hashStr(audio.uri || "x");
      key = AUTO_ORDER[(base + sectionIdx * 3) % AUTO_ORDER.length];
    }
    state.presetKey = key;
    state.targetW = PRESETS[key].w.slice();
    state.seed = (hashStr((audio.uri || "") + ":" + sectionIdx) % 1000) / 37;
    state.hueDir = (sectionIdx % 2 ? -1 : 1);
  }

  function syncPosition(now) {
    let p = 0;
    try { p = (S.Player.getProgress() || 0) / 1000; } catch (_) {}
    let playing = false;
    try { playing = !!S.Player.isPlaying(); } catch (_) {}
    const predicted = state.pos + (state.playing ? (now - state.posAt) / 1000 : 0);
    if (!state.lastSync || Math.abs(predicted - p) > 0.25 || playing !== state.playing) {
      state.pos = p; state.posAt = now;
    } else {
      state.pos = predicted; state.posAt = now;
    }
    state.playing = playing;
    state.lastSync = now;
  }

  function frame(now) {
    if (!isOpen) return;
    raf = requestAnimationFrame(frame);
    const dt = clamp((now - (lastNow || now)) / 1000, 0, 0.1);
    lastNow = now;
    state.time += dt;

    if (now - state.lastSync > 400) syncPosition(now);
    const pos = state.pos + (state.playing ? (now - state.posAt) / 1000 : 0);
    const a = audio.sample(pos);
    const live = state.playing;
    const I = settings.intensity;

    const loud = live ? a.loud : 0;
    state.energyFast = follow(state.energyFast, loud, 14, 3.5, dt);
    state.energySlow = follow(state.energySlow, live ? loud * 0.55 + a.sectionLoud * 0.45 : 0, 0.9, 0.55, dt);
    state.beat = live ? a.beat : state.beat * Math.exp(-dt * 6);
    state.onset = live ? a.onset : 0;
    state.bar = live ? a.bar : 0;

    if (live && a.beatIndex !== state.lastBeat) { state.lastBeat = a.beatIndex; state.beatCount = (state.beatCount + 1) % 997; }
    if (a.section !== state.lastSection) {
      // new song section: big return to the original cover, then a fresh morph character
      if (state.lastSection !== -1) state.returnPulse = 1;
      state.lastSection = a.section;
      choosePreset(a.section);
    } else if (state.forcePreset) choosePreset(a.section);
    state.forcePreset = false;
    if (live && a.barIndex !== state.lastBar) {
      state.lastBar = a.barIndex;
      // every 8 bars: a short breath back toward the original – stronger in calmer parts
      if (a.barIndex % 8 === 0 && a.barIndex > 0) state.returnPulse = Math.max(state.returnPulse, 0.5 + 0.4 * (1 - state.energySlow));
    }
    state.returnPulse *= Math.exp(-dt / 1.7);
    state.trans *= Math.exp(-dt / 1.1);
    state.mix = Math.min(1, state.mix + dt / 1.8);

    for (let i = 0; i < 6; i++) state.w[i] += (state.targetW[i] - state.w[i]) * (1 - Math.exp(-dt * 1.3));

    const calm = 1 - clamp(state.energySlow * 1.15);
    const intensityRelax = 1.45 - I * 0.9;
    const rate = (0.55 + 3.4 * Math.pow(calm, 2.3) + 7.5 * Math.pow(state.returnPulse, 1.4) + (live ? 0 : 2.2)) * intensityRelax;
    state.restoreRate = rate;
    const restore = 1 - Math.exp(-rate * dt);

    const drive = 0.06 + 0.95 * Math.pow(state.energyFast, 1.25) + 0.65 * state.beat * (0.35 + state.energyFast) + 0.45 * state.onset;
    const amount = I * 1.35 * drive * (1 - 0.85 * state.returnPulse) * (live ? 1 : 0.12) + state.trans * 0.35;
    state.amount = amount;
    const morph = clamp((state.energySlow * 1.35 - 0.15) * (1 - state.returnPulse) * (live ? 1 : 0)) * I;
    state.morph = morph;
    const cleanTarget = clamp((rate - 1.4) / 2.6) * (1 - clamp(amount * 1.6)) * (1 - clamp(state.trans * 2));
    state.clean = follow(state.clean, cleanTarget, 2.2, 3.5, dt);

    if (++layoutTick % 60 === 0) layout();

    const asp = renderer.w / renderer.h;
    renderer.render({
      time: state.time, dt, mix: state.mix, energy: state.energyFast, beat: state.beat * I, bar: state.bar, onset: state.onset * I,
      restore, amount, hue: 0.22 * state.hueDir * state.energySlow * I * (a.bright * 0.6 + 0.4),
      beatCount: state.beatCount, trans: state.trans, square: Math.min(0.8, 0.86 * asp), seed: state.seed, w: state.w,
      kale: state.w[5] * clamp(morph * 1.4), morph: Math.max(morph, 0.15 * I), segs: 6 + 2 * (state.lastSection % 3), glow: morph * 0.7, clean: state.clean,
      sharp: 0.015 + 0.02 * clamp(amount), warp: I * (0.25 + 1.1 * state.energyFast + 0.8 * state.beat) * (1 - 0.9 * state.returnPulse) * (live ? 1 : 0.2),
      trail: clamp(0.18 + 0.42 * state.energySlow + 0.3 * state.trans),
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
    if (token !== coverToken || !url || (!force && url === currentCoverUrl && renderer)) return;
    if (url === currentCoverUrl && !force) return;
    try {
      const img = await loadImage(url);
      if (token !== coverToken || !renderer) return;
      currentCoverUrl = url;
      renderer.pushImage(renderer.uploadImage(img));
      state.mix = 0;
      state.trans = Math.max(state.trans, 0.6);
      state.returnPulse = Math.max(state.returnPulse, 0.8);
      extractAccent(url);
    } catch (e) {
      console.warn("[Coverflux] cover load failed", e);
    }
  }

  async function extractAccent(url) {
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
    elDot.classList.toggle("cf-live", live);
    elStatus.textContent = live ? "Spotify-Analyse" : "Simuliert";
    elStatusWrap.title = live
      ? "Reagiert auf Spotifys Audio-Analyse (Lautheit, Beats, Takte, Abschnitte) des aktuellen Songs."
      : "Keine Audio-Analyse verfügbar – Bewegung folgt einem simulierten Takt, nicht der echten Musik.";
  }

  async function onTrack() {
    const data = S.Player.data;
    const item = data && (data.item || data.track);
    const uri = item && item.uri;
    refreshInfo();
    if (uri !== currentTrackUri) {
      currentTrackUri = uri;
      state.lastSection = -1; state.lastBar = -1; state.forcePreset = true;
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
    if (e.key === "Escape" && isOpen) { e.stopPropagation(); close(); }
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    root.classList.add("cf-open");
    root.style.bottom = Math.max(0, Math.round(window.innerHeight - playbarTop())) + "px";
    if (ensureRenderer()) {
      layout();
      renderer.needsInit = true;
      state.returnPulse = 1;
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
  window.Coverflux = { open, close, toggle: () => (isOpen ? close() : open()), state, settings, audio };
})();
