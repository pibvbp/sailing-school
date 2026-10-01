// Sail lab panel (spec §3.1): the boat is towed at a steady speed on a fixed heading — a wind tunnel on the
// water. The learner sets the apparent wind angle, the wind and the tow speed, trims with the normal trim
// panel, and reads each sail's lift, drag, Cl/Cd, drive and heeling force as they respond.
import { h, Slider, TextSlot, RateGate, fmtKn } from '../ui/dom';
import type { SailState, SimSnapshot } from '../sim/types';
import { RHO_AIR } from '../sim/sails/common';
import { DEG, KN } from '../shared/math';

export interface LabParams {
  /** Apparent wind angle wanted (rad, + from starboard). */
  awa: number;
  /** True wind speed (m/s). */
  tws: number;
  /** Tow speed (m/s). */
  tow: number;
}

export const LAB_DEFAULTS: LabParams = { awa: 35 * DEG, tws: 12 * KN, tow: 2.5 };

/** A tow faster than the wind cannot produce every apparent wind angle, so it stays just under the wind speed. */
export function towLimit(tws: number): number {
  return 0.95 * tws;
}

/** Apparent wind angle (level frame, same side) of true wind `tws` at angle `twa` on a boat moving at `u`. */
export function awaForTwa(twa: number, u: number, tws: number): number {
  return Math.atan2(tws * Math.sin(twa), tws * Math.cos(twa) + u);
}

/**
 * True wind angle (same side) that gives apparent wind angle `awa` when the boat moves at `u` through true
 * wind `tws`: from tan(awa) = w·sin θ / (w·cos θ + u) it follows that θ = awa + asin((u/w)·sin awa).
 */
export function twaForAwa(awa: number, u: number, tws: number): number {
  const side = Math.sign(awa) || 1;
  const a = Math.min(Math.PI, Math.abs(awa));
  const k = Math.min(1, (u / Math.max(tws, 0.1)) * Math.sin(a));
  return side * Math.min(Math.PI, a + Math.asin(k));
}

/** `p` with the tow speed held under its limit. */
export function limited(p: LabParams): LabParams {
  const tow = Math.min(p.tow, towLimit(p.tws));
  return tow === p.tow ? p : { ...p, tow };
}

function readout(label: string): { el: HTMLElement; slot: TextSlot } {
  const v = h('span', 'sx-ro-v');
  return { el: h('span', 'sx-ro', [h('span', { class: 'sx-ro-k', text: label }), v]), slot: new TextSlot(v) };
}

/** Dynamic pressure of about 1 kn of apparent wind (Pa). */
const CALM_Q = 0.5 * RHO_AIR * (1 * KN) ** 2;

const fmtN = (n: number): string => `${Math.round(n)} N`;
const sideTxt = (rad: number): string => {
  const d = Math.round(Math.abs(rad) / DEG);
  return d === 0 || d === 180 ? `${d}°` : `${d}° ${rad > 0 ? 'S' : 'P'}`;
};

class SailBlock {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly slots: Record<'cl' | 'cd' | 'ld' | 'lift' | 'drag' | 'drive' | 'heel', TextSlot>;

  constructor(name: string) {
    const cl = readout('Cl'), cd = readout('Cd'), ld = readout('L/D');
    const lift = readout('Lift'), drag = readout('Drag');
    const drive = readout('Drive'), heel = readout('Heel force');
    this.title = h('h3', { class: 'sx-sec-title', text: name });
    this.el = h('section', 'sx-sec', [
      h('header', 'sx-sec-head', [this.title]),
      h('div', 'sx-sec-body', [
        h('div', 'sx-ro-row', [cl.el, cd.el, ld.el]),
        h('div', 'sx-ro-row', [lift.el, drag.el]),
        h('div', 'sx-ro-row', [drive.el, heel.el]),
      ]),
    ]);
    this.slots = { cl: cl.slot, cd: cd.slot, ld: ld.slot, lift: lift.slot, drag: drag.slot, drive: drive.slot, heel: heel.slot };
  }

  update(s: SailState, visible: boolean): void {
    this.el.hidden = !visible;
    if (!visible) return;
    const n = s.sections.length;
    const q = n ? s.sections.reduce((a, x) => a + x.q, 0) / n : 0.5 * RHO_AIR;
    const qa = Math.max(1e-6, q * Math.max(s.area, 1e-6));
    // In next to no wind the coefficients are a ratio of two near-zero numbers: show none rather than noise.
    const calm = q < CALM_Q;
    this.slots.cl.set(calm ? '—' : (s.lift / qa).toFixed(2));
    this.slots.cd.set(calm ? '—' : (s.drag / qa).toFixed(2));
    this.slots.ld.set(Math.abs(s.drag) > 1 ? (s.lift / s.drag).toFixed(1) : '—');
    this.slots.lift.set(fmtN(s.lift));
    this.slots.drag.set(fmtN(s.drag));
    this.slots.drive.set(fmtN(s.drive));
    this.slots.heel.set(fmtN(Math.abs(s.heelForce)));
  }
}

export class LabPanel {
  readonly el: HTMLElement;
  private readonly awa: Slider;
  private readonly tws: Slider;
  private readonly tow: Slider;
  private readonly towNote: HTMLElement;
  private readonly totals: Record<'drive' | 'side' | 'heel' | 'awa' | 'aws', TextSlot>;
  private readonly main = new SailBlock('Main');
  private readonly jib = new SailBlock('Jib');
  private readonly spin = new SailBlock('Spinnaker');
  private readonly gate = new RateGate(8);

  constructor(private params: LabParams, onChange: (p: LabParams) => void) {
    const emit = (patch: Partial<LabParams>) => {
      this.params = limited({ ...this.params, ...patch });
      this.reflectTow();
      onChange(this.params);
    };
    this.awa = new Slider({
      label: 'Apparent wind angle', term: 'apparent wind', min: -180, max: 180, step: 1, bipolar: true,
      ends: ['from port', 'from starboard'],
      format: (v) => sideTxt(v * DEG),
      ariaText: (v) => `${Math.abs(Math.round(v))} degrees ${v >= 0 ? 'from starboard' : 'from port'}`,
      onInput: (v) => emit({ awa: v * DEG }),
    });
    this.tws = new Slider({
      label: 'True wind', min: 4, max: 25, step: 0.5, format: (v) => `${v.toFixed(1)} kn`,
      onInput: (v) => emit({ tws: v * KN }),
    });
    this.tow = new Slider({
      label: 'Tow speed', min: 0, max: 8, step: 0.1,
      // Dragged past the limit, the number shown is still the speed in use; the thumb comes back on release.
      format: (v) => `${Math.min(v, towLimit(this.params.tws) / KN).toFixed(1)} kn`,
      onInput: (v) => emit({ tow: v * KN }),
      onRelease: () => this.tow.set(this.params.tow / KN),
    });
    this.towNote = h('p', {
      class: 'sx-lab-note',
      text: 'Held just under the wind speed: a faster tow could not give every wind angle.',
      attrs: { hidden: true },
    });
    const drive = readout('Drive'), side = readout('Side force'), heel = readout('Heel');
    const awa = readout('Masthead AWA'), aws = readout('Masthead AWS');
    this.totals = { drive: drive.slot, side: side.slot, heel: heel.slot, awa: awa.slot, aws: aws.slot };

    this.el = h('div', { class: 'sx-trim sx-lab', attrs: { role: 'region', 'aria-label': 'Sail lab' } }, [
      h('header', 'sx-panel-head', [h('h2', { class: 'sx-panel-title', text: 'Sail lab' }), h('span', { class: 'sx-panel-sub', text: 'Boat towed · heading held' })]),
      h('div', 'sx-panel-scroll', [
        h('section', 'sx-sec', [
          h('header', 'sx-sec-head', [h('h3', { class: 'sx-sec-title', text: 'Wind and tow' })]),
          h('div', 'sx-sec-body', [this.awa.el, this.tws.el, this.tow.el, this.towNote]),
        ]),
        h('section', 'sx-sec', [
          h('header', 'sx-sec-head', [h('h3', { class: 'sx-sec-title', text: 'Whole rig' })]),
          h('div', 'sx-sec-body', [h('div', 'sx-ro-row', [awa.el, aws.el]), h('div', 'sx-ro-row', [drive.el, side.el, heel.el])]),
        ]),
        this.main.el,
        this.jib.el,
        this.spin.el,
        h('p', {
          class: 'sx-lab-help',
          text: 'Trim with the Trim panel and turn on Flow or Forces in View. Ease a sail until its luff telltales lift, then trim back: watch Cl rise and the drag fall. When the boat heels, the masthead reads a smaller wind angle than the one you set.',
        }),
      ]),
    ]);
    this.sync(params);
  }

  /** Moves the sliders to `p` without emitting. */
  sync(p: LabParams): void {
    this.params = limited(p);
    this.awa.set(this.params.awa / DEG);
    this.tws.set(this.params.tws / KN);
    this.reflectTow();
  }

  /** The tow slider and its note follow the speed in use (the slider itself waits while it is being dragged). */
  private reflectTow(): void {
    this.tow.set(this.params.tow / KN);
    this.towNote.hidden = this.params.tow < towLimit(this.params.tws) - 1e-6;
  }

  update(snap: SimSnapshot, dt: number): void {
    if (!this.gate.tick(dt)) return;
    const f = snap.forces;
    this.totals.drive.set(fmtN(f.drive));
    this.totals.side.set(fmtN(Math.abs(f.sideForce)));
    this.totals.heel.set(`${Math.abs(snap.boat.heel / DEG).toFixed(1)}°`);
    this.totals.awa.set(sideTxt(snap.wind.awa));
    this.totals.aws.set(`${fmtKn(snap.wind.aws)} kn`);
    const s = snap.sails;
    this.main.update(s.main, true);
    this.jib.update(s.jib, s.jib.furl < 0.98);
    this.spin.update(s.spinnaker, s.spinnaker.set && s.spinnaker.hoist > 0.5);
  }
}
