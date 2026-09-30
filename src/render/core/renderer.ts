// WebGL2 renderer setup (spec §9.1): antialias off (SMAA runs in the post chain), linear HDR rendering,
// no renderer tone mapping (the post chain's ToneMappingEffect does it), sRGB output, sun shadows.
import * as THREE from 'three';

/** Thrown by {@link createRenderer} when the browser cannot give us a WebGL2 context. */
export class WebGL2UnavailableError extends Error {
  constructor(message = 'WebGL2 is not available in this browser.') {
    super(message);
    this.name = 'WebGL2UnavailableError';
  }
}

export interface RendererOptions {
  /** Pretend WebGL2 is missing (tests the fallback page, e.g. `?forceNoWebGL2=1`). */
  forceNoWebGL2?: boolean;
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
};

export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions = {}): THREE.WebGLRenderer {
  let context: WebGL2RenderingContext | null = null;
  if (!options.forceNoWebGL2) {
    try {
      context = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    } catch {
      context = null;
    }
  }
  if (!context) throw new WebGL2UnavailableError();

  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false, stencil: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  // The post chain's AgX/ACES read this uniform; SkySystem sets it from the sky's brightness.
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Synchronous shader-log checks stall every compile; keep them for development only.
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  return renderer;
}

/** Pixel ratio for a quality tier: the device ratio capped by the tier, times its render scale. */
export function pixelRatioFor(q: { pixelRatioCap: number; renderScale: number }, devicePixelRatio = globalThis.devicePixelRatio ?? 1): number {
  return Math.min(devicePixelRatio, q.pixelRatioCap) * q.renderScale;
}
