"""Generate the 12 Merch-shop crate sprites as PREVIEWS ONLY.

4 categories (cat / cosmetic / background / effect) x 3 tiers
(standard / golden / mythic) = 12 BoxIds in src/shared/state.ts.

Locked geometry: one wooden-chest silhouette shared by all 12. The
only things that vary are (a) the lid motif per category and (b) the
trim + palette per tier. No randomness beyond a fixed per-crate seed
(mythic star specks), so output is deterministic across runs.

Outputs (this task writes NOTHING into the game or public/assets):
  variants/crates/crate-<boxId>.png      64x64 RGBA, hard pixel edges
  variants/crates/previews/crates-sheet.png   4 cols x 3 rows, 4x NEAREST
  variants/crates/manifest.json          id -> file

Usage: python3 scripts/gen-crate-sprites.py
"""
import json
import random
import zlib
from pathlib import Path

from PIL import Image

OUT = Path('variants/crates')
PREVIEWS = OUT / 'previews'
S = 64  # canvas

# ── Data table: everything a tweak would touch lives here ───────────────
# category base BoxId (tier suffix appended) + motif key
CATEGORIES = [
    ('cat', 'catBox', 'Cat'),
    ('cosmetic', 'cosmeticBox', 'Cosmetic'),
    ('background', 'backgroundBox', 'Background'),
    ('effect', 'effectsBox', 'Effect'),
]

# tier -> palette + trim params. wood = (light, mid, dark), outline,
# rim (glow, only mythic). seed is per (category,tier) below.
TIERS = {
    'standard': {
        'suffix': '',
        'label': 'STANDARD',
        'wood': ('#b5763a', '#8a5326', '#5c3417'),
        'outline': '#241206',
        'rope': '#c9a86a',      # rope band
        'trim': None,
        'starfield': False,
        'rim': None,
    },
    'golden': {
        'suffix': 'Golden',
        'label': 'GOLDEN',
        'wood': ('#c98a3e', '#a5641f', '#6e3d12'),  # warmer wood
        'outline': '#2e1606',
        'rope': None,
        'trim': '#ffd34d',      # gilt trim + clasp
        'starfield': False,
        'rim': None,
    },
    'mythic': {
        'suffix': 'Mythic',
        'label': 'MYTHIC',
        'wood': ('#3a1f6e', '#2a1454', '#1c0d3a'),  # deep-purple body
        'outline': '#0b041a',
        'rope': None,
        'trim': '#b066ff',      # purple trim
        'starfield': True,
        'rim': '#b066ff',       # glow halo
    },
}

# palette anchors
GOLD = '#ffd34d'
STAR = '#ffffff'


def hx(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# ── Locked chest geometry (derived once, shared by all 12) ──────────────
BODY_L, BODY_R = 9, 54          # 46 wide
BODY_T, BODY_B = 33, 55         # 22 tall
LID_L, LID_R = 7, 56            # slight overhang each side
LID_BOT = 32                    # lid meets body (seam at 32/33)
SEAM_Y = 33
CX = 32                         # visual centre column


def lid_top(x):
    """Domed lid profile: centre highest (y=17), edges lower (y=24)."""
    half = (LID_R - LID_L) / 2
    t = (x - (LID_L + half)) / half          # -1..1
    return round(24 - 7 * (1 - t * t))


def silhouette():
    """Set of (x,y) inside the full chest (lid + body)."""
    pts = set()
    for x in range(LID_L, LID_R + 1):
        for y in range(lid_top(x), LID_BOT + 1):
            pts.add((x, y))
    for x in range(BODY_L, BODY_R + 1):
        for y in range(BODY_T, BODY_B + 1):
            pts.add((x, y))
    return pts


class Canvas:
    def __init__(self):
        self.img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        self.px = self.img.load()

    def set(self, x, y, rgb, a=255):
        if 0 <= x < S and 0 <= y < S:
            self.px[x, y] = (*rgb, a)

    def get(self, x, y):
        return self.px[x, y]


def draw_crate(category, tier):
    t = TIERS[tier]
    light, mid, dark = (hx(c) for c in t['wood'])
    outline = hx(t['outline'])
    body = silhouette()
    c = Canvas()

    # 1. flat outline silhouette, then inset interior gets shading so a
    #    1px dark outline survives on every edge.
    def interior(x, y):
        return all((x + dx, y + dy) in body
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1))

    for (x, y) in body:
        c.set(x, y, outline)

    rng = random.Random(0)  # unused placeholder, kept deterministic

    # 2. wood/starfield shading on interior pixels
    for (x, y) in body:
        if not interior(x, y):
            continue
        is_lid = y <= LID_BOT
        if t['starfield']:
            # deep-purple gradient, darker toward bottom, lighter dome top
            if is_lid:
                lt = (y - lid_top(x)) / max(1, (LID_BOT - lid_top(x)))
                col = mix(light, mid, lt)
            else:
                lt = (y - BODY_T) / max(1, (BODY_B - BODY_T))
                col = mix(mid, dark, lt)
            c.set(x, y, col)
        else:
            # plank shading: light dome / left highlight, dark right+bottom
            if is_lid:
                lt = (y - lid_top(x)) / max(1, (LID_BOT - lid_top(x)))
                col = light if lt < 0.35 else (mid if lt < 0.8 else dark)
            else:
                col = mid
                if x <= BODY_L + 2:
                    col = light
                if x >= BODY_R - 2 or y >= BODY_B - 2:
                    col = dark
            c.set(x, y, col)

    # 3. plank seams on the body (skip for starfield)
    if not t['starfield']:
        for sx in (BODY_L + 15, BODY_L + 30):
            for y in range(BODY_T + 1, BODY_B):
                if (sx, y) in body and interior(sx, y):
                    c.set(sx, y, dark)
                if (sx + 1, y) in body and interior(sx + 1, y):
                    c.set(sx + 1, y, light)

    # 4. lid seam: dark line where lid meets body + a lip highlight
    lip = light if not t['starfield'] else hx('#4a2d82')
    for x in range(BODY_L, BODY_R + 1):
        if (x, SEAM_Y) in body:
            c.set(x, SEAM_Y, outline)
        if interior(x, SEAM_Y - 1):
            c.set(x, SEAM_Y - 1, dark)
        if interior(x, SEAM_Y + 1):
            c.set(x, SEAM_Y + 1, lip)

    # 5. mythic star specks (fixed seed per crate)
    if t['starfield']:
        seed = zlib.crc32(f'{category}:{tier}'.encode())  # stable per crate
        srng = random.Random(seed)
        specks = [p for p in body if interior(*p)]
        srng.shuffle(specks)
        for (x, y) in specks[:26]:
            bright = srng.random()
            col = hx(STAR) if bright > 0.55 else hx('#b066ff')
            c.set(x, y, col)

    # 6. tier trim
    if t['rope']:
        rope = hx(t['rope'])
        for x in range(BODY_L, BODY_R + 1):
            for y in (BODY_T + 8, BODY_T + 9):
                if interior(x, y):
                    shade = mix(rope, (0, 0, 0), 0.25) if (x % 3 == 0) else rope
                    c.set(x, y, shade)
    if t['trim']:
        trim = hx(t['trim'])
        # gilt edge lines along the lid dome rim + body base
        for x in range(LID_L + 1, LID_R):
            ty = lid_top(x)
            if interior(x, ty + 1):
                c.set(x, ty + 1, trim)
        for x in range(BODY_L + 1, BODY_R):
            if interior(x, BODY_B - 1):
                c.set(x, BODY_B - 1, mix(trim, (0, 0, 0), 0.2))
        # corner studs
        for (sx, sy) in [(BODY_L + 2, BODY_T + 3), (BODY_R - 2, BODY_T + 3),
                         (BODY_L + 2, BODY_B - 3), (BODY_R - 2, BODY_B - 3)]:
            if interior(sx, sy):
                c.set(sx, sy, trim)

    # 7. clasp / lock plate at front centre (golden = gold, else dark metal)
    clasp = hx(GOLD) if tier == 'golden' else (hx('#c9a86a') if tier == 'standard' else hx('#d9b3ff'))
    clasp_dark = mix(clasp, (0, 0, 0), 0.4)
    for x in range(CX - 3, CX + 4):
        for y in range(SEAM_Y - 2, SEAM_Y + 5):
            if (x, y) in body:
                edge = x in (CX - 3, CX + 3) or y in (SEAM_Y - 2, SEAM_Y + 4)
                c.set(x, y, clasp_dark if edge else clasp)
    # keyhole
    c.set(CX, SEAM_Y + 1, hx(t['outline']))
    c.set(CX, SEAM_Y + 2, hx(t['outline']))

    # 8. category motif on the lid (centred, above the seam)
    draw_motif(c, category, body, interior, tier)

    # 9. mythic glow rim (1-2px halo just outside silhouette)
    if t['rim']:
        rim = hx(t['rim'])
        halo = set()
        for (x, y) in body:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    q = (x + dx, y + dy)
                    if q not in body and 0 <= q[0] < S and 0 <= q[1] < S:
                        halo.add(q)
        for (x, y) in halo:
            if c.get(x, y)[3] == 0:
                c.set(x, y, rim, 120)

    return c.img


def draw_motif(c, category, body, interior, tier):
    """Category lid silhouette, centred on the dome around y=24..30."""
    my = 25  # motif anchor row on the lid
    mcol = hx('#f2e6c0') if tier != 'mythic' else hx('#ffe6a0')
    dk = mix(mcol, (0, 0, 0), 0.5)

    def m(x, y, col=None):
        if (x, y) in body and interior(x, y):
            c.set(x, y, col or mcol)

    if category == 'cat':
        # cat head silhouette: rounded head + two triangular ears + tail
        # ears (apex at top, widening into the head)
        ear = {  # y -> x-range half-width from ear centre
            0: 0, 1: 1, 2: 1, 3: 2,
        }
        for dy, hw in ear.items():
            for k in range(-hw, hw + 1):
                m(CX - 4 + k, my - 1 + dy)   # left ear
                m(CX + 4 + k, my - 1 + dy)   # right ear
        # head (rounded blob), rows y = my+2 .. my+8
        head = {2: 5, 3: 6, 4: 6, 5: 6, 6: 6, 7: 5, 8: 3}
        for dy, hw in head.items():
            for k in range(-hw, hw + 1):
                m(CX + k, my + dy)
        # face: two dark eyes + nose
        m(CX - 2, my + 4, dk); m(CX + 2, my + 4, dk)
        m(CX, my + 5, dk)
        # tail curling up on the right side of the head
        for (dx, dy) in [(7, 6), (8, 5), (9, 5), (9, 4), (9, 3), (8, 3)]:
            m(CX + dx, my + dy)
    elif category == 'cosmetic':
        # bowtie: two triangles meeting at a knot
        for i in range(4):
            for j in range(-i, i + 1):
                m(CX - 6 + (3 - i), my + 2 + j) if False else None
        # left wing
        for i in range(4):
            for j in range(-i, i + 1):
                m(CX - 3 - i, my + 3 + j)
        # right wing
        for i in range(4):
            for j in range(-i, i + 1):
                m(CX + 3 + i, my + 3 + j)
        # knot
        for x in range(CX - 1, CX + 2):
            for y in range(my + 1, my + 6):
                m(x, y, dk)
    elif category == 'background':
        # picture frame: outer rect + inner opening
        x0, x1, y0, y1 = CX - 6, CX + 6, my - 1, my + 7
        for x in range(x0, x1 + 1):
            m(x, y0); m(x, y1)
        for y in range(y0, y1 + 1):
            m(x0, y); m(x1, y)
        # inner mat line
        for x in range(x0 + 2, x1 - 1):
            m(x, y0 + 2, dk); m(x, y1 - 2, dk)
        for y in range(y0 + 2, y1 - 1):
            m(x0 + 2, y, dk); m(x1 - 2, y, dk)
        # a little "mountain" inside
        for i in range(3):
            m(CX - 1 + i, my + 4 - i, dk)
            m(CX + 1 + i, my + 4 - i, dk)
    elif category == 'effect':
        # 4-point sparkle burst
        for r in range(6):
            m(CX, my + 3 - r)          # up
            m(CX, my + 3 + r)          # down
            m(CX - r, my + 3)          # left
            m(CX + r, my + 3)          # right
        # taper the arms (already thin) + centre glint
        m(CX, my + 3, hx(GOLD))
        m(CX - 1, my + 3, hx(GOLD)); m(CX + 1, my + 3, hx(GOLD))
        m(CX, my + 2, hx(GOLD)); m(CX, my + 4, hx(GOLD))
        # small diagonal sparks
        for (dx, dy) in [(-3, -2), (3, -2), (-3, 4), (3, 4)]:
            m(CX + dx, my + dy)


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    entries = []
    grid = {}
    for cat_key, base_id, cat_label in CATEGORIES:
        for tier_key, t in TIERS.items():
            box_id = base_id + t['suffix']
            img = draw_crate(cat_key, tier_key)
            fn = OUT / f'crate-{box_id}.png'
            img.save(fn)
            grid[(cat_key, tier_key)] = img
            entries.append({'id': box_id, 'category': cat_key,
                            'tier': tier_key, 'file': f'crate-{box_id}.png'})

    # contact sheet: 4 cols (categories) x 3 rows (tiers), 4x NEAREST,
    # with a label gutter on top + left.
    scale = 4
    pad = 4
    gx, gy = 40, 18          # left gutter / top gutter
    cw, ch = S * scale + pad, S * scale + pad
    W = gx + 4 * cw + pad
    H = gy + 3 * ch + pad
    sheet = Image.new('RGBA', (W, H), (26, 14, 48, 255))  # card #1a0e30
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    for ci, (cat_key, _, cat_label) in enumerate(CATEGORIES):
        d.text((gx + ci * cw + cw // 2 - len(cat_label) * 3, 5), cat_label, fill=(255, 211, 77))
    tier_order = ['standard', 'golden', 'mythic']
    for ri, tier_key in enumerate(tier_order):
        d.text((4, gy + ri * ch + ch // 2 - 3), TIERS[tier_key]['label'][:6],
               fill=(176, 102, 255))
        for ci, (cat_key, _, _) in enumerate(CATEGORIES):
            im = grid[(cat_key, tier_key)].resize((S * scale, S * scale), Image.NEAREST)
            sheet.paste(im, (gx + ci * cw + pad, gy + ri * ch + pad), im)
    sheet.save(PREVIEWS / 'crates-sheet.png')

    (OUT / 'manifest.json').write_text(json.dumps(entries, indent=2))
    print(f'wrote {len(entries)} crates + sheet -> {PREVIEWS / "crates-sheet.png"}')


if __name__ == '__main__':
    build()
