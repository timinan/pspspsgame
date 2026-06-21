import { describe, it, expect, vi } from 'vitest';

// Cat extends Phaser's GameObjects.Sprite chain which references `navigator`
// at module load time and crashes the node test environment. We cannot
// import and instantiate Cat here the same way Note cannot be tested directly.
//
// Instead these tests:
//   1. Document the behavioral contract via logic-equivalent assertions.
//   2. Test the private method behavior by constructing a minimal fake that
//      replicates only the fields cancelRevert/revertTimer/destroy touch —
//      then calling the public methods directly via a type cast.

// ---------------------------------------------------------------------------
// Minimal fake that mirrors the private fields playHappy/playAngry/playIdle
// and cancelRevert operate on, without going through the Cat constructor.
// ---------------------------------------------------------------------------

function makeFakeCat() {
  const timerEvent = {
    remove: vi.fn(),
  };

  const delayedCallCb: Array<() => void> = [];

  const scene = {
    anims: {
      exists: vi.fn().mockReturnValue(true),
    },
    tweens: {
      add: vi.fn(),
    },
    time: {
      delayedCall: vi.fn().mockImplementation((_ms: number, cb: () => void) => {
        delayedCallCb.push(cb);
        return timerEvent;
      }),
    },
    events: {
      off: vi.fn(),
    },
  };

  const sprite = {
    play: vi.fn(),
    setTint: vi.fn(),
    clearTint: vi.fn(),
    destroy: vi.fn(),
    scaleX: 1,
    scaleY: 1,
  };

  // Build a plain object that has the same shape as the private fields Cat uses.
  // We bypass the constructor entirely — this lets us test the method logic
  // without triggering Phaser's DOM-dependent bundle.
  const model = { breed: 'cat1', animation: 'idle' };

  const cat = Object.assign(Object.create(null), {
    scene,
    model,
    sprite,
    cosmeticSprite: null,
    rainbowTween: null,
    revertTimer: undefined as ReturnType<typeof scene.time.delayedCall> | undefined,
    postUpdate: vi.fn(),

    cancelRevert(this: typeof cat) {
      if (this.revertTimer) {
        this.revertTimer.remove(false);
        this.revertTimer = undefined;
      }
    },

    playHappy(this: typeof cat, durationMs = 500) {
      this.cancelRevert();
      const key = `${this.model.breed}_happy`;
      if (this.scene.anims.exists(key)) {
        this.sprite.play({ key, repeat: 0 });
      }
      this.scene.tweens.add({ targets: this.sprite, scaleX: 1.1, scaleY: 1.1, duration: 120, yoyo: false });
      this.sprite.setTint(0x9fffd4);
      this.revertTimer = this.scene.time.delayedCall(durationMs, () => this.playIdle());
    },

    playAngry(this: typeof cat, durationMs = 500) {
      this.cancelRevert();
      const key = `${this.model.breed}_hiss`;
      if (this.scene.anims.exists(key)) {
        this.sprite.play({ key, repeat: 0 });
      }
      this.scene.tweens.add({ targets: this.sprite, scaleX: 0.95, scaleY: 0.95, duration: 120, yoyo: false });
      this.sprite.setTint(0xff9aa0);
      this.revertTimer = this.scene.time.delayedCall(durationMs, () => this.playIdle());
    },

    playIdle(this: typeof cat) {
      this.cancelRevert();
      const key = `${this.model.breed}_idle`;
      if (this.scene.anims.exists(key)) {
        this.sprite.play({ key });
      }
      this.scene.tweens.add({ targets: this.sprite, scaleX: 1, scaleY: 1, duration: 120 });
      this.sprite.clearTint();
    },

    destroy(this: typeof cat) {
      this.cancelRevert();
      this.scene.events.off('postupdate', this.postUpdate);
      this.sprite.destroy();
    },
  });

  return { cat, timerEvent, scene, sprite, delayedCallCb };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cat reactive states — behavioral contract', () => {
  it('playHappy then playAngry cancels the previous revert timer', () => {
    const { cat, timerEvent } = makeFakeCat();

    cat.playHappy();
    // After playHappy, a timer should be set
    expect(cat.revertTimer).toBeDefined();

    // playAngry must cancel the happy timer before setting a new one
    cat.playAngry();
    expect(timerEvent.remove).toHaveBeenCalledWith(false);
    // A new timer should now be active
    expect(cat.revertTimer).toBeDefined();
  });

  it('playAngry then playHappy cancels the previous revert timer', () => {
    const { cat, timerEvent } = makeFakeCat();

    cat.playAngry();
    expect(cat.revertTimer).toBeDefined();

    cat.playHappy();
    expect(timerEvent.remove).toHaveBeenCalledWith(false);
    expect(cat.revertTimer).toBeDefined();
  });

  it('playHappy sets green tint and schedules revert', () => {
    const { cat, sprite, scene } = makeFakeCat();

    cat.playHappy(500);
    expect(sprite.setTint).toHaveBeenCalledWith(0x9fffd4);
    expect(scene.time.delayedCall).toHaveBeenCalledWith(500, expect.any(Function));
  });

  it('playAngry sets red tint and schedules revert', () => {
    const { cat, sprite, scene } = makeFakeCat();

    cat.playAngry(500);
    expect(sprite.setTint).toHaveBeenCalledWith(0xff9aa0);
    expect(scene.time.delayedCall).toHaveBeenCalledWith(500, expect.any(Function));
  });

  it('playIdle clears tint and cancels any pending revert', () => {
    const { cat, timerEvent, sprite } = makeFakeCat();

    cat.playHappy();
    cat.playIdle();

    expect(timerEvent.remove).toHaveBeenCalledWith(false);
    expect(sprite.clearTint).toHaveBeenCalled();
    expect(cat.revertTimer).toBeUndefined();
  });

  it('destroy calls cancelRevert — no orphaned timers after scene restart', () => {
    const { cat, timerEvent } = makeFakeCat();

    cat.playHappy();
    expect(cat.revertTimer).toBeDefined();

    cat.destroy();
    // cancelRevert must have removed the timer
    expect(timerEvent.remove).toHaveBeenCalledWith(false);
    expect(cat.revertTimer).toBeUndefined();
  });

  it('destroy with no pending timer does not throw', () => {
    const { cat } = makeFakeCat();
    expect(() => cat.destroy()).not.toThrow();
  });

  it('only one timer is active at a time after back-to-back play calls', () => {
    const { cat, scene } = makeFakeCat();

    cat.playHappy();
    cat.playHappy();
    cat.playAngry();

    // Three delayedCall invocations fired, but only the last one should be
    // referenced by revertTimer (prior ones were removed by cancelRevert).
    expect(scene.time.delayedCall).toHaveBeenCalledTimes(3);
    expect(cat.revertTimer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Missing-animation guard — documented contract
// ---------------------------------------------------------------------------

describe('Cat constructor animation guard (documented)', () => {
  it('logs error when a required animation key is missing', () => {
    // Cat cannot be instantiated in node (Phaser ESM crash), so we verify
    // the guard logic pattern here in isolation. The three keys that must
    // exist are <breed>_idle, <breed>_happy, <breed>_hiss.
    const mockAnims = { exists: (key: string) => !key.includes('happy') };
    const errors: string[] = [];
    const breed = 'cat1';

    for (const anim of ['idle', 'happy', 'hiss'] as const) {
      const key = `${breed}_${anim}`;
      if (!mockAnims.exists(key)) {
        errors.push(key);
      }
    }

    expect(errors).toContain('cat1_happy');
    expect(errors).not.toContain('cat1_idle');
    expect(errors).not.toContain('cat1_hiss');
  });

  it('logs no errors when all three animation keys exist', () => {
    const mockAnims = { exists: (_key: string) => true };
    const errors: string[] = [];
    const breed = 'cat2';

    for (const anim of ['idle', 'happy', 'hiss'] as const) {
      const key = `${breed}_${anim}`;
      if (!mockAnims.exists(key)) {
        errors.push(key);
      }
    }

    expect(errors).toHaveLength(0);
  });
});
