// Beat-grid checks: tempo feel, meter detection, off-beat grid fix and half-time phase.
// Runs the real extension inside test/harness.html and feeds it synthetic Spotify analyses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, launch } from "./lib.mjs";

let srv, browser, page;
const errors = [];

before(async () => {
  srv = await serve();
  browser = await launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${srv.url}/test/harness.html`);
  await page.waitForFunction(() => window.Coverflux && window.Coverflux.audio);
});

after(async () => {
  await browser?.close();
  srv?.server.close();
});

// meter: beats per bar of the music · reportTs: what Spotify claims · shiftHalf: grid sits on the off-beats
// barOffset: Spotify's bars start this many beats late · reportTempo: Spotify's headline BPM if different
function analyze(opts) {
  return page.evaluate((o) => {
    const { tempo, meter = 4, reportTs = 4, shiftHalf = false, barOffset = 0, reportTempo } = o;
    const bl = 60 / tempo, dur = 120, beats = [], bars = [], segments = [];
    for (let t = shiftHalf ? bl / 2 : 0, i = 0; t < dur; t += bl, i++) {
      beats.push({ start: t, duration: bl, confidence: 0.7 });
      if ((i - barOffset) % reportTs === 0 && i >= barOffset) bars.push({ start: t, duration: bl * reportTs });
    }
    for (let t = 0, k = 0; t < dur; t += bl / 2, k++) {
      const on = k % 2 === 0, pos = (k / 2) % meter, down = on && pos === 0;
      const mx = down ? -4 : on ? -8 : -13;
      segments.push({
        start: t, duration: bl / 2, loudness_start: down ? mx - 22 : on ? mx - 14 : mx - 3, loudness_max: mx, loudness_max_time: 0.02,
        pitches: Array.from({ length: 12 }, (_, d) => (d === (down ? 0 : on ? 4 : 7) ? 1 : 0.15)),
        timbre: Array.from({ length: 12 }, (_, d) => (d === 1 ? (down ? 70 : on ? 30 : -10) : d === 2 ? (down ? 20 : -5) : 0)),
      });
    }
    const sections = [{ start: 0, duration: 60, loudness: -9 }, { start: 60, duration: 60, loudness: -6 }];
    const A = window.Coverflux.audio;
    A.uri = "spotify:track:test-" + JSON.stringify(o);
    A.set({ track: { tempo: reportTempo || tempo, time_signature: reportTs }, beats, bars, sections, segments });
    return { felt: Math.round(A.tempo / A.mult()), m: A.mult(), bpb: A.bpb, shift: A.shift, d0: A.d0, triple: !!(A.grid && A.grid.triple) };
  }, opts);
}

test("4/4 at 150 BPM is felt at half time (max 140)", async () => {
  const r = await analyze({ tempo: 150 });
  assert.equal(r.felt, 75);
  assert.equal(r.triple, false);
});

test("4/4 at 120 BPM stays as is", async () => {
  assert.equal((await analyze({ tempo: 120 })).felt, 120);
});

test("3/4 reported as 4/4 is detected and never halved", async () => {
  const r = await analyze({ tempo: 165, meter: 3, reportTs: 4 });
  assert.equal(r.triple, true);
  assert.equal(r.bpb, 3);
  assert.equal(r.m, 3);
});

test("6/8 eighth-note grid at 200 goes to one pulse per bar", async () => {
  const r = await analyze({ tempo: 200, meter: 3 });
  assert.equal(r.triple, true);
  assert.equal(r.felt, 67);
});

test("grid on the off-beat is moved by half a beat", async () => {
  const r = await analyze({ tempo: 100, shiftHalf: true });
  assert.equal(r.shift, 0.5);
  assert.equal(r.felt, 100);
});

test("wrong Spotify headline tempo is ignored, the grid wins", async () => {
  assert.equal((await analyze({ tempo: 128, reportTempo: 88 })).felt, 128);
});

test("half time picks the strong beat even if Spotify's bars start one beat late", async () => {
  const r = await analyze({ tempo: 150, barOffset: 1 });
  assert.equal(r.m, 2);
  assert.equal(r.d0 % 2, 0, "felt beat 0 must sit on the real downbeat");
});

test("no page errors", () => {
  assert.deepEqual(errors, []);
});
