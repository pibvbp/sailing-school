// Regular velocity grid over one slice — what the flow particles and the slice overlay read every frame.
//
// `fill` evaluates the solved lattice (free stream + induced velocity, Rankine cores) at every node once, at the
// solver's ~10 Hz; `sample` is then a bilinear lookup that neither allocates nor calls back into the solver.
import type { Vec2 } from '../shared/math';
import { VortexPack, fieldAt } from './vortexLattice';
import type { SliceSolution } from './vortexLattice';

export interface GridBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class VelocityGrid {
  readonly nx: number;
  readonly ny: number;
  /** Node spacing: nodes sit on both edges, x0 + i·dx (i = 0…nx−1) and y0 + j·dy. */
  readonly dx: number;
  readonly dy: number;
  readonly bounds: GridBounds;
  /**
   * Node velocities as interleaved (u, v) pairs, row-major with x fastest: node (i, j) is at index 2·(j·nx + i).
   * Float32 and this layout make it a ready-made RG/FloatType DataTexture for a shader-side lookup.
   * Total air velocity (free stream included), all zero until the first `fill`.
   */
  readonly data: Float32Array;
  /** Free stream of the solution last passed to `fill`. */
  readonly uInf: Vec2 = { x: 0, y: 0 };

  private readonly invDx: number;
  private readonly invDy: number;
  private readonly pack = new VortexPack();
  private readonly node: Vec2 = { x: 0, y: 0 };
  private readonly shared: Vec2 = { x: 0, y: 0 };

  constructor(bounds: GridBounds, nx: number, ny: number) {
    const { x0, y0, x1, y1 } = bounds;
    if (![x0, y0, x1, y1].every(Number.isFinite) || !(x1 > x0) || !(y1 > y0)) {
      throw new RangeError('VelocityGrid: bounds must be finite with x1 > x0 and y1 > y0');
    }
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 2 || ny < 2) {
      throw new RangeError('VelocityGrid: needs an integer node count of at least 2 per axis');
    }
    this.nx = nx;
    this.ny = ny;
    this.bounds = { x0, y0, x1, y1 };
    this.dx = (x1 - x0) / (nx - 1);
    this.dy = (y1 - y0) / (ny - 1);
    this.invDx = 1 / this.dx;
    this.invDy = 1 / this.dy;
    this.data = new Float32Array(2 * nx * ny);
  }

  /** Evaluate the solution at every node. `core` overrides the default vortex-core radius (see `velocityAt`). */
  fill(sol: SliceSolution, core?: number): void {
    this.pack.load(sol, core);
    const u0 = sol.uInf.x;
    const v0 = sol.uInf.y;
    this.uInf.x = u0;
    this.uInf.y = v0;
    const { nx, ny, data, node, pack } = this;
    let k = 0;
    for (let j = 0; j < ny; j++) {
      const y = this.bounds.y0 + j * this.dy;
      for (let i = 0; i < nx; i++) {
        fieldAt(pack, u0, v0, this.bounds.x0 + i * this.dx, y, node);
        data[k++] = node.x;
        data[k++] = node.y;
      }
    }
  }

  /**
   * Bilinear velocity at (x, y); positions outside the grid take the value of the nearest edge.
   *
   * Allocation-free: the result is written into `out` when given, otherwise into ONE object owned by the grid and
   * returned on every call — read it (or copy it) before the next `sample` call on the same grid.
   */
  sample(x: number, y: number, out: Vec2 = this.shared): Vec2 {
    const { nx, ny, data } = this;
    let fx = (x - this.bounds.x0) * this.invDx;
    let fy = (y - this.bounds.y0) * this.invDy;
    if (!(fx > 0)) fx = 0; // also catches NaN
    else if (fx > nx - 1) fx = nx - 1;
    if (!(fy > 0)) fy = 0;
    else if (fy > ny - 1) fy = ny - 1;
    let i0 = fx | 0;
    let j0 = fy | 0;
    if (i0 > nx - 2) i0 = nx - 2;
    if (j0 > ny - 2) j0 = ny - 2;
    const tx = fx - i0;
    const ty = fy - j0;
    const k00 = 2 * (j0 * nx + i0);
    const k10 = k00 + 2;
    const k01 = k00 + 2 * nx;
    const k11 = k01 + 2;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    out.x = data[k00] * w00 + data[k10] * w10 + data[k01] * w01 + data[k11] * w11;
    out.y = data[k00 + 1] * w00 + data[k10 + 1] * w10 + data[k01 + 1] * w01 + data[k11 + 1] * w11;
    return out;
  }
}
