// Planar reflection of what stands on the water (hull, sails, marks, land) for the higher quality
// tiers (spec §9.3). The scene minus the sea and the sky dome is rendered from the camera mirrored in
// the mean water plane, with an oblique near plane so nothing below the waterline is reflected; the sea
// samples it in screen space, displaced by its normal. The sky itself comes from the env map.
// Mirror/oblique-clip maths after three.js `examples/jsm/objects/Reflector.js` (MIT, three.js authors).
import * as THREE from 'three';

type ReflectionQuality = 'off' | 'half' | 'full';

const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
const _size = new THREE.Vector2();
const _camPos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _normal = new THREE.Vector3(0, 1, 0);
const _point = new THREE.Vector3();
const _clearColor = new THREE.Color();

export class PlanarReflection {
  private target: THREE.WebGLRenderTarget | null = null;
  private scale = 0;
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly hidden: THREE.Object3D[] = [];
  private skyCheckFrames = 0;
  private skies: THREE.Object3D[] = [];
  /** Mirror plane: the water level where reflections matter most (under the boat). */
  mirrorY = 0;
  /**
   * Oblique clip plane, below the troughs: geometry between it and the local surface (a hull's
   * waterline in a trough) must survive, and rays from below never reach submerged parts anyway.
   */
  clipY = -0.5;
  /** View-projection of the last mirror camera (x/y are unaffected by the oblique clip). */
  readonly viewProjection = new THREE.Matrix4();

  constructor(private readonly exclude: THREE.Object3D[]) {}

  /** Objects that must not appear in the mirror (the app's own sky dome, overlays under the water, …). */
  addExclusions(...objects: THREE.Object3D[]): void { this.exclude.push(...objects); }

  get texture(): THREE.Texture | null { return this.target?.texture ?? null; }

  setQuality(q: ReflectionQuality): void {
    this.scale = q === 'full' ? 1 : q === 'half' ? 0.5 : 0;
    if (this.scale === 0) { this.target?.dispose(); this.target = null; }
  }

  /** Render the mirrored view for `camera`; call from the sea's onBeforeRender. Returns false when off. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): boolean {
    if (this.scale === 0 || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return false;
    const cam = camera as THREE.PerspectiveCamera;
    camera.getWorldPosition(_camPos);
    if (_camPos.y <= this.mirrorY + 0.05) return false;
    this.ensureTarget(renderer);
    this.mirrorCamera(cam);

    // Only what stands on the water: hide the sea, our backdrop and any sky dome (three's Sky, or the
    // app's dome named 'sky'); the sky itself is reflected from the environment map.
    if (--this.skyCheckFrames <= 0) {
      this.skies = scene.children.filter((o) => (o as { isSky?: boolean }).isSky === true || o.name === 'sky');
      this.skyCheckFrames = 120;
    }
    this.hidden.length = 0;
    for (const o of [...this.exclude, ...this.skies]) if (o.visible) { o.visible = false; this.hidden.push(o); }
    const background = scene.background;
    scene.background = null;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadows = renderer.shadowMap.autoUpdate;
    const prevAutoClear = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_clearColor);
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.autoClear = false;
    renderer.render(scene, this.camera);

    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(_clearColor, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadows;
    renderer.xr.enabled = prevXr;
    renderer.setRenderTarget(prevTarget);
    const viewport = (camera as { viewport?: THREE.Vector4 }).viewport;
    if (viewport) renderer.state.viewport(viewport);
    scene.background = background;
    for (const o of this.hidden) o.visible = true;
    return true;
  }

  dispose(): void { this.target?.dispose(); this.target = null; }

  private ensureTarget(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.round(_size.x * this.scale)), h = Math.max(1, Math.round(_size.y * this.scale));
    if (this.target && this.target.width === w && this.target.height === h) return;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.target.texture.name = 'oceanReflection';
  }

  /** Mirror `cam` in the plane y = mirrorY and clip everything below y = clipY (oblique near plane). */
  private mirrorCamera(cam: THREE.PerspectiveCamera): void {
    const r = this.camera;
    const y0 = this.mirrorY;
    r.position.set(_camPos.x, 2 * y0 - _camPos.y, _camPos.z);
    cam.getWorldDirection(_look);
    _look.y = -_look.y;
    _up.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(_quat));
    _up.y = -_up.y;
    r.up.copy(_up);
    r.lookAt(r.position.x + _look.x, r.position.y + _look.y, r.position.z + _look.z);
    r.far = cam.far;
    r.near = cam.near;
    r.updateMatrixWorld();
    r.projectionMatrix.copy(cam.projectionMatrix);
    r.projectionMatrixInverse.copy(cam.projectionMatrixInverse);

    _plane.setFromNormalAndCoplanarPoint(_normal, _point.set(0, Math.min(this.clipY, y0), 0));
    _plane.applyMatrix4(r.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const p = r.projectionMatrix.elements;
    _q.set((Math.sign(_clip.x) + p[8]!) / p[0]!, (Math.sign(_clip.y) + p[9]!) / p[5]!, -1, (1 + p[10]!) / p[14]!);
    _clip.multiplyScalar(2 / _clip.dot(_q));
    p[2] = _clip.x;
    p[6] = _clip.y;
    p[10] = _clip.z + 1 - 0.003;
    p[14] = _clip.w;
    r.projectionMatrixInverse.copy(r.projectionMatrix).invert();
    this.viewProjection.multiplyMatrices(r.projectionMatrix, r.matrixWorldInverse);
  }
}
