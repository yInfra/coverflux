// Shared test helpers: tiny static server for the repo + a Chromium launcher.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".css": "text/css" };

export function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// Uses CHROME_PATH, else a locally installed Chrome on Windows, else Playwright's bundled Chromium.
export async function launch({ gpu = false } = {}) {
  const { chromium } = await import("playwright");
  const local = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const executablePath = process.env.CHROME_PATH || (fs.existsSync(local) ? local : undefined);
  const args = gpu ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : [];
  return chromium.launch({ executablePath, args });
}
