// Masthead wind indicator (spec §9.6): a vane on a vertical rod above the masthead whose arrow points
// INTO the apparent wind (`awa` at 10 m), with two fixed reference tabs angled aft to judge close-hauled.
// The vane is a light rotor on a pivot: a spring toward the wind with little damping, so it hunts a bit
// and wobbles in gusts like the real thing. Parts are merged per material: four draw calls in all.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOAT } from '../../shared/boatSpec';

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** A primitive placed by a matrix, ready to merge. */
function part(g: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1));
  const out = g.toNonIndexed().applyMatrix4(m);
  g.dispose();
  return out;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return g;
}

export class Windex {
  readonly group = new THREE.Group();
  private readonly vane = new THREE.Group();
  private angle = 0;
  private rate = 0;
  private init = false;
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  constructor() {
    this.group.name = 'windex';
    const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.28 });
    const black = new THREE.MeshStandardMaterial({ color: 0x141619, metalness: 0, roughness: 0.45 });
    const reflector = new THREE.MeshStandardMaterial({ color: 0xff3a12, metalness: 0, roughness: 0.3, emissive: 0x3a0800 });
    const top = BOAT.mast.topH;
    const z0 = -BOAT.mast.x;
    const rodLen = 0.36;
    // Pivot of the vane: on a rod raised from a bracket just forward of the masthead.
    const pivot = new THREE.Vector3(0, top + 0.02 + rodLen, z0 - 0.11);
    this.group.position.copy(pivot);

    // Fixed parts (relative to the pivot): bracket, rod, reference arms and their reflector tabs.
    const tabAngle = THREE.MathUtils.degToRad(32);
    const armParts: THREE.BufferGeometry[] = [];
    const tabParts: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const a = s * tabAngle;
      const dir = (r: number): [number, number, number] => [Math.sin(a) * r, -0.05, Math.cos(a) * r];
      armParts.push(part(new THREE.CylinderGeometry(0.002, 0.002, 0.15, 6), dir(0.075), [Math.PI / 2, a, 0]));
      tabParts.push(part(new THREE.BoxGeometry(0.002, 0.035, 0.05), dir(0.14), [0, a, 0]));
    }
    const fixed = merged([
      part(new THREE.BoxGeometry(0.012, 0.012, 0.1), [0, -rodLen, 0.05]),
      part(new THREE.CylinderGeometry(0.0035, 0.0045, rodLen, 8), [0, -rodLen / 2, 0]),
      ...armParts,
    ]);
    const tabs = merged(tabParts);

    // The vane: shaft along −Z (arrow forward at rotation 0), arrowhead + counterweight, tail fin, hub.
    const vaneBody = merged([
      part(new THREE.CylinderGeometry(0.0025, 0.0025, 0.44, 6), [0, 0, -0.02], [Math.PI / 2, 0, 0]),
      part(new THREE.ConeGeometry(0.014, 0.05, 10), [0, 0, -0.265], [-Math.PI / 2, 0, 0]),
      part(new THREE.SphereGeometry(0.011, 10, 8), [0, 0, -0.2]),
      part(new THREE.BoxGeometry(0.0025, 0.11, 0.1), [0, 0.02, 0.15]),
      part(new THREE.CylinderGeometry(0.006, 0.006, 0.02, 8), [0, 0, 0]),
    ]);
    const finTape = part(new THREE.BoxGeometry(0.003, 0.04, 0.05), [0, 0.045, 0.165]);

    this.group.add(new THREE.Mesh(fixed, steel), new THREE.Mesh(tabs, reflector));
    this.vane.add(new THREE.Mesh(vaneBody, black), new THREE.Mesh(finTape, reflector));
    this.group.add(this.vane);
    this.disposables.push(fixed, tabs, vaneBody, finTape, steel, black, reflector);
  }

  /** `awa`: apparent wind angle at the masthead (rad, + from starboard); `aws` in m/s. */
  update(dt: number, t: number, awa: number, aws: number): void {
    const target = -awa;
    if (!this.init) { this.angle = target; this.rate = 0; this.init = true; }
    const h = Math.min(Math.max(dt, 0), 1 / 30);
    const w = 5 + 0.45 * Math.max(aws, 0);
    const zeta = 0.3;
    // Semi-implicit Euler on a wrapped error: stable for ω·dt < 1.
    this.rate += (w * w * wrapPi(target - this.angle) - 2 * zeta * w * this.rate) * h;
    this.angle = wrapPi(this.angle + this.rate * h);
    const gust = Math.min(Math.max(aws, 0) / 10, 1.5);
    const wobble = gust * (0.035 * Math.sin(2 * Math.PI * 1.7 * t) + 0.02 * Math.sin(2 * Math.PI * 3.3 * t + 1.1));
    this.vane.rotation.y = this.angle + wobble;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
