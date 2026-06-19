/**
 * Tiny local dev server for the cosmetic calibrator. Serves every file
 * under the project root statically AND accepts POST /save with a JSON
 * body, persisting it to cosmetics.json so the calibrator's autosave is
 * truly silent — no file picker, no clipboard, just edit and the disk
 * stays in sync.
 *
 * Usage: `node cosmetic-server.mjs`  (default port 3000)
 * Then open http://localhost:3000/cosmetic-calibrator.html
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This script lives at tools/cosmetics/server.mjs. The HTTP root is the
// actual project root two directories up so the calibrator can fetch
// /public/assets/atlas/ assets directly. The save endpoint writes back
// next to this script so the tool's output is colocated with the tool.
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..', '..');
const PORT = Number(process.env.PORT) || 3000;
const SAVE_FILENAME = 'cosmetics.json';
const SAVE_PATH = path.join(TOOL_DIR, SAVE_FILENAME);
const DEFAULT_PAGE = '/tools/cosmetics/calibrator.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const NO_CACHE = 'no-store, no-cache, must-revalidate';

const server = http.createServer(async (req, res) => {
  try {
    // --- POST /save -----------------------------------------------------
    if (req.method === 'POST' && req.url === '/save') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // Reject anything that isn't valid JSON so we don't poison the
          // file with a half-written payload from a network hiccup.
          JSON.parse(body);
          await fs.writeFile(SAVE_PATH, body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: path.relative(PROJECT_ROOT, SAVE_PATH), bytes: body.length }));
          console.log(`[save] wrote ${body.length}B → ${path.relative(PROJECT_ROOT, SAVE_PATH)}`);
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // --- GET <path> -----------------------------------------------------
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    let pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (pathname === '/') pathname = DEFAULT_PAGE;
    let filepath = path.join(PROJECT_ROOT, pathname);

    // Block directory traversal.
    if (!filepath.startsWith(PROJECT_ROOT + path.sep) && filepath !== PROJECT_ROOT) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let stat = await fs.stat(filepath).catch(() => null);

    // If the requested path has no extension and doesn't exist, try
    // `<path>.html` so /cosmetic-calibrator resolves the same as
    // /cosmetic-calibrator.html.
    if ((!stat || stat.isDirectory()) && !path.extname(filepath)) {
      const withHtml = filepath + '.html';
      const htmlStat = await fs.stat(withHtml).catch(() => null);
      if (htmlStat && !htmlStat.isDirectory()) {
        filepath = withHtml;
        stat = htmlStat;
      }
    }

    if (!stat || stat.isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Not found: ${pathname}`);
      return;
    }

    const ext = path.extname(filepath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const data = await fs.readFile(filepath);
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': NO_CACHE,
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Server error: ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Cosmetic calibrator → http://localhost:${PORT}/`);
  console.log(`  Saves write to: ${path.relative(PROJECT_ROOT, SAVE_PATH)}\n`);
});
