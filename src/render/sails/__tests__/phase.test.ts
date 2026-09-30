// Wind-dependent motion must not depend on how long the session has been running. Flogging, leech flutter,
// the telltale ripple and the burgee flap all have frequencies that follow the apparent wind, so their
// phases are integrated frame by frame. With phase = f(aws) · t instead, a gust late in a session makes
// the phase jump by Δf · t per frame: at t = 3600 s and 2 m/s² that is ~29 cycles per frame, i.e. noise.
// Each test runs the same wind ramp starting at t = 10 s and at t = 3600 s and compares the per-frame steps.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BOAT } from '../../../shared/boatSpec';
import type { JibState, MainState, SailSection, Telltale } from '../../../sim/types';
import { MainShape, mainPlanChord } from '../mainMesh';
import { JibShape } from '../jibMesh';
import { Telltales } from '../telltales';
import { Burgee } from '../burgee';

const DEG = Math.PI / 180;
const FRAME = 1 / 60;
const WARM = 120;
const RAMP = 180;
/** Apparent wind: steady, then a 2 m/s² gust (5 → 11 m/s over 3 s). */
const awsAt = (k: number): number => (k < WARM ? 5 : 5 + Math.min(k - WARM, RAMP) * FRAME * 2);

const zero = { x: 0, y: 0, z: 0 };

function jibState(luffing: number): JibState {
  const J = BOAT.jib;
  const sections: SailSection[] = [];
  for (let i = 0; i < 8; i++) {
    const z = J.tack.h + 0.08 + (i + 0.5) * ((J.head.h - 0.3 - J.tack.h - 0.08) / 8);
    const s = (z - J.tack.h) / (J.head.h - J.tack.h);
    sections.push({
      h: s, luff: { x: J.tack.x + (J.head.x - J.tack.x) * s, y: 0, z: -z }, chordDir: { x: -0.98, y: -0.2, z: 0 },
      chord: 3.2 * (1 - s) + 0.1, camber: 0.12, draft: 0.42, leewardY: -1, aoa: 0.2, luffing, stall: 0, cl: 1, cd: 0.05, q: 30,
    });
  }
  return {
    id: 'jib', set: true, area: J.area, tack: { x: J.tack.x, y: 0, z: -J.tack.h }, clew: { x: 0.6, y: -0.7, z: -J.clewH },
    head: { x: J.head.x, y: 0, z: -J.head.h }, sections, force: zero, ce: zero, lift: 0, drag: 0, drive: 0, heelForce: 0,
    telltales: [], clewAngle: 0.2, furl: 0, backed: false, whisker: false,
  };
}

function mainState(): MainState {
  const G = BOAT.boom.gooseneck;
  const beta = 8 * DEG;
  const sections: SailSection[] = [];
  for (let i = 0; i < 8; i++) {
    const h = (i + 0.5) / 8;
    const th = beta + 8 * DEG * h ** 1.4;
    sections.push({
      h, luff: { x: G.x, y: 0, z: -(G.h + h * BOAT.main.P) }, chordDir: { x: -Math.cos(th), y: -Math.sin(th), z: 0 },
      chord: mainPlanChord(h), camber: 0.11, draft: 0.46, leewardY: -1, aoa: 0.2, luffing: 0, stall: 0, cl: 1, cd: 0.05, q: 30,
    });
  }
  return {
    id: 'main', set: true, area: BOAT.main.area, tack: { x: G.x, y: 0, z: -G.h },
    clew: { x: G.x - Math.cos(beta) * BOAT.main.E, y: -Math.sin(beta) * BOAT.main.E, z: -G.h },
    head: { x: G.x, y: 0, z: -(G.h + BOAT.main.P) }, sections, force: zero, ce: zero, lift: 0, drag: 0, drive: 0,
    heelForce: 0, telltales: [], boomAngle: beta, boomRate: 0, twistDeg: 8,
  };
}

/** Largest vertex move between consecutive frames, per frame of the gust. */
function stepsOf(arr: () => ArrayLike<number>, frame: (k: number) => void): number[] {
  const out: number[] = [];
  let prev: Float32Array | null = null;
  for (let k = 0; k < WARM + RAMP; k++) {
    frame(k);
    const a = arr();
    if (prev && k >= WARM) {
      let m = 0;
      for (let i = 0; i < a.length; i += 3) {
        m = Math.max(m, Math.hypot(a[i]! - prev[i]!, a[i + 1]! - prev[i + 1]!, a[i + 2]! - prev[i + 2]!));
      }
      out.push(m);
    }
    prev = Float32Array.from(a);
  }
  return out;
}

const max = (xs: number[]): number => Math.max(...xs);
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Same motion statistics whether the gust comes 10 s or an hour into the session. */
function expectSessionIndependent(run: (t0: number) => number[], bound: number): void {
  const early = run(10), late = run(3600);
  expect(max(late)).toBeLessThan(bound);
  expect(max(early)).toBeLessThan(bound);
  expect(mean(late) / mean(early)).toBeGreaterThan(0.8);
  expect(mean(late) / mean(early)).toBeLessThan(1.25);
  expect(max(late) / max(early)).toBeLessThan(1.3);
}

describe('wind-dependent motion over a long session (phases are integrated, never f(aws)·t)', () => {
  it('a flogging jib moves the same an hour in as at the start', () => {
    const s = jibState(1);
    expectSessionIndependent((t0) => {
      const jib = new JibShape(1);
      return stepsOf(() => jib.surface.out, (k) => jib.update(FRAME, t0 + k * FRAME, s, awsAt(k)));
    }, 0.35);
  });

  it('a main in a fresh breeze (leech flutter) moves the same an hour in', () => {
    const s = mainState();
    expectSessionIndependent((t0) => {
      const main = new MainShape(1);
      return stepsOf(() => main.surface.out, (k) => main.update(FRAME, t0 + k * FRAME, s, 5 + awsAt(k)));
    }, 0.1);
  });

  it('a streaming telltale ripples the same an hour in', () => {
    const js = jibState(0);
    const gravity = new THREE.Vector3(0, -1, 0);
    expectSessionIndependent((t0) => {
      const jib = new JibShape(1);
      const tt = new Telltales();
      jib.update(FRAME, t0, js, 5);
      // A starboard luff telltale at 50 % height, 12 % chord, streaming (body-frame position on the cloth).
      const p = new THREE.Vector3(), n = new THREE.Vector3();
      jib.surface.sample(0.12, 0.5, p, n);
      const list: Telltale[] = [{ id: 'jib-stbd-50', pos: { x: -p.z, y: p.x, z: -p.y }, side: 'stbd', state: 'streaming', intensity: 0 }];
      const sails = { main: { telltales: [] as Telltale[] }, jib: { telltales: list } };
      const main = new MainShape(1);
      const mainRef = { surface: main.surface, rows: main.rows, visible: false };
      const jibRef = { surface: jib.surface, rows: jib.rows, visible: true };
      const pos = (tt.mesh.geometry as THREE.BufferGeometry).getAttribute('position').array;
      return stepsOf(() => pos.slice(0, 9 * 2 * 3), (k) => {
        jib.update(FRAME, t0 + k * FRAME, js, awsAt(k));
        tt.update(FRAME, t0 + k * FRAME, sails, mainRef, jibRef, awsAt(k), gravity);
      });
    }, 0.12);
  });

  it('the burgee flaps the same an hour in', () => {
    expectSessionIndependent((t0) => {
      const b = new Burgee();
      let flag: THREE.BufferGeometry | null = null;
      b.group.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry.getAttribute('position').usage === THREE.DynamicDrawUsage) flag = o.geometry;
      });
      const pos = flag!.getAttribute('position').array;
      return stepsOf(() => pos, (k) => b.update(FRAME, t0 + k * FRAME, 0.4, awsAt(k)));
    }, 0.08);
  });

  it('holds still while paused (dt = 0)', () => {
    const jib = new JibShape(1);
    const s = jibState(1);
    for (let k = 0; k < 30; k++) jib.update(FRAME, 3600 + k * FRAME, s, 8);
    const before = Float32Array.from(jib.surface.out);
    const t = 3600 + 29 * FRAME;
    jib.update(0, t, s, 8);
    jib.update(0, t, s, 8);
    let m = 0;
    for (let i = 0; i < before.length; i++) m = Math.max(m, Math.abs(jib.surface.out[i]! - before[i]!));
    expect(m).toBe(0);
  });
});

describe('telltales in a calm', () => {
  it('hang from the cloth when there is no wind (gravity wins; no minimum flow)', () => {
    const jib = new JibShape(1);
    const js = jibState(0);
    jib.update(FRAME, 0, js, 0);
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    jib.surface.sample(0.12, 0.5, p, n);
    const list: Telltale[] = [{ id: 'jib-stbd-50', pos: { x: -p.z, y: p.x, z: -p.y }, side: 'stbd', state: 'streaming', intensity: 0 }];
    const tt = new Telltales();
    const main = new MainShape(1);
    for (let k = 0; k < 180; k++) {
      jib.update(FRAME, k * FRAME, js, 0);
      tt.update(FRAME, k * FRAME, { main: { telltales: [] }, jib: { telltales: list } },
        { surface: main.surface, rows: main.rows, visible: false }, { surface: jib.surface, rows: jib.rows, visible: true }, 0, new THREE.Vector3(0, -1, 0));
    }
    const pos = (tt.mesh.geometry as THREE.BufferGeometry).getAttribute('position');
    // Ribbon 0: 9 nodes × 2 edge vertices; the root pair first, the tip pair last.
    const rootY = (pos.getY(0) + pos.getY(1)) / 2, tipY = (pos.getY(16) + pos.getY(17)) / 2;
    expect(rootY - tipY).toBeGreaterThan(0.15); // a 22 cm ribbon hanging (nearly) straight down
  });
});
