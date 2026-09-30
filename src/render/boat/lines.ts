// Linear things: tubes swept along paths (rails, wires, spars with custom sections) and ropes.
// Ropes share one material: a tileable greyscale braid with a tracer mask, tinted per vertex with the
// rope's base and tracer colours (no atlas, so distant mips cannot bleed one rope's colour into another).
// RopeSet holds all animated ropes in one mesh and rewrites them in place (no allocation per frame).
import * as THREE from 'three';

type V3 = THREE.Vector3;

/** Rope colourways (index into ROPE_COLOURS). */
export const ROPE = {
  mainSheet: 0,
  jibPort: 1,
  jibStbd: 2,
  spinnaker: 3,
  halyard: 4,
  control: 5,
  black: 6,
  grey: 7,
} as const;

/** Base and tracer (fleck) colour of each rope colourway, sRGB (spec §6 running-rigging colours). */
export const ROPE_COLOURS: ReadonlyArray<readonly [number, number]> = [
  [0x1d4fa8, 0xf2f2ee], // main sheet: blue, white fleck
  [0xf0efea, 0xc8202a], // port jib sheet: white, red fleck
  [0xf0efea, 0x1f8a3c], // starboard jib sheet: white, green fleck
  [0xf06a14, 0x1b1b1b], // spinnaker sheets and guys: signal orange, black tracer
  [0xf3f2ee, 0x2a55b8], // halyards: white, blue fleck
  [0x34373b, 0xd9c21e], // control lines: charcoal, yellow fleck
  [0x161718, 0xe8e8e8], // furling line, adjusters: black, white fleck
  [0xa9adb0, 0x5d6166], // bare Dyneema: grey
];

const _col = new THREE.Color();
/** Linear-space base and tracer colours of a colourway. */
function ropeColours(cell: number): [number, number, number, number, number, number] {
  const [base, tracer] = ROPE_COLOURS[cell] ?? ROPE_COLOURS[0];
  _col.setHex(base, THREE.SRGBColorSpace);
  const b = [_col.r, _col.g, _col.b];
  _col.setHex(tracer, THREE.SRGBColorSpace);
  return [b[0], b[1], b[2], _col.r, _col.g, _col.b];
}

/** Add the per-vertex `color` (base) and `tracer` attributes of a colourway to a rope geometry. */
function tintRope(g: THREE.BufferGeometry, cell: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const [r, gg, b, tr, tg, tb] = ropeColours(cell);
  const col = new Float32Array(n * 3), tra = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col.set([r, gg, b], i * 3); tra.set([tr, tg, tb], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tracer', new THREE.BufferAttribute(tra, 3));
  return g;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Rotation-minimising frames along a polyline (double reflection, Wang et al. 2008). */
export function rmFrames(pts: readonly V3[], normals: V3[], binormals: V3[], tangents: V3[], seedNormal?: V3, count = pts.length): void {
  const n = count;
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    if (i === 0) t.subVectors(pts[1], pts[0]);
    else if (i === n - 1) t.subVectors(pts[n - 1], pts[n - 2]);
    else t.subVectors(pts[i + 1], pts[i - 1]);
    if (t.lengthSq() < 1e-16) t.copy(i > 0 ? tangents[i - 1] : _a.set(0, 0, 1));
    t.normalize();
  }
  // Initial normal: any vector perpendicular to the first tangent (or the seed projected).
  const t0 = tangents[0];
  const r0 = normals[0];
  if (seedNormal) r0.copy(seedNormal); else r0.set(Math.abs(t0.y) < 0.9 ? 0 : 1, Math.abs(t0.y) < 0.9 ? 1 : 0, 0);
  r0.addScaledVector(t0, -r0.dot(t0)).normalize();
  binormals[0].crossVectors(t0, r0);
  for (let i = 0; i < n - 1; i++) {
    const v1 = _a.subVectors(pts[i + 1], pts[i]);
    const c1 = v1.dot(v1);
    if (c1 < 1e-16) { normals[i + 1].copy(normals[i]); binormals[i + 1].copy(binormals[i]); continue; }
    const rL = _b.copy(normals[i]).addScaledVector(v1, (-2 / c1) * v1.dot(normals[i]));
    const tL = _c.copy(tangents[i]).addScaledVector(v1, (-2 / c1) * v1.dot(tangents[i]));
    const v2 = tL.sub(tangents[i + 1]).multiplyScalar(-1);
    const c2 = v2.dot(v2);
    const r = normals[i + 1].copy(rL);
    if (c2 > 1e-16) r.addScaledVector(v2, (-2 / c2) * v2.dot(rL));
    r.addScaledVector(tangents[i + 1], -r.dot(tangents[i + 1])).normalize();
    binormals[i + 1].crossVectors(tangents[i + 1], r);
  }
}

export interface TubeOptions {
  /** Radius, or radius per path point. */
  radius: number | ((i: number, s: number) => number);
  radial: number;
  capStart?: boolean;
  capEnd?: boolean;
  /** Closed cross-section in the (normal, binormal) plane, unit scale; defaults to a circle. */
  profile?: ReadonlyArray<readonly [number, number]>;
  /** Scale of the profile per path point [sx, sy] (overrides radius when a profile is given). */
  profileScale?: (i: number, s: number) => readonly [number, number];
  /** Seed for the frame's normal at the first point (orients non-circular profiles). */
  seedNormal?: V3;
  /** UV: u = uOffset + uScale · around, v = arc length · vScale. */
  uOffset?: number;
  uScale?: number;
  vScale?: number;
}

function circle(radial: number): Array<[number, number]> {
  const p: Array<[number, number]> = [];
  for (let j = 0; j < radial; j++) {
    const a = (j / radial) * Math.PI * 2;
    p.push([Math.cos(a), Math.sin(a)]);
  }
  return p;
}

/** Tube (or extrusion of a closed section) along a polyline. */
export function tube(path: readonly V3[], o: TubeOptions): THREE.BufferGeometry {
  const n = path.length;
  const prof = o.profile ?? circle(o.radial);
  const m = prof.length;
  const N = path.map(() => new THREE.Vector3()), B = path.map(() => new THREE.Vector3()), T = path.map(() => new THREE.Vector3());
  rmFrames(path, N, B, T, o.seedNormal);
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + path[i].distanceTo(path[i - 1]));
  // Profile outward normals (2-D) from neighbouring edges.
  const pn = prof.map((_, j) => {
    const a = prof[(j - 1 + m) % m], b = prof[(j + 1) % m];
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    return [ty / l, -tx / l] as const;
  });
  const uOff = o.uOffset ?? 0, uSc = o.uScale ?? 1, vSc = o.vScale ?? 1;
  const ring = m + 1;
  const capVerts = (o.capStart ? m + 1 : 0) + (o.capEnd ? m + 1 : 0);
  const pos = new Float32Array((n * ring + capVerts) * 3);
  const nor = new Float32Array((n * ring + capVerts) * 3);
  const uv = new Float32Array((n * ring + capVerts) * 2);
  const index: number[] = [];
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const [sx, sy] = o.profileScale ? o.profileScale(i, s[i]) : (() => { const r = typeof o.radius === 'number' ? o.radius : o.radius(i, s[i]); return [r, r] as const; })();
    for (let j = 0; j <= m; j++) {
      const jj = j % m;
      const [px, py] = prof[jj];
      p.copy(path[i]).addScaledVector(N[i], px * sx).addScaledVector(B[i], py * sy);
      const [nx, ny] = pn[jj];
      q.set(0, 0, 0).addScaledVector(N[i], nx / Math.max(sx, 1e-6)).addScaledVector(B[i], ny / Math.max(sy, 1e-6)).normalize();
      const v = i * ring + j;
      pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
      nor[v * 3] = q.x; nor[v * 3 + 1] = q.y; nor[v * 3 + 2] = q.z;
      uv[v * 2] = uOff + uSc * (j / m);
      uv[v * 2 + 1] = s[i] * vSc;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < m; j++) {
      const a = i * ring + j, b = (i + 1) * ring + j, c = (i + 1) * ring + j + 1, d = i * ring + j + 1;
      index.push(a, d, b, d, c, b);
    }
  }
  let base = n * ring;
  const cap = (i: number, flip: boolean) => {
    const [sx, sy] = o.profileScale ? o.profileScale(i, s[i]) : (() => { const r = typeof o.radius === 'number' ? o.radius : o.radius(i, s[i]); return [r, r] as const; })();
    const t = T[i];
    const sign = flip ? -1 : 1;
    const c0 = base;
    pos.set([path[i].x, path[i].y, path[i].z], c0 * 3);
    nor.set([t.x * sign, t.y * sign, t.z * sign], c0 * 3);
    uv.set([uOff + uSc * 0.5, s[i] * vSc], c0 * 2);
    for (let j = 0; j < m; j++) {
      const [px, py] = prof[j];
      p.copy(path[i]).addScaledVector(N[i], px * sx).addScaledVector(B[i], py * sy);
      const v = c0 + 1 + j;
      pos.set([p.x, p.y, p.z], v * 3);
      nor.set([t.x * sign, t.y * sign, t.z * sign], v * 3);
      uv.set([uOff + uSc * (j / m), s[i] * vSc], v * 2);
    }
    for (let j = 0; j < m; j++) {
      const a = c0 + 1 + j, b = c0 + 1 + ((j + 1) % m);
      if (flip) index.push(c0, b, a); else index.push(c0, a, b);
    }
    base += m + 1;
  };
  if (o.capStart) cap(0, true);
  if (o.capEnd) cap(n - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/** Straight cylinder between two points. */
export function rod(a: V3, b: V3, radius: number, radial: number, caps = true): THREE.BufferGeometry {
  return tube([a, b], { radius, radial, capStart: caps, capEnd: caps });
}

/** Catmull–Rom resampling of control points into a smooth polyline with `count` points. */
export function smoothPath(ctrl: readonly V3[], count: number, tension = 0.5): V3[] {
  const curve = new THREE.CatmullRomCurve3(ctrl.map((c) => c.clone()), false, 'centripetal', tension);
  return curve.getSpacedPoints(count - 1);
}

/** Polyline through corner points with each corner rounded by radius r (arcs of `segs` points). */
export function filletPath(pts: readonly V3[], r: number, segs: number): V3[] {
  const out: V3[] = [pts[0].clone()];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = _a.subVectors(pts[i - 1], pts[i]);
    const b = _b.subVectors(pts[i + 1], pts[i]);
    const la = a.length(), lb = b.length();
    a.normalize(); b.normalize();
    const d = Math.min(r, 0.45 * la, 0.45 * lb);
    const p0 = pts[i].clone().addScaledVector(a, d), p2 = pts[i].clone().addScaledVector(b, d);
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      out.push(new THREE.Vector3()
        .copy(p0).multiplyScalar((1 - t) * (1 - t))
        .addScaledVector(pts[i], 2 * t * (1 - t))
        .addScaledVector(p2, t * t));
    }
  }
  out.push(pts[pts.length - 1].clone());
  return out;
}

// --- Ropes -----------------------------------------------------------------------------------------

/** Braid pitch along a rope: one texture repeat per 6 radii (u wraps once round the rope). */
const ropeVScale = (radius: number) => 1 / (radius * 6);

/** Static rope along a smooth path, tinted with colourway `cell` (see ROPE). */
export function ropeGeometry(path: readonly V3[], radius: number, cell: number, radial: number): THREE.BufferGeometry {
  return tintRope(tube(path, { radius, radial, capStart: true, capEnd: true, vScale: ropeVScale(radius) }), cell);
}

/**
 * Fill `out[offset … offset+count-1]` with a span from a to b that sags by `sag` (m at mid-span)
 * along the unit gravity vector `g` (parabolic approximation of a light catenary).
 */
export function sagSpan(out: V3[], offset: number, count: number, a: V3, b: V3, sag: number, g: V3, includeFirst = true): void {
  const start = includeFirst ? 0 : 1;
  for (let k = start; k < count + start; k++) {
    const t = k / (count - 1 + start);
    const p = out[offset + k - start];
    p.lerpVectors(a, b, t).addScaledVector(g, 4 * sag * t * (1 - t));
  }
}

export interface RopeSpec { samples: number; radius: number; cell: number }

/** All animated ropes in one indexed mesh; paths are rewritten in place every pose. */
export class RopeSet {
  readonly mesh: THREE.Mesh;
  readonly specs: readonly RopeSpec[];
  private readonly base: number[] = [];
  private readonly radial: number;
  private readonly pos: THREE.BufferAttribute;
  private readonly nor: THREE.BufferAttribute;
  private readonly uv: THREE.BufferAttribute;
  private readonly N: V3[];
  private readonly B: V3[];
  private readonly T: V3[];

  constructor(material: THREE.Material, specs: readonly RopeSpec[], radial: number) {
    this.specs = specs;
    this.radial = radial;
    const ring = radial + 1;
    let verts = 0;
    const index: number[] = [];
    let maxSamples = 0;
    for (const sp of specs) {
      this.base.push(verts);
      for (let i = 0; i < sp.samples - 1; i++) {
        for (let j = 0; j < radial; j++) {
          const a = verts + i * ring + j, b = verts + (i + 1) * ring + j, c = b + 1, d = a + 1;
          index.push(a, d, b, d, c, b);
        }
      }
      verts += sp.samples * ring;
      maxSamples = Math.max(maxSamples, sp.samples);
    }
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.nor = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(verts * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('normal', this.nor);
    g.setAttribute('uv', this.uv);
    // Colours are fixed per rope.
    const col = new Float32Array(verts * 3), tra = new Float32Array(verts * 3);
    specs.forEach((sp, k) => {
      const [r, gg, b, tr, tg, tb] = ropeColours(sp.cell);
      const end = k + 1 < specs.length ? this.base[k + 1] : verts;
      for (let i = this.base[k]; i < end; i++) { col.set([r, gg, b], i * 3); tra.set([tr, tg, tb], i * 3); }
    });
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('tracer', new THREE.BufferAttribute(tra, 3));
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 12);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.N = Array.from({ length: maxSamples }, () => new THREE.Vector3());
    this.B = Array.from({ length: maxSamples }, () => new THREE.Vector3());
    this.T = Array.from({ length: maxSamples }, () => new THREE.Vector3());
  }

  /** Rewrite rope k along the first specs[k].samples points of `pts`. */
  setPath(k: number, pts: readonly V3[]): void {
    const sp = this.specs[k];
    const n = sp.samples;
    const N = this.N, B = this.B;
    rmFrames(pts, N, B, this.T, undefined, n);
    const ring = this.radial + 1;
    const p = this.pos.array as Float32Array, q = this.nor.array as Float32Array, uv = this.uv.array as Float32Array;
    const vs = ropeVScale(sp.radius);
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) s += pts[i].distanceTo(pts[i - 1]);
      for (let j = 0; j <= this.radial; j++) {
        const ang = (j / this.radial) * Math.PI * 2;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const nx = N[i].x * c + B[i].x * sn, ny = N[i].y * c + B[i].y * sn, nz = N[i].z * c + B[i].z * sn;
        const v = this.base[k] + i * ring + j;
        p[v * 3] = pts[i].x + nx * sp.radius; p[v * 3 + 1] = pts[i].y + ny * sp.radius; p[v * 3 + 2] = pts[i].z + nz * sp.radius;
        q[v * 3] = nx; q[v * 3 + 1] = ny; q[v * 3 + 2] = nz;
        uv[v * 2] = j / this.radial;
        uv[v * 2 + 1] = s * vs;
      }
    }
  }

  /** Collapse rope k to a point (invisible). */
  hide(k: number): void {
    const ring = this.radial + 1;
    const p = this.pos.array as Float32Array;
    const start = this.base[k] * 3, end = (this.base[k] + this.specs[k].samples * ring) * 3;
    p.fill(0, start, end);
  }

  commit(): void {
    this.pos.needsUpdate = true;
    this.nor.needsUpdate = true;
    this.uv.needsUpdate = true;
  }

  dispose(): void { this.mesh.geometry.dispose(); }
}
