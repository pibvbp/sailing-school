// Flow slice (spec §8 (c)): a translucent plane through the rig at a chosen height, like a textbook figure but live —
// a pressure map (blue suction where the air speeds up, warm pressure where it slows; Cp = 1 − (V/V∞)²) with
// isobars, streamlines whose pulses travel at half the local air speed (so their spacing still shows the speed-up),
// the sail sections cut at that height, and a churning texture where the flow has separated. Lives in the boat frame
// (it heels with the rig, perpendicular to the mast).
import * as THREE from 'three';
import { CAMBER_PTS, FIELD_BOUNDS, SliceField, type FlowSample } from './flowField';
import { guard, hit } from './flowParticles';
import type { Label, LabelLayer } from './labels';
import { LineBatch } from './lines';
import { OVERLAY_COMMON, OVERLAY_OUTPUT, bindOverlayMesh, overlayUniforms, type OverlayContext } from './overlayMaterial';
import { COLORS } from './palette';
import { FLOW_COLORS } from './trails';

export const SLICE_MIN_H = 1.8;
export const SLICE_MAX_H = 9.6;
/** Streamline spacing (m) seen from close by; from further away fewer, finer lines are traced (see `update`). */
const LINE_SPACING = 0.5;
const STREAM_MARGIN = 3.2;
/** Streamlines: a faint continuous line with bright pulses travelling at half the local air speed (coord = seconds). */
const STREAM_STYLE = { width: 1.7, alpha: 0.95, dash: 0.5, duty: 0.3, dashSpeed: 0.5, dashFloor: 0.32 };
/** The same from a distant camera (the top view): finer and quieter, so the sails' sections and the hull show. */
const STREAM_STYLE_FAR = { width: 1.25, alpha: 0.8, dash: 0.5, duty: 0.3, dashSpeed: 0.5, dashFloor: 0.2 };
/** The sails' cut sections: a dark casing under a bright line, so they stand out from the streamlines. */
const CLOTH_CASING = { width: 10.5, alpha: 0.85 };
const CLOTH_STYLE = { width: 4.6, alpha: 1 };
/** Section colours while the angle-of-attack colouring is on: luffing, in the groove, stalled (as the cloth and the HUD). */
const AOA_LUFF = new THREE.Color(COLORS.luffing);
const AOA_OK = new THREE.Color(COLORS.groove);
const AOA_STALL = new THREE.Color(COLORS.stalled);
/** How far (px) the Suction / Pressure tags stand off their peaks. */
const CALLOUT_PX = 40;
/** How far (in quarter steps) the view scale must pass a step's edge before the spacing changes. */
const SPACING_HYSTERESIS = 0.15;
/** RK2 step (m) — a little under half the grid spacing — and the longest streamline in steps. */
const STEP = 0.15;
const MAX_STEPS = 150;
const MAX_LINES = 48;
/** Streamline tracing is spread over frames within this CPU budget (ms). */
const TRACE_BUDGET_MS = 0.15;

const VERT = /* glsl */ `
${OVERLAY_COMMON}
varying vec2 vBody;
void main() {
  if (uVisible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vBody = vec2(-position.z, position.x);   // boat-local (X stbd, Z aft) → body (x fwd, y stbd)
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
${OVERLAY_COMMON}
uniform sampler2D uField;   // R: Cp, G: turbulence, B: speed ratio
uniform vec4 uBounds;       // x0, y0, x1, y1 (body)
uniform vec2 uGrid;         // nx, ny
uniform float uTime;
uniform float uAlpha;
uniform float uHiddenPass;
uniform vec3 uSuction;
uniform vec3 uPressure;
uniform vec3 uNeutral;
uniform vec3 uWake;
uniform vec3 uGlass;
varying vec2 vBody;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec2 span = uBounds.zw - uBounds.xy;
  vec2 g = (vBody - uBounds.xy) / span;                       // 0…1 over the grid
  vec2 uv = (g * (uGrid - 1.0) + 0.5) / uGrid;                 // node centres
  vec4 f = texture2D(uField, uv);
  float cp = f.r;
  float turb = f.g;
  // Suction (Cp < 0) cool, pressure (Cp > 0) warm; strength saturates at Cp −1.8 / +0.9.
  float ts = clamp(-cp / 1.8, 0.0, 1.0);
  float tp = clamp(cp / 0.9, 0.0, 1.0);
  float k = smoothstep(0.18, 1.0, pow(max(max(ts, tp), 1e-5), 0.7));
  vec3 hue = cp < 0.0 ? uSuction : uPressure;
  // A dark glass panel; the pressure field glows on it where the sails change the pressure noticeably.
  vec3 col = mix(uGlass, hue, 0.12 + 0.88 * k);
  float a = mix(0.22, 0.82, k);
  // Isobars every 0.25 of Cp.
  float q = cp * 4.0;
  float w = fwidth(q);
  float iso = 1.0 - smoothstep(0.0, 1.2 * w, abs(fract(q + 0.5) - 0.5));
  iso *= smoothstep(0.1, 0.2, abs(cp));
  col = mix(col, vec3(1.0), iso * 0.5);
  a = max(a, iso * 0.38);
  // Separated flow: a churning, drifting mottle.
  if (turb > 0.02) {
    float n = noise(vBody * 2.3 + vec2(uTime * 1.7, -uTime * 1.1)) * 0.6 + noise(vBody * 5.1 - vec2(uTime * 2.9, uTime * 0.7)) * 0.4;
    float m = turb * (0.45 + 0.55 * n);
    col = mix(col, uWake, clamp(m * 1.2, 0.0, 1.0));
    a = mix(a, 0.45 + 0.35 * n, clamp(turb * 1.3, 0.0, 1.0));
  }
  // Soft, rounded edges so the plane reads as a slice of air, not a board.
  vec2 e = min(vBody - uBounds.xy, uBounds.zw - vBody);
  vec2 c = max(3.2 - e, 0.0);
  float edge = 3.2 - length(c);
  a *= smoothstep(0.0, 2.6, edge);
  gl_FragColor = vec4(overlayColor(col), a * uAlpha * (uHiddenPass > 0.5 ? 0.55 : 1.0));
  ${OVERLAY_OUTPUT}
}
`;

export class FlowSlice {
  readonly group = new THREE.Group();
  readonly field: SliceField;
  private readonly plane: THREE.Mesh;
  private readonly planes: THREE.Mesh[];
  private readonly material: THREE.ShaderMaterial;
  private readonly materials: THREE.ShaderMaterial[];
  private readonly texture: THREE.DataTexture;
  private readonly texData: Uint16Array;
  private readonly stream: LineBatch;
  private readonly cloth: LineBatch;
  private readonly buf = new Float32Array(3 * (MAX_STEPS + 2));
  /** Traced streamlines waiting to replace the shown set: points (x, y, z), time-of-flight and opacity per point. */
  private readonly tracePts = new Float32Array(MAX_LINES * 3 * (MAX_STEPS + 2));
  private readonly traceCoords = new Float32Array(MAX_LINES * (MAX_STEPS + 2));
  private readonly traceAlphas = new Float32Array(MAX_LINES * (MAX_STEPS + 2));
  private readonly traceCount = new Int32Array(MAX_LINES);
  private readonly seedX = new Float32Array(MAX_LINES);
  private readonly seedY = new Float32Array(MAX_LINES);
  private seeds = 0;
  private nextSeed = 0;
  private tracing = false;
  private readonly smp: FlowSample = { u: 0, v: 0, ratio: 1, turb: 0 };
  private readonly white = new THREE.Color('#ffffff');
  private readonly clothColor = new THREE.Color('#ffffff');
  private readonly casingColor = new THREE.Color('#04101f');
  private spacing = LINE_SPACING;
  /** Spacing step (quarters of LINE_SPACING, from the view scale); −1 until the first update. */
  private spacingStep = -1;
  private aoa = false;
  private quiet = false;
  private readonly tagLabel: Label;
  private readonly lowLabel: Label;
  private readonly highLabel: Label;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly low = { x: 0, y: 0, cp: 0 };
  private readonly high = { x: 0, y: 0, cp: 0 };
  private seenVersion = -1;
  private time = 0;
  height: number;

  constructor(ctx: OverlayContext, layer: LabelLayer, height = 4.5) {
    this.height = height;
    this.field = new SliceField(height);
    const { x0, y0, x1, y1 } = FIELD_BOUNDS;
    const geo = new THREE.PlaneGeometry(y1 - y0, x1 - x0, 1, 1).rotateX(-Math.PI / 2);
    // Local X = body y, local Z = −body x.
    geo.translate(0.5 * (y0 + y1), 0, -0.5 * (x0 + x1));
    const nx = this.field.nx, ny = this.field.ny;
    this.texData = new Uint16Array(nx * ny * 4);
    this.texture = new THREE.DataTexture(this.texData, nx, ny, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    const u = overlayUniforms();
    const uniforms = {
      ...u,
      uField: { value: this.texture },
      uBounds: { value: new THREE.Vector4(x0, y0, x1, y1) },
      uGrid: { value: new THREE.Vector2(nx, ny) },
      uTime: { value: 0 },
      uAlpha: { value: 0 },
      uSuction: { value: new THREE.Color('#38c2ff') },
      uPressure: { value: new THREE.Color('#ff6d3f') },
      uNeutral: { value: FLOW_COLORS.neutral },
      uWake: { value: FLOW_COLORS.wake },
      uGlass: { value: new THREE.Color('#06121f') },
    };
    // The part of the slice behind the sails (seen through the cloth above it) is drawn at half strength.
    this.materials = [true, false].map((hidden) => new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uHiddenPass: { value: hidden ? 1 : 0 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    }));
    this.material = this.materials[1]!;
    this.planes = this.materials.map((m, i) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.renderOrder = 12 + i * 0.1;
      bindOverlayMesh(mesh, u, ctx);
      return mesh;
    });
    this.plane = this.planes[1]!;
    this.stream = new LineBatch(ctx, 4096, { renderOrder: 17, hiddenAlpha: 0.5 });
    // Seen from above, the sail's upper part lies over its own cut: the sections are drawn through the cloth at
    // nearly full strength (they are the subject of the picture).
    this.cloth = new LineBatch(ctx, 128, { renderOrder: 18, hiddenAlpha: 0.92, depthBiasC: 0.25 });
    this.group.add(...this.planes, this.stream.group, this.cloth.group);
    this.group.name = 'overlay-flow-slice';
    this.tagLabel = layer.create({ kind: 'tag', color: '#f4f7fb', priority: 6 });
    // Callouts: the tags stand off the sail (to leeward of the suction peak, to windward of the pressure peak) with a
    // leader line, so they never cover the section they describe.
    this.lowLabel = layer.create({ color: '#8fd0ff', priority: 5, leader: true });
    this.highLabel = layer.create({ color: '#ffb08a', priority: 5, leader: true });
    this.setHeight(height);
  }

  setHeight(h: number): void {
    this.height = Math.min(SLICE_MAX_H, Math.max(SLICE_MIN_H, h));
    this.field.h = this.height;
    for (const p of this.planes) p.position.y = this.height;
    // The owner (Overlays.setSliceHeight) queues a forced rebuild of the field at the new height.
  }

  /**
   * Leave the slice's own tags out (its height and speed, the suction and pressure peaks): the picture's subject is
   * something drawn on top of it — the lift/drag figure of the Forces overlay — and its tags are the ones to read.
   */
  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
  }

  /** Colour the sails' sections by their angle of attack (blue luffing, green in the groove, red stalled). */
  setAoaColouring(on: boolean): void {
    if (on === this.aoa) return;
    this.aoa = on;
    if (this.seenVersion > 0) this.drawCloth();
  }

  /**
   * Per frame: fade in (real time `dt`), animate the churn and the streamline pulses (air time `flowDt`, frozen while
   * paused), pick up a rebuilt field. `toWorld` maps body points to world for the labels. `viewScale` (1 at the chase
   * camera's distance, larger further away) thins the streamlines out for a distant camera.
   */
  update(dt: number, flowDt: number, toWorld: (x: number, y: number, z: number, out: THREE.Vector3) => THREE.Vector3, viewScale = 1): void {
    this.time += flowDt;
    // Lines 0.5 m apart are 10 px apart from 70 m up — hatching that hides the boat. Trace them further apart there.
    // In steps of a quarter, with hysteresis: a camera resting on a step's edge must not retrace every frame.
    const x = viewScale * 3;
    if (this.spacingStep < 0 || Math.abs(x - this.spacingStep) > 0.5 + SPACING_HYSTERESIS) this.spacingStep = Math.round(x);
    const spacing = LINE_SPACING * Math.min(2.5, Math.max(1, this.spacingStep / 4));
    if (spacing !== this.spacing) {
      this.spacing = spacing;
      if (this.seenVersion > 0) this.startTrace();
    }
    const u = this.material.uniforms;
    u['uTime']!.value = this.time;
    u['uAlpha']!.value = Math.min(1, (u['uAlpha']!.value as number) + dt * 3);
    this.stream.setTime(this.time);
    if (this.field.version !== this.seenVersion && this.field.version > 0) {
      this.seenVersion = this.field.version;
      this.upload();
      this.drawCloth();
      this.startTrace();
    }
    if (this.tracing) this.traceSome();
    if (this.quiet) {
      this.tagLabel.hide();
      this.lowLabel.hide();
      this.highLabel.hide();
      return;
    }
    const f = this.field;
    toWorld(f.x1 - 1.2, f.y0 + 1.5, -this.height, this.tmp);
    this.tagLabel.text('Flow slice', `${this.height.toFixed(1)} m up · ${(f.speed / 0.514444).toFixed(1)} kn`).at(this.tmp, 0, 0);
    if (this.low.cp < -0.3) {
      this.callout(this.lowLabel.text('Suction', `Cp ${this.low.cp.toFixed(1)}`), this.low.x, this.low.y, 1, toWorld);
    } else this.lowLabel.hide();
    if (this.high.cp > 0.3) {
      this.callout(this.highLabel.text('Pressure', `Cp +${this.high.cp.toFixed(1)}`), this.high.x, this.high.y, -1, toWorld);
    } else this.highLabel.hide();
  }

  /**
   * Anchor a tag at a point of the slice (body x, y) and stand it off toward the lee side (`side` = 1) or the
   * windward side (−1) of the nearest sail section.
   */
  private callout(label: Label, x: number, y: number, side: number, toWorld: (x: number, y: number, z: number, out: THREE.Vector3) => THREE.Vector3): void {
    const f = this.field;
    let nx = 0, ny = side, best = Infinity;
    for (let e = 0; e < f.count; e++) {
      const el = f.elements[e]!;
      const mx = 0.5 * (el.leX + el.teX) - x, my = 0.5 * (el.leY + el.teY) - y;
      const d = mx * mx + my * my;
      if (d < best) { best = d; nx = el.nX * side; ny = el.nY * side; }
    }
    toWorld(x - nx, y - ny, -this.height, this.tmp2);
    label.tip(toWorld(x, y, -this.height, this.tmp), this.tmp2, CALLOUT_PX);
  }

  hide(): void {
    this.tagLabel.hide();
    this.lowLabel.hide();
    this.highLabel.hide();
    this.material.uniforms['uAlpha']!.value = 0;
  }

  dispose(): void {
    this.plane.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.texture.dispose();
    this.stream.dispose();
    this.cloth.dispose();
  }

  /** Field → half-float texture (Cp, turbulence, speed ratio); also finds the suction peak and stagnation spot near the sails. */
  private upload(): void {
    const f = this.field;
    const d = f.data;
    const out = this.texData;
    const toHalf = THREE.DataUtils.toHalfFloat;
    this.low.cp = 0; this.high.cp = 0;
    for (let j = 0; j < f.ny; j++) {
      for (let i = 0; i < f.nx; i++) {
        const k = j * f.nx + i;
        const ratio = d[4 * k + 2]!;
        const turb = d[4 * k + 3]!;
        // In separated air Bernoulli does not hold across the wake: show the base pressure (slightly below ambient).
        const cpFlow = 1 - ratio * ratio;
        const cp = cpFlow + (-0.35 - cpFlow) * Math.min(1, turb * 1.4);
        out[4 * k] = toHalf(cp);
        out[4 * k + 1] = toHalf(turb);
        out[4 * k + 2] = toHalf(ratio);
        out[4 * k + 3] = toHalf(1);
        if (turb < 0.2) {
          const x = f.x0 + i * f.dx, y = f.y0 + j * f.dy;
          if (cp < this.low.cp) { this.low.cp = cp; this.low.x = x; this.low.y = y; }
          if (cp > this.high.cp) { this.high.cp = cp; this.high.x = x; this.high.y = y; }
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  /** Seeds for a new set of streamlines: a line across the flow, covering the sails' cut plus a margin. */
  private startTrace(): void {
    const f = this.field;
    const U = f.speed;
    const ux = f.uInf.x / U, uy = f.uInf.y / U;
    const nx = -uy, ny = ux;
    let sMin = -2, sMax = 2;
    if (f.count > 0) {
      sMin = Infinity; sMax = -Infinity;
      for (let e = 0; e < f.count; e++) {
        const el = f.elements[e]!;
        const a = el.leX * nx + el.leY * ny, b = el.teX * nx + el.teY * ny;
        sMin = Math.min(sMin, a, b); sMax = Math.max(sMax, a, b);
      }
    }
    this.seeds = 0;
    for (let sc = sMin - STREAM_MARGIN; sc <= sMax + STREAM_MARGIN + 1e-6 && this.seeds < MAX_LINES; sc += this.spacing) {
      // Start on the upstream edge of the grid.
      let x = 0.75 * ux + sc * nx, y = 0.75 * uy + sc * ny;
      for (let back = 0; back < 200 && f.inBounds(x - ux * 0.2, y - uy * 0.2); back++) { x -= ux * 0.2; y -= uy * 0.2; }
      if (!f.inBounds(x, y)) continue;
      this.seedX[this.seeds] = x;
      this.seedY[this.seeds] = y;
      this.seeds++;
    }
    this.nextSeed = 0;
    this.tracing = true;
  }

  /** Trace streamlines until the frame's budget is spent; publish the set when complete. */
  private traceSome(): void {
    const t0 = performance.now();
    while (this.nextSeed < this.seeds) {
      this.traceLine(this.nextSeed);
      this.nextSeed++;
      if (performance.now() - t0 > TRACE_BUDGET_MS) return;
    }
    this.tracing = false;
    this.stream.begin();
    const stride = MAX_STEPS + 2;
    const style = this.spacing > 1.5 * LINE_SPACING ? STREAM_STYLE_FAR : STREAM_STYLE;
    for (let i = 0; i < this.seeds; i++) {
      const n = this.traceCount[i]!;
      if (n > 4) {
        this.stream.add(this.tracePts.subarray(3 * i * stride, 3 * (i * stride + n)), n, this.white, style,
          this.traceCoords.subarray(i * stride, i * stride + n), this.traceAlphas.subarray(i * stride, i * stride + n));
      }
    }
    this.stream.end();
  }

  /** One streamline through the (tangent) advection field, RK2 with a fixed arc-length step. */
  private traceLine(i: number): void {
    const f = this.field;
    const U = f.speed;
    const stride = MAX_STEPS + 2;
    const P = this.tracePts, C = this.traceCoords, A = this.traceAlphas;
    const o = i * stride;
    let x = this.seedX[i]!, y = this.seedY[i]!;
    // Stagger the travelling pulses from line to line so they read as flow, not as rows.
    let tof = ((i * 0.618034) % 1) * STREAM_STYLE.dash;
    let n = 0;
    for (let st = 0; st < MAX_STEPS; st++) {
      const L = 3 * (o + n);
      P[L] = y; P[L + 1] = this.height + 0.02; P[L + 2] = -x;
      C[o + n] = tof;
      f.sample(x, y, this.smp);
      A[o + n] = 1 - Math.min(0.75, this.smp.turb);
      n++;
      let sp = Math.hypot(this.smp.u, this.smp.v);
      if (sp < 0.04 * U) break;
      const mx = x + 0.5 * STEP * this.smp.u / sp, my = y + 0.5 * STEP * this.smp.v / sp;
      f.sample(mx, my, this.smp);
      sp = Math.hypot(this.smp.u, this.smp.v);
      if (sp < 0.04 * U) break;
      let nx = x + STEP * this.smp.u / sp, ny = y + STEP * this.smp.v / sp;
      for (let e = 0; e < f.count; e++) if (guard(f.elements[e]!, x, y, nx, ny)) { nx = hit.x; ny = hit.y; break; }
      tof += Math.hypot(nx - x, ny - y) / Math.max(sp, 0.05 * U);
      x = nx; y = ny;
      if (!f.inBounds(x, y)) break;
    }
    // Fade both ends into the slice's soft edge.
    for (let k = 0; k < n; k++) A[o + k]! *= Math.min(1, k / 4, (n - 1 - k) / 4 + 0.001);
    this.traceCount[i] = n;
  }

  /**
   * The sails cut at this height: bold sections on a dark casing — white, or with the angle-of-attack colouring on,
   * blue where the cut luffs, green in the groove, red where it is stalled.
   */
  private drawCloth(): void {
    const f = this.field;
    this.cloth.begin();
    for (let pass = 0; pass < 2; pass++) {
      for (let e = 0; e < f.count; e++) {
        const el = f.elements[e]!;
        for (let k = 0; k < CAMBER_PTS; k++) {
          this.buf[3 * k] = el.pts[2 * k + 1]!;
          this.buf[3 * k + 1] = this.height + (pass === 0 ? 0.03 : 0.05);
          this.buf[3 * k + 2] = -el.pts[2 * k]!;
        }
        if (pass === 0) { this.cloth.add(this.buf, CAMBER_PTS, this.casingColor, CLOTH_CASING); continue; }
        if (this.aoa) {
          const luff = Math.min(1, Math.max(0, el.luffing * 1.6)), stall = Math.min(1, Math.max(0, el.stall * 1.6));
          this.clothColor.copy(AOA_OK).lerp(AOA_LUFF, luff).lerp(AOA_STALL, stall);
        } else {
          this.clothColor.set(1, 1, 1);
        }
        this.cloth.add(this.buf, CAMBER_PTS, this.clothColor, CLOTH_STYLE);
      }
    }
    this.cloth.end();
  }
}
