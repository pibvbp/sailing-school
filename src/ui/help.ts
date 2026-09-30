// Help (`?`): the keyboard map (spec §3.3), mouse/touch notes, the colour language used everywhere,
// and the searchable glossary.
import { GLOSSARY } from '../lessons/glossary';
import { h, Modal, notNull } from './dom';

export const KEYMAP: readonly [keys: string[], action: string][] = [
  [['←', '→'], 'Steer: bow to port / to starboard — hold to turn, release to centre'],
  [['A', 'D'], 'Steer (alternative keys)'],
  [['Shift'], 'Hold for fine control'],
  [['W', 'S'], 'Mainsheet: trim / ease'],
  [['↑', '↓'], 'Jib sheet: trim / ease'],
  [['Q', 'Z'], 'Traveler: to windward / to leeward'],
  [['I', 'K'], 'Spinnaker sheet: trim / ease'],
  [['J', 'L'], 'Spinnaker pole: forward / aft'],
  [['T'], 'Tack (the crew handles the sails)'],
  [['G'], 'Gybe'],
  [['H'], 'Hoist / douse the spinnaker'],
  [['F'], 'Furl / unfurl the jib'],
  [['1', '2', '3', '4', '5'], 'Camera: chase, helm, top, sail view, free'],
  [['C'], 'Next camera'],
  [['V'], 'Force vectors'],
  [['O'], 'Airflow'],
  [['P'], 'Points-of-sail wheel'],
  [['Space'], 'Pause'],
  [[',', '.'], 'Slow motion: slower / faster (0.25× – 2×)'],
  [['?'], 'This help'],
  [['Esc'], 'Menu, or close what is open'],
];

const COLOURS: readonly [cls: string, label: string][] = [
  ['is-port', 'Port (left) — red telltales and lights'],
  ['is-stbd', 'Starboard (right) — green'],
  ['is-tw', 'True wind'],
  ['is-aw', 'Apparent wind — what the sails feel'],
  ['is-luff', 'Sail luffing — angle of attack too small'],
  ['is-ok', 'In the groove'],
  ['is-stall', 'Stalled — angle of attack too big'],
];

export class HelpDialog {
  readonly modal: Modal;

  constructor(host: HTMLElement) {
    this.modal = new Modal(host, 'How to sail this boat', 'sx-help');
    const keys = h('dl', 'sx-keys', KEYMAP.flatMap(([ks, action]) => [
      h('dt', {}, ks.flatMap((k, i) => [i > 0 ? h('span', { class: 'sx-key-sep', text: '/' }) : null, h('kbd', { text: k })]).filter(notNull)),
      h('dd', { text: action }),
    ]));
    const colours = h('ul', 'sx-legend', COLOURS.map(([cls, label]) => h('li', {}, [h('span', `sx-swatch ${cls}`), h('span', { text: label })])));
    const list = h('dl', 'sx-gloss-list');
    const filter = h('input', { class: 'sx-input', attrs: { type: 'search', placeholder: 'Filter terms…', 'aria-label': 'Filter glossary' } });
    const entries = [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term));
    const renderList = () => {
      const q = filter.value.trim().toLowerCase();
      list.replaceChildren(...entries
        .filter((g) => !q || g.term.toLowerCase().includes(q) || g.def.toLowerCase().includes(q))
        .flatMap((g) => [h('dt', { text: g.term }), h('dd', { text: g.def })]));
    };
    filter.addEventListener('input', renderList);
    renderList();
    this.modal.body.append(h('div', 'sx-help-grid', [
      h('section', 'sx-set', [h('h3', { class: 'sx-set-title', text: 'Keyboard' }), keys]),
      h('div', 'sx-set-col', [
        h('section', 'sx-set', [
          h('h3', { class: 'sx-set-title', text: 'Mouse & touch' }),
          h('p', { class: 'sx-help-p', text: 'Every control in the trim panel works with the mouse. In the free camera, drag to orbit and scroll or pinch to zoom. On a phone, steer with the tiller slider at the bottom and trim with the sheet sliders on the right; the Lesson, Trim and View buttons open the panels.' }),
        ]),
        h('section', 'sx-set', [h('h3', { class: 'sx-set-title', text: 'Colours' }), colours]),
        h('section', 'sx-set', [h('h3', { class: 'sx-set-title', text: 'Glossary' }), filter, list]),
      ]),
    ]));
  }

  toggle(): void { this.modal.toggle(); }
  show(): void { this.modal.show(); }
  close(): void { this.modal.close(); }
  get open(): boolean { return this.modal.open; }
}
