// Round wind instrument (spec §3.2), boat-relative with the bow up, in the style of a B&G/Garmin
// analogue wind display: amber apparent-wind needle, blue true-wind marker, red/green close-hauled
// arcs (port/starboard) and a shaded no-go wedge that sits on the true wind — when the bow mark is
// inside the wedge the boat cannot sail. Needles move every frame (damped); digits update at ~15 Hz.
import type { SimSnapshot } from '../sim/types';
import { DEG, wrapPi } from '../shared/math';
import { fmtAngle, fmtKn, h, s, sideLetter, TextSlot, setClass } from './dom';

const C = 100; // viewBox centre
/** Half-width of the no-go zone around the true wind (rad). */
export const NO_GO = 40 * DEG;
/** Close-hauled apparent-wind band drawn as the red/green arcs (deg). */
const CLOSE_HAULED: [number, number] = [20, 60];
/** Needle damping time constant (s), like a real instrument's damping setting. */
const DAMPING = 0.15;

/** Point on a circle, angle clockwise from the bow (top). */
function polar(r: number, deg: number): [number, number] {
  const a = deg * DEG;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

function arc(r: number, from: number, to: number): string {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function wedge(r: number, half: number): string {
  const [x0, y0] = polar(r, -half);
  const [x1, y1] = polar(r, half);
  return `M${C} ${C}L${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}Z`;
}

export class WindDial {
  readonly el: HTMLElement;
  private readonly awaG: SVGGElement;
  private readonly twaG: SVGGElement;
  private readonly noGoG: SVGGElement;
  private readonly awaText: TextSlot;
  private readonly sideText: SVGTSpanElement;
  private readonly sideSlot: TextSlot;
  private readonly awsText: TextSlot;
  private awa = 0;
  private twa = 0;
  private drawnAwa = NaN;
  private drawnTwa = NaN;
  private primed = false;
  private side: string | null = null;

  constructor() {
    const ticks: SVGElement[] = [];
    for (let d = 10; d < 360; d += 10) {
      const major = d % 30 === 0;
      const [x0, y0] = polar(major ? 93 : 91, d);
      const [x1, y1] = polar(major ? 82 : 86, d);
      ticks.push(s('line', { x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2), class: major ? 'sx-dial-tick is-major' : 'sx-dial-tick' }));
    }
    const labels: SVGElement[] = [];
    for (const d of [30, 60, 90, 120, 150]) {
      for (const sign of [-1, 1]) {
        const [x, y] = polar(71, sign * d);
        labels.push(s('text', { x: x.toFixed(1), y: (y + 3.6).toFixed(1), class: `sx-dial-num ${sign < 0 ? 'is-port' : 'is-stbd'}` }, [String(d)]));
      }
    }
    const [bx, by] = polar(97, 0);
    this.noGoG = s('g', { class: 'sx-dial-nogo' }, [
      s('path', { d: wedge(80, NO_GO / DEG), class: 'sx-dial-nogo-fill' }),
      s('path', { d: `M${C} ${C}L${polar(80, -NO_GO / DEG).join(' ')}M${C} ${C}L${polar(80, NO_GO / DEG).join(' ')}`, class: 'sx-dial-nogo-edge' }),
    ]);
    this.twaG = s('g', { class: 'sx-dial-tw' }, [
      s('path', { d: `M${C} ${C - 79}L${C - 7} ${C - 96}L${C + 7} ${C - 96}Z`, class: 'sx-dial-tw-mark' }),
    ]);
    this.awaG = s('g', { class: 'sx-dial-aw' }, [
      s('path', { d: `M${C} ${C - 84}L${C + 4.6} ${C - 6}L${C + 1.8} ${C + 20}L${C - 1.8} ${C + 20}L${C - 4.6} ${C - 6}Z`, class: 'sx-dial-needle' }),
    ]);
    const awaValue = s('tspan', {}, ['0°']);
    this.sideText = s('tspan', { class: 'sx-dial-side', dx: 3 }, ['']);
    const awsValue = s('tspan', {}, ['0.0']);
    const svg = s('svg', { viewBox: '0 0 200 200', class: 'sx-dial-svg', 'aria-hidden': 'true' }, [
      s('defs', {}, [
        s('radialGradient', { id: 'sx-dial-face', cx: '50%', cy: '42%', r: '62%' }, [
          s('stop', { offset: '0%', 'stop-color': '#16304c', 'stop-opacity': '0.92' }),
          s('stop', { offset: '100%', 'stop-color': '#050e1a', 'stop-opacity': '0.9' }),
        ]),
      ]),
      s('circle', { cx: C, cy: C, r: 98, class: 'sx-dial-face', fill: 'url(#sx-dial-face)' }),
      s('path', { d: arc(87, -CLOSE_HAULED[1], -CLOSE_HAULED[0]), class: 'sx-dial-sector is-port' }),
      s('path', { d: arc(87, CLOSE_HAULED[0], CLOSE_HAULED[1]), class: 'sx-dial-sector is-stbd' }),
      ...ticks,
      ...labels,
      s('path', { d: `M${bx} ${by + 1}L${bx - 5} ${by + 10}L${bx + 5} ${by + 10}Z`, class: 'sx-dial-bow' }),
      this.noGoG,
      // Boat outline (top view, bow up) under the needle.
      s('path', { d: `M${C} ${C - 24}C${C + 9} ${C - 12} ${C + 9} ${C + 6} ${C + 7} ${C + 22}L${C - 7} ${C + 22}C${C - 9} ${C + 6} ${C - 9} ${C - 12} ${C} ${C - 24}Z`, class: 'sx-dial-boat' }),
      s('text', { x: C, y: C + 43, class: 'sx-dial-value' }, [awaValue, this.sideText]),
      s('text', { x: C, y: C + 58, class: 'sx-dial-sub' }, [awsValue, s('tspan', { class: 'sx-dial-unit', dx: 2 }, ['kn'])]),
      this.twaG,
      this.awaG,
      s('circle', { cx: C, cy: C, r: 6.5, class: 'sx-dial-hub' }),
    ]);
    this.awaText = new TextSlot(awaValue);
    this.sideSlot = new TextSlot(this.sideText);
    this.awsText = new TextSlot(awsValue);
    this.el = h('div', {
      class: 'sx-dial',
      title: 'Wind instrument — amber needle: apparent wind (AWA). Blue mark: true wind (TWA). Shaded wedge: the no-go zone. Red/green arcs: close-hauled on port/starboard.',
      attrs: { role: 'img', 'aria-label': 'Wind instrument' },
    }, [svg, h('div', 'sx-dial-caption', [h('span', { class: 'sx-dial-key is-aw', text: 'AWA' }), h('span', { class: 'sx-dial-key is-tw', text: 'TWA' })])]);
  }

  update(snap: SimSnapshot, dt: number, textTick: boolean): void {
    const { awa, twa, aws } = snap.wind;
    if (!this.primed) {
      this.awa = awa;
      this.twa = twa;
      this.primed = true;
    } else {
      const k = 1 - Math.exp(-Math.max(0, dt) / DAMPING);
      this.awa = wrapPi(this.awa + wrapPi(awa - this.awa) * k);
      this.twa = wrapPi(this.twa + wrapPi(twa - this.twa) * k);
    }
    const aDeg = this.awa / DEG;
    const tDeg = this.twa / DEG;
    // Needles point to where the wind comes FROM: +angle (starboard) is clockwise from the bow.
    if (!(Math.abs(aDeg - this.drawnAwa) < 0.05)) {
      this.drawnAwa = aDeg;
      this.awaG.setAttribute('transform', `rotate(${aDeg.toFixed(2)} ${C} ${C})`);
    }
    if (!(Math.abs(tDeg - this.drawnTwa) < 0.05)) {
      this.drawnTwa = tDeg;
      const r = `rotate(${tDeg.toFixed(2)} ${C} ${C})`;
      this.twaG.setAttribute('transform', r);
      this.noGoG.setAttribute('transform', r);
      setClass(this.el, 'is-nogo', Math.abs(this.twa) < NO_GO);
    }
    if (textTick) {
      this.awaText.set(fmtAngle(awa));
      const side = sideLetter(awa);
      if (side !== this.side) {
        this.side = side;
        this.sideSlot.set(side);
        this.sideText.setAttribute('class', `sx-dial-side ${side === 'P' ? 'is-port' : side === 'S' ? 'is-stbd' : ''}`);
      }
      this.awsText.set(fmtKn(aws));
    }
  }
}
