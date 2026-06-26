import { GameObjects, Scene } from 'phaser';
import {
  buildCommentBody,
  rewardWithComment,
  GIFT_COIN_PRESETS,
  GIFT_COIN_MAX,
  type PlaySummary,
  type GiftPayload,
} from '@/../shared/social-loop';

/**
 * Post-round comment composition modal — the social-loop hook screen.
 * Shows the rigid pre-filled stats block + an editable free-text line
 * (so players can sound human while the prize-hook data surface stays
 * uniform). Built-in gift slider so a tip can ride along with the
 * comment in one screen (vs Tim's brainstorm: spec was "stats + free
 * text + optional gift in one shot").
 *
 * Flow:
 *   open() — modal slides in over the summary
 *   ✏️ tap into the free-text box → keyboard input
 *   🎁 tap GIFT chip → reveal coin slider + preset chips
 *   POST → callback fires with { commentBody, gift } → caller submitPlay()
 *   SKIP → callback fires with no commentBody → caller submitPlay() (base reward only)
 *
 * No leaderboard / inbox knowledge here — modal is a pure UI surface.
 */
export class CommentComposeModal {
  private container: GameObjects.Container | null = null;
  private freeText = '';
  private giftCoins = 0;
  private giftItemInstanceIds: string[] = [];
  private giftPanelOpen = false;
  /** Re-renders dynamic parts (preview + coin label + 2x badge) on
   *  any state change. Cheaper than rebuilding the whole modal. */
  private rerender: (() => void) | null = null;

  constructor(private scene: Scene) {}

  open(args: {
    summary: PlaySummary;
    onPost: (commentBody: string, gift: GiftPayload | undefined) => void;
    onSkip: () => void;
    onCancel?: () => void;
  }): void {
    this.close();
    this.freeText = '';
    this.giftCoins = 0;
    this.giftItemInstanceIds = [];
    this.giftPanelOpen = false;
    const { summary, onPost, onSkip, onCancel } = args;

    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(300, width - 16);
    const panelH = Math.min(520, height - 40);
    const panelX = cx - panelW / 2;
    const panelY = cy - panelH / 2;

    this.container = this.scene.add.container(0, 0).setDepth(500);

    const scrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.78)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(scrim);

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
        .text(cx, panelY + 22, 'POST YOUR SCORE', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '16px',
          color: '#ffd34d',
        })
        .setOrigin(0.5),
    );
    // 2× bonus chip — sits next to the title so it's the first thing
    // the eye reads. Reward dollar value updates on toggle/gift change.
    const bonusChip = this.scene.add
      .text(cx, panelY + 44, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#a4ffb4',
      })
      .setOrigin(0.5);
    this.container.add(bonusChip);

    // ✕ close
    const closeBg = this.scene.add
      .circle(panelX + panelW - 18, panelY + 18, 12, 0xff5050, 1)
      .setStrokeStyle(2, 0x0b041a, 1)
      .setInteractive({ useHandCursor: true });
    closeBg.on('pointerdown', () => {
      this.close();
      onCancel?.();
    });
    this.container.add(closeBg);
    this.container.add(
      this.scene.add
        .text(panelX + panelW - 18, panelY + 18, '✕', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: '#ffffff',
        })
        .setOrigin(0.5),
    );

    // Free-text input zone — Phaser doesn't have native text inputs, so
    // we use an HTML overlay <textarea> positioned over the panel. Game
    // scenes pass pointer events through to canvas; the textarea floats
    // above it. Cleaned up on close.
    const taContainerY = panelY + 70;
    const taContainerH = 56;
    const taContainerW = panelW - 32;
    const taContainerX = panelX + 16;
    this.scene.add
      .rectangle(taContainerX + taContainerW / 2, taContainerY + taContainerH / 2, taContainerW, taContainerH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.45);
    const freeTextLabel = this.scene.add
      .text(taContainerX + 8, taContainerY + 6, 'SAY SOMETHING (optional)', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '8px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0);
    this.container.add(freeTextLabel);

    // HTML textarea overlay — positioned in CSS pixels matching the
    // panel's screen coords. Phaser scale.zoom is taken into account
    // by reading scene.scale.displaySize directly so the overlay tracks
    // any iframe size change. Re-positioned in updateOverlayPosition().
    const ta = document.createElement('textarea');
    ta.placeholder = 'nice run! 🐱';
    ta.style.position = 'absolute';
    ta.style.background = 'transparent';
    ta.style.color = '#ffffff';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.resize = 'none';
    ta.style.fontFamily = 'monospace';
    ta.style.fontSize = '11px';
    ta.style.padding = '2px 4px';
    ta.style.boxSizing = 'border-box';
    ta.style.zIndex = '9999';
    ta.maxLength = 240;
    document.body.appendChild(ta);
    const onTaInput = (): void => {
      this.freeText = ta.value;
      this.rerender?.();
    };
    ta.addEventListener('input', onTaInput);
    const updateOverlayPosition = (): void => {
      const canvas = this.scene.game.canvas;
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width / this.scene.scale.width;
      const sy = rect.height / this.scene.scale.height;
      ta.style.left = `${rect.left + (taContainerX + 8) * sx}px`;
      ta.style.top = `${rect.top + (taContainerY + 20) * sy}px`;
      ta.style.width = `${(taContainerW - 16) * sx}px`;
      ta.style.height = `${(taContainerH - 24) * sy}px`;
    };
    updateOverlayPosition();
    const resizeHandler = (): void => updateOverlayPosition();
    window.addEventListener('resize', resizeHandler);
    window.addEventListener('scroll', resizeHandler, true);

    // Stats preview block — what the comment will look like once posted.
    // Live re-render on free-text + gift change.
    const previewY = taContainerY + taContainerH + 14;
    const previewW = panelW - 32;
    const previewH = 140;
    this.scene.add
      .rectangle(panelX + 16 + previewW / 2, previewY + previewH / 2, previewW, previewH, 0x0b041a, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.35);
    const previewLabel = this.scene.add
      .text(panelX + 16 + 8, previewY + 6, 'COMMENT PREVIEW', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '8px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0);
    this.container.add(previewLabel);
    const previewText = this.scene.add
      .text(panelX + 16 + 8, previewY + 20, '', {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#ffffff',
        wordWrap: { width: previewW - 16 },
      })
      .setOrigin(0, 0);
    this.container.add(previewText);

    // Gift toggle row + gift panel (collapsed by default to keep the
    // modal compact for the "I just want to post" path).
    const giftToggleY = previewY + previewH + 14;
    const giftChip = this.scene.add
      .rectangle(panelX + 16 + 70, giftToggleY + 14, 140, 28, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.55)
      .setInteractive({ useHandCursor: true });
    const giftChipText = this.scene.add
      .text(panelX + 16 + 70, giftToggleY + 14, '🎁 ADD A GIFT', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    this.container.add([giftChip, giftChipText]);

    // Gift sub-panel — coin slider + 3 preset chips. Items omitted in
    // this first cut; cross-account item transfer needs the dressing-
    // room inventory picker which is a separate UI surface. The server
    // gift endpoint accepts itemInstanceIds today though.
    const giftPanelY = giftToggleY + 36;
    const giftPanelH = 80;
    const giftPanelBg = this.scene.add
      .rectangle(cx, giftPanelY + giftPanelH / 2, panelW - 32, giftPanelH, 0x0b041a, 0.6)
      .setStrokeStyle(1, 0xc0a0e6, 0.25);
    giftPanelBg.setVisible(false);
    this.container.add(giftPanelBg);

    const giftSubElements: GameObjects.GameObject[] = [];
    // Coin slider
    const sliderTrackW = panelW - 80;
    const sliderTrackX = cx - sliderTrackW / 2;
    const sliderY = giftPanelY + 24;
    const track = this.scene.add
      .rectangle(sliderTrackX, sliderY, sliderTrackW, 4, 0x2c1856, 1)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, 0xc0a0e6, 0.4)
      .setInteractive(
        new Phaser.Geom.Rectangle(0, -14, sliderTrackW, 28),
        Phaser.Geom.Rectangle.Contains,
      );
    const fill = this.scene.add
      .rectangle(sliderTrackX, sliderY, 0, 4, 0xffd34d, 0.85)
      .setOrigin(0, 0.5);
    const handle = this.scene.add
      .rectangle(sliderTrackX, sliderY, 14, 20, 0xffd34d, 1)
      .setStrokeStyle(2, 0x1a0a2e, 1)
      .setInteractive({ useHandCursor: true, draggable: true });
    const coinLabel = this.scene.add
      .text(cx, sliderY - 18, '0 coins', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    giftSubElements.push(track, fill, handle, coinLabel);
    const applySlider = (px: number): void => {
      const clamped = Math.max(0, Math.min(sliderTrackW, px));
      const v = (clamped / sliderTrackW) * GIFT_COIN_MAX;
      this.giftCoins = Math.max(0, Math.round(v / 10) * 10); // round to 10s
      const newFillW = (this.giftCoins / GIFT_COIN_MAX) * sliderTrackW;
      fill.width = newFillW;
      handle.x = sliderTrackX + newFillW;
      coinLabel.setText(`${this.giftCoins.toLocaleString()} coins`);
      this.rerender?.();
    };
    this.scene.input.on('drag', (_p: Phaser.Input.Pointer, target: GameObjects.GameObject, dragX: number) => {
      if (target !== handle) return;
      applySlider(dragX - sliderTrackX);
    });
    track.on('pointerdown', (p: Phaser.Input.Pointer) => applySlider(p.x - sliderTrackX));

    // Preset chips
    const presetY = giftPanelY + 56;
    const presetWid = 60;
    const presetGap = 12;
    const totalPresetW = GIFT_COIN_PRESETS.length * presetWid + (GIFT_COIN_PRESETS.length - 1) * presetGap;
    let px0 = cx - totalPresetW / 2 + presetWid / 2;
    for (const preset of GIFT_COIN_PRESETS) {
      const pBg = this.scene.add
        .rectangle(px0, presetY, presetWid, 22, 0x2c1856, 1)
        .setStrokeStyle(1, 0xc0a0e6, 0.55)
        .setInteractive({ useHandCursor: true });
      const pTxt = this.scene.add
        .text(px0, presetY, `${preset}`, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '10px',
          color: '#ffffff',
        })
        .setOrigin(0.5);
      pBg.on('pointerdown', () => {
        const newFillW = (preset / GIFT_COIN_MAX) * sliderTrackW;
        this.giftCoins = preset;
        fill.width = newFillW;
        handle.x = sliderTrackX + newFillW;
        coinLabel.setText(`${preset.toLocaleString()} coins`);
        this.rerender?.();
      });
      giftSubElements.push(pBg, pTxt);
      px0 += presetWid + presetGap;
    }
    for (const el of giftSubElements) {
      el.setVisible(false);
      this.container.add(el);
    }

    giftChip.on('pointerdown', () => {
      this.giftPanelOpen = !this.giftPanelOpen;
      giftPanelBg.setVisible(this.giftPanelOpen);
      for (const el of giftSubElements) el.setVisible(this.giftPanelOpen);
      giftChipText.setText(this.giftPanelOpen ? '🎁 GIFT — TAP TO HIDE' : '🎁 ADD A GIFT');
      this.rerender?.();
    });

    // POST + SKIP buttons at the bottom
    const btnY = panelY + panelH - 36;
    const postBg = this.scene.add
      .rectangle(panelX + panelW - 90, btnY, 160, 44, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    const postTxt = this.scene.add
      .text(panelX + panelW - 90, btnY, 'POST · 2×', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    postBg.on('pointerover', () => postBg.setFillStyle(0xffe680, 1));
    postBg.on('pointerout', () => postBg.setFillStyle(0xffd34d, 1));
    postBg.on('pointerdown', () => {
      const body = buildCommentBody(summary, this.freeText);
      const gift: GiftPayload | undefined =
        this.giftCoins > 0 || this.giftItemInstanceIds.length > 0
          ? { coins: this.giftCoins, itemInstanceIds: this.giftItemInstanceIds }
          : undefined;
      this.close();
      onPost(body, gift);
    });
    this.container.add([postBg, postTxt]);

    const skipBg = this.scene.add
      .rectangle(panelX + 70, btnY, 110, 44, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const skipTxt = this.scene.add
      .text(panelX + 70, btnY, 'SKIP · 1×', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    skipBg.on('pointerover', () => skipBg.setFillStyle(0x3d2566, 1));
    skipBg.on('pointerout', () => skipBg.setFillStyle(0x2c1856, 1));
    skipBg.on('pointerdown', () => {
      this.close();
      onSkip();
    });
    this.container.add([skipBg, skipTxt]);

    // Wire the re-render closure now that all refs exist.
    this.rerender = (): void => {
      const giftBlob: GiftPayload | undefined =
        this.giftCoins > 0 || this.giftItemInstanceIds.length > 0
          ? { coins: this.giftCoins, itemInstanceIds: this.giftItemInstanceIds }
          : undefined;
      const summaryWithGift: PlaySummary = giftBlob ? { ...summary, gift: giftBlob } : summary;
      previewText.setText(buildCommentBody(summaryWithGift, this.freeText));
      const final = rewardWithComment(summary.baseReward, true);
      bonusChip.setText(`Comment posted = +${summary.baseReward} bonus coins (${final} total)`);
    };
    this.rerender();

    // Stash the textarea + listeners on the container so close() tears them down.
    (this.container as unknown as { __socialModalTearDown?: () => void }).__socialModalTearDown = () => {
      ta.removeEventListener('input', onTaInput);
      window.removeEventListener('resize', resizeHandler);
      window.removeEventListener('scroll', resizeHandler, true);
      if (ta.parentElement) ta.parentElement.removeChild(ta);
    };
  }

  close(): void {
    if (this.container) {
      const tearDown = (this.container as unknown as { __socialModalTearDown?: () => void }).__socialModalTearDown;
      tearDown?.();
      this.container.destroy(true);
      this.container = null;
    }
    this.rerender = null;
  }

  destroy(): void {
    this.close();
  }
}
