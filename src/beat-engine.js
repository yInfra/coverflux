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
  function tempo(env) {
    const T = env.length, minL = Math.floor(FPS * 60 / 200), maxL = Math.ceil(FPS * 60 / 50);
    const ac = new Float32Array(maxL * 4 + 2);
    for (let L = 1; L < ac.length; L++) { let s = 0; for (let t = L; t < T; t++) s += env[t] * env[t - L]; ac[L] = s / (T - L); }
    const at = (L) => { const i = Math.floor(L), f = L - i; return i + 1 < ac.length ? ac[i] * (1 - f) + ac[i + 1] * f : 0; };
    let best = minL, bestS = -1;
    const score = new Float32Array(maxL + 1);
    for (let L = minL; L <= maxL; L++) {
      // the whole metrical family: subdivisions (L/2, L/4) and groupings (2L, 4L) must line up too
      const comb = at(L) + 0.5 * (at(2 * L) + at(L / 2)) + 0.25 * (at(4 * L) + (L / 4 >= 2 ? at(L / 4) : 0));
      const bpm = (60 * FPS) / L, prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 130) / 0.7, 2));
      score[L] = comb * prior;
      if (score[L] > bestS) { bestS = score[L]; best = L; }
    }
    // parabolic refinement
    let P = best;
    if (best > minL && best < maxL) { const a = score[best - 1], b = score[best], c = score[best + 1], d = a - 2 * b + c; if (d < 0) P = best + (0.5 * (a - c)) / d; }
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

  // linear resampler + downmix, so callers can hand in any AudioBuffer-like channel data
  function toMono22k(channels, rate) {
    const len = channels[0].length, mono = new Float32Array(len);
    for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;
    if (rate === SR) return mono;
    const outLen = Math.floor((len * SR) / rate), out = new Float32Array(outLen), k = rate / SR;
    for (let i = 0; i < outLen; i++) { const p = i * k, j = Math.floor(p), f = p - j; out[i] = mono[j] * (1 - f) + (mono[j + 1] || 0) * f; }
    return out;
  }

  return { analyze, align, toMono22k, SR };
}
if (typeof module === "object" && module.exports) module.exports = coverfluxBeatFactory;
