import { GameObjects, Scene, Sound, Loader } from 'phaser';
import {
  BACKING_CATALOG,
  BACKING_VIBES,
  BACKING_GENRES,
  BACKING_MOODS,
  type BackingTrack,
  type BackingVibe,
  type BackingGenre,
  type BackingMood,
} from '@/../shared/state';
import { CustomSongModal } from './custom-song-modal';
const SONGS_PER_PAGE = 5;
const PREVIEW_VOLUME = 0.6;

/** Dedupe + return in the catalog's canonical order. Keeps the cycle
 *  buttons predictable instead of "whatever order Object.values gave us". */
function uniqueSorted<T extends string>(values: T[]): T[] {
  const seen = new Set<T>(values);
  // Preserve canonical ordering when the set members are known constants.
  const order = (BACKING_GENRES as readonly string[]).concat(BACKING_MOODS as readonly string[]);
  const inOrder = order.filter((v) => seen.has(v as T)) as T[];
  // Anything not in the canonical lists (shouldn't happen, but defensive)
  // appends at the end in original input order.
  const extras = values.filter((v, i) => values.indexOf(v) === i && !inOrder.includes(v));
  return [...inOrder, ...extras];
}

export interface SongPickerResult {
  audioKey: string;
  bpm: number;
  vibe: BackingVibe;
}

/**
 * Two-step modal: first asks the player to pick a vibe (button grid),
 * then shows a paged list of songs at that vibe. Tap a row to highlight,
 * then PREVIEW (plays in place) or SELECT (commits + closes).
 *
 * Reuses the dressing-room visual language — purple panel, yellow primary
 * action, scrim that blocks pointer leakage to the underlying scene.
 *
 * Result carries the catalog id (used as chart.audioKey), bpm, and vibe
 * so the caller can stamp the chart consistently in one step.
 */
export class SongPickerModal {
  private container: GameObjects.Container | null = null;
  private previewSound: Sound.BaseSound | null = null;
  /** Songs available at the chosen vibe, in catalog order. */
  private candidates: BackingTrack[] = [];
  private selectedVibe: BackingVibe | null = null;
  /** Optional genre filter — 'all' means no filter. Cycles through
   *  available genres + 'all' on the song-list step's GENRE dropdown. */
  private selectedGenre: BackingGenre | 'all' = 'all';
  /** Optional mood filter — same shape as selectedGenre. */
  private selectedMood: BackingMood | 'all' = 'all';
  private selectedAudioKey: string | null = null;
  private page = 0;
  private showCustomSongTile = false;
  private customSongModal: CustomSongModal | null = null;
  private onPickRef: ((result: SongPickerResult) => void) | null = null;
  private onCancelRef: (() => void) | null = null;

  constructor(private scene: Scene) {}

  open(args: {
    initial?: { audioKey?: string; vibe?: BackingVibe };
    onPick: (result: SongPickerResult) => void;
    onCancel?: () => void;
    /** Show a "CUSTOM SONG" entry at the top of the vibe step that
     *  routes into the local-only custom-song flow. Set true only on
     *  the rehearsal entry path — charts that get posted publicly must
     *  use catalog songs (no copyright surface for shared content). */
    showCustomSong?: boolean;
  }): void {
    this.close();
    this.onPickRef = args.onPick;
    this.onCancelRef = args.onCancel ?? null;
    this.showCustomSongTile = args.showCustomSong === true;

    const availableVibes = this.availableVibes();
    if (availableVibes.length === 0) {
      console.warn('[SongPickerModal] no backings in catalog, refusing to open');
      args.onCancel?.();
      return;
    }

    const { width, height } = this.scene.scale;
    this.container = this.scene.add.container(0, 0).setDepth(400);

    const scrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.78)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(scrim);

    // Always land on the vibe step — Tim's rule: don't pre-jump based
    // on previous selection, the player picks fresh each time.
    this.showVibeStep(availableVibes);
  }

  close(): void {
    this.stopPreview();
    this.customSongModal?.close();
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
    this.chromeChildren = [];
    this.stepChildren = [];
    this.selectedVibe = null;
    this.selectedAudioKey = null;
    this.candidates = [];
    this.page = 0;
    this.onPickRef = null;
    this.onCancelRef = null;
  }

  /** Hand off to the custom-song flow, then fire the picker's onPick
   *  with the result so the caller treats it like any other song pick
   *  (audioKey='custom' routes the downstream code into the IndexedDB
   *  blob path in MusicSystem). */
  private openCustomSongModal(): void {
    if (!this.customSongModal) this.customSongModal = new CustomSongModal(this.scene);
    this.customSongModal.open({
      onDone: (result) => {
        const cb = this.onPickRef;
        this.close();
        cb?.({ audioKey: result.audioKey, bpm: result.bpm, vibe: result.vibe });
      },
      // Cancelled custom flow leaves the SongPicker open on the vibe
      // step so the player can pick a catalog song instead.
      onCancel: () => { /* no-op — picker stays open */ },
    });
  }

  destroy(): void {
    this.close();
  }

  // === Step 1: vibe picker ===
  private showVibeStep(vibes: BackingVibe[]): void {
    if (!this.container) return;
    // Reset selectedVibe so re-picking the SAME vibe after a BACK also
    // counts as "entering anew" and resets pagination.
    this.selectedVibe = null;

    const btnW = Math.min(284, this.scene.scale.width - 24) - 56;
    const btnH = 48;
    const btnGap = 12;
    // Custom-song tile (rehearsal entry only) prepends an extra row at
    // the top of the stack so it's the first thing the player sees.
    const totalRows = vibes.length + (this.showCustomSongTile ? 1 : 0);
    const stackH = totalRows * btnH + Math.max(0, totalRows - 1) * btnGap;
    // Title area (~70px) + stack + gap + cancel (32) + pad
    const panelH = SongPickerModal.TITLE_AREA_H + stackH + 24 + 32 + 20;

    const { panelX, panelY, panelW, cx } = this.renderChrome(panelH, 'PICK A SONG', 'Choose a vibe');

    let rowIndex = 0;
    const topY = panelY + SongPickerModal.TITLE_AREA_H + btnH / 2;

    if (this.showCustomSongTile) {
      const y = topY;
      // Distinct chrome — yellow primary action color — so the custom
      // entry reads as "different thing" vs the regular vibe options.
      const bg = this.scene.add
        .rectangle(cx, y, btnW, btnH, 0xffd34d, 1)
        .setInteractive({ useHandCursor: true });
      bg.on('pointerover', () => bg.setFillStyle(0xffe680, 1));
      bg.on('pointerout', () => bg.setFillStyle(0xffd34d, 1));
      bg.on('pointerdown', () => this.openCustomSongModal());
      const txt = this.scene.add
        .text(cx, y, '🎵  CUSTOM SONG', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#1a0a2e',
        })
        .setOrigin(0.5);
      this.container!.add([bg, txt]);
      this.stepChildren.push(bg, txt);
      rowIndex++;
    }

    vibes.forEach((v, i) => {
      const y = topY + (rowIndex + i) * (btnH + btnGap);
      const bg = this.scene.add
        .rectangle(cx, y, btnW, btnH, 0x2c1856, 1)
        .setStrokeStyle(2, 0xc678ff, 0.8)
        .setInteractive({ useHandCursor: true });
      bg.on('pointerover', () => bg.setFillStyle(0x3d2566, 1));
      bg.on('pointerout', () => bg.setFillStyle(0x2c1856, 1));
      bg.on('pointerdown', () => this.showSongList(v));
      const txt = this.scene.add
        .text(cx, y, v.toUpperCase(), {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '16px',
          color: '#ffffff',
        })
        .setOrigin(0.5);
      this.container!.add([bg, txt]);
      this.stepChildren.push(bg, txt);
    });

    // Cancel pill at the bottom of the panel
    this.addCancelButton(cx, panelY + panelH - 30);
    // panelX/panelW unused here but returned by renderChrome for parity.
    void panelX; void panelW;
  }

  // === Step 2: song list ===
  private showSongList(vibe: BackingVibe): void {
    if (!this.container) return;
    const enteringSongList = this.selectedVibe !== vibe;
    this.selectedVibe = vibe;
    // Step 1: vibe filter (existing behavior). The full vibe pool is what
    // the genre/mood dropdowns later filter against.
    const vibePool = Object.values(BACKING_CATALOG).filter((b) => b.vibe === vibe);
    if (vibePool.length === 0) {
      // Defensive: shouldn't happen because availableVibes() filters
      // empty vibes out. Fall back to vibe step.
      this.showVibeStep(this.availableVibes());
      return;
    }
    // Step 2: layered genre + mood filters (cycle dropdowns). 'all' is
    // the no-filter sentinel. Compute available options BEFORE filtering
    // so the dropdown can only offer values that actually exist in the
    // vibe pool — otherwise tapping the dropdown could land on a value
    // with zero results.
    const availableGenres = uniqueSorted(vibePool.map((b) => b.genre).filter(Boolean) as BackingGenre[]);
    const availableMoods = uniqueSorted(vibePool.map((b) => b.mood).filter(Boolean) as BackingMood[]);
    // If the selected filter is no longer in the pool (vibe changed),
    // snap it back to 'all'.
    if (this.selectedGenre !== 'all' && !availableGenres.includes(this.selectedGenre)) {
      this.selectedGenre = 'all';
    }
    if (this.selectedMood !== 'all' && !availableMoods.includes(this.selectedMood)) {
      this.selectedMood = 'all';
    }
    this.candidates = vibePool
      .filter((b) => {
        if (this.selectedGenre !== 'all' && b.genre !== this.selectedGenre) return false;
        if (this.selectedMood !== 'all' && b.mood !== this.selectedMood) return false;
        return true;
      })
      // Alphabetical by display name (case-insensitive, locale-aware). Was
      // catalog insertion order — fine while there were 5 songs, useless
      // now that the catalog spans dozens and the player wants to find a
      // specific title without scrubbing every page.
      .sort((a, b) =>
        (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id, undefined, { sensitivity: 'base' }),
      );

    // Per-vibe pagination: every transition from the vibe step into a
    // song list resets the page to 0. Tim's rule: pages should be
    // independent between vibes; clicking ▶ on melodic shouldn't pre-
    // advance upbeat. Re-renders within the same list (pager click, row
    // tap, preview toggle) preserve `this.page`.
    if (enteringSongList) {
      this.page = 0;
      // Drop selection if it doesn't belong to this vibe's candidates.
      if (this.selectedAudioKey && !this.candidates.some((b) => b.id === this.selectedAudioKey)) {
        this.selectedAudioKey = null;
      }
    }

    const rowH = 38;
    const rowGap = 6;
    const start = this.page * SONGS_PER_PAGE;
    const visible = this.candidates.slice(start, start + SONGS_PER_PAGE);
    const totalPages = Math.max(1, Math.ceil(this.candidates.length / SONGS_PER_PAGE));
    const rowsH = Math.max(rowH, visible.length * rowH + (visible.length - 1) * rowGap);
    // Filter cycle-buttons row (GENRE + MOOD) sits between the title
    // chrome and the song rows. 28px row height + 8px gap above + 8px
    // gap below. Always present so the filters are always available.
    const filtersRowH = 28 + 8 + 8;

    // Footer below rows: PREVIEW + SELECT (38h) if a row is highlighted,
    // else just CANCEL (32h). Gap above footer 12.
    const footerH = this.selectedAudioKey ? 38 : 32;
    // Pager strip at the very bottom (28h + 14 gap above) when multi-page.
    const pagerStripH = totalPages > 1 ? 28 + 14 : 0;
    const contentH = filtersRowH + rowsH + 12 + footerH + pagerStripH;
    const desiredH = SongPickerModal.TITLE_AREA_H + contentH + 20;
    const maxH = Math.min(480, this.scene.scale.height - 60);
    const panelH = Math.min(maxH, desiredH);

    const { panelX, panelW, panelY, cx } = this.renderChrome(panelH, 'PICK A SONG', vibe.toUpperCase());

    // ← BACK chip top-left, sitting in the chrome row alongside the title
    const backY = panelY + 22;
    const backX = panelX + 28;
    const backChip = this.scene.add
      .text(backX, backY, '← BACK', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    backChip.on('pointerdown', () => {
      this.selectedAudioKey = null;
      this.stopPreview();
      this.showVibeStep(this.availableVibes());
    });
    this.container.add(backChip);
    this.stepChildren.push(backChip);

    // GENRE + MOOD dropdown filters — sit in the filtersRowH band
    // between the chrome title and the song rows. Tapping opens a
    // pop-up list of options (replacing the old cycle-tap pattern
    // that felt opaque on long lists like the new user-added genres).
    const filtersY = panelY + SongPickerModal.TITLE_AREA_H + 8 + 14;
    const filterW = (panelW - 48) / 2; // 16 outer pad + 16 gap between
    const genreX = panelX + 16 + filterW / 2;
    const moodX = panelX + panelW - 16 - filterW / 2;
    const genreCycle: (BackingGenre | 'all')[] = ['all', ...availableGenres];
    const moodCycle: (BackingMood | 'all')[] = ['all', ...availableMoods];
    this.addDropdownFilter(genreX, filtersY, filterW, 'GENRE', this.selectedGenre, genreCycle, (next) => {
      this.selectedGenre = next;
      this.page = 0;
      this.showSongList(vibe);
    });
    this.addDropdownFilter(moodX, filtersY, filterW, 'MOOD', this.selectedMood, moodCycle, (next) => {
      this.selectedMood = next;
      this.page = 0;
      this.showSongList(vibe);
    });

    // Song rows
    const rowsTop = panelY + SongPickerModal.TITLE_AREA_H + filtersRowH;
    const rowW = panelW - 32;

    if (visible.length === 0) {
      // Filters yielded nothing — show a friendly message in place of rows.
      const empty = this.scene.add
        .text(cx, rowsTop + rowH / 2, 'No songs match these filters', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '11px',
          color: '#c0a0e6',
        })
        .setOrigin(0.5);
      this.container.add(empty);
      this.stepChildren.push(empty);
    }

    visible.forEach((song, i) => {
      const y = rowsTop + i * (rowH + rowGap) + rowH / 2;
      const isSelected = song.id === this.selectedAudioKey;
      const bg = this.scene.add
        .rectangle(cx, y, rowW, rowH, isSelected ? 0x4d2d8c : 0x2c1856, 1)
        .setStrokeStyle(2, isSelected ? 0xffd34d : 0xc678ff, isSelected ? 1 : 0.5)
        .setInteractive({ useHandCursor: true });
      bg.on('pointerdown', () => {
        if (this.selectedAudioKey === song.id) return;
        this.selectedAudioKey = song.id;
        this.stopPreview();
        this.showSongList(vibe);
      });
      const fullName = song.displayName ?? song.id;
      const txt = this.scene.add
        .text(cx, y, fullName, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: isSelected ? '#ffd34d' : '#ffffff',
        })
        .setOrigin(0.5);
      // Truncate with ellipsis so long display names ("Mahalia - I Wish
      // I Missed My Ex (Lyrics)") don't bleed past the row's bg edges.
      this.ellipsizeToWidth(txt, fullName, rowW - 16);
      this.container!.add([bg, txt]);
      this.stepChildren.push(bg, txt);
    });

    // Footer: PREVIEW + SELECT (when selected) or CANCEL — sits just
    // below the song rows, not at the very bottom (Tim's rule).
    const footerY = rowsTop + rowsH + 12 + footerH / 2;
    if (this.selectedAudioKey) {
      const footBtnW = 110;
      const footBtnH = 38;
      const footGap = 12;
      const previewX = cx - footBtnW / 2 - footGap / 2;
      const selectX = cx + footBtnW / 2 + footGap / 2;

      const isPreviewing = this.previewSound?.isPlaying ?? false;
      const previewBg = this.scene.add
        .rectangle(previewX, footerY, footBtnW, footBtnH, 0x2c1856, 1)
        .setStrokeStyle(2, isPreviewing ? 0xffd34d : 0xc678ff, isPreviewing ? 1 : 0.7)
        .setInteractive({ useHandCursor: true });
      const previewTxt = this.scene.add
        .text(previewX, footerY, isPreviewing ? '■ STOP' : '▶ PREVIEW', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: isPreviewing ? '#ffd34d' : '#ffffff',
        })
        .setOrigin(0.5);
      previewBg.on('pointerdown', () => {
        if (this.previewSound?.isPlaying) {
          this.stopPreview();
        } else {
          this.startPreview();
        }
        this.showSongList(vibe);
      });

      const selectBg = this.scene.add
        .rectangle(selectX, footerY, footBtnW, footBtnH, 0xffd34d, 1)
        .setInteractive({ useHandCursor: true });
      const selectTxt = this.scene.add
        .text(selectX, footerY, 'SELECT', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#1a0a2e',
        })
        .setOrigin(0.5);
      selectBg.on('pointerover', () => selectBg.setFillStyle(0xffe680, 1));
      selectBg.on('pointerout', () => selectBg.setFillStyle(0xffd34d, 1));
      selectBg.on('pointerdown', () => this.commitSelection());
      this.container.add([previewBg, previewTxt, selectBg, selectTxt]);
      this.stepChildren.push(previewBg, previewTxt, selectBg, selectTxt);
    } else {
      this.addCancelButton(cx, footerY);
    }

    // Pager (yellow arrows, page label between) anchored at panel bottom.
    if (totalPages > 1) {
      const pagerY = panelY + panelH - 18;
      const pageTxt = this.scene.add
        .text(cx, pagerY, `${this.page + 1} / ${totalPages}`, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: '#ffffff',
        })
        .setOrigin(0.5);
      this.container.add(pageTxt);
      this.stepChildren.push(pageTxt);
      const prev = this.makeArrow(panelX + 28, pagerY, '◀', () => {
        this.page = (this.page - 1 + totalPages) % totalPages;
        this.showSongList(vibe);
      });
      const next = this.makeArrow(panelX + panelW - 28, pagerY, '▶', () => {
        this.page = (this.page + 1) % totalPages;
        this.showSongList(vibe);
      });
      this.container.add([prev, next]);
      this.stepChildren.push(prev, next);
    }
  }

  // === helpers ===

  /** Top-of-panel reserved height for title + subtitle + ✕ + BACK chip. */
  private static readonly TITLE_AREA_H = 72;

  /** Per-step children (everything except scrim) — recreated every time
   *  `showVibeStep` or `showSongList` runs so dynamic panel height works. */
  private stepChildren: GameObjects.GameObject[] = [];
  /** Filter-popup children (dropdown's option list + dismiss scrim).
   *  Torn down via closeFilterPopup() either on selection or click-out. */
  private filterPopupChildren: GameObjects.GameObject[] = [];
  /** Panel chrome (panel rect, title, subtitle, ✕). Same lifecycle as
   *  stepChildren — destroyed and rebuilt each step transition. */
  private chromeChildren: GameObjects.GameObject[] = [];

  private clearStepChildren(): void {
    // Filter popup is logically part of the step — when the step
    // re-renders, drop any open popup first so it doesn't leak.
    this.closeFilterPopup();
    for (const child of this.stepChildren) child.destroy();
    this.stepChildren = [];
    for (const child of this.chromeChildren) child.destroy();
    this.chromeChildren = [];
  }

  /** Build (or rebuild) the panel + title + subtitle + ✕ close button at
   *  the given height. Returns the panel's bounds so step content can
   *  position relative to them. */
  private renderChrome(
    panelH: number,
    title: string,
    subtitle: string,
  ): { panelX: number; panelY: number; panelW: number; cx: number; cy: number } {
    this.clearStepChildren();
    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(284, width - 24);
    const clampedH = Math.min(panelH, Math.min(440, height - 60));
    const panelX = cx - panelW / 2;
    const panelY = cy - clampedH / 2;

    const panel = this.scene.add
      .rectangle(cx, cy, panelW, clampedH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xffd34d, 0.85)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );

    const titleText = this.scene.add
      .text(cx, panelY + 22, title, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);

    const subtitleText = this.scene.add
      .text(cx, panelY + 48, subtitle, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);

    const closeR = 12;
    const closeCx = panelX + panelW - 18;
    const closeCy = panelY + 18;
    const closeBg = this.scene.add
      .circle(closeCx, closeCy, closeR, 0xff5050, 1)
      .setStrokeStyle(2, 0x0b041a, 1)
      .setInteractive({ useHandCursor: true });
    const closeGlyph = this.scene.add
      .text(closeCx, closeCy, '✕', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    closeBg.on('pointerdown', () => {
      const cb = this.onCancelRef;
      this.close();
      cb?.();
    });

    this.container!.add([panel, titleText, subtitleText, closeBg, closeGlyph]);
    this.chromeChildren.push(panel, titleText, subtitleText, closeBg, closeGlyph);
    return { panelX, panelY, panelW, cx, cy };
  }

  /** Dropdown filter widget — `LABEL: VALUE ▼` chip that opens a
   *  popup list of options on tap. Tap outside the popup or pick a
   *  value to close it. Replaces the old cycle-on-tap pattern that
   *  was opaque on long taxonomy lists (15+ genres etc). */
  private addDropdownFilter<T extends string>(
    cx: number,
    cy: number,
    width: number,
    label: string,
    current: T,
    options: T[],
    onChange: (next: T) => void,
  ): void {
    if (!this.container) return;
    const h = 28;
    const isFiltered = current !== 'all';
    const bg = this.scene.add
      .rectangle(cx, cy, width, h, 0x2c1856, 1)
      .setStrokeStyle(1, isFiltered ? 0xffd34d : 0xc0a0e6, isFiltered ? 1 : 0.5)
      .setInteractive({ useHandCursor: true });
    const display = current === 'all' ? 'ALL' : current.toUpperCase().replace(/-/g, ' ');
    const txt = this.scene.add
      .text(cx, cy, `${label}: ${display} ▼`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: isFiltered ? '#ffd34d' : '#ffffff',
      })
      .setOrigin(0.5);
    bg.on('pointerdown', () => this.openFilterPopup(cx, cy + h / 2 + 4, width, options, current, onChange));
    this.container.add([bg, txt]);
    this.stepChildren.push(bg, txt);
  }

  /** Render a scrollable-ish popup list of options below a dropdown
   *  chip. Tap an option → fire onChange (which triggers re-render
   *  that destroys this popup along with the rest of stepChildren).
   *  Tap outside → close popup. Caps at 8 visible options; longer
   *  lists scroll (mobile pinch / scroll gesture works since this
   *  is a regular Phaser scrollable container — kept simple for now
   *  by just showing all rows + relying on the modal scrim for
   *  click-outside dismissal). */
  private openFilterPopup<T extends string>(
    anchorX: number,
    topY: number,
    width: number,
    options: T[],
    current: T,
    onChange: (next: T) => void,
  ): void {
    if (!this.container) return;
    this.closeFilterPopup();
    const rowH = 26;
    const maxRows = Math.min(options.length, 9);
    const popupH = maxRows * rowH + 6;
    const popupBg = this.scene.add
      .rectangle(anchorX, topY + popupH / 2, width, popupH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xffd34d, 1)
      .setInteractive();
    popupBg.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    popupBg.setDepth(500);
    this.filterPopupChildren.push(popupBg);
    options.slice(0, maxRows).forEach((opt, i) => {
      const y = topY + 3 + i * rowH + rowH / 2;
      const isCurrent = opt === current;
      const rowBg = this.scene.add
        .rectangle(anchorX, y, width - 4, rowH - 2, isCurrent ? 0x4d2d8c : 0x2c1856, 1)
        .setInteractive({ useHandCursor: true })
        .setDepth(501);
      const display = opt === 'all' ? 'ALL' : opt.toUpperCase().replace(/-/g, ' ');
      const rowText = this.scene.add
        .text(anchorX, y, display, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '10px',
          color: isCurrent ? '#ffd34d' : '#ffffff',
        })
        .setOrigin(0.5)
        .setDepth(502);
      rowBg.on('pointerover', () => rowBg.setFillStyle(isCurrent ? 0x4d2d8c : 0x3d2566, 1));
      rowBg.on('pointerout', () => rowBg.setFillStyle(isCurrent ? 0x4d2d8c : 0x2c1856, 1));
      rowBg.on('pointerdown', () => {
        this.closeFilterPopup();
        onChange(opt);
      });
      this.filterPopupChildren.push(rowBg, rowText);
    });
    // Dismiss-on-outside scrim — sits behind the popup but in front of
    // the rest of the modal. Tap anywhere outside the popup → close.
    const dismissScrim = this.scene.add
      .rectangle(0, 0, this.scene.scale.width, this.scene.scale.height, 0x000000, 0.001)
      .setOrigin(0, 0)
      .setInteractive()
      .setDepth(499);
    dismissScrim.on('pointerdown', () => this.closeFilterPopup());
    this.filterPopupChildren.unshift(dismissScrim); // first to destroy
    for (const el of this.filterPopupChildren) {
      this.container.add(el);
    }
  }

  private closeFilterPopup(): void {
    for (const el of this.filterPopupChildren) el.destroy();
    this.filterPopupChildren = [];
  }

  /** Shrink a display string with "…" suffix until it fits maxWidth at
   *  the text's current font. Binary-searches over the source string
   *  so it's O(log N) measurements per call. */
  private ellipsizeToWidth(t: GameObjects.Text, fullText: string, maxWidth: number): void {
    t.setText(fullText);
    if (t.width <= maxWidth) return;
    let lo = 0;
    let hi = fullText.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      t.setText(fullText.slice(0, mid) + '…');
      if (t.width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    t.setText(fullText.slice(0, lo) + '…');
  }

  /** Pager arrow matching DressingRoom's makeArrow: 36×28 dark-purple
   *  rect, light-purple stroke, yellow-glyph centered label. */
  private makeArrow(x: number, y: number, label: string, onTap: () => void): GameObjects.Container {
    const c = this.scene.add.container(x, y);
    const bg = this.scene.add
      .rectangle(0, 0, 36, 28, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const text = this.scene.add
      .text(0, 0, label, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    c.add([bg, text]);
    bg.on('pointerdown', onTap);
    return c;
  }

  private addCancelButton(cx: number, y: number): void {
    if (!this.container) return;
    const w = 110;
    const h = 32;
    const bg = this.scene.add
      .rectangle(cx, y, w, h, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const txt = this.scene.add
      .text(cx, y, 'CANCEL', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    bg.on('pointerover', () => bg.setFillStyle(0x3d2566, 1));
    bg.on('pointerout', () => bg.setFillStyle(0x2c1856, 1));
    bg.on('pointerdown', () => {
      const cb = this.onCancelRef;
      this.close();
      cb?.();
    });
    this.container.add([bg, txt]);
    this.stepChildren.push(bg, txt);
  }

  private availableVibes(): BackingVibe[] {
    // Vibes that BOTH (a) appear on at least one song in the catalog
    // and (b) are listed in BACKING_VIBES (which sync-catalog
    // regenerates from tools/music/taxonomies.json — so any custom
    // vibe Tim adds via the calibrator's "+ add new…" shows up here).
    // Then append any catalog vibes that weren't in BACKING_VIBES at
    // the bottom so nothing the player has tagged silently disappears.
    const present = new Set<BackingVibe>();
    for (const b of Object.values(BACKING_CATALOG)) present.add(b.vibe);
    const inOrder = BACKING_VIBES.filter((v) => present.has(v));
    const extras: BackingVibe[] = [];
    for (const v of present) {
      if (!inOrder.includes(v)) extras.push(v);
    }
    return [...inOrder, ...extras];
  }

  private commitSelection(): void {
    if (!this.selectedAudioKey) return;
    const entry = BACKING_CATALOG[this.selectedAudioKey];
    if (!entry) return;
    const cb = this.onPickRef;
    const result: SongPickerResult = {
      audioKey: entry.id,
      bpm: entry.bpm,
      vibe: entry.vibe,
    };
    this.close();
    cb?.(result);
  }

  /** Every audio key we've ever started a preview for. Used by
   *  stopPreview to nuke orphans — Phaser's scene-level sound manager
   *  keeps Sound instances alive even after our `previewSound` ref is
   *  null'd, and rapid preview/select cycles plus async loader callbacks
   *  could otherwise leak a playing preview into the rehearsal scene. */
  private startedKeys = new Set<string>();

  private startPreview(): void {
    this.stopPreview();
    if (!this.selectedAudioKey) return;
    const entry = BACKING_CATALOG[this.selectedAudioKey];
    if (!entry) return;
    const loader = this.scene.load;
    const begin = () => {
      const sound = this.scene.sound.add(entry.audioKey, {
        loop: true,
        volume: PREVIEW_VOLUME,
      });
      this.previewSound = sound;
      this.startedKeys.add(entry.audioKey);
      sound.play();
    };
    if (this.scene.cache.audio.exists(entry.audioKey)) {
      begin();
      return;
    }
    loader.audio(entry.audioKey, `assets/audio/backings/${entry.id}.mp3`);
    loader.once(Loader.Events.COMPLETE, () => {
      if (!this.container) return;
      if (this.selectedAudioKey !== entry.id) return;
      begin();
      if (this.selectedVibe) this.showSongList(this.selectedVibe);
    });
    if (!loader.isLoading()) loader.start();
  }

  private stopPreview(): void {
    if (this.previewSound) {
      try { this.previewSound.stop(); } catch {}
      try { this.previewSound.destroy(); } catch {}
      this.previewSound = null;
    }
    // Defense in depth: also kill ANY scene-level sounds for keys we
    // ever previewed — covers orphans from rapid retap or late loader
    // callbacks that could spawn a fresh Sound after `previewSound`
    // was already cleared.
    for (const key of this.startedKeys) {
      const matches = this.scene.sound.getAll(key);
      for (const s of matches) {
        try { s.stop(); } catch {}
        try { s.destroy(); } catch {}
      }
    }
    this.startedKeys.clear();
  }
}
