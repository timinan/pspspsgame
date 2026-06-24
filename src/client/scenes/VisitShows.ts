import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import type { PlayerState } from '@/../shared/state';

/**
 * Visit Shows — placeholder scene. Eventually this lists other players'
 * shows with deep links out to their reddit posts. For now it's a coming-
 * soon placeholder so the menu item has somewhere to land.
 *
 * Structurally mirrors Purchase's coming-soon view (same dark backdrop,
 * same TopHud nav, same centered lock/title/sub stack).
 */
export class VisitShows extends Scene {
  private playerState: PlayerState | null = null;
  private topHud!: TopHud;
  private uiRoot!: GameObjects.Container;

  constructor() {
    super(SceneKeys.VisitShows);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
  }

  create(): void {
    const { width, height } = this.scale;
    this.add.rectangle(0, 0, width, height, 0x0b041a, 1).setOrigin(0, 0);

    this.topHud = new TopHud(this, {
      showStats: true,
      currentKey: SceneKeys.VisitShows,
      items: [
        {
          label: 'SET STAGE',
          description: 'Dress the band, light the room',
          icon: '😺',
          key: SceneKeys.Decorate,
          onTap: () => this.scene.start(SceneKeys.Decorate, { playerState: this.playerState }),
        },
        {
          label: 'REHEARSE',
          description: 'Pawractice makes purrfect',
          icon: '🎵',
          key: SceneKeys.Game,
          onTap: () => this.scene.start(SceneKeys.Game, { playerState: this.playerState }),
        },
        {
          label: 'PUT ON A MEOWCERT',
          description: 'Cook up your next hit',
          icon: '🎼',
          key: SceneKeys.ChartEditor,
          onTap: () => this.scene.start(SceneKeys.ChartEditor, { playerState: this.playerState }),
        },
        {
          label: 'MERCH',
          description: 'Fresh drops at the merch table',
          icon: '🛒',
          key: SceneKeys.Purchase,
          onTap: () => this.scene.start(SceneKeys.Purchase, { playerState: this.playerState }),
        },
        {
          label: 'CATCH A MEOWCERT',
          description: 'Front row for fellow artists',
          icon: '🎪',
          key: SceneKeys.VisitShows,
          onTap: () => this.scene.start(SceneKeys.VisitShows, { playerState: this.playerState }),
        },
      ],
    });

    this.uiRoot = this.add.container(0, 0);
    this.drawComingSoon();
  }

  private drawComingSoon(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    const icon = this.add
      .text(cx, cy - 70, '🎪', { ...fontBase, fontSize: '48px' })
      .setOrigin(0.5);
    this.uiRoot.add(icon);

    const title = this.add
      .text(cx, cy - 8, 'COMING SOON', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '24px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(0.5);
    this.uiRoot.add(title);

    const sub = this.add
      .text(
        cx,
        cy + 28,
        'Soon you\'ll catch other cats\' meowcerts and jump straight into their reddit post.',
        {
          ...fontBase,
          fontSize: '11px',
          color: '#c0a0e6',
          align: 'center',
          wordWrap: { width: width - 48 },
        },
      )
      .setOrigin(0.5, 0);
    this.uiRoot.add(sub);
  }

  shutdown(): void {
    this.tweens.killAll();
    this.topHud?.destroy();
    this.uiRoot?.destroy();
  }
}
