"""Generate two reference catalog images:

- tools/catalog/cosmetics-catalog.png — every cosmetic with id + name,
  laid out as a grid. Pulled live from the atlas so it always reflects
  current state.
- tools/catalog/cats-catalog.png — every cat breed (idle frame 0) with
  id + name.

Output also includes index.html that displays both.
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path('.')
COS_ATLAS_PNG = ROOT / 'public/assets/atlas/cosmetics.png'
COS_ATLAS_JSON = ROOT / 'public/assets/atlas/cosmetics.json'
COS_CATALOG = ROOT / 'tools/cosmetics/cosmetics.json'
CAT_ATLAS_PNG = ROOT / 'public/assets/atlas/cats.png'
CAT_ATLAS_JSON = ROOT / 'public/assets/atlas/cats.json'
CAT_CATALOG = ROOT / 'tools/cats/cats.json'
OUT_DIR = ROOT / 'tools/catalog'
OUT_DIR.mkdir(parents=True, exist_ok=True)


def load_atlas(atlas_png, atlas_json):
    img = Image.open(atlas_png).convert('RGBA')
    data = json.load(open(atlas_json))
    frames = {f['filename']: f for f in data['frames']}
    return img, frames


def extract_frame(atlas_img, frames, name):
    fr = frames.get(name)
    if not fr:
        return None
    src = fr['frame']
    spr = fr['spriteSourceSize']
    sz = fr['sourceSize']
    canvas = Image.new('RGBA', (sz['w'], sz['h']), (0, 0, 0, 0))
    canvas.paste(
        atlas_img.crop((src['x'], src['y'], src['x'] + src['w'], src['y'] + src['h'])),
        (spr['x'], spr['y']),
    )
    bbox = canvas.getbbox()
    return canvas.crop(bbox) if bbox else canvas


# Use a default font; fall back to PIL's built-in if Pixeloid not available
def get_font(size):
    candidates = [
        '/System/Library/Fonts/Supplemental/Courier New Bold.ttf',
        '/System/Library/Fonts/Courier.ttc',
        '/System/Library/Fonts/Monaco.ttf',
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def build_grid(items, cols, cell_w, cell_h, scale, title, bg=(26, 10, 46), font_color=(200, 180, 230)):
    """items: list of (id, name, image). Returns the composed catalog PNG."""
    n = len(items)
    rows = (n + cols - 1) // cols
    TITLE_H = 60
    PAD = 8
    W = cols * cell_w + (cols + 1) * PAD
    H = TITLE_H + rows * cell_h + (rows + 1) * PAD
    canvas = Image.new('RGBA', (W, H), bg + (255,))
    draw = ImageDraw.Draw(canvas)
    title_font = get_font(22)
    id_font = get_font(11)
    name_font = get_font(10)
    draw.text((20, 18), title, fill=(255, 220, 80, 255), font=title_font)
    draw.text((20, 44), f'{n} entries', fill=font_color + (255,), font=name_font)

    for i, (cid, name, im) in enumerate(items):
        col = i % cols
        row = i // cols
        cx = PAD + col * (cell_w + PAD)
        cy = TITLE_H + PAD + row * (cell_h + PAD)
        # Cell bg
        draw.rectangle((cx, cy, cx + cell_w, cy + cell_h), fill=(38, 21, 64, 255), outline=(52, 28, 90, 255))
        # Image — scale to fit, center
        if im is not None:
            iw, ih = im.size
            sw = iw * scale
            sh = ih * scale
            # Constrain to cell - label area (label takes bottom 26 px)
            avail_h = cell_h - 30
            if sh > avail_h:
                ratio = avail_h / sh
                sw, sh = int(sw * ratio), int(sh * ratio)
            sw, sh = max(1, int(sw)), max(1, int(sh))
            big = im.resize((sw, sh), Image.NEAREST)
            ix = cx + (cell_w - sw) // 2
            iy = cy + (cell_h - 30 - sh) // 2 + 2
            canvas.paste(big, (ix, iy), big)
        # ID label
        draw.text((cx + 4, cy + cell_h - 26), cid, fill=(255, 220, 80, 255), font=id_font)
        # Name label (truncated)
        max_chars = max(1, cell_w // 6)
        truncated = name if len(name) <= max_chars else name[:max_chars - 1] + '…'
        draw.text((cx + 4, cy + cell_h - 14), truncated, fill=font_color + (255,), font=name_font)
    return canvas


# ---- Cosmetics catalog ----
cos_atlas, cos_frames = load_atlas(COS_ATLAS_PNG, COS_ATLAS_JSON)
cos_catalog = json.load(open(COS_CATALOG))
# Sort by slot then numeric id
slot_order = {'head': 0, 'face': 1, 'neck': 2, 'effect': 3}


def cid_sort_key(c):
    cid = c['id']
    n = int(cid[1:]) if cid[1:].isdigit() else 99999
    return (slot_order.get(c.get('slot', 'effect'), 99), n)


cos_catalog.sort(key=cid_sort_key)

cos_items = []
for c in cos_catalog:
    cid = c['id']
    frame_name = f'cosmetic_{cid}_idle_00'
    img = extract_frame(cos_atlas, cos_frames, frame_name)
    if img is None:
        # Variants pointing at parent via sourceFrame don't have own frames —
        # use the parent's frame, tinted in the runtime. For the catalog,
        # try the sourceFrame.
        if c.get('sourceFrame'):
            img = extract_frame(cos_atlas, cos_frames, c['sourceFrame'])
    cos_items.append((cid, c.get('name', cid), img))

cos_canvas = build_grid(
    cos_items,
    cols=16, cell_w=110, cell_h=110, scale=2,
    title=f'meowcert · Cosmetics Catalog',
)
cos_canvas.save(OUT_DIR / 'cosmetics-catalog.png')
print(f'cosmetics-catalog.png  {cos_canvas.size}  {len(cos_items)} cosmetics')

# ---- Cats catalog ----
cat_atlas, cat_frames = load_atlas(CAT_ATLAS_PNG, CAT_ATLAS_JSON)
cat_catalog = json.load(open(CAT_CATALOG))
cat_catalog.sort(key=lambda c: int(c['id'][3:]) if c['id'].startswith('cat') and c['id'][3:].isdigit() else 99999)

cat_items = []
for c in cat_catalog:
    cid = c['id']
    img = extract_frame(cat_atlas, cat_frames, f'{cid}_idle_00')
    cat_items.append((cid, c.get('name', cid), img))

cat_canvas = build_grid(
    cat_items,
    cols=7, cell_w=140, cell_h=140, scale=2,
    title=f'meowcert · Cats Catalog',
)
cat_canvas.save(OUT_DIR / 'cats-catalog.png')
print(f'cats-catalog.png       {cat_canvas.size}  {len(cat_items)} cats')

# ---- HTML wrapper ----
html = f'''<!doctype html>
<html><head><meta charset="utf-8"/>
<title>meowcert · catalogs</title>
<style>
  body {{ margin: 0; background: #1a0a2e; color: #fff;
    font-family: system-ui, -apple-system, sans-serif; padding-top: 50px; }}
  .hdr {{ padding: 14px 20px 10px; border-bottom: 1px solid #341c5a;
    position: sticky; top: 40px; background: #1a0a2e; z-index: 50; }}
  .hdr h1 {{ margin: 0 0 4px; font-size: 18px; color: #ffd34d; }}
  .hdr .sub {{ color: #c0a0e6; font-size: 12px; }}
  .navbtn {{ display: inline-block; padding: 4px 12px; background: #4a7c3a; color: #fff;
    border: 1px solid #6ba85a; border-radius: 4px; font-size: 12px; cursor: pointer;
    font-family: inherit; margin-left: 8px; }}
  .navbtn:hover {{ background: #5a9c44; }}
  .navbtn:disabled {{ opacity: 0.55; cursor: progress; }}
  section {{ padding: 20px; }}
  section h2 {{ margin: 0 0 10px; font-size: 16px; color: #ffd34d; }}
  section img {{ display: block; max-width: 100%; image-rendering: pixelated;
    border: 1px solid #341c5a; border-radius: 6px; }}
  .download {{ color: #ffd34d; text-decoration: none; font-size: 12px;
    margin-left: 12px; }}
  .download:hover {{ text-decoration: underline; }}
</style></head>
<body>
  <div class="hdr">
    <h1>catalogs</h1>
    <div class="sub">
      Live snapshots of every cosmetic + cat in the game, pulled from the
      atlas. Regenerates after any catalog change.
      <button class="navbtn" id="gen-btn" onclick="regenerate()">🔄 Generate</button>
    </div>
  </div>

  <section>
    <h2>Cosmetics — {len(cos_items)} entries
      <a class="download" href="cosmetics-catalog.png" download>↓ download PNG</a>
    </h2>
    <img src="cosmetics-catalog.png?t={Path(OUT_DIR / "cosmetics-catalog.png").stat().st_mtime if (OUT_DIR / "cosmetics-catalog.png").exists() else 0}" alt="cosmetics catalog"/>
  </section>

  <section>
    <h2>Cats — {len(cat_items)} entries
      <a class="download" href="cats-catalog.png" download>↓ download PNG</a>
    </h2>
    <img src="cats-catalog.png" alt="cats catalog"/>
  </section>

  <script src="/tools-nav.js"></script>
  <script>
    async function regenerate() {{
      const btn = document.getElementById('gen-btn');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Generating…';
      try {{
        const res = await fetch('/run-catalogs', {{ method: 'POST' }});
        const body = await res.json().catch(() => ({{ ok: false, error: 'bad json' }}));
        if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${{res.status}}`);
        btn.textContent = '✅ Reloading…';
        location.reload();
      }} catch (e) {{
        btn.textContent = '❌ ' + (e.message || 'failed');
        btn.disabled = false;
        setTimeout(() => {{ btn.textContent = original; }}, 5000);
      }}
    }}
  </script>
</body></html>
'''
(OUT_DIR / 'index.html').write_text(html)
print(f'Wrote {OUT_DIR / "index.html"}')
