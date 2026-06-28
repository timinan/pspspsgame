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
  rainbow:  0xe6a5ff,  // bumped lavender — rainbow cats hue-cycle, neutral resting tone
  cat1:     0xf5a05a,  // Mochi — warm orange tabby (sprite is orange + white, not cream)
  cat2:     0xb0bdce,  // Biscuit — cool blue-grey tabby (sprite reads grey, not biscuit-tan)
  cat3:     0xc4c4c4,  // Pebble — lifted cool grey
  cat4:     0x8ea0b8,  // Marble — slate blue (sprite is grey-blue marble, not cream)
  cat5:     0x6c7585,  // Saffron — dark slate (sprite reads dark grey, not saffron-orange)
  cat6:     0xd28a4a,  // Inkwell — toasted tabby brown (sprite is orange-brown tabby, not purple)
  cat7:     0xffa7e0,  // Pinky — vivid pink
  cat8:     0x6c6c84,  // Inky — lifted slate (pure black washes flat)
  cat9:     0x9aa6b6,  // Gregre — British Shorthair cool blue-grey, lifted brighter than realism per the rule
  cat10:    0x6cf088,  // Jade — pop jade green (matches green aura)
  cat11:    0xb968ff,  // Purps — punchy purple
  cat12:    0xffc4de,  // Sakura — bright blossom pink
  cat13:    0x6c7785,  // Butters — darker British Shorthair grey, lifted brighter than realism per the rule
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
