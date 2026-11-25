// Bundles the platform-neutral core with an adapter into single files:
//   dist/coverflux.js      – Spicetify extension (beat engine + core + adapters/spicetify)
//   dist/coverflux-web.js  – browser/web app (beat engine + core + adapters/web), used by web/index.html
// Both bundles are committed so users install without Node. `npm run build` (CI checks they are up to date)
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../test/lib.mjs";

const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8").replace(/\r\n/g, "\n");
const strip = (code) => code.replace(/\nif \(typeof module[^\n]*\n?$/, "\n").trim();
const engine = strip(read("beat-engine.js"));
const core = strip(read("core.js"));
fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });

function bundle(adapterFile, out) {
  if (!fs.existsSync(path.join(ROOT, "src", adapterFile))) return;
  const adapter = read(adapterFile);
  const header = (adapter.match(/^(\/\/[^\n]*\n)+/) || [""])[0];
  const body = adapter.slice(header.length).trim();
  const note = `// Built from src/beat-engine.js + src/core.js + src/${adapterFile} – edit those, then run \`npm run build\`.\n\n`;
  const text = header + note + engine + "\n\n" + core + "\n\n" + body + "\n";
  fs.writeFileSync(path.join(ROOT, "dist", out), text);
  console.log(`dist/${out}  ${(text.length / 1024).toFixed(1)} KB`);
}

bundle("adapters/spicetify.js", "coverflux.js");
bundle("adapters/web.js", "coverflux-web.js");
