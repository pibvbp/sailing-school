// Stand-in scene for the overlays demo: a calm sea plane, a simple Kestrel-25-sized hull with keel and rudder, the
// mast, boom, pole and stays, and the sails built straight from the simulation's strip sections (translucent cloth
// plus the section lines themselves) — so the flow overlays can be judged against exactly what the physics uses.
// The real ocean, boat and sails are other modules; nothing here is used by the app.
import * as THREE from 'three';
import { BOAT } from '../src/shared/boatSpec';
import type { SailState, SimSnapshot } from '../src/sim/types';
import { CAMBER_PTS, newSliceElement, sailCutAt } from '../src/render/overlays/flowField';

const local = (x: number, y: number, h: number): THREE.Vector3 => new THREE.Vector3(y, h, -x);
const H = BOAT.hull;

function sheer(x: number): number {
  const f = H.freeboard;
  const pts: Array<[number, number]> = [[H.transomDeck.x, f.stern], [f.minX, f.min], [BOAT.mast.x, f.mast], [H.stemDeck.x, f.bow]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!;
    if (x <= x1) { const t = (x - x0) / (x1 - x0); return y0 + (y1 - y0) * t * t * (3 - 2 * t); }
  }
  return f.bow;
}
function halfBeam(x: number): number {
  const b = H.beam / 2;
  if (x >= H.maxBeamX) { const t = (x - H.maxBeamX) / (H.stemDeck.x - H.maxBeamX); return b * Math.sqrt(Math.max(0, 1 - t ** 2.3)); }
  const t = (H.maxBeamX - x) / (H.maxBeamX - H.transomDeck.x);
  return b * (1 - 0.22 * t * t);
}
function bottom(x: number): number {
  if (x > H.stemWL.x) return ((x - H.stemWL.x) / (H.stemDeck.x - H.stemWL.x)) * H.stemDeck.h * 0.95;
  const t = x > 0.3 ? (x - 0.3) / (H.stemWL.x - 0.3) : (0.3 - x) / (0.3 - H.transomDeck.x);
  return -H.canoeDraft * (1 - Math.min(1, t) ** 2) + (x < 0.3 ? 0.12 * t ** 3 : 0);
}

function hullGeometry(): THREE.BufferGeometry {
  const NX = 60, NP = 18, pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= NX; i++) {
    const x = H.transomDeck.x + ((H.stemDeck.x - H.transomDeck.x) * i) / NX;
    const b = halfBeam(x), sh = sheer(x), kz = bottom(x);
    for (let j = 0; j <= 2 * NP; j++) {
      const a = ((j - NP) / NP) * (Math.PI / 2);
      const y = Math.sign(a) * b * Math.pow(Math.sin(Math.abs(a)), 0.5);
      const h = kz + (sh - kz) * (1 - Math.cos(a));
      pos.push(y, h, -x);
    }
  }
  const row = 2 * NP + 1;
  for (let i = 0; i < NX; i++) for (let j = 0; j < row - 1; j++) { const a = i * row + j, b = a + row; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  // Transom and deck.
  const base = pos.length / 3;
  const deckStart = base;
  for (let i = 0; i <= NX; i++) {
    const x = H.transomDeck.x + ((H.stemDeck.x - H.transomDeck.x) * i) / NX;
    const b = halfBeam(x) * 0.99, sh = sheer(x);
    pos.push(-b, sh, -x, b, sh, -x);
  }
  for (let i = 0; i < NX; i++) { const a = deckStart + 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function foil(rootX: number, rootH: number, rootChord: number, tipH: number, tipChord: number, sweepDeg: number, thick: number): THREE.BufferGeometry {
  const sweep = Math.tan((sweepDeg * Math.PI) / 180) * (rootH - tipH);
  const p = [
    local(rootX, -thick, rootH), local(rootX - rootChord, -thick * 0.3, rootH), local(rootX - sweep - tipChord, -thick * 0.3, tipH), local(rootX - sweep, -thick, tipH),
    local(rootX, thick, rootH), local(rootX - rootChord, thick * 0.3, rootH), local(rootX - sweep - tipChord, thick * 0.3, tipH), local(rootX - sweep, thick, tipH),
  ];
  const g = new THREE.BufferGeometry().setFromPoints(p);
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2]);
  g.computeVertexNormals();
  return g;
}

function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8, 1), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.castShadow = true;
  return m;
}

/** Procedural ripple normal map for the sea plane. */
function rippleNormals(): THREE.CanvasTexture {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  const hgt = (x: number, y: number) => {
    let v = 0;
    for (let k = 1; k <= 5; k++) {
      const f = (2 * Math.PI * k * (k % 2 ? 3 : 2)) / n;
      v += Math.sin(x * f + k * 1.7 + Math.sin(y * f * 0.7 + k)) * Math.cos(y * f * 1.3 + k * 0.4) / k;
    }
    return v;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = hgt(x + 1, y) - hgt(x - 1, y), dy = hgt(x, y + 1) - hgt(x, y - 1);
    const l = Math.hypot(dx * 0.6, dy * 0.6, 1);
    const o = 4 * (y * n + x);
    img.data[o] = 128 + (127 * -dx * 0.6) / l;
    img.data[o + 1] = 128 + (127 * -dy * 0.6) / l;
    img.data[o + 2] = 128 + 127 / l;
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(900, 900);
  t.anisotropy = 8;
  return t;
}

class SailSurface {
  readonly mesh: THREE.Mesh;
  readonly lines: THREE.LineSegments;
  private readonly rows = 26;
  private readonly valid = new Uint8Array(26);
  private readonly el = newSliceElement();
  private readonly geo = new THREE.BufferGeometry();
  private readonly lineGeo = new THREE.BufferGeometry();

  constructor(mat: THREE.Material, lineMat: THREE.LineBasicMaterial) {
    const verts = this.rows * CAMBER_PTS;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const idx: number[] = [];
    for (let r = 0; r < this.rows - 1; r++) for (let k = 0; k < CAMBER_PTS - 1; k++) {
      const a = r * CAMBER_PTS + k, b = a + CAMBER_PTS;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * (CAMBER_PTS - 1) * 2 * 3), 3));
    this.lines = new THREE.LineSegments(this.lineGeo, lineMat);
  }

  update(sail: SailState): void {
    const secs = sail.sections;
    if (!sail.set || secs.length < 2) { this.mesh.visible = this.lines.visible = false; return; }
    const hA = -secs[0]!.luff.z, hB = -secs[secs.length - 1]!.luff.z;
    const step = (hB - hA) / (secs.length - 1);
    const h0 = hA - 0.45 * step, h1 = hB + 0.45 * step;
    const pos = this.geo.attributes['position'] as THREE.BufferAttribute;
    const valid = this.valid;
    let firstValid = -1;
    for (let r = 0; r < this.rows; r++) {
      const h = h0 + ((h1 - h0) * r) / (this.rows - 1);
      valid[r] = sailCutAt(sail, h, this.el) ? 1 : 0;
      if (!valid[r]) continue;
      if (firstValid < 0) firstValid = r;
      for (let k = 0; k < CAMBER_PTS; k++) pos.setXYZ(r * CAMBER_PTS + k, this.el.pts[2 * k + 1]!, h, -this.el.pts[2 * k]!);
    }
    const visible = firstValid >= 0;
    // Rows the sail does not reach collapse onto the nearest valid one (no stray triangles).
    let src = firstValid;
    for (let r = 0; r < this.rows && visible; r++) {
      if (valid[r]) { src = r; continue; }
      for (let k = 0; k < CAMBER_PTS; k++) {
        const a = src * CAMBER_PTS + k;
        pos.setXYZ(r * CAMBER_PTS + k, pos.getX(a), pos.getY(a), pos.getZ(a));
      }
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this.mesh.visible = visible;
    // Section lines exactly at the strip sections.
    const lp = this.lineGeo.attributes['position'] as THREE.BufferAttribute;
    let v = 0;
    for (const sec of secs) {
      if (v + 2 * (CAMBER_PTS - 1) > lp.count) break;
      if (!sailCutAt(sail, -sec.luff.z, this.el)) continue;
      const h = -sec.luff.z;
      for (let k = 0; k < CAMBER_PTS - 1; k++) {
        lp.setXYZ(v++, this.el.pts[2 * k + 1]!, h, -this.el.pts[2 * k]!);
        lp.setXYZ(v++, this.el.pts[2 * k + 3]!, h, -this.el.pts[2 * k + 2]!);
      }
    }
    this.lineGeo.setDrawRange(0, v);
    lp.needsUpdate = true;
    this.lines.visible = visible;
  }
}

export class Stage {
  readonly boat = new THREE.Group();
  private readonly boom: THREE.Mesh;
  private readonly pole: THREE.Mesh;
  private readonly sails: SailSurface[];
  private readonly marks = new THREE.Group();

  constructor(scene: THREE.Scene) {
    // Sea.
    const sea = new THREE.Mesh(
      new THREE.CircleGeometry(6000, 96).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0b2a45, roughness: 0.12, metalness: 0, normalMap: rippleNormals(), normalScale: new THREE.Vector2(0.35, 0.35) }),
    );
    sea.renderOrder = -100;
    sea.receiveShadow = true;
    scene.add(sea, this.marks);

    this.boat.rotation.order = 'YXZ';
    scene.add(this.boat);
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.6 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xc9cfd6, roughness: 0.3, metalness: 0.8 });
    const hull = new THREE.Mesh(hullGeometry(), white);
    hull.castShadow = hull.receiveShadow = true;
    const k = BOAT.keel, r = BOAT.rudder;
    const keel = new THREE.Mesh(foil(k.rootLEX, k.rootH + 0.1, k.rootChord, k.tipH, k.tipChord, k.sweepDeg, 0.06), dark);
    const rudder = new THREE.Mesh(foil(r.stockX + 0.1, r.rootH + 0.1, r.rootChord, r.tipH, r.tipChord, 6, 0.024), dark);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.34, BOAT.cabin.xFwd - BOAT.cabin.xAft), white);
    cabin.position.copy(local((BOAT.cabin.xFwd + BOAT.cabin.xAft) / 2, 0, 0.93));
    cabin.castShadow = true;
    const m = BOAT.mast;
    const mast = tube(local(m.x, 0, m.baseH - 0.4), local(m.x, 0, m.topH), 0.055, metal);
    const stay = new THREE.LineBasicMaterial({ color: 0x9aa4ae });
    const line = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), stay);
    const f = BOAT.forestay, bs = BOAT.backstay, cp = BOAT.chainplates, sp = BOAT.spreaders;
    this.boat.add(hull, keel, rudder, cabin, mast,
      line(local(f.tack.x, 0, f.tack.h), local(f.head.x, 0, f.head.h)),
      line(local(bs.bottom.x, 0, bs.bottom.h), local(bs.top.x, 0, bs.top.h)),
      line(local(cp.x, cp.y, cp.h), local(m.x, sp.length, sp.h)), line(local(m.x, sp.length, sp.h), local(m.x, 0, m.topH - 0.2)),
      line(local(cp.x, -cp.y, cp.h), local(m.x, -sp.length, sp.h)), line(local(m.x, -sp.length, sp.h), local(m.x, 0, m.topH - 0.2)));
    // Boom: pivots at the gooseneck, points aft (+Z local).
    const boomPivot = new THREE.Group();
    boomPivot.position.copy(local(BOAT.boom.gooseneck.x, 0, BOAT.boom.gooseneck.h));
    this.boom = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, BOAT.boom.length, 8).rotateX(Math.PI / 2).translate(0, 0, BOAT.boom.length / 2), metal);
    this.boom.castShadow = true;
    boomPivot.add(this.boom);
    this.boat.add(boomPivot);
    this.boom.userData['pivot'] = boomPivot;
    // Spinnaker pole: unit-length cylinder along +Y from its base, stretched and aimed every frame.
    this.pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8).translate(0, 0.5, 0), metal);
    this.pole.castShadow = true;
    this.pole.visible = false;
    this.boat.add(this.pole);

    const cloth = new THREE.MeshStandardMaterial({ color: 0xf3efe6, roughness: 0.85, side: THREE.DoubleSide, transparent: true, opacity: 0.78 });
    const spinCloth = new THREE.MeshStandardMaterial({ color: 0xf2a25a, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.72 });
    const lines = new THREE.LineBasicMaterial({ color: 0x6b7f94, transparent: true, opacity: 0.8 });
    this.sails = [new SailSurface(cloth, lines), new SailSurface(cloth, lines), new SailSurface(spinCloth, lines)];
    for (const s of this.sails) this.boat.add(s.mesh, s.lines);
  }

  update(s: SimSnapshot): void {
    this.boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
    this.boat.rotation.set(0, -s.boat.heading, -s.boat.heel);
    const pivot = this.boom.userData['pivot'] as THREE.Group;
    // Boom angle + out to port; the boom points aft (+Z local) and swings toward −X (port) for + angles.
    pivot.rotation.y = -s.sails.main.boomAngle;
    this.sails[0]!.update(s.sails.main);
    this.sails[1]!.update(s.sails.jib);
    this.sails[2]!.update(s.sails.spinnaker);
    const sp = s.sails.spinnaker;
    this.pole.visible = sp.set;
    if (sp.set) {
      const a = local(BOAT.mast.x + 0.07, 0, BOAT.spinnaker.poleMastH), b = local(sp.poleTip.x, sp.poleTip.y, -sp.poleTip.z);
      this.pole.position.copy(a);
      this.pole.scale.set(1, a.distanceTo(b), 1);
      this.pole.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    }
  }

  setMarks(marks: { e: number; n: number; kind: string }[]): void {
    this.marks.clear();
    for (const m of marks) {
      const buoy = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 1.5, 20), new THREE.MeshStandardMaterial({ color: m.kind === 'leeward' ? 0xffc21a : 0xff5a14, roughness: 0.5 }));
      buoy.position.set(m.e, 0.55, -m.n);
      buoy.castShadow = true;
      this.marks.add(buoy);
    }
  }
}
