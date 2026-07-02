/**
 * summary-page3 harness — boots the REAL Game scene and drives it to
 * page-3 of the summary overlay so shoot.mjs can screenshot it in both
 * states: with comment-bonus (+50 COINS!) and without.
 */
import Phaser from 'phaser';
import { Game } from '@/scenes/Game';
import { ScoreSystem } from '@/systems/score-system';
import { DESIGN_W, DESIGN_H } from '@/constants/scene-layout';

// Replicate the crisp-text factory patch from src/client/game.ts
const DPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 2;
const TEXT_RESOLUTION = Math.max(2, Math.min(3, DPR));
const _origText = Phaser.GameObjects.GameObjectFactory.prototype.text;
Phaser.GameObjects.GameObjectFactory.prototype.text = function patched(
  this: Phaser.GameObjects.GameObjectFactory,
  x: number,
  y: number,
  text: string | string[],
  style?: Phaser.Types.GameObjects.Text.TextStyle,
) {
  return _origText.call(this, x, y, text, {
    ...(style ?? {}),
    resolution: style?.resolution ?? TEXT_RESOLUTION,
  });
};

class Page3Probe extends Game {
  // eslint-disable-next-line @typescript-eslint/require-await
  override async create(): Promise<void> {
    const self = this as unknown as Record<string, unknown> & {
      buildSummaryOverlay(): void;
      showSummary(): void;
      setSummaryPage(page: 1 | 2 | 3): void;
      summaryPage3BonusText: { setText(s: string): void; setVisible(v: boolean): void } | null;
    };
    self.visitorMode = true;
    self.testMode = false;
    self.playerState = { username: 'tester' };
    self.playChart = {
      authorId: 'host',
      title: 'Test Song',
      audioKey: 'song',
      difficulty: 'medium',
      stepCount: 72,
      bpm: 120,
      steps: [],
      holds: [],
      slides: [],
      slideReturns: [],
      updatedAt: Date.now(),
    };
    const score = new ScoreSystem();
    for (let i = 0; i < 64; i++) score.registerHit('perfect');
    for (let i = 0; i < 6; i++) score.registerHit('great');
    for (let i = 0; i < 2; i++) score.registerHit('miss');
    score.add(18420);
    self.score = score;
    self.comboText = this.add.text(DESIGN_W / 2, 20, '', {
      fontFamily: 'Pixeloid Sans, sans-serif',
    });

    self.buildSummaryOverlay();
    self.showSummary();
    self.setSummaryPage(3);

    (window as unknown as { __setBonus: (b: boolean) => void }).__setBonus = (hasBonus: boolean) => {
      if (self.summaryPage3BonusText) {
        if (hasBonus) {
          self.summaryPage3BonusText.setText('+50 COINS!');
          self.summaryPage3BonusText.setVisible(true);
        } else {
          self.summaryPage3BonusText.setText('');
          self.summaryPage3BonusText.setVisible(false);
        }
      }
    };
    (window as unknown as { __ready: boolean }).__ready = true;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0b041a',
  width: DESIGN_W,
  height: DESIGN_H,
  render: { preserveDrawingBuffer: true },
  scene: [Page3Probe],
});
