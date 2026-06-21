import { GameObjects, Scene, Scenes } from 'phaser';
import { ThemeManager } from '@/entities/theme-manager';
import { Decoration } from '@/entities/decoration';
import { Cat, parentIdFor } from '@/entities/cat'; // TEMP-DEMO: parentIdFor for cosmetic frame derivation
import { SCENE_SLOTS, SCENE_SEATS } from '@/constants/scene-slots';
import { AssetKeys } from '@/constants/assets'; // TEMP-DEMO: for cosmetics atlas in cosmetics-as-decor fallback
import { DECORATION_CATALOG, CAT_CATALOG, COSMETIC_CATALOG } from '@/../shared/state'; // TEMP-DEMO: COSMETIC_CATALOG for cosmetics-as-decor fallback
import type { PlayerState } from '@/../shared/state';

/**
 * Owns rendering of the room: theme backdrop, music, decorations in slots,
 * cats in seats. Used by both Game (play mode) and HouseEditor (edit mode)
 * so the room looks identical in both scenes.
 *
 * Call `renderFrom(playerState)` after construction. Call `destroy()` on
 * scene shutdown so audio + sprites don't leak.
 */
export class RoomRenderer {
  private themeManager: ThemeManager;
  private decorations: Decoration[] = [];
  private cats: Cat[] = [];
  private catSpriteBySeat: Map<string, GameObjects.Sprite> = new Map();
  private destroyed = false;

  constructor(private scene: Scene) {
    this.themeManager = new ThemeManager(scene);
    scene.events.once(Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  renderFrom(playerState: PlayerState): void {
    // Theme
    if (playerState.house?.themeId) {
      this.themeManager.applyTheme(playerState.house.themeId);
    }

    // Decorations
    for (const slot of SCENE_SLOTS) {
      const decorationId = playerState.house?.decorations[slot.id];
      if (!decorationId) continue;
      // TEMP-DEMO: try COSMETIC_CATALOG first; render directly as a sprite using cosmetics atlas
      const cosEntry = COSMETIC_CATALOG.find((c) => c.id === decorationId);
      if (cosEntry) {
        // TEMP-DEMO: derive frame from parentIdFor (handles both base and tint-variant cosmetics)
        const renderId = parentIdFor(cosEntry) ?? cosEntry.id;
        const frame = `cosmetic_${renderId}_idle_00`;
        const renderX = (slot.x / 320) * this.scene.scale.width;
        const renderY = (slot.y / 480) * this.scene.scale.height;
        const cosmeticSprite = this.scene.add
          .sprite(renderX, renderY, AssetKeys.Atlas.Cosmetics, frame)
          .setOrigin(slot.anchor.x, slot.anchor.y)
          .setDepth(renderY);
        if (cosEntry.tint) {
          const colorInt = parseInt(cosEntry.tint.replace('#', ''), 16);
          cosmeticSprite.setTint(colorInt);
        }
        // Track as a Decoration-like object — but cast to any since types differ
        // TEMP-DEMO: revert to proper decoration rendering when scenario testing done
        this.decorations.push(cosmeticSprite as unknown as Decoration);
        continue;
      }
      const entry = DECORATION_CATALOG.find((d) => d.id === decorationId);
      if (!entry) continue;
      const deco = new Decoration(this.scene, slot, entry);
      this.scene.add.existing(deco);
      this.decorations.push(deco);
    }

    // Cats — read from seatedCats only, never auto-seat from ownedCats
    for (const seat of SCENE_SEATS) {
      const catId = playerState.seatedCats[seat.id];
      if (!catId) continue;
      const catEntry = CAT_CATALOG.find((c) => c.id === catId);
      if (!catEntry) continue;

      const w = this.scene.scale.width;
      const h = this.scene.scale.height;
      // SCENE_SEATS coords are in 320×480 design space; scale to canvas size.
      const x = (seat.x / 320) * w;
      const y = (seat.y / 480) * h;

      const model = {
        id: `seat-${seat.id}`,
        breed: catId,
        animation: 'idle' as const,
        restingAnimation: 'idle' as const,
        x: (seat.x / 320) * 100,
        y: (seat.y / 480) * 100,
        ...(playerState.equippedCosmetics[catId] !== undefined
          ? { equippedCosmetic: playerState.equippedCosmetics[catId] }
          : {}),
      };
      const cat = new Cat(this.scene, model);
      cat.setPosition(x, y);
      this.cats.push(cat);
      this.catSpriteBySeat.set(seat.id, cat.sprite);
    }
  }

  /**
   * Snapshot of currently-rendered cat sprites, keyed by seat id.
   * HouseEditor uses this to wire up tap-to-dress and ✕ remove badges.
   */
  getSeatedCatSprites(): Map<string, GameObjects.Sprite> {
    return new Map(this.catSpriteBySeat);
  }

  /**
   * The live Cat entity array. Game scene uses this for the petting
   * interaction system (CatSelectionSystem + animation calls).
   */
  getCats(): Cat[] {
    return this.cats;
  }

  /** Snapshot of currently-rendered decoration sprites, keyed by slot id. */
  getDecorationSprites(): Map<string, Decoration> {
    const map = new Map<string, Decoration>();
    for (const deco of this.decorations) {
      map.set(deco.slotId, deco);
    }
    return map;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.themeManager.destroy();
    for (const d of this.decorations) d.destroy();
    for (const c of this.cats) c.destroy();
    this.decorations = [];
    this.cats = [];
    this.catSpriteBySeat.clear();
  }
}
