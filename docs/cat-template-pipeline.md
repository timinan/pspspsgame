# Cat template pipeline

How new cat breeds get generated from the cat2 master template. Companion
to [asset-pipeline.md](asset-pipeline.md), which covers how generated
frames then reach the atlas.

**The core idea:** cat2 (Biscuit) has the cleanest full animation set
(63 frames, 91×64, exactly 16 flat colors, zero anti-aliasing). We label
every pixel of every frame once with *what it is* (coat, belly, whisker,
eye…), freeze that as the template, and from then on a new breed is a
small JSON config — never another one-off fix-it script.

## Why palette-swap scripts kept breaking

A color→color swap can't tell regions apart when they share a color.
White `#ffffff` is simultaneously the belly fur, the whiskers, and the
floating "MEOW"/"HISS" text baked into the frames; the eye highlight
yellows also appear in the meow sparkles. Any variant beyond a coat-only
swap tints things it shouldn't. Region labels fix this permanently.

## Region taxonomy

| Region id | What it covers | Default in cat2 | Recolorable |
| --- | --- | --- | --- |
| `coat1..coat3` | body fur shading ramp, light→dark | blue-greys `#92a1b9 #657392 #424c6e` | yes |
| `accent` | pupils, nose, mouth, creases, soft outline parts | `#2a2f4e` | auto-derives from coat (darkest shade) |
| `mark1..mark3` | white markings ramp (belly, chest, muzzle, blaze, paws, tail tip, muzzle whiskers) | `#ffffff #b4b4b4 #858585` | yes |
| `earInner1..2` | inner ear, dark→bright | `#571c27 #891e2b` | yes |
| `iris` | eye base | `#ffa214` | yes |
| `irisHi1..2` | eye highlight + meow star-eyes | `#ffc825 #ffeb57` | auto-derives from eyes |
| `glint` | white dots inside eyes | white | locked by default |
| `tongue` | tongue pink (lick) | `#f68187` | yes |
| `outline` | black outline (incl. text glyph borders) | `#000000` | locked by default |
| `whisker` | detached 1px white flecks (eye corners) | white | locked by default |
| `fx` | MEOW/HISS text, sparkles, hiss glyph | white/yellows/`#ff0040`/`#ff5000` | locked, never recolored |

Notes from the template build (learned by pixel-checking, keep in mind
when reviewing variants):
- Muzzle whiskers are drawn as 2px white+grey strokes and intentionally
  ride with `mark1`/`mark2` — they recolor with markings, which matches
  how the artist shades them.
- The MEOW/HISS letters carry their own black borders that merge with
  the cat outline; borders stay in `outline` (locked black), letter
  fills are `fx`.
- Shared-color ambiguity (white, yellows, black) is resolved at build
  time by overlay-cut connectivity + eye-proximity + letter-stroke +
  position rules; see `scripts/build-cat-template.py`. Hand-verified
  once via the QA sheet, then frozen.

## Files

```
assets-raw/cat2/                          ← master source, never modified
assets-raw/cat-template/
├── <anim>_<NN>.png                       ← indexed region map per frame (palette = flag colors, doubles as QA visual)
├── regions.json                          ← region id ↔ palette index ↔ flag color, per-frame part bboxes (phase 2)
└── qa-sheet.png                          ← flag-colored contact sheet, the one-time approval artifact
scripts/build-cat-template.py             ← cat2 frames → template (rerunnable, deterministic)
scripts/gen-cat-variant.py                ← variant config JSON → assets-raw/cat<N>/ + contact sheet
variants/cats/*.json                      ← one config per generated breed (committed)
```

Canonical frame set = what the atlas ships: `idle` (9), `lick` (8),
`meow` (11), `hiss` (11) — 39 frames. sleep/stretch are labeled too (the
extractor drops them; labeling costs nothing and keeps options open).

## Variant config

```json
{
  "id": "cat200",
  "name": "Buttermilk",
  "coat": "#7d8896",
  "markings": "#ffffff",
  "eyes": "#ffa214",
  "earInner": "#891e2b"
}
```

Rules:
- Each base color auto-derives its shading ramp (coat → 3 shades +
  accent, markings → 3) in HSV. Derived coat shading uses SOFT steps
  (0.94/0.82 brightness — Tim locked this 2026-07-01; cat2's own artist
  ratios read as two-toned on solid cats). Any ramp can be overridden
  with an explicit array (`"coat": ["#...", "#...", "#...", "#..."]`,
  last slot = accent).
- `"markings": "coat"` = solid-colored cat — belly/blaze/muzzle melt
  into the coat and marking-shading pixels use the coat's shades.
- Derived `accent` brightness is capped at 0.32 so pupils stay dark on
  light coats (the "milky film" bug).
- `whisker` follows the markings color unless explicitly set.
- `"split": {"left": {...}, "right": {...}}` = two-face cat. Each side
  is a full palette (base config + side overrides); the divide is the
  body's vertical midline, recomputed per frame from non-fx pixels.
- Omitted regions keep cat2 defaults. `outline`, `glint`, `fx` are
  locked unless explicitly set (fx can never be set).
- Output: `assets-raw/cat<N>/cat<N>_<anim>_<NN>.png` (all 63 frames) +
  `variants/cats/previews/cat<N>.png` contact sheet, rendered every run.

### Patterns (phase 2)

`"pattern": { "type": "stripes|tailRings|spots|patches", "color": "#...", "density": ..., "seed": ... }`

Patterns are procedural and body-anchored: the template records per-frame
coat part bboxes (head/back/tail/legs); pattern generators compute in
part-relative coordinates so the pattern tracks the body across frames
instead of swimming in screen space. Pattern pixels replace coat pixels
only, and re-shade using the coat ramp position of the pixel they cover.

## QA gates (non-negotiable)

1. **Template freeze (one-time):** `qa-sheet.png` pixel-checked by Claude
   AND eyeballed by Tim before any variant is generated. Every region in
   its flag color; mislabeled pixels found here cost minutes, found later
   cost sessions.
2. **Every generation run:** the contact sheet is rendered and actually
   looked at (Read the PNG) before the variant is registered anywhere.
3. **Shipping** stays the existing path: add entry via cats calibrator
   (`tools/cats/cats.json`) → sync-catalog → `npm run extract:assets` →
   `npm run build`.

## Locked invariants

- `assets-raw/cat2/` is read-only. The template build never mutates it.
- After freeze, region maps are only changed by rerunning
  `build-cat-template.py` with a rule fix, followed by re-approval of the
  QA sheet — never by hand-editing map PNGs.
- Frames are 91×64, 16-color flat. Generators must emit exactly flat
  colors (no resampling, no alpha blending).
- `fx` pixels ship byte-identical to cat2 in every variant.
