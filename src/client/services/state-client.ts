import type {
  BackgroundId,
  BoxId,
  Chart,
  PlayerState,
  Rarity,
  SeatId,
  ThemeId,
} from '../../shared/state';
import type { TutorialStepId } from '../../shared/tutorial-types';

export interface PullResult {
  kind: 'cat' | 'cosmetic' | 'background';
  itemId: string;
  rarity: Rarity;
  duplicate: boolean;
  refundCoins: number;
  /** Present for cat + cosmetic pulls — the new instance id. */
  instanceId?: string;
}

export type BoxOpenResult =
  | { ok: true; pull: PullResult; state: PlayerState }
  | { ok: false; reason: string };

export type EquipResult =
  | { ok: true; state: PlayerState }
  | { ok: false; reason: string };

export async function fetchState(): Promise<PlayerState> {
  const r = await fetch('/api/state');
  if (!r.ok) throw new Error(`fetchState ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

export async function openBox(boxId: BoxId): Promise<BoxOpenResult> {
  const r = await fetch('/api/box/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ boxId }),
  });
  return (await r.json()) as BoxOpenResult;
}

export async function syncCoins(
  coinsDelta: number,
  bestScore?: number,
): Promise<PlayerState> {
  const r = await fetch('/api/coins/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ coinsDelta, bestScore }),
  });
  if (!r.ok) throw new Error(`syncCoins ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

/** Claim the host COLLECT pot (economy.pendingCollect). Server folds
 *  it into coins + coinsFromShow, zeroes the pot, and returns the fresh
 *  state. Await-and-adopt: the caller replaces its playerState with
 *  `state` wholesale — no optimistic local mutation. */
export async function collectRewards(): Promise<{ collected: number; state: PlayerState }> {
  const r = await fetch('/api/rewards/collect', { method: 'POST' });
  if (!r.ok) throw new Error(`collectRewards ${r.status}`);
  return (await r.json()) as { ok: true; collected: number; state: PlayerState };
}

export type ClaimQuestResult =
  | { ok: true; claimed: number; state: PlayerState }
  | { ok: false; reason: string };

/** Claim a single daily quest's coin reward. Server validates progress
 *  and claim state; on success returns the fresh state (await-and-adopt).
 *  A 400 (incomplete / already claimed / not active) resolves to
 *  { ok: false, reason } rather than throwing. */
export async function claimQuest(questId: string): Promise<ClaimQuestResult> {
  const r = await fetch('/api/quests/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questId }),
  });
  return (await r.json()) as ClaimQuestResult;
}

export type ClaimBonusResult =
  | { ok: true; pull: PullResult; state: PlayerState }
  | { ok: false; reason: string };

/** Claim the all-3-quests bonus: a free box pull of the chosen standard
 *  box (cat / cosmetic / background / effects). Server validates that
 *  all three of today's quests are claimed and the bonus is unclaimed. */
export async function claimQuestBonus(boxId: BoxId): Promise<ClaimBonusResult> {
  const r = await fetch('/api/quests/bonus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ boxId }),
  });
  return (await r.json()) as ClaimBonusResult;
}

export type ClaimStreakResult =
  | { ok: true; claimed: number; goldenBoxDue?: boolean; goldenPull?: PullResult; state: PlayerState }
  | { ok: false; reason: string };

/** Claim today's login-streak reward.
 *  On day 7, pass a golden-tier `boxId` to receive the free golden box pull
 *  in the same request (server returns `goldenPull`). If no boxId is sent on
 *  day 7, the server still awards coins and returns `goldenBoxDue: true` so
 *  the client can re-ask after the player picks a box. */
export async function claimStreak(boxId?: BoxId): Promise<ClaimStreakResult> {
  const r = await fetch('/api/streak/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(boxId ? { boxId } : {}),
  });
  return (await r.json()) as ClaimStreakResult;
}

/**
 * Equip a cosmetic instance on a cat instance.
 * Pass cosmeticInstanceId=null to clear the slot (cosmetic returns to inventory).
 */
export async function equipCosmetic(
  catInstanceId: string,
  slot: string,
  cosmeticInstanceId: string | null,
): Promise<EquipResult> {
  const r = await fetch('/api/cosmetic/equip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catInstanceId, slot, cosmeticInstanceId }),
  });
  return (await r.json()) as EquipResult;
}

export async function completeOnboarding(): Promise<PlayerState> {
  const r = await fetch('/api/onboarding/complete', { method: 'POST' });
  if (!r.ok) throw new Error(`completeOnboarding ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

/** Persist the tutorial-resume index. Call with the new step on every
 *  orchestrator advance. Call with null when the tutorial completes or
 *  the player skips (alongside completeOnboarding). */
export async function setTutorialStep(step: TutorialStepId | null): Promise<PlayerState> {
  const r = await fetch('/api/tutorial-step', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step }),
  });
  if (!r.ok) throw new Error(`setTutorialStep ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

/** Persist the tutorial pick-cat selection: seats the picked breed in
 *  seat-center (creating the instance if needed) and clears the other
 *  seats so the lone starter cat is the only one on stage. */
export async function seedStarterCat(breed: string): Promise<PlayerState> {
  const r = await fetch('/api/tutorial/seed-starter-cat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ breed }),
  });
  if (!r.ok) throw new Error(`seedStarterCat ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

export async function setTheme(themeId: ThemeId): Promise<PlayerState> {
  const r = await fetch('/api/house/theme', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeId }),
  });
  if (!r.ok) throw new Error(`setTheme ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

/** Seat a cat instance at a seat. Pass catInstanceId=null to unseat. */
export async function setSeat(seatId: SeatId, catInstanceId: string | null): Promise<PlayerState> {
  const r = await fetch('/api/house/seat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seatId, catInstanceId }),
  });
  if (!r.ok) throw new Error(`setSeat ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

/** Sell a cosmetic instance from inventory. */
export async function sellItem(kind: 'cosmetic', cosmeticInstanceId: string): Promise<PlayerState> {
  const r = await fetch('/api/inventory/sell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, cosmeticInstanceId }),
  });
  if (!r.ok) throw new Error(`sellItem ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

/** Remove a cat instance from the player's ownership. */
export async function rehomeCat(catInstanceId: string): Promise<PlayerState> {
  const r = await fetch('/api/cats/rehome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catInstanceId }),
  });
  if (!r.ok) throw new Error(`rehomeCat ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

/** Rename a cat instance. */
export async function renameCat(catInstanceId: string, name: string): Promise<PlayerState> {
  const r = await fetch('/api/cats/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catInstanceId, name }),
  });
  if (!r.ok) throw new Error(`renameCat ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

export async function saveChart(chart: Chart): Promise<void> {
  const r = await fetch('/api/chart/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chart),
  });
  if (!r.ok) throw new Error(`saveChart ${r.status}`);
}

export async function loadChart(authorId: string): Promise<Chart> {
  const r = await fetch(`/api/chart?author=${encodeURIComponent(authorId)}`);
  if (!r.ok) throw new Error(`loadChart ${r.status}`);
  return (await r.json()) as Chart;
}

export async function setBackground(backgroundId: BackgroundId): Promise<PlayerState> {
  const r = await fetch('/api/background/set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backgroundId }),
  });
  if (!r.ok) throw new Error(`setBackground ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}
