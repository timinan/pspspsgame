"""One-shot: re-sync variant catalog offsets from their parent.

Why: variants ship via ship-cosmetic-variants.py which inherits parent's
offsetX/offsetY/scale at the moment of shipping. But when a parent is later
re-calibrated, the variants don't auto-update — they sit at whatever the
parent had at ship time. The calibrator's `freshEntry()` default was
offsetY: -10 (see tools/cosmetics/calibrator.html), so every variant
shipped before the parent was hand-calibrated ended up stuck at
(offsetX=0, offsetY=-10, scale=1). At cat scales 1.4×/1.7×/2.5× this puts
the cosmetic art well above the cat head — the "Blue Beret floats above
PEBBLE" and "Blue Santa Hat clips the marquee" bugs.

Strategy:
  - Walk tools/cosmetics/variants/shipped.json (parent_id -> [variants]).
  - For each variant, look up parent in cosmetics.json.
  - Only resync if the variant is currently at the calibrator default
    (0, -10, 1). Hand-calibrated variants (e.g. legacy c60/c61/c62
    Flameheads that ended up under c18) keep whatever Tim set in the
    calibrator.
  - Copy parent's offsetX/offsetY/scale to the variant. Catalog math
    becomes consistent at every catScale via cat.ts:syncOneCosmetic.
  - Same fix also applies to DressingRoom (DressingRoom.ts:286-328 runs
    the same catalog-driven math with heroScale=1.15, heroCanvasRefY=32).

Re-runnable. Idempotent. Reads + writes tools/cosmetics/cosmetics.json.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / 'tools/cosmetics/cosmetics.json'
SHIPPED = ROOT / 'tools/cosmetics/variants/shipped.json'

DEFAULT = (0, -10, 1)


def main():
    catalog = json.load(open(CATALOG))
    shipped = json.load(open(SHIPPED))

    by_id = {c['id']: c for c in catalog}

    # Build variant_id -> parent_id
    variant_to_parent = {}
    for parent_id, kids in shipped.items():
        for _label, info in kids.items():
            variant_to_parent[info['new_id']] = parent_id

    stats = {'resynced': 0, 'already_consistent': 0, 'protected_hand_tuned': 0,
             'parent_at_default': 0, 'missing_variant': 0, 'missing_parent': 0}
    resynced_examples = []
    protected_examples = []

    for variant_id, parent_id in variant_to_parent.items():
        v = by_id.get(variant_id)
        p = by_id.get(parent_id)
        if v is None:
            stats['missing_variant'] += 1
            continue
        if p is None:
            stats['missing_parent'] += 1
            continue

        vox, voy, vs = v.get('offsetX', 0), v.get('offsetY', 0), v.get('scale', 1)
        pox, poy, ps = p.get('offsetX', 0), p.get('offsetY', 0), p.get('scale', 1)

        if (vox, voy, vs) == (pox, poy, ps):
            stats['already_consistent'] += 1
            continue

        if (vox, voy, vs) != DEFAULT:
            # Hand-calibrated. Protect.
            stats['protected_hand_tuned'] += 1
            if len(protected_examples) < 5:
                protected_examples.append((variant_id, parent_id, (vox, voy, vs)))
            continue

        if (pox, poy, ps) == DEFAULT:
            # Parent also untouched — copying default doesn't help. Track + skip.
            stats['parent_at_default'] += 1
            continue

        # The fix: copy parent's catalog values.
        v['offsetX'] = pox
        v['offsetY'] = poy
        v['scale'] = ps
        stats['resynced'] += 1
        if len(resynced_examples) < 6:
            resynced_examples.append((variant_id, parent_id,
                                       (vox, voy, vs), (pox, poy, ps)))

    # Write back
    dry_run = '--dry-run' in sys.argv
    if not dry_run:
        with open(CATALOG, 'w') as f:
            json.dump(catalog, f, indent=2)

    print('=== resync-variant-offsets ===')
    print(f"Catalog: {CATALOG.relative_to(ROOT)}")
    print(f"Shipped: {SHIPPED.relative_to(ROOT)}")
    print()
    for k, v in stats.items():
        print(f"  {k:30s} {v}")
    print()
    if resynced_examples:
        print('Resynced examples:')
        for vid, pid, was, now in resynced_examples:
            print(f"  {vid:7s} (parent {pid})  {was} -> {now}")
    if protected_examples:
        print()
        print('Protected hand-tuned (not touched):')
        for vid, pid, vals in protected_examples:
            print(f"  {vid:7s} (parent {pid})  keep {vals}")
    if dry_run:
        print('\n[dry-run] catalog NOT written. Re-run without --dry-run to apply.')


if __name__ == '__main__':
    main()
