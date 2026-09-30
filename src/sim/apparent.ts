// Apparent wind at points on the boat (spec §7.2).
import { rotX, wrapPi, type Vec3 } from '../shared/math';

export interface Kinematics {
  heading: number; // rad compass
  heel: number;    // rad, + starboard down
  u: number;       // surge m/s
  v: number;       // sway m/s (+ to starboard)
  r: number;       // yaw rate rad/s (+ to starboard)
  p: number;       // roll rate rad/s (+ rolling to starboard)
}

/**
 * Velocity of the air relative to a body-fixed point, expressed in the (heeled) body frame.
 * `windEN` is the true-wind air velocity (toward) at the point's height, world (east, north).
 * The sails use only the (x, y) components — the cross-flow is thereby reduced by cos(heel) — while the
 * component along the mast (z) is ignored.
 */
export function airVelocityBody(rB: Vec3, k: Kinematics, windEN: { e: number; n: number }): Vec3 {
  const s = Math.sin(k.heading), c = Math.cos(k.heading);
  // True wind in the heading frame (x forward, y starboard, horizontal).
  const wx = windEN.e * s + windEN.n * c;
  const wy = windEN.e * c - windEN.n * s;
  // Point velocity in the heading frame: (u, v, 0) + ω × r, with ω = (p, 0, r).
  const rH = rotX(rB, k.heel);
  const vx = k.u - k.r * rH.y;
  const vy = k.v + k.r * rH.x - k.p * rH.z;
  const vz = k.p * rH.y;
  return rotX({ x: wx - vx, y: wy - vy, z: -vz }, -k.heel);
}

/** Apparent wind angle (rad, + from starboard) and speed from a body-frame air velocity, rig plane. */
export function awaAws(aB: Vec3): { awa: number; aws: number } {
  const aws = Math.hypot(aB.x, aB.y);
  return { awa: aws < 1e-9 ? 0 : Math.atan2(-aB.y, -aB.x), aws };
}

/** Signed true wind angle (rad, + wind from starboard). */
export const twaOf = (heading: number, twd: number): number => wrapPi(twd - heading);
