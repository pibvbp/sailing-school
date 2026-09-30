// Screen-space-width polylines (ribbons) for laylines, the course line, the track and the flow-slice streamlines.
// Each point becomes two vertices pushed apart in screen space along the averaged normal of its two segments; the
// fragment shader anti-aliases the edges and can draw dashes that crawl along the line (streamline "flow").
// Lines lying on the water use a view-ray depth bias: vertices are pulled toward the eye (which keeps their screen
// position) so wave crests in front do not cut them, while the hull — metres nearer — still hides them properly.
import * as THREE from 'three';
import { OVERLAY_COMMON, OVERLAY_OUTPUT, bindOverlayMesh, overlayUniforms, type OverlayContext } from './overlayMaterial';

export interface LineStyle {
  /** Width (CSS px). */
  width: number;
  alpha: number;
  /** Dash period in `coord` units (0 = solid) and the lit fraction of each period. */
  dash?: number;
  duty?: number;
  /** Dash travel in `coord` units per second (animated dashes). */
  dashSpeed?: number;
  /** Opacity between dashes (0 = gaps are empty; 0.3 = a faint continuous line with bright moving dashes). */
  dashFloor?: number;
  /** Soft outer glow (CSS px). */
  glow?: number;
}

export interface LineBatchOptions {
  /** Pull toward the eye by this fraction of the view distance… */
  depthBiasK?: number;
  /** …plus this many metres. */
  depthBiasC?: number;
  depthTest?: boolean;
  renderOrder?: number;
  /** Opacity of the parts hidden behind geometry (0 = not drawn). */
  hiddenAlpha?: number;
}

const VERT = /* glsl */ `
${OVERLAY_COMMON}
uniform float uBiasK;
uniform float uBiasC;
attribute vec3 prev;
attribute vec3 next;
attribute float side;
attribute vec4 aColor;
attribute vec4 aLine;   // half-width px (CSS), coord, dash period, dash duty
attribute vec3 aAnim;   // dash speed, glow px (CSS), opacity between dashes
varying vec4 vColor;
varying vec3 vLine;     // across (px), coord, half-width (px)
varying vec4 vDash;     // period, duty, speed, glow (px)
varying float vFloor;

vec4 biased(vec3 p) {
  vec4 v = modelViewMatrix * vec4(p, 1.0);
  float dist = length(v.xyz);
  float pull = min(uBiasK * dist + uBiasC, 0.6 * dist);
  v.xyz *= (dist - pull) / max(dist, 1e-4);
  return v;
}

void main() {
  if (uVisible < 0.5 || aColor.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 vc = biased(position);
  vec4 vp = biased(prev);
  vec4 vn = biased(next);
  float zc = -1.001 * projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
  if (projectionMatrix[2][3] == -1.0 && vc.z > zc) {
    // Behind the near plane: slide toward a visible neighbour, or drop the vertex.
    vec4 other = vn.z <= zc ? vn : vp;
    if (other.z > zc) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vc = mix(vc, other, (zc - vc.z) / (other.z - vc.z));
  }
  vec4 cc = projectionMatrix * vc;
  vec4 cp = projectionMatrix * vp;
  vec4 cn = projectionMatrix * vn;
  vec2 sc = cc.xy / cc.w * 0.5 * uResolution;
  vec2 sp = cp.xy / max(cp.w, 1e-4) * 0.5 * uResolution;
  vec2 sn = cn.xy / max(cn.w, 1e-4) * 0.5 * uResolution;
  vec2 d1 = sc - sp;
  vec2 d2 = sn - sc;
  float l1 = length(d1), l2 = length(d2);
  vec2 t1 = l1 > 1e-3 ? d1 / l1 : vec2(0.0);
  vec2 t2 = l2 > 1e-3 ? d2 / l2 : vec2(0.0);
  if (vp.z > zc) t1 = t2;
  if (vn.z > zc) t2 = t1;
  vec2 t = t1 + t2;
  float lt = length(t);
  t = lt > 1e-4 ? t / lt : (l2 > l1 ? t2 : t1);
  vec2 nrm = vec2(-t.y, t.x);
  // Miter, limited so sharp corners do not spike.
  float miter = 1.0;
  if (l1 > 1e-3 && l2 > 1e-3) miter = clamp(1.0 / max(dot(nrm, vec2(-t1.y, t1.x)), 0.3), 1.0, 2.5);
  float hw = (aLine.x + aAnim.y) * uPxScale + 1.0;
  vec2 off = nrm * side * hw * miter;
  cc.xy += off / (0.5 * uResolution) * cc.w;
  gl_Position = cc;
  vColor = vec4(overlayColor(aColor.rgb), aColor.a);
  vLine = vec3(side * hw * miter, aLine.y, aLine.x * uPxScale * miter);
  vDash = vec4(aLine.z, aLine.w, aAnim.x, aAnim.y * uPxScale);
  vFloor = aAnim.z;
}
`;

const FRAG = /* glsl */ `
${OVERLAY_COMMON}
uniform float uTime;
uniform float uHiddenPass;
uniform float uHiddenAlpha;
varying vec4 vColor;
varying vec3 vLine;
varying vec4 vDash;
varying float vFloor;

void main() {
  float d = abs(vLine.x) - vLine.z;
  float core = 1.0 - smoothstep(-0.8, 0.8, d);
  float halo = 0.0;
  if (vDash.w > 0.0) { float g = max(d, 0.0) / vDash.w; halo = 0.35 * exp(-3.0 * g * g) * (1.0 - core); }
  float a = core + halo;
  if (vDash.x > 0.0) {
    float ph = fract((vLine.y - uTime * vDash.z) / vDash.x);
    float w = fwidth(vLine.y) / vDash.x;
    float lit = smoothstep(0.0, w + 1e-4, ph) * (1.0 - smoothstep(vDash.y - w, vDash.y, ph));
    a *= mix(vFloor, 1.0, lit);
  }
  a *= vColor.a * (uHiddenPass > 0.5 ? uHiddenAlpha : 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  ${OVERLAY_OUTPUT}
}
`;

const FLOATS = { position: 3, prev: 3, next: 3, side: 1, aColor: 4, aLine: 4, aAnim: 3 } as const;
type AttrName = keyof typeof FLOATS;

/** A set of polylines, rebuilt whenever its owner calls begin()/add()/end(). */
export class LineBatch {
  readonly group = new THREE.Group();
  readonly uniforms;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly materials: THREE.ShaderMaterial[] = [];
  private attrs = {} as Record<AttrName, THREE.BufferAttribute>;
  private index!: THREE.BufferAttribute;
  private capacity = 0;
  private points = 0;
  private indices = 0;

  constructor(ctx: OverlayContext, capacity = 256, opts: LineBatchOptions = {}) {
    const u = overlayUniforms();
    this.uniforms = {
      ...u,
      uBiasK: { value: opts.depthBiasK ?? 0 },
      uBiasC: { value: opts.depthBiasC ?? 0 },
      uTime: { value: 0 },
      uHiddenAlpha: { value: opts.hiddenAlpha ?? 0 },
    };
    this.allocate(capacity);
    const passes = (opts.hiddenAlpha ?? 0) > 0 ? [true, false] : [false];
    for (const hidden of passes) {
      const m = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uHiddenPass: { value: hidden ? 1 : 0 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: opts.depthTest ?? true,
        depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.geometry, m);
      mesh.renderOrder = (opts.renderOrder ?? 10) + (hidden ? 0 : 1);
      bindOverlayMesh(mesh, u, ctx);
      this.group.add(mesh);
      this.materials.push(m);
    }
  }

  begin(): void {
    this.points = 0;
    this.indices = 0;
  }

  /**
   * Add a polyline. `xyz` holds `count` points (x, y, z …) in the group's frame; `coords` (optional) the dash
   * coordinate per point (default: cumulative length); `alphas` (optional) an opacity per point.
   */
  add(xyz: ArrayLike<number>, count: number, color: THREE.Color, style: LineStyle, coords?: ArrayLike<number>, alphas?: ArrayLike<number>): void {
    if (count < 2) return;
    if (this.points + count > this.capacity) this.allocate(Math.max(this.capacity * 2, this.points + count));
    const a = this.attrs;
    const pos = a.position.array as Float32Array, prv = a.prev.array as Float32Array, nxt = a.next.array as Float32Array;
    const sid = a.side.array as Float32Array, col = a.aColor.array as Float32Array, lin = a.aLine.array as Float32Array;
    const anim = a.aAnim.array as Float32Array;
    const idx = this.index.array as Uint32Array;
    let dist = 0;
    for (let i = 0; i < count; i++) {
      const ip = Math.max(0, i - 1), inx = Math.min(count - 1, i + 1);
      if (i > 0) dist += Math.hypot(xyz[3 * i]! - xyz[3 * ip]!, xyz[3 * i + 1]! - xyz[3 * ip + 1]!, xyz[3 * i + 2]! - xyz[3 * ip + 2]!);
      const coord = coords ? coords[i]! : dist;
      const alpha = style.alpha * (alphas ? alphas[i]! : 1);
      for (let s = 0; s < 2; s++) {
        const v = 2 * (this.points + i) + s;
        for (let k = 0; k < 3; k++) {
          pos[3 * v + k] = xyz[3 * i + k]!;
          prv[3 * v + k] = xyz[3 * ip + k]!;
          nxt[3 * v + k] = xyz[3 * inx + k]!;
        }
        sid[v] = s === 0 ? -1 : 1;
        col[4 * v] = color.r; col[4 * v + 1] = color.g; col[4 * v + 2] = color.b; col[4 * v + 3] = alpha;
        lin[4 * v] = style.width * 0.5; lin[4 * v + 1] = coord; lin[4 * v + 2] = style.dash ?? 0; lin[4 * v + 3] = style.duty ?? 0.5;
        anim[3 * v] = style.dashSpeed ?? 0; anim[3 * v + 1] = style.glow ?? 0; anim[3 * v + 2] = style.dashFloor ?? 0;
      }
      if (i < count - 1) {
        const v0 = 2 * (this.points + i);
        idx[this.indices++] = v0; idx[this.indices++] = v0 + 1; idx[this.indices++] = v0 + 2;
        idx[this.indices++] = v0 + 1; idx[this.indices++] = v0 + 3; idx[this.indices++] = v0 + 2;
      }
    }
    this.points += count;
  }

  end(): void {
    for (const k of Object.keys(FLOATS) as AttrName[]) {
      const attr = this.attrs[k];
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, this.points * 2) * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, Math.max(1, this.indices));
    this.index.needsUpdate = true;
    this.geometry.setDrawRange(0, this.indices);
    this.group.visible = this.indices > 0;
  }

  setTime(t: number): void {
    this.uniforms.uTime.value = t;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }

  private allocate(points: number): void {
    const verts = points * 2;
    for (const k of Object.keys(FLOATS) as AttrName[]) {
      const size = FLOATS[k];
      const attr = new THREE.BufferAttribute(new Float32Array(verts * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      const old = this.attrs[k];
      if (old) (attr.array as Float32Array).set((old.array as Float32Array).subarray(0, Math.min(old.array.length, attr.array.length)));
      this.attrs[k] = attr;
      this.geometry.setAttribute(k, attr);
    }
    const index = new THREE.BufferAttribute(new Uint32Array(points * 6), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    if (this.index) (index.array as Uint32Array).set((this.index.array as Uint32Array).subarray(0, Math.min(this.index.array.length, index.array.length)));
    this.index = index;
    this.geometry.setIndex(index);
    this.capacity = points;
  }
}
