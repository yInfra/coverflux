// Beat engine on synthetic drum tracks with known ground truth (no third-party audio in the repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const engine = new Function(fs.readFileSync(path.join(ROOT, "src", "beat-engine.js"), "utf8") + ";return coverfluxBeatFactory;")()();
const SR = engine.SR;

// kick on 1 (+ "and" of 3), snare on 2 and 4, closed hats on 8ths, a chord that changes every bar
function drums({ bpm, bars = 32, meter = 4, lead = 1.3, seed = 7 }) {
  let r = seed; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const beat = 60 / bpm, n = Math.ceil((lead + bars * meter * beat + 1) * SR), x = new Float32Array(n);
  const add = (t, f) => { const i0 = Math.round(t * SR); for (let i = 0; i < SR * 0.4 && i0 + i < n; i++) x[i0 + i] += f(i / SR); };
  const kick = (t) => add(t, (u) => 0.9 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-u * 30)) * u) * Math.exp(-u * 9));
  const snare = (t) => add(t, (u) => (0.5 * (rnd() * 2 - 1) + 0.3 * Math.sin(2 * Math.PI * 190 * u)) * Math.exp(-u * 18));
  const hat = (t) => add(t, (u) => 0.15 * (rnd() * 2 - 1) * Math.exp(-u * 60));
  const chords = [[220, 277, 330], [196, 247, 294], [175, 220, 262], [247, 311, 370]];
  const beats = [], downs = [];
  for (let b = 0; b < bars; b++) {
    const t0 = lead + b * meter * beat, ch = chords[b % chords.length];
    downs.push(t0);
    for (let k = 0; k < meter; k++) {
      const t = t0 + k * beat; beats.push(t);
      if (k === 0 || (meter === 4 && k === 2 && b % 2)) kick(t);
      if (meter === 4 ? k % 2 === 1 : k > 0) snare(t);
      hat(t); hat(t + beat / 2);
    }
    const i0 = Math.round(t0 * SR), len = Math.round(meter * beat * SR);
    for (let i = 0; i < len && i0 + i < n; i++) { const u = i / SR; let v = 0; for (const f of ch) v += Math.sin(2 * Math.PI * f * u); x[i0 + i] += 0.05 * v * Math.min(1, u * 40); }
  }
  return { x, beats, downs };
}

const near = (a, b, tol = 0.05) => a.filter((t) => b.some((u) => Math.abs(u - t) <= tol)).length;
function fmeasure(est, ref) { const h = near(est, ref); const p = h / est.length, r = h / ref.length; return p + r ? (2 * p * r) / (p + r) : 0; }

test("128 BPM 4/4: tempo, beats and downbeats", () => {
  const { x, beats, downs } = drums({ bpm: 128 });
  const a = engine.analyze(x);
  assert.ok(Math.abs(a.track.tempo - 128) < 1.5, `tempo ${a.track.tempo}`);
  assert.equal(a.track.time_signature, 4);
  const est = a.beats.map((b) => b.start);
  assert.ok(fmeasure(est, beats) > 0.95, `beat F ${fmeasure(est, beats)}`);
  const db = a.bars.map((b) => b.start);
  assert.ok(near(db, downs) / db.length > 0.9, "downbeats on the one");
});

test("164 BPM is felt at half time, on beats 1 and 3", () => {
  const { x, beats, downs } = drums({ bpm: 164 });
  const a = engine.analyze(x);
  assert.ok(Math.abs(a.track.tempo - 82) < 1.5, `tempo ${a.track.tempo}`);
  const one3 = beats.filter((_, i) => i % 4 === 0 || i % 4 === 2);
  const est = a.beats.map((b) => b.start);
  assert.ok(fmeasure(est, one3) > 0.9, `felt-beat F ${fmeasure(est, one3)}`);
  assert.ok(near(a.bars.map((b) => b.start), downs) > 0, "bars include real downbeats");
});

test("3/4 waltz at 150 BPM is detected as triple meter", () => {
  const { x } = drums({ bpm: 150, meter: 3, bars: 40 });
  const a = engine.analyze(x);
  assert.equal(a.track.time_signature, 3);
});

test("output has Spotify's analysis shape", () => {
  const a = engine.analyze(drums({ bpm: 100, bars: 16 }).x);
  for (const k of ["beats", "bars", "sections", "segments"]) assert.ok(Array.isArray(a[k]) && a[k].length, k);
  const g = a.segments[3];
  for (const k of ["start", "duration", "loudness_start", "loudness_max", "loudness_max_time"]) assert.equal(typeof g[k], "number", k);
  assert.equal(g.timbre.length, 12);
  assert.equal(g.pitches.length, 12);
});
