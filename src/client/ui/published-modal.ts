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

    // OPEN POST — plain Phaser button. The previous "HTML overlay for
    // trusted gestures" approach was based on a wrong theory: I read
    // Devvit's source AFTER and confirmed navigateTo doesn't check
    // event.isTrusted at all (it's just parent.postMessage). So HTML
    // vs Phaser pointer makes zero difference to the navigation.
    // Keeping it Phaser to remove dead complexity.
    const openBg = this.scene.add
      .rectangle(rightX, btnY, btnW, btnH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    const openTxt = this.scene.add
      .text(rightX, btnY, 'OPEN POST', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    openBg.on('pointerover', () => openBg.setFillStyle(0xffe680, 1));
    openBg.on('pointerout', () => openBg.setFillStyle(0xffd34d, 1));
    openBg.on('pointerdown', () => {
      // Pass URL as a plain STRING. With the new `r/_/comments/<id>`
      // wildcard form (publish.ts), the URL's pathname does NOT match
      // permalink — so Devvit's resolveNavigationInput object-form
      // heuristic would fall back to the permalink URL (the subreddit-
      // rooted form that's been failing all day). Plain string passes
      // through unchanged to navigateTo's URL normalize + emitEffect.
      const target = args.url;
      let normalized = '<invalid>';
      try { normalized = new URL(target).toString(); } catch (err) {
        console.error('[PublishedModal] URL normalize threw:', err);
      }
      console.info('[PublishedModal] OPEN POST tapped — target:', target, 'normalized:', normalized);
      try {
        navigateTo(target);
      } catch (err) {
        console.error('[PublishedModal] navigateTo threw:', err);
      }
    });

    this.container.add([doneBg, doneTxt, openBg, openTxt]);
  }

  close(): void {
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
  }

  destroy(): void {
    this.close();
  }
}
