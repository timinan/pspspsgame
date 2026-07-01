export type Difficulty = 'easy' | 'medium' | 'spicy' | 'hard' | 'insane';
export type RewardTierId = 'flawless' | 'perfect' | 'great' | 'pass' | 'fail';

export const ECONOMY = {
  tiers: [
    { id: 'flawless' as RewardTierId, minAccuracyPct: 99, base: 400 },
    { id: 'perfect' as RewardTierId, minAccuracyPct: 95, base: 300 },
    { id: 'great' as RewardTierId, minAccuracyPct: 85, base: 200 },
    { id: 'pass' as RewardTierId, minAccuracyPct: 75, base: 100 },
  ],
  failBase: 25,
  comboMilestones: [
    { min: 100, bonus: 40 },
    { min: 50, bonus: 20 },
    { min: 25, bonus: 10 },
  ],
  perfectMilestones: [
    { min: 100, bonus: 40 },
    { min: 50, bonus: 20 },
    { min: 20, bonus: 10 },
  ],
  fullComboBonus: 50,
  fullPerfectBonus: 100,
  fcMinNotes: 30,
  difficultyMult: { easy: 1.0, medium: 1.25, spicy: 1.5, hard: 1.75, insane: 2.0 } satisfies Record<Difficulty, number>,
  commentBonus: 50,
  chartDecay: [1, 0.5, 0.25],
  dailyPlayBudget: 1200,
  overBudgetRate: 0.1,
  hostRoyaltyRate: 0.25,
  hostPotDailyCap: 300,
  passAccuracyPct: 75,
  sellPrice: 25,
  postMilestones: {
    firstPlay: 50,
    firstPass: 100,
    playCounts: [
      { count: 10, coins: 100 },
      { count: 50, coins: 250 },
      { count: 100, coins: 500 },
    ],
  },
} as const;

export interface PlayRewardInput {
  accuracyPct: number; // plain accuracy, 0..100 (hits/judged)
  maxCombo: number;
  perfects: number;
  misses: number;
  totalNotes: number; // judged notes this round
  difficulty: Difficulty;
  isOwnShow: boolean;
  chartPlaysToday: number; // completed plays of this post's chart today, before this one
  playIncomeToday: number; // play coins credited today, before this one
}

export interface PlayRewardBreakdown {
  tier: RewardTierId;
  tierBase: number;
  skillBonus: number;
  fullCombo: boolean;
  fullPerfect: boolean;
  multiplier: number;
  decayRate: number;
  budgetReduced: boolean;
  ownShow: boolean;
  final: number;
}

export function classifyTier(accuracyPct: number): { id: RewardTierId; base: number } {
  for (const t of ECONOMY.tiers) {
    if (accuracyPct >= t.minAccuracyPct) return { id: t.id, base: t.base };
  }
  return { id: 'fail', base: ECONOMY.failBase };
}

function milestoneBonus(value: number, table: readonly { min: number; bonus: number }[]): number {
  for (const m of table) if (value >= m.min) return m.bonus;
  return 0;
}

export function computePlayReward(i: PlayRewardInput): PlayRewardBreakdown {
  const tier = classifyTier(i.accuracyPct);
  let skill = milestoneBonus(i.maxCombo, ECONOMY.comboMilestones) + milestoneBonus(i.perfects, ECONOMY.perfectMilestones);
  const eligible = i.totalNotes >= ECONOMY.fcMinNotes;
  const fullPerfect = eligible && i.misses === 0 && i.perfects >= i.totalNotes;
  const fullCombo = !fullPerfect && eligible && i.misses === 0;
  if (fullPerfect) skill += ECONOMY.fullPerfectBonus;
  else if (fullCombo) skill += ECONOMY.fullComboBonus;

  const multiplier = ECONOMY.difficultyMult[i.difficulty];
  const decayRate = ECONOMY.chartDecay[Math.min(i.chartPlaysToday, ECONOMY.chartDecay.length - 1)]!;
  const raw = Math.round((tier.base + skill) * multiplier * decayRate);

  const room = Math.max(0, ECONOMY.dailyPlayBudget - i.playIncomeToday);
  const fullPart = Math.min(raw, room);
  const overPart = raw - fullPart;
  const paid = fullPart + Math.round(overPart * ECONOMY.overBudgetRate);

  return {
    tier: tier.id,
    tierBase: tier.base,
    skillBonus: skill,
    fullCombo,
    fullPerfect,
    multiplier,
    decayRate,
    budgetReduced: overPart > 0,
    ownShow: i.isOwnShow,
    final: i.isOwnShow ? 0 : paid,
  };
}
