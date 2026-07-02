import type { PlayerState } from './state';

export type AchievementTier = 'bronze' | 'silver' | 'gold';
export type AchievementId =
  | 'songs' | 'perfects' | 'cats' | 'streak' | 'crowd'
  | 'hopper' | 'combo' | 'pockets' | 'boxes' | 'holds';

export interface AchievementDef {
  id: AchievementId;
  name: string;
  thresholds: readonly [number, number, number]; // bronze / silver / gold
  progress: (p: PlayerState) => number;
}

export const ACHIEVEMENT_TIERS = ['bronze', 'silver', 'gold'] as const;

/** Locked 2026-07-02: bronze coins, silver golden box, gold mythic box (the only Mythic faucet besides purchase). */
export const ACHIEVEMENT_TIER_REWARDS = {
  bronze: { coins: 100 },
  silver: { boxTier: 'golden' },
  gold: { boxTier: 'mythic' },
} as const;

/** Launch set (locked). Add/remove/re-threshold HERE — engine + UI derive from this table. */
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'songs',    name: 'Song Finisher',  thresholds: [10, 100, 1000],       progress: p => p.stats.songsFinished },
  { id: 'perfects', name: 'Perfectionist',  thresholds: [100, 1000, 10000],    progress: p => p.stats.totalPerfects },
  { id: 'cats',     name: 'Cat Collector',  thresholds: [25, 50, 100],         progress: p => p.ownedCats.length },
  { id: 'streak',   name: 'Streaker',       thresholds: [3, 7, 30],            progress: p => p.stats.longestDailyStreak },
  { id: 'crowd',    name: 'Crowd Favorite', thresholds: [10, 100, 1000],       progress: p => p.stats.playsReceived },
  { id: 'hopper',   name: 'Show Hopper',    thresholds: [10, 100, 1000],       progress: p => p.stats.playsOnOthers },
  { id: 'combo',    name: 'Combo Machine',  thresholds: [50, 150, 500],        progress: p => p.stats.longestCombo },
  { id: 'pockets',  name: 'Deep Pockets',   thresholds: [1000, 10000, 100000], progress: p => p.stats.coinsEarnedLifetime },
  { id: 'boxes',    name: 'Box Addict',     thresholds: [5, 25, 100],          progress: p => Object.values(p.stats.boxesOpened).reduce((a, n) => a + (n ?? 0), 0) },
  { id: 'holds',    name: 'Hold Steady',    thresholds: [50, 500, 5000],       progress: p => p.stats.holdsCompleted },
];

export function achievementProgress(p: PlayerState, id: AchievementId): number {
  const def = ACHIEVEMENTS.find(a => a.id === id);
  return def ? def.progress(p) : 0;
}

export function tierThreshold(def: AchievementDef, tier: AchievementTier): number {
  return def.thresholds[ACHIEVEMENT_TIERS.indexOf(tier)]!;
}

export function tierReached(value: number, def: AchievementDef): AchievementTier | null {
  let reached: AchievementTier | null = null;
  for (const tier of ACHIEVEMENT_TIERS) if (value >= tierThreshold(def, tier)) reached = tier;
  return reached;
}

export function achievementClaimError(p: PlayerState, id: string, tier: string, boxTier: string | undefined): string | null {
  const def = ACHIEVEMENTS.find(a => a.id === id);
  if (!def) return 'unknown_achievement';
  if (!(ACHIEVEMENT_TIERS as readonly string[]).includes(tier)) return 'unknown_tier';
  const t = tier as AchievementTier;
  if ((p.economy.achievementsClaimed[def.id] ?? []).includes(t)) return 'already_claimed';
  if (def.progress(p) < tierThreshold(def, t)) return 'not_reached';
  const reward = ACHIEVEMENT_TIER_REWARDS[t];
  if ('boxTier' in reward && boxTier !== reward.boxTier) return 'wrong_box_tier';
  return null;
}
