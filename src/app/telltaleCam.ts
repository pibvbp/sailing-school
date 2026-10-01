// Telltale cam (plan Task 16): a picture-in-picture close-up of one pair of the jib's luff telltales, seen
// from just behind and to windward of the luff. The scene is re-rendered at 20 Hz into a small multisampled HDR target, which is drawn into
// the HUD's PiP slot every frame with the same tone mapping and exposure as the main view.
import * as THREE from 'three';
import { supportsHalfFloatTargets } from '../render/core/post';

const HZ = 20;
/**
 * Where the camera sits relative to the telltales it watches, boat-local (X starboard, Y up, Z aft; X is mirrored
 * to the windward side): close behind and a little to windward of the jib's luff, as if you leaned in to look.
 */
const OFFSET = { x: 0.55, y: -0.2, z: 1.25 };
/** The yarns stream aft of their roots: aim a little behind them (m along the boat). */
const LOOK_AFT = 0.12;
const tmp = new THREE.Vector3();
const dir = new THREE.Vector3();
const size = new THREE.Vector2();
const rot = new THREE.Matrix3();

export interface PipRect { x: number; y: number; width: number; height: number }

export class TelltaleCam {
  readonly camera = new THREE.PerspectiveCamera(30, 1.6, 0.05, 20000);
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly centre = new THREE.Vector3();
  private acc = Infinity;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: supportsHalfFloatTargets(renderer) ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples: 4,
    });
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this.target.texture, depthTest: false, depthWrite: false }),
    );
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /**
   * Draws the PiP into `rect` (CSS px, from the HUD), or does nothing when the cam is off. `anchors` are the
   * jib luff telltale anchors (children of the boat), `windSide` +1 when the wind is from starboard.
   * Call after the main frame has been rendered.
   */
  render(dt: number, rect: PipRect | null, scene: THREE.Scene, anchors: readonly THREE.Object3D[], boat: THREE.Object3D, windSide: number, toneMapping: THREE.ToneMapping): void {
    if (!rect || rect.width < 2 || rect.height < 2 || anchors.length === 0) {
      this.acc = Infinity;
      return;
    }
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const w = Math.round(rect.width * pr), h = Math.round(rect.height * pr);
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
      this.acc = Infinity;
    }
    this.acc += dt;
    if (this.acc >= 1 / HZ) {
      this.acc = this.acc === Infinity ? 0 : this.acc % (1 / HZ);
      this.aim(anchors, boat, windSide, rect.width / rect.height);
      // Reuse this frame's shadow maps instead of rendering them again for the small view.
      const autoShadows = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      const prev = r.getRenderTarget();
      r.setRenderTarget(this.target);
      r.clear();
      r.render(scene, this.camera);
      r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = autoShadows;
    }

    // Blit with tone mapping into the PiP rectangle (GL's y runs up from the bottom).
    r.getSize(size);
    const y = size.y - rect.y - rect.height;
    const prevTone = r.toneMapping;
    r.toneMapping = toneMapping;
    r.setScissorTest(true);
    r.setScissor(rect.x, y, rect.width, rect.height);
    r.setViewport(rect.x, y, rect.width, rect.height);
    r.render(this.quadScene, this.quadCam);
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    r.toneMapping = prevTone;
  }

  dispose(): void {
    this.target.dispose();
  }

  /** Lean in close to the telltales (windward and leeward of one pair) and frame them with a little margin. */
  private aim(anchors: readonly THREE.Object3D[], boat: THREE.Object3D, windSide: number, aspect: number): void {
    const cam = this.camera;
    this.centre.set(0, 0, 0);
    for (const a of anchors) this.centre.add(a.getWorldPosition(tmp));
    this.centre.multiplyScalar(1 / anchors.length);
    // The offset is given in the boat's frame, so the view heels and turns with the boat.
    rot.setFromMatrix4(boat.matrixWorld);
    cam.position.set(OFFSET.x * windSide, OFFSET.y, OFFSET.z).applyMatrix3(rot).add(this.centre);
    dir.set(0, 0, LOOK_AFT).applyMatrix3(rot).add(this.centre);
    cam.up.set(0, 1, 0);
    cam.lookAt(dir);
    // Widest angle from the view axis to any telltale root → field of view, with room for the streaming yarns.
    dir.sub(cam.position).normalize();
    let maxAngle = 0;
    for (const a of anchors) {
      const d = a.getWorldPosition(tmp).sub(cam.position).normalize();
      maxAngle = Math.max(maxAngle, Math.acos(THREE.MathUtils.clamp(d.dot(dir), -1, 1)));
    }
    const vertical = 2 * Math.atan(Math.tan(maxAngle * 1.3 + 0.16) / Math.min(1, aspect));
    cam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(vertical), 20, 55);
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }
}
