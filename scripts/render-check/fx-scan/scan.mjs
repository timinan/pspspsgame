/**
 * fx-scan driver — serves the built harness, applies every generated effect
 * for ~15 frames, and classifies each as ok / apply-throw / tick-throw /
 * raf-dead / hard-freeze. Run `npx vite build --config vite.config.mjs`
 * in this dir first, then `node scan.mjs`.
 */
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const dist = path.resolve(import.meta.dirname, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(path.join(dist, url));
    res.writeHead(200, { 'content-type': MIME[path.extname(url)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
let page;

async function freshPage() {
  if (page) await page.close().catch(() => {});
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 10000 });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms)),
  ]);
}

const SHOTS = process.argv.includes('--shots');
const shotsDir = path.resolve(import.meta.dirname, 'out');
if (SHOTS) await mkdir(shotsDir, { recursive: true });

await freshPage();
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => window.__scan.baseline());
const ids = await page.evaluate(() => window.__scan.ids());
console.log(`scanning ${ids.length} effects on port ${port}`);

const results = { ok: [], noRender: [], applyThrow: [], tickThrow: [], rafDead: [], hardFreeze: [] };

for (const id of ids) {
  try {
    const applyErr = await withTimeout(page.evaluate((i) => window.__scan.start(i), id), 4000);
    if (applyErr) {
      results.applyThrow.push({ id, err: applyErr });
      await withTimeout(page.evaluate(() => window.__scan.stop()), 4000).catch(() => {});
      continue;
    }
    const f0 = await withTimeout(page.evaluate(() => window.__scan.frames()), 4000);
    await new Promise((r) => setTimeout(r, 250));
    const f1 = await withTimeout(page.evaluate(() => window.__scan.frames()), 4000);
    const px = await withTimeout(page.evaluate(() => window.__scan.pixelDelta()), 4000);
    if (SHOTS) {
      await page.screenshot({ path: path.join(shotsDir, `${id}.png`), clip: { x: 60, y: 140, width: 360, height: 360 } });
    }
    const stopErr = await withTimeout(page.evaluate(() => window.__scan.stop()), 4000);
    if (stopErr) results.tickThrow.push({ id, err: stopErr });
    else if (f1 - f0 < 2) results.rafDead.push({ id, frames: f1 - f0 });
    else if (px < 40) results.noRender.push({ id, err: `pixelDelta=${px}` });
    else results.ok.push(id);
  } catch (err) {
    results.hardFreeze.push({ id, err: String(err) });
    console.log(`HARD FREEZE: ${id} — reloading page`);
    await freshPage();
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => window.__scan.baseline());
  }
}

console.log(`\nok: ${results.ok.length}`);
for (const key of ['noRender', 'applyThrow', 'tickThrow', 'rafDead', 'hardFreeze']) {
  console.log(`\n${key}: ${results[key].length}`);
  for (const r of results[key]) console.log(`  ${r.id}  ${r.err ?? ''}`);
}

await browser.close();
server.close();
