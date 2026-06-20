/**
 * Local dev server for the in-repo content-authoring tools. Serves
 * everything under the project root statically AND accepts
 * `POST /save/<toolName>` with a JSON body, persisting it to each
 * tool's output file. Calibrators autosave through this endpoint so
 * the on-disk JSON stays in lock-step with the UI — no file picker,
 * no clipboard.
 *
 * Usage: `node tools/server.mjs`   (default port 3000)
 * Visit  http://localhost:3000/ for the tool index.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const PORT = Number(process.env.PORT) || 3000;
const NO_CACHE = 'no-store, no-cache, must-revalidate';

// Each registered tool: where its calibrator lives and where the save
// endpoint writes its JSON. Add a new entry per tool — the / index page
// renders this object as a list.
const TOOLS = {
  cosmetics: {
    label: 'Cosmetic Calibrator',
    href: '/tools/cosmetics/calibrator.html',
    savePath: path.join(TOOL_DIR, 'cosmetics', 'cosmetics.json'),
    description: 'Name, position, slot, and tint variants for the 17 cosmetic sprites.',
  },
  cats: {
    label: 'Cat Calibrator',
    href: '/tools/cats/calibrator.html',
    savePath: path.join(TOOL_DIR, 'cats', 'cats.json'),
    description: 'Name, rarity, scale, animation preview, and tint variants for the 6 base cats.',
  },
};

const MAX_BACKUPS = 5;

/**
 * Before overwriting <tool>.json, shuffle the existing file down a
 * rolling stack of .bak-1.json … .bak-N.json copies. So if a save ever
 * lands on the wrong data (probe, schema bug, fat-finger), the last few
 * good versions are still on disk next to the live file.
 */
async function rotateBackups(filepath) {
  // Drop the oldest backup if we're at the cap.
  const oldest = backupPath(filepath, MAX_BACKUPS);
  await fs.unlink(oldest).catch(() => {});
  // Shift each existing backup one slot older.
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const from = backupPath(filepath, i);
    const to = backupPath(filepath, i + 1);
    await fs.rename(from, to).catch(() => {});
  }
  // Promote the current live file (if any) to .bak-1.
  await fs.rename(filepath, backupPath(filepath, 1)).catch(() => {});
}

function backupPath(filepath, n) {
  const ext = path.extname(filepath);
  return filepath.slice(0, -ext.length) + `.bak-${n}` + ext;
}

let catalogSyncTimer = null;
let catalogSyncRunning = false;
function scheduleCatalogSync() {
  clearTimeout(catalogSyncTimer);
  catalogSyncTimer = setTimeout(() => {
    if (catalogSyncRunning) {
      scheduleCatalogSync(); // try again after the in-flight run finishes
      return;
    }
    catalogSyncRunning = true;
    const child = spawn(
      'npx',
      ['tsx', path.join(PROJECT_ROOT, 'scripts', 'sync-catalog.ts')],
      { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      catalogSyncRunning = false;
      if (code === 0) {
        const summary = stdout.split('\n').find((l) => l.includes('[sync]')) ?? 'ok';
        console.log(`[sync-catalog] ${summary.trim()}`);
      } else {
        console.warn(`[sync-catalog] exit ${code}\n${stderr}`);
      }
    });
  }, 500);
}

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

function indexHtml() {
  const rows = Object.entries(TOOLS)
    .map(
      ([key, t]) => `
      <li>
        <a href="${t.href}">${t.label}</a>
        <small>${t.description}</small>
        <code>POST /save/${key} → ${path.relative(PROJECT_ROOT, t.savePath)}</code>
      </li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" /><title>pspsps tools</title>
  <link rel="icon" href="data:," />
  <style>
    body { font-family: system-ui, sans-serif; background: #1a0a2e; color: #fff;
           margin: 0; padding: 32px; max-width: 720px; }
    h1 { margin: 0 0 24px; color: #ffd34d; }
    ul { list-style: none; padding: 0; }
    li { background: #261540; border-radius: 10px; padding: 16px 18px; margin-bottom: 12px;
         display: flex; flex-direction: column; gap: 4px; }
    a { color: #fff; font-weight: 700; font-size: 18px; text-decoration: none; }
    a:hover { color: #ffd34d; }
    small { color: #c0a0e6; }
    code { color: #7fdc8a; font-size: 11px; font-family: ui-monospace, monospace; }
  </style></head>
<body>
  <h1>pspsps · dev tools</h1>
  <ul>${rows}</ul>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    // --- POST /save/<tool> ---------------------------------------------
    if (req.method === 'POST' && req.url?.startsWith('/save')) {
      const toolName = req.url.replace(/^\/save\/?/, '');
      const tool = TOOLS[toolName];
      if (!tool) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `unknown tool: ${toolName}` }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // Reject anything that isn't valid JSON so we don't poison
          // the file with a half-written payload from a network hiccup.
          JSON.parse(body);
          await rotateBackups(tool.savePath);
          await fs.writeFile(tool.savePath, body);
          const rel = path.relative(PROJECT_ROOT, tool.savePath);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: rel, bytes: body.length }));
          console.log(`[save:${toolName}] wrote ${body.length}B → ${rel}`);
          // Regenerate src/shared/*-catalog.generated.ts so the game
          // catalog tracks the calibrators in real time. Debounced + fire
          // and forget — if it fails we just log; the JSON file is still
          // correct on disk and the next save retries.
          scheduleCatalogSync();
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    let pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);

    // Index page when hitting the root.
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': NO_CACHE });
      res.end(indexHtml());
      return;
    }

    let filepath = path.join(PROJECT_ROOT, pathname);

    // Block directory traversal.
    if (!filepath.startsWith(PROJECT_ROOT + path.sep) && filepath !== PROJECT_ROOT) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let stat = await fs.stat(filepath).catch(() => null);

    // Extension-less URL fallback: `/tools/cosmetics/calibrator` → `.html`.
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
    res.writeHead(200, { 'content-type': contentType, 'cache-control': NO_CACHE });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Server error: ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  pspsps tools server → http://localhost:${PORT}/`);
  for (const [name, t] of Object.entries(TOOLS)) {
    console.log(`    · ${name}: ${t.href}`);
  }
  console.log();
});
