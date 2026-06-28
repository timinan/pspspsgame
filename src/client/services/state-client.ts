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
