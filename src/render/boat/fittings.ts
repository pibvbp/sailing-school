// Deck hardware (spec §9.5 + hero-asset detail): stanchions with bases, lifelines with pelican hooks,
// welded bow pulpit and quarter pushpits, self-tailing winches with handles, horn and cam cleats,
// blocks with sheaves and shackles, clutches and deck organisers, jib-lead tracks with cars, the
// traveller with car, end stops and control lines, chainplates, rub rail, bow fitting.
// The top of the file holds the small geometry primitives shared by the other builders.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { COCKPIT, cabinTopH, deckH } from './deck';
import { X_STEM, X_TRANSOM, deckHalfBeam, sheerH, topsideNormal } from './hull';
import { ROPE, ropeGeometry, rod, smoothPath, tube } from './lines';
import type { BuildContext, MatKey, Part } from './materials';

type V3 = THREE.Vector3;
export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Spec coordinates (x fwd, y stbd, h up) → boat-local vector. */
export const loc = (x: number, y: number, h: number) => new THREE.Vector3(y, h, -x);

// --- Primitives ------------------------------------------------------------------------------------

/** Lathe around local +Y from an (r, y) profile; `segments` around. UV: u around, v along profile. */
export function lathe(profile: ReadonlyArray<readonly [number, number]>, segments: number, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y));
  const g = new THREE.LatheGeometry(pts, segments, 0, phiLength);
  return g;
}

/** Box with rounded vertical edges and chamfered top (extruded rounded rectangle), centred on origin. */
export function roundedBox(w: number, h: number, d: number, r: number, segs = 2): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  const rr = Math.min(r, w / 2 - 1e-4, d / 2 - 1e-4);
  s.moveTo(x0 + rr, z0);
  s.lineTo(x1 - rr, z0); s.quadraticCurveTo(x1, z0, x1, z0 + rr);
  s.lineTo(x1, z1 - rr); s.quadraticCurveTo(x1, z1, x1 - rr, z1);
  s.lineTo(x0 + rr, z1); s.quadraticCurveTo(x0, z1, x0, z1 - rr);
  s.lineTo(x0, z0 + rr); s.quadraticCurveTo(x0, z0, x0 + rr, z0);
  const bevel = Math.min(rr * 0.6, h * 0.25);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(1e-4, h - 2 * bevel), bevelEnabled: bevel > 1e-4, bevelThickness: bevel, bevelSize: bevel * 0.8,
    bevelSegments: 1, curveSegments: segs,
  });
  // Extrude runs along +Z; stand it up so the height is along +Y, centred.
  g.rotateX(-Math.PI / 2);
  g.translate(0, -(h - 2 * bevel) / 2, 0);
  g.computeVertexNormals();
  return g;
}

/** Apply a matrix (position + normals). Returns the same geometry. */
export function place(g: THREE.BufferGeometry, pos: V3, rot?: THREE.Euler | THREE.Quaternion, scale?: V3): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = rot instanceof THREE.Quaternion ? rot : new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler());
  m.compose(pos, q, scale ?? new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Quaternion that turns local +Y onto `dir`. */
export function alignY(dir: V3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}

/**
 * Planar polygon (with optional holes) lying in a plane, triangulated with earcut.
 * `to2d` projects a 3-D point into the plane; the winding is fixed so the face normal is `normal`.
 */
export function planarFace(
  contour: readonly V3[], holes: readonly (readonly V3[])[], normal: V3,
  to2d: (p: V3) => THREE.Vector2, uvOf: (p: V3) => readonly [number, number], uv1Of?: (p: V3) => readonly [number, number],
): THREE.BufferGeometry {
  const all = [...contour, ...holes.flat()];
  const tris = THREE.ShapeUtils.triangulateShape(contour.map(to2d), holes.map((h) => h.map(to2d)));
  const pos = new Float32Array(all.length * 3), nor = new Float32Array(all.length * 3), uv = new Float32Array(all.length * 2);
  const uv1 = uv1Of ? new Float32Array(all.length * 2) : null;
  all.forEach((p, i) => {
    pos.set([p.x, p.y, p.z], i * 3);
    nor.set([normal.x, normal.y, normal.z], i * 3);
    uv.set(uvOf(p), i * 2);
    if (uv1 && uv1Of) uv1.set(uv1Of(p), i * 2);
  });
  const index: number[] = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const [a, b, c] of tris) {
    e1.subVectors(all[b], all[a]); e2.subVectors(all[c], all[a]);
    if (e1.cross(e2).dot(normal) >= 0) index.push(a, b, c); else index.push(a, c, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (uv1) g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  g.setIndex(index);
  return g;
}

/** Structured grid (rows × cols of points) → indexed geometry; `flip` reverses the winding. */
export function gridGeometry(rows: readonly (readonly V3[])[], flip: boolean, uvOf: (p: V3, i: number, j: number) => readonly [number, number]): THREE.BufferGeometry {
  const nr = rows.length, nc = rows[0].length;
  const pos = new Float32Array(nr * nc * 3), uv = new Float32Array(nr * nc * 2);
  for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
    const p = rows[i][j], v = i * nc + j;
    pos.set([p.x, p.y, p.z], v * 3);
    uv.set(uvOf(p, i, j), v * 2);
  }
  const index: number[] = [];
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nc - 1; j++) {
    const a = i * nc + j, b = (i + 1) * nc + j, c = (i + 1) * nc + j + 1, d = i * nc + j + 1;
    if (flip) index.push(a, c, b, a, d, c); else index.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Keep only position/normal/uv (for merging with parts that lack extra attributes). */
export function basicAttributes(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n);
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}


// --- Hardware makers (local frames; `m` places them) ---------------------------------------------

const Y = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();

function xf(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(m);
  return basicAttributes(g);
}

function part(g: THREE.BufferGeometry, m: THREE.Matrix4, mat: MatKey, shadow = true): Part {
  return { geometry: xf(g, m), mat, shadow };
}

/** Matrix from a position, an up direction (+Y of the fitting) and a heading for its +Z. */
export function frame(pos: V3, up: V3 = Y, forward?: V3): THREE.Matrix4 {
  const yA = up.clone().normalize();
  const zA = (forward ?? new THREE.Vector3(0, 0, 1)).clone();
  zA.addScaledVector(yA, -zA.dot(yA));
  if (zA.lengthSq() < 1e-8) zA.set(1, 0, 0).addScaledVector(yA, -yA.x);
  zA.normalize();
  const xA = new THREE.Vector3().crossVectors(yA, zA);
  return new THREE.Matrix4().makeBasis(xA, yA, zA).setPosition(pos);
}

/** Cylinder along local +Y from y0 to y1 (radius r0 → r1). */
function cyl(r0: number, r1: number, y0: number, y1: number, seg: number, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1, open);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

/** Stainless bow shackle: U of round bar with its pin along X, opening down (local +Y is the bow). */
export function shackle(size: number, m: THREE.Matrix4, seg = 5): Part[] {
  const r = size * 0.11;
  const path: V3[] = [];
  for (let k = 0; k <= 6; k++) {
    const a = Math.PI * (k / 6);
    path.push(v3(-Math.cos(a) * size * 0.34, size * 0.35 + Math.sin(a) * size * 0.42, 0));
  }
  const legs = [v3(-size * 0.34, 0, 0), ...path, v3(size * 0.34, 0, 0)];
  const pin = rod(v3(-size * 0.5, 0, 0), v3(size * 0.5, 0, 0), r * 1.1, seg);
  return [part(tube(legs, { radius: r, radial: seg }), m, 'polished', false), part(pin, m, 'polished', false)];
}

/**
 * Block with `sheaves` sheaves of diameter d: cheeks, sheave(s), axle caps and a swivel/shackle head.
 * Local: axle along X, rope in the YZ plane over the top of the sheave, head toward +Y.
 */
export function block(d: number, m: THREE.Matrix4, sheaves = 1, segIn = 16, cheek: MatKey = 'plastic'): Part[] {
  const parts: Part[] = [];
  const seg = Math.min(segIn, 14);
  const w = 0.012 + 0.014 * sheaves;
  const rc = d * 0.62;
  const cheekG = (x: number) => {
    const g = new THREE.CylinderGeometry(rc, rc, 0.004, seg);
    g.rotateZ(Math.PI / 2);
    const head = new THREE.BoxGeometry(0.004, rc * 0.9, rc * 1.1);
    head.translate(0, rc * 0.55, 0);
    const merged = [g, head].map(basicAttributes);
    return merged.map((gg) => gg.translate(x, 0, 0));
  };
  for (const s of [-1, 1]) for (const g of cheekG(s * w / 2)) parts.push(part(g, m, cheek));
  for (let k = 0; k < sheaves; k++) {
    const x = -w / 2 + (w / (sheaves + 1)) * (k + 1);
    const sh = new THREE.CylinderGeometry(d / 2, d / 2, (w / sheaves) * 0.7, seg);
    sh.rotateZ(Math.PI / 2);
    sh.translate(x, 0, 0);
    parts.push(part(sh, m, 'darkMetal'));
  }
  const axle = new THREE.CylinderGeometry(0.004, 0.004, w + 0.008, 6);
  axle.rotateZ(Math.PI / 2);
  parts.push(part(axle, m, 'polished', false));
  const head = new THREE.Matrix4().multiplyMatrices(m, tmpM.makeTranslation(0, rc * 1.08, 0));
  parts.push(...shackle(0.028 + d * 0.15, head));
  return parts;
}

/** Open-body turnbuckle with toggle and swage, from the chainplate pin (origin) up local +Y. */
export function turnbuckle(len: number, m: THREE.Matrix4, seg = 8): Part[] {
  const parts: Part[] = [];
  // Toggle: two jaw plates around the chainplate + cross pin.
  for (const s of [-1, 1]) parts.push(part(roundedBox(0.004, 0.032, 0.018, 0.002).translate(s * 0.007, 0.012, 0), m, 'polished'));
  parts.push(part(rod(v3(-0.012, 0, 0), v3(0.012, 0, 0), 0.0035, 8), m, 'polished', false));
  parts.push(part(cyl(0.006, 0.006, 0.026, 0.034, seg), m, 'polished'));
  // Lower stud, body with two windows' worth of rails, upper stud, swage terminal.
  parts.push(part(cyl(0.0045, 0.0045, 0.034, 0.05, seg), m, 'brushed'));
  const b0 = 0.05, b1 = 0.05 + len * 0.55;
  parts.push(part(cyl(0.0085, 0.0085, b0, b0 + 0.012, seg), m, 'polished'));
  parts.push(part(cyl(0.0085, 0.0085, b1 - 0.012, b1, seg), m, 'polished'));
  for (const s of [-1, 1]) parts.push(part(roundedBox(0.0035, b1 - b0 - 0.02, 0.009, 0.0015).translate(s * 0.0068, (b0 + b1) / 2, 0), m, 'polished'));
  parts.push(part(cyl(0.0045, 0.0045, b1, b1 + 0.02, seg), m, 'brushed'));
  parts.push(part(cyl(0.0048, 0.0032, b1 + 0.02, len, seg), m, 'polished'));
  return parts;
}

/** Stainless chainplate strap through a deck cover plate (local +Y up, strap plane YZ). */
export function chainplate(m: THREE.Matrix4): Part[] {
  return [
    part(roundedBox(0.05, 0.006, 0.09, 0.012), m, 'brushed'),
    part(roundedBox(0.006, 0.07, 0.034, 0.008).translate(0, 0.035, 0), m, 'brushed'),
  ];
}

/** Self-tailing winch (drum Ø ≈ 2·r), with ribs, jaws, stripper arm and top cap. Local +Y up. */
export function winch(r: number, h: number, m: THREE.Matrix4, segIn: number, handleYaw: number | null): Part[] {
  const parts: Part[] = [];
  const seg = Math.min(segIn, 24);
  parts.push(part(lathe([[0, 0], [r * 1.45, 0], [r * 1.45, h * 0.03], [r * 1.34, h * 0.07], [r * 1.18, h * 0.1], [r * 1.12, h * 0.13], [0, h * 0.13]], seg), m, 'black'));
  // Ribbed drum: radius modulated around, flaring at the foot.
  const ribs = 18, around = Math.max(seg + 8, 36) + (Math.max(seg + 8, 36) % 18 === 0 ? 0 : 18 - (Math.max(seg + 8, 36) % 18)), rows = 6;
  const pos: number[] = [], index: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const y = h * (0.13 + 0.47 * t);
    const base = r * (1.1 - 0.12 * Math.sqrt(t));
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const rib = 1 + 0.035 * Math.pow(Math.max(0, Math.cos(ribs * a)), 6);
      pos.push(Math.cos(a) * base * rib, y, Math.sin(a) * base * rib);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < around; j++) {
    const a = i * (around + 1) + j, b = a + 1, c = a + around + 2, d = a + around + 1;
    index.push(a, c, b, a, d, c);
  }
  const drum = new THREE.BufferGeometry();
  drum.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  drum.setIndex(index);
  drum.computeVertexNormals();
  parts.push(part(drum, m, 'black'));
  // Self-tailing jaws (V groove between two flanges) and the top cap.
  parts.push(part(lathe([[0, h * 0.6], [r * 1.18, h * 0.6], [r * 1.2, h * 0.64], [r * 0.98, h * 0.7], [r * 0.8, h * 0.76], [r * 0.98, h * 0.82], [r * 1.2, h * 0.87], [r * 1.16, h * 0.9], [0, h * 0.9]], seg), m, 'plastic'));
  parts.push(part(lathe([[0, h * 0.9], [r * 1.08, h * 0.9], [r * 1.08, h * 0.94], [r * 0.95, h * 0.99], [r * 0.5, h], [r * 0.2, h], [0, h * 0.99]], seg), m, 'black'));
  parts.push(part(lathe([[0, h * 1.0], [r * 0.22, h * 1.0], [r * 0.22, h * 1.006], [0, h * 1.006]], 8), m, 'darkMetal', false));
  // Stripper arm over the jaws.
  const arm = roundedBox(r * 0.5, h * 0.12, r * 0.9, 0.004);
  arm.rotateY(Math.PI / 4);
  arm.translate(r * 0.95, h * 0.83, r * 0.95);
  parts.push(part(arm, m, 'plastic'));
  if (handleYaw !== null) {
    // Winch handle: socket boss, aluminium arm, rotating grip.
    const hm = new THREE.Matrix4().multiplyMatrices(m, tmpM.makeRotationY(handleYaw));
    parts.push(part(cyl(0.013, 0.013, h * 1.0, h * 1.0 + 0.03, 12), hm, 'aluminium'));
    const arm2 = roundedBox(0.024, 0.014, 0.25, 0.006);
    arm2.translate(0, h + 0.035, 0.12);
    parts.push(part(arm2, hm, 'aluminium'));
    parts.push(part(cyl(0.016, 0.016, h + 0.04, h + 0.15, 12).translate(0, 0, 0.235), hm, 'plastic'));
  }
  return parts;
}

/** Horn cleat of length L (local X along the horns). */
export function hornCleat(L: number, m: THREE.Matrix4, seg = 8): Part[] {
  const h = L * 0.3;
  const bar: V3[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = -1 + (2 * k) / 10;
    bar.push(v3(t * L * 0.5, h - 0.25 * h * t * t, 0));
  }
  return [
    part(tube(bar, { radius: (i) => L * (0.055 + 0.035 * (1 - Math.abs(i - 5) / 5)), radial: seg, capStart: true, capEnd: true }), m, 'aluminium'),
    part(roundedBox(L * 0.22, h * 0.9, L * 0.12, 0.004).translate(-L * 0.18, h * 0.45, 0), m, 'aluminium'),
    part(roundedBox(L * 0.22, h * 0.9, L * 0.12, 0.004).translate(L * 0.18, h * 0.45, 0), m, 'aluminium'),
    part(roundedBox(L * 0.7, 0.006, L * 0.18, 0.01), m, 'aluminium'),
  ];
}

/** Cam cleat with fairlead; rope runs along local +Z (out of the jaws toward −Z). */
export function camCleat(m: THREE.Matrix4, seg = 10): Part[] {
  const parts: Part[] = [part(roundedBox(0.05, 0.008, 0.075, 0.008).translate(0, 0.004, 0), m, 'black')];
  for (const s of [-1, 1]) {
    const cam = cyl(0.012, 0.012, 0.008, 0.028, seg);
    cam.translate(s * 0.014, 0, -0.005);
    parts.push(part(cam, m, 'plastic'));
    // Teeth: thin ridges on each cam.
    for (let k = 0; k < 3; k++) parts.push(part(roundedBox(0.003, 0.02, 0.012, 0.001).translate(s * 0.004, 0.018, -0.02 + k * 0.012), m, 'plastic', false));
  }
  const lead: V3[] = [];
  for (let k = 0; k <= 8; k++) { const a = Math.PI * (k / 8); lead.push(v3(-Math.cos(a) * 0.014, 0.008 + Math.sin(a) * 0.022, 0.03)); }
  parts.push(part(tube(lead, { radius: 0.0035, radial: 6 }), m, 'polished'));
  return parts;
}

/** Rope clutch: body, cam lever and the rope's entry/exit bushes; rope runs along local +Z. */
export function clutch(m: THREE.Matrix4, seg = 10): Part[] {
  return [
    part(roundedBox(0.036, 0.042, 0.12, 0.01).translate(0, 0.021, 0), m, 'plastic'),
    part(roundedBox(0.03, 0.012, 0.075, 0.006).translate(0, 0.048, -0.015).applyMatrix4(tmpM.makeRotationX(0.12)), m, 'black'),
    part(cyl(0.011, 0.011, 0.0, 0.004, seg).rotateX(Math.PI / 2).translate(0, 0.022, 0.061), m, 'darkMetal', false),
    part(cyl(0.011, 0.011, 0.0, 0.004, seg).rotateX(Math.PI / 2).translate(0, 0.022, -0.064), m, 'darkMetal', false),
  ];
}

/** Stanchion base: flanged socket with four bolt heads. */
export function stanchionBase(m: THREE.Matrix4, seg: number): Part[] {
  const parts = [part(lathe([[0.045, 0], [0.045, 0.006], [0.02, 0.012], [0.017, 0.05], [0.017, 0.07], [0, 0.07]], Math.min(seg, 12)), m, 'polished')];
  for (const [bx, bz] of [[0.03, 0.03], [-0.03, 0.03], [0.03, -0.03], [-0.03, -0.03]]) parts.push(part(cyl(0.005, 0.005, 0.005, 0.009, 5).translate(bx, 0, bz), m, 'polished', false));
  return parts;
}

// --- Deck layout -------------------------------------------------------------------------------------

/** Deck point in local coordinates. */
export const onDeck = (x: number, y: number, lift = 0) => loc(x, y, deckH(x, y) + lift);

export const HARDWARE = {
  stanchionX: [2.1, 0.75, -0.6, -1.95],
  stanchionInset: 0.055,
  lifelineH: 0.6,
  primary: { x: -1.72, y: 0.99, r: 0.052, h: 0.2 },
  secondary: { x: -2.9, y: 0.97, r: 0.042, h: 0.165 },
  leadCarX: -0.1,
  capChainplate: { x: BOAT.chainplates.x, y: BOAT.chainplates.y },
  lowerChainplate: { x: 0.74, y: 1.12 },
  clutchX: -1.0,
  clutchY: 0.45,
  organizerX: -0.45,
  backstayLeg: { x: BOAT.backstay.bottom.x, y: 0.88 },
  pulpitLegs: [[3.02, 0.8], [3.52, 0.44]] as Array<[number, number]>,
  pushpitLegs: [[-2.92, 1.07], [-3.56, 0.9]] as Array<[number, number]>,
};

/** Top of the stanchion on side s at station x (where the upper lifeline runs). */
export function stanchionTop(x: number, s: number): V3 {
  const y = s * (deckHalfBeam(x) - HARDWARE.stanchionInset);
  return onDeck(x, y, HARDWARE.lifelineH);
}

/** Where the jib sheet turns: the lead block on the car (side s). */
export function jibLeadPoint(s: number): V3 {
  return onDeck(HARDWARE.leadCarX, s * BOAT.jib.lead.y, 0.075);
}

/** Primary winch drum (where the working jib sheet goes on). */
export function primaryDrum(s: number): V3 {
  const w = HARDWARE.primary;
  return onDeck(w.x, s * w.y, w.h * 0.3).add(v3(-s * w.r * 1.05, 0, 0));
}

export function secondaryDrum(s: number): V3 {
  const w = HARDWARE.secondary;
  return onDeck(w.x, s * w.y, w.h * 0.3).add(v3(-s * w.r * 1.05, 0, 0));
}

/** Spinnaker sheet turning block on the quarter (kept on deck, just inside the edge). */
export function quarterBlock(s: number): V3 {
  const x = BOAT.spinnaker.sheetBlock.x;
  return onDeck(x, s * Math.min(BOAT.spinnaker.sheetBlock.y, deckHalfBeam(x) - 0.05), 0.05);
}

export function guyBlock(s: number): V3 {
  const g = BOAT.spinnaker.guyBlock;
  return onDeck(g.x, s * Math.min(g.y, deckHalfBeam(g.x) - 0.05), 0.05);
}

export function buildFittings(ctx: BuildContext): Part[] {
  const parts: Part[] = [];
  const d = ctx.detail;
  const seg = d.lathe;
  const rad = d.radial;
  const pads = ctx.pads;
  const pad = (x: number, y: number, hx: number, hy: number) => pads.push([[x - hx, y - hy], [x + hx, y - hy], [x + hx, y + hy], [x - hx, y + hy]]);

  // Stanchions and their bases.
  for (const s of [1, -1]) {
    for (const x of HARDWARE.stanchionX) {
      const y = s * (deckHalfBeam(x) - HARDWARE.stanchionInset);
      const base = onDeck(x, y, -0.002);
      const top = stanchionTop(x, s);
      parts.push(...stanchionBase(frame(base), seg));
      parts.push({ geometry: tube([base.clone().add(v3(0, 0.05, 0)), top.clone().add(v3(0, 0.01, 0))], { radius: 0.0125, radial: rad, capEnd: true }), mat: 'polished', shadow: true });
      // Lower-lifeline eye and a top cap with the upper eye.
      parts.push({ geometry: xf(lathe([[0, 0], [0.016, 0], [0.016, 0.02], [0.01, 0.028], [0, 0.028]], 10), frame(top.clone().add(v3(0, -0.012, 0)))), mat: 'polished', shadow: true });
      parts.push({ geometry: xf(new THREE.TorusGeometry(0.01, 0.0025, 6, 12), frame(onDeck(x, y, HARDWARE.lifelineH * 0.5), Y, v3(1, 0, 0))), mat: 'polished' });
      pad(x, y, 0.06, 0.06);
    }
  }

  // Bow pulpit: welded tube rail following the deck line round the stem, two legs a side, lower rail.
  const pulpitTop = (x: number, y: number) => onDeck(x, y, HARDWARE.lifelineH + 0.02);
  {
    const railY = (x: number) => deckHalfBeam(x) - HARDWARE.stanchionInset;
    const [[xa], [xb]] = HARDWARE.pulpitLegs;
    const xFront = X_STEM - 0.16;
    const side = [xa, xa + 0.2, xa + 0.4, xb, xb + 0.12];
    const railPts: V3[] = [
      ...side.map((x) => pulpitTop(x, -railY(x))),
      pulpitTop(xFront - 0.03, -railY(xFront - 0.03) * 0.55), pulpitTop(xFront, 0), pulpitTop(xFront - 0.03, railY(xFront - 0.03) * 0.55),
      ...side.slice().reverse().map((x) => pulpitTop(x, railY(x))),
    ];
    parts.push({ geometry: tube(smoothPath(railPts, 44), { radius: 0.0127, radial: rad, capStart: true, capEnd: true }), mat: 'polished', shadow: true });
    for (const s of [-1, 1]) {
      for (const x of [xa, xb]) {
        const y = s * railY(x);
        const top = pulpitTop(x, y);
        const base = onDeck(x, y, -0.002);
        parts.push({ geometry: tube([base, top], { radius: 0.0127, radial: rad }), mat: 'polished', shadow: true });
        parts.push(...stanchionBase(frame(base), seg));
        parts.push({ geometry: xf(new THREE.SphereGeometry(0.018, 8, 6), frame(top)), mat: 'polished' });
        pad(x, y, 0.06, 0.06);
      }
      // Lower rail between the legs, following the deck edge.
      const low = [xa, (xa + xb) / 2, xb].map((x) => onDeck(x, s * railY(x), 0.3));
      parts.push({ geometry: tube(smoothPath(low, 8), { radius: 0.0105, radial: rad }), mat: 'polished', shadow: true });
      for (const p of [low[0], low[2]]) parts.push({ geometry: xf(new THREE.SphereGeometry(0.015, 7, 5), frame(p)), mat: 'polished' });
    }
    // Bi-colour navigation light on the pulpit front.
    const nav = pulpitTop(xFront - 0.01, 0).add(v3(0, 0.035, 0));
    parts.push({ geometry: xf(roundedBox(0.07, 0.045, 0.05, 0.01), frame(nav)), mat: 'black', shadow: true });
    parts.push({ geometry: xf(roundedBox(0.03, 0.03, 0.012, 0.004), frame(nav.clone().add(v3(0.018, 0, -0.022)))), mat: 'glass' });
    parts.push({ geometry: xf(roundedBox(0.03, 0.03, 0.012, 0.004), frame(nav.clone().add(v3(-0.018, 0, -0.022)))), mat: 'glass' });
  }

  // Quarter pushpits (open transom): rail from a forward leg around the quarter to an aft leg.
  for (const s of [-1, 1]) {
    const [[xa, ya], [xb, yb]] = HARDWARE.pushpitLegs;
    const topH = HARDWARE.lifelineH + 0.02;
    const railPts = [
      onDeck(xa, s * ya, topH), onDeck((xa + xb) / 2 + 0.05, s * (ya - 0.02), topH),
      onDeck(xb + 0.06, s * (yb + 0.08), topH), onDeck(xb, s * (yb - 0.12), topH),
    ];
    const rail = smoothPath(railPts, 24);
    parts.push({ geometry: tube(rail, { radius: 0.0127, radial: rad, capStart: true, capEnd: true }), mat: 'polished', shadow: true });
    const legs: Array<[number, number, V3]> = [[xa, ya, railPts[0]], [xb, yb, rail[rail.length - 1]]];
    for (const [x, y, top] of legs) {
      const base = onDeck(x, s * y, -0.002);
      parts.push({ geometry: tube([base, top], { radius: 0.0127, radial: rad }), mat: 'polished', shadow: true });
      parts.push(...stanchionBase(frame(base), seg));
      parts.push({ geometry: xf(new THREE.SphereGeometry(0.018, 8, 6), frame(top)), mat: 'polished' });
      pad(x, s * y, 0.06, 0.06);
    }
    // Lower rail.
    const l0 = onDeck(xa, s * ya, 0.3), l1 = onDeck(xb, s * yb, 0.3);
    parts.push({ geometry: tube([l0, l0.clone().lerp(l1, 0.5).add(v3(s * 0.04, 0, 0)), l1], { radius: 0.0105, radial: rad }), mat: 'polished', shadow: true });
    if (s > 0) {
      // White stern light on the starboard pushpit.
      const sl = rail[rail.length - 4].clone().add(v3(0, 0.05, 0));
      parts.push({ geometry: xf(cyl(0.018, 0.018, 0, 0.05, 12), frame(sl)), mat: 'glass' });
      parts.push({ geometry: xf(cyl(0.02, 0.02, -0.012, 0, 12), frame(sl)), mat: 'black' });
    }
  }

  // Lifelines (white coated wire): upper and lower, pulpit → stanchions → pushpit, pelican hook aft.
  for (const s of [-1, 1]) {
    for (const [hgt, rTube] of [[HARDWARE.lifelineH, 0.0032], [HARDWARE.lifelineH * 0.5, 0.0028]] as const) {
      const xs = [HARDWARE.pulpitLegs[0][0], ...HARDWARE.stanchionX, HARDWARE.pushpitLegs[0][0]];
      const pts: V3[] = [];
      for (let k = 0; k < xs.length - 1; k++) {
        const a = xs[k], b = xs[k + 1];
        for (let t = 0; t < 1; t += 0.125) {
          const x = a + (b - a) * t;
          const y = s * (deckHalfBeam(x) - HARDWARE.stanchionInset);
          const sag = 0.012 * Math.sin(Math.PI * t);
          pts.push(onDeck(x, y, hgt + (hgt > 0.4 ? 0.0 : 0) - sag));
        }
      }
      const endX = HARDWARE.pushpitLegs[0][0] + 0.05;
      pts.push(onDeck(endX, s * (deckHalfBeam(endX) - HARDWARE.stanchionInset), hgt));
      parts.push({ geometry: tube(pts, { radius: rTube, radial: 5 }), mat: 'lifeline' });
      if (hgt > 0.4) {
        // Pelican hook where the upper lifeline meets the pushpit.
        const p = pts[pts.length - 1];
        const hook: V3[] = [];
        for (let k = 0; k <= 12; k++) { const a = (k / 12) * Math.PI * 1.6; hook.push(p.clone().add(v3(0, Math.sin(a) * 0.012, 0.04 - Math.cos(a) * 0.012 - 0.02))); }
        parts.push({ geometry: tube(hook, { radius: 0.0028, radial: 6 }), mat: 'polished' });
        parts.push({ geometry: xf(cyl(0.004, 0.004, 0, 0.05, 8), frame(p.clone().add(v3(0, 0, -0.07)), v3(0, 0, 1))), mat: 'polished' });
      }
    }
  }

  // Chainplates (the toggles and turnbuckles on them are built with the rig).
  for (const s of [-1, 1]) {
    for (const cp of [HARDWARE.capChainplate, HARDWARE.lowerChainplate]) {
      const base = onDeck(cp.x, s * cp.y, -0.003);
      parts.push(...chainplate(frame(base, Y, v3(0, 0, 1))));
      pad(cp.x, s * cp.y, 0.07, 0.05);
    }
    const bl = HARDWARE.backstayLeg;
    const base = onDeck(bl.x, s * bl.y, -0.003);
    parts.push(...chainplate(frame(base, Y, v3(1, 0, 0))));
    pad(bl.x, s * bl.y, 0.05, 0.05);
  }

  // Stem head fitting (forestay tang + furler toggle) and the bow mooring cleat.
  {
    const x = BOAT.forestay.tack.x;
    const top = onDeck(x - 0.08, 0, -0.002);
    parts.push({ geometry: xf(roundedBox(0.07, 0.008, 0.26, 0.02), frame(top)), mat: 'brushed', shadow: true });
    parts.push({ geometry: xf(roundedBox(0.008, 0.07, 0.06, 0.01).translate(0, 0.03, 0), frame(onDeck(x, 0, -0.002))), mat: 'brushed', shadow: true });
    parts.push(...hornCleat(0.2, frame(onDeck(3.28, 0, -0.002), Y, v3(1, 0, 0)), rad));
    pad(3.28, 0, 0.14, 0.05);
    pad(x - 0.08, 0, 0.16, 0.06);
  }

  // Stern quarter cleats.
  for (const s of [-1, 1]) {
    parts.push(...hornCleat(0.17, frame(onDeck(-3.28, s * 0.97, -0.002), Y, v3(0, 0, 1)), rad));
    pad(-3.28, s * 0.97, 0.05, 0.12);
  }

  // Winches: primaries (jib) and secondaries (spinnaker), one handle parked in the starboard primary.
  for (const s of [-1, 1]) {
    const P = HARDWARE.primary, S2 = HARDWARE.secondary;
    parts.push(...winch(P.r, P.h, frame(onDeck(P.x, s * P.y, -0.003)), seg, s > 0 ? 2.2 : null));
    parts.push(...winch(S2.r, S2.h, frame(onDeck(S2.x, s * S2.y, -0.003)), seg, null));
    pad(P.x, s * P.y, 0.1, 0.1);
    pad(S2.x, s * S2.y, 0.09, 0.09);
    // Winch wraps of the sheets (three turns) on the primaries.
    const wraps: V3[] = [];
    const c = onDeck(P.x, s * P.y, -0.003);
    for (let k = 0; k <= 60; k++) {
      const a = (k / 60) * Math.PI * 2 * 3;
      wraps.push(c.clone().add(v3(Math.cos(a) * P.r * 1.12, P.h * (0.18 + 0.3 * (k / 60)), Math.sin(a) * P.r * 1.12)));
    }
    parts.push({ geometry: ropeGeometry(wraps, 0.0045, s > 0 ? ROPE.jibStbd : ROPE.jibPort, 6), mat: 'rope' });
    // Tail out of the self-tailer, down into the cockpit in a loose coil on the seat.
    const tailTop = c.clone().add(v3(-s * P.r * 0.9, P.h * 0.78, 0));
    const seat = loc(P.x - 0.25, s * (COCKPIT.halfWidth - 0.18), COCKPIT.seatH + 0.006);
    const tail = smoothPath([tailTop, tailTop.clone().add(v3(-s * 0.06, -0.02, 0.05)), loc(P.x - 0.12, s * (COCKPIT.halfWidth + 0.01), deckH(P.x, COCKPIT.halfWidth) + 0.005), loc(P.x - 0.15, s * (COCKPIT.halfWidth - 0.04), COCKPIT.seatH + 0.03), seat], 26);
    parts.push({ geometry: ropeGeometry(tail, 0.0045, s > 0 ? ROPE.jibStbd : ROPE.jibPort, 6), mat: 'rope' });
    parts.push({ geometry: coil(seat.clone().add(v3(-s * 0.06, 0, 0.06)), 0.09, 0.0045, s > 0 ? ROPE.jibStbd : ROPE.jibPort), mat: 'rope' });
  }

  // Jib lead tracks with end stops, cars and lead blocks.
  for (const s of [-1, 1]) {
    const L = BOAT.jib.lead;
    const a = onDeck(L.xFwd + 0.05, s * L.y, 0.004), b = onDeck(L.xAft - 0.05, s * L.y, 0.004);
    const profile: Array<[number, number]> = [[-1, -1], [1, -1], [1, 0.2], [0.45, 0.4], [0.45, 1], [-0.45, 1], [-0.45, 0.4], [-1, 0.2]];
    parts.push({
      geometry: tube([a, b], { radius: 1, radial: 8, profile, profileScale: () => [0.012, 0.007], seedNormal: v3(1, 0, 0), capStart: true, capEnd: true }),
      mat: 'aluminium', shadow: true,
    });
    for (const e of [a, b]) parts.push({ geometry: xf(roundedBox(0.03, 0.02, 0.03, 0.006), frame(e.clone().add(v3(0, 0.006, 0)))), mat: 'black' });
    const car = onDeck(HARDWARE.leadCarX, s * L.y, 0.012);
    parts.push({ geometry: xf(roundedBox(0.034, 0.02, 0.075, 0.008), frame(car)), mat: 'darkMetal', shadow: true });
    parts.push({ geometry: xf(cyl(0.004, 0.004, 0, 0.018, 8), frame(car.clone().add(v3(0, 0.005, 0.03)))), mat: 'black' });
    parts.push(...block(0.05, frame(jibLeadPoint(s).add(v3(0, -0.005, 0)), Y, v3(0, 0, 1)), 1, seg));
    pads.push([[L.xFwd + 0.1, s * L.y - 0.035], [L.xAft - 0.1, s * L.y - 0.035], [L.xAft - 0.1, s * L.y + 0.035], [L.xFwd + 0.1, s * L.y + 0.035]]);
  }

  // Spinnaker sheet quarter blocks and guy (twing) blocks on padeyes.
  for (const s of [-1, 1]) {
    for (const p of [quarterBlock(s), guyBlock(s)]) {
      const deckP = onDeck(-p.z, p.x, -0.002);
      parts.push({ geometry: xf(roundedBox(0.045, 0.006, 0.045, 0.012), frame(deckP)), mat: 'brushed' });
      parts.push(...block(0.045, frame(p.clone().add(v3(0, -0.012, 0)), Y, v3(s * 0.3, 0, 1)), 1, seg, 'black'));
      pad(-p.z, p.x, 0.05, 0.05);
    }
  }

  // Traveller track on the bridge/seats with end controls (the car is animated).
  {
    const T = BOAT.boom.traveler;
    const h = COCKPIT.seatH + 0.003;
    const profile: Array<[number, number]> = [[-1, -1], [1, -1], [1, 0.3], [0.6, 1], [-0.6, 1], [-1, 0.3]];
    parts.push({
      geometry: tube([loc(T.x, -T.halfWidth - 0.02, h), loc(T.x, T.halfWidth + 0.02, h)], { radius: 1, radial: 6, profile, profileScale: () => [0.0165, 0.009], seedNormal: v3(0, 0, -1), capStart: true, capEnd: true }),
      mat: 'aluminium', shadow: true,
    });
    for (const s of [-1, 1]) {
      const end = loc(T.x, s * (T.halfWidth + 0.03), h + 0.012);
      parts.push({ geometry: xf(roundedBox(0.05, 0.028, 0.06, 0.01), frame(end)), mat: 'black', shadow: true });
      parts.push(...camCleat(frame(loc(T.x + 0.07, s * (T.halfWidth - 0.03), h), Y, v3(-s, 0, 0)), rad));
      pad(T.x, s * T.halfWidth, 0.12, 0.08);
    }
  }

  // Mast-base turning blocks, deck organisers and the clutch banks with halyard tails.
  const mb = BOAT.mast;
  const lineCells = [ROPE.halyard, ROPE.halyard, ROPE.control, ROPE.grey];
  for (const s of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const bx = mb.x - 0.19 - 0.02 * k, by = s * (0.07 + 0.05 * k);
      const bp = loc(bx, by, cabinTopH(bx, by) + 0.03);
      parts.push(...block(0.04, frame(bp, v3(0, 0, -1), v3(0, 1, 0)), 1, seg, 'black'));
      // Line from the mast exit down round the block, aft along the cabin top to the organiser/clutch.
      const exit = loc(mb.x - 0.07, s * 0.03 * (k + 1), mb.baseH + 0.32 + 0.06 * k);
      const org = loc(HARDWARE.organizerX, s * (HARDWARE.clutchY - 0.012 + 0.025 * k), cabinTopH(HARDWARE.organizerX, HARDWARE.clutchY) + 0.022);
      const clutchP = loc(HARDWARE.clutchX, s * (HARDWARE.clutchY - 0.012 + 0.025 * k), cabinTopH(HARDWARE.clutchX, HARDWARE.clutchY) + 0.022);
      const onTop = (x: number, y: number) => loc(x, y, cabinTopH(x, y) + 0.012);
      const path = smoothPath([exit, bp.clone().add(v3(0, 0.02, -0.005)), bp.clone().add(v3(0, -0.005, 0.03)), onTop(0.4, s * (0.2 + 0.1 * k)), onTop(-0.2, s * (0.4 + 0.012 * k)), org, clutchP], 40);
      parts.push({ geometry: ropeGeometry(path, 0.004, lineCells[k + (s > 0 ? 0 : 2)], 6), mat: 'rope' });
      // Tail: out of the clutch, over the aft edge, down onto the bridge deck and into a coil.
      const tailEnd = loc(-1.55, s * (0.2 + 0.08 * k), COCKPIT.soleH + 0.005);
      const lip = loc(-1.3 + 0.02, s * (HARDWARE.clutchY - 0.03), cabinTopH(-1.3, HARDWARE.clutchY) + 0.015);
      const tail = smoothPath([clutchP, clutchP.clone().add(v3(0, 0.002, 0.12)), lip, lip.clone().add(v3(0, -0.12, 0.05)), loc(-1.38, s * (0.35 + 0.02 * k), COCKPIT.seatH - 0.05), tailEnd], 30);
      parts.push({ geometry: ropeGeometry(tail, 0.004, lineCells[k + (s > 0 ? 0 : 2)], 6), mat: 'rope' });
      parts.push({ geometry: coil(tailEnd.clone().add(v3(0, 0, 0.05)), 0.075, 0.004, lineCells[k + (s > 0 ? 0 : 2)]), mat: 'rope' });
    }
    // Organiser: base plate with two sheaves; clutch bank of two.
    const oy = s * HARDWARE.clutchY;
    const op = loc(HARDWARE.organizerX, oy, cabinTopH(HARDWARE.organizerX, oy));
    parts.push({ geometry: xf(roundedBox(0.075, 0.012, 0.06, 0.01).translate(0, 0.006, 0), frame(op)), mat: 'darkMetal', shadow: true });
    for (let k = 0; k < 2; k++) {
      const sh = cyl(0.016, 0.016, -0.005, 0.005, 12).rotateX(Math.PI / 2).rotateY(Math.PI / 2);
      parts.push({ geometry: xf(sh.translate((k - 0.5) * 0.025, 0.02, 0), frame(op)), mat: 'black' });
    }
    for (let k = 0; k < 2; k++) {
      const cy = s * (HARDWARE.clutchY - 0.012 + 0.025 * k);
      parts.push(...clutch(frame(loc(HARDWARE.clutchX, cy, cabinTopH(HARDWARE.clutchX, cy)), Y, v3(0, 0, 1)), rad));
    }
    pad(HARDWARE.clutchX, oy, 0.09, 0.06);
    pad(HARDWARE.organizerX, oy, 0.06, 0.06);
  }

  // Furling line: drum → fairleads on the port stanchion bases → cam cleat at the cockpit.
  {
    const pts: V3[] = [loc(BOAT.jib.tack.x - 0.01, -0.03, sheerH(X_STEM) + 0.05)];
    for (const x of [...HARDWARE.stanchionX]) pts.push(onDeck(x, -(deckHalfBeam(x) - HARDWARE.stanchionInset - 0.03), 0.03));
    const camX = -1.48, camY = -1.02;
    pts.push(onDeck(camX + 0.06, camY, 0.02));
    parts.push({ geometry: ropeGeometry(smoothPath(pts, 70), 0.003, ROPE.black, 6), mat: 'rope' });
    parts.push(...camCleat(frame(onDeck(camX, camY, -0.002), Y, v3(0, 0, 1)), rad));
    for (const x of HARDWARE.stanchionX) {
      const p = onDeck(x, -(deckHalfBeam(x) - HARDWARE.stanchionInset - 0.03), 0.03);
      parts.push({ geometry: xf(new THREE.TorusGeometry(0.008, 0.003, 6, 10), frame(p, v3(0, 0, 1))), mat: 'black' });
    }
    pad(camX, camY, 0.05, 0.06);
  }

  // Rub rail along the sheer (dark grey rubber D-section), stopping short of the stem fitting.
  for (const s of [-1, 1]) {
    const pts: V3[] = [];
    const x0 = X_TRANSOM + 0.005, x1 = X_STEM - 0.03;
    for (let k = 0; k <= 64; k++) {
      const x = x0 + (x1 - x0) * (k / 64);
      const n = topsideNormal(ctx.lines, x);
      const h = sheerH(x) - 0.018;
      pts.push(loc(x, s * (deckHalfBeam(x) - 0.004 + n.ny * 0.004), h));
    }
    const prof: Array<[number, number]> = [];
    for (let k = 0; k <= 6; k++) { const a = -Math.PI / 2 + (Math.PI * k) / 6; prof.push([Math.cos(a), Math.sin(a)]); }
    prof.push([-0.2, 1], [-0.2, -1]);
    parts.push({
      geometry: tube(pts, { radius: 1, radial: prof.length, profile: s > 0 ? prof : prof.map(([a, b]) => [-a, b] as [number, number]).reverse(), profileScale: () => [0.013, 0.019], seedNormal: v3(s, 0, 0), capStart: true, capEnd: true }),
      mat: 'rubber', shadow: true,
    });
  }
  return parts;
}

/** Flat rope coil lying on a surface (spiral of a few turns). */
export function coil(center: V3, radius: number, r: number, cell: number): THREE.BufferGeometry {
  const pts: V3[] = [];
  const turns = 3.2, n = 56;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const a = t * turns * Math.PI * 2;
    const rr = radius * (1 - 0.35 * t) + 0.004 * Math.sin(a * 3.1);
    pts.push(center.clone().add(v3(Math.cos(a) * rr, r + 0.9 * r * Math.max(0, Math.sin(a * 0.5 + 1)) * 0.5, Math.sin(a) * rr)));
  }
  return ropeGeometry(pts, r, cell, 5);
}
