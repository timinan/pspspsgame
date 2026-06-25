import { GameObjects, Scene } from 'phaser';
import { AssetKeys } from '@/constants/assets';
import {
  getUserSettings,
  setUserSettings,
  type UserSettings,
} from '@/systems/user-settings';
import { CAT_EFFECT_BY_ID } from '@/effects/cat-effects';

/**
 * Settings modal — reuses the dressing-room visual language (yellow
 * stroke panel + red ✕ corner + dark purple chrome). Three sliders
 * (effect size, effect transparency, music volume) + one toggle (mute).
 * Live preview on the right side fires a 🌟 burst every 1.4 s using
 * the current user-settings multipliers so the player sees their
 * changes in motion before closing.
 *
 * Settings persist via the user-settings module (localStorage). No
 * server round-trip — they're per-device, not per-Reddit-account.
 */
export class SettingsModal {
  private container: GameObjects.Container | null = null;
  private previewTimer: Phaser.Time.TimerEvent | null = null;
  /** Mute toggle bg/text refs — updated when toggle flips. */
  private muteBg: GameObjects.Rectangle | null = null;
  private muteText: GameObjects.Text | null = null;
  /** Volume slider widget so we can re-render its visual state when
   *  the mute toggle dims/restores it. */
  private volumeHandle: GameObjects.Rectangle | null = null;
  private volumeFill: GameObjects.Rectangle | null = null;

  constructor(private scene: Scene) {}

  open(args: { onClose?: () => void } = {}): void {
    this.close();
    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(300, width - 24);
    const panelH = Math.min(440, height - 60);
    const panelX = cx - panelW / 2;
    const panelY = cy - panelH / 2;

    this.container = this.scene.add.container(0, 0).setDepth(400);

    // Scrim — blocks underlying pointer events
    const scrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.78)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(scrim);

    // Panel
    const panel = this.scene.add
      .rectangle(cx, cy, panelW, panelH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xffd34d, 0.85)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(panel);

    // Title
    this.container.add(
      this.scene.add
        .text(cx, panelY + 22, 'SETTINGS', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '18px',
          color: '#ffd34d',
        })
        .setOrigin(0.5),
    );

    // ✕ close (top right)
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
      this.close();
      args.onClose?.();
    });
    this.container.add([closeBg, closeGlyph]);

    // === EFFECTS section ===
    const effectsHeaderY = panelY + 52;
    this.container.add(
      this.scene.add
        .text(panelX + 20, effectsHeaderY, 'EFFECTS', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '11px',
          color: '#c0a0e6',
        })
        .setOrigin(0, 0.5),
    );

    const settings = getUserSettings();

    // Effect size slider
    this.addSlider({
      x: panelX + 20,
      y: effectsHeaderY + 28,
      width: panelW - 130,
      label: 'SIZE',
      min: 0.3,
      max: 1.5,
      value: settings.effectSizeMul,
      onChange: (v) => setUserSettings({ effectSizeMul: v }),
    });

    // Effect alpha slider
    this.addSlider({
      x: panelX + 20,
      y: effectsHeaderY + 70,
      width: panelW - 130,
      label: 'OPACITY',
      min: 0,
      max: 1.5,
      value: settings.effectAlphaMul,
      onChange: (v) => setUserSettings({ effectAlphaMul: v }),
    });

    // Preview area — right side, fires periodic 🌟 bursts at current settings
    const previewX = panelX + panelW - 56;
    const previewY = effectsHeaderY + 52;
    this.buildPreview(previewX, previewY);

    // === AUDIO section ===
    const audioHeaderY = effectsHeaderY + 120;
    this.container.add(
      this.scene.add
        .text(panelX + 20, audioHeaderY, 'AUDIO', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '11px',
          color: '#c0a0e6',
        })
        .setOrigin(0, 0.5),
    );

    // Music volume slider — full panel width
    const volumeSlider = this.addSlider({
      x: panelX + 20,
      y: audioHeaderY + 28,
      width: panelW - 40,
      label: 'VOLUME',
      min: 0,
      max: 1,
      value: settings.musicVolume,
      onChange: (v) => {
        setUserSettings({ musicVolume: v });
        // If user adjusts volume manually, unmute (matches every
        // audio app's behavior — moving slider means "I want sound").
        if (settings.muted && v > 0) {
          setUserSettings({ muted: false });
          this.refreshMuteVisual();
        }
      },
    });
    this.volumeHandle = volumeSlider.handle;
    this.volumeFill = volumeSlider.fill;

    // Mute toggle
    this.addMuteToggle(panelX + 20, audioHeaderY + 70, panelW - 40);

    // Initial dim if muted
    this.refreshMuteVisual();

    // CANCEL at bottom
    const cancelY = panelY + panelH - 32;
    this.addCancelButton(cx, cancelY, () => {
      this.close();
      args.onClose?.();
    });
  }

  close(): void {
    if (this.previewTimer) {
      this.previewTimer.remove(false);
      this.previewTimer = null;
    }
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
    this.muteBg = null;
    this.muteText = null;
    this.volumeHandle = null;
    this.volumeFill = null;
  }

  destroy(): void {
    this.close();
  }

  // === helpers ===

  /** Slider widget — track + filled portion + draggable handle + live
   *  value label. Returns the handle + fill refs so the caller can
   *  visually dim/restore the slider (used by the volume slider when
   *  mute is on). */
  private addSlider(opts: {
    x: number;
    y: number;
    width: number;
    label: string;
    min: number;
    max: number;
    value: number;
    onChange: (v: number) => void;
  }): { handle: GameObjects.Rectangle; fill: GameObjects.Rectangle } {
    if (!this.container) {
      // Shouldn't happen — open() always runs before addSlider — but the
      // dummy stops a non-null assertion for typing.
      throw new Error('SettingsModal.addSlider called before open()');
    }
    const trackH = 4;
    const handleW = 16;
    const handleH = 22;
    const labelW = 80;
    const valueW = 40;
    const trackX = opts.x + labelW;
    const trackW = opts.width - labelW - valueW;
    const trackY = opts.y;

    // Label (left)
    this.container.add(
      this.scene.add
        .text(opts.x, opts.y, opts.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '10px',
          color: '#ffffff',
        })
        .setOrigin(0, 0.5),
    );

    // Track
    const track = this.scene.add
      .rectangle(trackX, trackY, trackW, trackH, 0x2c1856, 1)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, 0xc0a0e6, 0.4)
      .setInteractive(
        new Phaser.Geom.Rectangle(0, -handleH / 2, trackW, handleH),
        Phaser.Geom.Rectangle.Contains,
      );

    // Fill (left portion)
    const fillW = ((opts.value - opts.min) / (opts.max - opts.min)) * trackW;
    const fill = this.scene.add
      .rectangle(trackX, trackY, fillW, trackH, 0xffd34d, 0.85)
      .setOrigin(0, 0.5);

    // Handle
    const handleX = trackX + fillW;
    const handle = this.scene.add
      .rectangle(handleX, trackY, handleW, handleH, 0xffd34d, 1)
      .setStrokeStyle(2, 0x1a0a2e, 1)
      .setInteractive({ useHandCursor: true, draggable: true });

    // Value text (right)
    const valueText = this.scene.add
      .text(opts.x + opts.width, opts.y, this.fmtVal(opts.value, opts.max), {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#ffd34d',
      })
      .setOrigin(1, 0.5);

    const apply = (pointerLocalX: number): void => {
      const clamped = Math.max(0, Math.min(trackW, pointerLocalX));
      const v = opts.min + (clamped / trackW) * (opts.max - opts.min);
      const newFillW = clamped;
      fill.width = newFillW;
      handle.x = trackX + newFillW;
      valueText.setText(this.fmtVal(v, opts.max));
      opts.onChange(v);
    };

    // Drag on the handle itself
    this.scene.input.on(
      'drag',
      (_p: Phaser.Input.Pointer, target: GameObjects.GameObject, dragX: number) => {
        if (target !== handle) return;
        apply(dragX - trackX);
      },
    );

    // Tap-to-jump on the track
    track.on('pointerdown', (p: Phaser.Input.Pointer) => {
      apply(p.x - trackX);
    });

    this.container.add([track, fill, handle, valueText]);
    return { handle, fill };
  }

  private fmtVal(v: number, max: number): string {
    if (max <= 1.0) return `${Math.round(v * 100)}%`;
    return `${v.toFixed(2)}x`;
  }

  private addMuteToggle(x: number, y: number, width: number): void {
    if (!this.container) return;
    const h = 28;
    const bg = this.scene.add
      .rectangle(x, y, width, h, 0x2c1856, 1)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const txt = this.scene.add
      .text(x + width / 2, y, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    bg.on('pointerdown', () => {
      const s = getUserSettings();
      setUserSettings({ muted: !s.muted });
      this.refreshMuteVisual();
    });
    this.container.add([bg, txt]);
    this.muteBg = bg;
    this.muteText = txt;
  }

  private refreshMuteVisual(): void {
    const s = getUserSettings();
    if (this.muteBg && this.muteText) {
      const on = s.muted;
      this.muteBg.setFillStyle(on ? 0xff5050 : 0x2c1856, 1);
      this.muteBg.setStrokeStyle(2, on ? 0xff5050 : 0xc0a0e6, on ? 1 : 0.5);
      this.muteText.setText(on ? '🔇 MUTED — tap to unmute' : '🔊 SOUND ON — tap to mute');
      this.muteText.setColor(on ? '#ffffff' : '#ffffff');
    }
    // Dim the volume slider visual when muted so it reads as "this
    // doesn't do anything right now."
    if (this.volumeHandle && this.volumeFill) {
      const a = s.muted ? 0.35 : 1.0;
      this.volumeHandle.setAlpha(a);
      this.volumeFill.setAlpha(a * 0.85);
    }
  }

  private addCancelButton(cx: number, y: number, onTap: () => void): void {
    if (!this.container) return;
    const w = 110;
    const h = 32;
    const bg = this.scene.add
      .rectangle(cx, y, w, h, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const txt = this.scene.add
      .text(cx, y, 'DONE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    bg.on('pointerover', () => bg.setFillStyle(0x3d2566, 1));
    bg.on('pointerout', () => bg.setFillStyle(0x2c1856, 1));
    bg.on('pointerdown', onTap);
    this.container.add([bg, txt]);
  }

  /** Preview area on the right side of the EFFECTS section. Spawns a
   *  ⭐ burst every 1.4 s at the preview center using the live user-
   *  settings multipliers so the player can SEE their slider tweaks
   *  before closing the modal. Uses the existing makeParticleBurst path
   *  (via CAT_EFFECT_BY_ID['effect-glow-star'].burst) so it tracks any
   *  future engine changes without drift. */
  private buildPreview(centerX: number, centerY: number): void {
    if (!this.container) return;
    // Decorative box so the preview reads as its own zone
    const box = this.scene.add
      .rectangle(centerX, centerY, 80, 80, 0x0b041a, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.4);
    const label = this.scene.add
      .text(centerX, centerY + 50, 'PREVIEW', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '8px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    // Fake "target" sprite at the preview center for makeParticleBurst
    // to spawn around (it reads target.x / target.y / target.depth only).
    const fakeTarget = this.scene.add
      .image(centerX, centerY, AssetKeys.Image.PspspsTargetWhite)
      .setDisplaySize(32, 32)
      .setTint(0xffd34d)
      .setAlpha(0.55)
      .setDepth(400);
    this.container.add([box, label, fakeTarget]);

    const sparkleBurst = CAT_EFFECT_BY_ID['effect-glow-star']?.burst;
    if (!sparkleBurst) return;
    // Fire immediately so the preview isn't blank for the first 1.4 s
    sparkleBurst(this.scene, fakeTarget, 0.7);
    this.previewTimer = this.scene.time.addEvent({
      delay: 1400,
      loop: true,
      callback: () => sparkleBurst(this.scene, fakeTarget, 0.7),
    });
  }
}
