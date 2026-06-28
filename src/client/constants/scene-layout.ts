export const DESIGN_W = 320;
export const DESIGN_H = 580;
export const TOP_HUD_H = 36;
export const CAT_STAGE_H = 190;
// Bars now extend all the way to the bottom of the screen — no dedicated
// bottom HUD band. Kept the constant for any historical references but
// the lane no longer carves out space for it.
export const BOTTOM_HUD_H = 0;
export const LANE_TOP_Y = TOP_HUD_H + CAT_STAGE_H;        // = 226
export const LANE_BOTTOM_Y = DESIGN_H;                    // = 580
// Hit line sits 70px above the lane bottom so the fuzzball targets
// catch closer to the cats (Tim's request — "move them up slightly").
// The remaining 70px below the hit line still gives the player room
// for great/perfect taps on the "other side" of the target before the
// note leaves the lane. Was 40 (= 540); 70 = 510. Iterate if Tim
// wants higher (closer to cats) or lower.
export const HIT_LINE_Y = LANE_BOTTOM_Y - 70;             // = 510
// Bars run edge-to-edge with no padding between them — the rhythm bar
// texture is the floor of the playfield and Tim wants no background gaps
// peeking through. laneCenterX and the lane-width math both honor these
// values, so flipping them to 0 collapses the visual seams without
// requiring per-scene layout work.
export const LANE_GUTTER_PX = 0;
export const LANE_GAP_PX = 0;
export const LANE_COUNT = 3;

export const LANE_COLORS = [0x6fbcff, 0xc678ff, 0xffd34d] as const;

export function laneCenterX(laneId: 0 | 1 | 2, canvasWidth: number): number {
  const inner = canvasWidth - LANE_GUTTER_PX * 2;
  const colWidth = (inner - LANE_GAP_PX * (LANE_COUNT - 1)) / LANE_COUNT;
  return LANE_GUTTER_PX + colWidth * laneId + colWidth / 2 + LANE_GAP_PX * laneId;
}
