#!/usr/bin/env node
/**
 * Boot the meowcert client bundle in headless Chromium with mocked API
 * responses, drive the tutorial to a target step, and screenshot the
 * canvas. Purpose: verify visual fixes without needing Reddit playtest.
 *
 * Usage:  node scripts/render-check/screenshot-tutorial.mjs
 *
 * Serves dist/client/ on a random port, intercepts /api/* with mocks
 * that put the player at post-play-tutorial state (past stage-set-
 * confirm, cat picked, editor-tour is next). Screenshots are written
 * to scripts/render-check/out/<step>.png so they can be Read() by the
 * dev workflow.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_DIR = path.join(REPO_ROOT, 'dist/client');
const ASSETS_DIR = path.join(REPO_ROOT, 'public/assets');
const OUT_DIR = path.join(__dirname, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// Mock player state — past play-tutorial, at editor-tour-intro. Butters
// picked as starter (cat13) so we can visually confirm the same cat
// Tim sees in the playtest. seatedCats has seat-center pointed at the
// player's owned Butters instance so ensureStageRigForCurrentStep re-
// seats her.
const MOCK_OWNED_CAT_ID = 'owned-butters-1';
const emptyChart = () => ({
  authorId: 'tester',
  title: 'Untitled',
  stepCount: 32,
  bpm: 120,
  steps: Array.from({ length: 32 }, () => ({ lanes: [] })),
  holds: [],
  slides: [],
  slideReturns: [],
  updatedAt: Date.now(),
});
const mockPlayerState = (step = 'editor-tour-intro') => ({
  username: 'tester',
  coins: 100,
  ownedCats: [
    { id: MOCK_OWNED_CAT_ID, breed: 'cat13', name: 'BUTTERS', rarity: 'common' },
  ],
  ownedCosmetics: [],
  equippedCosmetics: {},
  equippedCosmeticTypes: {},
  bestScore: 0,
  onboardingDone: false,
  tutorialStep: step,
  updatedAt: Date.now(),
  house: { themeId: 'default', ownedThemes: ['default'] },
  seatedCats: { 'seat-center': MOCK_OWNED_CAT_ID },
  chart: emptyChart(),
  ownedBackgrounds: ['stage'],
  activeBackground: 'stage',
});

const TARGET_STEP = process.env.STEP ?? 'editor-tour-intro';

const API_MOCKS = {
  '/api/state': () => ({ state: mockPlayerState(TARGET_STEP) }),
  '/api/init': () => ({ postId: null }),
  '/api/tutorial/set-step': () => ({ ok: true, state: mockPlayerState(TARGET_STEP) }),
  '/api/tutorial/complete': () => ({ ok: true, state: { ...mockPlayerState(TARGET_STEP), onboardingDone: true } }),
  '/api/background/set': () => ({ ok: true, state: mockPlayerState(TARGET_STEP) }),
  '/api/house/seat': () => ({ ok: true, state: mockPlayerState(TARGET_STEP) }),
};

function serveStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // API mocks — return JSON.
      if (pathname.startsWith('/api/')) {
        const handler = API_MOCKS[pathname];
        const body = handler ? handler() : { ok: false };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      // Asset paths served from public/assets/.
      let filePath;
      if (pathname.startsWith('/assets/')) {
        filePath = path.join(REPO_ROOT, 'public', pathname);
      } else {
        filePath = path.join(DIST_DIR, pathname === '/' ? '/game.html' : pathname);
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end(`Not found: ${pathname}`);
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await serveStatic();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/game.html`;
  console.log(`serving on ${url}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  page.on('console', (msg) => {
    const t = msg.type();
    const txt = msg.text();
    if (t === 'error' || txt.includes('MISSING') || txt.includes('missing')) {
      console.log(`[browser ${t}] ${txt}`);
    }
  });
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
  page.on('requestfailed', (req) => {
    if (!req.url().endsWith('.map')) {
      console.log(`[reqfail] ${req.url()} ${req.failure()?.errorText ?? ''}`);
    }
  });

  await page.goto(url, { waitUntil: 'networkidle' });
  // Give Phaser boot + preloader time to complete + orchestrator to render.
  await page.waitForTimeout(15000);

  const outPath = path.join(OUT_DIR, `${TARGET_STEP}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`screenshot → ${outPath}`);

  await browser.close();
  server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
