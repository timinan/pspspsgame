# Cat Calibrator

Visual tool for calibrating the 6 base cats and spinning off tinted
variants as first-class catalog entries. Output (`cats.json`) feeds
back into `src/shared/state.ts` (`CAT_CATALOG` + `CatBreed`) and the
runtime cat renderer.

## Launch

From the project root:

```bash
node tools/server.mjs
```

Open `http://localhost:3000/tools/cats/calibrator.html` (or pick "Cat
Calibrator" from the index at `/`).

## Workflow

### Base tab

- **Prev / Next** (or ← / →) to step between cats.
- **Name** is the display name shown in the box-open reveal and the
  Collection scene.
- **Rarity** drives drop tables and shows up as the reveal badge.
- **Scale** lets you render a breed bigger or smaller than the others
  (kept at 1.0 unless a sprite needs adjustment).
- No offsets — cats are positioned by **seat** in the Game scene, not
  per-cat.

### Animation preview

- **Animation** dropdown lists the animations the atlas actually has
  for this cat (cat1/2/3 only have idle/lick/meow/sleep/stretch/hiss;
  cat5/6 add `happy`).
- **Pause / Play** (or `space`) toggles playback.
- **⟲ 1st frame** rewinds to the first frame.
- Playback runs at 12 FPS — the same rate as the game.

When a tint is being previewed (Variants tab), the multiply blend is
applied to every frame of the animation. That's the exact same code
path the game's renderer uses (`Phaser.setTint(0xRRGGBB)` persists
across animation frames), so what you see here is what ships.

### Variants tab

- Check the tints you want.
- Click any row to preview that tint live on the running animation.
- **⚡ Generate selected as new cats** promotes each checked tint into
  a real catalog entry — gets the next free id (`cat7`, `cat8`, …),
  inherits name template / rarity / scale, and stores a `sourceFrame`
  pointing at the parent's animation set plus the `tint` color.

Generated cats can themselves be opened on their own Variants tab to
spawn more — tints don't compose visually, but it's a fast way to fan
out the catalog without new art.

## Output schema

```json
[
  { "id": "cat1", "name": "Mochi", "rarity": "common", "scale": 1 },
  {
    "id": "cat7",
    "name": "Red Mochi",
    "rarity": "common",
    "scale": 1,
    "sourceFrame": "cat1",
    "tint": "#ff5555"
  }
]
```

- Bases omit `sourceFrame` (implicit — `id` is the source) and `tint`.
- Generated cats keep both fields so the runtime can pick the parent's
  atlas frames and apply `setTint(tint)` to the sprite.

## When you're done

Say "wire the calibrated cat JSON into the catalog" and the runtime
side will:

1. Expand `CatBreed` in `src/shared/state.ts` with the generated ids.
2. Append entries to `CAT_CATALOG`.
3. Update `Cat.frameName` / `Cat.renderBreed` to resolve via
   `sourceFrame` when present, and apply persistent `tint` on the
   sprite at construction time.
4. Update the box-pull RNG so the expanded pool actually drops the new
   cats.
