# Cosmetic Calibrator

Visual tool for assigning a name, slot, and per-cosmetic position offset
to each of the 17 cosmetic sprites. The output (`cosmetics.json`) feeds
back into `src/shared/state.ts` (catalog) and the per-slot offset table
in `src/client/entities/cat.ts`.

## Launch

From the project root:

```bash
node tools/cosmetics/server.mjs
```

Then open `http://localhost:3000/` (defaults to the calibrator).

The server serves the calibrator HTML plus the project's `public/`
assets, and accepts a `POST /save` endpoint that writes the JSON body to
`tools/cosmetics/cosmetics.json`.

## Workflow

1. **Drag the cosmetic** on the canvas to position it. The X / Y offset
   numbers update live as you drag.
2. **Type a name** (e.g. "Cowboy Hat") and **pick a slot**
   (`head | face | neck | body | held`).
3. Set **rarity** if it doesn't match the default.
4. Use **← / →** to step through the 17 cosmetics. **↑ / ↓** nudge the
   Y offset by 1px.
5. Switch the **reference cat** dropdown to verify positioning works on
   multiple breeds. cat6 (Inkwell) is the default and has the largest
   sprite.
6. Every edit autosaves (400ms debounced) to
   `tools/cosmetics/cosmetics.json`. The bottom-right toast confirms.
7. The next time you launch the server and open the page, the calibrator
   reads the saved file and picks up where you left off.

## Coordinates

- **X = 0** is the cat sprite's vertical midline. Positive X = right.
- **Y = 0** is the top of the cat sprite. Negative Y = above the head,
  positive Y = inside the cat's body.
- Both offsets are in cat-source pixels (NOT the on-screen display
  pixels). The game multiplies them by the cat's runtime scale.
- The yellow crosshair marks the cosmetic's anchor point.
- A red warning bar at the top of the canvas appears if the cosmetic is
  off-screen — drag it back toward the cat.

## Output schema

```json
[
  {
    "id": "c1",
    "name": "Cowboy Hat",
    "slot": "head",
    "rarity": "uncommon",
    "offsetX": 0,
    "offsetY": -8,
    "scale": 1
  },
  ...
]
```

## When you're done

Once all 17 cosmetics are calibrated and `cosmetics.json` looks right,
ask Claude to "wire the calibrated JSON into the catalog" — it will:

1. Update `COSMETIC_CATALOG` in `src/shared/state.ts` with the new names.
2. Add a `slot` field to `CosmeticEntry` and the per-slot offsets to
   `src/client/entities/cat.ts`.
3. Update `Cat.setCosmetic` to look up the offset by slot.

## Browser compatibility

Works in any modern browser (Chrome, Firefox, Safari, Edge). The Node
server handles all the file I/O, so there's no File System Access API
dependency.
