import { GameObjects, Scene } from 'phaser';
import {
  collectRewards,
  claimQuest,
  claimQuestBonus,
  claimStreak,
} from '@/services/state-client';
import { dailyQuestsFor, STREAK_TRACK, type DailyQuest } from '@/../shared/quests';
import { BOX_CATALOG, type BoxId, type PlayerState } from '@/../shared/state';

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
interface OpenArgs {
  getPlayerState: () => PlayerState | null;
  onClose?: () => void;
  /** UTC ISO day used to pick today's 3 quests + resolve the streak's
   *  "today". Defaults to the real UTC day; the render harness pins it. */
  isoToday?: string;
}

export class RewardsModal {
  private container: GameObjects.Container | null = null;
  private getPlayerState: () => PlayerState | null = () => null;
  private busy = false;
  private openArgs: OpenArgs | null = null;
  private isoToday = '';
  private chooser: GameObjects.Container | null = null;

  // Collect-card refs, rebuilt into their 0/N states by setPotState().
  private potText: GameObjects.Text | null = null;
  private collectBg: GameObjects.Rectangle | null = null;
  private collectLabel: GameObjects.Text | null = null;
  private cardCX = 0;
  private cardCY = 0;
  private cardW = 0;

  constructor(private scene: Scene) {}

  open(args: OpenArgs = { getPlayerState: () => null }): void {
    this.close();
    this.openArgs = args;
    this.getPlayerState = args.getPlayerState;
    this.isoToday = args.isoToday ?? new Date().toISOString().slice(0, 10);
    this.busy = false;

    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(300, width - 24);
    const panelH = Math.min(444, height - 40);
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

    // --- (b) DAILY QUESTS + LOGIN STREAK ------------------------------
    const bodyTop = cardTop + cardH + 12;
    const rowW = panelW - 24;
    this.renderQuestsSection(cx, bodyTop, rowW);
    this.renderStreakSection(cx, bodyTop + 142, rowW);

    const pot = this.getPlayerState()?.economy?.pendingCollect ?? 0;
    this.setPotState(pot);
  }

  private sectionHeader(cx: number, y: number, w: number, text: string): void {
    this.container!.add(
      this.scene.add
        .text(cx - w / 2, y, text, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '11px',
          color: '#ffd34d',
        })
        .setOrigin(0, 0.5),
    );
  }

  /** DAILY QUESTS — 3 rows for today's quests + an all-3 bonus row. */
  private renderQuestsSection(cx: number, top: number, w: number): void {
    this.sectionHeader(cx, top, w, '🗓  DAILY QUESTS');
    const daily = this.getPlayerState()?.economy?.daily;
    const progress = daily?.questProgress ?? {};
    const claimed = daily?.questClaimed ?? {};
    const quests = dailyQuestsFor(this.isoToday);

    const rowStride = 30;
    quests.forEach((q, i) => {
      this.addQuestRow(
        cx,
        top + 22 + i * rowStride,
        w,
        q,
        progress[q.id] ?? 0,
        claimed[q.id] === true,
      );
    });

    const claimedCount = quests.filter((q) => claimed[q.id] === true).length;
    this.addBonusRow(
      cx,
      top + 22 + quests.length * rowStride,
      w,
      claimedCount,
      daily?.questBonusClaimed === true,
    );
  }

  private addQuestRow(
    cx: number,
    cy: number,
    w: number,
    quest: DailyQuest,
    progress: number,
    claimed: boolean,
  ): void {
    const rowH = 26;
    const complete = progress >= quest.target;
    const bg = this.scene.add
      .rectangle(cx, cy, w, rowH, 0x120726, 1)
      .setStrokeStyle(1, complete && !claimed ? 0xffd34d : 0xc0a0e6, complete && !claimed ? 0.7 : 0.4);
    this.container!.add(bg);

    const labelColor = claimed ? '#6b8a6b' : complete ? '#ffffff' : '#c0a0e6';
    this.container!.add(
      this.scene.add
        .text(cx - w / 2 + 10, cy, quest.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '10px',
          color: labelColor,
        })
        .setOrigin(0, 0.5),
    );

    const rightX = cx + w / 2 - 10;
    if (claimed) {
      this.container!.add(
        this.scene.add
          .text(rightX, cy, '✓ CLAIMED', {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '9px',
            color: '#7ee08a',
          })
          .setOrigin(1, 0.5),
      );
    } else if (complete) {
      // Gold CLAIM button — label doubles as the reward (+N coins).
      const btnW = 60;
      const btnH = 20;
      const btnCX = rightX - btnW / 2;
      const btnBg = this.scene.add
        .rectangle(btnCX, cy, btnW, btnH, 0xffd34d, 1)
        .setStrokeStyle(2, 0x0b041a, 0.9)
        .setInteractive({ useHandCursor: true });
      btnBg.on('pointerdown', () => void this.onClaimQuest(quest.id));
      this.container!.add(btnBg);
      this.container!.add(
        this.scene.add
          .text(btnCX, cy, `+${quest.coins}`, {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '11px',
            color: '#0b041a',
          })
          .setOrigin(0.5),
      );
    } else {
      this.container!.add(
        this.scene.add
          .text(rightX, cy, `${progress}/${quest.target}`, {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '11px',
            color: '#c0a0e6',
          })
          .setOrigin(1, 0.5),
      );
    }
  }

  private addBonusRow(
    cx: number,
    cy: number,
    w: number,
    claimedCount: number,
    bonusClaimed: boolean,
  ): void {
    const rowH = 26;
    const unlocked = claimedCount >= 3;
    const bg = this.scene.add
      .rectangle(cx, cy, w, rowH, 0x1c1030, 1)
      .setStrokeStyle(1, unlocked && !bonusClaimed ? 0xffd34d : 0xc0a0e6, unlocked && !bonusClaimed ? 0.8 : 0.35);
    this.container!.add(bg);

    this.container!.add(
      this.scene.add
        .text(cx - w / 2 + 10, cy, '🎁 ALL 3 → FREE BOX', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '10px',
          color: bonusClaimed ? '#6b8a6b' : unlocked ? '#ffd34d' : '#c0a0e6',
        })
        .setOrigin(0, 0.5),
    );

    const rightX = cx + w / 2 - 10;
    if (bonusClaimed) {
      this.container!.add(
        this.scene.add
          .text(rightX, cy, '✓ CLAIMED', {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '9px',
            color: '#7ee08a',
          })
          .setOrigin(1, 0.5),
      );
    } else if (unlocked) {
      const btnW = 66;
      const btnH = 20;
      const btnCX = rightX - btnW / 2;
      const btnBg = this.scene.add
        .rectangle(btnCX, cy, btnW, btnH, 0xffd34d, 1)
        .setStrokeStyle(2, 0x0b041a, 0.9)
        .setInteractive({ useHandCursor: true });
      btnBg.on('pointerdown', () => this.openBoxChooser());
      this.container!.add(btnBg);
      this.container!.add(
        this.scene.add
          .text(btnCX, cy, 'CHOOSE', {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '10px',
            color: '#0b041a',
          })
          .setOrigin(0.5),
      );
    } else {
      this.container!.add(
        this.scene.add
          .text(rightX, cy, `${claimedCount}/3`, {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '11px',
            color: '#c0a0e6',
          })
          .setOrigin(1, 0.5),
      );
    }
  }

  /** LOGIN STREAK — 7 pips + reward label + CLAIM when claimable. */
  private renderStreakSection(cx: number, top: number, w: number): void {
    this.sectionHeader(cx, top, w, '🔥  LOGIN STREAK');
    const streak = this.getPlayerState()?.economy?.streak ?? {
      lastDay: '',
      count: 0,
      lastClaimedDay: '',
    };
    const count = Math.max(0, Math.min(7, streak.count));
    const activeToday = streak.lastDay === this.isoToday;
    const claimedToday = streak.lastClaimedDay === this.isoToday;
    const claimable = activeToday && !claimedToday && count >= 1;

    // 7 pips across the row width; filled up to `count`, today ringed.
    const pipsY = top + 26;
    const slot = w / 7;
    for (let i = 0; i < 7; i++) {
      const px = cx - w / 2 + slot * (i + 0.5);
      const filled = i < count;
      const isToday = claimable && i === count - 1;
      const pip = this.scene.add
        .circle(px, pipsY, isToday ? 9 : 8, filled ? 0xffd34d : 0x3a2b52, 1)
        .setStrokeStyle(2, isToday ? 0xffffff : 0x0b041a, isToday ? 1 : 0.6);
      this.container!.add(pip);
      this.container!.add(
        this.scene.add
          .text(px, pipsY, String(i + 1), {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '9px',
            color: filled ? '#0b041a' : '#7a6699',
          })
          .setOrigin(0.5),
      );
    }

    // Reward label (left) + CLAIM button (right).
    const rowY = top + 54;
    const reward = STREAK_TRACK[Math.max(0, count - 1)] ?? 25;
    let label: string;
    if (claimable) {
      label = count === 7 ? `Day 7: +${reward} 🪙 + Golden box` : `Day ${count}: +${reward} 🪙`;
    } else if (claimedToday) {
      label = `Day ${count} claimed ✓ — back tomorrow`;
    } else {
      label = 'Log in daily to earn coins';
    }
    this.container!.add(
      this.scene.add
        .text(cx - w / 2, rowY, label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '10px',
          color: claimable ? '#ffffff' : '#c0a0e6',
        })
        .setOrigin(0, 0.5),
    );

    if (claimable) {
      const btnW = 72;
      const btnH = 24;
      const btnCX = cx + w / 2 - btnW / 2;
      const btnBg = this.scene.add
        .rectangle(btnCX, rowY, btnW, btnH, 0xffd34d, 1)
        .setStrokeStyle(2, 0x0b041a, 0.9)
        .setInteractive({ useHandCursor: true });
      // Day 7: open the golden box chooser first; other days claim immediately.
      btnBg.on('pointerdown', () => {
        if (count === 7) {
          this.openGoldenChooser();
        } else {
          void this.onClaimStreak();
        }
      });
      this.container!.add(btnBg);
      this.container!.add(
        this.scene.add
          .text(btnCX, rowY, 'CLAIM', {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '12px',
            color: '#0b041a',
          })
          .setOrigin(0.5),
      );
    }
  }

  // --- claim handlers (await-and-adopt, then rebuild) -----------------

  private adopt(state: PlayerState): void {
    const live = this.getPlayerState();
    if (live) Object.assign(live, state);
    const hud = (this.scene as { topHud?: { setCoins?: (n: number) => void } }).topHud;
    hud?.setCoins?.(state.coins);
  }

  private rebuild(): void {
    if (this.openArgs) this.open(this.openArgs);
  }

  private async onClaimQuest(questId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await claimQuest(questId);
      if (!this.container) return;
      if (res.ok) {
        this.adopt(res.state);
        this.flyCoins(res.claimed);
        this.rebuild();
        return;
      }
    } catch {
      /* leave the drawer as-is on network error */
    }
    this.busy = false;
  }

  private async onClaimStreak(boxId?: BoxId): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await claimStreak(boxId);
      if (!this.container) return;
      if (res.ok) {
        this.adopt(res.state);
        this.flyCoins(res.claimed);
        if ('goldenPull' in res && res.goldenPull) {
          this.flyText(`🏆 ${BOX_CATALOG[boxId!]?.displayName ?? 'Golden Box'}!`);
        }
        this.rebuild();
        return;
      }
    } catch {
      /* leave the drawer as-is on network error */
    }
    this.busy = false;
  }

  /** Golden box chooser overlay for the day-7 streak reward.
   *  Shows only the four golden-tier boxes. On pick, calls claimStreak(boxId)
   *  which awards the streak coins AND performs the golden pull in one shot. */
  private openGoldenChooser(): void {
    if (this.busy || this.chooser) return;
    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const w = Math.min(240, width - 40);
    const options: Array<[BoxId, string]> = [
      ['catBoxGolden', '🐱  Golden Cat Box'],
      ['cosmeticBoxGolden', '🎀  Golden Cosmetic Box'],
      ['backgroundBoxGolden', '🖼  Golden Background Box'],
      ['effectsBoxGolden', '✨  Golden Effects Box'],
    ];
    const btnH = 32;
    const gap = 10;
    const h = 72 + options.length * (btnH + gap) + 20;
    const top = cy - h / 2;

    this.chooser = this.scene.add.container(0, 0).setDepth(470);
    const dim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.7)
      .setOrigin(0, 0)
      .setInteractive();
    dim.on('pointerdown', () => this.closeChooser());
    this.chooser.add(dim);

    const panel = this.scene.add
      .rectangle(cx, cy, w, h, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xffd34d, 0.9)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.chooser.add(panel);

    this.chooser.add(
      this.scene.add
        .text(cx, top + 22, '🏆 DAY 7 — PICK A GOLDEN BOX', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '12px',
          color: '#ffd34d',
        })
        .setOrigin(0.5),
    );
    this.chooser.add(
      this.scene.add
        .text(cx, top + 40, 'Guaranteed uncommon or better!', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '9px',
          color: '#c0a0e6',
        })
        .setOrigin(0.5),
    );

    options.forEach(([boxId, label], i) => {
      const by = top + 58 + i * (btnH + gap) + btnH / 2;
      const bg = this.scene.add
        .rectangle(cx, by, w - 28, btnH, 0x2c1856, 1)
        .setStrokeStyle(2, 0xffd34d, 0.7)
        .setInteractive({ useHandCursor: true });
      bg.on('pointerdown', () => {
        this.closeChooser();
        void this.onClaimStreak(boxId);
      });
      this.chooser!.add(bg);
      this.chooser!.add(
        this.scene.add
          .text(cx, by, label, {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '12px',
            color: '#ffffff',
          })
          .setOrigin(0.5),
      );
    });
  }

  private async onBonusPick(boxId: BoxId): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.closeChooser();
    try {
      const res = await claimQuestBonus(boxId);
      if (!this.container) return;
      if (res.ok) {
        this.adopt(res.state);
        // No coin count-up — the reward is an item; flash the box name.
        this.flyText(`🎁 ${BOX_CATALOG[boxId].displayName}!`);
        this.rebuild();
        return;
      }
    } catch {
      /* leave the drawer as-is on network error */
    }
    this.busy = false;
  }

  /** 4-way standard-box chooser overlay (cat / cosmetic / background /
   *  effects). effectsBox is offered here even though the shop doesn't
   *  sell it yet. */
  private openBoxChooser(): void {
    if (this.busy || this.chooser) return;
    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const w = Math.min(240, width - 40);
    const options: Array<[BoxId, string]> = [
      ['catBox', '🐱  Cat Box'],
      ['cosmeticBox', '🎀  Cosmetic Box'],
      ['backgroundBox', '🖼  Background Box'],
      ['effectsBox', '✨  Effects Box'],
    ];
    const btnH = 32;
    const gap = 10;
    const h = 56 + options.length * (btnH + gap) + 20;
    const top = cy - h / 2;

    this.chooser = this.scene.add.container(0, 0).setDepth(470);
    const dim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.7)
      .setOrigin(0, 0)
      .setInteractive();
    dim.on('pointerdown', () => this.closeChooser());
    this.chooser.add(dim);

    const panel = this.scene.add
      .rectangle(cx, cy, w, h, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xffd34d, 0.9)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.chooser.add(panel);

    this.chooser.add(
      this.scene.add
        .text(cx, top + 22, 'PICK YOUR FREE BOX', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '13px',
          color: '#ffd34d',
        })
        .setOrigin(0.5),
    );

    options.forEach(([boxId, label], i) => {
      const by = top + 48 + i * (btnH + gap) + btnH / 2;
      const bg = this.scene.add
        .rectangle(cx, by, w - 28, btnH, 0x2c1856, 1)
        .setStrokeStyle(2, 0xffd34d, 0.7)
        .setInteractive({ useHandCursor: true });
      bg.on('pointerdown', () => void this.onBonusPick(boxId));
      this.chooser!.add(bg);
      this.chooser!.add(
        this.scene.add
          .text(cx, by, label, {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '12px',
            color: '#ffffff',
          })
          .setOrigin(0.5),
      );
    });
  }

  private closeChooser(): void {
    if (this.chooser) {
      this.chooser.destroy(true);
      this.chooser = null;
    }
  }

  private flyText(text: string): void {
    if (!this.container) return;
    const fly = this.scene.add
      .text(this.cardCX, this.cardCY + 4, text, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '15px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.container.add(fly);
    this.scene.tweens.add({
      targets: fly,
      y: this.cardCY - 30,
      alpha: 0,
      duration: 1000,
      ease: 'Cubic.easeOut',
      onComplete: () => fly.destroy(),
    });
  }

  private flyCoins(amount: number): void {
    if (amount > 0) this.flyText(`+${amount} 🪙`);
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
    this.closeChooser();
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
