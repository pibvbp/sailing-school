// Bow spray: droplets thrown off the forward topsides when the bow drives into a wave face, plus a
// light steady sheet near hull speed. Emission comes from the ocean's own height sampler — the rate at
// which the water climbs the bow relative to the hull's mean water level (which the boat's pitch
// follows with a lag) — so it fires exactly when the drawn waves hit the drawn bow.
// Particle pool and emission shapes adapted from wave-riders `src/game/Wake.js` (_emitBow/_spawn).
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school.
import * as THREE from 'three';
import { BOAT } from '../../../shared/boatSpec';
import type { QualitySettings } from '../../core/types';
import { SPRAY_FRAG, SPRAY_VERT } from './shaders/spray.glsl';
import type { OceanBoat, OceanSampler } from './types';

const MAX = 2000;
const G = 9.81;
const HULL = BOAT.hull;
/** Time constant of the boat's pitch following the waves (the app's spring–damper is similar). */
const PITCH_LAG_S = 0.4;

/** Small deterministic PRNG so bursts do not depend on Math.random (repeatable demos). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BowSpray {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly px = new Float32Array(MAX);
  private readonly py = new Float32Array(MAX);
  private readonly pz = new Float32Array(MAX);
  private readonly vx = new Float32Array(MAX);
  private readonly vy = new Float32Array(MAX);
  private readonly vz = new Float32Array(MAX);
  private readonly age = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private readonly seed = new Float32Array(MAX);
  private readonly alive = new Uint8Array(MAX);
  private readonly free = new Int32Array(MAX);
  private freeCount = MAX;
  private readonly pos: THREE.BufferAttribute;
  private readonly data: THREE.BufferAttribute;
  private readonly rand = mulberry32(0x5eed);
  private bowFollow = 0;
  private lastImmersion = 0;
  private smoothRate = 0;
  private slamAcc = 0;
  private steadyAcc = 0;
  /** Live-droplet cap for the quality tier (spec §9.2 particle counts). */
  private limit = MAX;
  private live = 0;
  private primed = false;
  /** Wind the droplets relax toward (world x/z, m/s). */
  readonly wind = new THREE.Vector2();
  /** Diagnostics: live droplets and the latest bow-burial rate (m/s). */
  readonly stats = { live: 0, rate: 0, maxRate: 0 };

  constructor(uniforms: Record<string, THREE.IUniform>) {
    for (let i = 0; i < MAX; i++) this.free[i] = MAX - 1 - i;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.data = new THREE.BufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aData', this.data);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const material = new THREE.ShaderMaterial({
      name: 'OceanBowSpray',
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      uniforms: {
        uSunDir: uniforms['uSunDir']!, uSunRadiance: uniforms['uSunRadiance']!, uSkyLight: uniforms['uSkyLight']!,
        uPixelScale: { value: 500 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, material);
    this.points.name = 'OceanBowSpray';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      const cam = camera as THREE.PerspectiveCamera;
      const h = renderer.getRenderTarget()?.height ?? renderer.domElement.height;
      material.uniforms['uPixelScale']!.value = cam.projectionMatrix.elements[5]! * h * 0.5;
    };
  }

  setQuality(q: QualitySettings): void {
    this.limit = Math.max(150, Math.round(MAX * q.particleScale));
  }

  update(dt: number, t: number, boat: OceanBoat | null, sampler: OceanSampler): void {
    if (dt <= 0) return;
    if (boat) this.emit(dt, t, boat, sampler);
    else this.primed = false;
    this.integrate(dt);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }

  private emit(dt: number, t: number, b: OceanBoat, sampler: OceanSampler): void {
    const fe = Math.sin(b.heading), fn = Math.cos(b.heading);
    const bowE = b.e + fe * HULL.stemWL.x, bowN = b.n + fn * HULL.stemWL.x;
    // Water at the bow relative to the mean under the hull; the bow follows it with a lag, so the
    // difference is how fast the bow is being buried.
    const rel = sampler.heightAt(bowE, bowN, t) - 0.5 * (sampler.heightAt(b.e, b.n, t) + sampler.heightAt(b.e - fe * 2.5, b.n - fn * 2.5, t));
    if (!this.primed) { this.bowFollow = rel; this.lastImmersion = 0; this.primed = true; }
    this.bowFollow += (rel - this.bowFollow) * (1 - Math.exp(-dt / PITCH_LAG_S));
    const immersion = rel - this.bowFollow;
    // The sampler steps when a new readback lands: low-pass the rate and cap it at what waves and a
    // pitching bow can do (≈ 1.5 m/s), or every step would fire a burst.
    const raw = THREE.MathUtils.clamp((immersion - this.lastImmersion) / dt, -1.5, 1.5);
    this.lastImmersion = immersion;
    this.smoothRate += (raw - this.smoothRate) * (1 - Math.exp(-dt / 0.1));
    const rate = this.smoothRate;
    this.stats.rate = rate;
    this.stats.maxRate = Math.max(this.stats.maxRate, rate);
    const speed = Math.max(b.speed, 0);
    const drive = THREE.MathUtils.smoothstep(speed, 1.2, 3.2);
    // Slamming: the faster the face climbs the bow, the bigger the sheet.
    const slam = Math.max(0, rate - 0.18) * drive;
    // Rates in droplets per second, accumulated so light slams still emit at any frame rate.
    this.slamAcc += Math.min(slam * 1500, 5400) * dt;
    // A light steady sheet off the stem near hull speed.
    this.steadyAcc += 160 * THREE.MathUtils.smoothstep(speed, 2.6, 3.8) * dt;
    const strength = Math.min(1.4, 0.45 + slam * 2.2);
    let count = 0;
    while (this.slamAcc >= 1) { this.slamAcc -= 1; count++; }
    while (this.steadyAcc >= 1) { this.steadyAcc -= 1; count++; }
    for (let i = 0; i < count; i++) this.spawnBow(b, speed, i & 1 ? 1 : -1, strength, sampler, t);
  }

  private spawnBow(b: OceanBoat, speed: number, side: number, strength: number, sampler: OceanSampler, t: number): void {
    if (this.freeCount === 0 || this.live >= this.limit) return;
    this.live++;
    const r = this.rand;
    const fx = Math.sin(b.heading), fz = -Math.cos(b.heading);
    const sx = -fz, sz = fx; // starboard
    // Along the first metre and a half of topside, where the bow wave climbs the hull.
    const along = r() * 1.5;
    const x = HULL.stemWL.x - 0.1 - along;
    const u = Math.max(0, (x - HULL.maxBeamX) / (HULL.stemWL.x - HULL.maxBeamX));
    const half = (HULL.bwl / 2) * Math.pow(Math.max(1 - u * u, 0), 0.7) + 0.05;
    const wx = b.e + fx * x + sx * half * side;
    const wz = -b.n + fz * x + sz * half * side;
    const wy = sampler.heightAt(wx, -wz, t) + 0.05;
    const out = (0.9 + speed * 0.2) * (0.6 + r() * 0.8) * strength;
    const up = (1.1 + speed * 0.25) * (0.5 + r() * 0.9) * strength * (1 - along * 0.35);
    const fwd = speed * (0.55 + r() * 0.3);
    const i = this.free[--this.freeCount]!;
    this.alive[i] = 1;
    this.px[i] = wx; this.py[i] = wy; this.pz[i] = wz;
    this.vx[i] = fx * fwd + sx * side * out + (r() - 0.5) * 0.4;
    this.vy[i] = up;
    this.vz[i] = fz * fwd + sz * side * out + (r() - 0.5) * 0.4;
    this.age[i] = 0;
    this.life[i] = 0.55 + r() * 0.7;
    this.size[i] = (0.008 + r() * 0.022) * (0.8 + 0.4 * strength);
    this.seed[i] = r();
  }

  private integrate(dt: number): void {
    const P = this.pos.array as Float32Array, D = this.data.array as Float32Array;
    const airDrag = 1 - Math.exp(-dt * 1.4);
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      if (!this.alive[i]) continue;
      const age = (this.age[i] += dt);
      if (age >= this.life[i]! || this.py[i]! < -0.3) { this.alive[i] = 0; this.free[this.freeCount++] = i; continue; }
      this.vy[i]! -= G * dt;
      this.vx[i]! += (this.wind.x - this.vx[i]!) * airDrag;
      this.vz[i]! += (this.wind.y - this.vz[i]!) * airDrag;
      this.px[i]! += this.vx[i]! * dt; this.py[i]! += this.vy[i]! * dt; this.pz[i]! += this.vz[i]! * dt;
      P[n * 3] = this.px[i]!; P[n * 3 + 1] = this.py[i]!; P[n * 3 + 2] = this.pz[i]!;
      D[n * 4] = this.size[i]!; D[n * 4 + 1] = age / this.life[i]!; D[n * 4 + 2] = this.seed[i]!; D[n * 4 + 3] = 0;
      n++;
    }
    this.stats.live = n;
    this.live = n;
    this.points.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
    if (n > 0) {
      this.pos.needsUpdate = true;
      this.data.needsUpdate = true;
      this.pos.clearUpdateRanges(); this.data.clearUpdateRanges();
      this.pos.addUpdateRange(0, n * 3); this.data.addUpdateRange(0, n * 4);
    }
  }
}
