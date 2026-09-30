// Polar table lookups (knots / degrees, as stored in data/polars.json).
export interface PolarPoint { twa: number; speed: number; vmg: number }
export interface PolarTable {
  /** True wind speeds (kn). */
  tws: number[];
  /** True wind angles (deg, 0–180). */
  twa: number[];
  /** Boat speed (kn): speed[twsIndex][twaIndex]. */
  speed: number[][];
  /** Sail set used at each point. */
  sails: ('jib' | 'spinnaker')[][];
  /** Best upwind / downwind VMG per wind speed (refined between grid angles with a parabola). */
  beat: PolarPoint[];
  run: PolarPoint[];
  /** Grid points (TWS kn, TWA deg) whose steady run never settled on the angle: averaged values, use with care. */
  unconverged?: Array<[number, number]>;
}

function bracket(xs: readonly number[], x: number): [number, number, number] {
  if (x <= xs[0]!) return [0, 0, 0];
  const n = xs.length;
  if (x >= xs[n - 1]!) return [n - 1, n - 1, 0];
  let i = 0;
  while (xs[i + 1]! < x) i++;
  return [i, i + 1, (x - xs[i]!) / (xs[i + 1]! - xs[i]!)];
}

/** Target boat speed (kn) by bilinear interpolation. */
export function targetSpeed(t: PolarTable, twsKn: number, twaAbsDeg: number): number {
  const [a, b, u] = bracket(t.tws, twsKn);
  const [c, d, v] = bracket(t.twa, Math.min(180, Math.abs(twaAbsDeg)));
  const s = (i: number, j: number) => t.speed[i]![j]!;
  return (1 - u) * ((1 - v) * s(a, c) + v * s(a, d)) + u * ((1 - v) * s(b, c) + v * s(b, d));
}

/** Optimal VMG angle and value (kn) for a wind speed. */
export function optimalVmg(t: PolarTable, twsKn: number, upwind: boolean): PolarPoint {
  const rows = upwind ? t.beat : t.run;
  const [a, b, u] = bracket(t.tws, twsKn);
  const A = rows[a]!, B = rows[b]!;
  return { twa: A.twa + (B.twa - A.twa) * u, speed: A.speed + (B.speed - A.speed) * u, vmg: A.vmg + (B.vmg - A.vmg) * u };
}
