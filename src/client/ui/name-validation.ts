/**
 * Tiny client-side validator for the cat-naming modal.
 *
 * Catches the obvious cases (empty, too long, duplicates, common profanity
 * including leet-speak substitutions). Server-side validation should be
 * the source of truth for anything that genuinely matters — this is a
 * front-of-house guard so kids can't easily name their cat something
 * obviously not okay.
 */

export const NAME_MAX_LENGTH = 20;

/**
 * Lowercase + substitute the common leet-speak / symbol → letter mappings,
 * then strip everything that isn't a letter. So "fuck", "f.u.c.k.", "fu<k",
 * "FU(K", and "f u c k" all normalize to "fuck".
 */
function normalizeForProfanity(s: string): string {
  return s
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i')
    .replace(/\|/g, 'i')
    .replace(/[<({[]/g, 'c')
    .replace(/\+/g, 't')
    .replace(/[^a-z]/g, '');
}

/**
 * Bad-word list. Intentionally minimal — we trust server-side moderation for
 * anything tricky. Covers obvious profanity and the most-common English slurs.
 * Update sparingly; matching is a simple substring check on the normalized
 * input, so very short entries (`ass`, `sex`) will false-positive
 * "Cassidy"/"Sextans" etc. — that's an accepted tradeoff for a child-safe
 * naming flow.
 */
const PROFANITY_WORDS = [
  'fuck', 'shit', 'cunt', 'bitch', 'dick', 'cock', 'pussy', 'asshole', 'ass',
  'piss', 'damn', 'bastard', 'bollocks', 'wank', 'twat', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'fag', 'chink', 'spic', 'kike', 'wetback',
  'gook', 'retard', 'tranny',
  'sex', 'porn', 'rape', 'penis', 'vagina',
];

export function containsProfanity(name: string): boolean {
  const normalized = normalizeForProfanity(name);
  if (!normalized) return false;
  for (const word of PROFANITY_WORDS) {
    if (normalized.includes(word)) return true;
  }
  return false;
}

/**
 * Compare names case-insensitively after trimming. Two cats can't share a
 * name. Pass `selfId` so the modal doesn't flag the cat against its own
 * existing entry when renaming.
 */
export function isDuplicateName(
  name: string,
  existing: Array<{ id: string; name: string }>,
  selfId?: string,
): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return existing.some(
    (c) => c.id !== selfId && c.name.trim().toLowerCase() === needle,
  );
}

export interface NameValidationResult {
  ok: boolean;
  /** Error message to display, or empty when ok. */
  error: string;
}

export function validateCatName(
  name: string,
  existing: Array<{ id: string; name: string }>,
  selfId?: string,
): NameValidationResult {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Please enter a name.' };
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    return { ok: false, error: `You are at the max length (${NAME_MAX_LENGTH} characters).` };
  }
  if (containsProfanity(trimmed)) {
    return { ok: false, error: 'The name you have is inappropriate.' };
  }
  if (isDuplicateName(trimmed, existing, selfId)) {
    return { ok: false, error: 'No duplicate names. You already have a cat with this name.' };
  }
  return { ok: true, error: '' };
}
