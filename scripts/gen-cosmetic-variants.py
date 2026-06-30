"""Cosmetic color-variant explorer with per-region recoloring.

Variant types per cosmetic:
- 10 standard hue rotations (rotate ALL color pixels together)
- 2 lightness variants (darker / lighter version of the base)
- For multi-cluster items (e.g. crown gold body + clear jewel,
  strawberry red body + green stem): per-cluster recolors that shift
  ONE color region while keeping the others fixed
- For dark/bright item pairs detected on lightness (e.g. gold body
  with white poms): also "metal-swap" variants where the dark portion
  becomes a different metal hue while the bright portion stays

Pixel math:
- HSL rotation: hue shifts, lightness + saturation preserved per-pixel
  → darker shadows STAY proportionally darker in the new hue
- Near-gray pixels (saturation < 0.08) untouched → black outlines, white
  poms, silver chains survive any recolor

Output:
- tools/cosmetics/variants/imgs/<id>__<variant>.png per variant
- tools/cosmetics/variants/index.html — the explorer page

Selection state lives in tools/cosmetics/variants/selections.json,
managed by the page's checkboxes via POST /save-variant-selection.
"""
import json, os, colorsys
from PIL import Image
from pathlib import Path

ROOT = Path('.')
ATL_PNG = ROOT / 'public/assets/atlas/cosmetics.png'
ATL_JSON = ROOT / 'public/assets/atlas/cosmetics.json'
CAT_JSON = ROOT / 'tools/cosmetics/cosmetics.json'

OUT_DIR = ROOT / 'tools/cosmetics/variants'
IMG_DIR = OUT_DIR / 'imgs'
OUT_DIR.mkdir(parents=True, exist_ok=True)
IMG_DIR.mkdir(parents=True, exist_ok=True)
for f in IMG_DIR.glob('*.png'):
    f.unlink()

# 10 evenly-spaced target hues used for both whole-image rotation
# AND per-cluster recoloring
HUE_TARGETS = [
    ('red',     0),
    ('orange',  30),
    ('yellow',  55),
    ('lime',    90),
    ('green',   135),
    ('teal',    175),
    ('blue',    220),
    ('purple',  270),
    ('magenta', 305),
    ('pink',    330),
]

# Universal "force" recolors that apply to every cosmetic regardless of
# cluster shape — the (hue, sat, lightness_mid) target for each
FORCE_TARGETS = [
    ('black',  0,   0.0,  0.15),  # near-black with a hint of original shadow contrast
    ('white',  0,   0.0,  0.92),  # soft white
    ('gold',   45,  0.85, 0.55),  # warm metallic gold
    ('silver', 0,   0.0,  0.75),  # light grey silver
]

# Pre-curated dual-cluster combos for items with main + accent regions
# (crowns, witch hats, party hats, baseball caps, fancy necklaces).
# Each entry: (label, main_recipe, accent_recipe) where each recipe is
# either ('hue', deg) for hue rotation or ('force', force_target_name)
# for one of the FORCE_TARGETS (black/white/gold/silver).
DUAL_COMBOS = [
    ('xmas',         ('hue', 0),    ('hue', 45)),     # red body + gold accent
    ('royal',        ('hue', 270),  ('hue', 45)),     # purple + gold
    ('festive',      ('hue', 135),  ('hue', 0)),      # green + red
    ('aqua-pop',     ('hue', 175),  ('hue', 330)),    # teal + pink
    ('sunset',       ('hue', 30),   ('hue', 305)),    # orange + magenta
    ('black-gold',   ('force', 'black'),  ('hue', 45)),    # black body + gold accent
    ('black-red',    ('force', 'black'),  ('hue', 0)),     # black + red
    ('black-blue',   ('force', 'black'),  ('hue', 220)),   # black + blue
    ('black-green',  ('force', 'black'),  ('hue', 135)),   # black + green
    ('black-purple', ('force', 'black'),  ('hue', 270)),   # black + purple
    ('white-pink',   ('force', 'white'),  ('hue', 330)),   # white + pink
    ('white-blue',   ('force', 'white'),  ('hue', 220)),   # white + blue
    ('white-red',    ('force', 'white'),  ('hue', 0)),     # white + red
    ('white-gold',   ('force', 'white'),  ('hue', 45)),    # white + gold
    ('gold-red',     ('force', 'gold'),   ('hue', 0)),     # gold body + red accent
    ('gold-blue',    ('force', 'gold'),   ('hue', 220)),   # gold + blue gem
    ('gold-green',   ('force', 'gold'),   ('hue', 135)),   # gold + green gem
    ('gold-purple',  ('force', 'gold'),   ('hue', 270)),   # gold + purple gem
    ('silver-blue',  ('force', 'silver'), ('hue', 220)),   # silver + blue gem
    ('silver-red',   ('force', 'silver'), ('hue', 0)),     # silver + ruby gem
    ('silver-green', ('force', 'silver'), ('hue', 135)),   # silver + emerald
    ('silver-pink',  ('force', 'silver'), ('hue', 330)),   # silver + pink gem
]

# Saturation below this counts as "near-gray" — never recolored
GRAY_SAT = 0.08
# Two hue peaks need to be at least this far apart to count as separate clusters.
# Tuned 40 (was 60): crown's gold (36°) vs gem (344°) is only 52° apart on the
# color wheel; 60° merged them into one yellow cluster, hiding the gem.
CLUSTER_SEPARATION_DEG = 40
# Each cluster needs to hold at least this fraction of colored pixels.
# Tuned 0.05 (was 0.15): strawberry's green stem is only 2-3% of color weight
# but visually critical; 15% rejected it. 5% admits real secondary colors
# without picking up random outline noise.
CLUSTER_MIN_WEIGHT = 0.05

atlas = Image.open(ATL_PNG).convert('RGBA')
atl_json = json.load(open(ATL_JSON))
frames = {f['filename']: f for f in atl_json['frames']}


def extract_atlas_thumb(name):
    """Extract + crop an atlas frame for use as a small reference thumbnail."""
    fr = frames.get(name)
    if not fr:
        return None
    src = fr['frame']
    spr = fr['spriteSourceSize']
    sz = fr['sourceSize']
    canvas = Image.new('RGBA', (sz['w'], sz['h']), (0, 0, 0, 0))
    canvas.paste(
        atlas.crop((src['x'], src['y'], src['x'] + src['w'], src['y'] + src['h'])),
        (spr['x'], spr['y']),
    )
    bbox = canvas.getbbox()
    return canvas.crop(bbox) if bbox else canvas
cat = json.load(open(CAT_JSON))


def extract_canvas(name):
    fr = frames.get(name)
    if not fr:
        return None
    src = fr['frame']
    spr = fr['spriteSourceSize']
    sz = fr['sourceSize']
    canvas = Image.new('RGBA', (sz['w'], sz['h']), (0, 0, 0, 0))
    canvas.paste(
        atlas.crop((src['x'], src['y'], src['x'] + src['w'], src['y'] + src['h'])),
        (spr['x'], spr['y']),
    )
    return canvas


def crop_to_content(img):
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def hue_histogram(img):
    """Saturation-weighted hue histogram (360 buckets, 1° each)."""
    pixels = img.getdata()
    buckets = [0.0] * 360
    for r, g, b, a in pixels:
        if a < 50:
            continue
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if s < 0.15:
            continue
        bucket = int(h * 360) % 360
        # Weight by saturation * mid-lightness so vibrant mid-tones dominate
        # over near-black-or-white tints of the same hue
        buckets[bucket] += s * (1.0 - abs(0.5 - l) * 2)
    return buckets


def smooth(buckets, window=9):
    """Boxcar smooth a circular histogram so we pick rounded peaks, not noise."""
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
    """Find dominant hue peaks. Returns list of (center_hue_deg, weight_fraction)
    sorted by weight descending. Returns [] for grayscale images.

    Cluster weight is the SUM of histogram values within ±half_window of the
    peak, divided by total. Per-bucket peak values shrink after smoothing,
    so comparing single-bucket values against a fraction-of-total threshold
    would reject any cluster that's been smoothed out — even if the underlying
    color region is huge."""
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

    # Find all windowed-max peaks (no min-weight filter yet — that's per-cluster)
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

    # Filter by cluster weight (summed neighborhood, not single-bucket value)
    min_cluster_weight = total * CLUSTER_MIN_WEIGHT
    raw_peaks = [(d, w) for d, w in raw_peaks if w >= min_cluster_weight]
    if not raw_peaks:
        i = max(range(n), key=lambda j: hist[j])
        return [(i, 1.0)]
    raw_peaks.sort(key=lambda p: -p[1])
    return [(deg, w / total) for deg, w in raw_peaks]


def pixel_in_cluster(pixel_hue_deg, cluster_center_deg, radius=45):
    """Circular distance check — does this pixel belong to the cluster?"""
    d = abs(pixel_hue_deg - cluster_center_deg) % 360
    return min(d, 360 - d) <= radius


def cluster_avg_lightness(img, cluster_h_deg, radius=45):
    """Average lightness of pixels belonging to a hue cluster. Used to detect
    very-dark bases (e.g. black witch hat, black tie) where straight hue
    rotation produces an indistinguishable nearly-black variant — instead
    we boost lightness during recolor so the new color is actually visible."""
    src_px = img.load()
    w, h = img.size
    total_l = 0.0
    n = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = src_px[x, y]
            if a == 0:
                continue
            hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if ss < GRAY_SAT:
                continue
            if cluster_h_deg is not None:
                if not pixel_in_cluster(int(hh * 360), cluster_h_deg, radius):
                    continue
            total_l += ll
            n += 1
    return total_l / n if n else 0.5


# When the cluster's average lightness is below this, we boost output lightness
# so the recolored result is visible (black hat → real-red hat, not near-black-red)
DARK_BASE_THRESHOLD = 0.30
# Target average lightness for recolored dark bases — bright enough to read as
# a real color while still keeping shadow/highlight contrast
DARK_BASE_TARGET_L = 0.50


def shift_hue(img, target_h_deg, source_h_deg, mask_cluster_deg=None, mask_radius=45,
              cluster_avg_l=None):
    """Per-pixel hue rotation. If mask_cluster_deg is set, only pixels whose
    current hue falls within mask_radius of that cluster center get rotated;
    other colored pixels stay put.

    Per-pixel dark-pixel rescue: any colored pixel whose lightness is below
    DARK_BASE_THRESHOLD gets lifted to ~DARK_BASE_TARGET_L AND its saturation
    floored to 0.75+. This makes black/near-black bases produce VISIBLE
    colored variants instead of nearly-black ones. Bright pixels in the same
    image are untouched, so a mixed dark/bright cosmetic (witch hat: black
    body + red band) gets vivid recolor on the body while the band keeps
    its original tone. cluster_avg_l param kept for backward compat but no
    longer drives the boost decision."""
    rotation = (target_h_deg - source_h_deg) / 360.0
    # Dark-base boost only applies to pixels that ARE the cluster we're
    # rotating — otherwise unrelated dark accents (e.g. sunglass frames
    # that happen to be near-black with a faint blue tint) get
    # accidentally pumped to bright colors when all_red runs.
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


def apply_recipe(img, recipe, source_h_deg, mask_cluster_deg=None, mask_radius=45):
    """Apply ('hue', deg) or ('force', target_name) recipe to one cluster of
    the image. mask_cluster_deg confines the change to that cluster's pixels."""
    kind, val = recipe
    if kind == 'hue':
        return shift_hue(img, val, source_h_deg, mask_cluster_deg=mask_cluster_deg, mask_radius=mask_radius)
    if kind == 'force':
        target = next(t for t in FORCE_TARGETS if t[0] == val)
        _, h, s, l = target
        return force_recolor(img, h, s, l, preserve_contrast=0.35, mask_cluster_deg=mask_cluster_deg, mask_radius=mask_radius)
    raise ValueError(f'unknown recipe kind: {kind}')


def dual_recolor(img, main_recipe, accent_recipe, main_deg, accent_deg):
    """Recolor an image's two hue clusters independently in a SINGLE PASS.
    Per pixel: decide which cluster it belongs to BEFORE any rotation,
    then apply that cluster's recipe. This avoids the sequential bug
    where step-1's rotated pixels fall into step-2's mask and get
    rotated again."""
    def _circ_dist(a, b):
        d = abs(a - b) % 360
        return min(d, 360 - d)

    def _apply_one_pixel(r, g, b, a, recipe, source_deg, dark_boost_enabled):
        kind, val = recipe
        hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if kind == 'hue':
            rotation = (val - source_deg) / 360.0
            new_h = (hh + rotation) % 1.0
            new_l = ll
            new_s = ss
            if dark_boost_enabled and ll < DARK_BASE_THRESHOLD:
                new_l = min(1.0, ll + (DARK_BASE_TARGET_L - ll) * 0.8)
                new_s = max(ss, 0.75)
            nr, ng, nb = colorsys.hls_to_rgb(new_h, new_l, new_s)
            return (int(nr * 255), int(ng * 255), int(nb * 255), a)
        if kind == 'force':
            target = next(t for t in FORCE_TARGETS if t[0] == val)
            _, h, s, l_mid = target
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
            # Assign to closest cluster
            d_main = _circ_dist(pixel_h_deg, main_deg)
            d_accent = _circ_dist(pixel_h_deg, accent_deg)
            if d_main <= d_accent:
                dst_px[x, y] = _apply_one_pixel(r, g, b, a, main_recipe, main_deg, True)
            else:
                dst_px[x, y] = _apply_one_pixel(r, g, b, a, accent_recipe, accent_deg, True)
    return out


def force_recolor(img, target_h_deg, target_s, target_l_mid, preserve_contrast=0.35,
                  mask_cluster_deg=None, mask_radius=45):
    """Stamp every colored pixel toward (target_h, target_s, target_l_mid),
    keeping a small amount of the original lightness variation so shadows
    and highlights still read. Used for black/white/gold/silver "force"
    variants where the whole cosmetic becomes one color identity.

    preserve_contrast = how much of the original (L - 0.5) range survives.
    0.0 = perfectly flat single tone; 0.5 = full original lightness span."""
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
            # If a mask is set, only convert pixels that fall in the mask
            # cluster — others pass through untouched (so dual recolors only
            # affect one cluster, not the whole image)
            if mask_cluster_deg is not None and ss >= GRAY_SAT:
                if not pixel_in_cluster(int(hh * 360), mask_cluster_deg, mask_radius):
                    dst_px[x, y] = (r, g, b, a)
                    continue
            # For unmasked or in-mask pixels: stamp the target identity
            new_l = max(0.0, min(1.0, target_l_mid + (ll - 0.5) * preserve_contrast))
            nr, ng, nb = colorsys.hls_to_rgb(target_h_deg / 360, new_l, target_s)
            dst_px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out


def shift_lightness(img, delta):
    """Per-pixel lightness shift. delta in [-1, 1]. Saturation + hue preserved."""
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


def hue_to_swatch(deg):
    r, g, b = colorsys.hls_to_rgb(deg / 360, 0.5, 0.7)
    return f'#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}'


# Load the shipped-variants map so we can (a) skip showing already-shipped
# variant cells on parent rows and (b) avoid treating freshly-shipped child
# cosmetics as new bases (which would recursively re-offer to recolor them).
SHIPPED_PATH = OUT_DIR / 'shipped.json'
shipped_map = {}  # parent_id -> { variant_id: { new_id, ... } }
shipped_new_ids = set()  # all child IDs we've created from a parent
if SHIPPED_PATH.exists():
    try:
        shipped_map = json.load(open(SHIPPED_PATH))
        for vmap in shipped_map.values():
            for v in vmap.values():
                shipped_new_ids.add(v.get('new_id'))
    except Exception:
        shipped_map = {}

bases = [
    c for c in cat
    if not c.get('sourceFrame')
    and c.get('id') not in ('c58', 'c59')
    and c.get('id') not in shipped_new_ids
]
print(f'Generating variants for {len(bases)} bases (excluded {len(shipped_new_ids)} shipped-child IDs)')

manifest = []
total_variants = 0
for c in bases:
    cid = c['id']
    frame_name = f'cosmetic_{cid}_idle_00'
    img = extract_canvas(frame_name)
    if img is None:
        print(f'  SKIP {cid}: no atlas frame {frame_name}')
        continue
    img = crop_to_content(img)
    clusters = find_hue_clusters(img)
    base_path = IMG_DIR / f'{cid}__base.png'
    img.save(base_path)
    variants = []  # list of {id, label, file, kind}

    already_shipped_gs = shipped_map.get(cid, {})
    if not clusters:
        # Grayscale source — lightness + force variants are the useful ones
        if 'darker' not in already_shipped_gs:
            d_img = shift_lightness(img, -0.2)
            d_path = IMG_DIR / f'{cid}__darker.png'
            d_img.save(d_path)
            variants.append({'id': 'darker', 'label': 'darker', 'file': d_path.name, 'kind': 'lightness'})
        if 'lighter' not in already_shipped_gs:
            l_img = shift_lightness(img, 0.2)
            l_path = IMG_DIR / f'{cid}__lighter.png'
            l_img.save(l_path)
            variants.append({'id': 'lighter', 'label': 'lighter', 'file': l_path.name, 'kind': 'lightness'})
        # Force variants on grayscale bases give a clean "this in gold" /
        # "this in black" identity — useful for chains/jewelry
        for fname, fh, fs, fl in FORCE_TARGETS:
            vid = f'force_{fname}'
            if vid in already_shipped_gs:
                continue
            v_img = force_recolor(img, fh, fs, fl)
            v_path = IMG_DIR / f'{cid}__{vid}.png'
            v_img.save(v_path)
            variants.append({'id': vid, 'label': fname, 'file': v_path.name, 'kind': 'force'})

    else:
        # 1. Standard whole-image hue rotation (all clusters move together).
        # Use ALL colored pixels' avg-L for the boost decision so even an
        # item whose primary cluster is dark gets a sensible global lift.
        primary_hue = clusters[0][0]
        global_avg_l = cluster_avg_lightness(img, cluster_h_deg=None)
        already_shipped = shipped_map.get(cid, {})
        for hname, hdeg in HUE_TARGETS:
            vid = f'all_{hname}'
            if vid in already_shipped:
                continue  # already in the catalog as a real cosmetic
            v_img = shift_hue(img, hdeg, primary_hue, cluster_avg_l=global_avg_l)
            v_path = IMG_DIR / f'{cid}__{vid}.png'
            v_img.save(v_path)
            variants.append({'id': vid, 'label': hname, 'file': v_path.name, 'kind': 'all'})

        # 2. Per-cluster recolors (only if 2+ clusters with enough weight).
        # Per-cluster avg-L so a dark main cluster gets boosted to visible
        # color while a bright accent cluster keeps its original lightness.
        if len(clusters) >= 2 and all(w >= CLUSTER_MIN_WEIGHT for _, w in clusters[:2]):
            for ci, (cluster_deg, cluster_w) in enumerate(clusters[:2]):
                cluster_role = 'main' if ci == 0 else 'accent'
                cluster_l = cluster_avg_lightness(img, cluster_h_deg=cluster_deg)
                for hname, hdeg in HUE_TARGETS:
                    vid = f'cluster{ci}_{hname}'
                    if vid in already_shipped:
                        continue
                    v_img = shift_hue(
                        img,
                        target_h_deg=hdeg,
                        source_h_deg=cluster_deg,
                        mask_cluster_deg=cluster_deg,
                        mask_radius=45,
                        cluster_avg_l=cluster_l,
                    )
                    label = f'{cluster_role}→{hname}'
                    v_path = IMG_DIR / f'{cid}__{vid}.png'
                    v_img.save(v_path)
                    variants.append({'id': vid, 'label': label, 'file': v_path.name, 'kind': f'cluster{ci}'})

        # 3. Lightness variants of the base
        if 'darker' not in already_shipped:
            d_img = shift_lightness(img, -0.2)
            d_path = IMG_DIR / f'{cid}__darker.png'
            d_img.save(d_path)
            variants.append({'id': 'darker', 'label': 'darker', 'file': d_path.name, 'kind': 'lightness'})

        if 'lighter' not in already_shipped:
            l_img = shift_lightness(img, 0.2)
            l_path = IMG_DIR / f'{cid}__lighter.png'
            l_img.save(l_path)
            variants.append({'id': 'lighter', 'label': 'lighter', 'file': l_path.name, 'kind': 'lightness'})

        # 4. Universal "force" recolors (black / white / gold / silver) —
        # stamp every pixel toward the target identity. Skip the one
        # closest to the base's own primary identity to avoid duplicates.
        for fname, fh, fs, fl in FORCE_TARGETS:
            vid = f'force_{fname}'
            if vid in already_shipped:
                continue
            v_img = force_recolor(img, fh, fs, fl)
            v_path = IMG_DIR / f'{cid}__{vid}.png'
            v_img.save(v_path)
            variants.append({'id': vid, 'label': fname, 'file': v_path.name, 'kind': 'force'})

        # 5. Dual-cluster combos (main + accent recolored independently).
        # Only fires for items with 2 strong clusters — those are crowns,
        # witch hats, party hats, baseball caps, fancy necklaces etc.
        # Single-pass per-pixel cluster assignment avoids the double-rotation
        # bug that sequential apply_recipe had (where step1's rotated pixels
        # could fall into step2's mask and get rotated again).
        if len(clusters) >= 2 and all(w >= CLUSTER_MIN_WEIGHT for _, w in clusters[:2]):
            main_deg = clusters[0][0]
            accent_deg = clusters[1][0]
            for cname, main_recipe, accent_recipe in DUAL_COMBOS:
                vid = f'dual_{cname}'
                if vid in already_shipped:
                    continue
                v_img = dual_recolor(img, main_recipe, accent_recipe, main_deg, accent_deg)
                v_path = IMG_DIR / f'{cid}__{vid}.png'
                v_img.save(v_path)
                variants.append({'id': vid, 'label': cname, 'file': v_path.name, 'kind': 'dual'})

    cluster_summary = ', '.join(f'{int(d)}°({int(w*100)}%)' for d, w in clusters) if clusters else 'grayscale'
    manifest.append(
        {
            'id': cid,
            'name': c.get('name', ''),
            'slot': c.get('slot', ''),
            'base': base_path.name,
            'clusters': cluster_summary,
            'variants': variants,
        }
    )
    total_variants += len(variants)
    print(f'  {cid:5} {c.get("name","")[:25]:<25} clusters={cluster_summary:<25} variants={len(variants)}')

print(f'\nTotal: {len(manifest)} bases, {total_variants} variants')

# --- Load existing selections so the page restores ticks on load ---
SELECTIONS_PATH = OUT_DIR / 'selections.json'
selections = {}
if SELECTIONS_PATH.exists():
    try:
        selections = json.load(open(SELECTIONS_PATH))
    except Exception:
        selections = {}

# --- Build HTML ---
slot_order = ['head', 'face', 'neck']
slot_label = {'head': 'HEAD', 'face': 'FACE', 'neck': 'NECK'}
by_slot = {s: [c for c in manifest if c['slot'] == s] for s in slot_order}


def kind_color(kind):
    """Pick a border color per variant kind so cluster-recolors visually
    distinguish from whole-image rotations."""
    return {
        'all': '#341c5a',
        'cluster0': '#7bc4ff',
        'cluster1': '#ffd34d',
        'lightness': '#c0a0e6',
        'force': '#6ba85a',  # force black/white/gold/silver — green border
        'dual': '#ff8855',   # dual-cluster combos — orange border
    }.get(kind, '#341c5a')


# Pre-generate shipped-reference thumbnails for each parent that has shipped
# children. Pulled directly from the atlas so they show the EXACT in-game
# render (catalog ID + name).
SHIPPED_REF_DIR = OUT_DIR / 'shipped-refs'
SHIPPED_REF_DIR.mkdir(exist_ok=True)
for f in SHIPPED_REF_DIR.glob('*.png'):
    f.unlink()
shipped_thumbs = {}  # parent_id -> [{new_id, name, thumb_file}, ...]
for parent_id, vmap in shipped_map.items():
    refs = []
    for vid, info in vmap.items():
        new_id = info.get('new_id')
        if not new_id:
            continue
        thumb = extract_atlas_thumb(f'cosmetic_{new_id}_idle_00')
        if thumb is None:
            continue
        thumb_file = f'{parent_id}__{new_id}.png'
        thumb.save(SHIPPED_REF_DIR / thumb_file)
        refs.append({
            'new_id': new_id,
            'name': info.get('name', new_id),
            'thumb_file': thumb_file,
        })
    if refs:
        # Sort by numeric id for stable order
        refs.sort(key=lambda r: int(r['new_id'][1:]) if r['new_id'][1:].isdigit() else 9999)
        shipped_thumbs[parent_id] = refs

sections_html = []
for slot in slot_order:
    items = by_slot[slot]
    if not items:
        continue
    sections_html.append(f'<h2 class="slot-hdr">{slot_label[slot]} · {len(items)} cosmetics</h2>')
    for c in items:
        cid = c['id']
        sel_set = set(selections.get(cid, []))
        var_cells = []
        for v in c['variants']:
            checked = 'checked' if v['id'] in sel_set else ''
            border = kind_color(v['kind'])
            var_cells.append(
                f'<label class="vcell" data-cid="{cid}" data-vid="{v["id"]}" '
                f'style="border-color:{border}">'
                f'<img src="imgs/{v["file"]}" alt="{v["label"]}"/>'
                f'<div class="vlbl">{v["label"]}</div>'
                f'<input type="checkbox" class="vcheck" {checked}/>'
                f'</label>'
            )

        # Shipped reference panel — small thumbs of already-shipped children
        # so Tim can see what's already in the catalog and avoid duplicates
        refs = shipped_thumbs.get(cid, [])
        if refs:
            ref_cells = ''.join(
                f'<div class="rcell" title="{r["new_id"]} · {r["name"]}">'
                f'<img src="shipped-refs/{r["thumb_file"]}" alt="{r["new_id"]}"/>'
                f'<div class="rlbl">{r["new_id"]}</div></div>'
                for r in refs
            )
            ref_panel = (
                f'<div class="refs">'
                f'<div class="refs-hdr">{len(refs)} shipped</div>'
                f'<div class="refs-grid">{ref_cells}</div>'
                f'</div>'
            )
        else:
            ref_panel = '<div class="refs empty">no shipped yet</div>'

        sections_html.append(
            f'''
        <div class="row" data-cid="{cid}">
          <div class="base">
            <img src="imgs/{c['base']}" alt="{cid}"/>
            <div class="bid">{cid}</div>
            <div class="bnm">{c['name']}</div>
            <div class="bclusters">{c['clusters']}</div>
            <div class="bcount"><span class="sel-count">{len(sel_set)}</span> / {len(c['variants'])} selected</div>
          </div>
          {ref_panel}
          <div class="variants">{''.join(var_cells)}</div>
        </div>'''
        )

hdr_swatches = ''.join(
    f'<div class="vh"><span class="sw" style="background:{hue_to_swatch(d)}"></span><span>{n}</span></div>'
    for n, d in HUE_TARGETS
)

# Embed initial selections so the page can render restored ticks even
# before JS runs
initial_sel_json = json.dumps(selections)

html = f'''<!doctype html>
<html><head><meta charset="utf-8"/>
<title>meowcert · cosmetic color variants</title>
<style>
  :root {{
    --bg: #1a0a2e; --bg2: #261540; --bg3: #341c5a;
    --text: #fff; --muted: #c0a0e6; --accent: #ffd34d;
  }}
  body {{ margin: 0; background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, sans-serif; font-size: 13px; }}
  .hdr {{ position: sticky; top: 40px; z-index: 50; background: var(--bg);
    padding: 14px 20px 10px; border-bottom: 1px solid var(--bg3); }}
  .hdr h1 {{ margin: 0 0 4px; font-size: 18px; color: var(--accent); }}
  .hdr .sub {{ color: var(--muted); font-size: 12px; margin-bottom: 8px; }}
  .palette {{ display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }}
  .vh {{ display: flex; align-items: center; gap: 4px; font-size: 11px;
    color: var(--muted); padding: 3px 7px; background: var(--bg2); border-radius: 4px; }}
  .vh .sw {{ width: 12px; height: 12px; border-radius: 3px; border: 1px solid #0006; }}
  .legend {{ font-size: 11px; color: var(--muted); padding: 6px 14px; background: #00000040;
    border-radius: 4px; }}
  .legend span {{ display: inline-block; width: 10px; height: 10px; border-radius: 2px;
    margin: 0 4px 0 10px; vertical-align: middle; }}
  .stats {{ margin-left: auto; padding: 4px 12px; background: var(--bg2); border-radius: 4px;
    color: var(--accent); font-weight: 700; font-size: 12px; }}
  .navbtn {{ display: inline-block; padding: 4px 12px; background: #4a7c3a; color: #fff;
    border: 1px solid #6ba85a; border-radius: 4px; font-size: 12px;
    cursor: pointer; font-family: inherit; margin-left: 16px; }}
  .navbtn:hover {{ background: #5a9c44; }}
  .navbtn:disabled {{ opacity: 0.55; cursor: progress; }}
  .navbtn.err {{ background: #8b2c2c; border-color: #c44; }}
  .navbtn.alt {{ background: #4a3a7c; border-color: #6a5aa8; }}
  .navbtn.alt:hover {{ background: #5a44a0; }}
  .slot-hdr {{ margin: 28px 20px 8px; color: var(--accent); font-size: 14px;
    letter-spacing: 1px; padding-bottom: 4px; border-bottom: 1px solid var(--bg3); }}
  .row {{ display: flex; gap: 14px; padding: 12px 20px; align-items: flex-start;
    border-bottom: 1px solid #2a1845; }}
  .row:nth-child(even) {{ background: #14082599; }}
  .base {{ flex: 0 0 140px; text-align: center; padding: 10px; background: var(--bg2);
    border-radius: 8px; border: 2px solid var(--accent); }}
  .refs {{ flex: 0 0 180px; background: #0c0420; border-radius: 8px; padding: 8px;
    border: 1.5px dashed #6ba85a; align-self: stretch; }}
  .refs.empty {{ color: var(--muted); font-style: italic; font-size: 10px;
    display: flex; align-items: center; justify-content: center; }}
  .refs-hdr {{ color: #6ba85a; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 6px; text-align: center; font-weight: 700; }}
  .refs-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(46px, 1fr));
    gap: 4px; }}
  .rcell {{ background: var(--bg2); border-radius: 4px; padding: 4px 2px;
    text-align: center; }}
  .rcell img {{ display: block; margin: 0 auto 2px; width: 36px; height: auto;
    image-rendering: pixelated; }}
  .rlbl {{ color: #b0e0a0; font-size: 8px; font-weight: 700; }}
  .base img {{ display: block; margin: 0 auto 6px; width: 80px; height: auto;
    image-rendering: pixelated; }}
  .base .bid {{ color: var(--accent); font-weight: 700; font-size: 13px; }}
  .base .bnm {{ color: var(--text); font-size: 11px; margin: 2px 0; }}
  .base .bclusters {{ color: var(--muted); font-size: 10px; margin-bottom: 4px; }}
  .base .bcount {{ color: var(--accent); font-size: 11px; font-weight: 700;
    margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--bg3); }}
  .variants {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
    gap: 6px; flex: 1; min-width: 0; }}
  .vcell {{ background: var(--bg2); border: 1.5px solid var(--bg3); border-radius: 6px;
    padding: 6px 4px 4px; text-align: center; min-width: 0; cursor: pointer; position: relative;
    transition: background 0.1s; }}
  .vcell:hover {{ background: #2e1a4a; }}
  .vcell.checked {{ background: #2a4a2c; border-color: #6ba85a !important; }}
  .vcell img {{ display: block; margin: 0 auto 3px; width: 56px; height: auto;
    image-rendering: pixelated; pointer-events: none; }}
  .vlbl {{ color: var(--muted); font-size: 9px; text-transform: uppercase;
    letter-spacing: 0.3px; pointer-events: none; line-height: 1.2; }}
  .vcell.checked .vlbl {{ color: #b0e0a0; }}
  .vcheck {{ position: absolute; top: 4px; right: 4px; transform: scale(1.2);
    accent-color: #6ba85a; cursor: pointer; }}
</style></head>
<body>
  <div class="hdr">
    <h1>cosmetic color variants</h1>
    <div class="sub">
      Click any variant or its checkbox to mark it for shipping.
      <strong>Border colors:</strong>
      <span class="legend"><span style="background:#341c5a"></span>whole-image hue
        <span style="background:#7bc4ff"></span>main-color only
        <span style="background:#ffd34d"></span>accent-color only
        <span style="background:#c0a0e6"></span>lightness
        <span style="background:#6ba85a"></span>force (black/white/gold/silver)
        <span style="background:#ff8855"></span>dual combo</span>
    </div>
    <div class="palette">
      {hdr_swatches}
      <button class="navbtn" id="gen-btn" onclick="regenerate()">🔄 Generate (delete + rerun)</button>
      <button class="navbtn alt" id="export-btn" onclick="exportSelected()">📋 Show selected</button>
      <div class="stats" id="stats-pill">0 selected</div>
    </div>
  </div>
  {''.join(sections_html)}

  <script src="/tools-nav.js"></script>
  <script>
    // Selections shape: {{ "c18": ["all_red", "cluster0_blue"], "c24": [...] }}
    let SELECTIONS = {initial_sel_json};

    function totalSelected() {{
      return Object.values(SELECTIONS).reduce((acc, arr) => acc + arr.length, 0);
    }}
    function updateStats() {{
      document.getElementById('stats-pill').textContent = totalSelected() + ' selected';
      // Per-row counters
      document.querySelectorAll('.row').forEach(row => {{
        const cid = row.dataset.cid;
        const n = (SELECTIONS[cid] || []).length;
        const counter = row.querySelector('.sel-count');
        if (counter) counter.textContent = n;
      }});
    }}
    function applyCheckedClasses() {{
      document.querySelectorAll('.vcell').forEach(cell => {{
        const cid = cell.dataset.cid;
        const vid = cell.dataset.vid;
        const isOn = (SELECTIONS[cid] || []).includes(vid);
        cell.classList.toggle('checked', isOn);
        const cb = cell.querySelector('.vcheck');
        if (cb && cb.checked !== isOn) cb.checked = isOn;
      }});
    }}

    async function persist() {{
      try {{
        await fetch('/save-variant-selections', {{
          method: 'POST', headers: {{ 'content-type': 'application/json' }},
          body: JSON.stringify(SELECTIONS),
        }});
      }} catch (e) {{
        console.error('Failed to save selections', e);
      }}
    }}

    function toggle(cid, vid) {{
      const arr = SELECTIONS[cid] || (SELECTIONS[cid] = []);
      const idx = arr.indexOf(vid);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(vid);
      if (arr.length === 0) delete SELECTIONS[cid];
      applyCheckedClasses();
      updateStats();
      persist();
    }}

    document.addEventListener('click', (e) => {{
      const cell = e.target.closest('.vcell');
      if (!cell) return;
      // The native checkbox click fires a separate click event on .vcell
      // (because .vcell is a <label>). Avoid double-toggle by only handling
      // the label-level click and letting the checkbox stay in sync via class.
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      toggle(cell.dataset.cid, cell.dataset.vid);
    }});
    document.addEventListener('change', (e) => {{
      if (!e.target.classList.contains('vcheck')) return;
      const cell = e.target.closest('.vcell');
      toggle(cell.dataset.cid, cell.dataset.vid);
    }});

    function exportSelected() {{
      const lines = [];
      lines.push(`# Selected cosmetic variants (${{totalSelected()}} total)`);
      Object.entries(SELECTIONS).forEach(([cid, vids]) => {{
        if (!vids.length) return;
        lines.push(`\\n${{cid}}: ${{vids.join(', ')}}`);
      }});
      const text = lines.join('\\n');
      navigator.clipboard.writeText(text).then(
        () => alert('Selected variants copied to clipboard:\\n\\n' + text),
        () => prompt('Copy this:', text)
      );
    }}

    async function regenerate() {{
      const btn = document.getElementById('gen-btn');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Generating…';
      btn.classList.remove('err');
      try {{
        const res = await fetch('/run-cosmetic-variants', {{ method: 'POST' }});
        const body = await res.json().catch(() => ({{ ok: false, error: 'bad json' }}));
        if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${{res.status}}`);
        btn.textContent = '✅ Reloading…';
        location.reload();
      }} catch (e) {{
        btn.classList.add('err');
        btn.textContent = '❌ ' + (e.message || 'failed');
        btn.disabled = false;
        setTimeout(() => {{ btn.textContent = original; btn.classList.remove('err'); }}, 5000);
      }}
    }}

    applyCheckedClasses();
    updateStats();
  </script>
</body></html>
'''
(OUT_DIR / 'index.html').write_text(html)
print(f'\nWrote {OUT_DIR / "index.html"}')
