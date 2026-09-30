// Three crew figures (spec §9.5): helmsman at the tiller and two trimmers, in foul-weather jackets and
// dark trousers. Rigid body parts (capsules, lathes) hang on a small skeleton that is posed on the CPU
// and written into ONE vertex-coloured mesh per frame (no skinning, one draw call).
// Poses follow crewY: crouched in the footwell (0) → seated on the side deck, legs in (≈0.5) →
// trimmers swing their legs over the rail and hike facing outboard (1). Torsos lean against the heel;
// the helmsman's arm reaches the tiller extension with 2-bone IK.
import * as THREE from 'three';
import { COCKPIT, deckH } from './deck';
import { deckHalfBeam } from './hull';
import type { BoatDetail } from './materials';

type V3 = THREE.Vector3;

interface Style {
  jacket: number;
  /** Shoulder yokes, cuffs, hood (darker panels of an offshore jacket). */
  panel: number;
  trousers: number;
  skin: number;
  hair: number;
  hat: { kind: 'cap' | 'beanie'; color: number } | null;
  pfd: number;
  pfdTab: number;
  boots: number;
}

const STYLES: Style[] = [
  { jacket: 0xb4232a, panel: 0x2a2d31, trousers: 0x1c1e21, skin: 0xc68e6b, hair: 0x3b2a1d, hat: { kind: 'cap', color: 0xeeeeea }, pfd: 0x1f2226, pfdTab: 0xd23a1e, boots: 0x2b2e32 },
  { jacket: 0xe3b321, panel: 0x34383d, trousers: 0x2a2e33, skin: 0xe2ae8c, hair: 0x8a6a42, hat: { kind: 'cap', color: 0x1b2a44 }, pfd: 0x22262a, pfdTab: 0xe8c21e, boots: 0x31363b },
  { jacket: 0x263a55, panel: 0x6d747c, trousers: 0x17191c, skin: 0x9b6a4b, hair: 0x15110e, hat: { kind: 'beanie', color: 0x3c4148 }, pfd: 0x1b1e22, pfdTab: 0x2f7fd0, boots: 0x282a2d },
];

/** Crew stations (x, spec) and roles. */
const STATIONS = [
  { x: -2.55, role: 'helm' as const },
  { x: -1.98, role: 'trim' as const },
  { x: -1.42, role: 'trim' as const },
];

// Skeleton joints.
const J = { hips: 0, torso: 1, head: 2, armL: 3, foreL: 4, armR: 5, foreR: 6, thighL: 7, shinL: 8, thighR: 9, shinR: 10 } as const;
/** Parent joint of each joint (the hierarchy poseFigure walks explicitly). */
const PARENT = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9];
const SEG = { upper: 0.285, fore: 0.26, thigh: 0.43, shin: 0.41, torso: 0.47 };

interface PartDef { joint: number; geo: THREE.BufferGeometry; color: number }

const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);

function capsuleDown(r0: number, r1: number, len: number, seg: number): THREE.BufferGeometry {
  // Tapered limb from the joint (y = 0) down to y = −len, rounded ends.
  const prof: Array<[number, number]> = [];
  const n = 5;
  for (let k = 0; k <= n; k++) { const a = (Math.PI / 2) * (k / n); prof.push([r0 * Math.sin(a), r0 * Math.cos(a)]); }
  for (let k = 0; k <= n; k++) { const a = Math.PI / 2 + (Math.PI / 2) * (k / n); prof.push([r1 * Math.sin(a), -len + r1 * Math.cos(a)]); }
  prof.reverse();
  return new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), seg);
}

function ellipsoid(rx: number, ry: number, rz: number, seg: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, seg, Math.max(6, Math.round(seg * 0.6))).scale(rx, ry, rz);
}

function lathe(prof: Array<[number, number]>, seg: number, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), seg, phiStart, phiLength);
}

/** Bulky jacket torso from the waist (y 0) to the shoulders; elliptical section. */
function torsoGeo(seg: number): THREE.BufferGeometry {
  return lathe([[0.0, -0.02], [0.158, 0.0], [0.166, 0.1], [0.186, 0.24], [0.2, 0.34], [0.203, 0.4], [0.186, 0.45], [0.13, 0.49], [0.075, 0.505], [0.0, 0.51]], seg).scale(1, 1, 0.64);
}

/**
 * Head: a sphere deformed into a skull with a narrower jaw, a forward chin and a fuller occiput,
 * centred at y = 0.168 in the head-joint frame (face toward +Z).
 */
function headGeo(seg: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg + 4, seg);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const dx = p.getX(i), dy = p.getY(i), dz = p.getZ(i);
    const low = Math.max(0, -dy);
    let x = dx * 0.08 * (1 - 0.3 * low * low), y = dy * 0.113, z = dz * 0.1;
    if (dz > 0) z += 0.014 * dz * low * low + 0.004 * dz;           // chin and face forward
    if (dz < 0) z *= 1 + 0.08 * Math.max(0, 1 - Math.abs(dy + 0.1)); // occiput
    if (dz > 0.6 && dy > -0.2 && dy < 0.45) z -= 0.006;              // brow/eye plane
    y -= 0.012 * low * Math.max(0, dz);                              // jaw line drops toward the chin
    x *= dy > 0.3 ? 1 - 0.1 * (dy - 0.3) : 1;
    p.setXYZ(i, x, y + 0.168, z - 0.004);
  }
  g.computeVertexNormals();
  return g;
}

/** Tapered limb from a joint at y = 0 down to y = −len with rounded ends. */
function limb(r0: number, r1: number, len: number, seg: number): THREE.BufferGeometry {
  return capsuleDown(r0, r1, len, seg);
}

function buildParts(style: Style, seg: number): PartDef[] {
  const p: PartDef[] = [];
  const add = (joint: number, geo: THREE.BufferGeometry, color: number) => p.push({ joint, geo, color });
  const small = Math.max(6, seg - 4);
  // Pelvis in salopettes.
  add(J.hips, ellipsoid(0.175, 0.105, 0.125, seg).translate(0, 0.03, -0.01), style.trousers);
  // Jacket: torso, darker shoulder yokes, high collar, rolled hood, zip.
  add(J.torso, torsoGeo(seg), style.jacket);
  for (const sx of [-1, 1]) add(J.torso, ellipsoid(0.088, 0.072, 0.082, seg).translate(sx * 0.178, 0.43, -0.004), style.panel);
  add(J.torso, lathe([[0.068, 0.44], [0.08, 0.47], [0.083, 0.52], [0.082, 0.548], [0.072, 0.552], [0.066, 0.52], [0.062, 0.48]], seg).scale(1, 1, 0.92), style.jacket);
  add(J.torso, ellipsoid(0.105, 0.05, 0.05, small).translate(0, 0.56, -0.085), style.panel);
  add(J.torso, new THREE.BoxGeometry(0.014, 0.36, 0.012).translate(0, 0.27, 0.126), style.panel);
  // Inflatable life jacket: collar round the neck, two lobes down the chest, waist belt with a tab.
  add(J.torso, new THREE.TorusGeometry(0.118, 0.036, 6, seg).rotateX(Math.PI / 2).scale(1, 1, 0.78).translate(0, 0.462, -0.004), style.pfd);
  for (const sx of [-1, 1]) {
    add(J.torso, new THREE.CapsuleGeometry(0.04, 0.2, 3, small).rotateX(-0.12).rotateZ(sx * 0.08).translate(sx * 0.085, 0.31, 0.112), style.pfd);
  }
  add(J.torso, new THREE.CylinderGeometry(0.168, 0.165, 0.04, seg, 1, true).scale(1, 1, 0.66).translate(0, 0.14, 0), style.pfd);
  add(J.torso, new THREE.BoxGeometry(0.035, 0.03, 0.012).translate(0.05, 0.14, 0.113), style.pfdTab);
  // Head: neck, skull, jaw, ears, nose, hair, headwear, wraparound glasses.
  add(J.head, new THREE.CylinderGeometry(0.047, 0.054, 0.1, small).translate(0, 0.035, 0.0), style.skin);
  add(J.head, headGeo(seg), style.skin);
  for (const sx of [-1, 1]) add(J.head, ellipsoid(0.012, 0.027, 0.02, 6).translate(sx * 0.088, 0.158, -0.008), style.skin);
  add(J.head, ellipsoid(0.012, 0.024, 0.016, 6).rotateX(0.3).translate(0, 0.148, 0.1), style.skin);
  add(J.head, new THREE.SphereGeometry(0.092, seg, 6, Math.PI * 0.35, Math.PI * 1.3, Math.PI * 0.18, Math.PI * 0.42).translate(0, 0.17, -0.006), style.hair);
  if (style.hat?.kind === 'cap') {
    add(J.head, new THREE.SphereGeometry(0.095, seg, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1, 0.8, 1.05).translate(0, 0.19, -0.004), style.hat.color);
    add(J.head, new THREE.CylinderGeometry(0.086, 0.086, 0.007, seg, 1, false, -Math.PI * 0.42, Math.PI * 0.84).scale(1, 1, 1.05).rotateX(0.14).translate(0, 0.192, 0.052), style.hat.color);
    add(J.head, ellipsoid(0.01, 0.006, 0.01, 6).translate(0, 0.266, -0.004), style.hat.color);
  } else if (style.hat?.kind === 'beanie') {
    add(J.head, new THREE.SphereGeometry(0.097, seg, 7, 0, Math.PI * 2, 0, Math.PI * 0.56).scale(1, 0.95, 1.05).translate(0, 0.17, -0.006), style.hat.color);
    add(J.head, new THREE.CylinderGeometry(0.1, 0.1, 0.04, seg, 1, true).scale(1, 1, 1.03).translate(0, 0.19, -0.006), style.hat.color);
  }
  for (const sx of [-1, 1]) add(J.head, ellipsoid(0.03, 0.018, 0.009, 8).rotateY(sx * 0.3).translate(sx * 0.034, 0.17, 0.091), 0x08090b);
  add(J.head, new THREE.CylinderGeometry(0.092, 0.092, 0.012, seg, 1, true, -1.25, 2.5).translate(0, 0.176, -0.002), 0x111316);
  // Sleeves with dark cuffs; gloved hands (palm, curled fingers, thumb).
  for (const [a, f] of [[J.armL, J.foreL], [J.armR, J.foreR]] as const) {
    add(a, limb(0.062, 0.054, SEG.upper, seg), style.jacket);
    add(f, limb(0.054, 0.047, SEG.fore - 0.035, seg), style.jacket);
    add(f, new THREE.CylinderGeometry(0.047, 0.049, 0.03, small).translate(0, -SEG.fore + 0.03, 0), style.panel);
    add(f, ellipsoid(0.043, 0.052, 0.022, 8).translate(0, -SEG.fore - 0.03, 0.004), 0x131416);
    add(f, new THREE.CapsuleGeometry(0.017, 0.05, 3, 6).rotateZ(Math.PI / 2).translate(0, -SEG.fore - 0.075, 0.012), 0x131416);
    add(f, new THREE.CapsuleGeometry(0.012, 0.03, 3, 6).rotateX(0.5).translate(0.03, -SEG.fore - 0.03, 0.022), 0x131416);
  }
  // Salopettes and sea boots.
  for (const [t, sh] of [[J.thighL, J.shinL], [J.thighR, J.shinR]] as const) {
    add(t, limb(0.084, 0.066, SEG.thigh, seg), style.trousers);
    add(sh, limb(0.066, 0.056, SEG.shin - 0.12, seg), style.trousers);
    add(sh, limb(0.061, 0.056, 0.16, seg).translate(0, -SEG.shin + 0.16, 0), style.boots);
    add(sh, new THREE.CapsuleGeometry(0.05, 0.14, 3, small).rotateX(Math.PI / 2).translate(0, -SEG.shin - 0.02, 0.055), style.boots);
    add(sh, new THREE.BoxGeometry(0.1, 0.014, 0.26).translate(0, -SEG.shin - 0.068, 0.055), 0x3f4246);
  }
  return p;
}

interface FigureState {
  parts: PartDef[];
  /** First vertex of this figure in the shared buffers. */
  offset: number;
  /** World (boat-local) matrix per joint. */
  world: THREE.Matrix4[];
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const DOWN = new THREE.Vector3(0, -1, 0);

export class CrewSet {
  readonly object: THREE.Mesh;
  private readonly figures: FigureState[] = [];
  private readonly base: Float32Array;
  private readonly baseN: Float32Array;
  private readonly pos: THREE.BufferAttribute;
  private readonly nor: THREE.BufferAttribute;
  private readonly hand = new THREE.Vector3();
  /** The helm camera sits in the helmsman's head: it hides him. */
  helmVisible = true;

  constructor(detail: BoatDetail) {
    const seg = detail.radial >= 8 ? 12 : 8;
    const all: PartDef[][] = STYLES.map((s) => buildParts(s, seg));
    const total = all.reduce((n, parts) => n + parts.reduce((m, p) => m + p.geo.getAttribute('position').count, 0), 0);
    this.base = new Float32Array(total * 3);
    this.baseN = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const index: number[] = [];
    const c = new THREE.Color();
    let off = 0;
    for (const parts of all) {
      const start = off;
      for (const pd of parts) {
        const p = pd.geo.getAttribute('position'), n = pd.geo.getAttribute('normal');
        c.setHex(pd.color, THREE.SRGBColorSpace);
        const idx = pd.geo.getIndex();
        if (idx) for (let i = 0; i < idx.count; i++) index.push(off + idx.getX(i));
        else for (let i = 0; i < p.count; i++) index.push(off + i);
        for (let i = 0; i < p.count; i++, off++) {
          this.base.set([p.getX(i), p.getY(i), p.getZ(i)], off * 3);
          this.baseN.set([n.getX(i), n.getY(i), n.getZ(i)], off * 3);
          col.set([c.r, c.g, c.b], off * 3);
        }
      }
      this.figures.push({ parts, offset: start, world: Array.from({ length: PARENT.length }, () => new THREE.Matrix4()) });
    }
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.nor = new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('normal', this.nor);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 2), 4);
    this.object = new THREE.Mesh(g);
    this.object.name = 'crew';
    this.object.castShadow = true;
    this.object.receiveShadow = true;
    this.object.frustumCulled = false;
  }

  /**
   * Pose all three for the (smoothed) crew position and heel. Returns the helmsman's hand position
   * (boat-local), where the tiller extension ends.
   */
  update(crewY: number, heel: number, tillerEnd: V3): V3 {
    const s = crewY >= 0 ? 1 : -1;
    const a = Math.min(1, Math.abs(crewY));
    STATIONS.forEach((st, i) => this.poseFigure(this.figures[i], st.x, st.role, s, a, heel, tillerEnd));
    if (!this.helmVisible) for (const m of this.figures[0].world) m.makeScale(0, 0, 0);
    this.write();
    return this.hand;
  }

  dispose(): void { this.object.geometry.dispose(); }

  // -----------------------------------------------------------------------------------------------------

  private poseFigure(f: FigureState, x: number, role: 'helm' | 'trim', s: number, a: number, heel: number, tillerEnd: V3): void {
    const bs = deckHalfBeam(x);
    // Legs over the rail only for the trimmers, only when hiking hard.
    const over = role === 'trim' ? smooth(0.78, 0.95, a) : 0;
    const yMax = role === 'helm' ? bs - 0.16 : bs - 0.05;
    const yIn = COCKPIT.footwellHalf * 0.4;
    const lateral = yIn + (yMax - yIn) * smooth(0, 0.62, a);
    const y = s * Math.min(yMax, lateral + over * 0.05);
    // Seat surface under the hips: sole (crouched), cockpit seat, side deck; blended to avoid pops.
    const onSeat = smooth(COCKPIT.footwellHalf - 0.04, COCKPIT.footwellHalf + 0.04, Math.abs(y));
    const onDeck = smooth(COCKPIT.halfWidth - 0.05, COCKPIT.halfWidth + 0.05, Math.abs(y));
    const seatH = COCKPIT.soleH + (COCKPIT.seatH - COCKPIT.soleH) * onSeat + (deckH(x, Math.abs(y)) - COCKPIT.seatH) * onDeck;
    const crouch = 1 - onSeat;
    const hipH = seatH + 0.1 + crouch * 0.42;

    // Facing: crouched → forward; seated → inboard (helm: forward-inboard); hiking → outboard.
    const inboard = -s;
    const fwdBias = role === 'helm' ? 0.95 : 0.3;
    let fx = inboard * (1 - crouch), fz = -(fwdBias * (1 - crouch) + crouch);
    // Swinging the legs over the rail turns the body through "facing forward", never aft.
    fx = fx * (1 - over) - inboard * over;
    fz = fz * (1 - over) - 0.25 * over - Math.sin(Math.PI * over) * 0.8;
    const yaw = Math.atan2(fx, fz);

    // Torso lean (about the figure's own X; + = forward). Leaning back against the lifeline when
    // sitting to windward, forward over the water when hiking outboard; plus heel compensation.
    const upright = -heel * s; // how far the high side is lifted (rad)
    const faceSign = 1 - 2 * over;
    const leanBack = role === 'helm' ? 0.12 + 0.1 * a : 0.08 + 0.3 * smooth(0.45, 0.78, a) * (1 - over);
    let lean = -leanBack * (1 - crouch) + 0.4 * crouch + over * 0.28 - faceSign * 0.55 * upright;
    lean = THREE.MathUtils.clamp(lean, -0.7, 0.7);

    const W = f.world;
    const root = W[J.hips];
    root.makeRotationY(yaw);
    root.setPosition(y, hipH, -x);

    // Legs: seated → thighs level, shins 30° forward; crouched → thighs down 25°, shins back.
    const hipFlex = -Math.PI / 2 * (1 - crouch) + -1.15 * crouch;
    const knee = (Math.PI / 3) * (1 - crouch) + 2.05 * crouch;
    const splay = 0.14;
    this.local(W, J.thighL, root, 0.095, -0.02, 0, hipFlex, 0, splay);
    this.local(W, J.shinL, W[J.thighL], 0, -SEG.thigh, 0, knee, 0, -splay * 0.5);
    this.local(W, J.thighR, root, -0.095, -0.02, 0, hipFlex, 0, -splay);
    this.local(W, J.shinR, W[J.thighR], 0, -SEG.thigh, 0, knee, 0, splay * 0.5);

    // Torso and head (head turned toward the sails when facing inboard).
    this.local(W, J.torso, root, 0, 0.09, 0, lean, 0, 0);
    // Trimmers facing inboard turn their heads toward the bow (figure +X is their left).
    const look = (role === 'helm' ? 0.15 : 0.55) * (1 - over) * (1 - crouch) * s;
    this.local(W, J.head, W[J.torso], 0, 0.5, 0, -lean * 0.4 - 0.08, look, 0);

    // Arms: shoulders from the torso; hands rest on the thighs (IK); the helmsman's inboard hand holds
    // the tiller extension.
    this.local(W, J.armL, W[J.torso], 0.2, 0.44, 0, -0.3, 0, 0.1);
    this.local(W, J.foreL, W[J.armL], 0, -SEG.upper, 0, -1.0, 0, 0);
    this.local(W, J.armR, W[J.torso], -0.2, 0.44, 0, -0.3, 0, -0.1);
    this.local(W, J.foreR, W[J.armR], 0, -SEG.upper, 0, -1.0, 0, 0);
    const shL = new THREE.Vector3().setFromMatrixPosition(W[J.armL]);
    const shR = new THREE.Vector3().setFromMatrixPosition(W[J.armR]);
    let tillerArm = -1;
    if (role === 'helm') tillerArm = shL.distanceToSquared(tillerEnd) < shR.distanceToSquared(tillerEnd) ? J.armL : J.armR;
    for (const [arm, fore, thigh, sh, sx] of [[J.armL, J.foreL, J.thighL, shL, 1], [J.armR, J.foreR, J.thighR, shR, -1]] as const) {
      const outward = new THREE.Vector3(sx, 0, 0).transformDirection(W[J.hips]);
      if (arm === tillerArm) {
        const toTiller = tillerEnd.clone().sub(sh);
        const reach = Math.min(0.46, Math.max(0.2, toTiller.length() - 0.25));
        this.hand.copy(sh).addScaledVector(toTiller.normalize(), reach);
        this.ik(W, arm, fore, sh, this.hand, _n.set(0, -1, 0).addScaledVector(outward, 0.8).normalize());
        continue;
      }
      // Rest the glove on top of the thigh, two thirds of the way to the knee.
      const hip = new THREE.Vector3().setFromMatrixPosition(W[thigh]);
      const along = new THREE.Vector3(0, -1, 0).transformDirection(W[thigh]);
      const up = new THREE.Vector3(0, 0, -1).transformDirection(W[thigh]);
      const target = hip.addScaledVector(along, SEG.thigh * (0.62 + 0.06 * sx)).addScaledVector(up, 0.1).addScaledVector(outward, 0.02);
      this.ik(W, arm, fore, sh, target, _n.set(0, -0.4, 0).addScaledVector(outward, 1).normalize());
    }
  }

  /** Joint world matrix = parent × T(x,y,z) × R(rx, ry, rz) (order YXZ). */
  private local(W: THREE.Matrix4[], j: number, parent: THREE.Matrix4, x: number, y: number, z: number, rx: number, ry: number, rz: number): void {
    _e.set(rx, ry, rz, 'YXZ');
    _m.makeRotationFromEuler(_e).setPosition(x, y, z);
    W[j].multiplyMatrices(parent, _m);
  }

  /** Two-bone IK: upper and fore segments reach `target` from `shoulder`, elbow toward `pole`. */
  private ik(W: THREE.Matrix4[], jUpper: number, jFore: number, shoulder: V3, target: V3, pole: V3): void {
    const a = SEG.upper, b = SEG.fore + 0.04;
    const d = target.clone().sub(shoulder);
    const dist = THREE.MathUtils.clamp(d.length(), 0.05, a + b - 1e-3);
    const dir = d.normalize();
    // Angle at the shoulder between the reach line and the upper arm.
    const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
    const angA = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
    const side = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    const upperDir = dir.clone().multiplyScalar(Math.cos(angA)).addScaledVector(side, Math.sin(angA));
    const elbow = shoulder.clone().addScaledVector(upperDir, a);
    const foreDir = target.clone().sub(elbow).normalize();
    _q.setFromUnitVectors(DOWN, upperDir);
    W[jUpper].makeRotationFromQuaternion(_q).setPosition(shoulder);
    _q.setFromUnitVectors(DOWN, foreDir);
    W[jFore].makeRotationFromQuaternion(_q).setPosition(elbow);
  }

  private write(): void {
    const out = this.pos.array as Float32Array, outN = this.nor.array as Float32Array;
    const nm = _nm;
    for (const f of this.figures) {
      let v = f.offset;
      for (const pd of f.parts) {
        const m = f.world[pd.joint];
        nm.setFromMatrix4(m);
        const e = m.elements, ne = nm.elements;
        const cnt = pd.geo.getAttribute('position').count;
        for (let i = 0; i < cnt; i++, v++) {
          const x = this.base[v * 3], y = this.base[v * 3 + 1], z = this.base[v * 3 + 2];
          out[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          out[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          out[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
          const nx = this.baseN[v * 3], ny = this.baseN[v * 3 + 1], nz = this.baseN[v * 3 + 2];
          outN[v * 3] = ne[0] * nx + ne[3] * ny + ne[6] * nz;
          outN[v * 3 + 1] = ne[1] * nx + ne[4] * ny + ne[7] * nz;
          outN[v * 3 + 2] = ne[2] * nx + ne[5] * ny + ne[8] * nz;
        }
      }
    }
    this.pos.needsUpdate = true;
    this.nor.needsUpdate = true;
  }
}

