// Regenerates src/sim/data/polars.json by sailing the simulated boat to steady state at every
// wind speed and angle (see src/sim/vpp.ts). Run with: pnpm polars
import { writeFileSync } from 'node:fs';
import { bestSpeed } from '../src/sim/vpp';
import type { PolarTable, PolarPoint } from '../src/sim/polarTable';
import { DEG, KN } from '../src/shared/math';

const TWS = [4, 6, 8, 10, 12, 14, 16, 20, 25];
const TWA = Array.from({ length: 31 }, (_, i) => 30 + i * 5);

const speed: number[][] = [];
const sails: ('jib' | 'spinnaker')[][] = [];
const beat: PolarPoint[] = [];
const run: PolarPoint[] = [];
const unconverged: Array<[number, number]> = [];
const t0 = Date.now();

/** Refine an optimum with a parabola through the best sample and its neighbours. */
function refine(xs: number[], ys: number[], i: number): { x: number; y: number } {
  if (i <= 0 || i >= xs.length - 1) return { x: xs[i]!, y: ys[i]! };
  const [x0, x1, x2] = [xs[i - 1]!, xs[i]!, xs[i + 1]!];
  const [y0, y1, y2] = [ys[i - 1]!, ys[i]!, ys[i + 1]!];
  const denom = (x0 - x1) * (x0 - x2) * (x1 - x2);
  const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / denom;
  const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / denom;
  if (a >= 0) return { x: x1, y: y1 };
  const x = -b / (2 * a);
  return { x, y: a * x * x + b * x + (y1 - a * x1 * x1 - b * x1) };
}

for (const tws of TWS) {
  const row: number[] = [];
  const rowSails: ('jib' | 'spinnaker')[] = [];
  for (const twa of TWA) {
    const r = bestSpeed(tws * KN, twa * DEG);
    row.push(Number((r.speed / KN).toFixed(3)));
    rowSails.push(r.sails);
    // bestSpeed already retried it for twice as long; what is left is flagged, not silently trusted (M7).
    if (!r.converged) unconverged.push([tws, twa]);
  }
  speed.push(row);
  sails.push(rowSails);
  const vmg = row.map((s, j) => s * Math.cos(TWA[j]! * DEG));
  const up = vmg.indexOf(Math.max(...vmg));
  const down = vmg.indexOf(Math.min(...vmg));
  const u = refine(TWA, vmg, up);
  const d = refine(TWA, vmg.map((v) => -v), down);
  const spd = (x: number) => { const j = Math.min(TWA.length - 2, Math.max(0, Math.floor((x - 30) / 5))); const t = (x - TWA[j]!) / 5; return row[j]! * (1 - t) + row[j + 1]! * t; };
  beat.push({ twa: Number(u.x.toFixed(1)), vmg: Number(u.y.toFixed(3)), speed: Number(spd(u.x).toFixed(3)) });
  run.push({ twa: Number(d.x.toFixed(1)), vmg: Number((-d.y).toFixed(3)), speed: Number(spd(d.x).toFixed(3)) });
  console.log(`TWS ${tws} kn: beat ${beat.at(-1)!.speed} kn @ ${beat.at(-1)!.twa}° (VMG ${beat.at(-1)!.vmg}) · run ${run.at(-1)!.speed} kn @ ${run.at(-1)!.twa}° (VMG ${run.at(-1)!.vmg}) · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const table: PolarTable = { tws: TWS, twa: TWA, speed, sails, beat, run, ...(unconverged.length ? { unconverged } : {}) };
writeFileSync(new URL('../src/sim/data/polars.json', import.meta.url), JSON.stringify(table, null, 1) + '\n');
if (unconverged.length) console.warn(`did not settle on the angle (averaged, flagged in the table): ${unconverged.map(([s, a]) => `${s} kn/${a}°`).join(', ')}`);
console.log('wrote src/sim/data/polars.json');
