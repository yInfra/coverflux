// Contact sheet: every mode at several points of its cycle. `node tools/modes-sheet.mjs out.png [modes] [u-values] [square]`
// Also fails loudly on WebGL/page errors, so it doubles as a shader compile check.
import { serve, launch } from "../test/lib.mjs";

const [out = "modes.png", only, uArg, frame] = process.argv.slice(2);
const US = (uArg || "0,0.15,0.3,0.5,0.7,0.85,1").split(",").map(Number);
const srv = await serve();
const browser = await launch({ gpu: true });
const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" || /shader|webgl/i.test(m.text())) errors.push(m.text()); });
await page.goto(`${srv.url}/test/harness.html`);
await page.click("#cf-btn");
await page.evaluate((f) => { window.mock.seek(64); if (f) window.Coverflux.settings.frame = f; document.querySelector("#coverflux").classList.add("cf-idle"); }, frame);
await page.waitForTimeout(2000);
if (await page.evaluate(() => document.querySelector("#coverflux").classList.contains("cf-failed"))) errors.push("renderer failed (cf-failed)");

const modes = only ? only.split(",") : await page.evaluate(() => Object.keys(window.Coverflux.presets));
const rows = [];
for (const m of modes) {
  await page.evaluate((k) => { const C = window.Coverflux; C.settings.mode = k; C.state.pending = true; }, m);
  await page.waitForTimeout(1800);
  const shots = [];
  for (const u of US) {
    await page.evaluate((u) => { window.Coverflux.state.forceU = u; }, u);
    await page.waitForTimeout(260);
    shots.push((await page.screenshot({ clip: { x: 0, y: 0, width: 640, height: 330 } })).toString("base64"));
  }
  const running = await page.evaluate(() => window.Coverflux.state.presetKey);
  rows.push({ m, running, shots });
  await page.evaluate(() => { window.Coverflux.state.forceU = null; });
}
const W = 180;
const html = `<body style="margin:0;background:#000;color:#ddd;font:11px system-ui">${rows.map((r) =>
  `<div style="display:flex;align-items:center"><div style="width:90px;padding:4px">${r.m}${r.running !== r.m ? " ⚠ " + r.running : ""}</div>${r.shots.map((b, i) =>
    `<div><img src="data:image/png;base64,${b}" width="${W}"><div style="text-align:center">u=${US[i]}</div></div>`).join("")}</div>`).join("")}</body>`;
const sheet = await browser.newPage({ viewport: { width: 90 + W * US.length, height: 140 } });
await sheet.setContent(html);
await sheet.waitForTimeout(300);
await sheet.screenshot({ path: out, fullPage: true });
await browser.close();
srv.server.close();
console.log(errors.length ? "ERRORS:\n" + [...new Set(errors)].join("\n") : "ok – no errors");
