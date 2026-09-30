// Post chain (spec §9.1/§9.2) on pmndrs `postprocessing`: HalfFloat HDR scene buffer → anti-aliasing,
// bloom (sun glints only), AgX tone mapping, vibrance, a subtle vignette and dithering against sky banding.
//
// Layout, measured on a loaded M2 (ANGLE/Metal) in real frames — every frame closes its passes, best of 9
// interleaved rounds per run, post = frame − the same frame drawn straight to the canvas:
//                                             2.9 MP (high, Retina)   1.44 MP     5.2 MP (ultra, Retina)
//   this chain, one fused pass (high…low)          1.2–1.6 ms          0.85 ms
//   this chain, SMAA in a second pass (ultra)                                        7.4 ms
//   before: 7-level bloom | SMAA                   4.1–5.4 ms          2.1 ms        8.5 ms
// Tile-based GPUs pay mostly per pass (closing the scene pass costs about as much as a whole extra frame of
// shading here), so fewer passes beat cheaper pixels.
// SMAA costs two extra full-resolution passes and needs the tone-mapped image, so it must follow tone mapping in
// a pass of its own (pmndrs runs convolution effects first in a fused pass). Below ultra everything is therefore
// one pass straight from the HDR buffer, with FXAA judging edges on a tone-compressed luma:
//   [FXAA → NaN/Inf guard → bloom add → AgX → vibrance → vignette + dither] → canvas
// Ultra keeps SMAA (sharper on texture detail) and its extra pass:
//   [guard → bloom add → AgX] → [SMAA → vibrance → vignette + dither] → canvas
//
// The HDR buffer is fp16: a glossy highlight under the calibrated sun (23–49) can exceed 65 504 and is stored as
// +Inf on IEEE-conforming GPUs (Apple saturates to 65 504). Every stage that reads it clamps first (NaN → 0,
// ±Inf → 6·10⁴), so an overflow is a white glint, never a NaN that the blur pyramid spreads into black blocks.
import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  Effect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { pixelRatioFor } from './renderer';
import type { QualitySettings } from './types';

export type ToneMapping = 'agx' | 'aces';

const TONE_MODES: Record<ToneMapping, ToneMappingMode> = { agx: ToneMappingMode.AGX, aces: ToneMappingMode.ACES_FILMIC };
const RENDERER_TONE_MAPPING: Record<ToneMapping, THREE.ToneMapping> = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping };

/**
 * Bloom levels in exposed scene units (scene radiance × exposure; AgX reaches white near 16).
 * Only sun glints, the sun disc and specular hot spots pass; `maxLuminance` stops single-pixel glints from
 * turning into blobs (fireflies) and caps the sun disc. The threshold runs at half resolution and the blur
 * pyramid starts at quarter resolution: a glint glow is soft anyway, and the full-resolution steps were
 * most of the bloom's cost.
 */
const BLOOM = { threshold: 14, smoothing: 10, maxLuminance: 48, intensity: 0.4, radius: 0.62, levels: 5 };
const VIGNETTE = { offset: 0.22, darkness: 0.42 };
/** Saturation lift for weakly saturated colours after AgX (whose base look greys blues); 0 = off. */
const VIBRANCE = 0.25;
/**
 * FXAA 3.11's standard thresholds (pmndrs ships the "visible limit" 0.0312 minimum). Low-contrast ripples on
 * the water then skip the edge search; hull, rig and sail silhouettes against sky and sea are still smoothed.
 */
const FXAA = { minEdgeThreshold: 0.0625, maxEdgeThreshold: 0.166, samples: 8 };
/** Largest value the chain lets through: below the fp16 maximum (65 504), so sums and blurs stay finite. */
const HDR_MAX = '6.0e4';

/**
 * GLSL that maps NaN to 0 and ±Inf into [0, HDR_MAX]. NaN is found from its bit pattern and removed with a
 * boolean select (no arithmetic touches it): `isnan()` makes ANGLE compile the whole fused shader without
 * fast math on Metal, which measured 3.7 ms at 2.9 MP, and fast-math compilers may fold `x != x` away.
 */
const SANITIZE_GLSL = /* glsl */ `
vec3 sanitizeHdr(const in vec3 c) {
  bvec3 isNan = greaterThan(floatBitsToUint(c) & uvec3(0x7fffffffu), uvec3(0x7f800000u));
  return min(vec3(${HDR_MAX}), max(vec3(0.0), mix(c, vec3(0.0), isNan)));
}`;

/** First stage after the HDR buffer: nothing non-finite reaches bloom or tone mapping. */
export class HdrGuardEffect extends Effect {
  constructor() {
    super('HdrGuardEffect', /* glsl */ `${SANITIZE_GLSL}
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        outputColor = vec4(sanitizeHdr(inputColor.rgb), 1.0);
      }`);
  }
}

/**
 * Vibrance on the tone-mapped image: pale sky and sea blues gain saturation, colours that are already
 * saturated (an orange mark) barely change, and greys and whites stay neutral — so whites never tint.
 */
export class VibranceEffect extends Effect {
  constructor(amount: number) {
    super('VibranceEffect', /* glsl */ `
      uniform float vibrance;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float peak = max(c.r, max(c.g, c.b));
        float sat = (peak - min(c.r, min(c.g, c.b))) / max(peak, 1e-4);
        outputColor = vec4(max(mix(vec3(luma), c, 1.0 + vibrance * (1.0 - sat)), 0.0), inputColor.a);
      }`, { uniforms: new Map([['vibrance', new THREE.Uniform(amount)]]) });
  }
}

/**
 * FXAA straight on the HDR buffer. Edges are judged on a tone-compressed, gamma-like luma
 * (√(L/(1+L)) of the exposed luminance), the space FXAA's thresholds were tuned for; the blend itself stays
 * linear HDR and the guard that follows sanitises it.
 */
export class HdrFxaaEffect extends FXAAEffect {
  constructor() {
    super();
    const source = this.getFragmentShader();
    if (!source.includes('luminance(')) throw new Error('post: pmndrs FXAA shader changed (no luminance() taps)');
    // Taps are sanitised too, so a non-finite neighbour cannot turn FXAA's sample offset into NaN.
    const lumaFn = /* glsl */ `${SANITIZE_GLSL}
      uniform float fxaaExposure;
      float fxaaLuma(const in vec3 c) {
        float l = luminance(sanitizeHdr(c)) * fxaaExposure;
        return sqrt(l / (1.0 + l));
      }
    `;
    this.uniforms.set('fxaaExposure', new THREE.Uniform(1));
    this.setFragmentShader(lumaFn + source.split('luminance(').join('fxaaLuma('));
    this.minEdgeThreshold = FXAA.minEdgeThreshold;
    this.maxEdgeThreshold = FXAA.maxEdgeThreshold;
    this.samples = FXAA.samples;
  }

  set exposure(value: number) {
    this.uniforms.get('fxaaExposure')!.value = value;
  }
}

/** True when the GPU can render into half-float targets (WebGL2 needs an extension for that). */
export function supportsHalfFloatTargets(renderer: THREE.WebGLRenderer): boolean {
  return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

/**
 * Bloom input: sanitise each HDR texel before it is measured (an fp16 +Inf would otherwise become
 * Inf · 0 = NaN in the clamp below), then scale anything above `maxLuminance` down to it.
 */
function patchBloomInput(bloom: BloomEffect): void {
  const material = bloom.luminanceMaterial;
  const read = 'vec4 texel=texture2D(inputBuffer,vUv);';
  const write = 'gl_FragColor=texel*mask;';
  const src = material.fragmentShader;
  if (!src.includes(read) || !src.includes(write)) throw new Error('post: pmndrs luminance shader changed');
  material.uniforms['maxLuminance'] = new THREE.Uniform(BLOOM.maxLuminance);
  material.fragmentShader = src
    .replace('void main(){', `uniform float maxLuminance;\n${SANITIZE_GLSL}\nvoid main(){`)
    .replace(read, `${read}texel.rgb=sanitizeHdr(texel.rgb);`)
    .replace(write, 'vec4 c=texel*mask;float cl=luminance(c.rgb);gl_FragColor=c*min(1.0,maxLuminance/max(cl,1e-4));');
  material.needsUpdate = true;
}

export function createBloom(): BloomEffect {
  const bloom = new BloomEffect({
    blendFunction: BlendFunction.ADD,
    mipmapBlur: true,
    luminanceThreshold: BLOOM.threshold,
    luminanceSmoothing: BLOOM.smoothing,
    intensity: BLOOM.intensity,
    radius: BLOOM.radius,
    levels: BLOOM.levels,
  });
  bloom.luminancePass.resolution.scale = 0.5;
  const setSize = bloom.setSize.bind(bloom);
  bloom.setSize = (width: number, height: number) => {
    setSize(width, height);
    bloom.mipmapBlurPass.setSize(Math.round(width / 2), Math.round(height / 2));
  };
  patchBloomInput(bloom);
  return bloom;
}

/** SMAA's thresholds assume gamma-encoded input; its edge pass reads the linear buffer, so encode the taps. */
function perceptualEdges(smaa: SMAAEffect): void {
  const material = smaa.edgeDetectionMaterial;
  const patched = material.fragmentShader.replace(/texture2D\(inputBuffer,(vUv\d?)\)\.rgb/g, 'sqrt(max(texture2D(inputBuffer,$1).rgb,vec3(0.0)))');
  if (patched === material.fragmentShader) throw new Error('post: pmndrs SMAA edge shader changed');
  material.fragmentShader = patched;
  material.needsUpdate = true;
}

/** Ultra keeps SMAA in its own pass; every other tier runs the single fused pass. */
type Layout = 'fused-fxaa' | 'smaa';
const layoutFor = (q: QualitySettings): Layout => (q.tier === 'ultra' ? 'smaa' : 'fused-fxaa');

export class PostChain {
  /** False when half-float targets are unsupported: the scene then renders directly with renderer tone mapping. */
  readonly hdr: boolean;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private camera: THREE.Camera;
  private quality: QualitySettings;
  private toneMapping: ToneMapping = 'agx';
  private readonly size = new THREE.Vector2(1, 1);

  private readonly composer: EffectComposer | null = null;
  // Effects belong to their pass (disposing a pass disposes its effects), so a rebuild makes new ones.
  private bloom: BloomEffect | null = null;
  private toneEffect: ToneMappingEffect | null = null;
  private fxaa: HdrFxaaEffect | null = null;
  private passes: EffectPass[] = [];

  /** `options.hdr = false` forces the direct-to-canvas fallback (for testing it on capable GPUs). */
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, q: QualitySettings, options: { hdr?: boolean } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = q;
    this.hdr = options.hdr !== false && supportsHalfFloatTargets(renderer);
    renderer.getSize(this.size);
    if (this.hdr) {
      renderer.toneMapping = THREE.NoToneMapping;
      this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0, stencilBuffer: false });
      this.composer.addPass(new RenderPass(scene, camera));
      this.buildEffectPasses();
    } else {
      renderer.toneMapping = RENDERER_TONE_MAPPING[this.toneMapping];
    }
    this.setQuality(q);
  }

  /** CSS-pixel size of the canvas; the tier's pixel ratio is applied on top. */
  setSize(width: number, height: number): void {
    this.size.set(Math.max(1, width), Math.max(1, height));
    this.renderer.setPixelRatio(pixelRatioFor(this.quality));
    if (this.composer) this.composer.setSize(this.size.x, this.size.y, false);
    else this.renderer.setSize(this.size.x, this.size.y, false);
  }

  setQuality(q: QualitySettings): void {
    const rebuild = q.bloom !== this.quality.bloom || layoutFor(q) !== layoutFor(this.quality);
    this.quality = q;
    if (this.composer && rebuild) this.buildEffectPasses();
    this.setSize(this.size.x, this.size.y);
  }

  setToneMapping(mode: ToneMapping): void {
    this.toneMapping = mode;
    if (this.toneEffect) this.toneEffect.mode = TONE_MODES[mode];
    if (!this.hdr) this.renderer.toneMapping = RENDERER_TONE_MAPPING[mode];
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    this.composer?.setMainCamera(camera);
  }

  render(dt: number): void {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // Thresholds are defined after exposure, so bloom stays "glints only" and FXAA sees the same edges at
    // dusk and at noon.
    const exposure = Math.max(1e-3, this.renderer.toneMappingExposure);
    if (this.bloom) {
      const lum = this.bloom.luminanceMaterial;
      lum.threshold = BLOOM.threshold / exposure;
      lum.smoothing = BLOOM.smoothing / exposure;
      lum.uniforms['maxLuminance']!.value = BLOOM.maxLuminance / exposure;
    }
    if (this.fxaa) this.fxaa.exposure = exposure;
    this.composer.render(dt);
  }

  /** Disposes the composer, its passes and their effects. */
  dispose(): void {
    this.composer?.dispose();
  }

  private buildEffectPasses(): void {
    const composer = this.composer;
    if (!composer) return;
    for (const pass of this.passes) {
      composer.removePass(pass);
      pass.dispose();
    }
    this.bloom = this.quality.bloom ? createBloom() : null;
    this.toneEffect = new ToneMappingEffect({ mode: TONE_MODES[this.toneMapping] });
    const bloom = this.bloom ? [this.bloom] : [];
    const finish = [new VibranceEffect(VIBRANCE), new VignetteEffect(VIGNETTE)];

    if (layoutFor(this.quality) === 'smaa') {
      this.fxaa = null;
      const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.COLOR });
      perceptualEdges(smaa);
      this.passes = [new EffectPass(this.camera, new HdrGuardEffect(), ...bloom, this.toneEffect), new EffectPass(this.camera, smaa, ...finish)];
    } else {
      this.fxaa = new HdrFxaaEffect();
      this.passes = [new EffectPass(this.camera, this.fxaa, new HdrGuardEffect(), ...bloom, this.toneEffect, ...finish)];
    }
    this.passes[this.passes.length - 1]!.dithering = true;
    for (const pass of this.passes) composer.addPass(pass);
  }
}
