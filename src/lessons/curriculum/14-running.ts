// Lesson 14 — Running and wing-on-wing (spec §11.2): blanketing, the by-the-lee danger, the whisker pole.
// Task: 30 s dead downwind with the jib full.
import type { SimSnapshot } from '../../sim/types';
import { RHO_AIR } from '../../sim/sails/common';
import type { Lesson } from '../types';
import { absTwa, byTheLee, downKey, fmt, holdTwa, sailing, step, tackOf, trimOf, view } from './helpers';

/** A very broad reach, almost a run: where the lesson starts, and where the wing-on-wing task starts. */
const BROAD_TWA = 158;

/** The jib's clew is held out on the windward side, opposite the main. */
const jibPoledOut = (s: SimSnapshot): boolean => {
  const j = s.sails.jib;
  return j.whisker && Math.sign(j.clewAngle) === -tackOf(s) && Math.abs(j.clewAngle) > 0.7;
};

/**
 * How much wind the jib gets compared with the free apparent wind at mid-height (0…1): about 1 in clear air,
 * much less in the main's wind shadow.
 */
export function jibExposure(s: SimSnapshot): number {
  const secs = s.sails.jib.sections;
  if (!secs.length) return 0;
  const q = secs.reduce((a, x) => a + x.q, 0) / secs.length;
  const aws = (s.wind.aws + s.wind.awsDeck) / 2;
  const qFree = 0.5 * RHO_AIR * aws * aws;
  return qFree > 1e-3 ? q / qFree : 0;
}

const jibFull = (s: SimSnapshot): boolean => jibExposure(s) >= 0.5 && trimOf(s.sails.jib).luffing <= 0.35;

/** Key that turns the bow away from the boom's side (back out of a by-the-lee). */
const awayFromBoom = (s: SimSnapshot): '→' | '←' => (s.sails.main.boomAngle > 0 ? '→' : '←');

export const running: Lesson = {
  id: 'running',
  module: 'Manoeuvres',
  title: 'Running and wing-on-wing',
  summary: 'Sailing dead downwind: the wind shadow, the danger of sailing by the lee, and the whisker pole.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: BROAD_TWA })),
  steps: [
    step({
      title: 'Running',
      body: `<p>You are on a very broad reach, the wind almost behind you; a little further and you would be on a [[run]]. Down here the sails no longer work as wings: the air hits them and they are pushed along, like a parachute. The boat also runs away from her own wind, so the apparent wind is light and the ride feels calm.</p>
<p>Look at the jib. It hangs half-limp in the mainsail's wind shadow — the main is [[blanketing]] it — and dead downwind it would collapse completely, so almost half of your sail area does very little. The flow streaks show the slow, stirred-up air behind the main.</p>`,
      camera: 'chase',
      overlays: view('flow'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'Beware the lee',
      body: `<p>Keep the wind on the side <em>opposite</em> the boom. If you steer too far, the wind comes over the same side as the boom: you are sailing [[by-the-lee]]. A little further and the wind gets behind the mainsail and throws the boom across — an accidental [[gybe]].</p>
<p>Watch the windex and the wind dial, and stay a few degrees on the safe side of dead downwind.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
    }),
    step({
      title: 'Pole out the jib',
      body: `<p>Get the jib out of the wind shadow by setting it on the other side of the boat — [[wing-on-wing]]. Switch on <strong>Whisker pole</strong> in the trim panel: the crew clips the [[whisker-pole|whisker pole]] onto the jib's [[clew]] and pushes it out to windward, opposite the main.</p>`,
      camera: 'chase',
      overlays: view('flow'),
      controls: ['helm', 'jibWhisker'],
      task: {
        label: 'Pole the jib out to windward with the whisker pole',
        holdSeconds: 1,
        check: (c) => c.app.controls.jibWhisker && jibPoledOut(c.snap) && absTwa(c.snap) >= 150,
      },
      hint: (c) => (c.app.controls.jibWhisker ? null : 'Switch on Whisker pole in the Jib section of the trim panel.'),
      showMe: (c) => { c.app.controls.jibWhisker = true; },
    }),
    step({
      title: 'Wing-on-wing',
      body: `<p>Now both sails catch the wind: the main out on one side, the jib poled out on the other. The autopilot still holds the broad reach; steer down yourself — <kbd>←</kbd>/<kbd>→</kbd> turn the bow, or take the tiller — to as close to dead downwind as you safely can: a true wind angle of 165–180°, never by the lee. Hold it for 30 seconds with the jib full.</p>`,
      camera: 'chase',
      overlays: view('flow', 'wheel'),
      controls: ['helm', 'jibWhisker'],
      // The task starts from the broad reach, whether or not the learner has already been down to a run.
      onEnter: (c) => holdTwa(c, BROAD_TWA),
      task: {
        label: 'Dead downwind (165–180°, not by the lee) with the jib full, for 30 s',
        holdSeconds: 30,
        check: (c) => {
          const s = c.snap;
          return absTwa(s) >= 165 && !byTheLee(s) && jibPoledOut(s) && jibFull(s);
        },
      },
      hint: (c) => {
        const s = c.snap;
        if (byTheLee(s)) return `You are by the lee! Steer back with ${awayFromBoom(s)} so the wind comes from the side opposite the boom.`;
        if (!c.app.controls.jibWhisker) return 'Switch the whisker pole back on to hold the jib out to windward.';
        if (absTwa(s) < 165) return `Bear away toward dead downwind with ${downKey(s)} (true wind angle ${fmt(absTwa(s), 0)}°).`;
        if (!jibFull(s)) return 'The jib is still in the main’s shadow — keep it poled out on the side opposite the boom.';
        return null;
      },
      showMe: (c) => {
        c.app.controls.jibWhisker = true;
        holdTwa(c, 172);
      },
    }),
    step({
      title: 'Straight downwind is not always fastest',
      body: `<p>A run is the shortest way downwind, but not always the quickest. With the wind from behind, your speed subtracts from it, and in light air a broad reach — with its stronger apparent wind — can be so much faster that zigzagging downwind, gybing from one broad reach to the other, gets you there sooner. Lesson 18 shows how to tell.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
    }),
  ],
  quiz: [
    {
      q: 'Why does the jib hang limp on a run?',
      options: ['It is too small', 'It sits in the mainsail’s wind shadow', 'The wind is too light'],
      correct: 1,
      why: 'Dead downwind the main [[blanketing|blankets]] the jib; poling it out to windward gets it into clear air.',
    },
    {
      q: 'Sailing by the lee is dangerous because…',
      options: ['the boat can capsize', 'the wind can get behind the main and throw the boom across', 'the jib collapses'],
      correct: 1,
      why: 'With the wind on the boom’s side, an accidental [[gybe]] is only a few degrees away.',
    },
  ],
};
