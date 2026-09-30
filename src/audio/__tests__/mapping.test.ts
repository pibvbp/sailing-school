import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DEG, KN, wrapPi } from '../../shared/math';
import {
  cameraYawFromBasis, cameraYawFromForward, collapseLevel, crashLevel, finiteOr, flogLevel, flutterRate, luffDrive, meanLuffing, panFor, refillLevel,
  relativeBearing, spinRustleDrive, swooshCentre, swooshDrive, swooshLevel, waterRushCutoff, waterRushLevel, whistleDrive, whistleFreqA,
  whistleFreqB, windHissCutoff, windHissLevel, windRoarCutoff, windRoarLevel,
} from '../mapping';

const range = (lo: number, hi: number, n = 40) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
const toDbRatio = (a: number, b: number): number => 20 * Math.log10(a / b);
const nondecreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]! - 1e-12);

describe('wind mapping', () => {
  it('the roar level grows with the square of the apparent wind speed up to ~20 kn …', () => {
    for (const aws of [2, 3, 4, 5]) expect(windRoarLevel(2 * aws) / windRoarLevel(aws)).toBeCloseTo(4, 6);
  });

  it('… then flattens: a gale is louder, but well short of the full square law, and there is no jump at the knee', () => {
    const square = (aws: number): number => 0.52 * (aws / 12) ** 2;
    const knee = 0.85 * 12;
    expect(windRoarLevel(knee)).toBeCloseTo(square(knee), 9);
    expect(Math.abs(windRoarLevel(knee + 1e-6) - windRoarLevel(knee - 1e-6))).toBeLessThan(1e-5);
    expect(windRoarLevel(30 * KN)).toBeGreaterThan(windRoarLevel(25 * KN));
    expect(toDbRatio(windRoarLevel(30 * KN), square(30 * KN))).toBeCloseTo(-3.2, 1);
    expect(toDbRatio(windRoarLevel(40 * KN), square(40 * KN))).toBeCloseTo(-5, 0);
    expect(toDbRatio(windHissLevel(30 * KN), 0.31 * (30 * KN / 12) ** 2.3)).toBeLessThan(-3);
  });

  it('level and brightness rise monotonically with AWS', () => {
    const a = range(0, 25);
    for (const f of [windRoarLevel, windRoarCutoff, windHissLevel, windHissCutoff, whistleDrive, whistleFreqA, whistleFreqB]) expect(nondecreasing(a.map(f))).toBe(true);
  });

  it('is silent in no wind and never non-finite', () => {
    expect(windRoarLevel(0)).toBe(0);
    expect(windHissLevel(0)).toBe(0);
    for (const aws of range(0, 80)) for (const f of [windRoarLevel, windRoarCutoff, windHissLevel, windHissCutoff, whistleDrive, whistleFreqA, whistleFreqB]) expect(Number.isFinite(f(aws))).toBe(true);
  });

  it('the whistle is absent in light air, faint at 15 kn and fully in by 22 kn', () => {
    expect(whistleDrive(10 * KN)).toBe(0);
    expect(whistleDrive(13 * KN)).toBe(0);
    expect(whistleDrive(15 * KN)).toBeGreaterThan(0);
    expect(whistleDrive(15 * KN)).toBeLessThan(0.2);
    expect(whistleDrive(22 * KN)).toBe(1);
    expect(whistleDrive(35 * KN)).toBe(1);
  });

  it('the whistle pitch follows the wind and stays in the audible band', () => {
    expect(whistleFreqA(14)).toBeGreaterThan(whistleFreqA(8));
    for (const aws of range(0, 60)) {
      expect(whistleFreqA(aws)).toBeGreaterThanOrEqual(500);
      expect(whistleFreqB(aws)).toBeLessThanOrEqual(4000);
    }
  });
});

describe('water mapping', () => {
  it('the rush rises faster than linearly with speed and brightens', () => {
    expect(waterRushLevel(0)).toBe(0);
    expect(waterRushLevel(4) / waterRushLevel(2)).toBeGreaterThan(2);
    expect(nondecreasing(range(0, 8).map(waterRushCutoff))).toBe(true);
  });

  it('the swoosh follows roll activity and heel, and needs speed', () => {
    expect(swooshDrive(0, 0, 3)).toBe(0);
    expect(swooshDrive(0.2, 0, 3)).toBeGreaterThan(swooshDrive(0.05, 0, 3));
    expect(swooshDrive(0, 0.4, 3)).toBeGreaterThan(swooshDrive(0, 0.05, 3));
    expect(swooshDrive(0, -0.4, 3)).toBeCloseTo(swooshDrive(0, 0.4, 3), 9);
    expect(swooshDrive(0.2, 0.3, 0)).toBeLessThan(swooshDrive(0.2, 0.3, 3));
    expect(nondecreasing(range(0, 2).map(swooshLevel))).toBe(true);
    expect(nondecreasing(range(0, 2).map(swooshCentre))).toBe(true);
  });
});

describe('sail flogging mapping', () => {
  it('gates on luffing: nothing below ~0.18, half-way around the spec threshold of 0.3, full above ~0.42', () => {
    expect(luffDrive(0)).toBe(0);
    expect(luffDrive(0.15)).toBe(0);
    expect(luffDrive(0.3)).toBeGreaterThan(0.15);
    expect(luffDrive(0.3)).toBeLessThan(0.4);
    expect(luffDrive(0.5)).toBeGreaterThan(luffDrive(0.3) * 2);
    expect(luffDrive(1)).toBe(1);
    expect(nondecreasing(range(0, 1).map(luffDrive))).toBe(true);
  });

  it('flutter rate is 3–8 Hz and rises with AWS', () => {
    const rates = range(0, 40).map(flutterRate);
    expect(Math.min(...rates)).toBeCloseTo(3, 9);
    expect(Math.max(...rates)).toBeCloseTo(8, 9);
    expect(nondecreasing(rates)).toBe(true);
  });

  it('loudness is luffing × AWS² (until the cap) and grows with both', () => {
    expect(flogLevel(0, 10)).toBe(0);
    expect(flogLevel(0.5, 5) / flogLevel(1, 5)).toBeCloseTo(0.5, 9);
    expect(flogLevel(1, 4) / flogLevel(1, 2)).toBeCloseTo(4, 9);
    expect(flogLevel(1, 40)).toBeLessThan(2);
    expect(nondecreasing(range(0, 30).map((a) => flogLevel(1, a)))).toBe(true);
  });

  it('meanLuffing averages sections and shrugs off garbage', () => {
    expect(meanLuffing([])).toBe(0);
    expect(meanLuffing([{ luffing: 0 }, { luffing: 1 }])).toBe(0.5);
    expect(meanLuffing([{ luffing: NaN }, { luffing: 1 }])).toBe(0.5);
  });
});

describe('spinnaker and impact mapping', () => {
  it('a full spinnaker is quiet, a collapsed one rustles more in more wind', () => {
    expect(spinRustleDrive(0, 0, 8)).toBe(0);
    expect(spinRustleDrive(1, 1, 8)).toBeGreaterThan(spinRustleDrive(1, 1, 3));
    expect(spinRustleDrive(1, 1, 8)).toBeGreaterThan(spinRustleDrive(0.3, 0, 8));
    expect(spinRustleDrive(0, 1, 8)).toBeGreaterThan(0); // curling already flutters, gently
    expect(spinRustleDrive(0, 1, 8)).toBeLessThan(spinRustleDrive(1, 0, 8));
  });

  it('the boom crash is louder with the impact rate, within 0.55…1', () => {
    expect(crashLevel(1.5)).toBeCloseTo(0.55, 9);
    expect(crashLevel(10)).toBeCloseTo(1, 9);
    expect(nondecreasing(range(1.5, 8).map(crashLevel))).toBe(true);
    expect(crashLevel(NaN)).toBeCloseTo(0.55, 9);
  });

  it('refill and collapse are louder in more wind', () => {
    expect(refillLevel(10)).toBeGreaterThan(refillLevel(3));
    expect(collapseLevel(10)).toBeGreaterThan(collapseLevel(3));
    expect(refillLevel(10)).toBeGreaterThan(collapseLevel(10));
  });
});

describe('stereo placement', () => {
  // Boat heading north; the camera looks along the bow.
  it('wind from the starboard bow pans right, from the port bow pans left, from ahead stays centred', () => {
    expect(panFor(relativeBearing(0, 40 * DEG, 0), 0.55)).toBeGreaterThan(0.2);
    expect(panFor(relativeBearing(0, -40 * DEG, 0), 0.55)).toBeLessThan(-0.2);
    expect(Math.abs(panFor(relativeBearing(0, 0, 0), 0.55))).toBeLessThan(1e-9);
  });

  it('turns with the camera: looking to starboard puts an ahead wind on the left', () => {
    expect(panFor(relativeBearing(0, 0, 90 * DEG), 0.55)).toBeLessThan(-0.5);
    expect(panFor(relativeBearing(0, 0, -90 * DEG), 0.55)).toBeGreaterThan(0.5);
  });

  it('accounts for the boat heading (compass bearings)', () => {
    // Heading east, wind 30° off the bow to starboard = from the south-east; camera looking due east.
    expect(panFor(relativeBearing(90 * DEG, 30 * DEG, 90 * DEG), 1)).toBeCloseTo(0.5, 6);
    // Same wind (from compass 120°), camera looking south (180°): it comes from 60° to the left of the view.
    expect(panFor(relativeBearing(90 * DEG, 30 * DEG, 180 * DEG), 1)).toBeCloseTo(-Math.sin(60 * DEG), 6);
  });

  it('never exceeds the requested width and wraps across north', () => {
    for (const b of range(-10, 10)) expect(Math.abs(panFor(b, 0.55))).toBeLessThanOrEqual(0.55 + 1e-12);
    expect(panFor(relativeBearing(350 * DEG, 20 * DEG, 5 * DEG), 1)).toBeCloseTo(Math.sin(5 * DEG), 9);
  });

  it('converts a three.js forward vector to a compass yaw (X = east, Z = −north)', () => {
    expect(cameraYawFromForward(0, -1)).toBeCloseTo(0, 9);
    expect(cameraYawFromForward(1, 0)).toBeCloseTo(90 * DEG, 9);
    expect(Math.abs(cameraYawFromForward(0, 1))).toBeCloseTo(180 * DEG, 9);
    expect(cameraYawFromForward(-1, 0)).toBeCloseTo(-90 * DEG, 9);
  });
});

describe('finiteOr', () => {
  it('passes finite numbers and replaces NaN and infinities', () => {
    expect(finiteOr(3, 0)).toBe(3);
    expect(finiteOr(-1e300, 0)).toBe(-1e300);
    expect(finiteOr(NaN, 7)).toBe(7);
    expect(finiteOr(Infinity, 7)).toBe(7);
    expect(finiteOr(-Infinity, 7)).toBe(7);
  });
});

describe('cameraYawFromBasis (the listening direction from a camera\'s world axes)', () => {
  /** A camera facing compass bearing `a`, pitched `pitch` below the horizon (negative = above), no roll. three.js axes. */
  const cam = (a: number, pitch: number) => {
    const d = { x: Math.sin(a), z: -Math.cos(a) };
    return {
      forward: { x: Math.cos(pitch) * d.x, y: -Math.sin(pitch), z: Math.cos(pitch) * d.z },
      up: { x: Math.sin(pitch) * d.x, y: Math.cos(pitch), z: Math.sin(pitch) * d.z },
    };
  };
  const yaw = (c: ReturnType<typeof cam>) => cameraYawFromBasis(c.forward, c.up);
  const diff = (x: number, y: number) => Math.abs(wrapPi(x - y));
  const bearings = [0, 30, 90, 135, 180, -100, -45].map((d) => d * DEG);

  it('level or tilted views give the bearing of where the camera looks, like cameraYawFromForward', () => {
    for (const a of bearings) for (const pitch of [0, 10, 25, -20, -45].map((d) => d * DEG)) {
      const c = cam(a, pitch);
      expect(diff(yaw(c), a)).toBeLessThan(1e-9);
      expect(diff(yaw(c), cameraYawFromForward(c.forward.x, c.forward.z))).toBeLessThan(1e-9);
    }
  });

  it('looking straight down (the top view) takes the top of the screen as "ahead" — exactly', () => {
    for (const a of bearings) {
      const up = { x: Math.sin(a), y: 0, z: -Math.cos(a) }; // the rig sets cam.up to the wind-up bearing
      expect(diff(cameraYawFromBasis({ x: 0, y: -1, z: 0 }, up), a)).toBeLessThan(1e-12);
      // …whatever rounding noise lookAt leaves in forward:
      for (const [nx, nz] of [[2.2e-16, -1.2e-16], [-3e-16, 2e-16], [1e-9, 1e-9], [-1e-7, 3e-8]] as const) {
        expect(diff(cameraYawFromBasis({ x: nx, y: -1, z: nz }, up), a)).toBeLessThan(1e-6);
      }
    }
  });

  it('whereas the horizontal part of forward alone is garbage there (why this helper exists)', () => {
    const a = 1.2;
    const noise = [[2.2e-16, -1.2e-16], [-3e-16, 2e-16], [1e-16, 4e-16]] as const;
    const answers = noise.map(([x, z]) => cameraYawFromForward(x, z));
    expect(answers.some((y) => diff(y, a) > 0.5)).toBe(true);
  });

  it('is the same for every pitch from 80° above the horizon to straight down: no flip, no jump', () => {
    for (const a of bearings) for (let deg = -80; deg <= 90; deg += 1) expect(diff(yaw(cam(a, deg * DEG)), a)).toBeLessThan(1e-9);
  });

  it('still moves smoothly when the camera is rolled (a wind-up top view is a roll about the vertical)', () => {
    // Rotate `up` about `forward` by `roll` (Rodrigues); sweep the pitch to straight down with a fixed roll.
    const rolled = (a: number, pitch: number, roll: number) => {
      const c = cam(a, pitch);
      const f = c.forward, u = c.up;
      const cx = { x: f.y * u.z - f.z * u.y, y: f.z * u.x - f.x * u.z, z: f.x * u.y - f.y * u.x };
      const cs = Math.cos(roll), sn = Math.sin(roll);
      return { forward: f, up: { x: u.x * cs + cx.x * sn, y: u.y * cs + cx.y * sn, z: u.z * cs + cx.z * sn } };
    };
    for (const roll of [-50, -20, 20, 50].map((d) => d * DEG)) {
      let prev = cameraYawFromBasis(rolled(0, 0, roll).forward, rolled(0, 0, roll).up);
      for (let deg = 1; deg <= 90; deg++) {
        const c = rolled(0, deg * DEG, roll);
        const y = cameraYawFromBasis(c.forward, c.up);
        expect(diff(y, prev)).toBeLessThan(4 * DEG); // never more than a few degrees per degree of pitch
        prev = y;
      }
      // At the top view the answer is the top of the screen, here leaned by the roll.
      const top = rolled(0, 90 * DEG, roll);
      expect(diff(cameraYawFromBasis(top.forward, top.up), Math.atan2(top.up.x, -top.up.z))).toBeLessThan(1e-9);
    }
  });

  it('copes with un-normalised vectors and degenerate input', () => {
    const c = cam(0.7, 0.4);
    const scaled = cameraYawFromBasis({ x: c.forward.x * 7, y: c.forward.y * 7, z: c.forward.z * 7 }, { x: c.up.x * 0.1, y: c.up.y * 0.1, z: c.up.z * 0.1 });
    expect(diff(scaled, 0.7)).toBeLessThan(1e-9);
    expect(cameraYawFromBasis({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0);
    expect(Number.isFinite(cameraYawFromBasis({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }))).toBe(true); // looking straight up
    expect(Number.isFinite(cameraYawFromBasis({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }))).toBe(true);
    expect(Number.isFinite(cameraYawFromBasis({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }))).toBe(true);
  });

  it('gives the wind the same stereo side in the top view as a level camera at the same bearing would', () => {
    // Top view, wind-up: screen-up = the true-wind bearing 225°; the boat heads 180°+45°off… wind from its starboard bow.
    const up = { x: Math.sin(225 * DEG), y: 0, z: -Math.cos(225 * DEG) };
    const topYaw = cameraYawFromBasis({ x: 0, y: -1, z: 0 }, up);
    const levelYaw = yaw(cam(225 * DEG, 0));
    const heading = 180 * DEG, awa = 40 * DEG;
    expect(panFor(relativeBearing(heading, awa, topYaw), 0.55)).toBeCloseTo(panFor(relativeBearing(heading, awa, levelYaw), 0.55), 9);
  });

  describe('with real three.js cameras, set up the way CameraRig does it', () => {
    /** The two world-space axes App.ts will pass: where the camera looks, and the top of its screen. */
    const axes = (camera: THREE.PerspectiveCamera): { forward: THREE.Vector3; up: THREE.Vector3 } => {
      camera.updateMatrixWorld(true);
      return { forward: camera.getWorldDirection(new THREE.Vector3()), up: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1) };
    };
    const yawOf = (camera: THREE.PerspectiveCamera): number => {
      const { forward, up } = axes(camera);
      return cameraYawFromBasis(forward, up);
    };

    it('top view: the wind-up bearing, for every wind direction', () => {
      for (let deg = -180; deg < 180; deg += 15) {
        const w = deg * DEG; // twd + the view's own yaw
        const camera = new THREE.PerspectiveCamera(35, 1.6, 0.1, 40000);
        camera.position.set(12, 70, -30);
        camera.up.set(Math.sin(w), 0, -Math.cos(w));
        camera.lookAt(12, 0, -30);
        expect(diff(yawOf(camera), w)).toBeLessThan(1e-6);
      }
    });

    it('top view: it does not matter what rounding noise lookAt leaves in forward', () => {
      const camera = new THREE.PerspectiveCamera(35, 1.6, 0.1, 40000);
      let forwardOnlyWrong = 0;
      for (let i = 0; i < 60; i++) {
        const x = 1234.5678 + i * 0.731, z = -987.654 - i * 1.113; // far from the origin, so lookAt's arithmetic is not exact
        const w = -3 + i * 0.1; // the wind direction drifts, the way it does while sailing
        camera.position.set(x, 70.3, z);
        camera.up.set(Math.sin(w), 0, -Math.cos(w));
        camera.lookAt(x, 0, z);
        expect(diff(yawOf(camera), w)).toBeLessThan(1e-6);
        const f = axes(camera).forward;
        if (diff(cameraYawFromForward(f.x, f.z), w) > 0.5) forwardOnlyWrong++;
      }
      expect(forwardOnlyWrong).toBeGreaterThan(5); // …while the forward-only yaw is garbage much of the time
    });

    it('chase and free views: the bearing the camera looks along, including the steepest orbit the rig allows', () => {
      const boat = new THREE.Vector3(40, 0, -25);
      for (const heading of [0, 70, 180, -120].map((d) => d * DEG)) for (const pitch of [0.22, 0.6, 1.0, 1.45]) {
        const orbit = heading + Math.PI + 0.45; // the rig's chase orbit: heading + π + its yaw
        const horiz = 17 * Math.cos(pitch);
        const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 40000);
        camera.position.set(boat.x + Math.sin(orbit) * horiz, 2 + 17 * Math.sin(pitch), boat.z - Math.cos(orbit) * horiz);
        camera.up.set(0, 1, 0);
        camera.lookAt(boat.x, 3.2, boat.z);
        expect(diff(yawOf(camera), orbit + Math.PI)).toBeLessThan(1e-6); // looking back toward the boat
      }
    });

    it('helm and sail views (level, looking forward) agree with cameraYawFromForward', () => {
      const camera = new THREE.PerspectiveCamera(62, 1.6, 0.1, 40000);
      camera.position.set(3, 1.45, 4);
      camera.up.set(0, 1, 0);
      camera.lookAt(3 + Math.sin(1.0) * 6, 4.2, 4 - Math.cos(1.0) * 6);
      const { forward } = axes(camera);
      expect(diff(yawOf(camera), cameraYawFromForward(forward.x, forward.z))).toBeLessThan(1e-9);
      expect(diff(yawOf(camera), 1.0)).toBeLessThan(1e-6);
    });
  });
});

