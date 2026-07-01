/**
 * One-off draw experiments against the fx-scan harness page — isolates
 * which Phaser 4 Graphics calls produce pixels. Build first, then
 * `node experiment.mjs`.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const dist = path.resolve(import.meta.dirname, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer(async (req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(path.join(dist, url));
    res.writeHead(200, { 'content-type': MIME[path.extname(url)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__ready, null, { timeout: 10000 });
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => window.__scan.baseline());

const experiments = {
  'moveTo/lineTo straight line': (g) => {
    g.lineStyle(7, 0xff66cc, 0.9);
    g.beginPath(); g.moveTo(-40, 0); g.lineTo(40, 0); g.strokePath();
  },
  'heart path (exact runPulse code)': (g) => {
    g.lineStyle(7, 0xff66cc, 0.9);
    const sc = 25 / 30;
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2; a += 0.1) {
      const hx = 16 * Math.pow(Math.sin(a), 3);
      const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
      const px = hx * sc, py = hy * sc;
      if (a === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.strokePath();
  },
  'arc PI->0 (runPulse semicircle)': (g) => {
    g.lineStyle(7, 0x33ffe6, 0.9);
    g.beginPath(); g.arc(0, 0, 30, Math.PI, 0); g.strokePath();
  },
  'arc PI->0 anticlockwise=true': (g) => {
    g.lineStyle(7, 0x33ffe6, 0.9);
    g.beginPath(); g.arc(0, 0, 30, Math.PI, 0, true); g.strokePath();
  },
  'arc 0->PI': (g) => {
    g.lineStyle(7, 0x33ffe6, 0.9);
    g.beginPath(); g.arc(0, 0, 30, 0, Math.PI); g.strokePath();
  },
  'setTint red on sprite': (g, scene) => {
    scene.target.setTint(0xff0000);
  },
};

for (const [name, fn] of Object.entries(experiments)) {
  const px = await page.evaluate(async (src) => {
    const scene = window.__scene;
    const g = scene.add.graphics().setPosition(240, 200).setDepth(100);
    const fn = eval(`(${src})`);
    fn(g, scene);
    await new Promise((r) => setTimeout(r, 120));
    const delta = window.__scan.pixelDelta();
    g.destroy();
    scene.target.clearTint?.();
    await new Promise((r) => setTimeout(r, 60));
    return delta;
  }, fn.toString());
  console.log(`${px >= 40 ? 'DRAWS  ' : 'NOTHING'}  px=${String(px).padStart(6)}  ${name}`);
}

await browser.close();
server.close();
