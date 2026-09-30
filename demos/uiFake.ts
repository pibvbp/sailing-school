// UI demo only: a kinematic stand-in for the simulation (smooth, plausible values for every instrument,
// sail readout and telltale), a polar model shaped like the spec §7.8 targets, and demo lessons.
// NOT physics — the real sim (Tasks 3–9) replaces all of this.
import {
  defaultControls, type Controls, type JibState, type MainState, type SailSection, type ScenarioInit,
  type SimEvent, type SimEventType, type SimSnapshot, type SpinnakerState, type Telltale, type WindSettings,
} from '../src/sim/types';
import { BOAT } from '../src/shared/boatSpec';
import { DEG, KN, angleDiff, clamp, interpTable, lerp, smoothstep, wrapPi } from '../src/shared/math';
import type { PolarModel } from '../src/ui/polarChart';
import type { Lesson } from '../src/lessons/types';

// ---- polar (knots in, knots out; wrapped to SI for the UI) ------------------------------------------

const BEAT: readonly (readonly [number, number])[] = [[4, 3.3], [6, 4.3], [8, 4.9], [12, 5.6], [16, 5.8], [20, 5.9], [25, 5.9]];
const BEAM: readonly (readonly [number, number])[] = [[4, 3.9], [6, 5.0], [8, 5.7], [12, 6.5], [16, 6.85], [20, 7.0], [25, 7.2]];
const RUN150: readonly (readonly [number, number])[] = [[4, 3.0], [6, 4.3], [8, 5.1], [12, 6.4], [16, 7.2], [20, 7.9], [25, 8.4]];

function polarKn(twsKn: number, twaDeg: number): number {
  const beat = interpTable(BEAT, twsKn);
  const beam = interpTable(BEAM, twsKn);
  const run = interpTable(RUN150, twsKn);
  const knots: [number, number][] = [
    [26, 0], [34, beat * 0.72], [42, beat], [52, beat + 0.45 * (beam - beat)], [70, beam * 0.97], [90, beam],
    [110, beam * 1.01], [130, 0.5 * (beam + run)], [150, run], [165, run * 0.95], [180, run * 0.88],
  ];
  return interpTable(knots, twaDeg);
}

export const demoPolar: PolarModel = {
  speed: (tws, twa) => polarKn(tws / KN, Math.abs(twa) / DEG) * KN,
};

// ---- fake simulation ------------------------------------------------------------------------------

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });

function sections(n: number): SailSection[] {
  return Array.from({ length: n }, (_, i) => ({
    h: (i + 0.5) / n, luff: v3(), chordDir: v3(-1, 0, 0), chord: 2, camber: 0.1, draft: 0.45, leewardY: 1,
    aoa: 0, luffing: 0, stall: 0, cl: 0, cd: 0, q: 0,
  }));
}

function sail<T extends 'main' | 'jib' | 'spinnaker'>(id: T, n: number, area: number) {
  return { id, set: id !== 'spinnaker', area, tack: v3(), clew: v3(), head: v3(), sections: sections(n), force: v3(), ce: v3(), lift: 0, drag: 0, drive: 0, heelForce: 0, telltales: [] as Telltale[] };
}

function makeTelltales(): { jib: Telltale[]; main: Telltale[] } {
  const jib: Telltale[] = [];
  const { tack, head } = BOAT.jib;
  for (const f of [0.25, 0.5, 0.75]) {
    const x = lerp(tack.x, head.x, f) - 0.45;
    const hgt = lerp(tack.h, head.h, f);
    for (const side of ['port', 'stbd'] as const) jib.push({ id: `jib-${side}-${f}`, pos: v3(x, side === 'port' ? -0.05 : 0.05, -hgt), side, state: 'streaming', intensity: 0 });
  }
  const main: Telltale[] = [];
  for (let i = 1; i <= 4; i++) main.push({ id: `leech-${i}`, pos: v3(-2, 0, -(BOAT.boom.gooseneck.h + (BOAT.main.P * i) / 5)), side: 'leech', state: 'streaming', intensity: 0 });
  return { jib, main };
}

export class FakeSim {
  readonly snap: SimSnapshot;
  wind: WindSettings;
  private t = 0;
  private heading = Math.PI;
  private speed = 5.6 * KN;
  private r = 0;
  private rudder = 0;
  private e = 0;
  private n = 0;
  private hoist = 0;
  private collapsed = 0;
  private collapseTimer = 0;
  private maneuver: null | 'tack' | 'gybe' = null;
  private maneuverTarget = 0;
  private maneuverTurn = 1;
  private ironsTimer = 0;
  private ironsFired = false;
  private luffTimer = 0;
  private roundUpArmed = true;
  private lastTwa = 0;
  private events: SimEvent[] = [];

  constructor() {
    this.wind = { tws: 12 * KN, twd: 225 * DEG, gustiness: 0.35, shiftAmplitude: 4 * DEG, shiftPeriod: 150, seed: 7 };
    const tt = makeTelltales();
    const main = sail('main', 8, BOAT.main.area);
    main.telltales = tt.main;
    const jib = sail('jib', 8, BOAT.jib.area);
    jib.telltales = tt.jib;
    const spin = sail('spinnaker', 6, BOAT.spinnaker.area);
    this.snap = {
      t: 0,
      boat: { pos: { x: 0, y: 0 }, heading: this.heading, heel: 0, yawRate: 0, rollRate: 0, u: this.speed, v: 0, speed: this.speed, cog: this.heading, leeway: 0, rudder: 0, vmg: 0, crewHike: 0 },
      wind: { tws: this.wind.tws, twd: this.wind.twd, twa: 0, aws: 0, awa: 0, awsDeck: 0, awaDeck: 0, puffs: [] },
      sails: {
        main: { ...main, boomAngle: 0, boomRate: 0, twistDeg: 8 } satisfies MainState,
        jib: { ...jib, clewAngle: 0, furl: 0, backed: false, whisker: false } satisfies JibState,
        spinnaker: { ...spin, hoist: 0, poleAngle: 0, poleTip: v3(), poleHeight: 0.5, collapsed: 0, curl: 0 } satisfies SpinnakerState,
      },
      forces: {
        aero: { force: v3(), point: v3() }, drive: 0, sideForce: 0, keel: { force: v3(), point: v3() }, rudder: { force: v3(), point: v3() },
        resistance: 0, heelingMoment: 0, rightingMoment: 0, crewMoment: 0, cg: v3(), cb: v3(),
      },
      events: this.events,
      maneuver: null,
      towed: false,
    };
    this.step(0.001, defaultControls());
  }

  setWind(p: Partial<WindSettings>): void {
    this.wind = { ...this.wind, ...p };
  }

  /** Start from a steady state: heading so that TWA = `twaDeg`, speed on the polar. */
  settle(twaDeg: number): void {
    this.heading = wrapPi(this.wind.twd - twaDeg * DEG);
    this.speed = demoPolar.speed(this.wind.tws, twaDeg * DEG);
    this.lastTwa = twaDeg * DEG;
  }

  reset(init: ScenarioInit): void {
    this.wind = { ...init.wind };
    this.t = 0;
    this.snap.t = 0;
    this.e = init.boat?.e ?? 0;
    this.n = init.boat?.n ?? 0;
    this.heading = init.boat?.psi ?? this.heading;
    this.speed = init.boat?.u ?? this.speed;
    this.r = 0;
    this.maneuver = null;
    this.hoist = init.spinnakerSet ? 1 : 0;
  }

  step(dt: number, c: Controls): void {
    this.events.length = 0;
    if (dt <= 0) return;
    this.t += dt;
    const t = this.t;
    const w = this.wind;

    // Wind: slow oscillating shift + smooth gust noise (seeded phases).
    const g = w.gustiness;
    const gust = g * (0.16 * Math.sin(t * 0.37 + w.seed) + 0.1 * Math.sin(t * 0.113 + 1.7 * w.seed) + 0.05 * Math.sin(t * 1.3));
    const tws = w.tws * (1 + gust);
    const twd = w.twd + w.shiftAmplitude * Math.sin((2 * Math.PI * t) / w.shiftPeriod) + g * 3 * DEG * Math.sin(t * 0.21 + 0.4);
    let twa = wrapPi(twd - this.heading);

    // Manoeuvre requests.
    if (c.command) {
      const cmd = c.command;
      c.command = null;
      if (!this.maneuver && this.speed > 1.5 * KN) {
        this.maneuver = cmd;
        const side = twa >= 0 ? -1 : 1;
        this.maneuverTarget = cmd === 'tack' ? side * Math.max(Math.abs(twa), 42 * DEG) : side * Math.max(Math.abs(twa), 150 * DEG);
        // Tack: turn toward the wind (bow through it); gybe: turn away (stern through it). TWA falls as heading rises.
        this.maneuverTurn = (cmd === 'tack' ? 1 : -1) * (twa >= 0 ? 1 : -1);
      }
    }

    // Helm → rudder (rate limited like the real rudder).
    let target: number;
    const maxR = BOAT.rudder.maxAngleDeg * DEG;
    if (this.maneuver) {
      const err = wrapPi(this.maneuverTarget - twa);
      target = Math.abs(err) > 25 * DEG ? this.maneuverTurn * 22 * DEG : clamp(-1.4 * err - 0.8 * this.r, -maxR, maxR);
      if (Math.abs(err) < 3 * DEG) {
        this.emit(this.maneuver === 'tack' ? 'tackComplete' : 'gybeComplete');
        this.maneuver = null;
      }
    } else if (c.helmMode === 'manual') {
      target = c.tiller * maxR;
    } else {
      const err = c.helmMode === 'heading' ? wrapPi(c.helmTarget - this.heading) : -wrapPi(c.helmTarget - (c.helmMode === 'awa' ? this.snap.wind.awa : twa));
      target = clamp(1.6 * err - 1.1 * this.r, -maxR, maxR);
    }
    const rate = BOAT.rudder.rateDegS * DEG * dt;
    this.rudder += clamp(target - this.rudder, -rate, rate);

    // Yaw: turn rate grows with speed (a moving boat steers), weather helm adds a little luff-up.
    const rTarget = 0.34 * Math.max(0.4, this.speed) * this.rudder;
    this.r += (rTarget - this.r) * (1 - Math.exp(-dt / 0.35));
    this.heading = wrapPi(this.heading + this.r * dt);
    twa = wrapPi(twd - this.heading);

    // Apparent wind (boat frame, from-direction vector).
    const ax = tws * Math.cos(twa) + this.speed;
    const ay = tws * Math.sin(twa);
    const aws = Math.hypot(ax, ay);
    const awa = Math.atan2(ay, ax);
    const absAwa = Math.abs(awa);
    const side = awa >= 0 ? 1 : -1;

    // Crew auto-trim writes its choices back into the controls (bumpless manual take-over).
    const idealMain = clamp(1.12 - absAwa / DEG / 120, 0.02, 1);
    const idealJib = clamp(1.15 - absAwa / DEG / 110, 0.02, 1);
    const idealSpin = clamp(1.25 - absAwa / DEG / 140, 0.05, 1);
    if (c.autoTrim.main) c.mainSheet += (idealMain - c.mainSheet) * Math.min(1, dt * 1.5);
    if (c.autoTrim.jib) c.jibSheet += (idealJib - c.jibSheet) * Math.min(1, dt * 1.5);
    if (c.autoTrim.spinnaker) {
      c.spinSheet += (idealSpin - 0.04 - c.spinSheet) * Math.min(1, dt * 1.5);
      c.spinPole += (clamp((absAwa / DEG - 60) / 100, 0.1, 1) - c.spinPole) * Math.min(1, dt);
    }

    // Luffing / stall from the sheet error (+ the no-go zone).
    const mainErr = c.mainSheet - idealMain;
    const jibErr = c.jibSheet - idealJib;
    const nogo = 1 - smoothstep(22 * DEG, 32 * DEG, absAwa);
    const luffOf = (err: number) => Math.max(nogo, clamp((-err - 0.07) * 5, 0, 1));
    const stallOf = (err: number) => clamp((err - 0.09) * 4, 0, 1) * (1 - nogo);
    const mainLuff = luffOf(mainErr), mainStall = stallOf(mainErr);
    const jibFurl = c.jibFurl;
    const jibLuff = jibFurl > 0.98 ? 0 : luffOf(jibErr), jibStall = jibFurl > 0.98 ? 0 : stallOf(jibErr);
    const eff = clamp(1 - 0.55 * (mainLuff + mainStall) - 0.35 * (jibLuff + jibStall) - 0.3 * jibFurl, 0.15, 1);

    // Spinnaker hoist / collapse.
    const wantUp = c.spinHoist;
    this.hoist = clamp(this.hoist + (wantUp ? dt / 6 : -dt / 5), 0, 1);
    const spinUp = this.hoist > 0.98;
    const spinBad = spinUp && (absAwa < 70 * DEG || c.spinSheet < idealSpin - 0.28);
    this.collapseTimer = spinBad ? this.collapseTimer + dt : 0;
    const wasCollapsed = this.collapsed > 0.5;
    this.collapsed = clamp(this.collapsed + (this.collapseTimer > 0.6 ? dt * 3 : -dt * 1.2), 0, 1);
    if (!wasCollapsed && this.collapsed > 0.5) this.emit('spinCollapse');
    if (wasCollapsed && this.collapsed <= 0.5) this.emit('spinRefill');

    // Speed toward the polar target.
    const absTwa = Math.abs(twa);
    let vTarget = demoPolar.speed(tws, absTwa) * eff;
    if (absTwa > 110 * DEG && !spinUp) vTarget *= 0.86;
    if (spinUp) vTarget *= 1 - 0.35 * this.collapsed;
    const tau = vTarget > this.speed ? 6 : 4;
    this.speed += (vTarget - this.speed) * (1 - Math.exp(-dt / tau));

    // Heel to leeward, leeway to leeward.
    const awsKn = aws / KN;
    const sideFactor = Math.pow(Math.max(0, Math.sin(absAwa)), 0.8) * (absAwa > 100 * DEG ? 0.55 : 1);
    const hike = c.crewHike === 'auto' ? 0.78 : 1 - 0.22 * Math.abs(c.crewHike);
    const heelMag = Math.min(34 * DEG, 0.42 * DEG * Math.pow(awsKn, 1.55) * sideFactor * (0.35 + 0.65 * eff) * hike);
    const heel = -side * heelMag;
    const leeway = -side * (1.5 + 4 * (heelMag / (20 * DEG))) * DEG * (absTwa < 100 * DEG ? 1 : 0.25) * Math.min(1, this.speed / (2 * KN));
    if (heelMag > 28 * DEG && this.roundUpArmed) { this.emit('roundUp'); this.roundUpArmed = false; }
    if (heelMag < 22 * DEG) this.roundUpArmed = true;

    // Events: in irons, luffing, accidental gybe.
    if (absTwa < 30 * DEG && this.speed < 0.5 * KN) {
      this.ironsTimer += dt;
      if (this.ironsTimer > 3 && !this.ironsFired) { this.emit('inIrons'); this.ironsFired = true; }
    } else { this.ironsTimer = 0; this.ironsFired = false; }
    this.luffTimer = mainLuff > 0.5 ? this.luffTimer + dt : 0;
    if (this.luffTimer > 2) { this.emit('luffing'); this.luffTimer = -8; }
    if (!this.maneuver && Math.abs(this.lastTwa) > 150 * DEG && Math.abs(twa) > 150 * DEG && Math.sign(this.lastTwa) !== Math.sign(twa) && c.mainSheet < 0.6) {
      this.emit('crashGybe');
    }
    this.lastTwa = twa;

    // Kinematics.
    const cog = wrapPi(this.heading + leeway);
    this.e += this.speed * Math.sin(cog) * dt;
    this.n += this.speed * Math.cos(cog) * dt;

    // ---- write the snapshot (in place, like a real sim would) ----
    const s = this.snap;
    s.t = t;
    const b = s.boat;
    b.pos.x = this.e; b.pos.y = this.n;
    b.heading = (this.heading + 2 * Math.PI) % (2 * Math.PI);
    b.heel = heel; b.yawRate = this.r; b.rollRate = 0;
    b.u = this.speed * Math.cos(leeway); b.v = this.speed * Math.sin(leeway); b.speed = this.speed;
    b.cog = (cog + 2 * Math.PI) % (2 * Math.PI); b.leeway = leeway; b.rudder = this.rudder;
    b.vmg = this.speed * Math.cos(twa);
    b.crewHike = c.crewHike === 'auto' ? clamp(side * heelMag / (8 * DEG), -1, 1) : c.crewHike;
    const sw = s.wind;
    sw.tws = tws; sw.twd = (twd + 2 * Math.PI) % (2 * Math.PI); sw.twa = twa; sw.aws = aws; sw.awa = awa;
    sw.awsDeck = aws * 0.8; sw.awaDeck = awa * 1.08;

    const main = s.sails.main;
    const boomAbs = Math.min(5 * DEG + 75 * DEG * Math.pow(1 - c.mainSheet, 1.2), Math.max(2 * DEG, absAwa - 3 * DEG), BOAT.boom.maxAngleDeg * DEG);
    main.boomAngle = side * boomAbs;
    main.twistDeg = 3 + 16 * Math.pow(1 - Math.max(c.vang, c.mainSheet * 0.9), 1.3);
    this.fillSections(main.sections, absAwa - boomAbs, mainLuff, mainStall, aws);
    const jib = s.sails.jib;
    jib.clewAngle = side * (10 * DEG + 35 * DEG * Math.pow(1 - c.jibSheet, 1.3));
    jib.furl = jibFurl; jib.set = jibFurl < 0.98; jib.backed = c.jibBacked; jib.whisker = c.jibWhisker;
    jib.area = BOAT.jib.area * (1 - jibFurl);
    this.fillSections(jib.sections, absAwa - Math.abs(jib.clewAngle) * 0.7, jibLuff, jibStall, aws);
    const spin = s.sails.spinnaker;
    spin.hoist = this.hoist; spin.set = this.hoist > 0.02; spin.collapsed = this.collapsed;
    spin.poleAngle = c.spinPole * 90 * DEG; spin.poleHeight = c.spinPoleHeight;
    spin.curl = spinUp ? clamp(1 - Math.abs(c.spinSheet - (idealSpin - 0.04)) * 5, 0, 1) * (1 - this.collapsed) : 0;
    this.fillSections(spin.sections, absAwa - spin.poleAngle, spinUp ? this.collapsed : 0, spinUp ? clamp((c.spinSheet - idealSpin) * 3, 0, 1) : 0, aws);

    // Telltales: windward jib telltales lift when luffing, leeward ones stall when over-trimmed.
    const windward: Telltale['side'] = side > 0 ? 'stbd' : 'port';
    for (const tt of jib.telltales) {
      const h = -tt.pos.z / 10;
      const isWindward = tt.side === windward;
      const lift = jibLuff + 0.12 * Math.sin(t * 0.9 + h * 6) * g - 0.05 + h * 0.1;
      const stall = jibStall + 0.1 * Math.sin(t * 0.7 + h * 4) * g - h * 0.05;
      if (jibFurl > 0.98) { tt.state = 'fluttering'; tt.intensity = 1; }
      else if (isWindward) { tt.state = lift > 0.25 ? 'lifting' : 'streaming'; tt.intensity = clamp(lift, 0, 1); }
      else { tt.state = stall > 0.2 ? 'stalled' : 'streaming'; tt.intensity = clamp(stall, 0, 1); }
    }
    main.telltales.forEach((tt, i) => {
      // Top leech telltale streams about half the time at good trim; over-trimmed sheets stall the upper ones.
      const top = i === main.telltales.length - 1;
      const wobble = Math.sin(t * 0.8 + i * 1.7);
      const stalled = mainErr > 0.05 && i >= 2 ? true : top ? wobble > 0 : mainStall > 0.3;
      tt.state = mainLuff > 0.5 ? 'fluttering' : stalled ? 'stalled' : 'streaming';
      tt.intensity = stalled ? 0.8 : 0.2;
    });

    s.forces.drive = 0.5 * 1.225 * aws * aws * 28 * 0.35 * eff;
    s.forces.heelingMoment = heelMag * 9000;
    s.forces.rightingMoment = heelMag * 9000;
    s.maneuver = this.maneuver ?? (this.hoist > 0.02 && this.hoist < 0.98 ? (wantUp ? 'hoist' : 'douse') : null);
  }

  private fillSections(secs: SailSection[], aoaBase: number, luff: number, stall: number, aws: number): void {
    const q = 0.5 * 1.225 * aws * aws;
    secs.forEach((sec, i) => {
      const h = (i + 0.5) / secs.length;
      sec.aoa = Math.max(0, aoaBase - 4 * DEG * h + (stall - luff) * 8 * DEG);
      sec.luffing = clamp(luff + (h - 0.5) * 0.15, 0, 1);
      sec.stall = clamp(stall - (h - 0.5) * 0.15, 0, 1);
      sec.cl = 1.2 * (1 - sec.luffing) * (1 - 0.4 * sec.stall);
      sec.cd = 0.05 + 0.2 * sec.stall + 0.1 * sec.luffing;
      sec.q = q;
    });
  }

  private emit(type: SimEventType): void {
    this.events.push({ type, t: this.t });
  }
}

// ---- demo lessons (the real curriculum is Task 18) ------------------------------------------------

const twaDeg = (s: SimSnapshot) => Math.abs(s.wind.twa) / DEG;
const kn = (ms: number) => ms / KN;

function stub(id: string, module: string, title: string, summary: string): Lesson {
  return { id, module, title, summary, setup: () => {}, steps: [{ title, body: `<p>${summary}</p>` }] };
}

const WIND12: WindSettings = { tws: 12 * KN, twd: 225 * DEG, gustiness: 0.35, shiftAmplitude: 4 * DEG, shiftPeriod: 150, seed: 7 };

export const demoLessons: Lesson[] = [
  {
    id: 'meet-the-boat',
    module: 'Getting started',
    title: 'Meet the boat',
    summary: 'The parts of a Kestrel 25, port and starboard, and how the tiller steers.',
    setup: (c) => c.app.scenario({ wind: WIND12, boat: { psi: 180 * DEG, u: 5 * KN } }),
    steps: [
      {
        title: 'Welcome aboard',
        body: '<p>This is a Kestrel 25: a 7.6 m keelboat with a <strong>[[mainsail]]</strong> behind the mast and a <strong>[[jib]]</strong> in front of it. The front is the [[bow]], the back the [[stern]].</p><p>Facing forward, left is <span class="port">[[port]]</span> and right is <span class="stbd">[[starboard]]</span> — every telltale and instrument uses those colours.</p>',
        camera: 'chase',
        overlays: { labels: true },
      },
      {
        title: 'Steer to a heading',
        body: '<p>You steer with the [[tiller]]. Push it one way and the bow turns the <em>other</em> way — watch the little diagram in the Helm panel.</p><p>Hold <kbd>←</kbd> or <kbd>→</kbd> and let go to centre the tiller.</p>',
        controls: ['helm'],
        task: {
          label: 'Steer to a heading of 200° (±10°)',
          holdSeconds: 3,
          check: (c) => Math.abs(angleDiff(c.snap.boat.heading, 200 * DEG)) < 10 * DEG,
        },
        hint: (c) => {
          const d = angleDiff(200 * DEG, c.snap.boat.heading) / DEG;
          if (Math.abs(d) < 10) return 'Right on it — keep the tiller centred.';
          return d > 0 ? `You are ${Math.round(d)}° to port of the target: press → to turn the bow to starboard.` : `You are ${Math.round(-d)}° to starboard of the target: press ← to turn the bow to port.`;
        },
        showMe: (c) => { c.app.controls.helmMode = 'heading'; c.app.controls.helmTarget = 200 * DEG; },
        onExit: (c) => { c.app.controls.helmMode = 'manual'; },
      },
    ],
  },
  {
    id: 'finding-the-wind',
    module: 'Getting started',
    title: 'Finding the wind',
    summary: 'Read the water, the windex and the telltales; head to wind; the no-go zone.',
    setup: (c) => c.app.scenario({ wind: WIND12 }),
    steps: [
      {
        title: 'Point into the wind',
        body: '<p>Turn until the bow points straight into the [[true-wind|true wind]] — the blue mark on the wind instrument sits at the top. The sails will flap: you are in the [[no-go-zone]].</p>',
        controls: ['helm'],
        task: { label: 'Point into the wind: TWA under 10°', holdSeconds: 3, check: (c) => twaDeg(c.snap) < 10 },
        hint: (c) => (twaDeg(c.snap) > 30 ? 'Head up: turn the bow toward the blue true-wind mark.' : null),
      },
      {
        title: 'Bear away until the sails fill',
        body: '<p>Now [[bearing-away|bear away]] until the sails stop flapping and the boat picks up speed.</p>',
        controls: ['helm'],
        task: { label: 'Reach 3 knots with TWA above 45°', check: (c) => (twaDeg(c.snap) > 45 ? clamp(kn(c.snap.boat.speed) / 3, 0, 1) : 0) },
      },
    ],
  },
  {
    id: 'points-of-sail',
    module: 'Getting started',
    title: 'Points of sail',
    summary: 'Close-hauled, beam reach, broad reach and run — and how fast each one is.',
    setup: (c) => c.app.scenario({ wind: WIND12 }),
    steps: [
      {
        title: 'Close-hauled',
        body: '<p>Sailing as close to the wind as the boat can go is called [[close-hauled]]. Sheet the sails in hard and steer so the [[telltale|telltales]] on the jib both stream back.</p><p>Too close and you stall into the [[no-go-zone]]; too far off and you lose ground upwind.</p>',
        camera: 'chase',
        overlays: { wheel: true },
        controls: ['helm', 'manoeuvres'],
        autoTrim: { main: true, jib: true },
        task: { label: 'Sail close-hauled: TWA 38–50°', holdSeconds: 5, check: (c) => twaDeg(c.snap) >= 38 && twaDeg(c.snap) <= 50 },
        hint: (c) => (twaDeg(c.snap) < 38 ? 'Too close to the wind — bear away a little until the jib stops luffing.' : twaDeg(c.snap) > 50 ? 'Head up toward the wind until TWA reads about 45°.' : null),
        showMe: (c) => { c.app.controls.helmMode = 'twa'; c.app.controls.helmTarget = Math.sign(c.snap.wind.twa || 1) * 44 * DEG; },
      },
      {
        title: 'Beam reach',
        body: '<p>Bear away until the wind blows straight across the side of the boat: a [[beam-reach]]. The crew eases the sheets as you turn.</p>',
        controls: ['helm'],
        task: { label: 'Beam reach: TWA 80–100°', holdSeconds: 5, check: (c) => twaDeg(c.snap) >= 80 && twaDeg(c.snap) <= 100 },
      },
      {
        title: 'Broad reach',
        body: '<p>Keep bearing away onto a [[broad-reach]], wind over the back corner.</p>',
        controls: ['helm'],
        task: { label: 'Broad reach: TWA 120–150°', holdSeconds: 5, check: (c) => twaDeg(c.snap) >= 120 && twaDeg(c.snap) <= 150 },
      },
      {
        title: 'Run',
        body: '<p>Finally a [[run]]: wind from dead astern. Careful — too far and you sail [[by-the-lee]].</p>',
        controls: ['helm'],
        task: { label: 'Run: TWA over 165°', holdSeconds: 5, check: (c) => twaDeg(c.snap) > 165 },
      },
    ],
    quiz: [
      { q: 'Which point of sail is usually fastest for this boat without a spinnaker?', options: ['Close-hauled', 'Beam reach', 'Dead run'], correct: 1, why: 'On a beam reach the sails work as wings at a good angle and little of their force heels the boat.' },
      { q: 'What happens if you steer inside the no-go zone?', options: ['The boat speeds up', 'The sails flap and the boat slows to a stop', 'Nothing changes'], correct: 1, why: 'Pointing within about 40° of the wind the sails cannot make lift — they luff and the boat stops.' },
    ],
  },
  {
    id: 'apparent-wind',
    module: 'Getting started',
    title: 'Apparent wind',
    summary: 'Why the wind you feel moves forward and gets stronger as you speed up.',
    setup: (c) => c.app.scenario({ wind: WIND12 }),
    steps: [
      {
        title: 'The wind triangle',
        body: '<p>The sails feel the [[apparent-wind]]: the [[true-wind]] plus the wind made by the boat\'s own motion. On the instrument, the amber needle is apparent, the blue mark is true.</p>',
        overlays: { windTriangle: true },
      },
    ],
    quiz: [
      { q: 'Sailing upwind, the apparent wind is…', options: ['Weaker than the true wind', 'Stronger than the true wind', 'The same'], correct: 1, why: 'Your own speed adds to the wind coming over the bow.' },
      { q: 'As the boat speeds up, the apparent wind angle…', options: ['Moves forward', 'Moves aft', 'Does not change'], correct: 0, why: 'The boat-motion wind blows from dead ahead, so it pulls the apparent wind forward.' },
      { q: 'Which wind do the sails respond to?', options: ['True wind', 'Apparent wind'], correct: 1, why: 'Sails only feel the air moving past them — the apparent wind.' },
    ],
  },
  stub('sail-is-a-wing', 'How a sail works', 'A sail is a wing', 'Lift, drag, angle of attack, luffing and stall in the sail lab.'),
  stub('drive-and-heel', 'How a sail works', 'Drive and heel', 'The same sail force splits differently on each point of sail.'),
  {
    id: 'jib-and-telltales',
    module: 'How a sail works',
    title: 'Jib and telltales',
    summary: 'The groove: ease till the windward telltale lifts, trim till it streams.',
    setup: (c) => c.app.scenario({ wind: WIND12, controls: { autoTrim: { main: true, jib: false, spinnaker: true } } }),
    steps: [
      {
        title: 'Trim to the telltales',
        body: '<p>Ease the jib [[sheet]] (<kbd>↓</kbd>) until the <em>windward</em> [[telltale]] starts to lift, then trim (<kbd>↑</kbd>) until it just streams. That band is the [[groove]].</p>',
        controls: ['jib', 'helm'],
        autoTrim: { jib: false },
        task: {
          label: 'Both jib telltales streaming',
          holdSeconds: 15,
          check: (c) => c.snap.sails.jib.telltales.every((t) => t.state === 'streaming'),
        },
        hint: (c) => {
          const tts = c.snap.sails.jib.telltales;
          if (tts.some((t) => t.state === 'lifting')) return 'The windward telltale is lifting: trim the jib sheet in (↑) or bear away.';
          if (tts.some((t) => t.state === 'stalled')) return 'The leeward telltale has stalled: ease the jib sheet (↓) or head up.';
          return null;
        },
      },
    ],
  },
  stub('mainsail-trim', 'How a sail works', 'Mainsail trim and twist', 'Boom angle, traveler, leech telltales and twist.'),
  stub('main-and-jib', 'How a sail works', 'Main and jib together', 'Upwash, downwash and backwinding — why the "venturi" story is wrong.'),
  stub('keel-leeway-balance', 'Boat handling', 'Keel, leeway and balance', 'Keel lift, heeling vs righting moment and weather helm.'),
  stub('tacking', 'Boat handling', 'Tacking', 'The sequence and the calls; keeping momentum.'),
  stub('getting-out-of-irons', 'Boat handling', 'Getting out of irons', 'Back the jib, push the boom, reverse steering.'),
  stub('gybing', 'Boat handling', 'Gybing', 'Controlled versus accidental gybes.'),
  stub('running', 'Boat handling', 'Running and wing-on-wing', 'Blanketing, by-the-lee danger and the whisker pole.'),
  stub('spinnaker-hoist', 'Spinnaker', 'Spinnaker: hoist and trim', 'Pole square to the apparent wind; ease to the curl.'),
  stub('spinnaker-reaching', 'Spinnaker', 'Spinnaker: reaching to running', 'Pole and sheet through course changes.'),
  stub('spinnaker-gybe', 'Spinnaker', 'Spinnaker gybe and douse', 'Gybe with the kite up, then douse before heading up.'),
  stub('sailing-smart', 'Racing', 'Sailing smart', 'VMG and polars, laylines, gusts, lifts and headers.'),
];
