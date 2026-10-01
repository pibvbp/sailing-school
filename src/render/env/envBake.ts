// Amortised environment bake.
//
// three's PMREMGenerator turns a cube map of the sky into the CubeUV texture every PBR material and the sea
// sample. One call filters every roughness level with 256 GGX samples per texel: about 10 ms on an M2, which is
// a dropped frame each time the sun moves or the clouds have drifted. This class runs the *same* passes — the
// generator's own meshes, shader and layout — but in strips, one unit of work per frame, straight into the same
// target, so the texture object stays stable and no frame carries more than a fraction of a millisecond.
//
// It leans on PMREMGenerator internals (three r186: `_lodMeshes`, `_sizeLods`, `_ggxMaterial`,
// `_pingPongRenderTarget`, `_textureToCubeUV`, and the roughness schedule of `_applyGGXFilter`, MIT, three.js
// authors). Those are checked before use; on any other revision or shape the bake falls back to the one call.
import * as THREE from 'three';

/** three's `LOD_MIN`: levels below this size are stored side by side at the same resolution. */
const LOD_MIN = 4;
const SUPPORTED_REVISION = '186';
/** Texels filtered per unit of work (level 1 of a 256² cube is 98 304 texels: 24 units, ≈ 0.4 ms each on an M2). */
const TEXELS_PER_UNIT = 4096;

interface PmremInternals {
  _lodMax: number;
  _cubeSize: number;
  _sizeLods: number[];
  _lodMeshes: THREE.Mesh[];
  _ggxMaterial: THREE.ShaderMaterial | null;
  _pingPongRenderTarget: THREE.WebGLRenderTarget | null;
  _textureToCubeUV(texture: THREE.Texture, target: THREE.WebGLRenderTarget): void;
}

function internalsOf(pmrem: THREE.PMREMGenerator): PmremInternals | null {
  if (THREE.REVISION !== SUPPORTED_REVISION) return null;
  const g = pmrem as unknown as Partial<PmremInternals>;
  const uniforms = g._ggxMaterial?.uniforms;
  const ok = typeof g._textureToCubeUV === 'function'
    && Array.isArray(g._lodMeshes) && g._lodMeshes.length > 1
    && Array.isArray(g._sizeLods) && g._sizeLods.length === g._lodMeshes.length
    && typeof g._lodMax === 'number' && typeof g._cubeSize === 'number'
    && !!uniforms && 'envMap' in uniforms && 'roughness' in uniforms && 'mipInt' in uniforms
    && !!g._pingPongRenderTarget;
  return ok ? (g as PmremInternals) : null;
}

/** One unit of work: rows [row, row + rows) of roughness level `lod` (level 0 = the copy of the cube map). */
interface Unit {
  lod: number;
  row: number;
  rows: number;
}

/** Split the roughness levels of a PMREM into units of about `texelsPerUnit` texels each. */
export function planBake(sizeLods: readonly number[], texelsPerUnit: number = TEXELS_PER_UNIT): Unit[] {
  const units: Unit[] = [{ lod: 0, row: 0, rows: 0 }];
  for (let lod = 1; lod < sizeLods.length; lod++) {
    const size = sizeLods[lod]!;
    const height = 2 * size;
    const strips = Math.max(1, Math.ceil((3 * size * height) / texelsPerUnit));
    const rows = Math.ceil(height / strips);
    for (let row = 0; row < height; row += rows) units.push({ lod, row, rows: Math.min(rows, height - row) });
  }
  return units;
}

export class EnvironmentBaker {
  private readonly flatCamera = new THREE.OrthographicCamera();
  private internals: PmremInternals | null = null;
  private units: Unit[] = [];
  private next = 0;
  private cube: THREE.CubeTexture | null = null;
  private target: THREE.WebGLRenderTarget | null = null;
  private renderCube: (() => void) | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly pmrem: THREE.PMREMGenerator) {}

  /** True while an incremental bake is in flight. */
  get busy(): boolean {
    return this.next < this.units.length;
  }

  /** Units of work in one incremental bake (0 until the first bake has run). */
  get unitCount(): number {
    return this.units.length;
  }

  /** Bake everything in one call (start-up). `renderCube` draws the sky into the cube map first. */
  bakeNow(renderCube: () => void, cube: THREE.CubeTexture, target: THREE.WebGLRenderTarget | null): THREE.WebGLRenderTarget {
    this.next = this.units.length;
    renderCube();
    const out = this.pmrem.fromCubemap(cube, target);
    // The generator has allocated its meshes and shaders now: see whether the strip-wise path can use them.
    this.internals ??= internalsOf(this.pmrem);
    return out;
  }

  /**
   * Start re-baking `cube` into `target` (a target a previous `bakeNow` returned), a unit per `step()`.
   * Returns false when the incremental path is unavailable: the caller should `bakeNow` instead.
   */
  begin(renderCube: () => void, cube: THREE.CubeTexture, target: THREE.WebGLRenderTarget): boolean {
    const g = this.internals;
    if (!g) return false;
    this.renderCube = renderCube;
    this.cube = cube;
    this.target = target;
    this.units = planBake(g._sizeLods);
    this.next = 0;
    return true;
  }

  /** Do one unit of work. Returns true when the bake is complete. */
  step(): boolean {
    const g = this.internals;
    const target = this.target;
    if (!g || !target || !this.cube || !this.busy) return true;
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevCubeFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevAutoClear = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;

    // Small levels are quick: take them together until the unit's texel budget is used.
    let budget = TEXELS_PER_UNIT;
    do {
      const unit = this.units[this.next++]!;
      if (unit.lod === 0) {
        this.renderCube?.();
        renderer.autoClear = false;
        g._textureToCubeUV(this.cube, target);
        budget = 0;
      } else {
        renderer.autoClear = false;
        this.filterStrip(g, target, unit);
        budget -= 3 * g._sizeLods[unit.lod]! * unit.rows;
      }
    } while (this.busy && budget >= 3 * g._sizeLods[this.units[this.next]!.lod]! * this.units[this.next]!.rows);

    target.scissorTest = false;
    target.viewport.set(0, 0, target.width, target.height);
    target.scissor.set(0, 0, target.width, target.height);
    renderer.setRenderTarget(prevTarget, prevCubeFace, prevMip);
    renderer.autoClear = prevAutoClear;
    renderer.xr.enabled = prevXr;
    return !this.busy;
  }

  /** `_applyGGXFilter` of three r186, restricted to a strip of rows of the output level. */
  private filterStrip(g: PmremInternals, target: THREE.WebGLRenderTarget, unit: Unit): void {
    const renderer = this.renderer;
    const ping = g._pingPongRenderTarget!;
    const material = g._ggxMaterial!;
    const lodOut = unit.lod;
    const lodIn = lodOut - 1;
    const mesh = g._lodMeshes[lodOut]!;
    mesh.material = material;
    const u = material.uniforms;

    const last = g._lodMeshes.length - 1;
    const targetRoughness = lodOut / last;
    const sourceRoughness = lodIn / last;
    const incremental = Math.sqrt(targetRoughness * targetRoughness - sourceRoughness * sourceRoughness);
    const size = g._sizeLods[lodOut]!;
    const x = 3 * size * (lodOut > g._lodMax - LOD_MIN ? lodOut - g._lodMax + LOD_MIN : 0);
    const y = 4 * (g._cubeSize - size);

    // Filter the previous level into the scratch target…
    u['envMap']!.value = target.texture;
    u['roughness']!.value = incremental * targetRoughness * 1.25;
    u['mipInt']!.value = g._lodMax - lodIn;
    ping.scissorTest = true;
    ping.viewport.set(x, y, 3 * size, 2 * size);
    ping.scissor.set(x, y + unit.row, 3 * size, unit.rows);
    renderer.setRenderTarget(ping);
    renderer.render(mesh, this.flatCamera);

    // …and copy the strip back into the environment map.
    u['envMap']!.value = ping.texture;
    u['roughness']!.value = 0;
    u['mipInt']!.value = g._lodMax - lodOut;
    target.scissorTest = true;
    target.viewport.set(x, y, 3 * size, 2 * size);
    target.scissor.set(x, y + unit.row, 3 * size, unit.rows);
    renderer.setRenderTarget(target);
    renderer.render(mesh, this.flatCamera);
  }
}
