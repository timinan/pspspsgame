import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { SettingsModal } from '@/ui/settings-modal';
import { RewardsComingSoonModal } from '@/ui/rewards-coming-soon-modal';
import type { DrawerItem } from '@/ui/top-hud';
import type { PlayerState } from '@/../shared/state';

interface MenuModalCache {
  settings?: SettingsModal;
  rewards?: RewardsComingSoonModal;
}

const modalCache = new WeakMap<Scene, MenuModalCache>();

function modalsFor(scene: Scene): MenuModalCache {
  let cache = modalCache.get(scene);
  if (!cache) {
    cache = {};
    modalCache.set(scene, cache);
    scene.events.once('shutdown', () => modalCache.delete(scene));
  }
  return cache;
}

function openSettings(scene: Scene): void {
  const cache = modalsFor(scene);
  if (!cache.settings) cache.settings = new SettingsModal(scene);
  cache.settings.open();
}

function openRewards(scene: Scene): void {
  const cache = modalsFor(scene);
  if (!cache.rewards) cache.rewards = new RewardsComingSoonModal(scene);
  cache.rewards.open();
}

/**
 * Single source of truth for the hamburger drawer menu items. Every
 * scene that mounts a TopHud uses this so the seven entries stay in
 * lockstep across the app — Tim's rule: same menu, same order, on every
 * page.
 *
 * The order is: SET STAGE · REHEARSE · PUT ON A SHOW · MERCH · CATCH A
 * SHOW · REWARDS · SETTINGS. REWARDS is a placeholder modal until that
 * feature ships.
 *
 * `getPlayerState` is a getter (not a value) so each navigation closure
 * picks up the freshest state at tap-time, matching the previous
 * inlined `this.playerState` access pattern.
 */
export function buildMenuItems(scene: Scene, getPlayerState: () => PlayerState | null): DrawerItem[] {
  return [
    {
      label: 'SET STAGE',
      description: 'Dress the band, light the room',
      icon: '😺',
      key: SceneKeys.Decorate,
      onTap: () => scene.scene.start(SceneKeys.Decorate, { playerState: getPlayerState() }),
    },
    {
      label: 'REHEARSE',
      description: 'Pawractice makes purrfect',
      icon: '🎵',
      key: SceneKeys.Game,
      onTap: () => scene.scene.start(SceneKeys.Game, { playerState: getPlayerState(), forcePicker: true }),
    },
    {
      label: 'PUT ON A SHOW',
      description: 'Cook up your next hit',
      icon: '🎼',
      key: SceneKeys.ChartEditor,
      onTap: () => scene.scene.start(SceneKeys.ChartEditor, { playerState: getPlayerState() }),
    },
    {
      label: 'MERCH',
      description: 'Fresh drops at the merch table',
      icon: '🛒',
      key: SceneKeys.Purchase,
      onTap: () => scene.scene.start(SceneKeys.Purchase, { playerState: getPlayerState() }),
    },
    {
      label: 'CATCH A SHOW',
      description: 'Front row for fellow artists',
      icon: '🎪',
      key: SceneKeys.VisitShows,
      onTap: () => scene.scene.start(SceneKeys.VisitShows, { playerState: getPlayerState() }),
    },
    {
      label: 'REWARDS',
      description: 'Goodies on the way',
      icon: '🎁',
      onTap: () => openRewards(scene),
    },
    {
      label: 'SETTINGS',
      description: 'Tune effects + audio to taste',
      icon: '⚙️',
      onTap: () => openSettings(scene),
    },
  ];
}
