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
  /** Integrated shiver phase (cycles): its frequency follows the wind, so it must not be f·t. */
  private shiver = 0;
  /** The snapshot's foot corners last frame (boat-local), to spot a jump (see keepContinuity). */
  private readonly prevTack = new THREE.Vector3();
  private readonly prevClew = new THREE.Vector3();
  /** Foot glide after a jump: rendered corner minus snapshot corner at the jump, fading out over glideDur. */
  private readonly glideTack = new THREE.Vector3();
  private readonly glideClew = new THREE.Vector3();
  private glideT = 0;
  private glideDur = 0;
  /**
   * Fabric bookkeeping across gybe relabels: `mirrored` when grid column i holds the fabric of column
   * nu − 1 − i (patterns tied to the cloth use the fabric's u), and `orient` = −1 while the rows' normal N
   * points the other way through the fabric (displacements that are not side-weighted are multiplied by it).
   */
  private mirrored = false;
  private orient = 1;
  /** Curl as the cloth shows it (the sim's value with the luff's response time). */
  private curlF = 0;
  /** The foot corners as drawn this frame (boat-local): where the guy and the sheet are made fast. */
  readonly footTack = new THREE.Vector3();
  readonly footClew = new THREE.Vector3();
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
    dt = dt > 0 ? dt : 0; // NaN / negative → no step
    aws = aws > 0 ? aws : 0;
    const wasVisible = this.visible;
    this.visible = s.set || s.hoist > 0.005;
    if (!this.visible) return;
    if (!wasVisible) this.reset();
    const { rows, surface } = this;
    toLocal(s.tack, this.tack);
    toLocal(s.clew, this.clew);
    toLocal(s.head, this.head);
    if (surface.live) this.keepContinuity();
    this.prevTack.copy(this.tack);
    this.prevClew.copy(this.clew);
    const hoist = clamp01(s.hoist);
    this.estimateFullHead(s, hoist);
    rows.build(s.sections, this.tack, this.clew, this.fullHead, this.fullHead, 'horizontal');
    const side = this.sideField.update(rows.side, dt);
    const luff = this.luffF.update(rows.luffing, dt, 0.1);

    const fill = smooth(0.86, 0.995, hoist);
    const collapse = smooth(0, 1, Math.max(clamp01(s.collapsed), 1 - fill));
    // The luff folds in over a fraction of a second, not in the frame the sim's curl flag crosses its window.
    const curlIn = clamp01(s.curl) * (1 - collapse);
    this.curlF = surface.live ? this.curlF + (curlIn - this.curlF) * (1 - Math.exp(-dt / 0.2)) : curlIn;
    const curl = this.curlF;
    // Spring mode from the collapse trend (a rate, so it does not depend on the frame rate).
    const rate = dt > 0 ? (collapse - this.prevCollapse) / dt : 0;
    this.prevCollapse = collapse;
    if (rate < -0.24 && fill > 0.9) this.slam = 0.9;
    this.slam = Math.max(0, this.slam - dt);
    if (dt > 0) this.setSpring(this.slam > 0 ? 'slam' : rate > 0.12 ? 'collapsing' : 'full');
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
        const g = curlAmp > 1e-5 ? Math.exp(-(((u - uc) / (0.07 + 0.05 * (1 - curl))) ** 2)) : 0;
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
          const fu = this.mirrored ? 1 - u : u;
          const crumple = this.orient * (0.62 * (vnoise(fu * 5 + 0.25 * t, v * 1.6 - 0.1 * t) - 0.5)
            + 0.34 * (vnoise(fu * 11 - 0.35 * t + 11, v * 3 + 0.15 * t) - 0.5));
          dep += collapse * 1.5 * mid * crumple;
          sag = sagV * su;
        }
        tgt[ko] = lx + uu * (tx - lx) + nx * dep;
        tgt[ko + 1] = ly + uu * (ty - ly) + ny * dep - sag;
        tgt[ko + 2] = lz + uu * (tz - lz) + nz * dep;
      }
    }
    if (this.glideDur > 0) this.glide(dt);
    if (fill < 1) this.blendBundle(hoist, fill, t);

    surface.follow(dt);
    this.shiver += (3 + 0.3 * Math.max(aws, 0)) * dt;
    this.excite(t, aws, collapse, curl, luff, side, fill);
    if (this.colouring) writeState(surface, luff, rows.stall);
    surface.commit(this.colouring);
    const o = surface.out, c1 = (surface.nu - 1) * 3;
    this.footTack.set(o[0]!, o[1]!, o[2]!);
    this.footClew.set(o[c1]!, o[c1 + 1]!, o[c1 + 2]!);
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
    const sh = this.shiver, mirrored = this.mirrored, orient = this.orient;
    for (let j = 0; j < nv; j++) {
      const o = j * 3, v = j / (nv - 1), y = v * S.SL;
      const C = this.rows.chord[j]!;
      const edgeV = smooth(0, 0.1, v) * (1 - smooth(0.85, 1, v));
      for (let i = 0; i < nu; i++) {
        const u = U[i]!, ko = (j * nu + i) * 3, fu = mirrored ? 1 - u : u, x = fu * C;
        const lEff = Math.max(luff[j]!, 1 - Math.abs(side[j * nu + i]!));
        const mid = this.sinU[i]! * edgeV;
        let d = 0;
        // Collapsed / unfilled cloth: slow heavy folds plus a quick shiver.
        const slack = Math.max(collapse, 1 - fill);
        if (slack > 0.01) {
          d += slack * mid * (0.2 * Math.sin(TAU * (x / 1.6 - 0.55 * t) + 2.1 * y)
            + 0.12 * Math.sin(TAU * (x / 0.85 + 0.4 * t) - 3.3 * y + 1)
            + 0.04 * Math.sin(TAU * sh - 4 * y + 7 * x));
        }
        // The curling luff flutters at its fold.
        if (curl > 0.01) {
          const g = Math.exp(-(((u - 0.05) / 0.12) ** 2));
          d += curl * g * edgeV * 0.06 * Math.sin(TAU * 1.2 * sh - 5 * y);
        }
        // Luffing (low angle of attack) shivers the whole leading third.
        if (lEff > 0.01) d += lEff * edgeV * (1 - smooth(0.1, 0.45, u)) * 0.05 * Math.sin(TAU * (x / 0.7 - sh) + 1.3 * y);
        // Edge tapes vibrate in the breeze.
        d += 0.0006 * w * (smooth(0.88, 1, u) + 1 - smooth(0, 0.12, u)) * Math.sin(TAU * (7 * t - y / 0.8) + 3 * fu);
        d *= orient;
        out[ko] = pos[ko]! + N[o]! * d;
        out[ko + 1] = pos[ko + 1]! + N[o + 1]! * d;
        out[ko + 2] = pos[ko + 2]! + N[o + 2]! * d;
      }
    }
  }

  /**
   * Keep the kite continuous when the snapshot's foot jumps. In a spinnaker gybe the simulation moves the
   * pole end-for-end in one step, so its tack and clew mirror across the boat, while on the water the old
   * clew is clipped to the pole and becomes the new tack and the kite keeps flying.
   *  - Relabel: when the new tack is where the old clew was (and vice versa), mirror the cloth's columns
   *    instead of dragging it through itself.
   *  - Belly: it is side · N, and N turns with the chord. When the foot's chord reverses, negate the side
   *    field, so the belly keeps its side in space instead of turning inside out.
   *  - Glide: the remaining gap between the rendered corners and the snapshot's is closed on a smooth ease.
   * A real frame moves the corners a centimetre or two; a jump is anything over half a metre.
   */
  private keepContinuity(): void {
    const tk = this.tack, cl = this.clew, pt = this.prevTack, pc = this.prevClew;
    const same = tk.distanceTo(pt) + cl.distanceTo(pc);
    if (same > 0.5) {
      const s = this.surface, p = s.pos, o1 = (s.nu - 1) * 3;
      const swap = tk.distanceTo(pc) + cl.distanceTo(pt);
      if (swap < 0.6 * same) {
        s.mirrorColumns();
        this.sideField.mirrorColumns();
        this.mirrored = !this.mirrored;
      }
      this.glideTack.set(p[0]! - tk.x, p[1]! - tk.y, p[2]! - tk.z);
      this.glideClew.set(p[o1]! - cl.x, p[o1 + 1]! - cl.y, p[o1 + 2]! - cl.z);
      // The ease peaks at 1.5 × gap / duration: about 1.25 m/s, 2 cm per 60 Hz frame.
      const gap = Math.max(this.glideTack.length(), this.glideClew.length());
      this.glideDur = Math.min(Math.max(1.2 * gap, 0.6), 3);
      this.glideT = 0;
    }
    if ((cl.x - tk.x) * (pc.x - pt.x) + (cl.z - tk.z) * (pc.z - pt.z) < 0) {
      this.sideField.negate();
      this.orient = -this.orient;
    }
  }

  /** Carry the lower kite with the fading corner offsets: all of it at the foot, none at the head. */
  private glide(dt: number): void {
    const g = 1 - smooth(0, this.glideDur, this.glideT);
    this.glideT += dt;
    if (this.glideT >= this.glideDur) this.glideDur = 0;
    if (g <= 0) return;
    const { nu, nv, target: tgt, u: U } = this.surface;
    const a = this.glideTack, b = this.glideClew, V = this.rows.v;
    for (let j = 0; j < nv; j++) {
      const w = g * (1 - V[j]!);
      if (w <= 0) continue;
      for (let i = 0; i < nu; i++) {
        const ko = (j * nu + i) * 3, wb = w * U[i]!, wa = w - wb;
        tgt[ko] = tgt[ko]! + a.x * wa + b.x * wb;
        tgt[ko + 1] = tgt[ko + 1]! + a.y * wa + b.y * wb;
        tgt[ko + 2] = tgt[ko + 2]! + a.z * wa + b.z * wb;
      }
    }
  }

  /** Forget all motion state: the next update snaps to the snapshot's shape (scenario change). */
  reset(): void {
    this.surface.reset();
    this.sideField.reset();
    this.luffF.reset();
    this.prevCollapse = 0;
    this.slam = 0;
    this.glideDur = 0;
    this.mirrored = false;
    this.orient = 1;
  }

  dispose(): void { this.surface.dispose(); }
}
