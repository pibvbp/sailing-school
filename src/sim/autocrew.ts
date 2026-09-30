// The "crew" (spec §7.7): auto-trim for each sail, crew-driven manoeuvres (tack, gybe, hoist, douse).
// Auto-trim reads the same thing a real trimmer reads — the sail's angle of attack as shown by its
// telltales / luff curl — and eases or trims the sheet toward the groove.
import { DEG, KN, clamp, lerp, smoothstep } from '../shared/math';
import type { HelmMode, SimSnapshot } from './types';
import { MAIN_AERO, JIB_AERO, alphaLuff, alphaStall } from './aero';
import { ALPHA_CURL } from './sails/spinnaker';
import type { CrewHook, Simulation } from './simulation';
import type { SectionResult, Side } from './sails/common';

type Phase = 'turn' | 'settle' | 'prep' | 'cross';

/** Longest each manoeuvre phase may take (s) before the crew ends it cleanly and hands everything back (I6). */
export const PHASE_TIMEOUT: Readonly<Record<Phase, number>> = { prep: 15, turn: 15, cross: 15, settle: 10 };
/** Moving the tiller this far from where it was when the manoeuvre began takes the helm: 20 % of its −1…+1 travel. */
export const HELM_TAKEOVER = 0.4;

interface Entry { helmMode: HelmMode; helmTarget: number; speed: number; tiller: number }

const mean = (xs: readonly SectionResult[], f: (s: SectionResult) => number): number =>
  xs.length ? xs.reduce((a, s) => a + f(s), 0) / xs.length : 0;

/** First-order low-pass (τ = 1 s). A reading that is not a number is ignored. */
const smooth = (prev: number | null, x: number, dt: number): number | null => {
  if (!Number.isFinite(x)) return prev;
  return prev === null ? x : prev + (x - prev) * Math.min(1, dt / 1.0);
};

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
  /**
   * True once the learner has taken the helm during the current tack or gybe (tiller moved > 20 % of its travel,
   * or the helm mode changed): the crew then only works the sheets and never takes the helm back.
   */
  learnerHelm = false;
  private phase: Phase = 'turn';
  private t = 0;
  private phaseT = 0;
  private holdT = 0;
  private stuckT = 0;
  private targetTwa = 0;
  private entry: Entry = { helmMode: 'manual', helmTarget: 0, speed: 0, tiller: 0 };
  /** Mainsheet when the gybe began: where the crew lets it run back out to once the boom is across. */
  private entryMainSheet = 0;
  /** The helm mode the crew expects: the entry mode, or the one it set itself. Anything else is the learner's. */
  private crewMode: HelmMode = 'manual';
  private hoistPrev: boolean | null = null;
  /** A hoist is under way with the jib on auto: roll the jib away once the spinnaker is drawing. */
  private furlPending = false;
  /** Smoothed angle-of-attack readings (a trimmer doesn't chase every flicker of a telltale). */
  private aoaMain: number | null = null;
  private aoaJib: number | null = null;
  private aoaSpin: number | null = null;
  private awaPole: number | null = null;

  /** Forget the manoeuvre in progress and everything learned (the scenario was reset). */
  reset(): void {
    this.maneuver = null;
    this.refused = null;
    this.learnerHelm = false;
    this.phase = 'turn';
    this.t = this.phaseT = this.holdT = this.stuckT = 0;
    this.hoistPrev = null;
    this.furlPending = false;
    this.aoaMain = this.aoaJib = this.aoaSpin = this.awaPole = null;
  }

  update(dt: number, sim: Simulation): void {
    const c = sim.controls;
    if (this.hoistPrev === null) this.hoistPrev = c.spinHoist;

    if (c.command) {
      const cmd = c.command;
      c.command = null;
      if (this.maneuver !== 'tack' && this.maneuver !== 'gybe') this.start(cmd, sim);
    }

    // Hoist / douse: label the manoeuvre while the sail goes up or down. With the jib on auto the crew rolls it
    // away under the spinnaker and back out for the drop — only on those edges, so a learner's furl otherwise
    // stands (I7).
    if (c.spinHoist !== this.hoistPrev) {
      this.hoistPrev = c.spinHoist;
      if (this.maneuver !== 'tack' && this.maneuver !== 'gybe') this.maneuver = c.spinHoist ? 'hoist' : 'douse';
      this.furlPending = c.spinHoist && c.autoTrim.jib;
      if (!c.spinHoist && c.autoTrim.jib) c.jibFurl = 0;
    }
    if (this.furlPending && sim.spin.hoist > 0.3) {
      if (c.autoTrim.jib && c.spinHoist) c.jibFurl = 1;
      this.furlPending = false;
    }
    if ((this.maneuver === 'hoist' && sim.spin.hoist >= 1) || (this.maneuver === 'douse' && sim.spin.hoist <= 0)) this.maneuver = null;

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
    this.entryMainSheet = c.mainSheet;
    c.boomPush = 0; // whoever was holding the boom out lets go: the crew needs the main for the manoeuvre
    this.crewMode = c.helmMode;
    this.learnerHelm = false;
    this.maneuver = cmd;
    this.t = 0;
    this.holdT = 0;
    this.stuckT = 0;
    const side = Math.sign(sim.twa) || 1;
    if (cmd === 'tack') {
      this.targetTwa = -side * clamp(twaAbs, 38 * DEG, 80 * DEG);
      this.enter('turn');
    } else {
      this.targetTwa = -side * clamp(twaAbs, 120 * DEG, 172 * DEG);
      this.enter('prep');
    }
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.phaseT = 0;
    this.holdT = 0;
  }

  /** The crew steers with the autopilot: set its mode and target (only while the crew has the helm). */
  private setHelm(sim: Simulation, mode: HelmMode, target: number): void {
    if (this.learnerHelm) return;
    sim.controls.helmMode = mode;
    sim.controls.helmTarget = target;
    this.crewMode = mode;
  }

  /** Put the helm back the way the learner had it before the manoeuvre (unless they have taken it themselves). */
  private restoreHelm(sim: Simulation, settled: boolean): void {
    sim.rudderOverride = null;
    if (this.learnerHelm) return;
    const c = sim.controls;
    const e = this.entry;
    if (e.helmMode === 'manual') {
      c.helmMode = 'manual';
      c.tiller = 0;
    } else if (!settled) {
      c.helmMode = e.helmMode;
      c.helmTarget = e.helmTarget;
    } else if (e.helmMode === 'heading') {
      c.helmMode = 'heading';
      c.helmTarget = sim.boat.psi;
    } else {
      c.helmMode = 'twa';
      c.helmTarget = this.targetTwa;
    }
  }

  private finish(sim: Simulation, event: 'tackComplete' | 'gybeComplete'): void {
    sim.events.emit(event, sim.t, { entrySpeed: this.entry.speed, exitSpeed: sim.speed });
    this.maneuver = null;
    this.restoreHelm(sim, true);
  }

  /** The manoeuvre did not happen (in irons, timed out before the boat got round): hand everything back. */
  private abort(sim: Simulation): void {
    this.maneuver = null;
    this.restoreHelm(sim, false);
  }

  /** The learner moved the tiller or changed the helm mode: the crew lets go of the helm at once (I6). */
  private checkHandover(sim: Simulation): void {
    if (this.learnerHelm) return;
    const c = sim.controls;
    const byMode = c.helmMode !== this.crewMode;
    // Only steering counts: the tiller pushed further out, or across to the other side. A tiller springing
    // back toward the centre (the keyboard tiller self-centres when its key is released) is not a takeover.
    const t = c.tiller, t0 = this.entry.tiller;
    const byTiller = Math.abs(t) > Math.abs(t0) + HELM_TAKEOVER
      || (Math.sign(t) !== Math.sign(t0) && Math.abs(t) > HELM_TAKEOVER);
    if (!byMode && !byTiller) return;
    this.learnerHelm = true;
    sim.rudderOverride = null;
    // A tiller movement means hand steering: drop any autopilot mode the crew had engaged for the manoeuvre.
    if (!byMode && c.helmMode !== 'manual') c.helmMode = 'manual';
  }

  private runManeuver(dt: number, sim: Simulation): void {
    const c = sim.controls;
    this.t += dt;
    this.phaseT += dt;
    this.checkHandover(sim);
    const twa = sim.twa;
    const side0 = -Math.sign(this.targetTwa) as Side; // tack we started on
    const onNewSide = Math.sign(twa) === -side0;
    // With the learner steering, "settled" means on the new side and no longer turning.
    const steady = onNewSide && Math.abs(sim.boat.r) < 3 * DEG;

    if (this.maneuver === 'tack') {
      if (this.phase === 'turn') {
        // Steer smartly through the wind; the jib sheet is released and hauled as the bow passes through.
        if (!this.learnerHelm) sim.rudderOverride = side0 * 22 * DEG;
        if (onNewSide && Math.abs(twa) > 12 * DEG) {
          sim.rudderOverride = null;
          this.setHelm(sim, 'twa', this.targetTwa);
          this.enter('settle');
          return;
        }
        // Stalled head-to-wind: in irons. Give up and let the learner recover.
        this.stuckT = sim.speed < 0.3 && Math.abs(twa) < 25 * DEG ? this.stuckT + dt : 0;
        if (this.stuckT > 6 || this.phaseT > PHASE_TIMEOUT.turn) this.abort(sim);
      } else {
        const settled = this.learnerHelm ? steady : Math.abs(twa - this.targetTwa) < 5 * DEG;
        this.holdT = settled ? this.holdT + dt : 0;
        if (this.holdT > 1.5) this.finish(sim, 'tackComplete');
        // Timed out: a tack if the boat is on the new side, otherwise it fell back — hand back without claiming one.
        else if (this.phaseT > PHASE_TIMEOUT.settle) { if (onNewSide) this.finish(sim, 'tackComplete'); else this.abort(sim); }
      }
      return;
    }

    // Gybe: bear away to a deep run with the main hauled in, turn the stern through the wind, ease out.
    if (this.phase === 'prep') {
      sim.rudderOverride = null;
      this.setHelm(sim, 'twa', side0 * 176 * DEG);
      // Haul the main in as the stern comes toward the wind — hauled on a broad reach it would lay the boat over.
      c.mainSheet = Math.max(c.mainSheet, smoothstep(166 * DEG, 174 * DEG, Math.abs(twa)));
      const mainIn = sim.main.sheet > 0.8;
      if ((Math.abs(twa) > 170 * DEG && mainIn) || this.phaseT > PHASE_TIMEOUT.prep) this.enter('cross');
    } else if (this.phase === 'cross') {
      if (!this.learnerHelm) sim.rudderOverride = -side0 * 9 * DEG;
      c.mainSheet = Math.max(c.mainSheet, 0.85);
      // The stern has passed through the wind: gybe the rig — jib across, traveler over, pole end-for-end.
      if (onNewSide && sim.side === side0 && Math.abs(sim.awa) > 150 * DEG) sim.gybeRig(-side0 as Side);
      if (onNewSide && Math.abs(twa) < 172 * DEG) {
        sim.rudderOverride = null;
        this.setHelm(sim, 'twa', this.targetTwa);
        this.enter('settle');
      } else if (this.phaseT > PHASE_TIMEOUT.cross) this.abort(sim);
    } else {
      // Boom across: let the main run straight back out to where it was before the gybe.
      c.mainSheet = Math.min(c.mainSheet, this.entryMainSheet);
      const settled = this.learnerHelm ? steady : Math.abs(twa - this.targetTwa) < 8 * DEG;
      this.holdT = settled ? this.holdT + dt : 0;
      if (this.holdT > 1.5) this.finish(sim, 'gybeComplete');
      else if (this.phaseT > PHASE_TIMEOUT.settle) { if (onNewSide) this.finish(sim, 'gybeComplete'); else this.abort(sim); }
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

    // Main auto-trim pauses while someone holds the boom out by hand: the trimmer must not fight them.
    if (c.autoTrim.main && sim.main.last && !gybing && !(c.boomPush ?? 0)) {
      const mid = sim.main.last.sections.slice(2, 6);
      const cam = mean(mid, (s) => s.camber);
      const dr = mean(mid, (s) => s.draft);
      const aL = alphaLuff(MAIN_AERO, cam, dr);
      const aS = alphaStall(MAIN_AERO, cam, dr);
      let target = lerp(aS - 1.5 * DEG, aL + 0.85 * (aS - aL), upwind);
      // Depower when over-pressed: ease toward the luffing edge as heel builds.
      target -= smoothstep(18, 30, heelDeg) * Math.max(target - aL + DEG, 0);
      this.aoaMain = smooth(this.aoaMain, mean(mid, (s) => s.aoa), dt);
      // While the bow swings through the wind the main luffs by design: leave the sheet alone, and centre the
      // traveler car so it has nothing to cross (I2). Normal trimming resumes once the boat is on the new tack.
      const turning = tacking && this.phase === 'turn';
      if (this.aoaMain !== null && !turning) c.mainSheet = clamp(c.mainSheet + trimRate(target - this.aoaMain) * dt, 0, 1);
      c.traveler = turning ? 0 : upwind > 0.5 ? -0.8 * smoothstep(20, 30, heelDeg) : 0;
      // Upwind in light/moderate air keep the leech firm (little twist); open it as the breeze builds.
      c.vang = upwind > 0.5 ? lerp(0.55, 0.3, smoothstep(10, 18, twsKn)) : 0.55;
      const flat = upwind * smoothstep(14, 22, twsKn);
      c.outhaul = 0.3 + 0.7 * flat;
      c.backstay = 0.2 + 0.8 * flat;
      c.cunningham = 0.1 + 0.6 * flat;
    }

    // Jib auto-trim pauses while the crew holds the clew (backed, or out on the whisker pole): the sheet is not
    // what sets it then (I4).
    const jibHeld = c.jibBacked || c.jibWhisker;
    if (c.autoTrim.jib && sim.jib.last && sim.jib.furl < 0.97 && !tacking && !gybing && !jibHeld) {
      const mid = sim.jib.last.sections.slice(2, 6);
      const cam = mean(mid, (s) => s.camber);
      const dr = mean(mid, (s) => s.draft);
      const aL = alphaLuff(JIB_AERO, cam, dr);
      const aS = alphaStall(JIB_AERO, cam, dr);
      this.aoaJib = smooth(this.aoaJib, mean(mid, (s) => s.aoa), dt);
      if (this.aoaJib !== null) c.jibSheet = clamp(c.jibSheet + trimRate(aL + 0.75 * (aS - aL) - this.aoaJib) * dt, 0, 1);
      // Lead forward upwind (tight leech, full foot); aft when reaching or depowering (open leech).
      c.jibLead = upwind > 0.5 ? 0.6 - 1.2 * smoothstep(18, 28, heelDeg) : -0.3;
    }

    if (c.autoTrim.spinnaker && sim.spin.hoist > 0.5) {
      // Pole ⟂ apparent wind — set from a smoothed reading like every other trim, not chasing each yaw.
      this.awaPole = smooth(this.awaPole, awaAbs, dt);
      c.spinPole = clamp(((this.awaPole ?? awaAbs) / DEG - 90) / 90 + 0.05, 0, 1);
      c.spinPoleHeight = 0.4;
      this.aoaSpin = smooth(this.aoaSpin, sim.spin.alphaTrim, dt);
      if (this.aoaSpin !== null) c.spinSheet = clamp(c.spinSheet + trimRate(ALPHA_CURL + 2.5 * DEG - this.aoaSpin) * dt, 0, 1);
    }
  }
}
