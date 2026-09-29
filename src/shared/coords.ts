// Frame conversions (spec §5).
//   Body frame (sim):      x forward, y starboard, z down; origin on the centreline at the waterline,
//                          at the longitudinal station of the centre of gravity.
//   Boat-local (three.js): X starboard, Y up, Z aft (the bow points toward −Z).
//   World (three.js):      Y up, North = −Z, East = +X.  Sim world 2-D is (east, north).
import type { Vec3 } from './math';

/** Body (x fwd, y stbd, z down) → three.js boat-local (X stbd, Y up, Z aft). */
export const bodyToLocal = (p: Vec3): Vec3 => ({ x: p.y, y: -p.z, z: -p.x });

/** Inverse of {@link bodyToLocal}. */
export const localToBody = (p: Vec3): Vec3 => ({ x: -p.z, y: p.x, z: -p.y });

/** Height above the waterline → body z. */
export const hz = (h: number): number => -h;

/** Body point from spec-style coordinates (x forward, y starboard, h above the waterline). */
export const bodyPoint = (x: number, y: number, h: number): Vec3 => ({ x, y, z: -h });

/** Sim world (east, north) → three.js world X and Z. */
export const worldToThreeXZ = (e: number, n: number): { x: number; z: number } => ({ x: e, z: -n });

/** Compass bearing (rad, clockwise from north) → unit vector in the sim world (east, north). */
export const bearingToEN = (b: number): { e: number; n: number } => ({ e: Math.sin(b), n: Math.cos(b) });

/** three.js `rotation.y` for a compass heading. */
export const headingToRotationY = (psi: number): number => -psi;
