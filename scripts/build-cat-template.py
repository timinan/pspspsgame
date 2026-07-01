"""Build the cat region template from cat2 (Biscuit).

Labels every pixel of every assets-raw/cat2 frame with a semantic region
id and writes indexed region maps + regions.json + a flag-colored QA
contact sheet. See docs/cat-template-pipeline.md for the taxonomy and
the freeze rules. Rerunnable and deterministic; never mutates cat2.

Usage: python3 scripts/build-cat-template.py
"""
import json
from collections import deque
from pathlib import Path

from PIL import Image

SRC = Path('assets-raw/cat2')
OUT = Path('assets-raw/cat-template')
W, H = 91, 64

# Region ids in palette order. Index 0 is reserved for transparent.
REGIONS = [
    'coat1', 'coat2', 'coat3', 'accent',
    'mark1', 'mark2', 'mark3',
    'earInner1', 'earInner2',
    'iris', 'irisHi1', 'irisHi2', 'glint', 'eyeMid',
    'tongue', 'outline', 'whisker', 'fx',
]
RIDX = {r: i + 1 for i, r in enumerate(REGIONS)}

# Flag colors for the QA sheet / indexed palette. Chosen to be readable
# against the dark QA background and unmistakably distinct per region.
FLAG = {
    'coat1': (60, 130, 255), 'coat2': (40, 95, 210), 'coat3': (25, 60, 160),
    'accent': (255, 0, 255),
    'mark1': (90, 230, 90), 'mark2': (60, 175, 60), 'mark3': (35, 120, 35),
    'earInner1': (200, 40, 40), 'earInner2': (140, 20, 20),
    'iris': (255, 150, 0), 'irisHi1': (255, 210, 0), 'irisHi2': (255, 245, 120),
    'glint': (255, 255, 255), 'eyeMid': (180, 255, 0),
    'tongue': (255, 130, 180), 'outline': (110, 110, 110),
    'whisker': (0, 230, 230), 'fx': (170, 0, 255),
}

# Unambiguous source color -> region.
DIRECT = {
    (146, 161, 185): 'coat1', (101, 115, 146): 'coat2', (66, 76, 110): 'coat3',
    (42, 47, 78): 'accent',
    (87, 28, 39): 'earInner1', (137, 30, 43): 'earInner2',
    (255, 162, 20): 'iris', (246, 129, 135): 'tongue',
    (255, 0, 64): 'fx', (255, 80, 0): 'fx',
    (0, 0, 0): 'outline',
}
WHITE_GROUP = {(255, 255, 255): 'mark1', (180, 180, 180): 'mark2', (133, 133, 133): 'mark3'}
YELLOWS = {(255, 200, 37): 'irisHi1', (255, 235, 87): 'irisHi2'}
EYE_REGIONS = ('iris', 'irisHi1', 'irisHi2', 'accent')


def components(member):
    """Yield connected components (8-adjacency) of coords where member(x, y)."""
    seen = set()
    for y in range(H):
        for x in range(W):
            if (x, y) in seen or not member(x, y):
                continue
            comp, q = [], deque([(x, y)])
            seen.add((x, y))
            while q:
                cx, cy = q.popleft()
                comp.append((cx, cy))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in seen and member(nx, ny):
                            seen.add((nx, ny))
                            q.append((nx, ny))
            yield comp


def neighbors8(x, y):
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx or dy:
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H:
                    yield nx, ny


def label_frame(im):
    px = im.load()

    def rgb(x, y):
        return px[x, y][:3]

    def opaque(x, y):
        return px[x, y][3] == 255

    labels = {}

    # Pass 1: direct colors (black provisionally = outline).
    for y in range(H):
        for x in range(W):
            if opaque(x, y):
                region = DIRECT.get(rgb(x, y))
                if region:
                    labels[(x, y)] = region

    # The cat = the largest connected component of opaque pixels AFTER
    # removing overlay-colored pixels (sparkle yellows, hiss-glyph reds)
    # from the graph. Sparkles are the only thing that ever bridges the
    # floating MEOW/HISS text to the silhouette, and sparkles are always
    # yellow/red — so cutting them out of the adjacency leaves the text
    # (plus its black shadow pixels) as separate components.
    OVERLAY = set(YELLOWS) | {(255, 0, 64), (255, 80, 0)}

    def body_member(x, y):
        return opaque(x, y) and rgb(x, y) not in OVERLAY

    body = set(max(components(body_member), key=len, default=[]))
    # Detached pixels in the lower band are clipped body parts (tail fur
    # cut by the frame edge), not overlay art — overlays only ever
    # appear in the top band.
    body |= {
        (x, y) for y in range(24, H) for x in range(W)
        if opaque(x, y) and rgb(x, y) not in OVERLAY
    }
    for y in range(H):
        for x in range(W):
            if opaque(x, y) and (x, y) not in body and rgb(x, y) not in OVERLAY:
                labels[(x, y)] = 'fx'

    # Pass 2: yellows — eye highlights (the meow star-eyes and iris
    # glimmer) always sit within 2px of eye pixels (iris or the accent
    # eye circle). Everything else yellow is sparkle overlay (fx), even
    # when a sparkle arm crosses the head.
    def near_eye_core(x, y):
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and labels.get((nx, ny)) in ('iris', 'accent'):
                    return True
        return False

    for y in range(H):
        for x in range(W):
            if opaque(x, y) and rgb(x, y) in YELLOWS:
                labels[(x, y)] = YELLOWS[rgb(x, y)] if near_eye_core(x, y) else 'fx'

    # Pass 3: white group.
    #  - floating component  -> fx (text, sparkle cores)
    #  - tiny comp adjacent to eye pixels -> glint (locked white eye dot)
    #  - 1px-tall white run whose above/below neighbors are never
    #    white-group -> whisker
    #  - everything else -> mark1..3 by shade
    def is_white(x, y):
        return opaque(x, y) and rgb(x, y) in WHITE_GROUP

    for comp in components(is_white):
        cs = set(comp)
        if not (cs & body):
            for p in comp:
                labels[p] = 'fx'
            continue
        near_eye = any(
            labels.get(n) in EYE_REGIONS for p in comp for n in neighbors8(*p)
        )
        if len(comp) <= 6 and near_eye:
            for p in comp:
                labels[p] = 'glint'
            continue
        # MEOW/HISS letter strokes: tiny white comps bordered almost
        # entirely by black (their glyph border, which merges with the
        # cat outline and defeats connectivity). Whiskers border coat,
        # the muzzle/belly blobs are large — neither matches.
        nb = {
            n for p in comp for n in neighbors8(*p)
            if opaque(*n) and rgb(*n) not in WHITE_GROUP
        }
        # Position gate: overlay art lives in the top band of the frame.
        # The white tail tip matches the size/border signature but sits
        # in the lower half — never treat it as a letter stroke.
        if len(comp) <= 20 and nb and min(p[1] for p in comp) < 24:
            black_frac = sum(1 for n in nb if rgb(*n) == (0, 0, 0)) / len(nb)
            if black_frac >= 0.6:
                for p in comp:
                    labels[p] = 'fx'
                continue
        for (x, y) in comp:
            above = (x, y - 1) in cs or (y > 0 and is_white(x, y - 1))
            below = (x, y + 1) in cs or (y < H - 1 and is_white(x, y + 1))
            if rgb(x, y) == (255, 255, 255) and not above and not below:
                labels[(x, y)] = 'whisker'
            else:
                labels[(x, y)] = WHITE_GROUP[rgb(x, y)]

    # Cleanup: white pixels embedded in sparkle overlays (a sparkle core
    # crossing the head) end up labeled mark/whisker but sit surrounded
    # by fx — absorb them into fx. Two sweeps for chains.
    for _ in range(2):
        for (x, y), region in list(labels.items()):
            if region in ('mark1', 'mark2', 'mark3', 'whisker', 'glint'):
                fx_n = sum(1 for n in neighbors8(x, y) if labels.get(n) == 'fx')
                if fx_n >= 3:
                    labels[(x, y)] = 'fx'

    # The eye MIDDLE (dark pupil area) shares its color with the
    # nose/mouth/creases (accent), but must be independently recolorable
    # — Tim's three-part eye model (outer=iris, middle=eyeMid,
    # inner=glint). An accent component belongs to the eye when it
    # touches any eye pixel (iris ring in idle/hiss, star/glint in meow).
    eye_px = {p for p, r in labels.items() if r in ('iris', 'irisHi1', 'irisHi2', 'glint')}

    def is_accent(x, y):
        return labels.get((x, y)) == 'accent'

    for comp in components(is_accent):
        if any(n in eye_px for p in comp for n in neighbors8(*p)):
            for p in comp:
                labels[p] = 'eyeMid'

    return labels


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    frames = sorted(SRC.glob('cat2_*.png'))
    assert frames, f'no frames found in {SRC}'

    palette = [0, 0, 0]  # index 0: transparent
    for r in REGIONS:
        palette.extend(FLAG[r])
    palette.extend([0] * (768 - len(palette)))

    stats = {}
    maps = {}
    for f in frames:
        im = Image.open(f).convert('RGBA')
        assert im.size == (W, H), f'{f.name}: unexpected size {im.size}'
        labels = label_frame(im)
        # Every opaque pixel must be labeled — zero-gap rule.
        px = im.load()
        for y in range(H):
            for x in range(W):
                if px[x, y][3] == 255 and (x, y) not in labels:
                    raise SystemExit(f'{f.name}: unlabeled opaque pixel at {x},{y} color {px[x, y]}')

        out = Image.new('P', (W, H), 0)
        out.putpalette(palette)
        op = out.load()
        for (x, y), region in labels.items():
            op[x, y] = RIDX[region]
        name = f.stem.replace('cat2_', '')  # e.g. idle_00
        out.save(OUT / f'{name}.png', transparency=0)
        maps[name] = labels

        counts = {}
        for region in labels.values():
            counts[region] = counts.get(region, 0) + 1
        stats[name] = counts

    with open(OUT / 'regions.json', 'w') as fh:
        json.dump({
            'source': 'assets-raw/cat2',
            'regions': REGIONS,
            'palette_index': RIDX,
            'flag_colors': FLAG,
            'frame_stats': stats,
        }, fh, indent=2)

    # QA sheet: all frames, flag-colored, 2x, 8 per row.
    SCALE, COLS = 2, 8
    rows = (len(frames) + COLS - 1) // COLS
    sheet = Image.new('RGBA', (COLS * W * SCALE, rows * H * SCALE), (24, 24, 32, 255))
    for i, f in enumerate(frames):
        name = f.stem.replace('cat2_', '')
        vis = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        vp = vis.load()
        for (x, y), region in maps[name].items():
            vp[x, y] = (*FLAG[region], 255)
        vis = vis.resize((W * SCALE, H * SCALE), Image.NEAREST)
        sheet.paste(vis, ((i % COLS) * W * SCALE, (i // COLS) * H * SCALE), vis)
    sheet.save(OUT / 'qa-sheet.png')

    total = {}
    for counts in stats.values():
        for r, n in counts.items():
            total[r] = total.get(r, 0) + n
    print(f'{len(frames)} frames labeled → {OUT}')
    for r in REGIONS:
        print(f'  {r:10s} {total.get(r, 0):7d} px')


if __name__ == '__main__':
    main()
