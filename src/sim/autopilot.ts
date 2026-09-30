// Helm modes (spec §7.7): hold heading, true wind angle or apparent wind angle.
import { clamp, wrapPi, DEG } from '../shared/math';
import type { HelmMode } from './types';
import { BOAT } from '../shared/boatSpec';

export interface HelmInputs { heading: number; twa: number; awa: number; r: number; speed: number }

const MAX_RUDDER = BOAT.rudder.maxAngleDeg * DEG;

/** Steering error (rad): positive means "turn to starboard". */
export function helmError(mode: HelmMode, target: number, s: HelmInputs): number {
  switch (mode) {
    // Turning to starboard increases the heading but decreases a starboard-tack wind angle.
    case 'heading': return wrapPi(target - s.heading);
    case 'twa': return wrapPi(s.twa - target);
    case 'awa': return wrapPi(s.awa - target) * 0.8;
    default: return 0;
  }
}

/** Stateless PD helm (used where no memory is available). */
export function helmCommand(mode: HelmMode, target: number, s: HelmInputs): number {
  const gain = clamp((2.6 / Math.max(s.speed, 0.8)) ** 2, 0.35, 5);
  return clamp(gain * (1.1 * helmError(mode, target, s) - 1.6 * s.r), -MAX_RUDDER, MAX_RUDDER);
}

/**
 * PID helmsman: the integral removes the steady error that weather or lee helm would otherwise leave.
 * Gains scale with 1/V² because rudder force grows with V².
 */
export class Helmsman {
  private integral = 0;
  private lastMode: HelmMode = 'manual';
  private lastTarget = 0;

  reset(): void { this.integral = 0; }

  command(mode: HelmMode, target: number, s: HelmInputs, dt: number): number {
    if (mode !== this.lastMode || Math.abs(wrapPi(target - this.lastTarget)) > 10 * DEG) this.integral = 0;
    this.lastMode = mode;
    this.lastTarget = target;
    const err = helmError(mode, target, s);
    const gain = clamp((2.6 / Math.max(s.speed, 0.8)) ** 2, 0.35, 5);
    // Integrate only near the target (avoid wind-up during big turns).
    if (Math.abs(err) < 15 * DEG) this.integral = clamp(this.integral + err * dt, -0.6, 0.6);
    return clamp(gain * (1.1 * err + 0.35 * this.integral - 1.6 * s.r), -MAX_RUDDER, MAX_RUDDER);
  }
}
