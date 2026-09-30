// Boat wake and bow foam (spec §9.3): world-space targets around the boat that the ocean samples at the
// displaced surface, so wake foam rides the waves exactly.
//  • trail  — accumulates: churn and bow-wave foam, entrained bubbles, and the long glassy slick. The
//    window scrolls in whole texels with the boat (no resampling blur); each frame it decays, spreads
//    and takes new foam from the hull.
//  • kelvin — redrawn each frame from a ribbon of past stern positions: the transverse and divergent
//    Kelvin waves (19.47° wedge) as height, plus foam on the cusps when the boat is pushing hard.
// Kelvin ribbon adapted from wave-riders `src/game/Wake.js` (row ring buffer, 19.47° widening).
// Copyright (c) 2026 Davi (Token-Gremlin), MIT License — adapted for sailing-school.
import * as THREE from 'three';
import { BOAT } from '../../../shared/boatSpec';
import type { QualitySettings } from '../../core/types';
import { FullScreenPass, makeRT, renderPassScene } from './gpuPass';
import { WAKE_RIBBON_FRAG, WAKE_RIBBON_VERT, WAKE_UPDATE_FRAG } from './shaders/wake.glsl';
import type { OceanBoat } from './types';

const ROWS = 80;
/** Kelvin waves stay visible for many boat lengths; their foam dies in seconds. */
const LIFE = 14;
const ARM_FOAM_LIFE = 3.5;
const MIN_SPACING = 0.45;
const KELVIN = Math.tan((19.47 * Math.PI) / 180);
const HULL = BOAT.hull;
const LWL = HULL.stemWL.x - HULL.transomWL.x;

export function wakeResolution(q: QualitySettings): { res: number; size: number } {
  if (q.tier === 'ultra' || q.tier === 'high') return { res: 1024, size: 200 };
  if (q.tier === 'medium') return { res: 512, size: 160 };
  return { res: 256, size: 128 };
}

export class BoatWake {
  res = 0;
  size = 0;
  originX = 0;
  originZ = 0;
  private texel = 1;
  private a!: THREE.WebGLRenderTarget;
  private b!: THREE.WebGLRenderTarget;
  private kelvin!: THREE.WebGLRenderTarget;
  private cur!: THREE.WebGLRenderTarget;
  private readonly updatePass: FullScreenPass;
  private readonly ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.RawShaderMaterial>;
  private readonly ribbonScene = new THREE.Scene();
  private readonly ribbonCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly pos: THREE.BufferAttribute;
  private readonly data: THREE.BufferAttribute;
  private readonly clearColor = new THREE.Color();
  // Ring buffer of stern samples (oldest first from `head`).
  private readonly rx = new Float32Array(ROWS);
  private readonly rz = new Float32Array(ROWS);
  private readonly rsx = new Float32Array(ROWS);
  private readonly rsz = new Float32Array(ROWS);
  private readonly rdist = new Float32Array(ROWS);
  private readonly rtime = new Float32Array(ROWS);
  private readonly rstr = new Float32Array(ROWS);
  private head = 0;
  private count = 0;
  private dist = 0;
  private lastLay = -1e9;
  private time = 0;
  private initialised = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, q: QualitySettings) {
    this.updatePass = new FullScreenPass(WAKE_UPDATE_FRAG, {
      uPrev: { value: null },
      uShift: { value: new THREE.Vector2() },
      uRes: { value: 1 },
      uOrigin: { value: new THREE.Vector2() },
      uTexel: { value: 1 },
      uDt: { value: 0 },
      uBoat: { value: new THREE.Vector4(0, 0, 0, -1) },
      uMotion: { value: new THREE.Vector4() },
      uHull: { value: new THREE.Vector4(HULL.stemWL.x, HULL.transomWL.x, HULL.maxBeamX, HULL.bwl / 2) },
    }, 'oceanWakeUpdate');

    const verts = (ROWS + 2) * 3;
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.data = new THREE.BufferAttribute(new Float32Array(verts * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint16Array((ROWS + 1) * 12);
    for (let i = 0; i <= ROWS; i++) {
      const a = i * 3;
      idx.set([a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5], i * 12);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.pos);
    g.setAttribute('aData', this.data);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.RawShaderMaterial({
      name: 'oceanWakeRibbon',
      glslVersion: THREE.GLSL3,
      vertexShader: WAKE_RIBBON_VERT,
      fragmentShader: WAKE_RIBBON_FRAG,
      uniforms: {
        uOrigin: { value: new THREE.Vector2() }, uSize: { value: 1 }, uSpeed: { value: 0 },
        uLwl: { value: LWL }, uKelvin: { value: KELVIN }, uFoamLife: { value: ARM_FOAM_LIFE },
      },
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NoBlending,
    });
    this.ribbon = new THREE.Mesh(g, mat);
    this.ribbon.frustumCulled = false;
    this.ribbonScene.add(this.ribbon);
    this.setQuality(q);
  }

  get trailTexture(): THREE.Texture { return this.cur.texture; }
  get kelvinTexture(): THREE.Texture { return this.kelvin.texture; }

  setQuality(q: QualitySettings): void {
    const { res, size } = wakeResolution(q);
    if (res === this.res && size === this.size) return;
    this.a?.dispose();
    this.b?.dispose();
    this.kelvin?.dispose();
    this.res = res;
    this.size = size;
    this.texel = size / res;
    this.a = makeRT(res, res, { filter: 'linear', name: 'oceanWakeA' });
    this.b = makeRT(res, res, { filter: 'linear', name: 'oceanWakeB' });
    this.kelvin = makeRT(res / 2, res / 2, { filter: 'linear', name: 'oceanKelvin' });
    this.cur = this.a;
    // The first update reads nothing from the (uninitialised) previous target.
    this.initialised = false;
  }

  update(dt: number, boat: OceanBoat | null): void {
    this.time += dt;
    const u = this.updatePass.uniforms;
    const fwdX = boat ? Math.sin(boat.heading) : 0, fwdZ = boat ? -Math.cos(boat.heading) : -1;
    const bx = boat ? boat.e : this.originX + this.size / 2;
    const bz = boat ? -boat.n : this.originZ + this.size / 2;
    const speed = boat ? Math.max(boat.speed, 0) : 0;
    this.dist += speed * dt;

    // Scroll the window in whole texels so the stored foam never gets resampled.
    const ox = Math.round((bx - this.size / 2) / this.texel) * this.texel;
    const oz = Math.round((bz - this.size / 2) / this.texel) * this.texel;
    const shift = u['uShift']!.value as THREE.Vector2;
    if (!this.initialised) shift.set(1e6, 1e6);
    else shift.set(Math.round((ox - this.originX) / this.texel), Math.round((oz - this.originZ) / this.texel));
    this.initialised = true;
    this.originX = ox;
    this.originZ = oz;

    const next = this.cur === this.a ? this.b : this.a;
    u['uPrev']!.value = this.cur.texture;
    u['uRes']!.value = this.res;
    (u['uOrigin']!.value as THREE.Vector2).set(ox, oz);
    u['uTexel']!.value = this.texel;
    u['uDt']!.value = Math.min(dt, 0.1);
    (u['uBoat']!.value as THREE.Vector4).set(bx, bz, fwdX, fwdZ);
    (u['uMotion']!.value as THREE.Vector4).set(speed, boat?.heel ?? 0, boat ? 1 : 0, 0);
    this.updatePass.render(this.renderer, next);
    this.cur = next;

    if (boat) this.layRows(bx, bz, fwdX, fwdZ, speed);
    this.drawKelvin(bx, bz, fwdX, fwdZ, speed, boat !== null);
  }

  dispose(): void {
    this.a?.dispose();
    this.b?.dispose();
    this.kelvin?.dispose();
    this.updatePass.dispose();
    this.ribbon.geometry.dispose();
    this.ribbon.material.dispose();
  }

  private layRows(bx: number, bz: number, fx: number, fz: number, speed: number): void {
    const spacing = Math.max(MIN_SPACING, (speed * LIFE) / ROWS);
    if (this.dist - this.lastLay >= spacing && speed > 0.4) {
      const i = (this.head + this.count) % ROWS;
      if (this.count === ROWS) this.head = (this.head + 1) % ROWS; else this.count++;
      this.rx[i] = bx + fx * HULL.transomWL.x;
      this.rz[i] = bz + fz * HULL.transomWL.x;
      this.rsx[i] = -fz; this.rsz[i] = fx;
      this.rdist[i] = this.dist; this.rtime[i] = this.time; this.rstr[i] = armFoam(speed);
      this.lastLay = this.dist;
    }
    while (this.count > 0 && this.time - this.rtime[this.head]! >= LIFE) { this.head = (this.head + 1) % ROWS; this.count--; }
  }

  /** One ribbon row at vertex index v (port, centre, starboard); returns the next free index. */
  private putRow(v: number, x: number, z: number, sx: number, sz: number, fromBow: number, age: number, strength: number): number {
    const P = this.pos.array as Float32Array, D = this.data.array as Float32Array;
    const half = Math.max(fromBow * KELVIN, 0.2) * 1.08;
    for (let side = -1; side <= 1; side++) {
      P[v * 3] = x + sx * half * side; P[v * 3 + 1] = 0; P[v * 3 + 2] = z + sz * half * side;
      D[v * 4] = side / 1.08; D[v * 4 + 1] = age; D[v * 4 + 2] = strength; D[v * 4 + 3] = fromBow;
      v++;
    }
    return v;
  }

  /** Oldest row → newest → live stern → bow, 3 vertices each (port, centre, starboard). */
  private drawKelvin(bx: number, bz: number, fx: number, fz: number, speed: number, live: boolean): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.getClearColor(this.clearColor);
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.kelvin);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setClearColor(this.clearColor, prevAlpha);
    r.setRenderTarget(prevTarget);

    let v = 0;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head + k) % ROWS;
      v = this.putRow(v, this.rx[i]!, this.rz[i]!, this.rsx[i]!, this.rsz[i]!, LWL + this.dist - this.rdist[i]!, this.time - this.rtime[i]!, this.rstr[i]!);
    }
    if (live && speed > 0.4) {
      v = this.putRow(v, bx + fx * HULL.transomWL.x, bz + fz * HULL.transomWL.x, -fz, fx, LWL, 0, armFoam(speed));
      v = this.putRow(v, bx + fx * HULL.stemWL.x, bz + fz * HULL.stemWL.x, -fz, fx, 0, 0, armFoam(speed));
    }
    const rows = v / 3;
    if (rows < 2) return;
    this.ribbon.geometry.setDrawRange(0, (rows - 1) * 12);
    this.pos.needsUpdate = true;
    this.data.needsUpdate = true;
    const m = this.ribbon.material.uniforms;
    (m['uOrigin']!.value as THREE.Vector2).set(this.originX, this.originZ);
    m['uSize']!.value = this.size;
    m['uSpeed']!.value = speed;
    renderPassScene(r, this.ribbonScene, this.ribbonCamera, this.kelvin);
  }
}

/** Cusp foam: faint at 5 kn, white once the boat approaches hull speed (≈ 6 kn). */
function armFoam(speed: number): number {
  return 0.25 * THREE.MathUtils.smoothstep(speed, 1.5, 3.0) + 0.75 * THREE.MathUtils.smoothstep(speed, 2.7, 4.2);
}
