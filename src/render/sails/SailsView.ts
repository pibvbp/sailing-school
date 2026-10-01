// Sails, telltales, windex and burgee (spec §9.6), in the three.js boat-local frame
// (X starboard, Y up, Z aft; origin at the CG station on the waterline). Snapshot points are body-frame
// and converted on the way in. Sheets and the spinnaker pole are drawn by the boat model.
import * as THREE from 'three';
import type { QualitySettings } from '../core/types';
import type { SailSection, SimSnapshot } from '../../sim/types';
import { MainShape } from './mainMesh';
import { JibShape } from './jibMesh';
import { SpinShape } from './spinMesh';
import { blankTexture, createClothMaterial, type ClothDetail, type ClothMaterial } from './clothMaterial';
import { jibWindows, makeFurlTexture, makeJibTextures, makeMainTextures, makeSpinTextures, seamLayout, type SailTextureSet } from './sailTextures';
import { toLocal, type PlanPoint, type SailPlan } from './sailMesh';
import { Telltales, type TelltaleSail } from './telltales';
import { Windex } from './windex';
import { Burgee } from './burgee';

export interface SailsWind { awa: number; aws: number; awaDeck: number; awsDeck: number }

/** Mesh resolution and texture scale for a quality tier. */
export function sailScales(q: QualitySettings): { res: number; texScale: number } {
  const r = Number.isFinite(q.sailResolution) ? q.sailResolution : 1;
  const res = Math.min(Math.max(r, 0.4), 1.5);
  return { res, texScale: res >= 1 ? 1 : res >= 0.75 ? 0.75 : 0.5 };
}

/** The cloth textures are drawn on canvases; headless (unit tests) the sails are built untextured. */
const HAS_DOM = typeof document !== 'undefined';

function untextured(): SailTextureSet {
  const base = new THREE.DataTexture(new Uint8Array([240, 240, 236, 64]), 1, 1);
  base.needsUpdate = true;
  return { base, decalFront: blankTexture(), decalBack: blankTexture(), dispose() { base.dispose(); } };
}

export class SailsView {
  readonly root = new THREE.Group();
  /**
   * For the telltale cam: jib luff telltales (port/stbd at 25, 50, 75 %: indices 0–5), then the main
   * leech telltales at the four batten ends (6–9). Positions follow the ribbons' roots every update.
   */
  readonly telltaleAnchors: THREE.Object3D[];
  private main: MainShape;
  private jib: JibShape;
  private spin: SpinShape;
  private res: number;
  private texScale: number;
  private readonly mats: { main: ClothMaterial; jib: ClothMaterial; spin: ClothMaterial };
  private textures: SailTextureSet[];
  private readonly mainMesh: THREE.Mesh;
  private readonly jibMesh: THREE.Mesh;
  private readonly spinMesh: THREE.Mesh;
  private readonly rollMesh: THREE.Mesh;
  private readonly rollTexture: THREE.Texture | null;
  private readonly telltales = new Telltales();
  private readonly windex = new Windex();
  private readonly burgee = new Burgee();
  /** The two sails the telltales ride on (refreshed in place: no per-frame literals). */
  private readonly mainRef: TelltaleSail;
  private readonly jibRef: TelltaleSail;
  /** Last finite inputs: one NaN frame must not poison springs and filters that have no way back. */
  private readonly wind: SailsWind = { awa: 0, aws: 0, awaDeck: 0, awsDeck: 0 };
  /**
   * Motion clock: the sum of the frame steps. The cloth's fixed-rate motions (breathing, wobble, bubble pulse,
   * telltale spin) run on it rather than on the sim's `t`, so a pause (dt = 0) freezes everything, a scenario
   * swap (t back to 0) causes no jump, and a long session is no different from a short one.
   */
  private clock = 0;
  private readonly gravity = new THREE.Vector3(0, -1, 0);
  private readonly q = new THREE.Quaternion();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly footprints = new Float32Array(30 * 4);
  private readonly spinFootBody = { tack: { x: 0, y: 0, z: 0 }, clew: { x: 0, y: 0, z: 0 } };
  private readonly jibPlanAt = (u: number, v: number, out: PlanPoint): PlanPoint => this.jib.planAt(u, v, out);

  constructor(q: QualitySettings) {
    this.root.name = 'sails';
    const { res, texScale } = sailScales(q);
    this.res = res;
    this.texScale = texScale;
    this.main = new MainShape(res);
    this.jib = new JibShape(res);
    this.spin = new SpinShape(res);

    this.textures = this.makeTextures(texScale);
    const [tMain, tJib, tSpin] = this.textures as [SailTextureSet, SailTextureSet, SailTextureSet];
    const corners = (plan: SailPlan, reach: [number, number, number], strength: [number, number, number]): ClothDetail['corners'] => {
      const n = plan.luff.length - 1;
      const head = { x: (plan.luff[n]!.x + plan.leech[n]!.x) / 2, y: plan.luff[n]!.y };
      return [
        { p: plan.leech[0]!, reach: reach[0], strength: strength[0] },
        { p: plan.luff[0]!, reach: reach[1], strength: strength[1] },
        { p: head, reach: reach[2], strength: strength[2] },
      ];
    };
    this.mats = {
      main: createClothMaterial('dacron', tMain, {
        plan: this.main.plan, seams: seamLayout(this.main.plan, 'main'), corners: corners(this.main.plan, [0.95, 0.6, 0.8], [1, 0.6, 0.8]),
        luffSlides: { spacing: 0.55 },
      }),
      jib: createClothMaterial('dacron', tJib, {
        plan: this.jib.plan, seams: seamLayout(this.jib.plan, 'jib'), corners: corners(this.jib.plan, [1.05, 0.6, 0.85], [1, 0.6, 0.8]),
        windows: jibWindows(this.jib.plan), ribbons: true,
      }),
      // The kite's guy and sheet load its two foot corners alike, and they swap roles in a gybe: symmetric.
      spin: createClothMaterial('nylon', tSpin, { plan: this.spin.plan, corners: corners(this.spin.plan, [0.9, 0.9, 1.0], [0.8, 0.8, 0.8]) }),
    };

    const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string): THREE.Mesh => {
      const mesh = new THREE.Mesh(g, m);
      mesh.name = name;
      return mesh;
    };
    this.mainMesh = mk(this.main.surface.geometry, this.mats.main.material, 'main');
    this.jibMesh = mk(this.jib.surface.geometry, this.mats.jib.material, 'jib');
    this.spinMesh = mk(this.spin.surface.geometry, this.mats.spin.material, 'spinnaker');
    this.rollTexture = HAS_DOM ? makeFurlTexture() : null;
    this.rollMesh = mk(this.jib.roll.geometry, new THREE.MeshStandardMaterial({ map: this.rollTexture, roughness: 0.7 }), 'jib-roll');
    this.rollMesh.visible = false;
    this.spinMesh.visible = false;
    this.setShadows(q.shadowMapSize > 0);
    this.mainRef = { surface: this.main.surface, rows: this.main.rows, visible: false };
    this.jibRef = { surface: this.jib.surface, rows: this.jib.rows, visible: false };
    this.telltaleAnchors = this.telltales.anchors;
    this.root.add(this.mainMesh, this.jibMesh, this.spinMesh, this.rollMesh, this.telltales.mesh, this.windex.group, this.burgee.group, ...this.telltaleAnchors);
  }

  /**
   * The spinnaker's two foot corners as the cloth draws them this frame (body frame: x forward, y starboard, z down),
   * or null while the kite is down. Through a gybe they glide between the snapshot's corners; the boat makes the guy
   * and the sheet fast here so the ropes stay on the sail.
   */
  get spinFoot(): { tack: { x: number; y: number; z: number }; clew: { x: number; y: number; z: number } } | null {
    if (!this.spin.visible) return null;
    const out = this.spinFootBody, a = this.spin.footTack, b = this.spin.footClew;
    out.tack.x = -a.z; out.tack.y = a.x; out.tack.z = -a.y;
    out.clew.x = -b.z; out.clew.y = b.x; out.clew.z = -b.y;
    return out;
  }

  update(dt: number, _t: number, sails: SimSnapshot['sails'], wind: SailsWind): void {
    // Sanitise once: a NaN or infinite input holds the last good value (dt → 0: nothing moves).
    const step = dt > 0 ? Math.min(dt, 0.1) : 0;
    this.clock += step;
    const time = this.clock;
    const w = this.wind;
    if (Number.isFinite(wind.awa)) w.awa = wind.awa;
    if (Number.isFinite(wind.aws)) w.aws = Math.max(wind.aws, 0);
    if (Number.isFinite(wind.awaDeck)) w.awaDeck = wind.awaDeck;
    if (Number.isFinite(wind.awsDeck)) w.awsDeck = Math.max(wind.awsDeck, 0);
    const aws = w.aws;

    this.mainMesh.visible = sails.main.set;
    if (sails.main.set) this.main.update(step, time, sails.main, aws);

    const jibSet = sails.jib.set;
    this.jibMesh.visible = jibSet;
    if (jibSet) this.jib.update(step, time, sails.jib, aws);
    else this.jib.rollVisible = this.jib.roll.update(sails.jib.furl, toLocal(sails.jib.tack, this.v1), toLocal(sails.jib.head, this.v2));
    this.rollMesh.visible = this.jib.rollVisible;

    this.spin.update(step, time, sails.spinnaker, aws);
    this.spinMesh.visible = this.spin.visible;

    // Load wrinkles need a loaded sail: they fade as it luffs, curls or collapses, and in light air.
    const breeze = Math.min(Math.max(aws / 7, 0.35), 1.3);
    this.mats.main.setLoad((1 - meanLuffing(sails.main.sections)) * breeze);
    this.mats.jib.setLoad((1 - meanLuffing(sails.jib.sections)) * breeze);
    const sp = sails.spinnaker;
    this.mats.spin.setLoad((1 - unit(sp.collapsed)) * (1 - 0.5 * unit(sp.curl)) * breeze);

    // World "down" in the boat frame, for the telltales (the boat heels and pitches under us).
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldQuaternion(this.q).invert();
    this.gravity.set(0, -1, 0).applyQuaternion(this.q);
    this.mainRef.visible = sails.main.set;
    this.jibRef.visible = jibSet;
    this.telltales.update(step, time, sails, this.mainRef, this.jibRef, aws, this.gravity);
    // The jib's far-side telltales show through the cloth as silhouettes.
    this.telltales.writeFootprints(this.footprints, this.jibPlanAt);
    this.mats.jib.setRibbons(this.footprints);

    this.windex.update(step, time, w.awa, aws);
    this.burgee.update(step, time, w.awaDeck, w.awsDeck);
  }

  /** AoA colouring of main, jib and spinnaker: blue luffing / green in the groove / red stalled. */
  setColouring(mode: 'none' | 'aoa'): void {
    const on = mode === 'aoa';
    this.main.colouring = on;
    this.jib.colouring = on;
    this.spin.colouring = on;
    this.mats.main.setColouring(on);
    this.mats.jib.setColouring(on);
    this.mats.spin.setColouring(on);
  }

  /**
   * Overlay a texture on the main or jib, sampled at (u = chord fraction luff → leech, v = height
   * fraction foot → head) and blended over the cloth by its alpha. Pass null to remove it.
   */
  setPressureTexture(sail: 'main' | 'jib', tex: THREE.Texture | null): void {
    this.mats[sail].setPressure(tex);
  }

  /**
   * Forget all motion (call on a scenario change): springs, side fields, battens, phases, telltale ribbons,
   * windex and burgee start again from the next snapshot instead of morphing from the previous scenario.
   */
  reset(): void {
    this.main.reset();
    this.jib.reset();
    this.spin.reset();
    this.telltales.reset();
    this.windex.reset();
    this.burgee.reset();
  }

  /**
   * Follow a quality-tier change: shadows at once; a new mesh resolution rebuilds the cloth grids (their
   * motion restarts from the next snapshot); a new texture scale redraws the cloth textures.
   */
  setQuality(q: QualitySettings): void {
    this.setShadows(q.shadowMapSize > 0);
    const { res, texScale } = sailScales(q);
    if (res !== this.res) {
      this.res = res;
      const old = [this.main, this.jib, this.spin] as const;
      const colouring = this.main.colouring;
      this.main = new MainShape(res);
      this.jib = new JibShape(res);
      this.spin = new SpinShape(res);
      this.main.colouring = this.jib.colouring = this.spin.colouring = colouring;
      this.mainMesh.geometry = this.main.surface.geometry;
      this.jibMesh.geometry = this.jib.surface.geometry;
      this.spinMesh.geometry = this.spin.surface.geometry;
      this.rollMesh.geometry = this.jib.roll.geometry;
      this.mainRef.surface = this.main.surface; this.mainRef.rows = this.main.rows;
      this.jibRef.surface = this.jib.surface; this.jibRef.rows = this.jib.rows;
      for (const s of old) s.dispose();
    }
    if (texScale !== this.texScale) {
      this.texScale = texScale;
      const old = this.textures;
      this.textures = this.makeTextures(texScale);
      this.mats.main.setTextures(this.textures[0]!);
      this.mats.jib.setTextures(this.textures[1]!);
      this.mats.spin.setTextures(this.textures[2]!);
      for (const t of old) t.dispose();
    }
  }

  dispose(): void {
    this.main.dispose();
    this.jib.dispose();
    this.spin.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    for (const t of this.textures) t.dispose();
    this.rollTexture?.dispose();
    (this.rollMesh.material as THREE.Material).dispose();
    this.telltales.dispose();
    this.windex.dispose();
    this.burgee.dispose();
  }

  private makeTextures(texScale: number): SailTextureSet[] {
    if (!HAS_DOM) return [untextured(), untextured(), untextured()];
    return [
      makeMainTextures(this.main.plan, this.main.battens, texScale),
      makeJibTextures(this.jib.plan, texScale),
      makeSpinTextures(this.spin.plan, texScale),
    ];
  }

  private setShadows(on: boolean): void {
    for (const m of [this.mainMesh, this.jibMesh, this.spinMesh, this.rollMesh]) {
      m.castShadow = on;
      m.receiveShadow = on;
    }
  }
}

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

function meanLuffing(sections: readonly SailSection[]): number {
  if (sections.length === 0) return 0;
  let sum = 0;
  for (const s of sections) sum += s.luffing;
  return unit(sum / sections.length);
}
