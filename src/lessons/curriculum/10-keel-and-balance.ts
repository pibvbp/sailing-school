// Lesson 10 — Keel, leeway and balance (spec §11.2): keel lift and leeway, heeling vs righting moment, weather
// helm, depowering. Task: upwind in 16 kn with heel < 20° and helm < 6°.
//
// Each step shows only the forces its text talks about (the pair that balances sideways, then the righting couple,
// then the rudder), with the x-ray water where the subject is under the boat: the keel and rudder drawn through the
// hull, and at the keel the leeway picture — heading against track.
import type { SimSnapshot } from '../../sim/types';
import type { ForcePart, Lesson } from '../types';
import {
  absTwa, autoTrim, fmt, frameDt, heelDeg, helmDeg, holdTwa, ramp, sailing, speedKn, step, together, upKey, view, type StepDef,
} from './helpers';

/** While the step is shown, the Forces overlay draws only these pieces (and everything again once it is left). */
const forceParts = (...parts: ForcePart[]): Pick<StepDef, 'onEnter' | 'onExit'> => ({
  onEnter: (c) => c.app.setForceParts?.(parts),
  onExit: (c) => c.app.setForceParts?.(null),
});

const MAX_HEEL = 20;
const MAX_HELM = 6;
const MIN_SPEED = 5;

const balanced = (s: SimSnapshot): boolean =>
  absTwa(s) <= 55 && heelDeg(s) < MAX_HEEL && helmDeg(s) < MAX_HELM && speedKn(s) >= MIN_SPEED;

export const keelAndBalance: Lesson = {
  id: 'keel-and-balance',
  module: 'Trim and balance',
  title: 'Keel, leeway and balance',
  summary: 'The keel is an underwater wing; heel, weather helm and how to depower when the wind builds.',
  setup: (c) => c.app.scenario(sailing({
    twsKn: 16, twa: 45,
    controls: {
      mainSheet: 0.9, traveler: 0, vang: 0.3, outhaul: 0.2, backstay: 0.1, cunningham: 0,
      crewHike: 'auto', autoTrim: autoTrim(false, true, false),
    },
  })),
  steps: [
    step({
      title: 'The keel is a wing too',
      body: `<p>The sails' [[heeling-force|heeling force]] (the purple arrow) pushes the boat sideways, and the [[keel]] resists it. The water view (x-ray) shows how. The white arrow from under the bow is her heading, where she points; the yellow arrow is her track, where she actually goes, and astern yellow marks drift away along it. The small angle between the two is her [[leeway]].</p>
<p>So the keel meets the water at a small angle of attack. Like a sail, it turns that into lift (the cyan arrow), pointing to windward.</p>
<p>A keel needs speed: its lift grows with the square of the boat speed. Slow down, and the boat must slide further sideways before the keel can hold her — which is why pinching and stalled sails make you drift to leeward.</p>`,
      camera: 'chase',
      overlays: view('xray', 'forces'),
      ...forceParts('heel', 'keel'),
      controls: ['helm'],
    }),
    step({
      title: 'Heeling and righting',
      body: `<p>The heeling force acts high on the sails and the keel's force low down under the water. Together they try to tip the boat over: the [[heeling-moment|heeling moment]].</p>
<p>The boat fights back. Her weight (the gold arrow) pulls down through her centre of gravity, low thanks to the heavy keel, while the water pushes up — her buoyancy, the light-blue arrow — through the centre of the underwater hull, which moves out to leeward as she heels. That pair is the [[righting-moment|righting moment]]; the crew sitting out on the high side ([[hiking]]) adds to it. The boat heels until the two moments balance.</p>`,
      camera: 'chase',
      overlays: view('xray', 'forces'),
      ...forceParts('heel', 'keel', 'righting'),
      controls: ['helm'],
    }),
    step({
      title: 'Weather helm',
      body: `<p>Heel changes the steering too. The sails' force moves out to leeward of the hull, and the heeled hull's shape tries to turn the bow toward the wind. To hold a straight course the rudder must push the other way: [[weather-helm|weather helm]], shown as the rudder angle on the instruments.</p>
<p>The x-ray shows the rudder blade held over under the stern, and the pale arrow is the force on it; the tag at the tiller gives the helm angle. A few degrees of weather helm is good — the boat tells you where the wind is, and the rudder adds a little lift. A lot is a brake. Too much, and the rudder loses its grip and the boat spins into the wind: a [[round-up]].</p>`,
      camera: 'chase',
      overlays: view('xray', 'forces'),
      ...forceParts('rudder', 'helm'),
      controls: ['helm'],
    }),
    step({
      title: 'Depower',
      body: `<p>It is blowing 16 knots and the mainsail is set for light air, so she is heeling hard. [[depower|Depower]] the main until she sails flat and easy — without slowing down:</p>
<ul><li>Flatten it: outhaul, backstay and cunningham in the trim panel's <em>Sail shape</em>.</li>
<li>Drop the [[traveler]] to leeward (<kbd>Z</kbd>) — the boom goes out, the twist stays the same.</li>
<li>Ease the mainsheet a little (<kbd>S</kbd>) so the top twists open and spills power.</li></ul>
<p>The crew hikes out and trims the jib for you; the autopilot holds the course, so watch the heel, the purple heeling force and the helm tag at the tiller.</p>`,
      camera: 'chase',
      overlays: view('forces'),
      ...forceParts('heel', 'helm'),
      controls: ['main', 'crew'],
      task: {
        label: `Upwind at ${MIN_SPEED} kn or more with heel under ${MAX_HEEL}° and helm under ${MAX_HELM}°, for 10 s`,
        holdSeconds: 10,
        check: (c) => balanced(c.snap),
      },
      hint: (c) => {
        const s = c.snap;
        const k = c.app.controls;
        if (absTwa(s) > 55) return `Head back up to close-hauled with ${upKey(s)}.`;
        if (heelDeg(s) >= MAX_HEEL || helmDeg(s) >= MAX_HELM) {
          const now = `Heel ${fmt(heelDeg(s), 0)}°, helm ${fmt(helmDeg(s), 0)}°.`;
          if (k.outhaul < 0.8 || k.backstay < 0.8) return `${now} Flatten the main first: pull on the outhaul and the backstay (Sail shape).`;
          if (k.traveler > -0.6) return `${now} Drop the traveler to leeward with Z.`;
          return `${now} Ease the mainsheet a little with S to twist off the top.`;
        }
        if (speedKn(s) < MIN_SPEED) return `Only ${fmt(speedKn(s))} kn — you have depowered too much. Trim the main back in a little with W.`;
        return null;
      },
      showMe: (c) => {
        const k = c.app.controls;
        k.autoTrim.main = false;
        k.crewHike = 'auto';
        holdTwa(c, 45);
        // Flatten the main and drop the traveler, then play the mainsheet against the heel.
        return together(ramp({ outhaul: 1, backstay: 1, cunningham: 0.8, vang: 0.6, traveler: -0.8 }, 0.5), (cc) => {
          const dt = frameDt(cc, 'demoDt');
          const heel = heelDeg(cc.snap);
          const kk = cc.app.controls;
          if (heel > 18.5) kk.mainSheet = Math.max(0.6, kk.mainSheet - 0.06 * dt);
          else if (heel < 16) kk.mainSheet = Math.min(1, kk.mainSheet + 0.04 * dt);
        });
      },
    }),
    step({
      title: 'Flat is fast',
      body: `<p>Sailing flatter, the boat carries less weather helm and drags less rudder through the water — and in this breeze she loses almost no speed.</p>
<p>When the wind builds, depower in this order: flatten the sails, drop the traveler, ease the sheet to add twist, and in the gusts steer a touch closer to the wind to spill power — [[feathering]]. Keep the crew's weight on the high side all the time.</p>`,
      camera: 'chase',
      overlays: view('xray', 'forces'),
      ...forceParts('heel', 'keel', 'rudder', 'helm'),
    }),
  ],
  quiz: [
    {
      q: 'What gives the keel its angle of attack?',
      options: ['The rudder', 'Leeway — the boat sliding slightly sideways', 'The heel'],
      correct: 1,
      why: 'Sliding a few degrees sideways makes the water meet the keel at a small angle, and the keel turns that into lift.',
    },
    {
      q: 'The boat heels more and more and fights the rudder. What is the first thing to do?',
      options: ['Pull the mainsheet in harder', 'Depower the main: flatten it, drop the traveler, ease', 'Steer away from the wind as far as possible'],
      correct: 1,
      why: 'Less heeling force means less heel and less [[weather-helm|weather helm]].',
    },
    {
      q: 'Why does a heeled boat develop weather helm?',
      options: [
        'The sails’ force moves to leeward and the heeled hull turns toward the wind',
        'The keel is too small',
        'The wind is stronger at the top of the mast',
      ],
      correct: 0,
      why: 'Both effects turn the bow toward the wind, and the rudder has to hold it off.',
    },
  ],
};

