// Polar diagram (spec §7.8, lesson 18): target boat speed at every true-wind angle for the current wind
// strength, the best upwind/downwind VMG angles, and where the boat is now (with a short trail).
// The App supplies the model from the VPP table (Task 9); until then the chart shows a placeholder.
import type { SimSnapshot } from '../sim/types';
import { DEG } from '../shared/math';
import { toKn } from '../shared/units';
import { button, fmtKn, h, TextSlot } from './dom';

export interface PolarModel {
  /** Target boat speed (m/s) at true wind speed `tws` (m/s at 10 m) and unsigned true wind angle `twa` (rad, 0…π). */
  speed(tws: number, twa: number): number;
}

export interface VmgOptimum { twa: number; speed: number; vmg: number }

/** Best upwind and downwind VMG for a polar at one wind speed (1° scan). */
export function vmgOptima(model: PolarModel, tws: number): { beat: VmgOptimum; run: VmgOptimum } {
  let beat: VmgOptimum = { twa: 45 * DEG, speed: 0, vmg: -Infinity };
  let run: VmgOptimum = { twa: 150 * DEG, speed: 0, vmg: Infinity };
  for (let d = 20; d <= 180; d++) {
    const a = d * DEG;
    const v = model.speed(tws, a);
    const vmg = v * Math.cos(a);
    if (d <= 90 && vmg > beat.vmg) beat = { twa: a, speed: v, vmg };
    if (d >= 90 && vmg < run.vmg) run = { twa: a, speed: v, vmg };
  }
  return { beat, run };
}

const W = 200;
const H = 290;
const CX = 26;
const CY = H / 2;
const R = H / 2 - 24;
const TRAIL_S = 6;

export class PolarChart {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private readonly title: TextSlot;
  private readonly line1: TextSlot;
  private readonly line2: TextSlot;
  private model: PolarModel | null = null;
  private shown = false;
  private acc = Infinity;
  private layer: HTMLCanvasElement | null = null;
  private layerKey = '';
  private scaleKn = 8;
  private readonly trail: { a: number; kn: number; t: number }[] = [];

  constructor(onClose: () => void) {
    this.canvas = h('canvas', { class: 'sx-polar-canvas', attrs: { 'aria-hidden': 'true' } });
    this.g = this.canvas.getContext('2d');
    const titleEl = h('div', 'sx-card-title');
    const l1 = h('div', 'sx-polar-line');
    const l2 = h('div', 'sx-polar-line is-dim');
    this.title = new TextSlot(titleEl);
    this.line1 = new TextSlot(l1);
    this.line2 = new TextSlot(l2);
    this.el = h('section', { class: 'sx-polar sx-glass', attrs: { 'aria-label': 'Polar diagram', hidden: true } }, [
      h('header', 'sx-card-head', [titleEl, button('Close polar', { icon: 'close', iconOnly: true, class: 'sx-btn--ghost sx-btn--sm', onClick: onClose })]),
      this.canvas,
      l1,
      l2,
    ]);
  }

  setModel(m: PolarModel | null): void {
    this.model = m;
    this.layerKey = '';
    this.acc = Infinity;
  }

  get visible(): boolean { return this.shown; }

  setVisible(on: boolean): void {
    this.shown = on;
    this.el.hidden = !on;
    this.acc = Infinity;
  }

  update(snap: SimSnapshot, dt: number): void {
    const a = Math.abs(snap.wind.twa);
    const kn = toKn(snap.boat.speed);
    this.trail.push({ a, kn, t: snap.t });
    while (this.trail.length && (snap.t - this.trail[0]!.t > TRAIL_S || this.trail[0]!.t > snap.t)) this.trail.shift();
    if (!this.shown) return;
    this.acc += dt;
    if (this.acc < 1 / 8) return;
    this.acc = 0;
    this.draw(snap);
  }

  private draw(snap: SimSnapshot): void {
    const g = this.g;
    if (!g) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.layerKey = '';
    }
    const tws = snap.wind.tws;
    const twsKey = Math.round(toKn(tws) * 2) / 2;
    const key = `${twsKey}|${dpr}|${this.model ? 1 : 0}`;
    if (key !== this.layerKey) this.buildLayer(twsKey, dpr, key);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.layer) g.drawImage(this.layer, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Trail and the boat now.
    const pt = (ang: number, k: number): [number, number] => {
      const r = (Math.min(k, this.scaleKn) / this.scaleKn) * R;
      return [CX + r * Math.sin(ang), CY - r * Math.cos(ang)];
    };
    const n = this.trail.length;
    for (let i = 0; i < n - 1; i++) {
      const p = this.trail[i]!;
      const [x, y] = pt(p.a, p.kn);
      g.fillStyle = `rgba(255, 170, 90, ${(0.08 + 0.35 * (i / n)).toFixed(3)})`;
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
    const [bx, by] = pt(Math.abs(snap.wind.twa), toKn(snap.boat.speed));
    g.fillStyle = '#ff7a1a';
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(bx, by, 4.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    this.title.set(`Polar · TWS ${fmtKn(tws)} kn`);
    if (this.model) {
      const target = this.model.speed(tws, Math.abs(snap.wind.twa));
      const ratio = target > 0.05 ? snap.boat.speed / target : 0;
      this.line1.set(`Target ${fmtKn(target)} kn · you ${fmtKn(snap.boat.speed)} kn (${Math.round(ratio * 100)}%)`);
      const o = vmgOptima(this.model, tws);
      this.line2.set(`Best VMG angles: ${Math.round(o.beat.twa / DEG)}° up · ${Math.round(o.run.twa / DEG)}° down`);
    } else {
      this.line1.set(`You: ${fmtKn(snap.boat.speed)} kn at ${Math.round(Math.abs(snap.wind.twa) / DEG)}° TWA`);
      this.line2.set('Polar table not loaded');
    }
  }

  private buildLayer(twsKn: number, dpr: number, key: string): void {
    this.layerKey = key;
    const c = this.layer ?? document.createElement('canvas');
    this.layer = c;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const tws = twsKn * 0.514444;
    const model = this.model;

    // Speed scale: next even knot above the polar's maximum.
    let vmax = 6;
    if (model) for (let d = 20; d <= 180; d += 5) vmax = Math.max(vmax, toKn(model.speed(tws, d * DEG)));
    this.scaleKn = Math.ceil((vmax + 0.3) / 2) * 2;
    const scale = this.scaleKn;
    const pt = (ang: number, k: number): [number, number] => {
      const r = (k / scale) * R;
      return [CX + r * Math.sin(ang), CY - r * Math.cos(ang)];
    };

    g.font = '10px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
    g.lineWidth = 1;
    // Speed rings.
    for (let k = 2; k <= scale; k += 2) {
      g.strokeStyle = k === scale ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)';
      g.beginPath();
      g.arc(CX, CY, (k / scale) * R, -Math.PI / 2, Math.PI / 2);
      g.stroke();
      g.fillStyle = 'rgba(184,198,214,0.75)';
      g.fillText(k === scale ? `${k} kn` : `${k}`, CX + 4, CY - (k / scale) * R + 12);
    }
    // Angle spokes.
    for (let d = 0; d <= 180; d += 30) {
      const [x, y] = pt(d * DEG, scale);
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.beginPath();
      g.moveTo(CX, CY);
      g.lineTo(x, y);
      g.stroke();
      const [lx, ly] = pt(d * DEG, scale * 1.1);
      g.fillStyle = 'rgba(184,198,214,0.8)';
      g.textAlign = d === 0 || d === 180 ? 'center' : 'left';
      g.fillText(`${d}°`, lx - (d === 0 || d === 180 ? 0 : 2), ly + (d === 0 ? 2 : d === 180 ? 8 : 4));
      g.textAlign = 'left';
    }
    // No-go zone.
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.beginPath();
    g.moveTo(CX, CY);
    g.arc(CX, CY, R, -Math.PI / 2, -Math.PI / 2 + 30 * DEG);
    g.closePath();
    g.fill();
    if (!model) return;

    // Polar curve.
    g.strokeStyle = '#7cc4ff';
    g.lineWidth = 2;
    g.beginPath();
    for (let d = 26; d <= 180; d += 2) {
      const [x, y] = pt(d * DEG, toKn(model.speed(tws, d * DEG)));
      if (d === 26) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    // Best VMG angles.
    const o = vmgOptima(model, tws);
    g.setLineDash([3, 4]);
    g.strokeStyle = 'rgba(255,122,26,0.8)';
    g.lineWidth = 1.2;
    for (const opt of [o.beat, o.run]) {
      const [x, y] = pt(opt.twa, scale);
      g.beginPath();
      g.moveTo(CX, CY);
      g.lineTo(x, y);
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = '#ff7a1a';
    for (const opt of [o.beat, o.run]) {
      const [x, y] = pt(opt.twa, toKn(opt.speed));
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
}
