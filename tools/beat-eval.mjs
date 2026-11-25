// Measures the JS beat engine against reference beats (test/audio-ref/*.beats.json from Beat This!).
// Usage: node tools/beat-eval.mjs <audio files...>     (needs ffmpeg on PATH for decoding)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../test/lib.mjs";

// loaded as plain source text – the same way the extension ships it into a Web Worker
const engine = new Function(fs.readFileSync(path.join(ROOT, "src", "beat-engine.js"), "utf8") + ";return coverfluxBeatFactory;")()();

function decode(file) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(engine.SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

// F-measure with ±70 ms tolerance (MIREX standard)
function fmeasure(est, ref, tol = 0.07) {
  let hit = 0; const used = new Set();
  for (const e of est) { let bi = -1, bd = tol; ref.forEach((r, i) => { const d = Math.abs(r - e); if (d <= bd && !used.has(i)) { bd = d; bi = i; } }); if (bi >= 0) { used.add(bi); hit++; } }
  const p = hit / Math.max(1, est.length), r = hit / Math.max(1, ref.length);
  return p + r ? (2 * p * r) / (p + r) : 0;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const bpmOf = (b) => 60 / median(b.slice(1).map((v, i) => v - b[i]));
const offsetMs = (est, ref) => { const d = []; for (const e of est) { let bd = 0.07, bv = null; for (const r of ref) { const x = e - r; if (Math.abs(x) < bd) { bd = Math.abs(x); bv = x; } } if (bv != null) d.push(bv); } return d.length ? Math.round(median(d) * 1000) : NaN; };

for (const file of process.argv.slice(2)) {
  const name = path.basename(file).replace(/\.[^.]+$/, "");
  const refFile = path.join(ROOT, "test", "audio-ref", name + ".beats.json");
  const t0 = performance.now();
  const a = engine.analyze(decode(file));
  const ms = Math.round(performance.now() - t0);
  const est = a.beats.map((b) => b.start), estDb = a.bars.map((b) => b.start);
  if (!fs.existsSync(refFile)) { console.log(name, "– no reference", a.track); continue; }
  const ref = JSON.parse(fs.readFileSync(refFile, "utf8"));
  // octave-tolerant: also compare against every other reference beat / doubled reference
  const refHalf = ref.beats.filter((_, i) => i % 2 === 0), refHalf2 = ref.beats.filter((_, i) => i % 2 === 1);
  const refDouble = ref.beats.flatMap((b, i) => (i + 1 < ref.beats.length ? [b, (b + ref.beats[i + 1]) / 2] : [b]));
  // half time done right: beats 1 and 3 of every reference bar
  const ref13 = ref.downbeats.flatMap((d) => {
    const i = ref.beats.findIndex((b) => Math.abs(b - d) < 0.02);
    return i >= 0 && ref.beats[i + 2] !== undefined ? [ref.beats[i], ref.beats[i + 2]] : [d];
  });
  console.log(`\n${name}  (${ms} ms)`);
  console.log(`  tempo   est ${bpmOf(est).toFixed(1)} BPM (track ${a.track.tempo}) · ref ${bpmOf(ref.beats).toFixed(1)} BPM · meter ${a.track.time_signature}/4`);
  console.log(`  beats   F ${fmeasure(est, ref.beats).toFixed(3)} · vs ½ref ${Math.max(fmeasure(est, refHalf), fmeasure(est, refHalf2)).toFixed(3)} · vs ref 1+3 ${fmeasure(est, ref13).toFixed(3)} · vs 2×ref ${fmeasure(est, refDouble).toFixed(3)} · offset ${offsetMs(est, ref.beats)} ms`);
  const prec = estDb.filter((d) => ref.downbeats.some((r) => Math.abs(r - d) <= 0.07)).length / Math.max(1, estDb.length);
  console.log(`  downb.  F ${fmeasure(estDb, ref.downbeats).toFixed(3)} · precision ${prec.toFixed(3)} (${estDb.length} est / ${ref.downbeats.length} ref)`);
  console.log(`  ${a.segments.length} segments, ${a.sections.length} sections`);
}
