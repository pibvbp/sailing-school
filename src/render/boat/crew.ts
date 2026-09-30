// Three crew figures (spec §9.5): helmsman at the tiller and two trimmers in foul-weather gear. Rigid body
// parts (lathes, capsules) hang on an 11-joint skeleton that is posed on the CPU and written into two
// vertex-coloured meshes: the trimmers, and the helmsman (who can be hidden per camera — see HIDE_HELMSMAN).
//
// Motion: every figure keeps its own pose state (seat position, hip height, facing, lean, legs over the
// rail, head turn) that follows targets derived from crewY at bounded rates, so nothing can jump whatever
// crewY does. Each figure latches its side with hysteresis — crewY dithering around 0 never flips anyone —
// and a tack becomes a crossing: slide inboard along the seat, stand into the footwell, cross facing
// forward (under the boom), sit on the far seat and slide out; trimmers swing their legs over the rail to
// hike. Torsos lean against the heel, hands rest on the thighs, the helmsman holds the tiller extension
// (both hands while he changes sides) and the main trimmer holds the mainsheet tail.
import * as THREE from 'three';
import { COCKPIT, deckH } from './deck';
import { deckHalfBeam } from './hull';
import type { BoatDetail } from './materials';

type V3 = THREE.Vector3;
type Role = 'helm' | 'main' | 'jib';

/** Set `camera.userData[HIDE_HELMSMAN] = true` on cameras placed at the helmsman's eyes. */
export const HIDE_HELMSMAN = 'hideHelmsman';

export interface CrewInput {
  /** Crew lateral position −1 (port) … +1 (starboard). */
  crewY: number;
  /** Heel (rad, + starboard down). */
  heel: number;
  /** Tiller end (universal joint), boat-local. */
  tillerEnd: V3;
  /** Where the mainsheet tail leaves the traveller-car cam, boat-local (null: nobody holds it). */
  mainsheetCam: V3 | null;
}

/**
 * Crew stations (spec x), clear of stanchions, winches and the helm camera (the helmsman's eye, x −2.3):
 * where each sits (`x`), crosses the footwell (`crossX`) and hikes (`hikeX`). The jib trimmer sits on
 * the rail beside the cabin with his legs over the side and crosses through the front of the cockpit.
 */
export const CREW_STATIONS: ReadonlyArray<{ x: number; crossX: number; hikeX: number; role: Role }> = [
  { x: -2.36, crossX: -2.36, hikeX: -2.36, role: 'helm' },
  { x: -1.66, crossX: -1.85, hikeX: -1.52, role: 'main' },
  { x: -1.05, crossX: -1.45, hikeX: -1.05, role: 'jib' },
];

/** Rates and thresholds of the crew's movement (per second where a rate). */
export const CREW_MOTION = {
  /** crewY must be this far over on the other side before a figure changes sides. */
  sideHyst: { helm: 0.12, main: 0.08, jib: 0.1 } as Record<Role, number>,
  hikeOn: 0.88,
  hikeOff: 0.74,
  /** Lateral speed seated (sliding along a seat) and standing in the footwell (m/s), acceleration (m/s²). */
  slide: 1.0,
  cross: 1.45,
  accel: 4.5,
  approach: 6,
  hip: 1.0,
  crouch: 2.3,
  over: 1.9,
  yaw: 2.4,
  lean: 1.6,
  look: 1.8,
  /** Heel compensation of the trunk (rad/s). */
  roll: 0.8,
  /** Hands move toward their holds at this speed (m/s) with a first-order approach rate (1/s). */
  hand: 1.9,
  handApproach: 14,
  /** The idle sway alone (nothing else moving) is refreshed at this rate (Hz): mm-scale steps, a fraction of the rewrites. */
  swayHz: 15,
};

interface Style {
  jacket: number;
  /** Shoulder yokes, cuffs, hood (the darker panels of an offshore jacket). */
  panel: number;
  trousers: number;
  skin: number;
  hair: number;
  hat: { kind: 'cap' | 'beanie'; color: number } | null;
  pfd: number;
  pfdTab: number;
  boots: number;
}

const STYLES: Record<Role, Style> = {
  helm: { jacket: 0xb4232a, panel: 0x2a2d31, trousers: 0x1c1e21, skin: 0xc68e6b, hair: 0x3b2a1d, hat: { kind: 'cap', color: 0xeeeeea }, pfd: 0x1f2226, pfdTab: 0xd23a1e, boots: 0x2b2e32 },
  main: { jacket: 0xe3b321, panel: 0x34383d, trousers: 0x2a2e33, skin: 0xe2ae8c, hair: 0x8a6a42, hat: { kind: 'cap', color: 0x1b2a44 }, pfd: 0x22262a, pfdTab: 0xe8c21e, boots: 0x31363b },
  jib: { jacket: 0x244a80, panel: 0x6d747c, trousers: 0x17191c, skin: 0x9b6a4b, hair: 0x15110e, hat: { kind: 'beanie', color: 0x3c4148 }, pfd: 0x1b1e22, pfdTab: 0x2f7fd0, boots: 0x282a2d },
};

/** Surface classes → (roughness, cloth weight of the fabric normal map). */
const SURF = {
  jacket: [0.55, 1], panel: [0.62, 1], trousers: [0.7, 1], skin: [0.52, 0], hair: [0.85, 0.15], hat: [0.72, 0.8],
  pfd: [0.5, 0.5], glass: [0.06, 0], glove: [0.62, 0.35], boot: [0.4, 0], sole: [0.85, 0],
} as const;
type Surf = keyof typeof SURF;

// Skeleton joints (parents: hips ← torso ← head, arms; hips ← thighs ← shins).
const J = { hips: 0, torso: 1, head: 2, armL: 3, foreL: 4, armR: 5, foreR: 6, thighL: 7, shinL: 8, thighR: 9, shinR: 10 } as const;
const JOINTS = 11;
const SEG = { upper: 0.285, fore: 0.26, thigh: 0.43, shin: 0.41 };

interface Tint { color: number; surf: Surf; w: (p: V3) => number }
interface PartDef { joint: number; geo: THREE.BufferGeometry; color: number; surf: Surf; ao?: (p: V3) => number; tint?: Tint }

const clamp = THREE.MathUtils.clamp;
const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);
const approach = (cur: number, target: number, maxStep: number) => cur + clamp(target - cur, -maxStep, maxStep);

function lathe(prof: Array<[number, number]>, seg: number, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), seg, phiStart, phiLength);
}

/** Tapered limb from a joint at y = 0 down to y = −len with rounded ends. */
function limb(r0: number, r1: number, len: number, seg: number): THREE.BufferGeometry {
  const prof: Array<[number, number]> = [];
  for (let k = 0; k <= 5; k++) { const a = (Math.PI / 2) * (k / 5); prof.push([r0 * Math.sin(a), r0 * Math.cos(a)]); }
  for (let k = 0; k <= 5; k++) { const a = Math.PI / 2 + (Math.PI / 2) * (k / 5); prof.push([r1 * Math.sin(a), -len + r1 * Math.cos(a)]); }
  return lathe(prof.reverse(), seg);
}

function ellipsoid(rx: number, ry: number, rz: number, seg: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, seg, Math.max(6, Math.round(seg * 0.6))).scale(rx, ry, rz);
}

/** Skull surface point for a unit direction (face +Z): narrower jaw, forward chin, fuller occiput. */
function skull(dx: number, dy: number, dz: number, out: V3): V3 {
  const low = Math.max(0, -dy);
  let x = dx * 0.08 * (1 - 0.3 * low * low), y = dy * 0.113, z = dz * 0.1;
  if (dz > 0) z += 0.014 * dz * low * low + 0.004 * dz;
  if (dz < 0) z *= 1 + 0.08 * Math.max(0, 1 - Math.abs(dy + 0.1));
  if (dz > 0.6 && dy > -0.2 && dy < 0.45) z -= 0.006;
  y -= 0.012 * low * Math.max(0, dz);
  x *= dy > 0.3 ? 1 - 0.1 * (dy - 0.3) : 1;
  return out.set(x, y + 0.168, z - 0.004);
}

/** 0 at the face, 1 at the back of the head, for a SphereGeometry azimuth (face at φ = π/2). */
const aft = (phi: number) => (1 - Math.sin(phi)) / 2;

/**
 * A shell over the skull (the skin itself, hair, a hat, the glasses strap): SphereGeometry's grid with
 * each meridian's polar range given by `band(φ)`, mapped onto the skull and pushed `gap` m outward, so
 * whatever sits on the head follows its shape. Normals are averaged across the seam and at the poles.
 */
function skullShell(wSeg: number, hSeg: number, gap: number, phiStart: number, phiLength: number, band: (phi: number) => [number, number]): THREE.BufferGeometry {
  // SphereGeometry's own minimums (3 × 2 segments), so every vertex it makes is remapped below.
  const w = Math.max(3, Math.floor(wSeg)), h = Math.max(2, Math.floor(hSeg));
  let t0 = Math.PI, t1 = 0;
  for (let ix = 0; ix <= w; ix++) { const [a, b] = band(phiStart + (ix / w) * phiLength); t0 = Math.min(t0, a); t1 = Math.max(t1, b); }
  const g = new THREE.SphereGeometry(1, w, h, phiStart, phiLength, t0, t1 - t0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const s = new THREE.Vector3();
  for (let iy = 0; iy <= h; iy++) for (let ix = 0; ix <= w; ix++) {
    const phi = phiStart + (ix / w) * phiLength;
    const [a, b] = band(phi);
    const theta = a + (iy / h) * (b - a);
    const dx = -Math.cos(phi) * Math.sin(theta), dy = Math.cos(theta), dz = Math.sin(phi) * Math.sin(theta);
    skull(dx, dy, dz, s);
    p.setXYZ(iy * (w + 1) + ix, s.x + dx * gap, s.y + dy * gap, s.z + dz * gap);
  }
  g.computeVertexNormals();
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const avg = (ids: number[]) => {
    s.set(0, 0, 0);
    for (const i of ids) s.x += n.getX(i), s.y += n.getY(i), s.z += n.getZ(i);
    s.normalize();
    for (const i of ids) n.setXYZ(i, s.x, s.y, s.z);
  };
  if (phiLength > Math.PI * 2 - 1e-6) for (let iy = 0; iy <= h; iy++) avg([iy * (w + 1), iy * (w + 1) + w]);
  const row = (iy: number) => Array.from({ length: w + 1 }, (_, ix) => iy * (w + 1) + ix);
  if (t0 === 0) avg(row(0));
  if (t1 >= Math.PI) avg(row(h));
  return g;
}

/** Stiff cap brim: inner edge round the forehead, 7 cm peak, tapering to the sides, tilted down. */
function capBrim(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const a0 = -1.05, a1 = 1.05, n = 12;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    if (i === 0) shape.moveTo(0.088 * Math.sin(a), 0.088 * Math.cos(a));
    else shape.lineTo(0.088 * Math.sin(a), 0.088 * Math.cos(a));
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n;
    shape.lineTo(0.092 * Math.sin(a), 0.03 + 0.135 * Math.cos(a));
  }
  // Shape plane (lateral, forward) → horizontal, thickness downward; front tipped down.
  return new THREE.ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: false, curveSegments: 1 }).rotateX(Math.PI / 2).rotateX(0.14).translate(0, 0.222, -0.004);
}

function buildParts(style: Style, seg: number): PartDef[] {
  const p: PartDef[] = [];
  const add = (joint: number, geo: THREE.BufferGeometry, color: number, surf: Surf, ao?: (v: V3) => number, tint?: Tint) => p.push({ joint, geo, color, surf, ao, tint });
  // Offshore-jacket yoke: the shoulders in the darker panel fabric above a line across the upper chest.
  const yoke: Tint = { color: style.panel, surf: 'panel', w: (v) => smooth(0.405, 0.425, v.y) };
  const small = Math.max(6, seg - 4);
  // Salopettes, darker between the legs.
  add(J.hips, ellipsoid(0.165, 0.105, 0.125, seg).translate(0, 0.03, -0.01), style.trousers, 'trousers', (v) => 0.8 + 0.2 * smooth(-0.06, 0.08, v.y));
  // Jacket: torso (shoulders rounded forward), yokes, high collar, rolled hood, zip.
  const torso = lathe([[0.0, -0.02], [0.158, 0.0], [0.166, 0.1], [0.186, 0.24], [0.2, 0.34], [0.203, 0.4], [0.186, 0.45], [0.13, 0.49], [0.075, 0.505], [0.0, 0.51]], seg).scale(1, 1, 0.64);
  bend(torso, 0.3, 0.035);
  add(J.torso, torso, style.jacket, 'jacket', (v) => 0.78 + 0.22 * smooth(0.0, 0.18, v.y) - 0.1 * smooth(0.14, 0.19, Math.abs(v.x)) * smooth(0.22, 0.3, v.y) * (1 - smooth(0.34, 0.42, v.y)), yoke);
  // Shoulders in the yoke fabric (they also close the gap where the sleeves meet the body).
  for (const sx of [-1, 1]) add(J.torso, ellipsoid(0.076, 0.06, 0.076, seg).translate(sx * 0.182, 0.425, 0.012), style.panel, 'panel', (v) => 0.86 + 0.14 * smooth(0.38, 0.44, v.y));
  add(J.torso, lathe([[0.068, 0.44], [0.08, 0.47], [0.083, 0.52], [0.082, 0.548], [0.072, 0.552], [0.066, 0.52], [0.062, 0.48]], seg).scale(1, 1, 0.92).translate(0, 0, 0.02), style.jacket, 'jacket', (v) => (v.y < 0.5 ? 0.8 : 1));
  add(J.torso, ellipsoid(0.105, 0.05, 0.05, small).translate(0, 0.56, -0.07), style.panel, 'panel');
  add(J.torso, new THREE.BoxGeometry(0.014, 0.36, 0.012).translate(0, 0.27, 0.13), style.panel, 'panel');
  // Inflatable life jacket: collar round the neck, lobes down the chest, waist belt with a tab.
  add(J.torso, new THREE.TorusGeometry(0.118, 0.036, 6, seg).rotateX(Math.PI / 2).scale(1, 1, 0.78).translate(0, 0.462, 0.012), style.pfd, 'pfd');
  for (const sx of [-1, 1]) add(J.torso, new THREE.CapsuleGeometry(0.04, 0.2, 3, small).rotateX(-0.12).rotateZ(sx * 0.08).translate(sx * 0.085, 0.31, 0.118), style.pfd, 'pfd');
  add(J.torso, new THREE.CylinderGeometry(0.168, 0.165, 0.04, seg, 1, true).scale(1, 1, 0.66).translate(0, 0.14, 0), style.pfd, 'pfd');
  add(J.torso, new THREE.BoxGeometry(0.035, 0.03, 0.012).translate(0.05, 0.14, 0.113), style.pfdTab, 'panel');
  // Head: neck, skull, ears, nose, hair, headwear, wraparound glasses.
  add(J.head, new THREE.CylinderGeometry(0.051, 0.057, 0.1, small).translate(0, 0.035, 0), style.skin, 'skin', () => 0.72);
  add(J.head, skullShell(seg + 4, seg, 0, 0, Math.PI * 2, () => [0, Math.PI]), style.skin, 'skin', (v) => 0.74 + 0.26 * smooth(0.07, 0.13, v.y) - 0.08 * smooth(0.17, 0.2, v.y) * smooth(0.05, 0.09, v.z));
  for (const sx of [-1, 1]) add(J.head, ellipsoid(0.011, 0.025, 0.018, 6).translate(sx * 0.087, 0.158, -0.008), style.skin, 'skin', () => 0.85);
  add(J.head, ellipsoid(0.012, 0.024, 0.016, 6).rotateX(0.3).translate(0, 0.148, 0.1), style.skin, 'skin');
  // Hair round the back and sides down to the nape (the face open); the hat covers the crown.
  add(J.head, skullShell(seg, 5, 0.003, Math.PI * 0.9, Math.PI * 1.2, (phi) => [Math.PI * 0.08, Math.PI * (0.47 + 0.17 * aft(phi))]), style.hair, 'hair', (v) => 0.75 + 0.25 * smooth(0.13, 0.2, v.y));
  if (style.hat?.kind === 'cap') {
    // Crown down to the forehead in front and the strap line behind, a stiff brim and the top button.
    const c = style.hat.color;
    add(J.head, skullShell(seg + 4, 6, 0.006, -Math.PI / 2, Math.PI * 2, (phi) => [0, Math.PI * (0.36 + 0.14 * aft(phi))]), c, 'hat', (v) => 0.82 + 0.18 * smooth(0.2, 0.27, v.y));
    add(J.head, capBrim(), c, 'hat', () => 0.86);
    add(J.head, ellipsoid(0.011, 0.005, 0.011, 6).translate(0, 0.288, -0.004), c, 'hat');
  } else if (style.hat?.kind === 'beanie') {
    // Knitted beanie pulled down over the ears, with a turned-up cuff.
    const c = style.hat.color;
    const edge = (phi: number) => Math.PI * (0.4 + 0.18 * aft(phi));
    add(J.head, skullShell(seg + 4, 7, 0.008, -Math.PI / 2, Math.PI * 2, (phi) => [0, edge(phi)]), c, 'hat', (v) => 0.84 + 0.16 * smooth(0.18, 0.27, v.y));
    add(J.head, skullShell(seg + 4, 2, 0.014, -Math.PI / 2, Math.PI * 2, (phi) => [edge(phi) - Math.PI * 0.1, edge(phi) + 0.01]), c, 'hat', () => 0.9);
  }
  // Wraparound sunglasses: lenses, and the frame's arms back over the ears.
  for (const sx of [-1, 1]) add(J.head, ellipsoid(0.03, 0.018, 0.009, 8).rotateY(sx * 0.3).translate(sx * 0.034, 0.17, 0.096), 0x08090b, 'glass');
  add(J.head, skullShell(seg, 2, 0.006, Math.PI * 0.05, Math.PI * 0.9, () => [Math.PI * 0.47, Math.PI * 0.5]), 0x111316, 'boot');
  // Sleeves with dark cuffs; gloved hands (palm, curled fingers, thumb).
  for (const [a, f] of [[J.armL, J.foreL], [J.armR, J.foreR]] as const) {
    add(a, limb(0.062, 0.054, SEG.upper, seg), style.jacket, 'jacket', (v) => 0.85 + 0.15 * smooth(-0.2, -0.02, v.y), { ...yoke, w: (v) => smooth(-0.09, -0.04, v.y) });
    add(f, limb(0.054, 0.047, SEG.fore - 0.035, seg), style.jacket, 'jacket');
    add(f, new THREE.CylinderGeometry(0.047, 0.049, 0.03, small).translate(0, -SEG.fore + 0.03, 0), style.panel, 'panel');
    add(f, ellipsoid(0.043, 0.052, 0.022, 8).translate(0, -SEG.fore - 0.03, 0.004), 0x131416, 'glove');
    add(f, new THREE.CapsuleGeometry(0.017, 0.05, 3, 6).rotateZ(Math.PI / 2).translate(0, -SEG.fore - 0.075, 0.012), 0x131416, 'glove');
    add(f, new THREE.CapsuleGeometry(0.012, 0.03, 3, 6).rotateX(0.5).translate(0.03, -SEG.fore - 0.03, 0.022), 0x131416, 'glove');
  }
  // Salopettes and sea boots.
  for (const [t, sh] of [[J.thighL, J.shinL], [J.thighR, J.shinR]] as const) {
    add(t, limb(0.084, 0.066, SEG.thigh, seg), style.trousers, 'trousers');
    add(sh, limb(0.066, 0.056, SEG.shin - 0.12, seg), style.trousers, 'trousers');
    add(sh, limb(0.061, 0.056, 0.16, seg).translate(0, -SEG.shin + 0.16, 0), style.boots, 'boot');
    add(sh, new THREE.CapsuleGeometry(0.05, 0.14, 3, small).rotateX(Math.PI / 2).translate(0, -SEG.shin - 0.02, 0.055), style.boots, 'boot');
    add(sh, new THREE.BoxGeometry(0.1, 0.014, 0.26).translate(0, -SEG.shin - 0.068, 0.055), 0x3f4246, 'sole');
  }
  return p;
}

/** Round the shoulders: push the upper torso forward progressively above height y0. */
function bend(g: THREE.BufferGeometry, y0: number, amount: number): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > y0) p.setZ(i, p.getZ(i) + amount * ((y - y0) / 0.21) ** 2);
  }
  g.computeVertexNormals();
}

interface Figure {
  role: Role;
  /** Station seated (legs in) and hiking; `xNow` is where he is (between them, by the legs-over state). */
  x: number;
  crossX: number;
  hikeX: number;
  xNow: number;
  mesh: 0 | 1;
  /** First vertex in its mesh's buffers and the vertex count of each part, in order. */
  vStart: number;
  parts: Array<{ joint: number; count: number }>;
  world: THREE.Matrix4[];
  side: 1 | -1;
  hike: boolean;
  // Pose state.
  y: number; vy: number; hip: number; crouch: number; over: number; delta: number; lean: number; look: number;
  roll: number;
  /** Hand positions (boat-local), each moving toward its hold at a bounded speed. */
  handL: THREE.Vector3; handR: THREE.Vector3;
  /** Share of the helm's tiller hold in the left hand (0…1), for the extension end. */
  gripL: number;
  phase: number;
}

interface MeshBuffers {
  mesh: THREE.Mesh;
  base: Float32Array;
  baseN: Float32Array;
  pos: THREE.BufferAttribute;
  nor: THREE.BufferAttribute;
}

// Scratch (allocation-free posing).
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _nm = new THREE.Matrix3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _shL = new THREE.Vector3();
const _shR = new THREE.Vector3();
const _restL = new THREE.Vector3();
const _restR = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _upper = new THREE.Vector3();
const _side = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

export class CrewSet {
  /** Trimmers (index 0) and helmsman (index 1). */
  readonly objects: [THREE.Mesh, THREE.Mesh];
  /** Where the helmsman's hand holds the tiller extension (boat-local). */
  readonly helmGrip = new THREE.Vector3();
  /** Where the main trimmer's hand holds the mainsheet tail, and how firmly (0…1). */
  readonly sheetHand = new THREE.Vector3();
  sheetGrip = 0;

  private readonly figures: Figure[] = [];
  private readonly buffers: MeshBuffers[] = [];
  private time = 0;
  private placed = false;
  private handsPlaced = false;
  private sinceWrite = Infinity;
  private readonly last = { crewY: NaN, heel: NaN, tx: NaN, ty: NaN, tz: NaN, cam: NaN };

  constructor(detail: BoatDetail) {
    const seg = detail.radial >= 8 ? 12 : 8;
    const groups: Array<Array<{ role: Role; x: number; crossX: number; hikeX: number }>> = [
      CREW_STATIONS.filter((s) => s.role !== 'helm'),
      CREW_STATIONS.filter((s) => s.role === 'helm'),
    ];
    groups.forEach((stations, meshIndex) => {
      const built = stations.map((st) => ({ st, parts: buildParts(STYLES[st.role], seg) }));
      const total = built.reduce((n, b) => n + b.parts.reduce((m, p) => m + p.geo.getAttribute('position').count, 0), 0);
      const base = new Float32Array(total * 3), baseN = new Float32Array(total * 3);
      const col = new Float32Array(total * 3), uv = new Float32Array(total * 2), matp = new Float32Array(total * 2);
      const index: number[] = [];
      const c = new THREE.Color(), c2 = new THREE.Color(), v = new THREE.Vector3();
      let off = 0;
      built.forEach(({ st, parts }, k) => {
        const fig: Figure = {
          role: st.role, x: st.x, crossX: st.crossX, hikeX: st.hikeX, xNow: st.x, mesh: meshIndex as 0 | 1, vStart: off, parts: [],
          world: Array.from({ length: JOINTS }, () => new THREE.Matrix4()),
          side: 1, hike: false, y: 0, vy: 0, hip: 0, crouch: 0, over: 0, delta: 0, lean: 0, look: 0, roll: 0,
          handL: new THREE.Vector3(), handR: new THREE.Vector3(), gripL: 1,
          phase: 1.7 * (k + 2 * meshIndex) + 0.4,
        };
        for (const pd of parts) {
          const p = pd.geo.getAttribute('position'), n = pd.geo.getAttribute('normal'), t = pd.geo.getAttribute('uv');
          const idx = pd.geo.getIndex();
          if (idx) for (let i = 0; i < idx.count; i++) index.push(off + idx.getX(i));
          else for (let i = 0; i < p.count; i++) index.push(off + i);
          const [rough, cloth] = SURF[pd.surf];
          const [rough2, cloth2] = pd.tint ? SURF[pd.tint.surf] : SURF[pd.surf];
          for (let i = 0; i < p.count; i++, off++) {
            v.fromBufferAttribute(p, i);
            const ao = pd.ao ? clamp(pd.ao(v), 0.4, 1) : 1;
            const tw = pd.tint ? clamp(pd.tint.w(v), 0, 1) : 0;
            c.setHex(pd.color, THREE.SRGBColorSpace);
            if (pd.tint) c.lerp(c2.setHex(pd.tint.color, THREE.SRGBColorSpace), tw);
            c.multiplyScalar(ao);
            base.set([v.x, v.y, v.z], off * 3);
            baseN.set([n.getX(i), n.getY(i), n.getZ(i)], off * 3);
            col.set([c.r, c.g, c.b], off * 3);
            uv.set(t ? [t.getX(i), t.getY(i)] : [0, 0], off * 2);
            matp.set([rough + (rough2 - rough) * tw, cloth + (cloth2 - cloth) * tw], off * 2);
          }
          fig.parts.push({ joint: pd.joint, count: p.count });
          pd.geo.dispose();
        }
        this.figures.push(fig);
      });
      const g = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const nor = new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', pos);
      g.setAttribute('normal', nor);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('matp', new THREE.BufferAttribute(matp, 2));
      g.setIndex(index);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 2), 4);
      const mesh = new THREE.Mesh(g);
      mesh.name = meshIndex === 0 ? 'crew' : 'helmsman';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.buffers.push({ mesh, base, baseN, pos, nor });
    });
    this.objects = [this.buffers[0].mesh, this.buffers[1].mesh];
    // Per-camera hide: a camera flagged HIDE_HELMSMAN draws nothing of him (his shadow still renders).
    const helm = this.buffers[1].mesh;
    helm.onBeforeRender = (_r, _s, camera, geometry) => {
      geometry.setDrawRange(0, camera.userData[HIDE_HELMSMAN] ? 0 : Infinity);
    };
  }

  /** Show or hide the helmsman in every view. */
  set helmVisible(v: boolean) { this.buffers[1].mesh.visible = v; }
  get helmVisible(): boolean { return this.buffers[1].mesh.visible; }

  /** Place everyone at their target pose on the next update instead of walking there. */
  snap(): void { this.placed = false; }

  /**
   * Advance the pose state by dt (0 freezes it) and rewrite the meshes when anything moved.
   * Returns true when the geometry was rewritten.
   */
  update(inp: CrewInput, dt: number): boolean {
    const placing = !this.placed;
    const step = this.placed ? Math.max(0, dt) : 0;
    if (placing) this.handsPlaced = false;
    this.time += step;
    this.sinceWrite += step;
    let moved = !this.placed;
    for (const f of this.figures) moved = this.advance(f, inp, step) || moved;
    this.placed = true;
    const L = this.last, cam = inp.mainsheetCam ? inp.mainsheetCam.x + 7 * inp.mainsheetCam.z : NaN;
    const inputChanged = L.crewY !== inp.crewY || L.heel !== inp.heel || L.tx !== inp.tillerEnd.x || L.ty !== inp.tillerEnd.y || L.tz !== inp.tillerEnd.z || !(L.cam === cam || (Number.isNaN(L.cam) && Number.isNaN(cam)));
    const swayDue = step > 0 && this.sinceWrite >= 1 / CREW_MOTION.swayHz;
    if (!moved && !inputChanged && !swayDue) return false;
    L.crewY = inp.crewY; L.heel = inp.heel; L.tx = inp.tillerEnd.x; L.ty = inp.tillerEnd.y; L.tz = inp.tillerEnd.z; L.cam = cam;
    for (const f of this.figures) this.pose(f, inp, placing ? 0 : step);
    this.handsPlaced = true;
    this.write();
    this.sinceWrite = 0;
    return true;
  }

  dispose(): void { for (const b of this.buffers) b.mesh.geometry.dispose(); }

  // --- state ------------------------------------------------------------------------------------------

  /** Latch side/hike and move the pose state toward its targets at bounded rates. Returns true if moved. */
  private advance(f: Figure, inp: CrewInput, dt: number): boolean {
    const M = CREW_MOTION;
    const c = clamp(inp.crewY, -1, 1);
    const snap = !this.placed;
    const fw = COCKPIT.footwellHalf;
    const before = f.y + f.xNow + f.hip + f.crouch + f.over + f.delta + f.lean + f.look + f.roll;

    // 1. Side (latched with hysteresis) and hiking (latched between two thresholds).
    if (snap) f.side = c < 0 ? -1 : 1;
    else if (c * f.side < -M.sideHyst[f.role]) { f.side = f.side > 0 ? -1 : 1; f.hike = false; }
    const a = Math.max(0, c * f.side);
    if (f.role !== 'helm') {
      if (!f.hike && a > M.hikeOn) f.hike = true;
      else if (f.hike && a < M.hikeOff) f.hike = false;
    }
    const legsOverWanted = f.role === 'jib' || f.hike;

    // 2. Lateral target at the seat station: helm and main trimmer between the cockpit seat and the rail
    //    by crewY; the jib trimmer always on the rail beside the cabin.
    const seatRail = deckHalfBeam(f.x) - (f.role === 'helm' ? 0.17 : 0.05);
    const inner = f.role === 'helm' ? 0.7 : 0.62;
    const yT = f.side * (f.role === 'jib' ? seatRail : inner + (seatRail - inner) * smooth(0.12, 0.8, a));
    // Band of |y| over which the station moves between crossing (crossX) and seated (x) along the boat:
    // the jib trimmer reaches his place beside the cabin only once out on the side deck (never through
    // the cabin); the others shift at the footwell's edge.
    const lo = f.role === 'jib' ? COCKPIT.halfWidth + 0.02 : fw - 0.2;
    const hi = f.role === 'jib' ? seatRail - 0.08 : fw + 0.2;

    // 3. Move the state (or place it).
    if (snap) {
      f.y = yT; f.vy = 0;
      f.over = legsOverWanted ? 1 : 0;
      f.crouch = Math.abs(f.y) < fw + 0.03 ? 1 : 0;
    } else {
      // Slide seated, faster standing in the footwell, never with the legs over the rail, slowly while
      // the body is still turning. Where the station also moves along the boat with |y| (step 4), the
      // bound is on the speed along that diagonal path, not just across it.
      const turning = smooth(0.2, 0.9, Math.abs(f.delta - this.deltaTarget(f)));
      const t = clamp((Math.abs(f.y) - lo) / (hi - lo), 0, 1);
      const slope = (Math.abs(f.x - f.crossX) * 6 * t * (1 - t)) / (hi - lo);
      const vmax = ((M.slide + (M.cross - M.slide) * f.crouch) * (1 - f.over) * (1 - 0.5 * turning)) / Math.hypot(1, slope);
      const vWant = clamp((yT - f.y) * M.approach, -vmax, vmax);
      f.vy = clamp(approach(f.vy, vWant, M.accel * dt), -vmax, vmax);
      f.y += f.vy * dt;
      f.crouch = approach(f.crouch, Math.abs(f.y) < fw + 0.03 ? 1 : 0, M.crouch * dt);
      const atRail = f.side * f.y > seatRail - 0.08;
      f.over = approach(f.over, legsOverWanted && atRail ? 1 : 0, M.over * dt);
    }

    // 4. Station along the boat from the current state: the seat, the footwell while crossing, forward
    //    along the rail when hiking.
    const ay = Math.abs(f.y);
    const toSeat = smooth(lo, hi, ay);
    f.xNow = f.crossX + (f.x - f.crossX) * toSeat + (f.role === 'main' ? (f.hikeX - f.x) * f.over : 0);
    const bs = deckHalfBeam(f.xNow);

    // 5. Dependent targets: seat height, facing, lean, head, heel compensation.
    const onSeat = smooth(fw - 0.04, fw + 0.04, ay);
    const onDeck = smooth(COCKPIT.halfWidth - 0.05, COCKPIT.halfWidth + 0.05, ay);
    const surf = COCKPIT.soleH + (COCKPIT.seatH - COCKPIT.soleH) * onSeat + (deckH(f.xNow, Math.min(ay, bs)) - COCKPIT.seatH) * onDeck;
    const hipT = surf + 0.1 + f.crouch * (0.42 * (1 - onSeat) + 0.2 * onSeat);
    const sy = clamp(f.y / 0.35, -1, 1);
    const deltaT = this.deltaTarget(f);
    const leanBack = f.role === 'helm' ? 0.1 + 0.08 * a : 0.06 + 0.26 * smooth(0.45, 0.8, a) * (1 - f.over);
    const leanT = -leanBack * (1 - f.crouch) + 0.38 * f.crouch + 0.22 * f.over * (f.role === 'jib' ? 0.3 + 0.7 * a : 1);
    // Trimmers facing inboard look toward the bow (their right on starboard).
    const lookT = -sy * (f.role === 'helm' ? 0.15 : 0.5) * (1 - f.over) * (1 - f.crouch);
    const rollT = clamp(0.6 * inp.heel, -0.35, 0.35);
    if (snap) {
      f.hip = hipT; f.delta = deltaT; f.lean = leanT; f.look = lookT; f.roll = rollT;
    } else {
      f.hip = Math.max(approach(f.hip, hipT, M.hip * dt), surf + 0.08);
      f.delta = approach(f.delta, deltaT, M.yaw * dt);
      f.lean = approach(f.lean, leanT, M.lean * dt);
      f.look = approach(f.look, lookT, M.look * dt);
      f.roll = approach(f.roll, rollT, M.roll * dt);
    }
    return snap || Math.abs(f.y + f.xNow + f.hip + f.crouch + f.over + f.delta + f.lean + f.look + f.roll - before) > 1e-6;
  }

  /** Facing target (relative to the bow) for the figure's current position, legs and crouch. */
  private deltaTarget(f: Figure): number {
    const sy = clamp(f.y / 0.35, -1, 1);
    const bias = f.role === 'helm' ? 0.8 : 0.29;
    const dSeated = sy * (Math.PI / 2 - bias);
    const dOver = -sy * (Math.PI / 2 - 0.25);
    return (dSeated + (dOver - dSeated) * f.over) * (1 - f.crouch);
  }

  // --- skeleton ---------------------------------------------------------------------------------------

  private pose(f: Figure, inp: CrewInput, dt: number): void {
    const W = f.world;
    const t = this.time + f.phase;
    const sway = 0.018 * Math.sin(1.3 * t) + 0.01 * Math.sin(0.47 * t + 1.1);
    const swayRoll = 0.012 * Math.sin(0.9 * t + 2.0);
    const lookSway = 0.07 * Math.sin(0.37 * t) + 0.035 * Math.sin(0.83 * t + 2);
    const psi = Math.PI + f.delta;
    W[J.hips].makeRotationY(psi).setPosition(f.y, f.hip, -f.xNow);
    // The trunk rolls about the boat's fore-and-aft axis to stay nearer the true vertical when heeled.
    _m.makeRotationZ(f.roll + swayRoll);
    _mB.makeRotationY(psi);
    _mB.premultiply(_m).setPosition(f.y, f.hip, -f.xNow);

    // Legs: seated → thighs level, shins 30° forward; standing crouch → thighs down, shins back, wider.
    const cr = f.crouch;
    const hipFlex = (-Math.PI / 2) * (1 - cr) - 1.15 * cr;
    const knee = (Math.PI / 3) * (1 - cr) + 2.05 * cr;
    const splay = 0.14 + 0.12 * cr;
    local(W[J.thighL], W[J.hips], 0.09, -0.02, 0, hipFlex, 0, splay);
    local(W[J.shinL], W[J.thighL], 0, -SEG.thigh, 0, knee, 0, -splay * 0.5);
    local(W[J.thighR], W[J.hips], -0.09, -0.02, 0, hipFlex, 0, -splay);
    local(W[J.shinR], W[J.thighR], 0, -SEG.thigh, 0, knee, 0, splay * 0.5);

    // Torso, head carried slightly forward, shoulders.
    local(W[J.torso], _mB, 0, 0.09, 0, f.lean + sway, 0, 0);
    local(W[J.head], W[J.torso], 0, 0.5, 0.025, -f.lean * 0.4 - 0.02, f.look + lookSway, 0);
    local(W[J.armL], W[J.torso], 0.2, 0.44, 0.015, -0.3, 0, 0.1);
    local(W[J.armR], W[J.torso], -0.2, 0.44, 0.015, -0.3, 0, -0.1);
    _shL.setFromMatrixPosition(W[J.armL]);
    _shR.setFromMatrixPosition(W[J.armR]);
    restOnThigh(W, J.thighL, 1, _restL);
    restOnThigh(W, J.thighR, -1, _restR);

    // Where each hand wants to be: resting on its thigh, or holding the tiller extension / mainsheet tail.
    const sy = clamp(f.y / 0.35, -1, 1);
    let wantL = _restL, wantR = _restR;
    if (f.role === 'helm') {
      // Grip on the extension between the chest and the tiller end; the hand on the tiller side holds it
      // (left on starboard, right on port) and both hands meet on it while he changes sides.
      _c.set(0, 0.32, 0).applyMatrix4(W[J.torso]);
      _d.subVectors(inp.tillerEnd, _c);
      const dist = Math.max(1e-3, _d.length());
      _grip.copy(_c).addScaledVector(_d, clamp(dist - 0.3, 0.18, 0.5) / dist);
      // The hold passes from one hand to the other at a bounded rate (no jump of the extension end).
      const gripT = smooth(-0.35, 0.35, sy);
      f.gripL = this.handsPlaced ? approach(f.gripL, gripT, 2.5 * dt) : gripT;
      _a.lerpVectors(_restL, _grip, f.gripL);
      _b.lerpVectors(_restR, _grip, 1 - f.gripL);
      wantL = _a; wantR = _b;
    } else if (f.role === 'main' && inp.mainsheetCam) {
      // The aft hand (left on starboard) holds the tail a little above the cam.
      _c.set(0, 0.3, 0).applyMatrix4(W[J.torso]);
      _d.subVectors(_c, inp.mainsheetCam);
      const dist = Math.max(1e-3, _d.length());
      _grip.copy(inp.mainsheetCam).addScaledVector(_d, Math.min(0.4, dist * 0.45) / dist);
      // Released while standing (crossing) and while hiking facing outboard.
      const w = (1 - cr) * (1 - f.over) * smooth(0.3, 0.7, Math.abs(sy));
      this.sheetGrip = w;
      _a.lerpVectors(_restL, _grip, sy > 0 ? w : 0);
      _b.lerpVectors(_restR, _grip, sy < 0 ? w : 0);
      wantL = _a; wantR = _b;
    }
    if (!this.handsPlaced) {
      f.handL.copy(wantL); f.handR.copy(wantR);
    } else if (dt > 0) {
      const k = 1 - Math.exp(-CREW_MOTION.handApproach * dt);
      moveToward(f.handL, wantL, CREW_MOTION.hand * dt, k);
      moveToward(f.handR, wantR, CREW_MOTION.hand * dt, k);
    }
    this.arm(W, J.armL, J.foreL, _shL, f.handL, 1);
    this.arm(W, J.armR, J.foreR, _shR, f.handR, -1);
    if (f.role === 'helm') this.helmGrip.lerpVectors(f.handR, f.handL, f.gripL);
    if (f.role === 'main') this.sheetHand.copy(sy > 0 ? f.handL : f.handR);
  }

  /** Two-bone IK from the shoulder to `target`, elbow out to the figure's side (sx: +1 left, −1 right). */
  private arm(W: THREE.Matrix4[], jUpper: number, jFore: number, shoulder: V3, target: V3, sx: number): void {
    _side.set(sx, 0, 0).transformDirection(W[J.hips]);
    _pole.set(0, -0.5, 0).addScaledVector(_side, 1).normalize();
    const a = SEG.upper, b = SEG.fore + 0.04;
    _d.subVectors(target, shoulder);
    // Soft reach: the elbow angle is infinitely sensitive near full stretch, so compress distances past
    // 90 % of the arm's length smoothly toward the limit instead of clamping (no elbow snaps).
    const full = a + b, soft = 0.9 * full;
    const raw = Math.max(0.05, _d.length());
    const dist = raw < soft ? raw : soft + (full - soft) * (1 - Math.exp(-(raw - soft) / (full - soft))) * 0.995;
    _d.normalize();
    const angA = Math.acos(clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1));
    _pole.addScaledVector(_d, -_pole.dot(_d));
    if (_pole.lengthSq() < 1e-8) _pole.set(0, -1, 0);
    _pole.normalize();
    _upper.copy(_d).multiplyScalar(Math.cos(angA)).addScaledVector(_pole, Math.sin(angA));
    _elbow.copy(shoulder).addScaledVector(_upper, a);
    _q.setFromUnitVectors(DOWN, _upper);
    W[jUpper].makeRotationFromQuaternion(_q).setPosition(shoulder);
    _d.subVectors(target, _elbow).normalize();
    _q.setFromUnitVectors(DOWN, _d);
    W[jFore].makeRotationFromQuaternion(_q).setPosition(_elbow);
  }

  private write(): void {
    for (const f of this.figures) {
      const buf = this.buffers[f.mesh];
      const out = buf.pos.array as Float32Array, outN = buf.nor.array as Float32Array;
      const base = buf.base, baseN = buf.baseN;
      let v = f.vStart;
      for (const part of f.parts) {
        const m = f.world[part.joint];
        _nm.setFromMatrix4(m);
        const e = m.elements, ne = _nm.elements;
        for (let i = 0; i < part.count; i++, v++) {
          const x = base[v * 3], y = base[v * 3 + 1], z = base[v * 3 + 2];
          out[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          out[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          out[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
          const nx = baseN[v * 3], ny = baseN[v * 3 + 1], nz = baseN[v * 3 + 2];
          outN[v * 3] = ne[0] * nx + ne[3] * ny + ne[6] * nz;
          outN[v * 3 + 1] = ne[1] * nx + ne[4] * ny + ne[7] * nz;
          outN[v * 3 + 2] = ne[2] * nx + ne[5] * ny + ne[8] * nz;
        }
      }
    }
    for (const b of this.buffers) { b.pos.needsUpdate = true; b.nor.needsUpdate = true; }
  }
}

/** Move `p` toward `target` by a first-order step, but no further than `maxStep` (m). */
function moveToward(p: V3, target: V3, maxStep: number, k: number): void {
  _e2.subVectors(target, p).multiplyScalar(k);
  const l = _e2.length();
  if (l > maxStep) _e2.multiplyScalar(maxStep / l);
  p.add(_e2);
}

/** Joint world matrix = parent × T(x,y,z) × R(rx, ry, rz) (order YXZ). */
function local(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx: number, ry: number, rz: number): void {
  _e.set(rx, ry, rz, 'YXZ');
  _m.makeRotationFromEuler(_e).setPosition(x, y, z);
  out.multiplyMatrices(parent, _m);
}

/** A glove resting on top of the thigh, a little past halfway to the knee. */
function restOnThigh(W: THREE.Matrix4[], thigh: number, sx: number, out: V3): void {
  out.setFromMatrixPosition(W[thigh]);
  _a.set(0, -1, 0).transformDirection(W[thigh]);
  _b.set(0, 0, -1).transformDirection(W[thigh]);
  _c.set(sx, 0, 0).transformDirection(W[J.hips]);
  out.addScaledVector(_a, SEG.thigh * (0.62 + 0.06 * sx)).addScaledVector(_b, 0.1).addScaledVector(_c, 0.02);
}
