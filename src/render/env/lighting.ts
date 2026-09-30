// Sun light (spec §9.1/§9.4): one directional light whose colour and intensity come from the sky model, with
// a shadow frustum fitted tightly around the followed object (the boat) so the sails shade deck and hull.
// Ambient light is the sky's PMREM environment (scene.environment), set by SkySystem.
import * as THREE from 'three';
import type { QualitySettings, SkyState } from '../core/types';

/** Half-size of the shadow box around the target: hull (7.6 m), rig (10.2 m), boom and spinnaker when heeled. */
const SHADOW_HALF_EXTENT = 11;
/** Light distance from the target along the sun direction, and the shadow depth range it covers. */
const LIGHT_DISTANCE = 45;
const SHADOW_NEAR = 20;
const SHADOW_FAR = 75;
/**
 * Penumbra of the 0.53° sun ≈ 0.0093 × occluder distance: ≈ 3 cm for sails and boom a few metres above the
 * deck. The PCF radius is set in texels from this, so every shadow-map size gives the same softness.
 */
const PENUMBRA_M = 0.032;
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

export class Lighting {
  readonly sun: THREE.DirectionalLight;

  private readonly sky: SkyState;
  private target: THREE.Object3D | null = null;
  private readonly center = new THREE.Vector3();
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private mapSize = 0;

  constructor(scene: THREE.Scene, sky: SkyState, q: QualitySettings) {
    this.sky = sky;
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.name = 'sun';
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_HALF_EXTENT;
    cam.right = SHADOW_HALF_EXTENT;
    cam.top = SHADOW_HALF_EXTENT;
    cam.bottom = -SHADOW_HALF_EXTENT;
    cam.near = SHADOW_NEAR;
    cam.far = SHADOW_FAR;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.025;
    scene.add(this.sun, this.sun.target);
    this.setQuality(q);
    this.update();
  }

  /** Centre the shadow frustum on this object (usually the boat root); null = world origin. */
  follow(target: THREE.Object3D | null): void {
    this.target = target;
  }

  setQuality(q: QualitySettings): void {
    const size = q.shadowMapSize;
    this.sun.castShadow = size > 0;
    if (size === this.mapSize) return;
    this.mapSize = size;
    if (size > 0) {
      this.sun.shadow.mapSize.set(size, size);
      // The 5-tap Vogel PCF gets grainy past ~4.5 texels; tiny maps simply stay a little harder.
      this.sun.shadow.radius = THREE.MathUtils.clamp(PENUMBRA_M / ((2 * SHADOW_HALF_EXTENT) / size), 1.2, 4.5);
    }
    // The map is reallocated at the new size on the next render.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /** Call once per frame after the target moved and the sky updated. */
  update(): void {
    const sky = this.sky;
    this.sun.color.copy(sky.sunColor);
    // Intensity only (never `visible`): toggling a light changes every material's program hash.
    this.sun.intensity = sky.sunIntensity;

    if (this.target) this.target.getWorldPosition(this.center);
    else this.center.set(0, 0, 0);
    this.center.y += 3; // middle of the rig rather than the waterline
    this.snapToShadowTexels(sky.sunDirection);

    this.sun.target.position.copy(this.center);
    this.sun.position.copy(this.center).addScaledVector(sky.sunDirection, LIGHT_DISTANCE);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Move the frustum centre in whole shadow texels (in the light's view plane) so a slowly moving boat does
   * not make shadow edges crawl. The axes match DirectionalLightShadow's lookAt with the default up.
   */
  private snapToShadowTexels(sunDirection: THREE.Vector3): void {
    if (this.mapSize <= 0) return;
    const up = Math.abs(sunDirection.y) > 0.999 ? FALLBACK_UP : THREE.Object3D.DEFAULT_UP;
    this.axisX.crossVectors(up, sunDirection).normalize();
    this.axisY.crossVectors(sunDirection, this.axisX);
    const texel = (2 * SHADOW_HALF_EXTENT) / this.mapSize;
    const u = this.center.dot(this.axisX);
    const v = this.center.dot(this.axisY);
    this.center.addScaledVector(this.axisX, Math.round(u / texel) * texel - u);
    this.center.addScaledVector(this.axisY, Math.round(v / texel) * texel - v);
  }
}
