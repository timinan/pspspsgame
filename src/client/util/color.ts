/**
 * Convert an HSL triple to a packed 0xRRGGBB integer Phaser can pass to
 * setTint(). Used by the rainbow cat (and its box-open reveal) to cycle
 * through hues without needing extra atlas frames.
 *
 * @param hue - degrees in [0, 360)
 * @param saturation - [0, 1]
 * @param lightness - [0, 1]
 */
export function hslToInt(
  hue: number,
  saturation: number,
  lightness: number,
): number {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c; g = x; b = 0;
  } else if (h < 120) {
    r = x; g = c; b = 0;
  } else if (h < 180) {
    r = 0; g = c; b = x;
  } else if (h < 240) {
    r = 0; g = x; b = c;
  } else if (h < 300) {
    r = x; g = 0; b = c;
  } else {
    r = c; g = 0; b = x;
  }
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}
