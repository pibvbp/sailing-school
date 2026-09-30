// OceanSampler: the drawn surface's height and normal on the CPU, for boat heave/pitch/roll, marks and
// camera clearance. A probe pass renders height + slope with the surface's own displacement code on
//  • a fine grid around the boat (40 m) and a coarse grid (1.6 km) — the boat's own motion, fallback;
//  • 5 × 5 stencils around registered points (marks, the camera): any heightAt() query farther than a
//    few metres from the boat registers itself and is served exactly from the next readback on, at the
//    level of detail the drawn mesh uses there and including the wake, as the surface vertex shader does.
// The result is read back with renderer.readRenderTargetPixelsAsync (never a synchronous read), served
// by bilinear lookup one frame late and extrapolated to the requested time with the change since the
// previous readback. Adapted from wave-riders `src/game/WaveField.js` (Sea/WaveField: two-level grid,
// bilinear lookup, previous grid for dh/dt, edge blend). Copyright (c) 2026 Davi (Token-Gremlin), MIT
// License — adapted for sailing-school (TypeScript, three r186 async readback, sim-world coordinates,
// registered point probes).
import * as THREE from 'three';
import { FullScreenPass, makeRT } from './gpuPass';
import { MAX_PROBE_POINTS, PROBE_FRAG, STENCIL_NODES, STENCIL_SPACING } from './shaders/probe.glsl';
import type { OceanSampler } from './types';

export { MAX_PROBE_POINTS, STENCIL_NODES, STENCIL_SPACING };

/** One square grid inside a readback: nodes (i, j) at world (originX + i·spacing, originZ + j·spacing). */
export interface GridView {
  data: Float32Array;
  /** Texels per row of the readback (all blocks share rows). */
  stride: number;
  /** First column and first row of this grid in the readback. */
  column: number;
  row: number;
  cells: number;
  originX: number;
  originZ: number;
  spacing: number;
}

export interface SurfaceSample { h: number; sx: number; sz: number }

/** Bilinear height and slope (∂h/∂x, ∂h/∂z) at world (x, z); false outside the grid or on bad data. */
export function sampleGrid(g: GridView, x: number, z: number, out: SurfaceSample): boolean {
  const fx = (x - g.originX) / g.spacing, fz = (z - g.originZ) / g.spacing;
  const last = g.cells - 1;
  if (!(fx >= 0 && fz >= 0 && fx <= last && fz <= last)) return false;
  const ix = Math.min(last - 1, Math.floor(fx)), iz = Math.min(last - 1, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const i00 = ((g.row + iz) * g.stride + g.column + ix) * 4, i10 = i00 + 4;
  const i01 = i00 + g.stride * 4, i11 = i01 + 4;
  const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
  const d = g.data;
  const h = d[i00]! * w00 + d[i10]! * w10 + d[i01]! * w01 + d[i11]! * w11;
  if (!Number.isFinite(h)) return false;
  out.h = h;
  out.sx = d[i00 + 1]! * w00 + d[i10 + 1]! * w10 + d[i01 + 1]! * w01 + d[i11 + 1]! * w11;
  out.sz = d[i00 + 2]! * w00 + d[i10 + 2]! * w10 + d[i01 + 2]! * w01 + d[i11 + 2]! * w11;
  return true;
}

/** A completed readback: fine and coarse grids plus the registered points' stencils, at one sea time. */
export interface HeightSnapshot {
  fine: GridView;
  coarse: GridView;
  /** Stencils of the points probed in this readback (centre = originX/Z + half the stencil). */
  points: GridView[];
  time: number;
}

/** Where a lookup was served from; the time extrapolation must compare like with like. */
const SRC_NONE = 0, SRC_POINT = 1, SRC_FINE = 2, SRC_COARSE = 3;
type Source = typeof SRC_NONE | typeof SRC_POINT | typeof SRC_FINE | typeof SRC_COARSE;

const _s = { h: 0, sx: 0, sz: 0 };
const _p = { h: 0, sx: 0, sz: 0 };
const _c = { h: 0, sx: 0, sz: 0 };
const STENCIL_HALF = ((STENCIL_NODES - 1) / 2) * STENCIL_SPACING;

/**
 * CPU side of the sampler: lookups on the newest snapshot — a registered point's stencil first, then
 * the fine grid blended into the coarse one over its outer 20 % (no step for a hull crossing the edge),
 * then the coarse grid — extrapolated in time with the change since the previous snapshot of the same
 * source. Outside everything the sea is at mean level.
 */
export class HeightGridSet implements OceanSampler {
  private cur: HeightSnapshot | null = null;
  private prev: HeightSnapshot | null = null;
  /** Stencil that served the last sampleWorld() call, if any (for point bookkeeping). */
  lastPoint: GridView | null = null;

  push(s: HeightSnapshot): void { this.prev = this.cur; this.cur = s; }
  get latest(): HeightSnapshot | null { return this.cur; }

  /** Height/slope in the three.js world (x = east, z = south) at time t. */
  sampleWorld(x: number, z: number, t: number, out: SurfaceSample): SurfaceSample {
    out.h = 0; out.sx = 0; out.sz = 0;
    this.lastPoint = null;
    const cur = this.cur;
    if (!cur) return out;
    const source = this.lookup(cur, x, z, out, true);
    if (source === SRC_NONE) return out;
    const prev = this.prev;
    const span = prev ? cur.time - prev.time : 0;
    // Allow extrapolating over a few readback intervals (time-scaled or slow frames), never far.
    const cap = Math.max(0.1, Math.min(0.5, 2.5 * span));
    const ahead = Math.max(-cap, Math.min(cap, t - cur.time));
    if (prev && span > 1e-4 && span < 1 && ahead !== 0 && this.lookupSame(prev, source, x, z, _p)) {
      const k = ahead / span;
      out.h += Math.max(-3, Math.min(3, (out.h - _p.h) / span)) * ahead;
      out.sx += (out.sx - _p.sx) * k;
      out.sz += (out.sz - _p.sz) * k;
    }
    return out;
  }

  heightAt(e: number, n: number, t: number): number { return this.sampleWorld(e, -n, t, _s).h; }

  /** Diagnostics: the fine/coarse grids' value at world (x, z) in the newest readback, ignoring points. */
  sampleGridsOnly(x: number, z: number, out: SurfaceSample): boolean {
    return this.cur !== null && this.lookup(this.cur, x, z, out, false) !== SRC_NONE;
  }

  normalAt(e: number, n: number, t: number, out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }): { x: number; y: number; z: number } {
    const s = this.sampleWorld(e, -n, t, _s);
    const l = Math.hypot(s.sx, 1, s.sz);
    out.x = -s.sx / l; out.y = 1 / l; out.z = -s.sz / l;
    return out;
  }

  private lookup(s: HeightSnapshot, x: number, z: number, out: SurfaceSample, usePoints: boolean): Source {
    if (usePoints) {
      for (const p of s.points) {
        if (sampleGrid(p, x, z, out)) { this.lastPoint = p; return SRC_POINT; }
      }
    }
    const f = s.fine;
    if (sampleGrid(f, x, z, out)) {
      const half = ((f.cells - 1) * f.spacing) / 2;
      const cx = f.originX + half, cz = f.originZ + half;
      const edge = Math.max(Math.abs(x - cx), Math.abs(z - cz)) / half;
      if (edge > 0.8 && sampleGrid(s.coarse, x, z, _c)) {
        const t = (edge - 0.8) / 0.2;
        out.h += (_c.h - out.h) * t;
        out.sx += (_c.sx - out.sx) * t;
        out.sz += (_c.sz - out.sz) * t;
      }
      return SRC_FINE;
    }
    return sampleGrid(s.coarse, x, z, out) ? SRC_COARSE : SRC_NONE;
  }

  /** The same source in an older snapshot (a point stencil only if it was probed at the same place). */
  private lookupSame(s: HeightSnapshot, source: Source, x: number, z: number, out: SurfaceSample): boolean {
    if (source === SRC_POINT) {
      const cur = this.lastPoint!;
      for (const p of s.points) {
        if (p.originX === cur.originX && p.originZ === cur.originZ) return sampleGrid(p, x, z, out);
      }
      return false;
    }
    return this.lookup(s, x, z, out, false) === source;
  }
}

/** A registered probe point (three.js world x, z). */
export interface ProbePoint { x: number; z: number; lastUsed: number }

/**
 * Registered points: a query not covered by a stencil registers its position (the first query of a
 * mark is its centre, so the ±0.6 m slope queries that follow land on stencil nodes); points unused
 * for `ttl` frames are dropped, and when all slots are busy the least recently used one is recycled.
 */
export class ProbePoints {
  readonly points: ProbePoint[] = [];
  frame = 0;

  constructor(readonly capacity = MAX_PROBE_POINTS, readonly ttl = 60) {}

  /** Note a query at (x, z); returns true if it is (or will be from the next probe on) covered. */
  request(x: number, z: number): boolean {
    for (const p of this.points) {
      if (Math.abs(x - p.x) <= STENCIL_HALF && Math.abs(z - p.z) <= STENCIL_HALF) { p.lastUsed = this.frame; return true; }
    }
    if (this.points.length < this.capacity) {
      this.points.push({ x, z, lastUsed: this.frame });
      return true;
    }
    let oldest = 0;
    for (let i = 1; i < this.points.length; i++) if (this.points[i]!.lastUsed < this.points[oldest]!.lastUsed) oldest = i;
    // Never evict a point that is still being asked for this frame or the last.
    if (this.points[oldest]!.lastUsed >= this.frame - 1) return false;
    this.points[oldest] = { x, z, lastUsed: this.frame };
    return true;
  }

  /** Mark the point probed at stencil origin (ox, oz) as used (its stencil served a query). */
  touch(ox: number, oz: number): void {
    for (const p of this.points) {
      if (p.x - STENCIL_HALF === ox && p.z - STENCIL_HALF === oz) { p.lastUsed = this.frame; return; }
    }
  }

  /** Start a new frame: drop points nobody asked for recently. */
  advance(): void {
    this.frame++;
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.frame - this.points[i]!.lastUsed > this.ttl) this.points.splice(i, 1);
    }
  }
}

export interface ProbeOptions { cells?: number; fineSpan?: number; coarseSpan?: number }

/** Mesh level of detail at a point: the footprint (m) of one projected-grid cell seen from the camera. */
export interface ProbeView {
  camX: number;
  camY: number;
  camZ: number;
  /** Angular size of one grid row / column (rad). */
  rowAngle: number;
  colAngle: number;
}

/** Footprint of the drawn mesh's cells at world (x, z) — the LOD the surface vertex shader uses there. */
export function meshFootprint(v: ProbeView, x: number, z: number): number {
  const d = Math.hypot(x - v.camX, z - v.camZ);
  const h = Math.max(v.camY, 0.35);
  const cell = Math.max(d * v.colAngle, ((d * d + h * h) / h) * v.rowAngle);
  return Math.min(Math.max(cell, 0.03), 12);
}

interface ReadbackSlot { data: Float32Array; raw: Float32Array | Uint16Array; snapshot: HeightSnapshot; stencils: GridView[] }

/** GPU half: renders the probe and keeps one asynchronous readback in flight. */
export class OceanHeightSampler implements OceanSampler {
  readonly grids = new HeightGridSet();
  readonly registry = new ProbePoints();
  /** False when this GPU can neither render nor read back float/half-float targets: a flat sea. */
  readonly available: boolean;
  private readonly cells: number;
  private readonly width: number;
  private readonly height: number;
  private readonly fineSpacing: number;
  private readonly coarseSpacing: number;
  private readonly target: THREE.WebGLRenderTarget | null;
  private readonly pass: FullScreenPass;
  private readonly half: boolean;
  private readonly spare: ReadbackSlot[] = [];
  private readonly inUse: ReadbackSlot[] = [];
  private readonly pointUniforms: THREE.Vector4[];
  private pending = false;
  private disposed = false;
  /** Queries closer than `exclusionRadius` to (exclusionX, exclusionZ) — the boat's own — never register. */
  exclusionX = 0;
  exclusionZ = 0;
  exclusionRadius = -1;
  /** Camera and mesh resolution for the points' level of detail. */
  readonly view: ProbeView = { camX: 0, camY: 3, camZ: 0, rowAngle: 0.002, colAngle: 0.002 };

  constructor(private readonly renderer: THREE.WebGLRenderer, uniforms: Record<string, THREE.IUniform>, o: ProbeOptions = {}) {
    this.cells = o.cells ?? 64;
    this.width = this.cells * 2;
    this.height = this.cells + STENCIL_NODES;
    this.fineSpacing = (o.fineSpan ?? 40) / (this.cells - 1);
    this.coarseSpacing = (o.coarseSpan ?? 1600) / (this.cells - 1);
    const ext = renderer.extensions;
    const float = ext.has('EXT_color_buffer_float');
    this.half = !float && ext.has('EXT_color_buffer_half_float');
    this.available = float || this.half;
    if (!this.available) console.warn('Ocean: no float render targets — the sampler reports a flat sea.');
    this.target = this.available
      ? makeRT(this.width, this.height, { type: float ? THREE.FloatType : THREE.HalfFloatType, filter: 'nearest', name: 'oceanProbe' })
      : null;
    this.pointUniforms = Array.from({ length: MAX_PROBE_POINTS }, () => new THREE.Vector4());
    this.pass = new FullScreenPass(PROBE_FRAG, {
      ...uniforms,
      uCells: { value: this.cells },
      uFine: { value: new THREE.Vector4() },
      uCoarse: { value: new THREE.Vector4() },
      uPoints: { value: this.pointUniforms },
    }, 'oceanProbe');
    const texels = this.width * this.height * 4;
    for (let i = 0; i < 3; i++) {
      const data = new Float32Array(texels);
      const stencils = Array.from({ length: MAX_PROBE_POINTS }, (_, k): GridView => ({
        data, stride: this.width, column: k * STENCIL_NODES, row: this.cells, cells: STENCIL_NODES, originX: 0, originZ: 0, spacing: STENCIL_SPACING,
      }));
      const grid = (column: number, spacing: number): GridView => ({ data, stride: this.width, column, row: 0, cells: this.cells, originX: 0, originZ: 0, spacing });
      this.spare.push({
        data, raw: this.half ? new Uint16Array(texels) : data, stencils,
        snapshot: { fine: grid(0, this.fineSpacing), coarse: grid(this.cells, this.coarseSpacing), points: [], time: 0 },
      });
    }
  }

  /** Render this frame's grids around (focusX, focusZ) and the registered points for sea time t, and start a readback if idle. */
  update(t: number, focusX: number, focusZ: number): void {
    this.registry.advance();
    if (this.pending || this.disposed || !this.target) return;
    const slot = this.spare.pop();
    if (!slot) return;
    const snap = slot.snapshot;
    // Snap grid origins to the node spacing so consecutive grids share nodes (clean dh/dt).
    this.placeGrid(snap.fine, focusX, focusZ);
    this.placeGrid(snap.coarse, focusX, focusZ);
    snap.time = t;
    snap.points.length = 0;
    const pts = this.registry.points;
    for (let k = 0; k < MAX_PROBE_POINTS; k++) {
      const p = pts[k];
      const u = this.pointUniforms[k]!;
      if (!p) { u.set(0, 0, 1, 0); continue; }
      u.set(p.x, p.z, meshFootprint(this.view, p.x, p.z), 1);
      const st = slot.stencils[k]!;
      st.originX = p.x - STENCIL_HALF;
      st.originZ = p.z - STENCIL_HALF;
      snap.points.push(st);
    }
    (this.pass.uniforms['uFine']!.value as THREE.Vector4).set(snap.fine.originX, snap.fine.originZ, snap.fine.spacing, snap.fine.spacing * 0.5);
    (this.pass.uniforms['uCoarse']!.value as THREE.Vector4).set(snap.coarse.originX, snap.coarse.originZ, snap.coarse.spacing, snap.coarse.spacing * 0.5);
    this.pass.render(this.renderer, this.target);
    this.pending = true;
    this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, this.width, this.height, slot.raw)
      .then(() => {
        if (this.disposed) return;
        if (slot.raw !== slot.data) {
          const raw = slot.raw as Uint16Array, data = slot.data;
          for (let i = 0; i < raw.length; i++) data[i] = THREE.DataUtils.fromHalfFloat(raw[i]!);
        }
        this.grids.push(snap);
        // Slots in use: newest + previous (for dh/dt); anything older goes back to the pool.
        this.inUse.push(slot);
        while (this.inUse.length > 2) this.spare.push(this.inUse.shift()!);
      })
      .catch(() => { this.spare.push(slot); })
      .finally(() => { this.pending = false; });
  }

  heightAt(e: number, n: number, t: number): number {
    const h = this.grids.heightAt(e, n, t);
    this.note(e, -n);
    return h;
  }

  normalAt(e: number, n: number, t: number, out?: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const r = this.grids.normalAt(e, n, t, out);
    this.note(e, -n);
    return r;
  }

  dispose(): void {
    this.disposed = true;
    this.target?.dispose();
    this.pass.dispose();
  }

  /** Point bookkeeping after a lookup: keep a serving stencil alive, or register an uncovered query. */
  private note(x: number, z: number): void {
    const g = this.grids;
    if (g.lastPoint) { this.registry.touch(g.lastPoint.originX, g.lastPoint.originZ); return; }
    if (this.exclusionRadius > 0 && Math.hypot(x - this.exclusionX, z - this.exclusionZ) < this.exclusionRadius) return;
    this.registry.request(x, z);
  }

  private placeGrid(g: GridView, fx: number, fz: number): void {
    const half = ((g.cells - 1) * g.spacing) / 2;
    g.originX = Math.round((fx - half) / g.spacing) * g.spacing;
    g.originZ = Math.round((fz - half) / g.spacing) * g.spacing;
  }
}
