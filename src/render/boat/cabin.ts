// Cabin trunk (spec §6): walls swept along the footprint (inward tilt, radiused into the cambered top),
// aft face with the companionway and recessed smoked washboard, tapered smoked windows, sliding hatch
// with its garage and runners, fore hatch, teak handrails and the mast step.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { cabinBoundary, cabinTopH, cabinTopNormal, deckH, planU, planV, type BoundaryPoint } from './deck';
import { lathe, loc, planarFace, place, roundedBox, v3 } from './fittings';
import { planUV } from './cockpit';
import { tube } from './lines';
import type { BuildContext, Part } from './materials';

type V3 = THREE.Vector3;
const CAB = BOAT.cabin;
const TILT = 13 * (Math.PI / 180);
const FILLET = 0.035;

/** Wall section at one boundary station: bottom on the deck, straight tilted wall, fillet onto the top. */
interface WallSection {
  b: BoundaryPoint;
  /** Plan + height points (x, y, h) from the deck up and over onto the top. */
  pts: Array<{ x: number; y: number; h: number }>;
  /** Top of the straight part (start of the fillet). */
  f1: { x: number; y: number; h: number };
  /** Outward wall normal (spec coordinates). */
  n: { x: number; y: number; h: number };
}

function wallSection(b: BoundaryPoint, filletPts: number): WallSection {
  const dx = -b.nx, dy = -b.ny; // inward plan direction
  const sT = Math.sin(TILT), cT = Math.cos(TILT);
  const bh = deckH(b.x, b.y);
  // Where the tilted wall meets the cabin top.
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) {
    const t = 0.5 * (lo + hi);
    const h = bh + t * cT;
    if (h < cabinTopH(b.x + t * sT * dx, b.y + t * sT * dy)) lo = t; else hi = t;
  }
  const t = 0.5 * (lo + hi);
  const T = { x: b.x + t * sT * dx, y: b.y + t * sT * dy, h: bh + t * cT };
  // Inward direction along the top surface at T.
  const e = 0.01;
  const slope = (cabinTopH(T.x + e * dx, T.y + e * dy) - cabinTopH(T.x, T.y)) / e;
  const el = Math.hypot(1, slope);
  const E = { x: dx / el, y: dy / el, h: slope / el };
  const D = { x: sT * dx, y: sT * dy, h: cT };
  const turn = Math.acos(Math.min(1, D.x * E.x + D.y * E.y + D.h * E.h));
  const d = FILLET * Math.tan(turn / 2);
  const f1 = { x: T.x - d * D.x, y: T.y - d * D.y, h: T.h - d * D.h };
  const f2 = { x: T.x + d * E.x, y: T.y + d * E.y, h: T.h + d * E.h };
  const pts = [{ x: b.x, y: b.y, h: bh }];
  for (let k = 0; k <= filletPts; k++) {
    const u = k / filletPts;
    const a = (1 - u) * (1 - u), c = 2 * u * (1 - u), w = u * u;
    pts.push({ x: a * f1.x + c * T.x + w * f2.x, y: a * f1.y + c * T.y + w * f2.y, h: a * f1.h + c * T.h + w * f2.h });
  }
  // Snap the last point onto the top surface exactly.
  const last = pts[pts.length - 1];
  last.h = cabinTopH(last.x, last.y);
  const n = { x: b.nx * cT, y: b.ny * cT, h: sT };
  return { b, pts, f1, n };
}

export function buildCabin(ctx: BuildContext): Part[] {
  const parts: Part[] = [];
  const count = Math.max(24, Math.round(60 * ctx.detail.deck));
  const boundary = cabinBoundary(count);
  const sections = boundary.map((b) => wallSection(b, 5));

  // Walls: starboard as computed, port mirrored; plan UVs (the texture keeps a smooth band there).
  for (const side of [1, -1] as const) {
    const rows = sections.map((s) => s.pts.map((p) => loc(p.x, side * p.y, p.h)));
    const nc = rows[0].length;
    const pos: number[] = [], uv: number[] = [], index: number[] = [];
    rows.forEach((row) => row.forEach((p) => { pos.push(p.x, p.y, p.z); uv.push(planU(-p.z), planV(p.x)); }));
    for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < nc - 1; j++) {
      const a = i * nc + j, b = (i + 1) * nc + j, c = (i + 1) * nc + j + 1, d = i * nc + j + 1;
      if (side > 0) index.push(a, b, c, a, c, d); else index.push(a, c, b, a, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeVertexNormals();
    // Blend the last column into the top's normal so the fillet runs smoothly onto the cap.
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const tn = new THREE.Vector3();
    rows.forEach((row, i) => {
      const p = row[nc - 1];
      cabinTopNormal(-p.z, p.x, tn);
      nor.setXYZ(i * nc + nc - 1, tn.x, tn.y, tn.z);
    });
    parts.push({ geometry: g, mat: 'deck', shadow: true });
  }

  // Cabin top: transverse rows between the port and starboard fillet edges.
  const lateral = Math.max(8, Math.round(16 * ctx.detail.deck));
  {
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], index: number[] = [];
    const tn = new THREE.Vector3();
    sections.forEach((s) => {
      const e = s.pts[s.pts.length - 1];
      for (let j = 0; j < lateral; j++) {
        const y = -e.y + (2 * e.y * j) / (lateral - 1);
        const p = loc(e.x, y, cabinTopH(e.x, y));
        cabinTopNormal(e.x, y, tn);
        pos.push(p.x, p.y, p.z); nor.push(tn.x, tn.y, tn.z); uv.push(planU(e.x), planV(y));
      }
    });
    for (let i = 0; i < sections.length - 1; i++) for (let j = 0; j < lateral - 1; j++) {
      const a = i * lateral + j, b = (i + 1) * lateral + j, c = (i + 1) * lateral + j + 1, d = i * lateral + j + 1;
      index.push(a, c, b, a, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    parts.push({ geometry: g, mat: 'deck', shadow: true });
  }

  // Aft face at the cabin's aft end with the companionway opening.
  const aft = sections[0];
  const xa = CAB.xAft;
  const contour: V3[] = [];
  aft.pts.forEach((p) => contour.push(loc(p.x, -p.y, p.h)));
  const ye = aft.pts[aft.pts.length - 1].y;
  for (let j = 1; j < lateral - 1; j++) {
    const y = -ye + (2 * ye * j) / (lateral - 1);
    contour.push(loc(xa, y, cabinTopH(xa, y)));
  }
  aft.pts.slice().reverse().forEach((p) => contour.push(loc(p.x, p.y, p.h)));
  for (let j = 1; j < 9; j++) {
    const y = aft.b.y - (2 * aft.b.y * j) / 9;
    contour.push(loc(xa, y, deckH(xa, y)));
  }
  const cw = 0.28;
  const sill = deckH(xa, 0) + 0.035;
  const lintel = cabinTopH(xa, 0) - 0.05;
  const hole = [loc(xa, -cw, sill), loc(xa, cw, sill), loc(xa, cw * 0.93, lintel), loc(xa, -cw * 0.93, lintel)];
  parts.push({
    geometry: planarFace(contour, [hole], v3(0, 0, 1), (p) => new THREE.Vector2(p.x, p.y), (p) => [planU(xa), planV(p.x)]),
    mat: 'deck', shadow: true,
  });
  // Jambs of the companionway (recess 3 cm) and the smoked washboard.
  const depth = 0.03;
  for (let k = 0; k < 4; k++) {
    const a = hole[k], b = hole[(k + 1) % 4];
    const a2 = a.clone().add(v3(0, 0, -depth)), b2 = b.clone().add(v3(0, 0, -depth));
    const nrm = new THREE.Vector3().subVectors(b, a).cross(v3(0, 0, -1)).normalize().negate();
    parts.push({
      geometry: planarFace([a, b, b2, a2], [], nrm, (p) => {
        const u = new THREE.Vector3().subVectors(b, a).normalize();
        return new THREE.Vector2(p.clone().sub(a).dot(u), p.z);
      }, (p) => [planU(-p.z), planV(p.x)]),
      mat: 'deck', shadow: false,
    });
  }
  const board = planarFace(hole.map((p) => p.clone().add(v3(0, 0, -depth))), [], v3(0, 0, 1), (p) => new THREE.Vector2(p.x, p.y), (p) => [p.x, p.y]);
  parts.push({ geometry: board, mat: 'glass' });
  // Washboard divider line and a small teak sill.
  const sillBar = roundedBox(2 * cw + 0.04, 0.02, 0.05, 0.006);
  parts.push({ geometry: place(sillBar, loc(xa - 0.0, 0, sill - 0.012)), mat: 'wood', shadow: true });
  const divider = roundedBox(2 * cw * 0.96, 0.006, 0.006, 0.002);
  parts.push({ geometry: place(divider, v3(0, 0.5 * (sill + lintel), -xa - depth + 0.003)), mat: 'plastic' });

  // Windows: tapered, round-ended smoked panes on each side wall.
  for (const side of [1, -1] as const) parts.push({ geometry: windowPane(sections, side), mat: 'glass' });

  // Sliding hatch (smoked acrylic on aluminium runners) and its garage.
  const hatchAft = xa - 0.015, hatchFwd = -0.66, hatchHalf = 0.31, lift = 0.028;
  {
    const nx = 10, ny = 8;
    const rows: V3[][] = [];
    for (let i = 0; i <= nx; i++) {
      const x = hatchAft + ((hatchFwd - hatchAft) * i) / nx;
      const row: V3[] = [];
      for (let j = 0; j <= ny; j++) {
        const y = -hatchHalf + (2 * hatchHalf * j) / ny;
        row.push(loc(x, y, cabinTopH(Math.max(x, xa), y) + lift));
      }
      rows.push(row);
    }
    const g = gridUp(rows);
    parts.push({ geometry: g, mat: 'glass', shadow: true });
    // Edges of the slide (thin smoked sides) and runners.
    for (const s of [1, -1]) {
      const path = [];
      for (let i = 0; i <= 8; i++) {
        const x = hatchAft + ((hatchFwd - 0.12 - hatchAft) * i) / 8;
        path.push(loc(x, s * (hatchHalf + 0.018), cabinTopH(Math.max(x, xa), s * (hatchHalf + 0.018)) + 0.012));
      }
      parts.push({ geometry: tube(path, { radius: 0.011, radial: 6, capStart: true, capEnd: true }), mat: 'aluminium', shadow: true });
      const edge = [];
      for (let i = 0; i <= 8; i++) {
        const x = hatchAft + ((hatchFwd - hatchAft) * i) / 8;
        edge.push(loc(x, s * hatchHalf, cabinTopH(Math.max(x, xa), s * hatchHalf) + lift * 0.5));
      }
      parts.push({ geometry: tube(edge, { radius: lift * 0.5, radial: 6 }), mat: 'glass' });
    }
    // Aft edge lip with a handle.
    const lip = tube([loc(hatchAft, -hatchHalf, cabinTopH(xa, -hatchHalf) + lift * 0.5), loc(hatchAft, hatchHalf, cabinTopH(xa, hatchHalf) + lift * 0.5)], { radius: lift * 0.5, radial: 6 });
    parts.push({ geometry: lip, mat: 'glass' });
    const handle = tube([loc(hatchAft + 0.05, -0.07, cabinTopH(xa, 0) + lift), loc(hatchAft + 0.035, -0.06, cabinTopH(xa, 0) + lift + 0.025), loc(hatchAft + 0.035, 0.06, cabinTopH(xa, 0) + lift + 0.025), loc(hatchAft + 0.05, 0.07, cabinTopH(xa, 0) + lift)], { radius: 0.006, radial: 6 });
    parts.push({ geometry: handle, mat: 'polished', shadow: true });
    // Garage (sea hood) over the forward end of the slide.
    const gar: V3[][] = [];
    const gx0 = hatchFwd - 0.04, gx1 = hatchFwd + 0.2, gHalf = hatchHalf + 0.06;
    for (let i = 0; i <= 6; i++) {
      const x = gx0 + ((gx1 - gx0) * i) / 6;
      const row: V3[] = [];
      for (let j = 0; j <= 12; j++) {
        const u = -1 + (2 * j) / 12;
        const y = u * gHalf;
        const bump = 0.062 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), 6)), 0.35) * Math.pow(Math.sin((Math.PI * i) / 6), 0.3);
        row.push(loc(x, y, cabinTopH(x, y) + bump));
      }
      gar.push(row);
    }
    const garage = gridUp(gar);
    planUV(garage);
    parts.push({ geometry: garage, mat: 'deck', shadow: true });
    ctx.pads.push([[xa - 0.02, -gHalf - 0.03], [gx1 + 0.03, -gHalf - 0.03], [gx1 + 0.03, gHalf + 0.03], [xa - 0.02, gHalf + 0.03]]);
  }

  // Fore hatch: low aluminium frame with a smoked lens, hinged forward.
  {
    const hx = 1.62, hHalf = 0.235;
    const topH = cabinTopH(hx, 0);
    const frame = roundedBox(2 * hHalf, 0.04, 2 * hHalf, 0.045);
    parts.push({ geometry: place(frame, loc(hx, 0, topH + 0.012)), mat: 'aluminium', shadow: true });
    const lens = roundedBox(2 * hHalf - 0.05, 0.01, 2 * hHalf - 0.05, 0.03);
    parts.push({ geometry: place(lens, loc(hx, 0, topH + 0.034)), mat: 'glass' });
    for (const s of [1, -1]) {
      const hinge = roundedBox(0.05, 0.022, 0.03, 0.006);
      parts.push({ geometry: place(hinge, loc(hx + hHalf + 0.005, s * 0.13, topH + 0.02)), mat: 'darkMetal' });
      const latch = roundedBox(0.035, 0.012, 0.018, 0.004);
      parts.push({ geometry: place(latch, loc(hx - hHalf + 0.03, s * 0.11, topH + 0.04)), mat: 'black' });
    }
    ctx.pads.push([[hx - hHalf - 0.04, -hHalf - 0.04], [hx + hHalf + 0.04, -hHalf - 0.04], [hx + hHalf + 0.04, hHalf + 0.04], [hx - hHalf - 0.04, hHalf + 0.04]]);
  }

  // Teak handrails on the cabin top: a bar on four feet each side.
  for (const s of [1, -1]) {
    const x0 = -1.02, x1 = 0.62;
    const yOf = (x: number) => s * (edgeHalfWidth(sections, x) - 0.095);
    const rail: V3[] = [];
    for (let i = 0; i <= 16; i++) {
      const x = x0 + ((x1 - x0) * i) / 16;
      rail.push(loc(x, yOf(x), cabinTopH(x, yOf(x)) + 0.062));
    }
    const profile: Array<[number, number]> = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      profile.push([Math.sign(c) * Math.pow(Math.abs(c), 0.6), Math.sign(sn) * Math.pow(Math.abs(sn), 0.6)]);
    }
    parts.push({
      geometry: tube(rail, { radius: 1, radial: 12, profile, profileScale: () => [0.016, 0.012], seedNormal: v3(0, 1, 0), capStart: true, capEnd: true, vScale: 2 }),
      mat: 'wood', shadow: true,
    });
    for (const x of [x0 + 0.06, -0.47, 0.07, x1 - 0.06]) {
      const y = yOf(x);
      const foot = roundedBox(0.075, 0.07, 0.024, 0.008);
      parts.push({ geometry: place(foot, loc(x, y, cabinTopH(x, y) + 0.03)), mat: 'wood', shadow: true });
      ctx.pads.push([[x - 0.06, y - 0.03], [x + 0.06, y - 0.03], [x + 0.06, y + 0.03], [x - 0.06, y + 0.03]]);
    }
  }

  // Mast step casting on the cabin top.
  {
    const mx = BOAT.mast.x, h = cabinTopH(mx, 0);
    const base = roundedBox(0.26, 0.022, 0.16, 0.03);
    parts.push({ geometry: place(base, loc(mx, 0, h + 0.006)), mat: 'darkMetal', shadow: true });
    const collar = lathe([[0, 0], [0.075, 0], [0.078, 0.012], [0.07, 0.03], [0, 0.03]], ctx.detail.lathe);
    collar.scale(1, 1, 0.66);
    parts.push({ geometry: place(collar, loc(mx, 0, h + 0.012)), mat: 'darkMetal', shadow: true });
    ctx.pads.push([[mx - 0.2, -0.13], [mx + 0.16, -0.13], [mx + 0.16, 0.13], [mx - 0.2, 0.13]]);
  }
  return parts;
}

/** Half-width of the cabin top between the fillet edges at station x (interpolated). */
export function edgeHalfWidth(sections: WallSection[], x: number): number {
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i].pts[sections[i].pts.length - 1], b = sections[i + 1].pts[sections[i + 1].pts.length - 1];
    if (x >= a.x && x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / Math.max(1e-9, b.x - a.x);
  }
  return 0;
}

/** Grid of points facing up (rows along x forward, columns port → starboard). */
function gridUp(rows: V3[][]): THREE.BufferGeometry {
  const nr = rows.length, nc = rows[0].length;
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  rows.forEach((row) => row.forEach((p) => { pos.push(p.x, p.y, p.z); uv.push(planU(-p.z), planV(p.x)); }));
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nc - 1; j++) {
    const a = i * nc + j, b = (i + 1) * nc + j, c = (i + 1) * nc + j + 1, d = i * nc + j + 1;
    index.push(a, c, b, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** One cabin-side window: a round-ended taper in the wall's (arc, height) parameter space. */
function windowPane(sections: WallSection[], side: 1 | -1): THREE.BufferGeometry {
  const xA = -0.98, xF = 1.5;
  // Parameter along the wall by x (side part only, well aft of the rounded front).
  const at = (x: number, v: number, off: number): V3 => {
    let i = 0;
    while (i < sections.length - 2 && sections[i + 1].b.x < x) i++;
    const a = sections[i], b = sections[i + 1];
    const t = (x - a.b.x) / Math.max(1e-9, b.b.x - a.b.x);
    const lerp = (p: { x: number; y: number; h: number }, q: { x: number; y: number; h: number }) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, h: p.h + (q.h - p.h) * t });
    const bottom = lerp(a.pts[0], b.pts[0]);
    const top = lerp(a.f1, b.f1);
    const n = lerp(a.n, b.n);
    return loc(bottom.x + (top.x - bottom.x) * v + n.x * off, side * (bottom.y + (top.y - bottom.y) * v + n.y * off), bottom.h + (top.h - bottom.h) * v + n.h * off);
  };
  // Outline: lower edge straight, upper edge tapering; semicircular-ish ends in (x, v).
  const outline: Array<[number, number]> = [];
  const vLo = (x: number) => 0.3 + 0.07 * ((x - xA) / (xF - xA));
  const vHi = (x: number) => 0.8 - 0.12 * ((x - xA) / (xF - xA));
  const n = 28, capN = 10;
  for (let k = 0; k <= n; k++) { const x = xA + 0.09 + ((xF - xA - 0.16) * k) / n; outline.push([x, vLo(x)]); }
  for (let k = 1; k < capN; k++) {
    const a = -Math.PI / 2 + (Math.PI * k) / capN;
    const x0 = xF - 0.07, mid = 0.5 * (vLo(x0) + vHi(x0)), half = 0.5 * (vHi(x0) - vLo(x0));
    outline.push([x0 + 0.07 * Math.cos(a), mid + half * Math.sin(a)]);
  }
  for (let k = n; k >= 0; k--) { const x = xA + 0.09 + ((xF - xA - 0.16) * k) / n; outline.push([x, vHi(x)]); }
  for (let k = 1; k < capN; k++) {
    const a = Math.PI / 2 + (Math.PI * k) / capN;
    const x0 = xA + 0.09, mid = 0.5 * (vLo(x0) + vHi(x0)), half = 0.5 * (vHi(x0) - vLo(x0));
    outline.push([x0 + 0.09 * Math.cos(a), mid + half * Math.sin(a)]);
  }
  const pts = outline.map(([x, v]) => at(x, v, 0.003));
  const tris = THREE.ShapeUtils.triangulateShape(outline.map(([x, v]) => new THREE.Vector2(x, v)), []);
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  pts.forEach((p, i) => { pos.push(p.x, p.y, p.z); uv.push(outline[i][0], outline[i][1]); });
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const [a, b, c] of tris) {
    e1.subVectors(pts[b], pts[a]); e2.subVectors(pts[c], pts[a]);
    if (e1.cross(e2).x * side >= 0) index.push(a, b, c); else index.push(a, c, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
