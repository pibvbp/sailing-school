// A spinnaker gybe must animate, not pop. The simulation moves the pole end-for-end in one step (its tack
// and clew mirror across the boat); on the water the old clew is clipped to the pole and becomes the new
// tack while the kite keeps flying. The rendered kite must follow that: corners that never jump, a belly
// that never turns inside out, low rows that never pass through themselves.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Simulation } from '../../../sim/simulation';
import { AutoCrew } from '../../../sim/autocrew';
import { BOAT } from '../../../shared/boatSpec';
import type { SailSection, SpinnakerState } from '../../../sim/types';
import { SpinShape } from '../spinMesh';
import { toLocal } from '../sailMesh';

// Each run simulates about half a minute at 120 Hz: allow for a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

const DEG = Math.PI / 180;
const KN = 0.514444;
const FRAME = 1 / 60;

/** Rendered foot corners (grid columns 0 and nu − 1 of the bottom row). */
function corners(s: SpinShape): [THREE.Vector3, THREE.Vector3] {
  const o = s.surface.out, o1 = (s.surface.nu - 1) * 3;
  return [new THREE.Vector3(o[0], o[1], o[2]), new THREE.Vector3(o[o1], o[o1 + 1], o[o1 + 2])];
}

/** How far the two corners moved since last frame, whichever way round they are labelled now. */
function cornerStep(now: [THREE.Vector3, THREE.Vector3], before: [THREE.Vector3, THREE.Vector3]): number {
  const kept = Math.max(now[0].distanceTo(before[0]), now[1].distanceTo(before[1]));
  const swapped = Math.max(now[0].distanceTo(before[1]), now[1].distanceTo(before[0]));
  return Math.min(kept, swapped);
}

/** Largest vertex move since last frame, matching the grid either as is or mirrored (a relabel). */
function vertexStep(s: SpinShape, prev: Float32Array): number {
  const { nu, nv, out } = s.surface;
  let best = Infinity;
  for (const mirrored of [false, true]) {
    let m = 0;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = (j * nu + i) * 3, q = (j * nu + (mirrored ? nu - 1 - i : i)) * 3;
        m = Math.max(m, Math.hypot(out[k]! - prev[q]!, out[k + 1]! - prev[q + 1]!, out[k + 2]! - prev[q + 2]!));
      }
    }
    best = Math.min(best, m);
  }
  return best;
}

/**
 * Cosine between the rendered belly at mid height (middle vertex minus the midpoint of the row's ends) and
 * the contract's belly direction leewardY · (chordDir.y, −chordDir.x, 0) of the middle section.
 */
function bellyAlignment(s: SpinShape, state: SpinnakerState): number {
  const sec = state.sections[Math.floor(state.sections.length / 2)]!;
  const want = toLocal({ x: sec.leewardY * sec.chordDir.y, y: -sec.leewardY * sec.chordDir.x, z: 0 }, new THREE.Vector3()).normalize();
  const { nu, nv, out } = s.surface;
  const j = Math.round(sec.h * (nv - 1));
  const a = j * nu * 3, b = (j * nu + nu - 1) * 3, m = (j * nu + (nu >> 1)) * 3;
  return new THREE.Vector3(
    out[m]! - (out[a]! + out[b]!) / 2, out[m + 1]! - (out[a + 1]! + out[b + 1]!) / 2, out[m + 2]! - (out[a + 2]! + out[b + 2]!) / 2,
  ).normalize().dot(want);
}

/** Rows 1–3 run from tack to clew without doubling back (the cloth does not pass through itself). */
function lowRowsReversed(s: SpinShape): number {
  const { nu, out } = s.surface;
  let bad = 0;
  for (let j = 1; j <= 3; j++) {
    const r0 = j * nu * 3, r1 = (j * nu + nu - 1) * 3;
    const ex = out[r1]! - out[r0]!, ey = out[r1 + 1]! - out[r0 + 1]!, ez = out[r1 + 2]! - out[r0 + 2]!;
    for (let i = 0; i < nu - 1; i++) {
      const k = (j * nu + i) * 3;
      if ((out[k + 3]! - out[k]!) * ex + (out[k + 4]! - out[k + 1]!) * ey + (out[k + 5]! - out[k + 2]!) * ez < 0) bad++;
    }
  }
  return bad;
}

interface Watch { maxCorner: number; maxVertexNearFlip: number; worstBelly: number; beliesChecked: number; reversed: number }

/** Drive a SpinShape at 60 fps from `next()` states; `flipFrame` marks where the input jumps. */
function watch(frames: number, next: (f: number) => { state: SpinnakerState; t: number; aws: number }, flipAt: () => number): Watch & { shape: SpinShape } {
  const shape = new SpinShape(1);
  const w: Watch = { maxCorner: 0, maxVertexNearFlip: 0, worstBelly: 1, beliesChecked: 0, reversed: 0 };
  let prevCorners: [THREE.Vector3, THREE.Vector3] | null = null;
  const prev = new Float32Array(shape.surface.count * 3);
  for (let f = 0; f < frames; f++) {
    const { state, t, aws } = next(f);
    shape.update(FRAME, t, state, aws);
    const c = corners(shape);
    if (prevCorners && f > 60) {
      w.maxCorner = Math.max(w.maxCorner, cornerStep(c, prevCorners));
      const flip = flipAt();
      if (flip > 0 && f >= flip - 5 && f <= flip + 60) w.maxVertexNearFlip = Math.max(w.maxVertexNearFlip, vertexStep(shape, prev));
      if (state.collapsed < 0.1) {
        w.worstBelly = Math.min(w.worstBelly, bellyAlignment(shape, state));
        w.beliesChecked++;
      }
      w.reversed += lowRowsReversed(shape);
    }
    prevCorners = c;
    prev.set(shape.surface.out);
  }
  return { ...w, shape };
}

describe('spinnaker gybe (real Simulation + AutoCrew)', () => {
  for (const [tws, twa] of [[12, 150], [20, 150]] as const) {
    it(`${tws} kn, TWA ${twa}° → −${twa}°: the kite flies across without a pop`, () => {
      const sim = new Simulation({
        wind: { tws: tws * KN, twd: twa * DEG, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 5 },
        boat: { u: 3 }, spinnakerSet: true, controls: { helmMode: 'twa', helmTarget: twa * DEG },
      });
      sim.crew = new AutoCrew();
      const tack = new THREE.Vector3();
      let side = 0, flips = 0, flipFrame = -1;
      let gybed = false;
      const w = watch(60 * 34, (f) => {
        if (f === 60 * 20) sim.controls.command = 'gybe';
        sim.step();
        sim.step();
        const snap = sim.snapshot();
        if (snap.events.some((e) => e.type === 'gybeComplete')) gybed = true;
        const s = Math.sign(toLocal(snap.sails.spinnaker.tack, tack).x);
        if (side !== 0 && s !== side) { flips++; flipFrame = f; }
        side = s;
        return { state: snap.sails.spinnaker, t: snap.t, aws: snap.wind.aws };
      }, () => flipFrame);

      // The simulation really did gybe the kite: the pole went end-for-end once.
      expect(gybed).toBe(true);
      expect(flips).toBe(1);
      expect(sim.twa / DEG).toBeLessThan(-twa + 10);
      // No corner moves more than a few centimetres per frame, before, through or after the gybe.
      expect(w.maxCorner).toBeLessThan(0.04);
      // Around the gybe the cloth moves no faster than ordinary flying (the pop moved it 0.3–0.45 m/frame).
      expect(w.maxVertexNearFlip).toBeLessThan(0.2);
      // The belly is always on the side the contract gives, and the foot never passes through itself.
      expect(w.beliesChecked).toBeGreaterThan(1000);
      expect(w.worstBelly).toBeGreaterThan(0.5);
      expect(w.reversed).toBe(0);
      // The old clew became the new tack: after the glide the kite's corners sit on the snapshot's corners.
      const snap = sim.snapshot().sails.spinnaker;
      const [c0, c1] = corners(w.shape);
      const tk = toLocal(snap.tack, new THREE.Vector3()), cl = toLocal(snap.clew, new THREE.Vector3());
      expect(Math.min(c0.distanceTo(tk) + c1.distanceTo(cl), c0.distanceTo(cl) + c1.distanceTo(tk))).toBeLessThan(0.02);
    });
  }
});

describe('spinnaker gybe (mirrored input)', () => {
  /** The kite of the unit tests, flown with the pole to starboard (side +1) or mirrored to port (−1). */
  const kite = (side: number): SpinnakerState => {
    const S = BOAT.spinnaker;
    const tack = { x: 2.5, y: 2.2 * side, z: -2.4 }, clew = { x: 2.9, y: -2.9 * side, z: -2.4 };
    const head = { x: S.head.x + 0.35, y: 0, z: -(S.head.h - 0.15) };
    const sections: SailSection[] = [];
    for (let i = 0; i < 6; i++) {
      const t = (i + 0.5) / 6;
      sections.push({
        h: t, luff: { x: tack.x + (head.x - tack.x) * t, y: tack.y * (1 - t), z: tack.z + (head.z - tack.z) * t },
        chordDir: { x: 0.08, y: -0.997 * side, z: 0 }, chord: S.foot * (1 - t) + 1.3 * Math.sin(Math.PI * t), camber: 0.27,
        draft: 0.45, leewardY: -side, aoa: 0.5, luffing: 0, stall: 0, cl: 1, cd: 0.3, q: 20,
      });
    }
    const zero = { x: 0, y: 0, z: 0 };
    return {
      id: 'spinnaker', set: true, area: S.area, tack, clew, sections, force: zero, ce: zero, lift: 0, drag: 0, drive: 0,
      heelForce: 0, telltales: [], hoist: 1, poleAngle: 1, poleTip: tack, poleHeight: 2.4, collapsed: 0, curl: 0, head,
    };
  };

  it('relabels the cloth when the corners swap sides, gliding the foot and keeping the belly forward', () => {
    const before = kite(1), after = kite(-1);
    const w = watch(240, (f) => ({ state: f < 120 ? before : after, t: f * FRAME, aws: 7 }), () => 120);
    expect(w.maxCorner).toBeLessThan(0.04);
    expect(w.maxVertexNearFlip).toBeLessThan(0.2);
    expect(w.worstBelly).toBeGreaterThan(0.5);
    expect(w.reversed).toBe(0);
  });

  it('flips back and forth (a flickering rig side) without ever jumping', () => {
    // Flips at frames 120, 150 and 170: each one starts from wherever the last glide had got to.
    const w = watch(320, (f) => ({ state: f < 120 || (f >= 150 && f < 170) ? kite(1) : kite(-1), t: f * FRAME, aws: 7 }), () => 120);
    expect(w.maxCorner).toBeLessThan(0.05);
    expect(w.worstBelly).toBeGreaterThan(0.5);
    expect(w.reversed).toBe(0);
  });
});
