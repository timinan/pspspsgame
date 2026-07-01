"""Generate a cat breed from the cat2 region template.

Reads a variant config JSON, colors every region of every template
frame, writes assets-raw/cat<N>/ frames plus a preview contact sheet.
See docs/cat-template-pipeline.md for the config format and ramp rules.

Usage: python3 scripts/gen-cat-variant.py variants/cats/cat200-buttermilk.json [more.json ...]
"""
import colorsys
import json
import sys
from pathlib import Path

from PIL import Image

SRC = Path('assets-raw/cat2')
TPL = Path('assets-raw/cat-template')
PREVIEWS = Path('variants/cats/previews')
W, H = 91, 64

# cat2's own palette per region — the identity mapping, and the ramp
# reference that derived ramps must reproduce when given cat2's bases.
CAT2 = {
    'coat1': '#92a1b9', 'coat2': '#657392', 'coat3': '#424c6e', 'accent': '#2a2f4e',
    'mark1': '#ffffff', 'mark2': '#b4b4b4', 'mark3': '#858585',
    'earInner1': '#571c27', 'earInner2': '#891e2b',
    'iris': '#ffa214', 'irisHi1': '#ffc825', 'irisHi2': '#ffeb57',
    'glint': '#ffffff', 'tongue': '#f68187', 'outline': '#000000',
    'whisker': '#ffffff',
}


def hex_rgb(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def to_hsv(rgb):
    return colorsys.rgb_to_hsv(*(c / 255 for c in rgb))


def from_hsv(h, s, v):
    return tuple(round(c * 255) for c in colorsys.hsv_to_rgb(h % 1.0, min(max(s, 0), 1), min(max(v, 0), 1)))


def derive(base_rgb, ref_base, ref_target, v_cap=None):
    """Color for a ramp slot: apply cat2's base→slot HSV relationship to
    a new base. Hue shifts add; S/V scale multiplicatively (with S
    falling back to the reference's own S for grey bases, so grey coats
    still gain the reference's saturation structure only if the base has
    any saturation at all)."""
    bh, bs, bv = to_hsv(base_rgb)
    rh, rs, rv = to_hsv(hex_rgb(ref_base))
    th, ts, tv = to_hsv(hex_rgb(ref_target))
    h = bh + (th - rh)
    s = bs * (ts / rs) if rs > 0 else bs
    v = bv * (tv / rv) if rv > 0 else bv
    if v_cap is not None:
        v = min(v, v_cap)
    return from_hsv(h, s, v)


def build_palette(cfg):
    """Region -> RGB for one variant. Explicit array overrides beat
    single-base derivation beats cat2 defaults."""
    pal = {r: hex_rgb(c) for r, c in CAT2.items()}

    # Derived coat shading uses GENTLER steps than cat2's artist ramp.
    # cat2's own ratios (0.79/0.59 brightness) read as "two different
    # colors" on solid cats — Butters (cat13) is really shaded at ~0.94
    # of base. Tim locked the soft ramp for all generated cats
    # (2026-07-01); explicit ramp arrays bypass this.
    SOFT_COAT = {'coat2': (0.94, 1.15), 'coat3': (0.82, 1.35)}

    def ramp(key, slots, ref_base):
        val = cfg.get(key)
        if val is None:
            return
        if isinstance(val, list):
            if len(val) != len(slots):
                raise SystemExit(f'{key}: expected {len(slots)} colors, got {len(val)}')
            for slot, c in zip(slots, val):
                pal[slot] = hex_rgb(c)
            return
        base = hex_rgb(val)
        for slot in slots:
            if key == 'coat' and slot in SOFT_COAT:
                v_ratio, s_ratio = SOFT_COAT[slot]
                bh, bs, bv = to_hsv(base)
                rh = to_hsv(hex_rgb(ref_base))[0]
                th = to_hsv(hex_rgb(CAT2[slot]))[0]
                pal[slot] = from_hsv(bh + (th - rh), bs * s_ratio, bv * v_ratio)
                continue
            # Pupils/nose/mouth must stay dark on light coats or the eye
            # reads as a milky film — cap derived accent brightness at
            # cat2's own accent level.
            cap = 0.32 if slot == 'accent' else None
            pal[slot] = derive(base, ref_base, CAT2[slot], v_cap=cap)

    ramp('coat', ['coat1', 'coat2', 'coat3', 'accent'], CAT2['coat1'])
    # "markings": "coat" = solid-colored cat: belly/blaze/muzzle melt into
    # the coat, and their shading pixels use the coat's own shades (the
    # white-marking shading greys read as smudge artifacts otherwise).
    if cfg.get('markings') == 'coat':
        for m, c in (('mark1', 'coat1'), ('mark2', 'coat2'), ('mark3', 'coat3')):
            pal[m] = pal[c]
    else:
        ramp('markings', ['mark1', 'mark2', 'mark3'], CAT2['mark1'])
    ramp('earInner', ['earInner2', 'earInner1'], CAT2['earInner2'])
    ramp('eyes', ['iris', 'irisHi1', 'irisHi2'], CAT2['iris'])
    if 'accent' in cfg:
        pal['accent'] = hex_rgb(cfg['accent'])
    # Whisker flecks follow the markings color (they're white on cat2
    # because his markings are white; on a solid cat they melt into the
    # coat). Explicit "whisker" still overrides.
    pal['whisker'] = pal['mark1']
    for key in ('tongue', 'outline', 'whisker', 'glint'):
        if key in cfg:
            pal[key] = hex_rgb(cfg[key])
    return pal


def generate(cfg_path):
    cfg = json.loads(Path(cfg_path).read_text())
    cid, name = cfg['id'], cfg['name']
    if 'fx' in cfg:
        raise SystemExit('fx is never recolorable')
    # "split": {"left": {...}, "right": {...}} — two-face cat. Each side
    # is a full palette (base config + side overrides); the divide is the
    # body's vertical midline, recomputed per frame.
    split = cfg.get('split')
    if split:
        base_cfg = {k: v for k, v in cfg.items() if k != 'split'}
        pal = build_palette({**base_cfg, **split.get('left', {})})
        pal_right = build_palette({**base_cfg, **split.get('right', {})})
    else:
        pal = build_palette(cfg)
        pal_right = pal

    regions = json.loads((TPL / 'regions.json').read_text())
    ridx = {int(v): k for k, v in regions['palette_index'].items()}

    out_dir = Path(f'assets-raw/{cid}')
    out_dir.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)

    frames = sorted(TPL.glob('*.png'))
    frames = [f for f in frames if f.name != 'qa-sheet.png']

    # Split midline per frame: midpoint of the eye bbox (stable even when
    # one eye squints). Blink frames have no eye pixels — they inherit
    # the mean anchor of their own animation so the line never jumps.
    split_cx = {}
    if split:
        eye_ids = {v for k, v in json.loads((TPL / 'regions.json').read_text())['palette_index'].items()
                   if k in ('iris', 'irisHi1', 'irisHi2', 'glint')}
        by_anim = {}
        for f in frames:
            tp = Image.open(f).load()
            xs = [x for y in range(H) for x in range(W) if tp[x, y] in eye_ids]
            if xs:
                split_cx[f.stem] = (min(xs) + max(xs)) // 2
                by_anim.setdefault(f.stem.rsplit('_', 1)[0], []).append(split_cx[f.stem])
        for f in frames:
            if f.stem not in split_cx:
                anim = by_anim.get(f.stem.rsplit('_', 1)[0])
                split_cx[f.stem] = round(sum(anim) / len(anim)) if anim else W // 2

    for f in frames:
        tpl = Image.open(f)
        src = Image.open(SRC / f'cat2_{f.stem}.png').convert('RGBA')
        tp, sp = tpl.load(), src.load()
        out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        op = out.load()
        cx = split_cx.get(f.stem, W // 2)
        for y in range(H):
            for x in range(W):
                idx = tp[x, y]
                if idx == 0:
                    continue
                region = ridx[idx]
                side = pal if x <= cx else pal_right
                op[x, y] = (*sp[x, y][:3], 255) if region == 'fx' else (*side[region], 255)
        out.save(out_dir / f'{cid}_{f.stem}.png')

    # Preview contact sheet: the four anims that actually ship, 4x.
    picks = ['idle_00', 'lick_04', 'meow_05', 'hiss_05']
    SCALE = 4
    sheet = Image.new('RGBA', (W * SCALE * 2, H * SCALE * 2), (30, 30, 40, 255))
    for i, pick in enumerate(picks):
        im = Image.open(out_dir / f'{cid}_{pick}.png')
        im = im.resize((W * SCALE, H * SCALE), Image.NEAREST)
        sheet.paste(im, ((i % 2) * W * SCALE, (i // 2) * H * SCALE), im)
    preview = PREVIEWS / f'{cid}.png'
    sheet.save(preview)
    print(f'{cid} ({name}): {len(frames)} frames → {out_dir}, preview → {preview}')


def write_manifest():
    """Rebuild variants/cats/manifest.json from every config on disk —
    the Cat Variants tools page renders from this."""
    entries = []
    for cfg_path in sorted(Path('variants/cats').glob('*.json')):
        if cfg_path.name == 'manifest.json':
            continue
        cfg = json.loads(cfg_path.read_text())
        preview = PREVIEWS / f"{cfg['id']}.png"
        entries.append({
            'id': cfg['id'],
            'name': cfg['name'],
            'config': cfg_path.name,
            'preview': f"previews/{cfg['id']}.png" if preview.exists() else None,
        })
    Path('variants/cats/manifest.json').write_text(json.dumps(entries, indent=2))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for cfg_path in sys.argv[1:]:
        generate(cfg_path)
    write_manifest()
