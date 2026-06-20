# Asset pipeline

How sprites get from raw GIFs into the game. Designed around the
[Phaser best practices](.) for asset handling: atlas-packed, lazy
animation registration, centralized keys.

## Folder layout

```
assets-raw/                              ← source GIFs (gitignored)
├── cat1/ … cat6/                        ← cat animation GIFs
│   └── catN_<animation>.gif
└── cosmetic/c1/ … c43/                  ← cosmetic animation GIFs (auto-discovered)
    └── cN_<animation>.gif

public/assets/atlas/                     ← extractor output (committed)
├── cats.png        + cats.json          ← 6 cats × ~7 animations
└── cosmetics.png   + cosmetics.json     ← 43 cosmetics × ~6 animations

scripts/
└── extract-cat-assets.ts                ← run with `npm run extract:assets`

src/client/
├── constants/assets.ts                  ← AssetKeys.Atlas.Cats / Cosmetics
└── entities/cat.ts                      ← Cat.setCosmetic plays matching anims
```

## Canonical animations

Every sprite is normalized into one of these names at extract time. The
extractor's animation maps accept common typos / direction suffixes and
collapse them back to the canonical name.

| Canonical | Cat suffixes that map to it | Cosmetic suffixes |
| --- | --- | --- |
| `idle` | idle | idle, idlet, idlegif |
| `lick` | lick | lick, lickt, lickgif |
| `meow` | meow | (cats only) |
| `sleep` | sleep, sleep_left, sleep_right | sleep |
| `sleep_alt` | (cats only) | sleep_r |
| `stretch` | stretch, stretch_left, stretch_right, strech_right | stretch |
| `hiss` | hiss | hiss |
| `happy` | happy | happy |

Adding a new canonical animation (e.g. `dance`):

1. Append it to `CANONICAL_ANIM` in `scripts/extract-cat-assets.ts`.
2. Add suffix → canonical entries in `CAT_ANIM_MAP` and/or
   `COSMETIC_ANIM_MAP`.
3. Drop `*_dance.gif` files into the relevant `assets-raw/<entity>/<id>/` folders.
4. Re-run `npm run extract:assets`.
5. The game auto-uses it via `anims.exists()` checks — falls back to
   `idle` for entities that don't have the animation.

## Frame naming convention

```
<entity>_<id>_<animation>_<NN>
```

Examples:

- `cat1_idle_00`, `cat6_happy_03`
- `cosmetic_c1_idle_00`, `cosmetic_c43_stretch_07`

`<NN>` is zero-padded to 2 digits. Frames are sorted alphabetically in
the atlas JSON, so this convention also gives natural animation ordering.

## Adding a new cosmetic (or cat)

```bash
# 1. Drop GIFs
mkdir assets-raw/cosmetic/c44
cp ~/new-cosmetic/*.gif assets-raw/cosmetic/c44/
# (filenames: c44_idle.gif, c44_lick.gif, c44_sleep.gif, etc.)

# 2. Extract
npm run extract:assets
# → regenerates public/assets/atlas/cosmetics.{png,json}

# 3. Calibrate
node tools/server.mjs
open http://localhost:3000/tools/cosmetics/calibrator.html
# c44 auto-appears in Prev/Next (calibrator scans the atlas at boot)
# Set name, slot, offset, rarity, animation preview

# 4. Save
# autosaves to tools/cosmetics/cosmetics.json
# also commit it: git add tools/cosmetics/cosmetics.json
```

Same workflow for cats (`assets-raw/cat<N>/`, the cat calibrator).

## Trimmed atlas frames

Cosmetic frames source as 91×64 canvases but most of that is transparent
padding (a hat occupies maybe 10% of the area). The extractor computes
the painted bounds per frame and packs only the cropped region — with
the original 91×64 metadata recorded under `spriteSourceSize` /
`sourceSize`. Phaser handles trimmed atlases internally so sprites
still render at the correct relative position.

Effect: the cosmetics atlas shrunk from ~13,000 px tall to ~1,200 px
when trimming was added. Cat atlas went from ~1,200 to ~650.

## Animations matching cosmetic ↔ cat

`Cat.setCosmetic` plays whichever cosmetic animation matches the cat's
current animation. If a cosmetic doesn't ship that animation (e.g.,
older cosmetics only had `idle`), the cosmetic falls back to its own
idle frames.

```ts
// In Cat.playAnimation:
this.sprite.play(catAnimKey);        // cat plays e.g. 'cat1_lick'
this.playCosmeticAnimation(animation);  // cosmetic plays 'cosmetic_c1_lick'
                                        // (or falls back to 'cosmetic_c1_idle')
```

This is implemented via `ensureCosmeticAnimation(id, animation)` which
lazily registers each animation the first time it's needed (same pattern
the existing cat animations use, per Phaser best practices).

## Atlas split rationale

Two atlases (cats + cosmetics) instead of one. Reasons:

1. **GPU texture size limits.** With 43 cosmetics × ~6 animations × ~9
   frames each ≈ 2300 cosmetic frames in addition to ~400 cat frames, a
   single atlas hit ~13,000 px tall before trimming. Many devices cap at
   4096×4096; we'd lose Android compatibility.
2. **Independent re-extraction.** When you add a new cosmetic, you don't
   need to re-pack the cat atlas. The cat atlas only changes when cat
   art changes.
3. **Draw-call cost is negligible.** Phaser batches per-texture, so as
   long as we draw cats then cosmetics (which the cat entity does — cat
   sprite then cosmetic on top), the GPU cost is the same as one atlas.

## Running everything

```bash
npm run extract:assets         # regenerate atlases from assets-raw/
npm run type-check             # tsc --build
npm test                       # vitest (68 tests)
npm run build                  # vite build
node tools/server.mjs          # tool servers (calibrators)
npm run dev                    # devvit playtest
```
