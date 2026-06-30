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
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { extractTapsForSong } from '../scripts/lib/extract-taps-for-song.mjs';
import {
  probeDurationSeconds,
  extractRmsBins,
  findBestSectionStart,
  reclipFromSource,
  CLIP_DURATION_S,
  WAVEFORM_BIN_MS,
} from '../scripts/lib/music-section.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const PORT = Number(process.env.PORT) || 3000;
const NO_CACHE = 'no-store, no-cache, must-revalidate';

// Tiny inline .env loader — no dep on dotenv. Loaded once at startup.
// Only used by /api/* endpoints that need API keys; keys stay server-side,
// never reach the browser.
async function loadEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  try {
    const txt = await fs.readFile(envPath, 'utf8');
    const out = {};
    for (const line of txt.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line.trim());
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}
const ENV = await loadEnv();

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
    description: 'Tempo, vibe, BPM, genre + mood per backing track. Drop an MP3 to add a new song; ffmpeg auto-detects the hyped 65 s chorus section + downmixes to 96kbps mono. Waveform editor lets you override the auto-pick.',
  },
  prompts: {
    label: 'Prompt Generator',
    href: '/tools/prompts/generator.html',
    // No save endpoint — purely client-side prompt generation. Path
    // is set so the TOOLS table stays uniform; nothing reads it.
    savePath: path.join(TOOL_DIR, 'prompts', 'prompts.json'),
    description: 'Fresh background + music prompts on demand. Tap regenerate to roll new ones matched to the game vibe; tap a prompt to copy.',
  },
  'commit-wip': {
    label: 'Commit WIP',
    href: '/tools/commit-wip/index.html',
    // No save endpoint — uses /git-status (GET) + /commit-wip (POST)
    // that shell out to git directly. Path here is uniform with the
    // TOOLS table convention; nothing reads it.
    savePath: path.join(TOOL_DIR, 'commit-wip', 'placeholder.json'),
    description: 'One-tap commit of the entire working tree. Lists every modified + untracked file, lets you set a message, and runs git add -A + git commit so content drops never get lost.',
  },
  'cosmetic-quick-add': {
    label: 'Cosmetic Quick Add',
    href: '/tools/cosmetics/quick-add.html',
    // Reuses the cosmetics catalog — no dedicated save endpoint, the
    // upload handler writes directly + runs extract + sync-catalog.
    savePath: path.join(TOOL_DIR, 'cosmetics', 'cosmetics.json'),
    description: 'Upload one PNG → fully integrated cosmetic (static + rides cat motion).',
  },
  'smoke-test-small': {
    label: 'Cosmetic Smoke (small)',
    href: '/tools/cats/smoke-small-lick.html',
    // Generated artifact — gitignored. 14 representative cats × 43 base
    // cosmetics × 4 anims (idle/hiss/lick/meow), animated live in the
    // browser. Replaces the full 116×498 sweep which melted Tim's
    // laptop. Regenerate via the Generate button on the page or
    // `npm run smoke-test:small`.
    savePath: path.join(TOOL_DIR, 'cats', 'smoke-small-lick.html'),
    description: '14 cats × 43 base cosmetics × 4 anims, live CSS playback. 2 cats per visible variety (hand-drawn / legendary / neon / pastel split / themed split / common two-tone / solid). Run `npm run smoke-test:small` to regenerate.',
  },
  'cosmetic-variants': {
    label: 'Cosmetic Color Variants',
    href: '/tools/cosmetics/variants/index.html',
    // Generated artifact — base cosmetic + 10 hue-rotated variants per item.
    // HSL-aware rotation preserves shadow/highlight relationships within
    // the new hue. Replaces the old flat-tint variants in the catalog.
    // Use the Generate button on the page or `npm run cosmetic-variants`.
    savePath: path.join(TOOL_DIR, 'cosmetics', 'variants', 'index.html'),
    description: 'Per-base 10-hue color exploration. Use to pick which hue-rotated variants to ship as catalog cosmetics; the page shows the same HSL rotation the runtime would apply if we move to per-pixel recoloring.',
  },
  'catalog': {
    label: 'Catalogs',
    href: '/tools/catalog/index.html',
    // Generated PNG grids of every cosmetic + every cat. Pulled from the
    // atlas live so they always reflect current catalog state.
    savePath: path.join(TOOL_DIR, 'catalog', 'index.html'),
    description: 'Reference catalog images — every cosmetic in one grid, every cat in another. Live from the atlas, regenerable from the page.',
  },
  'marketing': {
    label: 'Marketing',
    href: '/tools/marketing/index.html',
    // Final marketing assets (logo + Reddit banner + dev.to banner) with
    // SVG and PNG download links. Source generators live in PM-OS, copies
    // here so the assets are accessible from the tools nav.
    savePath: path.join(TOOL_DIR, 'marketing', 'index.html'),
    description: 'V21 logo + Reddit subreddit banner + dev.to article cover. SVG + PNG downloads for each.',
  },
  'effects': {
    label: 'Effects Smoke',
    href: '/tools/effects/index.html',
    // Live preview grid of every candidate cat-effect (stagelights, halos,
    // beams, pulses, orbiters, tints, floor, weather, decor, misc). Tickbox
    // per card persists to selections.json so picks survive reloads. After
    // Tim ticks favorites, ship the chosen ones to src/client/effects/
    // cat-effects.ts as full TS entries. Vanilla canvas — no Phaser load.
    savePath: path.join(TOOL_DIR, 'effects', 'selections.json'),
    description: 'Candidate effects beyond floating-emoji particles. Tick the ones to ship; selections persist to tools/effects/selections.json. Cards lazy-render via IntersectionObserver so the grid scrolls smoothly.',
  },
  'user-management': {
    label: 'User Management',
    href: '/tools/user-management/index.html',
    // Per-user dev overrides — tutorialCheck (force tutorial replay on
    // next game open; auto-clears on completion via /dev/clear-tutorial-
    // check endpoint) + godmode (unlock everything on load). Temp tooling
    // — talk before relying on it in shipped builds. The game runtime
    // reads from src/shared/user-overrides.generated.ts which sync-catalog
    // regenerates from users.json on every save.
    savePath: path.join(TOOL_DIR, 'user-management', 'users.json'),
    description: 'Per-user dev overrides — force tutorial replay + godmode unlocks.',
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
  if (window.__meowcertToolsNavInjected) return;
  window.__meowcertToolsNavInjected = true;
  const tools = ${JSON.stringify(tools)};
  const path = window.location.pathname;

  const style = document.createElement('style');
  style.textContent = [
    '#meowcert-tools-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 9999;',
    '  background: #0d041b; padding: 7px 14px;',
    '  display: flex; gap: 4px; flex-wrap: wrap; align-items: center;',
    '  border-bottom: 1px solid #341c5a;',
    '  font-family: system-ui, sans-serif; font-size: 12px;',
    '  box-shadow: 0 2px 8px rgba(0,0,0,0.3); }',
    '#meowcert-tools-nav a { color: #c0a0e6; text-decoration: none;',
    '  padding: 4px 10px; border-radius: 4px;',
    '  transition: background 0.1s, color 0.1s; }',
    '#meowcert-tools-nav a:hover { background: #261540; color: #fff; }',
    '#meowcert-tools-nav a.active { background: #ffd34d; color: #1a0a2e; font-weight: 700; }',
    '#meowcert-tools-nav .brand { color: #ffd34d; font-weight: 700; margin-right: 10px;',
    '  letter-spacing: 0.5px; }',
    'body { padding-top: 40px !important; }'
  ].join('\\n');
  document.head.appendChild(style);

  const nav = document.createElement('nav');
  nav.id = 'meowcert-tools-nav';

  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = '🐾 meowcert tools';
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
  <meta charset="utf-8" /><title>meowcert tools</title>
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
  <h1>meowcert · dev tools</h1>
  <ul>${rows}</ul>
  <script src="/tools-nav.js"></script>
</body></html>`;
}

const BG_UPLOAD_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'themes');
const MUSIC_UPLOAD_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'audio', 'backings');
const TAPS_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'audio', 'taps');
const MUSIC_JSON = path.join(TOOL_DIR, 'music', 'music.json');
const MUSIC_TAXONOMIES_JSON = path.join(TOOL_DIR, 'music', 'taxonomies.json');
// Preserved raw uploads — the calibrator's section editor needs the
// FULL source to recompute the waveform + let the user pick any
// 65-second window. Kept separate from MUSIC_UPLOAD_DIR so the
// production-served backings stay slim.
const MUSIC_SOURCES_DIR = path.join(TOOL_DIR, 'music', 'sources');
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
async function handleDescribeBg(req, res) {
  if (!ENV.GEMINI_API_KEY) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'GEMINI_API_KEY missing from .env' }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const buf = Buffer.concat(chunks);
    if (buf.length < 100) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'image body too small' }));
      return;
    }
    const mime = (req.headers['content-type'] || 'image/png').split(';')[0].trim();
    try {
      const apiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${ENV.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { inline_data: { mime_type: mime, data: buf.toString('base64') } },
                  {
                    text:
                      'This is a pixel-art game background. Give it a short, evocative 2-4 word title that captures the scene (examples: "Pirate Treasure Cove", "Crystal Geode Cave", "Sunken Atlantis Ruins", "Cherry Blossom Tunnel", "F1 Pit Garage"). Output ONLY the title, no quotes, no punctuation other than spaces, no explanation, no extra words.',
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 128,
              // 2.5 Flash burns "thinking" tokens before producing output;
              // disabling thinking gives us faster + cheaper naming calls.
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      );
      const text = await apiRes.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!apiRes.ok) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `gemini ${apiRes.status}`, detail: json }));
        return;
      }
      const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      const title = (raw ?? '').trim().replace(/^["']|["']$/g, '').slice(0, 60);
      if (!title) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no title in response', detail: json }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, title }));
    } catch (e) {
      console.warn(`[describe-bg] failed: ${e.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

/**
 * Regenerate a single theme's picker thumbnail from the on-disk bg PNG.
 * Same shape as the tools/gen-thumbs.mjs backfill — 200x360 cover-fit,
 * 128-color palette, max-effort compression. Idempotent: overwrites any
 * existing thumb so the calibrator user can re-save after replacing a
 * bg image.
 */
async function handleSaveThumb(res, slug) {
  if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(slug)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `bad slug: ${slug}` }));
    return;
  }
  try {
    const src = path.join(BG_UPLOAD_DIR, `${slug}-bg.png`);
    try {
      await fs.access(src);
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `bg not found: ${slug}-bg.png` }));
      return;
    }
    const thumbsDir = path.join(BG_UPLOAD_DIR, 'thumbs');
    await fs.mkdir(thumbsDir, { recursive: true });
    const dst = path.join(thumbsDir, `${slug}-thumb.png`);
    await sharp(src)
      .resize(200, 360, { fit: 'cover', position: 'centre' })
      .png({ palette: true, colours: 128, quality: 80, compressionLevel: 9, effort: 10 })
      .toFile(dst);
    const stat = await fs.stat(dst);
    const rel = path.relative(PROJECT_ROOT, dst);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: rel, bytes: stat.size }));
    console.log(`[save-thumb:${slug}] wrote ${stat.size}B → ${rel}`);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/**
 * POST /run-smoke-test — nuke every existing smoke-anim artifact and
 * regenerate all 4 anim pages (idle/hiss/lick/meow) from current atlas
 * + catalog. The smoke test pages render runtime-accurate composites,
 * so they're the fastest way to eyeball cosmetic positioning bugs
 * without having to set up state in-game. Run after any catalog drag,
 * extract:assets, or cat.ts math change.
 *
 * Safe to retry — the script's first action per anim is to delete the
 * old PNGs in tools/cats/smoke-anim-<anim>/. We additionally delete the
 * .html files and any orphaned anim dirs (e.g. "sleep" from earlier
 * runs) so the output is exactly the current package.json `smoke-test`
 * matrix and nothing else.
 */
async function handleRunSmokeTest(res, { small = false } = {}) {
  const prefix = small ? 'smoke-small-' : 'smoke-anim-';
  const npmScript = small ? 'smoke-test:small' : 'smoke-test';
  const tag = small ? 'run-smoke-test-small' : 'run-smoke-test';
  try {
    const catsDir = path.join(TOOL_DIR, 'cats');
    const entries = await fs.readdir(catsDir).catch(() => []);
    let deleted = 0;
    for (const name of entries) {
      if (name.startsWith(prefix)) {
        const target = path.join(catsDir, name);
        await fs.rm(target, { recursive: true, force: true });
        deleted++;
      }
    }
    console.log(`[${tag}] cleared ${deleted} stale artifact(s) from ${path.relative(PROJECT_ROOT, catsDir)}`);
    const { stdout } = await runScript('npm', ['run', npmScript]);
    const summary = stdout
      .split('\n')
      .filter((l) => l.startsWith('✓') || l.startsWith('  ...'))
      .slice(-8)
      .join(' | ');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted, summary }));
    console.log(`[${tag}] regenerated — ${summary}`);
  } catch (e) {
    console.warn(`[${tag}] failed: ${e.message}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/**
 * POST /run-cosmetic-variants — wipe + regen the color-variants explorer.
 * Mirrors handleRunSmokeTest: the script itself clears stale imgs and
 * rewrites index.html, so all this handler needs is to spawn it and
 * surface success/failure to the page so the Generate button can react.
 */
async function handleRunCosmeticVariants(res) {
  try {
    const { stdout } = await runScript('npm', ['run', 'cosmetic-variants']);
    const summary = stdout
      .split('\n')
      .filter((l) => l.startsWith('Wrote') || l.startsWith('Generating'))
      .slice(-2)
      .join(' | ');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, summary }));
    console.log(`[run-cosmetic-variants] regenerated — ${summary}`);
  } catch (e) {
    console.warn(`[run-cosmetic-variants] failed: ${e.message}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/**
 * POST /run-catalogs — regenerate the cosmetics + cats catalog PNGs.
 * Spawns the gen-catalogs.py script; the page reloads on success so
 * the new PNGs render with cache-busted img tags.
 */
async function handleRunCatalogs(res) {
  try {
    const { stdout } = await runScript('npm', ['run', 'catalogs']);
    const summary = stdout
      .split('\n')
      .filter((l) => l.includes('-catalog.png') || l.startsWith('Wrote'))
      .join(' | ');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, summary }));
    console.log(`[run-catalogs] ${summary}`);
  } catch (e) {
    console.warn(`[run-catalogs] failed: ${e.message}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/**
 * POST /save-effect-selections — persist Tim's ticked effect smoketest picks
 * AND any per-effect freeform notes typed into the card textareas.
 * Body: { selected: [effectId, ...], notes?: { effectId: 'text', ... }, timestamp, totalAvailable }.
 * Writes to tools/effects/selections.json. The effects smoketest page
 * reads this file back on load so tickboxes + notes survive reloads. A
 * future ship-effects script can read it to know which candidates Tim
 * wants promoted to src/client/effects/cat-effects.ts and what to change
 * about each one.
 */
async function handleSaveEffectSelections(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body !== 'object' || body === null || !Array.isArray(body.selected)) {
        throw new Error('expected { selected: [string], ... }');
      }
      if (body.notes != null) {
        if (typeof body.notes !== 'object' || Array.isArray(body.notes)) {
          throw new Error('notes must be an object keyed by effect id');
        }
        for (const [k, v] of Object.entries(body.notes)) {
          if (typeof v !== 'string') throw new Error(`notes.${k} must be a string`);
        }
      }
      if (body.categoryPrompts != null) {
        if (typeof body.categoryPrompts !== 'object' || Array.isArray(body.categoryPrompts)) {
          throw new Error('categoryPrompts must be an object keyed by category name');
        }
        for (const [k, v] of Object.entries(body.categoryPrompts)) {
          if (typeof v !== 'string') throw new Error(`categoryPrompts.${k} must be a string`);
        }
      }
      const target = path.join(TOOL_DIR, 'effects', 'selections.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(body, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' });
      const noteCount = body.notes ? Object.keys(body.notes).length : 0;
      const promptCount = body.categoryPrompts ? Object.keys(body.categoryPrompts).length : 0;
      res.end(JSON.stringify({ ok: true, count: body.selected.length, notes: noteCount, prompts: promptCount }));
      console.log(`[save-effect-selections] wrote ${body.selected.length} picks, ${noteCount} notes, ${promptCount} category prompts`);
    } catch (e) {
      console.warn(`[save-effect-selections] ${e.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

/**
 * POST /save-variant-selections — persist Tim's ticked cosmetic variants.
 * Body is the full selections object so this is idempotent (no diffing).
 * Writes to tools/cosmetics/variants/selections.json. A regen of the
 * variants page reads this file back so checkmarks survive.
 */
async function handleSaveVariantSelections(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error('expected an object keyed by cosmetic id');
      }
      const target = path.join(TOOL_DIR, 'cosmetics', 'variants', 'selections.json');
      await fs.writeFile(target, JSON.stringify(body, null, 2));
      const count = Object.values(body).reduce((acc, arr) => acc + (arr?.length || 0), 0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count }));
    } catch (e) {
      console.warn(`[save-variant-selections] ${e.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

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
 * Accepts raw mp3 bytes from the music calibrator. Runs ffmpeg with:
 *   1. `silenceremove` to clip leading silence / soft intro so the
 *      backing starts on something the player can actually hear.
 *   2. `-t 62` to cut a 62-second clip (the 60-second round + 2 s
 *      breathing room before the loop seam).
 *   3. Fade-in (350 ms) + fade-out (1.5 s) to mask the seam when
 *      Phaser loops the audio — end of clip eases to silence, start
 *      eases back up, so the cut reads as a breath instead of a jump.
 *   4. Downmix to mono + re-encode at 96 kbps so every backing in the
 *      catalog has the same shape.
 * Appends a default catalog entry to tools/music/music.json (FAST 130
 * UPBEAT; the calibrator UI lets Tim tune speedLabel / vibe / bpm).
 * Mirrors the retroactive script at scripts/audio/reprocess-backings.py.
 */
async function handleMusicUpload(req, res, slug) {
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(slug)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `bad slug: ${slug}` }));
    return;
  }
  // Optional defaults via query string — calibrator's tune-metadata
  // modal can pass all of these. Falls back to FAST 130 UPBEAT + no
  // genre/mood (server-side guess happens in the calibrator's render
  // pass via guessGenreMood).
  const q = new URL(req.url, 'http://localhost').searchParams;
  const displayName = q.get('displayName') || slug;
  const speedLabel = q.get('speedLabel') || 'fast';
  const vibe = q.get('vibe') || 'upbeat';
  const bpm = Number(q.get('bpm')) || 130;
  const genre = q.get('genre') || undefined;
  const mood = q.get('mood') || undefined;

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
      await fs.mkdir(MUSIC_SOURCES_DIR, { recursive: true });
      // Source preserved in tools/music/sources/<slug>.src so the
      // calibrator's waveform editor can re-clip from the original
      // bytes. Final clip lives in the production backings dir.
      const srcPath = path.join(MUSIC_SOURCES_DIR, `${slug}.src`);
      const outPath = path.join(MUSIC_UPLOAD_DIR, `${slug}.mp3`);
      // tmpPath kept for backwards-compat with the finally cleanup
      // block, but we no longer write to it.
      tmpPath = null;
      await fs.writeFile(srcPath, buf);

      // Section auto-detect: probe the source, compute per-100ms RMS
      // bins, score every 65-second window, pick the highest. Falls
      // back to startS=0 for sources shorter than CLIP_DURATION_S.
      let bestStart = 0;
      try {
        const duration = await probeDurationSeconds(srcPath);
        if (duration >= CLIP_DURATION_S) {
          const bins = await extractRmsBins(srcPath);
          const result = findBestSectionStart(bins, duration);
          bestStart = result.bestStart;
        }
      } catch (e) {
        console.warn(`[upload-music:${slug}] section-detect failed, using start=0:`, e.message);
      }

      // Clip 65 s starting at the auto-detected best section. Tim can
      // override later via the calibrator's waveform editor →
      // /music-reclip/<slug>.
      await reclipFromSource(srcPath, outPath, bestStart, CLIP_DURATION_S);

      // Read existing music.json (if any), add the new entry, write back.
      let raw = {};
      try {
        raw = JSON.parse(await fs.readFile(MUSIC_JSON, 'utf8'));
      } catch {
        // first upload — file might not exist yet
      }
      // Preserve addedAt if the slug already had one (re-upload doesn't
      // restart the clock); otherwise stamp now. addedAt is calibrator-
      // only metadata — the runtime BackingTrack type doesn't care.
      const addedAt = (raw[slug] && raw[slug].addedAt) || Date.now();
      raw[slug] = {
        id: slug,
        displayName,
        speedLabel,
        vibe,
        bpm,
        loopDurationMs: CLIP_DURATION_S * 1000,
        clipStartS: bestStart,
        addedAt,
        ...(genre ? { genre } : {}),
        ...(mood ? { mood } : {}),
      };
      await rotateBackups(MUSIC_JSON);
      await fs.writeFile(MUSIC_JSON, JSON.stringify(raw, null, 2) + '\n');

      const finalBytes = (await fs.stat(outPath)).size;

      // Auto-extract the 3 per-lane tap samples for the new song. Lives
      // in the same response cycle so the upload-complete UI signal
      // means "song + taps are both ready". Failure here doesn't block
      // the upload — MusicSystem falls back to the per-vibe NoteSynth
      // for any lane whose sample is missing.
      try {
        await extractTapsForSong(outPath, TAPS_DIR, slug);
        console.log(`[upload-music:${slug}] tap samples extracted`);
      } catch (tapsErr) {
        console.warn(`[upload-music:${slug}] tap-extract failed:`, tapsErr.message);
      }

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

/**
 * Spawn a git subprocess and collect stdout + stderr. Resolves with both
 * even on non-zero exit so the caller can surface real git error messages
 * to the UI instead of a generic "command failed".
 */
function runGit(args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: PROJECT_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // --- GET /git-status ----------------------------------------------
    // Reports the current branch + every uncommitted file so the
    // Commit WIP tool can render a checklist before the user commits.
    if (req.method === 'GET' && (req.url === '/git-status' || req.url?.startsWith('/git-status?'))) {
      const [branch, status] = await Promise.all([
        runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
        runGit(['status', '--porcelain']),
      ]);
      if (branch.code !== 0 || status.code !== 0) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: branch.stderr.trim() || status.stderr.trim() || 'git failed',
        }));
        return;
      }
      const files = status.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3),
        }));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': NO_CACHE });
      res.end(JSON.stringify({
        ok: true,
        branch: branch.stdout.trim(),
        files,
      }));
      return;
    }

    // --- POST /commit-wip ---------------------------------------------
    // Body: { message: string }. Runs `git add -A && git commit -m
    // "<message>"`. Returns the new commit SHA on success, or "nothing
    // to commit" if the working tree is clean. Never pushes — keep
    // remote ops manual.
    if (req.method === 'POST' && req.url === '/commit-wip') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const message = (parsed.message ?? '').toString().trim();
          if (!message) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'commit message is required' }));
            return;
          }
          const add = await runGit(['add', '-A']);
          if (add.code !== 0) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `git add: ${add.stderr.trim()}` }));
            return;
          }
          const status = await runGit(['status', '--porcelain']);
          if (!status.stdout.trim()) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, nothing: true }));
            return;
          }
          const commit = await runGit(['commit', '-m', message]);
          if (commit.code !== 0) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `git commit: ${commit.stderr.trim() || commit.stdout.trim()}` }));
            return;
          }
          const sha = await runGit(['rev-parse', '--short', 'HEAD']);
          const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            sha: sha.stdout.trim(),
            branch: branch.stdout.trim(),
            summary: commit.stdout.trim(),
          }));
          console.log(`[commit-wip] ${branch.stdout.trim()} ${sha.stdout.trim()} ${message}`);
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // --- POST /upload-bg/<slug> ----------------------------------------
    if (req.method === 'POST' && req.url?.startsWith('/upload-bg/')) {
      const slug = req.url.replace(/^\/upload-bg\//, '').split('?')[0];
      await handleBgUpload(req, res, slug);
      return;
    }

    // --- POST /save-thumb/<slug> --------------------------------------
    // Regenerate the picker thumbnail for a single theme. Reads the
    // current bg PNG from disk, runs the same sharp resize the
    // tools/gen-thumbs.mjs backfill script uses, writes to
    // public/assets/themes/thumbs/<slug>-thumb.png. No body required.
    if (req.method === 'POST' && req.url?.startsWith('/save-thumb/')) {
      const slug = req.url.replace(/^\/save-thumb\//, '').split('?')[0];
      await handleSaveThumb(res, slug);
      return;
    }

    // --- POST /run-smoke-test ----------------------------------------
    // Wipes tools/cats/smoke-anim-*.html + smoke-anim-*/ dirs and runs
    // `npm run smoke-test` to regenerate all 4 anim pages from current
    // atlas + catalog. Used by the Generate button on each smoke-anim
    // page so cosmetic-positioning bugs can be re-checked in seconds
    // without rebuilding game state.
    if (req.method === 'POST' && req.url === '/run-smoke-test') {
      await handleRunSmokeTest(res);
      return;
    }
    if (req.method === 'POST' && req.url === '/run-smoke-test-small') {
      await handleRunSmokeTest(res, { small: true });
      return;
    }

    // --- POST /run-cosmetic-variants ---------------------------------
    // Regenerates the 10-hue color-variants explorer for every base
    // cosmetic. The page's own Generate button hits this; the script
    // wipes tools/cosmetics/variants/imgs/* first so deleted cosmetics
    // don't leave orphans.
    if (req.method === 'POST' && req.url === '/run-cosmetic-variants') {
      await handleRunCosmeticVariants(res);
      return;
    }

    // --- POST /run-catalogs ------------------------------------------
    // Regenerates cosmetics-catalog.png + cats-catalog.png from the
    // current atlas + catalog files. The Catalogs page's Generate
    // button hits this so the snapshots stay in sync with whatever
    // got shipped most recently.
    if (req.method === 'POST' && req.url === '/run-catalogs') {
      await handleRunCatalogs(res);
      return;
    }

    // --- POST /save-variant-selections -------------------------------
    // Body: { "c18": ["all_red","cluster0_blue",...], "c24": [...] }
    // Persisted to tools/cosmetics/variants/selections.json so picks
    // survive page reloads + regenerations. A future
    // ship-selected-variants script can read this file to know which
    // tinted cosmetics to add to the catalog.
    if (req.method === 'POST' && req.url === '/save-variant-selections') {
      await handleSaveVariantSelections(req, res);
      return;
    }

    // --- POST /save-effect-selections --------------------------------
    // Body: { selected: ['effect-halo-golden', ...], timestamp, totalAvailable }
    // Persisted to tools/effects/selections.json so tickboxes survive
    // page reloads. A future ship-effects script reads this file to know
    // which candidates Tim wants promoted to cat-effects.ts.
    if (req.method === 'POST' && req.url === '/save-effect-selections') {
      await handleSaveEffectSelections(req, res);
      return;
    }

    // --- POST /api/describe-bg ----------------------------------------
    // Body: raw image bytes (image/png or image/jpeg).
    // Calls Google Gemini 2.5 Flash vision with a tight naming prompt;
    // returns { ok, title } so the themes calibrator's bulk-upload flow
    // can auto-name new themes from the image content instead of the
    // filename. Falls back gracefully if GEMINI_API_KEY is missing.
    if (req.method === 'POST' && req.url === '/api/describe-bg') {
      await handleDescribeBg(req, res);
      return;
    }

    // --- POST /upload-music/<slug>?displayName=...&vibe=...&bpm=... ----
    if (req.method === 'POST' && req.url?.startsWith('/upload-music/')) {
      const slug = req.url.replace(/^\/upload-music\//, '').split('?')[0];
      await handleMusicUpload(req, res, slug);
      return;
    }

    // --- POST /music-taxonomy/add?kind=<genres|moods>&value=<slug> -----
    // Appends a new value to the genre/mood taxonomy. Calibrator
    // dropdowns offer "+ add new…" which prompts the user then POSTs
    // here. Slugifies the value, deduplicates, persists back to
    // tools/music/taxonomies.json. Returns the new full list.
    if (req.method === 'POST' && req.url?.startsWith('/music-taxonomy/add')) {
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const kind = q.get('kind');
        const rawValue = q.get('value');
        if (kind !== 'genres' && kind !== 'moods' && kind !== 'vibes') {
          throw new Error(`bad kind: ${kind}`);
        }
        if (!rawValue || rawValue.trim().length === 0) {
          throw new Error('value required');
        }
        // Reuse the same slugify as filename → slug so calibrator-typed
        // values normalize consistently with existing entries.
        const slug = rawValue
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40);
        if (!slug) throw new Error(`value slugifies to empty: "${rawValue}"`);
        let tax = { vibes: [], genres: [], moods: [] };
        try {
          tax = JSON.parse(await fs.readFile(MUSIC_TAXONOMIES_JSON, 'utf8'));
        } catch {
          // first run — fall through to default empty + ensure file exists below
        }
        if (!Array.isArray(tax[kind])) tax[kind] = [];
        if (!tax[kind].includes(slug)) {
          tax[kind].push(slug);
          await fs.writeFile(MUSIC_TAXONOMIES_JSON, JSON.stringify(tax, null, 2) + '\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug, list: tax[kind] }));
        console.log(`[music-taxonomy] added ${kind} = ${slug}`);
        // Regenerate music-catalog.generated.ts so the game's SongPicker
        // (which imports BACKING_VIBES/GENRES/MOODS from the generated
        // file) picks up the new value on the next bundle rebuild.
        scheduleCatalogSync();
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // --- GET /music-source/<slug> --------------------------------------
    // Returns the preserved raw source mp3 with HTTP Range support so
    // the calibrator's waveform editor can seek + play any sub-region.
    // Without `Accept-Ranges: bytes` + a 206 path, browsers silently
    // fail to honor `audio.currentTime = X` before the buffer is fully
    // loaded — the "play selection always starts at 0s" bug. Falls back
    // to the already-clipped backing if no source exists.
    if (req.method === 'GET' && req.url?.startsWith('/music-source/')) {
      const slug = req.url.replace(/^\/music-source\//, '').split('?')[0];
      try {
        let p = path.join(MUSIC_SOURCES_DIR, `${slug}.src`);
        try { await fs.access(p); } catch {
          p = path.join(MUSIC_UPLOAD_DIR, `${slug}.mp3`);
        }
        const stat = await fs.stat(p);
        const range = req.headers.range;
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
            if (Number.isFinite(start) && end >= start && end < stat.size) {
              res.writeHead(206, {
                'content-type': 'audio/mpeg',
                'content-range': `bytes ${start}-${end}/${stat.size}`,
                'accept-ranges': 'bytes',
                'content-length': end - start + 1,
                'cache-control': NO_CACHE,
              });
              createReadStream(p, { start, end }).pipe(res);
              return;
            }
          }
        }
        // No range request → return full file but ADVERTISE range
        // support via Accept-Ranges so the audio element knows to
        // request byte ranges on seek.
        res.writeHead(200, {
          'content-type': 'audio/mpeg',
          'accept-ranges': 'bytes',
          'content-length': stat.size,
          'cache-control': NO_CACHE,
        });
        createReadStream(p).pipe(res);
      } catch (e) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // --- GET /music-analyze/<slug> -------------------------------------
    // Returns waveform bins + auto-detected best start for the editor UI.
    // Uses the preserved source if available; falls back to the clipped
    // backing (in which case the waveform shows the existing clip only).
    if (req.method === 'GET' && req.url?.startsWith('/music-analyze/')) {
      const slug = req.url.replace(/^\/music-analyze\//, '').split('?')[0];
      try {
        let p = path.join(MUSIC_SOURCES_DIR, `${slug}.src`);
        let hasSource = true;
        try { await fs.access(p); } catch {
          p = path.join(MUSIC_UPLOAD_DIR, `${slug}.mp3`);
          hasSource = false;
        }
        const duration = await probeDurationSeconds(p);
        const bins = await extractRmsBins(p);
        const { bestStart } = findBestSectionStart(bins, duration);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': NO_CACHE });
        res.end(JSON.stringify({
          ok: true,
          duration,
          bins,
          binMs: WAVEFORM_BIN_MS,
          bestStart,
          clipDuration: CLIP_DURATION_S,
          hasSource,
        }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // --- POST /music-reclip/<slug>?startS=N&durS=M --------------------
    // Manual override from the waveform editor. Re-runs the fade-in/out
    // + 96kbps mono pipeline against the preserved source with Tim's
    // chosen window.
    if (req.method === 'POST' && req.url?.startsWith('/music-reclip/')) {
      const slug = req.url.replace(/^\/music-reclip\//, '').split('?')[0];
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const rawStartS = Math.max(0, parseFloat(q.get('startS') || '0'));
        const durS = parseFloat(q.get('durS') || String(CLIP_DURATION_S));
        if (!Number.isFinite(durS) || durS < 5 || durS > 180) {
          throw new Error(`bad durS: ${durS}`);
        }
        const srcPath = path.join(MUSIC_SOURCES_DIR, `${slug}.src`);
        try { await fs.access(srcPath); } catch {
          throw new Error(`no source preserved for ${slug} — re-upload the original mp3 to use the editor`);
        }
        // Clamp startS so it can't land past the end of the source —
        // ffmpeg silently produces a near-empty mp3 when atrim starts
        // beyond duration, which used to ship a broken playable through
        // the catalog (Tim's "songs can't be played" report). Cap at
        // max(0, sourceDur - durS) so we always get a full window.
        const sourceDur = await probeDurationSeconds(srcPath);
        const maxStart = Math.max(0, sourceDur - durS);
        const startS = Math.min(rawStartS, maxStart);
        if (startS !== rawStartS) {
          console.warn(
            `[reclip:${slug}] requested startS=${rawStartS}s clamped to ${startS}s (source ${sourceDur.toFixed(1)}s, window ${durS}s)`,
          );
        }
        const outPath = path.join(MUSIC_UPLOAD_DIR, `${slug}.mp3`);
        await reclipFromSource(srcPath, outPath, startS, durS);
        // Update catalog entry with new clipStartS + loopDurationMs.
        try {
          const raw = JSON.parse(await fs.readFile(MUSIC_JSON, 'utf8'));
          if (raw[slug]) {
            raw[slug].clipStartS = startS;
            raw[slug].loopDurationMs = Math.round(durS * 1000);
            await rotateBackups(MUSIC_JSON);
            await fs.writeFile(MUSIC_JSON, JSON.stringify(raw, null, 2) + '\n');
          }
        } catch (e) {
          console.warn(`[reclip:${slug}] catalog update failed:`, e.message);
        }
        // Re-extract tap samples from the new clip — they're sliced from
        // the song so they need to match the new section.
        try {
          await extractTapsForSong(outPath, TAPS_DIR, slug);
        } catch (tapsErr) {
          console.warn(`[reclip:${slug}] tap-extract failed:`, tapsErr.message);
        }
        const bytes = (await fs.stat(outPath)).size;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, startS, durS, bytes }));
        console.log(`[reclip:${slug}] startS=${startS.toFixed(2)} durS=${durS.toFixed(2)} → ${bytes}B`);
        scheduleCatalogSync();
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
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
        // Preserved source goes with the song too.
        await fs.unlink(path.join(MUSIC_SOURCES_DIR, `${slug}.src`)).catch(() => {});
        // Tap samples follow the song. No-op-safely if they were never
        // extracted (older songs or extract failures).
        for (let lane = 0; lane < 3; lane++) {
          await fs.unlink(path.join(TAPS_DIR, `${slug}-${lane}.wav`)).catch(() => {});
        }
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

/**
 * One-shot migration on server boot — backfill `addedAt` on existing
 * music.json entries from the mp3's file mtime. Lets the calibrator's
 * "newest / oldest" sort work for tracks uploaded before addedAt was
 * stamped. Idempotent: entries that already have addedAt are skipped.
 */
async function backfillMusicAddedAt() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(MUSIC_JSON, 'utf8'));
  } catch {
    return; // no music.json yet — nothing to do
  }
  let changed = 0;
  for (const [slug, entry] of Object.entries(raw)) {
    if (typeof entry.addedAt === 'number') continue;
    const mp3Path = path.join(MUSIC_UPLOAD_DIR, `${slug}.mp3`);
    try {
      const stat = await fs.stat(mp3Path);
      entry.addedAt = stat.mtimeMs;
      changed++;
    } catch {
      // mp3 missing — leave entry without addedAt (sort will park it at 0)
    }
  }
  if (changed > 0) {
    await rotateBackups(MUSIC_JSON);
    await fs.writeFile(MUSIC_JSON, JSON.stringify(raw, null, 2) + '\n');
    console.log(`[music] backfilled addedAt on ${changed} legacy entr${changed === 1 ? 'y' : 'ies'} from mp3 mtime`);
  }
}

server.listen(PORT, async () => {
  console.log(`\n  meowcert tools server → http://localhost:${PORT}/`);
  for (const [name, t] of Object.entries(TOOLS)) {
    console.log(`    · ${name}: ${t.href}`);
  }
  console.log();
  // Run-once migrations on boot — best-effort, swallow errors so a
  // single bad file doesn't keep the server from coming up.
  try { await backfillMusicAddedAt(); } catch (e) {
    console.warn('[music] addedAt backfill failed:', e.message);
  }
});
