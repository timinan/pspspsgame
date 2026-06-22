import { describe, it, expect } from 'vitest';
import { buildSchedule, noteForLane } from '../src/client/systems/song-player';
import { emptyChart, type Chart } from '../src/shared/state';

// SongPlayer's Tone.js side-effects are out of scope for unit tests
// (no AudioContext in Node). We exercise the pure scheduling math
// instead: lane-to-note mapping and chart-step-to-Transport-time
// conversion.

describe('SongPlayer scheduling math', () => {
  describe('noteForLane', () => {
    it('lane 0 plays the A minor root (A3)', () => {
      expect(noteForLane(0)).toBe('A3');
    });
    it('lane 1 plays the minor third (C4)', () => {
      expect(noteForLane(1)).toBe('C4');
    });
    it('lane 2 plays the perfect fifth (E4)', () => {
      expect(noteForLane(2)).toBe('E4');
    });
  });

  describe('buildSchedule', () => {
    function chartFromLanes(stepLanes: number[][], bpm = 120): Chart {
      const c = emptyChart('test', 'unit', stepLanes.length);
      c.bpm = bpm;
      stepLanes.forEach((lanes, i) => {
        c.steps[i] = { lanes: lanes as Array<0 | 1 | 2> };
      });
      return c;
    }

    it('returns an empty schedule for a chart with no active steps', () => {
      const c = chartFromLanes([[], [], [], [], [], [], [], []]);
      expect(buildSchedule(c)).toEqual([]);
    });

    it('schedules step 0 at time 0', () => {
      const c = chartFromLanes([[0], [], [], [], [], [], [], []]);
      const out = buildSchedule(c);
      expect(out).toEqual([{ timeSec: 0, note: 'A3' }]);
    });

    it('spaces steps by 60s / (bpm * 2) at the chart bpm', () => {
      // 120 bpm × 2 eighths = 250ms per step = 0.25s.
      const c = chartFromLanes([[0], [1], [2], [], [], [], [], []], 120);
      const out = buildSchedule(c);
      expect(out.map((s) => s.timeSec)).toEqual([0, 0.25, 0.5]);
      expect(out.map((s) => s.note)).toEqual(['A3', 'C4', 'E4']);
    });

    it('emits one entry per active lane on a multi-lane step (double-tap)', () => {
      const c = chartFromLanes([[0, 2], [], [], [], [], [], [], []], 120);
      const out = buildSchedule(c);
      expect(out).toEqual([
        { timeSec: 0, note: 'A3' },
        { timeSec: 0, note: 'E4' },
      ]);
    });

    it('respects slower bpm — 90 bpm → 333ms per step', () => {
      const c = chartFromLanes([[0], [1], [], [], [], [], [], []], 90);
      const out = buildSchedule(c);
      expect(out[0]!.timeSec).toBeCloseTo(0, 5);
      // 60000 / (90 * 2) = 333.33ms = 0.333s
      expect(out[1]!.timeSec).toBeCloseTo(0.333, 2);
    });

    it('handles longer charts (default 32-step paged chart)', () => {
      const c = emptyChart('test', 'unit'); // defaults to 32 steps
      c.steps[0] = { lanes: [0] };
      c.steps[31] = { lanes: [2] };
      c.bpm = 120;
      const out = buildSchedule(c);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ timeSec: 0, note: 'A3' });
      // 31 × 0.25s = 7.75s
      expect(out[1]!.timeSec).toBeCloseTo(7.75, 2);
      expect(out[1]!.note).toBe('E4');
    });
  });
});
