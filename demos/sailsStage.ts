// Boats and water for the sails demo. By default the real Kestrel 25 (src/render/boat) carries the sails,
// posed from the snapshot the way App does it; ?boat=stand swaps in the original stand-in (a lofted hull
// with boot stripe, deck and cabin, mast, boom, rigging, furler foil, pole and sheets). The water is a
// rippled plane either way — just enough that screenshots read as a keelboat under sail.
import * as THREE from 'three';
import { BOAT } from '../src/shared/boatSpec';
import type { SimSnapshot } from '../src/sim/types';
import type { QualitySettings } from '../src/render/core/types';
import { BoatModel } from '../src/render/boat/BoatModel';

const H = BOAT.hull;
const local = (x: number, y: number, h: number): THREE.Vector3 => new THREE.Vector3(y, h, -x);

function sheerH(x: number): number {
  const f = H.freeboard;
  const pts: Array<[number, number]> = [[H.transomDeck.x, f.stern], [f.minX, f.min], [BOAT.mast.x, f.mast], [H.stemDeck.x, f.bow]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!;
    if (x <= x1) { const t = (x - x0) / (x1 - x0); return y0 + (y1 - y0) * (t * t * (3 - 2 * t)); }
  }
  return f.bow;
}

function halfBeam(x: number): number {
  const mid = H.maxBeamX, b = H.beam / 2;
  if (x >= mid) { const t = (x - mid) / (H.stemDeck.x - mid); return b * Math.sqrt(Math.max(0, 1 - t ** 2.2)); }
  const t = (mid - x) / (mid - H.transomDeck.x);
  return b * (1 - 0.24 * t * t);
}

/** Height of the hull's bottom centreline (canoe body only). */
function keelH(x: number): number {
  if (x > H.stemWL.x) return ((x - H.stemWL.x) / (H.stemDeck.x - H.stemWL.x)) * H.stemDeck.h * 0.98;
  const t = (x - 0.3) / (x > 0.3 ? H.stemWL.x - 0.3 : 0.3 - H.transomDeck.x);
  return -H.canoeDraft * (1 - Math.min(1, Math.abs(t)) ** 2) + (x < 0.3 ? 0.14 * Math.abs(t) ** 3 : 0);
}

function hullGeometry(): THREE.BufferGeometry {
  const NX = 64, NP = 22;
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= NX; i++) {
    const x = H.transomDeck.x + ((H.stemDeck.x - H.transomDeck.x) * i) / NX;
    const b = halfBeam(x), sh = sheerH(x), kz = keelH(x);
    for (let j = 0; j <= NP * 2; j++) {
      const phi = ((j - NP) / NP) * (Math.PI / 2);
      const s = Math.sign(phi), a = Math.abs(phi);
      const y = s * b * Math.pow(Math.sin(a), 0.45);
      const h = kz + (sh - kz) * (1 - Math.cos(a));
      pos.push(y, h, -x);
    }
  }
  const row = NP * 2 + 1;
  for (let i = 0; i < NX; i++) for (let j = 0; j < row - 1; j++) {
    const a = i * row + j, b = a + row;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // Transom: a fan from its centre across the aft-most section, facing aft.
  const c = pos.length / 3;
  const x0 = H.transomDeck.x;
  pos.push(0, (sheerH(x0) + keelH(x0)) / 2, -x0);
  for (let j = 0; j < row - 1; j++) idx.push(c, j, j + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function deckGeometry(): THREE.BufferGeometry {
  const NX = 64, pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= NX; i++) {
    const x = H.transomDeck.x + ((H.stemDeck.x - H.transomDeck.x) * i) / NX;
    const b = halfBeam(x) * 0.985, sh = sheerH(x);
    for (let j = 0; j <= 8; j++) {
      const y = -b + (2 * b * j) / 8;
      pos.push(y, sh + H.deckCamber * (1 - (y / (b || 1)) ** 2), -x);
    }
  }
  for (let i = 0; i < NX; i++) for (let j = 0; j < 8; j++) {
    const a = i * 9 + j, b = a + 9;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A thin cylinder stretched between two points (rope, wire, spar). */
class Stick {
  readonly mesh: THREE.Mesh;
  constructor(radius: number, material: THREE.Material, parent: THREE.Object3D) {
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 8, 1), material);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }
  set(a: THREE.Vector3, b: THREE.Vector3): void {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    this.mesh.position.copy(a).addScaledVector(d, 0.5);
    this.mesh.scale.set(1, Math.max(len, 1e-4), 1);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  }
}

function rippleNormals(): THREE.DataTexture {
  const N = 256, d = new Uint8Array(N * N * 4);
  const waves = Array.from({ length: 14 }, (_, k) => ({ a: Math.random() * Math.PI * 2, f: 2 + (k % 7) * 1.3, p: Math.random() * 6, amp: 1 / (1 + k * 0.35) }));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let dx = 0, dy = 0;
    for (const w of waves) {
      const kx = Math.cos(w.a) * w.f, ky = Math.sin(w.a) * w.f;
      const c = Math.cos(((x * Math.round(kx)) / N + (y * Math.round(ky)) / N) * Math.PI * 2 + w.p) * w.amp;
      dx += c * Math.round(kx); dy += c * Math.round(ky);
    }
    const k = (y * N + x) * 4, s = 0.012;
    const nx = -dx * s, ny = -dy * s, l = Math.hypot(nx, ny, 1);
    d[k] = (nx / l * 0.5 + 0.5) * 255; d[k + 1] = (ny / l * 0.5 + 0.5) * 255; d[k + 2] = (1 / l * 0.5 + 0.5) * 255; d[k + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(900, 900);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** What the demo knows about the boat beyond the sails (the mock has no helm or crew of its own). */
export interface DemoPose {
  /** Heel (rad, + starboard down). */
  heel: number;
  /** Rudder (rad, + turns to starboard). */
  rudder: number;
  /** Crew −1 port … +1 starboard. */
  crewY: number;
  /** Sheet trim 0 eased … 1 hard in. */
  sheets: { main: number; jib: number; spin: number };
}

export interface DemoBoat {
  update(s: SimSnapshot['sails'], dt: number, pose: DemoPose): void;
}

/** The dark rippled sea plane. */
export function makeWater(scene: THREE.Scene, prod = false): THREE.Mesh {
  // In the production path the water matches demos/env.ts (dark, glossy, ior 1.333, unfogged).
  const waterMat = prod
    ? new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(0.004, 0.016, 0.022, THREE.LinearSRGBColorSpace), roughness: 0.12, metalness: 0, ior: 1.333, normalMap: rippleNormals(), normalScale: new THREE.Vector2(0.55, 0.55), fog: false })
    : new THREE.MeshPhysicalMaterial({ color: 0x06243b, roughness: 0.06, metalness: 0, normalMap: rippleNormals(), normalScale: new THREE.Vector2(0.55, 0.55) });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), waterMat);
  water.receiveShadow = true;
  scene.add(water);
  return water;
}

/** The real boat model, posed from the snapshot as App does (setPose, then update, before the sails). */
export class RealBoat implements DemoBoat {
  readonly model: BoatModel;
  constructor(boat: THREE.Group, q: QualitySettings) {
    this.model = new BoatModel(q);
    boat.add(this.model.root);
  }
  update(s: SimSnapshot['sails'], dt: number, pose: DemoPose): void {
    const sp = s.spinnaker;
    this.model.setPose({
      boomAngle: s.main.boomAngle,
      rudder: pose.rudder,
      jibClew: s.jib.clew,
      jibFurl: s.jib.furl,
      spin: { visible: sp.set, poleAngle: sp.poleAngle, poleTipH: sp.poleHeight, tack: sp.tack, clew: sp.clew },
      crewY: pose.crewY,
      heel: pose.heel,
      sheets: pose.sheets,
    });
    this.model.update(dt);
  }
}

/** The original stand-in boat (?boat=stand). */
export class StandInBoat implements DemoBoat {
  private readonly boom = new THREE.Group();
  private readonly pole: Stick;
  private readonly jibSheet: Stick;
  private readonly mainSheet: Stick;
  private readonly spinSheet: Stick;
  private readonly spinGuy: Stick;

  constructor(boat: THREE.Group) {
    const gel = new THREE.MeshPhysicalMaterial({ color: 0xf3f3f0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 });
    gel.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying float vH;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vH;')
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (vH < 0.16) diffuseColor.rgb = vH < 0.02 ? vec3(0.05, 0.055, 0.06) : vec3(0.02, 0.04, 0.1);');
    };
    const hull = new THREE.Mesh(hullGeometry(), gel);
    hull.castShadow = hull.receiveShadow = true;
    const deckMat = new THREE.MeshStandardMaterial({ color: 0xb7b9b6, roughness: 0.92 });
    const deck = new THREE.Mesh(deckGeometry(), deckMat);
    deck.receiveShadow = deck.castShadow = true;
    // Cabin trunk and cockpit well.
    const c = BOAT.cabin;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry((c.widthAft + c.widthFwd) / 2, 0.36, c.xFwd - c.xAft), gel);
    cabin.position.copy(local((c.xFwd + c.xAft) / 2, 0, sheerH(0.3) + 0.2));
    cabin.castShadow = cabin.receiveShadow = true;
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b0f14, roughness: 0.05, metalness: 0.2 });
    for (const s of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.12, 1.3), glass);
      win.position.copy(local(0.4, s * ((c.widthAft + c.widthFwd) / 4 + 0.004), sheerH(0.3) + 0.24));
      boat.add(win);
    }
    boat.add(hull, deck, cabin);

    // Mast (elliptical, tapered), spreaders, rigging.
    const alu = new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 0.85, roughness: 0.32 });
    const m = BOAT.mast;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(m.sectionTop[0] / 2, m.sectionBase[0] / 2, m.topH - m.baseH, 20), alu);
    mast.scale.x = m.sectionBase[1] / m.sectionBase[0];
    mast.position.copy(local(m.x, 0, (m.topH + m.baseH) / 2));
    mast.castShadow = mast.receiveShadow = true;
    boat.add(mast);
    const wire = new THREE.MeshStandardMaterial({ color: 0xd5d9de, metalness: 1, roughness: 0.25 });
    const sp = BOAT.spreaders;
    for (const s of [-1, 1]) {
      const tip = local(m.x - Math.sin((sp.sweepDeg * Math.PI) / 180) * sp.length, s * sp.length, sp.h);
      new Stick(0.012, alu, boat).set(local(m.x, 0, sp.h), tip);
      new Stick(0.0032, wire, boat).set(local(BOAT.chainplates.x, s * BOAT.chainplates.y, BOAT.chainplates.h), tip);
      new Stick(0.0032, wire, boat).set(tip, local(m.x, s * 0.03, m.topH - 0.35));
      new Stick(0.0028, wire, boat).set(local(BOAT.chainplates.x + 0.05, s * BOAT.chainplates.y, BOAT.chainplates.h), local(m.x, s * 0.03, sp.h - 0.05));
    }
    const fs = BOAT.forestay, bs = BOAT.backstay;
    new Stick(0.003, wire, boat).set(local(fs.tack.x, 0, fs.tack.h), local(fs.head.x, 0, fs.head.h));
    new Stick(0.014, new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.8, roughness: 0.35 }), boat)
      .set(local(BOAT.jib.tack.x, 0, BOAT.jib.tack.h - 0.1), local(BOAT.jib.head.x, 0, BOAT.jib.head.h + 0.05));
    new Stick(0.003, wire, boat).set(local(bs.top.x, 0, bs.top.h), local(bs.bottom.x, 0, bs.bottom.h));

    // Boom (rotates about the gooseneck), with vang.
    const g = BOAT.boom.gooseneck;
    this.boom.position.copy(local(g.x, 0, g.h));
    const boomBar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, BOAT.boom.length), alu);
    boomBar.position.set(0, -0.01, BOAT.boom.length / 2);
    boomBar.castShadow = true;
    this.boom.add(boomBar);
    boat.add(this.boom);

    const rope = new THREE.MeshStandardMaterial({ color: 0x1f4fb0, roughness: 0.8 });
    const red = new THREE.MeshStandardMaterial({ color: 0xb02a1f, roughness: 0.8 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xe8661f, roughness: 0.8 });
    this.pole = new Stick(0.025, alu, boat);
    this.jibSheet = new Stick(0.0055, red, boat);
    this.mainSheet = new Stick(0.006, rope, boat);
    this.spinSheet = new Stick(0.005, orange, boat);
    this.spinGuy = new Stick(0.005, orange, boat);
  }

  update(s: SimSnapshot['sails']): void {
    this.boom.rotation.y = -s.main.boomAngle;
    const L = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.y, -p.z, -p.x);
    const jc = L(s.jib.clew);
    const leadSide = s.jib.clewAngle >= 0 ? -1 : 1;
    this.jibSheet.mesh.visible = s.jib.set;
    this.jibSheet.set(jc, local(-0.1, -leadSide * BOAT.jib.lead.y, BOAT.jib.lead.h));
    const tr = BOAT.boom.traveler;
    const g = BOAT.boom.gooseneck;
    const end = new THREE.Vector3(Math.sin(-s.main.boomAngle) * BOAT.boom.sheetAttach, g.h - 0.06, -g.x + Math.cos(s.main.boomAngle) * BOAT.boom.sheetAttach);
    this.mainSheet.set(end, local(tr.x, 0, tr.h + 0.05));
    const sp = s.spinnaker;
    const up = sp.set;
    for (const st of [this.pole, this.spinSheet, this.spinGuy]) st.mesh.visible = up;
    if (up) {
      const tack = L(sp.tack), clew = L(sp.clew);
      this.pole.set(local(BOAT.mast.x + 0.07, 0, BOAT.spinnaker.poleMastH), tack);
      const lee = sp.tack.y >= 0 ? -1 : 1;
      this.spinSheet.set(clew, local(BOAT.spinnaker.sheetBlock.x, lee * BOAT.spinnaker.sheetBlock.y, BOAT.spinnaker.sheetBlock.h));
      this.spinGuy.set(tack, local(BOAT.spinnaker.guyBlock.x, -lee * BOAT.spinnaker.guyBlock.y, BOAT.spinnaker.guyBlock.h));
    }
  }
}

/** Camera presets in boat-local coordinates; `lee` = +1 when the leeward side is starboard. */
export function cameraPreset(name: string, lee: number): { pos: THREE.Vector3; target: THREE.Vector3; fov: number } {
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  switch (name) {
    case 'helm': return { pos: P(-lee * 1.02, 1.55, 2.2), target: P(lee * 0.25, 4.6, -2.75), fov: 50 };
    case 'astern': return { pos: P(lee * 4.6, 1.5, 7.2), target: P(lee * 0.8, 5.6, -0.6), fov: 50 };
    case 'quarter': return { pos: P(lee * 7.5, 1.1, 8.5), target: P(lee * 0.8, 4.6, -0.8), fov: 50 };
    case 'under': return { pos: P(lee * 1.35, 1.45, 1.4), target: P(lee * 0.4, 7.2, -0.6), fov: 60 };
    case 'side': return { pos: P(lee * 17, 4.4, -0.6), target: P(0, 5.0, -0.6), fov: 45 };
    case 'windward': return { pos: P(-lee * 17, 4.4, -0.6), target: P(0, 5.0, -0.6), fov: 45 };
    case 'bow': return { pos: P(lee * 6.5, 2.6, -13), target: P(0, 5.2, -1), fov: 45 };
    case 'spin': return { pos: P(lee * 10, 3.2, -15), target: P(lee * 1.2, 5.4, -3), fov: 45 };
    case 'spinluff': return { pos: P(-lee * 6.5, 2.4, -13), target: P(-lee * 0.6, 5.6, -3.2), fov: 45 };
    case 'spinside': return { pos: P(lee * 16, 3.8, -6), target: P(lee * 0.5, 5.4, -2.5), fov: 45 };
    case 'jib': return { pos: P(lee * 9.5, 2.6, -11.5), target: P(lee * 0.6, 4.6, -1.8), fov: 45 };
    case 'mainleech': return { pos: P(lee * 3.2, 5.2, 4.6), target: P(lee * 0.5, 5.4, 0.9), fov: 45 };
    case 'windex': return { pos: P(lee * 1.2, 10.0, 0.9), target: P(0, 10.45, -1.1), fov: 30 };
    case 'sailview': return { pos: P(0.02, 2.35, 1.6), target: P(0, 9.2, -0.95), fov: 72 };
    case 'telltales': return { pos: P(-lee * 1.02, 1.55, 2.2), target: P(lee * 0.05, 5.0, -2.35), fov: 16 };
    case 'leech': return { pos: P(lee * 6.5, 3.2, 7.5), target: P(lee * 0.5, 5.6, 1.2), fov: 24 };
    case 'telltale': return { pos: P(lee * 1.6, 5.2, -0.8), target: P(0, 5.3, -2.5), fov: 45 };
    case 'top': return { pos: P(lee * 3, 14, 2), target: P(0, 5, -1), fov: 50 };
    default: return { pos: P(lee * 11, 4.2, 10), target: P(0, 5, -0.8), fov: 45 };
  }
}
