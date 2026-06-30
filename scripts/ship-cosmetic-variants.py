"""Ship checkmarked cosmetic variants into the catalog as real assets.

Reads tools/cosmetics/variants/selections.json (the ticks from the
Cosmetic Color Variants tool page). For each selected variant:

1. Resolves the parent cosmetic + variant kind (all_<hue>, cluster0_<hue>,
   cluster1_<hue>, darker, lighter)
2. Reads every per-frame source PNG from assets-raw/cosmetic/<parent>/
3. Applies the SAME HSL recolor the variants page previewed
4. Writes recolored frames to assets-raw/cosmetic/<new_id>/ using the
   <new_id>_<anim>_<NN>.png naming the extractor treats as source PNGs
5. Adds a catalog entry to tools/cosmetics/cosmetics.json with name +
   slot + rarity inherited from parent
6. Tracks the parent→variant→new_id mapping in
   tools/cosmetics/variants/shipped.json so the variants page can hide
   already-shipped picks on the next regen

Also deletes the 14 OLD flat-tint variants (c44, c47-c56, c60-c62) from
the catalog — those are the ones Tim flagged as looking bad. The new
HSL-recolored ones replace them.

After this script runs, you must:
- npm run extract:assets   (pack new cosmetic frames into the atlas)
- npm run sync:catalog     (regen the runtime catalog)
- npm run cosmetic-variants  (regen the variants page with new
                              bases + shipped IDs filtered out)
"""
import json, os, re, colorsys, shutil
from PIL import Image
from pathlib import Path

ROOT = Path('.')
COSMETIC_RAW = ROOT / 'assets-raw' / 'cosmetic'
CATALOG = ROOT / 'tools' / 'cosmetics' / 'cosmetics.json'
SELECTIONS = ROOT / 'tools' / 'cosmetics' / 'variants' / 'selections.json'
SHIPPED = ROOT / 'tools' / 'cosmetics' / 'variants' / 'shipped.json'
ATLAS_JSON = ROOT / 'public' / 'assets' / 'atlas' / 'cosmetics.json'
ATLAS_PNG = ROOT / 'public' / 'assets' / 'atlas' / 'cosmetics.png'

# === HELPERS — MUST MATCH gen-cosmetic-variants.py ===
GRAY_SAT = 0.08
CLUSTER_SEPARATION_DEG = 40
CLUSTER_MIN_WEIGHT = 0.05
DARK_BASE_THRESHOLD = 0.30
DARK_BASE_TARGET_L = 0.50
HUE_TARGETS_DICT = {
    'red': 0, 'orange': 30, 'yellow': 55, 'lime': 90, 'green': 135,
    'teal': 175, 'blue': 220, 'purple': 270, 'magenta': 305, 'pink': 330,
}
# Must match gen-cosmetic-variants.py FORCE_TARGETS
FORCE_TARGETS = {
    'black':  (0,   0.0,  0.15),
    'white':  (0,   0.0,  0.92),
    'gold':   (45,  0.85, 0.55),
    'silver': (0,   0.0,  0.75),
}
# Must match gen-cosmetic-variants.py DUAL_COMBOS
DUAL_COMBOS = {
    'xmas':         (('hue', 0),    ('hue', 45)),
    'royal':        (('hue', 270),  ('hue', 45)),
    'festive':      (('hue', 135),  ('hue', 0)),
    'aqua-pop':     (('hue', 175),  ('hue', 330)),
    'sunset':       (('hue', 30),   ('hue', 305)),
    'black-gold':   (('force', 'black'),  ('hue', 45)),
    'black-red':    (('force', 'black'),  ('hue', 0)),
    'black-blue':   (('force', 'black'),  ('hue', 220)),
    'black-green':  (('force', 'black'),  ('hue', 135)),
    'black-purple': (('force', 'black'),  ('hue', 270)),
    'white-pink':   (('force', 'white'),  ('hue', 330)),
    'white-blue':   (('force', 'white'),  ('hue', 220)),
    'white-red':    (('force', 'white'),  ('hue', 0)),
    'white-gold':   (('force', 'white'),  ('hue', 45)),
    'gold-red':     (('force', 'gold'),   ('hue', 0)),
    'gold-blue':    (('force', 'gold'),   ('hue', 220)),
    'gold-green':   (('force', 'gold'),   ('hue', 135)),
    'gold-purple':  (('force', 'gold'),   ('hue', 270)),
    'silver-blue':  (('force', 'silver'), ('hue', 220)),
    'silver-red':   (('force', 'silver'), ('hue', 0)),
    'silver-green': (('force', 'silver'), ('hue', 135)),
    'silver-pink':  (('force', 'silver'), ('hue', 330)),
}


def hue_histogram(img):
    pixels = img.getdata()
    buckets = [0.0] * 360
    for r, g, b, a in pixels:
        if a < 50:
            continue
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if s < 0.15:
            continue
        buckets[int(h * 360) % 360] += s * (1.0 - abs(0.5 - l) * 2)
    return buckets


def smooth(buckets, window=9):
    n = len(buckets)
    out = [0.0] * n
    half = window // 2
    for i in range(n):
        s = 0.0
        for k in range(-half, half + 1):
            s += buckets[(i + k) % n]
        out[i] = s / window
    return out


def find_hue_clusters(img):
    hist = smooth(hue_histogram(img))
    total = sum(hist)
    if total == 0:
        return []
    n = len(hist)
    half_window = CLUSTER_SEPARATION_DEG // 2

    def cluster_weight(center_idx):
        s = 0.0
        for k in range(-half_window, half_window + 1):
            s += hist[(center_idx + k) % n]
        return s

    raw_peaks = []
    for i in range(n):
        if hist[i] == 0:
            continue
        is_peak = True
        for k in range(-half_window, half_window + 1):
            if k == 0:
                continue
            j = (i + k) % n
            if hist[j] > hist[i] or (hist[j] == hist[i] and j < i):
                is_peak = False
                break
        if is_peak:
            raw_peaks.append((i, cluster_weight(i)))

    if not raw_peaks:
        i = max(range(n), key=lambda j: hist[j])
        return [(i, 1.0)]
    min_cluster_weight = total * CLUSTER_MIN_WEIGHT
    raw_peaks = [(d, w) for d, w in raw_peaks if w >= min_cluster_weight]
    if not raw_peaks:
        i = max(range(n), key=lambda j: hist[j])
        return [(i, 1.0)]
    raw_peaks.sort(key=lambda p: -p[1])
    return [(deg, w / total) for deg, w in raw_peaks]


def pixel_in_cluster(pixel_hue_deg, cluster_center_deg, radius=45):
    d = abs(pixel_hue_deg - cluster_center_deg) % 360
    return min(d, 360 - d) <= radius


def shift_hue(img, target_h_deg, source_h_deg, mask_cluster_deg=None, mask_radius=45):
    rotation = (target_h_deg - source_h_deg) / 360.0
    boost_cluster_deg = mask_cluster_deg if mask_cluster_deg is not None else source_h_deg
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    src_px = img.load()
    dst_px = out.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = src_px[x, y]
            if a == 0:
                continue
            hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if ss < GRAY_SAT:
                dst_px[x, y] = (r, g, b, a)
                continue
            pixel_h_deg = int(hh * 360)
            if mask_cluster_deg is not None:
                if not pixel_in_cluster(pixel_h_deg, mask_cluster_deg, mask_radius):
                    dst_px[x, y] = (r, g, b, a)
                    continue
            new_h = (hh + rotation) % 1.0
            new_l = ll
            new_s = ss
            if ll < DARK_BASE_THRESHOLD and pixel_in_cluster(pixel_h_deg, boost_cluster_deg, mask_radius):
                new_l = min(1.0, ll + (DARK_BASE_TARGET_L - ll) * 0.8)
                new_s = max(ss, 0.75)
            nr, ng, nb = colorsys.hls_to_rgb(new_h, new_l, new_s)
            dst_px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out


def force_recolor(img, target_h_deg, target_s, target_l_mid, preserve_contrast=0.35):
    """Stamp every pixel toward target HSL, keep partial original lightness
    contrast. Mirrors gen-cosmetic-variants.py force_recolor (no mask)."""
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    src_px = img.load()
    dst_px = out.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = src_px[x, y]
            if a == 0:
                continue
            _, ll, _ = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            new_l = max(0.0, min(1.0, target_l_mid + (ll - 0.5) * preserve_contrast))
            nr, ng, nb = colorsys.hls_to_rgb(target_h_deg / 360, new_l, target_s)
            dst_px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out


def dual_recolor(img, main_recipe, accent_recipe, main_deg, accent_deg):
    """Single-pass per-pixel cluster assignment + recipe application.
    Mirrors gen-cosmetic-variants.py dual_recolor."""
    def _circ_dist(a, b):
        d = abs(a - b) % 360
        return min(d, 360 - d)

    def _apply_one_pixel(r, g, b, a, recipe, source_deg):
        kind, val = recipe
        hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if kind == 'hue':
            rotation = (val - source_deg) / 360.0
            new_h = (hh + rotation) % 1.0
            new_l = ll
            new_s = ss
            if ll < DARK_BASE_THRESHOLD:
                new_l = min(1.0, ll + (DARK_BASE_TARGET_L - ll) * 0.8)
                new_s = max(ss, 0.75)
            nr, ng, nb = colorsys.hls_to_rgb(new_h, new_l, new_s)
            return (int(nr * 255), int(ng * 255), int(nb * 255), a)
        if kind == 'force':
            h, s, l_mid = FORCE_TARGETS[val]
            new_l = max(0.0, min(1.0, l_mid + (ll - 0.5) * 0.35))
            nr, ng, nb = colorsys.hls_to_rgb(h / 360, new_l, s)
            return (int(nr * 255), int(ng * 255), int(nb * 255), a)

    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    src_px = img.load()
    dst_px = out.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = src_px[x, y]
            if a == 0:
                continue
            hh, _, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if ss < GRAY_SAT:
                dst_px[x, y] = (r, g, b, a)
                continue
            pixel_h_deg = int(hh * 360)
            d_main = _circ_dist(pixel_h_deg, main_deg)
            d_accent = _circ_dist(pixel_h_deg, accent_deg)
            recipe, src = (main_recipe, main_deg) if d_main <= d_accent else (accent_recipe, accent_deg)
            dst_px[x, y] = _apply_one_pixel(r, g, b, a, recipe, src)
    return out


def shift_lightness(img, delta):
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    src_px = img.load()
    dst_px = out.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = src_px[x, y]
            if a == 0:
                continue
            hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            new_l = max(0.0, min(1.0, ll + delta))
            nr, ng, nb = colorsys.hls_to_rgb(hh, new_l, ss)
            dst_px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out


# === END HELPERS ===

ATLAS_FRAMES = {f['filename']: f for f in json.load(open(ATLAS_JSON))['frames']}
ATLAS_IMG = Image.open(ATLAS_PNG).convert('RGBA')


def extract_atlas_frame(name):
    fr = ATLAS_FRAMES.get(name)
    if not fr:
        return None
    src = fr['frame']
    spr = fr['spriteSourceSize']
    sz = fr['sourceSize']
    canvas = Image.new('RGBA', (sz['w'], sz['h']), (0, 0, 0, 0))
    canvas.paste(
        ATLAS_IMG.crop((src['x'], src['y'], src['x'] + src['w'], src['y'] + src['h'])),
        (spr['x'], spr['y']),
    )
    return canvas


def list_parent_frames(parent_id):
    """Returns dict {anim: [(idx, srcPath)...]} sorted by idx. Mirrors the
    server's listSourceFramesForCosmetic."""
    parent_dir = COSMETIC_RAW / parent_id
    if not parent_dir.is_dir():
        return {}
    prefix = f'cosmetic_{parent_id}_'
    by_anim = {}
    for entry in parent_dir.iterdir():
        name = entry.name
        if not name.startswith(prefix) or not name.endswith('.png'):
            continue
        stripped = name[len(prefix):-4]
        m = re.match(r'^(.+)_(\d+)$', stripped)
        if not m:
            continue
        anim, idx = m.group(1), int(m.group(2))
        by_anim.setdefault(anim, []).append((idx, entry))
    for arr in by_anim.values():
        arr.sort(key=lambda x: x[0])
    return by_anim


def apply_variant(img, variant_id, primary_hue, clusters):
    """Apply the same transformation the variants page previewed for this
    variant_id, on the given image. Returns the recolored image."""
    if variant_id.startswith('all_'):
        hue_name = variant_id[4:]
        target = HUE_TARGETS_DICT[hue_name]
        return shift_hue(img, target, primary_hue)
    if variant_id.startswith('cluster0_'):
        hue_name = variant_id[len('cluster0_'):]
        target = HUE_TARGETS_DICT[hue_name]
        cdeg = clusters[0][0]
        return shift_hue(img, target, cdeg, mask_cluster_deg=cdeg)
    if variant_id.startswith('cluster1_'):
        hue_name = variant_id[len('cluster1_'):]
        target = HUE_TARGETS_DICT[hue_name]
        cdeg = clusters[1][0]
        return shift_hue(img, target, cdeg, mask_cluster_deg=cdeg)
    if variant_id == 'darker':
        return shift_lightness(img, -0.2)
    if variant_id == 'lighter':
        return shift_lightness(img, 0.2)
    if variant_id.startswith('force_'):
        name = variant_id[len('force_'):]
        h, s, l = FORCE_TARGETS[name]
        return force_recolor(img, h, s, l)
    if variant_id.startswith('dual_'):
        if len(clusters) < 2:
            raise ValueError(f'{variant_id}: parent has fewer than 2 clusters')
        name = variant_id[len('dual_'):]
        main_recipe, accent_recipe = DUAL_COMBOS[name]
        return dual_recolor(img, main_recipe, accent_recipe, clusters[0][0], clusters[1][0])
    raise ValueError(f'unknown variant id: {variant_id}')


def variant_name(parent_name, variant_id):
    """Human-readable name for the new cosmetic. Tim can rename via the
    cosmetic calibrator if any of these read awkward."""
    if variant_id == 'darker':
        return f'Dark {parent_name}'
    if variant_id == 'lighter':
        return f'Light {parent_name}'
    if variant_id.startswith('force_'):
        name = variant_id[len('force_'):]
        return f'{name.capitalize()} {parent_name}'
    if variant_id.startswith('dual_'):
        name = variant_id[len('dual_'):]
        # 'black-gold' → 'Black-Gold'
        cap = '-'.join(p.capitalize() for p in name.split('-'))
        return f'{cap} {parent_name}'
    if variant_id.startswith('all_'):
        color_word = variant_id[4:]
    elif variant_id.startswith('cluster0_'):
        color_word = variant_id[len('cluster0_'):]
    elif variant_id.startswith('cluster1_'):
        color_word = variant_id[len('cluster1_'):]
        return f'{color_word.capitalize()}-Accent {parent_name}'
    else:
        return f'{variant_id} {parent_name}'
    return f'{color_word.capitalize()} {parent_name}'


# ----- Main -----

selections = json.load(open(SELECTIONS))
catalog = json.load(open(CATALOG))
shipped = json.load(open(SHIPPED)) if SHIPPED.exists() else {}

cat_by_id = {c['id']: c for c in catalog}

# Find next free numeric ID
max_id = 0
for c in catalog:
    m = re.match(r'^c(\d+)$', c['id'])
    if m:
        max_id = max(max_id, int(m.group(1)))
next_id_num = max_id + 1


def next_id():
    global next_id_num
    s = f'c{next_id_num}'
    next_id_num += 1
    return s


new_entries = []
skipped = []
created_dirs = []

for parent_id, variant_ids in selections.items():
    parent = cat_by_id.get(parent_id)
    if not parent:
        skipped.append((parent_id, 'no catalog entry'))
        continue
    if parent.get('sourceFrame'):
        skipped.append((parent_id, 'is itself a variant — refusing to derive'))
        continue

    parent_idle = extract_atlas_frame(f'cosmetic_{parent_id}_idle_00')
    if parent_idle is None:
        skipped.append((parent_id, 'no idle_00 atlas frame'))
        continue

    bbox = parent_idle.getbbox()
    parent_idle_cropped = parent_idle.crop(bbox) if bbox else parent_idle
    clusters = find_hue_clusters(parent_idle_cropped)
    primary_hue = clusters[0][0] if clusters else 0

    parent_frames = list_parent_frames(parent_id)
    if not parent_frames:
        skipped.append((parent_id, 'no source PNG frames in assets-raw/cosmetic/<parent>/'))
        continue

    parent_shipped = shipped.get(parent_id, {})

    for vid in variant_ids:
        if vid in parent_shipped:
            continue  # already shipped previously
        if vid.startswith('cluster1_') and len(clusters) < 2:
            skipped.append((f'{parent_id}/{vid}', 'cluster1 selected but parent only has 1 cluster'))
            continue

        new_id = next_id()
        new_dir = COSMETIC_RAW / new_id
        new_dir.mkdir(parents=True, exist_ok=True)
        created_dirs.append(new_dir)

        total_frames_written = 0
        for anim, frames in parent_frames.items():
            multi = len(frames) > 1
            for idx, src_path in frames:
                src_img = Image.open(src_path).convert('RGBA')
                new_img = apply_variant(src_img, vid, primary_hue, clusters)
                if multi:
                    dst_name = f'{new_id}_{anim}_{idx:02d}.png'
                else:
                    dst_name = f'{new_id}_{anim}.png'
                new_img.save(new_dir / dst_name)
                total_frames_written += 1

        new_name = variant_name(parent['name'], vid)
        new_entries.append({
            'id': new_id,
            'name': new_name,
            'slot': parent['slot'],
            'rarity': parent.get('rarity', 'common'),
            # offsets + scale will get filled in by the migration on first
            # extract — let calibrator-drives-runtime baseline math compute them
            'offsetX': parent.get('offsetX', 0),
            'offsetY': parent.get('offsetY', 0),
            'scale': parent.get('scale', 1),
        })
        if parent.get('isStatic'):
            new_entries[-1]['isStatic'] = True

        shipped.setdefault(parent_id, {})[vid] = {
            'new_id': new_id,
            'frames': total_frames_written,
            'name': new_name,
        }
        print(f'  + {new_id:5} {new_name:<35}  ({total_frames_written} frames from {parent_id} variant={vid})')

# Delete the 14 old flat-tint variants — Tim flagged them as looking bad
OLD_TINTS = {'c44', 'c47', 'c48', 'c49', 'c50', 'c51', 'c52', 'c53', 'c54', 'c55', 'c56', 'c60', 'c61', 'c62'}
removed = [c['id'] for c in catalog if c['id'] in OLD_TINTS]
catalog = [c for c in catalog if c['id'] not in OLD_TINTS]
catalog += new_entries

# Write everything back
with open(CATALOG, 'w') as f:
    json.dump(catalog, f, indent=2)
with open(SHIPPED, 'w') as f:
    json.dump(shipped, f, indent=2)
# Clear selections — they've been shipped and shouldn't re-prompt next regen
with open(SELECTIONS, 'w') as f:
    json.dump({}, f, indent=2)

print(f'\nShipped: {len(new_entries)} new variants')
print(f'Removed: {len(removed)} old flat-tint variants ({", ".join(removed) if removed else "none"})')
if skipped:
    print(f'\nSkipped:')
    for s, reason in skipped:
        print(f'  {s}: {reason}')
print(f'\nNext: npm run extract:assets && npm run sync:catalog && npm run cosmetic-variants')
