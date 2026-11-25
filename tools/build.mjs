// Bundles the beat engine and the extension into the single file Spicetify loads: dist/coverflux.js.
// The bundle is committed, so users install without Node. `npm run build`  (CI checks it is up to date)
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../test/lib.mjs";

const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8").replace(/\r\n/g, "\n");
const ext = read("coverflux.js");
const engine = read("beat-engine.js").replace(/\nif \(typeof module[^\n]*\n?$/, "\n");

// keep the Spicetify metadata header on top
const header = ext.match(/^(\/\/[^\n]*\n)+/)[0];
const out = header +
  "// Built from src/beat-engine.js + src/coverflux.js – edit those, then run `npm run build`.\n\n" +
  engine.trimEnd() + "\n\n" + ext.slice(header.length).trimStart();

fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "dist", "coverflux.js"), out);
console.log(`dist/coverflux.js  ${(out.length / 1024).toFixed(1)} KB`);
