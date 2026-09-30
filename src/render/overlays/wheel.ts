// Points-of-sail wheel (spec §8): a ring on the water around the boat, fixed to the true wind, divided into
// no-go / close-hauled / close reach / beam reach / broad reach / run on both tacks, with a compass-style tick
// scale, a wind arrow blowing in across the no-go zone and a "you are here" pointer at the boat's heading.
// One mesh; sectors, ticks, hatching and the pointer are drawn procedurally in the fragment shader.
import * as THREE from 'three';
import type { SimSnapshot } from '../../sim/types';
import { DEG } from '../../shared/math';
import { ARROW_BOLD, type ArrowBatch } from './arrows';
import { bearingToWorld } from './frames';
import type { Label, LabelLayer } from './labels';
import { OVERLAY_COMMON, OVERLAY_OUTPUT, bindOverlayMesh, overlayUniforms, type OverlayContext } from './overlayMaterial';
import { COLORS, linearColor } from './palette';

/** Sector upper bounds in |TWA| degrees (no-go matches the HUD's 40°, glossary ranges for the rest). */
export const SECTORS = [
  { name: 'No-go zone', short: 'No-go', upTo: 40 },
  { name: 'Close-hauled', short: 'Close-hauled', upTo: 52 },
  { name: 'Close reach', short: 'Close reach', upTo: 80 },
  { name: 'Beam reach', short: 'Beam reach', upTo: 100 },
  { name: 'Broad reach', short: 'Broad reach', upTo: 155 },
  { name: 'Run', short: 'Run', upTo: 180 },
] as const;

/** Index into {@link SECTORS} for a signed or unsigned true wind angle (rad). */
export function pointOfSail(twa: number): number {
  const a = Math.abs(twa) / DEG;
  for (let i = 0; i < SECTORS.length; i++) if (a < SECTORS[i]!.upTo) return i;
  return SECTORS.length - 1;
}

const INNER = 10.5;
const OUTER = 14;

const VERT = /* glsl */ `
${OVERLAY_COMMON}
varying vec2 vXZ;
void main() {
  if (uVisible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vXZ = position.xz;
  vec4 v = modelViewMatrix * vec4(position, 1.0);
  // View-ray depth bias: stays under the boat, rides over wave crests.
  float dist = length(v.xyz);
  v.xyz *= max(dist - (0.07 * dist + 0.6), 0.5 * dist) / max(dist, 1e-4);
  gl_Position = projectionMatrix * v;
}
`;

const FRAG = /* glsl */ `
${OVERLAY_COMMON}
#define PI 3.14159265
uniform float uTwd;
uniform float uHeading;
uniform float uInner;
uniform float uOuter;
uniform float uAlpha;
uniform float uBounds[5];
uniform vec3 uNoGo;
uniform vec3 uAccent;
uniform vec3 uWhite;
varying vec2 vXZ;

float wrapPi(float a) { return a - 2.0 * PI * floor((a + PI) / (2.0 * PI)); }
/** 1 on a line of \`px\` pixels around distance 0 (d and aa in the same units, aa = units per pixel). */
float lineAA(float d, float aa, float px) { return 1.0 - smoothstep((px - 1.0) * 0.5 * aa, (px + 1.0) * 0.5 * aa, d); }

void main() {
  float r = length(vXZ);
  float aaR = fwidth(r);
  float inside = smoothstep(uInner - aaR, uInner + aaR, r) * (1.0 - smoothstep(uOuter - aaR, uOuter + aaR, r));
  if (inside <= 0.0) discard;
  float bearing = atan(vXZ.x, -vXZ.y);
  float rel = wrapPi(bearing - uTwd);          // 0 = straight upwind
  float a = abs(rel);
  float here = wrapPi(uHeading - uTwd);        // the boat's heading on the same scale
  float aHere = abs(here);
  float aaA = fwidth(a) + 1e-5;
  float sector = 5.0;
  for (int i = 4; i >= 0; i--) if (a < uBounds[i]) sector = float(i);
  float sectorHere = 5.0;
  for (int i = 4; i >= 0; i--) if (aHere < uBounds[i]) sectorHere = float(i);
  bool sameSide = rel * here >= 0.0 || sector == 0.0 || sector == 5.0;
  bool current = sector == sectorHere && sameSide;

  float t = (r - uInner) / (uOuter - uInner);   // 0 inner … 1 outer
  vec3 col = uWhite;
  float alpha = 0.12 + 0.06 * t;
  if (sector == 0.0) {
    // No-go: red with diagonal hatching.
    float hatch = smoothstep(0.45, 0.55, fract((vXZ.x + vXZ.y) * 0.8));
    col = uNoGo;
    alpha = 0.18 + 0.16 * hatch;
  }
  if (current) { col = sector == 0.0 ? uNoGo : mix(uWhite, uAccent, 0.3); alpha += 0.17; }

  // Sector boundaries, rims and a tick scale on the outer rim (every 10°, longer every 30°).
  float edge = 0.0;
  for (int i = 0; i < 5; i++) edge = max(edge, lineAA(abs(a - uBounds[i]), aaA, 1.6));
  float deg = a / PI * 180.0;
  float aaD = aaA / PI * 180.0;
  float tick10 = lineAA(abs(fract(deg / 10.0 + 0.5) - 0.5) * 10.0, aaD, 1.2) * step(0.8, t);
  float tick30 = lineAA(abs(fract(deg / 30.0 + 0.5) - 0.5) * 30.0, aaD, 1.6) * step(0.62, t);
  float rims = max(lineAA(abs(r - uInner), aaR, 1.4), lineAA(abs(r - uOuter), aaR, 2.0));
  float lines = max(max(edge, rims), max(tick10 * 0.65, tick30 * 0.9));
  col = mix(col, uWhite, lines);
  alpha = max(alpha, lines * 0.85);

  // "You are here": a bright wedge at the heading pointing outward, the full depth of the ring.
  float dh = abs(wrapPi(bearing - uHeading)) * r;   // arc distance (m) from the heading line
  float pointer = 1.0 - smoothstep(0.0, aaR * 1.5, dh - (0.07 + 0.6 * (1.0 - t)));
  col = mix(col, uAccent, pointer);
  alpha = max(alpha, pointer * 0.95);

  gl_FragColor = vec4(overlayColor(col), alpha * inside * uAlpha);
  ${OVERLAY_OUTPUT}
}
`;

export class PointsOfSailWheel {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly sectorLabels: Label[] = [];
  private readonly hereLabel: Label;
  private readonly windLabel: Label;
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly windColor = linearColor(COLORS.trueWind);
  private twd = NaN;

  constructor(ctx: OverlayContext, private readonly arrows: ArrowBatch, layer: LabelLayer) {
    const geo = new THREE.RingGeometry(INNER, OUTER, 256, 1).rotateX(-Math.PI / 2);
    const u = overlayUniforms();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...u,
        uTwd: { value: 0 },
        uHeading: { value: 0 },
        uInner: { value: INNER },
        uOuter: { value: OUTER },
        uAlpha: { value: 1 },
        uBounds: { value: SECTORS.slice(0, 5).map((s) => s.upTo * DEG) },
        uNoGo: { value: linearColor(COLORS.noGo) },
        uAccent: { value: linearColor(COLORS.apparentWind) },
        uWhite: { value: linearColor(COLORS.white) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'overlay-wheel';
    this.mesh.renderOrder = 5;
    bindOverlayMesh(this.mesh, u, ctx);
    // Sector names on both tacks (no-go and run are single sectors across the wind).
    for (let i = 0; i < SECTORS.length; i++) {
      const sides = i === 0 || i === SECTORS.length - 1 ? 1 : 2;
      for (let k = 0; k < sides; k++) this.sectorLabels.push(layer.create({ kind: 'sector', priority: 2, dx: 0, dy: 0 }).text(SECTORS[i]!.short));
    }
    this.hereLabel = layer.create({ kind: 'tag', color: COLORS.apparentWind, priority: 10, dx: 0, dy: -20 });
    this.windLabel = layer.create({ color: COLORS.trueWind, priority: 9, dx: 0, dy: -16 });
  }

  update(dt: number, s: SimSnapshot, boatWorld: THREE.Vector3): void {
    const u = this.material.uniforms;
    // Follow the true wind, smoothed (τ ≈ 0.2 s, frame-rate independent) so gust-to-gust noise does not jitter the ring.
    const twd = s.wind.twd;
    const k = 1 - Math.exp(-dt / 0.2);
    this.twd = Number.isNaN(this.twd) ? twd : this.twd + Math.atan2(Math.sin(twd - this.twd), Math.cos(twd - this.twd)) * k;
    u['uTwd']!.value = this.twd;
    u['uHeading']!.value = s.boat.heading;
    this.mesh.position.set(boatWorld.x, 0.02, boatWorld.z);

    // Sector names at mid-angle, mid-radius; the current one highlighted.
    const here = pointOfSail(s.wind.twa);
    const hereSide = Math.sign(-s.wind.twa) || 1; // bearing side of the heading relative to the wind
    let li = 0;
    let lo = 0;
    for (let i = 0; i < SECTORS.length; i++) {
      const hi = SECTORS[i]!.upTo;
      const mid = i === SECTORS.length - 1 ? 180 : i === 0 ? 0 : 0.5 * (lo + hi);
      const nSides = i === 0 || i === SECTORS.length - 1 ? 1 : 2;
      for (let k = 0; k < nSides; k++) {
        const side = k === 0 ? 1 : -1;
        const bearing = this.twd + side * mid * DEG;
        bearingToWorld(bearing, this.dir);
        this.p.copy(boatWorld).addScaledVector(this.dir, 0.5 * (INNER + OUTER));
        this.p.y = 0.1;
        const on = i === here && (nSides === 1 || side === hereSide);
        this.sectorLabels[li++]!.cls(on ? 'on' : '').at(this.p);
      }
      lo = hi;
    }

    // Wind arrow blowing in over the no-go sector.
    bearingToWorld(this.twd, this.dir);
    this.p.copy(boatWorld).addScaledVector(this.dir, OUTER + 5.5);
    this.q.copy(boatWorld).addScaledVector(this.dir, OUTER + 0.4);
    this.p.y = this.q.y = 0.12;
    this.arrows.add(this.p, this.q, this.windColor, ARROW_BOLD);
    this.windLabel.text('Wind').at(this.p, 0, -16);

    // You-are-here tag on the pointer.
    bearingToWorld(s.boat.heading, this.dir);
    this.p.copy(boatWorld).addScaledVector(this.dir, OUTER + 1.2);
    this.p.y = 0.1;
    const tack = Math.abs(s.wind.twa) < 1 * DEG || Math.abs(s.wind.twa) > 179 * DEG ? '' : s.wind.twa > 0 ? ' · starboard tack' : ' · port tack';
    this.hereLabel.text(SECTORS[here]!.name, `${Math.round(Math.abs(s.wind.twa) / DEG)}° TWA${tack}`).at(this.p);
  }

  hide(): void {
    for (const l of this.sectorLabels) l.hide();
    this.hereLabel.hide();
    this.windLabel.hide();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
