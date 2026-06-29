"""Animated smoke test: per (cat × cosmetic) combo, build a sprite strip
of ALL cat animation frames, with the cosmetic's matching anim frame
overlaid at (0,0) — mirroring runtime exactly. CSS keyframes plays it
back live in the browser. Pass --anim to switch (idle/hiss/lick/meow).

Runtime parity rules (from src/client/entities/cat.ts):
- cosmetic sprite shares cat's (x, y) and origin (0.5, 1) — bottom-center
- NO catalog offsetX/offsetY applied (they're in the JSON but unused)
- NO frame-offset math applied (none of the catalog cosmetics are isStatic)
- cosmetic plays cosmetic_<id>_<anim> in lockstep with cat's anim
- if the cosmetic lacks the requested anim, runtime FREEZES on whatever
  frame it was last on; fresh sprites fall back to idle frame 0
"""
import json, sys
from PIL import Image
from pathlib import Path
import html

ANIM = 'lick'
for arg in sys.argv[1:]:
    if arg.startswith('--anim='):
        ANIM = arg.split('=', 1)[1]

ROOT = Path('.')
OUT_DIR = Path(f'tools/cats/smoke-anim-{ANIM}')
OUT_DIR.mkdir(exist_ok=True)
for f in OUT_DIR.glob('*.png'): f.unlink()

CATS_PNG = Image.open(ROOT / 'public/assets/atlas/cats.png').convert('RGBA')
CATS_JSON = json.load(open(ROOT / 'public/assets/atlas/cats.json'))
COS_PNG = Image.open(ROOT / 'public/assets/atlas/cosmetics.png').convert('RGBA')
COS_JSON = json.load(open(ROOT / 'public/assets/atlas/cosmetics.json'))
COS_CATALOG = json.load(open(ROOT / 'tools/cosmetics/cosmetics.json'))
CAT_CATALOG = json.load(open(ROOT / 'tools/cats/cats.json'))
FRAME_OFFSETS = json.load(open(ROOT / 'public/assets/atlas/cat-frame-offsets.json'))

# Mirror cat.ts motionStrengthForSlot — how strongly a static cosmetic
# rides the cat's per-frame head motion.
MOTION_STRENGTH = {'head': 1.0, 'face': 1.0, 'neck': 0.5, 'body': 0.2}

cat_frames = {f['filename']: f for f in CATS_JSON['frames']}
cos_frames = {f['filename']: f for f in COS_JSON['frames']}

def extract_canvas(atlas, fd):
    """Reconstruct the trimmed atlas frame into its full sourceSize canvas
    — same thing Phaser does when rendering a trimmed atlas frame."""
    src = fd['frame']; size = fd['sourceSize']
    spr = fd.get('spriteSourceSize', {'x':0,'y':0})
    canvas = Image.new('RGBA', (size['w'], size['h']), (0,0,0,0))
    canvas.paste(atlas.crop((src['x'], src['y'], src['x']+src['w'], src['y']+src['h'])),
                 (spr.get('x', 0), spr.get('y', 0)))
    return canvas

cat_ids = sorted([c['id'] for c in CAT_CATALOG],
                 key=lambda s: int(s[3:]) if s[3:].isdigit() else 9999)
cos_grouped = {'face': [], 'head': [], 'neck': []}
for c in COS_CATALOG:
    cos_grouped.setdefault(c['slot'], []).append(c)
cosmetic_order = cos_grouped.get('face', []) + cos_grouped.get('head', []) + cos_grouped.get('neck', [])

def cat_anim_frames(cat_id, anim):
    return sorted([n for n in cat_frames if n.startswith(f'{cat_id}_{anim}_')])

def cosmetic_anim_frames(cos_id, anim):
    return sorted([n for n in cos_frames if n.startswith(f'cosmetic_{cos_id}_{anim}_')])

# Pre-resolve cosmetic anim frames per cosmetic
# Returns list of frame names to use per cat-anim-frame-index, applying
# the runtime "freeze on missing anim" behavior.
def resolve_cos_frames(cos_id, N):
    """Pick which cosmetic frame to overlay on each cat frame index 0..N-1.
    Runtime rule:
      1. If cosmetic has this anim → play its frames in lockstep (loop if shorter)
      2. If cosmetic lacks this anim → freeze on last-played frame; fresh
         sprite falls back to idle_00.
    Smoke test rule (matches runtime intent): use anim frames if present;
    else fall back to idle_00 for every cat frame (= same as a fresh sprite
    seeing this anim for the first time).
    """
    own = cosmetic_anim_frames(cos_id, ANIM)
    if own:
        # Loop the cosmetic's frames if it has fewer than the cat's anim
        # (rare — but match modulo-style playback Phaser uses by default).
        return [own[i % len(own)] for i in range(N)]
    fallback = f'cosmetic_{cos_id}_idle_00'
    if fallback in cos_frames:
        return [fallback] * N
    return []  # cosmetic has no frames at all — skip

combo_meta = {}  # (cat_id, cos_id) -> frame_count
print(f'Building animated strips for {ANIM} (runtime-accurate composite)...')
for ci, cat_id in enumerate(cat_ids):
    af = cat_anim_frames(cat_id, ANIM)
    N = len(af)
    if N == 0: continue
    # Per-frame head offsets for this cat × anim (used only for isStatic
    # cosmetics, mirroring cat.ts:569-605). Pad with [0,0] if absent.
    cat_offs = FRAME_OFFSETS.get(cat_id, {}).get(ANIM, [])
    for cos in cosmetic_order:
        cos_seq = resolve_cos_frames(cos['id'], N)
        if not cos_seq: continue
        is_static = bool(cos.get('isStatic'))
        # Mirror runtime cat.ts: cosmetics WITHOUT anim frames for the
        # current cat anim ride per-frame offsets too (otherwise they'd
        # freeze at idle pose while the cat moves underneath, looking
        # like drift). Detect this by checking if the cosmetic has its
        # own frames for this anim — if not, treat as effectively static.
        # Mirror runtime: isStatic forces idle-pinned + offsets; non-static
        # falls back only when no anim frames exist.
        has_own_anim = bool(cosmetic_anim_frames(cos['id'], ANIM))
        rides_offsets = is_static or not has_own_anim
        # For isStatic, also pin the cosmetic to idle_00 so any per-anim
        # frames in the atlas (degenerate or otherwise) are ignored.
        if is_static:
            idle0 = f'cosmetic_{cos["id"]}_idle_00'
            if idle0 in cos_frames:
                cos_seq = [idle0] * N
        strength = MOTION_STRENGTH.get(cos['slot'], 0.6)
        strip = Image.new('RGBA', (91 * N, 64), (0, 0, 0, 0))
        # Mirror runtime cat.ts syncOneCosmetic math:
        #   shift = (catalog_target - art_anchor) + per_frame_head_offset
        # where art_anchor is where the cosmetic's idle_00 art CENTER
        # actually sits in its canvas, and catalog_target is where the
        # calibrator says it should land. Migration was computed so they
        # match → shift = 0 for unmodified cosmetics. As the calibrator
        # is edited, target diverges from anchor → cosmetic moves.
        CAT_HEAD_TOP_REF = 12
        CANVAS_HCENTER = 45
        idle0_name = f'cosmetic_{cos["id"]}_idle_00'
        if idle0_name in cos_frames:
            idle_sss = cos_frames[idle0_name].get('spriteSourceSize', {'x':0,'y':0,'w':0,'h':0})
            anchor_x = idle_sss['x'] + idle_sss['w']/2
            anchor_y = idle_sss['y'] + idle_sss['h']/2
        else:
            anchor_x = CANVAS_HCENTER
            anchor_y = CAT_HEAD_TOP_REF
        target_x = CANVAS_HCENTER + cos.get('offsetX', 0)
        target_y = CAT_HEAD_TOP_REF + cos.get('offsetY', 0)
        base_shift_x = round(target_x - anchor_x)
        base_shift_y = round(target_y - anchor_y)
        for i, fr_name in enumerate(af):
            cat_canvas = extract_canvas(CATS_PNG, cat_frames[fr_name])
            cos_canvas = extract_canvas(COS_PNG, cos_frames[cos_seq[i]])
            dx = base_shift_x
            dy = base_shift_y
            if rides_offsets and i < len(cat_offs):
                ox, oy = cat_offs[i]
                dx += round(ox * strength)
                dy += round(oy * strength)
            cat_canvas.alpha_composite(cos_canvas, (dx, dy))
            strip.paste(cat_canvas, (91 * i, 0))
        strip.save(OUT_DIR / f'{cat_id}_{cos["id"]}.png')
        combo_meta[(cat_id, cos['id'])] = N
    if ci % 10 == 0:
        print(f'  ...{ci+1}/{len(cat_ids)}')

print(f'\n✓ {len(combo_meta)} strips written to {OUT_DIR}/')

slot_color = {'face': '#7bc4ff', 'head': '#ffd34d', 'neck': '#c678ff'}
cat_by_id = {c['id']: c for c in CAT_CATALOG}
unique_Ns = sorted(set(combo_meta.values()))

hdr = ['<th class="corner"></th>']
for cos in cosmetic_order:
    hdr.append(
        f'<th class="cos" style="border-bottom-color:{slot_color[cos["slot"]]}">'
        f'<div class="cid">{cos["id"]}</div><div class="cn">{html.escape(cos["name"])}</div>'
        f'</th>')
hdr_row = '<tr>' + ''.join(hdr) + '</tr>'

rows = []
for cat_id in cat_ids:
    name = cat_by_id[cat_id].get('name', '')
    cells = [f'<th class="cat"><div class="cid">{cat_id}</div><div class="cn">{html.escape(name)}</div></th>']
    for cos in cosmetic_order:
        N = combo_meta.get((cat_id, cos['id']))
        if N is None:
            cells.append('<td class="empty"></td>')
        else:
            cells.append(
                f'<td><div class="cell anim-{N}" '
                f'style="background-image:url(smoke-anim-{ANIM}/{cat_id}_{cos["id"]}.png)"></div></td>')
    rows.append('<tr>' + ''.join(cells) + '</tr>')

keyframes = []
for N in unique_Ns:
    keyframes.append(
        f'.anim-{N} {{ animation: play{N} {max(0.6, N*0.12):.2f}s steps({N}) infinite; }}'
        f' @keyframes play{N} {{ from {{ background-position: 0 0 }} to {{ background-position: -{91*N}px 0 }} }}')

html_out = f"""<!doctype html>
<html><head><meta charset="utf-8"/>
<title>meowcert smoke test ANIMATED — {ANIM}</title>
<style>
  body {{ margin: 0; background: #1a0a2e; color: #fff; font-family: system-ui, sans-serif; }}
  .hdr {{ position: sticky; top: 0; z-index: 100; background: #1a0a2e; padding: 10px 16px; border-bottom: 1px solid #341c5a; }}
  .hdr h1 {{ margin: 0; font-size: 16px; color: #ffd34d; }}
  .sub {{ color: #c0a0e6; font-size: 12px; margin-top: 4px; }}
  .navbtn {{ display: inline-block; padding: 4px 12px; margin: 0 4px; background: #261540; color: #ffd34d;
            text-decoration: none; border-radius: 4px; border: 1px solid #341c5a; font-size: 12px; }}
  .navbtn.cur {{ background: #ffd34d; color: #1a0a2e; }}
  table {{ border-collapse: separate; border-spacing: 0; }}
  th.corner {{ position: sticky; left: 0; top: 56px; z-index: 90; background: #261540; width: 100px; }}
  th.cos {{ position: sticky; top: 56px; z-index: 80; background: #261540;
           writing-mode: vertical-rl; transform: rotate(180deg);
           padding: 6px 4px; font-size: 10px; white-space: nowrap;
           border-bottom: 3px solid; min-width: 18px; }}
  th.cos .cid {{ color: #ffd34d; }}
  th.cos .cn {{ color: #fff; font-weight: 400; opacity: 0.75; }}
  th.cat {{ position: sticky; left: 0; z-index: 70; background: #261540;
           padding: 4px 8px; text-align: left; font-size: 11px; font-weight: 600;
           width: 100px; border-right: 1px solid #341c5a; border-bottom: 1px solid #341c5a; }}
  th.cat .cid {{ color: #ffd34d; }}
  th.cat .cn {{ color: #fff; opacity: 0.7; font-weight: 400; }}
  td {{ border-right: 1px solid #2a1845; border-bottom: 1px solid #2a1845;
        background: #1a0a2e; padding: 0; }}
  td.empty {{ width: 91px; height: 64px; background: #15082a; }}
  .cell {{ width: 91px; height: 64px; background-repeat: no-repeat;
           image-rendering: pixelated; }}
  {' '.join(keyframes)}
</style>
</head><body>
  <div class="hdr">
    <h1>meowcert smoke test ANIMATED — {ANIM}</h1>
    <div class="sub">
      Runtime-accurate composite: cosmetic anim plays in sync with cat, no offset math.
      Switch animation:
      {' '.join(f'<a class="navbtn{(" cur" if a == ANIM else "")}" href="smoke-anim-{a}.html">{a}</a>' for a in ['idle','hiss','lick','meow'])}
    </div>
  </div>
  <table>{hdr_row}{''.join(rows)}</table>
</body></html>
"""
out = ROOT / f'tools/cats/smoke-anim-{ANIM}.html'
out.write_text(html_out)
print(f'✓ HTML: {out}')
