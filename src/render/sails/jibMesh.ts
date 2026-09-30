// Roller-furling jib cloth (spec §9.6): luff along the forestay from BOAT.jib.tack to BOAT.jib.head, a
// free foot and leech, the clew held by the sheet. Furling rolls the luff side of the sail around the
// foil, so the visible cloth is the aft part of the plan and a roll thickens on the forestay.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { JibState, SailSection } from '../../sim/types';
import {
  RowFilter, SailRows, SailSurface, SideField, advancePhase, breathing, camberShape, exciteCloth, planFromRows, smooth, toLocal,
  writeState, type ClothPhase, type FlutterParams, type PlanPoint, type SailPlan,
} from './sailMesh';

const J = BOAT.jib;
const FOOT_H = Math.sqrt(J.foot * J.foot - (J.clewH - J.tack.h) ** 2);
const ENTRY = 2.4;
const EXIT = 1.1;
const FLUTTER: FlutterParams = {
  aLuff: 0.04, aFlog: 0.3, aLeech: 0.0014, f0: 1.5, fPerMs: 0.24, lambda0: 0.5, lambdaPerChord: 0.3, height: J.luff,
};

/** Flat jib with the clew on the centreline, sections laid out like the simulation's (texture plan). */
export function nominalJibSections(n = 8): SailSection[] {
  const zBottom = J.tack.h + 0.08, zTop = J.head.h - 0.3, dz = (zTop - zBottom) / n;
  const clewX = J.tack.x - FOOT_H;
  const out: SailSection[] = [];
  for (let i = 0; i < n; i++) {
    const z = zBottom + (i + 0.5) * dz;
    const s = (z - J.tack.h) / (J.head.h - J.tack.h);
    const luffX = J.tack.x + (J.head.x - J.tack.x) * s;
    const leechX = clewX + (J.head.x - clewX) * ((z - J.clewH) / (J.head.h - J.clewH));
    out.push({
      h: s, luff: { x: luffX, y: 0, z: -z }, chordDir: { x: -1, y: 0, z: 0 }, chord: Math.max(luffX - leechX, 0.02),
      camber: 0, draft: 0.42, leewardY: 0, aoa: 0, luffing: 0, stall: 0, cl: 0, cd: 0, q: 0,
    });
  }
  return out;
}

/** Plan of the jib: x = metres aft of the tack, y = metres above the tack. */
export function jibPlan(): SailPlan {
  const rows = new SailRows(161);
  const tack = new THREE.Vector3(0, J.tack.h, -J.tack.x);
  const clew = new THREE.Vector3(0, J.clewH, -(J.tack.x - FOOT_H));
  const head = new THREE.Vector3(0, J.head.h, -J.head.x);
  rows.build(nominalJibSections(), tack, clew, head, head, 'luff');
  return planFromRows(rows, (_x, y, z) => ({ x: z + J.tack.x, y: y - J.tack.h }));
}

/** The rolled-up part of the sail on the furling foil: a tapered tube, thicker at the foot. */
export class JibFurlRoll {
  readonly geometry = new THREE.BufferGeometry();
  private readonly rings = 28;
  private readonly segs = 12;
  private readonly posArr: Float32Array;
  private readonly nrmArr: Float32Array;
  private lastFurl = -1;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();

  constructor() {
    const n = this.rings * (this.segs + 1);
    this.posArr = new Float32Array(n * 3);
    this.nrmArr = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const index: number[] = [];
    for (let r = 0; r < this.rings; r++) {
      for (let s = 0; s <= this.segs; s++) {
        const k = r * (this.segs + 1) + s;
        uv[k * 2] = s / this.segs;
        uv[k * 2 + 1] = r / (this.rings - 1);
        if (r < this.rings - 1 && s < this.segs) {
          const c = k + this.segs + 1;
          index.push(k, c, k + 1, k + 1, c, c + 1);
        }
      }
    }
    this.geometry.setIndex(index);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.nrmArr, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  /** Rebuild for a furl fraction (0 = none rolled … 1 = all rolled); returns false when nothing shows. */
  update(furl: number, tackLocal: THREE.Vector3, headLocal: THREE.Vector3): boolean {
    if (furl < 0.01) return false;
    if (Math.abs(furl - this.lastFurl) < 0.002) return true;
    this.lastFurl = furl;
    const axis = this.b.subVectors(headLocal, tackLocal);
    const len = axis.length();
    axis.divideScalar(len);
    // Any vector ⟂ the axis, then a right-handed pair around it.
    const e1 = this.a.set(1, 0, 0).addScaledVector(axis, -axis.x).normalize();
    const e2 = this.c.crossVectors(axis, e1);
    const foil = 0.016;
    for (let r = 0; r < this.rings; r++) {
      const v = r / (this.rings - 1);
      // Rolled cloth area ∝ furl · local chord (≈ foot at the bottom → 0 at the head).
      const rad = Math.sqrt(foil * foil + 4.6e-4 * furl * J.foot * (1 - v) + 2e-5 * furl);
      for (let s = 0; s <= this.segs; s++) {
        const ang = (s / this.segs) * Math.PI * 2;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const k = (r * (this.segs + 1) + s) * 3;
        const nx = e1.x * c + e2.x * sn, ny = e1.y * c + e2.y * sn, nz = e1.z * c + e2.z * sn;
        this.posArr[k] = tackLocal.x + axis.x * len * v + nx * rad;
        this.posArr[k + 1] = tackLocal.y + axis.y * len * v + ny * rad;
        this.posArr[k + 2] = tackLocal.z + axis.z * len * v + nz * rad;
        this.nrmArr[k] = nx; this.nrmArr[k + 1] = ny; this.nrmArr[k + 2] = nz;
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
    this.geometry.computeBoundingSphere();
    return true;
  }

  dispose(): void { this.geometry.dispose(); }
}

export class JibShape {
  readonly rows: SailRows;
  readonly surface: SailSurface;
  readonly plan: SailPlan;
  readonly roll = new JibFurlRoll();
  colouring = false;
  /** True while the roll on the foil should be drawn. */
  rollVisible = false;
  private readonly env: Float32Array;
  private readonly leechEnv: Float32Array;
  private readonly sideField: SideField;
  private readonly luffF: RowFilter;
  private uvFurl = 0;
  private readonly phase: ClothPhase = { flog: 0, leech: 0 };
  private readonly tack = new THREE.Vector3();
  private readonly clew = new THREE.Vector3();
  private readonly head = new THREE.Vector3();

  constructor(resolution = 1) {
    const nu = Math.max(10, Math.round(20 * resolution));
    const nv = Math.max(16, Math.round(44 * resolution));
    this.rows = new SailRows(nv);
    this.surface = new SailSurface(nu, nv);
    this.plan = jibPlan();
    this.surface.setPlanUV(this.plan);
    this.sideField = new SideField(nu, nv, this.surface.u, 0.05, 0.2);
    this.luffF = new RowFilter(nv);
    const n = this.surface.count;
    this.env = new Float32Array(n);
    this.leechEnv = new Float32Array(n);
    const plan = this.plan, s = this.surface;
    const clewP = plan.rowAt(0).b, headP = plan.rowAt(1).a, tackP = plan.rowAt(0).a;
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i, u = s.u[i]!;
        const q = plan.at(u, v);
        const corners = smooth(0.05, 0.6, Math.hypot(q.x - clewP.x, q.y - clewP.y))
          * smooth(0.05, 0.7, Math.hypot(q.x - headP.x, q.y - headP.y))
          * smooth(0.05, 0.4, Math.hypot(q.x - tackP.x, q.y - tackP.y));
        this.env[k] = smooth(0, 0.08, u) * corners;
        // The leech flutters, and so does the foot a little.
        this.leechEnv[k] = Math.max(smooth(0.82, 1, u), 0.5 * (1 - smooth(0, 0.08, v)) * smooth(0.25, 0.7, u)) * corners;
        s.omega[k] = 13 - 5 * u;
        s.zeta[k] = 0.42;
        s.pinned[k] = i === 0 || j === nv - 1 || (i === nu - 1 && j === 0) ? 1 : 0;
      }
    }
  }

  update(dt: number, t: number, s: JibState, aws: number): void {
    dt = dt > 0 ? dt : 0; // NaN / negative → no step
    aws = aws > 0 ? aws : 0;
    const { rows, surface } = this;
    toLocal(s.tack, this.tack);
    toLocal(s.clew, this.clew);
    toLocal(s.head, this.head);
    this.rollVisible = this.roll.update(s.furl, this.tack, this.head);
    if (Math.abs(s.furl - this.uvFurl) > 0.002) {
      this.uvFurl = s.furl;
      surface.setPlanUV(this.plan, Math.min(Math.max(s.furl, 0), 0.97));
    }
    rows.build(s.sections, this.tack, this.clew, this.head, this.head, 'luff');
    const side = this.sideField.update(rows.side, dt);
    const luff = this.luffF.update(rows.luffing, dt, 0.07);

    const { nu, nv, target: tgt, u: U } = surface;
    const { L, T, N } = rows;
    // Pinching: the luff bubble breathes in and out.
    const pulse = 0.76 + 0.17 * Math.sin(Math.PI * 2 * 2.1 * t + 0.4) + 0.1 * Math.sin(Math.PI * 2 * 3.4 * t);
    for (let j = 0; j < nv; j++) {
      const o = j * 3, v = rows.v[j]!;
      const l = luff[j]!;
      const bubble = smooth(0.05, 0.5, l) * (1 - 0.5 * smooth(0.7, 1, l)) * pulse;
      const reach = (0.12 + 0.35 * l) * (0.9 + 0.2 * pulse);
      const depthScale = rows.camber[j]! * breathing(t + 3.1, v) * rows.chord[j]! * (1 - 0.9 * smooth(0.5, 1, l));
      const d = rows.draft[j]!;
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i, u = U[i]!;
        let f = camberShape(u, d, ENTRY, EXIT);
        if (bubble > 0) f *= 1 - 2 * bubble * (1 - smooth(reach * 0.55, reach * 1.45, u));
        const dep = side[k]! * depthScale * f;
        const ko = k * 3;
        tgt[ko] = L[o]! + u * (T[o]! - L[o]!) + N[o]! * dep;
        tgt[ko + 1] = L[o + 1]! + u * (T[o + 1]! - L[o + 1]!) + N[o + 1]! * dep;
        tgt[ko + 2] = L[o + 2]! + u * (T[o + 2]! - L[o + 2]!) + N[o + 2]! * dep;
      }
    }
    surface.follow(dt);
    advancePhase(this.phase, FLUTTER, aws, dt);
    exciteCloth(surface, rows, luff, side, FLUTTER, this.phase, t, aws, this.env, this.leechEnv);
    if (this.colouring) writeState(surface, luff, rows.stall);
    surface.commit(this.colouring);
  }

  /** Plan position (texture layout) of grid point (u, v) into `out`, allowing for the furled part of the sail. */
  planAt(u: number, v: number, out: PlanPoint): PlanPoint {
    const f = Math.min(Math.max(this.uvFurl, 0), 0.97);
    return this.plan.atInto(f + u * (1 - f), v, out);
  }

  /** Forget all motion state: the next update snaps to the snapshot's shape (scenario change). */
  reset(): void {
    this.surface.reset();
    this.sideField.reset();
    this.luffF.reset();
  }

  dispose(): void {
    this.surface.dispose();
    this.roll.dispose();
  }
}
