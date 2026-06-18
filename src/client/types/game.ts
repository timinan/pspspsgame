export type CatBreed = 'cat1' | 'cat2' | 'cat3';

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
  x: number; // 0–100 percent of background width
  y: number; // 0–100 percent of background height
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
