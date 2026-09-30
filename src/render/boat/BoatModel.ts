// The procedural Kestrel 25 (spec §6, §9.5): assembles hull, deck, cabin, cockpit, appendages, rig,
// fittings, running rigging and crew in the boat-local frame (X starboard, Y up, Z aft; origin on the
// centreline at the design waterline at the CG station). Static parts are merged per material;
// the boom, rudder/tiller, spinnaker pole, sheets and crew are driven by setPose().
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOAT } from '../../shared/boatSpec';
import { bodyToLocal } from '../../shared/coords';
import type { Vec3 } from '../../shared/math';
import type { QualitySettings } from '../core/types';
import { buildKeel, buildRudderBlade } from './appendages';
import { buildCabin } from './cabin';
import { buildCockpit } from './cockpit';
import { CrewSet } from './crew';
import { COCKPIT, buildDeck, topSurfaceH } from './deck';
import {
  block, buildFittings, frame, guyBlock, jibLeadPoint, lathe, loc, primaryDrum, quarterBlock, roundedBox, secondaryDrum, v3,
} from './fittings';
import { buildHull, hullLines } from './hull';
import { ROPE, RopeSet, rod, sagSpan, tube, type RopeSpec } from './lines';
import { BoatMaterials, boatDetail, type BuildContext, type MatKey, type Part } from './materials';
import { RIG, buildRig } from './rig';

export interface BoatPose {
  /** Boom angle (rad, + out to port). */
  boomAngle: number;
  /** Rudder angle (rad, + turns the boat to starboard; the tiller swings to port). */
  rudder: number;
  /** Jib clew, body frame (x fwd, y stbd, z down). */
  jibClew: Vec3;
  /** 0 fully out … 1 furled. */
  jibFurl: number;
  /** Spinnaker: pole angle/tip height as in the snapshot; tack and clew in the body frame. */
  spin: { visible: boolean; poleAngle: number; poleTipH: number; tack: Vec3; clew: Vec3 };
  /** Crew lateral position −1 (port) … +1 (starboard). */
  crewY: number;
  /** Heel (rad, + starboard down); used for rope sag and the crew's posture. */
  heel: number;
  /** Sheet trim 0 eased … 1 hard in: how straight the loaded sheets run (eased sheets sag a little). */
  sheets: { main: number; jib: number; spin: number };
}

/** Merge geometries that share a material into one (drops attributes not present in all of them). */
export function mergeParts(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'uv', 'uv1'].filter((n) => geos.every((g) => g.getAttribute(n)));
  for (const g of geos) for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
  const input = geos.every((g) => g.index) ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(input, false);
  if (!merged) throw new Error('boat: geometry merge failed');
  for (const g of geos) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

// Animated rope slots.
const R_MAIN = 0, R_MAIN_TAIL = 4, R_JIB_P = 5, R_JIB_S = 6, R_SPIN_SHEET = 7, R_SPIN_GUY = 8, R_LIFT = 9, R_FOREGUY = 10, R_TRAV_P = 11, R_TRAV_S = 12;

const TR = BOAT.boom.traveler;
const DEG = Math.PI / 180;

export class BoatModel {
  readonly root = new THREE.Group();
  readonly anchors: {
    mastTop: THREE.Vector3;
    gooseneck: THREE.Vector3;
    forestayTack: THREE.Vector3;
    forestayHead: THREE.Vector3;
    boomEnd(angle: number): THREE.Vector3;
  };

  /** Construction cost breakdown (ms): lofting + builders, procedural textures, merging. */
  readonly buildStats = { geometryMs: 0, texturesMs: 0, mergeMs: 0 };
  private readonly materials: BoatMaterials;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly boom = new THREE.Group();
  private readonly rudder = new THREE.Group();
  private readonly pole = new THREE.Group();
  private readonly car = new THREE.Group();
  private readonly furl: THREE.Mesh;
  private readonly extension: THREE.Mesh;
  private readonly ropes: RopeSet;
  private readonly crew: CrewSet;
  private readonly pose: BoatPose;
  private crewY = 0.5;
  private dirty = true;
  /** The first update places the crew directly; afterwards they move at a human pace (frozen when dt = 0). */
  private crewPlaced = false;
  // Scratch.
  private readonly g = new THREE.Vector3();
  private readonly pts: THREE.Vector3[];

  constructor(q: QualitySettings) {
    const detail = boatDetail(q);
    this.root.name = 'Kestrel25';
    let t = performance.now();
    const ctx: BuildContext = { detail, lines: hullLines(detail), pads: [] };
    const rig = buildRig(ctx);
    const staticParts: Part[] = [
      ...buildHull(ctx.lines), ...buildDeck(detail), ...buildCabin(ctx), ...buildCockpit(ctx), ...buildKeel(),
      ...buildFittings(ctx), ...rig.staticParts,
    ];
    this.buildStats.geometryMs = performance.now() - t;
    t = performance.now();
    this.materials = new BoatMaterials(detail, ctx.pads);
    this.buildStats.texturesMs = performance.now() - t;
    t = performance.now();
    this.addParts(this.root, staticParts);

    // Boom (pivots about the mast axis at the gooseneck).
    this.boom.name = 'boom';
    this.boom.position.copy(RIG.gooseneck);
    this.addParts(this.boom, rig.boomParts);
    this.root.add(this.boom);

    // Rudder assembly: blade, stock, head fitting and tiller rotate about the stock.
    this.rudder.name = 'rudder';
    this.rudder.position.copy(loc(BOAT.rudder.stockX, 0, 0));
    this.addParts(this.rudder, this.rudderParts(detail.lathe));
    this.root.add(this.rudder);

    // Spinnaker pole.
    this.pole.name = 'spinnaker-pole';
    this.pole.position.copy(RIG.poleInboard);
    this.addParts(this.pole, rig.poleParts);
    this.pole.visible = false;
    this.root.add(this.pole);

    // Furled jib roll (scaled radially by the furl amount).
    this.furl = new THREE.Mesh(rig.furlGeometry, this.materials.get('furl'));
    this.furl.position.copy(rig.furlBase);
    this.furl.quaternion.setFromUnitVectors(v3(0, 0, 1), rig.furlDir);
    this.furl.castShadow = true;
    this.furl.receiveShadow = true;
    this.geometries.push(rig.furlGeometry);
    this.root.add(this.furl);

    // Traveller car with the mainsheet's lower (fiddle + cam) block.
    this.car.name = 'traveller-car';
    const carParts: Part[] = [
      { geometry: roundedBox(0.075, 0.03, 0.06, 0.01).translate(0, 0.015, 0), mat: 'darkMetal', shadow: true },
      { geometry: roundedBox(0.09, 0.012, 0.03, 0.005).translate(0, 0.005, 0), mat: 'black' },
      ...block(0.055, frame(v3(0, 0.1, 0), v3(0, 1, 0), v3(1, 0, 0)), 2, detail.lathe, 'black'),
      { geometry: roundedBox(0.05, 0.02, 0.045, 0.006).translate(0, 0.045, 0.02), mat: 'black' },
    ];
    this.addParts(this.car, carParts);
    this.root.add(this.car);

    // Tiller extension: carbon tube with grip knob along +Y, stretched to the helmsman's hand.
    const ext = mergeParts([
      tube([v3(0, 0, 0), v3(0, 1, 0)], { radius: 0.0105, radial: 10 }),
      new THREE.SphereGeometry(0.016, 10, 8).translate(0, 1, 0),
    ]);
    this.geometries.push(ext);
    this.extension = new THREE.Mesh(ext, this.materials.get('carbon'));
    this.extension.castShadow = true;
    this.extension.receiveShadow = true;
    this.root.add(this.extension);

    // Animated ropes.
    const n = detail.ropeSamples;
    const specs: RopeSpec[] = [
      { samples: 2, radius: 0.0045, cell: ROPE.mainSheet }, { samples: 2, radius: 0.0045, cell: ROPE.mainSheet },
      { samples: 2, radius: 0.0045, cell: ROPE.mainSheet }, { samples: 2, radius: 0.0045, cell: ROPE.mainSheet },
      { samples: 14, radius: 0.0045, cell: ROPE.mainSheet },
      { samples: n, radius: 0.0048, cell: ROPE.jibPort }, { samples: n, radius: 0.0048, cell: ROPE.jibStbd },
      { samples: n, radius: 0.0042, cell: ROPE.spinnaker }, { samples: n, radius: 0.0042, cell: ROPE.spinnaker },
      { samples: 2, radius: 0.003, cell: ROPE.control }, { samples: 2, radius: 0.003, cell: ROPE.control },
      { samples: 2, radius: 0.0028, cell: ROPE.control }, { samples: 2, radius: 0.0028, cell: ROPE.control },
    ];
    this.ropes = new RopeSet(this.materials.get('rope'), specs, Math.max(5, detail.radial - 2));
    this.ropes.mesh.name = 'running-rigging';
    this.ropes.mesh.receiveShadow = true;
    this.root.add(this.ropes.mesh);
    this.pts = Array.from({ length: Math.max(n, 16) }, () => new THREE.Vector3());

    this.crew = new CrewSet(detail);
    this.crew.object.material = this.materials.get('crew');
    this.root.add(this.crew.object);

    const gooseneck = RIG.gooseneck.clone();
    this.anchors = {
      mastTop: RIG.mastTop.clone(),
      gooseneck,
      forestayTack: RIG.forestayTack.clone(),
      forestayHead: RIG.forestayHead.clone(),
      boomEnd: (angle: number) => gooseneck.clone().add(v3(-Math.sin(angle) * BOAT.boom.length, 0, Math.cos(angle) * BOAT.boom.length)),
    };

    this.buildStats.mergeMs = performance.now() - t;
    this.pose = {
      boomAngle: 0, rudder: 0, jibClew: { x: BOAT.jib.tack.x - 0.4, y: 0, z: -BOAT.jib.clewH }, jibFurl: 1,
      spin: { visible: false, poleAngle: 0, poleTipH: 2.2, tack: { x: 3, y: 0, z: -2 }, clew: { x: 0, y: 0, z: -2 } },
      crewY: 0.5, heel: 0, sheets: { main: 0.5, jib: 0.5, spin: 0.5 },
    };
    this.update(0);
  }

  /** Hide the helmsman (for a camera placed at his eyes); the tiller extension stays. */
  setHelmVisible(visible: boolean): void {
    this.crew.helmVisible = visible;
    this.dirty = true;
  }

  /** Set the pose driven by the simulation (applied on the next update()). */
  setPose(p: BoatPose): void {
    const q = this.pose;
    q.boomAngle = p.boomAngle; q.rudder = p.rudder; q.jibFurl = p.jibFurl; q.crewY = p.crewY; q.heel = p.heel;
    Object.assign(q.jibClew, p.jibClew);
    const s = q.spin, ps = p.spin;
    s.visible = ps.visible; s.poleAngle = ps.poleAngle; s.poleTipH = ps.poleTipH;
    Object.assign(s.tack, ps.tack);
    Object.assign(s.clew, ps.clew);
    Object.assign(q.sheets, p.sheets);
    this.dirty = true;
  }

  update(dt: number): void {
    const p = this.pose;
    // The crew moves at a human pace toward the requested side (a tack takes them ~1.5 s to cross).
    const prevCrew = this.crewY;
    const rate = this.crewPlaced ? 1 - Math.exp(-Math.max(0, dt) / 0.25) : 1;
    this.crewPlaced = true;
    this.crewY += (THREE.MathUtils.clamp(p.crewY, -1, 1) - this.crewY) * rate;
    if (!this.dirty && Math.abs(this.crewY - prevCrew) < 1e-5) return;
    this.dirty = false;

    this.boom.rotation.y = -p.boomAngle;
    this.rudder.rotation.y = p.rudder;
    // Local "down" tilts with heel so slack lines hang toward the true vertical.
    this.g.set(Math.sin(p.heel), -Math.cos(p.heel), 0);

    // Furled roll.
    const f = THREE.MathUtils.clamp(p.jibFurl, 0, 1);
    this.furl.visible = f > 0.02;
    this.furl.scale.set(0.25 + 0.75 * f, 0.25 + 0.75 * f, 1);

    // Traveller car sits under the sheet, limited by the track.
    const end = this.anchors.boomEnd(p.boomAngle);
    const carX = THREE.MathUtils.clamp(end.x * 0.8, -TR.halfWidth + 0.06, TR.halfWidth - 0.06);
    this.car.position.set(carX, COCKPIT.seatH + 0.012, -TR.x);

    this.updateMainsheet(carX);
    this.updateJibSheets();
    this.updateSpinnaker();
    this.updateTravellerLines(carX);

    // Tiller end → helmsman's hand → extension.
    const tillerEnd = this.tillerEnd();
    const hand = this.crew.update(this.crewY, p.heel, tillerEnd);
    const dir = hand.clone().sub(tillerEnd);
    const len = Math.max(0.05, dir.length());
    this.extension.position.copy(tillerEnd);
    this.extension.quaternion.setFromUnitVectors(v3(0, 1, 0), dir.normalize());
    this.extension.scale.set(1, len, 1);

    this.ropes.commit();
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.ropes.dispose();
    this.crew.dispose();
    this.materials.dispose();
  }

  // --- building -------------------------------------------------------------------------------------

  /**
   * Merge parts per material into one mesh each (a bucket casts shadows if any of its parts does; thin
   * wires, lifelines and decals have their own materials and never cast).
   */
  private addParts(target: THREE.Object3D, parts: Part[]): void {
    const buckets = new Map<MatKey, { shadow: boolean; geos: THREE.BufferGeometry[] }>();
    for (const part of parts) {
      let b = buckets.get(part.mat);
      if (!b) { b = { shadow: false, geos: [] }; buckets.set(part.mat, b); }
      b.shadow ||= !!part.shadow;
      b.geos.push(part.geometry);
    }
    for (const [mat, b] of buckets) {
      const geo = mergeParts(b.geos);
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.materials.get(mat));
      mesh.name = `boat-${mat}`;
      mesh.castShadow = b.shadow;
      mesh.receiveShadow = mat !== 'glass' && mat !== 'decal';
      target.add(mesh);
    }
  }

  /** Rudder group frame: origin on the stock at the waterline. */
  private rudderParts(seg: number): Part[] {
    const T = BOAT.tiller;
    const parts: Part[] = [{ geometry: buildRudderBlade(), mat: 'antifouling', shadow: true }];
    // Stock through the bearing, head fitting clamping the tiller.
    parts.push({ geometry: rod(v3(0, T.headH - 0.1, 0), v3(0, T.headH + 0.03, 0), 0.03, 16), mat: 'polished', shadow: true });
    parts.push({ geometry: lathe([[0, 0], [0.042, 0], [0.042, 0.07], [0.034, 0.085], [0, 0.085]], seg).translate(0, T.headH - 0.05, 0), mat: 'brushed', shadow: true });
    for (const s of [-1, 1]) parts.push({ geometry: roundedBox(0.008, 0.07, 0.16, 0.006).translate(s * 0.026, T.headH, -0.07), mat: 'brushed', shadow: true });
    parts.push({ geometry: rod(v3(-0.035, T.headH + 0.01, -0.08), v3(0.035, T.headH + 0.01, -0.08), 0.005, 8), mat: 'polished' });
    // Laminated tiller: tapering rounded section, rising gently, with a grip end.
    const rise = 8 * DEG;
    const path: THREE.Vector3[] = [];
    for (let k = 0; k <= 12; k++) {
      const s = (k / 12) * T.length;
      path.push(v3(0, T.headH + s * Math.sin(rise) + 0.02 * Math.sin((Math.PI * s) / T.length), -s * Math.cos(rise)));
    }
    const prof: Array<[number, number]> = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      prof.push([Math.sign(c) * Math.pow(Math.abs(c), 0.7), Math.sign(sn) * Math.pow(Math.abs(sn), 0.7)]);
    }
    parts.push({
      geometry: tube(path, { radius: 1, radial: 14, profile: prof, profileScale: (_i, s) => { const t = s / T.length; return [0.018 - 0.004 * t, 0.027 - 0.01 * t]; }, seedNormal: v3(1, 0, 0), capEnd: true, vScale: 1 }),
      mat: 'wood', shadow: true,
    });
    // Universal joint at the tiller end (rubber) where the extension clips on.
    const tip = path[path.length - 1];
    parts.push({ geometry: new THREE.CapsuleGeometry(0.012, 0.03, 3, 10).translate(tip.x, tip.y + 0.035, tip.z + 0.03), mat: 'rubber', shadow: true });
    return parts;
  }

  // --- animated rigging ------------------------------------------------------------------------------

  private tillerEnd(): THREE.Vector3 {
    const T = BOAT.tiller;
    const rise = 8 * DEG;
    const local = v3(0, T.headH + T.length * Math.sin(rise) + 0.05, -T.length * Math.cos(rise) + 0.03);
    return local.applyAxisAngle(v3(0, 1, 0), this.pose.rudder).add(this.rudder.position);
  }

  private boomPoint(local: THREE.Vector3): THREE.Vector3 {
    return local.clone().applyAxisAngle(v3(0, 1, 0), -this.pose.boomAngle).add(RIG.gooseneck);
  }

  private updateMainsheet(carX: number): void {
    const upper = RIG.sheetBail.clone().add(v3(0, -0.075, 0));
    const lower = v3(carX, COCKPIT.seatH + 0.012 + 0.1, -TR.x);
    const axleBoom = v3(1, 0, 0).applyAxisAngle(v3(0, 1, 0), -this.pose.boomAngle);
    for (let k = 0; k < 4; k++) {
      const off = -0.013 + 0.0087 * k;
      const a = this.boomPoint(upper).addScaledVector(axleBoom, off);
      const b = lower.clone().add(v3(off * 0.9, 0, 0));
      this.pts[0].copy(a); this.pts[1].copy(b);
      this.ropes.setPath(R_MAIN + k, this.pts);
    }
    // Tail from the cam on the lower block, down into a loose coil on the sole.
    const camOut = v3(carX, COCKPIT.seatH + 0.075, -TR.x + 0.04);
    const coil = loc(TR.x - 0.35, 0.12, COCKPIT.soleH + 0.01);
    const n = this.ropes.specs[R_MAIN_TAIL].samples;
    sagSpan(this.pts, 0, n, camOut, coil, 0.12 + 0.05 * (1 - this.pose.sheets.main), this.g);
    for (let i = 0; i < n; i++) this.clampAbove(this.pts[i], 0.0045);
    this.ropes.setPath(R_MAIN_TAIL, this.pts);
  }

  private updateJibSheets(): void {
    const p = this.pose;
    const clew = bodyToLocal(p.jibClew);
    const c = v3(clew.x, clew.y, clew.z);
    const working = Math.abs(c.x) > 0.04 ? Math.sign(c.x) : 1;
    const furled = THREE.MathUtils.clamp(p.jibFurl, 0, 1);
    for (const s of [-1, 1]) {
      const slot = s < 0 ? R_JIB_P : R_JIB_S;
      const n = this.ropes.specs[slot].samples;
      const lead = jibLeadPoint(s).add(v3(0, 0.03, 0));
      const drum = primaryDrum(s);
      const loaded = s === working && furled < 0.8;
      const span = c.distanceTo(lead);
      const sag = loaded ? span * (0.004 + 0.02 * (1 - p.sheets.jib)) : span * (0.1 + 0.05 * furled);
      const n1 = Math.round(n * 0.72);
      sagSpan(this.pts, 0, n1, c, lead, sag, this.g);
      sagSpan(this.pts, n1, n - n1, lead, drum, loaded ? 0.002 : 0.02, this.g, false);
      for (let i = 0; i < n; i++) this.clampAbove(this.pts[i], 0.005);
      this.ropes.setPath(slot, this.pts);
    }
  }

  private updateSpinnaker(): void {
    const sp = this.pose.spin;
    this.pole.visible = sp.visible;
    if (!sp.visible) {
      for (const k of [R_SPIN_SHEET, R_SPIN_GUY, R_LIFT, R_FOREGUY]) this.ropes.hide(k);
      return;
    }
    const tackL = bodyToLocal(sp.tack), clewL = bodyToLocal(sp.clew);
    const tack = v3(tackL.x, tackL.y, tackL.z), clew = v3(clewL.x, clewL.y, clewL.z);
    // Pole from the mast ring to the tack.
    const dir = tack.clone().sub(RIG.poleInboard);
    const len = dir.length();
    this.pole.quaternion.setFromUnitVectors(v3(0, 0, 1), dir.clone().normalize());
    this.pole.scale.set(1, 1, len / BOAT.spinnaker.poleLength);
    const mid = RIG.poleInboard.clone().addScaledVector(dir, 0.5);
    this.pts[0].copy(RIG.poleLiftMast); this.pts[1].copy(mid).add(v3(0, 0.06, 0));
    this.ropes.setPath(R_LIFT, this.pts);
    this.pts[0].copy(mid).add(v3(0, -0.03, 0)); this.pts[1].copy(RIG.foreguyDeck);
    this.ropes.setPath(R_FOREGUY, this.pts);
    const windward = Math.sign(tack.x) || 1;
    const lines: Array<[number, THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
      [R_SPIN_SHEET, clew, quarterBlock(-windward).add(v3(0, 0.03, 0)), secondaryDrum(-windward)],
      [R_SPIN_GUY, tack, guyBlock(windward).add(v3(0, 0.03, 0)), secondaryDrum(windward)],
    ];
    for (const [slot, from, via, to] of lines) {
      const n = this.ropes.specs[slot].samples;
      const n1 = Math.round(n * 0.7);
      sagSpan(this.pts, 0, n1, from, via, from.distanceTo(via) * (0.006 + 0.02 * (1 - this.pose.sheets.spin)), this.g);
      sagSpan(this.pts, n1, n - n1, via, to, 0.004, this.g, false);
      for (let i = 0; i < n; i++) this.clampAbove(this.pts[i], 0.004);
      this.ropes.setPath(slot, this.pts);
    }
  }

  private updateTravellerLines(carX: number): void {
    const h = COCKPIT.seatH + 0.028;
    for (const [slot, s] of [[R_TRAV_P, -1], [R_TRAV_S, 1]] as const) {
      this.pts[0].set(carX + s * 0.04, h, -TR.x + 0.012);
      this.pts[1].set(s * (TR.halfWidth + 0.01), h - 0.006, -TR.x + 0.012);
      this.ropes.setPath(slot, this.pts);
    }
  }

  /** Keep a rope point from sinking into the deck, cabin top, seats or sole. */
  private clampAbove(p: THREE.Vector3, r: number): void {
    const h = topSurfaceH(-p.z, p.x);
    if (Number.isFinite(h) && p.y < h + r) p.y = h + r;
  }
}
