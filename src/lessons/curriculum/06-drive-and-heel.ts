// Lesson 6 — Drive and heel (spec §11.2): the sails' total force splits into drive and heeling force, and the
// split depends on the point of sail.
import type { SimSnapshot } from '../../sim/types';
import type { Lesson } from '../types';
import { absTwa, downKey, fmt, heelDeg, holdTwa, sailing, step, upKey, view } from './helpers';

const drive = (s: SimSnapshot): number => s.forces.drive;
const heeling = (s: SimSnapshot): number => Math.abs(s.forces.sideForce);

export const driveAndHeel: Lesson = {
  id: 'drive-and-heel',
  module: 'How sails work',
  title: 'Drive and heel',
  summary: 'The same sail force pushes you forward on a reach but mostly sideways upwind.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 12, twa: 90 })),
  steps: [
    step({
      title: 'Two parts of one force',
      body: `<p>The red arrow is the sails' total force, drawn at their [[centre-of-effort|centre of effort]]. It points roughly at right angles to the apparent wind, because it is mostly [[lift]].</p>
<p>Only part of it is useful. The green arrow is the [[drive]], the part along the boat that pushes you forward. The purple arrow is the [[heeling-force|heeling force]], the part across the boat that heels you over and pushes you sideways. The keel resists the sideways push; you will meet it in lesson 10.</p>`,
      camera: 'chase',
      overlays: view('forces'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'Close-hauled',
      body: `<p>Head up to close-hauled (<kbd>→</kbd> on this tack). The apparent wind now comes from well ahead, so the sails' force — at right angles to it — points mostly sideways.</p>
<p>Look at the arrows: the heeling force is several times bigger than the drive. The boat leans over, and the crew hikes out to hold her up.</p>`,
      camera: 'chase',
      overlays: view('forces'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
      task: {
        label: 'Close-hauled (TWA 38–52°) with a heeling force at least 2.5 × the drive, for 5 s',
        holdSeconds: 5,
        check: (c) => {
          const s = c.snap;
          const a = absTwa(s);
          return a >= 38 && a <= 52 && drive(s) > 0 && heeling(s) >= 2.5 * drive(s);
        },
      },
      hint: (c) => {
        const s = c.snap;
        const a = absTwa(s);
        if (a > 52) return `Turn toward the wind with ${upKey(s)} until the true wind angle is 40–50°.`;
        if (a < 38) return `Too close to the wind — bear away a little with ${downKey(s)}.`;
        return `Drive ${fmt(drive(s), 0)} N, heeling force ${fmt(heeling(s), 0)} N, heel ${fmt(heelDeg(s), 0)}°.`;
      },
      showMe: (c) => holdTwa(c, 45),
    }),
    step({
      title: 'Broad reach',
      body: `<p>Now bear away (<kbd>←</kbd>). As the apparent wind moves aft, the sails' force swings forward with it: the heeling arrow shrinks fast, while the drive arrow grows until about a beam reach. The boat stands up and the ride gets easier.</p>
<p>Keep turning until the drive is bigger than the heeling force.</p>`,
      camera: 'chase',
      overlays: view('forces'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
      task: {
        label: 'Bear away until the drive is bigger than the heeling force, and hold it for 3 s',
        holdSeconds: 3,
        check: (c) => absTwa(c.snap) >= 90 && drive(c.snap) > heeling(c.snap),
      },
      hint: (c) => {
        const s = c.snap;
        if (drive(s) > heeling(s) && absTwa(s) >= 90) return null;
        return `Drive ${fmt(drive(s), 0)} N, heeling force ${fmt(heeling(s), 0)} N: keep bearing away with ${downKey(s)}.`;
      },
      showMe: (c) => holdTwa(c, 125),
    }),
    step({
      title: 'Why it matters',
      body: `<p>Upwind, most of the sails' effort goes into heeling the boat and pushing it sideways, and only a small part drives it forward — which is why a boat heels and slides most when close-hauled, and why sailing upwind is slow work.</p>
<p>On a reach the force swings forward: less heel, more drive. Further downwind nearly all of it drives, but the apparent wind — and with it the whole force — gets weaker. That is why the beam reach is usually the fastest point of sail.</p>`,
      camera: 'chase',
      overlays: view('forces'),
    }),
  ],
  quiz: [
    {
      q: 'Close-hauled, the sails’ force mostly…',
      options: ['drives the boat forward', 'heels the boat and pushes it sideways', 'lifts the boat out of the water'],
      correct: 1,
      why: 'The force is roughly at right angles to an apparent wind that comes from well ahead, so most of it points sideways.',
    },
    {
      q: 'As you bear away from close-hauled toward a broad reach, the share of the sails’ force that drives you forward…',
      options: ['grows', 'shrinks', 'stays the same'],
      correct: 0,
      why: 'The apparent wind moves aft and the force turns forward with it — even though the whole force shrinks as the apparent wind weakens.',
    },
  ],
};
