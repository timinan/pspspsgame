import { describe, it, expect } from 'vitest';
import { ScoreSystem } from '@/systems/score-system';
import { MeowBarSystem } from '@/systems/meow-bar-system';
import { RhythmSystem } from '@/systems/rhythm-system';
import { InteractionSystem } from '@/systems/interaction-system';
import { CatSelectionSystem } from '@/systems/cat-selection-system';
import { Balance } from '@/constants/balance';
import type { CatModel } from '@/types/game';

describe('phase 1 — systems composed end-to-end', () => {
  it('catching pspsps elements fills the meow bar', () => {
    const score = new ScoreSystem();
    const meow = new MeowBarSystem();
    const rhythm = new RhythmSystem(() => 0.5);

    // Spawn a stream of elements, force each onto the target, tap to consume
    for (let round = 0; round < 30; round++) {
      for (let i = 0; i < Balance.pspspsBaseSpawnDelayTicks; i++) rhythm.tick();
      for (const el of rhythm.getElements()) {
        (el as { fraction: number }).fraction = rhythm.getTargetFraction();
      }
      const result = rhythm.tap();
      score.add(result.pointsAwarded);
      meow.onScoreChanged(score.get());
    }

    expect(score.get()).toBeGreaterThan(0);
    expect(meow.isFull()).toBe(true);
  });

  it('interaction + selection compose: pick a cat then resolve a pet', () => {
    const cats: CatModel[] = [
      { id: 'a', breed: 'cat1', animation: 'idle', x: 0, y: 0 },
      { id: 'b', breed: 'cat2', animation: 'idle', x: 0, y: 0 },
      { id: 'c', breed: 'cat3', animation: 'idle', x: 0, y: 0 },
    ];

    const selector = new CatSelectionSystem(() => 0.4);
    const interaction = new InteractionSystem(() => 0.5);

    const picked = selector.pickActive(cats);
    expect(['a', 'b', 'c']).toContain(picked.id);

    // rng=0.5, pet chance=0.7, so 0.5 < 0.7 => success
    const result = interaction.resolve('pet');
    expect(result.outcome).toBe('success');
    expect(result.coinsAwarded).toBeGreaterThan(0);
  });

  it('drain empties the meow bar over many ticks', () => {
    const meow = new MeowBarSystem();
    meow.onScoreChanged(10_000);
    expect(meow.isFull()).toBe(true);
    for (let i = 0; i < Balance.meowBarMax / Balance.meowBarDrainPerTick; i++) {
      meow.drainTick();
    }
    expect(meow.isEmpty()).toBe(true);
  });
});
