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
import sharp from 'sharp';

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
  themes: {
    label: 'Theme Calibrator',
    href: '/tools/themes/calibrator.html',
    savePath: path.join(TOOL_DIR, 'themes', 'themes.json'),
    description: 'Display name, frame key, and rarity for room themes.',
  },
  music: {
    label: 'Music Calibrator',
    href: '/tools/music/calibrator.html',
    savePath: path.join(TOOL_DIR, 'music', 'music.json'),
    description: 'Tempo, vibe, BPM per backing track. Drop an MP3 to add a new song; ffmpeg auto-trims to 32s + downmixes to 96kbps mono.',
  },
  prompts: {
    label: 'Prompt Generator',
    href: '/tools/prompts/generator.html',
    // No save endpoint — purely client-side prompt generation. Path
    // is set so the TOOLS table stays uniform; nothing reads it.
    savePath: path.join(TOOL_DIR, 'prompts', 'prompts.json'),
    description: 'Fresh background + music prompts on demand. Tap regenerate to roll new ones matched to the game vibe; tap a prompt to copy.',
  },
  'cosmetic-quick-add': {
    label: 'Cosmetic Quick Add',
    href: '/tools/cosmetics/quick-add.html',
    // Reuses the cosmetics catalog — no dedicated save endpoint, the
    // upload handler writes directly + runs extract + sync-catalog.
    savePath: path.join(TOOL_DIR, 'cosmetics', 'cosmetics.json'),
    description: 'Upload one PNG → fully integrated cosmetic (static + rides cat motion).',
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

/**
 * Returns the JS source for the universal tools-nav top bar. Tool pages
 * pull this via `<script src="/tools-nav.js"></script>` and the script
 * self-injects a fixed nav at the top of the page with one link per
 * registered tool plus a Home link. The current tool gets an `active`
 * highlight. Brand-new tools added to the TOOLS table show up
 * automatically — no per-tool HTML edit needed.
 */
function toolsNavJs() {
  const tools = Object.entries(TOOLS).map(([_, t]) => ({
    label: t.label,
    href: t.href,
  }));
  return `(function () {
  if (window.__pspspsToolsNavInjected) return;
  window.__pspspsToolsNavInjected = true;
  const tools = ${JSON.stringify(tools)};
  const path = window.location.pathname;

  const style = document.createElement('style');
  style.textContent = [
    '#pspsps-tools-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 9999;',
    '  background: #0d041b; padding: 7px 14px;',
    '  display: flex; gap: 4px; flex-wrap: wrap; align-items: center;',
    '  border-bottom: 1px solid #341c5a;',
    '  font-family: system-ui, sans-serif; font-size: 12px;',
    '  box-shadow: 0 2px 8px rgba(0,0,0,0.3); }',
    '#pspsps-tools-nav a { color: #c0a0e6; text-decoration: none;',
    '  padding: 4px 10px; border-radius: 4px;',
    '  transition: background 0.1s, color 0.1s; }',
    '#pspsps-tools-nav a:hover { background: #261540; color: #fff; }',
    '#pspsps-tools-nav a.active { background: #ffd34d; color: #1a0a2e; font-weight: 700; }',
    '#pspsps-tools-nav .brand { color: #ffd34d; font-weight: 700; margin-right: 10px;',
    '  letter-spacing: 0.5px; }',
    'body { padding-top: 40px !important; }'
  ].join('\\n');
  document.head.appendChild(style);

  const nav = document.createElement('nav');
  nav.id = 'pspsps-tools-nav';

  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = '🐾 pspsps tools';
  nav.appendChild(brand);

  const home = document.createElement('a');
  home.href = '/';
  home.textContent = 'home';
  if (path === '/' || path === '') home.className = 'active';
  nav.appendChild(home);

  for (const t of tools) {
    const a = document.createElement('a');
    a.href = t.href;
    a.textContent = t.label;
    if (path === t.href) a.className = 'active';
    nav.appendChild(a);
  }

  if (document.body) document.body.insertBefore(nav, document.body.firstChild);
  else document.addEventListener('DOMContentLoaded', () => {
    document.body.insertBefore(nav, document.body.firstChild);
  });
})();`;
}

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
  <script src="/tools-nav.js"></script>
</body></html>`;
}

const BG_UPLOAD_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'themes');
const MUSIC_UPLOAD_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'audio', 'backings');
const MUSIC_JSON = path.join(TOOL_DIR, 'music', 'music.json');
const COSMETIC_RAW_DIR = path.join(PROJECT_ROOT, 'assets-raw', 'cosmetic');
const CAT_RAW_DIR = path.join(PROJECT_ROOT, 'assets-raw');

/**
 * Runs an npm script and resolves on success. Used by the cosmetic
 * upload flow to chain `extract:assets` → `sync:catalog` after writing
 * the new PNG. Stderr is captured into the rejection so the caller can
 * surface it back to the calibrator.
 */
function runScript(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stderr}`));
    });
    child.on('error', reject);
  });
}

/**
 * Read all source intermediate PNGs for a cosmetic (the ones the extractor
 * either decomposed from a GIF or copied from a single PNG source). These
 * are the frames the atlas was packed from — the source of truth we want
 * to recolor.
 *
 * Returns a list keyed by animation, each carrying the original
 * intermediate paths sorted by frame index. Recolor logic iterates these
 * and writes the swapped variants to a new cosmetic folder.
 */
async function listSourceFramesForCosmetic(sourceId) {
  const dir = path.join(COSMETIC_RAW_DIR, sourceId);
  const entries = await fs.readdir(dir).catch(() => []);
  const prefix = `cosmetic_${sourceId}_`;
  const byAnim = new Map();
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.png')) continue;
    const stripped = name.slice(prefix.length, -4); // e.g. "idle_03"
    const m = /^(.+)_(\d+)$/.exec(stripped);
    if (!m) continue;
    const anim = m[1];
    const idx = parseInt(m[2], 10);
    let arr = byAnim.get(anim);
    if (!arr) {
      arr = [];
      byAnim.set(anim, arr);
    }
    arr.push({ idx, srcPath: path.join(dir, name) });
  }
  for (const arr of byAnim.values()) arr.sort((a, b) => a.idx - b.idx);
  return byAnim;
}

/**
 * Pixel-level palette swap on a single PNG. Reads `srcPath`, replaces
 * every exact-hex pixel in `swaps` with its new value, writes to `dstPath`.
 * Alpha is preserved. Sharp's raw buffer interface keeps this fast even
 * across hundreds of frames.
 */
async function recolorPng(srcPath, dstPath, swaps) {
  const img = sharp(srcPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  // Build a hex→[r,g,b] lookup once.
  const lookup = new Map();
  for (const [hex, target] of Object.entries(swaps)) {
    const oldKey = hex.toLowerCase();
    const r = parseInt(target.slice(1, 3), 16);
    const g = parseInt(target.slice(3, 5), 16);
    const b = parseInt(target.slice(5, 7), 16);
    lookup.set(oldKey, [r, g, b]);
  }
  if (lookup.size === 0) {
    // No swaps — just copy.
    await fs.copyFile(srcPath, dstPath);
    return;
  }
  for (let i = 0; i < data.length; i += channels) {
    if (data[i + 3] < 200) continue;
    const key =
      '#' +
      data[i].toString(16).padStart(2, '0') +
      data[i + 1].toString(16).padStart(2, '0') +
      data[i + 2].toString(16).padStart(2, '0');
    const swap = lookup.get(key);
    if (swap) {
      data[i] = swap[0];
      data[i + 1] = swap[1];
      data[i + 2] = swap[2];
    }
  }
  await sharp(data, { raw: { width, height, channels } })
    .png()
    .toFile(dstPath);
}

/**
 * Color-Repick cosmetic variant: reads the source cosmetic's intermediate
 * frame PNGs, applies the supplied hex→hex swap map to every pixel across
 * every animation, writes the result as a new c<N> folder (multi-frame
 * if the source was animated; single-frame if static), then runs extractor
 * + sync-catalog so the new variant shows up in the game.
 *
 * Body shape: JSON { sourceId, swaps: {hex: newHex, ...}, name, slot,
 * rarity, isStatic? }. `isStatic` defaults to the source's flag — if the
 * source was a Quick Add static, the variant is static too and rides the
 * cat's frame offsets via `cat-frame-offsets.json`.
 */
async function handleRepickCosmetic(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { sourceId, swaps, name, slot, rarity } = body;

      if (!sourceId || typeof sourceId !== 'string') throw new Error('sourceId required');
      if (!swaps || typeof swaps !== 'object') throw new Error('swaps required');
      if (!name || typeof name !== 'string' || !name.trim()) throw new Error('name required');
      const allowedSlots = new Set(['head', 'face', 'neck', 'body', 'held']);
      if (!allowedSlots.has(slot)) throw new Error(`slot must be one of ${[...allowedSlots].join(', ')}`);
      const allowedRarities = new Set(['common', 'uncommon', 'rare', 'legendary']);
      if (!allowedRarities.has(rarity)) throw new Error(`rarity must be one of ${[...allowedRarities].join(', ')}`);

      const cosmeticsPath = TOOLS.cosmetics.savePath;
      const cosmeticsRaw = await fs.readFile(cosmeticsPath, 'utf8').catch(() => '[]');
      const cosmetics = JSON.parse(cosmeticsRaw);
      const sourceEntry = cosmetics.find((c) => c?.id === sourceId);
      if (!sourceEntry) throw new Error(`unknown sourceId: ${sourceId}`);

      let maxId = 0;
      for (const entry of cosmetics) {
        const m = /^c(\d+)$/.exec(entry?.id ?? '');
        if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
      }
      const slug = `c${maxId + 1}`;

      // Read source intermediate frames.
      const sourceFrames = await listSourceFramesForCosmetic(sourceId);
      if (sourceFrames.size === 0) {
        throw new Error(
          `no source frames found for ${sourceId} — extract:assets may need to run, or the source has no intermediate PNGs in assets-raw/cosmetic/${sourceId}/`,
        );
      }

      // Write recolored frames to the new cosmetic folder. Multi-frame
      // sources use `<slug>_<anim>_<NN>.png` (the new numbered pattern
      // the extractor handles); single-frame sources just `<slug>_<anim>.png`.
      const outDir = path.join(COSMETIC_RAW_DIR, slug);
      await fs.mkdir(outDir, { recursive: true });
      let totalFrames = 0;
      for (const [anim, frames] of sourceFrames) {
        const multi = frames.length > 1;
        for (const { idx, srcPath } of frames) {
          const dstName = multi
            ? `${slug}_${anim}_${String(idx).padStart(2, '0')}.png`
            : `${slug}_${anim}.png`;
          await recolorPng(srcPath, path.join(outDir, dstName), swaps);
          totalFrames++;
        }
      }
      console.log(`[repick-cosmetic:${slug}] wrote ${totalFrames} recolored frames to ${path.relative(PROJECT_ROOT, outDir)}`);

      // Extract → pack new atlas frames; sync-catalog → typed catalog regen.
      console.log(`[repick-cosmetic:${slug}] extracting…`);
      await runScript('npm', ['run', 'extract:assets']);

      const variantEntry = {
        id: slug,
        name: name.trim(),
        slot,
        rarity,
        offsetX: sourceEntry.offsetX ?? 0,
        offsetY: sourceEntry.offsetY ?? 0,
        scale: sourceEntry.scale ?? 1,
      };
      // Preserve isStatic if the source had it (Quick Add static cosmetic).
      // The variant inherits the same isStatic semantics — single-frame
      // source → static variant; multi-frame source → animated variant.
      if (sourceEntry.isStatic) variantEntry.isStatic = true;
      cosmetics.push(variantEntry);
      await rotateBackups(cosmeticsPath);
      await fs.writeFile(cosmeticsPath, JSON.stringify(cosmetics, null, 2));
      console.log(`[repick-cosmetic:${slug}] catalog entry appended`);

      await runScript('npm', ['run', 'sync:catalog']);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slug, name: variantEntry.name, slot, rarity, frames: totalFrames }));
    } catch (e) {
      console.warn(`[repick-cosmetic] failed: ${e.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

/**
 * List intermediate frame PNGs for a cat breed. Both base cats (cat1–cat6)
 * and Color-Repick variants share the same naming `cat<N>_<anim>_<NN>.png`
 * and same folder structure `assets-raw/cat<N>/`, so this single reader
 * works for both sources. Returns a Map keyed by animation, frames sorted
 * by index.
 */
async function listSourceFramesForCat(sourceBreed) {
  const dir = path.join(CAT_RAW_DIR, sourceBreed);
  const entries = await fs.readdir(dir).catch(() => []);
  const frameRe = new RegExp(`^${sourceBreed}_(.+)_(\\d+)\\.png$`);
  const byAnim = new Map();
  for (const name of entries) {
    const m = frameRe.exec(name);
    if (!m) continue;
    const anim = m[1];
    const idx = parseInt(m[2], 10);
    let arr = byAnim.get(anim);
    if (!arr) {
      arr = [];
      byAnim.set(anim, arr);
    }
    arr.push({ idx, srcPath: path.join(dir, name) });
  }
  for (const arr of byAnim.values()) arr.sort((a, b) => a.idx - b.idx);
  return byAnim;
}

/**
 * Color-Repick cat variant: reads the source cat breed's intermediate
 * frame PNGs, applies the supplied hex→hex swap map to every pixel across
 * every animation, writes the result as a new `assets-raw/cat<N>/` folder
 * with the same naming convention as the base cats. The extractor's
 * auto-discovery picks them up + packs them into the cats atlas, and the
 * frame-offsets emitter re-runs so the new breed has its own per-frame
 * motion data.
 *
 * Body: JSON { sourceId, swaps, name, rarity, scale? }.
 */
async function handleRepickCat(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { sourceId, swaps, name, rarity, scale } = body;

      if (!sourceId || typeof sourceId !== 'string' || !/^cat\d+$/.test(sourceId)) {
        throw new Error('sourceId must look like "cat<N>"');
      }
      if (!swaps || typeof swaps !== 'object') throw new Error('swaps required');
      if (!name || typeof name !== 'string' || !name.trim()) throw new Error('name required');
      const allowedRarities = new Set(['common', 'uncommon', 'rare', 'legendary']);
      if (!allowedRarities.has(rarity)) throw new Error(`rarity must be one of ${[...allowedRarities].join(', ')}`);

      const catsPath = TOOLS.cats.savePath;
      const catsRaw = await fs.readFile(catsPath, 'utf8').catch(() => '[]');
      const cats = JSON.parse(catsRaw);

      // Defensive seed: ensure the 6 base cats + rainbow are always present
      // in cats.json before we write back. The bases live in the catalog
      // because sync-catalog ships them as bootstrap defaults when the file
      // is empty — but once the file has ANY entry, the defaults stop
      // contributing and any missing bases vanish from the catalog. We
      // re-add them here so a /repick-cat call can never strip the bases.
      const BASE_CATS = [
        { id: 'cat1', name: 'Mochi', rarity: 'common' },
        { id: 'cat2', name: 'Biscuit', rarity: 'common' },
        { id: 'cat3', name: 'Pebble', rarity: 'common' },
        { id: 'cat4', name: 'Marble', rarity: 'uncommon' },
        { id: 'cat5', name: 'Saffron', rarity: 'rare' },
        { id: 'cat6', name: 'Inkwell', rarity: 'rare' },
        { id: 'rainbow', name: 'Rainbow Whiskers', rarity: 'legendary' },
      ];
      const existingIds = new Set(cats.map((c) => c?.id));
      for (const base of BASE_CATS) {
        if (!existingIds.has(base.id)) cats.unshift(base);
      }

      // Pick next free `cat<N>`. Scan both catalog entries AND on-disk
      // folders to avoid collisions with breeds that exist on disk but
      // weren't yet added to cats.json.
      let maxId = 0;
      for (const entry of cats) {
        const m = /^cat(\d+)$/.exec(entry?.id ?? '');
        if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
      }
      const rawEntries = await fs.readdir(CAT_RAW_DIR).catch(() => []);
      for (const e of rawEntries) {
        const m = /^cat(\d+)$/.exec(e);
        if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
      }
      const slug = `cat${maxId + 1}`;

      const sourceFrames = await listSourceFramesForCat(sourceId);
      if (sourceFrames.size === 0) {
        throw new Error(
          `no source frames in assets-raw/${sourceId}/ — run extract:assets if this is a base cat without intermediates yet`,
        );
      }

      const outDir = path.join(CAT_RAW_DIR, slug);
      await fs.mkdir(outDir, { recursive: true });
      let totalFrames = 0;
      for (const [anim, frames] of sourceFrames) {
        for (const { idx, srcPath } of frames) {
          const dstName = `${slug}_${anim}_${String(idx).padStart(2, '0')}.png`;
          await recolorPng(srcPath, path.join(outDir, dstName), swaps);
          totalFrames++;
        }
      }
      console.log(`[repick-cat:${slug}] wrote ${totalFrames} recolored frames to ${path.relative(PROJECT_ROOT, outDir)}`);

      console.log(`[repick-cat:${slug}] extracting…`);
      await runScript('npm', ['run', 'extract:assets']);

      const sourceEntry = cats.find((c) => c?.id === sourceId);
      const variantEntry = {
        id: slug,
        name: name.trim(),
        rarity,
      };
      if (typeof scale === 'number') variantEntry.scale = scale;
      else if (sourceEntry?.scale) variantEntry.scale = sourceEntry.scale;
      cats.push(variantEntry);
      await rotateBackups(catsPath);
      await fs.writeFile(catsPath, JSON.stringify(cats, null, 2));
      console.log(`[repick-cat:${slug}] catalog entry appended`);

      await runScript('npm', ['run', 'sync:catalog']);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slug, name: variantEntry.name, rarity, frames: totalFrames }));
    } catch (e) {
      console.warn(`[repick-cat] failed: ${e.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

/**
 * One-shot cosmetic creation: accepts a PNG body + query params
 * (`name`, `slot`, `rarity`). Finds the next free `c<N>` slug, writes
 * `assets-raw/cosmetic/c<N>/c<N>_idle.png`, runs the extractor (which
 * packs the new frame into the cosmetics atlas + emits cat-frame-offsets
 * for the runtime), appends the entry to `tools/cosmetics/cosmetics.json`
 * with sensible defaults, then runs sync:catalog. Returns the new slug.
 *
 * The new cosmetic is automatically a "static" cosmetic (single-frame
 * idle animation); the game's Cat entity rides it through cat motion
 * via `cat-frame-offsets.json` so it bobs without per-frame art.
 */
async function handleUploadCosmetic(req, res, query) {
  const name = (query.get('name') ?? '').trim();
  const slot = (query.get('slot') ?? '').trim();
  const rarity = (query.get('rarity') ?? 'common').trim();
  const allowedSlots = new Set(['head', 'face', 'neck', 'body']);
  const allowedRarities = new Set(['common', 'uncommon', 'rare', 'legendary']);

  if (!name) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'name is required' }));
    return;
  }
  if (!allowedSlots.has(slot)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `slot must be one of ${[...allowedSlots].join(', ')}` }));
    return;
  }
  if (!allowedRarities.has(rarity)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `rarity must be one of ${[...allowedRarities].join(', ')}` }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'empty image upload' }));
        return;
      }

      // Pick the next free slug by scanning the live catalog. Avoids
      // clashing with anything Tim added earlier in the session.
      const cosmeticsPath = TOOLS.cosmetics.savePath;
      const cosmeticsRaw = await fs.readFile(cosmeticsPath, 'utf8').catch(() => '[]');
      const cosmetics = JSON.parse(cosmeticsRaw);
      let maxId = 0;
      for (const entry of cosmetics) {
        const m = /^c(\d+)$/.exec(entry?.id ?? '');
        if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
      }
      const slug = `c${maxId + 1}`;

      // Write the PNG into the canonical extractor input slot.
      const folder = path.join(COSMETIC_RAW_DIR, slug);
      await fs.mkdir(folder, { recursive: true });
      const pngPath = path.join(folder, `${slug}_idle.png`);
      await fs.writeFile(pngPath, buf);
      console.log(`[upload-cosmetic:${slug}] wrote ${buf.length}B → ${path.relative(PROJECT_ROOT, pngPath)}`);

      // Run extractor — this regens both atlases + emits cat-frame-offsets.
      // Long-running (~5-30s) so we hold the HTTP connection open. Tim's
      // upload UI shows a spinner while we wait.
      console.log(`[upload-cosmetic:${slug}] extracting…`);
      await runScript('npm', ['run', 'extract:assets']);

      // Append the catalog entry now that the atlas has the frame. Defaults
      // are tuned for "drop in and it works" — no offset, no scale tweak,
      // calibrator can refine later.
      cosmetics.push({
        id: slug,
        name,
        slot,
        rarity,
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        // Marks this cosmetic as single-frame so the Cat entity rides it
        // through cat-frame-offsets at runtime (bobs/jumps with the cat
        // without per-frame art). Hand-animated cosmetics omit this flag
        // and keep their per-frame motion.
        isStatic: true,
      });
      await rotateBackups(cosmeticsPath);
      await fs.writeFile(cosmeticsPath, JSON.stringify(cosmetics, null, 2));
      console.log(`[upload-cosmetic:${slug}] catalog entry appended`);

      // Regenerate the typed catalog. The devvit playtest watcher picks up
      // the resulting source-file touch and re-uploads automatically.
      await runScript('npm', ['run', 'sync:catalog']);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slug, name, slot, rarity }));
    } catch (e) {
      console.warn(`[upload-cosmetic] failed: ${e.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

/**
 * Accepts raw image bytes from the themes calibrator and writes them to
 * public/assets/themes/<slug>-bg.png. The slug is validated against a
 * conservative charset because it becomes a filename + a code identifier.
 * On success the devvit playtest watcher should re-upload + the
 * Preloader picks the new file up on next reload.
 */
async function handleBgUpload(req, res, slug) {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(slug)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `bad slug: ${slug}` }));
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'empty upload' }));
        return;
      }
      await fs.mkdir(BG_UPLOAD_DIR, { recursive: true });
      const outPath = path.join(BG_UPLOAD_DIR, `${slug}-bg.png`);
      await fs.writeFile(outPath, buf);
      const rel = path.relative(PROJECT_ROOT, outPath);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: rel, bytes: buf.length }));
      console.log(`[upload-bg:${slug}] wrote ${buf.length}B → ${rel}`);
      // vite doesn't watch public/ so a fresh PNG alone won't trigger
      // a re-upload. Re-running sync:catalog rewrites the typed catalog
      // (idempotent if nothing changed) which IS a source file, so vite
      // sees it and devvit playtest re-uploads with the new image.
      scheduleCatalogSync();
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

/**
 * Accepts raw mp3 bytes from the music calibrator. Runs ffmpeg to trim
 * to 32s, downmix to mono, and re-encode at 96kbps so the upload lands
 * the file in the same shape every other backing already has.
 * Appends a default catalog entry to tools/music/music.json (FAST 130
 * UPBEAT; the calibrator UI then lets Tim tune speedLabel / vibe / bpm).
 */
async function handleMusicUpload(req, res, slug) {
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(slug)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `bad slug: ${slug}` }));
    return;
  }
  // Optional defaults via query string — calibrator can drop a file
  // with an opinion attached. Falls back to FAST 130 UPBEAT otherwise.
  const q = new URL(req.url, 'http://localhost').searchParams;
  const displayName = q.get('displayName') || slug;
  const speedLabel = q.get('speedLabel') || 'fast';
  const vibe = q.get('vibe') || 'upbeat';
  const bpm = Number(q.get('bpm')) || 130;

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    let tmpPath = null;
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'empty upload' }));
        return;
      }
      await fs.mkdir(MUSIC_UPLOAD_DIR, { recursive: true });
      // Write raw upload to a temp file, then run ffmpeg into the final
      // path so a half-finished encode never leaves a corrupt mp3 in
      // the catalog dir.
      tmpPath = path.join(MUSIC_UPLOAD_DIR, `.${slug}.upload.mp3`);
      const outPath = path.join(MUSIC_UPLOAD_DIR, `${slug}.mp3`);
      await fs.writeFile(tmpPath, buf);

      await new Promise((resolve, reject) => {
        const ff = spawn(
          'ffmpeg',
          [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', tmpPath,
            '-t', '32',
            '-ac', '1',
            '-ar', '44100',
            '-b:a', '96k',
            outPath,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        ff.stderr.on('data', (b) => { stderr += b.toString(); });
        ff.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim()}`));
        });
      });

      // Read existing music.json (if any), add the new entry, write back.
      let raw = {};
      try {
        raw = JSON.parse(await fs.readFile(MUSIC_JSON, 'utf8'));
      } catch {
        // first upload — file might not exist yet
      }
      raw[slug] = {
        id: slug,
        displayName,
        speedLabel,
        vibe,
        bpm,
        loopDurationMs: 30000,
      };
      await rotateBackups(MUSIC_JSON);
      await fs.writeFile(MUSIC_JSON, JSON.stringify(raw, null, 2) + '\n');

      const finalBytes = (await fs.stat(outPath)).size;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        path: path.relative(PROJECT_ROOT, outPath),
        bytes: finalBytes,
        entry: raw[slug],
      }));
      console.log(`[upload-music:${slug}] ${buf.length}B raw → ${finalBytes}B mp3, catalog updated`);
      scheduleCatalogSync();
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    } finally {
      if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
    }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // --- POST /upload-bg/<slug> ----------------------------------------
    if (req.method === 'POST' && req.url?.startsWith('/upload-bg/')) {
      const slug = req.url.replace(/^\/upload-bg\//, '').split('?')[0];
      await handleBgUpload(req, res, slug);
      return;
    }

    // --- POST /upload-music/<slug>?displayName=...&vibe=...&bpm=... ----
    if (req.method === 'POST' && req.url?.startsWith('/upload-music/')) {
      const slug = req.url.replace(/^\/upload-music\//, '').split('?')[0];
      await handleMusicUpload(req, res, slug);
      return;
    }

    // --- DELETE /music/<slug> ------------------------------------------
    if (req.method === 'DELETE' && req.url?.startsWith('/music/')) {
      const slug = req.url.replace(/^\/music\//, '').split('?')[0];
      try {
        let raw = {};
        try { raw = JSON.parse(await fs.readFile(MUSIC_JSON, 'utf8')); } catch {}
        if (raw[slug]) {
          delete raw[slug];
          await rotateBackups(MUSIC_JSON);
          await fs.writeFile(MUSIC_JSON, JSON.stringify(raw, null, 2) + '\n');
        }
        await fs.unlink(path.join(MUSIC_UPLOAD_DIR, `${slug}.mp3`)).catch(() => {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug }));
        console.log(`[delete-music:${slug}] removed`);
        scheduleCatalogSync();
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // --- POST /upload-cosmetic?name=...&slot=...&rarity=... -----------
    if (req.method === 'POST' && req.url?.startsWith('/upload-cosmetic')) {
      const q = new URL(req.url, 'http://localhost').searchParams;
      await handleUploadCosmetic(req, res, q);
      return;
    }

    // --- POST /repick-cosmetic ----------------------------------------
    // JSON body: { sourceId, swaps: {hex: newHex}, name, slot, rarity }
    if (req.method === 'POST' && req.url?.startsWith('/repick-cosmetic')) {
      await handleRepickCosmetic(req, res);
      return;
    }

    // --- POST /repick-cat ---------------------------------------------
    // JSON body: { sourceId: "cat<N>", swaps, name, rarity, scale? }
    if (req.method === 'POST' && req.url?.startsWith('/repick-cat')) {
      await handleRepickCat(req, res);
      return;
    }

    // --- GET /tools-nav.js --------------------------------------------
    // Universal top-bar nav injected by every tool page. Generated from
    // the live TOOLS table so adding a new tool auto-appears in the bar
    // — no per-tool HTML edit needed.
    if (req.method === 'GET' && req.url === '/tools-nav.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': NO_CACHE,
      });
      res.end(toolsNavJs());
      return;
    }

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
