// True wind over the sailing area (spec §7.1): log-law gradient, drifting puffs/lulls, oscillating shifts.
import type { Puff, WindSettings } from './types';
import { mulberry32, uniform } from './rng';
import { DEG, smoothstep } from '../shared/math';

const Z0 = 0.005; // surface roughness over water (ORC VPP 2023 §7.1)
const Z_REF = 10;
const LN_REF = Math.log(Z_REF / Z0);

/** Wind speed at height h relative to the 10 m reference (log profile). */
export function gradientFactor(h: number): number {
  return Math.log(Math.max(h, 0.3) / Z0) / LN_REF;
}

/**
 * Gust gain and direction offset (rad) of a puff field at world (e, n) for base wind direction `dir`
 * (FROM). Overlapping puffs do not add up their shifts: the offset is their weighted mean once they
 * overlap. Shared by the simulation and the overlays' reconstruction of the field, so they cannot drift.
 */
export function puffInfluence(puffs: readonly Puff[], e: number, n: number, dir: number,
  out: { gain: number; turn: number }): { gain: number; turn: number } {
  const upE = Math.sin(dir), upN = Math.cos(dir);
  const crossE = Math.cos(dir), crossN = -Math.sin(dir);
  let gain = 0, turn = 0, wsum = 0;
  for (let i = 0; i < puffs.length; i++) {
    const p = puffs[i]!;
    const de = e - p.e, dn = n - p.n;
    const along = (de * upE + dn * upN) / p.radiusAlong;
    const across = (de * crossE + dn * crossN) / p.radiusAcross;
    const d2 = along * along + across * across;
    if (d2 > 9) continue;
    const w = p.envelope * Math.exp(-d2);
    gain += p.strength * w;
    turn += p.dirOffset * w;
    wsum += w;
  }
  out.gain = gain;
  out.turn = turn / Math.max(1, wsum);
  return out;
}

interface PuffState extends Puff {
  age: number;
  life: number;
}

const SPAWN_UPWIND_MIN = 400;
const SPAWN_UPWIND_MAX = 900;
const SPAWN_LATERAL = 350;
const REMOVE_DOWNWIND = 600;
const REMOVE_LATERAL = 900;
const FADE_S = 20;

export class WindField {
  readonly settings: WindSettings;
  /** Active puffs (gusts have strength > 0, lulls < 0). */
  readonly puffs: Puff[] = [];
  private readonly influence = { gain: 0, turn: 0 };
  t = 0;
  private rand: () => number;
  private nextId = 1;
  private phase1: number;
  private phase2: number;
  private spawnCooldown = 0;
  private seeded = false;

  constructor(settings: WindSettings) {
    this.settings = { ...settings };
    this.rand = mulberry32(settings.seed);
    this.phase1 = this.rand() * Math.PI * 2;
    this.phase2 = this.rand() * Math.PI * 2;
  }

  setSettings(patch: Partial<WindSettings>): void {
    const reseed = patch.seed !== undefined && patch.seed !== this.settings.seed;
    Object.assign(this.settings, patch);
    if (reseed) {
      this.rand = mulberry32(this.settings.seed);
      this.puffs.length = 0;
      this.seeded = false;
    }
    if (this.settings.gustiness <= 0) this.puffs.length = 0;
  }

  /** TWD including the slow oscillating shifts but not local puffs (rad, FROM). */
  baseDirection(): number {
    const { twd, shiftAmplitude: a, shiftPeriod: period } = this.settings;
    if (a === 0) return twd;
    const w = (2 * Math.PI) / Math.max(period, 1);
    return twd + a * (0.8 * Math.sin(w * this.t + this.phase1) + 0.2 * Math.sin((w / 2.9) * this.t + this.phase2));
  }

  step(dt: number, boatE: number, boatN: number): void {
    this.t += dt;
    const gust = this.settings.gustiness;
    const dir = this.baseDirection();
    const upE = Math.sin(dir), upN = Math.cos(dir);      // toward where the wind comes from
    const crossE = Math.cos(dir), crossN = -Math.sin(dir);
    const drift = this.settings.tws * 0.9;

    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i] as PuffState;
      p.age += dt;
      p.e -= upE * drift * dt;
      p.n -= upN * drift * dt;
      p.envelope = smoothstep(0, FADE_S, p.age) * (1 - smoothstep(p.life - FADE_S, p.life, p.age));
      const de = p.e - boatE, dn = p.n - boatN;
      const along = de * upE + dn * upN;       // + upwind of the boat
      const across = de * crossE + dn * crossN;
      if (p.age >= p.life || along < -REMOVE_DOWNWIND || Math.abs(across) > REMOVE_LATERAL) this.puffs.splice(i, 1);
    }

    if (gust <= 0) return;
    const target = Math.round(6 * gust);
    if (!this.seeded) {
      // Fill the area straight away so gusts are visible from the first second.
      for (let k = 0; k < target; k++) this.spawn(boatE, boatN, dir, uniform(this.rand, -250, SPAWN_UPWIND_MAX), true);
      this.seeded = true;
    }
    this.spawnCooldown -= dt;
    if (this.puffs.length < target && this.spawnCooldown <= 0) {
      this.spawn(boatE, boatN, dir, uniform(this.rand, SPAWN_UPWIND_MIN, SPAWN_UPWIND_MAX), false);
      this.spawnCooldown = uniform(this.rand, 3, 12);
    }
  }

  private spawn(boatE: number, boatN: number, dir: number, upwind: number, midLife: boolean): void {
    const g = this.settings.gustiness;
    const upE = Math.sin(dir), upN = Math.cos(dir);
    const crossE = Math.cos(dir), crossN = -Math.sin(dir);
    let e = 0, n = 0, ra = 0, rc = 0;
    // Try a few positions and keep puffs from piling on top of each other.
    for (let attempt = 0; attempt < 6; attempt++) {
      const lateral = uniform(this.rand, -SPAWN_LATERAL, SPAWN_LATERAL);
      e = boatE + upE * upwind + crossE * lateral;
      n = boatN + upN * upwind + crossN * lateral;
      ra = uniform(this.rand, 40, 120) * (0.7 + 0.6 * g);
      rc = ra * uniform(this.rand, 1.3, 2.0);
      const clear = this.puffs.every((q) => Math.hypot(q.e - e, q.n - n) > 0.8 * (Math.max(q.radiusAcross, rc) + Math.min(q.radiusAlong, ra)));
      if (clear) break;
    }
    const isGust = this.rand() < 0.7;
    const strength = isGust ? uniform(this.rand, 0.15, 0.45) * (0.5 + 0.5 * g) : -uniform(this.rand, 0.1, 0.3) * (0.5 + 0.5 * g);
    const dirOffset = isGust ? uniform(this.rand, -6, 14) * DEG : uniform(this.rand, -8, 8) * DEG;
    const life = uniform(this.rand, 90, 240);
    const puff: PuffState = {
      id: this.nextId++,
      e, n,
      radiusAlong: ra,
      radiusAcross: rc,
      strength,
      dirOffset,
      envelope: 0,
      age: midLife ? uniform(this.rand, FADE_S, life - FADE_S) : 0,
      life,
    };
    puff.envelope = smoothstep(0, FADE_S, puff.age) * (1 - smoothstep(puff.life - FADE_S, puff.life, puff.age));
    this.puffs.push(puff);
  }

  /** True wind at a world point (east, north) and height h: speed (m/s) and direction FROM (rad). */
  sample(e: number, n: number, h: number): { speed: number; dir: number } {
    const base = this.settings.tws * gradientFactor(h);
    const dir = this.baseDirection();
    if (this.puffs.length === 0) return { speed: base, dir };
    const { gain, turn } = puffInfluence(this.puffs, e, n, dir, this.influence);
    return { speed: base * Math.max(0.2, 1 + gain), dir: dir + turn };
  }

  /** Air velocity (toward) at a world point and height, world (east, north) components. */
  velocity(e: number, n: number, h: number): { e: number; n: number } {
    const { speed, dir } = this.sample(e, n, h);
    return { e: -speed * Math.sin(dir), n: -speed * Math.cos(dir) };
  }
}
