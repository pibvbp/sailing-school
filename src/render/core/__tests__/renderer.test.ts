// Renderer set-up helpers that run without a GL context.
import { describe, it, expect } from 'vitest';
import { isSoftwareRendererName, pixelRatioFor } from '../renderer';

describe('software renderer detection', () => {
  it('recognises the software rasterisers browsers fall back to', () => {
    for (const name of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Mesa/X.org, softpipe',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Apple Software Renderer'.replace('Renderer', 'Rasterizer'),
    ]) expect(isSoftwareRendererName(name), name).toBe(true);
  });

  it('leaves real GPUs, and browsers that hide the name, on the normal start', () => {
    for (const name of [
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Mali-G78',
      'Adreno (TM) 660',
      'Apple GPU',
      'WebKit WebGL',
      'Mozilla',
      '',
    ]) expect(isSoftwareRendererName(name), name).toBe(false);
  });
});

describe('pixelRatioFor', () => {
  it('caps the device ratio by the tier and applies its render scale', () => {
    expect(pixelRatioFor({ pixelRatioCap: 1.5, renderScale: 1 }, 2)).toBe(1.5);
    expect(pixelRatioFor({ pixelRatioCap: 1, renderScale: 0.7 }, 3)).toBeCloseTo(0.7, 12);
    expect(pixelRatioFor({ pixelRatioCap: 2, renderScale: 1 }, 1)).toBe(1);
  });
});
