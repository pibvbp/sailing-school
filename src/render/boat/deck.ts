// Deck plan layout (spec §6): cambered deck inside the sheer, the cabin-trunk footprint with a rounded
// front, the cockpit opening (open transom) and the cabin-top surface. Shared by the deck, cabin,
// cockpit, fittings and rope builders so every part sits exactly on the surfaces it touches.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { X_STEM, X_TRANSOM, deckHalfBeam, deckHalfBeamSlope, sheerH, sheerSlope } from './hull';
import type { BoatDetail, Part } from './materials';

const CAB = BOAT.cabin;
const CP = BOAT.cockpit;
const HALF_BEAM = BOAT.hull.beam / 2;
const CAMBER = BOAT.hull.deckCamber;

/** Plan-view UV rectangle shared by the deck-plan texture (textures.ts). */
export const PLAN_UV = { x0: X_TRANSOM - 0.05, x1: X_STEM + 0.05, y0: -1.36, y1: 1.36 };

export const planU = (x: number) => (x - PLAN_UV.x0) / (PLAN_UV.x1 - PLAN_UV.x0);
export const planV = (y: number) => (y - PLAN_UV.y0) / (PLAN_UV.y1 - PLAN_UV.y0);

/** Deck height: sheer plus a constant-radius camber (crown CAMBER at the widest station). */
export function deckH(x: number, y: number): number {
  const b = deckHalfBeam(x);
  return sheerH(x) + (CAMBER * (b * b - y * y)) / (HALF_BEAM * HALF_BEAM);
}

/** Outward unit normal of the deck in the boat-local frame. */
export function deckNormal(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
  const b = deckHalfBeam(x);
  const dhdx = sheerSlope(x) + (2 * CAMBER * b * deckHalfBeamSlope(x)) / (HALF_BEAM * HALF_BEAM);
  const dhdy = (-2 * CAMBER * y) / (HALF_BEAM * HALF_BEAM);
  // Plan gradient (x fwd, y stbd) → local (X = y, Y = h, Z = −x).
  return out.set(-dhdy, 1, dhdx).normalize();
}

// --- Cabin trunk -------------------------------------------------------------------------------

/** Length of the rounded cabin front in plan (superellipse, flat across the middle). */
export const CABIN_FRONT_ROUND = 0.24;
const CABIN_FRONT_EXP = 3;

/** Straight-sided cabin half-width (before the rounded front). */
function cabinSideHalfWidth(x: number): number {
  const t = (x - CAB.xAft) / (CAB.xFwd - CAB.xAft);
  return 0.5 * (CAB.widthAft + (CAB.widthFwd - CAB.widthAft) * t);
}

/** Cabin footprint half-width at deck level (0 forward of the cabin front). */
export function cabinHalfWidth(x: number): number {
  if (x < CAB.xAft || x > CAB.xFwd) return 0;
  const x0 = CAB.xFwd - CABIN_FRONT_ROUND;
  const w = cabinSideHalfWidth(x);
  if (x <= x0) return w;
  const u = Math.min(1, (x - x0) / CABIN_FRONT_ROUND);
  return w * Math.pow(Math.max(0, 1 - Math.pow(u, CABIN_FRONT_EXP)), 1 / CABIN_FRONT_EXP);
}

/** Cabin height above the sheer (spec: 0.40 aft → 0.30 forward). */
export function cabinHeight(x: number): number {
  const t = Math.min(1, Math.max(0, (x - CAB.xAft) / (CAB.xFwd - CAB.xAft)));
  return CAB.heightAft + (CAB.heightFwd - CAB.heightAft) * t;
}

/** Cabin-top crown, chosen so the top passes exactly through the mast base height. */
const CABIN_CROWN = BOAT.mast.baseH - sheerH(BOAT.mast.x) - cabinHeight(BOAT.mast.x);
const CABIN_CROWN_HALF = CAB.widthAft / 2;

/** Cabin-top height (a cambered surface over the whole footprint). */
export function cabinTopH(x: number, y: number): number {
  const r = y / CABIN_CROWN_HALF;
  return sheerH(x) + cabinHeight(x) + CABIN_CROWN * (1 - r * r);
}

export function cabinTopNormal(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 1e-3;
  const dhdx = (cabinTopH(x + e, y) - cabinTopH(x - e, y)) / (2 * e);
  const dhdy = (cabinTopH(x, y + e) - cabinTopH(x, y - e)) / (2 * e);
  return out.set(-dhdy, 1, dhdx).normalize();
}

/** Plan point on the cabin footprint boundary with its outward plan normal (starboard side). */
export interface BoundaryPoint { x: number; y: number; nx: number; ny: number; s: number }

/** Starboard cabin boundary from the aft end to the front tip, uniformly spaced along its arc. */
export function cabinBoundary(count: number): BoundaryPoint[] {
  const dense: Array<{ x: number; y: number }> = [];
  const x0 = CAB.xFwd - CABIN_FRONT_ROUND;
  const nSide = 400, nFront = 1200;
  for (let i = 0; i <= nSide; i++) {
    const x = CAB.xAft + (x0 - CAB.xAft) * (i / nSide);
    dense.push({ x, y: cabinHalfWidth(x) });
  }
  for (let i = 1; i <= nFront; i++) {
    // Cluster samples near the tip where the half-width collapses quickly.
    const u = 1 - Math.pow(1 - i / nFront, 3);
    const x = x0 + CABIN_FRONT_ROUND * u;
    dense.push({ x, y: cabinHalfWidth(x) });
  }
  dense[dense.length - 1] = { x: CAB.xFwd, y: 0 };
  const s = [0];
  for (let i = 1; i < dense.length; i++) s.push(s[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
  const total = s[s.length - 1];
  const out: BoundaryPoint[] = [];
  let j = 1;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (j < dense.length - 1 && s[j] < target) j++;
    const t = Math.min(1, Math.max(0, (target - s[j - 1]) / Math.max(1e-12, s[j] - s[j - 1])));
    const x = dense[j - 1].x + (dense[j].x - dense[j - 1].x) * t;
    const y = dense[j - 1].y + (dense[j].y - dense[j - 1].y) * t;
    // Tangent from neighbouring dense samples → outward normal (to starboard / forward).
    const a = dense[Math.max(0, j - 2)], b = dense[Math.min(dense.length - 1, j + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    out.push({ x, y, nx: -ty, ny: tx, s: target });
  }
  // The front tip normal points straight forward; the aft end straight to starboard.
  out[count - 1] = { x: CAB.xFwd, y: 0, nx: 1, ny: 0, s: total };
  out[0].nx = 0; out[0].ny = 1;
  return out;
}

// --- Cockpit -------------------------------------------------------------------------------------

/** Cockpit layout: well from the cabin to an open transom; seats outboard of a central footwell. */
export const COCKPIT = {
  xFwd: CP.xFwd,
  xSeatAft: CP.xAft,
  halfWidth: CP.width / 2,
  footwellHalf: 0.45,
  soleH: CP.soleH,
  seatH: CP.seatH,
};

/** Half-width of the opening in the deck (cockpit aft of the cabin, cabin trunk, 0 forward). */
export function holeHalfWidth(x: number): number {
  if (x < COCKPIT.xFwd) return COCKPIT.halfWidth;
  return cabinHalfWidth(x);
}

/**
 * Height of the top-most boat surface at plan point (x, y): deck, cabin top, cockpit seat or sole.
 * Used to drape slack ropes. Returns −∞ outside the boat.
 */
export function topSurfaceH(x: number, y: number): number {
  if (x < X_TRANSOM || x > X_STEM) return -Infinity;
  const ay = Math.abs(y);
  if (ay > deckHalfBeam(x)) return -Infinity;
  if (x >= CAB.xAft && ay < cabinHalfWidth(x)) return cabinTopH(x, y);
  if (x < COCKPIT.xFwd && ay < COCKPIT.halfWidth) return ay < COCKPIT.footwellHalf ? COCKPIT.soleH : COCKPIT.seatH;
  return deckH(x, y);
}

// --- Deck mesh -----------------------------------------------------------------------------------

interface DeckStation { x: number; yIn: number }

function deckStations(detail: BoatDetail): DeckStation[] {
  const st: DeckStation[] = [];
  const nCockpit = Math.round(22 * detail.deck);
  for (let i = 0; i <= nCockpit; i++) {
    const x = X_TRANSOM + (COCKPIT.xFwd - X_TRANSOM) * (i / nCockpit);
    st.push({ x, yIn: COCKPIT.halfWidth });
  }
  for (const b of cabinBoundary(Math.round(60 * detail.deck))) st.push({ x: b.x, yIn: b.y });
  const nFore = Math.round(34 * detail.deck);
  for (let i = 1; i <= nFore; i++) {
    const u = i / nFore;
    const x = CAB.xFwd + (X_STEM - CAB.xFwd) * (1 - Math.pow(1 - u, 1.6));
    st.push({ x, yIn: 0 });
  }
  return st;
}

/** One side of the deck: transverse rows from the opening (or centreline) out to the sheer. */
function deckSide(stations: DeckStation[], lateral: number, side: 1 | -1): THREE.BufferGeometry {
  const rows = stations.length;
  const pos = new Float32Array(rows * lateral * 3);
  const nor = new Float32Array(rows * lateral * 3);
  const uv = new Float32Array(rows * lateral * 2);
  const n = new THREE.Vector3();
  for (let i = 0; i < rows; i++) {
    const { x, yIn } = stations[i];
    const yOut = deckHalfBeam(x);
    for (let j = 0; j < lateral; j++) {
      const t = 0.5 - 0.5 * Math.cos((Math.PI * j) / (lateral - 1));
      const y = Math.min(yOut, yIn + (yOut - yIn) * t);
      const v = i * lateral + j;
      const ys = side * y;
      pos[v * 3] = ys; pos[v * 3 + 1] = deckH(x, ys); pos[v * 3 + 2] = -x;
      deckNormal(x, ys, n);
      nor[v * 3] = n.x; nor[v * 3 + 1] = n.y; nor[v * 3 + 2] = n.z;
      uv[v * 2] = planU(x); uv[v * 2 + 1] = planV(ys);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < lateral - 1; j++) {
      const a = i * lateral + j, b = (i + 1) * lateral + j, c = (i + 1) * lateral + j + 1, d = i * lateral + j + 1;
      if (side > 0) index.push(a, c, b, a, d, c);
      else index.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

export function buildDeck(detail: BoatDetail): Part[] {
  const stations = deckStations(detail);
  const lateral = Math.max(6, Math.round(12 * detail.deck));
  return [
    { geometry: deckSide(stations, lateral, 1), mat: 'deck', shadow: true },
    { geometry: deckSide(stations, lateral, -1), mat: 'deck', shadow: true },
  ];
}
