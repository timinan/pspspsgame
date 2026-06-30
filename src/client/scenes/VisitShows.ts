import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import { buildMenuItems } from '@/ui/menu-items';
import { playTutorialMusic } from '@/systems/home-music';
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
  /** Source scene the user navigated from — when set, a back chip
   *  appears top-left and returns there. Used by the post-POST page-3
   *  menu in Game so visitors can back out to their previous flow. */
  private fromScene: string | null = null;

  constructor() {
    super(SceneKeys.VisitShows);
  }

  init(data: { playerState?: PlayerState | null; fromScene?: string }): void {
    this.playerState = data?.playerState ?? null;
    this.fromScene = data?.fromScene ?? null;
  }

  create(): void {
    playTutorialMusic(this);
    const { width, height } = this.scale;
    this.add.rectangle(0, 0, width, height, 0x0b041a, 1).setOrigin(0, 0);

    this.topHud = new TopHud(this, {
      showStats: true,
      currentKey: SceneKeys.VisitShows,
      items: buildMenuItems(this, () => this.playerState),
    });

    this.uiRoot = this.add.container(0, 0);
    this.drawComingSoon();
    this.maybeDrawBackChip();
  }

  /** Top-left BACK chip — rendered only when init received a fromScene.
   *  Returns the visitor to the scene they came from (currently used by
   *  the post-POST page-3 menu in Game). High depth so it always sits
   *  above any other UI in the scene. */
  private maybeDrawBackChip(): void {
    if (!this.fromScene) return;
    const x = 38;
    const y = TopHud.HEIGHT + 18;
    const bg = this.add
      .rectangle(x, y, 56, 24, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.6)
      .setInteractive({ useHandCursor: true })
      .setDepth(1000);
    const txt = this.add
      .text(x, y, '← BACK', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5)
      .setDepth(1001);
    bg.on('pointerover', () => bg.setFillStyle(0x3d2566, 1));
    bg.on('pointerout', () => bg.setFillStyle(0x2c1856, 1));
    bg.on('pointerdown', () => {
      this.scene.start(this.fromScene!, { playerState: this.playerState });
    });
    this.uiRoot.add([bg, txt]);
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
        'Soon you\'ll catch other cats\' shows and jump straight into their reddit post.',
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
