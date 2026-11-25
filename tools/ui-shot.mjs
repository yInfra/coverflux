// Screenshot of the visualizer with its controls visible: `node tools/ui-shot.mjs out.png [width] [height] [panel]`
import { serve, launch } from "../test/lib.mjs";

const [out = "ui.png", w = "1280", h = "760", panel] = process.argv.slice(2);
const srv = await serve();
const browser = await launch({ gpu: true });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${srv.url}/test/harness.html`);
await page.click("#cf-btn");
await page.waitForTimeout(2500);
await page.mouse.move(+w / 2, +h / 3);
if (panel) await page.evaluate((sel) => document.querySelector(sel)?.click(), panel);
await page.waitForTimeout(500);
await page.screenshot({ path: out });
await browser.close();
srv.server.close();
console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "ok");
