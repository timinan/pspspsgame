# Rewards Scene + Shop Glow-Up — Design Spec

**Date:** 2026-07-02 · **Status:** approved in brainstorming with Tim · **Deadline context:** hackathon submission 2026-07-15 18:00 PDT.

Builds on the shipped economy (plan `2026-07-01-economy-wiring.md`, commits `fe000ee`..`24e08bd`). Four workstreams: (1) Rewards scene replacing the modal, (2) weekly quest engine, (3) achievements engine, (4) Merch shop visual overhaul — plus (5) economy tools-tab visualizer additions for Tim.

## 1. Rewards scene (replaces RewardsModal)

- New Phaser scene `Rewards` (`src/client/scenes/Rewards.ts`). Drawer REWARDS entry (`menu-items.ts` `openRewards`) does `scene.start('Rewards')` like Decorate/Merch. Back button returns to the invoking scene (pass `from` in init data, same pattern other scenes use — read before building).
- **Collect banner** pinned above the tabs on every tab: "💰 Your shows earned N coins while you were away — COLLECT" / grey 0-state. Reuses `collectRewards()` await-and-adopt unchanged.
- **Tabs: DAILY · WEEKLY · TROPHIES** (Tim approved "TROPHIES"). Tab chips follow the DressingRoom slot-tab pattern (crisp text factory, visible strokes, selected state).
- DAILY tab ports the existing modal content 1:1: 3 quest rows (progress, CLAIM/✓), all-3 Standard box chooser, 7-pip streak track with CLAIM + day-7 golden chooser. All claim plumbing (`claimQuest`, `claimQuestBonus`, `claimStreak`, `goldenGrantedDay` guard) reused as-is.
- `src/client/ui/rewards-modal.ts` is DELETED in the same commit that lands the scene; the render-check harness moves to `scripts/render-check/rewards-scene/`.

## 2. Weekly quest engine

- Launch set (locked): **15 plays** · **5 hard+ passes** (difficulty hard|insane AND accuracy ≥75) · **your shows hosted 25 plays**. Each pays **Golden box (of choice) + coins** — 100 / 150 / 150. **All 3 = Golden box + 500** (never Mythic, locked).
- **Week key = UTC ISO week, resets Monday 00:00 UTC** (= Sunday 5pm PDT; Tim approved). `isoWeekOf(date)` helper in `src/shared/quests.ts` (e.g. `2026-W27`).
- Schema: `economy.weekly { weekKey: string; progress: Record<WeeklyQuestId, number>; claimed: Record<WeeklyQuestId, boolean>; bonusClaimed: boolean }` (the golden box choice rides with the claim request, so no pending-choice field is needed). Rollover mirrors `rolloverEconomy` (`rolloverWeekly(p, weekKey)`), applied in `loadOrInit` next to the daily rollover.
- Progress hooks ride the existing route points: `/play` credit block (plays, hard-pass), owner-side host-plays counter in the same block where milestones already load the owner. One shared `recordWeeklyEvent(p, ev, weekKey)` in `quests.ts`.
- Claim routes mirror the daily ones: `POST /api/weekly/claim {questId, boxId}` (validates golden tier BEFORE mutating — same guard pattern as streak day-7), `POST /api/weekly/bonus {boxId}` (all 3 claimed, golden tier, +500 coins).

## 3. Achievements engine (TROPHIES)

- **Computed, not counted:** progress derives live from existing `PlayerStats` / state — no new event plumbing, retroactively accurate. Only claims persist: `economy.achievementsClaimed: Record<AchievementId, ('bronze'|'silver'|'gold')[]>` (list of claimed tiers).
- New pure module `src/shared/achievements.ts`: `ACHIEVEMENTS` defs + `achievementProgress(p: PlayerState, id): number` + `tierReached(value, def): Tier|null`.
- Launch set (10 × bronze/silver/gold; thresholds tunable in the defs table):

| ID | Name | Stat source | B / S / G |
|---|---|---|---|
| songs | Song Finisher | `stats.songsFinished` | 10 / 100 / 1000 |
| perfects | Perfectionist | `stats.totalPerfects` | 100 / 1,000 / 10,000 |
| cats | Cat Collector | `ownedCats.length` | 25 / 50 / 100 |
| streak | Streaker | `stats.longestDailyStreak` | 3 / 7 / 30 |
| crowd | Crowd Favorite | `stats.playsReceived` | 10 / 100 / 1000 |
| hopper | Show Hopper | `stats.playsOnOthers` | 10 / 100 / 1000 |
| combo | Combo Machine | `stats.longestCombo` | 50 / 150 / 500 |
| pockets | Deep Pockets | `stats.coinsEarnedLifetime` | 1k / 10k / 100k |
| boxes | Box Addict | Σ `stats.boxesOpened` | 5 / 25 / 100 |
| holds | Hold Steady | `stats.holdsCompleted` | 50 / 500 / 5000 |

- **Rewards per tier (locked):** bronze = 100 coins · silver = Golden box (of choice) · gold = **Mythic box (of choice)** — the only Mythic faucet besides direct purchase.
- **Tap-to-claim** (Tim approved): `POST /api/achievements/claim {achievementId, tier, boxId?}` — validates `achievementProgress ≥ threshold`, tier not already claimed, tiers claimable in any order but each once; boxId required + tier-validated for silver (golden) / gold (mythic) BEFORE mutating.
- TROPHIES tab UI: masked scroll list; each row = name, medal chips (🥉🥈🥇 filled when claimed, hollow when reached-unclaimed → CLAIM button, grey when unreached), progress bar (Graphics rounded fill) with exact label "14,203 / 20,000" toward the next unreached tier (bar full + "MAXED" at gold claimed).

## 4. Merch shop visual overhaul

- **12 generated pixel crate sprites** (4 categories × 3 tiers) via the asset-gen pipeline. Category motif on the lid: cat ears+tail (cats), bowtie (cosmetics), sparkle burst (effects), picture frame (backgrounds). Tier styling: plain wood+rope (Standard) · gilt trim+clasp (Golden) · deep-purple starfield+glow rim (Mythic). Discipline: locked spec extracted from one approved reference crate, vary only category motif + tier trim, full-res render + side-by-side pixel-check BEFORE registering (memory rule `feedback_asset_gen_discipline`). Frames land in the atlas via the existing extract pipeline.
- Card layout: crate art focal center (idle-bob tween ±2px), category label top, tier chips below art (tier-colored glow on selected; Mythic gets a slow shine-sweep tween), **odds as a color-segmented rarity bar** (common grey / uncommon green / rare blue / legendary gold, widths = rates) with the numbers on hover-tap, price + coin icon, gold BUY.
- Crates reuse in the box-open reveal and both golden/standard choosers (Rewards scene) — consistent treasure language.
- Coordination: crate asset files enter `assets-raw/` + `public/assets/` — the cat agent's churn territory. Generate + extract in a quiet window, clean-restart the watcher after (standing rule 1).

## 5. Economy tools tab — quests & trophies visualizer

Extend `tools/economy/index.html` (my artifact; other agents' tools WIP untouched) with a **Quests & Trophies** section:
- Today's daily rotation (same hash ported to the page's inline JS, date-picker to preview any day), streak track values, weekly set + reset countdown.
- Achievements table: all 10 defs, thresholds, tier rewards.
- Interactive what-if sliders for quest/weekly/achievement coin values + box tiers feeding the existing persona budget simulator (visualizer only — **source of truth stays `src/shared/economy.ts` / `quests.ts` / `achievements.ts`**; the tab documents + models, it does not configure the game).

## Data & constraints

- Schema additions (`src/shared/state.ts`): `economy.weekly`, `economy.achievementsClaimed`. Same three-level `loadOrInit` merge treatment. **Staging discipline:** state.ts is shared with parallel agents — diff-check before staging, stage by name.
- New/changed reward numbers live in `ECONOMY` (`src/shared/economy.ts`): weekly coin values, achievement tier rewards.
- Testing: vitest for `isoWeekOf`/weekly rollover/`recordWeeklyEvent`/`achievementProgress`/claim validation (pure modules); pixel-check (rule 9) for every scene tab state + shop states + each crate sprite vs reference.
- Build order within this pass: scene shell + daily port → weekly engine → achievements engine → shop art last (generation rounds need Tim's preview approval) → tools tab.

## Out of scope

Community quests, seasonal events, rarity re-bucket (still blocked on catalog agents), gifting, `/api/coins/sync` retirement (separate backlog item).
