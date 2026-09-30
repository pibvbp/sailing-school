// Burgee (spec §9.6): a small pennant on a swivel stick clipped to the backstay above the helm. It
// streams downwind of the deck-level apparent wind (`awaDeck`), flapping faster and flatter as the wind
// rises and drooping in a near calm.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { makeBurgeeTexture } from './sailTextures';
import { makeThinTranslucent } from './clothMaterial';

const NU = 14;
const NV = 5;
const HOIST = 0.17;
const FLY = 0.34;
/** Height of the swivel on the backstay (m above the waterline). */
export const BURGEE_H = 2.35;
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (a: number, b: number, x: number): number => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

export class Burgee {
  readonly group = new THREE.Group();
  private readonly flagPivot = new THREE.Group();
  private readonly pos = new Float32Array(NU * NV * 3);
  private readonly nrm = new Float32Array(NU * NV * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly texture = makeBurgeeTexture();
  private readonly flagMat: THREE.MeshStandardMaterial;
  private readonly stickMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.5 });
  private readonly stickGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.3, 8);
  private angle = 0;
  private rate = 0;
  private init = false;

  constructor() {
    this.group.name = 'burgee';
    const top = BOAT.backstay.top, bot = BOAT.backstay.bottom;
    const k = (top.h - BURGEE_H) / (top.h - bot.h);
    const x = top.x + (bot.x - top.x) * k;
    this.group.position.set(0, BURGEE_H, -x);
    const stick = new THREE.Mesh(this.stickGeo, this.stickMat);
    stick.position.y = 0.02;
    const uv = new Float32Array(NU * NV * 2);
    const index: number[] = [];
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const kk = j * NU + i;
        uv[kk * 2] = i / (NU - 1);
        uv[kk * 2 + 1] = j / (NV - 1);
        if (i < NU - 1 && j < NV - 1) index.push(kk, kk + NU, kk + 1, kk + 1, kk + NU, kk + NU + 1);
      }
    }
    this.geometry.setIndex(index);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, FLY / 2), FLY);
    this.flagMat = new THREE.MeshStandardMaterial({ map: this.texture, side: THREE.DoubleSide, roughness: 0.6 });
    makeThinTranslucent(this.flagMat, 0.55);
    const flag = new THREE.Mesh(this.geometry, this.flagMat);
    this.flagPivot.position.y = 0.08;
    this.flagPivot.add(flag);
    this.group.add(stick, this.flagPivot);
  }

  /** `awaDeck` (rad, + from starboard) and `awsDeck` (m/s): the apparent wind at deck height. */
  update(dt: number, t: number, awaDeck: number, awsDeck: number): void {
    const aws = Math.max(awsDeck, 0);
    const target = -awaDeck;
    if (!this.init) { this.angle = target; this.init = true; }
    const h = Math.min(Math.max(dt, 0), 1 / 30);
    const w = 4 + 0.5 * aws;
    this.rate += (w * w * wrapPi(target - this.angle) - 2 * 0.45 * w * this.rate) * h;
    this.angle = wrapPi(this.angle + this.rate * h);
    this.flagPivot.rotation.y = this.angle;

    const strong = smooth(1, 8, aws);
    const slack = 1 - smooth(0.4, 3.5, aws);
    const f = 1.4 + 0.55 * aws;
    const lambda = 0.2 + 0.015 * aws;
    const TAU = Math.PI * 2;
    for (let j = 0; j < NV; j++) {
      const s = j / (NV - 1) - 0.5;
      for (let i = 0; i < NU; i++) {
        const u = i / (NU - 1), k = (j * NU + i) * 3;
        const amp = u * (0.012 + 0.03 * strong) + slack * 0.02 * u;
        const x = amp * (Math.sin(TAU * (f * t - (u * FLY) / lambda) + 0.8 * s) + 0.35 * Math.sin(TAU * (1.7 * f * t - (u * FLY) / (0.55 * lambda)) + 1.3));
        const y = s * HOIST * (1 - 0.92 * u) - slack * 0.8 * FLY * u * u;
        const z = u * FLY * (1 - 0.35 * slack * u);
        this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
      }
    }
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const k = (j * NU + i) * 3;
        const r = (j * NU + Math.min(i + 1, NU - 1)) * 3, l = (j * NU + Math.max(i - 1, 0)) * 3;
        const u2 = (Math.min(j + 1, NV - 1) * NU + i) * 3, d = (Math.max(j - 1, 0) * NU + i) * 3;
        const ax = this.pos[r]! - this.pos[l]!, ay = this.pos[r + 1]! - this.pos[l + 1]!, az = this.pos[r + 2]! - this.pos[l + 2]!;
        const bx = this.pos[u2]! - this.pos[d]!, by = this.pos[u2 + 1]! - this.pos[d + 1]!, bz = this.pos[u2 + 2]! - this.pos[d + 2]!;
        let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        this.nrm[k] = nx; this.nrm[k + 1] = ny; this.nrm[k + 2] = nz;
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
    this.flagMat.dispose();
    this.stickMat.dispose();
    this.stickGeo.dispose();
  }
}
