// Post chain (spec §9.1) on pmndrs `postprocessing`: HalfFloat HDR scene buffer → bloom (sun glints only)
// → AgX tone mapping → SMAA → vibrance → subtle vignette, with dithering against 8-bit sky banding.
//
// Two effect passes instead of one: pmndrs sorts convolution effects (SMAA) to the front of a fused pass,
// where they would read the raw HDR buffer. SMAA's edge thresholds are made for display-referred values,
// and blending HDR edges before tone mapping leaves bright edges aliased, so SMAA runs on the tone-mapped
// image in a second pass (measured: no slower than the fused single pass, which pays for SMAA anyway).
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
 * turning into blobs (fireflies) and caps the sun disc.
 */
const BLOOM = { threshold: 14, smoothing: 10, maxLuminance: 48, intensity: 0.35, radius: 0.62, levels: 7 };
const VIGNETTE = { offset: 0.22, darkness: 0.42 };
/** Saturation lift for weakly saturated colours after AgX (whose base look greys blues); 0 = off. */
const VIBRANCE = 0.25;

/**
 * Vibrance on the tone-mapped image: pale sky and sea blues gain saturation, colours that are already
 * saturated (an orange mark) barely change, and greys and whites stay neutral — so whites never tint.
 */
class VibranceEffect extends Effect {
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

/** True when the GPU can render into half-float targets (WebGL2 needs an extension for that). */
export function supportsHalfFloatTargets(renderer: THREE.WebGLRenderer): boolean {
  return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

/** Clamp the bloom input so one blazing pixel cannot flood the blur pyramid. */
function clampBloomInput(bloom: BloomEffect, maxLuminance: number): void {
  const material = bloom.luminanceMaterial;
  const original = 'gl_FragColor=texel*mask;';
  if (!material.fragmentShader.includes(original)) return; // library changed: keep its behaviour
  material.uniforms['maxLuminance'] = new THREE.Uniform(maxLuminance);
  material.fragmentShader = material.fragmentShader
    .replace('void main(){', 'uniform float maxLuminance;\nvoid main(){')
    .replace(original, 'vec4 c=texel*mask;float cl=luminance(c.rgb);gl_FragColor=c*min(1.0,maxLuminance/max(cl,1e-4));');
  material.needsUpdate = true;
}

/**
 * Anti-aliasing per tier. Measured on an M2 at 1600×900 (scene excluded): SMAA ≈ 1.2 ms, FXAA ≈ 0.6 ms;
 * MSAA ×4 on the HDR target was slower than SMAA on ANGLE/Metal. The low tier trades crispness for FXAA.
 */
type AntiAliasing = 'smaa-high' | 'smaa-medium' | 'fxaa';
function antiAliasing(q: QualitySettings): AntiAliasing {
  if (q.tier === 'low') return 'fxaa';
  return q.tier === 'medium' ? 'smaa-medium' : 'smaa-high';
}

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
  private hdrPass: EffectPass | null = null;
  private displayPass: EffectPass | null = null;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, q: QualitySettings) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = q;
    this.hdr = supportsHalfFloatTargets(renderer);
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
    const rebuild = q.bloom !== this.quality.bloom || antiAliasing(q) !== antiAliasing(this.quality);
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
    if (this.bloom) {
      // Thresholds are defined after exposure, so bloom stays "glints only" at dusk and noon alike.
      const exposure = Math.max(1e-3, this.renderer.toneMappingExposure);
      const lum = this.bloom.luminanceMaterial;
      lum.threshold = BLOOM.threshold / exposure;
      lum.smoothing = BLOOM.smoothing / exposure;
      const max = lum.uniforms['maxLuminance'];
      if (max) max.value = BLOOM.maxLuminance / exposure;
    }
    this.composer.render(dt);
  }

  /** Disposes the composer, its passes and their effects. */
  dispose(): void {
    this.composer?.dispose();
  }

  private buildEffectPasses(): void {
    const composer = this.composer;
    if (!composer) return;
    for (const pass of [this.hdrPass, this.displayPass]) {
      if (!pass) continue;
      composer.removePass(pass);
      pass.dispose();
    }
    this.bloom = null;

    const hdrEffects: Array<BloomEffect | ToneMappingEffect> = [];
    if (this.quality.bloom) {
      this.bloom = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: BLOOM.threshold,
        luminanceSmoothing: BLOOM.smoothing,
        intensity: BLOOM.intensity,
        radius: BLOOM.radius,
        levels: BLOOM.levels,
      });
      clampBloomInput(this.bloom, BLOOM.maxLuminance);
      hdrEffects.push(this.bloom);
    }
    this.toneEffect = new ToneMappingEffect({ mode: TONE_MODES[this.toneMapping] });
    hdrEffects.push(this.toneEffect);
    const aa = antiAliasing(this.quality);
    const aaEffect = aa === 'fxaa'
      ? new FXAAEffect()
      : new SMAAEffect({ preset: aa === 'smaa-high' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM, edgeDetectionMode: EdgeDetectionMode.COLOR });
    this.hdrPass = new EffectPass(this.camera, ...hdrEffects);
    this.displayPass = new EffectPass(this.camera, aaEffect, new VibranceEffect(VIBRANCE), new VignetteEffect(VIGNETTE));
    this.displayPass.dithering = true;
    composer.addPass(this.hdrPass);
    composer.addPass(this.displayPass);
  }
}
