// Shared plumbing for every overlay material.
//
// Overlays are teaching graphics: their colours must read as the spec's palette whatever the scene's exposure.
// Two render setups exist (agent rules): demos render straight to the canvas with renderer tone mapping, while the
// production app renders the scene into a HalfFloat HDR buffer that the pmndrs post chain tone-maps with AgX
// (renderer.toneMapping = NoToneMapping, exposure from the sky meter). Overlay materials therefore opt out of
// renderer tone mapping (`toneMapped: false`) and, when they detect the HDR buffer, pre-distort their colour with the
// exact inverse of three's AgX curve and divide by the exposure — so after the post chain the pixel is the colour
// asked for (to within AgX's gamut clamp). A display value of 1.0 would need infinite radiance, so targets are capped
// at 0.94, which also keeps overlays below the bloom threshold.
//
// Every overlay mesh also draws only for the camera given to `Overlays.update` (not the ocean's mirror camera or a
// picture-in-picture view), and gets its viewport size for screen-space widths from the renderer at draw time.
import * as THREE from 'three';

// --- AgX constants (three.js tonemapping_pars_fragment, r186) -------------------------------------------------
const SRGB_TO_2020 = new THREE.Matrix3().set(0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0113, 0.0164, 0.088, 0.8956);
const REC2020_TO_SRGB = new THREE.Matrix3().set(1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187);
const INSET = new THREE.Matrix3().set(
  0.856627153315983, 0.0951212405381588, 0.0482516061458583,
  0.137318972929847, 0.761241990602591, 0.101439036467562,
  0.11189821299995, 0.0767994186031903, 0.811302368396859,
);
const OUTSET = new THREE.Matrix3().set(
  1.1271005818144368, -0.11060664309660323, -0.016493938717834573,
  -0.1413297634984383, 1.157823702216272, -0.016493938717834257,
  -0.14132976349843826, -0.11060664309660294, 1.2519364065950405,
);
const MIN_EV = -12.47393;
const MAX_EV = 4.026069;
const INSET_INV = INSET.clone().invert();
const OUTSET_INV = OUTSET.clone().invert();
/** Highest display value an overlay asks for (AgX's shoulder is asymptotic). */
export const DISPLAY_CAP = 0.94;

/** GLSL `mat3(...)` literal (column-major) of a Matrix3. */
function glslMat3(m: THREE.Matrix3): string {
  return `mat3(${Array.from(m.elements, (v) => v.toPrecision(10)).join(', ')})`;
}

export const agxContrast = (x: number): number => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

/** Monotone inverse of {@link agxContrast} on [0, 1] (bisection). */
export function agxContrastInverse(y: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = 0.5 * (lo + hi);
    if (agxContrast(mid) < y) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

const v3 = new THREE.Vector3();
/** three.js AgXToneMapping (CPU port, for tests): linear-sRGB scene colour → display-linear sRGB. */
export function agxForward(c: THREE.Vector3, exposure: number, out = new THREE.Vector3()): THREE.Vector3 {
  v3.copy(c).multiplyScalar(exposure).applyMatrix3(SRGB_TO_2020).applyMatrix3(INSET);
  const enc = (x: number) => agxContrast(THREE.MathUtils.clamp((Math.log2(Math.max(x, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV), 0, 1));
  v3.set(enc(v3.x), enc(v3.y), enc(v3.z)).applyMatrix3(OUTSET);
  v3.set(Math.pow(Math.max(0, v3.x), 2.2), Math.pow(Math.max(0, v3.y), 2.2), Math.pow(Math.max(0, v3.z), 2.2)).applyMatrix3(REC2020_TO_SRGB);
  return out.set(THREE.MathUtils.clamp(v3.x, 0, 1), THREE.MathUtils.clamp(v3.y, 0, 1), THREE.MathUtils.clamp(v3.z, 0, 1));
}

/** Inverse of {@link agxForward}: the scene colour that AgX maps to `display` (CPU twin of the GLSL). */
export function agxInverse(display: THREE.Vector3, exposure: number, out = new THREE.Vector3()): THREE.Vector3 {
  const cap = (x: number) => THREE.MathUtils.clamp(x, 0, DISPLAY_CAP);
  v3.set(cap(display.x), cap(display.y), cap(display.z)).applyMatrix3(SRGB_TO_2020);
  v3.set(Math.pow(Math.max(v3.x, 0), 1 / 2.2), Math.pow(Math.max(v3.y, 0), 1 / 2.2), Math.pow(Math.max(v3.z, 0), 1 / 2.2)).applyMatrix3(OUTSET_INV);
  const dec = (y: number) => Math.pow(2, agxContrastInverse(THREE.MathUtils.clamp(y, agxContrast(0), agxContrast(1))) * (MAX_EV - MIN_EV) + MIN_EV);
  v3.set(dec(v3.x), dec(v3.y), dec(v3.z)).applyMatrix3(INSET_INV).applyMatrix3(REC2020_TO_SRGB);
  return out.set(Math.max(v3.x, 0), Math.max(v3.y, 0), Math.max(v3.z, 0)).multiplyScalar(1 / exposure);
}

/**
 * three.js layer the overlay meshes live on. `Overlays.update` enables it on the main camera only, so mirror and
 * picture-in-picture cameras skip the overlay draws entirely (not just their fragments).
 */
export const OVERLAY_LAYER = 11;

/** Size of the lookup table that replaces the per-fragment bisection of the inverse AgX contrast curve. */
export const AGX_LUT_SIZE = 256;
const AGX_LO = agxContrast(0);
const AGX_HI = agxContrast(1);

/** Table of `agxContrastInverse` over [agxContrast(0), agxContrast(1)], one value per texel centre. */
export function agxInverseTable(): Float32Array {
  const t = new Float32Array(AGX_LUT_SIZE);
  for (let i = 0; i < AGX_LUT_SIZE; i++) t[i] = agxContrastInverse(AGX_LO + ((AGX_HI - AGX_LO) * i) / (AGX_LUT_SIZE - 1));
  return t;
}

/** CPU twin of the shader lookup (linear filtering between texel centres), for tests. */
export function agxInverseLookup(table: Float32Array, y: number): number {
  const f = THREE.MathUtils.clamp((y - AGX_LO) / (AGX_HI - AGX_LO), 0, 1) * (AGX_LUT_SIZE - 1);
  const i = Math.min(AGX_LUT_SIZE - 2, Math.floor(f));
  return table[i]! + (table[i + 1]! - table[i]!) * (f - i);
}

let lutTexture: THREE.DataTexture | null = null;
/** Shared half-float LUT texture (filterable on every WebGL2 device). */
function agxLut(): THREE.DataTexture {
  if (lutTexture) return lutTexture;
  const table = agxInverseTable();
  const half = new Uint16Array(AGX_LUT_SIZE);
  for (let i = 0; i < AGX_LUT_SIZE; i++) half[i] = THREE.DataUtils.toHalfFloat(table[i]!);
  lutTexture = new THREE.DataTexture(half, AGX_LUT_SIZE, 1, THREE.RedFormat, THREE.HalfFloatType);
  lutTexture.minFilter = lutTexture.magFilter = THREE.LinearFilter;
  lutTexture.wrapS = lutTexture.wrapT = THREE.ClampToEdgeWrapping;
  lutTexture.generateMipmaps = false;
  lutTexture.needsUpdate = true;
  return lutTexture;
}

/**
 * GLSL shared by all overlay shaders: `overlayColor(displayLinear)` returns what to write so the final pixel shows
 * `displayLinear`.
 */
export const OVERLAY_COMMON = /* glsl */ `
uniform float uOutMode;   // 0: display-referred target, 1: HDR buffer tone-mapped later by AgX
uniform float uExposure;
uniform float uVisible;   // 0 when this draw is for another camera (mirror, picture-in-picture)
uniform vec2 uResolution; // viewport, physical px
uniform float uPxScale;   // physical px per CSS px

uniform sampler2D uAgxInvLut;
// Inverse of AgX's contrast curve, from a 256-entry table sampled between texel centres.
float agxContrastInv(float y) {
  float f = clamp((y - ${AGX_LO.toFixed(6)}) / ${(AGX_HI - AGX_LO).toFixed(6)}, 0.0, 1.0);
  return texture(uAgxInvLut, vec2((f * ${(AGX_LUT_SIZE - 1).toFixed(1)} + 0.5) / ${AGX_LUT_SIZE.toFixed(1)}, 0.5)).r;
}
vec3 overlayColor(vec3 display) {
  vec3 c = clamp(display, 0.0, ${DISPLAY_CAP.toFixed(3)});
  if (uOutMode < 0.5) return c;
  c = ${glslMat3(SRGB_TO_2020)} * c;
  c = ${glslMat3(OUTSET_INV)} * pow(max(c, 1e-6), vec3(1.0 / 2.2));
  c = vec3(agxContrastInv(c.r), agxContrastInv(c.g), agxContrastInv(c.b));
  c = exp2(c * ${(MAX_EV - MIN_EV).toFixed(6)} + (${MIN_EV.toFixed(6)}));
  c = ${glslMat3(REC2020_TO_SRGB)} * (${glslMat3(INSET_INV)} * c);
  return max(c, 0.0) / uExposure;
}
`;

/** Straight (un-premultiplied) linear colour → premultiplied output in the target's colour space. */
export const OVERLAY_OUTPUT = /* glsl */ `
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
`;

/** Shared per-frame state: which camera the overlays are drawn for. */
export interface OverlayContext {
  camera: THREE.Camera | null;
}

/**
 * What an overlay needs to place itself in the picture this frame: the camera, the viewport and the safe area (the
 * part of the window the HUD leaves free) in CSS px, and how much further away than the chase camera the view is
 * (`scale`: 1 at 17 m with the 50° lens, larger further off) — world-sized graphics are stretched by it to stay readable.
 */
export interface OverlayView {
  camera: THREE.Camera | null;
  width: number;
  height: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  scale: number;
}

export type OverlayUniforms = {
  uOutMode: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uVisible: THREE.IUniform<number>;
  uResolution: THREE.IUniform<THREE.Vector2>;
  uPxScale: THREE.IUniform<number>;
  uAgxInvLut: THREE.IUniform<THREE.Texture>;
};

export function overlayUniforms(): OverlayUniforms {
  return {
    uOutMode: { value: 0 },
    uExposure: { value: 1 },
    uVisible: { value: 1 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uPxScale: { value: 1 },
    uAgxInvLut: { value: agxLut() },
  };
}

const viewport = new THREE.Vector4();
const cssSize = new THREE.Vector2();

/** Update the shared uniforms right before a draw (called from `onBeforeRender`). */
export function syncOverlayUniforms(u: OverlayUniforms, renderer: THREE.WebGLRenderer, camera: THREE.Camera, ctx: OverlayContext): void {
  u.uVisible.value = ctx.camera === null || camera === ctx.camera ? 1 : 0;
  const target = renderer.getRenderTarget();
  const hdr = renderer.toneMapping === THREE.NoToneMapping && target !== null && target.texture.type !== THREE.UnsignedByteType;
  u.uOutMode.value = hdr ? 1 : 0;
  u.uExposure.value = Math.max(1e-4, renderer.toneMappingExposure);
  renderer.getCurrentViewport(viewport);
  u.uResolution.value.set(Math.max(1, viewport.z), Math.max(1, viewport.w));
  // CSS size from the renderer (no DOM layout read mid-render); render targets scale with it.
  renderer.getSize(cssSize);
  u.uPxScale.value = viewport.z / Math.max(1, cssSize.x);
}

/** Attach the per-draw uniform sync to a mesh. */
export function bindOverlayMesh(mesh: THREE.Object3D, u: OverlayUniforms, ctx: OverlayContext): void {
  mesh.onBeforeRender = (renderer, _scene, camera) => syncOverlayUniforms(u, renderer, camera, ctx);
  mesh.layers.set(OVERLAY_LAYER);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
}
