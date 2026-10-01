// The force arrows' geometry: length against force for a reduced force set (lesson 10 step 4 "Depower": the learner
// watches the heeling arrow shrink as they depower, so it must never grow while the force falls, nor creep while
// nothing changes); lift square to the apparent wind; the x-ray's leeway on the leeward side.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { SimSnapshot } from '../../../sim/types';
import { tierSettings } from '../../core/types';
import { Overlays } from '../Overlays';
import { windAtBodyPoint, pointWind } from '../frames';
import type { ArrowBatch } from '../arrows';
import { ForceOverlay } from '../forces';
import { BoatFrame } from '../frames';
import type { LabelLayer } from '../labels';
import type { LineBatch } from '../lines';
import { DEG } from '../../../shared/math';
import { COLORS, linearColor } from '../palette';
import { sail } from './helpers';

const HEEL = linearColor(COLORS.heel);

/** Records each arrow's colour and length; everything else is a no-op. */
function rig() {
  const drawn: { color: THREE.Color; len: number }[] = [];
  const arrows = { add: (a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color) => { drawn.push({ color, len: a.distanceTo(b) }); } };
  const noop: unknown = new Proxy(function () {}, { get: () => noop, apply: () => noop });
  const layer = { create: () => noop } as unknown as LabelLayer;
  const ov = new ForceOverlay(arrows as unknown as ArrowBatch, noop as LineBatch, layer);
  const frame = new BoatFrame();
  frame.update(new THREE.Group());
  const heelArrow = (s: SimSnapshot, frames: number, dt = 1 / 60): number => {
    for (let i = 0; i < frames; i++) { drawn.length = 0; ov.update(dt, s, frame, false); }
    const a = drawn.find((d) => d.color.equals(HEEL));
    if (!a) throw new Error('no heeling arrow');
    return a.len;
  };
  return { ov, heelArrow };
}

/** The snapshot with the sails' force scaled by `k` (heeling force, drive and the 3-D aerodynamic force alike). */
function scaled(s: SimSnapshot, k: number): SimSnapshot {
  const c = structuredClone(s);
  c.forces.sideForce *= k;
  c.forces.drive *= k;
  const a = c.forces.aero.force;
  a.x *= k; a.y *= k; a.z *= k;
  return c;
}

describe('force scale of a reduced set', () => {
  it('a falling heeling force gives a shorter arrow, in proportion, however long the step lasts', () => {
    const { snap } = sail(16, 45);
    const { ov, heelArrow } = rig();
    ov.setParts(['heel', 'helm']);
    const before = heelArrow(snap, 120);
    const low = scaled(snap, 0.85);
    // Two seconds and a minute after depowering: the arrow is 15 % shorter both times.
    expect(heelArrow(low, 120) / before).toBeCloseTo(0.85, 2);
    expect(heelArrow(low, 3600) / before).toBeCloseTo(0.85, 2);
  });

  it('does not creep while the boat is paused', () => {
    const { snap } = sail(16, 45);
    const { ov, heelArrow } = rig();
    ov.setParts(['heel', 'helm']);
    heelArrow(snap, 60);
    const low = scaled(snap, 0.6);
    const first = heelArrow(low, 60);
    expect(heelArrow(low, 60 * 120) / first).toBeCloseTo(1, 3);
  });

  it('takes its scale from the drawn forces, not the whole aerodynamic force', () => {
    const { snap } = sail(16, 45);
    const { ov, heelArrow } = rig();
    ov.setParts(['heel', 'helm']);
    const before = heelArrow(snap, 60);
    // A larger aerodynamic force that is not drawn (more drive, same heeling force) leaves the arrow alone.
    const c = structuredClone(snap);
    c.forces.drive *= 3;
    c.forces.aero.force.x *= 3;
    expect(heelArrow(c, 120) / before).toBeCloseTo(1, 3);
  });

  it('a new set of parts starts a new scale', () => {
    const { snap } = sail(16, 45);
    const { ov, heelArrow } = rig();
    ov.setParts(['heel', 'helm']);
    const full = heelArrow(snap, 60);
    const low = scaled(snap, 0.5);
    expect(heelArrow(low, 60) / full).toBeCloseTo(0.5, 2);
    ov.setParts(['heel']);
    expect(heelArrow(low, 1) / full).toBeCloseTo(1, 2);
  });
});

/** Run the real overlays on a sailing boat and record every arrow drawn in the last frame, with its colour. */
function drawnArrows(twa: number, keys: readonly ('forces' | 'xray' | 'aoa')[], parts: Parameters<Overlays['setForceParts']>[0] = null) {
  const { sim } = sail(12, twa, { seconds: 20 });
  const scene = new THREE.Scene();
  const boat = new THREE.Group();
  scene.add(boat);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
  const ov = new Overlays(scene, boat, tierSettings('low'));
  ov.setForceParts(parts);
  for (const k of keys) ov.set(k, true);
  const batch = (ov as unknown as { arrows: ArrowBatch }).arrows;
  const drawn: { a: THREE.Vector3; b: THREE.Vector3; color: THREE.Color }[] = [];
  const lines: Float32Array[] = [];
  const lineBatch = (ov as unknown as { forceLines: LineBatch }).forceLines;
  const addLine = lineBatch.add.bind(lineBatch);
  vi.spyOn(lineBatch, 'add').mockImplementation((xyz, count, ...rest) => { lines.push(Float32Array.from(Array.from(xyz).slice(0, 3 * count))); addLine(xyz, count, ...rest); });
  const add = batch.add.bind(batch);
  vi.spyOn(batch, 'add').mockImplementation((a, b, color, style, alpha) => { drawn.push({ a: a.clone(), b: b.clone(), color: color.clone() }); add(a, b, color, style, alpha); });
  let s = sim.snapshot();
  for (let i = 0; i < 90; i++) {
    sim.step(); sim.step();
    s = sim.snapshot();
    boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
    boat.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
    camera.position.set(boat.position.x + 12, 8, boat.position.z + 15);
    camera.lookAt(boat.position);
    drawn.length = 0;
    lines.length = 0;
    ov.update(1 / 60, s, camera);
  }
  ov.dispose();
  return { s, drawn, lines };
}

/** Unit vector to starboard (level, world) for a heading. */
const starboard = (psi: number) => new THREE.Vector3(Math.cos(psi), 0, Math.sin(psi));

describe('force geometry', () => {
  for (const twa of [40, 60, 90, 120]) {
    it(`lift stands square to the apparent wind and points to leeward (${twa}° to the wind)`, () => {
      const { s, drawn } = drawnArrows(twa, ['forces'], ['liftDrag']);
      const lift = drawn.filter((d) => d.color.equals(linearColor(COLORS.lift)));
      expect(lift.length).toBeGreaterThan(0);
      const w = pointWind();
      const windSide = Math.sign(s.wind.twa);
      for (const sail of [s.sails.main, s.sails.jib]) {
        windAtBodyPoint(s, sail.ce.x, sail.ce.y, sail.ce.z, w);
        const level = new THREE.Vector3(w.appW.x, 0, w.appW.z).normalize();
        // The arrow drawn for this sail (from its centre of effort, the nearest tail).
        const arrow = lift.reduce((best, d) => (Math.abs(d.a.y + sail.ce.z) < Math.abs(best.a.y + sail.ce.z) ? d : best));
        const v = arrow.b.clone().sub(arrow.a);
        v.y = 0;
        if (v.length() < 1e-3) continue;
        expect(Math.abs(v.normalize().dot(level))).toBeLessThan(0.02);
        expect(Math.sign(v.dot(starboard(s.boat.heading)))).toBe(-windSide);
      }
    });
  }

  for (const twa of [45, -45, 90]) {
    it(`the x-ray's track arrow lies to leeward of the heading by the leeway (${twa}° to the wind)`, () => {
      const { s, drawn } = drawnArrows(twa, ['xray']);
      const heading = drawn.find((d) => d.color.equals(linearColor(COLORS.heading)))!;
      const track = drawn.find((d) => d.color.equals(linearColor(COLORS.track)))!;
      expect(heading && track).toBeTruthy();
      const h = heading.b.clone().sub(heading.a).normalize(), t = track.b.clone().sub(track.a).normalize();
      // Leeward, as the boat really slips (her sideways speed through the water), and by the leeway angle.
      const side = Math.sign(t.clone().sub(h).dot(starboard(s.boat.heading)));
      expect(side).toBe(-Math.sign(s.wind.twa));
      expect(side).toBe(Math.sign(s.boat.v));
      expect(Math.acos(Math.min(1, h.dot(t)))).toBeCloseTo(Math.abs(s.boat.leeway), 2);
    });
  }
});

describe('angle-of-attack arc', () => {
  for (const twa of [50, 90]) {
    it(`spans the angle in its tag, from the chord line (${twa}° to the wind)`, () => {
      const { s, lines } = drawnArrows(twa, ['forces', 'aoa'], ['liftDrag']);
      const secs = s.sails.main.sections;
      const aoa = secs.reduce((sum, sec) => sum + sec.aoa, 0) / secs.length;
      // The arc is the 9-point line; the chord is a 2-point line ending ahead of the luff.
      const arc = lines.find((l) => l.length === 3 * 9)!;
      expect(arc).toBeTruthy();
      const p = (i: number) => new THREE.Vector3(arc[3 * i]!, arc[3 * i + 1]!, arc[3 * i + 2]!);
      // Centre: the arc is a circle round the luff; take it from three of its points.
      const a = p(0), b = p(4), c = p(8);
      const ab = b.clone().sub(a), ac = c.clone().sub(a), n = ab.clone().cross(ac);
      const centre = a.clone().add(
        n.clone().cross(ab).multiplyScalar(ac.lengthSq()).add(ac.clone().cross(n).multiplyScalar(ab.lengthSq())).divideScalar(2 * n.lengthSq()),
      );
      const angle = a.clone().sub(centre).angleTo(c.clone().sub(centre));
      expect(angle / DEG).toBeCloseTo(Math.abs(aoa) / DEG, 1);
      // It starts on the chord: the chord line passes through the arc's first point's direction from the luff.
      const chord = lines.filter((l) => l.length === 6).map((l) => new THREE.Vector3(l[3]!, l[4]!, l[5]!).sub(centre).normalize());
      const start = a.clone().sub(centre).normalize();
      expect(Math.max(...chord.map((d) => d.dot(start)))).toBeGreaterThan(0.9999);
    });
  }
});
