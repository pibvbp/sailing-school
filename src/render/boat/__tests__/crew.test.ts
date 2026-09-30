// The crew must move continuously (review Important 1): whatever crewY does, no crew vertex may move more
// than a few centimetres between 60 Hz frames, sides change only when crewY clearly asks for it, and a
// paused update (dt = 0) changes nothing.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CrewSet } from '../crew';
import { boatDetail } from '../materials';

const DT = 1 / 60;
/** Max per-frame displacement allowed for any crew vertex (m). */
const MAX_STEP = 0.06;

const tillerEnd = new THREE.Vector3(0, 0.87, 1.84);
const cam = new THREE.Vector3(0.2, 0.705, 2.11);

const version = (crew: CrewSet) => (crew.objects[0].geometry.getAttribute('position') as THREE.BufferAttribute).version;

function snapshot(crew: CrewSet): Float32Array[] {
  return crew.objects.map((o) => (o.geometry.getAttribute('position').array as Float32Array).slice());
}

function maxStep(a: Float32Array[], b: Float32Array[]): number {
  let m = 0;
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = b[k];
    for (let i = 0; i < p.length; i += 3) m = Math.max(m, Math.hypot(p[i] - q[i], p[i + 1] - q[i + 1], p[i + 2] - q[i + 2]));
  }
  return m;
}

function meanX(crew: CrewSet, mesh: number): number {
  const p = crew.objects[mesh].geometry.getAttribute('position').array as Float32Array;
  let s = 0;
  for (let i = 0; i < p.length; i += 3) s += p[i];
  return s / (p.length / 3);
}

/** Run a crewY/heel program at 60 Hz; returns the largest per-frame vertex and grip steps. */
function run(crew: CrewSet, seconds: number, at: (t: number) => { crewY: number; heel: number }): { vertex: number; grip: number } {
  let prev = snapshot(crew);
  const grip = crew.helmGrip.clone();
  let vertex = 0, gripStep = 0;
  for (let t = 0; t < seconds; t += DT) {
    const s = at(t);
    crew.update({ crewY: s.crewY, heel: s.heel, tillerEnd, mainsheetCam: cam }, DT);
    const next = snapshot(crew);
    vertex = Math.max(vertex, maxStep(prev, next));
    gripStep = Math.max(gripStep, grip.distanceTo(crew.helmGrip));
    grip.copy(crew.helmGrip);
    prev = next;
  }
  return { vertex, grip: gripStep };
}

function placed(crewY: number): CrewSet {
  const crew = new CrewSet(boatDetail({ tier: 'high' }));
  crew.update({ crewY, heel: -0.25 * crewY, tillerEnd, mainsheetCam: cam }, 0);
  return crew;
}

/** crewY easing from `from` to `to` over `dur` seconds, starting at t0 (the sim lags the helm ≈ 1 s). */
const ramp = (from: number, to: number, t0: number, dur: number) => (t: number) => {
  const u = THREE.MathUtils.clamp((t - t0) / dur, 0, 1);
  const crewY = from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * u));
  return { crewY, heel: -0.25 * crewY };
};

describe('crew motion is continuous', () => {
  it.each([
    ['tack, crewY across in 1.5 s', 1, -1, 1.5],
    ['tack, crewY across in 1.0 s', 1, -1, 1.0],
    ['too-fast tack, 0.4 s', -1, 1, 0.4],
    ['gybe with the crew near the centreline', 0.3, -0.3, 1.0],
  ] as const)('%s', (_name, from, to, dur) => {
    const crew = placed(from);
    const r = run(crew, 7, ramp(from, to, 0.5, dur));
    expect(r.vertex).toBeLessThanOrEqual(MAX_STEP);
    expect(r.grip).toBeLessThanOrEqual(0.05);
    // Everyone ends up on the new side.
    for (const mesh of [0, 1]) expect(Math.sign(meanX(crew, mesh))).toBe(Math.sign(to));
  });

  it('downwind dither of crewY around 0 flips nobody and stays smooth', () => {
    const crew = placed(0.01);
    const before = [meanX(crew, 0), meanX(crew, 1)];
    const r = run(crew, 8, (t) => ({ crewY: 0.05 * Math.sin(t * 2 * Math.PI * 0.9) + 0.02 * Math.sin(t * 5.1), heel: 0.03 * Math.sin(t * 1.3) }));
    expect(r.vertex).toBeLessThanOrEqual(MAX_STEP);
    expect(Math.sign(meanX(crew, 0))).toBe(Math.sign(before[0]));
    expect(Math.sign(meanX(crew, 1))).toBe(Math.sign(before[1]));
  });

  it('breeze building to full hike (legs over the rail) and easing again', () => {
    const crew = placed(0.5);
    const r = run(crew, 12, (t) => ({ crewY: 0.55 + 0.45 * Math.sin((t * 2 * Math.PI) / 8), heel: -0.3 * (0.55 + 0.45 * Math.sin((t * 2 * Math.PI) / 8)) }));
    expect(r.vertex).toBeLessThanOrEqual(MAX_STEP);
  });

  it('a paused update (dt = 0) neither moves nor rewrites the crew', () => {
    const crew = placed(1);
    run(crew, 1, () => ({ crewY: 1, heel: -0.25 }));
    const v0 = version(crew);
    const before = snapshot(crew);
    for (let k = 0; k < 10; k++) crew.update({ crewY: -1, heel: 0.25, tillerEnd, mainsheetCam: cam }, 0);
    // The new input is applied (rewritten once) but nobody walks while paused.
    expect(maxStep(before, snapshot(crew))).toBeLessThan(0.05);
    const v2 = version(crew);
    for (let k = 0; k < 10; k++) crew.update({ crewY: -1, heel: 0.25, tillerEnd, mainsheetCam: cam }, 0);
    expect(version(crew)).toBe(v2);
    expect(v2 - v0).toBeLessThanOrEqual(1);
  });

  it('snap() places the crew on the new side without walking', () => {
    const crew = placed(1);
    crew.snap();
    crew.update({ crewY: -1, heel: 0.25, tillerEnd, mainsheetCam: cam }, 0);
    expect(meanX(crew, 0)).toBeLessThan(-0.3);
    expect(meanX(crew, 1)).toBeLessThan(-0.3);
  });
});
