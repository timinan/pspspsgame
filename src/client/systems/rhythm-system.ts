import { Balance } from '@/constants/balance';
import type { PspspsElement, PspspsTapResult } from '@/types/game';

/**
 * Models the pspsps target track:
 *   - A stationary target sits at `pspspsTargetXFraction`.
 *   - Moving "pspsps" elements spawn at the left and slide right toward it.
 *   - When the player taps, every element within the perfect/partial margin
 *     of the target is consumed and awards points.
 *   - Elements that pass off the right edge wrap back to the left.
 *
 * Movement is time-based via `advance(dtMs)` so the renderer can call it
 * every frame for smooth motion. Spawning runs on a slower discrete tick
 * via `spawnTick()` to keep spawn timing deterministic.
 *
 * `tick()` is provided for tests and runs one tickDurationMs worth of
 * advance + a single spawnTick.
 */
export class RhythmSystem {
  private readonly elements: PspspsElement[] = [];
  private ticksSinceLastSpawn = 0;
  private ticksUntilNextSpawn: number;
  private nextId = 0;
  private speedMultiplier = 1;

  constructor(private readonly rng: () => number = Math.random) {
    this.ticksUntilNextSpawn = this.rollSpawnDelay();
  }

  /**
   * Scales how fast existing elements slide right. The renderer sets this
   * each frame based on meow-bar progress so the game ramps up in
   * difficulty as the meter fills.
   */
  setSpeedMultiplier(mult: number): void {
    this.speedMultiplier = Math.max(0, mult);
  }

  /**
   * Move all elements based on elapsed wall-clock time. Called every frame.
   * Returns the number of elements that despawned past the right edge this
   * frame — the renderer uses that to reset the combo when a ball was
   * missed (untapped).
   */
  advance(dtMs: number): number {
    const dtSec = dtMs / 1000;
    for (const el of this.elements) {
      el.fraction += el.speed * dtSec * this.speedMultiplier;
    }
    // Despawn anything that's slid past the right edge so we never render
    // an element half-outside the bar. New elements will spawn over time
    // via spawnTick().
    let despawnedCount = 0;
    for (let i = this.elements.length - 1; i >= 0; i--) {
      if (this.elements[i]!.fraction > 1) {
        this.elements.splice(i, 1);
        despawnedCount += 1;
      }
    }
    return despawnedCount;
  }

  /** Spawn-check tick. Called on a fixed cadence (e.g. every 100ms). */
  spawnTick(): void {
    if (
      this.elements.length < Balance.pspspsMaxElements &&
      this.ticksSinceLastSpawn >= this.ticksUntilNextSpawn
    ) {
      this.spawn();
      this.ticksSinceLastSpawn = 0;
      this.ticksUntilNextSpawn = this.rollSpawnDelay();
    } else {
      this.ticksSinceLastSpawn += 1;
    }
  }

  /** Convenience for tests: advance one tick's worth of time + run spawn check. */
  tick(): void {
    this.advance(Balance.tickDurationMs);
    this.spawnTick();
  }

  tap(): PspspsTapResult {
    const target = Balance.pspspsTargetXFraction;
    const perfect = Balance.pspspsPerfectMarginFraction;
    const partial = Balance.pspspsPartialMarginFraction;

    let perfectHits = 0;
    let partialHits = 0;
    let pointsAwarded = 0;
    const hitIds: string[] = [];

    for (const el of this.elements) {
      const distance = Math.abs(el.fraction - target);
      if (distance <= perfect) {
        perfectHits += 1;
        pointsAwarded += Balance.pspspsPerfectPoints;
        hitIds.push(el.id);
      } else if (distance <= partial) {
        partialHits += 1;
        pointsAwarded += Balance.pspspsPartialPoints;
        hitIds.push(el.id);
      }
    }

    if (hitIds.length > 0) {
      const consumed = new Set(hitIds);
      const survivors = this.elements.filter((e) => !consumed.has(e.id));
      this.elements.length = 0;
      this.elements.push(...survivors);
    }

    return { perfectHits, partialHits, pointsAwarded, hitIds };
  }

  getElements(): readonly PspspsElement[] {
    return this.elements;
  }

  getTargetFraction(): number {
    return Balance.pspspsTargetXFraction;
  }

  private spawn(): void {
    const variation = (this.rng() * 2 - 1) * Balance.pspspsSpeedVariationPerSecond;
    this.elements.push({
      id: `psps-${this.nextId++}`,
      fraction: Balance.pspspsSpawnXFraction,
      speed: Balance.pspspsBaseSpeedFractionPerSecond + variation,
    });
  }

  private rollSpawnDelay(): number {
    const jitter = (this.rng() * 2 - 1) * Balance.pspspsSpawnDelayVariation;
    return Math.max(1, Math.round(Balance.pspspsBaseSpawnDelayTicks * (1 + jitter)));
  }
}
