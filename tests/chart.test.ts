import { describe, expect, it } from 'vitest';
import { emptyChart, validateChart, type Chart } from '../src/shared/state';

describe('Chart', () => {
  it('emptyChart returns an 8-step blank chart at 120 bpm', () => {
    const c = emptyChart('alice', 'untitled');
    expect(c.stepCount).toBe(8);
    expect(c.bpm).toBe(120);
    expect(c.steps).toHaveLength(8);
    expect(c.steps.every(s => s.lanes.length === 0)).toBe(true);
  });

  it('validateChart rejects wrong stepCount', () => {
    const c = emptyChart('alice', 'x');
    const bad = { ...c, stepCount: 7 } as unknown as Chart;
    expect(validateChart(bad)).toMatchObject({ ok: false });
  });

  it('validateChart rejects out-of-range bpm', () => {
    const c = emptyChart('alice', 'x');
    expect(validateChart({ ...c, bpm: 30 })).toMatchObject({ ok: false });
    expect(validateChart({ ...c, bpm: 240 })).toMatchObject({ ok: false });
  });

  it('validateChart rejects illegal lane ids', () => {
    const c = emptyChart('alice', 'x');
    c.steps[0] = { lanes: [3 as unknown as 0] };
    expect(validateChart(c)).toMatchObject({ ok: false });
  });

  it('validateChart returns ok:true for a clean emptyChart', () => {
    const c = emptyChart('alice', 'x');
    expect(validateChart(c)).toEqual({ ok: true });
  });

  it('validateChart rejects steps.length !== 8 when stepCount is right', () => {
    const c = emptyChart('alice', 'x');
    c.steps.pop();
    expect(validateChart(c)).toMatchObject({ ok: false });
  });
});
