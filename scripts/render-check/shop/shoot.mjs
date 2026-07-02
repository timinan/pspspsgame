/**
 * shop driver — serves the built harness and screenshots the Merch shop:
 * the default grid, all three tier selections on the Cosmetics card, and an
 * insufficient-coins state.
 *
 * Build first:  npx vite build --config vite.config.mjs
 * Then:         node shoot.mjs
 */
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const dist = path.resolve(import.meta.dirname, 'dist');
const outDir = path.resolve(import.meta.dirname, 'out');
await mkdir(outDir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(path.join(dist, url));
    res.writeHead(200, { 'content-type': MIME[path.extname(url)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
page.on('console', (m) => console.log('  [page]', m.text()));
page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 400));

const canvas = page.locator('canvas');

async function shot(name) {
  await new Promise((r) => setTimeout(r, 220));
  await canvas.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`shot ${name}.png`);
}

// Default grid — 5000 coins, all four cards on standard tier.
await shot('shop-standard');

// Cosmetics card: golden then mythic.
await page.evaluate(() => window.__selectTier('cosmetic', 'golden'));
await shot('shop-cosmetic-golden');

await page.evaluate(() => window.__selectTier('cosmetic', 'mythic'));
await shot('shop-cosmetic-mythic');

// Insufficient coins — 100 coins, every tier unaffordable (BUY greyed).
await page.evaluate(() => window.__setCoins(100));
await shot('shop-insufficient');

await browser.close();
server.close();
console.log('done');
