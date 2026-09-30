// Distant land for heading reference: low islands and a headland 2–6 km out, one with a lighthouse.
// Aerial perspective: the island colour decays exponentially with distance toward the sky radiance just
// above the horizon *in the same direction* (sampled from the sky's PMREM environment), so a hazy island
// always melts into the exact sky behind it — warm and bright toward the sun, blue-grey away from it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gradientNoise } from './clouds';
import type { SkyState } from '../core/types';

interface IslandSpec {
  /** Compass bearing (deg) and distance (m) of the island centre from the world origin. */
  bearing: number;
  distance: number;
  /** Size of the footprint (m) and compass direction (deg) of its long axis. */
  length: number;
  width: number;
  axis: number;
  /** Highest summit (m). */
  height: number;
  /** Summits along the long axis: [position −1…1, relative height, spread]. */
  hills: Array<[number, number, number]>;
  /** 0…1: how abruptly the land meets the sea (cliffs). */
  cliff: number;
  /** 0…1: bare rock and dry grass instead of woods and scrub. */
  rocky: number;
  seed: number;
}

const ISLANDS: IslandSpec[] = [
  // A long headland to the north-west: the main landmark.
  { bearing: 318, distance: 3600, length: 3400, width: 1100, axis: 62, height: 128, hills: [[-0.45, 1, 0.35], [0.15, 0.72, 0.3], [0.62, 0.45, 0.25]], cliff: 0.8, rocky: 0.15, seed: 11 },
  // Small rocky islet with the lighthouse, north-east.
  { bearing: 52, distance: 2300, length: 520, width: 300, axis: 140, height: 24, hills: [[0.2, 1, 0.35], [-0.35, 0.7, 0.3], [0.7, 0.55, 0.18]], cliff: 0.95, rocky: 0.75, seed: 23 },
  // Large hilly island far to the south-south-west, mostly haze.
  { bearing: 203, distance: 5600, length: 4600, width: 1700, axis: 100, height: 215, hills: [[-0.3, 1, 0.3], [0.25, 0.82, 0.28], [0.7, 0.5, 0.2]], cliff: 0.55, rocky: 0.1, seed: 37 },
  // Low islet east-south-east.
  { bearing: 112, distance: 4300, length: 1100, width: 420, axis: 20, height: 48, hills: [[-0.2, 1, 0.4], [0.45, 0.6, 0.3]], cliff: 0.7, rocky: 0.4, seed: 41 },
];

/** Extinction of the marine haze (per metre): ≈ 35 % at 2.3 km, 65 % at 5.6 km (visibility ≈ 20 km). */
const HAZE_PER_M = 1.9e-4;
const RINGS = 44;
const SECTORS = 180;

const ROCK = new THREE.Color().setRGB(0.3, 0.27, 0.22, THREE.LinearSRGBColorSpace);
const SCRUB = new THREE.Color().setRGB(0.16, 0.15, 0.08, THREE.LinearSRGBColorSpace);
const FOREST = new THREE.Color().setRGB(0.045, 0.06, 0.028, THREE.LinearSRGBColorSpace);
const WET_ROCK = new THREE.Color().setRGB(0.07, 0.065, 0.055, THREE.LinearSRGBColorSpace);

function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  for (let i = 0; i < octaves; i++) {
    sum += amp * gradientNoise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 - 5.3;
    amp *= 0.5;
  }
  return sum;
}

/** Height (m) at normalised footprint coordinates (u along the axis, v across; ρ = 1 is the coast). */
function terrainHeight(spec: IslandSpec, u: number, v: number, rho: number, wx: number, wz: number): number {
  if (rho >= 1) return -4 * Math.min(1, (rho - 1) / 0.08);
  let ridge = 0;
  for (const [pos, amp, spread] of spec.hills) ridge = Math.max(ridge, amp * Math.exp(-(((u - pos) / spread) ** 2)));
  const across = Math.exp(-((v / 0.62) ** 2));
  // Relief scales with the island: knolls and gullies on a headland, boulders and ledges on an islet.
  const broad = Math.min(420, spec.length * 0.22);
  const fine = Math.min(90, spec.length * 0.05);
  const detail = 1 + 0.35 * fbm(wx / broad + spec.seed, wz / broad, 4) + (0.12 + 0.2 * spec.rocky) * fbm(wx / fine, wz / fine + spec.seed, 3);
  // Coastal cliff: the land keeps its height almost to the shore, then drops.
  const edge = THREE.MathUtils.clamp((1 - rho) / (0.02 + 0.2 * (1 - spec.cliff)), 0, 1);
  const shore = Math.pow(edge, 0.6);
  const interior = (0.25 + 0.75 * ridge * across) * detail;
  return Math.max(0.5, spec.height * interior * shore) * (rho < 0.999 ? 1 : 0);
}

function buildIsland(spec: IslandSpec): THREE.BufferGeometry {
  const bearing = THREE.MathUtils.degToRad(spec.bearing);
  const cx = Math.sin(bearing) * spec.distance;
  const cz = -Math.cos(bearing) * spec.distance;
  const axis = THREE.MathUtils.degToRad(spec.axis);
  const ax = new THREE.Vector2(Math.sin(axis), -Math.cos(axis)); // long axis in (X, Z)
  const cxAxis = new THREE.Vector2(-ax.y, ax.x);                  // across axis

  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const rho = 1.1 * Math.sqrt(i / RINGS);
    for (let j = 0; j <= SECTORS; j++) {
      const phi = (j / SECTORS) * 2 * Math.PI;
      // Ragged coastline: bays and points.
      const coast = 1 + 0.16 * fbm(Math.cos(phi) * 1.7 + spec.seed, Math.sin(phi) * 1.7, 4);
      const u = rho * coast * Math.cos(phi);
      const v = rho * coast * Math.sin(phi);
      const lx = (u * spec.length) / 2;
      const lz = (v * spec.width) / 2;
      const wx = cx + ax.x * lx + cxAxis.x * lz;
      const wz = cz + ax.y * lx + cxAxis.y * lz;
      positions.push(wx, terrainHeight(spec, u, v, rho, wx, wz), wz);
    }
  }
  const row = SECTORS + 1;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SECTORS; j++) {
      const a = i * row + j;
      const b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // Colour by slope, height and noise: forest in the hollows, scrub on the tops, rock on the cliffs.
  const normals = geometry.getAttribute('normal');
  const colors = new Float32Array(positions.length);
  const c = new THREE.Color();
  for (let k = 0; k < positions.length / 3; k++) {
    const x = positions[k * 3]!;
    const y = positions[k * 3 + 1]!;
    const z = positions[k * 3 + 2]!;
    const steep = 1 - normals.getY(k);
    const n = fbm(x / 160 + spec.seed, z / 160, 3);
    const rock = Math.max(THREE.MathUtils.smoothstep(steep, 0.28, 0.5), spec.rocky * THREE.MathUtils.smoothstep(n, -0.1, 0.25));
    const scrub = THREE.MathUtils.clamp(0.45 + n * 1.4 + (y / spec.height) * 0.3 + spec.rocky, 0, 1);
    c.copy(FOREST).lerp(SCRUB, scrub).lerp(ROCK, rock);
    if (y < 2.5) c.lerp(WET_ROCK, 1 - y / 2.5);
    colors[k * 3] = c.r;
    colors[k * 3 + 1] = c.g;
    colors[k * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('mottle', new THREE.BufferAttribute(new Float32Array(positions.length / 3).fill(1), 1));
  return geometry;
}

/** Painted building parts: flat vertex colour, no terrain mottling. */
function colored(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, position: THREE.Vector3): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  g.translate(position.x, position.y, position.z);
  const c = new THREE.Color(color);
  const count = g.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('mottle', new THREE.BufferAttribute(new Float32Array(count), 1));
  return g;
}

/** White tower with a red lantern roof and a keeper's cottage. Returns geometry and the lamp position. */
function buildLighthouse(base: THREE.Vector3): { geometry: THREE.BufferGeometry; lamp: THREE.Vector3 } {
  const white = 0xe8e6df;
  const red = 0x8a1c14;
  const dark = 0x202224;
  const towerHeight = 17;
  const parts = [
    colored(new THREE.CylinderGeometry(1.55, 2.1, towerHeight, 20, 1, true), white, base.clone().add(new THREE.Vector3(0, towerHeight / 2, 0))),
    colored(new THREE.CylinderGeometry(2.25, 2.25, 0.45, 20), dark, base.clone().add(new THREE.Vector3(0, towerHeight + 0.2, 0))),
    colored(new THREE.CylinderGeometry(1.15, 1.15, 2.0, 16, 1, true), dark, base.clone().add(new THREE.Vector3(0, towerHeight + 1.4, 0))),
    colored(new THREE.ConeGeometry(1.45, 1.3, 16), red, base.clone().add(new THREE.Vector3(0, towerHeight + 3.05, 0))),
    colored(new THREE.BoxGeometry(8, 4.2, 5), white, base.clone().add(new THREE.Vector3(6.5, 2.1, 1.5))),
    colored(new THREE.CylinderGeometry(0.01, 4.3, 2.2, 4, 1).rotateY(Math.PI / 4).scale(1.35, 1, 0.85), red, base.clone().add(new THREE.Vector3(6.5, 5.3, 1.5))),
  ];
  const geometry = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return { geometry, lamp: base.clone().add(new THREE.Vector3(0, towerHeight + 1.4, 0)) };
}

const HAZE_GLSL = /* glsl */ `
{
	vec3 toFrag = vLandWorld - cameraPosition;
	float dist = length( toFrag );
	vec3 viewDir = toFrag / max( dist, 1e-3 );
	float haze = 1.0 - exp( - dist * landHaze );
	// Light scattered toward the eye along the path is the sky just above the horizon in this direction.
	vec3 hazeDir = normalize( vec3( viewDir.x, max( viewDir.y, 0.0 ) + 0.012, viewDir.z ) );
	#if defined( ENVMAP_TYPE_CUBE_UV )
		vec3 hazeColor = textureCubeUV( envMap, envMapRotation * hazeDir, 0.0 ).rgb;
	#elif defined( USE_FOG )
		vec3 hazeColor = fogColor;
	#else
		vec3 hazeColor = gl_FragColor.rgb;
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeColor, haze );
}`;

/**
 * Albedo mottling below the vertex spacing: clumps of trees and scrub, bare patches. Each octave fades out
 * once it is smaller than about two pixels, so distant land stays calm instead of shimmering.
 */
const MOTTLE_GLSL = /* glsl */ `
float landHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float landNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( landHash( i ), landHash( i + vec2( 1.0, 0.0 ) ), u.x ),
		mix( landHash( i + vec2( 0.0, 1.0 ) ), landHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float landMottle( vec2 xz ) {
	float sum = 0.0;
	float amp = 0.5;
	float freq = 1.0 / 60.0;
	for ( int i = 0; i < 4; i ++ ) {
		vec2 p = xz * freq;
		float footprint = length( fwidth( p ) );
		sum += amp * ( landNoise( p ) - 0.5 ) * ( 1.0 - smoothstep( 0.25, 0.6, footprint ) );
		amp *= 0.6;
		freq *= 3.1;
	}
	return sum;
}`;

function createLandMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  material.name = 'land';
  material.onBeforeCompile = (shader) => {
    shader.uniforms['landHaze'] = { value: HAZE_PER_M };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float mottle;\nvarying vec3 vLandWorld;\nvarying float vMottle;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvLandWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n\tvMottle = mottle;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLandWorld;\nvarying float vMottle;\nuniform float landHaze;\n${MOTTLE_GLSL}`)
      // Woods, scrub and bare patches differ 2–4× in albedo: mottle in stops, not percent.
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb *= exp2( 2.4 * vMottle * landMottle( vLandWorld.xz ) );')
      .replace('#include <fog_fragment>', HAZE_GLSL);
  };
  material.customProgramCacheKey = () => 'land-haze-5';
  return material;
}

/** Lighthouse character "Fl(2) W 10s": two 0.4 s flashes every 10 s. */
function lighthouseFlash(t: number): number {
  const p = t % 10;
  const pulse = (start: number) => Math.max(0, 1 - Math.abs(p - start) / 0.25);
  return Math.max(pulse(0.3), pulse(1.6));
}

export class Land {
  readonly group = new THREE.Group();

  private readonly sky: SkyState;
  private readonly mesh: THREE.Mesh;
  private readonly lamp: THREE.Points;
  private readonly lampMaterial: THREE.PointsMaterial;

  constructor(scene: THREE.Scene, sky: SkyState) {
    this.sky = sky;
    this.group.name = 'land';

    const islands = ISLANDS.map(buildIsland);
    const lighthouseSpec = ISLANDS[1]!;
    const top = highestPoint(islands[1]!);
    const lighthouse = buildLighthouse(top.setY(top.y - 0.5));
    const geometry = mergeGeometries([...islands.map((g) => g.toNonIndexed()), lighthouse.geometry])!;
    for (const g of islands) g.dispose();
    lighthouse.geometry.dispose();
    geometry.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geometry, createLandMaterial());
    this.mesh.name = `islands (${ISLANDS.length}, lighthouse at ${lighthouseSpec.bearing}°)`;
    this.group.add(this.mesh);

    // The lamp: a screen-sized HDR point so bloom turns it into a real light at dusk.
    const lampGeometry = new THREE.BufferGeometry().setFromPoints([lighthouse.lamp]);
    this.lampMaterial = new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, color: 0xfff1d6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.lamp = new THREE.Points(lampGeometry, this.lampMaterial);
    this.lamp.visible = false;
    this.group.add(this.lamp);

    scene.add(this.group);
  }

  /** Optional per-frame call: the lighthouse flashes once the sun is low. `t` in seconds. */
  update(t: number): void {
    const dusk = THREE.MathUtils.smoothstep(-this.sky.sunDirection.y, -0.12, -0.02);
    const on = dusk * lighthouseFlash(t);
    this.lamp.visible = on > 0.01;
    this.lampMaterial.color.setRGB(1, 0.94, 0.82).multiplyScalar(on * 60);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.lamp.geometry.dispose();
    this.lampMaterial.dispose();
  }
}

function highestPoint(geometry: THREE.BufferGeometry): THREE.Vector3 {
  const pos = geometry.getAttribute('position');
  const best = new THREE.Vector3(0, -Infinity, 0);
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > best.y) best.set(pos.getX(i), pos.getY(i), pos.getZ(i));
  return best;
}
