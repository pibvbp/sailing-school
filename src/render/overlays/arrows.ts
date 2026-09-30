// Vector arrows for the physics overlays: one instanced draw for every arrow on screen.
//
// Each arrow is a single screen-aligned quad built in the vertex shader from its two world-space end points; the
// fragment shader draws the arrow as a signed-distance shape (rounded shaft + triangular head), so edges are
// anti-aliased, widths are constant in screen pixels (readable at any camera distance), and a soft glow and a thin
// dark rim cost nothing extra. Short arrows shrink their heads; an arrow pointing (almost) straight at the camera
// becomes the physics symbol ⊙ (toward you) or ⊗ (away). Depth: a first pass draws what is visible, a second pass
// (depthFunc Greater) draws the hidden parts faintly — forces under water or behind a sail stay readable but read as
// "behind". Arrows never write depth, so they cannot z-fight the water or each other.
//
// Third-party code: the fragment shader's `sdTriangle` is adapted from Inigo Quilez, "Triangle - distance 2D"
// (https://www.shadertoy.com/view/XsXSz4, https://iquilezles.org/articles/distfunctions2d/). Adapted for
// sailing-school (renamed parameters, inlined). Also listed in THIRD_PARTY_NOTICES.md. Its licence:
//
//   The MIT License
//   Copyright © 2014 Inigo Quilez
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//   copyright notice and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//   SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
import * as THREE from 'three';
import { OVERLAY_COMMON, OVERLAY_OUTPUT, bindOverlayMesh, overlayUniforms, type OverlayContext } from './overlayMaterial';

export interface ArrowStyle {
  /** Shaft width (CSS px). */
  width: number;
  /** Head length and width (CSS px). */
  head: number;
  headWidth: number;
  /** Glow radius (CSS px); 0 = none. */
  glow: number;
  /** 0…1 overall opacity. */
  alpha: number;
  /** Opacity multiplier for the parts hidden behind geometry (default 0.35). */
  hidden?: number;
}

export const ARROW_BOLD: ArrowStyle = { width: 6.5, head: 25, headWidth: 22, glow: 9, alpha: 1, hidden: 0.72 };
export const ARROW_MEDIUM: ArrowStyle = { width: 4.6, head: 19, headWidth: 16, glow: 7, alpha: 1, hidden: 0.6 };
export const ARROW_THIN: ArrowStyle = { width: 3, head: 13, headWidth: 11, glow: 4, alpha: 0.92, hidden: 0.45 };

const VERT = /* glsl */ `
${OVERLAY_COMMON}
uniform float uHiddenPass;
attribute vec2 corner;
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec4 aColor;
attribute vec4 aShape;   // shaft half-width, head length, head half-width, glow (CSS px)
attribute float aHidden; // opacity factor in the hidden pass
varying vec2 vP;
varying float vLen;
varying vec4 vShape;
varying vec4 vColor;
varying float vEndOn;

void main() {
  vec4 vs = viewMatrix * vec4(aStart, 1.0);
  vec4 ve = viewMatrix * vec4(aEnd, 1.0);
  bool persp = projectionMatrix[2][3] == -1.0;
  // The arrow in view space (metres): a vector that is merely small fades out; only one that really points along
  // the line of sight becomes the ⊙ / ⊗ symbol.
  vec3 dv = ve.xyz - vs.xyz;
  float worldLen = length(dv);
  vec3 sight = persp ? normalize(0.5 * (vs.xyz + ve.xyz)) : vec3(0.0, 0.0, -1.0);
  bool alongSight = worldLen > 0.05 && abs(dot(dv, sight)) > 0.95 * worldLen;
  float present = smoothstep(0.015, 0.06, worldLen);
  if (uVisible < 0.5 || aColor.a <= 0.0 || present <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (persp) {
    // Trim the part behind the near plane so the projection stays valid.
    float zc = -1.001 * projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
    if (vs.z > zc && ve.z > zc) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    if (vs.z > zc) vs = mix(vs, ve, (zc - vs.z) / (ve.z - vs.z));
    else if (ve.z > zc) ve = mix(ve, vs, (zc - ve.z) / (vs.z - ve.z));
  }
  vec4 cs = projectionMatrix * vs;
  vec4 ce = projectionMatrix * ve;
  vec3 ns = cs.xyz / cs.w;
  vec3 ne = ce.xyz / ce.w;
  vec2 ss = (ns.xy * 0.5 + 0.5) * uResolution;
  vec2 se = (ne.xy * 0.5 + 0.5) * uResolution;
  vec2 d = se - ss;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  float shaftHalf = aShape.x * uPxScale;
  float headLen = aShape.y * uPxScale;
  float headHalf = aShape.z * uPxScale;
  float glow = aShape.w * uPxScale;
  float hl = min(headLen, 0.55 * len);
  float hh = max(headHalf * hl / max(headLen, 1e-4), 1.5 * shaftHalf);

  float endOn = 0.0;
  vec2 p;
  float along;
  float across;
  float z;
  if (alongSight && len < 0.4 * headLen) {
    // Seen end-on: a circle with a dot (pointing at the viewer) or a cross (pointing away).
    endOn = dot(dv, sight) < 0.0 ? 1.0 : -1.0;
    float r = headHalf + glow + 2.0;
    vec2 q = vec2(corner.x * 2.0 - 1.0, corner.y) * r;
    p = 0.5 * (ss + se) + q;
    along = q.x;
    across = q.y;
    z = 0.5 * (ns.z + ne.z);
    hh = headHalf;
  } else {
    float pad = max(hh, shaftHalf) + glow + 2.0;
    along = mix(-(shaftHalf + glow + 2.0), len + glow + 2.0, corner.x);
    across = corner.y * pad;
    p = ss + dir * along + nrm * across;
    z = mix(ns.z, ne.z, clamp(along / len, 0.0, 1.0));
  }
  gl_Position = vec4(p / uResolution * 2.0 - 1.0, clamp(z, -1.0, 1.0), 1.0);
  vP = vec2(along, across);
  vLen = len;
  vShape = vec4(shaftHalf, hl, hh, glow);
  vEndOn = endOn;
  vColor = vec4(overlayColor(aColor.rgb), aColor.a * present * (uHiddenPass > 0.5 ? aHidden : 1.0));
}
`;

const FRAG = /* glsl */ `
${OVERLAY_COMMON}
uniform float uHiddenPass;
varying vec2 vP;
varying float vLen;
varying vec4 vShape;
varying vec4 vColor;
varying float vEndOn;

// Signed distance to a triangle — adapted from Inigo Quilez (MIT, © 2014; see the file header).
float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

void main() {
  float shaftHalf = vShape.x;
  float hl = vShape.y;
  float hh = vShape.z;
  float glow = vShape.w;
  float d;
  if (abs(vEndOn) > 0.5) {
    float r = 0.8 * hh;
    float rr = length(vP);
    d = abs(rr - r) - max(0.8 * shaftHalf, 1.0);
    if (vEndOn > 0.0) {
      d = min(d, rr - max(1.3 * shaftHalf, 1.6));
    } else {
      float c = min(abs(vP.x - vP.y), abs(vP.x + vP.y)) * 0.70710678 - max(0.8 * shaftHalf, 1.0);
      d = min(d, max(c, rr - 0.62 * r));
    }
  } else {
    float shaftEnd = max(vLen - 0.8 * hl, 0.0);
    vec2 q = vec2(vP.x - clamp(vP.x, 0.0, shaftEnd), vP.y);
    float dShaft = length(q) - shaftHalf;
    float dHead = sdTriangle(vP, vec2(vLen, 0.0), vec2(vLen - hl, hh), vec2(vLen - hl, -hh)) - 0.6;
    d = min(dShaft, dHead);
  }
  float aa = 0.8;
  float core = 1.0 - smoothstep(-aa, aa, d);
  float rim = (1.0 - core) * (1.0 - smoothstep(0.6, 1.8, d)) * 0.3;
  float halo = 0.0;
  if (glow > 0.0) {
    float g = max(d, 0.0) / glow;
    halo = (uHiddenPass > 0.5 ? 0.2 : 0.42) * exp(-3.0 * g * g) * (1.0 - core);
  }
  float a = core + halo + rim * (1.0 - halo);
  if (a < 0.002) discard;
  vec3 rgb = vColor.rgb * (core + halo) / a;
  gl_FragColor = vec4(rgb, min(a, 1.0) * vColor.a);
  ${OVERLAY_OUTPUT}
}
`;

function makeMaterial(uniforms: Record<string, THREE.IUniform>, hidden: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uHiddenPass: { value: hidden ? 1 : 0 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
    premultipliedAlpha: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    toneMapped: false,
  });
}

/** A growable set of arrows redrawn every frame: `begin()`, `add(...)` any number, `end()`. */
export class ArrowBatch {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly materials: THREE.ShaderMaterial[];
  private start!: THREE.InstancedBufferAttribute;
  private end_!: THREE.InstancedBufferAttribute;
  private color!: THREE.InstancedBufferAttribute;
  private shape!: THREE.InstancedBufferAttribute;
  private hidden!: THREE.InstancedBufferAttribute;
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private capacity = 0;
  private count = 0;

  constructor(ctx: OverlayContext, capacity = 48, renderOrder = 20) {
    this.geometry.setAttribute('corner', new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.allocate(capacity);
    const u = overlayUniforms();
    this.materials = [makeMaterial(u, false), makeMaterial(u, true)];
    // Hidden parts first, so the visible pass (and its glow) lands on top.
    this.materials.forEach((m, i) => {
      const mesh = new THREE.Mesh(this.geometry, m);
      mesh.renderOrder = renderOrder + (i === 0 ? 1 : 0);
      bindOverlayMesh(mesh, u, ctx);
      this.group.add(mesh);
    });
    this.group.name = 'overlay-arrows';
  }

  begin(): void {
    this.count = 0;
  }

  /** Arrow from `a` to `b` (world space). Colours are linear-sRGB display targets. */
  add(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, style: ArrowStyle, alpha = 1): void {
    if (this.count >= this.capacity) this.allocate(this.capacity * 2);
    const i = this.count++;
    this.start.setXYZ(i, a.x, a.y, a.z);
    this.end_.setXYZ(i, b.x, b.y, b.z);
    this.color.setXYZW(i, color.r, color.g, color.b, style.alpha * alpha);
    this.shape.setXYZW(i, style.width * 0.5, style.head, style.headWidth * 0.5, style.glow);
    this.hidden.setX(i, style.hidden ?? 0.35);
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    for (let i = 0; i < this.attrs.length; i++) {
      const attr = this.attrs[i]!;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, this.count) * attr.itemSize);
      attr.needsUpdate = true;
    }
    const ch = this.group.children;
    for (let i = 0; i < ch.length; i++) ch[i]!.visible = this.count > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }

  private allocate(capacity: number): void {
    // Growing: free the old GL buffers and three's instance-count latch (`_maxInstanceCount`, set at the first draw),
    // which would otherwise keep clamping draws to the old capacity.
    if (this.capacity > 0) this.geometry.dispose();
    const grow = (old: THREE.InstancedBufferAttribute | undefined, size: number) => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      if (old) (attr.array as Float32Array).set(old.array as Float32Array);
      return attr;
    };
    this.start = grow(this.start, 3);
    this.end_ = grow(this.end_, 3);
    this.color = grow(this.color, 4);
    this.shape = grow(this.shape, 4);
    this.hidden = grow(this.hidden, 1);
    this.geometry.setAttribute('aStart', this.start);
    this.geometry.setAttribute('aEnd', this.end_);
    this.geometry.setAttribute('aColor', this.color);
    this.geometry.setAttribute('aShape', this.shape);
    this.geometry.setAttribute('aHidden', this.hidden);
    this.attrs = [this.start, this.end_, this.color, this.shape, this.hidden];
    this.capacity = capacity;
  }
}
