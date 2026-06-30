"""Fix cats with the "tiny white pupil + dark all around" eye pattern.

Detects dark eye blobs in the face region of each cat frame and replaces
them with a proper cat-eye structure:
  - Keep the dark outer rim (preserves silhouette)
  - Fill interior with white sclera
  - Place a small orange iris in the center
  - Tiny dark pupil + tiny white highlight on the orange

Operates per-frame (eye position shifts slightly between anim frames),
so we don't hardcode coordinates. Uses connected-component detection
restricted to the upper-face Y band.

Usage:
  python3 scripts/fix-eye-blobs.py <cat_id> [--preview]
  python3 scripts/fix-eye-blobs.py cat13            # apply in-place + backup
  python3 scripts/fix-eye-blobs.py cat13 --preview  # write /tmp/eyefix-cat13.png
  python3 scripts/fix-eye-blobs.py --all            # scan all cats, apply where needed
"""
import json
import shutil
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import numpy as np

ROOT = Path('.')
RAW = ROOT / 'assets-raw'
BACKUPS = ROOT / 'assets-raw-backups' / 'eye-fix'

# Face-region Y band where eyes can live (for a 91x64 cat frame; eyes
# sit roughly y=18-36 across all base cats inspected).
FACE_Y_MIN, FACE_Y_MAX = 14, 38

# A "dark eye pixel" is a low-luminance, opaque pixel.
DARK_LUMA_MAX = 110  # R+G+B sum
ALPHA_MIN = 200

# Blob acceptance — a real eye blob is roughly 4-12 px wide x 4-9 tall
BLOB_MIN_SIZE = 12
BLOB_MAX_SIZE = 90
BLOB_MIN_W, BLOB_MAX_W = 3, 12
BLOB_MIN_H, BLOB_MAX_H = 3, 10

# Eye colors — pulled to match the kawaii vibe Tim signed off on
SCLERA = (255, 255, 255, 255)          # bright white
IRIS = (255, 152, 50, 255)              # warm orange (similar to cat2 Biscuit)
IRIS_SHADE = (210, 110, 30, 255)        # darker orange rim under pupil
PUPIL = (30, 18, 40, 255)               # near-black with a hint of warmth
HIGHLIGHT = (255, 255, 255, 255)


def load_rgba(p: Path) -> np.ndarray:
    return np.array(Image.open(p).convert('RGBA'))


def save_rgba(a: np.ndarray, p: Path):
    Image.fromarray(a, 'RGBA').save(p)


def find_eye_blobs(a: np.ndarray):
    """Return list of (xs, ys) where each entry is the (cols, rows) pixel
    sets of a dark blob in the eye region."""
    r, g, b, alpha = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int), a[..., 3]
    luma = r + g + b
    mask = np.zeros_like(alpha, dtype=bool)
    mask[FACE_Y_MIN:FACE_Y_MAX, :] = (luma[FACE_Y_MIN:FACE_Y_MAX, :] < DARK_LUMA_MAX) & (alpha[FACE_Y_MIN:FACE_Y_MAX, :] > ALPHA_MIN)

    # Connected components (4-neighbor flood fill)
    visited = np.zeros_like(mask, dtype=bool)
    blobs = []
    h, w = mask.shape
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or visited[y, x]:
                continue
            stack = [(y, x)]
            xs, ys = [], []
            while stack:
                cy, cx = stack.pop()
                if cy < 0 or cy >= h or cx < 0 or cx >= w:
                    continue
                if visited[cy, cx] or not mask[cy, cx]:
                    continue
                visited[cy, cx] = True
                xs.append(cx)
                ys.append(cy)
                stack.extend([(cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)])
            if not xs:
                continue
            bw = max(xs) - min(xs) + 1
            bh = max(ys) - min(ys) + 1
            sz = len(xs)
            if (BLOB_MIN_SIZE <= sz <= BLOB_MAX_SIZE
                    and BLOB_MIN_W <= bw <= BLOB_MAX_W
                    and BLOB_MIN_H <= bh <= BLOB_MAX_H):
                blobs.append((xs, ys))
    return blobs


def fill_blob(a: np.ndarray, xs, ys):
    """Replace the interior of a dark blob with sclera + iris + pupil.
    Keep the outline (boundary pixels) as-is so the silhouette doesn't change.

    Layout (kawaii cat eye, big iris, small pupil, white highlight on top):
      .##.
      #WO#   ← top: white highlight + orange iris start
      #OO#   ← orange iris with single-pixel dark pupil
      #OB#
      .##.
    """
    pix = set(zip(ys, xs))
    interior = []
    for (y, x) in pix:
        neighbours = [(y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)]
        if all(n in pix for n in neighbours):
            interior.append((y, x))

    if not interior:
        return

    iys = [y for y, x in interior]
    ixs = [x for y, x in interior]
    by_min, by_max = min(iys), max(iys)
    bx_min, bx_max = min(ixs), max(ixs)
    h_inner = by_max - by_min + 1
    w_inner = bx_max - bx_min + 1

    interior_set = set(interior)

    # Fill interior with orange iris by default (this becomes the dominant color)
    for (y, x) in interior:
        a[y, x] = IRIS

    # White highlight — a 1-2 px square on the TOP-LEFT of the interior.
    # This is the classic kawaii sparkle that reads as glossy eye.
    hl_w = 1 if w_inner <= 3 else 2
    hl_h = 1 if h_inner <= 3 else 2
    hl_top = by_min
    hl_left = bx_min
    for y in range(hl_top, hl_top + hl_h):
        for x in range(hl_left, hl_left + hl_w):
            if (y, x) in interior_set:
                a[y, x] = HIGHLIGHT

    # Bottom row — darker iris shade for depth (drop-in shadow under iris)
    for x in range(bx_min, bx_max + 1):
        if (by_max, x) in interior_set:
            a[by_max, x] = IRIS_SHADE

    # Pupil — small dark spot in the lower-middle of the eye.
    # Place it 1 row above the bottom shade so it sits on iris, not shadow.
    pupil_y = by_max - 1 if h_inner >= 4 else by_max
    pupil_x_center = (bx_min + bx_max) // 2
    pupil_w = 1 if w_inner <= 3 else 2
    pupil_left = pupil_x_center - pupil_w // 2 + (1 if w_inner % 2 == 0 else 0)
    for x in range(pupil_left, pupil_left + pupil_w):
        if (pupil_y, x) in interior_set:
            a[pupil_y, x] = PUPIL


def fix_frame(a: np.ndarray) -> tuple[np.ndarray, int]:
    """Returns (fixed_array, number_of_blobs_fixed)."""
    blobs = find_eye_blobs(a)
    out = a.copy()
    # Sort blobs left-to-right; expect 2 (one per eye)
    blobs.sort(key=lambda b: sum(b[0]) / len(b[0]) if b[0] else 0)
    fixed = 0
    for xs, ys in blobs:
        fill_blob(out, xs, ys)
        fixed += 1
    return out, fixed


def make_preview(cat_id: str, frame_filename: str, before: np.ndarray, after: np.ndarray, save_to: Path):
    """8x-scale side-by-side comparison."""
    scale = 8
    h, w = before.shape[:2]
    gap = 30
    header = 30
    pw = w * scale
    ph = h * scale
    total_w = pw * 2 + gap * 3
    total_h = ph + header * 2 + 20
    img = Image.new('RGBA', (total_w, total_h), (255, 245, 200, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Courier New Bold.ttf', 18)
    except Exception:
        font = ImageFont.load_default()
    draw.text((gap, 4), f'{cat_id} {frame_filename}  —  BEFORE / AFTER (8x)', fill=(40, 20, 60, 255), font=font)
    bimg = Image.fromarray(before, 'RGBA').resize((pw, ph), Image.NEAREST)
    aimg = Image.fromarray(after, 'RGBA').resize((pw, ph), Image.NEAREST)
    img.paste(bimg, (gap, header), bimg)
    img.paste(aimg, (gap * 2 + pw, header), aimg)
    draw.text((gap + pw // 2 - 40, header + ph + 4), 'BEFORE', fill=(120, 30, 30, 255), font=font)
    draw.text((gap * 2 + pw + pw // 2 - 30, header + ph + 4), 'AFTER', fill=(30, 110, 30, 255), font=font)
    img.save(save_to)


def cat_needs_fix(cat_id: str) -> bool:
    """Heuristic: cat needs fix if idle_00 has 2 dark eye blobs in the face band."""
    idle = RAW / cat_id / f'{cat_id}_idle_00.png'
    if not idle.exists():
        return False
    a = load_rgba(idle)
    blobs = find_eye_blobs(a)
    return len(blobs) >= 2


def process_cat(cat_id: str, dry_run: bool = False, preview: bool = False) -> dict:
    cat_dir = RAW / cat_id
    frames = sorted(cat_dir.glob(f'{cat_id}_*.png'))
    if not frames:
        return {'cat': cat_id, 'error': 'no frames'}

    if preview:
        # Use idle_00 specifically for a consistent reference shot
        idle = cat_dir / f'{cat_id}_idle_00.png'
        src = idle if idle.exists() else frames[0]
        a = load_rgba(src)
        fixed, n = fix_frame(a)
        prev = Path('/tmp') / f'eyefix-{cat_id}-preview.png'
        make_preview(cat_id, src.name, a, fixed, prev)
        return {'cat': cat_id, 'preview': str(prev), 'blobs_in_first_frame': n}

    BACKUPS.mkdir(parents=True, exist_ok=True)
    backup_dir = BACKUPS / cat_id
    backup_dir.mkdir(parents=True, exist_ok=True)
    counts = []
    for fp in frames:
        a = load_rgba(fp)
        fixed, n = fix_frame(a)
        # backup once
        bp = backup_dir / fp.name
        if not bp.exists():
            shutil.copy2(fp, bp)
        if not dry_run:
            save_rgba(fixed, fp)
        counts.append((fp.name, n))
    return {'cat': cat_id, 'frames_processed': len(counts),
            'frames_with_2_blobs': sum(1 for _, n in counts if n == 2),
            'frames_with_0_blobs': sum(1 for _, n in counts if n == 0)}


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    if args[0] == '--all':
        dry = '--dry-run' in args
        # Scan every cat directory
        cats = sorted([p.name for p in RAW.iterdir() if p.is_dir() and p.name.startswith('cat') and p.name[3:].isdigit()],
                      key=lambda s: int(s[3:]))
        affected = []
        for cid in cats:
            if cat_needs_fix(cid):
                affected.append(cid)
        print(f'cats needing fix (have ≥2 dark eye blobs): {len(affected)}')
        print(' '.join(affected))
        if dry:
            return
        for cid in affected:
            r = process_cat(cid)
            print(f'  {cid:6s}  frames={r["frames_processed"]:3d}  2-blob={r["frames_with_2_blobs"]:3d}  0-blob={r["frames_with_0_blobs"]:3d}')
        return

    cat_id = args[0]
    if '--preview' in args:
        r = process_cat(cat_id, preview=True)
        print(json.dumps(r, indent=2))
    else:
        r = process_cat(cat_id, dry_run='--dry-run' in args)
        print(json.dumps(r, indent=2))


if __name__ == '__main__':
    main()
