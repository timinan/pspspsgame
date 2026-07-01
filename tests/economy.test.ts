import { describe, expect, it } from 'vitest';
import { computePlayReward, ECONOMY, type PlayRewardInput } from '../src/shared/economy';

const base: PlayRewardInput = {
  accuracyPct: 80, maxCombo: 10, perfects: 0, misses: 5, totalNotes: 50,
  difficulty: 'easy', isOwnShow: false, chartPlaysToday: 0, playIncomeToday: 0,
};

describe('computePlayReward', () => {
  it('classifies tier boundaries on plain accuracy', () => {
    expect(computePlayReward({ ...base, accuracyPct: 74.9 }).tierBase).toBe(25);
    expect(computePlayReward({ ...base, accuracyPct: 75 }).tierBase).toBe(100);
    expect(computePlayReward({ ...base, accuracyPct: 85 }).tierBase).toBe(200);
    expect(computePlayReward({ ...base, accuracyPct: 95 }).tierBase).toBe(300);
    expect(computePlayReward({ ...base, accuracyPct: 99 }).tierBase).toBe(400);
  });

  it('pays only the highest combo and perfect milestone', () => {
    const r = computePlayReward({ ...base, maxCombo: 120, perfects: 55, misses: 1 });
    expect(r.skillBonus).toBe(40 + 20); // combo ≥100 → 40, perfects ≥50 → 20
  });

  it('FULL PERFECT replaces FULL COMBO and caps skill at 180', () => {
    const fp = computePlayReward({ ...base, accuracyPct: 100, maxCombo: 100, perfects: 50, misses: 0, totalNotes: 50 });
    expect(fp.fullPerfect).toBe(true);
    expect(fp.fullCombo).toBe(false);
    expect(fp.skillBonus).toBe(40 + 20 + 100);
    const fc = computePlayReward({ ...base, maxCombo: 50, perfects: 10, misses: 0, totalNotes: 50 });
    expect(fc.fullCombo).toBe(true);
    expect(fc.skillBonus).toBe(20 + 0 + 50);
  });

  it('denies FC/FP on charts under 30 notes', () => {
    const r = computePlayReward({ ...base, misses: 0, totalNotes: 20, perfects: 20 });
    expect(r.fullCombo).toBe(false);
    expect(r.fullPerfect).toBe(false);
  });

  it('applies difficulty multiplier and ceilings', () => {
    const easyMax = computePlayReward({ ...base, accuracyPct: 100, maxCombo: 100, perfects: 100, misses: 0, totalNotes: 100 });
    expect(easyMax.final).toBe(580); // (400+180)×1.0 — see spec-inconsistency note
    const insaneMax = computePlayReward({ ...base, accuracyPct: 100, maxCombo: 100, perfects: 100, misses: 0, totalNotes: 100, difficulty: 'insane' });
    expect(insaneMax.final).toBe(1160);
  });

  it('decays repeat plays of the same chart 100/50/25', () => {
    expect(computePlayReward({ ...base, chartPlaysToday: 0 }).decayRate).toBe(1);
    expect(computePlayReward({ ...base, chartPlaysToday: 1 }).decayRate).toBe(0.5);
    expect(computePlayReward({ ...base, chartPlaysToday: 2 }).decayRate).toBe(0.25);
    expect(computePlayReward({ ...base, chartPlaysToday: 9 }).decayRate).toBe(0.25);
  });

  it('splits the daily budget valve at the 1200 line', () => {
    // reward would be 200; 100 of room left → 100 full + 100×10% = 110
    const r = computePlayReward({ ...base, accuracyPct: 85, maxCombo: 0, perfects: 0, playIncomeToday: 1100 });
    expect(r.final).toBe(110);
    expect(r.budgetReduced).toBe(true);
    const over = computePlayReward({ ...base, accuracyPct: 85, maxCombo: 0, perfects: 0, playIncomeToday: 1200 });
    expect(over.final).toBe(20);
  });

  it('pays zero on own-show plays but reports the breakdown', () => {
    const r = computePlayReward({ ...base, isOwnShow: true, accuracyPct: 95 });
    expect(r.final).toBe(0);
    expect(r.ownShow).toBe(true);
    expect(r.tierBase).toBe(300);
  });
});
