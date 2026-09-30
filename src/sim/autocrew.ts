// The "crew" (spec §7.7): auto-trim for each sail, crew-driven manoeuvres (tack, gybe, hoist, douse).
// Auto-trim reads the same thing a real trimmer reads — the sail's angle of attack as shown by its
// telltales / luff curl — and eases or trims the sheet toward the groove.
import { DEG, clamp, lerp, smoothstep } from '../shared/math';
import type { HelmMode, SimSnapshot } from './types';
import { MAIN_AERO, JIB_AERO, alphaLuff, alphaStall } from './aero';
import { ALPHA_CURL } from './sails/spinnaker';
import type { CrewHook, Simulation } from './simulation';
import type { SectionResult } from './sails/common';

const KN = 0.514444;

type Phase = 'turn' | 'settle' | 'prep' | 'cross';

interface Entry { helmMode: HelmMode; helmTarget: number; speed: number; tiller: number }

const mean = (xs: readonly SectionResult[], f: (s: SectionResult) => number): number =>
  xs.length ? xs.reduce((a, s) => a + f(s), 0) / xs.length : 0;

/** First-order low-pass (τ = 1 s). */
const smooth = (prev: number | null, x: number, dt: number): number => (prev === null ? x : prev + (x - prev) * Math.min(1, dt / 1.0));

/** Sheet speed (per s) from an angle-of-attack error (rad): dead-band ±0.75°, gentle gain, rate-limited. */
const trimRate = (err: number): number => {
  const dead = 0.75 * DEG;
  if (Math.abs(err) < dead) return 0;
  return clamp((err - Math.sign(err) * dead) * 1.2, -0.4, 0.4);
};

export class AutoCrew implements CrewHook {
  maneuver: SimSnapshot['maneuver'] = null;
  /** Why the last command was refused (for the UI), cleared on the next successful one. */
  refused: string | null = null;
  private phase: Phase = 'turn';
  private t = 0;
  private holdT = 0;
  private stuckT = 0;
  private targetTwa = 0;
  private entry: Entry = { helmMode: 'manual', helmTarget: 0, speed: 0, tiller: 0 };
  private hoistPrev: boolean | null = null;
  /** Smoothed angle-of-attack readings (a trimmer doesn't chase every flicker of a telltale). */
  private aoaMain: number | null = null;
  private aoaJib: number | null = null;
  private aoaSpin: number | null = null;

  update(dt: number, sim: Simulation): void {
    const c = sim.controls;
    if (this.hoistPrev === null) this.hoistPrev = c.spinHoist;

    if (c.command) {
      const cmd = c.command;
      c.command = null;
      if (this.maneuver !== 'tack' && this.maneuver !== 'gybe') this.start(cmd, sim);
    }

    // Hoist / douse: label the manoeuvre while the sail goes up or down.
    if (c.spinHoist !== this.hoistPrev) {
      this.hoistPrev = c.spinHoist;
      if (this.maneuver !== 'tack' && this.maneuver !== 'gybe') this.maneuver = c.spinHoist ? 'hoist' : 'douse';
    }
    if ((this.maneuver === 'hoist' && sim.spin.hoist >= 1) || (this.maneuver === 'douse' && sim.spin.hoist <= 0)) this.maneuver = null;

    // With the jib on auto, the crew rolls it away under the spinnaker and back out after the drop.
    if (c.autoTrim.jib) c.jibFurl = c.spinHoist && sim.spin.hoist > 0.3 ? 1 : 0;

    if (this.maneuver === 'tack' || this.maneuver === 'gybe') this.runManeuver(dt, sim);
    this.trim(dt, sim);
  }

  private start(cmd: 'tack' | 'gybe', sim: Simulation): void {
    const c = sim.controls;
    const twaAbs = Math.abs(sim.twa);
    if (cmd === 'tack' && twaAbs > 80 * DEG) { this.refused = 'Too far off the wind to tack — head up first (or gybe).'; return; }
    if (cmd === 'tack' && sim.speed < 1.0) { this.refused = 'Not enough speed to tack — bear away and build speed first.'; return; }
    if (cmd === 'gybe' && twaAbs < 100 * DEG) { this.refused = 'Too close to the wind to gybe — bear away first (or tack).'; return; }
    this.refused = null;
    this.entry = { helmMode: c.helmMode, helmTarget: c.helmTarget, speed: sim.speed, tiller: c.tiller };
    this.maneuver = cmd;
    this.t = 0;
    this.holdT = 0;
    this.stuckT = 0;
    const side = Math.sign(sim.twa) || 1;
    if (cmd === 'tack') {
      this.targetTwa = -side * clamp(twaAbs, 38 * DEG, 80 * DEG);
      this.phase = 'turn';
    } else {
      this.targetTwa = -side * clamp(twaAbs, 120 * DEG, 172 * DEG);
      this.phase = 'prep';
    }
  }

  private finish(sim: Simulation, event: 'tackComplete' | 'gybeComplete'): void {
    const c = sim.controls;
    sim.rudderOverride = null;
    sim.events.emit(event, sim.t, { entrySpeed: this.entry.speed, exitSpeed: sim.speed });
    this.maneuver = null;
    if (this.entry.helmMode === 'manual') {
      c.helmMode = 'manual';
      c.tiller = 0;
    } else if (this.entry.helmMode === 'heading') {
      c.helmMode = 'heading';
      c.helmTarget = sim.boat.psi;
    } else {
      c.helmMode = 'twa';
      c.helmTarget = this.targetTwa;
    }
  }

  private runManeuver(dt: number, sim: Simulation): void {
    const c = sim.controls;
    this.t += dt;
    const twa = sim.twa;
    const side0 = -Math.sign(this.targetTwa); // tack we started on

    if (this.maneuver === 'tack') {
      if (this.phase === 'turn') {
        // Steer smartly through the wind; the jib sheet is released and hauled as the bow passes through.
        sim.rudderOverride = side0 * 22 * DEG;
        if (Math.sign(twa) === -side0 && Math.abs(twa) > 12 * DEG) {
          this.phase = 'settle';
          sim.rudderOverride = null;
          c.helmMode = 'twa';
          c.helmTarget = this.targetTwa;
        }
        // Stalled head-to-wind: in irons. Give up and let the learner recover.
        this.stuckT = sim.speed < 0.3 && Math.abs(twa) < 25 * DEG ? this.stuckT + dt : 0;
        if (this.stuckT > 6) { sim.rudderOverride = null; this.maneuver = null; c.helmMode = this.entry.helmMode === 'manual' ? 'manual' : c.helmMode; }
      } else {
        this.holdT = Math.abs(twa - this.targetTwa) < 5 * DEG ? this.holdT + dt : 0;
        if (this.holdT > 1.5 || this.t > 25) this.finish(sim, 'tackComplete');
      }
      return;
    }

    // Gybe: bear away to a deep run with the main hauled in, turn the stern through the wind, ease out.
    if (this.phase === 'prep') {
      c.helmMode = 'twa';
      c.helmTarget = side0 * 168 * DEG;
      sim.rudderOverride = null;
      c.mainSheet = Math.min(1, c.mainSheet + 0.45 * dt);
      if (Math.abs(twa) > 160 * DEG && c.mainSheet > 0.8) this.phase = 'cross';
      if (this.t > 20) this.phase = 'cross';
    } else if (this.phase === 'cross') {
      sim.rudderOverride = -side0 * 9 * DEG;
      c.mainSheet = Math.max(c.mainSheet, 0.85);
      if (Math.sign(twa) === -side0 && Math.abs(twa) < 172 * DEG) {
        this.phase = 'settle';
        sim.rudderOverride = null;
        c.helmMode = 'twa';
        c.helmTarget = this.targetTwa;
      }
    } else {
      this.holdT = Math.abs(twa - this.targetTwa) < 8 * DEG ? this.holdT + dt : 0;
      if (this.holdT > 1.5 || this.t > 35) this.finish(sim, 'gybeComplete');
    }
  }

  private trim(dt: number, sim: Simulation): void {
    const c = sim.controls;
    const awaAbs = Math.abs(sim.awa);
    const heelDeg = Math.abs(sim.boat.phi) / DEG;
    const twsKn = sim.tws / KN;
    const upwind = 1 - smoothstep(35 * DEG, 60 * DEG, awaAbs);
    const gybing = this.maneuver === 'gybe';
    const tacking = this.maneuver === 'tack';

    if (c.autoTrim.main && sim.main.last && !gybing) {
      const mid = sim.main.last.sections.slice(2, 6);
      const cam = mean(mid, (s) => s.camber);
      const dr = mean(mid, (s) => s.draft);
      const aL = alphaLuff(MAIN_AERO, cam, dr);
      const aS = alphaStall(MAIN_AERO, cam, dr);
      let target = lerp(aS - 1.5 * DEG, aL + 0.85 * (aS - aL), upwind);
      // Depower when over-pressed: ease toward the luffing edge as heel builds.
      target -= smoothstep(18, 30, heelDeg) * Math.max(target - aL + DEG, 0);
      this.aoaMain = smooth(this.aoaMain, mean(mid, (s) => s.aoa), dt);
      c.mainSheet = clamp(c.mainSheet + trimRate(target - this.aoaMain) * dt, 0, 1);
      c.traveler = upwind > 0.5 ? -0.8 * smoothstep(20, 30, heelDeg) : 0;
      // Upwind in light/moderate air keep the leech firm (little twist); open it as the breeze builds.
      c.vang = upwind > 0.5 ? lerp(0.55, 0.3, smoothstep(10, 18, twsKn)) : 0.55;
      const flat = upwind * smoothstep(14, 22, twsKn);
      c.outhaul = 0.3 + 0.7 * flat;
      c.backstay = 0.2 + 0.8 * flat;
      c.cunningham = 0.1 + 0.6 * flat;
    }

    if (c.autoTrim.jib && sim.jib.last && sim.jib.furl < 0.97 && !tacking && !gybing) {
      const mid = sim.jib.last.sections.slice(2, 6);
      const cam = mean(mid, (s) => s.camber);
      const dr = mean(mid, (s) => s.draft);
      const aL = alphaLuff(JIB_AERO, cam, dr);
      const aS = alphaStall(JIB_AERO, cam, dr);
      this.aoaJib = smooth(this.aoaJib, mean(mid, (s) => s.aoa), dt);
      c.jibSheet = clamp(c.jibSheet + trimRate(aL + 0.75 * (aS - aL) - this.aoaJib) * dt, 0, 1);
      // Lead forward upwind (tight leech, full foot); aft when reaching or depowering (open leech).
      c.jibLead = upwind > 0.5 ? 0.6 - 1.2 * smoothstep(18, 28, heelDeg) : -0.3;
    }

    if (c.autoTrim.spinnaker && sim.spin.hoist > 0.5) {
      c.spinPole = clamp((awaAbs / DEG - 90) / 90 + 0.05, 0, 1);
      c.spinPoleHeight = 0.4;
      this.aoaSpin = smooth(this.aoaSpin, sim.spin.alphaTrim, dt);
      c.spinSheet = clamp(c.spinSheet + trimRate(ALPHA_CURL + 2.5 * DEG - this.aoaSpin) * dt, 0, 1);
    }
  }
}
