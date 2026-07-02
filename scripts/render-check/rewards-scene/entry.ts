/**
 * rewards-scene harness — boots the REAL Rewards scene
 * (src/client/scenes/Rewards.ts) against a fake playerState and exposes
 * window hooks so shoot.mjs can screenshot every state: collect-pot
 * (240 / 0 / post-collect), the daily-quest + login-streak states, both
 * box choosers, and the WEEKLY / TROPHIES "coming soon" placeholders.
 *
 * All four reward endpoints are served by a stubbed window.fetch that
 * returns the real state-client response shapes — no private-method
 * reaches to fake responses.
 */
import Phaser from 'phaser';
import { Rewards } from '@/scenes/Rewards';
import { SceneKeys } from '@/constants/scenes';
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

// '2026-07-02' resolves to quests [play3(t3), hardplay1(t1), comment1(t1)]
// — play3's target of 3 is what makes the "1/3" mid-progress case visible.
const DAY = '2026-07-02';

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
      weekly: { weekKey: '', progress: {}, claimed: {}, bonusClaimed: false },
    },
  } as unknown as PlayerState;
}

type WeeklyPin = {
  progress: Record<string, number>;
  claimed: Record<string, boolean>;
  bonusClaimed: boolean;
};

type QuestScene = {
  isoToday: string;
  questProgress: Record<string, number>;
  questClaimed: Record<string, boolean>;
  questBonusClaimed: boolean;
  streak: { lastDay: string; count: number; lastClaimedDay: string };
  weekly?: WeeklyPin;
};

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
  // Weekly scenarios — daily fields idle; weekly is what's under test.
  'weekly-mid': {
    isoToday: DAY,
    questProgress: {},
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: '', count: 0, lastClaimedDay: '' },
    weekly: {
      progress: { wplays15: 9, whardpass5: 2, whostplays25: 11 },
      claimed: {},
      bonusClaimed: false,
    },
  },
  'weekly-claimable': {
    isoToday: DAY,
    questProgress: {},
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: '', count: 0, lastClaimedDay: '' },
    weekly: {
      progress: { wplays15: 15, whardpass5: 5, whostplays25: 25 },
      claimed: {},
      bonusClaimed: false,
    },
  },
  'weekly-two-claimed': {
    isoToday: DAY,
    questProgress: {},
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: '', count: 0, lastClaimedDay: '' },
    weekly: {
      progress: { wplays15: 15, whardpass5: 5, whostplays25: 25 },
      claimed: { wplays15: true, whardpass5: true },
      bonusClaimed: false,
    },
  },
  'weekly-all-claimed': {
    isoToday: DAY,
    questProgress: {},
    questClaimed: {},
    questBonusClaimed: false,
    streak: { lastDay: '', count: 0, lastClaimedDay: '' },
    weekly: {
      progress: { wplays15: 15, whardpass5: 5, whostplays25: 25 },
      claimed: { wplays15: true, whardpass5: true, whostplays25: true },
      bonusClaimed: false,
    },
  },
};

function sceneState(name: string): PlayerState {
  const s = SCENES[name]!;
  const st = fakeState(0) as unknown as {
    economy: { daily: Record<string, unknown>; streak: unknown; weekly: WeeklyPin & { weekKey: string } };
  };
  st.economy.daily.questProgress = s.questProgress;
  st.economy.daily.questClaimed = s.questClaimed;
  st.economy.daily.questBonusClaimed = s.questBonusClaimed;
  st.economy.streak = s.streak;
  if (s.weekly) {
    st.economy.weekly = { weekKey: '2026-W27', ...s.weekly };
  }
  return st as unknown as PlayerState;
}

// -- fetch stub: serve the four reward endpoints with real shapes -------

// The current playerState reference the scene is rendering, so the collect
// endpoint can compute the pot + post-collect coins.
let current: PlayerState = fakeState(0);

function jsonRes(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

window.fetch = ((input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/api/rewards/collect')) {
    const pot = current.economy.pendingCollect;
    return Promise.resolve(
      jsonRes({ ok: true, collected: pot, state: fakeState(0, current.coins + pot) }),
    );
  }
  if (url.includes('/api/quests/claim')) {
    return Promise.resolve(jsonRes({ ok: true, claimed: 75, state: current }));
  }
  if (url.includes('/api/quests/bonus')) {
    return Promise.resolve(
      jsonRes({
        ok: true,
        pull: { kind: 'cosmetic', itemId: 'c1', rarity: 'common', duplicate: false, refundCoins: 0 },
        state: current,
      }),
    );
  }
  if (url.includes('/api/streak/claim')) {
    return Promise.resolve(jsonRes({ ok: true, claimed: 100, state: current }));
  }
  if (url.includes('/api/weekly/claim')) {
    return Promise.resolve(
      jsonRes({
        ok: true,
        claimed: 100,
        pull: { kind: 'cat', itemId: 'siamese', rarity: 'rare', duplicate: false, refundCoins: 0 },
        state: current,
      }),
    );
  }
  if (url.includes('/api/weekly/bonus')) {
    return Promise.resolve(
      jsonRes({
        ok: true,
        claimed: 500,
        pull: { kind: 'cat', itemId: 'tabby', rarity: 'legendary', duplicate: false, refundCoins: 0 },
        state: current,
      }),
    );
  }
  return Promise.resolve(jsonRes({ ok: true, state: current }));
}) as typeof window.fetch;

// -- boot the real scene + expose hooks --------------------------------

type SceneReach = {
  activeTab: 'daily' | 'weekly' | 'trophies';
  buildChrome(): void;
  renderTabBody(): void;
  openTierChooser(
    tier: 'standard' | 'golden' | 'mythic',
    title: string,
    onPick: (boxId: string) => void,
  ): void;
};

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0b041a',
  width: DESIGN_W,
  height: DESIGN_H,
  render: { preserveDrawingBuffer: true },
  scale: { mode: Phaser.Scale.NONE },
  scene: [Rewards],
});

function reach(): SceneReach {
  return game.scene.getScene(SceneKeys.Rewards) as unknown as SceneReach;
}

function start(state: PlayerState, iso: string): void {
  current = state;
  game.scene.start(SceneKeys.Rewards, { playerState: state, fromScene: SceneKeys.Game, isoToday: iso });
}

const w = window as unknown as {
  __open: (n: number) => void;
  __scene: (name: string) => void;
  __tab: (tab: 'daily' | 'weekly' | 'trophies') => void;
  __openChooser: () => void;
  __openGoldenChooser: () => void;
  __collectNow: () => Promise<void>;
  __ready: boolean;
};

w.__open = (n: number) => start(fakeState(n), DAY);
w.__scene = (name: string) => start(sceneState(name), SCENES[name]!.isoToday);
w.__tab = (tab) => {
  // Mirror the real chip-tap path: switch tab, then rebuild chrome (so the
  // chip highlight moves) + the body.
  const s = reach();
  s.activeTab = tab;
  s.buildChrome();
  s.renderTabBody();
};
w.__openChooser = () => reach().openTierChooser('standard', 'PICK YOUR BOX', () => {});
w.__openGoldenChooser = () =>
  reach().openTierChooser('golden', 'PICK YOUR GOLDEN BOX', () => {});
w.__collectNow = async () => {
  const s = reach() as unknown as { onCollect(): Promise<void> };
  await s.onCollect();
};

game.events.once('ready', () => {
  w.__ready = true;
});
