/**
 * rewards-modal harness — boots a bare Phaser scene, opens the real
 * RewardsModal (src/client/ui/rewards-modal.ts) against a fake
 * getPlayerState, and exposes window hooks so shoot.mjs can screenshot
 * the collect-pot states AND the Task 10 daily-quest / login-streak
 * states (mid-progress, claimable, all-claimed + bonus, streak day 3,
 * streak day 7, bonus box chooser).
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
  return {
    coins,
    economy: {
      pendingCollect,
      daily: {
        day: '',
        playIncome: 0,
        chartPlays: {},
        hostPotAccrued: 0,
        questProgress: {},
        questClaimed: {},
        questBonusClaimed: false,
      },
      streak: { lastDay: '', count: 0, lastClaimedDay: '' },
    },
  } as unknown as PlayerState;
}

type QuestScene = {
  isoToday: string;
  questProgress: Record<string, number>;
  questClaimed: Record<string, boolean>;
  questBonusClaimed: boolean;
  streak: { lastDay: string; count: number; lastClaimedDay: string };
};

// '2026-07-02' resolves to quests [play3(t3), hardplay1(t1), comment1(t1)]
// — play3's target of 3 is what makes the "1/3" mid-progress case visible.
const DAY = '2026-07-02';

const SCENES: Record<string, QuestScene> = {
  'quests-mid': {
    isoToday: DAY,
    questProgress: { play3: 1 },
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: DAY, count: 1, lastClaimedDay: DAY },
  },
  'quest-claimable': {
    isoToday: DAY,
    questProgress: { play3: 3, hardplay1: 1 },
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: DAY, count: 1, lastClaimedDay: DAY },
  },
  'all-claimed': {
    isoToday: DAY,
    questProgress: { play3: 3, hardplay1: 1, comment1: 1 },
    questClaimed: { play3: true, hardplay1: true, comment1: true },
    questBonusClaimed: false,
    streak: { lastDay: DAY, count: 2, lastClaimedDay: DAY },
  },
  'streak-3': {
    isoToday: DAY,
    questProgress: {},
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: DAY, count: 3, lastClaimedDay: '' },
  },
  'streak-7': {
    isoToday: DAY,
    questProgress: {},
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: DAY, count: 7, lastClaimedDay: '' },
  },
};

function sceneState(name: string): PlayerState {
  const s = SCENES[name]!;
  const st = fakeState(0) as unknown as {
    economy: {
      daily: Record<string, unknown>;
      streak: unknown;
    };
  };
  st.economy.daily.questProgress = s.questProgress;
  st.economy.daily.questClaimed = s.questClaimed;
  st.economy.daily.questBonusClaimed = s.questBonusClaimed;
  st.economy.streak = s.streak;
  return st as unknown as PlayerState;
}

class HarnessScene extends Phaser.Scene {
  create(): void {
    this.add.rectangle(0, 0, DESIGN_W, DESIGN_H, 0x0b041a, 1).setOrigin(0, 0);

    let modal: RewardsModal | null = null;
    let state: PlayerState = fakeState(0);

    const w = window as unknown as {
      __open: (n: number) => void;
      __scene: (name: string) => void;
      __openChooser: () => void;
      __openGoldenChooser: () => void;
      __collectNow: () => Promise<void>;
      __ready: boolean;
    };

    w.__open = (n: number) => {
      state = fakeState(n);
      modal?.destroy();
      modal = new RewardsModal(this);
      modal.open({ getPlayerState: () => state });
    };

    w.__scene = (name: string) => {
      state = sceneState(name);
      modal?.destroy();
      modal = new RewardsModal(this);
      modal.open({ getPlayerState: () => state, isoToday: SCENES[name]!.isoToday });
    };

    w.__openChooser = () => {
      (modal as unknown as { openBoxChooser: () => void }).openBoxChooser();
    };

    w.__openGoldenChooser = () => {
      (modal as unknown as { openGoldenChooser: () => void }).openGoldenChooser();
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
