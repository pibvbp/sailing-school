// Telltales (spec §9.6): short nylon ribbons on the jib luff (red port / green starboard, at 25/50/75 %
// height) and at the main's batten ends on the leech. Each is a little Verlet chain whose root rides the
// rendered cloth and whose body is blown by a flow that depends on the snapshot state:
//   streaming  – aligned with the flow along the sail, a fine flutter running down the ribbon;
//   lifting    – the flow on that side has separated: the ribbon rises and spins;
//   stalled    – no flow: it droops and curls lazily (a leech telltale disappears behind the leech);
//   fluttering – random, violent (the sail is luffing).
import * as THREE from 'three';
import type { Telltale, TelltaleState } from '../../sim/types';
import { toLocal, type SailRows, type SailSurface } from './sailMesh';
import { MAIN_BATTENS } from './mainMesh';
import { makeThinTranslucent } from './clothMaterial';

export interface TelltaleSail { surface: SailSurface; rows: SailRows; visible: boolean }

const NODES = 9;
const MAX = 16;
const SUB = 1 / 60;
const COLOURS = {
  port: new THREE.Color(0.8, 0.035, 0.03),
  stbd: new THREE.Color(0.03, 0.5, 0.1),
  leech: new THREE.Color(0.85, 0.16, 0.02),
};

class Ribbon {
  readonly p = new Float32Array(NODES * 3);
  readonly q = new Float32Array(NODES * 3);
  readonly flow = new THREE.Vector3();
  u = 0;
  v = 0;
  state: TelltaleState = 'streaming';
  intensity = 0;
  active = false;
  seen = false;
  started = false;
  slot = -1;
  readonly mappedFrom = new THREE.Vector3(1e9, 0, 0);
  /** Cloth normal (starboard side) and chord direction at the root, from the last update. */
  readonly nrm = new THREE.Vector3(1, 0, 0);
  readonly chord = new THREE.Vector3(0, 0, 1);
  constructor(readonly id: string, readonly sail: 'main' | 'jib', readonly side: Telltale['side'], readonly seed: number) {}
  get length(): number { return this.side === 'leech' ? 0.3 : 0.22; }
  get width(): number { return this.side === 'leech' ? 0.014 : 0.012; }
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

export class Telltales {
  readonly mesh: THREE.Mesh;
  /** Jib luff telltales (port/stbd at 25, 50, 75 %) then the four main leech telltales. */
  readonly anchors: THREE.Object3D[];
  private readonly ribbons = new Map<string, Ribbon>();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly col: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private acc = 0;
  /** Integrated ripple phase (cycles) and its value after each substep of the current frame. */
  private ripple = 0;
  private readonly ripplePhases = new Float64Array(3);
  private readonly planTmp = { x: 0, y: 0 };
  private readonly root = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly target = new THREE.Vector3();

  constructor() {
    const verts = MAX * NODES * 2;
    this.pos = new Float32Array(verts * 3);
    this.nrm = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 3);
    const index: number[] = [];
    for (let r = 0; r < MAX; r++) {
      for (let k = 0; k < NODES - 1; k++) {
        const a = (r * NODES + k) * 2;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setIndex(index);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.geometry = g;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0 });
    // Thin nylon glows in its own colour when light shines through it.
    makeThinTranslucent(mat, 0.7);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'telltales';
    this.mesh.frustumCulled = false;
    const names = ['jib-port-25', 'jib-stbd-25', 'jib-port-50', 'jib-stbd-50', 'jib-port-75', 'jib-stbd-75', 'main-leech-20', 'main-leech-40', 'main-leech-60', 'main-leech-80'];
    this.anchors = names.map((n) => { const o = new THREE.Object3D(); o.name = `telltale:${n}`; return o; });
  }

  /**
   * `gravity` is the unit world-down direction in the boat-local frame (the boat heels and pitches).
   * Call after the sails have been updated (roots ride the rendered cloth).
   */
  update(dt: number, t: number, sails: { main: { telltales: Telltale[] }; jib: { telltales: Telltale[] } },
    main: TelltaleSail, jib: TelltaleSail, aws: number, gravity: THREE.Vector3): void {
    for (const r of this.ribbons.values()) r.seen = false;
    this.ingest(sails.jib.telltales, 'jib', jib);
    this.ingest(sails.main.telltales, 'main', main);
    for (const r of this.ribbons.values()) r.active = r.seen && (r.sail === 'jib' ? jib.visible : main.visible);

    if (!(aws > 0)) aws = 0;
    this.acc = Math.min(this.acc + (dt > 0 ? dt : 0), 3 * SUB);
    const steps = Math.floor(this.acc / SUB);
    this.acc -= steps * SUB;
    // The ripple's frequency follows the wind, so its phase is integrated per substep (never f·t).
    const rippleHz = 9 + 0.6 * Math.max(aws, 0);
    for (let s = 0; s < steps; s++) this.ripplePhases[s] = this.ripple + rippleHz * SUB * (s + 1);
    if (steps > 0) this.ripple = this.ripplePhases[steps - 1]!;
    let drawn = 0;
    for (const r of this.ribbons.values()) {
      if (!r.active || drawn >= MAX) continue;
      const sail = r.sail === 'jib' ? jib : main;
      this.attach(r, sail);
      for (let s = 0; s < steps; s++) this.simulate(r, sail, t - (steps - 1 - s) * SUB, aws, gravity, this.ripplePhases[s]!);
      if (!r.started) this.simulate(r, sail, t, aws, gravity, this.ripple);
      // A bad frame (non-finite root or flow) must not freeze the ribbon for good: it re-forms.
      if (!Number.isFinite(r.p[NODES * 3 - 1]! + r.flow.x + r.flow.y + r.flow.z)) { r.started = false; r.flow.set(0, 0, 0); }
      this.write(r, drawn, sail, t);
      if (r.slot >= 0) this.anchors[r.slot]!.position.copy(this.root);
      drawn++;
    }
    this.geometry.setDrawRange(0, drawn * (NODES - 1) * 6);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
    this.geometry.getAttribute('color').needsUpdate = true;
  }

  private ingest(list: Telltale[], sailId: 'main' | 'jib', sail: TelltaleSail): void {
    for (const tt of list) {
      let r = this.ribbons.get(tt.id);
      if (!r) {
        r = new Ribbon(tt.id, sailId, tt.side, hash(tt.id));
        this.ribbons.set(tt.id, r);
      }
      r.seen = true;
      r.state = tt.state;
      r.intensity = Number.isFinite(tt.intensity) ? tt.intensity : 0;
      toLocal(tt.pos, this.tmp);
      if (this.tmp.distanceTo(r.mappedFrom) > 0.25) {
        r.mappedFrom.copy(this.tmp);
        const uv = sail.surface.locate(this.tmp);
        r.u = uv.u;
        r.v = uv.v;
        if (tt.side === 'leech') {
          r.u = 1;
          if (sailId === 'main') {
            // Tie it to the nearest batten end.
            let best = MAIN_BATTENS[0]!.v;
            for (const b of MAIN_BATTENS) if (Math.abs(b.v - uv.v) < Math.abs(best - uv.v)) best = b.v;
            if (Math.abs(best - uv.v) < 0.1) r.v = best;
          }
        }
        r.slot = this.slotFor(r);
      }
    }
  }

  private slotFor(r: Ribbon): number {
    if (r.sail === 'jib' && r.side !== 'leech') {
      const h = Math.min(2, Math.max(0, Math.round((r.v - 0.25) / 0.25)));
      return h * 2 + (r.side === 'stbd' ? 1 : 0);
    }
    if (r.sail === 'main' && r.side === 'leech') return 6 + Math.min(3, Math.max(0, Math.round(r.v / 0.2) - 1));
    return -1;
  }

  /** Root on the rendered cloth, offset off the face it is stitched to (or just aft of the leech). */
  private attach(r: Ribbon, sail: TelltaleSail): void {
    sail.surface.sample(r.u, r.v, this.root, this.n);
    r.nrm.copy(this.n);
    this.rowDir(sail, r.v, r.chord).addScaledVector(r.nrm, -r.chord.dot(r.nrm)).normalize();
    if (r.side === 'leech') {
      this.rowDir(sail, r.v, this.dir);
      this.root.addScaledVector(this.dir, 0.012);
    } else {
      this.root.addScaledVector(this.n, r.side === 'stbd' ? 0.005 : -0.005);
    }
  }

  private rowDir(sail: TelltaleSail, v: number, out: THREE.Vector3): THREE.Vector3 {
    const j = Math.min(sail.rows.nv - 1, Math.max(0, Math.round(v * (sail.rows.nv - 1)))) * 3;
    return out.set(sail.rows.D[j]!, sail.rows.D[j + 1]!, sail.rows.D[j + 2]!);
  }

  private simulate(r: Ribbon, sail: TelltaleSail, t: number, aws: number, gravity: THREE.Vector3, ripple: number): void {
    const { p, q } = r;
    const seg = r.length / (NODES - 1);
    const sideSign = r.side === 'stbd' ? 1 : r.side === 'port' ? -1 : 0;
    const n = this.n;
    // Flow follows the cloth: the chord direction projected onto the sail's tangent plane at the root.
    const chord = this.rowDir(sail, r.v, this.dir);
    chord.addScaledVector(n, -chord.dot(n)).normalize();
    const up = this.up.set(0, 1, 0);
    // No floor: in a calm the flow dies away and gravity wins, so the ribbons hang.
    const speed = 0.85 * Math.max(aws, 0);
    const k = r.intensity;
    const ph = r.seed * 40;
    // Target flow velocity for this state (boat-local, m/s).
    const f = this.target.copy(chord).multiplyScalar(speed);
    if (r.state === 'lifting') {
      const spin = 7 * t + ph;
      const lift = 0.35 + 0.65 * k;
      f.multiplyScalar(1 - 0.85 * lift)
        .addScaledVector(up, speed * 0.55 * lift)
        .addScaledVector(n, sideSign * speed * 0.35 * lift * (0.6 + Math.cos(spin)))
        .addScaledVector(chord, -speed * 0.3 * lift * Math.sin(spin));
    } else if (r.state === 'stalled') {
      const lazy = 0.3 + 0.7 * k;
      f.multiplyScalar(1 - 0.92 * lazy)
        .addScaledVector(chord, -0.35 * lazy * Math.sin(1.3 * t + ph))
        .addScaledVector(up, 0.25 * lazy * Math.sin(0.9 * t + ph * 1.7));
      if (r.side === 'leech') {
        // Separated flow behind the leech: the ribbon is drawn round to leeward and hides behind the sail.
        const j = Math.min(sail.rows.nv - 1, Math.max(0, Math.round(r.v * (sail.rows.nv - 1))));
        const lee = sail.rows.side[j]! >= 0 ? 1 : -1;
        f.addScaledVector(n, lee * speed * 0.35 * lazy * (0.75 + 0.25 * Math.sin(0.8 * t + ph)))
          .addScaledVector(chord, -speed * 0.12 * lazy);
      }
    } else if (r.state === 'fluttering') {
      const j1 = Math.sin(23 * t + ph), j2 = Math.sin(31 * t + ph * 2.3), j3 = Math.sin(17 * t + ph * 0.7);
      f.multiplyScalar(0.6).addScaledVector(n, speed * 0.9 * j1).addScaledVector(up, speed * 0.6 * j2).addScaledVector(chord, speed * 0.4 * j3);
    }
    // Smooth state changes (the flow does not switch instantly).
    r.flow.lerp(f, 0.12);
    const drag = 22;
    const gx = gravity.x * 9.81 * 0.4, gy = gravity.y * 9.81 * 0.4, gz = gravity.z * 9.81 * 0.4;

    if (!r.started) {
      for (let i = 0; i < NODES; i++) {
        const o = i * 3;
        p[o] = this.root.x + chord.x * seg * i;
        p[o + 1] = this.root.y + chord.y * seg * i;
        p[o + 2] = this.root.z + chord.z * seg * i;
      }
      q.set(p);
      r.started = true;
      return;
    }
    p[0] = this.root.x; p[1] = this.root.y; p[2] = this.root.z;
    q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
    for (let i = 1; i < NODES; i++) {
      const o = i * 3;
      const vx = (p[o]! - q[o]!) / SUB, vy = (p[o + 1]! - q[o + 1]!) / SUB, vz = (p[o + 2]! - q[o + 2]!) / SUB;
      // Streaming ribbons ripple: a travelling lateral wave in the flow they see.
      const wave = r.state === 'streaming' ? 0.22 * speed * Math.sin(Math.PI * 2 * ripple - 0.9 * i + ph) * (i / NODES) : 0;
      const wx = r.flow.x + n.x * wave, wy = r.flow.y + n.y * wave, wz = r.flow.z + n.z * wave;
      const ax = gx + drag * (wx - vx), ay = gy + drag * (wy - vy), az = gz + drag * (wz - vz);
      q[o] = p[o]!; q[o + 1] = p[o + 1]!; q[o + 2] = p[o + 2]!;
      p[o] = p[o]! + vx * SUB * 0.995 + ax * SUB * SUB;
      p[o + 1] = p[o + 1]! + vy * SUB * 0.995 + ay * SUB * SUB;
      p[o + 2] = p[o + 2]! + vz * SUB * 0.995 + az * SUB * SUB;
    }
    // Luff telltales stay on their own face of the sail; then the ribbon is made inextensible exactly with
    // one follow-the-leader pass from the root (strong drag at a 60 Hz step would otherwise stretch it).
    if (sideSign !== 0) {
      for (let i = 1; i < NODES; i++) {
        const b = i * 3;
        const d = ((p[b]! - p[0]!) * n.x + (p[b + 1]! - p[1]!) * n.y + (p[b + 2]! - p[2]!) * n.z) * sideSign;
        if (d < 0.004) {
          const push = (0.004 - d) * sideSign;
          p[b] = p[b]! + n.x * push; p[b + 1] = p[b + 1]! + n.y * push; p[b + 2] = p[b + 2]! + n.z * push;
        }
      }
    }
    for (let i = 1; i < NODES; i++) {
      const a = (i - 1) * 3, b = i * 3;
      const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!;
      const k = seg / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6);
      p[b] = p[a]! + dx * k; p[b + 1] = p[a + 1]! + dy * k; p[b + 2] = p[a + 2]! + dz * k;
    }
  }

  private write(r: Ribbon, slot: number, sail: TelltaleSail, t: number): void {
    const { p } = r;
    const base = slot * NODES * 2 * 3;
    const c = COLOURS[r.side];
    const face = this.n;
    const chord = this.rowDir(sail, r.v, this.dir);
    const tan = this.tmp;
    for (let i = 0; i < NODES; i++) {
      const a = Math.max(i - 1, 0) * 3, b = Math.min(i + 1, NODES - 1) * 3;
      tan.set(p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!).normalize();
      // Width lies flat on the sail when streaming; a lifting ribbon twists as it spins.
      let wx = tan.y * face.z - tan.z * face.y, wy = tan.z * face.x - tan.x * face.z, wz = tan.x * face.y - tan.y * face.x;
      let wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (wl < 1e-4) { wx = chord.y; wy = -chord.x; wz = 0; wl = Math.sqrt(wx * wx + wy * wy) || 1; }
      wx /= wl; wy /= wl; wz /= wl;
      const twist = r.state === 'lifting' ? (7 * t + r.seed * 40) + i * 0.5 : r.state === 'fluttering' ? Math.sin(19 * t + i) * 1.2 : 0.15 * Math.sin(11 * t + i);
      const ct = Math.cos(twist), st = Math.sin(twist);
      // Rotate w about the tangent.
      const cx = tan.y * wz - tan.z * wy, cy = tan.z * wx - tan.x * wz, cz = tan.x * wy - tan.y * wx;
      const rx = wx * ct + cx * st, ry = wy * ct + cy * st, rz = wz * ct + cz * st;
      const half = r.width * 0.5 * (i === NODES - 1 ? 0.7 : 1);
      const nx = ry * tan.z - rz * tan.y, ny = rz * tan.x - rx * tan.z, nz = rx * tan.y - ry * tan.x;
      for (let e = 0; e < 2; e++) {
        const s = e === 0 ? -half : half;
        const o = base + (i * 2 + e) * 3;
        this.pos[o] = p[i * 3]! + rx * s;
        this.pos[o + 1] = p[i * 3 + 1]! + ry * s;
        this.pos[o + 2] = p[i * 3 + 2]! + rz * s;
        this.nrm[o] = nx; this.nrm[o + 1] = ny; this.nrm[o + 2] = nz;
        this.col[o] = c.r; this.col[o + 1] = c.g; this.col[o + 2] = c.b;
      }
    }
  }

  /**
   * Where the jib luff ribbons lie on the cloth, for the silhouette seen through it: per ribbon (up to 6)
   * five points (plan x, plan y, contact weight 0…1, side +1 stbd / −1 port); unused slots are zero.
   * The weight fades as the ribbon lifts off the cloth.
   */
  writeFootprints(out: Float32Array, planAt: (u: number, v: number, out: { x: number; y: number }) => { x: number; y: number }): void {
    out.fill(0);
    let slot = 0;
    const up = this.up;
    for (const r of this.ribbons.values()) {
      if (!r.active || r.sail !== 'jib' || r.side === 'leech' || slot >= 6) continue;
      const root = planAt(r.u, r.v, this.planTmp);
      up.crossVectors(r.nrm, r.chord).normalize(); // along the sail, toward the head
      if (up.y < 0) up.negate();
      const side = r.side === 'stbd' ? 1 : -1;
      for (let k = 0; k < 5; k++) {
        const o = k * 2 * 3;
        const dx = r.p[o]! - r.p[0]!, dy = r.p[o + 1]! - r.p[1]!, dz = r.p[o + 2]! - r.p[2]!;
        const off = Math.abs(dx * r.nrm.x + dy * r.nrm.y + dz * r.nrm.z);
        const w = (slot * 5 + k) * 4;
        out[w] = root.x + dx * r.chord.x + dy * r.chord.y + dz * r.chord.z;
        out[w + 1] = root.y + dx * up.x + dy * up.y + dz * up.z;
        out[w + 2] = Math.exp(-off / 0.03);
        out[w + 3] = side;
      }
      slot++;
    }
  }

  /** Drop every ribbon (scenario change): they re-form from the next snapshot. */
  reset(): void {
    this.ribbons.clear();
    this.acc = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
