import { GameObjects, Scene } from 'phaser';
import { navigateTo } from '@devvit/web/client';

/**
 * Tiny confirmation modal shown after a successful PUT ON A SHOW —
 * tells the player their post is live and gives them a tappable link
 * to the Reddit post. No actions other than DONE / OPEN POST.
 *
 * Reuses the dressing-room visual language (dark panel, yellow stroke,
 * red ✕ close). Lightweight by design — there's nothing to configure
 * here, just confirmation + a link.
 */
export class PublishedModal {
  private container: GameObjects.Container | null = null;
  /** HTML overlay button + its teardown. Held so close() can rip it out.
   *  See makeOpenOverlay() for why this isn't a plain Phaser button. */
  private overlay: { btn: HTMLButtonElement; teardown: () => void } | null = null;

  constructor(private scene: Scene) {}

  open(args: { url: string; permalink?: string; onClose?: () => void }): void {
    this.close();
    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(284, width - 24);
    const panelH = 220;
    const panelX = cx - panelW / 2;
    const panelY = cy - panelH / 2;

    this.container = this.scene.add.container(0, 0).setDepth(420);

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
      .setStrokeStyle(2, 0xffd34d, 0.85);
    this.container.add(panel);

    // Confetti emoji for the celebratory beat
    const emoji = this.scene.add
      .text(cx, panelY + 38, '🎉', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '32px',
      })
      .setOrigin(0.5);
    this.container.add(emoji);

    const title = this.scene.add
      .text(cx, panelY + 76, 'YOUR SHOW IS LIVE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '15px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.container.add(title);

    const subtitle = this.scene.add
      .text(cx, panelY + 102, 'Share the link or hit OPEN POST to\nwatch fans land on your stage.', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
        align: 'center',
        wordWrap: { width: panelW - 32 },
      })
      .setOrigin(0.5);
    this.container.add(subtitle);

    // Two buttons stacked at the bottom: DONE (left, secondary) +
    // OPEN POST (right, primary). OPEN POST navigates to the Reddit
    // post URL via window.open — Devvit allows that for own posts.
    const btnY = panelY + panelH - 38;
    const btnH = 36;
    const btnGap = 10;
    const btnW = (panelW - 32 - btnGap) / 2;
    const leftX = cx - btnW / 2 - btnGap / 2;
    const rightX = cx + btnW / 2 + btnGap / 2;

    const doneBg = this.scene.add
      .rectangle(leftX, btnY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const doneTxt = this.scene.add
      .text(leftX, btnY, 'DONE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    doneBg.on('pointerover', () => doneBg.setFillStyle(0x3d2566, 1));
    doneBg.on('pointerout', () => doneBg.setFillStyle(0x2c1856, 1));
    doneBg.on('pointerdown', () => {
      this.close();
      args.onClose?.();
    });

    // OPEN POST — Phaser visuals kept for the pixel-art look, but the
    // tap target is an HTML overlay button. Devvit's webview escape-
    // hatch APIs (navigateTo, requestExpandedMode) require a TRUSTED
    // user gesture; Phaser pointer events are JS-synthesized from
    // canvas hits and are NOT trusted, so navigateTo silently no-ops
    // and Reddit's app falls back to the subreddit landing. Splash's
    // TAP TO PLAY already uses this pattern for the same reason.
    const openBg = this.scene.add
      .rectangle(rightX, btnY, btnW, btnH, 0xffd34d, 1);
    const openTxt = this.scene.add
      .text(rightX, btnY, 'OPEN POST', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    this.container.add([doneBg, doneTxt, openBg, openTxt]);

    const openOverlay = this.makeOpenOverlay(rightX, btnY, btnW, btnH, openBg, args);
    this.overlay = openOverlay;
  }

  /** Build an HTML <button> sitting on top of the OPEN POST Phaser
   *  rectangle. Its real DOM `click` event is the trusted gesture
   *  Devvit's navigateTo needs to escape the webview. Position is
   *  recomputed on resize so the overlay tracks the canvas. */
  private makeOpenOverlay(
    rectX: number,
    rectY: number,
    rectW: number,
    rectH: number,
    visualBg: Phaser.GameObjects.Rectangle,
    args: { url: string; permalink?: string },
  ): { btn: HTMLButtonElement; teardown: () => void } {
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Open post');
    btn.style.position = 'fixed';
    btn.style.background = 'transparent';
    btn.style.border = 'none';
    btn.style.outline = 'none';
    btn.style.cursor = 'pointer';
    btn.style.padding = '0';
    btn.style.zIndex = '9999';
    document.body.appendChild(btn);

    const place = (): void => {
      const canvas = this.scene.game.canvas;
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width / this.scene.scale.width;
      const sy = rect.height / this.scene.scale.height;
      btn.style.left = `${rect.left + (rectX - rectW / 2) * sx}px`;
      btn.style.top = `${rect.top + (rectY - rectH / 2) * sy}px`;
      btn.style.width = `${rectW * sx}px`;
      btn.style.height = `${rectH * sy}px`;
    };
    place();
    const onResize = (): void => place();
    window.addEventListener('resize', onResize);

    const onClick = (e: MouseEvent): void => {
      // Trusted DOM gesture — navigateTo escapes the webview cleanly.
      // Object form so Devvit's resolver routes to the post (not the
      // subreddit landing it would infer from a plain reddit.com URL).
      const target = args.permalink
        ? { url: args.url, permalink: args.permalink }
        : args.url;
      console.info('[PublishedModal] OPEN POST (HTML overlay) tapped — target:', target, 'isTrusted:', e.isTrusted);
      try {
        navigateTo(target);
      } catch (err) {
        console.error('[PublishedModal] navigateTo threw:', err);
      }
    };
    btn.addEventListener('click', onClick);

    // Hover affordance — match the previous Phaser hover by tinting
    // the underlying rectangle on pointerenter/leave of the overlay.
    btn.addEventListener('pointerenter', () => visualBg.setFillStyle(0xffe680, 1));
    btn.addEventListener('pointerleave', () => visualBg.setFillStyle(0xffd34d, 1));

    return {
      btn,
      teardown: () => {
        window.removeEventListener('resize', onResize);
        btn.removeEventListener('click', onClick);
        if (btn.parentElement) btn.parentElement.removeChild(btn);
      },
    };
  }

  close(): void {
    this.overlay?.teardown();
    this.overlay = null;
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
  }

  destroy(): void {
    this.close();
  }
}
