# Meowcert Economy Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the locked economy design (`PM-OS/outputs/portfolio/meowcert/economy-design-2026-07-01.md`) into the game: credit play rewards, host collect pot, anti-farm valves, daily quests + login streak, and the new box SKU tiers.

**Architecture:** All economy math lives in a new pure shared module (`src/shared/economy.ts`) unit-tested with vitest. The server is authoritative: `/api/social/play` computes and credits rewards; new routes handle collect/quest/streak claims. Daily counters live inside `PlayerState.economy` (auto-rollover on UTC day change), reusing the existing redis-JSON persistence. Client only displays breakdowns returned by the server.

**Tech Stack:** TypeScript, Hono on Devvit runtime, `@devvit/web/server` redis, Phaser 4 client, vitest (node env, `tests/**/*.test.ts`).

## Global Constraints

- **Deadline:** hackathon submission 2026-07-15 18:00 PDT. Phases 0-3 are the core loop; Phase 4 (boxes) next; everything in "Deferred" is post-blocker or post-launch.
- **Parallel agents:** do NOT touch `tools/`, `public/assets/`, `assets-raw/`, `variants/`, `src/client/effects/`, DressingRoom/context-menu, or `cats-catalog.generated.ts` — other agents own those. `src/shared/state.ts` carries the effects agent's uncommitted 15-line catalog block (~line 199): **never `git add src/shared/state.ts` while that block is uncommitted** — hold the commit or stage after their commit lands.
- **Session-state rules apply to every commit:** `npm run build` before commit (rule 2), `git add <file>` by name (rule 8), one task per commit, Read every file before editing it (rule 4), pixel-verify UI changes via the render harness before claiming done (rule 9), dev-log grep before any "live" message (rule 1a).
- **Devvit redis quirks:** `incrBy` exists, `incr` does not; no MULTI/EXEC (sequential ops, last-write-wins accepted at this scale — same as `transferGift`).
- **Day boundary is UTC** (`new Date().toISOString().slice(0,10)`), matching the existing streak logic in `/api/stats/round` (`src/server/routes/state.ts:351-373`). UTC midnight = 5pm PDT.
- **Dev reset caveat:** `GET /api/state` wipes non-godmode state on every load (`DEV_RESET_ON_LOAD=true`, `state.ts:30`). Playtest persistence checks need a godmode account. Pre-launch checklist: flip `DEV_RESET_ON_LOAD` to `false`.
- **Locked numbers** (from the spec, verbatim): tiers pass≥75→100 / great≥85→200 / perfect≥95→300 / flawless≥99→400 / fail 25; combo bonus ≥25/50/100→+10/20/40; perfect-count bonus ≥20/50/100→+10/20/40; FULL COMBO +50, FULL PERFECT +100 (replaces FC), both need ≥30 judged notes; difficulty mult easy 1.0 / medium 1.25 / spicy 1.5 / hard 1.75 / insane 2.0; comment bonus +50 first comment per post ever; decay 100/50/25%; daily play budget 1200 then 10%; host royalty 25% capped 300/day; own-show plays pay 0; per-post milestones first play +50 / first pass +100 / 10 plays +100 / 50 plays +250 / 100 plays +500; starter coins 600; sell price 25; dupe bg refund 50.
- **Spec inconsistency, flagged to Tim:** spec says "best easy play = 530" but that assumes FULL COMBO; with FULL PERFECT the max is (400+180)×1.0 = **580** (the insane ceiling 1160 = (400+180)×2.0 already assumes FP). Tests use 580 until Tim says otherwise.

---

### Task 0: Design decisions embedded in this plan (Tim sign-off list)

No code. These choices are baked into the tasks below; veto before execution starts.

1. **Comment bonus is exempt from decay and the daily budget** and does not count toward `playIncome` — it's once per post ever, so it self-caps. Credited by `/api/social/comment`, not the play route.
2. **Fail-tier plays still earn skill bonuses**: formula is uniform `(base + bonuses) × mult`, fail base 25.
3. **Own-show plays**: 0 coins for everything (play reward, comment bonus, no royalty), but count `stats.playsOnOwnShow` and leaderboard as today.
4. **Decay keys on postId** ("same chart, same day" = same post's chart).
5. **Budget valve splits at the boundary**: coins under the 1200 line pay full, the remainder pays 10% (faithful reading of "first 1200 pay full").
6. **Quest rotation is deterministic from the UTC date** (hash picks 3 of 6) — no cron/scheduler needed, client and server independently compute the same 3 quests.
7. **Streak wraps**: day 7 claim → next day starts at 1. Missing a day resets to 1. Streak advances on first `/api/state` load of the day (login), claims via Rewards drawer.
8. **Play-reward idempotency via a client `playToken`** (random id per round) because `recordPlay` can fire twice (endRound + finalizePlay comment flow). Server credits once per token.
9. **Milestone + royalty coins land in the host's `pendingCollect` pot** (one COLLECT moment), not directly in coins.
10. **Box prices change** for existing SKUs (cat 150→400, cosmetic 80→200, bg 250→350, effects 80→200). Rarity **re-bucket stays deferred**; the "fall back to nearest non-empty tier" rule makes the new odds safe against today's skewed catalogs.

---

### Task 1: Shared economy constants + reward math (`src/shared/economy.ts`)

**Files:**
- Create: `src/shared/economy.ts`
- Test: `tests/economy.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `ECONOMY` const; `type Difficulty = 'easy'|'medium'|'spicy'|'hard'|'insane'`; `computePlayReward(input: PlayRewardInput): PlayRewardBreakdown`; `classifyTier(accuracyPct: number): { id: RewardTierId; base: number }`. Later tasks import all of these.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/economy.test.ts
import { describe, expect, it } from 'vitest';
import { computePlayReward, ECONOMY, type PlayRewardInput } from '../src/shared/economy';

const base: PlayRewardInput = {
  accuracyPct: 80, maxCombo: 10, perfects: 0, misses: 5, totalNotes: 50,
  difficulty: 'easy', isOwnShow: false, chartPlaysToday: 0, playIncomeToday: 0,
};

describe('computePlayReward', () => {
  it('classifies tier boundaries on plain accuracy', () => {
    expect(computePlayReward({ ...base, accuracyPct: 74.9 }).tierBase).toBe(25);
    expect(computePlayReward({ ...base, accuracyPct: 75 }).tierBase).toBe(100);
    expect(computePlayReward({ ...base, accuracyPct: 85 }).tierBase).toBe(200);
    expect(computePlayReward({ ...base, accuracyPct: 95 }).tierBase).toBe(300);
    expect(computePlayReward({ ...base, accuracyPct: 99 }).tierBase).toBe(400);
  });

  it('pays only the highest combo and perfect milestone', () => {
    const r = computePlayReward({ ...base, maxCombo: 120, perfects: 55, misses: 1 });
    expect(r.skillBonus).toBe(40 + 20); // combo ≥100 → 40, perfects ≥50 → 20
  });

  it('FULL PERFECT replaces FULL COMBO and caps skill at 180', () => {
    const fp = computePlayReward({ ...base, accuracyPct: 100, maxCombo: 100, perfects: 50, misses: 0, totalNotes: 50 });
    expect(fp.fullPerfect).toBe(true);
    expect(fp.fullCombo).toBe(false);
    expect(fp.skillBonus).toBe(40 + 20 + 100);
    const fc = computePlayReward({ ...base, maxCombo: 50, perfects: 10, misses: 0, totalNotes: 50 });
    expect(fc.fullCombo).toBe(true);
    expect(fc.skillBonus).toBe(20 + 0 + 50);
  });

  it('denies FC/FP on charts under 30 notes', () => {
    const r = computePlayReward({ ...base, misses: 0, totalNotes: 20, perfects: 20 });
    expect(r.fullCombo).toBe(false);
    expect(r.fullPerfect).toBe(false);
  });

  it('applies difficulty multiplier and ceilings', () => {
    const easyMax = computePlayReward({ ...base, accuracyPct: 100, maxCombo: 100, perfects: 100, misses: 0, totalNotes: 100 });
    expect(easyMax.final).toBe(580); // (400+180)×1.0 — see spec-inconsistency note
    const insaneMax = computePlayReward({ ...base, accuracyPct: 100, maxCombo: 100, perfects: 100, misses: 0, totalNotes: 100, difficulty: 'insane' });
    expect(insaneMax.final).toBe(1160);
  });

  it('decays repeat plays of the same chart 100/50/25', () => {
    expect(computePlayReward({ ...base, chartPlaysToday: 0 }).decayRate).toBe(1);
    expect(computePlayReward({ ...base, chartPlaysToday: 1 }).decayRate).toBe(0.5);
    expect(computePlayReward({ ...base, chartPlaysToday: 2 }).decayRate).toBe(0.25);
    expect(computePlayReward({ ...base, chartPlaysToday: 9 }).decayRate).toBe(0.25);
  });

  it('splits the daily budget valve at the 1200 line', () => {
    // reward would be 200; 100 of room left → 100 full + 100×10% = 110
    const r = computePlayReward({ ...base, accuracyPct: 85, maxCombo: 0, perfects: 0, playIncomeToday: 1100 });
    expect(r.final).toBe(110);
    expect(r.budgetReduced).toBe(true);
    const over = computePlayReward({ ...base, accuracyPct: 85, maxCombo: 0, perfects: 0, playIncomeToday: 1200 });
    expect(over.final).toBe(20);
  });

  it('pays zero on own-show plays but reports the breakdown', () => {
    const r = computePlayReward({ ...base, isOwnShow: true, accuracyPct: 95 });
    expect(r.final).toBe(0);
    expect(r.ownShow).toBe(true);
    expect(r.tierBase).toBe(300);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Documents/GitHub/meowcert && npx vitest run tests/economy.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/economy'`

- [ ] **Step 3: Write the module**

```ts
// src/shared/economy.ts
export type Difficulty = 'easy' | 'medium' | 'spicy' | 'hard' | 'insane';
export type RewardTierId = 'flawless' | 'perfect' | 'great' | 'pass' | 'fail';

export const ECONOMY = {
  tiers: [
    { id: 'flawless' as RewardTierId, minAccuracyPct: 99, base: 400 },
    { id: 'perfect' as RewardTierId, minAccuracyPct: 95, base: 300 },
    { id: 'great' as RewardTierId, minAccuracyPct: 85, base: 200 },
    { id: 'pass' as RewardTierId, minAccuracyPct: 75, base: 100 },
  ],
  failBase: 25,
  comboMilestones: [
    { min: 100, bonus: 40 },
    { min: 50, bonus: 20 },
    { min: 25, bonus: 10 },
  ],
  perfectMilestones: [
    { min: 100, bonus: 40 },
    { min: 50, bonus: 20 },
    { min: 20, bonus: 10 },
  ],
  fullComboBonus: 50,
  fullPerfectBonus: 100,
  fcMinNotes: 30,
  difficultyMult: { easy: 1.0, medium: 1.25, spicy: 1.5, hard: 1.75, insane: 2.0 } satisfies Record<Difficulty, number>,
  commentBonus: 50,
  chartDecay: [1, 0.5, 0.25],
  dailyPlayBudget: 1200,
  overBudgetRate: 0.1,
  hostRoyaltyRate: 0.25,
  hostPotDailyCap: 300,
  passAccuracyPct: 75,
  sellPrice: 25,
  postMilestones: {
    firstPlay: 50,
    firstPass: 100,
    playCounts: [
      { count: 10, coins: 100 },
      { count: 50, coins: 250 },
      { count: 100, coins: 500 },
    ],
  },
} as const;

export interface PlayRewardInput {
  accuracyPct: number; // plain accuracy, 0..100 (hits/judged)
  maxCombo: number;
  perfects: number;
  misses: number;
  totalNotes: number; // judged notes this round
  difficulty: Difficulty;
  isOwnShow: boolean;
  chartPlaysToday: number; // completed plays of this post's chart today, before this one
  playIncomeToday: number; // play coins credited today, before this one
}

export interface PlayRewardBreakdown {
  tier: RewardTierId;
  tierBase: number;
  skillBonus: number;
  fullCombo: boolean;
  fullPerfect: boolean;
  multiplier: number;
  decayRate: number;
  budgetReduced: boolean;
  ownShow: boolean;
  final: number;
}

export function classifyTier(accuracyPct: number): { id: RewardTierId; base: number } {
  for (const t of ECONOMY.tiers) {
    if (accuracyPct >= t.minAccuracyPct) return { id: t.id, base: t.base };
  }
  return { id: 'fail', base: ECONOMY.failBase };
}

function milestoneBonus(value: number, table: readonly { min: number; bonus: number }[]): number {
  for (const m of table) if (value >= m.min) return m.bonus;
  return 0;
}

export function computePlayReward(i: PlayRewardInput): PlayRewardBreakdown {
  const tier = classifyTier(i.accuracyPct);
  let skill = milestoneBonus(i.maxCombo, ECONOMY.comboMilestones) + milestoneBonus(i.perfects, ECONOMY.perfectMilestones);
  const eligible = i.totalNotes >= ECONOMY.fcMinNotes;
  const fullPerfect = eligible && i.misses === 0 && i.perfects >= i.totalNotes;
  const fullCombo = !fullPerfect && eligible && i.misses === 0;
  if (fullPerfect) skill += ECONOMY.fullPerfectBonus;
  else if (fullCombo) skill += ECONOMY.fullComboBonus;

  const multiplier = ECONOMY.difficultyMult[i.difficulty];
  const decayRate = ECONOMY.chartDecay[Math.min(i.chartPlaysToday, ECONOMY.chartDecay.length - 1)]!;
  const raw = Math.round((tier.base + skill) * multiplier * decayRate);

  const room = Math.max(0, ECONOMY.dailyPlayBudget - i.playIncomeToday);
  const fullPart = Math.min(raw, room);
  const overPart = raw - fullPart;
  const paid = fullPart + Math.round(overPart * ECONOMY.overBudgetRate);

  return {
    tier: tier.id,
    tierBase: tier.base,
    skillBonus: skill,
    fullCombo,
    fullPerfect,
    multiplier,
    decayRate,
    budgetReduced: overPart > 0,
    ownShow: i.isOwnShow,
    final: i.isOwnShow ? 0 : paid,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/economy.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/economy.ts tests/economy.test.ts
git commit -m "economy: shared constants + play reward math"
```

---

### Task 2: `PlayerState.economy` + rollover + `playsOnOwnShow` stat

**Files:**
- Modify: `src/shared/state.ts` (PlayerStats ~line 677, PlayerState ~line 769, `createFreshStats` ~731, `createFreshPlayerState` ~835)
- Modify: `src/server/core/player-state.ts:23-49` (`loadOrInit` merge)
- Test: `tests/economy-state.test.ts`, extend `tests/player-state.test.ts`

**⚠️ Staging constraint:** `state.ts` also holds the effects agent's uncommitted catalog block. Do NOT commit this task until their registration commit lands; keep the work in the tree and re-run tests after they land.

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface EconomyState { daily: EconomyDaily; pendingCollect: number; streak: EconomyStreak }` on `PlayerState.economy`; `createFreshEconomy(day: string): EconomyState`; `rolloverEconomy(p: PlayerState, isoToday: string): void`; `stats.playsOnOwnShow: number`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/economy-state.test.ts
import { describe, expect, it } from 'vitest';
import { createFreshEconomy, createFreshPlayerState, rolloverEconomy } from '../src/shared/state';

describe('economy state', () => {
  it('fresh player carries a zeroed economy block', () => {
    const p = createFreshPlayerState('tim');
    expect(p.economy.pendingCollect).toBe(0);
    expect(p.economy.daily.playIncome).toBe(0);
    expect(p.economy.streak.count).toBe(0);
    expect(p.stats.playsOnOwnShow).toBe(0);
  });

  it('rollover resets daily counters on a new day but keeps the pot', () => {
    const p = createFreshPlayerState('tim');
    p.economy.daily = { ...createFreshEconomy('2026-07-01').daily, playIncome: 900, chartPlays: { t3_abc: 2 } };
    p.economy.pendingCollect = 240;
    rolloverEconomy(p, '2026-07-02');
    expect(p.economy.daily.day).toBe('2026-07-02');
    expect(p.economy.daily.playIncome).toBe(0);
    expect(p.economy.daily.chartPlays).toEqual({});
    expect(p.economy.pendingCollect).toBe(240);
  });

  it('rollover is a no-op on the same day', () => {
    const p = createFreshPlayerState('tim');
    p.economy.daily.day = '2026-07-01';
    p.economy.daily.playIncome = 500;
    rolloverEconomy(p, '2026-07-01');
    expect(p.economy.daily.playIncome).toBe(500);
  });
});
```

Also extend `tests/player-state.test.ts` (read it first — follow its existing mock-redis pattern): a stored JSON blob **without** an `economy` key must come back from `loadOrInit` with the fresh economy block, and a stored blob with a partial `economy` (e.g. missing `streak`) must backfill the missing sub-shape.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/economy-state.test.ts`
Expected: FAIL — `createFreshEconomy` is not exported

- [ ] **Step 3: Implement**

In `src/shared/state.ts` — add near PlayerState (~line 765):

```ts
export interface EconomyDaily {
  day: string; // UTC ISO day these counters belong to
  playIncome: number;
  chartPlays: Record<string, number>;
  hostPotAccrued: number;
  questProgress: Record<string, number>;
  questClaimed: Record<string, boolean>;
  questBonusClaimed: boolean;
}

export interface EconomyStreak {
  lastDay: string;
  count: number; // 0 = never, cycles 1..7
  lastClaimedDay: string;
}

export interface EconomyState {
  daily: EconomyDaily;
  pendingCollect: number;
  streak: EconomyStreak;
}

export function createFreshEconomy(day = ''): EconomyState {
  return {
    daily: {
      day,
      playIncome: 0,
      chartPlays: {},
      hostPotAccrued: 0,
      questProgress: {},
      questClaimed: {},
      questBonusClaimed: false,
    },
    pendingCollect: 0,
    streak: { lastDay: '', count: 0, lastClaimedDay: '' },
  };
}

export function rolloverEconomy(p: PlayerState, isoToday: string): void {
  if (p.economy.daily.day !== isoToday) {
    p.economy.daily = createFreshEconomy(isoToday).daily;
  }
}
```

Then: add `economy: EconomyState;` to the `PlayerState` interface, `economy: createFreshEconomy(),` in `createFreshPlayerState`, and `playsOnOwnShow: 0,` in `createFreshStats` + `playsOnOwnShow: number;` in `PlayerStats` (next to `playsOnOthers`, ~line 677).

In `src/server/core/player-state.ts` `loadOrInit` (line ~37), mirror the stats deep-merge for economy:

```ts
const stats = { ...fresh.stats, ...(parsed.stats ?? createFreshStats()) };
const economy = parsed.economy
  ? {
      ...fresh.economy,
      ...parsed.economy,
      daily: { ...fresh.economy.daily, ...parsed.economy.daily },
      streak: { ...fresh.economy.streak, ...parsed.economy.streak },
    }
  : fresh.economy;
return { ...fresh, ...parsed, stats, economy };
```

(Import `createFreshEconomy` alongside `createFreshStats` if the file imports helpers individually — read the imports first.)

- [ ] **Step 4: Run the full suite** (state shape touches many tests)

Run: `npx vitest run`
Expected: PASS, including the extended `player-state.test.ts`

- [ ] **Step 5: Type-check + build (no commit yet — staging constraint)**

Run: `npm run type-check && npm run build`
Expected: clean. Commit deferred until the effects agent's `state.ts` block lands; then `git add src/shared/state.ts src/server/core/player-state.ts tests/economy-state.test.ts tests/player-state.test.ts && git commit -m "economy: player economy state + daily rollover"`.

---

### Task 3: Consolidate reward tables into `ECONOMY`

**Files:**
- Modify: `src/shared/social-loop.ts` (tiers at lines 27-42, `classifyScore` 49-63, `rewardWithComment` 66-68)
- Modify: `src/server/routes/state.ts:501` (SELL_PRICE), `src/server/routes/social.ts:88` + `src/server/core/social.ts:105` (hardcoded 0.75)
- Test: update `tests/social-loop.test.ts`

**Interfaces:**
- Consumes: `ECONOMY`, `classifyTier` from Task 1.
- Produces: `classifyScore` now returns the NEW tier values (great gate moves 0.75→0.85, perfect 0.90→0.95); `rewardWithComment` is deleted (callers move to the additive comment bonus); `SELL_PRICE` reads `ECONOMY.sellPrice`.

- [ ] **Step 1: Read `src/shared/social-loop.ts` and `tests/social-loop.test.ts` in full.** `classifyScore(accuracy, passed)` takes accuracy 0..1 — keep that signature, delegate to `classifyTier(accuracy * 100)`. Update `SCORE_TIER_THRESHOLDS` to re-export from `ECONOMY.tiers` (or delete if only `classifyScore` used it — grep callers first: `grep -rn "SCORE_TIER_THRESHOLDS\|rewardWithComment\|COMMENT_REWARD_MULTIPLIER" src tests`).
- [ ] **Step 2: Update `tests/social-loop.test.ts` expectations** to the new thresholds (85/95/99) and delete `rewardWithComment` tests. Run: `npx vitest run tests/social-loop.test.ts` — expect FAIL before the change, PASS after.
- [ ] **Step 3:** Replace `Game.ts:2596`'s `rewardWithComment(...)` call with plain `result.baseReward` for now (Task 5 replaces this whole block with the server-returned breakdown). Replace `SELL_PRICE = 25` with `ECONOMY.sellPrice` and the two hardcoded `0.75` with `ECONOMY.passAccuracyPct / 100`.
- [ ] **Step 4:** `npx vitest run && npm run type-check && npm run build` — all clean.
- [ ] **Step 5: Commit** (social-loop.ts, state.ts server route, core/social.ts, Game.ts, tests — name each file; the shared `state.ts` is NOT touched by this task):

```bash
git commit -m "economy: single source of truth for reward tables"
```

---

### Task 4: Server credit path in `/api/social/play`

**Files:**
- Create: `src/shared/economy-apply.ts` (pure credit logic)
- Modify: `src/server/routes/social.ts:73-298` (`POST /play`), `src/shared/social-loop.ts` types if `PlaySummary` lives there (grep `interface PlaySummary`)
- Test: `tests/economy-apply.test.ts`

**Interfaces:**
- Consumes: `computePlayReward`, `ECONOMY`, `rolloverEconomy`, `PlayerState`.
- Produces:

```ts
export interface PlayCreditResult { breakdown: PlayRewardBreakdown; royalty: number; }
export function applyPlayReward(
  visitor: PlayerState,
  owner: PlayerState | null, // null when owner state unavailable or own show
  input: Omit<PlayRewardInput, 'chartPlaysToday' | 'playIncomeToday'>,
  postId: string,
  isoToday: string,
): PlayCreditResult
```

The route also gains request fields `perfects: number`, `misses: number`, `difficulty: Difficulty`, `playToken: string`, and its response gains `breakdown: PlayRewardBreakdown` and `royalty: number`.

- [ ] **Step 1: Write failing tests** for `applyPlayReward` covering: visitor coins credited + `playIncome`/`chartPlays[postId]` incremented + `coinsEarnedLifetime`; second play same post same day gets decayed; own show → 0 coins, `stats.playsOnOwnShow` incremented, no royalty; royalty = `floor(final × 0.25)` credited to `owner.economy.pendingCollect` and capped so `hostPotAccrued` never exceeds 300 (test the cap boundary: accrued 290, royalty would be 25 → only 10 lands); rollover fires for both parties when the stored day is stale.

```ts
// tests/economy-apply.test.ts — core shape (write all cases listed above)
import { describe, expect, it } from 'vitest';
import { createFreshPlayerState } from '../src/shared/state';
import { applyPlayReward } from '../src/shared/economy-apply';

const input = {
  accuracyPct: 85, maxCombo: 10, perfects: 5, misses: 3, totalNotes: 40,
  difficulty: 'medium' as const, isOwnShow: false,
};

it('credits visitor and accrues capped royalty to the owner pot', () => {
  const visitor = createFreshPlayerState('vic');
  const owner = createFreshPlayerState('host');
  const { breakdown, royalty } = applyPlayReward(visitor, owner, input, 't3_x', '2026-07-01');
  expect(breakdown.final).toBe(250); // 200 × 1.25
  expect(visitor.coins).toBe(600 + 250);
  expect(visitor.economy.daily.playIncome).toBe(250);
  expect(visitor.economy.daily.chartPlays['t3_x']).toBe(1);
  expect(royalty).toBe(62); // floor(250 × 0.25)
  expect(owner.economy.pendingCollect).toBe(62);
  expect(owner.economy.daily.hostPotAccrued).toBe(62);
});
```

- [ ] **Step 2:** `npx vitest run tests/economy-apply.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement `src/shared/economy-apply.ts`:**

```ts
import { ECONOMY, computePlayReward, type PlayRewardBreakdown, type PlayRewardInput } from './economy';
import { rolloverEconomy, type PlayerState } from './state';

export interface PlayCreditResult {
  breakdown: PlayRewardBreakdown;
  royalty: number;
}

export function applyPlayReward(
  visitor: PlayerState,
  owner: PlayerState | null,
  input: Omit<PlayRewardInput, 'chartPlaysToday' | 'playIncomeToday'>,
  postId: string,
  isoToday: string,
): PlayCreditResult {
  rolloverEconomy(visitor, isoToday);
  const daily = visitor.economy.daily;
  const breakdown = computePlayReward({
    ...input,
    chartPlaysToday: daily.chartPlays[postId] ?? 0,
    playIncomeToday: daily.playIncome,
  });
  daily.chartPlays[postId] = (daily.chartPlays[postId] ?? 0) + 1;

  if (input.isOwnShow) {
    visitor.stats.playsOnOwnShow += 1;
    return { breakdown, royalty: 0 };
  }

  visitor.coins += breakdown.final;
  visitor.stats.coinsEarnedLifetime += breakdown.final;
  daily.playIncome += breakdown.final;

  let royalty = 0;
  if (owner && breakdown.final > 0) {
    rolloverEconomy(owner, isoToday);
    const room = Math.max(0, ECONOMY.hostPotDailyCap - owner.economy.daily.hostPotAccrued);
    royalty = Math.min(Math.floor(breakdown.final * ECONOMY.hostRoyaltyRate), room);
    owner.economy.pendingCollect += royalty;
    owner.economy.daily.hostPotAccrued += royalty;
  }
  return { breakdown, royalty };
}
```

- [ ] **Step 4:** Tests pass: `npx vitest run tests/economy-apply.test.ts`.
- [ ] **Step 5: Wire the route.** Read `src/server/routes/social.ts:73-298` in full first. Inside `POST /play` after the existing leaderboard/score handling and before the response:
  1. Parse the new body fields; reject if `playToken` missing (`400`).
  2. Idempotency: `const tokenKey = 'meowcert:reward-token:' + body.playToken;` — copy the `setFirstPasserIfUnset` set-if-unset pattern from `core/social.ts:174-182`. If the token was already consumed, skip crediting and return the stored breakdown shape with `alreadyCredited: true` (store `JSON.stringify(result)` as the token value so the repeat response is identical).
  3. `const isoToday = new Date().toISOString().slice(0,10);` then `loadOrInit` visitor (and owner when `visitor !== owner`), call `applyPlayReward`, `save()` both (owner first, visitor last — visitor response reflects final state).
  4. Include `breakdown` + `royalty` in the JSON response.
- [ ] **Step 6:** `npx vitest run && npm run type-check && npm run build` — clean. Commit `src/shared/economy-apply.ts tests/economy-apply.test.ts src/server/routes/social.ts` — **not** `src/shared/state.ts` — `"economy: credit play rewards + host royalty server-side"`.

---

### Task 5: Client thread-through + summary coin line

**Files:**
- Modify: `src/client/scenes/Game.ts` — `buildPlaySummary()` (2540-2571), `recordPlay` (2578-2604), `endRound` (2127-2209), `buildSummaryOverlay()` (~1077 area), `showSummary()` (2247-2318)
- Modify: `src/client/services/social-client.ts` (`submitPlay` payload + response types)
- Test: extend the fetch-mocked pattern in `tests/state-client.test.ts` for the new payload fields

**Interfaces:**
- Consumes: `PlayRewardBreakdown` (shared), server response from Task 4.
- Produces: summary UI shows `+N coins` with modifier chips; `PlaySummary` gains `perfects`, `misses`, `difficulty`, `playToken`.

- [ ] **Step 1: Read `Game.ts` regions above + `social-client.ts` in full.** Confirm how `recordPlay`/`finalizePlay` interact with `playSubmitted` (does the comment flow re-call the route?). The `playToken` design tolerates both answers.
- [ ] **Step 2: Thread the data.** In `buildPlaySummary()` add: `perfects: this.score.getPerfects()`, `misses: this.score.getJudged() - this.score.getLanded()`, `difficulty: this.playChart?.difficulty ?? 'easy'`, and `playToken: this.playToken` where `this.playToken` is minted once per round in the same place the round starts (grep where `playSubmitted` resets to false): `this.playToken = 'pt_' + Math.random().toString(36).slice(2) + Date.now().toString(36);`
- [ ] **Step 3: Replace the log-only block** at `recordPlay` 2593-2598: store `this.lastRewardBreakdown = result.breakdown` and call the new summary update instead of `console.info`.
- [ ] **Step 4: Summary UI.** In `buildSummaryOverlay()` add a `summaryCoinsText` text object in the stripe below the BEST row (same slot/pattern as `summaryGateText`, `Game.ts:1077` + `showSummary` 2290-2294). In `showSummary()` render from the breakdown:
  - normal: `+275 COINS` (green)
  - decayed/budget: `+110 COINS · REDUCED (daily limit)` / `· REPLAY ×0.5` (amber)
  - own show: `YOUR OWN SHOW · NO COINS` (grey)
  Menu-text rules apply: text within bounds, factory crisp-text patch, don't crowd the stripe.
- [ ] **Step 5: Verify per rule 9.** `npm run build`, then render the summary via the harness: `STEP=<summary-reachable-step> node scripts/render-check/screenshot-tutorial.mjs` — if the tutorial harness can't reach a visitor-mode summary, extend the fx-scan harness pattern (`scripts/render-check/fx-scan/`) to mount Game with a mock `/api/social/play` response carrying a breakdown, screenshot, and **Read the PNG**. All three chip states.
- [ ] **Step 6:** `npx vitest run && npm run type-check && npm run build` — clean. Commit by name: `"economy: summary shows the coin reward + valve chips"`.

---

### Task 6: First-comment bonus in `/api/social/comment`

**Files:**
- Modify: `src/server/routes/social.ts:324-343` (`POST /comment`)
- Modify: `src/client/scenes/Game.ts` page-3 handler (1188-1236 area) to show `+50 COINS` when the response says so

**Interfaces:**
- Consumes: `ECONOMY.commentBonus`, set-if-unset pattern.
- Produces: `/api/social/comment` response gains `commentBonus: number` (0 or 50).

- [ ] **Step 1: Read the route.** After the Reddit comment posts successfully: skip entirely when commenter === post owner. Otherwise set-if-unset on `` `meowcert:commented:${postId}:${username}` ``; if fresh, `loadOrInit` the commenter, `rolloverEconomy`, `coins += ECONOMY.commentBonus`, `stats.coinsEarnedLifetime += ECONOMY.commentBonus` (comment bonus does NOT touch `playIncome` — decision 1), `save`, respond `commentBonus: 50`, else `0`.
- [ ] **Step 2: Client:** in the POST handler after `submitComment` resolves, append `+50 COINS` to the page-3 confirmation text when `commentBonus > 0`.
- [ ] **Step 3:** Harness-render page 3 both ways, Read the PNGs. `npm run build`. Commit: `"economy: first-comment-per-post +50"`.

---

### Task 7: Per-post milestones → host pot

**Files:**
- Create: `src/shared/post-milestones.ts`
- Modify: `src/server/routes/social.ts` `POST /play` (after Task 4's credit block)
- Test: `tests/post-milestones.test.ts`

**Interfaces:**
- Consumes: `ECONOMY.postMilestones`; redis `incrBy` + `hGet/hSet` via `SocialRedis` (`core/social.ts:28-53`).
- Produces: `milestonesEarned(prevPlays: number, newPlays: number, firstPass: boolean): { coins: number; labels: string[] }` (pure), plus route wiring that credits `owner.economy.pendingCollect`.

- [ ] **Step 1: Failing tests** for the pure function: crossing 1 play → 50 (`firstPlay`); `firstPass` true → +100; crossing 10/50/100 → 100/250/500; crossing two thresholds in one play (prev 9 → new 10 with first pass) sums; no double-pay when prev ≥ threshold.

```ts
export function milestonesEarned(prevPlays: number, newPlays: number, firstPass: boolean): { coins: number; labels: string[] } {
  let coins = 0;
  const labels: string[] = [];
  if (prevPlays < 1 && newPlays >= 1) { coins += ECONOMY.postMilestones.firstPlay; labels.push('first play'); }
  if (firstPass) { coins += ECONOMY.postMilestones.firstPass; labels.push('first pass'); }
  for (const m of ECONOMY.postMilestones.playCounts) {
    if (prevPlays < m.count && newPlays >= m.count) { coins += m.coins; labels.push(`${m.count} plays`); }
  }
  return { coins, labels };
}
```

- [ ] **Step 2: Route wiring:** in `POST /play` (visitor ≠ owner only): `const newPlays = await redis.incrBy('meowcert:post-plays:' + postId, 1);` — first pass detection reuses the existing `FIRST_PASSER_KEY`/`setFirstPasserIfUnset` result already computed in this route (read it; if the route already knows "this play set the first passer", reuse that boolean). Credit `owner.economy.pendingCollect += coins` (milestones bypass the 300/day royalty cap — they're one-time). Save owner (fold into Task 4's owner save — one load, one save).
- [ ] **Step 3:** `npx vitest run && npm run build`. Commit: `"economy: per-post milestones feed the host pot"`.

---

### Task 8: Collect route + Rewards drawer (COLLECT surface)

**Files:**
- Modify: `src/server/routes/state.ts` (new handler next to `/api/coins/sync` at :83)
- Create: `src/client/ui/rewards-modal.ts`
- Modify: `src/client/ui/menu-items.ts:33-34, 89-93` (swap `RewardsComingSoonModal` → `RewardsModal`)
- Modify: `src/client/services/state-client.ts` (add `collectRewards()`)
- Delete (same commit): `src/client/ui/rewards-coming-soon-modal.ts`

**Interfaces:**
- Consumes: `PlayerState.economy.pendingCollect`, `coinsFromShow` stat.
- Produces: `POST /api/rewards/collect` → `{ ok: true, collected: number, playerState: PlayerState }`; `RewardsModal.open()` (mirrors `InboxModal.open()` at `src/client/ui/inbox-modal.ts:28`).

- [ ] **Step 1: Route:** `loadOrInit`, `rolloverEconomy`, `const amount = player.economy.pendingCollect;` → `player.coins += amount; player.stats.coinsFromShow += amount; player.stats.coinsEarnedLifetime += amount; player.economy.pendingCollect = 0;` save, respond. (This finally gives `coinsFromShow` its writer.)
- [ ] **Step 2: Modal.** Read `src/client/ui/inbox-modal.ts` in full first and copy its container/scroll/close structure exactly (rule: match the existing render pattern). v1 sections: (a) collect pot — "💰 Your shows earned 240 coins while you were away" + COLLECT button (disabled at 0); (b) placeholder rows for streak + quests (filled by Task 10). COLLECT calls `collectRewards()`, adopts the returned playerState (the H3/H4 await-and-adopt pattern), plays the coin count-up.
- [ ] **Step 3: Wire the drawer:** `menu-items.ts` `openRewards` now instantiates `RewardsModal`. Delete the ComingSoon modal file and its import.
- [ ] **Step 4: Verify per rule 9:** harness screenshot of the modal at 0-pot and 240-pot states, Read both PNGs. `npm run build`. Commit: `"economy: collect pot + rewards drawer v1"`.

---

### Task 9: Quest + streak shared module

**Files:**
- Create: `src/shared/quests.ts`
- Test: `tests/quests.test.ts`

**Interfaces:**
- Consumes: `EconomyDaily.questProgress/questClaimed`, `EconomyStreak`.
- Produces:

```ts
export type DailyQuestId = 'play3' | 'post1' | 'combo20' | 'comment1' | 'hardplay1' | 'openbox1';
export interface DailyQuest { id: DailyQuestId; label: string; target: number; coins: number; }
export const DAILY_QUEST_POOL: DailyQuest[]; // 6 entries below
export function dailyQuestsFor(isoDay: string): DailyQuest[]; // deterministic 3-of-6
export type QuestEvent = { kind: 'play'; maxCombo: number; difficulty: Difficulty } | { kind: 'post' } | { kind: 'comment' } | { kind: 'openbox' };
export function recordQuestEvent(p: PlayerState, ev: QuestEvent, isoToday: string): void;
export const STREAK_TRACK: number[]; // [25, 40, 55, 70, 85, 100, 100] — day 7 also grants a Golden box
export function touchLoginStreak(p: PlayerState, isoToday: string): void; // advance/reset on first load of the day
```

Pool: `play3` "Play 3 shows" target 3 / 75c · `post1` "Post a show" 1 / 50c · `combo20` "Hit a 20-combo" 1 / 50c · `comment1` "Comment on a show" 1 / 50c · `hardplay1` "Play a hard or insane chart" 1 / 100c · `openbox1` "Open a box" 1 / 50c.

- [ ] **Step 1: Failing tests:** `dailyQuestsFor` returns exactly 3 distinct quests, same 3 for the same day string, different sets across a 10-day span (at least 2 distinct sets); `recordQuestEvent` maps events → progress (one `play` event increments `play3`, sets `combo20` when `maxCombo >= 20`, sets `hardplay1` when difficulty is hard/insane) and ignores quests not active today; progress clamps at target; `touchLoginStreak`: fresh → 1, consecutive day → 2, gap day → back to 1, day 8 after full week → wraps to 1, same-day repeat call → no-op.
- [ ] **Step 2: Implement.** Rotation: `const h = [...isoDay].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 7);` then pick 3 by repeated `splice(Math.abs(h + i * 31) % pool.length, 1)`. `recordQuestEvent`: `rolloverEconomy` first, then for each active quest matching the event kind and not claimed, `questProgress[id] = Math.min(target, (questProgress[id] ?? 0) + inc)`. `touchLoginStreak`: `rolloverEconomy`, if `streak.lastDay === isoToday` return; `streak.count = (streak.lastDay === yesterdayOf(isoToday) && streak.count < 7) ? streak.count + 1 : 1; streak.lastDay = isoToday;` with `yesterdayOf(d)` = `new Date(Date.parse(d) - 86400000).toISOString().slice(0,10)`.
- [ ] **Step 3:** `npx vitest run tests/quests.test.ts` PASS. Commit: `"economy: daily quest pool + login streak logic"`.

---

### Task 10: Quest/streak server hooks + claim routes + drawer UI

**Files:**
- Modify: `src/server/routes/state.ts` (`GET /api/state` streak touch; new `POST /api/quests/claim`, `POST /api/quests/bonus`, `POST /api/streak/claim`; `POST /api/box/open` → `recordQuestEvent(openbox)`)
- Modify: `src/server/routes/social.ts` (`/play` → `recordQuestEvent(play)`, `/comment` → `recordQuestEvent(comment)`)
- Modify: `src/server/routes/publish.ts` (→ `recordQuestEvent(post)` — read the file to find the post-success point)
- Modify: `src/client/ui/rewards-modal.ts` (streak track + quest rows + claim buttons), `src/client/services/state-client.ts` (claim calls)
- Test: extend `tests/quests.test.ts` for claim validation helpers if extracted; route logic stays thin

**Interfaces:**
- Consumes: everything from Task 9; `core/box-pull.ts` (read it first for the pull signature — the all-3 bonus and streak day-7 grant a free box through the same pull path the paid route uses).
- Produces: `POST /api/quests/claim {questId}` → validates progress ≥ target && !claimed, credits quest coins, marks claimed. `POST /api/quests/bonus {boxId}` → all 3 claimed && !questBonusClaimed && boxId is a Standard-tier box → free pull, marks `questBonusClaimed`. `POST /api/streak/claim` → `lastClaimedDay !== today && streak.lastDay === today` → credits `STREAK_TRACK[count-1]`; when `count === 7` the response includes `goldenBoxDue: true` and the client immediately routes into a Golden-tier box chooser (needs Task 11's SKUs — gate this branch behind the Golden SKUs existing; until then day 7 pays coins only with a `TODO(golden)` marker that Task 11 removes).
- [ ] **Step 1:** wire hooks server-side (each is 1-3 lines calling `recordQuestEvent` before `save()` in an already-loaded state). The `/play` hook fires for visitor-mode plays including own-show (playing is playing); `post1` fires once (quest progress clamps).
- [ ] **Step 2:** claim routes + client calls; UI: streak = 7 pips with today highlighted + CLAIM; quests = 3 rows (label, progress `2/3`, CLAIM or ✓); all-3 bonus row opens the Standard box chooser.
- [ ] **Step 3: Verify per rule 9:** harness screenshots — quests mid-progress, all-claimed, streak claimable day 3, day 7. Read the PNGs. `npm run build`. Commit: `"economy: daily quests + login streak live in rewards drawer"`.

---

### Task 11: Box SKU tiers + legendary fix (⚠️ `state.ts` staging constraint applies)

**Files:**
- Modify: `src/shared/state.ts:326-374` (`BOX_CATALOG`, `BoxId`), `src/server/core/box-pull.ts` (tier fallback), `src/server/routes/state.ts:56-78` (`/box/open` — price/id validation only if hardcoded)
- Test: extend `tests/box-pull.test.ts`

**Interfaces:**
- Consumes: existing `BoxCatalogEntry` shape (read `state.ts:326-374` first), `boxesOpened: Partial<Record<BoxId, number>>` (already Partial — new ids safe).
- Produces: 12 SKUs — existing 4 ids become Standard tier with new prices (catBox 400, cosmeticBox 200, backgroundBox 350, effectsBox 200) and rates `{common:60, uncommon:30, rare:9, legendary:1}`; new `<id>Golden` (cat 1200, cosmetic 600, bg 1000, effects 600; rates 0/60/32/8) and `<id>Mythic` (all 2000; rates 0/0/70/30). Every entry gains `tier: 'standard'|'golden'|'mythic'` and `category: 'cat'|'cosmetic'|'background'|'effect'`.

- [ ] **Step 1: Read `core/box-pull.ts` + `tests/box-pull.test.ts` in full.** Confirm how a rolled rarity with an empty/exhausted pool behaves today.
- [ ] **Step 2: Failing tests:** rates sum to 100 for all 12; legendary is now reachable (seeded-roll test per existing test idiom); empty-pool fallback walks to the nearest non-empty rarity (spec rule) — e.g. Mythic background roll hits `legendary` with both bg legendaries owned → falls back to `rare`.
- [ ] **Step 3: Implement** catalog + fallback. Fallback order: try rolled rarity, then step outward by distance in `[common, uncommon, rare, legendary]` preferring the rarer side on ties.
- [ ] **Step 4:** un-gate Task 10's day-7 Golden branch (remove the `TODO(golden)`).
- [ ] **Step 5:** `npx vitest run && npm run build`. Commit **only after the effects agent's `state.ts` block has landed**; stage each file by name. `"economy: box tiers standard/golden/mythic + legendary fix"`.

---

### Task 12: Purchase scene — un-gate, effects box, tier selector

**Files:**
- Modify: `src/client/scenes/Purchase.ts` (read it in full first — find the COMING SOON gate and the shop grid)

**Interfaces:**
- Consumes: Task 11's 12-SKU catalog (`tier`/`category` fields drive the UI).
- Produces: 4 category cards (COSMETICS · EFFECTS · CATS · BACKGROUNDS), each with a Standard/Golden/Mythic selector, price + odds line, BUY → existing `/api/box/open` flow.

- [ ] **Step 1:** Read the scene; remove the COMING SOON gate; grid = 4 cards; selector = 3 chips per card (menu-text rules: within bounds, crisp, visible cell strokes per the cell-border rule).
- [ ] **Step 2: Verify per rule 9:** harness screenshot of the shop on all three tier selections, Read the PNGs, confirm prices/odds text matches `ECONOMY`/`BOX_CATALOG`.
- [ ] **Step 3:** `npm run build`. Commit: `"economy: shop live — 4 categories × 3 tiers"`.

---

## Deferred (explicitly out of this plan)

- **Rarity re-bucket** (50/30/15/5 per category) — blocked on the effects agent's 440-effect registration and the cat agent's new breeds; it edits their files. The Economy tab tracker (`tools/economy/`) already measures progress.
- **Weekly quests, achievements, community quests, seasonal events** — post-launch per Tim's locked build order.
- **Economy tab ↔ runtime number sync** (generate the tab's `ECONOMY` JS block from `src/shared/economy.ts`) — nice-to-have after numbers settle.
- **Inbox drawer entry** — the built-but-unwired `InboxModal`; separate UX decision.
- **Pre-launch checklist:** flip `DEV_RESET_ON_LOAD` to `false` (`src/server/routes/state.ts:30`), confirm `DEV_STARTER_COINS` 5000 → `STARTER_COINS` 600.

## Execution order & commit safety

Tasks 1 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 are the core loop (Task 2's code lands early but its **commit** waits for the effects agent). 11 → 12 follow. Tasks 1, 3-10 never stage `src/shared/state.ts`; Tasks 2 and 11 do and are the only two commits gated on the other agent.
