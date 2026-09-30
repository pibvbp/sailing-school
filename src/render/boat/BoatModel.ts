// The procedural Kestrel 25 (spec §6, §9.5): assembles hull, deck, cabin, cockpit, appendages, rig,
// fittings, running rigging and crew in the boat-local frame (X starboard, Y up, Z aft; origin on the
// centreline at the design waterline at the CG station). Static parts are merged per material;
// the boom, rudder/tiller, spinnaker pole, jib-lead cars, traveller car, sheets and crew are driven by
// setPose() + update(). update() does no work when neither the pose nor the crew changed (e.g. paused)
// and allocates nothing per frame.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOAT } from '../../shared/boatSpec';
import type { Vec3 } from '../../shared/math';
import type { QualitySettings } from '../core/types';
import { buildKeel, buildRudderBlade } from './appendages';
import { buildCabin } from './cabin';
import { buildCockpit } from './cockpit';
import { CrewSet, HIDE_HELMSMAN, type CrewInput } from './crew';
import { COCKPIT, buildDeck, topSurfaceH } from './deck';
import {
  HARDWARE, block, buildFittings, frame, guyBlock, jibLeadPoint, lathe, leadCarParts, loc, primaryDrum, quarterBlock,
  roundedBox, secondaryDrum, v3,
} from './fittings';
import { HULL_SOLVE_MS, buildHull, hullLines } from './hull';
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
  /** Optional: jib-lead cars, −1 aft … +1 forward (`Controls.jibLead`). Default 0 = mid-track. */
  jibLead?: number;
  /** Optional: traveller car position (m, + to starboard: the sim's mainsail `carY`). Default: under the boom. */
  travelerCarY?: number;
}

/** Merge geometries that share a material into one (drops attributes not present in all of them). */
export function mergeParts(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'uv', 'uv1', 'color', 'tracer'].filter((n) => geos.every((g) => g.getAttribute(n)));
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
const TRAVELLER_SLOTS: ReadonlyArray<readonly [number, number]> = [[R_TRAV_P, -1], [R_TRAV_S, 1]];
const SIDES = [-1, 1] as const;

const TR = BOAT.boom.traveler;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const ZAXIS = new THREE.Vector3(0, 0, 1);
const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);

// Scratch.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();

/** Body-frame point → boat-local, into `out` (same as shared/coords bodyToLocal, allocation-free). */
function bodyInto(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(p.y, -p.z, -p.x);
}

export interface BoatOptions {
  /**
   * Draw a furled-jib roll on the foil (default false). SailsView owns the sail cloth, the furled roll
   * included; this is only for views without it (e.g. the boat demo).
   */
  furledJib?: boolean;
}

export class BoatModel {
  /** `camera.userData` key: cameras with this flag set to true do not draw the helmsman (helm/PiP views). */
  static readonly HIDE_HELMSMAN = HIDE_HELMSMAN;

  readonly root = new THREE.Group();
  readonly anchors: {
    mastTop: THREE.Vector3;
    gooseneck: THREE.Vector3;
    forestayTack: THREE.Vector3;
    forestayHead: THREE.Vector3;
    boomEnd(angle: number): THREE.Vector3;
  };

  /** Construction cost (ms): module-level hull solve (once per app), lofting + builders, textures, assembly. */
  readonly buildStats = { hullSolveMs: HULL_SOLVE_MS, geometryMs: 0, texturesMs: 0, mergeMs: 0 };
  private readonly materials: BoatMaterials;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly boom = new THREE.Group();
  private readonly rudder = new THREE.Group();
  private readonly pole = new THREE.Group();
  private readonly car = new THREE.Group();
  private readonly leadCars = new THREE.Group();
  private readonly furl: THREE.Mesh | null = null;
  private readonly extension: THREE.Mesh;
  private readonly ropes: RopeSet;
  private readonly crew: CrewSet;
  private readonly pose: BoatPose;
  private ropesDirty = true;
  // Per-side fixed points (index 0 port, 1 starboard) and other constants.
  private readonly lead: [THREE.Vector3, THREE.Vector3];
  private readonly drum: [THREE.Vector3, THREE.Vector3];
  private readonly drum2: [THREE.Vector3, THREE.Vector3];
  private readonly quarter: [THREE.Vector3, THREE.Vector3];
  private readonly guy: [THREE.Vector3, THREE.Vector3];
  private readonly bailLocal = RIG.sheetBail.clone().add(v3(0, -0.075, 0));
  private readonly coilPoint = loc(TR.x - 0.35, 0.12, COCKPIT.soleH + 0.01);
  private readonly camOut = new THREE.Vector3();
  private readonly tillerEndPt = new THREE.Vector3();
  private readonly crewInput: CrewInput = { crewY: 0, heel: 0, tillerEnd: this.tillerEndPt, mainsheetCam: this.camOut };
  private readonly g = new THREE.Vector3();
  private readonly pts: THREE.Vector3[];
  private carX = 0;

  constructor(q: QualitySettings, opts: BoatOptions = {}) {
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

    // Jib-lead cars (both sides move together along their tracks).
    this.leadCars.name = 'jib-lead-cars';
    this.addParts(this.leadCars, leadCarParts(detail.lathe));
    this.root.add(this.leadCars);

    // Optional furled-jib roll (scaled radially by the furl amount); normally SailsView draws it.
    if (opts.furledJib) {
      const roll = rig.furl();
      this.furl = new THREE.Mesh(roll.geometry, this.materials.get('furl'));
      this.furl.name = 'furled-jib';
      this.furl.position.copy(roll.base);
      this.furl.quaternion.setFromUnitVectors(ZAXIS, roll.dir);
      this.furl.castShadow = true;
      this.furl.receiveShadow = true;
      this.geometries.push(roll.geometry);
      this.root.add(this.furl);
    }

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
    this.extension.name = 'tiller-extension';
    this.extension.castShadow = true;
    this.extension.receiveShadow = true;
    this.root.add(this.extension);

    // Animated ropes.
    const n = detail.ropeSamples;
    const specs: RopeSpec[] = [
      { samples: 2, radius: 0.0045, cell: ROPE.mainSheet }, { samples: 2, radius: 0.0045, cell: ROPE.mainSheet },
      { samples: 2, radius: 0.0045, cell: ROPE.mainSheet }, { samples: 2, radius: 0.0045, cell: ROPE.mainSheet },
      { samples: 16, radius: 0.0045, cell: ROPE.mainSheet },
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
    for (const o of this.crew.objects) { o.material = this.materials.get('crew'); this.root.add(o); }

    this.lead = [jibLeadPoint(-1).add(v3(0, 0.03, 0)), jibLeadPoint(1).add(v3(0, 0.03, 0))];
    this.drum = [primaryDrum(-1), primaryDrum(1)];
    this.drum2 = [secondaryDrum(-1), secondaryDrum(1)];
    this.quarter = [quarterBlock(-1).add(v3(0, 0.03, 0)), quarterBlock(1).add(v3(0, 0.03, 0))];
    this.guy = [guyBlock(-1).add(v3(0, 0.03, 0)), guyBlock(1).add(v3(0, 0.03, 0))];

    const gooseneck = RIG.gooseneck.clone();
    this.anchors = {
      mastTop: RIG.mastTop.clone(),
      gooseneck,
      forestayTack: RIG.forestayTack.clone(),
      forestayHead: RIG.forestayHead.clone(),
      boomEnd: (angle: number) => this.boomEndInto(angle, new THREE.Vector3()),
    };

    this.buildStats.mergeMs = performance.now() - t;
    this.pose = {
      boomAngle: 0, rudder: 0, jibClew: { x: BOAT.jib.tack.x - 0.4, y: 0, z: -BOAT.jib.clewH }, jibFurl: 1,
      spin: { visible: false, poleAngle: 0, poleTipH: 2.2, tack: { x: 3, y: 0, z: -2 }, clew: { x: 0, y: 0, z: -2 } },
      crewY: 0.5, heel: 0, sheets: { main: 0.5, jib: 0.5, spin: 0.5 }, jibLead: 0, travelerCarY: undefined,
    };
    this.update(0);
    // The first real pose places the crew directly rather than walking them over from this default.
    this.crew.snap();
  }

  /** Hide the helmsman in every view (see also BoatModel.HIDE_HELMSMAN for a per-camera switch). */
  setHelmVisible(visible: boolean): void {
    this.crew.helmVisible = visible;
  }

  /** Put the crew straight at the current pose on the next update (scenario swaps, teleports). */
  snapToPose(): void {
    this.crew.snap();
    this.ropesDirty = true;
  }

  /** Set the pose driven by the simulation; changes are applied by the next update(). */
  setPose(p: BoatPose): void {
    const q = this.pose;
    const ps = p.spin, qs = q.spin;
    const jibLead = p.jibLead ?? 0;
    const changed = q.boomAngle !== p.boomAngle || q.rudder !== p.rudder || q.jibFurl !== p.jibFurl || q.heel !== p.heel
      || q.crewY !== p.crewY || q.jibLead !== jibLead || q.travelerCarY !== p.travelerCarY
      || !same(q.jibClew, p.jibClew) || qs.visible !== ps.visible || !same(qs.tack, ps.tack) || !same(qs.clew, ps.clew)
      || q.sheets.main !== p.sheets.main || q.sheets.jib !== p.sheets.jib || q.sheets.spin !== p.sheets.spin;
    if (!changed) return;
    q.boomAngle = p.boomAngle; q.rudder = p.rudder; q.jibFurl = p.jibFurl; q.crewY = p.crewY; q.heel = p.heel;
    q.jibLead = jibLead; q.travelerCarY = p.travelerCarY;
    Object.assign(q.jibClew, p.jibClew);
    qs.visible = ps.visible; qs.poleAngle = ps.poleAngle; qs.poleTipH = ps.poleTipH;
    Object.assign(qs.tack, ps.tack);
    Object.assign(qs.clew, ps.clew);
    Object.assign(q.sheets, p.sheets);
    this.ropesDirty = true;
  }

  /** Apply the pose and advance the crew by dt (0 = paused: the crew holds still). */
  update(dt: number): void {
    const p = this.pose;
    const rigging = this.ropesDirty;
    if (rigging) {
      this.ropesDirty = false;
      this.boom.rotation.y = -p.boomAngle;
      this.rudder.rotation.y = p.rudder;
      // Local "down" tilts with heel so slack lines hang toward the true vertical.
      this.g.set(Math.sin(p.heel), -Math.cos(p.heel), 0);
      if (this.furl) {
        const f = THREE.MathUtils.clamp(p.jibFurl, 0, 1);
        this.furl.visible = f > 0.02;
        this.furl.scale.set(0.25 + 0.75 * f, 0.25 + 0.75 * f, 1);
      }
      this.leadCars.position.z = -(HARDWARE.leadCarX(p.jibLead ?? 0) - HARDWARE.leadCarX(0));
      // Traveller car: the sim's car when given, else under the sheet; always within the track.
      const lim = TR.halfWidth - 0.06;
      const want = p.travelerCarY ?? this.boomEndInto(p.boomAngle, _a).x * 0.8;
      this.carX = THREE.MathUtils.clamp(want, -lim, lim);
      this.car.position.set(this.carX, COCKPIT.seatH + 0.012, -TR.x);
      this.camOut.set(this.carX, COCKPIT.seatH + 0.075, -TR.x + 0.04);
      this.updateMainsheet();
      this.updateJibSheets();
      this.updateSpinnaker();
      this.updateTravellerLines();
      this.tillerEndInto(this.tillerEndPt);
    }
    this.crewInput.crewY = p.crewY;
    this.crewInput.heel = p.heel;
    const crewMoved = this.crew.update(this.crewInput, dt);
    if (crewMoved || rigging) {
      // Extension from the tiller's universal joint to the helmsman's hand; the mainsheet tail runs
      // through the main trimmer's hand when he holds it.
      _a.subVectors(this.crew.helmGrip, this.tillerEndPt);
      const len = Math.max(0.05, _a.length());
      this.extension.position.copy(this.tillerEndPt);
      this.extension.quaternion.setFromUnitVectors(UP, _a.multiplyScalar(1 / len));
      this.extension.scale.set(1, len, 1);
      this.updateMainsheetTail();
      this.ropes.commit();
    }
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
      mesh.receiveShadow = true;
      target.add(mesh);
    }
  }

  /** Rudder group frame: origin on the stock at the waterline. */
  private rudderParts(seg: number): Part[] {
    const T = BOAT.tiller;
    const parts: Part[] = [{ geometry: buildRudderBlade(), mat: 'antifouling', shadow: true }];
    // Stock above the bearing, head fitting clamping the tiller.
    parts.push({ geometry: rod(v3(0, T.headH - 0.1, 0), v3(0, T.headH + 0.03, 0), 0.03, 16), mat: 'polished', shadow: true });
    parts.push({ geometry: lathe([[0, 0], [0.042, 0], [0.042, 0.07], [0.034, 0.085], [0, 0.085]], seg).translate(0, T.headH - 0.05, 0), mat: 'brushed', shadow: true });
    for (const s of SIDES) parts.push({ geometry: roundedBox(0.008, 0.07, 0.16, 0.006).translate(s * 0.026, T.headH, -0.07), mat: 'brushed', shadow: true });
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

  private boomEndInto(angle: number, out: THREE.Vector3): THREE.Vector3 {
    const L = BOAT.boom.length;
    return out.set(-Math.sin(angle) * L, 0, Math.cos(angle) * L).add(RIG.gooseneck);
  }

  private tillerEndInto(out: THREE.Vector3): THREE.Vector3 {
    const T = BOAT.tiller;
    const rise = 8 * DEG;
    return out.set(0, T.headH + T.length * Math.sin(rise) + 0.05, -T.length * Math.cos(rise) + 0.03)
      .applyAxisAngle(UP, this.pose.rudder).add(this.rudder.position);
  }

  /** A point in the boom group's frame → boat-local, into `out`. */
  private boomPointInto(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(local).applyAxisAngle(UP, -this.pose.boomAngle).add(RIG.gooseneck);
  }

  private updateMainsheet(): void {
    this.boomPointInto(this.bailLocal, _b);
    _c.set(1, 0, 0).applyAxisAngle(UP, -this.pose.boomAngle);
    for (let k = 0; k < 4; k++) {
      const off = -0.013 + 0.0087 * k;
      this.pts[0].copy(_b).addScaledVector(_c, off);
      this.pts[1].set(this.carX + off * 0.9, COCKPIT.seatH + 0.012 + 0.1, -TR.x);
      this.ropes.setPath(R_MAIN + k, this.pts);
    }
  }

  /** Tail from the car's cam, through the main trimmer's hand when he holds it, into a coil on the sole. */
  private updateMainsheetTail(): void {
    const n = this.ropes.specs[R_MAIN_TAIL].samples;
    const w = this.crew.sheetGrip;
    const sag = 0.12 + 0.05 * (1 - this.pose.sheets.main);
    if (w < 0.02) {
      sagSpan(this.pts, 0, n, this.camOut, this.coilPoint, sag, this.g);
    } else {
      // Held: cam → hand (short, fairly straight) → a loop hanging from the hand down to the coil.
      _d.lerpVectors(this.camOut, this.coilPoint, 0.35).lerp(this.crew.sheetHand, w);
      const n1 = Math.round(n * 0.35);
      sagSpan(this.pts, 0, n1, this.camOut, _d, 0.02, this.g);
      sagSpan(this.pts, n1, n - n1, _d, this.coilPoint, sag * 1.4, this.g, false);
    }
    for (let i = 0; i < n; i++) this.clampAbove(this.pts[i], 0.0045);
    this.ropes.setPath(R_MAIN_TAIL, this.pts);
  }

  private updateJibSheets(): void {
    const p = this.pose;
    const c = bodyInto(p.jibClew, _a);
    const furled = THREE.MathUtils.clamp(p.jibFurl, 0, 1);
    const dz = this.leadCars.position.z;
    for (let k = 0; k < 2; k++) {
      const s = SIDES[k];
      const slot = s < 0 ? R_JIB_P : R_JIB_S;
      const n = this.ropes.specs[slot].samples;
      const lead = _b.copy(this.lead[k]).setZ(this.lead[k].z + dz);
      // Load blends in as the clew moves over this side (no hard switch at the centreline).
      const loaded = smooth(0.05, 0.4, c.x * s) * (1 - smooth(0.6, 0.9, furled));
      const span = c.distanceTo(lead);
      const sagLoaded = span * (0.004 + 0.02 * (1 - p.sheets.jib));
      const sagLazy = span * (0.1 + 0.05 * furled);
      const n1 = Math.round(n * 0.72);
      sagSpan(this.pts, 0, n1, c, lead, sagLazy + (sagLoaded - sagLazy) * loaded, this.g);
      sagSpan(this.pts, n1, n - n1, lead, this.drum[k], 0.02 + (0.002 - 0.02) * loaded, this.g, false);
      for (let i = 0; i < n; i++) this.clampAbove(this.pts[i], 0.005);
      this.ropes.setPath(slot, this.pts);
    }
  }

  private updateSpinnaker(): void {
    const sp = this.pose.spin;
    this.pole.visible = sp.visible;
    if (!sp.visible) {
      this.ropes.hide(R_SPIN_SHEET); this.ropes.hide(R_SPIN_GUY); this.ropes.hide(R_LIFT); this.ropes.hide(R_FOREGUY);
      return;
    }
    const tack = bodyInto(sp.tack, _a), clew = bodyInto(sp.clew, _b);
    // Pole from the mast ring to the tack.
    const dir = _c.subVectors(tack, RIG.poleInboard);
    const len = Math.max(1e-3, dir.length());
    this.pole.quaternion.setFromUnitVectors(ZAXIS, _d.copy(dir).multiplyScalar(1 / len));
    this.pole.scale.set(1, 1, len / BOAT.spinnaker.poleLength);
    _e.copy(RIG.poleInboard).addScaledVector(dir, 0.5);
    this.pts[0].copy(RIG.poleLiftMast); this.pts[1].copy(_e).y += 0.06;
    this.ropes.setPath(R_LIFT, this.pts);
    this.pts[0].copy(_e).y -= 0.03; this.pts[1].copy(RIG.foreguyDeck);
    this.ropes.setPath(R_FOREGUY, this.pts);
    // Windward = the pole's side; with the pole on the centreline, the side away from the clew.
    const windward = Math.sign(tack.x) || -Math.sign(clew.x) || 1;
    const wi = windward > 0 ? 1 : 0, li = 1 - wi;
    this.spinLine(R_SPIN_SHEET, clew, this.quarter[li], this.drum2[li]);
    this.spinLine(R_SPIN_GUY, tack, this.guy[wi], this.drum2[wi]);
  }

  private spinLine(slot: number, from: THREE.Vector3, via: THREE.Vector3, to: THREE.Vector3): void {
    const n = this.ropes.specs[slot].samples;
    const n1 = Math.round(n * 0.7);
    sagSpan(this.pts, 0, n1, from, via, from.distanceTo(via) * (0.006 + 0.02 * (1 - this.pose.sheets.spin)), this.g);
    sagSpan(this.pts, n1, n - n1, via, to, 0.004, this.g, false);
    for (let i = 0; i < n; i++) this.clampAbove(this.pts[i], 0.004);
    this.ropes.setPath(slot, this.pts);
  }

  private updateTravellerLines(): void {
    const h = COCKPIT.seatH + 0.028;
    for (const [slot, s] of TRAVELLER_SLOTS) {
      this.pts[0].set(this.carX + s * 0.04, h, -TR.x + 0.012);
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

function same(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
