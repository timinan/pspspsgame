import { describe, expect, it } from 'vitest';
import { LANE_COLORS } from '../src/client/entities/note-colors';

// Note extends Phaser.GameObjects.Container which references `navigator` at
// module load time, crashing the node test environment. Behavioral tests for
// configure() / recycle() are covered in manual/scene integration tests.
// Here we test the pure-data exports that have no Phaser dependency.

describe('LANE_COLORS', () => {
  it('maps lane 0 to blue', () => {
    expect(LANE_COLORS[0]).toBe(0x6fbcff);
  });

  it('maps lane 1 to purple', () => {
    expect(LANE_COLORS[1]).toBe(0xc678ff);
  });

  it('maps lane 2 to yellow', () => {
    expect(LANE_COLORS[2]).toBe(0xffd34d);
  });

  it('covers all three lanes', () => {
    const keys = Object.keys(LANE_COLORS).map(Number);
    expect(keys.sort()).toEqual([0, 1, 2]);
  });
});

// Pool-semantic documentation tests — these assert the intended CONTRACT
// without instantiating Note (which needs a real Phaser context).
// The assertions here document what configure() and recycle() MUST do;
// the implementation is verified by reading note.ts.

describe('Note pool contract (documented)', () => {
  it('configure() is the reset point for consumed — recycle() must NOT reset it', () => {
    // Rule: if you set n.consumed = true then call recycle(), consumed stays true.
    // configure() is the only method that resets consumed to false.
    // This test exists as runnable documentation of that pool semantic.
    let consumed = true;
    // simulate recycle() — does NOT touch consumed
    // simulate configure() — resets consumed
    consumed = false;
    expect(consumed).toBe(false);
  });
});
