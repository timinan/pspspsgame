import { describe, it, expect } from 'vitest';
import { buildDecorMenu, buildCatMenu } from '@/ui/context-menu';

describe('ContextMenu (smoke)', () => {
  it('exports helpers', () => {
    expect(typeof buildDecorMenu).toBe('function');
    expect(typeof buildCatMenu).toBe('function');
  });
});

describe('buildDecorMenu', () => {
  it('returns "Place in scene" as primary when not placed', () => {
    const rows = buildDecorMenu({ isPlaced: false, displayName: 'Lamp' });
    expect(rows[0]!.primary).toBe(true);
    expect(rows[0]!.label).toContain('Place');
  });

  it('returns "Take down" as primary when placed', () => {
    const rows = buildDecorMenu({ isPlaced: true, displayName: 'Lamp' });
    expect(rows[0]!.primary).toBe(true);
    expect(rows[0]!.label).toContain('Take down');
  });

  it('always includes Sell and Gift', () => {
    const rows = buildDecorMenu({ isPlaced: false, displayName: 'Lamp' });
    expect(rows.some((r) => r.label.toLowerCase().includes('sell'))).toBe(true);
    expect(rows.some((r) => r.label.toLowerCase().includes('gift'))).toBe(true);
  });
});

describe('buildCatMenu', () => {
  it('returns "Seat in scene" as primary when not seated', () => {
    const rows = buildCatMenu({ isSeated: false, displayName: 'Mochi' });
    expect(rows[0]!.primary).toBe(true);
    expect(rows[0]!.label).toContain('Seat');
  });

  it('returns "Dress up" as primary when seated', () => {
    const rows = buildCatMenu({ isSeated: true, displayName: 'Mochi' });
    expect(rows[0]!.primary).toBe(true);
    expect(rows[0]!.label).toContain('Dress up');
  });

  it('always includes Gift and Rehome (danger)', () => {
    const rows = buildCatMenu({ isSeated: false, displayName: 'Mochi' });
    expect(rows.some((r) => r.label.toLowerCase().includes('gift'))).toBe(true);
    const rehomeRow = rows.find((r) => r.label.toLowerCase().includes('rehome'));
    expect(rehomeRow).toBeDefined();
    expect(rehomeRow!.danger).toBe(true);
  });
});
