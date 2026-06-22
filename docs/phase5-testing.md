# Phase 5 Core Loop Testing Plan

Living tracker for end-to-end testing of the Phase 5 redesign. Each flow gets tested in order; don't mix flows. Updated as we go.

**Branch:** `phase5-vertical-gameplay`
**Playtest URL:** https://www.reddit.com/r/pspspsgame_dev/?playtest=pspspsgame
**Spec:** `/Users/timnan/Documents/GitHub/PM-OS/outputs/prds/2026-06-21-pspsps-phase5-spec.md`

---

## Flow status overview

| Flow | Status | Commits | Notes |
|---|---|---|---|
| 0 — Hamburger nav + asset visuals | ✅ GREEN | `ff38071`, `3ec30dd`, `ffcbaf4` | Confirmed in playtest |
| 1 — Purchase (boxes → inventory) | ✅ GREEN (in passing) | `f5e5578` | Box reveals work, debug panel shows inventory deltas; cleared as a side-effect of Flow 2 testing |
| 2 — Decorate + DressingRoom + Effects | ✅ GREEN | `f5e5578` → `e964f65` | Per-instance cats + cosmetics, validated naming, multi-slot dressing room, 16 effect cosmetics, seat→lane mapping fix |
| 3 — Play (random fallback chart) | ✅ GREEN | `7e1bc00` → `edd40c7` | Position-based hit/miss, multi-touch doubles, 16fps reactions, off-screen fall, effect reveal fix — random chart limits round depth so closing out and moving to Flow 4 for real-song playtest |
| 4 — Editor (author chart) | 🟡 NEXT | — | Authoring real charts so Flow 3 can be retested with real songs |

---

## Where we are right now

**Flows 0, 1, 2 green. Moving to Flow 3 (Play).** Flow 2 closed with the per-instance ownership refactor + the 16-effect EFFECT slot + the seat→lane rendering fix. Next setup: wire a `RandomChartSource` so the Game scene spawns notes even without an authored chart, so Flow 3 can be tested without first going through Flow 4.

**Open design decisions before Flow 2 can be marked DONE:**

1. **Per-instance cats** — each owned cat should be its own instance with a unique id + custom name. Currently `ownedCats: CatBreed[]` only stores breed ids, so a player can't own two "Mochi"s. Refactor needed: `ownedCats: OwnedCat[]` where `OwnedCat = { id, breed, name }`. Cascades through `seatedCats` and `equippedCosmetics` (both keyed by instance id instead of breed).
2. **Per-instance cosmetics** — same shape for cosmetics: `ownedCosmetics: OwnedCosmetic[]` with `{ id, type }`. Duplicates allowed.
3. **Equip removes from inventory** — equipping a cosmetic on a cat removes that instance from `ownedCosmetics`. Unequip puts it back.
4. **Box reveal naming flow** — on cat box open, show rarity ("you got a COMMON cat"), then prompt "What would you like to name your cat?". User-typed name attaches to the new owned-cat instance.
5. **Thumbnail label length** — when names can be arbitrary, truncate at the two-line capacity of the thumb cell. Show ellipsis when overflow.

Scope estimate: ~9 files touched + tests. Should be one coordinated commit because halfway state would be broken.

---

## Flow 0 — Hamburger nav + asset visuals

**Bugs caught:**
- Hamburger drawer item taps froze Game scene (delayedCall + scene.time timing race)
- Lanes / hit zones / falling notes were procedural Rectangles instead of Phase 1 art
- Stale vite watchers from earlier sessions were serving outdated bundles

**Fix commits:**
- `ff38071` — drawer item handler fires `onTap` synchronously + try/catch; Game.drawLanes uses `RhythmBarBackground` + `PspspsTarget`; Note entity uses `PspspsElementBall` + `PspspsElementLetters`
- `3ec30dd` — Welcome onboarding now routes to Decorate (not Game) after the starter boxes
- `ffcbaf4` — added DEV_RESET_ON_LOAD + inventory debug panel for Flow 1 prep
- Killed 3 stale vite watchers from earlier sessions

**Verify in next playtest:**
- [x] Hamburger → tap any menu item → scene navigates cleanly
- [x] Lane backdrops use the bar art (blue/purple/yellow tinted)
- [x] Hit target is the fuzzy ball
- [x] Falling notes are the PS ball with letters

---

## Flow 1 — Purchase (inventory gateway)

### What to test

1. Open Purchase via hamburger → see 3 boxes (Cat / Cosmetic / Background) with prices
2. Affordable boxes are tappable; unaffordable show red "🪙 N · need N more"
3. Tap a box → box-open animation → item reveal → coins deducted → reveal shows the REAL sprite, not a blank or placeholder
4. Inventory grows: `ownedCats`, `ownedCosmetics`, `ownedBackgrounds` arrays
5. Duplicate pull → 50-coin refund (CURRENT mechanic — may change with per-instance refactor)
6. Coin balance in topbar updates immediately
7. Hamburger from Purchase → clean nav back to any other scene

### Dev setup

- `DEV_RESET_ON_LOAD = true` in `src/server/routes/state.ts:20` ✅
- `DEV_STARTER_COINS = 5000` ✅
- Debug inventory panel in Purchase scene (top-right) ✅

### Known fixed bugs

- **Box reveal sprite was blank** — wrong texture key (`'cats'` instead of `AssetKeys.Atlas.Cats = 'cats-atlas'`). Fixed in `f5e5578`.

### Done bar

- [ ] Bought at least 2 cats, 2 cosmetics, 1 background
- [ ] All show up in your state (counts visible in debug panel)
- [ ] No console errors
- [ ] No freezes / crashes / weird UI states

### Pending bugs

_(none currently reported — Tim hasn't reported back after the texture key fix; needs verification)_

---

## Flow 2 — Decorate + DressingRoom

### What to test

1. Open Decorate via hamburger
2. Top half: 3-cat preview with current backdrop
3. CATS tab tray: shows your owned cats as **real atlas sprites with their equipped cosmetics layered on top**; tap a thumb → context menu pops up next to the cat
4. Tap "Seat in scene" / "Move" → 3 green placement panels (sized to the cat footprint) appear over each seat slot
5. Tap a green panel → cat seats there. If a cat is already there, it's replaced.
6. Red ✕ badge on every seated cat → tap to quick-unseat
7. Tap "Dress up" → DressingRoom modal pops up over Decorate (Decorate visible dimmed behind)
8. DressingRoom: HEAD / FACE / NECK tabs; each tab equips into its own slot; cat preview stacks all equipped cosmetics
9. ✕ top-right of modal → closes and Decorate refreshes with the new cosmetics on the cat
10. BACKGROUNDS tab: shows only OWNED backgrounds (locked ones hidden); tap → live preview swap
11. Pagination (◀ ▶) at the bottom of CATS and BACKGROUNDS trays when there's >8 items

### Known fixed bugs

- Cat thumbs showed emoji 🐱 → replaced with real atlas sprite (`f5e5578`)
- Cat thumbs distorted → uniform scale preserving aspect (`2a3481c`)
- Cat thumbs too small → bumped to ~78% of cell height (`65a614d`)
- Cat thumbs didn't show equipped items → render cosmetic sprites layered on the thumb (`65a614d`)
- Context menu opened above the cat instead of beside → menu opens to the right (flips left at edge) (`2a3481c`)
- Context menu jumped to top of screen on tray taps → convert local trayContainer coords to world coords (`7cfc53c`)
- Green placement panels covered full lane column → sized to cat-sprite footprint, centered on where cat sits (`2a3481c`)
- Locked backgrounds shown with 🔒 → only owned backgrounds rendered (`2a3481c`)
- DressingRoom was a separate scene → converted to modal popup launched via `scene.launch` (`7cfc53c`)
- DressingRoom had no slot tabs (1 cosmetic per cat) → HEAD/FACE/NECK tabs, multi-slot equip (`aea3f1c`)
- DressingRoom double-launch + listener leak → guard `scene.isActive()` + remove `dressingroom:closed` listener on shutdown (defensive patch)
- No pagination on CATS / BACKGROUNDS trays → added Prev/Next + page indicator (`65a614d`)

### Pending (design decisions)

See "Open design decisions" at the top of this doc.

### Done bar

- [ ] Per-instance ownership refactor merged (or decision to skip for v1)
- [ ] Custom cat naming flow on box open (if doing the refactor)
- [ ] Equip-removes-from-inventory + unequip-restores (if doing the refactor)
- [ ] Name labels truncate to fit thumb width
- [ ] 3 seated cats, each wearing different cosmetics across slots
- [ ] Non-default background active
- [ ] Reload page → setup persists

### Dev setup pending

- `DEV_SKIP_ONBOARDING` flag to land straight in Decorate with seeded inventory (skip Welcome). _(Not yet added — currently DEV_RESET_ON_LOAD wipes state every reload, so Tim re-runs Welcome each time.)_

---

## Flow 3 — Play (random fallback chart)

**Prereq:** Flow 2 done — at least 1 seated cat.

### What to test

1. Open Game via hamburger
2. Backdrop + seated cats render above lanes (matches Decorate preview)
3. Lane bars + target balls render correctly
4. Notes fall from top
5. Tap (or 1/2/3 keys) catches notes → lane's cat plays happy
6. Miss → cat plays angry, combo resets
7. Round finishes (8 loops) → summary overlay with score / accuracy / max combo / misses
8. Skip button → back to Decorate
9. Hamburger during play → clean nav

### Dev setup pending

- Replace dev fallback `emptyChart('dev','test')` with a `RandomChartSource` that spawns notes at fixed BPM with random lanes. Faithful to Phase 1 RhythmSystem feel.
- Random source kicks in when `playerState.chart.steps` is all empty (so Flow 4's authored chart takes priority once it exists).

### Done bar

- [ ] Played 2-3 full rounds without crashes
- [ ] Hits + misses register correctly
- [ ] Cats react in the right lanes
- [ ] Summary stats look right
- [ ] Navigation works mid-round and post-round

---

## Flow 4 — Editor (author a chart)

**Prereq:** Flows 1-3 done.

### What to test

1. Open ChartEditor via hamburger (Post tab)
2. 3×8 grid, lane labels in lane colors
3. Tap a cell → toggles note; tap again → un-toggles
4. ▶ Play preview → scan line scrolls; lit cells flash
5. Clear → all cells reset
6. BPM cycle → restarts preview at new tempo
7. POST → saves chart, routes back to Game
8. Game plays your authored chart (not the random one)
9. Reload → chart persists from server

### Defer

- HTML input for editable title (currently read-only)
- Real Devvit `Reddit.submitPost` (currently stubbed log+route)

### Done bar

- [ ] Author a chart, save it, exit, come back, play your own beat
- [ ] End-to-end loop complete

---

## Pre-ship cleanup (after Flow 4 green)

- [ ] `DEV_RESET_ON_LOAD = false`
- [ ] `DEV_STARTER_COINS` removed or `STARTER_COINS` reverted to ship value
- [ ] `DEV_SHOW_INVENTORY` debug panel removed or gated
- [ ] `DEV_SKIP_ONBOARDING` flag removed
- [ ] Update `outputs/portfolio/pspsps-session-state.md` with Phase 5 shipped state
- [ ] Devvit submit-post wired (for real comment posting on round end)
- [ ] HTML title input in ChartEditor (or accept the read-only fallback for v1)

---

## Phaser best-practice notes applied

Each Phase 5 change validated against `~/Documents/GitHub/PM-OS/.claude/skills/phaser-best-practices/references/scenes-state-architecture.md`:

- ✅ SHUTDOWN handler in every scene (Decorate, DressingRoom, Game, ChartEditor, Purchase) kills tweens / timers / input + keyboard listeners / scale listeners + destroys owned entities.
- ✅ Navigation uses `scene.start()` only (no pause+resume) — Phase 2 quirk in Phaser 4.1.0.
- ✅ Parallel-scene pattern used for DressingRoom modal (`scene.launch` + `scene.stop`) per the UI overlay section of the ref.
- ✅ Double-launch guard via `scene.isActive(key)` check (ref calls this out as a common pitfall).
- ✅ Named callback for `events.on('dressingroom:closed')` listener + explicit `events.off` on cleanup (ref calls out "registering listeners every create()" as a pitfall).
- ✅ Decorate scene re-initializes per-tab page indices in `init()` so scene restarts get a clean state.
