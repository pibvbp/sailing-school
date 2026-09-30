// Lesson 16 — Spinnaker: reaching to running (spec §11.2): pole and sheet through course changes; collapse
// and broach risk. Task: broad reach → run → broad reach without a collapse.
import type { Lesson, LessonCtx } from '../types';
import {
  absTwa, autoTrim, downKey, fmt, frameDt, hasEvent, holdTwa, kiteOf, mem, pilotTwa, sailing, step, tackOf, upKey, view,
} from './helpers';

interface Leg { name: string; lo: number; hi: number; hold: number; steer: number }
const LEGS: readonly Leg[] = [
  { name: 'broad reach', lo: 115, hi: 140, hold: 3, steer: 128 },
  { name: 'run', lo: 160, hi: 180, hold: 5, steer: 168 },
  { name: 'broad reach', lo: 115, hi: 140, hold: 5, steer: 128 },
];

interface Progress { leg: number; held: number; collapses: number }
const progress = (c: LessonCtx): Progress => mem(c, 'legs', () => ({ leg: 0, held: 0, collapses: 0 }));

export const spinnakerReachingRunning: Lesson = {
  id: 'spinnaker-reaching-running',
  module: 'Spinnaker',
  title: 'Spinnaker: reaching to running',
  summary: 'Keep the spinnaker flying while you change course — and learn why it can knock you flat on a windy reach.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 125, spinnaker: true, controls: { autoTrim: autoTrim(true, true, true) } })),
  steps: [
    step({
      title: 'Changing course under spinnaker',
      body: `<p>Every course change moves the apparent wind, so the pole and the sheet have to follow:</p>
<ul><li><strong>Bearing away</strong> (the wind moves aft): square the pole back (<kbd>L</kbd>) and ease the sheet (<kbd>K</kbd>).</li>
<li><strong>Heading up</strong> (the wind moves forward): bring the pole forward (<kbd>J</kbd>) and trim the sheet (<kbd>I</kbd>) — at once, or the luff folds and the spinnaker collapses.</li></ul>
<p>Turn smoothly, so the trimmer can keep up.</p>`,
      camera: 'chase',
      overlays: view('windTriangle'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true, spinnaker: true },
    }),
    step({
      title: 'Reach, run, reach',
      body: `<p>Now you trim. Sail a broad reach, bear away to a run, then head back up to a broad reach — without letting the spinnaker collapse. Keep the curl in the luff as your guide: ease until it curls, trim a touch.</p>`,
      camera: 'chase',
      overlays: view('windTriangle', 'wheel'),
      controls: ['helm', 'spinPole', 'spinPoleHeight', 'spinSheet'],
      autoTrim: { spinnaker: false },
      task: {
        label: 'Broad reach → run → broad reach, with the spinnaker full all the way',
        check: (c) => {
          const s = c.snap;
          const p = progress(c);
          const dt = frameDt(c, 'legDt');
          const kite = kiteOf(s);
          if (hasEvent(s, 'spinCollapse') || kite.collapsed > 0.5) {
            if (p.leg > 0 || p.held > 0) p.collapses++;
            p.leg = 0;
            p.held = 0;
          }
          if (p.leg >= LEGS.length) return 1;
          const leg = LEGS[p.leg]!;
          const a = absTwa(s);
          if (a >= leg.lo && a <= leg.hi && kite.full) {
            p.held += dt;
            if (p.held >= leg.hold) { p.leg++; p.held = 0; }
          } else {
            p.held = 0;
          }
          return Math.min(1, (p.leg + Math.min(1, p.held / leg.hold)) / LEGS.length);
        },
      },
      hint: (c) => {
        const s = c.snap;
        const p = progress(c);
        const kite = kiteOf(s);
        if (!kite.up) return 'The spinnaker is down — press H to hoist it.';
        if (kite.collapsed > 0.05) return 'It collapsed! Trim the sheet in hard with I until it refills, then start again from a broad reach.';
        if (p.leg >= LEGS.length) return null;
        const leg = LEGS[p.leg]!;
        const a = absTwa(s);
        if (a < leg.lo) return `Bear away to a ${leg.name} with ${downKey(s)}: square the pole back (L) and ease the sheet (K) as you turn.`;
        if (a > leg.hi) return `Head up to a ${leg.name} with ${upKey(s)}: bring the pole forward (J) and trim the sheet (I) as you turn.`;
        return `Hold the ${leg.name} (${fmt(a, 0)}°) and keep the luff just curling.`;
      },
      showMe: (c) => {
        c.app.controls.autoTrim.spinnaker = true;
        holdTwa(c, LEGS[0]!.steer);
        // Steer the legs smoothly (4°/s) while the crew trims pole and sheet.
        return (cc) => {
          const p = progress(cc);
          const leg = LEGS[Math.min(p.leg, LEGS.length - 1)]!;
          const now = Math.abs(pilotTwa(cc) ?? leg.steer);
          const inc = 4 * frameDt(cc, 'steerDt');
          const next = now + Math.max(-inc, Math.min(inc, leg.steer - now));
          holdTwa(cc, next, tackOf(cc.snap));
        };
      },
    }),
    step({
      title: 'Broaching',
      body: `<p>Watch what can happen on a reach in a fresh breeze. It is blowing 20 knots, the boat is on a reach and the spinnaker is pulled in hard. The spinnaker's force heels her far over; as she heels, weather helm builds until the rudder, half out of the water, loses its grip — and she spins up into the wind with the sails flogging. That is a [[round-up|broach]].</p>
<p>Nobody steers into a broach on purpose: the gust does it for you.</p>`,
      camera: 'chase',
      overlays: view('forces'),
      controls: [],
      onEnter: (c) => c.app.scenario(sailing({
        twsKn: 20, twa: 105, spinnaker: true, speedKn: 6,
        controls: { mainSheet: 0.9, spinSheet: 0.85, spinPole: 0.1, autoTrim: autoTrim(false, true, false) },
      })),
      hint: (c) => (hasEvent(c.snap, 'roundUp') ? 'There it goes: too much heel, and the rudder lost its grip.' : null),
    }),
    step({
      title: 'Staying in control',
      body: `<p>To keep a spinnaker under control in a breeze: ease the spinnaker sheet and the mainsheet the moment a gust heels you; bear away with the gust rather than fighting it; keep the boat as upright as you can; and do not carry the spinnaker too close to the wind. If the wind is getting too strong, [[douse]] it early — the next lesson shows how.</p>`,
      camera: 'chase',
      overlays: view(),
      onEnter: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 135, spinnaker: true, controls: { autoTrim: autoTrim(true, true, true) } })),
    }),
  ],
  quiz: [
    {
      q: 'You head up from a run to a broad reach under spinnaker. What must the trimmer do?',
      options: ['Ease the sheet and square the pole back', 'Trim the sheet and bring the pole forward', 'Nothing'],
      correct: 1,
      why: 'The apparent wind moves forward: without trimming, the luff folds and the spinnaker collapses.',
    },
    {
      q: 'What makes a boat broach?',
      options: ['Too little sail', 'So much heel that the rudder loses its grip', 'Sailing dead downwind in light air'],
      correct: 1,
      why: 'Heel builds weather helm and lifts the rudder until it can no longer hold the boat.',
    },
  ],
};
