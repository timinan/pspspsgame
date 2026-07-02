/**
 * Per-post milestone rewards — paid into the host's pendingCollect pot.
 * Milestones bypass the 300/day royalty cap; they are one-time events
 * tied to play-count thresholds and first-pass detection.
 */
import { ECONOMY } from './economy';

export interface MilestoneResult {
  coins: number;
  labels: string[];
}

/**
 * Compute which post milestones were crossed on this play.
 *
 * @param prevPlays - total visitor plays for this post BEFORE this one
 * @param newPlays  - total visitor plays AFTER this one (= prevPlays + 1)
 * @param isFirstPass - true when this play atomically claimed the first-pass
 *                      slot (incrBy on the claim counter returned 1)
 *
 * Milestones are one-time — a threshold crossed when prevPlays < threshold
 * and newPlays >= threshold. Once crossed (prevPlays >= threshold) the same
 * threshold never fires again. firstPass is already atomic on the call site.
 */
export function milestonesEarned(
  prevPlays: number,
  newPlays: number,
  isFirstPass: boolean,
): MilestoneResult {
  let coins = 0;
  const labels: string[] = [];

  // First-play milestone: first non-owner play on this post
  if (prevPlays < 1 && newPlays >= 1) {
    coins += ECONOMY.postMilestones.firstPlay;
    labels.push('first play');
  }

  // Play-count milestones (10 / 50 / 100)
  for (const milestone of ECONOMY.postMilestones.playCounts) {
    if (prevPlays < milestone.count && newPlays >= milestone.count) {
      coins += milestone.coins;
      labels.push(`${milestone.count} plays`);
    }
  }

  // First-pass milestone
  if (isFirstPass) {
    coins += ECONOMY.postMilestones.firstPass;
    labels.push('first pass');
  }

  return { coins, labels };
}
