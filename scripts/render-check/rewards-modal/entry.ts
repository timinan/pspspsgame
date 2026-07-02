/**
 * rewards-modal harness — boots a bare Phaser scene, opens the real
 * RewardsModal (src/client/ui/rewards-modal.ts) against a fake
 * getPlayerState, and exposes window hooks so shoot.mjs can screenshot
 * three states: pot=240, pot=0, and post-collect.
 */
import Phaser from 'phaser';
import { RewardsModal } from '@/ui/rewards-modal';
import { DESIGN_W, DESIGN_H } from '@/constants/scene-layout';
import type { PlayerState } from '@/../shared/state';

// Replicate the crisp-text factory patch from src/client/game.ts so the
// harness renders text the same way the game does.
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

function fakeState(pendingCollect: number, coins = 1000): PlayerState {
  return { coins, economy: { pendingCollect } } as unknown as PlayerState;
}

class HarnessScene extends Phaser.Scene {
  create(): void {
    this.add.rectangle(0, 0, DESIGN_W, DESIGN_H, 0x0b041a, 1).setOrigin(0, 0);

    let modal: RewardsModal | null = null;
    let state: PlayerState = fakeState(0);

    const w = window as unknown as {
      __open: (n: number) => void;
      __collectNow: () => Promise<void>;
      __ready: boolean;
    };

    w.__open = (n: number) => {
      state = fakeState(n);
      modal?.destroy();
      modal = new RewardsModal(this);
      modal.open({ getPlayerState: () => state });
    };

    w.__collectNow = async () => {
      // Stub fetch so collectRewards() resolves without a server: hands
      // back the pot as `collected` and a zeroed-pot state with coins
      // bumped — exactly what POST /api/rewards/collect returns.
      const pot = state.economy.pendingCollect;
      (window as unknown as { fetch: unknown }).fetch = () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              collected: pot,
              state: fakeState(0, state.coins + pot),
            }),
        });
      // onCollect is private; reach it by cast for the harness only.
      await (modal as unknown as { onCollect: () => Promise<void> }).onCollect();
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
  scene: [HarnessScene],
});
