// Helm modes (spec §7.7): hold heading, true wind angle or apparent wind angle.
import { clamp, wrapPi, DEG } from '../shared/math';
import type { HelmMode } from './types';
import { BOAT } from '../shared/boatSpec';

export interface HelmInputs { heading: number; twa: number; awa: number; r: number; speed: number }

const MAX_RUDDER = BOAT.rudder.maxAngleDeg * DEG;

/**
 * Rudder angle to steer toward the target (rad, + turns to starboard). PD on the heading error with
 * gains scaled by 1/V² because rudder force grows with V².
 * Turning to starboard increases the heading and decreases a starboard-tack wind angle, so wind-angle
 * errors enter with the opposite sign to heading errors.
 */
export function helmCommand(mode: HelmMode, target: number, s: HelmInputs): number {
  let err: number;
  switch (mode) {
    case 'heading': err = wrapPi(target - s.heading); break;
    case 'twa': err = wrapPi(s.twa - target); break;
    case 'awa': err = wrapPi(s.awa - target) * 0.8; break;
    default: return 0;
  }
  const gain = clamp((2.6 / Math.max(s.speed, 0.8)) ** 2, 0.35, 5);
  return clamp(gain * (1.1 * err - 1.6 * s.r), -MAX_RUDDER, MAX_RUDDER);
}
