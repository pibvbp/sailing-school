// Symmetric spinnaker cloth (spec §9.6): a deep nylon balloon from the head (masthead halyard) to the tack
// (pole tip) and clew. Its horizontal sections are deep arcs; `curl` folds the luff in toward windward
// (strongest at the shoulders), `collapsed` lets the cloth fall in and sag, and `hoist` raises it from
// the foredeck as a twisted bundle that fills once the head is up.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import type { SpinnakerState } from '../../sim/types';
import {
  RowFilter, SailPlan, SailRows, SailSurface, SideField, breathing, camberShape, clamp01, smooth, toLocal, vnoise, writeState,
  type PlanPoint,
} from './sailMesh';

const S = BOAT.spinnaker;
const ENTRY = 2.7;
const EXIT = 2.5;
/** Arc length / chord for a ~26 % deep section (≈ 1 + 8/3·camber²). */
const ARC = 1.18;

/** Nominal chord (m) at height fraction v: foot at the bottom, mid-girth at half height, a point at the head. */
export function spinPlanChord(v: number): number {
  return S.foot * (1 - v) + (S.halfWidth - S.foot / 2) * Math.sin(Math.PI * v);
}

/** Symmetric plan: x = metres across from the centre seam, y = metres up the luff. */
export function spinPlan(): SailPlan {
  const luff: PlanPoint[] = [], leech: PlanPoint[] = [];
  const n = 160;
  for (let k = 0; k <= n; k++) {
    const v = k / n, g = spinPlanChord(v) * ARC;
    luff.push({ x: -g / 2, y: v * S.SL });
    leech.push({ x: g / 2, y: v * S.SL });
  }
  return new SailPlan(luff, leech, 0.05);
}

export class SpinShape {
  readonly rows: SailRows;
  readonly surface: SailSurface;
  readonly plan: SailPlan;
  colouring = false;
  visible = false;
  private readonly sideField: SideField;
  private readonly luffF: RowFilter;
  /** Per column: sin(πu) and its 0.8 power (hood profile). */
  private readonly sinU: Float32Array;
  private readonly hoodU: Float32Array;
  private prevCollapse = 0;
  private slam = 0;
  private springMode = '';
  private readonly tack = new THREE.Vector3();
  private readonly clew = new THREE.Vector3();
  private readonly head = new THREE.Vector3();
  private readonly fullHead = new THREE.Vector3();
  private readonly bag = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(resolution = 1) {
    const nu = Math.max(12, Math.round(26 * resolution));
    const nv = Math.max(14, Math.round(36 * resolution));
    this.rows = new SailRows(nv);
    this.surface = new SailSurface(nu, nv, 1);
    this.plan = spinPlan();
    this.surface.setPlanUV(this.plan);
    this.sideField = new SideField(nu, nv, this.surface.u, 0.12, 0.28);
    this.sinU = new Float32Array(nu);
    this.hoodU = new Float32Array(nu);
    for (let i = 0; i < nu; i++) {
      this.sinU[i] = Math.sin(Math.PI * this.surface.u[i]!);
      this.hoodU[i] = Math.pow(this.sinU[i]!, 0.8);
    }
    this.luffF = new RowFilter(nv);
    const s = this.surface;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i;
        s.pinned[k] = j === nv - 1 || (j === 0 && (i === 0 || i === nu - 1)) ? 1 : 0;
      }
    }
    this.setSpring('full');
  }

  /**
   * Nylon dynamics: soft and well damped while the kite falls in, stiff and under-damped for the slam
   * when it refills, in between when flying.
   */
  private setSpring(mode: 'full' | 'collapsing' | 'slam'): void {
    if (mode === this.springMode) return;
    this.springMode = mode;
    const [w, z] = mode === 'slam' ? [15, 0.2] : mode === 'collapsing' ? [4.5, 0.55] : [7, 0.32];
    this.surface.omega.fill(w);
    this.surface.zeta.fill(z);
  }

  update(dt: number, t: number, s: SpinnakerState, aws: number): void {
    const wasVisible = this.visible;
    this.visible = s.set || s.hoist > 0.005;
    if (!this.visible) return;
    if (!wasVisible) { this.surface.reset(); this.sideField.reset(); this.luffF.reset(); }
    const { rows, surface } = this;
    toLocal(s.tack, this.tack);
    toLocal(s.clew, this.clew);
    toLocal(s.head, this.head);
    const hoist = clamp01(s.hoist);
    this.estimateFullHead(s, hoist);
    rows.build(s.sections, this.tack, this.clew, this.fullHead, this.fullHead, 'horizontal');
    const side = this.sideField.update(rows.side, dt);
    const luff = this.luffF.update(rows.luffing, dt, 0.1);

    const fill = smooth(0.86, 0.995, hoist);
    const collapse = smooth(0, 1, Math.max(clamp01(s.collapsed), 1 - fill));
    const curl = clamp01(s.curl) * (1 - collapse);
    // Spring mode from the collapse trend.
    const dC = collapse - this.prevCollapse;
    this.prevCollapse = collapse;
    if (dC < -0.004 && fill > 0.9) this.slam = 0.9;
    this.slam = Math.max(0, this.slam - dt);
    this.setSpring(this.slam > 0 ? 'slam' : dC > 0.002 ? 'collapsing' : 'full');
    // Bag on the foredeck (forward end of the cabin top), to leeward of the forestay (the pole is windward).
    this.bag.set(s.tack.y >= 0 ? -0.3 : 0.3, BOAT.mast.baseH - 0.02, -(BOAT.cabin.xFwd - 0.05));

    const { nu, nv, target: tgt, u: U } = surface;
    const { L, T, N } = rows;
    const TAU = Math.PI * 2;
    for (let j = 0; j < nv; j++) {
      const o = j * 3, v = rows.v[j]!;
      const C = rows.chord[j]!, d = rows.draft[j]!;
      const depth = rows.camber[j]! * breathing(t + 7.3, v) * C * (0.55 + 0.45 * smooth(0, 0.22, v));
      // A real kite is domed: the upper half bulges forward into a hood instead of tapering to a cone.
      const hood = 0.85 * Math.sin(Math.PI * Math.min(v / 0.97, 1)) * smooth(0.25, 0.75, v) * breathing(t + 2.2, v);
      // The luff curl rolls in and out along the luff, strongest at the shoulders.
      const curlAmp = curl * 1.7 * rows.camber[j]! * C * smooth(0.12, 0.45, v) * (1 - smooth(0.88, 1, v))
        * (0.75 + 0.25 * Math.sin(TAU * 1.1 * t - 6 * v));
      const uc = 0.03 + 0.05 * curl * (0.5 + 0.5 * Math.sin(TAU * 0.8 * t - 5 * v));
      const pull = 0.3 * Math.sin(Math.PI * v) * collapse;
      const lx = L[o]!, ly = L[o + 1]!, lz = L[o + 2]!, tx = T[o]!, ty = T[o + 1]!, tz = T[o + 2]!;
      const nx = N[o]!, ny = N[o + 1]!, nz = N[o + 2]!;
      const edgeV = smooth(0, 0.1, v) * (1 - smooth(0.85, 1, v));
      const sagV = collapse * 1.1 * Math.sin(Math.PI * Math.min(v / 0.92, 1)) * (1 - 0.25 * v);
      for (let i = 0; i < nu; i++) {
        const u = U[i]!, k = j * nu + i, ko = k * 3;
        const sd = side[k]!;
        const f = camberShape(u, d, ENTRY, EXIT);
        const g = Math.exp(-(((u - uc) / (0.07 + 0.05 * (1 - curl))) ** 2));
        const su = this.sinU[i]!;
        let dep = sd * (depth * f + hood * this.hoodU[i]!) - sd * curlAmp * g;
        let sag = 0;
        let uu = u;
        if (collapse > 0.001) {
          // Collapsed: the edges fall in, the belly caves in, the middle sags, the cloth crumples.
          uu = u + (0.5 - u) * pull * 2 * Math.abs(0.5 - u);
          dep += collapse * (-1.35 * sd * (depth * f + hood * su));
          const mid = su * edgeV;
          // Hanging nylon falls into long folds running down from the head (fine across, coarse along).
          const crumple = 0.6 * (vnoise(u * 5 + 0.25 * t, v * 1.6 - 0.1 * t) - 0.5)
            + 0.32 * (vnoise(u * 11 - 0.35 * t + 11, v * 3 + 0.15 * t) - 0.5)
            + 0.1 * (vnoise(u * 19 + 5, v * 6 + 0.3 * t) - 0.5);
          dep += collapse * 1.5 * mid * crumple;
          sag = sagV * su;
        }
        tgt[ko] = lx + uu * (tx - lx) + nx * dep;
        tgt[ko + 1] = ly + uu * (ty - ly) + ny * dep - sag;
        tgt[ko + 2] = lz + uu * (tz - lz) + nz * dep;
      }
    }
    if (fill < 1) this.blendBundle(hoist, fill, t);

    surface.follow(dt);
    this.excite(t, aws, collapse, curl, luff, side, fill);
    if (this.colouring) writeState(surface, luff, rows.stall);
    surface.commit(this.colouring);
  }

  /** Head position at full hoist (the sections are laid out for it even while hoisting). */
  private estimateFullHead(s: SpinnakerState, hoist: number): void {
    const n = s.sections.length;
    if (hoist > 0.995 || n < 2) { this.fullHead.copy(this.head); return; }
    const a = s.sections[n - 2]!, b = s.sections[n - 1]!;
    const k = (1 - b.h) / Math.max(b.h - a.h, 1e-3);
    this.fullHead.set(
      b.luff.y + (b.luff.y - a.luff.y) * k,
      -(b.luff.z + (b.luff.z - a.luff.z) * k),
      -(b.luff.x + (b.luff.x - a.luff.x) * k),
    );
  }

  /** While hoisting/dousing: a twisted bundle from the head down to the bag and the corners. */
  private blendBundle(hoist: number, fill: number, t: number): void {
    const { nu, nv, target: tgt, u: U } = this.surface;
    const out = Math.max(hoist, 0.02);
    const spread = smooth(0.45, 0.95, hoist);
    const h = this.head, bag = this.bag, tk = this.tack, cl = this.clew;
    const ax = this.tmp.subVectors(bag, h).normalize();
    // Two directions across the bundle.
    const px = -ax.z, pz = ax.x, pl = Math.hypot(px, pz) || 1;
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      for (let i = 0; i < nu; i++) {
        const u = U[i]!, ko = (j * nu + i) * 3;
        const sAlong = (1 - v) / out;
        let x: number, y: number, z: number;
        if (sAlong >= 1) {
          x = bag.x; y = bag.y + 0.05; z = bag.z;
        } else {
          const ancX = bag.x + (tk.x + (cl.x - tk.x) * u - bag.x) * spread;
          const ancY = bag.y + (tk.y + (cl.y - tk.y) * u - bag.y) * spread;
          const ancZ = bag.z + (tk.z + (cl.z - tk.z) * u - bag.z) * spread;
          const twist = 5 * sAlong + 0.9 * u + 0.6 * t;
          const r = (u - 0.5) * 0.28 * Math.sin(Math.PI * sAlong) * (1 - spread * 0.6);
          x = h.x + (ancX - h.x) * sAlong + (px / pl) * r * Math.cos(twist);
          y = h.y + (ancY - h.y) * sAlong + r * Math.sin(twist) * 0.5;
          z = h.z + (ancZ - h.z) * sAlong + (pz / pl) * r * Math.cos(twist);
        }
        tgt[ko] = x + (tgt[ko]! - x) * fill;
        tgt[ko + 1] = y + (tgt[ko + 1]! - y) * fill;
        tgt[ko + 2] = z + (tgt[ko + 2]! - z) * fill;
      }
    }
  }

  private excite(t: number, aws: number, collapse: number, curl: number, luff: Float32Array, side: Float32Array, fill: number): void {
    const { nu, nv, pos, out, u: U } = this.surface;
    const N = this.rows.N;
    const TAU = Math.PI * 2;
    const w = Math.max(aws, 0);
    const shiverF = 3 + 0.3 * w;
    for (let j = 0; j < nv; j++) {
      const o = j * 3, v = j / (nv - 1), y = v * S.SL;
      const C = this.rows.chord[j]!;
      const edgeV = smooth(0, 0.1, v) * (1 - smooth(0.85, 1, v));
      for (let i = 0; i < nu; i++) {
        const u = U[i]!, ko = (j * nu + i) * 3, x = u * C;
        const lEff = Math.max(luff[j]!, 1 - Math.abs(side[j * nu + i]!));
        const mid = Math.sin(Math.PI * u) * edgeV;
        let d = 0;
        // Collapsed / unfilled cloth: slow heavy folds plus a quick shiver.
        const slack = Math.max(collapse, 1 - fill);
        if (slack > 0.01) {
          d += slack * mid * (0.2 * Math.sin(TAU * (x / 1.6 - 0.55 * t) + 2.1 * y)
            + 0.12 * Math.sin(TAU * (x / 0.85 + 0.4 * t) - 3.3 * y + 1)
            + 0.04 * Math.sin(TAU * shiverF * t - 4 * y + 7 * x));
        }
        // The curling luff flutters at its fold.
        if (curl > 0.01) {
          const g = Math.exp(-(((u - 0.05) / 0.12) ** 2));
          d += curl * g * edgeV * 0.06 * Math.sin(TAU * (shiverF * 1.2 * t) - 5 * y);
        }
        // Luffing (low angle of attack) shivers the whole leading third.
        if (lEff > 0.01) d += lEff * edgeV * (1 - smooth(0.1, 0.45, u)) * 0.05 * Math.sin(TAU * (x / 0.7 - shiverF * t) + 1.3 * y);
        // Edge tapes vibrate in the breeze.
        d += 0.0006 * w * (smooth(0.88, 1, u) + 1 - smooth(0, 0.12, u)) * Math.sin(TAU * (7 * t - y / 0.8) + 3 * u);
        out[ko] = pos[ko]! + N[o]! * d;
        out[ko + 1] = pos[ko + 1]! + N[o + 1]! * d;
        out[ko + 2] = pos[ko + 2]! + N[o + 2]! * d;
      }
    }
  }

  dispose(): void { this.surface.dispose(); }
}
