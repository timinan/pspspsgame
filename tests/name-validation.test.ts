import { describe, it, expect } from 'vitest';
import { validateCatName, containsProfanity, isDuplicateName, NAME_MAX_LENGTH } from '@/ui/name-validation';

const noCats: Array<{ id: string; name: string }> = [];

describe('validateCatName', () => {
  it('accepts a reasonable name', () => {
    expect(validateCatName('Whiskers', noCats)).toEqual({ ok: true, error: '' });
  });

  it('rejects empty / whitespace-only names', () => {
    expect(validateCatName('', noCats).ok).toBe(false);
    expect(validateCatName('   ', noCats).ok).toBe(false);
  });

  it('rejects names exceeding NAME_MAX_LENGTH', () => {
    const longName = 'x'.repeat(NAME_MAX_LENGTH + 1);
    const result = validateCatName(longName, noCats);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/max length/i);
  });

  it('accepts names exactly at the limit', () => {
    const name = 'x'.repeat(NAME_MAX_LENGTH);
    expect(validateCatName(name, noCats).ok).toBe(true);
  });

  it('rejects profanity', () => {
    expect(validateCatName('fuck', noCats).ok).toBe(false);
    expect(validateCatName('Mr. Fuck', noCats).ok).toBe(false);
  });

  it('rejects profanity with leet-speak substitutions', () => {
    expect(validateCatName('fu<k', noCats).ok).toBe(false);
    expect(validateCatName('5h1t', noCats).ok).toBe(false);
    expect(validateCatName('B!tch', noCats).ok).toBe(false);
  });

  it('rejects duplicate names case-insensitively', () => {
    const existing = [{ id: 'a', name: 'Bob' }];
    expect(validateCatName('Bob', existing).ok).toBe(false);
    expect(validateCatName('bob', existing).ok).toBe(false);
    expect(validateCatName('  BOB  ', existing).ok).toBe(false);
  });

  it('allows the same name when selfId matches (renaming a cat to its current name)', () => {
    const existing = [{ id: 'a', name: 'Bob' }];
    expect(validateCatName('Bob', existing, 'a').ok).toBe(true);
  });
});

describe('containsProfanity', () => {
  it('catches naive spellings', () => {
    expect(containsProfanity('shit')).toBe(true);
  });
  it('catches leet-speak', () => {
    expect(containsProfanity('5h!t')).toBe(true);
  });
  it('passes clean strings', () => {
    expect(containsProfanity('Mochi')).toBe(false);
    expect(containsProfanity('Cinnamon')).toBe(false);
  });
});

describe('isDuplicateName', () => {
  it('detects case-insensitive duplicates', () => {
    expect(isDuplicateName('Bob', [{ id: 'x', name: 'BOB' }])).toBe(true);
  });
  it('respects selfId opt-out', () => {
    expect(isDuplicateName('Bob', [{ id: 'x', name: 'Bob' }], 'x')).toBe(false);
  });
});
