/**
 * rewards-scene driver — serves the built harness and screenshots the
 * real Rewards scene across every state: collect-pot (240 / 0 /
 * post-collect), daily-quest + login-streak states, both box choosers,
 * and the WEEKLY / TROPHIES placeholders.
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
const shoot = async (name) => {
  await new Promise((r) => setTimeout(r, 220));
  await canvas.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`shot ${name}.png`);
};

// collect-pot states
await page.evaluate(() => window.__open(240));
await shoot('pot-240');

await page.evaluate(() => window.__open(0));
await shoot('pot-0');

// post-collect (open at 240, then collect through the stubbed endpoint)
await page.evaluate(() => window.__open(240));
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => window.__collectNow());
await shoot('post-collect');

// daily-quest + login-streak scenes
for (const name of ['quests-mid', 'quest-claimable', 'all-claimed', 'streak-3', 'streak-7']) {
  await page.evaluate((n) => window.__scene(n), name);
  await shoot(name);
}

// standard box chooser (all-3 quest bonus)
await page.evaluate(() => window.__scene('all-claimed'));
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => window.__openChooser());
await shoot('bonus-chooser');

// golden box chooser (day-7 streak)
await page.evaluate(() => window.__scene('streak-7'));
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => window.__openGoldenChooser());
await shoot('golden-chooser');

// WEEKLY tab states — start the scene, then switch to the weekly tab.
for (const name of ['weekly-mid', 'weekly-claimable', 'weekly-two-claimed', 'weekly-all-claimed']) {
  await page.evaluate((n) => window.__scene(n), name);
  await new Promise((r) => setTimeout(r, 120));
  await page.evaluate(() => window.__tab('weekly'));
  await shoot(name);
}

// weekly golden chooser (the overlay a CLAIM tap opens — exactly 4 golden SKUs)
await page.evaluate(() => window.__scene('weekly-claimable'));
await new Promise((r) => setTimeout(r, 120));
await page.evaluate(() => window.__tab('weekly'));
await new Promise((r) => setTimeout(r, 120));
await page.evaluate(() => window.__openGoldenChooser());
await shoot('weekly-chooser');

// TROPHIES placeholder
await page.evaluate(() => window.__open(0));
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => window.__tab('trophies'));
await shoot('tab-trophies-placeholder');

await browser.close();
server.close();
console.log('done');
