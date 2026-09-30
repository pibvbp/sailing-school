// The overlays' wind and frame maths must agree with the simulation that drives the boat.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { airVelocityBody, awaAws } from '../../../sim/apparent';
import { bodyToLocal } from '../../../shared/coords';
import { BOAT } from '../../../shared/boatSpec';
import { DEG, rotX } from '../../../shared/math';
import { BoatFrame, TrueWindField, bearingToWorld, boatVelocityWorld, rigAir, windAtBodyPoint, pointWind, worldToBearing } from '../frames';
import { sail } from './helpers';

describe('frames', () => {
  it('rigAir equals the simulation’s airVelocityBody at points all over the rig (heeled, turning, gusty)', () => {
    const { sim, snap } = sail(14, 50, { gust: 0.8, seconds: 20 });
    const kin = sim.kinematics();
    const out = { x: 0, y: 0 };
    for (const p of [{ x: 1.05, y: 0, z: -10.2 }, { x: 3.2, y: -0.4, z: -2 }, { x: -1.5, y: 0.8, z: -5 }, { x: 0, y: 0, z: -1 }]) {
      const hWorld = -rotX(p, kin.heel).z;
      const ref = airVelocityBody(p, kin, sim.windAt(hWorld));
      rigAir(snap, p.x, p.y, p.z, out);
      expect(out.x).toBeCloseTo(ref.x, 9);
      expect(out.y).toBeCloseTo(ref.y, 9);
    }
  });

  it('the masthead triangle: true wind from the TWD, boat-motion wind opposite the boat’s velocity, apparent as the instrument', () => {
    const { snap } = sail(12, 45);
    const w = windAtBodyPoint(snap, BOAT.mast.x, 0, -BOAT.mast.topH, pointWind());
    // True wind blows FROM the TWD: the air moves toward the opposite bearing.
    expect(worldToBearing(-w.trueW.x, -w.trueW.z)).toBeCloseTo(snap.wind.twd, 6);
    expect(w.trueW.length()).toBeCloseTo(snap.wind.tws * 1.0027, 1); // log gradient at 10.2 m
    // Steady sailing (no yaw or roll rate to speak of): the boat-motion wind is minus the velocity over the ground.
    expect(w.boatW.clone().add(boatVelocityWorld(snap, new THREE.Vector3())).length()).toBeLessThan(0.05);
    // Horizontal apparent wind vs the rig-plane instrument: equal speed-ish, angle within the heel projection (~2°).
    const heading = snap.boat.heading;
    const fwd = bearingToWorld(heading, new THREE.Vector3());
    const stbd = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
    const awa = Math.atan2(-w.appW.dot(stbd), -w.appW.dot(fwd));
    expect(Math.abs(awa - snap.wind.awa) / DEG).toBeLessThan(2.5);
    expect(Math.abs(w.appW.length() - snap.wind.aws)).toBeLessThan(0.3);
  });

  it('TrueWindField reproduces the simulation’s puff field anywhere on the water', () => {
    const { sim, snap } = sail(12, 90, { gust: 1, seconds: 40 });
    expect(snap.wind.puffs.length).toBeGreaterThan(0);
    const f = new TrueWindField();
    f.update(snap);
    const out = { e: 0, n: 0 };
    let maxErr = 0;
    for (let i = 0; i < 200; i++) {
      const e = snap.boat.pos.x + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 400;
      const n = snap.boat.pos.y + (Math.sin(i * 78.233) * 12345.678 % 1) * 400;
      const ref = sim.wind.velocity(e, n, 2);
      f.sample(e, n, 2, out);
      maxErr = Math.max(maxErr, Math.hypot(out.e - ref.e, out.n - ref.n));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('BoatFrame maps body points like bodyToLocal + the boat root transform', () => {
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    root.position.set(12, 0.3, -40);
    root.rotation.set(0.02, -1.1, -0.3);
    const frame = new BoatFrame();
    frame.update(root);
    const p = { x: 1.2, y: -0.7, z: -6 };
    const l = bodyToLocal(p);
    const expected = new THREE.Vector3(l.x, l.y, l.z).applyMatrix4(root.matrixWorld);
    expect(frame.point(p.x, p.y, p.z, new THREE.Vector3()).distanceTo(expected)).toBeLessThan(1e-9);
    const v = frame.vector(1, 0, 0, new THREE.Vector3());
    const bow = new THREE.Vector3(0, 0, -1).applyQuaternion(root.quaternion);
    expect(v.distanceTo(bow)).toBeLessThan(1e-9);
  });

  it('compass bearings round-trip through world directions (north = −Z, east = +X)', () => {
    const v = new THREE.Vector3();
    expect(bearingToWorld(0, v).z).toBeCloseTo(-1);
    expect(bearingToWorld(Math.PI / 2, v).x).toBeCloseTo(1);
    for (const b of [0.1, 1, 2.5, 4, 6]) {
      bearingToWorld(b, v);
      expect(worldToBearing(v.x, v.z)).toBeCloseTo(b, 9);
    }
    expect(awaAws({ x: -1, y: -1, z: 0 }).awa).toBeGreaterThan(0); // air moving to port = wind from starboard
  });
});
