// Lesson 11 — Tacking (spec §11.2): the sequence and calls, keeping momentum. Task: three tacks keeping at
// least 60 % of the entry speed.
import type { Lesson, LessonCtx } from '../types';
import { absTwa, fmt, holdTwa, mem, polarSpeed, sailing, speedKn, step, TackWatch, twsKn, upKey, view, type TackResult } from './helpers';

const TACKS = 3;
const KEEP = 0.6;
/** Close-hauled for this lesson (deg TWA). A crew tack from here at full speed keeps 66–71 % of its speed in 12 kn. */
const CLOSE_HAULED = 45;
/** Above this (deg TWA) the boat is reaching: the turn is longer and a tack keeps too little (≈ 55 % from 53°). */
const TOO_LOW = 50;

interface TackLog { watch: TackWatch; good: number; last: TackResult | null }
const log = (c: LessonCtx): TackLog => mem(c, 'tacks', () => ({ watch: new TackWatch(), good: 0, last: null }));

export const tacking: Lesson = {
  id: 'tacking',
  module: 'Manoeuvres',
  title: 'Tacking',
  summary: 'Turn the bow through the wind from one tack to the other without losing your speed.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 12, twa: 45 })),
  steps: [
    step({
      title: 'The tack',
      body: `<p>To get upwind you zigzag, and every corner of the zigzag is a [[tack]]: the bow turns through the wind until it blows over the other side.</p>
<p>The helmsman calls <em>"Ready about!"</em>; the crew gets the jib sheets ready and answers <em>"Ready!"</em>. On <em>"Lee-oh!"</em> the helmsman turns toward the wind. As the bow passes through it the jib flaps across: the crew lets the old sheet go and pulls the new one in, and the boom swings over — heads down. The boat settles close-hauled on the new tack. The line behind the boat is your track: every tack adds a corner to the zigzag.</p>`,
      camera: 'chase',
      overlays: view('track'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'Keep your speed',
      body: `<p>While the bow is in the no-go zone nothing drives the boat: she coasts on her momentum. So go into the tack at full speed — never while pinching — and turn at a steady rate. Too fast, and the rudder, hard over, acts as a brake. Too slow, and the boat stops head to wind: she is [[in-irons]].</p>
<p>After the tack, sail a little lower for a moment and let the boat pick up speed before pointing high again.</p>`,
      camera: 'chase',
      overlays: view('track'),
      controls: ['helm'],
    }),
    step({
      title: 'Three good tacks',
      body: `<p>Tack three times, keeping at least ${KEEP * 100} % of your speed through each one. Press <kbd>T</kbd> and the crew tacks with you — or steer through the wind yourself with the tiller (the crew still handles the jib). After each tack the boat sails a little low while she picks up speed: wait until she is back up to close-hauled and at full speed before the next one. From a reach the turn is longer, and you lose more.</p>`,
      camera: 'chase',
      overlays: view('track', 'wheel'),
      controls: ['helm', 'manoeuvres'],
      autoTrim: { main: true, jib: true },
      task: {
        label: `${TACKS} tacks, each keeping at least ${KEEP * 100} % of the entry speed`,
        check: (c) => {
          const l = log(c);
          const r = l.watch.update(c.snap);
          if (r) {
            l.last = r;
            if (r.ratio >= KEEP) l.good++;
          }
          return Math.min(1, l.good / TACKS);
        },
      },
      hint: (c) => {
        const s = c.snap;
        const l = log(c);
        if (s.maneuver === 'tack') return null;
        if (l.last && l.last.ratio < KEEP) {
          return `That tack kept only ${fmt(l.last.ratio * 100, 0)} % of your speed (${fmt(l.last.entry)} → ${fmt(l.last.min)} kn). Build full speed first, then turn steadily.`;
        }
        if (absTwa(s) > TOO_LOW) return `Head up to close-hauled (about ${CLOSE_HAULED}°) with ${upKey(s)} before you tack: from a reach the turn is longer and you lose more speed.`;
        const target = polarSpeed(twsKn(s), absTwa(s));
        if (speedKn(s) < 0.9 * target) return `Wait for full speed (about ${fmt(target)} kn) before the next tack.`;
        return `Ready about: press T. Tacks so far: ${l.good} of ${TACKS}.`;
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true });
        holdTwa(c, CLOSE_HAULED);
        // Tack only from close-hauled at full speed. After each tack the boat sails a little low while she picks up
        // speed; tacking again from there turns further and loses more, so wait until she is back on the wind.
        return (cc) => {
          const s = cc.snap;
          if (s.maneuver !== null) return;
          holdTwa(cc, CLOSE_HAULED);
          const onTheWind = Math.abs(absTwa(s) - CLOSE_HAULED) < 2;
          if (onTheWind && speedKn(s) >= 0.95 * polarSpeed(twsKn(s), CLOSE_HAULED)) cc.app.controls.command = 'tack';
        };
      },
    }),
    step({
      title: 'When a tack goes wrong',
      body: `<p>If you turn too slowly, or start without speed, the boat stops with her bow in the wind and the sails flapping — in irons. She drifts backwards and the rudder stops working as you expect. The next lesson shows how to get out.</p>`,
      camera: 'chase',
      overlays: view('track'),
    }),
  ],
  quiz: [
    {
      q: 'What drives the boat while her bow turns through the no-go zone?',
      options: ['The sails', 'Only her momentum', 'The rudder'],
      correct: 1,
      why: 'Head to wind the sails cannot drive; she coasts on the speed she carried into the tack.',
    },
    {
      q: 'Why not slam the tiller hard over to tack as fast as possible?',
      options: ['It damages the rudder', 'A rudder hard over acts as a brake', 'The jib cannot cross'],
      correct: 1,
      why: 'At large angles the rudder mostly drags — a steady turn keeps more speed.',
    },
  ],
};
