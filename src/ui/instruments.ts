// Bottom instrument strip (spec §3.2): boat speed, VMG, heading, true wind, apparent wind, heel, leeway,
// rudder — marine-display style (small caps label, big tabular digits, P/S in port red / starboard green).
// Digits update at ~15 Hz; the heel and rudder bars move every frame.
import type { SimSnapshot } from '../sim/types';
import { BOAT } from '../shared/boatSpec';
import { DEG } from '../shared/math';
import { toKn } from '../shared/units';
import { fmtAngle, fmtHeading, fmtKn, h, setClass, sideLetter, TextSlot } from './dom';
import type { PolarModel } from './polarChart';

/** Heel shown full-scale on the bar (display choice). */
const HEEL_SCALE = 30 * DEG;
const RUDDER_SCALE = BOAT.rudder.maxAngleDeg * DEG;

interface SideValue { value: TextSlot; side: HTMLElement; last: string }

function sideValue(): { el: HTMLElement; sv: SideValue } {
  const v = h('span', 'sx-v');
  const side = h('span', 'sx-side');
  return { el: h('span', 'sx-vwrap', [v, side]), sv: { value: new TextSlot(v), side, last: '' } };
}

function setSide(sv: SideValue, rad: number, digits = 0): void {
  sv.value.set(fmtAngle(rad, digits));
  const s = sideLetter(rad, digits > 0 ? 0.05 * DEG : 0.5 * DEG);
  if (s === sv.last) return;
  sv.last = s;
  sv.side.textContent = s;
  sv.side.className = `sx-side ${s === 'P' ? 'is-port' : s === 'S' ? 'is-stbd' : ''}`;
}

/** Centre-zero bar: port fill grows left (red), starboard fill grows right (green). */
class CentreBar {
  readonly el: HTMLElement;
  private readonly port: HTMLElement;
  private readonly stbd: HTMLElement;
  private last = NaN;
  constructor(label: string) {
    this.port = h('span', 'sx-bar-fill is-port');
    this.stbd = h('span', 'sx-bar-fill is-stbd');
    this.el = h('span', { class: 'sx-bar', attrs: { 'aria-hidden': 'true', title: label } }, [this.port, this.stbd, h('span', 'sx-bar-zero')]);
  }
  set(v: number): void {
    const x = Math.max(-1, Math.min(1, v));
    if (Math.abs(x - this.last) < 0.004) return;
    this.last = x;
    this.port.style.transform = `scaleX(${x < 0 ? (-x).toFixed(3) : '0'})`;
    this.stbd.style.transform = `scaleX(${x > 0 ? x.toFixed(3) : '0'})`;
  }
}

function cell(key: string, label: string, opts: { unit?: string; term?: string; title: string; wide?: boolean }, body: HTMLElement[]): HTMLElement {
  const lab = h('span', { class: `sx-cell-label${opts.term ? ' sx-gloss' : ''}`, text: label, attrs: opts.term ? { 'data-term': opts.term, tabindex: '0' } : {} });
  return h('div', { class: `sx-cell${opts.wide ? ' is-dual' : ''}`, title: opts.title, attrs: { 'data-k': key, role: 'group', 'aria-label': opts.title } }, [
    h('div', 'sx-cell-head', [lab, opts.unit ? h('span', { class: 'sx-cell-unit', text: opts.unit }) : null]),
    ...body,
  ]);
}

export class Instruments {
  readonly el: HTMLElement;
  /** Where the Hud mounts the round wind instrument (between the two cell groups). */
  readonly dialSlot: HTMLElement;
  private polar: PolarModel | null = null;
  private readonly bsp: TextSlot;
  private readonly bspSub: TextSlot;
  private readonly vmg: TextSlot;
  private readonly vmgArrow: HTMLElement;
  private vmgDir = '';
  private readonly vmgSub: TextSlot;
  private readonly hdg: TextSlot;
  private readonly cog: TextSlot;
  private readonly tws: TextSlot;
  private readonly twa: SideValue;
  private readonly aws: TextSlot;
  private readonly awa: SideValue;
  private readonly heel: SideValue;
  private readonly heelBar = new CentreBar('Heel: port ← → starboard');
  private readonly leeway: SideValue;
  private readonly rudder: SideValue;
  private readonly rudderBar = new CentreBar('Rudder: port ← → starboard');
  private readonly status: TextSlot;
  private readonly statusEl: HTMLElement;

  constructor() {
    const big = () => h('span', 'sx-v');
    const sub = () => h('div', 'sx-cell-sub');
    const bspV = big(); const bspS = sub();
    const vmgV = big(); const vmgS = sub();
    this.vmgArrow = h('span', 'sx-vmg-dir');
    const hdgV = big(); const cogS = sub();
    const twsV = h('span', 'sx-v'); const twa = sideValue();
    const awsV = h('span', 'sx-v'); const awa = sideValue();
    const heel = sideValue();
    const lwy = sideValue();
    const rud = sideValue();
    this.bsp = new TextSlot(bspV); this.bspSub = new TextSlot(bspS);
    this.vmg = new TextSlot(vmgV); this.vmgSub = new TextSlot(vmgS);
    this.hdg = new TextSlot(hdgV); this.cog = new TextSlot(cogS);
    this.tws = new TextSlot(twsV); this.twa = twa.sv;
    this.aws = new TextSlot(awsV); this.awa = awa.sv;
    this.heel = heel.sv; this.leeway = lwy.sv; this.rudder = rud.sv;
    this.statusEl = h('div', { class: 'sx-status', attrs: { 'aria-live': 'polite' } });
    this.status = new TextSlot(this.statusEl);

    const duo = (k: string, term: string, value: HTMLElement, unit?: string) =>
      h('div', 'sx-duo', [h('span', { class: 'sx-duo-k sx-gloss', text: k, attrs: { 'data-term': term, tabindex: '0' } }), value, unit ? h('span', { class: 'sx-duo-u', text: unit }) : null]);

    const left = h('div', 'sx-cells is-left', [
      cell('bsp', 'BSP', { unit: 'kn', title: 'Boat speed through the water' }, [h('div', 'sx-cell-value', [bspV]), bspS]),
      cell('vmg', 'VMG', { unit: 'kn', term: 'vmg', title: 'Velocity made good: speed toward (▲) or away from (▼) the wind' }, [h('div', 'sx-cell-value', [this.vmgArrow, vmgV]), vmgS]),
      cell('hdg', 'HDG', { title: 'Compass heading (course over ground below)' }, [h('div', 'sx-cell-value', [hdgV]), cogS]),
      cell('tw', 'TRUE WIND', { term: 'true-wind', title: 'True wind: speed (TWS) and angle to the bow (TWA)', wide: true }, [
        duo('TWS', 'true-wind', twsV, 'kn'),
        duo('TWA', 'true-wind', twa.el),
      ]),
    ]);
    this.dialSlot = h('div', 'sx-dial-slot');
    const right = h('div', 'sx-cells is-right', [
      cell('aw', 'APPARENT', { term: 'apparent-wind', title: 'Apparent wind: what the sails feel (AWS, AWA)', wide: true }, [
        duo('AWS', 'apparent-wind', awsV, 'kn'),
        duo('AWA', 'apparent-wind', awa.el),
      ]),
      cell('heel', 'HEEL', { term: 'heel', title: 'Heel angle (P/S = side that is down)' }, [h('div', 'sx-cell-value', [heel.el]), this.heelBar.el]),
      cell('lwy', 'LEEWAY', { term: 'leeway', title: 'Leeway: sideways slip (P/S = direction of drift)' }, [h('div', 'sx-cell-value', [lwy.el])]),
      cell('rud', 'RUDDER', { term: 'rudder', title: 'Rudder angle (S = turning the boat to starboard)' }, [h('div', 'sx-cell-value', [rud.el]), this.rudderBar.el]),
    ]);
    this.el = h('div', { class: 'sx-cluster', attrs: { role: 'region', 'aria-label': 'Instruments' } }, [this.statusEl, left, this.dialSlot, right]);
  }

  setPolar(m: PolarModel | null): void {
    this.polar = m;
  }

  update(snap: SimSnapshot, textTick: boolean): void {
    const b = snap.boat;
    this.heelBar.set(b.heel / HEEL_SCALE);
    this.rudderBar.set(b.rudder / RUDDER_SCALE);
    if (!textTick) return;
    const w = snap.wind;
    this.bsp.set(toKn(b.speed).toFixed(2));
    if (this.polar) {
      const target = this.polar.speed(w.tws, Math.abs(w.twa));
      this.bspSub.set(target > 0.05 ? `TGT ${fmtKn(target)} · ${Math.round((b.speed / target) * 100)}%` : 'TGT —');
    } else {
      this.bspSub.set(snap.towed ? 'towed' : '');
    }
    const vmgKn = toKn(b.vmg);
    this.vmg.set(Math.abs(vmgKn).toFixed(1));
    const dir = vmgKn > 0.05 ? '▲' : vmgKn < -0.05 ? '▼' : '';
    if (dir !== this.vmgDir) {
      this.vmgDir = dir;
      this.vmgArrow.textContent = dir;
      this.vmgSub.set(dir === '▲' ? 'upwind' : dir === '▼' ? 'downwind' : '');
    }
    this.hdg.set(fmtHeading(b.heading));
    this.cog.set(`COG ${fmtHeading(b.cog)}`);
    this.tws.set(fmtKn(w.tws));
    setSide(this.twa, w.twa);
    this.aws.set(fmtKn(w.aws));
    setSide(this.awa, w.awa);
    setSide(this.heel, b.heel);
    setSide(this.leeway, b.leeway, 1);
    setSide(this.rudder, b.rudder);
    const m = snap.maneuver;
    const status = m === 'tack' ? 'Tacking…' : m === 'gybe' ? 'Gybing…' : m === 'hoist' ? 'Hoisting spinnaker…'
      : m === 'douse' ? 'Dousing spinnaker…' : snap.towed ? 'Sail lab — boat towed' : '';
    this.status.set(status);
    setClass(this.statusEl, 'is-on', status !== '');
  }
}
