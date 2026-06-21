// Seat positions for the cat house scene (survived Phase 5 cleanup).
// SlotGhost/SCENE_SLOTS removed — only seat-related exports remain here.
import type { Scene } from 'phaser';
import type { SeatId } from '@/../shared/state';

export interface SeatPosition {
  id: SeatId;
  label: string;
  /** Pixel coordinates relative to scene top-left (320×480 design space) */
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
const TRAY_HEIGHT = 170;

/**
 * Convert design-space coords (320x480) to canvas-space coords mapped onto
 * the playable area between TopHud and the bottom tray.
 */
export function designToCanvas(scene: Scene, designX: number, designY: number): { x: number; y: number } {
  const playableHeight = scene.scale.height - TOP_BAR - TRAY_HEIGHT;
  return {
    x: (designX / DESIGN_W) * scene.scale.width,
    y: TOP_BAR + (designY / DESIGN_H) * playableHeight,
  };
}
