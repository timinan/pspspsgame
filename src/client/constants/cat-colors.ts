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
  cat1:     0xfff7e8,  // Mochi — pearly cream
  cat2:     0xf5c690,  // Biscuit — bright toasted tan
  cat3:     0xc4c4c4,  // Pebble — lifted cool grey
  cat4:     0xeae3d0,  // Marble — bright marble cream
  cat5:     0xffb04d,  // Saffron — sun-bright orange
  cat6:     0x8f6cc7,  // Inkwell — vivid mid-purple (was muddy)
  cat7:     0xffa7e0,  // Pinky — vivid pink
  cat8:     0x6c6c84,  // Inky — lifted slate (pure black washes flat)
  cat9:     0xeef3fb,  // Snow White — clean bright cool white
  cat10:    0x6cf088,  // Jade — pop jade green (matches green aura)
  cat11:    0xb968ff,  // Purps — punchy purple
  cat12:    0xffc4de,  // Sakura — bright blossom pink
};

const SEAT_ORDER: SeatId[] = ['seat-left', 'seat-center', 'seat-right'];

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
  playerState: PlayerState | null,
): [number, number, number] | null {
  const seatedCats = playerState?.seatedCats ?? {};
  const ownedCats = playerState?.ownedCats ?? [];
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
