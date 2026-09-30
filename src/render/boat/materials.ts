// PBR materials for the Kestrel 25 (spec §6 "Look", §9.5) and the part/detail types the geometry
// builders share. Geometry modules import only the types from here, so they stay DOM-free for tests.
import * as THREE from 'three';
import type { QualitySettings } from '../core/types';
import type { HullLines } from './hull';
import {
  deckPlanTextures, fairnessNormal, hullPaintTextures, nameDecal, nonSkidNormal, ropeAtlas, ropeBraidNormal,
  woodTexture, brushedNormal, furlTexture, type PlanPt,
} from './textures';

/** Material slots; static parts with the same slot are merged into one mesh. */
export type MatKey =
  | 'hull' | 'deck' | 'antifouling' | 'glass' | 'aluminium' | 'polished' | 'brushed' | 'wire' | 'black'
  | 'plastic' | 'rubber' | 'wood' | 'lifeline' | 'rope' | 'darkMetal' | 'furl' | 'decal' | 'carbon' | 'crew';

export interface Part {
  geometry: THREE.BufferGeometry;
  mat: MatKey;
  /** Casts sun shadows (thin wires and ropes do not; they would alias at shadow-map resolution). */
  shadow?: boolean;
}

/** What every builder receives: resolution, the lofted hull, and a list to add smooth deck pads to. */
export interface BuildContext {
  detail: BoatDetail;
  lines: HullLines;
  /** Plan-view polygons (x fwd, y stbd) kept free of non-skid (under hardware, hatches). */
  pads: PlanPt[][];
}

/** Mesh/texture resolution derived from the quality tier. */
export interface BoatDetail {
  hullStations: number;
  hullSectionPoints: number;
  /** Radial segments of tubes (stanchions, spars) and ropes. */
  radial: number;
  /** Samples along curved tubes and ropes. */
  ropeSamples: number;
  /** Deck grid density multiplier. */
  deck: number;
  /** Long side of the large canvas textures. */
  textureSize: number;
  /** Lathe segments of round hardware (winches, sheaves). */
  lathe: number;
}

export function boatDetail(q: Pick<QualitySettings, 'tier'>): BoatDetail {
  switch (q.tier) {
    case 'ultra': return { hullStations: 170, hullSectionPoints: 34, radial: 10, ropeSamples: 36, deck: 1.3, textureSize: 4096, lathe: 40 };
    case 'high': return { hullStations: 140, hullSectionPoints: 28, radial: 8, ropeSamples: 28, deck: 1, textureSize: 2048, lathe: 28 };
    case 'medium': return { hullStations: 100, hullSectionPoints: 22, radial: 6, ropeSamples: 20, deck: 0.75, textureSize: 2048, lathe: 20 };
    case 'low': return { hullStations: 70, hullSectionPoints: 16, radial: 5, ropeSamples: 14, deck: 0.5, textureSize: 1024, lathe: 14 };
  }
}

/** Owns every boat material and generated texture. */
export class BoatMaterials {
  private readonly mats = new Map<MatKey, THREE.Material>();
  private readonly textures: THREE.Texture[] = [];

  constructor(detail: BoatDetail, planPads: PlanPt[][]) {
    const keep = <T extends THREE.Texture>(t: T): T => { this.textures.push(t); return t; };

    // Hull: white gelcoat topsides, navy boot-top, antifouling (paint zones in the maps), clearcoat.
    const paint = hullPaintTextures(detail.textureSize);
    keep(paint.map); keep(paint.orm);
    const fair = keep(fairnessNormal());
    fair.channel = 1;
    fair.repeat.set(1, 1.4);
    const hull = new THREE.MeshPhysicalMaterial({
      map: paint.map,
      roughnessMap: paint.orm,
      clearcoatMap: paint.orm,
      roughness: 1,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.035,
      normalMap: fair,
      normalScale: new THREE.Vector2(0.05, 0.05),
      clearcoatNormalMap: fair,
      clearcoatNormalScale: new THREE.Vector2(0.09, 0.09),
      specularIntensity: 0.9,
    });
    this.mats.set('hull', hull);

    // Deck, cabin and cockpit mouldings: plan-mapped non-skid panels with smooth gelcoat margins.
    const plan = deckPlanTextures(Math.min(detail.textureSize, 2048), planPads);
    keep(plan.map); keep(plan.orm);
    const grit = keep(nonSkidNormal());
    grit.repeat.set(40, 14);
    const deck = new THREE.MeshPhysicalMaterial({
      map: plan.map,
      aoMap: plan.orm,
      aoMapIntensity: 1,
      roughnessMap: plan.orm,
      roughness: 1,
      metalness: 0,
      normalMap: grit,
      normalScale: new THREE.Vector2(0.55, 0.55),
      clearcoat: 1,
      clearcoatRoughness: 0.05,
    });
    // The non-skid mask (B of the ORM map) gates the grit normal and the clearcoat: margins stay glossy.
    deck.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize( mix( nonPerturbedNormal, normal, texelRoughness.b ) );')
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= 1.0 - 0.92 * texelRoughness.b;\n#endif');
    };
    deck.customProgramCacheKey = () => 'kestrel-deck';
    this.mats.set('deck', deck);

    this.mats.set('antifouling', new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.82, metalness: 0 }));
    this.mats.set('glass', new THREE.MeshPhysicalMaterial({
      color: 0x07090b, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.49, specularIntensity: 1,
    }));

    // Anodised aluminium (spars, tracks): satin, slightly anisotropic along the extrusion.
    const brushed = keep(brushedNormal());
    this.mats.set('aluminium', new THREE.MeshPhysicalMaterial({
      color: 0xc3c8cd, metalness: 1, roughness: 0.3, anisotropy: 0.45, anisotropyRotation: Math.PI / 2,
      clearcoat: 0.4, clearcoatRoughness: 0.12,
    }));
    this.mats.set('polished', new THREE.MeshStandardMaterial({ color: 0xe6e8ea, metalness: 1, roughness: 0.07 }));
    const brushedSteel = new THREE.MeshPhysicalMaterial({
      color: 0xd9dcdf, metalness: 1, roughness: 0.22, anisotropy: 0.6, normalMap: brushed, normalScale: new THREE.Vector2(0.15, 0.15),
    });
    this.mats.set('brushed', brushedSteel);
    this.mats.set('wire', new THREE.MeshStandardMaterial({ color: 0xd0d3d6, metalness: 1, roughness: 0.28 }));
    this.mats.set('black', new THREE.MeshPhysicalMaterial({ color: 0x151617, metalness: 0.55, roughness: 0.34, clearcoat: 0.5, clearcoatRoughness: 0.2 }));
    this.mats.set('plastic', new THREE.MeshStandardMaterial({ color: 0x1c1d1f, metalness: 0, roughness: 0.42 }));
    this.mats.set('darkMetal', new THREE.MeshStandardMaterial({ color: 0x55595d, metalness: 0.9, roughness: 0.38 }));
    this.mats.set('carbon', new THREE.MeshPhysicalMaterial({ color: 0x111214, metalness: 0.1, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }));
    this.mats.set('rubber', new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.6, metalness: 0 }));

    const wood = keep(woodTexture());
    this.mats.set('wood', new THREE.MeshPhysicalMaterial({
      map: wood, roughness: 0.5, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.07,
    }));
    this.mats.set('lifeline', new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.38, metalness: 0 }));

    // All running rigging shares one braided atlas material; the colour cell is chosen by UV.
    const atlas = keep(ropeAtlas());
    const braid = keep(ropeBraidNormal());
    braid.repeat.set(8, 1);
    this.mats.set('rope', new THREE.MeshPhysicalMaterial({
      map: atlas, normalMap: braid, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.78, metalness: 0,
      sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff),
    }));
    // Furled jib: the UV cover (acrylic canvas) is what shows outside the roll.
    const furl = keep(furlTexture());
    this.mats.set('furl', new THREE.MeshPhysicalMaterial({ map: furl, roughness: 0.84, metalness: 0, sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x8fa4b8) }));
    // Crew: vertex-coloured foul-weather gear, skin and boots; a little sheen for the fabric.
    this.mats.set('crew', new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.58, metalness: 0, sheen: 0.35, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xffffff) }));
    const name = keep(nameDecal('KESTREL'));
    this.mats.set('decal', new THREE.MeshPhysicalMaterial({
      map: name, transparent: true, alphaTest: 0.02, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false,
    }));
  }

  get(key: MatKey): THREE.Material {
    const m = this.mats.get(key);
    if (!m) throw new Error(`boat material ${key} missing`);
    return m;
  }

  dispose(): void {
    for (const m of this.mats.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    this.mats.clear();
  }
}
