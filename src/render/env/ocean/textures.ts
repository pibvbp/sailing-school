// Procedural textures for the ocean, baked on the GPU once at start-up.
import * as THREE from 'three';
import { FullScreenPass, makeRT, type Uniforms } from './gpuPass';
import { FOAM_BAKE, NOISE_BAKE, RIPPLE_BAKE } from './shaders/bake.glsl';

export interface OceanTextures {
  foam: THREE.Texture;
  ripple: THREE.Texture;
  noise: THREE.Texture;
  dispose(): void;
}

function bake(renderer: THREE.WebGLRenderer, frag: string, size: number, mipmapped: boolean, uniforms: Uniforms = {}): THREE.WebGLRenderTarget {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const rt = makeRT(size, size, {
    type: THREE.UnsignedByteType, wrap: THREE.RepeatWrapping, filter: mipmapped ? 'mipmap' : 'linear',
    anisotropy: mipmapped ? aniso : 1, name: 'oceanBake',
  });
  const pass = new FullScreenPass(frag, uniforms, 'oceanBake');
  pass.render(renderer, rt);
  pass.dispose();
  return rt;
}

export function bakeOceanTextures(renderer: THREE.WebGLRenderer, quality: 'full' | 'reduced'): OceanTextures {
  const foamSize = quality === 'full' ? 1024 : 512;
  const foam = bake(renderer, FOAM_BAKE, foamSize, true);
  const rippleSize = 512;
  const ripple = bake(renderer, RIPPLE_BAKE, rippleSize, true, { uRes: { value: rippleSize }, uSlope: { value: 0.05 } });
  const noise = bake(renderer, NOISE_BAKE, 256, false);
  return {
    foam: foam.texture,
    ripple: ripple.texture,
    noise: noise.texture,
    dispose() { foam.dispose(); ripple.dispose(); noise.dispose(); },
  };
}
