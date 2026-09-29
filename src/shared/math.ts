// Small allocation-light vector helpers shared by the simulation and the renderer.
// Pure functions on plain objects so `src/sim` stays independent of three.js.

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

export const DEG = Math.PI / 180;
/** Metres per second in one knot. */
export const KN = 0.514444;

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
};
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/** Right-handed rotation about the x axis. Body → heading frame uses +heel. */
export const rotX = (v: Vec3, a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
};

/** Right-handed rotation about the z axis. In the body frame (z down) +a turns forward toward starboard. */
export const rotZ = (v: Vec3, a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
};

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Wrap an angle into (−π, π]. */
export const wrapPi = (a: number): number => {
  const twoPi = 2 * Math.PI;
  let r = (a + Math.PI) % twoPi;
  if (r <= 0) r += twoPi;
  return r - Math.PI;
};

/** Signed smallest difference a − b wrapped into (−π, π]. */
export const angleDiff = (a: number, b: number): number => wrapPi(a - b);

/** Piecewise-linear interpolation in a sorted [x, y] table (clamped at both ends). */
export function interpTable(table: ReadonlyArray<readonly [number, number]>, x: number): number {
  const n = table.length;
  if (n === 0) return 0;
  const first = table[0]!;
  const last = table[n - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid]![0] <= x) lo = mid; else hi = mid;
  }
  const a = table[lo]!, b = table[hi]!;
  return a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
}
