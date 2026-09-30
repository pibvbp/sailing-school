import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BOAT } from '../../../shared/boatSpec';
import type { MainState, SailSection, SpinnakerState } from '../../../sim/types';
import { KnotCurve, SailRows, SailSurface, SideField, camberShape, toLocal } from '../sailMesh';
import { MAIN_BATTENS, MAIN_FOOT_LIFT, MainShape, mainPlanChord } from '../mainMesh';
import { JibShape } from '../jibMesh';
import { SpinShape } from '../spinMesh';

const DEG = Math.PI / 180;
const G = BOAT.boom.gooseneck;

/** A main laid out like the simulation's (src/sim/sails/main.ts): 8 sections, boom `boomDeg` to port. */
function mainState(opts: { boomDeg?: number; side?: number; camber?: number; luffing?: number; nan?: boolean } = {}): MainState {
  const beta = (opts.boomDeg ?? 8) * DEG;
  const sections: SailSection[] = [];
  for (let i = 0; i < 8; i++) {
    const h = (i + 0.5) / 8;
    const th = beta + 8 * DEG * h ** 1.4;
    sections.push({
      h, luff: { x: G.x, y: 0, z: -(G.h + h * BOAT.main.P) }, chordDir: { x: -Math.cos(th), y: -Math.sin(th), z: 0 },
      chord: opts.nan && i === 3 ? Number.NaN : mainPlanChord(h), camber: opts.camber ?? 0.11, draft: 0.46,
      leewardY: opts.side ?? -1, aoa: 0.2, luffing: opts.luffing ?? 0, stall: 0, cl: 1, cd: 0.05, q: 30,
    });
  }
  const zero = { x: 0, y: 0, z: 0 };
  return {
    id: 'main', set: true, area: BOAT.main.area, tack: { x: G.x, y: 0, z: -G.h },
    clew: { x: G.x - Math.cos(beta) * BOAT.main.E, y: -Math.sin(beta) * BOAT.main.E, z: -G.h },
    head: { x: G.x, y: 0, z: -(G.h + BOAT.main.P) }, sections, force: zero, ce: zero, lift: 0, drag: 0, drive: 0,
    heelForce: 0, telltales: [], boomAngle: beta, boomRate: 0, twistDeg: 8,
  };
}

const vtx = (s: SailSurface, i: number, j: number, arr = s.target) => {
  const k = (j * s.nu + i) * 3;
  return new THREE.Vector3(arr[k], arr[k + 1], arr[k + 2]);
};

describe('KnotCurve', () => {
  it('passes exactly through its knots and is smooth between them', () => {
    const c = new KnotCurve(1);
    const ts = [0, 0.1, 0.35, 0.6, 1];
    const vs = [0, 0.4, 0.9, 0.7, 0.2];
    ts.forEach((t, i) => c.push(t, [vs[i]!]));
    c.finish();
    const out = new Float64Array(1);
    ts.forEach((t, i) => { c.valueAt(t, out); expect(out[0]).toBeCloseTo(vs[i]!, 9); });
    // C1: the slope just left and right of an interior knot agree.
    const d = new Float64Array(1);
    c.valueAt(0.35 - 1e-6, out, 0, d); const left = d[0]!;
    c.valueAt(0.35 + 1e-6, out, 0, d); const right = d[0]!;
    expect(Math.abs(left - right)).toBeLessThan(1e-3);
  });

  it('keeps a straight line straight (the luff of a straight mast or forestay)', () => {
    const c = new KnotCurve(1);
    for (const t of [0, 0.2, 0.45, 0.8, 1]) c.push(t, [3 + 2 * t]);
    c.finish();
    const out = new Float64Array(1);
    for (let t = 0; t <= 1; t += 0.05) { c.valueAt(t, out); expect(out[0]).toBeCloseTo(3 + 2 * t, 6); }
  });
});

describe('camberShape', () => {
  it('is 0 at the luff and leech, 1 at the draft, and never overshoots', () => {
    for (const d of [0.35, 0.45, 0.55]) {
      expect(camberShape(0, d, 2.4, 1.2)).toBe(0);
      expect(camberShape(1, d, 2.4, 1.2)).toBe(0);
      expect(camberShape(d, d, 2.4, 1.2)).toBeCloseTo(1, 9);
      for (let u = 0; u <= 1; u += 0.01) {
        const f = camberShape(u, d, 2.4, 1.2);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe('SailRows', () => {
  it('interpolates luff and leech through the section points and the corners (boat-local frame)', () => {
    const s = mainState();
    const rows = new SailRows(81);
    const L = (p: { x: number; y: number; z: number }) => toLocal(p, new THREE.Vector3());
    const head = L(s.head);
    rows.build(s.sections, L(s.tack), L(s.clew), head, head, 'luff');
    for (const sec of s.sections) {
      const j = Math.round(sec.h * 80);
      if (Math.abs(j / 80 - sec.h) > 1e-9) continue;
      const luff = L(sec.luff);
      expect(rows.L[j * 3]).toBeCloseTo(luff.x, 5);
      expect(rows.L[j * 3 + 1]).toBeCloseTo(luff.y, 5);
      expect(rows.chord[j]).toBeCloseTo(sec.chord, 4);
    }
    // Foot row runs tack → clew.
    expect(rows.T[1]).toBeCloseTo(L(s.clew).y, 6);
    expect(rows.T[2]).toBeCloseTo(L(s.clew).z, 6);
  });

  it('builds the belly normal as leewardY · (chordDir.y, −chordDir.x, 0) in the body frame', () => {
    const s = mainState({ boomDeg: 30 });
    const rows = new SailRows(41);
    const L = (p: { x: number; y: number; z: number }) => toLocal(p, new THREE.Vector3());
    rows.build(s.sections, L(s.tack), L(s.clew), L(s.head), L(s.head), 'luff');
    const sec = s.sections[4]!;
    const j = Math.round(sec.h * 40);
    const n = new THREE.Vector3(rows.N[j * 3], rows.N[j * 3 + 1], rows.N[j * 3 + 2]);
    const want = toLocal({ x: sec.chordDir.y, y: -sec.chordDir.x, z: 0 }, new THREE.Vector3()).normalize();
    expect(n.dot(want)).toBeGreaterThan(0.99);
  });
});

describe('MainShape', () => {
  it('bellies to the side the contract says, by ≈ camber × chord', () => {
    for (const side of [-1, 1]) {
      const m = new MainShape(1);
      const s = mainState({ side, camber: 0.1 });
      m.update(1 / 60, 0, s, 6);
      const j = Math.round(0.5 * (m.surface.nv - 1));
      const L = vtx(m.surface, 0, j), T = vtx(m.surface, m.surface.nu - 1, j);
      const chord = T.clone().sub(L);
      let best = 0;
      for (let i = 0; i < m.surface.nu; i++) {
        const p = vtx(m.surface, i, j).sub(L);
        const off = p.clone().sub(chord.clone().multiplyScalar(p.dot(chord) / chord.lengthSq()));
        if (off.length() > Math.abs(best)) best = off.length() * Math.sign(off.x);
      }
      // Body y (starboard) is local +X: side −1 bellies to port (−X).
      expect(Math.sign(best)).toBe(side);
      expect(Math.abs(best)).toBeGreaterThan(0.1 * chord.length() * 0.85);
      expect(Math.abs(best)).toBeLessThan(0.1 * chord.length() * 1.15);
    }
  });

  it('keeps the luff on the mast and the corners on tack, clew and head', () => {
    const m = new MainShape(1);
    const s = mainState({ boomDeg: 20 });
    m.update(1 / 60, 0, s, 6);
    const sf = m.surface;
    const tack = toLocal(s.tack, new THREE.Vector3()), clew = toLocal(s.clew, new THREE.Vector3());
    tack.y += MAIN_FOOT_LIFT; clew.y += MAIN_FOOT_LIFT;
    expect(vtx(sf, 0, 0).distanceTo(tack)).toBeLessThan(1e-4);
    expect(vtx(sf, sf.nu - 1, 0).distanceTo(clew)).toBeLessThan(1e-4);
    expect(vtx(sf, 0, sf.nv - 1).distanceTo(toLocal(s.head, new THREE.Vector3()))).toBeLessThan(1e-4);
    for (let j = 0; j < sf.nv; j++) expect(Math.abs(vtx(sf, 0, j).x)).toBeLessThan(1e-4);
  });

  it('carries roach: the leech bulges aft of the straight clew–head line', () => {
    const m = new MainShape(1);
    m.update(1 / 60, 0, mainState({ boomDeg: 0 }), 6);
    const sf = m.surface;
    const clew = vtx(sf, sf.nu - 1, 0), head = vtx(sf, sf.nu - 1, sf.nv - 1);
    const j = Math.round(0.5 * (sf.nv - 1));
    const leech = vtx(sf, sf.nu - 1, j);
    const t = (leech.y - clew.y) / (head.y - clew.y);
    const straightZ = clew.z + (head.z - clew.z) * t;
    expect(leech.z - straightZ).toBeGreaterThan(0.25); // aft = +Z
  });

  it('winds its triangles so the front face (and the normal) is the starboard side', () => {
    const m = new MainShape(1);
    m.update(1 / 60, 0, mainState({ boomDeg: 0, side: 1 }), 6);
    const g = m.surface.geometry;
    const idx = g.getIndex()!;
    const pos = g.getAttribute('position');
    const a = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(0));
    const b = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(1));
    const c = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(2));
    const faceN = b.sub(a).cross(c.sub(a)).normalize();
    expect(faceN.x).toBeGreaterThan(0.9);
    const k = (Math.round(m.surface.nv / 2) * m.surface.nu + 5) * 3;
    expect(m.surface.nrm[k]).toBeGreaterThan(0.8);
  });

  it('turns over luff first and keeps the battens curved until they flick', () => {
    const m = new MainShape(1);
    m.update(1 / 60, 0, mainState({ side: -1 }), 6);
    const sf = m.surface;
    const j = Math.round(0.6 * (sf.nv - 1));
    const sideAt = (i: number) => {
      const L = vtx(sf, 0, j), T = vtx(sf, sf.nu - 1, j), p = vtx(sf, i, j);
      const c = T.clone().sub(L);
      const q = p.sub(L);
      return q.sub(c.multiplyScalar(q.dot(c) / c.lengthSq())).x;
    };
    // Flip the wind: after 0.12 s the front of the sail has crossed, the leech has not.
    for (let k = 1; k <= 7; k++) m.update(1 / 60, k / 60, mainState({ side: 1 }), 6);
    expect(sideAt(Math.round(sf.nu * 0.25))).toBeGreaterThan(0);
    expect(sideAt(sf.nu - 3)).toBeLessThan(0);
    // After a second everything has gone over, battens included.
    for (let k = 8; k <= 70; k++) m.update(1 / 60, k / 60, mainState({ side: 1 }), 6);
    for (const i of [5, 12, sf.nu - 3]) expect(sideAt(i)).toBeGreaterThan(0);
  });

  it('is stable at 30 fps and snaps to a sane shape after a huge frame', () => {
    const m = new MainShape(1);
    m.update(1 / 30, 0, mainState({ side: -1 }), 8);
    let maxSpeed = 0;
    for (let k = 1; k < 300; k++) {
      m.update(1 / 30, k / 30, mainState({ side: k % 60 < 30 ? -1 : 1, boomDeg: k % 60 < 30 ? 10 : -10 }), 8);
      for (let q = 0; q < m.surface.vel.length; q++) maxSpeed = Math.max(maxSpeed, Math.abs(m.surface.vel[q]!));
    }
    expect(Number.isFinite(maxSpeed)).toBe(true);
    expect(maxSpeed).toBeLessThan(40);
    m.update(5, 20, mainState({ side: 1 }), 8);
    for (const x of m.surface.out) expect(Number.isFinite(x)).toBe(true);
  });

  it('settles on the target when nothing excites it', () => {
    const m = new MainShape(1);
    const s = mainState({ side: -1 });
    m.update(1 / 60, 0, s, 0);
    for (let k = 1; k < 240; k++) m.update(1 / 60, 0, s, 0);
    let err = 0;
    for (let q = 0; q < m.surface.pos.length; q++) err = Math.max(err, Math.abs(m.surface.pos[q]! - m.surface.target[q]!));
    expect(err).toBeLessThan(2e-3);
  });

  it('survives a NaN chord in the input without poisoning the mesh', () => {
    const m = new MainShape(1);
    m.update(1 / 60, 0, mainState({ nan: true }), 6);
    for (const x of m.surface.out) expect(Number.isFinite(x)).toBe(true);
  });

  it('places the leech telltale anchors at the batten ends', () => {
    const m = new MainShape(1);
    expect(m.battenEnds.map((b) => b.v)).toEqual(MAIN_BATTENS.map((b) => b.v));
    for (const b of m.battenEnds) expect(b.u).toBe(1);
  });
});

describe('SailSurface.locate', () => {
  it('finds the grid coordinates of a point on the surface', () => {
    const m = new MainShape(1);
    m.update(1 / 60, 0, mainState(), 6);
    const p = new THREE.Vector3();
    for (const [u, v] of [[0.12, 0.25], [0.5, 0.5], [0.9, 0.8]] as const) {
      m.surface.sample(u, v, p);
      const found = m.surface.locate(p);
      expect(Math.abs(found.u - u)).toBeLessThan(0.02);
      expect(Math.abs(found.v - v)).toBeLessThan(0.02);
    }
  });
});

describe('SideField', () => {
  it('lags more at the leech than at the luff', () => {
    const u = new Float32Array([0, 0.5, 1]);
    const f = new SideField(3, 1, u);
    f.update(new Float32Array([-1]), 1 / 60);
    const v = f.update(new Float32Array([1]), 0.1);
    expect(v[0]!).toBeGreaterThan(v[1]!);
    expect(v[1]!).toBeGreaterThan(v[2]!);
  });
});

describe('JibShape', () => {
  it('keeps its luff on the forestay line from tack to head', () => {
    const J = BOAT.jib;
    const j = new JibShape(1);
    const sections: SailSection[] = [];
    for (let i = 0; i < 8; i++) {
      const z = J.tack.h + 0.08 + (i + 0.5) * ((J.head.h - 0.3 - J.tack.h - 0.08) / 8);
      const s = (z - J.tack.h) / (J.head.h - J.tack.h);
      sections.push({
        h: s, luff: { x: J.tack.x + (J.head.x - J.tack.x) * s, y: 0, z: -z }, chordDir: { x: -0.98, y: -0.2, z: 0 },
        chord: 3.2 * (1 - s) + 0.1, camber: 0.12, draft: 0.42, leewardY: -1, aoa: 0.2, luffing: 0, stall: 0, cl: 1, cd: 0.05, q: 30,
      });
    }
    const zero = { x: 0, y: 0, z: 0 };
    j.update(1 / 60, 0, {
      id: 'jib', set: true, area: J.area, tack: { x: J.tack.x, y: 0, z: -J.tack.h }, clew: { x: 0.6, y: -0.7, z: -J.clewH },
      head: { x: J.head.x, y: 0, z: -J.head.h }, sections, force: zero, ce: zero, lift: 0, drag: 0, drive: 0, heelForce: 0,
      telltales: [], clewAngle: 0.2, furl: 0, backed: false, whisker: false,
    }, 6);
    const a = new THREE.Vector3(0, J.tack.h, -J.tack.x), b = new THREE.Vector3(0, J.head.h, -J.head.x);
    const line = new THREE.Line3(a, b);
    const q = new THREE.Vector3();
    for (let jj = 0; jj < j.surface.nv; jj++) {
      const p = vtx(j.surface, 0, jj);
      line.closestPointToPoint(p, true, q);
      expect(p.distanceTo(q)).toBeLessThan(1e-3);
    }
  });
});

describe('SpinShape', () => {
  const spin = (hoist: number): SpinnakerState => {
    const S = BOAT.spinnaker;
    const tack = { x: 2.5, y: 2.2, z: -2.4 }, clew = { x: 2.9, y: -2.9, z: -2.4 };
    const head = { x: S.head.x + 0.35, y: 0, z: -(S.head.h - 0.15) };
    const sections: SailSection[] = [];
    for (let i = 0; i < 6; i++) {
      const t = (i + 0.5) / 6;
      sections.push({
        h: t, luff: { x: tack.x + (head.x - tack.x) * t, y: tack.y * (1 - t), z: tack.z + (head.z - tack.z) * t },
        chordDir: { x: 0.08, y: -0.997, z: 0 }, chord: S.foot * (1 - t) + 1.3 * Math.sin(Math.PI * t), camber: 0.27, draft: 0.45,
        leewardY: -1, aoa: 0.5, luffing: 0, stall: 0, cl: 1, cd: 0.3, q: 20,
      });
    }
    const zero = { x: 0, y: 0, z: 0 };
    return {
      id: 'spinnaker', set: hoist > 0.01, area: S.area * hoist, tack, clew, sections, force: zero, ce: zero, lift: 0, drag: 0,
      drive: 0, heelForce: 0, telltales: [], hoist, poleAngle: 1, poleTip: tack, poleHeight: 2.4, collapsed: 0, curl: 0,
      head: { x: head.x, y: 0, z: head.z + (1 - hoist) * (-head.z - 1.2) },
    };
  };

  it('stays in a low bundle while hoisting and fills to full height at the top', () => {
    const s = new SpinShape(1);
    s.update(1 / 60, 0, spin(0.3), 6);
    let maxY = -Infinity;
    for (let k = 1; k < s.surface.count * 3; k += 3) maxY = Math.max(maxY, s.surface.target[k]!);
    expect(maxY).toBeLessThan(4.5);
    const full = new SpinShape(1);
    full.update(1 / 60, 0, spin(1), 6);
    maxY = -Infinity;
    for (let k = 1; k < full.surface.count * 3; k += 3) maxY = Math.max(maxY, full.surface.target[k]!);
    expect(maxY).toBeGreaterThan(9.5);
  });

  it('is hidden when stowed', () => {
    const s = new SpinShape(1);
    s.update(1 / 60, 0, spin(0), 6);
    expect(s.visible).toBe(false);
  });
});
