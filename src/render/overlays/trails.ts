// Comet trails for flow particles. Every particle keeps its last K positions in a float texture used as a ring buffer
// (one row per slot, one column per particle): the CPU writes only the newest row each frame and uploads just that
// row, and one instanced draw turns each column into a tapering screen-space ribbon. A per-particle history count
// makes a respawned particle's older slots collapse onto its first point, so a respawn writes one texel, not K.
// The oldest point slides toward the next one between pushes, so trails keep a steady length instead of sawtoothing.
import * as THREE from 'three';
import { OVERLAY_COMMON, OVERLAY_OUTPUT, bindOverlayMesh, overlayUniforms, type OverlayContext } from './overlayMaterial';

export interface TrailOptions {
  count: number;
  /** Points per trail (≥ 3). */
  slots: number;
  /** Head width (CSS px). */
  width: number;
  alpha: number;
  /** 'flow': colour from the per-point value (speed ratio / wake); 'solid': `color`. */
  colorMode: 'flow' | 'solid';
  color?: THREE.Color;
  renderOrder?: number;
  /** Opacity of trail parts hidden behind geometry (0 = not drawn). */
  hiddenAlpha?: number;
  /** Dark outline width (CSS px); 0 = none. */
  outline?: number;
}

/** Colours of the flow map (display-linear): slower air = higher pressure (warm), faster = lower pressure (cool). */
export const FLOW_COLORS = {
  slow: new THREE.Color('#ff6a3a'),
  neutral: new THREE.Color('#f4f6fa'),
  fast: new THREE.Color('#1fb2ff'),
  wake: new THREE.Color('#b6a9e6'),
};

const VERT = /* glsl */ `
${OVERLAY_COMMON}
uniform sampler2D uTrail;
uniform int uHead;
uniform int uSlots;
uniform float uFrac;
uniform float uWidth;
uniform float uAlpha;
uniform float uHiddenPass;
uniform float uHiddenAlpha;
uniform float uFlowMode;
uniform vec3 uColor;
uniform vec3 uSlow;
uniform vec3 uNeutral;
uniform vec3 uFast;
uniform vec3 uWake;
uniform float uOutline;
attribute float aPoint;
attribute float aSide;
attribute float aAlpha;
attribute float aHist;   // valid history points behind the head
varying vec4 vColor;
varying float vAcross;
varying float vHalf;

vec4 pt(int j) {
  j = min(j, int(aHist + 0.5));   // older than the particle: its first recorded point
  int slot = uHead - j;
  if (slot < 0) slot += uSlots;
  return texelFetch(uTrail, ivec2(gl_InstanceID, slot), 0);
}

vec3 flowColor(float w) {
  if (w < 0.0) return mix(uNeutral, uWake, clamp(-w * 1.5, 0.0, 1.0));
  float t = clamp((w - 1.0) / 0.3, -1.0, 1.0);
  float m = abs(t);
  t = sign(t) * sqrt(m) * sqrt(sqrt(m)); // |t|^0.75 without pow(0, y), which some GPU drivers turn into NaN
  return t < 0.0 ? mix(uNeutral, uSlow, -t) : mix(uNeutral, uFast, t);
}

void main() {
  if (uVisible < 0.5 || aAlpha <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int last = uSlots - 1;
  int j = int(aPoint + 0.5);
  vec4 P = pt(j);
  if (j == last) P.xyz = mix(P.xyz, pt(last - 1).xyz, uFrac);
  vec4 A = pt(max(j - 1, 0));                   // toward the head
  vec4 B = j + 1 >= last ? mix(pt(last), pt(last - 1), uFrac) : pt(j + 1);
  if (j == last) B = P;
  vec4 cc = projectionMatrix * modelViewMatrix * vec4(P.xyz, 1.0);
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(A.xyz, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(B.xyz, 1.0);
  if (cc.w < 0.05 || ca.w < 0.05 || cb.w < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 sa = ca.xy / ca.w * uResolution;
  vec2 sb = cb.xy / cb.w * uResolution;
  vec2 t = sa - sb;
  float lt = length(t);
  t = lt > 1e-4 ? t / lt : vec2(1.0, 0.0);
  float u = float(j) / float(last);        // 0 head … 1 tail
  float taper = 1.0 - u;
  float hw = 0.5 * uWidth * uPxScale * (0.35 + 0.65 * taper);
  float pad = hw + uOutline * uPxScale + 1.0;
  cc.xy += vec2(-t.y, t.x) * aSide * pad / (0.5 * uResolution) * cc.w;
  gl_Position = cc;
  vec3 col = uFlowMode > 0.5 ? flowColor(P.w) : uColor;
  // Soft head (no bright dot where trails bunch up), long fading tail.
  float a = aAlpha * uAlpha * smoothstep(0.0, 0.14, u + 0.02) * pow(max(taper, 1e-4), 0.9) * (uHiddenPass > 0.5 ? uHiddenAlpha : 1.0);
  // A trail that has not moved yet (just born) stays invisible instead of drawing a dot.
  a *= smoothstep(0.0, 1.5, lt);
  vColor = vec4(overlayColor(col), a);
  vAcross = aSide * pad;
  vHalf = hw;
}
`;

const FRAG = /* glsl */ `
${OVERLAY_COMMON}
uniform float uOutline;
uniform float uOutlinePass;
varying vec4 vColor;
varying float vAcross;
varying float vHalf;
void main() {
  float d = abs(vAcross) - vHalf;
  float core = 1.0 - smoothstep(-0.7, 0.7, d);
  float a;
  vec3 rgb = vColor.rgb;
  if (uOutlinePass > 0.5) {
    // Drawn first, under every trail: a thin dark outline that keeps light streaks readable on sky, sails and
    // glitter without dark seams where one trail overlaps the next.
    float ol = max(uOutline * uPxScale, 0.5);
    float x = clamp(d / ol, 0.0, 4.0);
    a = clamp(exp(-2.2 * x * x) * 0.3 * vColor.a, 0.0, 1.0);
    rgb = vec3(0.0, 0.02, 0.06);
  } else {
    a = core * vColor.a;
  }
  if (a < 0.003) discard;
  gl_FragColor = vec4(rgb, a);
  ${OVERLAY_OUTPUT}
}
`;

export class TrailRenderer {
  readonly group = new THREE.Group();
  readonly count: number;
  readonly slots: number;
  /** Ring buffer: texel (particle, slot) = (x, y, z, value); row `slot` starts at 4·slot·count. */
  readonly data: Float32Array;
  /** Per-particle opacity. */
  readonly alpha: Float32Array;
  /** Per-particle count of valid points behind the head (0 … slots − 1). */
  readonly hist: Float32Array;
  head = 0;
  private readonly texture: THREE.DataTexture;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly histAttr: THREE.InstancedBufferAttribute;
  /** The whole texture must go up (first use); afterwards only the head row. */
  private fullUpload = true;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly uniforms;

  constructor(ctx: OverlayContext, opts: TrailOptions) {
    this.count = opts.count;
    this.slots = Math.max(3, opts.slots);
    this.data = new Float32Array(this.count * this.slots * 4);
    this.alpha = new Float32Array(this.count);
    this.hist = new Float32Array(this.count);
    this.texture = new THREE.DataTexture(this.data, this.count, this.slots, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    const points: number[] = [], sides: number[] = [], index: number[] = [];
    for (let j = 0; j < this.slots; j++) {
      points.push(j, j);
      sides.push(-1, 1);
      if (j < this.slots - 1) {
        const v = 2 * j;
        index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    this.geometry.setAttribute('aPoint', new THREE.Float32BufferAttribute(points, 1));
    this.geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    // three.js needs a position attribute to size the draw; the shader never reads it.
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.slots * 2 * 3), 3));
    this.geometry.setIndex(index);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alpha, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aAlpha', this.alphaAttr);
    this.histAttr = new THREE.InstancedBufferAttribute(this.hist, 1);
    this.histAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aHist', this.histAttr);
    this.geometry.instanceCount = this.count;

    const u = overlayUniforms();
    this.uniforms = {
      ...u,
      uTrail: { value: this.texture },
      uHead: { value: 0 },
      uSlots: { value: this.slots },
      uFrac: { value: 0 },
      uWidth: { value: opts.width },
      uAlpha: { value: opts.alpha },
      uHiddenAlpha: { value: opts.hiddenAlpha ?? 0 },
      uFlowMode: { value: opts.colorMode === 'flow' ? 1 : 0 },
      uColor: { value: opts.color ?? new THREE.Color(1, 1, 1) },
      uSlow: { value: FLOW_COLORS.slow },
      uNeutral: { value: FLOW_COLORS.neutral },
      uFast: { value: FLOW_COLORS.fast },
      uWake: { value: FLOW_COLORS.wake },
      uOutline: { value: opts.outline ?? 0 },
    };
    // Passes: faint hidden parts (behind sails), then the outline under everything, then the cores.
    const passes: Array<'hidden' | 'outline' | 'core'> = [];
    if ((opts.hiddenAlpha ?? 0) > 0) passes.push('hidden');
    if ((opts.outline ?? 0) > 0) passes.push('outline');
    passes.push('core');
    passes.forEach((pass, order) => {
      const hidden = pass === 'hidden';
      const m = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uHiddenPass: { value: hidden ? 1 : 0 }, uOutlinePass: { value: pass === 'outline' ? 1 : 0 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.geometry, m);
      mesh.renderOrder = (opts.renderOrder ?? 15) + order * 0.1;
      bindOverlayMesh(mesh, u, ctx);
      this.group.add(mesh);
      this.materials.push(m);
    });
  }

  /** Put particle `i` at a point with no history. */
  reset(i: number, x: number, y: number, z: number, w: number): void {
    this.set(i, x, y, z, w);
    this.hist[i] = 0;
  }

  /** Move particle `i`'s newest point. */
  set(i: number, x: number, y: number, z: number, w: number): void {
    const o = 4 * (this.head * this.count + i);
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = w;
  }

  /** Start a new trail point for every particle (it begins where the old head is). */
  push(): void {
    const prev = this.head;
    this.head = (this.head + 1) % this.slots;
    const row = 4 * this.count;
    this.data.copyWithin(this.head * row, prev * row, prev * row + row);
    const last = this.slots - 1;
    for (let i = 0; i < this.count; i++) if (this.hist[i]! < last) this.hist[i] = this.hist[i]! + 1;
  }

  /** Upload this frame's changes (the head row only); `frac` = progress (0…1) toward the next push. */
  commit(frac: number): void {
    this.uniforms.uHead.value = this.head;
    this.uniforms.uFrac.value = frac;
    this.texture.clearUpdateRanges();
    if (!this.fullUpload) this.texture.addUpdateRange(4 * this.head * this.count, 4 * this.count);
    this.fullUpload = false;
    this.texture.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.histAttr.needsUpdate = true;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
    for (const m of this.materials) m.dispose();
  }
}
