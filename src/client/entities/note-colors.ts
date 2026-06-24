import type { LaneId } from '../../shared/state';

export const LANE_COLORS: Record<LaneId, number> = {
  0: 0x6fbcff,
  1: 0xc678ff,
  2: 0xffd34d,
};

/**
 * Mix a 24-bit RGB color toward pure white by `amount` (0..1). Used to
 * brighten the falling-note tint so the ball reads more clearly against
 * a lane that's already tinted the same hue. `amount=0` is a no-op;
 * `amount=1` returns white. Default consumer uses ~0.35 — keeps the
 * lane's identity (still recognizably the same hue) while lifting the
 * ball one shade lighter so it pops against the alpha-0.55 lane.
 */
export function liftTowardWhite(rgb: number, amount: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return (lr << 16) | (lg << 8) | lb;
}

/** Mix toward pure black by `amount` (0..1). Inverse of liftTowardWhite. */
export function darkenTowardBlack(rgb: number, amount: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  const dr = Math.max(0, Math.round(r * (1 - amount)));
  const dg = Math.max(0, Math.round(g * (1 - amount)));
  const db = Math.max(0, Math.round(b * (1 - amount)));
  return (dr << 16) | (dg << 8) | db;
}

/** Standard amount the falling note + chart-editor cell ball get lifted
 *  above the lane color. Currently 0 (no lift): we lift the LANE toward
 *  white instead (see `LANE_BRIGHTNESS_LIFT`) so the ball naturally
 *  reads as the darker shape against a pastel lane. Kept as a dial for
 *  future fine-tuning. */
export const BALL_BRIGHTNESS_LIFT = 0;

/** Amount the lane fill is lifted toward white before being applied as
 *  a tint on top of the RhythmBarBackgroundWhite. Was 0.72 (very pale
 *  wash) which made the three cat colors all blur together into near-
 *  white. Pulled back to 0.35 so each lane reads as its cat's actual
 *  color — Snow White stays white-ish, Jade pops green, Sakura sits
 *  pink — while still pastel enough that the falling note + hit target
 *  read as the darker shape against it. */
export const LANE_BRIGHTNESS_LIFT = 0.35;
