// Renders the README preview images from the test harness (generated cover art, no third-party images).
// Needs a GPU-capable local Chrome: `npm run preview`
import path from "node:path";
import { serve, launch, ROOT } from "../test/lib.mjs";

const OUT = path.join(ROOT, "docs");
const srv = await serve();
const browser = await launch({ gpu: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
await page.goto(`${srv.url}/test/harness.html`);
await page.waitForFunction(() => window.Coverflux);
await page.click("#cf-btn");
await page.evaluate(() => window.mock.seek(64));
await page.waitForTimeout(2500);

async function shot(name, { mode, frame, u }) {
  await page.evaluate(({ mode, frame }) => {
    const C = window.Coverflux;
    C.settings.frame = frame; C.settings.modes = [mode]; C.state.pending = true;
    document.querySelector("#coverflux").classList.add("cf-idle"); // hide the chrome
  }, { mode, frame });
  await page.waitForTimeout(2800);
  await page.evaluate((u) => { window.Coverflux.state.forceU = u; }, u);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, name) });
  await page.evaluate(() => { window.Coverflux.state.forceU = null; });
}

await shot("preview-kaleido.png", { mode: "kaleido", frame: "full", u: 0.5 });
await shot("preview-square.png", { mode: "kaleido", frame: "square", u: 0.3 });
await browser.close();
srv.server.close();
console.log("docs/preview-*.png written");
