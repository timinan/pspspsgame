/**
 * dressing-room driver — serves the built harness + the game's real
 * assets, opens the modal in both modes, exercises drag-scroll and a
 * category chip, dumps PNGs to out/. Build first:
 *   npx vite build --config vite.config.mjs && node shoot.mjs
 */
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const here = import.meta.dirname;
const dist = path.resolve(here, 'dist');
// Snapshot copy — dist/client/assets gets rewritten by the dev watcher
// mid-run, which yields green missing-texture boxes.
const gameAssets = path.resolve(here, 'assets-snapshot');
const outDir = path.resolve(here, 'out');
await mkdir(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.otf': 'font/otf',
};
const server = http.createServer(async (req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  // Harness dist first (vite also emits under /assets/), then the game's
  // real asset tree for atlases + fonts.
  const candidates = [path.join(dist, url)];
  if (url.startsWith('/assets/')) {
    candidates.push(path.join(gameAssets, url.slice('/assets/'.length)));
  }
  for (const file of candidates) {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
      return;
    } catch { /* try next */ }
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 580 } });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 300));

// 1. Effects-only mode, fresh
await page.evaluate(() => window.__openDR(true));
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: path.join(outDir, 'effects-fresh.png') });

// 2. Drag-scroll down inside the grid
await page.mouse.move(160, 430);
await page.mouse.down();
for (let y = 430; y >= 260; y -= 17) await page.mouse.move(160, y);
await page.mouse.up();
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: path.join(outDir, 'effects-scrolled.png') });

// 3. Pick a category via the scene handle (chip-tap equivalent)
const chipOk = await page.evaluate(() => {
  const scene = window.__game?.scene.getScene('DressingRoom');
  if (!scene) return 'no scene';
  scene.effectCategoryFilter = 'Orbiters';
  scene.scrollY = 0;
  scene.renderSlotTabs();
  scene.renderGrid();
  return 'ok';
});
console.log('chip switch:', chipOk);
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: path.join(outDir, 'effects-orbiters.png') });

// 3b. Tap the first effect cell (row 0, col 1 — after NONE) to verify
// pointer input reaches cells through the grid camera; equip is optimistic
// so the yellow stroke + hero effect should appear even though the
// /api equip call 404s in the harness.
await page.mouse.click(160, 330);
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: path.join(outDir, 'effects-tapped.png') });

// 4. Dress-up mode (slot tabs + scrollable cosmetics)
await page.evaluate(() => window.__openDR(false));
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: path.join(outDir, 'dressup-fresh.png') });

// 5. Wheel-scroll the cosmetics grid
await page.mouse.move(160, 400);
await page.mouse.wheel(0, 300);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: path.join(outDir, 'dressup-scrolled.png') });

console.log('shots in', outDir);
await browser.close();
server.close();
