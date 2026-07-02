/**
 * shop harness — boots the REAL Purchase scene's shop grid against a fake
 * player state, skipping the music + TopHud + network bits the bare harness
 * can't feed. Exposes window hooks so shoot.mjs can flip tier chips and
 * change coin balances, then screenshots each state. Extends the probe
 * pattern from scripts/render-check/rewards-modal/.
 */
import Phaser from 'phaser';
import { Purchase } from '@/scenes/Purchase';
import { DESIGN_W, DESIGN_H } from '@/constants/scene-layout';
import type { PlayerState } from '@/../shared/state';

// Crisp-text factory patch — mirrors src/client/game.ts so the harness
// renders text at the same resolution the game does.
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

function fakeState(coins: number): PlayerState {
  return {
    coins,
    ownedCats: [],
    ownedCosmetics: [],
    ownedBackgrounds: [],
  } as unknown as PlayerState;
}

// Subclass that renders only the shop grid (the code under test), skipping
// the music/HUD/loader dependencies the bare harness can't satisfy.
class HarnessPurchase extends Purchase {
  override async create(): Promise<void> {
    const self = this as unknown as {
      playerState: PlayerState;
      uiRoot: Phaser.GameObjects.Container;
      selectedTier: Record<string, string>;
      drawShop: () => void;
      redrawCards: () => void;
    };
    self.playerState = fakeState(5000);

    const { width, height } = this.scale;
    this.add.rectangle(0, 0, width, height, 0x0b041a, 1).setOrigin(0, 0);
    self.uiRoot = this.add.container(0, 0);
    self.drawShop();

    const w = window as unknown as {
      __selectTier: (cat: string, tier: string) => void;
      __setCoins: (c: number) => void;
      __ready: boolean;
    };
    w.__selectTier = (cat: string, tier: string) => {
      self.selectedTier[cat] = tier;
      self.redrawCards();
    };
    w.__setCoins = (c: number) => {
      self.playerState = fakeState(c);
      self.redrawCards();
    };
    w.__ready = true;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0b041a',
  width: DESIGN_W,
  height: DESIGN_H,
  render: { preserveDrawingBuffer: true },
  scene: [HarnessPurchase],
});
