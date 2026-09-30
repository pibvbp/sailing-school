// Lesson 2 — Finding the wind (spec §11.2): reading the water, clouds, flags and the windex; head to wind;
// the no-go zone.
import type { Lesson } from '../types';
import { absTwa, downKey, fmt, holdTwa, manualHelm, sailAway, sailing, speedKn, step, trimOf, twaDeg, upKey, view } from './helpers';

export const findingTheWind: Lesson = {
  id: 'finding-the-wind',
  module: 'First steps',
  title: 'Finding the wind',
  summary: 'Read the wind from the water, the sky and the boat, meet the no-go zone, and point head to wind.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 60, gustiness: 0.25, seed: 3 })),
  steps: [
    step({
      title: 'Where is the wind coming from?',
      body: `<p>Everything in sailing starts with the wind's direction, so learn to read it. Small waves and ripples march across the water with the wind. Darker, rougher patches are [[gust|gusts]] sweeping downwind; low clouds drift with the wind too, and flags stream away from it.</p>
<p>On board, the arrow at the masthead — the [[windex]] — points into the wind, toward where it comes from. On the wind dial the blue marker shows the true wind and the amber needle the wind you feel; lesson 4 explains why those two differ once you move.</p>`,
      camera: 'chase',
      overlays: view('flow'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'The no-go zone',
      body: `<p>No sailboat can sail straight into the wind. Within about 40–45° either side of it — the [[no-go-zone]] — the sails just flap and the boat stops.</p>
<p>The ring on the water is the [[points-of-sail]] wheel (key <kbd>P</kbd>). It is lined up with the true wind, and its no-go sector sits right on the wind. The marker shows where your bow points.</p>`,
      camera: 'top',
      overlays: view('wheel'),
      controls: ['helm'],
    }),
    step({
      title: 'Head to wind',
      body: `<p>Take the helm and turn toward the wind until the bow points straight into it — [[head-to-wind]]. The wind is on your starboard side, so turn to starboard with <kbd>→</kbd>.</p>
<p>Watch the sails start to flap along their [[luff]] and the boat slow down. Hold the bow there for 3 seconds.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
      onEnter: manualHelm,
      task: {
        label: 'Point head to wind (true wind angle within 10°) for 3 s',
        holdSeconds: 3,
        check: (c) => absTwa(c.snap) < 10,
      },
      hint: (c) => {
        const s = c.snap;
        const a = absTwa(s);
        if (a < 10) return null;
        const side = twaDeg(s) > 0 ? 'starboard' : 'port';
        if (speedKn(s) < 0.4 && a < 30) return 'You have almost stopped, so the rudder has little grip. Hold the tiller over and let the wind swing the bow, or press Show me.';
        return `The wind is still ${fmt(a, 0)}° off the bow on the ${side} side. Keep turning toward it with ${upKey(s)}, then centre the tiller as the sails start to flap.`;
      },
      showMe: (c) => holdTwa(c, 0),
    }),
    step({
      title: 'Bear away until the sails fill',
      body: `<p>Pointing into the wind you are losing speed and will soon drift backwards. Turn away from the wind — [[bearing-away|bear away]] — to either side, until the sails stop flapping and fill, and the boat speeds up again.</p>
<p>The crew trims the sails for you as soon as they can draw.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm', 'jibBacked'],
      onEnter: manualHelm,
      task: {
        label: 'Bear away out of the no-go zone until the sails fill and you reach 2.5 kn',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          return absTwa(s) >= 50 && speedKn(s) >= 2.5 && trimOf(s.sails.main).luffing <= 0.35 && trimOf(s.sails.jib).luffing <= 0.35;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const a = absTwa(s);
        if (a < 30 && speedKn(s) < 0.4) return 'You are stuck head to wind — [[in-irons]]. Switch on Back jib in the trim panel: the wind pushes the jib and swings the bow off. Lesson 12 covers this in detail.';
        if (a < 50) return `Keep turning away from the wind with ${downKey(s)} — the sails cannot fill inside the no-go zone.`;
        if (speedKn(s) < 2.5) return 'Good angle. Hold your course while the boat picks up speed.';
        return null;
      },
      showMe: () => sailAway(65),
    }),
  ],
  quiz: [
    {
      q: 'Which way does the windex at the masthead point?',
      options: ['Downwind, like a flag', 'Into the wind — toward where it comes from', 'Always along the boat'],
      correct: 1,
      why: 'Its arrow points into the wind; the tail vane trails downwind.',
    },
    {
      q: 'Roughly how close to the wind can a sailboat sail?',
      options: ['Straight into it', 'About 40–45° off it', 'No closer than 90°'],
      correct: 1,
      why: 'Inside the [[no-go-zone]] the sails cannot hold their shape; about 40–45° off the wind is as close as a boat like this drives well.',
    },
    {
      q: 'Dark patches moving across the water are usually…',
      options: ['shallow water', 'gusts — stronger wind', 'lulls — lighter wind'],
      correct: 1,
      why: 'Stronger wind roughens the surface so it reflects less sky and looks darker — a [[gust]] on its way.',
    },
  ],
};
