import type { Scene } from 'phaser';
import type { SlotId, SeatId } from '@/../shared/state';

export interface SceneSlot {
  id: SlotId;
  /** Display label shown in the Collection decor tab */
  label: string;
  /** Pixel coordinates relative to scene top-left (320x480 design space) */
  x: number;
  y: number;
  /** Phaser origin for the placed sprite. 0.5/1.0 = bottom-center. */
  anchor: { x: number; y: number };
}

// TEMP-DEMO: revert to full slot list before ship
// Original SCENE_SLOTS was 7 entries — kept commented below
/*
export const SCENE_SLOTS: readonly SceneSlot[] = [
  { id: 'window-sill',  label: 'Window Sill',  x: 60,  y: 130, anchor: { x: 0.5, y: 1.0 } },
  { id: 'side-table',   label: 'Side Table',   x: 260, y: 280, anchor: { x: 0.5, y: 1.0 } },
  { id: 'floor-left',   label: 'Floor (Left)', x: 80,  y: 420, anchor: { x: 0.5, y: 1.0 } },
  { id: 'floor-right',  label: 'Floor (Right)',x: 240, y: 420, anchor: { x: 0.5, y: 1.0 } },
  { id: 'wall-hook',    label: 'Wall Hook',    x: 160, y: 90,  anchor: { x: 0.5, y: 0.5 } },
  { id: 'shelf-top',    label: 'Shelf (Top)',  x: 230, y: 170, anchor: { x: 0.5, y: 1.0 } },
  { id: 'corner-back',  label: 'Back Corner',  x: 30,  y: 360, anchor: { x: 0.5, y: 1.0 } },
] as const;
*/
export const SCENE_SLOTS: readonly SceneSlot[] = [
  // TEMP-DEMO: single test slot mid-canvas
  { id: 'slot-test', label: 'Test Slot', x: 160, y: 200, anchor: { x: 0.5, y: 0.5 } },
] as const;

export const SLOT_IDS: readonly SlotId[] = SCENE_SLOTS.map((s) => s.id);

export interface SeatPosition {
  id: SeatId;
  label: string;
  /** Pixel coordinates relative to scene top-left (320x480 design space) */
  x: number;
  y: number;
  anchor: { x: number; y: number };
}

// TEMP-DEMO: revert to 3 seats before ship
/*
export const SCENE_SEATS: readonly SeatPosition[] = [
  { id: 'seat-left',   label: 'Left Seat',   x: 80,  y: 370, anchor: { x: 0.5, y: 1.0 } },
  { id: 'seat-center', label: 'Center Seat', x: 160, y: 370, anchor: { x: 0.5, y: 1.0 } },
  { id: 'seat-right',  label: 'Right Seat',  x: 240, y: 370, anchor: { x: 0.5, y: 1.0 } },
] as const;
*/
export const SCENE_SEATS: readonly SeatPosition[] = [
  // TEMP-DEMO: single test seat at floor center
  { id: 'seat-center', label: 'Test Seat', x: 160, y: 370, anchor: { x: 0.5, y: 1.0 } },
] as const;

export const SEAT_IDS: readonly SeatId[] = SCENE_SEATS.map((s) => s.id);

const DESIGN_W = 320;
const DESIGN_H = 480;
const TOP_BAR = 44;
export const TRAY_HEIGHT = 170;

/**
 * Convert design-space coords (320×480) to canvas-space coords mapped onto
 * the playable area between TopHud and the bottom tray.
 */
export function designToCanvas(scene: Scene, designX: number, designY: number): { x: number; y: number } {
  const playableHeight = scene.scale.height - TOP_BAR - TRAY_HEIGHT;
  return {
    x: (designX / DESIGN_W) * scene.scale.width,
    y: TOP_BAR + (designY / DESIGN_H) * playableHeight,
  };
}
