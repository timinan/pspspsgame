#!/usr/bin/env python3
"""Render static PNG previews of the two empty-chart splash surfaces so
the composition can be pixel-checked before wiring it into either.

1. `empty-splash.png` — Phaser VisitPost scene, 320x580 design canvas.
2. `empty-splash-card.png` — Devvit HTML splash card (splash.html +
   splash.css with body.empty-chart), roughly 380x700 to match a phone
   feed viewport.

Both use the brand palette; the button label is rendered with a system
font because the project ships Pixeloid webfonts via CSS, not TTFs on
disk. The color/position check is what matters, not glyph fidelity.
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

# --- splash-card empty-chart preview (Devvit HTML surface) ----------
CARD_W, CARD_H = 380, 700
card = Image.new('RGB', (CARD_W, CARD_H), (0x0b, 0x04, 0x1a))

# Stage band stretches to fill vertical space in empty-chart mode. The
# actual CSS uses flex-grow, but we approximate with a fixed inset that
# leaves room for the button at the bottom.
STAGE_INSET_TOP = 8
STAGE_INSET_BOT = 100
stage_draw = ImageDraw.Draw(card)
stage_draw.rectangle(
    [0, STAGE_INSET_TOP, CARD_W, CARD_H - STAGE_INSET_BOT],
    fill=(0x1a, 0x0a, 0x2e),
)

# Logo centered vertically inside the stage. Width 66% capped at 260,
# height maintains aspect (square logo).
logo2 = Image.open(LOGO).convert('RGBA')
LOGO_W = min(260, int(CARD_W * 0.66))
logo2 = logo2.resize((LOGO_W, LOGO_W), Image.NEAREST)
stage_h = (CARD_H - STAGE_INSET_BOT) - STAGE_INSET_TOP
logo2_cx = CARD_W // 2
logo2_cy = STAGE_INSET_TOP + stage_h // 2
card.paste(logo2, (logo2_cx - LOGO_W // 2, logo2_cy - LOGO_W // 2), logo2)

# Play button — matches splash.css (full-width minus 16px, yellow).
BTN_H = 46
BTN_MARGIN_X = 8
BTN_MARGIN_BOT = 20
btn_top = CARD_H - BTN_MARGIN_BOT - BTN_H
btn_bot = CARD_H - BTN_MARGIN_BOT
card_draw = ImageDraw.Draw(card)
card_draw.rectangle(
    [BTN_MARGIN_X, btn_top, CARD_W - BTN_MARGIN_X, btn_bot],
    fill=BTN,
    outline=BTN,
    width=2,
)
btn_label = '▶  TAP TO PLAY'
tb2 = card_draw.textbbox((0, 0), btn_label, font=font)
tw2, th2 = tb2[2] - tb2[0], tb2[3] - tb2[1]
card_draw.text(
    (CARD_W // 2 - tw2 // 2, (btn_top + btn_bot) // 2 - th2 // 2 - 2),
    btn_label,
    fill=BTN_TEXT,
    font=font,
)

OUT_CARD = OUT_DIR / 'empty-splash-card.png'
card.save(OUT_CARD)
print(f'wrote {OUT_CARD.relative_to(ROOT)}  ({CARD_W}x{CARD_H})')
