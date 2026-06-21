import { describe, it, expect } from 'vitest';
import type { ThemeId, ThemeEntry, BackgroundId } from '@/../shared/state';
import { BACKGROUND_CATALOG } from '@/../shared/state';

// Phase 5: decoration types removed. This file now tests the replacement types.
describe('background + theme types', () => {
  it('ThemeId is a string', () => {
    const id: ThemeId = 'default';
    expect(typeof id).toBe('string');
  });

  it('ThemeEntry has required fields', () => {
    const e: ThemeEntry = {
      id: 'default',
      displayName: 'Default',
      backdropKey: 'bg-default',
      musicKey: 'theme-default-music',
      rarity: 'common',
    };
    expect(e.id).toBe('default');
  });

  it('BackgroundId union covers the three base backgrounds', () => {
    const ids: BackgroundId[] = ['default', 'cozy', 'spooky'];
    expect(ids).toHaveLength(3);
  });

  it('BACKGROUND_CATALOG has entries for all three backgrounds', () => {
    expect(BACKGROUND_CATALOG.default).toBeDefined();
    expect(BACKGROUND_CATALOG.cozy).toBeDefined();
    expect(BACKGROUND_CATALOG.spooky).toBeDefined();
  });

  it('each BACKGROUND_CATALOG entry has an id and backdropKey', () => {
    for (const entry of Object.values(BACKGROUND_CATALOG)) {
      expect(entry.id).toBeTruthy();
      expect(entry.backdropKey).toBeTruthy();
    }
  });
});
