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

/** Proportional/derivative gain: it scales with 1/V² because rudder force grows with V² (bounded). */
const helmGain = (speed: number): number => clamp((2.6 / Math.max(speed, 0.8)) ** 2, 0.35, 5);
const KI = 0.35;

/** The steering law; `trim` is the integral's rudder angle (rad); rudder angle out (rad). */
function steer(err: number, trim: number, s: HelmInputs): number {
  return clamp(helmGain(s.speed) * (1.1 * err - 1.6 * s.r) + trim, -MAX_RUDDER, MAX_RUDDER);
}

/**
 * Stateless PD helm: the {@link Helmsman} law without the integral.
 * @deprecated Unused by the simulation, which steers with a {@link Helmsman}; kept for API compatibility.
 */
export function helmCommand(mode: HelmMode, target: number, s: HelmInputs): number {
  return steer(helmError(mode, target, s), 0, s);
}

/**
 * PID helmsman: the integral removes the steady error that weather or lee helm would otherwise leave. It is kept
 * as a rudder angle (up to the stops), so it has the same authority at any speed: kept as a raw error integral it
 * was scaled by the 1/V² gain and, fast and over-pressed, could only trim a few degrees — the boat then settled
 * well below the angle it was told to hold (M7).
 */
export class Helmsman {
  /** Rudder angle (rad) the integral holds. */
  private integral = 0;
  private lastMode: HelmMode = 'manual';
  private lastTarget = 0;

  reset(): void { this.integral = 0; }

  command(mode: HelmMode, target: number, s: HelmInputs, dt: number): number {
    if (mode !== this.lastMode || Math.abs(wrapPi(target - this.lastTarget)) > 10 * DEG) this.integral = 0;
    this.lastMode = mode;
    this.lastTarget = target;
    const err = helmError(mode, target, s);
    // Integrate only near the target (avoid wind-up during big turns).
    if (Math.abs(err) < 15 * DEG) this.integral = clamp(this.integral + KI * helmGain(s.speed) * err * dt, -MAX_RUDDER, MAX_RUDDER);
    return steer(err, this.integral, s);
  }
}
