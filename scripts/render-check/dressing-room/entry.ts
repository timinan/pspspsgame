/**
 * dressing-room harness — boots the REAL DressingRoom scene against the
 * real atlases with a fabricated PlayerState (all 440 effects + a spread
 * of cosmetics owned) so scroll/tab/layout changes can be pixel-verified
 * headlessly. Diagnostic tool only, never shipped.
 */
import Phaser from 'phaser';
import { DressingRoom } from '@/scenes/DressingRoom';
import { AssetKeys } from '@/constants/assets';
import { SceneKeys } from '@/constants/scenes';
import { NEW_EFFECT_CATALOG } from '@/shared/effect-catalog-gen';
import { COSMETIC_CATALOG } from '@/../shared/state';
import type { PlayerState } from '@/../shared/state';

// NO window.Phaser polyfill — the game bundle has none; polyfilling here
// masks unbound-global bugs (the 2026-07-01 strobe freeze class).

function makePlayerState(): PlayerState {
  const ownedCosmetics = [
    ...NEW_EFFECT_CATALOG.map((m, i) => ({ id: `fx${i}`, type: m.id })),
    ...COSMETIC_CATALOG.filter((c) => c.slot !== 'effect').slice(0, 60)
      .map((c, i) => ({ id: `cos${i}`, type: c.id })),
  ];
  return {
    ownedCats: [{ id: 'catA', breed: 'cat2', name: 'Butters' }],
    ownedCosmetics,
    equippedCosmetics: {},
    equippedCosmeticTypes: {},
    seatedCats: {},
    coins: 0,
  } as unknown as PlayerState;
}

class HarnessBoot extends Phaser.Scene {
  constructor() { super('HarnessBoot'); }
  preload(): void {
    this.load.atlas(AssetKeys.Atlas.Cats, 'assets/atlas/cats.png', 'assets/atlas/cats.json');
    this.load.atlas(AssetKeys.Atlas.Cosmetics, 'assets/atlas/cosmetics.png', 'assets/atlas/cosmetics.json');
  }
  create(): void {
    (window as unknown as { __ready: boolean }).__ready = true;
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: 320,
  height: 580,
  backgroundColor: '#0b041a',
  render: { preserveDrawingBuffer: true },
  scene: [HarnessBoot, DressingRoom],
});

(window as unknown as { __game: Phaser.Game }).__game = game;
(window as unknown as { __openDR: (effectsOnly: boolean) => void }).__openDR = (effectsOnly: boolean) => {
  const key = SceneKeys.DressingRoom;
  if (game.scene.isActive(key) || game.scene.isPaused(key)) game.scene.stop(key);
  game.scene.start(key, {
    catInstanceId: 'catA',
    playerState: makePlayerState(),
    effectsOnly,
  });
};
