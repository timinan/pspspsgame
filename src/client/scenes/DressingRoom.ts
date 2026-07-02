import { GameObjects, Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { CAT_CATALOG, COSMETIC_CATALOG } from '@/../shared/state';
import { AssetKeys } from '@/constants/assets';
import { equipCosmetic } from '@/services/state-client';
import { Cat, parentIdFor } from '@/entities/cat';
import { CAT_EFFECT_BY_ID, getEffectById, getEffectGridEntries, isEffectCosmeticId, type EffectHandle } from '@/effects/cat-effects';
import type { PlayerState, OwnedCosmetic } from '@/../shared/state';

// Effect-category filter — matches EffectCategory from the generated
// catalog + the legacy categories from cat-effects.ts. Order drives the
// category tab chips in effects-only mode.
const EFFECT_CATEGORY_ORDER = [
  'Stagelights (live)',
  'Halos & Rings',
  'Beams',
  'Pulse Waves',
  'Orbiters',
  'Tint FX',
  'Floor / Ground',
  'Weather',
  'Decorative',
  'Misc / Extras',
] as const;

/** Short label used on the category tab chips. */
const CATEGORY_SHORT_LABEL: Record<string, string> = {
  'all': 'ALL',
  'Stagelights (live)': 'STAGELIGHTS',
  'Halos & Rings': 'HALOS',
  'Beams': 'BEAMS',
  'Pulse Waves': 'PULSES',
  'Orbiters': 'ORBITERS',
  'Tint FX': 'TINTS',
  'Floor / Ground': 'FLOORS',
  'Weather': 'WEATHER',
  'Decorative': 'DECOR',
  'Misc / Extras': 'MISC',
};

// 3 cols × 3 rows = 9 visible cells; last slot is the ✕ "clear slot"
// tile, so up to 8 cosmetics fit per page. Cells are a middle ground
// between the original 48 px grid and the briefly-tried 104 px grid —
// big enough to read the asset + name clearly, small enough to keep
// the page count low and let the modal envelope grow only modestly.
// Grid geometry — 3 columns of 76px cells with an 8px gap, drag-scrolled
// vertically behind a GeometryMask (pagination retired 2026-07-01; a 512-
// cosmetic catalog at 8/page was ~56 pages of arrow taps).
const GRID_CELL = 76;
const GRID_GAP = 8;
const GRID_COLS = 3;
const GRID_ROW_H = GRID_CELL + GRID_GAP;
// Cells live in a far-away world band only the grid camera looks at; the
// main camera never sees them, and the grid camera's viewport (the modal's
// grid rect) scissor-clips them exactly — no masks (removed in Phaser 4
// WebGL), no cover panels (cells poked past the modal bottom).
const GRID_WORLD_OFF = 100000;
// Effects moved out of the Dress Up tabs on 2026-07-01 — they get their own
// entry point ('Add effect' on the cat context menu) which opens this modal
// in effects-only mode with category tabs. The 'effect' SLOT key stays alive
// in the equip model; only the tab is gone.
const SLOT_TABS: { key: string; label: string }[] = [
  { key: 'head', label: 'HEAD' },
  { key: 'face', label: 'FACE' },
  { key: 'neck', label: 'NECK' },
];

export class DressingRoom extends Scene {
  /** The cat INSTANCE id (not breed). */
  private catInstanceId!: string;
  private playerState!: PlayerState;
  /** Which slot the player is currently browsing in the cosmetics tray. */
  private activeSlot: string = 'head';
  /** Live scene-level cell objects for the visible scroll window. */
  private gridCells: GameObjects.GameObject[] = [];
  /** Dedicated camera whose viewport is the grid rect. */
  private gridCam!: Phaser.Cameras.Scene2D.Camera;
  private heroSprite!: GameObjects.Image;
  /** One layered sprite per equipped slot — keyed by slot name. */
  private heroCosmetics: Record<string, GameObjects.Sprite> = {};
  /** Active EFFECT handles on the hero preview, keyed by slot ('effect'). */
  private heroEffects: Record<string, EffectHandle> = {};
  private wearingLabel!: GameObjects.Text;
  private slotTabsContainer!: GameObjects.Container;
  // --- drag-scroll grid state ---
  private scrollY = 0;
  private gridTopY = 0;
  private gridViewH = 244;
  private gridZoneX = 0;
  private gridZoneW = 0;
  /** Virtual item list for the active tab; index 0 (null) is the NONE tile
   *  so "clear slot" is always at the top instead of buried under 100+
   *  items at the bottom of the scroll. */
  private gridItems: (OwnedCosmetic | null)[] = [];
  private gridEquippedInstanceId: string | undefined;
  private visibleFirstRow = -1;
  private visibleLastRow = -1;
  private scrollbar!: GameObjects.Rectangle;
  private dragActive = false;
  private dragLastY = 0;
  private dragMoved = 0;
  private dragVelocity = 0;
  private dragLastT = 0;
  private momentumTween: Phaser.Tweens.Tween | null = null;
  /** True when launched via 'Add effect' — the modal locks to the effect
   *  slot and the slot tabs become effect-category tabs. */
  private effectsOnly = false;
  /** Category filter driving the effects grid. 'all' shows everything. */
  private effectCategoryFilter: string = 'all';
  /** Cached id → category map so the grid filter doesn't re-scan the
   *  catalog on every render. Populated on scene create. */
  private effectCategoryById: Record<string, string> = {};

  constructor() {
    super(SceneKeys.DressingRoom);
  }

  init(data: { catInstanceId: string; playerState: PlayerState; effectsOnly?: boolean }): void {
    // Defensive teardown — if the previous DressingRoom launch's
    // SHUTDOWN handler didn't fire cleanly (Phaser launch/stop edge
    // cases), the prior effect's particle timer keeps spawning text
    // emojis into the scene with no live reference to destroy them.
    // Tim's bug: 🐾 Paw Prints effect from cat 2's dressing session
    // lingered on cat 3's preview. Calling each effect's destroy()
    // here BEFORE replacing the map ensures particles + timers + tweens
    // are torn down even if cleanup() missed a beat last close.
    for (const slot of Object.keys(this.heroEffects)) {
      this.heroEffects[slot]?.destroy();
    }
    for (const slot of Object.keys(this.heroCosmetics)) {
      this.heroCosmetics[slot]?.destroy();
    }
    this.catInstanceId = data.catInstanceId;
    this.playerState = data.playerState;
    this.scrollY = 0;
    this.visibleFirstRow = -1;
    this.visibleLastRow = -1;
    this.effectsOnly = data.effectsOnly ?? false;
    this.activeSlot = this.effectsOnly ? 'effect' : 'head';
    this.effectCategoryFilter = 'all';
    this.heroCosmetics = {};
    this.heroEffects = {};
  }

  create(): void {
    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());
    const { width, height } = this.scale;

    const modalW = Math.min(width * 0.86, 420);
    // Modal sizes to its actual content — constants below mirror the
    // positions used downstream (hero / tabs / grid / pagination). Any
    // change to those numbers needs to be reflected here too.
    const HERO_OFFSET_Y = 110;
    // Effects-only mode stacks THREE rows of category chips (11 labels on
    // a 275px-wide modal) where the single slot-tab row sits in dress-up
    // mode, so the grid starts lower there.
    const GRID_OFFSET_FROM_HERO = this.effectsOnly ? 178 : 130;
    // 3 rows × 76 + 2 × 8 = 244. Slightly taller than the original
    // 4×48 grid (216) — the modal grows by ~30 px to accommodate the
    // bigger, more readable cells without going off-screen.
    const GRID_CONTENT_H = 3 * 76 + 2 * 8;
    const PAGINATION_GAP_FROM_GRID = 24;
    const BOTTOM_PADDING = 24;
    const contentH =
      HERO_OFFSET_Y + GRID_OFFSET_FROM_HERO + GRID_CONTENT_H +
      PAGINATION_GAP_FROM_GRID + BOTTOM_PADDING;
    // Cap at viewport - 36 so a tiny canvas never pushes the modal off
    // the edge; the cap also bounds the lower limit so contentH wins on
    // the normal 580-design canvas (the old height*0.78 left ~90 px of
    // dead space below the pagination strip).
    const modalH = Math.min(contentH, height - 36);
    const modalX = (width - modalW) / 2;
    const modalY = (height - modalH) / 2;
    const cx = width / 2;

    // Dim backdrop — eats taps so Decorate underneath doesn't react.
    const scrim = this.add
      .rectangle(0, 0, width, height, 0x000000, 0.55)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', () => this.exit());

    // Modal panel
    const panelBg = this.add
      .rectangle(modalX, modalY, modalW, modalH, 0x1a0a2e, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0xffd34d, 0.85)
      .setInteractive();
    panelBg.on(
      'pointerdown',
      (
        _p: Phaser.Input.Pointer,
        _x: number,
        _y: number,
        event: Phaser.Types.Input.EventData,
      ) => {
        event.stopPropagation();
      },
    );

    // Resolve cat instance + catalog entry.
    const catInstance = this.playerState.ownedCats.find((cat) => cat.id === this.catInstanceId);
    const catEntry = catInstance ? CAT_CATALOG.find((c) => c.id === catInstance.breed) : undefined;
    // Title uses the custom name set by the player.
    const heroName = catInstance?.name ?? catEntry?.name ?? this.catInstanceId;
    this.add
      .text(cx, modalY + 22, this.effectsOnly
        ? `${heroName.toUpperCase()} — EFFECTS`
        : `DRESSING ${heroName.toUpperCase()}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setDepth(10);

    // ✕ close button
    const closeBg = this.add
      .circle(modalX + modalW - 18, modalY + 18, 12, 0xff5050, 1)
      .setStrokeStyle(2, 0x0b041a, 1)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    closeBg.on(
      'pointerdown',
      (
        _p: Phaser.Input.Pointer,
        _x: number,
        _y: number,
        event: Phaser.Types.Input.EventData,
      ) => {
        event.stopPropagation();
        this.exit();
      },
    );
    this.add
      .text(modalX + modalW - 18, modalY + 18, '✕', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(10);

    // Hero sprite — use the breed for the atlas frame.
    const breed = catInstance?.breed ?? this.catInstanceId;
    const heroFrame = breed === 'rainbow' ? 'cat6_idle_00' : `${breed}_idle_00`;
    const heroY = modalY + HERO_OFFSET_Y;
    // 1.15× (was 1.4 to match seated-stage) — tall cosmetics like the
    // cherry-blossom wreath were extending above + to the sides of the
    // hero and getting clipped by the modal top + side edges at 1.4.
    // Smaller hero means cosmetic atlas frames (some 80×80, taller than
    // the 48×48 cat) fit cleanly inside the preview. Cat still reads
    // big enough to recognize at this scale.
    const heroScale = 1.15;
    this.heroSprite = this.add
      .image(cx, heroY, AssetKeys.Atlas.Cats, heroFrame)
      .setScale(heroScale)
      // Bump the hero (and by extension its effect handles which use
      // depth relative to this) well above the modal panel + scrim, both
      // of which sit at depth 0. Without this, the flame aura's
      // `sprite.depth - 1 = -1` gets covered by the modal backdrop.
      .setDepth(200);
    this.renderEquippedCosmetics();

    // Wearing label
    this.wearingLabel = this.add
      .text(cx, this.heroSprite.y + 68, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5)
      .setDepth(10);
    this.updateWearingLabel();

    // Tab row — slot tabs (HEAD / FACE / NECK) in dress-up mode, two rows
    // of effect-category chips in effects-only mode.
    this.slotTabsContainer = this.add.container(0, this.heroSprite.y + 92).setDepth(10);
    this.buildEffectCategoryIndex();
    this.renderSlotTabs();

    // Grid — filtered by activeSlot, drag-scrolled behind a GeometryMask.
    const gridTop = this.heroSprite.y + GRID_OFFSET_FROM_HERO;
    this.gridTopY = gridTop;
    this.gridViewH = Math.max(GRID_ROW_H * 2, modalY + modalH - 20 - gridTop);
    this.gridZoneX = modalX;
    this.gridZoneW = modalW;
    // Grid camera — viewport is exactly the grid rect, so cells (which
    // live at GRID_WORLD_OFF, out of the main camera's sight) clip
    // pixel-perfectly at the viewport edges. Scrolling = camera scrollY.
    this.gridCam = this.cameras.add(0, gridTop, this.scale.width, this.gridViewH);
    this.gridCam.setScroll(0, GRID_WORLD_OFF);

    // Thin position indicator on the modal's right edge; hidden when the
    // whole list fits in the viewport.
    this.scrollbar = this.add
      .rectangle(modalX + modalW - 7, gridTop, 3, 40, 0xc0a0e6, 0.45)
      .setOrigin(0.5, 0)
      .setDepth(10);

    this.renderGrid();
    this.setupGridScrollInput();
  }

  /** Drag / momentum / wheel scrolling for the grid viewport. Listeners
   *  are scene-level so drags that start on a cell still scroll; cells
   *  distinguish tap from drag via `dragMoved`. */
  private setupGridScrollInput(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (
        p.x < this.gridZoneX || p.x > this.gridZoneX + this.gridZoneW ||
        p.y < this.gridTopY - GRID_GAP || p.y > this.gridTopY + this.gridViewH
      ) return;
      this.momentumTween?.stop();
      this.momentumTween = null;
      this.dragActive = true;
      this.dragLastY = p.y;
      this.dragMoved = 0;
      this.dragVelocity = 0;
      this.dragLastT = this.time.now;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.dragActive) return;
      const dy = p.y - this.dragLastY;
      if (dy === 0) return;
      const now = this.time.now;
      const dt = Math.max(1, now - this.dragLastT);
      this.dragVelocity = dy / dt;
      this.dragLastY = p.y;
      this.dragLastT = now;
      this.dragMoved += Math.abs(dy);
      this.setScroll(this.scrollY - dy);
    });
    this.input.on('pointerup', () => {
      if (!this.dragActive) return;
      this.dragActive = false;
      const v = this.dragVelocity;
      if (Math.abs(v) > 0.25 && this.maxScroll() > 0) {
        const proxy = { v: this.scrollY };
        this.momentumTween = this.tweens.add({
          targets: proxy,
          v: this.scrollY - v * 260,
          duration: 480,
          ease: 'Quad.easeOut',
          onUpdate: () => this.setScroll(proxy.v),
        });
      }
    });
    this.input.on('wheel', (_p: unknown, _objs: unknown, _dx: number, dy: number) => {
      if (this.maxScroll() > 0) this.setScroll(this.scrollY + dy * 0.6);
    });
  }

  private maxScroll(): number {
    const totalRows = Math.ceil(this.gridItems.length / GRID_COLS);
    return Math.max(0, totalRows * GRID_ROW_H - GRID_GAP - this.gridViewH);
  }

  private setScroll(v: number): void {
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), v));
    this.gridCam.setScroll(0, GRID_WORLD_OFF + this.scrollY);
    this.renderVisibleCells();
    this.updateScrollbar();
  }

  private updateScrollbar(): void {
    const max = this.maxScroll();
    this.scrollbar.setVisible(max > 0);
    if (max <= 0) return;
    const frac = this.gridViewH / (max + this.gridViewH);
    const barH = Math.max(24, this.gridViewH * frac);
    this.scrollbar.setSize(3, barH);
    this.scrollbar.y = this.gridTopY + (this.gridViewH - barH) * (this.scrollY / max);
  }

  /** Re-render all hero cosmetic layers from equippedCosmetics. */
  private renderEquippedCosmetics(): void {
    for (const slot of Object.keys(this.heroCosmetics)) {
      this.heroCosmetics[slot]?.destroy();
    }
    this.heroCosmetics = {};
    for (const slot of Object.keys(this.heroEffects)) {
      this.heroEffects[slot]?.destroy();
    }
    this.heroEffects = {};

    const slots = this.playerState.equippedCosmetics[this.catInstanceId];
    if (!slots) return;

    // Hero is `add.image()` with default origin (0.5, 0.5) — center
    // anchored on a 91×64 source canvas. Cat.syncOneCosmetic's math is
    // written against origin (0.5, 1); for center origin the canvas-Y
    // reference is the midpoint (32) instead of the bottom (64).
    const heroCanvasRefY = Cat.SOURCE_CANVAS_H / 2;
    const heroX = this.heroSprite.x;
    const heroY = this.heroSprite.y;
    const heroScale = this.heroSprite.scaleX;

    const equippedTypes = this.playerState.equippedCosmeticTypes ?? {};
    // Tim 06-30: depth comes from the slot name (head > face > neck) so the
    // hero preview matches the in-game cat.ts layering, not from equip
    // order which produced inconsistent stacking.
    const SLOT_DEPTH: Record<string, number> = { neck: 1, face: 2, head: 3, effect: 0 };
    for (const [slotKey, cosInstanceId] of Object.entries(slots)) {
      if (!cosInstanceId) continue;
      // Resolve the catalog type via the sidecar.
      const cosTypeId = equippedTypes[cosInstanceId] ?? cosInstanceId;
      // EFFECT cosmetics are code-driven — apply them to the hero preview
      // so the player can see what they're equipping without leaving the
      // modal. Tracked separately so they tear down on slot swap / close.
      const effect = getEffectById(cosTypeId);
      if (effect) {
        // Pass the hero's render scale so the effect's footprint
        // (flame width, particle size, spread, rise distance) matches
        // the up-to-2.2× hero. Without this the effect rendered at 1×
        // and looked smaller than the cat.
        this.heroEffects[slotKey] = effect.apply(this, this.heroSprite, this.heroSprite.scaleX);
        continue;
      }
      // DELETED effect still equipped on an existing state — occupy the
      // slot, render nothing, don't hunt for an atlas frame.
      if (isEffectCosmeticId(cosTypeId)) continue;
      const cos = COSMETIC_CATALOG.find((c) => c.id === cosTypeId);
      if (!cos) continue;
      const renderId = parentIdFor(cos) ?? cos.id;
      const frame = `cosmetic_${renderId}_idle_00`;

      // Apply the catalog's calibrator-driven offsetX/offsetY/scale so
      // the hero preview matches the in-game render and the calibrator
      // preview. Before this: DressingRoom stacked the cosmetic at the
      // hero's raw position and ignored catalog placement, so any
      // calibrator drag (e.g. c62 Purple Flamehead's offsetY=9, scale=1.1)
      // showed up everywhere EXCEPT the modal — the flame floated a few
      // pixels above the hero's head while the game + calibrator agreed.
      // Math mirrors Cat.syncOneCosmetic, with the hero's center origin
      // (0.5, 0.5) substituting heroCanvasRefY=32 for the cat's 64.
      const catalogOffsetX = cos.offsetX ?? 0;
      const catalogOffsetY = cos.offsetY ?? 0;
      const catalogScale = cos.scale ?? 1;
      const targetX = Cat.CANVAS_HORIZONTAL_CENTER + catalogOffsetX;
      const targetY = Cat.CAT_HEAD_TOP_REF + catalogOffsetY;
      const cosScale = catalogScale * heroScale;

      const textureFrame = this.textures
        .get(AssetKeys.Atlas.Cosmetics)
        .get(frame);
      const anchorX = textureFrame.x + textureFrame.width / 2;
      const anchorY = textureFrame.y + textureFrame.height / 2;

      const cosX = heroX
        + (targetX - Cat.SOURCE_CANVAS_HALF_W) * heroScale
        - (anchorX - Cat.SOURCE_CANVAS_HALF_W) * cosScale;
      const cosY = heroY
        + (targetY - heroCanvasRefY) * heroScale
        - (anchorY - heroCanvasRefY) * cosScale;

      const sprite = this.add
        .sprite(cosX, cosY, AssetKeys.Atlas.Cosmetics, frame)
        .setScale(cosScale)
        .setOrigin(this.heroSprite.originX, this.heroSprite.originY)
        .setDepth(this.heroSprite.depth + (SLOT_DEPTH[slotKey] ?? 1));
      if (cos.tint) {
        sprite.setTint(parseInt(cos.tint.replace('#', ''), 16));
      }
      this.heroCosmetics[slotKey] = sprite;
    }
  }

  private updateWearingLabel(): void {
    const slots = this.playerState.equippedCosmetics[this.catInstanceId] ?? {};
    const cosInstanceId = slots[this.activeSlot];
    const equippedTypes = this.playerState.equippedCosmeticTypes ?? {};
    const cosTypeId = cosInstanceId ? (equippedTypes[cosInstanceId] ?? cosInstanceId) : undefined;
    const cos = cosTypeId ? COSMETIC_CATALOG.find((c) => c.id === cosTypeId) : null;
    this.wearingLabel.setText(
      `${this.activeSlot.toUpperCase()}: ${cos?.name ?? 'empty'}`,
    );
  }

  /** Render the tab row — slot tabs in dress-up mode, effect-category
   *  chips in effects-only mode. */
  private renderSlotTabs(): void {
    if (this.effectsOnly) {
      this.renderCategoryChips();
      return;
    }
    this.slotTabsContainer.removeAll(true);
    const { width } = this.scale;
    // Tabs must fit inside the modal panel. The modal is up to 86% of the
    // canvas (capped at 420px); leave a small inset so tabs don't kiss the
    // border. Width is divided evenly across the slot count so we don't have
    // to retune when slots are added/removed.
    const modalW = Math.min(width * 0.86, 420);
    const inset = 14;
    const gap = 5;
    const available = modalW - inset * 2;
    const tabW = Math.floor((available - gap * (SLOT_TABS.length - 1)) / SLOT_TABS.length);
    const tabH = 26;
    const totalW = SLOT_TABS.length * tabW + (SLOT_TABS.length - 1) * gap;
    const startX = (width - totalW) / 2;
    const equippedSlots = this.playerState.equippedCosmetics[this.catInstanceId] ?? {};
    SLOT_TABS.forEach((tab, i) => {
      const x = startX + i * (tabW + gap);
      const isActive = this.activeSlot === tab.key;
      const equipped = equippedSlots[tab.key];
      // Tim flagged that all four tabs were reading as "lit" when only
      // one was selected — the previous alpha gradient (1.0 / 0.55 /
      // 0.35) was too subtle. Now:
      //   active                  → yellow border + filled bg
      //   equipped (not active)   → small yellow dot indicator on the
      //                              right edge, dim purple border
      //   empty + not active      → dim purple border, no dot
      // The dot is unambiguous (only present for equipped non-active)
      // and the border is uniformly dim — no false yellow.
      const strokeColor = isActive ? 0xffd34d : 0xc0a0e6;
      const strokeAlpha = isActive ? 1 : 0.25;
      const textColor = isActive ? '#ffd34d' : '#c0a0e6';
      const bg = this.add
        .rectangle(x, 0, tabW, tabH, isActive ? 0x4d2d8c : 0x0b041a, isActive ? 1 : 0.55)
        .setOrigin(0, 0)
        .setStrokeStyle(isActive ? 2 : 1, strokeColor, strokeAlpha)
        .setInteractive({ useHandCursor: true });
      const text = this.add
        .text(x + tabW / 2, tabH / 2, tab.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '11px',
          color: textColor,
        })
        .setOrigin(0.5);
      this.slotTabsContainer.add([bg, text]);
      // Tiny yellow dot on equipped non-active tabs — signals "you've
      // got something in this slot" without making the tab look active.
      if (equipped && !isActive) {
        const dot = this.add
          .circle(x + tabW - 6, 6, 3, 0xffd34d, 1);
        this.slotTabsContainer.add(dot);
      }
      bg.on('pointerdown', () => {
        this.activeSlot = tab.key;
        this.scrollY = 0;
        this.renderSlotTabs();
        this.renderGrid();
        this.updateWearingLabel();
      });
    });
  }

  /** Effects-only mode: two rows of category chips (ALL + the 10 effect
   *  categories) driving `effectCategoryFilter`. Flow layout — chip width
   *  follows its label so STAGELIGHTS and DECOR both stay readable at the
   *  same font size (menu-text rule: text always inside its button). */
  private renderCategoryChips(): void {
    this.slotTabsContainer.removeAll(true);
    const { width } = this.scale;
    const modalW = Math.min(width * 0.86, 420);
    const inset = 14;
    const available = modalW - inset * 2;
    const startX = (width - available) / 2;
    const chipH = 22;
    const rowGap = 4;
    const chipGap = 5;
    const padX = 7;

    const options: string[] = ['all', ...EFFECT_CATEGORY_ORDER];
    // Measure → flow into rows.
    type Chip = { key: string; label: string; w: number };
    const chips: Chip[] = options.map((key) => {
      const label = CATEGORY_SHORT_LABEL[key] ?? key.toUpperCase();
      // 9px Pixeloid bold ≈ 6.5px per char + padding both sides.
      const w = Math.ceil(label.length * 6.5) + padX * 2;
      return { key, label, w };
    });
    const rows: Chip[][] = [[]];
    let rowW = 0;
    for (const chip of chips) {
      const cur = rows[rows.length - 1];
      const next = rowW + (cur.length ? chipGap : 0) + chip.w;
      if (cur.length && next > available) {
        rows.push([chip]);
        rowW = chip.w;
      } else {
        cur.push(chip);
        rowW = next;
      }
    }

    rows.forEach((row, r) => {
      const totalW = row.reduce((s, c) => s + c.w, 0) + chipGap * (row.length - 1);
      let x = startX + (available - totalW) / 2;
      const y = r * (chipH + rowGap);
      for (const chip of row) {
        const isActive = this.effectCategoryFilter === chip.key;
        const bg = this.add
          .rectangle(x, y, chip.w, chipH, isActive ? 0x4d2d8c : 0x0b041a, isActive ? 1 : 0.55)
          .setOrigin(0, 0)
          .setStrokeStyle(isActive ? 2 : 1, isActive ? 0xffd34d : 0xc0a0e6, isActive ? 1 : 0.25)
          .setInteractive({ useHandCursor: true });
        const text = this.add
          .text(x + chip.w / 2, y + chipH / 2, chip.label, {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '9px',
            color: isActive ? '#ffd34d' : '#c0a0e6',
          })
          .setOrigin(0.5);
        this.slotTabsContainer.add([bg, text]);
        bg.on('pointerdown', () => {
          this.effectCategoryFilter = chip.key;
          this.scrollY = 0;
          this.renderCategoryChips();
          this.renderGrid();
        });
        x += chip.w + chipGap;
      }
    });
  }

  /** Build the id → category map used to filter the grid on the EFFECT
   *  tab. Runs once on scene create; cheap enough (~500 entries). */
  private buildEffectCategoryIndex(): void {
    const entries = getEffectGridEntries();
    for (const e of entries) this.effectCategoryById[e.id] = e.category;
  }

  private renderGrid(): void {
    // The grid shows cosmetics currently IN ownedCosmetics (not equipped anywhere).
    // Equipped cosmetics are removed from ownedCosmetics, so they don't appear here.
    const ownedInSlot: OwnedCosmetic[] = this.playerState.ownedCosmetics.filter((cosItem) => {
      // DELETED effects a player still owns never show in the grid.
      if (isEffectCosmeticId(cosItem.type) && !getEffectById(cosItem.type)) return false;
      const cos = COSMETIC_CATALOG.find((c) => c.id === cosItem.type);
      const slot = cos?.slot ?? 'head';
      if (slot !== this.activeSlot) return false;
      // Category dropdown filter — active only on the EFFECT tab.
      if (this.activeSlot === 'effect' && this.effectCategoryFilter !== 'all') {
        const cat = this.effectCategoryById[cosItem.type];
        if (cat !== this.effectCategoryFilter) return false;
      }
      return true;
    });

    // Currently-equipped cosmetic in this slot (instance id + type id).
    // We include it in the display list alongside non-equipped owned
    // cosmetics so the grid order stays stable: equipping/unequipping
    // doesn't shift other items around. The equipped one is highlighted
    // and tapping it toggles back to unequipped.
    const equippedSlots = this.playerState.equippedCosmetics[this.catInstanceId] ?? {};
    const equippedInstanceId = equippedSlots[this.activeSlot];
    let equippedItem: OwnedCosmetic | null = null;
    if (equippedInstanceId) {
      const type = this.playerState.equippedCosmeticTypes?.[equippedInstanceId];
      if (type) {
        const eqCos = COSMETIC_CATALOG.find((c) => c.id === type);
        if (eqCos?.slot === this.activeSlot) {
          equippedItem = { id: equippedInstanceId, type };
        }
      }
    }

    // Merge + sort by instance id so the order is deterministic and
    // doesn't shuffle between renders (equip / unequip preserved).
    const merged: OwnedCosmetic[] = equippedItem
      ? [equippedItem, ...ownedInSlot]
      : [...ownedInSlot];
    merged.sort((a, b) => a.id.localeCompare(b.id));

    // NONE (clear slot) leads the list so it's always one flick away.
    this.gridItems = [null, ...merged];
    this.gridEquippedInstanceId = equippedInstanceId;
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY));
    this.gridCam.setScroll(0, GRID_WORLD_OFF + this.scrollY);
    this.visibleFirstRow = -1;
    this.visibleLastRow = -1;
    this.renderVisibleCells();
    this.updateScrollbar();
  }

  /** Rebuild only the cells whose rows intersect the scroll viewport
   *  (± one buffer row). Cheap enough to rebuild on window change —
   *  ~15 live cells regardless of whether the tab holds 8 items or 130.
   *  Cells are static world objects at GRID_WORLD_OFF; scrolling is
   *  purely the grid camera panning over them. */
  private renderVisibleCells(): void {
    const totalRows = Math.ceil(this.gridItems.length / GRID_COLS);
    const first = Math.max(0, Math.floor(this.scrollY / GRID_ROW_H) - 1);
    const last = Math.min(totalRows - 1, Math.floor((this.scrollY + this.gridViewH) / GRID_ROW_H) + 1);
    if (first === this.visibleFirstRow && last === this.visibleLastRow) return;
    this.visibleFirstRow = first;
    this.visibleLastRow = last;
    for (const obj of this.gridCells) obj.destroy();
    this.gridCells.length = 0;
    const lastIdx = Math.min(this.gridItems.length - 1, last * GRID_COLS + GRID_COLS - 1);
    for (let idx = first * GRID_COLS; idx <= lastIdx; idx++) this.buildCell(idx);
  }

  /** Build one grid cell (cosmetic, effect, or the NONE tile) at its
   *  virtual world position (grid-camera space). */
  private buildCell(idx: number): void {
    const cosItem = this.gridItems[idx];
    const col = idx % GRID_COLS;
    const row = Math.floor(idx / GRID_COLS);
    const gridStartX = (this.scale.width - (GRID_CELL * GRID_COLS + GRID_GAP * (GRID_COLS - 1))) / 2;
    const x = gridStartX + col * (GRID_CELL + GRID_GAP) + GRID_CELL / 2;
    const y = GRID_WORLD_OFF + row * GRID_ROW_H + GRID_CELL / 2;
    // Head atlas frames are authored with the hat at the very top of
    // the canvas (where the cat's head would be), so the default
    // -14 offset positions them way too high in the cell. Push head
    // cosmetics down by 14 px more to bring them closer to centered.
    const imageYOffset = this.activeSlot === 'head' ? 0 : -14;
    const labelYOffset = this.activeSlot === 'head' ? 28 : 22;
    const labelFontSize = 9;
    const labelWrapWidth = GRID_CELL - 10;
    const equippedInstanceId = this.gridEquippedInstanceId;

    // NONE (clear slot) tile — lights up yellow when nothing is equipped.
    if (cosItem === null) {
      const isNone = !equippedInstanceId;
      const bg = this.add
        .rectangle(x, y, GRID_CELL, GRID_CELL, 0x0b041a, 0.6)
        .setStrokeStyle(2, isNone ? 0xffd34d : 0xc0a0e6, isNone ? 1 : 0.3)
        .setInteractive({ useHandCursor: true });
      const glyph = this.add
        .text(x, y + imageYOffset, '⊘', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '34px',
          color: isNone ? '#ffd34d' : '#c0a0e6',
        })
        .setOrigin(0.5);
      const label = this.add
        .text(x, y + labelYOffset, 'NONE', {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: `${labelFontSize}px`,
          color: isNone ? '#ffd34d' : '#ffffff',
        })
        .setOrigin(0.5);
      this.gridCells.push(bg, glyph, label);
      bg.on('pointerup', () => {
        if (this.dragMoved < 8) this.equipInSlot(null);
      });
      return;
    }

    const cos = COSMETIC_CATALOG.find((c) => c.id === cosItem.type);
    if (!cos) return;
    const isEquipped = equippedInstanceId === cosItem.id;
    // Tim's call: non-selected cells looked too "lit" — purple-alpha-0.3
    // strokes still read as bright on the dark bg. Drop non-selected
    // to a much thinner barely-there stroke; bump selected to 3 px
    // for a clear pop.
    const bg = this.add
      .rectangle(x, y, GRID_CELL, GRID_CELL, 0x0b041a, 0.6)
      .setStrokeStyle(
        isEquipped ? 3 : 1,
        isEquipped ? 0xffd34d : 0xc0a0e6,
        isEquipped ? 1 : 0.15,
      )
      .setInteractive({ useHandCursor: true });
    this.gridCells.push(bg);

    // Effect cosmetics don't have atlas frames — render an emoji thumb.
    const effect = getEffectById(cosItem.type);
    if (effect) {
      const icon = this.add
        .text(x, y + imageYOffset, effect.iconEmoji, { fontSize: '32px' })
        .setOrigin(0.5);
      const label = this.add
        .text(x, y + labelYOffset, effect.name, {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: `${labelFontSize}px`,
          color: '#ffffff',
          align: 'center',
          wordWrap: { width: labelWrapWidth },
        })
        .setOrigin(0.5);
      this.gridCells.push(icon, label);
    } else {
      const renderId = parentIdFor(cos) ?? cos.id;
      const frame = `cosmetic_${renderId}_idle_00`;
      const sprite = this.add
        .sprite(x, y + imageYOffset, AssetKeys.Atlas.Cosmetics, frame)
        .setScale(1.05);
      if (cos.tint) {
        sprite.setTint(parseInt(cos.tint.replace('#', ''), 16));
      }
      const label = this.add
        .text(x, y + labelYOffset, cos.name.toUpperCase(), {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: `${labelFontSize}px`,
          color: '#ffffff',
          align: 'center',
          wordWrap: { width: labelWrapWidth },
        })
        .setOrigin(0.5);
      this.gridCells.push(sprite, label);
    }

    // Tap behavior:
    //  - Tapping an unequipped cosmetic → equip it
    //  - Tapping the currently-equipped cosmetic → unequip it (toggle)
    // Equip fires on pointerUP gated by drag distance so a flick-scroll
    // that starts on a cell never equips it. The pointerdown pre-flash
    // keeps the instant "you selected it" cue on real taps.
    bg.on('pointerdown', () => {
      bg.setStrokeStyle(3, 0xffd34d, 1);
    });
    bg.on('pointerup', () => {
      if (this.dragMoved >= 8) {
        // Was a scroll, not a tap — restore the resting stroke.
        bg.setStrokeStyle(isEquipped ? 3 : 1, isEquipped ? 0xffd34d : 0xc0a0e6, isEquipped ? 1 : 0.15);
        return;
      }
      if (isEquipped) this.equipInSlot(null);
      else this.equipInSlot(cosItem);
    });
  }

  /**
   * Equip / clear a cosmetic in the currently-active slot.
   * `cosItem` is an OwnedCosmetic instance, or null to clear.
   */
  private async equipInSlot(cosItem: OwnedCosmetic | null): Promise<void> {
    const slot = this.activeSlot;

    // Ensure structures exist.
    if (!this.playerState.equippedCosmetics[this.catInstanceId]) {
      this.playerState.equippedCosmetics[this.catInstanceId] = {};
    }
    if (!this.playerState.equippedCosmeticTypes) {
      this.playerState.equippedCosmeticTypes = {};
    }
    const slots = this.playerState.equippedCosmetics[this.catInstanceId]!;
    const equippedTypes = this.playerState.equippedCosmeticTypes;

    // Cross-slot bug diagnostics (Tim reported: equipping a necklace
    // changed the cat's hat to a different one). Snapshot all slot
    // contents + their resolved cosmetic types BEFORE the mutation,
    // and the same after the server round-trip, so we can see exactly
    // where the rogue HEAD swap is coming from.
    const snapshotSlots = (label: string): void => {
      const summary: Record<string, string> = {};
      for (const [k, instId] of Object.entries(slots)) {
        if (!instId) continue;
        const type = equippedTypes[instId] ?? '(missing)';
        summary[k] = `${instId} → ${type}`;
      }
      console.info(`[DressingRoom] ${label} slot=${slot} cos=${cosItem?.id ?? 'null'}`, summary);
    };
    snapshotSlots('BEFORE');

    // Snapshot previous state for rollback.
    const previousInstanceId = slots[slot];
    const snapshotOwnedCosmetics = [...this.playerState.ownedCosmetics];
    const snapshotEquippedTypes = { ...equippedTypes };

    // Optimistic mutation — mirrors server logic.
    if (previousInstanceId) {
      // Restore previous cosmetic to inventory.
      const prevType = equippedTypes[previousInstanceId];
      if (prevType) {
        this.playerState.ownedCosmetics.push({ id: previousInstanceId, type: prevType });
        delete equippedTypes[previousInstanceId];
      }
    }

    if (cosItem === null) {
      delete slots[slot];
    } else {
      // Pop the new cosmetic from inventory.
      const idx = this.playerState.ownedCosmetics.findIndex((c) => c.id === cosItem.id);
      if (idx !== -1) this.playerState.ownedCosmetics.splice(idx, 1);
      equippedTypes[cosItem.id] = cosItem.type;
      slots[slot] = cosItem.id;
    }

    if (Object.keys(slots).length === 0) {
      delete this.playerState.equippedCosmetics[this.catInstanceId];
    }

    this.renderEquippedCosmetics();
    this.updateWearingLabel();
    this.renderSlotTabs();
    this.renderGrid();

    // Server sync.
    try {
      const result = await equipCosmetic(
        this.catInstanceId,
        slot,
        cosItem?.id ?? null,
      );
      if (!result.ok) {
        // Revert.
        this.playerState.ownedCosmetics = snapshotOwnedCosmetics;
        this.playerState.equippedCosmeticTypes = snapshotEquippedTypes;
        if (!this.playerState.equippedCosmetics[this.catInstanceId]) {
          this.playerState.equippedCosmetics[this.catInstanceId] = {};
        }
        const revertSlots = this.playerState.equippedCosmetics[this.catInstanceId]!;
        if (previousInstanceId === undefined) {
          delete revertSlots[slot];
        } else {
          revertSlots[slot] = previousInstanceId;
        }
        if (Object.keys(revertSlots).length === 0) {
          delete this.playerState.equippedCosmetics[this.catInstanceId];
        }
        this.renderEquippedCosmetics();
        this.updateWearingLabel();
        this.renderSlotTabs();
        this.renderGrid();
      } else {
        Object.assign(this.playerState, result.state);
        // Re-snapshot after server response — if HEAD changed here,
        // the server's response is the source of the cross-slot bug.
        snapshotSlots('AFTER SERVER');
        // Re-render so the visual matches the server-truth state
        // (previously we skipped this and only updated visuals from
        // the optimistic mutation, so any server-truth diff went
        // unseen until the next interaction).
        this.renderEquippedCosmetics();
        this.updateWearingLabel();
        this.renderSlotTabs();
        this.renderGrid();
      }
    } catch (e) {
      console.warn('[DressingRoom] equip failed:', e);
    }
  }

  private exit(): void {
    const decorate = this.scene.get(SceneKeys.Decorate);
    if (decorate) decorate.events.emit('dressingroom:closed');
    this.scene.stop();
  }

  private cleanup(): void {
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();
    this.scale.off('resize');
    for (const slot of Object.keys(this.heroCosmetics)) {
      this.heroCosmetics[slot]?.destroy();
    }
    this.heroCosmetics = {};
    for (const slot of Object.keys(this.heroEffects)) {
      this.heroEffects[slot]?.destroy();
    }
    this.heroEffects = {};
    for (const obj of this.gridCells) obj.destroy();
    this.gridCells.length = 0;
    this.slotTabsContainer?.destroy(true);
  }
}
