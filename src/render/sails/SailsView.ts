// Sails, telltales, windex and burgee (spec §9.6), in the three.js boat-local frame
// (X starboard, Y up, Z aft; origin at the CG station on the waterline). Snapshot points are body-frame
// and converted on the way in. Sheets and the spinnaker pole are drawn by the boat model.
import * as THREE from 'three';
import type { QualitySettings } from '../core/types';
import type { SailSection, SimSnapshot } from '../../sim/types';
import { MainShape } from './mainMesh';
import { JibShape } from './jibMesh';
import { SpinShape } from './spinMesh';
import { createClothMaterial, type ClothDetail, type ClothMaterial } from './clothMaterial';
import { jibWindows, makeFurlTexture, makeJibTextures, makeMainTextures, makeSpinTextures, seamLayout, type SailTextureSet } from './sailTextures';
import { toLocal, type SailPlan } from './sailMesh';
import { Telltales } from './telltales';
import { Windex } from './windex';
import { Burgee } from './burgee';

export interface SailsWind { awa: number; aws: number; awaDeck: number; awsDeck: number }

export class SailsView {
  readonly root = new THREE.Group();
  /**
   * For the telltale cam: jib luff telltales (port/stbd at 25, 50, 75 %: indices 0–5), then the main
   * leech telltales at the four batten ends (6–9). Positions follow the ribbons' roots every update.
   */
  readonly telltaleAnchors: THREE.Object3D[];
  private readonly main: MainShape;
  private readonly jib: JibShape;
  private readonly spin: SpinShape;
  private readonly mats: { main: ClothMaterial; jib: ClothMaterial; spin: ClothMaterial };
  private readonly textures: SailTextureSet[];
  private readonly mainMesh: THREE.Mesh;
  private readonly jibMesh: THREE.Mesh;
  private readonly spinMesh: THREE.Mesh;
  private readonly rollMesh: THREE.Mesh;
  private readonly rollTexture: THREE.Texture;
  private readonly telltales = new Telltales();
  private readonly windex = new Windex();
  private readonly burgee = new Burgee();
  private readonly gravity = new THREE.Vector3(0, -1, 0);
  private readonly q = new THREE.Quaternion();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly footprints = new Float32Array(30 * 4);
  private readonly jibPlanAt = (u: number, v: number) => this.jib.planAt(u, v);

  constructor(q: QualitySettings) {
    this.root.name = 'sails';
    const res = Math.min(Math.max(q.sailResolution, 0.4), 1.5);
    const texScale = res >= 1 ? 1 : res >= 0.75 ? 0.75 : 0.5;
    this.main = new MainShape(res);
    this.jib = new JibShape(res);
    this.spin = new SpinShape(res);

    const tMain = makeMainTextures(this.main.plan, this.main.battens, texScale);
    const tJib = makeJibTextures(this.jib.plan, texScale);
    const tSpin = makeSpinTextures(this.spin.plan, texScale);
    this.textures = [tMain, tJib, tSpin];
    const corners = (plan: SailPlan, reach: [number, number, number]): ClothDetail['corners'] => {
      const n = plan.luff.length - 1;
      const head = { x: (plan.luff[n]!.x + plan.leech[n]!.x) / 2, y: plan.luff[n]!.y };
      return [
        { p: plan.leech[0]!, reach: reach[0], strength: 1 },
        { p: plan.luff[0]!, reach: reach[1], strength: 0.6 },
        { p: head, reach: reach[2], strength: 0.8 },
      ];
    };
    this.mats = {
      main: createClothMaterial('dacron', tMain, {
        plan: this.main.plan, seams: seamLayout(this.main.plan, 'main'), corners: corners(this.main.plan, [0.95, 0.6, 0.8]), luffSlides: { spacing: 0.55 },
      }),
      jib: createClothMaterial('dacron', tJib, {
        plan: this.jib.plan, seams: seamLayout(this.jib.plan, 'jib'), corners: corners(this.jib.plan, [1.05, 0.6, 0.85]),
        windows: jibWindows(this.jib.plan), ribbons: true,
      }),
      spin: createClothMaterial('nylon', tSpin, { plan: this.spin.plan, corners: corners(this.spin.plan, [0.9, 0.9, 1.0]) }),
    };

    const shadows = q.shadowMapSize > 0;
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string): THREE.Mesh => {
      const mesh = new THREE.Mesh(g, m);
      mesh.name = name;
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      return mesh;
    };
    this.mainMesh = mk(this.main.surface.geometry, this.mats.main.material, 'main');
    this.jibMesh = mk(this.jib.surface.geometry, this.mats.jib.material, 'jib');
    this.spinMesh = mk(this.spin.surface.geometry, this.mats.spin.material, 'spinnaker');
    this.rollTexture = makeFurlTexture();
    this.rollMesh = mk(this.jib.roll.geometry, new THREE.MeshStandardMaterial({ map: this.rollTexture, roughness: 0.7 }), 'jib-roll');
    this.rollMesh.visible = false;
    this.spinMesh.visible = false;
    this.telltaleAnchors = this.telltales.anchors;
    this.root.add(this.mainMesh, this.jibMesh, this.spinMesh, this.rollMesh, this.telltales.mesh, this.windex.group, this.burgee.group, ...this.telltaleAnchors);
  }

  update(dt: number, t: number, sails: SimSnapshot['sails'], wind: SailsWind): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    const aws = Math.max(wind.aws, 0);

    this.mainMesh.visible = sails.main.set;
    if (sails.main.set) this.main.update(step, t, sails.main, aws);

    const jibSet = sails.jib.set;
    this.jibMesh.visible = jibSet;
    if (jibSet) this.jib.update(step, t, sails.jib, aws);
    else this.jib.rollVisible = this.jib.roll.update(sails.jib.furl, toLocal(sails.jib.tack, this.v1), toLocal(sails.jib.head, this.v2));
    this.rollMesh.visible = this.jib.rollVisible;

    this.spin.update(step, t, sails.spinnaker, aws);
    this.spinMesh.visible = this.spin.visible;

    // Load wrinkles need a loaded sail: they fade as it luffs, curls or collapses, and in light air.
    const breeze = Math.min(Math.max(aws / 7, 0.35), 1.3);
    this.mats.main.setLoad((1 - meanLuffing(sails.main.sections)) * breeze);
    this.mats.jib.setLoad((1 - meanLuffing(sails.jib.sections)) * breeze);
    this.mats.spin.setLoad((1 - sails.spinnaker.collapsed) * (1 - 0.5 * sails.spinnaker.curl) * breeze);

    // World "down" in the boat frame, for the telltales (the boat heels and pitches under us).
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldQuaternion(this.q).invert();
    this.gravity.set(0, -1, 0).applyQuaternion(this.q);
    this.telltales.update(step, t, sails,
      { surface: this.main.surface, rows: this.main.rows, visible: sails.main.set },
      { surface: this.jib.surface, rows: this.jib.rows, visible: jibSet },
      aws, this.gravity);
    // The jib's far-side telltales show through the cloth as silhouettes.
    this.telltales.writeFootprints(this.footprints, this.jibPlanAt);
    this.mats.jib.setRibbons(this.footprints);

    this.windex.update(step, t, wind.awa, aws);
    this.burgee.update(step, t, wind.awaDeck, wind.awsDeck);
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

  dispose(): void {
    this.main.dispose();
    this.jib.dispose();
    this.spin.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    for (const t of this.textures) t.dispose();
    this.rollTexture.dispose();
    (this.rollMesh.material as THREE.Material).dispose();
    this.telltales.dispose();
    this.windex.dispose();
    this.burgee.dispose();
  }
}

function meanLuffing(sections: readonly SailSection[]): number {
  if (sections.length === 0) return 0;
  let sum = 0;
  for (const s of sections) sum += s.luffing;
  return Math.min(Math.max(sum / sections.length, 0), 1);
}
