// Race marks: inflatable PVC buoys (≈1.5 m) that ride the waves. Windward = orange cylinder with a white band,
// leeward = yellow cylinder with a black band, start = orange tetrahedron with a white band.
// Positions are sim world (east, north) → three.js (X = e, Z = −n).
import * as THREE from 'three';

export type MarkKind = 'windward' | 'leeward' | 'start';

interface Style {
  body: string;
  band: string;
  /** Cross-section: cylinder or rounded triangle (tetrahedron-like pyramid). */
  shape: 'cylinder' | 'pyramid';
}

const STYLES: Record<MarkKind, Style> = {
  windward: { body: '#ff5a14', band: '#f2f0ea', shape: 'cylinder' },
  leeward: { body: '#ffc21a', band: '#1d1d1f', shape: 'cylinder' },
  start: { body: '#ff5a14', band: '#f2f0ea', shape: 'pyramid' },
};

/** Draft below the waterline (ballast skirt) and height above it. */
const DRAFT = 0.28;
const HEIGHT = 1.55;
const CYLINDER_RADIUS = 0.5;
const PYRAMID_BASE_RADIUS = 0.78;
const PANELS = 8;
/** Rocking: natural period and damping ratio of the tilt following the wave slope. */
const ROCK_PERIOD_S = 1.6;
const ROCK_DAMPING = 0.35;
/** Sampling half-span for the surface slope under the buoy (≈ its radius). */
const SLOPE_SPAN = 0.6;

/** Profile of the inflated body (r = radius factor, y = height), bottom to top. */
function profile(shape: Style['shape']): Array<[number, number]> {
  if (shape === 'pyramid') {
    // Tetrahedron-like pyramid: wide base, slightly bellied faces, and an inflated (blunt) apex.
    const pts: Array<[number, number]> = [[0, -DRAFT], [0.72, -DRAFT], [0.9, -0.2], [0.97, -0.08]];
    const capStart = HEIGHT - 0.1;
    const capRadius = 0.22;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      pts.push([0.97 * (1 - t) + capRadius * t + 0.035 * Math.sin(Math.PI * t), -0.02 + t * (capStart + 0.02)]);
    }
    for (let i = 1; i <= 5; i++) {
      const a = (i / 5) * (Math.PI / 2);
      pts.push([capRadius * Math.cos(a), capStart + 0.1 * Math.sin(a)]);
    }
    return pts;
  }
  // Cylinder: ballast skirt, slightly bulging inflated wall, rounded shoulder and a flat top.
  const pts: Array<[number, number]> = [[0, -DRAFT], [0.8, -DRAFT], [0.9, -0.22], [0.96, -0.12]];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push([1 + 0.035 * Math.sin(Math.PI * t), -0.06 + t * (HEIGHT - 0.3)]);
  }
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push([0.78 + 0.22 * Math.cos(a), HEIGHT - 0.36 + 0.22 * Math.sin(a) + 0.14 * (i / 6)]);
  }
  pts.push([0.3, HEIGHT - 0.005], [0, HEIGHT]);
  return pts;
}

/** Radius factor around the body: panel seams pull in slightly; the pyramid is a rounded triangle. */
function radial(shape: Style['shape'], theta: number): number {
  if (shape === 'pyramid') {
    const sector = (2 * Math.PI) / 3;
    const a = ((theta % sector) + sector) % sector - sector / 2;
    const triangle = Math.cos(Math.PI / 3) / Math.cos(a); // inradius-normalised triangle
    return 0.78 * triangle + 0.22; // inflated: a triangle with rounded edges
  }
  const seam = (2 * Math.PI) / PANELS;
  const d = Math.abs(((theta % seam) + seam) % seam - seam / 2) - seam / 2; // 0 at a seam
  return 1 - 0.018 * Math.exp(-((d / 0.05) ** 2));
}

function buildBuoyGeometry(style: Style): THREE.BufferGeometry {
  const pts = profile(style.shape);
  const segments = style.shape === 'pyramid' ? 72 : 96;
  const baseRadius = style.shape === 'pyramid' ? PYRAMID_BASE_RADIUS : CYLINDER_RADIUS;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [r, y] = pts[i]!;
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * 2 * Math.PI;
      const rr = r * baseRadius * radial(style.shape, theta);
      positions.push(Math.cos(theta) * rr, y, -Math.sin(theta) * rr);
      uvs.push(j / segments, (y + DRAFT) / (HEIGHT + DRAFT));
    }
  }
  const row = segments + 1;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      const b = a + row;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Wrap-around PVC print: body colour, band, dark ballast skirt, waterline grime, panel seams. */
function buildBuoyTexture(style: Style): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const yOf = (height: number) => h - ((height + DRAFT) / (HEIGHT + DRAFT)) * h; // canvas y for a height
  g.fillStyle = style.body;
  g.fillRect(0, 0, w, h);
  // Band on the upper third of the body.
  const bandLow = style.shape === 'pyramid' ? 0.55 : 0.82;
  const bandHigh = style.shape === 'pyramid' ? 0.8 : 1.12;
  g.fillStyle = style.band;
  g.fillRect(0, yOf(bandHigh), w, yOf(bandLow) - yOf(bandHigh));
  // Ballast skirt and the grimy strip the waves keep wet.
  g.fillStyle = '#26282a';
  g.fillRect(0, yOf(-0.1), w, h - yOf(-0.1));
  const grime = g.createLinearGradient(0, yOf(0.18), 0, yOf(-0.1));
  grime.addColorStop(0, 'rgba(40,45,30,0)');
  grime.addColorStop(1, 'rgba(40,45,30,0.45)');
  g.fillStyle = grime;
  g.fillRect(0, yOf(0.18), w, yOf(-0.1) - yOf(0.18));
  // Welded seams between the panels.
  g.fillStyle = 'rgba(0,0,0,0.16)';
  for (let i = 0; i < PANELS; i++) g.fillRect(((i + 0.5) / PANELS) * w - 1, 0, 2, yOf(-0.1));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

interface Mark {
  kind: MarkKind;
  e: number;
  n: number;
  mesh: THREE.Mesh;
  yaw: number;
  swingPhase: number;
  heave: number;
  tilt: THREE.Vector2;
  tiltRate: THREE.Vector2;
}

export class Marks {
  readonly group = new THREE.Group();

  private readonly marks = new Map<string, Mark>();
  private readonly geometries = new Map<MarkKind, THREE.BufferGeometry>();
  private readonly materials = new Map<MarkKind, THREE.MeshPhysicalMaterial>();
  private lastT = Number.NaN;
  /** Order XZY = Rx·Rz·Ry: yaw about the buoy's own axis first, then tilt about world axes. */
  private readonly euler = new THREE.Euler(0, 0, 0, 'XZY');

  constructor(scene: THREE.Scene) {
    this.group.name = 'marks';
    scene.add(this.group);
  }

  /** Add (or move) a mark at sim world (east, north) metres. */
  add(id: string, e: number, n: number, kind: MarkKind): void {
    const existing = this.marks.get(id);
    if (existing && existing.kind === kind) {
      existing.e = e;
      existing.n = n;
      return;
    }
    if (existing) this.remove(id);
    const mesh = new THREE.Mesh(this.geometry(kind), this.material(kind));
    mesh.name = `mark:${id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(e, 0, -n);
    this.group.add(mesh);
    const seed = hash(id);
    this.marks.set(id, {
      kind, e, n, mesh,
      yaw: seed * Math.PI * 2,
      swingPhase: seed * 97.3,
      heave: 0,
      tilt: new THREE.Vector2(),
      tiltRate: new THREE.Vector2(),
    });
  }

  remove(id: string): void {
    const mark = this.marks.get(id);
    if (!mark) return;
    this.group.remove(mark.mesh);
    this.marks.delete(id);
  }

  /** `t` = seconds (any monotonic clock); `heightAt(e, n)` = water surface height at a sim world point. */
  update(t: number, heightAt: (e: number, n: number) => number): void {
    const dt = Number.isNaN(this.lastT) ? 0 : THREE.MathUtils.clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    const omega = (2 * Math.PI) / ROCK_PERIOD_S;
    for (const mark of this.marks.values()) {
      const { e, n } = mark;
      mark.heave = heightAt(e, n);
      // Surface slope under the buoy (rise per metre toward east and toward north).
      const slopeE = (heightAt(e + SLOPE_SPAN, n) - heightAt(e - SLOPE_SPAN, n)) / (2 * SLOPE_SPAN);
      const slopeN = (heightAt(e, n + SLOPE_SPAN) - heightAt(e, n - SLOPE_SPAN)) / (2 * SLOPE_SPAN);
      // Tilts that align the buoy axis with the surface normal: `roll` about Z, `pitch` about X (see below).
      const targetRoll = Math.atan(slopeE);
      const targetPitch = Math.atan(slopeN);
      // Second-order follower: the buoy rocks and overshoots a little instead of snapping to the slope.
      if (dt > 0) {
        mark.tiltRate.x += (omega * omega * (targetRoll - mark.tilt.x) - 2 * ROCK_DAMPING * omega * mark.tiltRate.x) * dt;
        mark.tiltRate.y += (omega * omega * (targetPitch - mark.tilt.y) - 2 * ROCK_DAMPING * omega * mark.tiltRate.y) * dt;
        mark.tilt.x += mark.tiltRate.x * dt;
        mark.tilt.y += mark.tiltRate.y * dt;
      } else {
        mark.tilt.set(targetRoll, targetPitch);
      }
      // A moored mark swings slowly on its anchor line.
      const yaw = mark.yaw + 0.35 * Math.sin(t * 0.05 + mark.swingPhase);
      mark.mesh.position.set(e, mark.heave, -n);
      // The surface normal is (−slopeE, 1, +slopeN) in three.js (north = −Z): +Z-rotation leans the top
      // west, +X-rotation leans it south.
      this.euler.set(mark.tilt.y, yaw, mark.tilt.x, 'XZY');
      mark.mesh.quaternion.setFromEuler(this.euler);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.marks.clear();
  }

  private geometry(kind: MarkKind): THREE.BufferGeometry {
    let g = this.geometries.get(kind);
    if (!g) {
      g = buildBuoyGeometry(STYLES[kind]);
      this.geometries.set(kind, g);
    }
    return g;
  }

  private material(kind: MarkKind): THREE.MeshPhysicalMaterial {
    let m = this.materials.get(kind);
    if (!m) {
      // Coated PVC fabric: satin base with a thin glossy coat.
      m = new THREE.MeshPhysicalMaterial({
        map: buildBuoyTexture(STYLES[kind]),
        roughness: 0.5,
        clearcoat: 0.45,
        clearcoatRoughness: 0.28,
      });
      m.name = `mark-${kind}`;
      this.materials.set(kind, m);
    }
    return m;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}
