// Coverflux for the web – runs the visualizer in any modern browser, no Spotify involved:
//   · play audio files (exact offline beat analysis, cover from the file's tags),
//   · follow a shared tab / system audio or the microphone live (real-time beat tracking).
// Everything stays on the device; nothing is uploaded.
// Built from src/beat-engine.js + src/core.js + src/adapters/web.js – edit those, then run `npm run build`.

// Coverflux beat engine – analyses decoded audio into the same shape as Spotify's audio analysis
// (beats, bars, sections, segments, track). Pure JS, no dependencies: runs in a Web Worker inside Spotify,
// on the main thread as fallback, and in Node for tests. Everything lives inside one factory function so the
// extension can ship it to a worker as source text.
//
// Pipeline: log-band spectrogram -> spectral-flux onset envelope -> tempo (autocorrelation + comb + prior)
// -> beat tracking (dynamic programming, Ellis 2007) -> downbeats/meter (bass onsets + harmony changes)
// -> segments (onset peaks with loudness, timbre, chroma) -> sections (novelty on bar features).
function coverfluxBeatFactory() {
  "use strict";
  const SR = 22050, N = 1024, HOP = 220, FPS = SR / HOP, NB = 24;

  // ---- radix-2 FFT (in place) ----
  const rev = new Uint32Array(N), cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2), win = new Float32Array(N);
  for (let i = 0, bits = Math.log2(N); i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = -Math.sin((2 * Math.PI * i) / N); }
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  function fft(re, im) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) for (let k = 0; k < half; k++) {
        const c = cosT[k * step], s = sinT[k * step], a = i + k, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }

  // ---- band layout: NB log-spaced bands 40 Hz..10 kHz, chroma bins 65 Hz..2 kHz ----
  const binHz = SR / N, bandOf = new Int16Array(N / 2).fill(-1), chromaOf = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    if (f >= 40 && f < 10000) bandOf[k] = Math.min(NB - 1, Math.floor((Math.log(f / 40) / Math.log(10000 / 40)) * NB));
    if (f >= 65 && f < 2000) chromaOf[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
  }
  const LOW_BANDS = 5, MID_END = 17; // ~40..150 Hz kick/bass · ~150 Hz..2 kHz snare/body

  function spectrogram(x) {
    const T = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
    const bands = new Float32Array(T * NB), chroma = new Float32Array(T * 12), rmsDb = new Float32Array(T);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let t = 0; t < T; t++) {
      const o = t * HOP;
      let e = 0;
      for (let i = 0; i < N; i++) { const v = x[o + i] || 0; e += v * v; re[i] = v * win[i]; im[i] = 0; }
      rmsDb[t] = 10 * Math.log10(e / N + 1e-10);
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (bandOf[k] >= 0) bands[t * NB + bandOf[k]] += m;
        if (chromaOf[k] >= 0) chroma[t * 12 + chromaOf[k]] += m * m;
      }
      for (let b = 0; b < NB; b++) bands[t * NB + b] = Math.log1p(100 * bands[t * NB + b]);
    }
    return { T, bands, chroma, rmsDb };
  }

  // spectral flux with a max filter across neighbouring bands (SuperFlux-style), split into full + low band
  function onsets(S) {
    const { T, bands } = S, env = new Float32Array(T), low = new Float32Array(T), mid = new Float32Array(T), lag = 2;
    for (let t = lag; t < T; t++) {
      let s = 0, l = 0, m = 0;
      for (let b = 0; b < NB; b++) {
        const p = Math.max(bands[(t - lag) * NB + Math.max(0, b - 1)], bands[(t - lag) * NB + b], bands[(t - lag) * NB + Math.min(NB - 1, b + 1)]);
        const d = bands[t * NB + b] - p;
        if (d > 0) { s += d; if (b < LOW_BANDS) l += d; else if (b < MID_END) m += d; }
      }
      env[t] = s; low[t] = l; mid[t] = m;
    }
    return { env: normalize(env), low: normalize(low), mid: normalize(mid) };
  }
  // subtract a 1 s moving average, keep the positive part, unit std
  function normalize(a) {
    const T = a.length, w = Math.round(FPS * 0.5), out = new Float32Array(T);
    let acc = 0;
    const cs = new Float64Array(T + 1);
    for (let i = 0; i < T; i++) { acc += a[i]; cs[i + 1] = acc; }
    let sq = 0, n = 0;
    for (let i = 0; i < T; i++) {
      const lo = Math.max(0, i - w), hi = Math.min(T, i + w + 1);
      const v = Math.max(0, a[i] - (cs[hi] - cs[lo]) / (hi - lo));
      out[i] = v; sq += v * v; n++;
    }
    const sd = Math.sqrt(sq / Math.max(1, n)) || 1;
    for (let i = 0; i < T; i++) out[i] /= sd;
    return out;
  }

  // ---- tempo: autocorrelation, comb over multiples, log-normal prior around 120 BPM ----
  // center (optional, BPM at tracking level): live tracking keeps to the tempo family it already follows
  function tempo(env, center) {
    const T = env.length, minL = Math.floor(FPS * 60 / 200), maxL = Math.ceil(FPS * 60 / 50);
    const ac = new Float32Array(maxL * 4 + 2);
    for (let L = 1; L < ac.length; L++) { let s = 0; for (let t = L; t < T; t++) s += env[t] * env[t - L]; ac[L] = s / (T - L); }
    const at = (L) => { const i = Math.floor(L), f = L - i; return i + 1 < ac.length ? ac[i] * (1 - f) + ac[i + 1] * f : 0; };
    let best = minL, bestS = -1;
    const score = new Float32Array(maxL + 1), priors = new Float32Array(maxL + 1);
    const priorAt = (L) => priors[L] || 1;
    for (let L = minL; L <= maxL; L++) {
      // the whole metrical family: subdivisions (L/2, L/4) and groupings (2L, 4L) must line up too
      const comb = at(L) + 0.5 * (at(2 * L) + at(L / 2)) + 0.25 * (at(4 * L) + (L / 4 >= 2 ? at(L / 4) : 0));
      const bpm = (60 * FPS) / L;
      let prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 130) / 0.7, 2));
      if (center) { const g = (c) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / c) / 0.08, 2)); prior *= 0.35 + 2 * Math.max(g(center), g(center * 2), g(center / 2)); }
      score[L] = comb * prior; priors[L] = prior;
      if (score[L] > bestS) { bestS = score[L]; best = L; }
    }
    // parabolic refinement
    let P = best;
    if (best > minL && best < maxL) { const a = score[best - 1], b = score[best], c = score[best + 1], d = a - 2 * b + c; if (d < 0) P = best + (0.5 * (a - c)) / d; }
    tempo.lastComb = bestS > 0 ? score[best] / Math.max(1e-6, priorAt(best)) : 0;
    return P; // period in frames
  }

  // ---- beats: dynamic programming (Ellis 2007) ----
  function track(env, P, tight = 100) {
    const T = env.length, score = new Float32Array(T), back = new Int32Array(T).fill(-1);
    const lo = Math.round(P / 2), hi = Math.round(2 * P);
    for (let t = 0; t < T; t++) {
      let best = 0, bi = -1;
      for (let d = lo; d <= hi && t - d >= 0; d++) {
        const r = Math.log(d / P), s = score[t - d] - tight * r * r;
        if (s > best || bi < 0) { best = s; bi = t - d; }
      }
      score[t] = env[t] + (bi >= 0 ? best : 0);
      back[t] = best > 0 ? bi : -1;
    }
    // end on the best-scoring frame of the last period
    let t = T - 1, bs = -Infinity;
    for (let i = Math.max(0, T - Math.round(P)); i < T; i++) if (score[i] > bs) { bs = score[i]; t = i; }
    const beats = [];
    while (t >= 0) { beats.push(t); t = back[t]; }
    beats.reverse();
    // drop beats in silent lead-in / tail
    const sm = smooth(env, Math.round(P));
    const thr = 0.25 * mean(sm);
    let a = 0, b = beats.length - 1;
    while (a < b && sm[beats[a]] < thr) a++;
    while (b > a && sm[beats[b]] < thr) b--;
    return beats.slice(a, b + 1);
  }
  function smooth(a, w) { const out = new Float32Array(a.length); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= w) s -= a[i - w]; out[i] = s / Math.min(i + 1, w); } return out; }
  function mean(a) { let s = 0; for (const v of a) s += v; return s / Math.max(1, a.length); }

  // snap each beat to the strongest onset within ±40 ms (DP works on whole frames; this removes jitter)
  function refine(beats, env) {
    const r = Math.round(0.04 * FPS);
    return beats.map((b) => { let bi = b, bv = env[b] * 1.15; for (let d = -r; d <= r; d++) { const t = b + d; if (t > 0 && t < env.length && env[t] > bv) { bv = env[t]; bi = t; } } return bi; });
  }

  // Intros/outros without a clear pulse: the tracker guesses on weak onsets there. Replace those beats by
  // continuing the grid of the first/last confident stretch at its own period – a steady pulse that lines up
  // with where the groove actually starts.
  function extrapolateWeakEdges(beats, env) {
    const n = beats.length;
    if (n < 24) return beats;
    const str = beats.map((t) => { let m = 0; for (let d = -3; d <= 3; d++) m = Math.max(m, env[t + d] || 0); return m; });
    const w = 8, avg = str.map((_, i) => { let s = 0, c = 0; for (let j = i; j < Math.min(n, i + w); j++) { s += str[j]; c++; } return s / c; });
    const sorted = [...avg].sort((a, b) => a - b), med = sorted[sorted.length >> 1], ok = (i) => avg[i] >= 0.6 * med;
    const per = (i0, i1) => { const d = []; for (let i = i0 + 1; i <= i1; i++) d.push(beats[i] - beats[i - 1]); d.sort((a, b) => a - b); return d[d.length >> 1]; };
    let a = 0; while (a < n - w && !ok(a)) a++;
    let b = n - 1; while (b > w && !ok(Math.max(0, b - w + 1))) b--;
    if (b - a < 2 * w) return beats;
    const out = beats.slice(a, b + 1);
    const pa = per(a, Math.min(b, a + 16)), pb = per(Math.max(a, b - 16), b);
    for (let t = out[0] - pa; t > 0; t -= pa) out.unshift(Math.round(t));
    const end = env.length - 1;
    for (let t = out[out.length - 1] + pb; t < end; t += pb) out.push(Math.round(t));
    return refine(out, env).map((t, i, arr) => (i > 0 && t <= arr[i - 1] ? arr[i - 1] + 1 : t));
  }

  // ---- per-beat features ----
  function beatFeatures(S, O, beats) {
    const n = beats.length, chroma = [], lowOn = new Float32Array(n), on = new Float32Array(n), bandsAvg = [];
    for (let i = 0; i < n; i++) {
      const t0 = beats[i], t1 = i + 1 < n ? beats[i + 1] : Math.min(S.T, t0 + 50);
      const c = new Float32Array(12), bb = new Float32Array(NB);
      for (let t = t0; t < t1; t++) { for (let k = 0; k < 12; k++) c[k] += S.chroma[t * 12 + k]; for (let b = 0; b < NB; b++) bb[b] += S.bands[t * NB + b]; }
      let m = 0; for (let k = 0; k < 12; k++) m = Math.max(m, c[k]); for (let k = 0; k < 12; k++) c[k] /= m || 1;
      for (let b = 0; b < NB; b++) bb[b] /= Math.max(1, t1 - t0);
      chroma.push(c); bandsAvg.push(bb);
      const w = 3; let lo = 0, al = 0;
      for (let t = Math.max(0, t0 - w); t <= Math.min(S.T - 1, t0 + w); t++) { lo = Math.max(lo, O.low[t]); al = Math.max(al, O.env[t]); }
      lowOn[i] = lo; on[i] = al;
    }
    return { chroma, lowOn, on, bandsAvg };
  }
  const cosSim = (a, b) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return ab / (Math.sqrt(aa * bb) || 1); };

  // ---- meter + downbeat phase: harmony changes and bass hits land on the one ----
  function downbeats(F) {
    const n = F.on.length;
    const hchange = new Float32Array(n);
    for (let i = 1; i < n; i++) hchange[i] = 1 - cosSim(F.chroma[i - 1], F.chroma[i]);
    const z = (a) => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); s = Math.sqrt(s / Math.max(1, a.length)) || 1; return Array.from(a, (v) => (v - m) / s); };
    const H = z(hchange), L = z(F.lowOn), A = z(F.on);
    const cue = H.map((h, i) => 1.0 * h + 0.6 * L[i] + 0.25 * A[i]);
    let best = { m: 4, p: 0, s: -Infinity }, byMeter = {};
    for (const m of [3, 4]) {
      let mBest = -Infinity, mP = 0;
      for (let p = 0; p < m; p++) {
        let on = 0, cOn = 0, off = 0, cOff = 0;
        for (let i = 0; i < n; i++) { if ((i - p) % m === 0) { on += cue[i]; cOn++; } else { off += cue[i]; cOff++; } }
        const s = on / Math.max(1, cOn) - off / Math.max(1, cOff);
        if (s > mBest) { mBest = s; mP = p; }
      }
      byMeter[m] = mBest;
      if (m === 4 ? mBest > best.s : mBest > best.s * 1.25) best = { m, p: mP, s: mBest };
    }
    return { meter: best.m, phase: best.p, strength: best.s, byMeter };
  }

  // ---- segments: onset peaks, loudness curve, 12 band "timbre", chroma ----
  function segments(S, O) {
    const { T, rmsDb } = S, env = O.env, peaks = [0];
    const minGap = Math.round(0.06 * FPS);
    for (let t = 2; t < T - 2; t++) {
      if (env[t] > 0.6 && env[t] >= env[t - 1] && env[t] >= env[t + 1] && env[t] >= env[t - 2] && env[t] >= env[t + 2] && t - peaks[peaks.length - 1] >= minGap) peaks.push(t);
    }
    const segs = [];
    for (let i = 0; i < peaks.length; i++) {
      const t0 = peaks[i], t1 = i + 1 < peaks.length ? peaks[i + 1] : T;
      if (t1 <= t0) continue;
      let mx = -100, mt = t0;
      const timbre = new Array(12).fill(0), pitches = new Array(12).fill(0);
      for (let t = t0; t < t1; t++) {
        if (rmsDb[t] > mx) { mx = rmsDb[t]; mt = t; }
        for (let b = 0; b < NB; b++) timbre[Math.floor((b * 12) / NB)] += S.bands[t * NB + b];
        for (let k = 0; k < 12; k++) pitches[k] += S.chroma[t * 12 + k];
      }
      const len = t1 - t0, pm = Math.max(...pitches) || 1;
      segs.push({
        start: r4(t0 / FPS), duration: r4(len / FPS), confidence: Math.min(1, env[t0] / 3),
        loudness_start: r2(rmsDb[Math.max(0, t0 - 1)]), loudness_max: r2(mx), loudness_max_time: r4((mt - t0) / FPS),
        timbre: timbre.map((v) => r2((v / len) * 10)), pitches: pitches.map((v) => r2(v / pm)),
      });
    }
    return segs;
  }

  // ---- sections: checkerboard novelty on bar-level features, boundaries snapped to downbeats ----
  function sections(bars, F, beatIdxOfBar, S, beatsSec) {
    const nb = bars.length;
    if (nb < 8) return [{ start: 0, duration: S.T / FPS, loudness: r2(mean(S.rmsDb)), confidence: 0.5 }];
    const feat = bars.map((_, j) => {
      const i0 = beatIdxOfBar[j], i1 = j + 1 < nb ? beatIdxOfBar[j + 1] : F.chroma.length;
      const f = new Float32Array(12 + NB);
      for (let i = i0; i < i1; i++) { for (let k = 0; k < 12; k++) f[k] += F.chroma[i][k]; for (let b = 0; b < NB; b++) f[12 + b] += F.bandsAvg[i][b] * 0.3; }
      return f;
    });
    const K = 4, nov = new Float32Array(nb);
    for (let j = K; j < nb - K; j++) {
      let s = 0;
      for (let a = 1; a <= K; a++) for (let b = 1; b <= K; b++) s += cosSim(feat[j - a], feat[j - b]) + cosSim(feat[j + a - 1], feat[j + b - 1]) - 2 * cosSim(feat[j - a], feat[j + b - 1]);
      nov[j] = s;
    }
    const thr = mean(nov) + 0.5 * Math.sqrt(mean(nov.map((v) => v * v)) - mean(nov) ** 2);
    const cuts = [0];
    for (let j = K; j < nb - K; j++) if (nov[j] > thr && nov[j] >= nov[j - 1] && nov[j] >= nov[j + 1] && j - cuts[cuts.length - 1] >= 8) cuts.push(j);
    const out = [];
    for (let c = 0; c < cuts.length; c++) {
      const start = c === 0 ? 0 : bars[cuts[c]].start;
      const end = c + 1 < cuts.length ? bars[cuts[c + 1]].start : S.T / FPS;
      const f0 = Math.round(start * FPS), f1 = Math.round(end * FPS);
      let l = 0; for (let t = f0; t < f1; t++) l += S.rmsDb[t];
      out.push({ start: r4(start), duration: r4(end - start), loudness: r2(l / Math.max(1, f1 - f0)), confidence: 0.6 });
    }
    return out;
  }

  const r4 = (v) => Math.round(v * 1e4) / 1e4, r2 = (v) => Math.round(v * 100) / 100;

  // ---- align two analyses of the same recording (a downloaded file vs Spotify's stream) ----
  // Uses what both analyses share: segment onsets (attack-weighted), chroma and loudness.
  // Returns { ok, shift, score, margin } – add `shift` seconds to times of `a` to land on `b`.
  function timeline(an, R, n, sigma) {
    const on = new Float32Array(n), loud = new Float32Array(n).fill(-60), chroma = [];
    for (let k = 0; k < 12; k++) chroma.push(new Float32Array(n));
    const w = Math.max(1, Math.ceil(2.5 * sigma));
    for (const g of an.segments || []) {
      const c = g.start * R, i0 = Math.round(c), att = Math.max(0, g.loudness_max - g.loudness_start);
      for (let d = -w; d <= w; d++) { const i = i0 + d; if (i >= 0 && i < n) on[i] += att * Math.exp(-0.5 * ((i - c) / sigma) ** 2); }
      const a = Math.max(0, Math.floor(c)), b = Math.min(n, Math.ceil((g.start + g.duration) * R));
      for (let i = a; i < b; i++) {
        if (g.loudness_max > loud[i]) loud[i] = g.loudness_max;
        if (g.pitches) for (let k = 0; k < 12; k++) chroma[k][i] = g.pitches[k];
      }
    }
    const z = (x) => { let m = 0; for (const v of x) m += v; m /= x.length; let s = 0; for (const v of x) s += (v - m) * (v - m); s = Math.sqrt(s / x.length) || 1; for (let i = 0; i < x.length; i++) x[i] = (x[i] - m) / s; return x; };
    return { on: z(on), loud: z(loud), chroma: chroma.map(z), hasChroma: (an.segments || []).some((g) => g.pitches) };
  }
  function xcorr(x, y, L) {
    let s = 0, c = 0;
    const i0 = Math.max(0, -L), i1 = Math.min(x.length, y.length - L);
    for (let i = i0; i < i1; i++) { s += x[i] * y[i + L]; c++; }
    return c > 50 ? s / c : 0;
  }
  function align(a, b, maxShift = 20) {
    const end = (an) => Math.max((an.track && an.track.duration) || 0, ...(an.segments || []).slice(-3).map((g) => g.start + g.duration));
    const dur = Math.max(end(a), end(b)) + 1;
    // coarse: 20 Hz over ±maxShift
    const R = 20, n = Math.ceil(dur * R), A = timeline(a, R, n, 1), B = timeline(b, R, n, 1);
    const chromaW = A.hasChroma && B.hasChroma ? 0.8 / 12 : 0, M = Math.round(maxShift * R);
    const sc = new Float32Array(2 * M + 1);
    let bi = 0;
    for (let L = -M; L <= M; L++) {
      let s = xcorr(A.on, B.on, L) + 0.3 * xcorr(A.loud, B.loud, L);
      if (chromaW) for (let k = 0; k < 12; k++) s += chromaW * xcorr(A.chroma[k], B.chroma[k], L);
      sc[L + M] = s;
      if (s > sc[bi]) bi = L + M;
    }
    let second = -Infinity;
    for (let i = 0; i < sc.length; i++) if (Math.abs(i - bi) > 0.6 * R && sc[i] > second) second = sc[i];
    const coarse = (bi - M) / R, score = sc[bi], margin = score - second;
    // fine: onset trains at 200 Hz within ±75 ms of the coarse lag
    const R2 = 200, n2 = Math.ceil(dur * R2), A2 = timeline(a, R2, n2, 1.5), B2 = timeline(b, R2, n2, 1.5);
    const c0 = Math.round(coarse * R2);
    let fb = c0, fs = -Infinity;
    for (let L = c0 - 15; L <= c0 + 15; L++) { const s = xcorr(A2.on, B2.on, L); if (s > fs) { fs = s; fb = L; } }
    return { ok: score > 0.25 && margin > 0.06, shift: r4(fb / R2), score: r2(score), margin: r2(margin) };
  }

  // x: mono Float32Array at 22050 Hz (resample before calling)
  function analyze(x) {
    const S = spectrogram(x), O = onsets(S);
    const P = tempo(O.env);
    let Pf = P, bf = refine(track(O.env, P), O.env), musicMeter = 0;
    // felt pulse max 140 BPM: find the bar lines on the fast grid first (more anchors, more reliable), then keep
    // beats 1 and 3 of every bar (duple) or only the one (triple) – the felt beat follows the bar, not a parity count
    if ((60 * FPS) / P > 140 && bf.length > 16) {
      const Dfast = downbeats(beatFeatures(S, O, bf));
      const step = Dfast.meter === 3 ? 3 : 2;
      musicMeter = Dfast.meter;
      bf = bf.filter((_, i) => (((i - Dfast.phase) % step) + step) % step === 0);
      Pf = P * step;
    }
    bf = extrapolateWeakEdges(bf, O.env);
    // sub-frame timing: parabola through the onset peak around each beat frame
    const e = O.env;
    const beatsSec = bf.map((t) => {
      const a = e[t - 1] || 0, b = e[t] || 0, c = e[t + 1] || 0, d = a - 2 * b + c;
      const off = d < 0 && b >= a && b >= c ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      return ((t + off) * HOP + N / 2) / SR;
    });
    const F = beatFeatures(S, O, bf);
    const D = downbeats(F);
    const beats = beatsSec.map((t, i) => ({ start: r4(t), duration: r4((beatsSec[i + 1] ?? t + (Pf / FPS)) - t), confidence: r2(Math.min(1, F.on[i] / 3)) }));
    const bars = [], beatIdxOfBar = [];
    for (let i = D.phase; i < beats.length; i += D.meter) {
      const end = beats[Math.min(beats.length - 1, i + D.meter)].start;
      bars.push({ start: beats[i].start, duration: r4(Math.max(0.1, end - beats[i].start)), confidence: 0.6 });
      beatIdxOfBar.push(i);
    }
    const dur = x.length / SR;
    return {
      source: "coverflux", version: 1,
      track: { duration: r4(dur), tempo: r2((60 * FPS) / Pf), tempo_tracked: r2((60 * FPS) / P), time_signature: musicMeter || D.meter, felt_per_bar: D.meter, time_signature_confidence: r2(Math.min(1, Math.max(0, D.strength))), loudness: r2(mean(S.rmsDb)) },
      beats, bars, segments: segments(S, O), sections: sections(bars, F, beatIdxOfBar, S, beatsSec),
    };
  }

  // ---- live (causal) tracking for microphone / system audio ----
  // push(mono22k) as audio arrives; update() every ~0.5 s re-estimates tempo/phase on the last 12 s and returns an
  // analysis in Spotify's shape on the stream clock (seconds since the first sample). Past beats are committed and
  // never move, upcoming beats are predicted – so beat indices stay stable and the visuals never jump.
  function createLive() {
    const HIST = Math.round(FPS * 16);
    let pending = new Float32Array(0), frameIdx = 0;
    const envR = [], lowR = [], midR = [], rmsR = [], chromaR = [];
    let prev1 = null, prev2 = null;
    const re = new Float32Array(N), im = new Float32Array(N), bands = new Float32Array(NB), chroma = new Float32Array(12);
    const committed = [];                    // beat times (s) that have passed
    let grid = null;                         // { anchor: beat time (s), period: s }
    let candidate = null, candHits = 0, lastConf = 0;
    const segs = [];

    function frame(x, o) {
      let e = 0;
      for (let i = 0; i < N; i++) { const v = x[o + i]; e += v * v; re[i] = v * win[i]; im[i] = 0; }
      fft(re, im);
      bands.fill(0); chroma.fill(0);
      for (let k = 1; k < N / 2; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (bandOf[k] >= 0) bands[bandOf[k]] += m;
        if (chromaOf[k] >= 0) chroma[chromaOf[k]] += m * m;
      }
      const cur = new Float32Array(NB);
      for (let b = 0; b < NB; b++) cur[b] = Math.log1p(100 * bands[b]);
      let s = 0, l = 0, md = 0;
      if (prev2) for (let b = 0; b < NB; b++) {
        const p = Math.max(prev2[Math.max(0, b - 1)], prev2[b], prev2[Math.min(NB - 1, b + 1)]), d = cur[b] - p;
        if (d > 0) { s += d; if (b < LOW_BANDS) l += d; else if (b < MID_END) md += d; }
      }
      prev2 = prev1; prev1 = cur;
      envR.push(s); lowR.push(l); midR.push(md); rmsR.push(10 * Math.log10(e / N + 1e-10)); chromaR.push(Array.from(chroma));
      if (envR.length > HIST) { envR.shift(); lowR.shift(); midR.shift(); rmsR.shift(); chromaR.shift(); }
      frameIdx++;
    }

    function push(samples) {
      const all = new Float32Array(pending.length + samples.length);
      all.set(pending); all.set(samples, pending.length);
      let o = 0;
      while (o + N <= all.length) { frame(all, o); o += HOP; }
      pending = all.slice(o);
    }

    const now = () => (Math.max(0, frameIdx - 1) * HOP + N / 2) / SR; // stream time of the newest frame centre
    const wrap = (x, p) => ((x % p) + 1.5 * p) % p - 0.5 * p;

    function estimate(center) {
      if (envR.length < FPS * 4) return null;
      const len = envR.length;
      const env = normalize(Float32Array.from(envR)), lo = normalize(Float32Array.from(lowR)), mi = normalize(Float32Array.from(midR));
      let P = tempo(env, center || 0);
      const comb = tempo.lastComb;
      let beats = refine(track(env, P), env);
      if (beats.length < 6) return null;
      let parity = 0;
      if ((60 * FPS) / P > 140) {
        // felt pulse <= 140: find the bar lines on the fast grid (harmony changes + bass), keep beats 1 and 3
        const chroma = new Float32Array(len * 12);
        for (let i = 0; i < len; i++) for (let k = 0; k < 12; k++) chroma[i * 12 + k] = chromaR[i][k];
        const Sw = { T: len, chroma, bands: new Float32Array(len * NB) };
        const D = downbeats(beatFeatures(Sw, { env, low: lo, mid: mi }, beats));
        // 12 s are few bars: only trust a triple meter when it clearly wins
        const triple = D.meter === 3 && D.byMeter[3] > 1.5 * Math.max(0.05, D.byMeter[4]);
        const step = triple ? 3 : 2, phase = triple ? D.phase : (D.meter === 4 ? D.phase : 0) % 2;
        beats = beats.filter((_, i) => (((i - phase) % step) + step) % step === 0);
        P *= step; parity = D.strength;
      }
      const recent = beats.slice(-10), d = [];
      for (let i = 1; i < recent.length; i++) d.push(recent[i] - recent[i - 1]);
      d.sort((x, y) => x - y);
      const per = d.length ? d[d.length >> 1] : P;
      // least-squares anchor on the last beats (the newest beat alone sits where the tracker has least context)
      const K = recent.length - 1;
      let acc = 0; for (let k = 0; k <= K; k++) acc += recent[k] + (K - k) * per;
      const anchorFrame = acc / (K + 1);
      // confidence: onset strength on the beats vs. half-way between them
      let on = 0, off = 0;
      for (const t of recent) { on += env[t] || 0; off += env[Math.round(t + per / 2)] || 0; }
      return { anchor: now() - (len - 1 - anchorFrame) / FPS, period: per / FPS, conf: on / Math.max(1e-3, on + off), parity, comb };
    }

    function update() {
      const tNow = now();
      // two estimates: one that keeps to the current tempo family (smooth tracking) and a free one (escape hatch
      // out of a wrong lock, e.g. on a beatless intro or after a real tempo change)
      const free = estimate(0);
      const est = grid && free ? estimate(60 / grid.period) : free;
      if (est && est.conf > 0.55) {
        lastConf = est.conf;
        if (!grid) grid = { anchor: est.anchor, period: est.period, trust: est.conf };
        else {
          const ratio = est.period / grid.period;
          const pred = grid.anchor + Math.round((est.anchor - grid.anchor) / grid.period) * grid.period;
          const perr = wrap(est.anchor - pred, grid.period);
          if (Math.abs(ratio - 1) < 0.05 && Math.abs(perr) < 0.25 * grid.period) {
            // phase-locked loop (PI): ease period and phase towards the estimate; a phase error that keeps the same
            // sign means the period is off, so it also nudges the period (no steady-state lag)
            grid.period += 0.2 * (est.period - grid.period);
            grid.period *= 1 + 0.08 * perr / grid.period;
            grid.anchor = pred + 0.3 * perr;
            grid.trust += 0.1 * (est.conf - grid.trust);
          } else grid.trust += 0.1 * (0.4 - grid.trust); // estimates disagree with the grid: trust it less
        }
        // switch only when the free estimate is a clearly better explanation, consistently for ~5 s (12 s for 4:3 / 3:2)
        const sameFamily = free && grid && [0.5, 1, 2].some((m) => Math.abs(free.period / (grid.period * m) - 1) < 0.05) &&
          Math.abs(wrap(free.anchor - grid.anchor, grid.period)) < 0.25 * grid.period;
        if (free && !sameFamily && free.conf > 0.55 && free.comb > 1.12 * est.comb) {
          if (candidate && Math.abs(free.period / candidate.period - 1) < 0.05 && Math.abs(wrap(free.anchor - candidate.anchor, free.period)) < 0.15 * free.period) {
            // 4:3 and 3:2 are the classic tempo confusions in short windows – those need much more evidence
            const r = free.period / grid.period, odd = [4 / 3, 3 / 4, 3 / 2, 2 / 3, 8 / 3, 3 / 8].some((q) => Math.abs(r / q - 1) < 0.04);
            // a grid built on weak evidence (e.g. a beatless intro) gives way quickly, a confirmed groove does not
            const need = grid.trust < 0.66 ? 3 : odd ? 24 : 10;
            if (++candHits >= need) { grid = { anchor: free.anchor, period: free.period, trust: free.conf }; candidate = null; candHits = 0; }
            else candidate = { anchor: free.anchor, period: free.period };
          } else { candidate = { anchor: free.anchor, period: free.period }; candHits = 1; }
        } else if (sameFamily) { candidate = null; candHits = 0; }
      }
      if (!grid) return null;
      // commit beats up to now, predict 30 s ahead
      let next = committed.length ? committed[committed.length - 1] + grid.period : grid.anchor - Math.floor((grid.anchor - Math.max(0, tNow - 12)) / grid.period) * grid.period;
      if (committed.length) {
        // land the continuation on the current grid without moving committed beats
        const g = grid.anchor + Math.round((next - grid.anchor) / grid.period) * grid.period;
        if (Math.abs(g - next) < 0.35 * grid.period) next = next + 0.5 * (g - next);
      }
      while (next <= tNow) { committed.push(next); next += grid.period; }
      const beatsT = committed.slice();
      for (let t = next; t < tNow + 30; t += grid.period) beatsT.push(t);
      // loudness segments from recent onsets (energy / accents for the visuals)
      const t0 = tNow - envR.length / FPS, lastSeg = segs.length ? segs[segs.length - 1].start : -1;
      const envN = normalize(Float32Array.from(envR));
      for (let i = 2; i < envN.length - 2; i++) {
        const t = t0 + (i * HOP + N / 2) / SR;
        if (t <= lastSeg + 0.06 || envN[i] < 0.8 || envN[i] < envN[i - 1] || envN[i] < envN[i + 1]) continue;
        let mx = -100; for (let j = i; j < Math.min(envN.length, i + 12); j++) mx = Math.max(mx, rmsR[j]);
        const c = chromaR[i], cm = Math.max(...c) || 1;
        segs.push({ start: r4(t), duration: 0.12, loudness_start: r2(rmsR[Math.max(0, i - 2)]), loudness_max: r2(mx), loudness_max_time: 0.02, timbre: new Array(12).fill(0), pitches: c.map((v) => r2(v / cm)) });
      }
      while (segs.length > 1500) segs.shift();
      for (let i = 0; i + 1 < segs.length; i++) segs[i].duration = r4(Math.max(0.02, segs[i + 1].start - segs[i].start));
      const beats = beatsT.map((t, i) => ({ start: r4(t), duration: r4((beatsT[i + 1] ?? t + grid.period) - t), confidence: 0.6 }));
      const bars = [];
      for (let i = 0; i < beats.length; i += 4) bars.push({ start: beats[i].start, duration: r4(4 * grid.period), confidence: 0.5 });
      return {
        source: "coverflux", live: true, version: 1,
        track: { duration: r4(tNow + 3600), tempo: r2(60 / grid.period), time_signature: 4, felt_per_bar: 4, confidence: r2(lastConf) },
        beats, bars, segments: segs.length ? segs.slice() : [{ start: 0, duration: tNow + 3600, loudness_start: -60, loudness_max: -60, loudness_max_time: 0 }],
        sections: [{ start: 0, duration: r4(tNow + 3600), loudness: r2(mean(rmsR)), confidence: 0.5 }],
      };
    }

    return { push, update, now, get tempo() { return grid ? 60 / grid.period : 0; }, get confidence() { return lastConf; } };
  }

  // linear resampler + downmix, so callers can hand in any AudioBuffer-like channel data
  function toMono22k(channels, rate) {
    const len = channels[0].length, mono = new Float32Array(len);
    for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;
    if (rate === SR) return mono;
    const outLen = Math.floor((len * SR) / rate), out = new Float32Array(outLen), k = rate / SR;
    for (let i = 0; i < outLen; i++) { const p = i * k, j = Math.floor(p), f = p - j; out[i] = mono[j] * (1 - f) + (mono[j + 1] || 0) * f; }
    return out;
  }

  return { analyze, align, createLive, toMono22k, SR };
}

// Coverflux core – the platform-neutral visualizer. A host adapter (src/adapters/*) supplies playback position,
// track metadata, cover art, an optional ready-made analysis, storage, layout and the button that opens it.
//
// host = {
//   name, storage: { get(key), set(key, value) },
//   position(): { pos /* s */, playing },              track(): { uri, title, artist, duration, local } | null,
//   on(event, cb)  – "track" | "playpause" | "analysis" (cb(uri, analysis) for live analyses),
//   getAnalysis?(uri): Promise<analysis>,               trackCover?(): Promise<url|image>, contextCover?(): Promise<url|image>,
//   accent?(): Promise<css color>,                      bottomInset?(): px kept free at the bottom (Spotify's playbar),
//   mountToggle?(toggle): { active },                    playbarGlow?: bool, closable?: bool (default true),
//   library?: bool (default true), keyTarget?: EventTarget for shortcuts (default document)
// }
function createCoverflux(host) {
  "use strict";
  const closable = host.closable !== false;
  // UI language: the host decides, else the browser (German or English)
  const LANG = host.lang || (((typeof navigator !== "undefined" && navigator.language) || "en").toLowerCase().startsWith("de") ? "de" : "en");
  const t = (de, en) => (LANG === "de" ? de : en);

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */
  const SETTINGS_KEY = "coverflux:settings";
  const TEMPO_KEY = "coverflux:tempo"; // per-track tempo-feel overrides
  const DEFAULTS = { source: "track", intensity: 0.75, mode: "auto", autoOff: [], showInfo: true, syncMs: 0, frame: "full" };
  const loadJSON = (k, def) => { try { return Object.assign({}, def, JSON.parse(host.storage.get(k) || "{}")); } catch (_) { return Object.assign({}, def); } };
  const settings = loadJSON(SETTINGS_KEY, DEFAULTS);
  const tempoOverrides = loadJSON(TEMPO_KEY, {});
  const saveSettings = () => { try { host.storage.set(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} };
  const saveTempo = () => {
    const keys = Object.keys(tempoOverrides);
    if (keys.length > 300) delete tempoOverrides[keys[0]];
    try { host.storage.set(TEMPO_KEY, JSON.stringify(tempoOverrides)); } catch (_) {}
  };

  // One morph character at a time. `fill` = how far the sharp, mirrored cover spreads beyond its square while morphing.
  const GROUPS = { Fluss: t("Fluss", "Flow"), Symmetrie: t("Symmetrie", "Symmetry"), Fraktal: t("Fraktal", "Fractal"), Raum: t("Raum", "Space") };
  function PRESET_KEYS() { return Object.keys(PRESETS); }
  // group: how the list is sectioned · fill: how far the sharp mirrored cover spreads while morphing
  const PRESETS = {
    liquid:   { label: "Liquid",        group: "Fluss",    mode: 0,  fill: 3.0,  desc: t("Marmorstrom, fließt eine Periode weiter", "Marbled stream, flows one period on") },
    ripple:   { label: "Ripple",        group: "Fluss",    mode: 2,  fill: 1.6,  desc: t("Wasser zieht quer durchs Bild", "Water sweeps across the picture") },
    vortex:   { label: "Vortex",        group: "Fluss",    mode: 1,  fill: 3.0,  desc: t("Ringe drehen volle Runden", "Rings turn full circles") },
    prism:    { label: "Prism",         group: "Fluss",    mode: 4,  fill: 1.8,  desc: t("Geriffeltes Glas, Regenbogenkanten", "Fluted glass, rainbow edges") },
    tunnel:   { label: "Tunnel",        group: "Fluss",    mode: 8,  fill: 0.15, desc: t("Droste-Tauchgang ins Cover", "Droste dive into the cover") },
    kaleido:  { label: "Kaleido",       group: "Symmetrie", mode: 5, fill: 3.0,  desc: t("Faltet sich von innen nach außen", "Folds from the centre outwards") },
    mandala:  { label: "Mandala",       group: "Symmetrie", mode: 6, fill: 3.0,  desc: t("Kaleido auf einer Spirale", "Kaleido on a spiral") },
    hexa:     { label: "Hexa",          group: "Symmetrie", mode: 9, fill: 3.0,  desc: t("Waben mit sechsfacher Spiegelung (p6m)", "Honeycomb with sixfold mirrors (p6m)") },
    rosette:  { label: "Rosette",       group: "Symmetrie", mode: 14, fill: 6.0, desc: t("Blütenblätter aus z ↦ zⁿ", "Petals from z ↦ zⁿ") },
    moire:    { label: "Moiré",         group: "Symmetrie", mode: 18, fill: 3.0, desc: t("Zwei Kaleido-Gitter, die sich überlagern", "Two kaleido lattices interfering") },
    quasi:    { label: t("Quasikristall", "Quasicrystal"), group: "Symmetrie", mode: 10, fill: 3.0, desc: t("Fünf- oder siebenzählig, wiederholt sich nie", "Five- or sevenfold, never repeats") },
    fractal:  { label: "Fractal",       group: "Fraktal",  mode: 7,  fill: 3.0,  desc: t("Faltet sich Stufe für Stufe", "Folds in stage by stage") },
    sierpinski: { label: "Sierpinski",  group: "Fraktal",  mode: 17, fill: 40.0,  desc: t("Dreiecke voller Dreiecke", "Triangles full of triangles") },
    inversion: { label: "Inversion",    group: "Fraktal",  mode: 13, fill: 3.0,  desc: t("Kreisinversion, Perlenketten", "Circle inversion, strings of pearls") },
    phyllo:   { label: "Phyllotaxis",   group: "Fraktal",  mode: 15, fill: 3.0,  desc: t("Sonnenblumen-Spirale im goldenen Winkel", "Sunflower spiral at the golden angle") },
    escher:   { label: t("Escher-Spirale", "Escher spiral"), group: "Raum",    mode: 12, fill: 3.0,  desc: t("Dreht sich endlos in sich selbst", "Turns endlessly into itself") },
    hyper:    { label: t("Hyperbolisch", "Hyperbolic"),  group: "Raum",     mode: 11, fill: 3.0,  desc: t("Poincaré-Scheibe, Kacheln strömen", "Poincaré disk, tiles streaming") },
    triangle: { label: t("Dreiecksgruppe", "Triangle group"), group: "Raum",    mode: 20, fill: 3.0,  desc: t("Dreiecks-Kaleidoskop, Winkel wandern", "Triangle kaleidoscope, wandering angles") },
    sphere:   { label: t("Sphäre", "Sphere"),        group: "Raum",     mode: 16, fill: 3.0,  desc: t("Ikosaeder-Kugel, rollt einmal", "Icosahedral sphere, rolls once") },
    moebius:  { label: t("Möbius-Strom", "Möbius flow"),  group: "Raum",     mode: 19, fill: 3.0,  desc: t("Fließt von einem Pol in den anderen", "Flows from one pole into the other") },
  };
  // Auto picks from these depending on the energy of the current song section (among the ones switched on).
  const CALM_POOL = ["liquid", "ripple", "prism", "kaleido", "mandala", "hexa", "rosette", "moire", "phyllo", "escher", "sphere"];
  const LOUD_POOL = ["vortex", "tunnel", "kaleido", "mandala", "fractal", "quasi", "sierpinski", "inversion", "hyper", "triangle", "moebius", "escher", "hexa"];
  const CYCLE_BARS = 16; // one full loop away from the cover and back onto it

  // settings.mode: "auto" or one preset key. settings.autoOff: presets Auto must skip (new presets start switched on).
  if (Array.isArray(settings.modes)) { // v2.6 stored the enabled list
    if (settings.modes.length === 1) settings.mode = settings.modes[0];
    else settings.autoOff = PRESET_KEYS().filter((k) => !settings.modes.includes(k) && ["liquid", "vortex", "ripple", "prism", "kaleido", "mandala", "fractal", "tunnel"].includes(k));
    delete settings.modes;
  }
  if (settings.mode !== "auto" && !PRESET_KEYS().includes(settings.mode)) settings.mode = "auto";
  settings.autoOff = (Array.isArray(settings.autoOff) ? settings.autoOff : []).filter((k) => PRESET_KEYS().includes(k));
  if (settings.autoOff.length >= PRESET_KEYS().length) settings.autoOff = [];
  const autoOn = () => PRESET_KEYS().filter((k) => !settings.autoOff.includes(k));

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

  /* ------------------------------------------------------------------ */
  /* Library – own beat analysis of the user's audio files               */
  /* Files are decoded in Spotify, analysed by the beat engine (Web Worker, */
  /* main-thread fallback) and kept in IndexedDB. Tracks are matched by     */
  /* title/artist/duration; streamed versions are aligned by loudness.      */
  /* ------------------------------------------------------------------ */
  const Library = (() => {
    const AUDIO_EXT = /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|webm)$/i;
    let dbp = null, index = [], worker = null, workerFailed = false, mainEngine = null, busy = false;
    const available = typeof coverfluxBeatFactory === "function" && typeof indexedDB !== "undefined";

    function db() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open("coverflux", 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains("tracks")) d.createObjectStore("tracks", { keyPath: "id" });
          if (!d.objectStoreNames.contains("analyses")) d.createObjectStore("analyses", { keyPath: "id" });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return db().then((d) => new Promise((res, rej) => {
        const t = d.transaction(store, mode), req = fn(t.objectStore(store));
        t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
        t.onerror = () => rej(t.error);
      }));
    }
    async function init() {
      if (!available) return [];
      try { index = (await tx("tracks", "readonly", (st) => st.getAll())) || []; } catch (_) { index = []; }
      return index;
    }

    // "Señorita (feat. X) - 2019 Remaster" -> "senorita"
    function norm(v) {
      return String(v || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
        .replace(/\s*[([](feat|ft|with|prod)\.?[^)\]]*[)\]]/g, "")
        .replace(/\s+-\s+(\d{4}\s+)?(remaster|remastered|radio edit|single version|live|mono|stereo)\b.*$/, "")
        .replace(/[^a-z0-9]+/g, " ").trim();
    }
    const artistMatch = (a, b) => {
      if (!a || !b) return true;
      if (a.includes(b) || b.includes(a)) return true;
      const wa = a.split(" ").filter((w) => w.length > 2);
      return wa.some((w) => b.split(" ").includes(w));
    };

    // minimal ID3v2.3/2.4 reader: title + artist
    function id3(buf) {
      const u = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 20));
      if (u[0] !== 0x49 || u[1] !== 0x44 || u[2] !== 0x33) return {};
      const v = u[3], size = (u[6] << 21) | (u[7] << 14) | (u[8] << 7) | u[9], out = {};
      let p = 10;
      if (u[5] & 0x40) p += v === 4 ? (u[10] << 21) | (u[11] << 14) | (u[12] << 7) | u[13] : ((u[10] << 24) | (u[11] << 16) | (u[12] << 8) | u[13]) + 4;
      while (p + 10 < Math.min(u.length, size + 10)) {
        const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const len = v === 4 ? (u[p + 4] << 21) | (u[p + 5] << 14) | (u[p + 6] << 7) | u[p + 7] : (u[p + 4] << 24) | (u[p + 5] << 16) | (u[p + 6] << 8) | u[p + 7];
        if (len <= 0 || p + 10 + len > u.length) break;
        if (id === "TIT2" || id === "TPE1") {
          const enc = u[p + 10], body = u.subarray(p + 11, p + 10 + len);
          const label = enc === 0 ? "iso-8859-1" : enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : "utf-8";
          try { out[id === "TIT2" ? "title" : "artist"] = new TextDecoder(label).decode(body).replace(/\0+$/g, "").split("\0")[0].trim(); } catch (_) {}
        }
        p += 10 + len;
      }
      return out;
    }

    // "SpotiDown.App - Nie mehr - CRO" / "CRO - Nie mehr" -> both orders as title/artist pairs
    function pairsFor(name, tags) {
      const pairs = [];
      if (tags.title) pairs.push([norm(tags.title), norm(tags.artist)]);
      const parts = name.replace(AUDIO_EXT, "").split(/\s+[-–]\s+/).map((x) => x.trim())
        .filter((x) => x && !/^(spotidown|y2mate|savefrom|ytmp3|mp3juice)|\.(app|com|net|io|to|cc)$/i.test(x));
      if (parts.length >= 2) { pairs.push([norm(parts[0]), norm(parts[1])], [norm(parts[1]), norm(parts[0])]); }
      else if (parts.length === 1 && !tags.title) pairs.push([norm(parts[0]), ""]);
      const seen = new Set();
      return pairs.filter((x) => x[0] && !seen.has(x.join("|")) && seen.add(x.join("|")));
    }

    function find(meta) {
      if (!meta || !index.length) return null;
      const t = norm(meta.title), a = norm(meta.artist), tol = meta.local ? 3 : 20;
      let best = null, bd = Infinity;
      for (const e of index) {
        if (!e.pairs.some(([pt, pa]) => pt === t && artistMatch(pa, a))) continue;
        const d = meta.duration ? Math.abs(e.duration - meta.duration) : 0;
        if (d <= tol && d < bd) { bd = d; best = e; }
      }
      return best;
    }
    const get = (id) => tx("analyses", "readonly", (st) => st.get(id)).then((r) => r && r.analysis);

    function engine() { return mainEngine || (mainEngine = coverfluxBeatFactory()); }
    function runEngine(mono) {
      if (!workerFailed) {
        try {
          if (!worker) {
            const src = coverfluxBeatFactory.toString() + "\nconst E = coverfluxBeatFactory();\nonmessage = (e) => { try { postMessage({ ok: true, a: E.analyze(e.data) }); } catch (err) { postMessage({ ok: false, err: String(err) }); } };";
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
          }
          return new Promise((res, rej) => {
            worker.onmessage = (e) => (e.data.ok ? res(e.data.a) : rej(new Error(e.data.err)));
            worker.onerror = (e) => { if (e.preventDefault) e.preventDefault(); workerFailed = true; worker = null; try { res(engine().analyze(mono)); } catch (err) { rej(err); } };
            worker.postMessage(mono); // copied, so the main-thread fallback still has the samples
          });
        } catch (_) { workerFailed = true; }
      }
      return new Promise((res, rej) => setTimeout(() => { try { res(engine().analyze(mono)); } catch (err) { rej(err); } }, 0));
    }

    async function decode(buf) {
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new AC(1, 1, engine().SR);
      const ab = await ctx.decodeAudioData(buf);
      const ch = []; for (let i = 0; i < ab.numberOfChannels; i++) ch.push(ab.getChannelData(i));
      return { mono: engine().toMono22k(ch, ab.sampleRate), duration: ab.duration };
    }

    // analyses a list of File objects one after another; onProgress(done, total, name, added)
    async function addFiles(files, onProgress) {
      if (!available || busy) return 0;
      busy = true;
      const list = Array.from(files).filter((f) => AUDIO_EXT.test(f.name));
      let done = 0, added = 0;
      try {
        for (const f of list) {
          const id = f.name + "|" + f.size + "|" + f.lastModified;
          onProgress && onProgress(done, list.length, f.name, added);
          if (!index.some((e) => e.id === id)) {
            try {
              const buf = await f.arrayBuffer();
              const tags = /\.mp3$/i.test(f.name) ? id3(buf) : {};
              const { mono, duration } = await decode(buf);
              const analysis = await runEngine(mono);
              const entry = { id, file: f.name, title: tags.title || "", artist: tags.artist || "", pairs: pairsFor(f.name, tags), duration, added: Date.now() };
              await tx("analyses", "readwrite", (st) => st.put({ id, analysis }));
              await tx("tracks", "readwrite", (st) => st.put(entry));
              index.push(entry); added++;
            } catch (e) { console.warn("[Coverflux] Analyse fehlgeschlagen:", f.name, e); }
          }
          done++;
        }
      } finally { busy = false; }
      onProgress && onProgress(done, list.length, "", added);
      return added;
    }
    async function clear() { await tx("tracks", "readwrite", (st) => st.clear()); await tx("analyses", "readwrite", (st) => st.clear()); index = []; }

    // aligning a file analysis with Spotify's analysis of the streamed version: onsets + chroma + loudness (beat engine)
    const align = (own, spot) => engine().align(own, spot);
    function shiftAnalysis(a, d) {
      const mv = (list) => (list || []).map((x) => Object.assign({}, x, { start: x.start + d }));
      return Object.assign({}, a, { beats: mv(a.beats).filter((b) => b.start >= 0), bars: mv(a.bars).filter((b) => b.start >= 0), sections: mv(a.sections), segments: mv(a.segments).filter((g) => g.start + g.duration > 0), tatums: mv(a.tatums) });
    }

    return { available, init, find, get, addFiles, clear, align, shiftAnalysis, norm, get size() { return index.length; }, get busy() { return busy; } };
  })();

  class AudioModel {
    constructor() { this.cache = new Map(); this.a = null; this.uri = null; this.synthetic = true; }

    // Source priority: own analysis of the user's file (aligned to the streamed version) > Spotify > simulated.
    async load(uri, durationSec, meta) {
      this.uri = uri;
      if (!uri) { this.set(buildSynthetic("none", durationSec)); return; }
      if (this.cache.has(uri)) { this.set(this.cache.get(uri)); return; }
      this.set(buildSynthetic(uri, durationSec)); // immediate, replaced when real data arrives
      const local = !!(meta && meta.local) || /^spotify:local:/.test(uri);
      let data = null;
      if (!local) {
        try {
          if (typeof host.getAnalysis === "function") data = await withTimeout(Promise.resolve(host.getAnalysis(uri)), 9000);
        } catch (_) { data = null; }
      }
      if (this.uri !== uri) return;
      const ok = data && Array.isArray(data.segments) && data.segments.length > 8 && Array.isArray(data.beats) && data.beats.length > 8;
      let analysis = ok ? data : null;
      const hit = Library.find(meta);
      if (hit) {
        let own = null;
        try { own = await Library.get(hit.id); } catch (_) {}
        if (this.uri !== uri) return;
        if (own) {
          if (!ok) analysis = Object.assign({}, own, { alignNote: local ? t("Datei", "file") : t("Datei, ohne Spotify-Abgleich", "file, not matched to Spotify") });
          else {
            const al = Library.align(own, data);
            if (al.ok) analysis = Object.assign({}, Library.shiftAnalysis(own, al.shift), { alignNote: t("Datei, abgeglichen ", "file, aligned ") + (al.shift >= 0 ? "+" : "") + al.shift.toFixed(2) + " s" });
            else console.info("[Coverflux] Datei-Analyse passt nicht zur Spotify-Version (Score " + al.score + ", Abstand " + al.margin + ") – nehme Spotify");
          }
        }
      }
      if (!analysis) analysis = buildSynthetic(uri, durationSec);
      if (local && !hit) analysis.localMissing = true;
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
      this.own = a.source === "coverflux";
      this.ownNote = a.alignNote || "";
      this.localMissing = !!a.localMissing;
      this.grid = this.synthetic ? null : this.own ? { own: true, triple: this.spotifyBpb === 3 || this.spotifyBpb === 6, offRatio: 0, tripleScore: 0 } : this.checkGrid(segs);
      if (this.own && a.track && a.track.felt_per_bar) this.bpb = clamp(a.track.felt_per_bar, 2, 7); // engine already chose the felt level
      this.autoMult = this.synthetic || this.own ? 1 : this.detectFeel();
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
      if (this.synthetic) return t("Simulierter Takt", "Simulated beat") + " · " + Math.round(this.tempo / m) + " BPM";
      if (this.a && this.a.live) return t("Live-Analyse", "Live analysis") + " · " + Math.round(this.tempo) + " BPM" + (this.a.track && this.a.track.confidence ? " · " + t("Sicherheit ", "confidence ") + Math.round(this.a.track.confidence * 100) + " %" : "");
      if (this.own) return t("Eigene Analyse", "Own analysis") + (this.ownNote ? " (" + this.ownNote + ")" : "") + " · " + Math.round(this.tempo) + " BPM " + ((this.a.track && this.a.track.time_signature) || this.bpb) + "/4 → " + t("gefühlt ", "felt ") + Math.round(this.tempo / m) + " BPM";
      return "Spotify " + Math.round(this.spotifyTempo) + " BPM " + this.spotifyBpb + "/4 · " + t("Raster ", "grid ") + Math.round(this.tempo) + " BPM" +
        (g ? (g.triple ? t(" · Dreiertakt", " · triple meter") : t(" · Zweiertakt", " · duple meter")) + (this.shift ? t(" · um ½ Schlag korrigiert", " · moved by ½ beat") : "") : "") +
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

  /* ---- geometry toolkit for the mathematical modes ---- */
  vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
  vec2 cdiv(vec2 a, vec2 b){ float d = dot(b,b) + 1e-9; return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y)/d; }
  vec2 clog(vec2 z){ return vec2(log(max(length(z), 1e-6)), atan(z.y, z.x)); }
  vec2 cexp(vec2 w){ return exp(w.x)*vec2(cos(w.y), sin(w.y)); }
  // every new mode morphs like kaleido: each point blends from itself to its image, spreading from the centre out
  float radialBlend(vec2 p){
    float ph = prog(clamp(length(p)/gDiag, 0.0, 1.0));
    float en = envOf(ph);
    gE = en*uDepth;
    float b = en*clamp(0.45 + uDepth*0.9, 0.0, 1.0);
    gF = b;
    return b;
  }
  // fold z (unit disk) into the fundamental triangle of the {P,Q} tiling: wedge mirrors + inversion in the third side
  vec2 hypFold(vec2 z, float P, float Q, out float n){
    float a = PI/P, cq = cos(PI/Q);
    float rr = sin(a)/sqrt(max(cq*cq - sin(a)*sin(a), 1e-4));
    vec2 C = vec2(sqrt(1.0 + rr*rr), 0.0);
    n = 0.0;
    for (int i=0; i<32; i++){
      float an = atan(z.y, z.x), r = length(z);
      an -= floor(an/(2.0*a))*2.0*a;
      if (an > a) { an = 2.0*a - an; n += 1.0; }
      z = r*vec2(cos(an), sin(an));
      vec2 d = z - C; float dd = dot(d, d);
      if (dd < rr*rr) { z = C + d*(rr*rr/dd); n += 1.0; } else break;
    }
    return z;
  }
  // hexa: p6m wallpaper – twelve mirrors per honeycomb cell, drifting two cells forward and a sixth turn
  vec2 mHexa(vec2 p){
    float b = radialBlend(p);
    float s = 0.3 + 0.08*fract(uSeed*0.31);
    vec2 q = rot(uDir*PI/3.0*uPhi)*p/s + uDir*vec2(2.0, 0.0)*uPhi;
    const vec2 H = vec2(1.0, 1.7320508);
    vec2 a = mod(q, H) - H*0.5, c = mod(q - H*0.5, H) - H*0.5;
    vec2 l = dot(a, a) < dot(c, c) ? a : c;
    float r = length(l), an = atan(l.y, l.x);
    an = mod(an, PI/3.0); an = abs(an - PI/6.0);
    return mix(p, r*vec2(cos(an), sin(an))*s*1.35 + 0.1*vec2(cos(uSeed), sin(uSeed)), b);
  }
  // quasicrystal: n plane waves at n angles – five- or sevenfold order that never repeats
  vec2 mQuasi(vec2 p){
    float b = radialBlend(p);
    float n = uSegs > 9.0 ? 7.0 : 5.0;
    float f = 15.0 + 5.0*fract(uSeed*0.7), t = uDir*TAU*2.0*uPhi + uFlow*0.12;
    vec2 v = vec2(0.0);
    for (int i=0; i<7; i++){ if (float(i) >= n) break;
      float an = PI*float(i)/n; vec2 d = vec2(cos(an), sin(an));
      v += d*sin(dot(p, d)*f + t);
    }
    return mix(p, kfold(rot(uDir*PI/n*uPhi)*p, 2.0*n, uSeed*0.2)*0.9 + v*(0.22/n), b);
  }
  // hyperbolic: {7,3} tiling of the Poincaré disk; a Möbius translation streams the tiles across the disk
  vec2 mHyper(vec2 p){
    float b = radialBlend(p);
    vec2 z = p/0.5; float l = dot(z, z); if (l > 1.0) z /= l;
    vec2 t = 0.55*uPhi*uDir*vec2(cos(uSeed), sin(uSeed));
    z = cdiv(z + t, vec2(1.0, 0.0) + cmul(vec2(t.x, -t.y), z));
    float n; vec2 f = hypFold(rot(uDir*0.5*uPhi)*z, 7.0, 3.0, n);
    vec2 k = (f - vec2(0.12, 0.05))*3.0;
    if (mod(n, 2.0) > 0.5) k.y = -k.y;
    return mix(p, k, b);
  }
  // escher spiral: the conformal Droste twist – zooming and turning at once, one spiral turn per cycle
  vec2 mEscher(vec2 p){
    float b = radialBlend(p);
    float L = log(2.6 + 0.8*fract(uSeed*0.43));
    vec2 w = cmul(clog(p + 1e-5), cdiv(vec2(0.0, TAU), vec2(L, TAU)));
    w.x = mod(w.x - uDir*L*2.0*uPhi, L) - 0.85*L;
    return mix(p, cexp(w)*0.5, b);
  }
  // inversion: Apollonian circle inversions – pearl chains of the cover
  vec2 mInversion(vec2 p){
    float b = radialBlend(p);
    vec2 z = rot(uDir*PI*0.5*uPhi)*p*2.4 + 0.2*vec2(cos(uSeed), sin(uSeed));
    float sc = 1.12 + 0.1*sin(TAU*uPhi + uSeed);
    for (int i=0; i<6; i++){ z = -1.0 + 2.0*fract(0.5*z + 0.5); z *= sc/max(dot(z, z), 0.02); }
    return mix(p, z*0.22, b);
  }
  // rosette: z -> z^n, the cover opens into n petals that keep turning
  vec2 mRosette(vec2 p){
    float b = radialBlend(p);
    float n = floor(uSegs*0.5), R0 = 0.42;
    float r = length(p), a = atan(p.y, p.x);
    float rr = R0*pow(r/R0, 1.6)*(1.0 + 0.18*sin(n*a + uFlow*0.6));
    return mix(p, rr*vec2(cos(n*a + uDir*TAU*uPhi), sin(n*a + uDir*TAU*uPhi)), b);
  }
  // phyllotaxis: cells on the golden-angle spiral, every cell a small cover; the spiral winds a quarter turn
  vec2 mPhyllo(vec2 p){
    float b = radialBlend(p);
    float c = 0.085 + 0.02*fract(uSeed*0.5);
    vec2 q = rot(-uDir*TAU*0.25*uPhi)*p;
    float k0 = floor(dot(q, q)/(c*c));
    float bd = 1e9; vec2 bc = vec2(0.0);
    const float FIB[12] = float[](0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0, 34.0, 55.0, 89.0, 144.0);
    for (int i=0; i<12; i++) for (int sg=-1; sg<=1; sg+=2){
      float k = k0 + float(sg)*FIB[i];
      if (k < 0.0) continue;
      float an = k*2.39996323; vec2 ctr = c*sqrt(k)*vec2(cos(an), sin(an));
      float d = distance(q, ctr);
      if (d < bd) { bd = d; bc = ctr; }
    }
    gRim = smoothstep(0.62, 0.72, bd/c)*b*0.6;
    return mix(p, (q - bc)/c*0.42*uSquare + bc*0.4, b);
  }
  // sphere: icosahedral mirror sphere – rolls one full turn
  vec2 mSphere(vec2 p){
    float b = radialBlend(p);
    vec2 d = p/0.46; float l = dot(d, d); if (l > 1.0) d /= l;
    vec3 s = vec3(d, sqrt(max(0.0, 1.0 - dot(d, d))));
    s.xz = rot(uDir*TAU*uPhi + uSeed)*s.xz; s.yz = rot(0.5 + 0.3*sin(uSeed))*s.yz;
    const float PHI = 1.618034;
    vec3 n = normalize(vec3(-PHI, PHI - 1.0, 1.0));
    for (int i=0; i<5; i++){ s = abs(s); s -= 2.0*min(0.0, dot(s, n))*n; }
    gShade = mix(1.0, 0.55 + 0.6*sqrt(max(0.0, 1.0 - min(l, 1.0))), b);
    return mix(p, (s.xy - vec2(0.25, 0.25))*1.3, b);
  }
  // sierpinski: folds into triangles of triangles stage by stage, and out again in the same order
  vec2 mSierpinski(vec2 p){
    float r = length(p);
    float ph = prog(clamp(r/gDiag, 0.0, 1.0)), en = envOf(ph);
    gE = en*uDepth;
    float amt = clamp(0.5 + uDepth*0.8, 0.0, 1.0);
    float inP = clamp(ph/0.42, 0.0, 1.0), outP = clamp((ph - 0.58)/0.42, 0.0, 1.0);
    float spin = uDir*TAU/3.0*uPhi;
    vec2 w = rot(spin)*p;
    const vec2 V1 = vec2(0.0, 0.5), V2 = vec2(-0.433, -0.25), V3 = vec2(0.433, -0.25);
    for (int i=0; i<4; i++){ float fi = float(i);
      float wi = smoothstep(0.0, 1.0, clamp(inP*4.5 - fi, 0.0, 1.0))*(1.0 - smoothstep(0.0, 1.0, clamp(outP*4.5 - fi, 0.0, 1.0)))*amt;
      vec2 c = V1; float d = distance(w, V1);
      if (distance(w, V2) < d) { c = V2; d = distance(w, V2); }
      if (distance(w, V3) < d) c = V3;
      w = mix(w, 2.0*w - c, wi);
    }
    gF = max(gE, amt*en);
    return rot(-spin)*w;
  }
  // moiré: two kaleido lattices, a hair apart in angle and scale – huge slow interference rosettes
  vec2 mMoire(vec2 p){
    float b = radialBlend(p);
    float th = uDir*TAU/uSegs*uPhi;
    vec2 k1 = kfold(rot(th)*p, uSegs, uSeed*0.3), k2 = kfold(rot(-0.97*th + 0.04)*p*1.045, uSegs, uSeed*0.3);
    return mix(p, 0.5*(k1 + k2), b);
  }
  // möbius stream: a loxodromic flow out of one pole into the other, one period per cycle
  vec2 mMoebius(vec2 p){
    float b = radialBlend(p);
    vec2 A = 0.3*vec2(cos(uSeed), sin(uSeed)), B = -A;
    vec2 w = clog(cdiv(p - A, p - B));
    float L = 1.5;
    w.x = mod(w.x + uDir*L*2.0*uPhi, L) - 0.5*L;
    w.y += 0.55*w.x;
    vec2 z = cexp(w);
    return mix(p, cdiv(cmul(B, z) - A, z - vec2(1.0, 0.0)), b);
  }
  // triangle group: (P,4) kaleidoscope whose corner angle wanders – flatter and more hyperbolic and back
  vec2 mTriangle(vec2 p){
    float b = radialBlend(p);
    float P = 5.0 + 2.5*(0.5 - 0.5*cos(TAU*uPhi));
    vec2 z = p/0.5; float l = dot(z, z); if (l > 1.0) z /= l;
    float n; vec2 f = hypFold(rot(uDir*TAU*uPhi/P)*z, P, 4.0, n);
    vec2 k = (f - vec2(0.14, 0.06))*2.8;
    if (mod(n, 2.0) > 0.5) k.y = -k.y;
    return mix(p, k, b);
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
    else if (uMode == 9) w = mHexa(p);
    else if (uMode == 10) w = mQuasi(p);
    else if (uMode == 11) w = mHyper(p);
    else if (uMode == 12) w = mEscher(p);
    else if (uMode == 13) w = mInversion(p);
    else if (uMode == 14) w = mRosette(p);
    else if (uMode == 15) w = mPhyllo(p);
    else if (uMode == 16) w = mSphere(p);
    else if (uMode == 17) w = mSierpinski(p);
    else if (uMode == 18) w = mMoire(p);
    else if (uMode == 19) w = mMoebius(p);
    else if (uMode == 20) w = mTriangle(p);
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
  // Some sources (e.g. Spotify's local-file images) refuse CORS mode but are still usable by WebGL without it.
  // Hosts may also hand over a ready image/canvas/bitmap instead of a URL.
  function loadImage(url) {
    if (url && typeof url === "object") return Promise.resolve(url);
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
  #coverflux .cf-panel[data-panel="modes"]{width:min(400px,calc(100% - 48px))}
  #coverflux .cf-list{max-height:min(56vh,520px);overflow-y:auto;margin:0 -6px;padding:0 6px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
  #coverflux .cf-group{display:flex;justify-content:space-between;align-items:baseline;margin:14px 8px 4px;font-size:10px;font-weight:700;letter-spacing:.09em;
    text-transform:uppercase;color:rgba(243,239,232,.42)}
  #coverflux .cf-group small{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:none}
  #coverflux .cf-mrow{display:flex;align-items:center;gap:11px;padding:8px 8px;border-radius:11px;cursor:pointer;outline:none;transition:background .15s ease}
  #coverflux .cf-mrow:hover,#coverflux .cf-mrow:focus-visible{background:rgba(255,255,255,.06)}
  #coverflux .cf-mrow[aria-checked="true"]{background:color-mix(in srgb,var(--cf-accent) 13%,transparent)}
  #coverflux .cf-radio{flex:none;width:14px;height:14px;border-radius:50%;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.3);transition:box-shadow .2s ease}
  #coverflux .cf-mrow[aria-checked="true"] .cf-radio{box-shadow:inset 0 0 0 4px var(--cf-accent)}
  #coverflux .cf-mt{flex:1;min-width:0}
  #coverflux .cf-mt b{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:650;color:var(--cf-text)}
  #coverflux .cf-mt span{display:block;margin-top:1px;font-size:11px;color:var(--cf-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #coverflux .cf-auto{margin-bottom:2px}
  #coverflux .cf-auto-links{display:flex;gap:2px}
  #coverflux .cf-check{flex:none;width:18px;height:18px;border-radius:6px;display:grid;place-items:center;color:#111;
    box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.25);transition:background .15s ease,box-shadow .15s ease}
  #coverflux .cf-check svg{opacity:0;transform:scale(.6);transition:opacity .15s ease,transform .2s var(--cf-ease)}
  #coverflux .cf-check[aria-checked="true"]{background:var(--cf-accent);box-shadow:none}
  #coverflux .cf-check[aria-checked="true"] svg{opacity:1;transform:none}
  #coverflux .cf-list.cf-solo .cf-check{opacity:.45}
  #coverflux .cf-mrow.cf-running .cf-mt b::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--cf-accent);
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
  #coverflux .cf-lib{margin-top:12px;padding:12px 4px 0;border-top:1px solid var(--cf-line)}
  #coverflux .cf-lib-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
  #coverflux .cf-lib-h b{font-size:12px;font-weight:650}
  #coverflux .cf-lib-h small{font-size:11px;color:var(--cf-mute);font-variant-numeric:tabular-nums}
  #coverflux .cf-lib-t{margin:4px 0 10px;font-size:11px;line-height:1.45;color:var(--cf-mute)}
  #coverflux .cf-lib-b{display:flex;align-items:center;gap:6px}
  #coverflux .cf-lib-b .cf-link{margin-left:auto}
  #coverflux .cf-btn{padding:7px 12px;border-radius:9px;font-size:12px;font-weight:650;background:rgba(255,255,255,.07);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);transition:background .2s ease}
  #coverflux .cf-btn:hover{background:rgba(255,255,255,.12)}
  #coverflux .cf-btn[disabled]{opacity:.45;pointer-events:none}
  #coverflux .cf-lib-p{margin-top:10px}
  #coverflux .cf-lib-p i{display:block;height:3px;border-radius:3px;background:linear-gradient(90deg,var(--cf-accent) var(--p,0%),rgba(255,255,255,.12) var(--p,0%))}
  #coverflux .cf-lib-p small{display:block;margin-top:6px;font-size:11px;color:var(--cf-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
  #coverflux.cf-noclose .cf-close,#coverflux.cf-nosource .cf-seg,#coverflux.cf-nosource .cf-seg + .cf-sep,#coverflux.cf-nolib .cf-lib{display:none}
  @media (max-width:900px){#coverflux .cf-chip small{display:none}#coverflux .cf-info{max-width:30vw}}
  @media (prefers-reduced-motion:reduce){#coverflux,#coverflux .cf-chrome,#coverflux .cf-panel{transition:none}
    #coverflux .cf-mrow.cf-running .cf-mt b::after{animation:none}}
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "coverflux";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Coverflux Visualizer");
  root.innerHTML = `
    <canvas aria-hidden="true"></canvas>
    <div class="cf-drag"></div>
    <div class="cf-error">${t("WebGL2 ist hier nicht verfügbar – Visualizer kann nicht starten.", "WebGL2 is not available here – the visualizer can't start.")}</div>
    <div class="cf-info cf-chrome"><div class="cf-title"></div><div class="cf-artist"></div></div>
    <div class="cf-note cf-chrome"></div>
    <div class="cf-panel cf-chrome" data-panel="modes" role="dialog" aria-label="${t("Modi", "Modes")}">
      <div class="cf-ph"><b>${t("Modus", "Mode")}</b><small class="cf-modes-hint"></small></div>
      <div class="cf-list" role="radiogroup" aria-label="${t("Modus", "Mode")}">
        <div class="cf-mrow cf-auto" role="radio" tabindex="0" data-k="auto"><span class="cf-radio"></span><span class="cf-mt"><b>Auto</b><span class="cf-auto-d"></span></span>
          <span class="cf-auto-links"><button class="cf-link cf-all">${t("Alle", "All")}</button><button class="cf-link cf-none">${t("Keine", "None")}</button></span></div>
        ${["Fluss", "Symmetrie", "Fraktal", "Raum"].map((g) => `<div class="cf-group">${GROUPS[g]}<small>${t("in Auto", "in Auto")}</small></div>` + PRESET_KEYS().filter((k) => PRESETS[k].group === g).map((k) => `<div class="cf-mrow" role="radio" tabindex="0" data-k="${k}"><span class="cf-radio"></span><span class="cf-mt"><b>${PRESETS[k].label}</b><span>${PRESETS[k].desc}</span></span><button class="cf-check" role="checkbox" data-k="${k}" aria-label="${PRESETS[k].label} ${t("in Auto verwenden", "in Auto")}"><svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.2l2 2L8 3"/></svg></button></div>`).join("")).join("")}
      </div>
      <label class="cf-row">${t("Intensität", "Intensity")} <input class="cf-intensity" type="range" min="0" max="100" aria-label="${t("Intensität", "Intensity")}"><span class="cf-val cf-intv"></span></label>
    </div>
    <div class="cf-panel cf-chrome" data-panel="tempo" role="dialog" aria-label="Tempo">
      <div class="cf-ph"><b>Tempo</b></div>
      <p class="cf-detect"></p>
      <div class="cf-ratio" role="radiogroup" aria-label="${t("Tempo-Gefühl", "Tempo feel")}">
        <button role="radio" data-r="auto">Auto</button><button role="radio" data-r="2" title="${t("halbes Tempo", "half time")}">½</button><button role="radio" data-r="1">1×</button><button role="radio" data-r="0.5" title="${t("doppeltes Tempo", "double time")}">2×</button><button role="radio" data-r="3" title="${t("ein Puls pro Dreiertakt", "one pulse per triple bar")}">⅓</button>
      </div>
      <button class="cf-tap" aria-label="${t("Tempo tappen", "Tap the tempo")}">Tap<small>${t("im Takt klicken oder T drücken · mind. 4×", "click or press T on the beat · 4× or more")}</small></button>
      <div class="cf-lib">
        <div class="cf-lib-h"><b>${t("Eigene Beat-Analyse", "Own beat analysis")}</b><small class="cf-lib-n"></small></div>
        <p class="cf-lib-t">${t("Analysiert deine Musikdateien direkt hier, ohne Upload. Genauer als Spotifys Analyse und auch für lokale Dateien.", "Analyses your music files right here, nothing is uploaded. More precise than Spotify's analysis and works for local files too.")}</p>
        <div class="cf-lib-b"><button class="cf-btn cf-lib-dir">${t("Ordner wählen", "Choose folder")}</button><button class="cf-btn cf-lib-files">${t("Dateien", "Files")}</button><button class="cf-link cf-lib-clear">${t("Leeren", "Clear")}</button></div>
        <div class="cf-lib-p" hidden><i></i><small></small></div>
        <input class="cf-in-dir" type="file" multiple webkitdirectory hidden>
        <input class="cf-in-files" type="file" multiple accept="audio/*,.mp3,.flac,.wav,.ogg,.opus,.m4a" hidden>
      </div>
      <label class="cf-row" title="${t("Verschiebt die Visuals gegenüber dem Ton. Plus = früher. Tasten [ und ]", "Shifts the visuals against the sound. Plus = earlier. Keys [ and ]")}">Sync <input class="cf-syncr" type="range" min="-250" max="250" step="10" aria-label="${t("Sync-Versatz", "Sync offset")}"><span class="cf-val cf-syncv"></span></label>
    </div>
    <div class="cf-controls cf-chrome">
      <div class="cf-seg" role="radiogroup" aria-label="${t("Bildquelle", "Image source")}">
        <span class="cf-thumb"></span>
        <button role="radio" data-src="track">Song</button>
        <button role="radio" data-src="context">Playlist</button>
      </div>
      <span class="cf-sep"></span>
      <button class="cf-chip cf-modes" data-open="modes" aria-haspopup="dialog" aria-expanded="false"><small class="cf-modes-k">Auto</small><span class="cf-modes-v"></span></button>
      <button class="cf-chip cf-bpm" data-open="tempo" aria-haspopup="dialog" aria-expanded="false"><span class="cf-dot"></span><span class="cf-bpmv">– BPM</span><small class="cf-bpmm"></small></button>
      <button class="cf-icon cf-frame" aria-pressed="false" aria-label="${t("Quadrat-Modus", "Square mode")}">
        <svg class="cf-i-full" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9"/></svg>
        <svg class="cf-i-sq" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x=".75" y=".75" width="12.5" height="12.5" rx="3" stroke-opacity=".35"/></svg>
      </button>
      <button class="cf-icon cf-close" aria-label="${t("Visualizer schließen", "Close visualizer")}" title="${t("Schließen (Esc)", "Close (Esc)")}">
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
  if (host.playbarGlow) document.body.appendChild(glowEl);
  const glowCtx = glowCv.getContext("2d", { alpha: false });
  const glowTmp = document.createElement("canvas");
  const glowTmpCtx = glowTmp.getContext("2d", { alpha: false });
  const GLOW_W = 320, GLOW_PAD = 12, GLOW_BLUR = 4;
  // Mirror at exactly 1:1 scale: the row touching the playbar is the bottom row of the visual, x lines up pixel for pixel.
  // Blur happens inside the canvas on an edge-padded copy, so it can't pull the reflection away from the edge.
  function drawGlow(src) {
    if (!host.playbarGlow) return;
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
  const rows = Array.from(root.querySelectorAll(".cf-mrow")), checks = Array.from(root.querySelectorAll(".cf-check")), elList = $(".cf-list"), elAutoD = $(".cf-auto-d"), ratioButtons = Array.from(root.querySelectorAll(".cf-ratio button"));
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
    elFrame.title = settings.frame === "square" ? t("Quadrat – klicken für gespiegeltes Vollbild", "Square – click for mirrored full screen") : t("Vollbild – klicken, damit das Cover ein Quadrat bleibt", "Full screen – click to keep the cover square");
    syncModes();
  }

  // mode chip + tiles: which modes are on, which one is running right now
  function syncModes() {
    const on = autoOn(), auto = settings.mode === "auto";
    rows.forEach((r) => {
      r.setAttribute("aria-checked", String(r.dataset.k === settings.mode));
      r.classList.toggle("cf-running", r.dataset.k === state.presetKey && isOpen);
    });
    checks.forEach((c) => c.setAttribute("aria-checked", String(on.includes(c.dataset.k))));
    elList.classList.toggle("cf-solo", !auto);
    elAutoD.textContent = t("wechselt zwischen ", "switches between ") + (on.length === PRESET_KEYS().length ? t("allen ", "all ") + on.length : on.length + t(" von ", " of ") + PRESET_KEYS().length) + t(" Modi", " modes");
    elModesK.textContent = auto ? "Auto" : t("Modus", "Mode");
    elModesV.textContent = (PRESETS[state.presetKey] || PRESETS[on[0]]).label;
    elModesHint.textContent = auto ? t("Zeile wählt einen festen Modus · Häkchen = in Auto", "Row picks one fixed mode · tick = in Auto") : t("Fest: ", "Fixed: ") + PRESETS[settings.mode].label;
  }


  let openPanel = null;
  function setPanel(name) {
    openPanel = name && name !== openPanel ? name : null;
    panels.forEach((p) => p.classList.toggle("cf-on", p.dataset.panel === openPanel));
    openers.forEach((b) => b.setAttribute("aria-expanded", String(b.dataset.open === openPanel)));
    if (openPanel === "tempo") { refreshStatus(); syncLib(); }
  }
  openers.forEach((b) => b.addEventListener("click", () => setPanel(b.dataset.open)));
  root.addEventListener("pointerdown", (e) => { if (openPanel && !e.target.closest(".cf-panel,[data-open]")) setPanel(null); });

  function setMode(k) {
    settings.mode = k; saveSettings(); syncModes();
    if (k !== "auto" ? state.presetKey !== k : settings.autoOff.includes(state.presetKey)) state.pending = true; // glide home, then switch
  }
  function setAutoOff(list) {
    settings.autoOff = PRESET_KEYS().filter((k) => list.includes(k));
    if (settings.autoOff.length >= PRESET_KEYS().length) { settings.autoOff = PRESET_KEYS().filter((k) => k !== PRESET_KEYS()[0]); note(t("Mindestens ein Modus bleibt in Auto", "At least one mode stays in Auto")); }
    saveSettings(); syncModes();
    if (settings.mode === "auto" && settings.autoOff.includes(state.presetKey)) state.pending = true;
  }
  rows.forEach((r) => {
    r.addEventListener("click", (e) => { if (!e.target.closest(".cf-check,.cf-link")) setMode(r.dataset.k); });
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMode(r.dataset.k); } });
  });
  checks.forEach((c) => c.addEventListener("click", () => {
    const k = c.dataset.k, off = settings.autoOff;
    if (!off.includes(k) && autoOn().length === 1) { note(t("Mindestens ein Modus bleibt in Auto", "At least one mode stays in Auto")); return; }
    setAutoOff(off.includes(k) ? off.filter((x) => x !== k) : off.concat(k));
  }));
  $(".cf-all").addEventListener("click", () => setAutoOff([]));
  $(".cf-none").addEventListener("click", () => setAutoOff(PRESET_KEYS().filter((k) => k !== (PRESETS[state.presetKey] ? state.presetKey : PRESET_KEYS()[0]))));
  ratioButtons.forEach((b) => b.addEventListener("click", () => {
    const uri = audio.uri;
    if (!uri) return;
    if (b.dataset.r === "auto") delete tempoOverrides[uri]; else tempoOverrides[uri] = +b.dataset.r;
    saveTempo(); refreshStatus(); state.pending = true;
    note(b.dataset.r === "auto" ? t("Tempo: automatisch erkannt", "Tempo: detected automatically") : t("Tempo für diesen Song fixiert", "Tempo fixed for this song"));
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
    if (!uri || audio.synthetic) { note(t("Tap braucht eine Beat-Analyse", "Tap needs a beat analysis")); return; }
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1].now > 2200) taps = [];
    const pos = state.pos + (state.playing ? (now - state.posAt) / 1000 : 0) + settings.syncMs / 1000;
    taps.push({ now, B: audio.beatPos(pos) });
    if (taps.length > 16) taps.shift();
    elTap.classList.add("cf-hit"); clearTimeout(tapHit); tapHit = setTimeout(() => elTap.classList.remove("cf-hit"), 90);
    if (taps.length < 4) { note("Tap " + taps.length + t(" … weiter im Takt", " … keep going")); return; }
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
    note("Tap: " + Math.round(audio.tempo / m) + t(" BPM · Beat gesetzt", " BPM · beat set"));
  }
  elTap.addEventListener("click", tap);

  // ---- library UI ----
  const elLibN = $(".cf-lib-n"), elLibP = $(".cf-lib-p"), elLibBar = $(".cf-lib-p i"), elLibTxt = $(".cf-lib-p small");
  const elInDir = $(".cf-in-dir"), elInFiles = $(".cf-in-files"), libButtons = [$(".cf-lib-dir"), $(".cf-lib-files")];
  function syncLib() {
    elLibN.textContent = !Library.available ? t("nicht verfügbar", "not available") : Library.size ? Library.size + (Library.size === 1 ? " Song" : " Songs") : t("noch leer", "empty");
    libButtons.forEach((b) => { if (Library.busy || !Library.available) b.setAttribute("disabled", ""); else b.removeAttribute("disabled"); });
  }
  async function analyseFiles(files) {
    if (!files || !files.length) return;
    elLibP.hidden = false;
    const added = await Library.addFiles(files, (done, total, name) => {
      elLibBar.style.setProperty("--p", (total ? (done / total) * 100 : 100) + "%");
      elLibTxt.textContent = total ? done + " / " + total + (name ? " · " + name : "") : t("Keine Audiodateien gefunden", "No audio files found");
      syncLib();
    });
    elLibTxt.textContent = added ? added + t(" neu analysiert", " newly analysed") : t("Nichts Neues – alles schon analysiert", "Nothing new – all analysed already");
    syncLib();
    if (added) reloadCurrent();
  }
  $(".cf-lib-dir").addEventListener("click", () => elInDir.click());
  $(".cf-lib-files").addEventListener("click", () => elInFiles.click());
  elInDir.addEventListener("change", () => { analyseFiles(elInDir.files); elInDir.value = ""; });
  elInFiles.addEventListener("change", () => { analyseFiles(elInFiles.files); elInFiles.value = ""; });
  $(".cf-lib-clear").addEventListener("click", async () => { await Library.clear(); syncLib(); elLibP.hidden = true; reloadCurrent(); note(t("Eigene Analysen gelöscht", "Own analyses cleared")); });
  Library.init().then(() => { syncLib(); if (Library.size) reloadCurrent(); });

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
    let inset = 0;
    try { inset = host.bottomInset ? host.bottomInset() || 0 : 0; } catch (_) {}
    return window.innerHeight - inset;
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
    const on = settings.mode !== "auto" && PRESETS[settings.mode] ? [settings.mode] : autoOn();
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
    try { const ps = host.position(); p = ps.pos || 0; playing = !!ps.playing; } catch (_) {}
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
    const token = ++coverToken;
    let url = null;
    try {
      if (settings.source === "context" && host.contextCover) {
        url = await host.contextCover();
        if (!url && token === coverToken) note(t("Kein Playlist-Cover verfügbar – zeige Song-Cover", "No playlist cover – showing the song cover"));
      }
      if (!url && host.trackCover) url = await host.trackCover();
    } catch (_) { url = null; }
    if (token !== coverToken || !url) return;
    if (url === currentCoverUrl && !force) return;
    try {
      const img = await loadImage(url);
      if (token !== coverToken || !renderer) return;
      currentCoverUrl = url;
      renderer.pushImage(renderer.uploadImage(img));
      state.mix = 0;
      extractAccent(img);
    } catch (e) {
      console.warn("[Coverflux] cover load failed", e);
    }
  }

  // accent colour for the UI: from the host if it knows one, else the most vivid bright colour of the cover itself
  async function extractAccent(img) {
    let col = null;
    try { if (host.accent) col = await host.accent(); } catch (_) {}
    if (!col && img) {
      try {
        const c = document.createElement("canvas"); c.width = c.height = 24;
        const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data;
        let best = -1;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
          const score = (mx - mn) * (0.35 + mx) * (mx > 0.35 ? 1 : 0.2);
          if (score > best) { best = score; col = "rgb(" + d[i] + "," + d[i + 1] + "," + d[i + 2] + ")"; }
        }
        if (best < 0.12) col = "#e8e3d9";
      } catch (_) { col = null; } // tainted canvas (no CORS) – keep the current accent
    }
    if (col) root.style.setProperty("--cf-accent", col);
  }

  function refreshInfo() {
    const t = host.track();
    if (!t) return;
    const title = t.title || "", artist = t.artist || "";
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
    elBpm.title = live ? t("Tempo – der Punkt blinkt auf jedem Beat", "Tempo – the dot blinks on every beat") : t("Keine Audio-Analyse – simulierter Takt", "No audio analysis – simulated beat");
    const cur = o === undefined ? "auto" : typeof o === "number" ? String(o) : "";
    ratioButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.r === cur)));
    elDetect.textContent = live ? audio.describe() : audio.localMissing ? t("Lokale Datei ohne Analyse – simulierter Takt. Unten den Ordner analysieren, dann sitzt der Beat.", "Local file without analysis – simulated beat. Analyse its folder below and the beat locks in.") : t("Keine Analyse – simulierter Takt", "No analysis – simulated beat");
    elDetect.title = elDetect.textContent;
  }

  function reloadCurrent() {
    const t = host.track();
    if (!t || !t.uri) return;
    audio.cache.delete(t.uri);
    state.cycleId = null; state.dissolve = Math.max(state.dissolve, 0.6);
    audio.load(t.uri, t.duration || 0, t).then(refreshStatus);
  }

  async function onTrack() {
    const t = host.track();
    const uri = t && t.uri;
    refreshInfo();
    if (uri !== currentTrackUri) {
      currentTrackUri = uri;
      state.cycleId = null; state.dissolve = 1;
      audio.load(uri, (t && t.duration) || 0, t).then(refreshStatus);
      refreshStatus();
    }
    if (isOpen) refreshCover(false);
  }

  host.on("track", () => { state.lastSync = 0; onTrack(); });
  host.on("playpause", () => { state.lastSync = 0; });
  // live sources (microphone / system audio) refine their analysis while playing – swap it in without a dissolve
  host.on("analysis", (uri, a) => {
    if (!a || uri !== audio.uri) return;
    audio.cache.set(uri, a);
    audio.set(a);
    if (openPanel === "tempo") refreshStatus();
  });

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
    if (e.key === "Escape") { if (openPanel) { e.stopPropagation(); setPanel(null); } else if (closable) { e.stopPropagation(); close(); } }
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

  const button = host.mountToggle ? host.mountToggle(() => (isOpen ? close() : open())) : { active: false };
  if (!closable) root.classList.add("cf-noclose");
  if (!host.contextCover) root.classList.add("cf-nosource");
  if (host.library === false) root.classList.add("cf-nolib");

  syncControls();
  onTrack();
  return { open, close, toggle: () => (isOpen ? close() : open()), state, settings, audio, presets: PRESETS, library: Library, refresh: onTrack, reloadCurrent };
}

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
