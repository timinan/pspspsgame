import { ECONOMY, type PlayRewardBreakdown } from './economy';
import type { PlayerState } from './state';
import { rolloverEconomy } from './state';

export interface ApplyPlayRewardResult {
  breakdown: PlayRewardBreakdown;
  royalty: number;
}

/**
 * Mutates visitor + owner in place to credit a completed play round.
 *
 * - Rolls over stale economy daily blocks for both parties first.
 * - Own-show plays (visitor.username === owner.username): increments
 *   playsOnOwnShow, no coin credit, royalty = 0.
 * - Other plays: credits visitor.coins by breakdown.final, updates
 *   economy daily counters, pays host royalty capped by daily pot.
 *
 * Returns the breakdown and the actual royalty credited to the host.
 */
export function applyPlayReward(
  visitor: PlayerState,
  owner: PlayerState,
  breakdown: PlayRewardBreakdown,
  postId: string,
  isoToday: string,
): ApplyPlayRewardResult {
  // Ensure both parties have today's daily block (idempotent if already today).
  rolloverEconomy(visitor, isoToday);
  rolloverEconomy(owner, isoToday);

  if (visitor.username === owner.username) {
    visitor.stats.playsOnOwnShow += 1;
    return { breakdown, royalty: 0 };
  }

  // Credit visitor
  visitor.coins += breakdown.final;
  visitor.stats.coinsEarnedLifetime += breakdown.final;
  visitor.economy.daily.playIncome += breakdown.final;
  visitor.economy.daily.chartPlays[postId] =
    (visitor.economy.daily.chartPlays[postId] ?? 0) + 1;

  // Host royalty: floor(final × hostRoyaltyRate), capped by remaining daily
  // pot. Lands in the owner's pendingCollect pot — NOT coins — so it
  // surfaces as the "your show earned N while you were away — COLLECT"
  // moment in the Rewards drawer. coinsFromShow/coinsEarnedLifetime are
  // credited at collect time, not here.
  const rawRoyalty = Math.floor(breakdown.final * ECONOMY.hostRoyaltyRate);
  const remainingPot = Math.max(0, ECONOMY.hostPotDailyCap - owner.economy.daily.hostPotAccrued);
  const royalty = Math.min(rawRoyalty, remainingPot);

  if (royalty > 0) {
    owner.economy.pendingCollect += royalty;
    owner.economy.daily.hostPotAccrued += royalty;
  }

  return { breakdown, royalty };
}
