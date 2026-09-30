// Right-hand trim panel (spec §3.2): Helm (tiller + autopilot), Main (sheet, traveler, shape), Jib
// (sheet, lead, furl, back jib, whisker pole), Spinnaker (hoist/douse, pole, sheet), Crew (hiking) and
// per-sail crew auto-trim — plus live teaching read-outs (boom/clew angle, angle of attack, a
// luff–groove–stall meter and the telltales). `TouchDeck` is the phone version: tiller and sheet sliders.
// Everything writes only to `app.controls` (read fresh on every access).
import type { SimSnapshot, Telltale, SailState } from '../sim/types';
import { DEG, clamp } from '../shared/math';
import type { AppApi, ControlKey } from '../lessons/types';
import { nudgeHelmTarget, SAIL_NAME, takeManualControl, type SailKey } from './input';
import {
  button, fmtAngle, fmtHeading, fmtSheetAngle, fmtSided, h, icon, pct, s, Segmented, setClass, setDisabled, sideLetter, Slider, TextSlot, Toggle,
} from './dom';

export interface TrimHooks {
  /** On-screen tiller: a value while held, null on release (self-centres). */
  holdTiller(v: number | null): void;
  notify(msg: string): void;
  isLive(k: ControlKey): boolean;
}

type Sail = SailKey;
type NumKey = 'mainSheet' | 'traveler' | 'vang' | 'outhaul' | 'cunningham' | 'backstay' | 'jibSheet' | 'jibLead' | 'jibFurl'
  | 'spinPole' | 'spinPoleHeight' | 'spinSheet';

const AUTOPILOT_STEP = 1 * DEG;

interface Bound { key: NumKey; slider: Slider; sail: Sail | null }

/** The learner grabbed one of a sail's controls: same rule as the keyboard (see takeManualControl). */
function takeManual(app: AppApi, hooks: TrimHooks, sail: Sail | null): void {
  if (sail) takeManualControl(app.controls, sail, hooks.notify);
}

function tillerText(v: number): string {
  if (Math.abs(v) < 0.02) return 'centre';
  return `${v < 0 ? 'port' : 'stbd'} ${Math.round(Math.abs(v) * 100)}%`;
}

// ---- telltales and the groove meter ---------------------------------------------------------------

const RIBBON: Record<Telltale['state'], string> = {
  streaming: 'M2 7 C8 7 14 7 26 7',
  lifting: 'M2 7 C8 7 11 2 16 3 S22 1 26 0',
  stalled: 'M2 7 C5 9 7 11 8 13',
  fluttering: 'M2 7 L6 4 L10 10 L14 4 L18 10 L22 5 L26 7',
};
const STATE_WORD: Record<Telltale['state'], string> = { streaming: 'streaming', lifting: 'lifting', stalled: 'stalled', fluttering: 'fluttering' };

/** A row of ribbon glyphs (top of the sail first). */
class TelltaleRow {
  readonly el: HTMLElement;
  private readonly paths: SVGPathElement[] = [];
  private readonly boxes: HTMLElement[] = [];
  private readonly key: string[] = [];

  constructor(label: string, n: number, private readonly colourBySide: boolean) {
    const items: HTMLElement[] = [];
    for (let i = 0; i < n; i++) {
      const p = s('path', { d: RIBBON.streaming, class: 'sx-ribbon' });
      const svg = s('svg', { viewBox: '0 0 28 14', width: 28, height: 14, 'aria-hidden': 'true' }, [s('circle', { cx: 2, cy: 7, r: 1.6, class: 'sx-ribbon-pin' }), p]);
      const box = h('span', 'sx-tt', [svg]);
      this.paths.push(p);
      this.boxes.push(box);
      this.key.push('');
      items.push(box);
    }
    this.el = h('div', 'sx-tt-row', [h('span', { class: 'sx-tt-label', text: label }), h('span', 'sx-tt-items', items)]);
  }

  set(tts: readonly Telltale[]): void {
    for (let i = 0; i < this.paths.length; i++) {
      const t = tts[i];
      const key = t ? `${t.state}|${t.side}` : '';
      if (key === this.key[i]) continue;
      this.key[i] = key;
      const box = this.boxes[i]!;
      box.hidden = !t;
      if (!t) continue;
      this.paths[i]!.setAttribute('d', RIBBON[t.state]);
      box.className = `sx-tt is-${t.state} ${this.colourBySide ? `is-${t.side}` : 'is-leech'}`;
      box.title = `${t.side === 'leech' ? 'Leech' : t.side === 'port' ? 'Port' : 'Starboard'} telltale: ${STATE_WORD[t.state]}`;
    }
  }
}

/** Luffing ← groove → stalled, from the sections' luffing/stall intensities. */
class GrooveMeter {
  readonly el: HTMLElement;
  private readonly mark: HTMLElement;
  private readonly word: TextSlot;
  private last = NaN;
  constructor() {
    this.mark = h('span', 'sx-groove-mark');
    const word = h('span', 'sx-groove-word');
    this.word = new TextSlot(word);
    this.el = h('div', { class: 'sx-groove', title: 'Blue: luffing (angle of attack too small). Green: in the groove. Red: stalled (too big).' }, [
      h('span', 'sx-groove-track', [h('span', 'sx-groove-zone is-luff'), h('span', 'sx-groove-zone is-ok'), h('span', 'sx-groove-zone is-stall'), this.mark]),
      word,
    ]);
  }
  set(sail: SailState): void {
    let luff = 0, stall = 0;
    const n = sail.sections.length;
    for (const sec of sail.sections) { luff += sec.luffing; stall += sec.stall; }
    if (n > 0) { luff /= n; stall /= n; }
    const x = clamp(0.5 + 0.5 * (stall - luff) * 1.6, 0, 1);
    if (Math.abs(x - this.last) > 0.004) {
      this.last = x;
      this.mark.style.left = `${(x * 100).toFixed(1)}%`;
    }
    this.word.set(!sail.set || n === 0 ? '—' : luff > 0.35 ? 'luffing' : stall > 0.35 ? 'stalled' : 'in the groove');
  }
}

function meanAoa(sail: SailState): number | null {
  const n = sail.sections.length;
  if (!n) return null;
  let a = 0;
  for (const sec of sail.sections) a += sec.aoa;
  return a / n;
}

/** Tiny top view of the stern: rudder blade and tiller swing opposite ways (spec §3.3 "shown on screen"). */
class TillerDiagram {
  readonly el: HTMLElement;
  private readonly tiller: SVGGElement;
  private readonly blade: SVGGElement;
  private readonly caption: TextSlot;
  private last = NaN;
  constructor() {
    this.tiller = s('g', {}, [s('line', { x1: 60, y1: 34, x2: 60, y2: 8, class: 'sx-td-tiller' }), s('circle', { cx: 60, cy: 8, r: 2.6, class: 'sx-td-grip' })]);
    this.blade = s('g', {}, [s('line', { x1: 60, y1: 34, x2: 60, y2: 50, class: 'sx-td-blade' })]);
    const cap = h('span', 'sx-td-caption');
    this.caption = new TextSlot(cap);
    this.el = h('div', { class: 'sx-td', title: 'Top view of the stern: the tiller moves opposite to the way the bow turns' }, [
      s('svg', { viewBox: '0 0 120 56', width: 120, height: 56, 'aria-hidden': 'true' }, [
        s('path', { d: 'M18 0 C22 20 34 34 46 36 L74 36 C86 34 98 20 102 0', class: 'sx-td-hull' }),
        s('text', { x: 8, y: 52, class: 'sx-td-side is-port' }, ['P']),
        s('text', { x: 106, y: 52, class: 'sx-td-side is-stbd' }, ['S']),
        this.blade,
        this.tiller,
        s('circle', { cx: 60, cy: 34, r: 2.2, class: 'sx-td-stock' }),
      ]),
      cap,
    ]);
  }
  /** `rudder` rad, + turns the boat to starboard: the blade's trailing edge goes to starboard, the tiller to port. */
  set(rudder: number, textTick: boolean): void {
    const d = rudder / DEG;
    if (Math.abs(d - this.last) > 0.1) {
      this.last = d;
      // Screen y grows downward (aft); rotating the aft-pointing blade by −d swings its tip to starboard (right).
      this.blade.setAttribute('transform', `rotate(${(-d).toFixed(1)} 60 34)`);
      this.tiller.setAttribute('transform', `rotate(${(-d).toFixed(1)} 60 34)`);
    }
    if (textTick) {
      const side = sideLetter(rudder, 1 * DEG);
      this.caption.set(side === '' ? 'Tiller centred — going straight' : side === 'S' ? 'Tiller to port → bow turns to starboard' : 'Tiller to starboard → bow turns to port');
    }
  }
}

// ---- sections -------------------------------------------------------------------------------------

class Section {
  readonly el: HTMLElement;
  private readonly head: HTMLButtonElement;
  private readonly body: HTMLElement;
  private collapsed: boolean;
  constructor(title: string, extra: HTMLElement | null, children: (HTMLElement | null)[], collapsed = false) {
    this.collapsed = collapsed;
    this.body = h('div', 'sx-sec-body', children.filter((c): c is HTMLElement => c !== null));
    this.head = h('button', { class: 'sx-sec-toggle', attrs: { type: 'button', 'aria-expanded': String(!collapsed) }, on: { click: () => this.setCollapsed(!this.collapsed) } }, [
      icon('chevronDown', 14),
      h('span', { class: 'sx-sec-title', text: title }),
    ]);
    this.el = h('section', `sx-sec${collapsed ? ' is-collapsed' : ''}`, [h('header', 'sx-sec-head', [this.head, extra]), this.body]);
  }
  setCollapsed(on: boolean): void {
    this.collapsed = on;
    setClass(this.el, 'is-collapsed', on);
    this.head.setAttribute('aria-expanded', String(!on));
  }
}

function readout(label: string): { el: HTMLElement; slot: TextSlot } {
  const v = h('span', 'sx-ro-v');
  return { el: h('span', 'sx-ro', [h('span', { class: 'sx-ro-k', text: label }), v]), slot: new TextSlot(v) };
}

// ---- the panel -------------------------------------------------------------------------------------

export class TrimPanel {
  readonly el: HTMLElement;
  private readonly bound: Bound[] = [];
  private readonly helmMode: Segmented<'manual' | 'heading' | 'twa' | 'awa'>;
  private readonly tiller: Slider;
  private readonly manualBox: HTMLElement;
  private readonly pilotBox: HTMLElement;
  private readonly pilotTarget: TextSlot;
  private readonly pilotLabel: TextSlot;
  private readonly tackBtn: HTMLButtonElement;
  private readonly gybeBtn: HTMLButtonElement;
  private readonly diagram = new TillerDiagram();
  private readonly auto: Record<Sail, Toggle>;
  private readonly backJib: Toggle;
  private readonly whisker: Toggle;
  private readonly hoist: Toggle;
  private readonly hike: Segmented<'auto' | 'manual'>;
  private readonly boomPush: Segmented<'off' | 'port' | 'stbd'>;
  private readonly hikeSlider: Slider;
  private readonly mainTT = new TelltaleRow('Leech', 4, false);
  private readonly jibWindward = new TelltaleRow('Windward', 3, true);
  private readonly jibLeeward = new TelltaleRow('Leeward', 3, true);
  private readonly mainGroove = new GrooveMeter();
  private readonly jibGroove = new GrooveMeter();
  private readonly spinGroove = new GrooveMeter();
  private readonly ro: Record<'boom' | 'twist' | 'mainAoa' | 'clew' | 'jibAoa' | 'spinHoist' | 'curl' | 'collapse' | 'rudder' | 'leeway' | 'heel', TextSlot>;
  private readonly spinSection: Section;
  private spinWasUp = false;
  private snap: SimSnapshot | null = null;

  constructor(private readonly app: AppApi, private readonly hooks: TrimHooks) {
    const c = () => this.app.controls;

    // Helm.
    this.helmMode = new Segmented('Helm mode', [
      { value: 'manual', label: 'Manual', title: 'You steer with the tiller' },
      { value: 'heading', label: 'HDG', title: 'Autopilot holds a compass heading' },
      { value: 'twa', label: 'TWA', title: 'Autopilot holds a true wind angle' },
      { value: 'awa', label: 'AWA', title: 'Autopilot holds an apparent wind angle' },
    ], (m) => this.setHelmMode(m), 'sx-seg--fill');
    this.tiller = new Slider({
      label: 'Steer', term: 'tiller', min: -1, max: 1, step: 0.01, bipolar: true, ends: ['◀ bow to port', 'bow to stbd ▶'],
      format: tillerText,
      ariaText: (v) => `Helm ${tillerText(v)}`,
      onInput: (v) => this.hooks.holdTiller(v),
      onGrab: () => this.hooks.holdTiller(this.app.controls.tiller),
      onRelease: () => this.hooks.holdTiller(null),
    });
    this.manualBox = h('div', 'sx-helm-manual', [this.tiller.el, this.diagram.el]);
    const targetEl = h('span', 'sx-pilot-v');
    const targetLab = h('span', 'sx-pilot-k');
    this.pilotTarget = new TextSlot(targetEl);
    this.pilotLabel = new TextSlot(targetLab);
    this.pilotBox = h('div', 'sx-helm-pilot', [
      button('Bow to port', { icon: 'chevronLeft', iconOnly: true, class: 'sx-btn--sq', title: 'Bow 1° to port (or hold ←)', onClick: () => this.nudge(-1) }),
      h('div', 'sx-pilot-read', [targetLab, targetEl]),
      button('Bow to starboard', { icon: 'chevronRight', iconOnly: true, class: 'sx-btn--sq', title: 'Bow 1° to starboard (or hold →)', onClick: () => this.nudge(1) }),
    ]);
    this.tackBtn = button('Tack', { class: 'sx-btn--action', title: 'Tack: turn the bow through the wind (T)', onClick: () => { if (this.hooks.isLive('tack')) c().command = 'tack'; } });
    this.gybeBtn = button('Gybe', { class: 'sx-btn--action', title: 'Gybe: turn the stern through the wind (G)', onClick: () => { if (this.hooks.isLive('gybe')) c().command = 'gybe'; } });
    const rudderRo = readout('Rudder'); const leewayRo = readout('Leeway'); const heelRo = readout('Heel');
    const helm = new Section('Helm', null, [
      this.helmMode.el,
      this.manualBox,
      this.pilotBox,
      h('div', 'sx-ro-row', [rudderRo.el, leewayRo.el, heelRo.el]),
      h('div', 'sx-row sx-row--2', [this.tackBtn, this.gybeBtn]),
    ]);

    // Per-sail auto-trim.
    const autoToggle = (sail: Sail) => new Toggle('Auto', (on) => {
      if (!this.hooks.isLive(`autoTrim.${sail}`)) return;
      c().autoTrim[sail] = on;
    }, { title: `Crew auto-trims the ${SAIL_NAME[sail].toLowerCase()}`, class: 'sx-toggle--auto' });
    this.auto = { main: autoToggle('main'), jib: autoToggle('jib'), spinnaker: autoToggle('spinnaker') };

    const boom = readout('Boom'); const twist = readout('Twist'); const mainAoa = readout('AoA');
    const clew = readout('Clew'); const jibAoa = readout('AoA');
    const spinHoist = readout('Hoist'); const curl = readout('Curl'); const collapse = readout('Shape');
    this.ro = {
      boom: boom.slot, twist: twist.slot, mainAoa: mainAoa.slot, clew: clew.slot, jibAoa: jibAoa.slot, spinHoist: spinHoist.slot,
      curl: curl.slot, collapse: collapse.slot, rudder: rudderRo.slot, leeway: leewayRo.slot, heel: heelRo.slot,
    };

    // Pushing the boom out by hand backs the main (getting out of irons); the mainsheet must be eased for it.
    this.boomPush = new Segmented('Push boom', [
      { value: 'off', label: 'Boom free', short: 'Free', title: 'Nobody holds the boom' },
      { value: 'port', label: 'Push to port', short: 'Port', title: 'A crew member pushes the boom out to port (ease the mainsheet)' },
      { value: 'stbd', label: 'Push to stbd', short: 'Stbd', title: 'A crew member pushes the boom out to starboard (ease the mainsheet)' },
    ], (v) => {
      if (this.hooks.isLive('boomPush')) c().boomPush = v === 'port' ? 1 : v === 'stbd' ? -1 : 0;
    }, 'sx-seg--fill');
    const main = new Section('Mainsail', this.auto.main.el, [
      this.bind('mainSheet', 'main', { label: 'Sheet', term: 'sheet', min: 0, max: 1, ends: ['eased', 'trimmed'], format: pct }),
      this.bind('traveler', 'main', { label: 'Traveler', term: 'traveler', min: -1, max: 1, bipolar: true, ends: ['to leeward', 'to windward'], format: (v) => (Math.abs(v) < 0.02 ? 'centre' : `${v > 0 ? 'W' : 'L'} ${pct(Math.abs(v))}`) }),
      h('div', 'sx-ro-row', [boom.el, twist.el, mainAoa.el]),
      this.mainGroove.el,
      this.mainTT.el,
      this.boomPush.el,
      h('details', 'sx-shape', [
        h('summary', { text: 'Sail shape' }),
        this.bind('vang', 'main', { label: 'Vang', term: 'vang', min: 0, max: 1, ends: ['loose', 'hard'], format: pct }),
        this.bind('outhaul', 'main', { label: 'Outhaul', term: 'outhaul', min: 0, max: 1, ends: ['deep foot', 'flat foot'], format: pct }),
        this.bind('cunningham', 'main', { label: 'Cunningham', term: 'cunningham', min: 0, max: 1, ends: ['draft aft', 'draft fwd'], format: pct }),
        this.bind('backstay', 'main', { label: 'Backstay', term: 'backstay', min: 0, max: 1, ends: ['full', 'flat'], format: pct }),
      ]),
    ]);

    this.backJib = new Toggle('Back jib', (on) => { if (this.hooks.isLive('jibBacked')) c().jibBacked = on; }, { title: 'Hold the jib clew to windward (to turn the bow away, e.g. out of irons)' });
    this.whisker = new Toggle('Whisker pole', (on) => { if (this.hooks.isLive('jibWhisker')) c().jibWhisker = on; }, { title: 'Pole the jib out to windward for wing-on-wing downwind' });
    const jib = new Section('Jib', this.auto.jib.el, [
      this.bind('jibSheet', 'jib', { label: 'Sheet', term: 'sheet', min: 0, max: 1, ends: ['eased', 'trimmed'], format: pct }),
      this.bind('jibLead', 'jib', { label: 'Lead', min: -1, max: 1, bipolar: true, ends: ['aft', 'forward'], format: (v) => (Math.abs(v) < 0.02 ? 'middle' : `${v > 0 ? 'fwd' : 'aft'} ${pct(Math.abs(v))}`) }),
      this.bind('jibFurl', null, { label: 'Furl', min: 0, max: 1, ends: ['full sail', 'furled'], format: pct }),
      h('div', 'sx-row sx-row--2', [this.backJib.el, this.whisker.el]),
      h('div', 'sx-ro-row', [clew.el, jibAoa.el]),
      this.jibGroove.el,
      this.jibWindward.el,
      this.jibLeeward.el,
    ]);

    this.hoist = new Toggle('Hoisted', (on) => { if (this.hooks.isLive('spinHoist')) c().spinHoist = on; }, { title: 'Hoist or douse the spinnaker (H)', class: 'sx-toggle--wide' });
    this.spinSection = new Section('Spinnaker', this.auto.spinnaker.el, [
      h('div', 'sx-row', [this.hoist.el]),
      this.bind('spinPole', 'spinnaker', { label: 'Pole angle', term: 'spinnaker-pole', min: 0, max: 1, ends: ['on the forestay', 'squared back'], format: pct }),
      this.bind('spinPoleHeight', 'spinnaker', { label: 'Pole height', min: 0, max: 1, ends: ['low', 'high'], format: pct }),
      this.bind('spinSheet', 'spinnaker', { label: 'Sheet', term: 'sheet', min: 0, max: 1, ends: ['eased', 'trimmed'], format: pct }),
      h('div', 'sx-ro-row', [spinHoist.el, curl.el, collapse.el]),
      this.spinGroove.el,
    ], true);

    this.hikeSlider = new Slider({
      label: 'Crew weight', term: 'hiking', min: -1, max: 1, bipolar: true, ends: ['port rail', 'stbd rail'],
      format: (v) => (Math.abs(v) < 0.05 ? 'centre' : `${v < 0 ? 'port' : 'stbd'} ${pct(Math.abs(v))}`),
      onInput: (v) => { if (this.hooks.isLive('crewHike')) this.app.controls.crewHike = v; },
    });
    this.hike = new Segmented('Crew hiking', [
      { value: 'auto', label: 'Auto hike', title: 'Crew moves to the high side automatically' },
      { value: 'manual', label: 'Manual', title: 'You place the crew weight' },
    ], (m) => {
      if (!this.hooks.isLive('crewHike')) return;
      const cur = this.app.controls.crewHike;
      this.app.controls.crewHike = m === 'auto' ? 'auto' : typeof cur === 'number' ? cur : (this.snap?.boat.crewHike ?? 0);
    }, 'sx-seg--fill');
    const crew = new Section('Crew', null, [this.hike.el, this.hikeSlider.el]);

    this.el = h('div', { class: 'sx-trim', attrs: { role: 'region', 'aria-label': 'Trim controls' } }, [
      h('header', 'sx-panel-head', [h('h2', { class: 'sx-panel-title', text: 'Trim' }), h('span', { class: 'sx-panel-sub', text: 'W/S main · ↑/↓ jib · Q/Z traveler' })]),
      h('div', 'sx-panel-scroll', [helm.el, main.el, jib.el, this.spinSection.el, crew.el]),
    ]);
    this.refreshLive();
  }

  /** Re-apply which controls the current lesson step leaves live. */
  refreshLive(): void {
    const live = (k: ControlKey) => this.hooks.isLive(k);
    for (const b of this.bound) b.slider.setEnabled(live(b.key));
    this.tiller.setEnabled(live('tiller'));
    this.helmMode.setEnabled(live('helmMode'));
    setDisabled(this.tackBtn, !live('tack'));
    setDisabled(this.gybeBtn, !live('gybe'));
    this.auto.main.setEnabled(live('autoTrim.main'));
    this.auto.jib.setEnabled(live('autoTrim.jib'));
    this.auto.spinnaker.setEnabled(live('autoTrim.spinnaker'));
    this.backJib.setEnabled(live('jibBacked'));
    this.whisker.setEnabled(live('jibWhisker'));
    this.boomPush.setEnabled(live('boomPush'));
    this.hoist.setEnabled(live('spinHoist'));
    this.hike.setEnabled(live('crewHike'));
    this.hikeSlider.setEnabled(live('crewHike'));
  }

  update(snap: SimSnapshot, textTick: boolean): void {
    this.snap = snap;
    const c = this.app.controls;
    // The tiller knob follows every frame so self-centring looks smooth.
    this.tiller.set(c.tiller);
    this.diagram.set(snap.boat.rudder, textTick);
    if (!textTick) return;

    const manual = c.helmMode === 'manual';
    this.helmMode.set(c.helmMode);
    this.manualBox.hidden = !manual;
    this.pilotBox.hidden = manual;
    if (!manual) {
      this.pilotLabel.set(c.helmMode === 'heading' ? 'Hold heading' : c.helmMode === 'twa' ? 'Hold TWA' : 'Hold AWA');
      this.pilotTarget.set(c.helmMode === 'heading' ? fmtHeading(c.helmTarget) : fmtSided(c.helmTarget));
    }
    for (const b of this.bound) {
      b.slider.set(c[b.key]);
      b.slider.setAuto(b.sail !== null && c.autoTrim[b.sail]);
    }
    this.auto.main.set(c.autoTrim.main);
    this.auto.jib.set(c.autoTrim.jib);
    this.auto.spinnaker.set(c.autoTrim.spinnaker);
    this.backJib.set(c.jibBacked);
    this.whisker.set(c.jibWhisker);
    this.boomPush.set(c.boomPush > 0 ? 'port' : c.boomPush < 0 ? 'stbd' : 'off');
    this.hoist.set(c.spinHoist);
    const hikeAuto = c.crewHike === 'auto';
    this.hike.set(hikeAuto ? 'auto' : 'manual');
    this.hikeSlider.set(hikeAuto ? snap.boat.crewHike : (c.crewHike as number));
    this.hikeSlider.setAuto(hikeAuto);
    setClass(this.tackBtn, 'is-busy', snap.maneuver === 'tack');
    setClass(this.gybeBtn, 'is-busy', snap.maneuver === 'gybe');
    // P/S as in the instrument strip: rudder + turns to starboard, leeway + slides to starboard, heel + starboard down.
    this.ro.rudder.set(fmtSided(snap.boat.rudder));
    this.ro.leeway.set(fmtSided(snap.boat.leeway, 1));
    this.ro.heel.set(fmtSided(snap.boat.heel));

    const { main, jib, spinnaker } = snap.sails;
    this.ro.boom.set(fmtSheetAngle(main.boomAngle));
    this.ro.twist.set(fmtAngle(main.twistDeg * DEG));
    const ma = meanAoa(main);
    this.ro.mainAoa.set(ma === null ? '—' : fmtAngle(ma));
    this.mainGroove.set(main);
    this.mainTT.set(sortedTelltales(main.telltales, 'leech'));
    this.ro.clew.set(jib.furl > 0.98 ? 'furled' : fmtSheetAngle(jib.clewAngle));
    const ja = meanAoa(jib);
    this.ro.jibAoa.set(ja === null || !jib.set ? '—' : fmtAngle(ja));
    this.jibGroove.set(jib);
    const windward = snap.wind.awa >= 0 ? 'stbd' : 'port';
    this.jibWindward.set(sortedTelltales(jib.telltales, windward));
    this.jibLeeward.set(sortedTelltales(jib.telltales, windward === 'stbd' ? 'port' : 'stbd'));

    const up = spinnaker.hoist > 0.02;
    if (up && !this.spinWasUp) this.spinSection.setCollapsed(false);
    this.spinWasUp = up;
    this.ro.spinHoist.set(pct(spinnaker.hoist));
    this.ro.curl.set(up ? pct(spinnaker.curl) : '—');
    this.ro.collapse.set(!up ? '—' : spinnaker.collapsed > 0.5 ? 'collapsed' : spinnaker.collapsed > 0.1 ? 'folding' : 'full');
    this.spinGroove.set(spinnaker);
  }

  private bind(key: NumKey, sail: Sail | null, o: { label: string; term?: string; min: number; max: number; bipolar?: boolean; ends?: [string, string]; format?: (v: number) => string }): HTMLElement {
    const slider = new Slider({
      ...o,
      step: 0.01,
      onGrab: () => takeManual(this.app, this.hooks, sail),
      onInput: (v) => {
        if (!this.hooks.isLive(key)) return;
        this.app.controls[key] = v;
      },
    });
    this.bound.push({ key, slider, sail });
    return slider.el;
  }

  private setHelmMode(m: 'manual' | 'heading' | 'twa' | 'awa'): void {
    if (!this.hooks.isLive('helmMode')) return;
    const c = this.app.controls;
    if (c.helmMode === m) return;
    // Start the autopilot on the current value so the boat does not swerve.
    const s = this.snap;
    if (s) c.helmTarget = m === 'heading' ? s.boat.heading : m === 'twa' ? s.wind.twa : m === 'awa' ? s.wind.awa : c.helmTarget;
    c.helmMode = m;
    if (m === 'manual') c.tiller = 0;
  }

  private nudge(dir: -1 | 1): void {
    if (this.hooks.isLive('helmTarget')) nudgeHelmTarget(this.app.controls, dir, AUTOPILOT_STEP);
  }
}

/** Telltales of one side, top of the sail first (body z is down, so the most negative z is highest). */
function sortedTelltales(all: readonly Telltale[], side: Telltale['side']): Telltale[] {
  return all.filter((t) => t.side === side).sort((a, b) => a.pos.z - b.pos.z);
}

// ---- phones: on-screen tiller and sheet sliders ------------------------------------------------------

export class TouchDeck {
  readonly el: HTMLElement;
  private readonly tiller: Slider;
  private readonly sheets: { key: 'mainSheet' | 'jibSheet' | 'spinSheet'; sail: Sail; slider: Slider }[] = [];
  private readonly spinBox: HTMLElement;
  private readonly tackBtn: HTMLButtonElement;
  private readonly gybeBtn: HTMLButtonElement;

  constructor(private readonly app: AppApi, private readonly hooks: TrimHooks) {
    this.tiller = new Slider({
      label: 'Tiller', min: -1, max: 1, step: 0.01, bipolar: true, ends: ['◀ port', 'stbd ▶'],
      ariaText: (v) => `Helm ${tillerText(v)}`,
      onInput: (v) => this.hooks.holdTiller(v),
      onGrab: () => this.hooks.holdTiller(this.app.controls.tiller),
      onRelease: () => this.hooks.holdTiller(null),
    });
    const sheet = (key: 'mainSheet' | 'jibSheet' | 'spinSheet', sail: Sail, label: string) => {
      const slider = new Slider({
        label, min: 0, max: 1, step: 0.01, vertical: true, format: pct,
        onGrab: () => takeManual(this.app, this.hooks, sail),
        onInput: (v) => { if (this.hooks.isLive(key)) this.app.controls[key] = v; },
      });
      this.sheets.push({ key, sail, slider });
      return slider.el;
    };
    this.spinBox = h('div', 'sx-touch-spin', [sheet('spinSheet', 'spinnaker', 'Spin')]);
    this.tackBtn = button('Tack', { class: 'sx-btn--action', onClick: () => { if (this.hooks.isLive('tack')) this.app.controls.command = 'tack'; } });
    this.gybeBtn = button('Gybe', { class: 'sx-btn--action', onClick: () => { if (this.hooks.isLive('gybe')) this.app.controls.command = 'gybe'; } });
    this.el = h('div', { class: 'sx-touch', attrs: { role: 'region', 'aria-label': 'Touch controls' } }, [
      h('div', 'sx-touch-sheets sx-glass', [sheet('mainSheet', 'main', 'Main'), sheet('jibSheet', 'jib', 'Jib'), this.spinBox]),
      h('div', 'sx-touch-helm sx-glass', [this.tiller.el, h('div', 'sx-touch-btns', [this.tackBtn, this.gybeBtn])]),
    ]);
    this.refreshLive();
  }

  refreshLive(): void {
    this.tiller.setEnabled(this.hooks.isLive('tiller'));
    for (const s of this.sheets) s.slider.setEnabled(this.hooks.isLive(s.key));
    setDisabled(this.tackBtn, !this.hooks.isLive('tack'));
    setDisabled(this.gybeBtn, !this.hooks.isLive('gybe'));
  }

  update(snap: SimSnapshot, textTick: boolean): void {
    const c = this.app.controls;
    this.tiller.set(c.tiller);
    if (!textTick) return;
    for (const s of this.sheets) {
      s.slider.set(c[s.key]);
      s.slider.setAuto(c.autoTrim[s.sail]);
    }
    this.spinBox.hidden = snap.sails.spinnaker.hoist < 0.02 && !c.spinHoist;
  }
}
