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
    'glint': '#ffffff', 'eyeMid': '#2a2f4e',
    'tongue': '#f68187', 'outline': '#000000',
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
    # Three-part eye model (Tim, 2026-07-01): outer = iris ring, middle =
    # the dark part (default cat2 navy, NEVER derived from anything),
    # inner = the white glints. The meow star-eyes + glimmer (irisHi)
    # stay cat2's yellows for ALL cats — locked, no param.
    if 'eyeOuter' in cfg or 'eyes' in cfg:
        pal['iris'] = hex_rgb(cfg.get('eyeOuter', cfg.get('eyes')))
    if 'eyeMid' in cfg:
        pal['eyeMid'] = hex_rgb(cfg['eyeMid'])
    if 'eyeInner' in cfg:
        pal['glint'] = hex_rgb(cfg['eyeInner'])
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


def _propagate_step(prev_labels, prev_src, cur_src, cur_mask, max_r):
    """One frame-to-frame label transfer. Every body pixel inherits the
    majority label of the nearest pixels in the previous frame with the
    SAME cat2 source color (expanding Chebyshev rings, r=0..max_r);
    pixels with no color match anywhere fall back to nearest-any."""
    labels = {}
    for (x, y) in cur_mask:
        color = cur_src[(x, y)]
        found = None
        for r in range(0, max_r + 1):
            votes = []
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if max(abs(dx), abs(dy)) != r:
                        continue
                    q = (x + dx, y + dy)
                    lab = prev_labels.get(q)
                    if lab is not None and prev_src.get(q) == color:
                        votes.append(lab)
            if votes:
                found = round(sum(votes) / len(votes))
                break
        if found is None:
            for r in range(1, max_r + 4):
                votes = [prev_labels[q] for dy in range(-r, r + 1) for dx in range(-r, r + 1)
                         if (q := (x + dx, y + dy)) in prev_labels]
                if votes:
                    found = round(sum(votes) / len(votes))
                    break
        labels[(x, y)] = found if found is not None else 0
    return labels


def _cohere(labels, src, mask):
    """Per-frame label coherence. Small connected blobs of one source
    color (paw tips, ear tips, glint patches — anatomical units <= 30px)
    get a winner-take-all label so half-flipped tips can't happen; then
    two speckle sweeps flip isolated pixels to the local majority."""
    seen = set()
    from collections import deque
    for start in mask:
        if start in seen:
            continue
        color = src[start]
        comp, q = [], deque([start])
        seen.add(start)
        while q:
            (cx, cy) = q.popleft()
            comp.append((cx, cy))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    n = (cx + dx, cy + dy)
                    if n in mask and n not in seen and src[n] == color:
                        seen.add(n)
                        q.append(n)
        if len(comp) <= 30:
            majority = round(sum(labels[p] for p in comp) / len(comp))
            for p in comp:
                labels[p] = majority
    for _ in range(2):
        flips = []
        for (x, y), lab in labels.items():
            nb = [labels[q] for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                  if (dx or dy) and (q := (x + dx, y + dy)) in labels]
            if len(nb) >= 3 and sum(1 for v in nb if v == lab) <= 1:
                flips.append(((x, y), round(sum(nb) / len(nb))))
        for p, v in flips:
            labels[p] = v
    return labels


def propagate_labels(anim_seqs, ref_stem, seed_labels, src_pixels, body_masks):
    """Body-locked pattern tracking with ONE reference for the whole cat.
    seed_labels: {(x,y): 0|1} on the reference frame (idle_00). Every
    other animation's first frame is bridged FROM the reference with a
    wide search window (all anims start near the sitting pose), then
    propagation runs frame-to-frame within the anim. This keeps the
    pattern consistent across animations — the same ear tip has the same
    color in idle, lick, meow, and hiss. Returns {stem: {(x,y): 0|1}}."""
    out = {ref_stem: _cohere(dict(seed_labels), src_pixels[ref_stem], body_masks[ref_stem])}
    for anim, seq in anim_seqs.items():
        chain = [s for s in seq if s != ref_stem]
        prev = ref_stem
        for i, stem in enumerate(chain):
            max_r = 8 if i == 0 and not stem.startswith(prev.rsplit('_', 1)[0]) else 4
            labels = _propagate_step(out[prev], src_pixels[prev], src_pixels[stem],
                                     body_masks[stem], max_r)
            out[stem] = _cohere(labels, src_pixels[stem], body_masks[stem])
            prev = stem
    return out


def generate(cfg_path):
    cfg = json.loads(Path(cfg_path).read_text())
    cid, name = cfg['id'], cfg['name']
    if 'fx' in cfg:
        raise SystemExit('fx is never recolorable')
    # "split": {"left": {...}, "right": {...}} — two-face cat, divided at
    # the body's vertical midline (eye-anchored, recomputed per frame).
    # "split": {"top": {...}, "bottom": {...}} — head/body cat, divided
    # at the chin-safe neck waist (ported from gen-cat-variants.py:
    # narrowest silhouette row in y=36..50, split one row below, so the
    # chin always stays head-colored).
    # "pattern": {"type": "checker", "size": 5, "a": {...}, "b": {...}} —
    # alternating grid of two full palettes over the fur. The grid is
    # anchored to the body per frame (eye-anchor x, body-top y) so the
    # checkers ride with the cat instead of swimming in screen space.
    pattern = cfg.get('pattern')
    split = cfg.get('split')
    horizontal = bool(split) and 'top' in split
    if pattern:
        if pattern.get('type') != 'checker':
            raise SystemExit(f"unknown pattern type: {pattern.get('type')}")
        base_cfg = {k: v for k, v in cfg.items() if k != 'pattern'}
        pal = build_palette({**base_cfg, **pattern.get('a', {})})
        pal_right = build_palette({**base_cfg, **pattern.get('b', {})})
    elif split:
        base_cfg = {k: v for k, v in cfg.items() if k != 'split'}
        first = split.get('top', split.get('left', {}))
        second = split.get('bottom', split.get('right', {}))
        pal = build_palette({**base_cfg, **first})
        pal_right = build_palette({**base_cfg, **second})
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

    def waist_y(tp):
        """Chin-safe head/body split row: narrowest silhouette row in the
        neck zone (y=36..50), one row below. Fallback 44."""
        best_y, best_w = None, 10 ** 9
        for y in range(36, 50):
            xs = [x for x in range(W) if tp[x, y]]
            if len(xs) < 4:
                continue
            w = max(xs) - min(xs) + 1
            if w < best_w:
                best_w, best_y = w, y
        return (best_y + 1) if best_y is not None else 44

    # Split midline per frame: midpoint of the eye bbox (stable even when
    # one eye squints). Blink frames have no eye pixels — they inherit
    # the mean anchor of their own animation so the line never jumps.
    # Splits (Tim, 2026-07-02): a FIXED straight line — same x (or waist
    # y) in every frame of every animation, derived once from idle_00.
    # The only body-locked exception is the licking paw (template
    # parts.json, frozen), which crosses the line and keeps its root
    # side's color. No per-pixel propagation — that produced wobble.
    split_line = None
    paw_px = {}
    if split:
        tp0 = Image.open(TPL / 'idle_00.png').load()
        eye_ids = {v for k, v in json.loads((TPL / 'regions.json').read_text())['palette_index'].items()
                   if k in ('iris', 'irisHi1', 'irisHi2', 'glint')}
        if horizontal:
            def _waist(tp):
                best_y, best_w = None, 10 ** 9
                for y in range(36, 50):
                    xs = [x for x in range(W) if tp[x, y]]
                    if len(xs) >= 4 and (xs[-1] - xs[0] + 1) < best_w:
                        best_w, best_y = xs[-1] - xs[0] + 1, y
                return (best_y + 1) if best_y is not None else 44
            split_line = _waist(tp0)
        else:
            xs = [x for y in range(H) for x in range(W) if tp0[x, y] in eye_ids]
            split_line = (min(xs) + max(xs)) // 2 if xs else W // 2
        parts_path = TPL / 'parts.json'
        if parts_path.exists():
            paw_px = {stem: {tuple(p) for p in pts}
                      for stem, pts in json.loads(parts_path.read_text())['lick_paw'].items()}

    # Checkers stay body-locked via propagation until the frozen
    # correspondence map lands (see resume-prompt-2026-07-02).
    locked = {}
    if pattern:
        tmaps = {f.stem: Image.open(f).load() for f in frames}
        smaps = {f.stem: Image.open(SRC / f'cat2_{f.stem}.png').convert('RGBA').load() for f in frames}
        body_masks = {
            stem: {(x, y) for y in range(H) for x in range(W)
                   if tp[x, y] and ridx[tp[x, y]] != 'fx'}
            for stem, tp in tmaps.items()
        }
        src_pixels = {
            stem: {p: smaps[stem][p[0], p[1]][:3] for p in mask}
            for stem, mask in body_masks.items()
        }
        eye_regions = ('iris', 'irisHi1', 'irisHi2', 'glint')
        by_anim = {}
        for f in frames:
            by_anim.setdefault(f.stem.rsplit('_', 1)[0], []).append(f.stem)
        for seq in by_anim.values():
            seq.sort()
        # ONE geometric seed on the reference frame; every animation
        # bridges from it (see propagate_labels).
        ref = 'idle_00'
        mask0 = body_masks[ref]
        cell = int(pattern.get('size', 5))
        ax = (min(p[0] for p in mask0) + max(p[0] for p in mask0)) // 2
        ay = min(p[1] for p in mask0)
        seed = {p: ((p[0] - ax) // cell + (p[1] - ay) // cell) % 2 for p in mask0}
        locked = propagate_labels(by_anim, ref, seed, src_pixels, body_masks)

    for f in frames:
        tpl = Image.open(f)
        src = Image.open(SRC / f'cat2_{f.stem}.png').convert('RGBA')
        tp, sp = tpl.load(), src.load()
        out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        op = out.load()
        frame_labels = locked.get(f.stem, {})
        frame_paw = paw_px.get(f.stem, set())
        for y in range(H):
            for x in range(W):
                idx = tp[x, y]
                if idx == 0:
                    continue
                region = ridx[idx]
                if split:
                    if (x, y) in frame_paw:
                        # licking paw keeps its root side: left palette
                        # for L/R splits, body (bottom) for head/body.
                        side = pal_right if horizontal else pal
                    elif horizontal:
                        side = pal if y < split_line else pal_right
                    else:
                        side = pal if x <= split_line else pal_right
                elif pattern:
                    side = pal_right if frame_labels.get((x, y)) == 1 else pal
                else:
                    side = pal
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
