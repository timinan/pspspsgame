import { GameObjects, Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import { RoomRenderer } from '@/entities/room-renderer';
import { SCENE_SLOTS, SCENE_SEATS } from '@/constants/scene-slots';
import { SlotGhost } from '@/entities/slot-ghost';
import { SeatGhost } from '@/entities/seat-ghost';
import { fetchState } from '@/services/state-client';
import type { PlayerState } from '@/../shared/state';

/**
 * Edit-mode scene. Shares room rendering with the Game scene via
 * RoomRenderer. Adds slot ghosts, seat ghosts, ✕ remove badges, a bottom
 * tray, and a context menu surface.
 *
 * Phase 4 Task 14 scope: skeleton that renders the room + ghosts + an
 * empty tray frame. Tabs, menus, and interactions land in Task 15.
 */
export class HouseEditor extends Scene {
  private playerState!: PlayerState;
  private topHud!: TopHud;
  private roomRenderer!: RoomRenderer;
  private slotGhosts: SlotGhost[] = [];
  private seatGhosts: SeatGhost[] = [];
  private trayContainer!: GameObjects.Container;

  constructor() {
    super(SceneKeys.HouseEditor);
  }

  init(data: { playerState?: PlayerState }): void {
    this.slotGhosts = [];
    this.seatGhosts = [];
    if (data?.playerState) {
      this.playerState = data.playerState;
    }
  }

  async create(): Promise<void> {
    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());

    if (!this.playerState) {
      this.playerState = await fetchState();
    }

    // TopHud in edit mode
    this.topHud = new TopHud(this, { items: [], showStats: true });
    this.topHud.setMode('edit', { onDone: () => this.exitToGame() });

    // Room (theme + decorations + seated cats)
    this.roomRenderer = new RoomRenderer(this);
    this.roomRenderer.renderFrom(this.playerState);

    // Slot ghosts (only for empty slots)
    for (const slot of SCENE_SLOTS) {
      if (this.playerState.house.decorations[slot.id]) continue;
      const ghost = new SlotGhost(this, slot);
      this.add.existing(ghost);
      this.slotGhosts.push(ghost);
    }

    // Seat ghosts (only for empty seats)
    for (const seat of SCENE_SEATS) {
      if (this.playerState.seatedCats[seat.id]) continue;
      const ghost = new SeatGhost(this, seat);
      this.add.existing(ghost);
      this.seatGhosts.push(ghost);
    }

    // Tray placeholder — filled in by Task 15
    this.trayContainer = this.add.container(0, this.scale.height - 180).setDepth(80);
    const trayBg = this.add
      .rectangle(0, 0, this.scale.width, 180, 0x2c1856, 0.95)
      .setOrigin(0, 0);
    trayBg.setStrokeStyle(2, 0xc0a0e6, 0.4);
    this.trayContainer.add(trayBg);
  }

  private exitToGame(): void {
    this.scene.start(SceneKeys.Game, { playerState: this.playerState });
  }

  private cleanup(): void {
    this.topHud?.destroy();
    this.roomRenderer?.destroy();
    for (const g of this.slotGhosts) g.destroy();
    for (const g of this.seatGhosts) g.destroy();
    this.trayContainer?.destroy(true);
    this.slotGhosts = [];
    this.seatGhosts = [];
  }
}
