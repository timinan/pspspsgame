import { GameObjects, Scene, Sound, Loader } from 'phaser';
import {
  BACKING_CATALOG,
  type BackingTrack,
  type BackingVibe,
} from '@/../shared/state';

const VIBE_ORDER: BackingVibe[] = ['upbeat', 'melodic', 'smooth'];
const SONGS_PER_PAGE = 5;
const PREVIEW_VOLUME = 0.6;

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
  private selectedAudioKey: string | null = null;
  private page = 0;
  private onPickRef: ((result: SongPickerResult) => void) | null = null;
  private onCancelRef: (() => void) | null = null;
  private titleText: GameObjects.Text | null = null;
  private subtitleText: GameObjects.Text | null = null;

  constructor(private scene: Scene) {}

  open(args: {
    initial?: { audioKey?: string; vibe?: BackingVibe };
    onPick: (result: SongPickerResult) => void;
    onCancel?: () => void;
  }): void {
    this.close();
    this.onPickRef = args.onPick;
    this.onCancelRef = args.onCancel ?? null;

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

    const panelW = Math.min(284, width - 24);
    const panelH = Math.min(440, height - 60);
    const cx = width / 2;
    const cy = height / 2;
    const panel = this.scene.add
      .rectangle(cx, cy, panelW, panelH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xc678ff, 0.8)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(panel);

    // Header title + subtitle (rewritten per step)
    this.titleText = this.scene.add
      .text(cx, cy - panelH / 2 + 22, 'PICK A SONG', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.container.add(this.titleText);

    this.subtitleText = this.scene.add
      .text(cx, cy - panelH / 2 + 48, 'Choose a vibe', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.container.add(this.subtitleText);

    // Decide which step to open on. If caller passed an initial audioKey
    // that's in the catalog, jump straight to the song list scrolled to
    // its page so the player sees their current pick highlighted.
    // Always land on the vibe step — Tim's rule: don't pre-jump based on
    // previous selection, the player picks fresh each time. `args.initial`
    // is now only used inside the song list to highlight the previously
    // chosen song when the user navigates to its vibe; selection state is
    // NOT carried across modal opens.
    this.showVibeStep(availableVibes);
  }

  close(): void {
    this.stopPreview();
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
    this.titleText = null;
    this.subtitleText = null;
    this.selectedVibe = null;
    this.selectedAudioKey = null;
    this.candidates = [];
    this.page = 0;
    this.onPickRef = null;
    this.onCancelRef = null;
  }

  destroy(): void {
    this.close();
  }

  // === Step 1: vibe picker ===
  private showVibeStep(vibes: BackingVibe[]): void {
    if (!this.container) return;
    this.clearStepChildren();
    // Reset selectedVibe so re-picking the SAME vibe after a BACK also
    // counts as "entering anew" and resets pagination.
    this.selectedVibe = null;
    if (this.subtitleText) this.subtitleText.setText('Choose a vibe');

    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(284, width - 24);
    const panelH = Math.min(440, height - 60);
    const btnW = panelW - 56;
    const btnH = 48;
    const gap = 12;
    const stackH = vibes.length * btnH + (vibes.length - 1) * gap;
    const topY = cy - stackH / 2 + btnH / 2;

    vibes.forEach((v, i) => {
      const y = topY + i * (btnH + gap);
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
    const cancelY = cy + panelH / 2 - 30;
    this.addCancelButton(cx, cancelY);
  }

  // === Step 2: song list ===
  private showSongList(vibe: BackingVibe): void {
    if (!this.container) return;
    this.clearStepChildren();
    const enteringSongList = this.selectedVibe !== vibe;
    this.selectedVibe = vibe;
    this.candidates = Object.values(BACKING_CATALOG).filter((b) => b.vibe === vibe);
    if (this.candidates.length === 0) {
      // Defensive: shouldn't happen because availableVibes() filters
      // empty vibes out. Fall back to vibe step.
      this.showVibeStep(this.availableVibes());
      return;
    }
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

    if (this.subtitleText) {
      const totalPages = Math.max(1, Math.ceil(this.candidates.length / SONGS_PER_PAGE));
      const pageLabel = totalPages > 1 ? `  ·  PAGE ${this.page + 1}/${totalPages}` : '';
      this.subtitleText.setText(`${vibe.toUpperCase()}${pageLabel}`);
    }

    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(284, width - 24);
    const panelH = Math.min(440, height - 60);

    // ← BACK chip top-left
    const backY = cy - panelH / 2 + 22;
    const backX = cx - panelW / 2 + 28;
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

    // Song rows
    const rowsTop = cy - panelH / 2 + 72;
    const rowW = panelW - 32;
    const rowH = 38;
    const rowGap = 6;
    const start = this.page * SONGS_PER_PAGE;
    const visible = this.candidates.slice(start, start + SONGS_PER_PAGE);

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
      const txt = this.scene.add
        .text(cx, y, song.displayName ?? song.id, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: isSelected ? '#ffd34d' : '#ffffff',
        })
        .setOrigin(0.5);
      this.container!.add([bg, txt]);
      this.stepChildren.push(bg, txt);
    });

    // Pager (only if more than one page)
    const totalPages = Math.ceil(this.candidates.length / SONGS_PER_PAGE);
    if (totalPages > 1) {
      const pagerY = rowsTop + SONGS_PER_PAGE * (rowH + rowGap) - rowGap + 14;
      const arrowSize = 24;
      const arrowGap = 90;
      const prevBg = this.scene.add
        .rectangle(cx - arrowGap / 2, pagerY, arrowSize, arrowSize, 0x2c1856, 1)
        .setStrokeStyle(1, 0xc678ff, 0.6)
        .setInteractive({ useHandCursor: true });
      const prevTxt = this.scene.add
        .text(cx - arrowGap / 2, pagerY, '◀', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: '#ffffff',
        })
        .setOrigin(0.5);
      prevBg.on('pointerdown', () => {
        this.page = (this.page - 1 + totalPages) % totalPages;
        this.showSongList(vibe);
      });
      const nextBg = this.scene.add
        .rectangle(cx + arrowGap / 2, pagerY, arrowSize, arrowSize, 0x2c1856, 1)
        .setStrokeStyle(1, 0xc678ff, 0.6)
        .setInteractive({ useHandCursor: true });
      const nextTxt = this.scene.add
        .text(cx + arrowGap / 2, pagerY, '▶', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: '#ffffff',
        })
        .setOrigin(0.5);
      nextBg.on('pointerdown', () => {
        this.page = (this.page + 1) % totalPages;
        this.showSongList(vibe);
      });
      this.container.add([prevBg, prevTxt, nextBg, nextTxt]);
      this.stepChildren.push(prevBg, prevTxt, nextBg, nextTxt);
    }

    // Footer: PREVIEW + SELECT (only when a song is highlighted)
    const footerY = cy + panelH / 2 - 32;
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
      // No selection yet: just a cancel pill
      this.addCancelButton(cx, footerY);
    }
  }

  // === helpers ===

  /** Track every per-step game object so step transitions only nuke
   *  the step's UI, not the persistent panel/scrim/title. */
  private stepChildren: GameObjects.GameObject[] = [];

  private clearStepChildren(): void {
    for (const child of this.stepChildren) child.destroy();
    this.stepChildren = [];
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
    const present = new Set<BackingVibe>();
    for (const b of Object.values(BACKING_CATALOG)) present.add(b.vibe);
    return VIBE_ORDER.filter((v) => present.has(v));
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
