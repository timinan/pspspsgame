"""One-shot roster rebuild, 2026-07-01 (Tim's cleanup + renumber).

Old roster (108 entries incl 'rainbow') → new roster (79 cats):
  cat1-6           unchanged        (original unique-art breeds)
  cat7             DELETED          (Pinky)
  cat8-12  → 7-11  renamed          (Inky, Gregre/Snow White, Jade, Purps, Sakura)
  cat13            REPLACED → 12    (Butters: template grey, darker than Buttermilk)
  cat14-53 → 13-52 REMADE           (same colors, cat2 template, untouched eyes)
  cat54-78 → 53-76 renamed          (24 cats — old roster skips cat60)
  cat79-116        DELETED          (Goldie…Toffee, all old variant rounds)
  rainbow          DELETED
  cat200-203       → 77-79          (Frost, Ember, Domino; Buttermilk became Butters)

Phases (run in order, each idempotent-ish and inspectable):
  --classify     read old 14-53 raws → variant configs in variants/cats/
  --restructure  retire deleted dirs to assets-raw-retired/, rename kept dirs+files
  --catalog      rebuild tools/cats/cats.json + remap src/client/constants/cat-colors.ts

Generation itself runs via gen-cat-variant.py on the emitted configs
(after --restructure so the new ids are free).
"""
import colorsys
import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

RAW = Path('assets-raw')
RETIRED = Path('assets-raw-retired')
VARIANTS = Path('variants/cats')
CATS_JSON = Path('tools/cats/cats.json')
CAT_COLORS_TS = Path('src/client/constants/cat-colors.ts')
W, H = 91, 64

# Colors in the old cat13-based variants that are NOT fur (never used to
# classify / extract coat colors).
NON_FUR = {
    (0, 0, 0), (42, 47, 78), (221, 151, 164), (242, 196, 202),
    (255, 162, 20), (255, 200, 37), (255, 235, 87), (255, 255, 255),
    (87, 28, 39), (137, 30, 43), (246, 129, 135), (255, 0, 64), (255, 80, 0),
}

DELETED_OLD = [7, 13] + list(range(79, 91)) + [91, 92, 93, 94, 96, 99, 103, 104, 105, 106, 107, 108, 109, 110, 113, 114, 115, 116]
RENAME_MAP = {8: 7, 9: 8, 10: 9, 11: 10, 12: 11}
OLD_54_78 = [54, 55, 56, 57, 58, 59] + list(range(61, 79))
RENAME_MAP.update({old: 53 + i for i, old in enumerate(OLD_54_78)})
REMAKE_MAP = {old: old - 1 for old in range(14, 54)}   # 14→13 … 53→52


def hexs(c):
    return '#%02x%02x%02x' % c


def waist_y_alpha(px):
    best_y, best_w = None, 10 ** 9
    for y in range(36, 50):
        xs = [x for x in range(W) if px[x, y][3] > 100]
        if len(xs) < 4:
            continue
        w = max(xs) - min(xs) + 1
        if w < best_w:
            best_w, best_y = w, y
    return (best_y + 1) if best_y is not None else 44


def dominant_fur(px, xs, ys):
    from collections import Counter
    c = Counter()
    for y in ys:
        for x in xs:
            p = px[x, y]
            if p[3] == 255 and p[:3] not in NON_FUR:
                c[p[:3]] += 1
    return c.most_common(1)[0][0] if c else None


def differ(a, b):
    if a is None or b is None:
        return False
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5 > 40


def classify():
    report = []
    for old, new in sorted(REMAKE_MAP.items()):
        im = Image.open(RAW / f'cat{old}' / f'cat{old}_idle_00.png').convert('RGBA')
        px = im.load()
        wy = waist_y_alpha(px)
        left = dominant_fur(px, range(0, 43), range(H))
        right = dominant_fur(px, range(48, W), range(H))
        head = dominant_fur(px, range(W), range(0, wy))
        body = dominant_fur(px, range(W), range(wy, H))
        cid = f'cat{new}'
        base = {'id': cid, 'name': f'Cat {new}', 'earInner': '#dd97a4'}
        if differ(left, right):
            kind = 'lrsplit'
            cfg = {**base, 'split': {
                'left': {'coat': hexs(left), 'markings': 'coat'},
                'right': {'coat': hexs(right), 'markings': 'coat'},
            }}
        elif differ(head, body):
            kind = 'hbsplit'
            cfg = {**base, 'split': {
                'top': {'coat': hexs(head), 'markings': 'coat'},
                'bottom': {'coat': hexs(body), 'markings': 'coat'},
            }}
        else:
            kind = 'solid'
            cfg = {**base, 'coat': hexs(left or right), 'markings': 'coat'}
        out = VARIANTS / f'{cid}-remake.json'
        out.write_text(json.dumps(cfg, indent=2) + '\n')
        report.append(f'cat{old}→{cid}: {kind:8s} ' + (
            f'L={hexs(left)} R={hexs(right)}' if kind == 'lrsplit' else
            f'H={hexs(head)} B={hexs(body)}' if kind == 'hbsplit' else hexs(left or right)))
    print('\n'.join(report))


def rename_dir(old, new):
    src, dst = RAW / f'cat{old}', RAW / f'cat{new}'
    assert src.exists(), f'{src} missing'
    assert not dst.exists(), f'{dst} already exists'
    src.rename(dst)
    for f in sorted(dst.glob(f'cat{old}_*.png')):
        f.rename(dst / f.name.replace(f'cat{old}_', f'cat{new}_', 1))


def restructure():
    RETIRED.mkdir(exist_ok=True)
    for old in DELETED_OLD + list(REMAKE_MAP):
        src = RAW / f'cat{old}'
        if src.exists():
            shutil.move(str(src), str(RETIRED / f'cat{old}'))
    for old in [200, 201, 202, 203]:
        src = RAW / f'cat{old}'
        if src.exists():
            shutil.rmtree(src)
    for old in sorted(RENAME_MAP):   # ascending: every target is already free
        rename_dir(old, RENAME_MAP[old])
    print('restructure done:', len(list(RETIRED.glob('cat*'))), 'dirs retired')


def catalog():
    cats = json.load(open(CATS_JSON))
    by_id = {c['id']: c for c in cats}

    def carry(old_id, new_num, name=None):
        e = dict(by_id[old_id])
        e['id'] = f'cat{new_num}'
        if name:
            e['name'] = name
        elif re.fullmatch(r'Cat \d+', e.get('name', '')):
            e['name'] = f'Cat {new_num}'
        return e

    out = [dict(by_id[f'cat{n}']) for n in range(1, 7)]
    for old, new in sorted(RENAME_MAP.items()):
        if old <= 12:
            out.append(carry(f'cat{old}', new))
    out.append({'id': 'cat12', 'name': 'Butters', 'rarity': 'common', 'scale': by_id['cat13'].get('scale', 1)})
    for old, new in sorted(REMAKE_MAP.items()):
        out.append(carry(f'cat{old}', new))
    for old, new in sorted(RENAME_MAP.items()):
        if old >= 54:
            out.append(carry(f'cat{old}', new))
    for new, name in [(77, 'Frost'), (78, 'Ember'), (79, 'Domino')]:
        out.append({'id': f'cat{new}', 'name': name, 'rarity': 'common', 'scale': 1})
    out.sort(key=lambda c: int(c['id'][3:]))
    json.dump(out, open(CATS_JSON, 'w'), indent=2)
    print(f'cats.json: {len(out)} entries')

    # cat-colors.ts: remap `catNN:` keys line-by-line, drop deleted,
    # append entries for the remade/new cats from their configs.
    txt = CAT_COLORS_TS.read_text()
    lines = txt.split('\n')
    keep, dropped = [], 0
    old_to_new = {**{f'cat{o}': f'cat{n}' for o, n in RENAME_MAP.items()}}
    deleted_keys = {f'cat{n}' for n in DELETED_OLD + list(REMAKE_MAP)} | {'rainbow'}
    for line in lines:
        m = re.match(r'(\s*)(cat\d+|rainbow):(\s*)(0x[0-9a-fA-F]+,.*)', line)
        if not m:
            keep.append(line)
            continue
        key = m.group(2)
        if key in deleted_keys:
            dropped += 1
            continue
        new_key = old_to_new.get(key, key)
        keep.append(f'{m.group(1)}{new_key}:{m.group(3)}{m.group(4)}')
    txt = '\n'.join(keep)

    entries = []
    for cfg_path in sorted(VARIANTS.glob('cat*-remake.json'), key=lambda p: int(re.search(r'cat(\d+)', p.name).group(1))):
        cfg = json.loads(cfg_path.read_text())
        coat = cfg.get('coat') or cfg['split'].get('left', cfg['split'].get('top'))['coat']
        entries.append(f"  {cfg['id']}:{' ' * max(1, 9 - len(cfg['id']))}0x{coat.lstrip('#')},  // {cfg['name']} — remade from old roster, coat base")
    for cid, name, coat in [('cat12', 'Butters', '#6e7987'), ('cat77', 'Frost', '#fbfbfd'), ('cat78', 'Ember', '#c0392b'), ('cat79', 'Domino', '#d6d6de')]:
        entries.append(f"  {cid}:{' ' * max(1, 9 - len(cid))}0x{coat.lstrip('#')},  // {name} — template cat, coat base")
    marker = 'export const CAT_COLOR_BY_BREED: Record<string, number> = {'
    txt = txt.replace(marker, marker + '\n' + '\n'.join(sorted(entries, key=lambda e: int(re.search(r'cat(\d+)', e).group(1)))))
    CAT_COLORS_TS.write_text(txt)
    print(f'cat-colors.ts: {dropped} keys dropped, {len(entries)} added')


if __name__ == '__main__':
    phase = sys.argv[1] if len(sys.argv) > 1 else ''
    {'--classify': classify, '--restructure': restructure, '--catalog': catalog}.get(
        phase, lambda: sys.exit(__doc__))()
