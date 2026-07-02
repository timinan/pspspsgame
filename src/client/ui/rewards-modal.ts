import { GameObjects, Scene } from 'phaser';
import { collectRewards } from '@/services/state-client';
import type { PlayerState } from '@/../shared/state';

/**
 * Rewards drawer (v1) — opens from the hamburger drawer (🎁 REWARDS).
 * Replaces the old RewardsComingSoonModal. Container/backdrop/close
 * structure mirrors InboxModal (src/client/ui/inbox-modal.ts) so the
 * two drawer modals read the same.
 *
 * v1 surfaces:
 *   (a) COLLECT pot — host royalties + post milestones accrued into
 *       `economy.pendingCollect` while the owner was away. Tapping
 *       COLLECT hits POST /api/rewards/collect, adopts the returned
 *       state (await-and-adopt — no optimistic mutation), and flips the
 *       card to its 0-state.
 *   (b) DAILY QUESTS + LOGIN STREAK placeholder rows — Task 10 fills
 *       these in; the layout reserves the space now.
 */
export class RewardsModal {
  private container: GameObjects.Container | null = null;
  private getPlayerState: () => PlayerState | null = () => null;
  private busy = false;

  // Collect-card refs, rebuilt into their 0/N states by setPotState().
  private potText: GameObjects.Text | null = null;
  private collectBg: GameObjects.Rectangle | null = null;
  private collectLabel: GameObjects.Text | null = null;
  private cardCX = 0;
  private cardCY = 0;
  private cardW = 0;

  constructor(private scene: Scene) {}

  open(args: { getPlayerState: () => PlayerState | null; onClose?: () => void } = { getPlayerState: () => null }): void {
    this.close();
    this.getPlayerState = args.getPlayerState;
    this.busy = false;

    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(300, width - 24);
    const panelH = Math.min(460, height - 60);
    const panelX = cx - panelW / 2;
    const panelY = cy - panelH / 2;

    this.container = this.scene.add.container(0, 0).setDepth(450);

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

    this.container.add(
      this.scene.add
        .text(cx, panelY + 22, '🎁 REWARDS', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '18px',
          color: '#ffd34d',
        })
        .setOrigin(0.5),
    );
    this.container.add(
      this.scene.add
        .text(cx, panelY + 44, 'claim your show earnings', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '10px',
          color: '#c0a0e6',
        })
        .setOrigin(0.5),
    );

    // ✕ close
    const closeBg = this.scene.add
      .circle(panelX + panelW - 18, panelY + 18, 12, 0xff5050, 1)
      .setStrokeStyle(2, 0x0b041a, 1)
      .setInteractive({ useHandCursor: true });
    closeBg.on('pointerdown', () => {
      this.close();
      args.onClose?.();
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

    // --- (a) COLLECT pot card -----------------------------------------
    const cardTop = panelY + 66;
    const cardH = 132;
    this.cardW = panelW - 24;
    this.cardCX = cx;
    this.cardCY = cardTop + cardH / 2;

    const card = this.scene.add
      .rectangle(this.cardCX, this.cardCY, this.cardW, cardH, 0x2c1856, 1)
      .setStrokeStyle(2, 0xffd34d, 0.85);
    this.container.add(card);

    this.potText = this.scene.add
      .text(this.cardCX, this.cardCY - 32, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: this.cardW - 28 },
      })
      .setOrigin(0.5);
    this.container.add(this.potText);

    this.collectBg = this.scene.add
      .rectangle(this.cardCX, this.cardCY + 34, 150, 34, 0xffd34d, 1)
      .setStrokeStyle(2, 0x0b041a, 0.9)
      .setInteractive({ useHandCursor: true });
    this.collectBg.on('pointerdown', () => void this.onCollect());
    this.container.add(this.collectBg);

    this.collectLabel = this.scene.add
      .text(this.cardCX, this.cardCY + 34, 'COLLECT', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#0b041a',
      })
      .setOrigin(0.5);
    this.container.add(this.collectLabel);

    // --- (b) placeholder rows (Task 10 fills these) -------------------
    const rowTop = cardTop + cardH + 16;
    const rowH = 46;
    const rowGap = 10;
    const rowW = panelW - 24;
    this.addPlaceholderRow(cx, rowTop + rowH / 2, rowW, rowH, '🗓  DAILY QUESTS', 'coming next');
    this.addPlaceholderRow(cx, rowTop + rowH + rowGap + rowH / 2, rowW, rowH, '🔥  LOGIN STREAK', 'coming next');

    const pot = this.getPlayerState()?.economy?.pendingCollect ?? 0;
    this.setPotState(pot);
  }

  private addPlaceholderRow(
    cx: number,
    y: number,
    w: number,
    h: number,
    label: string,
    tag: string,
  ): void {
    const bg = this.scene.add
      .rectangle(cx, y, w, h, 0x120726, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.4);
    const title = this.scene.add
      .text(cx - w / 2 + 12, y, label, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0.5);
    const tagText = this.scene.add
      .text(cx + w / 2 - 12, y, tag, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '9px',
        color: '#7a6699',
      })
      .setOrigin(1, 0.5);
    this.container!.add([bg, title, tagText]);
  }

  /** Paint the collect card for a given pot amount. 0 → greyed button +
   *  "nothing to collect" copy; >0 → gold button + "you earned N" copy. */
  private setPotState(amount: number): void {
    if (!this.potText || !this.collectBg || !this.collectLabel) return;
    if (amount > 0) {
      this.potText.setText(`💰 Your shows earned ${amount} coins while you were away`);
      this.collectBg.setFillStyle(0xffd34d, 1);
      this.collectLabel.setText('COLLECT').setColor('#0b041a');
    } else {
      this.potText.setText('💰 Nothing to collect yet — host shows to earn');
      this.collectBg.setFillStyle(0x3a2b52, 1);
      this.collectLabel.setText('COLLECTED').setColor('#7a6699');
    }
  }

  private async onCollect(): Promise<void> {
    if (this.busy) return;
    const pot = this.getPlayerState()?.economy?.pendingCollect ?? 0;
    if (pot <= 0) return;
    this.busy = true;

    let result: { collected: number; state: PlayerState };
    try {
      result = await collectRewards();
    } catch {
      this.busy = false;
      return;
    }
    if (!this.container) return; // closed mid-fetch

    // Await-and-adopt: copy the server's fresh state onto the scene's
    // live playerState reference (getPlayerState has no setter, so we
    // mutate in place — every closure reading it sees the new values).
    const live = this.getPlayerState();
    if (live) Object.assign(live, result.state);

    // Best-effort HUD coin refresh — scenes expose `topHud` with
    // setCoins(); no-op safely on scenes that don't.
    const hud = (this.scene as { topHud?: { setCoins?: (n: number) => void } }).topHud;
    hud?.setCoins?.(result.state.coins);

    // Brief "+N 🪙" count-up feel floating off the card.
    if (result.collected > 0) {
      const fly = this.scene.add
        .text(this.cardCX, this.cardCY + 4, `+${result.collected} 🪙`, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '18px',
          color: '#ffd34d',
        })
        .setOrigin(0.5);
      this.container.add(fly);
      this.scene.tweens.add({
        targets: fly,
        y: this.cardCY - 30,
        alpha: 0,
        duration: 900,
        ease: 'Cubic.easeOut',
        onComplete: () => fly.destroy(),
      });
    }

    this.setPotState(0);
    this.busy = false;
  }

  close(): void {
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
    this.potText = null;
    this.collectBg = null;
    this.collectLabel = null;
  }

  destroy(): void {
    this.close();
  }
}
