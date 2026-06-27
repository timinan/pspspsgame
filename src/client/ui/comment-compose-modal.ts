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
    // Shrunk from 520 → 300 now that COMMENT PREVIEW is gone. Modal
    // fits above the iOS keyboard so POST + SKIP are visible even
    // when the input is focused. Vertically centered shifts up since
    // the panel's shorter.
    const panelH = Math.min(300, height - 40);
    const panelX = cx - panelW / 2;
    const panelY = cy - panelH / 2;

    this.container = this.scene.add.container(0, 0).setDepth(500);

    const scrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.78)
      .setOrigin(0, 0)
      .setInteractive();
    // Scrim tap = close (cancel). Tim's bug: "modal still appearing
    // after click out x from comment" — the X target was small and
    // iOS pointerdown was getting eaten by the textarea overlay in
    // some cases. Making the scrim itself dismiss the modal gives
    // visitors a giant tap target that always works.
    scrim.on('pointerdown', () => {
      this.close();
      onCancel?.();
    });
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
    // Distinctive class so close() can sweep orphans: if for any reason
    // a previous modal's teardown didn't fire (scene torn down before
    // close ran, iOS pointer event eaten by the textarea, etc), this
    // class is the marker close() uses to remove any leaked textareas
    // from document.body. Tim hit two symptoms — the previous comment
    // text re-appearing on next open + the text overlay leaking onto
    // the game canvas after dismiss. Both root-cause to the same leak.
    ta.className = 'meowcert-comment-overlay-input';
    ta.placeholder = 'nice run! 🐱';
    // position:fixed — iOS Safari scrolls the document up when the
    // keyboard pops up, which made an absolute-positioned textarea
    // (computed off rect.top of the moving canvas) drift above the
    // label. fixed pins to the viewport so the overlay stays aligned
    // with what the user is looking at while typing.
    ta.style.position = 'fixed';
    ta.style.background = 'transparent';
    ta.style.color = '#ffffff';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.resize = 'none';
    // Pixeloid Sans matches the rest of the in-game UI; was monospace
    // (system default), which read as a system input dropped into the
    // pixel-art chrome.
    ta.style.fontFamily = '"Pixeloid Sans", sans-serif';
    // 16px is the threshold below which iOS Safari auto-zooms the
    // viewport when the input gains focus — and once auto-zoomed, the
    // splash/game viewport meta has user-scalable=no, so the user
    // can't pinch back out. That's what Tim hit (screen zoomed in +
    // locked). Slightly bigger than the rest of the modal copy but
    // typing actually works.
    ta.style.fontSize = '16px';
    ta.style.padding = '2px 4px';
    ta.style.boxSizing = 'border-box';
    ta.style.zIndex = '9999';
    // Single-line semantics keep iOS's keyboard "Done" key acting like
    // blur instead of inserting newline characters (which on a
    // textarea fires input → rerender → can deadlock under iOS's
    // scroll-into-view loop while the keyboard transitions).
    ta.rows = 1;
    ta.wrap = 'soft';
    ta.maxLength = 240;
    document.body.appendChild(ta);
    const onTaInput = (): void => {
      this.freeText = ta.value;
      this.rerender?.();
    };
    ta.addEventListener('input', onTaInput);
    // No custom Enter handler — preventDefault + blur was contributing
    // to the freeze Tim hit. Let the textarea's native single-row
    // behavior take over: iOS dismisses the keyboard on Return, the
    // input loses focus, the modal's POST button is right below the
    // input so the next tap goes through cleanly.
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
    // Only re-position on resize. The original scroll listener with
    // capture fired during iOS keyboard transitions and could enter a
    // loop with the input's scroll-into-view behavior — that loop is
    // what locked Tim's screen after he tapped Done.
    const resizeHandler = (): void => updateOverlayPosition();
    window.addEventListener('resize', resizeHandler);

    // COMMENT PREVIEW removed — Tim flagged it as redundant: visitor
    // can already see the free-text in the input above, and the stats
    // are already visible at the top of the modal. The preview block
    // was eating ~160 px of vertical space below the input, pushing
    // POST + SKIP below the iOS keyboard fold so the visitor couldn't
    // see them. previewText still exists as a stub so the rerender
    // closure has something to point at without branching everywhere.
    const previewText = { setText: (_: string): void => {} };

    // Layout order: Input → POST/SKIP (immediately under) → gift chip.
    // POST/SKIP are the primary action and must stay above the iOS
    // keyboard fold; the gift chip (a secondary opt-in) can sit
    // further down where the keyboard would cover it.
    const btnRowY = taContainerY + taContainerH + 32;       // POST + SKIP center
    const giftToggleY = btnRowY + 22 + 16;                   // gift chip top
    // (was: giftToggleY = taContainerY + taContainerH + 14 — kept above
    //  shape for the gift chip + sub-panel layout below).
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
    //
    // Renders BELOW the POST/SKIP buttons so the primary action stays
    // visible above the iOS keyboard. Only shown when the gift chip
    // is tapped, so it doesn't add vertical noise on the common path.
    const giftPanelY = giftToggleY + 46 + 44 + 14;
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

    const btnY = btnRowY;
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
    // Reset typed state so a re-open starts blank. open() already does
    // this, but doing it here too means even cancel-paths that bypass
    // open's reset stay clean.
    this.freeText = '';
    this.giftCoins = 0;
    this.giftItemInstanceIds = [];
    this.giftPanelOpen = false;
    // Belt + suspenders: sweep any leaked textarea overlays out of the
    // DOM. The tearDown closure above SHOULD be sufficient, but Tim
    // reported "exiting modal leave the comment here / comment also
    // shows up in lane" — pointing to a teardown miss. Query by the
    // distinctive class we put on every overlay we create; remove all.
    const orphans = document.querySelectorAll('textarea.meowcert-comment-overlay-input');
    orphans.forEach((el) => el.parentElement?.removeChild(el));
  }

  destroy(): void {
    this.close();
  }
}
