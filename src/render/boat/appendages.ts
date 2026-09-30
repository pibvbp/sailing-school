// Keel and rudder (spec §6): NACA 0012 fin keel lofted from BOAT.keel with a fairing fillet into the
// canoe body and a rounded tip; balanced spade rudder from BOAT.rudder whose blade top follows the
// hull with a small gap. Geometry is DOM-free (used by the unit test for the keel draft).
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { keelH } from './hull';
import type { Part } from './materials';

const K = BOAT.keel;
const R = BOAT.rudder;

/** NACA 00xx half-thickness at chord fraction ξ (closed trailing edge). */
export function nacaHalfThickness(xi: number, tc: number): number {
  const x = Math.min(Math.max(xi, 0), 1);
  return 5 * tc * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
}

/** Chordwise stations with cosine clustering at the leading and trailing edges. */
function chordStations(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((Math.PI * i) / (n - 1)));
}

interface FoilRow {
  h: number;
  le: number;
  chord: number;
  thick: number;
  /** Optional height per chordwise point (x in the row's frame) instead of the constant h. */
  hOf?: (x: number) => number;
}

/**
 * Loft a symmetric foil from spanwise rows (h, leading-edge x, chord, thickness scale).
 * Local frame: X = thickness (starboard), Y = h, Z = −x. Rows go top → bottom.
 */
function loftFoil(rows: FoilRow[], chordwise: number, tc: number, tipCap: boolean): THREE.BufferGeometry {
  const xs = chordStations(chordwise);
  // Ring: upper TE → LE along starboard, then LE → TE along port (shared LE/TE points).
  const ring: Array<[number, number]> = [];
  for (let i = xs.length - 1; i >= 0; i--) ring.push([xs[i], 1]);
  for (let i = 1; i < xs.length - 1; i++) ring.push([xs[i], -1]);
  const nr = ring.length;
  const pos: number[] = [], index: number[] = [];
  for (const r of rows) {
    for (const [xi, side] of ring) {
      const x = r.le - xi * r.chord;
      const t = nacaHalfThickness(xi, tc) * r.chord * r.thick;
      pos.push(side * t, r.hOf ? r.hOf(x) : r.h, -x);
    }
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < nr; j++) {
      const a = i * nr + j, b = i * nr + ((j + 1) % nr), c = (i + 1) * nr + ((j + 1) % nr), d = (i + 1) * nr + j;
      index.push(a, d, b, b, d, c);
    }
  }
  if (tipCap) {
    // Close the bottom ring with a fan to its centroid.
    const last = rows.length - 1;
    const r = rows[last];
    const ci = pos.length / 3;
    pos.push(0, r.h, -(r.le - 0.45 * r.chord));
    for (let j = 0; j < nr; j++) index.push(last * nr + j, ci, last * nr + ((j + 1) % nr));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}

/** Keel rows: root inside the hull, a fairing fillet just below it, the swept fin, a rounded tip. */
function keelRows(spanRows: number): FoilRow[] {
  const rows: FoilRow[] = [];
  const sweep = Math.tan(K.sweepDeg * (Math.PI / 180));
  const span = K.rootH - K.tipH;
  const leAt = (h: number) => K.rootLEX - (K.rootH - h) * sweep;
  const chordAt = (h: number) => K.rootChord + (K.tipChord - K.rootChord) * ((K.rootH - h) / span);
  const filletDepth = 0.085;
  const row = (h: number, flare: number, thick = 1): FoilRow => ({
    h, le: leAt(Math.min(h, K.rootH)) + 0.07 * flare, chord: chordAt(Math.min(h, K.rootH)) + 0.15 * flare, thick: thick * (1 + 1.25 * flare),
  });
  // Inside the canoe body (hidden), then the fillet flaring into the hull surface.
  rows.push(row(K.rootH + 0.08, 1), row(K.rootH + 0.02, 1));
  for (let k = 0; k <= 4; k++) {
    const u = k / 4;
    rows.push(row(K.rootH - filletDepth * u, (1 - u) * (1 - u)));
  }
  for (let k = 1; k <= spanRows; k++) {
    const h = K.rootH - filletDepth - (span - filletDepth - 0.03) * (k / spanRows);
    rows.push(row(h, 0));
  }
  // Rounded tip: the last 3 cm close as a half-ellipse so the lowest point is exactly the keel draft.
  for (let k = 1; k <= 4; k++) {
    const a = (k / 4) * (Math.PI / 2);
    const h = K.tipH + 0.03 * (1 - Math.sin(a));
    const s = Math.max(0.05, Math.cos(a));
    const r = row(h, 0, s);
    r.le -= 0.02 * (1 - s);
    r.chord *= 0.9 + 0.1 * s;
    rows.push(r);
  }
  return rows;
}

export function buildKeelGeometry(chordwise = 24, spanRows = 14): THREE.BufferGeometry {
  return loftFoil(keelRows(spanRows), chordwise, K.tc, true);
}

export function buildKeel(chordwise = 24): Part[] {
  return [{ geometry: buildKeelGeometry(chordwise), mat: 'antifouling', shadow: true }];
}

/**
 * Rudder blade in the rudder group's frame (origin on the stock axis at the waterline): planform per
 * BOAT.rudder (stock at 25 % chord) with the blade continued up to 1.5 cm under the hull.
 */
export function buildRudderBlade(chordwise = 20): THREE.BufferGeometry {
  const span = R.rootH - R.tipH;
  const quarter = 0.25;
  const rows: FoilRow[] = [];
  // Above the spec root the blade continues up to 1.5 cm under the hull, following its buttock.
  const hullAt = (x: number) => Math.max(R.rootH, keelH(R.stockX + x) - 0.015);
  for (let k = 0; k <= 2; k++) {
    const u = k / 2;
    rows.push({ h: R.rootH, le: quarter * R.rootChord, chord: R.rootChord, thick: 1, hOf: (x) => hullAt(x) * (1 - u) + R.rootH * u });
  }
  for (let k = 1; k <= 10; k++) {
    const h = R.rootH - (span - 0.02) * (k / 10);
    const c = R.rootChord + (R.tipChord - R.rootChord) * ((R.rootH - h) / span);
    rows.push({ h, le: quarter * c, chord: c, thick: 1 });
  }
  for (let k = 1; k <= 3; k++) {
    const a = (k / 3) * (Math.PI / 2);
    const h = R.tipH + 0.02 * (1 - Math.sin(a));
    rows.push({ h, le: quarter * R.tipChord, chord: R.tipChord * (0.92 + 0.08 * Math.cos(a)), thick: Math.max(0.05, Math.cos(a)) });
  }
  return loftFoil(rows, chordwise, R.tc, true);
}
