#!/usr/bin/env python3
"""Render a static PNG preview of VisitPost's empty-chart splash so the
composition can be pixel-checked before wiring it into the scene.

Matches the design canvas (320x580) and the brand palette. The button
label is rendered without a real font (project ships webfonts via CSS,
not TTFs on disk) so we approximate with a filled rect + a system font
label; the color/position check is what matters, not glyph fidelity.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / 'public' / 'assets' / 'images' / 'logo.png'
OUT_DIR = ROOT / 'tools' / 'visit-post-preview'
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT = OUT_DIR / 'empty-splash.png'

W, H = 320, 580
BG = (0x1a, 0x0a, 0x2e)
BTN = (0xff, 0xd3, 0x4d)
BTN_TEXT = (0x1a, 0x0a, 0x2e)

img = Image.new('RGB', (W, H), BG)

logo = Image.open(LOGO).convert('RGBA')
logo = logo.resize((220, 220), Image.NEAREST)
logo_cx, logo_cy = W // 2, int(H * 0.36)
img.paste(logo, (logo_cx - 110, logo_cy - 110), logo)

btn_cx, btn_cy = W // 2, int(H * 0.72)
btn_w, btn_h = 220, 48
draw = ImageDraw.Draw(img)
draw.rectangle(
    [btn_cx - btn_w // 2, btn_cy - btn_h // 2, btn_cx + btn_w // 2, btn_cy + btn_h // 2],
    fill=BTN,
)

try:
    font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 18)
except Exception:
    font = ImageFont.load_default()
label = 'PLAY NOW'
tb = draw.textbbox((0, 0), label, font=font)
tw, th = tb[2] - tb[0], tb[3] - tb[1]
draw.text((btn_cx - tw // 2, btn_cy - th // 2 - 2), label, fill=BTN_TEXT, font=font)

img.save(OUT)
print(f'wrote {OUT.relative_to(ROOT)}  ({W}x{H})')
