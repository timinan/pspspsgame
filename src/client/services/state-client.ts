import type {
  BackgroundId,
  BoxId,
  CatBreed,
  Chart,
  CosmeticId,
  PlayerState,
  Rarity,
  SeatId,
  ThemeId,
} from '../../shared/state';

export interface PullResult {
  kind: 'cat' | 'cosmetic' | 'theme';
  itemId: CatBreed | CosmeticId | ThemeId;
  rarity: Rarity;
  duplicate: boolean;
  refundCoins: number;
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

export async function equipCosmetic(
  breed: CatBreed,
  cosmeticId: CosmeticId | null,
): Promise<EquipResult> {
  const r = await fetch('/api/cosmetic/equip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ breed, cosmeticId }),
  });
  return (await r.json()) as EquipResult;
}

export async function completeOnboarding(): Promise<PlayerState> {
  const r = await fetch('/api/onboarding/complete', { method: 'POST' });
  if (!r.ok) throw new Error(`completeOnboarding ${r.status}`);
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

export async function setSeat(seatId: SeatId, catId: CatBreed | null): Promise<PlayerState> {
  const r = await fetch('/api/house/seat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seatId, catId }),
  });
  if (!r.ok) throw new Error(`setSeat ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

export async function sellItem(kind: 'cosmetic', id: string): Promise<PlayerState> {
  const r = await fetch('/api/inventory/sell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, id }),
  });
  if (!r.ok) throw new Error(`sellItem ${r.status}`);
  const data = (await r.json()) as { state: PlayerState };
  return data.state;
}

export async function rehomeCat(catId: CatBreed): Promise<PlayerState> {
  const r = await fetch('/api/cats/rehome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catId }),
  });
  if (!r.ok) throw new Error(`rehomeCat ${r.status}`);
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
