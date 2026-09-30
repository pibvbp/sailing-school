// Flow particles (spec §8 "Flow"):
//  (b) apparent-wind streaks around the sails, advected in the boat frame through the slice fields (flowField.ts),
//      height-interpolated between slices, coloured by speed ratio (faster = lower pressure), wobbling in separated
//      wakes; a collision guard slides any particle that would cross a sail along the cloth instead;
//  (a) true-wind streaks drifting over the water in the world frame, faster in gusts (the puff field of the sim).
// All per-frame loops are allocation-free; trails are drawn by TrailRenderer (one instanced draw each).
import * as THREE from 'three';
import type { QualitySettings } from '../core/types';
import type { SimSnapshot } from '../../sim/types';
import { CAMBER_PTS, SliceField, newSliceElement, sailCutAt, type FlowSample, type SliceElement } from './flowField';
import { TrueWindField, boatVelocityWorld } from './frames';
import type { OverlayContext } from './overlayMaterial';
import { TrailRenderer } from './trails';
import { COLORS, linearColor } from './palette';

/** Heights (m above the waterline) of the slices the particles fly through. */
export const PARTICLE_SLICE_HEIGHTS: readonly number[] = [2.5, 4.0, 5.5, 7.0, 8.6];
/** Smoke-rake heights, their seed spacing across the flow, how far outside the rig they reach and how far upstream. */
const RAKE_HEIGHTS: readonly number[] = [3.2, 5.4, 7.6];
const RAKE_SPACING = 0.6;
const RAKE_MARGIN = 2.4;
const RAKE_UPSTREAM = 4.5;
/** Seconds between releases (≈ 1.3 m apart at 16 kn apparent): trails overlap into streamlines that visibly flow. */
const EMIT_DT = 0.2;
/** Body x of the rig's middle (used before any sail is cut). */
const BOAT_RIG_X = 1;
const H_MIN = 2.1;
const H_MAX = 9.4;
/** Fine height levels of the sail cuts used by the collision guard. */
const CUT_STEP = 0.25;
const TRAIL_SLOTS = 12;
const PUSH_DT = 1 / 28;
const EDGE_FADE = 1.4;

// ---------------------------------------------------------------------------------------------------------------
// Tiny deterministic RNG (particles only need variety, not quality).
let seed = 0x9e3779b9;
function rand(): number {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
}

/** Cuts of every sail at fine height steps, refreshed each frame for the collision guard. */
class SailCuts {
  readonly levels: SliceElement[][] = [];
  readonly counts: number[] = [];
  readonly h0 = 1.6;
  constructor() {
    const n = Math.ceil((10.2 - this.h0) / CUT_STEP) + 1;
    for (let i = 0; i < n; i++) { this.levels.push([newSliceElement(), newSliceElement(), newSliceElement()]); this.counts.push(0); }
  }
  update(s: SimSnapshot): void {
    for (let i = 0; i < this.levels.length; i++) {
      const h = this.h0 + i * CUT_STEP;
      let c = 0;
      const lv = this.levels[i]!;
      if (sailCutAt(s.sails.jib, h, lv[c]!)) c++;
      if (sailCutAt(s.sails.spinnaker, h, lv[c]!)) c++;
      if (sailCutAt(s.sails.main, h, lv[c]!)) c++;
      this.counts[i] = c;
    }
  }
  level(h: number): number {
    return Math.max(0, Math.min(this.levels.length - 1, Math.round((h - this.h0) / CUT_STEP)));
  }
}

/** Result of {@link guard}. */
export const hit = { x: 0, y: 0 };

/**
 * If the step p0 → p1 crosses the cloth, move p1 to slide along it on p0's side (writes `hit`, returns true).
 */
export function guard(el: SliceElement, x0: number, y0: number, x1: number, y1: number): boolean {
  const p = el.pts;
  // Cheap reject: both points far from the element's chord box.
  const m = 0.6;
  const minX = Math.min(el.leX, el.teX) - el.camber * el.chord - m, maxX = Math.max(el.leX, el.teX) + el.camber * el.chord + m;
  const minY = Math.min(el.leY, el.teY) - el.camber * el.chord - m, maxY = Math.max(el.leY, el.teY) + el.camber * el.chord + m;
  if ((x0 < minX && x1 < minX) || (x0 > maxX && x1 > maxX) || (y0 < minY && y1 < minY) || (y0 > maxY && y1 > maxY)) return false;
  const dx = x1 - x0, dy = y1 - y0;
  for (let q = 0; q < CAMBER_PTS - 1; q++) {
    const ax = p[2 * q]!, ay = p[2 * q + 1]!, bx = p[2 * q + 2]!, by = p[2 * q + 3]!;
    const ex = bx - ax, ey = by - ay;
    const d0 = ex * (y0 - ay) - ey * (x0 - ax);
    const d1 = ex * (y1 - ay) - ey * (x1 - ax);
    if (d0 * d1 > 0) continue;
    const e0 = dx * (ay - y0) - dy * (ax - x0);
    const e1 = dx * (by - y0) - dy * (bx - x0);
    if (e0 * e1 > 0) continue;
    // Crossing: keep the along-cloth part of the step, stay 3 cm off the cloth on the side we came from.
    const el2 = ex * ex + ey * ey || 1;
    const tAlong = (dx * ex + dy * ey) / el2;
    const tx = (x0 - ax) * ex + (y0 - ay) * ey;
    const s = Math.max(0, Math.min(1, tx / el2 + tAlong));
    const len = Math.sqrt(el2);
    const side = d0 >= 0 ? 1 : -1;
    hit.x = ax + ex * s - (ey / len) * 0.03 * side;
    hit.y = ay + ey * s + (ex / len) * 0.03 * side;
    return true;
  }
  return false;
}

/**
 * Apparent-wind particles around the rig (boat frame). Default 'rake' mode works like smoke rakes in a wind tunnel:
 * rows of seed points upstream of the rig, at several heights, release particles together at a steady beat, so the
 * trails line up into streamlines that bend round the sails and each release forms a timeline — the air over the
 * lee side visibly races ahead (no "equal transit time"). 'volume' mode instead fills the air around the rig with
 * randomly seeded particles.
 */
export class FlowParticles {
  readonly trails: TrailRenderer;
  readonly fields: SliceField[];
  private readonly n: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly h: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly ph: Float32Array;
  private readonly alive: Uint8Array;
  private readonly free: Int32Array;
  private nFree = 0;
  private readonly cuts = new SailCuts();
  private readonly sA: FlowSample = { u: 0, v: 0, ratio: 1, turb: 0 };
  private readonly sB: FlowSample = { u: 0, v: 0, ratio: 1, turb: 0 };
  private pushT = 0;
  private emitT = 0;
  private time = 0;
  private started = false;
  mode: 'rake' | 'volume' = 'rake';

  /** `fields` lets a rebuilt particle system (quality change) keep the slices already solved. */
  constructor(ctx: OverlayContext, q: QualitySettings, fields?: SliceField[]) {
    this.n = Math.max(300, Math.round(1800 * q.particleScale));
    this.fields = fields ?? PARTICLE_SLICE_HEIGHTS.map((h) => new SliceField(h));
    this.x = new Float32Array(this.n);
    this.y = new Float32Array(this.n);
    this.h = new Float32Array(this.n);
    this.age = new Float32Array(this.n);
    this.life = new Float32Array(this.n);
    this.ph = new Float32Array(this.n);
    this.alive = new Uint8Array(this.n);
    this.free = new Int32Array(this.n);
    this.trails = new TrailRenderer(ctx, { count: this.n, slots: TRAIL_SLOTS, width: 2.6, alpha: 0.95, colorMode: 'flow', hiddenAlpha: 0.32, renderOrder: 16, outline: 2.2 });
    this.trails.group.name = 'overlay-flow-particles';
  }

  /** Advance the particles by `dt` (s) through the current fields. Fields are rebuilt by the owner's scheduler. */
  update(dt: number, s: SimSnapshot): void {
    this.cuts.update(s);
    if (!this.started) this.start();
    this.time += dt;
    this.pushT += dt;
    if (this.pushT >= PUSH_DT) {
      this.pushT %= PUSH_DT;
      this.trails.push();
    }
    if (this.mode === 'rake') {
      this.emitT += dt;
      // A long stall (paused tab) must not dump a burst of rows.
      if (this.emitT > 4 * EMIT_DT) this.emitT = EMIT_DT;
      while (this.emitT >= EMIT_DT) { this.emitT -= EMIT_DT; this.emitRows(); }
    }
    const fields = this.fields;
    const f0 = fields[0]!;
    const nF = fields.length;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      let x = this.x[i]!, y = this.y[i]!;
      const h = this.h[i]!;
      // Bracketing slices and blend.
      let k = 0;
      while (k < nF - 2 && fields[k + 1]!.h < h) k++;
      const fa = fields[k]!, fb = fields[k + 1]!;
      const t = Math.max(0, Math.min(1, (h - fa.h) / (fb.h - fa.h)));
      fa.sample(x, y, this.sA);
      fb.sample(x, y, this.sB);
      let u = this.sA.u + (this.sB.u - this.sA.u) * t;
      let v = this.sA.v + (this.sB.v - this.sA.v) * t;
      const ratio = this.sA.ratio + (this.sB.ratio - this.sA.ratio) * t;
      const turb = this.sA.turb + (this.sB.turb - this.sA.turb) * t;
      if (turb > 0.02) {
        // Separated air: a smooth per-particle wobble plus a slower swirl (curling, broken streaks).
        const U = fa.speed + (fb.speed - fa.speed) * t;
        const p = this.ph[i]!;
        const a = turb * U * 0.55;
        u += a * (Math.sin(this.time * 9.1 + p) + 0.6 * Math.sin(this.time * 3.3 + 2.1 * p));
        v += a * (Math.cos(this.time * 8.3 + 1.7 * p) + 0.6 * Math.cos(this.time * 2.9 + p));
      }
      let nx = x + u * dt, ny = y + v * dt;
      // Collision guard against the cloth at this height.
      const L = this.cuts.level(h);
      const lv = this.cuts.levels[L]!;
      for (let e = 0; e < this.cuts.counts[L]!; e++) {
        if (guard(lv[e]!, x, y, nx, ny)) { nx = hit.x; ny = hit.y; break; }
      }
      x = nx; y = ny;
      const age = this.age[i]! + dt;
      if (age > this.life[i]! || !f0.inBounds(x, y)) {
        this.kill(i);
        if (this.mode === 'volume') this.spawnRandom(i, false);
        continue;
      }
      this.x[i] = x; this.y[i] = y; this.age[i] = age;
      const edge = Math.min(x - f0.x0, f0.x1 - x, y - f0.y0, f0.y1 - y);
      const fade = Math.min(1, age / 0.25) * Math.min(1, (this.life[i]! - age) / 0.5) * Math.min(1, edge / EDGE_FADE);
      // Free-stream air is drawn quieter than air the sails have sped up or slowed down.
      const dev = Math.min(1, Math.abs(ratio - 1) * 4 + turb);
      this.trails.alpha[i] = fade * (0.62 + 0.38 * dev);
      // Boat-local position (X stbd, Y up, Z aft); colour value: speed ratio, or −turbulence in a wake.
      this.trails.set(i, y, h, -x, turb > 0.25 ? -turb : ratio);
    }
    this.trails.commit(this.pushT / PUSH_DT);
  }

  setVisible(on: boolean): void {
    this.trails.setVisible(on);
    if (!on) this.started = false;
  }

  /** Switch between smoke rakes and free-floating particles (restarts the particles). */
  setMode(mode: 'rake' | 'volume'): void {
    this.mode = mode;
    this.started = false;
  }

  dispose(): void {
    this.trails.dispose();
  }

  private start(): void {
    this.nFree = 0;
    for (let i = this.n - 1; i >= 0; i--) {
      this.alive[i] = 0;
      this.trails.alpha[i] = 0;
      if (this.mode === 'rake') this.free[this.nFree++] = i;
      else this.spawnRandom(i, true);
    }
    this.emitT = EMIT_DT;
    this.started = true;
  }

  private kill(i: number): void {
    if (this.alive[i] && this.mode === 'rake') this.free[this.nFree++] = i;
    this.alive[i] = 0;
    this.trails.alpha[i] = 0;
  }

  private take(): number {
    return this.nFree > 0 ? this.free[--this.nFree]! : -1;
  }

  /** One release from every rake: a row of seeds across the flow, upstream of the rig, per rake height. */
  private emitRows(): void {
    for (const hr of RAKE_HEIGHTS) {
      // Slice nearest to the rake height gives the stream direction and where the sails are.
      let f = this.fields[0]!;
      for (const g of this.fields) if (Math.abs(g.h - hr) < Math.abs(f.h - hr)) f = g;
      if (f.version === 0) continue;
      const U = f.speed;
      const ux = f.uInf.x / U, uy = f.uInf.y / U;
      const nx = -uy, ny = ux;
      // Extent of the rig across and along the flow.
      let sMin = -1, sMax = 1, aMin = BOAT_RIG_X * ux;
      if (f.count > 0) {
        sMin = Infinity; sMax = -Infinity; aMin = Infinity;
        for (let e = 0; e < f.count; e++) {
          const el = f.elements[e]!;
          const s1 = el.leX * nx + el.leY * ny, s2 = el.teX * nx + el.teY * ny;
          sMin = Math.min(sMin, s1, s2); sMax = Math.max(sMax, s1, s2);
          aMin = Math.min(aMin, el.leX * ux + el.leY * uy, el.teX * ux + el.teY * uy);
        }
      }
      const along = aMin - RAKE_UPSTREAM;
      for (let sc = sMin - RAKE_MARGIN; sc <= sMax + RAKE_MARGIN + 1e-6; sc += RAKE_SPACING) {
        // Seed = along·ŵ + sc·n̂ (body coordinates); walk downstream into the grid if the rake starts outside it.
        let x = along * ux + sc * nx, y = along * uy + sc * ny;
        const f0 = this.fields[0]!;
        for (let k = 0; k < 40 && !f0.inBounds(x, y); k++) { x += ux * 0.25; y += uy * 0.25; }
        if (!f0.inBounds(x, y)) continue;
        const i = this.take();
        if (i < 0) return;
        this.x[i] = x; this.y[i] = y; this.h[i] = hr;
        this.age[i] = 0;
        this.life[i] = 7;
        this.ph[i] = rand() * 100;
        this.alive[i] = 1;
        this.trails.alpha[i] = 0;
        this.trails.reset(i, y, hr, -x, 1);
      }
    }
  }

  private spawnRandom(i: number, anywhere: boolean): void {
    const f = this.fields[0]!;
    const h = H_MIN + rand() * (H_MAX - H_MIN);
    let fld = this.fields[0]!;
    for (const g of this.fields) if (Math.abs(g.h - h) < Math.abs(fld.h - h)) fld = g;
    const ux = fld.uInf.x, uy = fld.uInf.y;
    let x: number, y: number;
    if (anywhere) {
      x = f.x0 + rand() * (f.x1 - f.x0);
      y = f.y0 + rand() * (f.y1 - f.y0);
    } else {
      // Enter through the upstream edges, weighted by the flux through each (uniform density in a uniform stream).
      const w = f.x1 - f.x0, hgt = f.y1 - f.y0;
      const fl = Math.max(0, ux) * hgt, fr = Math.max(0, -ux) * hgt, fb = Math.max(0, uy) * w, ft = Math.max(0, -uy) * w;
      let r = rand() * (fl + fr + fb + ft + 1e-9);
      const m = 0.05;
      if ((r -= fl) < 0) { x = f.x0 + m; y = f.y0 + rand() * hgt; }
      else if ((r -= fr) < 0) { x = f.x1 - m; y = f.y0 + rand() * hgt; }
      else if ((r -= fb) < 0) { y = f.y0 + m; x = f.x0 + rand() * w; }
      else { y = f.y1 - m; x = f.x0 + rand() * w; }
      const inward = rand() * 0.12;
      x += ux * inward; y += uy * inward;
    }
    this.x[i] = x; this.y[i] = y; this.h[i] = h;
    this.age[i] = anywhere ? rand() * 1.5 : 0;
    this.life[i] = 3 + rand() * 2.5;
    this.ph[i] = rand() * 100;
    this.alive[i] = 1;
    this.trails.alpha[i] = 0;
    this.trails.reset(i, y, h, -x, 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------

const WIND_BOX = 70; // half-size (m) of the square of water the true-wind particles cover
const WIND_CLEAR = 9; // radius around the rig where they fade out (the boat-frame flow lives there)
const WIND_PUSH = 1 / 12; // trail point spacing (s): ~1 s streaks

/** True-wind particles drifting over the water (world frame). */
export class WindParticles {
  readonly trails: TrailRenderer;
  private readonly n: number;
  private readonly e: Float32Array;
  private readonly nn: Float32Array;
  private readonly hh: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly field = new TrueWindField();
  private readonly w = { e: 0, n: 0 };
  private readonly boatV = new THREE.Vector3();
  private pushT = 0;
  private started = false;
  private cx = 0;
  private cn = 0;

  constructor(ctx: OverlayContext, q: QualitySettings) {
    this.n = Math.max(100, Math.round(420 * q.particleScale));
    this.e = new Float32Array(this.n);
    this.nn = new Float32Array(this.n);
    this.hh = new Float32Array(this.n);
    this.age = new Float32Array(this.n);
    this.life = new Float32Array(this.n);
    this.trails = new TrailRenderer(ctx, { count: this.n, slots: 12, width: 1.7, alpha: 0.36, colorMode: 'solid', color: linearColor(COLORS.trueWind).lerp(new THREE.Color(1, 1, 1), 0.5), renderOrder: 14 });
    this.trails.group.name = 'overlay-wind-particles';
  }

  update(dt: number, s: SimSnapshot): void {
    this.field.update(s);
    this.cx = s.boat.pos.x;
    this.cn = s.boat.pos.y;
    if (!this.started) {
      for (let i = 0; i < this.n; i++) this.spawn(i, true, s);
      this.started = true;
    }
    this.pushT += dt;
    if (this.pushT >= WIND_PUSH) { this.pushT %= WIND_PUSH; this.trails.push(); }
    for (let i = 0; i < this.n; i++) {
      this.field.sample(this.e[i]!, this.nn[i]!, this.hh[i]!, this.w);
      const e = this.e[i]! + this.w.e * dt, n = this.nn[i]! + this.w.n * dt;
      const age = this.age[i]! + dt;
      const de = e - this.cx, dn = n - this.cn;
      if (age > this.life[i]! || Math.abs(de) > WIND_BOX || Math.abs(dn) > WIND_BOX) { this.spawn(i, false, s); continue; }
      this.e[i] = e; this.nn[i] = n; this.age[i] = age;
      const r = Math.sqrt(de * de + dn * dn);
      const edge = WIND_BOX - Math.max(Math.abs(de), Math.abs(dn));
      this.trails.alpha[i] = Math.min(1, age / 0.6) * Math.min(1, (this.life[i]! - age) / 0.8) * Math.min(1, edge / 12)
        * Math.min(1, Math.max(0, (r - WIND_CLEAR) / 6));
      this.trails.set(i, e, this.hh[i]!, -n, 1);
    }
    this.trails.commit(this.pushT / WIND_PUSH);
  }

  setVisible(on: boolean): void {
    this.trails.setVisible(on);
    if (!on) this.started = false;
  }

  dispose(): void {
    this.trails.dispose();
  }

  private spawn(i: number, anywhere: boolean, s: SimSnapshot): void {
    // Relative to the (moving) box the air enters through the edges facing the wind minus the boat's motion.
    boatVelocityWorld(s, this.boatV);
    const f = this.field;
    const we = -f.baseSpeed * Math.sin(f.baseDir) - this.boatV.x, wn = -f.baseSpeed * Math.cos(f.baseDir) + this.boatV.z;
    let de: number, dn: number;
    const L = WIND_BOX * 0.98;
    if (anywhere) {
      de = (rand() * 2 - 1) * L; dn = (rand() * 2 - 1) * L;
    } else {
      const fl = Math.max(0, we), fr = Math.max(0, -we), fs = Math.max(0, wn), fnn = Math.max(0, -wn);
      let r = rand() * (fl + fr + fs + fnn + 1e-9);
      if ((r -= fl) < 0) { de = -L; dn = (rand() * 2 - 1) * L; }
      else if ((r -= fr) < 0) { de = L; dn = (rand() * 2 - 1) * L; }
      else if ((r -= fs) < 0) { dn = -L; de = (rand() * 2 - 1) * L; }
      else { dn = L; de = (rand() * 2 - 1) * L; }
    }
    this.e[i] = this.cx + de;
    this.nn[i] = this.cn + dn;
    this.hh[i] = 0.35 + rand() * rand() * 2.6;
    this.age[i] = anywhere ? rand() * 2 : 0;
    this.life[i] = 4 + rand() * 5;
    this.trails.alpha[i] = 0;
    this.trails.reset(i, this.e[i]!, this.hh[i]!, -this.nn[i]!, 1);
  }
}
