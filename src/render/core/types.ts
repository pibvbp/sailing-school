// Render-side shared contract: quality tiers and the sky/light state other modules consume.
import type * as THREE from 'three';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

export interface QualitySettings {
  tier: QualityTier;
  /** Cap applied to window.devicePixelRatio before renderScale. */
  pixelRatioCap: number;
  /** Multiplier on the capped pixel ratio (dynamic resolution). */
  renderScale: number;
  oceanFFTSize: 128 | 256;
  oceanCascades: 2 | 3;
  /** 0…1 density of the ocean grid. */
  oceanMeshDetail: number;
  reflections: 'off' | 'half' | 'full';
  /** 0 disables shadows. */
  shadowMapSize: 0 | 1024 | 2048 | 4096;
  bloom: boolean;
  /** 0…1 multiplier on particle counts. */
  particleScale: number;
  /** 0…1 multiplier on sail mesh resolution. */
  sailResolution: number;
}

const TIERS: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  ultra: { pixelRatioCap: 2, renderScale: 1, oceanFFTSize: 256, oceanCascades: 3, oceanMeshDetail: 1, reflections: 'full', shadowMapSize: 4096, bloom: true, particleScale: 1, sailResolution: 1 },
  high: { pixelRatioCap: 1.5, renderScale: 1, oceanFFTSize: 256, oceanCascades: 3, oceanMeshDetail: 0.8, reflections: 'half', shadowMapSize: 2048, bloom: true, particleScale: 1, sailResolution: 1 },
  medium: { pixelRatioCap: 1.25, renderScale: 0.85, oceanFFTSize: 128, oceanCascades: 2, oceanMeshDetail: 0.6, reflections: 'off', shadowMapSize: 2048, bloom: true, particleScale: 0.6, sailResolution: 0.75 },
  low: { pixelRatioCap: 1, renderScale: 0.7, oceanFFTSize: 128, oceanCascades: 2, oceanMeshDetail: 0.4, reflections: 'off', shadowMapSize: 1024, bloom: false, particleScale: 0.35, sailResolution: 0.5 },
};

export const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export function tierSettings(tier: QualityTier): QualitySettings {
  return { tier, ...TIERS[tier] };
}

/** What the sky system publishes for the ocean, boat, sails and post chain. */
export interface SkyState {
  /** Unit vector toward the sun, three.js world frame. */
  readonly sunDirection: THREE.Vector3;
  /** Linear-space sun colour (already attenuated by the atmosphere). */
  readonly sunColor: THREE.Color;
  readonly sunIntensity: number;
  /** PMREM environment map of the sky (null until the first bake). */
  readonly envMap: THREE.Texture | null;
  readonly fogColor: THREE.Color;
  readonly horizonColor: THREE.Color;
  /** 0…1 cloud cover. */
  readonly cloudCover: number;
}
