// OceanSampler: the drawn surface's height and normal on the CPU, for boat heave/pitch/roll and marks.
// A probe pass renders height + slope on two grids with the surface's own displacement code, the
// result is read back with renderer.readRenderTargetPixelsAsync (never a synchronous read) and served
// by bilinear lookup one frame late, extrapolated to the requested time with the grids' dh/dt.
// Adapted from wave-riders `src/game/WaveField.js` (Sea/WaveField: two-level grid, bilinear lookup,
// previous grid for dh/dt, edge blend). Copyright (c) 2026 Davi (Token-Gremlin), MIT License —
// adapted for sailing-school (TypeScript, three r186 async readback, sim-world coordinates).
import * as THREE from 'three';
import { FullScreenPass, makeRT } from './gpuPass';
import { PROBE_FRAG } from './shaders/probe.glsl';
import type { OceanSampler } from './types';

/** One square grid inside a readback: nodes (i, j) at world (originX + i·spacing, originZ + j·spacing). */
export interface GridView {
  data: Float32Array;
  /** Texels per row of the readback (both grids share rows). */
  stride: number;
  /** First column of this grid in the readback. */
  column: number;
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
  const i00 = (iz * g.stride + g.column + ix) * 4, i10 = i00 + 4;
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

/** A completed readback: fine grid around the focus plus a wide coarse grid, at one sea time. */
export interface HeightSnapshot { fine: GridView; coarse: GridView; time: number }

const _s = { h: 0, sx: 0, sz: 0 };
const _p = { h: 0, sx: 0, sz: 0 };
const _c = { h: 0, sx: 0, sz: 0 };

/**
 * CPU side of the sampler: lookups on the newest snapshot, blending the fine grid into the coarse one
 * over its outer 20 % (no step for a hull crossing the edge), extrapolated in time with the change
 * since the previous snapshot. Outside both grids the sea is at mean level.
 */
export class HeightGridSet implements OceanSampler {
  private cur: HeightSnapshot | null = null;
  private prev: HeightSnapshot | null = null;

  push(s: HeightSnapshot): void { this.prev = this.cur; this.cur = s; }
  get latest(): HeightSnapshot | null { return this.cur; }

  /** Height/slope in the three.js world (x = east, z = south) at time t. */
  sampleWorld(x: number, z: number, t: number, out: SurfaceSample): SurfaceSample {
    out.h = 0; out.sx = 0; out.sz = 0;
    const cur = this.cur;
    if (!cur || !lookup(cur, x, z, out)) return out;
    const prev = this.prev;
    const span = prev ? cur.time - prev.time : 0;
    const ahead = Math.max(-0.1, Math.min(0.1, t - cur.time));
    if (prev && span > 1e-4 && span < 0.25 && ahead !== 0 && lookup(prev, x, z, _p)) {
      const k = ahead / span;
      out.h += Math.max(-3, Math.min(3, (out.h - _p.h) / span)) * ahead;
      out.sx += (out.sx - _p.sx) * k;
      out.sz += (out.sz - _p.sz) * k;
    }
    return out;
  }

  heightAt(e: number, n: number, t: number): number { return this.sampleWorld(e, -n, t, _s).h; }

  normalAt(e: number, n: number, t: number): { x: number; y: number; z: number } {
    const s = this.sampleWorld(e, -n, t, _s);
    const l = Math.hypot(s.sx, 1, s.sz);
    return { x: -s.sx / l, y: 1 / l, z: -s.sz / l };
  }
}

function lookup(s: HeightSnapshot, x: number, z: number, out: SurfaceSample): boolean {
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
    return true;
  }
  return sampleGrid(s.coarse, x, z, out);
}

export interface ProbeOptions { cells?: number; fineSpan?: number; coarseSpan?: number }

/** GPU half: renders the probe and keeps one asynchronous readback in flight. */
export class OceanHeightSampler implements OceanSampler {
  readonly grids = new HeightGridSet();
  private readonly cells: number;
  private readonly fineSpacing: number;
  private readonly coarseSpacing: number;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly pass: FullScreenPass;
  private readonly spare: Float32Array[] = [];
  private readonly inUse: Float32Array[] = [];
  private pending = false;
  private disposed = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, uniforms: Record<string, THREE.IUniform>, o: ProbeOptions = {}) {
    this.cells = o.cells ?? 64;
    this.fineSpacing = (o.fineSpan ?? 40) / (this.cells - 1);
    this.coarseSpacing = (o.coarseSpan ?? 1600) / (this.cells - 1);
    this.target = makeRT(this.cells * 2, this.cells, { type: THREE.FloatType, filter: 'nearest', name: 'oceanProbe' });
    this.pass = new FullScreenPass(PROBE_FRAG, {
      ...uniforms,
      uCells: { value: this.cells },
      uFine: { value: new THREE.Vector4() },
      uCoarse: { value: new THREE.Vector4() },
    }, 'oceanProbe');
    for (let i = 0; i < 3; i++) this.spare.push(new Float32Array(this.cells * this.cells * 2 * 4));
  }

  /** Render this frame's grids around (focusX, focusZ) for sea time t and start a readback if idle. */
  update(t: number, focusX: number, focusZ: number): void {
    if (this.pending || this.disposed) return;
    const buffer = this.spare.pop();
    if (!buffer) return;
    // Snap origins to the node spacing so consecutive grids share nodes (clean dh/dt).
    const fine = this.gridFor(focusX, focusZ, this.fineSpacing, buffer, 0);
    const coarse = this.gridFor(focusX, focusZ, this.coarseSpacing, buffer, this.cells);
    (this.pass.uniforms['uFine']!.value as THREE.Vector4).set(fine.originX, fine.originZ, fine.spacing, fine.spacing * 0.5);
    (this.pass.uniforms['uCoarse']!.value as THREE.Vector4).set(coarse.originX, coarse.originZ, coarse.spacing, coarse.spacing * 0.5);
    this.pass.render(this.renderer, this.target);
    this.pending = true;
    const snapshot: HeightSnapshot = { fine, coarse, time: t };
    this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, this.cells * 2, this.cells, buffer)
      .then(() => {
        if (this.disposed) return;
        this.grids.push(snapshot);
        // Buffers in use: newest + previous (for dh/dt); anything older goes back to the pool.
        this.inUse.push(buffer);
        while (this.inUse.length > 2) this.spare.push(this.inUse.shift()!);
      })
      .catch(() => { this.spare.push(buffer); })
      .finally(() => { this.pending = false; });
  }

  heightAt(e: number, n: number, t: number): number { return this.grids.heightAt(e, n, t); }
  normalAt(e: number, n: number, t: number): { x: number; y: number; z: number } { return this.grids.normalAt(e, n, t); }

  dispose(): void {
    this.disposed = true;
    this.target.dispose();
    this.pass.dispose();
  }

  private gridFor(fx: number, fz: number, spacing: number, data: Float32Array, column: number): GridView {
    const half = ((this.cells - 1) * spacing) / 2;
    return {
      data, stride: this.cells * 2, column, cells: this.cells, spacing,
      originX: Math.round((fx - half) / spacing) * spacing,
      originZ: Math.round((fz - half) / spacing) * spacing,
    };
  }
}
