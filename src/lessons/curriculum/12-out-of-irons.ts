// Lesson 12 — Getting out of irons (spec §11.2): starts stuck head to wind; back the jib, steer in reverse
// while drifting astern, then sail away. Task: sailing again at ≥ 2 kn.
import type { Lesson } from '../types';
import { absTwa, autoTrim, fmt, sailAway, sailing, speedKn, step, view } from './helpers';

const RELEASE_TWA = 50;

export const outOfIrons: Lesson = {
  id: 'out-of-irons',
  module: 'Manoeuvres',
  title: 'Getting out of irons',
  summary: 'Stuck head to wind and drifting backwards? Back the jib, steer in reverse, and sail away.',
  setup: (c) => c.app.scenario(sailing({
    twsKn: 10, twa: 2, speedKn: -0.3, helm: 'manual',
    controls: { autoTrim: autoTrim(true, true, false) },
  })),
  steps: [
    step({
      title: 'In irons',
      body: `<p>The boat has stopped with her bow pointing into the wind: she is [[in-irons]]. The sails flap, nothing drives her, and the wind on the hull and rig is pushing her backwards — she has [[sternway]].</p>
<p>The rudder only steers when water flows past it, and going backwards it works in reverse. Waiting helps little: sooner or later the bow falls off to one side, but you can make it happen at once.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: [],
    }),
    step({
      title: 'Back the jib',
      body: `<p>Switch on <strong>Back jib</strong> in the trim panel: the crew holds the jib out on the side it is on. The wind now presses on its back and pushes the bow away from that side.</p>
<p>Help with the rudder. You are drifting backwards, so steering is reversed: the key that normally turns the bow one way now turns it the other. With the jib held out to port the bow swings to starboard, so hold <kbd>←</kbd>; with it held out to starboard, hold <kbd>→</kbd>. Keep going until the wind is well round on the side, about ${RELEASE_TWA}° off the bow.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm', 'jibBacked'],
      task: {
        label: `Back the jib until the bow is ${RELEASE_TWA}° off the wind`,
        holdSeconds: 0.5,
        check: (c) => c.app.controls.jibBacked && absTwa(c.snap) >= RELEASE_TWA,
      },
      hint: (c) => {
        const s = c.snap;
        if (!c.app.controls.jibBacked) {
          return absTwa(s) >= RELEASE_TWA
            ? 'The bow fell off by itself. Now practise the real thing: switch on Back jib in the trim panel.'
            : 'Switch on Back jib in the trim panel (Jib section).';
        }
        if (absTwa(s) >= RELEASE_TWA) return null;
        const clew = s.sails.jib.clewAngle > 0 ? 'port' : 'starboard';
        const bow = clew === 'port' ? 'starboard' : 'port';
        const key = bow === 'starboard' ? '←' : '→';
        if (s.boat.u < -0.05) return `The jib is held out to ${clew}, so the bow swings to ${bow}. You are drifting backwards: hold ${key} to help it round (${fmt(absTwa(s), 0)}° off the wind so far).`;
        return `The jib is pushing the bow to ${bow} — ${fmt(absTwa(s), 0)}° off the wind so far.`;
      },
      showMe: () => sailAway(60, { releaseAt: RELEASE_TWA + 8 }),
    }),
    step({
      title: 'Sail away',
      body: `<p>Now let the jib go: switch <strong>Back jib</strong> off, and the crew sheets it in on the proper side. Steer onto a close reach, about 60° off the wind, and let the boat pick up speed. Once water flows past the rudder it steers the normal way again.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm', 'jibBacked', 'main', 'jib'],
      onEnter: (c) => { c.app.controls.tiller = 0; },
      task: {
        label: 'Sailing again at 2 kn or more, with the jib drawing normally',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          const a = absTwa(s);
          return !c.app.controls.jibBacked && !s.sails.jib.backed && a >= 40 && a <= 150 && speedKn(s) >= 2;
        },
      },
      hint: (c) => {
        const s = c.snap;
        if (c.app.controls.jibBacked) return 'Switch Back jib off now, or the jib keeps pushing the bow round.';
        if (absTwa(s) < 40) return 'You have turned back toward the wind. Steer away from it until the sails fill.';
        if (speedKn(s) < 2) return `${fmt(speedKn(s))} kn — hold a close reach and let her accelerate.`;
        return null;
      },
      showMe: () => sailAway(60, { releaseAt: 0 }),
    }),
  ],
  quiz: [
    {
      q: 'In irons and drifting backwards, the rudder…',
      options: ['works as usual', 'works in reverse', 'does nothing at all'],
      correct: 1,
      why: 'With the water flowing past it from behind, the rudder turns the boat the opposite way.',
    },
    {
      q: 'The jib is held out (backed) on the port side. Which way does the bow turn?',
      options: ['To port', 'To starboard'],
      correct: 1,
      why: 'The wind presses on the back of the jib and pushes the bow away from the side it is held on.',
    },
  ],
};
