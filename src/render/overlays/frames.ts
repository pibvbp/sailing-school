// Frame conversions and wind kinematics for the overlays — allocation-free versions of what the simulation
// computes (spec §5, §7.1–7.2), so arrows and flow fields agree with the physics that drives the boat.
//
//   body (sim):  x forward, y starboard, z down      boat-local (three): X stbd, Y up, Z aft
//   world:       three.js, Y up, North = −Z, East = +X; sim (e, n) → (X = e, Z = −n)
import * as THREE from 'three';
import { gradientFactor } from '../../sim/wind';
import type { Puff, SimSnapshot } from '../../sim/types';

/** The boat root's world transform, for converting body-frame points and vectors to world space. */
export class BoatFrame {
  readonly matrix = new THREE.Matrix4();
  private readonly rot = new THREE.Matrix3();

  update(boatRoot: THREE.Object3D): void {
    boatRoot.updateWorldMatrix(true, false);
    this.matrix.copy(boatRoot.matrixWorld);
    this.rot.setFromMatrix4(this.matrix);
  }

  /** Body point (x fwd, y stbd, z down) → world position. */
  point(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(y, -z, -x).applyMatrix4(this.matrix);
  }

  /** Body vector → world vector (rotation only). */
  vector(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(y, -z, -x).applyMatrix3(this.rot);
  }
}

/** Body point → boat-local position (three.js), `bodyToLocal` without allocating. */
export function bodyToLocalV(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(y, -z, -x);
}

/** World (three.js) horizontal unit vector for a compass bearing (rad). */
export function bearingToWorld(b: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(b), 0, -Math.cos(b));
}

/** Compass bearing (rad, [0, 2π)) of a world (three.js) horizontal direction. */
export function worldToBearing(x: number, z: number): number {
  const b = Math.atan2(x, -z);
  return b < 0 ? b + 2 * Math.PI : b;
}

/** Wind seen at one point of the boat, all world-frame horizontal velocities (m/s). */
export interface PointWind {
  /** True wind air velocity (toward) at the point's height, local gust included. */
  readonly trueW: THREE.Vector3;
  /** Air velocity due to the point's own motion over the ground (= −point velocity). */
  readonly boatW: THREE.Vector3;
  /** Apparent wind = true + boat-motion wind. */
  readonly appW: THREE.Vector3;
}

export function pointWind(): PointWind {
  return { trueW: new THREE.Vector3(), boatW: new THREE.Vector3(), appW: new THREE.Vector3() };
}

/**
 * Wind triangle at a body point (spec §7.2): the point's height above the water after heel sets the gradient, the
 * point velocity includes yaw and roll rates exactly as `airVelocityBody` does. Result in world space, horizontal.
 */
export function windAtBodyPoint(s: SimSnapshot, x: number, y: number, z: number, out: PointWind): PointWind {
  const b = s.boat;
  const c = Math.cos(b.heel), sn = Math.sin(b.heel);
  // Point in the level heading frame (rotX by +heel).
  const yH = y * c - z * sn;
  const zH = y * sn + z * c;
  const h = -zH;
  const speed = s.wind.tws * gradientFactor(h);
  // True wind blows FROM twd: air velocity toward = −speed · (sin twd, cos twd) in (e, n).
  out.trueW.set(-speed * Math.sin(s.wind.twd), 0, speed * Math.cos(s.wind.twd));
  // Point velocity in the heading frame: (u, v) + ω × r with ω = (p, 0, r).
  const vx = b.u - b.yawRate * yH;
  const vy = b.v + b.yawRate * x - b.rollRate * zH;
  const sp = Math.sin(b.heading), cp = Math.cos(b.heading);
  // Heading frame → world: x_H = (sin ψ, 0, −cos ψ), y_H = (cos ψ, 0, sin ψ).
  out.boatW.set(-(vx * sp + vy * cp), 0, -(-vx * cp + vy * sp));
  out.appW.copy(out.trueW).add(out.boatW);
  return out;
}

/**
 * Rig-plane air velocity at a body point (body x, y), what the sails see (spec §7.2): true wind at the point's height
 * minus the point's velocity including yaw and roll rates, rotated into the heeled body frame, along-mast part dropped.
 */
export function rigAir(s: SimSnapshot, x: number, y: number, z: number, out: { x: number; y: number }): { x: number; y: number } {
  const b = s.boat;
  const c = Math.cos(b.heel), sn = Math.sin(b.heel);
  const yH = y * c - z * sn;
  const zH = y * sn + z * c;
  const speed = s.wind.tws * gradientFactor(-zH);
  const we = -speed * Math.sin(s.wind.twd), wn = -speed * Math.cos(s.wind.twd);
  const sp = Math.sin(b.heading), cp = Math.cos(b.heading);
  const wx = we * sp + wn * cp;
  const wy = we * cp - wn * sp;
  const vx = b.u - b.yawRate * yH;
  const vy = b.v + b.yawRate * x - b.rollRate * zH;
  const vz = b.rollRate * yH;
  const ax = wx - vx, ay = wy - vy, az = -vz;
  // Heading frame → body: rotX by −heel.
  out.x = ax;
  out.y = ay * c + az * sn;
  return out;
}

/** Boat velocity over the ground, world (three.js) horizontal. */
export function boatVelocityWorld(s: SimSnapshot, out: THREE.Vector3): THREE.Vector3 {
  const b = s.boat;
  const sp = Math.sin(b.heading), cp = Math.cos(b.heading);
  const ve = b.u * sp + b.v * cp;
  const vn = b.u * cp - b.v * sp;
  return out.set(ve, 0, -vn);
}

/**
 * True wind anywhere on the water, reproducing the simulation's puff field (spec §7.1) from what the snapshot carries:
 * the local wind at the boat (which includes the puffs there) and the puff list. The base wind is recovered by
 * removing the boat's own puff influence, so gusts and lulls elsewhere are exactly where the ocean draws them.
 */
export class TrueWindField {
  private baseSpeed = 0;
  private baseDir = 0;
  private puffs: readonly Puff[] = [];
  private readonly tmp = { gain: 0, turn: 0 };

  update(s: SimSnapshot): void {
    this.puffs = s.wind.puffs;
    let dir = s.wind.twd;
    // The puff axes follow the base direction; two fixed-point passes recover it to well under 0.01°.
    for (let i = 0; i < 3; i++) {
      this.influence(s.boat.pos.x, s.boat.pos.y, dir, this.tmp);
      dir = s.wind.twd - this.tmp.turn;
    }
    this.baseDir = dir;
    this.influence(s.boat.pos.x, s.boat.pos.y, dir, this.tmp);
    this.baseSpeed = s.wind.tws / Math.max(0.2, 1 + this.tmp.gain);
  }

  /** Air velocity (toward) at world (e, n) and height h: writes east/north components into `out`. */
  sample(e: number, n: number, h: number, out: { e: number; n: number }): { e: number; n: number } {
    this.influence(e, n, this.baseDir, this.tmp);
    const speed = this.baseSpeed * gradientFactor(h) * Math.max(0.2, 1 + this.tmp.gain);
    const dir = this.baseDir + this.tmp.turn;
    out.e = -speed * Math.sin(dir);
    out.n = -speed * Math.cos(dir);
    return out;
  }

  /** Base (un-gusted) true wind at 10 m: speed (m/s) and direction FROM (rad). */
  get base(): { speed: number; dir: number } {
    return { speed: this.baseSpeed, dir: this.baseDir };
  }

  private influence(e: number, n: number, dir: number, out: { gain: number; turn: number }): void {
    const upE = Math.sin(dir), upN = Math.cos(dir);
    const crossE = Math.cos(dir), crossN = -Math.sin(dir);
    let gain = 0, turn = 0;
    for (let i = 0; i < this.puffs.length; i++) {
      const p = this.puffs[i]!;
      const de = e - p.e, dn = n - p.n;
      const along = (de * upE + dn * upN) / p.radiusAlong;
      const across = (de * crossE + dn * crossN) / p.radiusAcross;
      const d2 = along * along + across * across;
      if (d2 > 9) continue;
      const w = p.envelope * Math.exp(-d2);
      gain += p.strength * w;
      turn += p.dirOffset * w;
    }
    out.gain = gain;
    out.turn = turn;
  }
}
