// CatBreed lives in shared/state.ts so the server can reference it too. The
// full union now includes cat4-6 and the legendary 'rainbow'.
import type { CatBreed, CosmeticId } from '@/../shared/state';
export type { CatBreed, CosmeticId };

export type CatAnimationState =
  | 'idle'
  | 'lick'
  | 'meow'
  | 'sleep'
  | 'stretch'
  | 'happy'
  | 'hiss';

export interface CatModel {
  id: string;
  breed: CatBreed;
  animation: CatAnimationState;
  // The animation a cat returns to when not actively meowing/being petted.
  // Each seated cat picks a different one (idle, lick, sleep, stretch) so
  // the scene doesn't look uniform.
  restingAnimation: CatAnimationState;
  x: number; // 0–100 percent of background width
  y: number; // 0–100 percent of background height
  /**
   * Cosmetics worn by this cat, keyed by slot ('head' / 'neck' / 'body' / etc).
   * Each rendered as a sprite stacked on the cat. Empty / undefined = naked.
   */
  equippedCosmetics?: Partial<Record<string, CosmeticId>>;
  /**
   * Render scale applied to the cat sprite (and its cosmetics / effects).
   * Defaults to 1. Game scene seats cats at 1.4× so they read at the same
   * weight as the lane hit targets.
   */
  scale?: number;
}

export type InteractionType = 'pet' | 'chinScratch' | 'bellyRub';

export type InteractionOutcome = 'success' | 'fail';

/**
 * A "pspsps" sound wave riding the track from left to right toward the target.
 * Position is expressed as a fraction of the bar width so rendering can scale.
 */
export interface PspspsElement {
  id: string;
  fraction: number;     // 0 = left edge of bar, 1 = right edge
  speed: number;        // fraction per tick
}

export interface PspspsTapResult {
  perfectHits: number;
  partialHits: number;
  pointsAwarded: number;
  hitIds: string[];     // elements consumed by this tap
}
