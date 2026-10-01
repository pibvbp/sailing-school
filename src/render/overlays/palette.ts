// Overlay colours (spec §8) as display-referred sRGB hex, the same tokens the HUD uses where they overlap
// (true wind #5cb6ff and apparent wind #ffb547 match `--sx-tw` / `--sx-aw` in src/ui/styles.css).
import * as THREE from 'three';

export const COLORS = {
  trueWind: '#5cb6ff',
  boatWind: '#c4ccd6',
  apparentWind: '#ffb547',
  sailForce: '#ff4b4b',
  drive: '#3ee07f',
  heel: '#b77cff',
  keel: '#2ee8f0',
  rudder: '#9ef4ff',
  resistance: '#ff9a6b',
  lift: '#ff9fb4',
  drag: '#d7c6ff',
  weight: '#ffd166',
  buoyancy: '#7fe0ff',
  port: '#ff5a5f',
  starboard: '#3ddc84',
  white: '#f4f7fb',
  noGo: '#ff5a4f',
  // Angle-of-attack states, as the cloth colouring and the HUD's groove meter show them.
  luffing: '#4aa8ff',
  groove: '#34c77b',
  stalled: '#ff5a4f',
  // Leeway picture (x-ray): where the boat points, and where she actually goes through the water.
  heading: '#f4f7fb',
  track: '#ffe066',
} as const;

export type ColorKey = keyof typeof COLORS;

/** Linear-sRGB colour of a token (what the overlay shaders expect as "display-linear" input). */
export function linearColor(hex: string, out = new THREE.Color()): THREE.Color {
  return out.set(hex); // THREE.Color stores linear sRGB when ColorManagement is enabled (the default)
}

/** CSS colour for DOM labels. */
export const css = (k: ColorKey): string => COLORS[k];
