/**
 * Primary color per cat breed — used to tint the rhythm lanes so each
 * lane's color reads as "this cat's lane" at a glance. Hand-picked
 * against the catalog art: saturated enough to survive the
 * `liftTowardWhite` lane wash but still recognizable as the cat's hue.
 *
 * When a seat is empty, Game.resolveLaneTints copies the nearest
 * occupied lane's color so the playfield never has a stale default tint
 * next to a colored neighbour.
 */
import type { PlayerState, SeatId } from '@/../shared/state';

// Brightest fur tone per breed — eyes / ears / noses excluded. Tim's
// rule: pick the dominant FUR color, then nudge it a touch brighter
// than realism so the lane sings under the cat instead of muddying.
// Slightly punched-up vs the earlier picks.
export const CAT_COLOR_BY_BREED: Record<string, number> = {
  cat12:    0x6e7987,  // Butters — template cat, coat base
  cat13:    0x474747,  // Cat 13 — remade from old roster, coat base
  cat14:    0xf9b38b,  // Cat 14 — remade from old roster, coat base
  cat15:    0xcf8459,  // Cat 15 — remade from old roster, coat base
  cat16:    0xe8d5b0,  // Cat 16 — remade from old roster, coat base
  cat17:    0xeeeadd,  // Cat 17 — remade from old roster, coat base
  cat18:    0xf6ad8e,  // Cat 18 — remade from old roster, coat base
  cat19:    0xdd9a5f,  // Cat 19 — remade from old roster, coat base
  cat20:    0x808a93,  // Cat 20 — remade from old roster, coat base
  cat21:    0xdfe0e2,  // Cat 21 — remade from old roster, coat base
  cat22:    0xf0d8a8,  // Cat 22 — remade from old roster, coat base
  cat23:    0xfff9b8,  // Cat 23 — remade from old roster, coat base
  cat24:    0xa2f877,  // Cat 24 — remade from old roster, coat base
  cat25:    0x94f0f0,  // Cat 25 — remade from old roster, coat base
  cat26:    0xbae8d1,  // Cat 26 — remade from old roster, coat base
  cat27:    0xd4bfe3,  // Cat 27 — remade from old roster, coat base
  cat28:    0xf09c94,  // Cat 28 — remade from old roster, coat base
  cat29:    0xf98bd4,  // Cat 29 — remade from old roster, coat base
  cat30:    0x85b8ff,  // Cat 30 — remade from old roster, coat base
  cat31:    0x8b23e7,  // Cat 31 — remade from old roster, coat base
  cat32:    0xf7a1c5,  // Cat 32 — remade from old roster, coat base
  cat33:    0x474747,  // Cat 33 — remade from old roster, coat base
  cat34:    0xcf8459,  // Cat 34 — remade from old roster, coat base
  cat35:    0xf797bf,  // Cat 35 — remade from old roster, coat base
  cat36:    0xf09c94,  // Cat 36 — remade from old roster, coat base
  cat37:    0x85b8ff,  // Cat 37 — remade from old roster, coat base
  cat38:    0x474747,  // Cat 38 — remade from old roster, coat base
  cat39:    0xa2f877,  // Cat 39 — remade from old roster, coat base
  cat40:    0xbae8d1,  // Cat 40 — remade from old roster, coat base
  cat41:    0xd4bfe3,  // Cat 41 — remade from old roster, coat base
  cat42:    0xf68e8e,  // Cat 42 — remade from old roster, coat base
  cat43:    0x94f0f0,  // Cat 43 — remade from old roster, coat base
  cat44:    0x9653c6,  // Cat 44 — remade from old roster, coat base
  cat45:    0xf797bf,  // Cat 45 — remade from old roster, coat base
  cat46:    0xdd9a5f,  // Cat 46 — remade from old roster, coat base
  cat47:    0xfff9b2,  // Cat 47 — remade from old roster, coat base
  cat48:    0xfc88d5,  // Cat 48 — remade from old roster, coat base
  cat49:    0xb1d1f1,  // Cat 49 — remade from old roster, coat base
  cat50:    0x474747,  // Cat 50 — remade from old roster, coat base
  cat51:    0xf98b8b,  // Cat 51 — remade from old roster, coat base
  cat52:    0xfff9b2,  // Cat 52 — remade from old roster, coat base
  cat77:    0xfbfbfd,  // Frost — template cat, coat base
  cat78:    0xc0392b,  // Ember — template cat, coat base
  cat79:    0xd6d6de,  // Domino — template cat, coat base
  cat1:     0xf5a05a,  // Mochi — warm orange tabby (sprite is orange + white, not cream)
  cat2:     0xb0bdce,  // Biscuit — cool blue-grey tabby (sprite reads grey, not biscuit-tan)
  cat3:     0xc4c4c4,  // Pebble — lifted cool grey
  cat4:     0x8ea0b8,  // Marble — slate blue (sprite is grey-blue marble, not cream)
  cat5:     0x6c7585,  // Saffron — dark slate (sprite reads dark grey, not saffron-orange)
  cat6:     0xd28a4a,  // Inkwell — toasted tabby brown (sprite is orange-brown tabby, not purple)
  cat7:     0x6c6c84,  // Inky — lifted slate (pure black washes flat)
  cat8:     0x9aa6b6,  // Gregre — British Shorthair cool blue-grey, lifted brighter than realism per the rule
  cat9:    0x6cf088,  // Jade — pop jade green (matches green aura)
  cat10:    0xb968ff,  // Purps — punchy purple
  cat11:    0xffc4de,  // Sakura — bright blossom pink
  // ===== AUTO-EXTRACTED dominant fur color for cat14+ (scripts/extract-cat-fur-colors.py one-off) =====
  // Algorithm: most-common opaque non-outline non-white non-ear-pink pixel from idle_00, lifted in HSL
  // by +0.10 lightness / +0.15 saturation per the cat-colors rule.
  cat53:    0xff70a7,  cat55:    0x70eeff,  cat56:    0xc770ff,  cat57:    0xd6ff70,
  cat57:    0xff70e2,  cat59:    0xfff770,  cat61:    0x70fff7,  cat62:    0xc6b8a8,
  cat61:    0xc2acac,  cat64:    0x5c4444,  cat65:    0xc2acac,  cat66:    0xf9cb75,
  cat65:    0xecc182,  cat68:    0xefcf7f,  cat69:    0xf1cb7d,  cat70:    0x9bbad3,
  cat69:    0xf5c579,  cat72:    0x616187,  cat73:    0xe7ba87,  cat74:    0xe6c589,
  cat73:    0xcf9fab,  cat76:    0xf4b87a,  cat77:    0xfbc874,  cat78:    0xa9a9c5,
  // Bright neon single-tones (cat79-90)
  // L/R splits — dominant picks one side (typically head color); fine for lane identity.
};

const SEAT_ORDER: SeatId[] = ['seat-left', 'seat-center', 'seat-right'];

/** Pump a base cat color toward the most-saturated form of its hue so
 *  the lane border reads as a vivid frame rather than a pastel outline.
 *  Game.drawLanes uses this for the opaque border specifically — the
 *  bar fill keeps the softer original. */
export function vividBorderColor(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  // Boost saturation to ~0.85 minimum and pin value to 1.0 so the
  // border pops on the dark playfield bg. Hue is preserved.
  const newS = Math.max(s, 0.85);
  const newV = 1;
  let h: number;
  if (max === min) h = 0;
  else if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h *= 60;
  if (h < 0) h += 360;
  const c = newV * newS;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = newV - c;
  let rp = 0, gp = 0, bp = 0;
  if (h < 60)       { rp = c; gp = x; bp = 0; }
  else if (h < 120) { rp = x; gp = c; bp = 0; }
  else if (h < 180) { rp = 0; gp = c; bp = x; }
  else if (h < 240) { rp = 0; gp = x; bp = c; }
  else if (h < 300) { rp = x; gp = 0; bp = c; }
  else              { rp = c; gp = 0; bp = x; }
  const ri = Math.round((rp + m) * 255);
  const gi = Math.round((gp + m) * 255);
  const bi = Math.round((bp + m) * 255);
  // Near-grey inputs (Snow White) saturate to a faint cool blue —
  // that's not what we want for "vivid white border". Detect the
  // grey case and return solid white instead.
  if (v - min < 0.05) return 0xffffff;
  return (ri << 16) | (gi << 8) | bi;
}

/**
 * Shared resolver: pick the lane tint trio from the player's seated cats.
 *
 * Each lane takes the primary color of the cat in the matching seat (left
 * → lane 0, center → lane 1, right → lane 2). Empty seats inherit the
 * color of the nearest occupied lane so a single-cat lineup colors all
 * three lanes the same shade. When ZERO seats are filled, returns null so
 * the caller can fall back to a bg-sampled / default trio.
 *
 * Game.drawLanes and ChartEditor both use this so the playfield + the
 * editor preview always share the same per-lane identity. Don't reach
 * into PlayerState.seatedCats outside this helper for lane colours —
 * keep all the logic here so changes ripple to every screen at once.
 */
export function resolveLaneTintsFromSeatedCats(
  source: { seatedCats?: PlayerState['seatedCats']; ownedCats?: { id: string; breed: string }[] } | null,
): [number, number, number] | null {
  const seatedCats = source?.seatedCats ?? {};
  const ownedCats = source?.ownedCats ?? [];
  const laneColors: (number | null)[] = [null, null, null];
  for (let i = 0; i < 3; i++) {
    const seatId = SEAT_ORDER[i]!;
    const instanceId = seatedCats[seatId];
    if (!instanceId) continue;
    const cat = ownedCats.find((c) => c.id === instanceId);
    if (!cat) continue;
    const color = CAT_COLOR_BY_BREED[cat.breed];
    if (color !== undefined) laneColors[i] = color;
  }
  if (!laneColors.some((c) => c !== null)) return null;
  for (let i = 0; i < 3; i++) {
    if (laneColors[i] !== null) continue;
    for (let d = 1; d < 3; d++) {
      const right = i + d;
      const left = i - d;
      const rightColor = right < 3 ? laneColors[right] : null;
      if (rightColor !== null && rightColor !== undefined) {
        laneColors[i] = rightColor;
        break;
      }
      const leftColor = left >= 0 ? laneColors[left] : null;
      if (leftColor !== null && leftColor !== undefined) {
        laneColors[i] = leftColor;
        break;
      }
    }
  }
  return [laneColors[0]!, laneColors[1]!, laneColors[2]!];
}
