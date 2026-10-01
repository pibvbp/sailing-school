// Lesson 5 — A sail is a wing (spec §11.2), run as a Sail-lab: the boat is towed at a steady speed on a beam
// reach so only the trim changes. Lift, drag, angle of attack, luffing vs stall; find the maximum drive.
//
// Every step looks straight down (the top camera puts the wind at the top of the screen) and shows only what its
// text talks about: the flow slice alone; then the lift/drag figure on the sail — the apparent wind, lift, drag and
// the angle of attack — with the slice under it where the text is about the flow; for the last task the angle of
// attack and the drive arrow alone.
import type { SimSnapshot } from '../../sim/types';
import type { ForcePart, Lesson } from '../types';
import { autoTrim, fmt, ramp, sailing, step, trimOf, view, type StepDef } from './helpers';

/** The top view from this height (m) fills the picture with the rig rather than the sea round it (where the app can zoom). */
export const CLOSE_UP_M = 38;

/**
 * A step's picture: the close top view, and — while the step is shown — only these pieces of the Forces overlay
 * (everything again once it is left).
 */
const figure = (...parts: ForcePart[]): Pick<StepDef, 'onEnter' | 'onExit'> => ({
  onEnter: (c) => {
    c.app.setCameraDistance?.(CLOSE_UP_M);
    c.app.setForceParts?.(parts.length > 0 ? parts : null);
  },
  onExit: (c) => c.app.setForceParts?.(null),
});

/** Mean angle of attack (deg) at which the main drives hardest on this beam reach (≥ ~90 % of the best). */
export const MAX_DRIVE_AOA: readonly [number, number] = [13, 18];

/** The task's "maximum drive" condition — exported so the tests can check it against a sheet sweep. */
export function inMaxDriveWindow(s: SimSnapshot): boolean {
  const t = trimOf(s.sails.main);
  return t.aoa >= MAX_DRIVE_AOA[0] && t.aoa <= MAX_DRIVE_AOA[1] && t.luffing < 0.05 && t.stall < 0.35;
}

/** The lab: 10 kn of true wind on the beam, towed at 5 kn, jib rolled away. */
export const LAB_SCENARIO = sailing({
  twsKn: 10, twa: 90, towedKn: 5, helm: 'manual',
  controls: { mainSheet: 0.37, jibFurl: 1, autoTrim: autoTrim(false, false, false) },
});

export const sailIsAWing: Lesson = {
  id: 'sail-is-a-wing',
  module: 'How sails work',
  title: 'A sail is a wing',
  summary: 'In the sail lab: lift and drag, angle of attack, and why a sail luffs when it is too eased and stalls when it is too tight.',
  setup: (c) => c.app.scenario(LAB_SCENARIO),
  steps: [
    step({
      title: 'The sail lab',
      body: `<p>Welcome to the sail lab. The boat is towed at a steady 5 knots on a beam reach, so nothing changes except what you do with the sail. The jib is rolled away: the mainsail works alone.</p>
<p>You are looking straight down on a slice of the air, cut through the rig. The bold white curve is the mainsail where the slice cuts it, and the fine lines are streamlines: the [[apparent-wind|apparent wind]] bending round the sail. The sail turns the air, and the air pushes back: flowing round the curved lee side it speeds up and its pressure drops (blue, <em>Suction</em>), while on the windward side it slows and the pressure rises (orange, <em>Pressure</em>). That pressure difference is the sail's force.</p>`,
      camera: 'top',
      overlays: view('flowSlice'),
      ...figure(),
      controls: [],
    }),
    step({
      title: 'Lift and drag',
      body: `<p>Split the sail's force in two. [[lift|Lift]] — the pink arrow — acts at right angles to the apparent wind, the amber arrow. [[drag|Drag]] — the short lilac arrow — acts along it. A good sail makes a lot of lift for little drag, like an aircraft wing standing on end. (The arrows are the forces overlay, <kbd>V</kbd>.)</p>
<p>How much lift depends on the [[angle-of-attack|angle of attack]]: the angle between the sail's chord (the straight line from [[luff]] to [[leech]], dashed) and the apparent wind. It is the small arc ahead of the mast, where the two lines meet, and the trim panel shows it as <strong>AoA</strong>. The arc and the sail are blue when the sail luffs, green in the [[groove]] and red when it stalls — like the groove meter in the trim panel.</p>`,
      camera: 'top',
      overlays: view('forces', 'aoa'),
      ...figure('liftDrag'),
      controls: [],
    }),
    step({
      title: 'Too small: luffing',
      body: `<p>Ease the mainsheet with <kbd>S</kbd>. The boom swings out and the angle of attack shrinks. Below about 5° the front of the sail can no longer hold its curve: it flaps — it [[luff|luffs]]. The streamlines stop bending, the arc turns blue, and the pink lift arrow shrinks to almost nothing.</p>`,
      camera: 'top',
      overlays: view('flowSlice', 'forces', 'aoa'),
      ...figure('liftDrag'),
      controls: ['mainSheet'],
      task: {
        label: 'Ease the main until it luffs (groove meter blue)',
        holdSeconds: 1,
        check: (c) => trimOf(c.snap.sails.main).luffing >= 0.5,
      },
      hint: (c) => {
        const t = trimOf(c.snap.sails.main);
        return t.luffing >= 0.5 ? null : `Ease further with S: the angle of attack is ${fmt(t.aoa, 0)}°, and the sail luffs below about 5°.`;
      },
      showMe: (c) => {
        c.app.controls.autoTrim.main = false;
        return ramp({ mainSheet: 0.15 });
      },
    }),
    step({
      title: 'Too big: stall',
      body: `<p>Now pull the sail in hard with <kbd>W</kbd>. Past about 18° the air can no longer follow the curved lee side: it breaks away into a swirling wake behind the sail — the streamlines show it. That is a [[stall]]. The arc turns red, the lift arrow shrinks and the drag arrow grows, and the telltales on the [[leech]] disappear behind the sail.</p>`,
      camera: 'top',
      overlays: view('flowSlice', 'forces', 'aoa'),
      ...figure('liftDrag'),
      controls: ['mainSheet'],
      task: {
        label: 'Over-trim the main until it stalls (groove meter red)',
        holdSeconds: 1,
        check: (c) => trimOf(c.snap.sails.main).stall >= 0.6,
      },
      hint: (c) => {
        const t = trimOf(c.snap.sails.main);
        return t.stall >= 0.6 ? null : `Trim harder with W: the angle of attack is ${fmt(t.aoa, 0)}°, and the flow separates beyond about 18°.`;
      },
      showMe: (c) => {
        c.app.controls.autoTrim.main = false;
        return ramp({ mainSheet: 0.65 });
      },
    }),
    step({
      title: 'Maximum drive',
      body: `<p>Between the two is the [[groove]]. A sail pulls hardest near the top of it: the biggest angle of attack at which the air still flows smoothly round the lee side.</p>
<p>The green arrow is the [[drive]]: the part of the sail's force that points the way the boat is heading. Ease slowly out of the stall with <kbd>S</kbd> until the groove meter and the arc turn green and the leech telltales stream — that is the top of the groove. Watch the green drive arrow: it is longest at an angle of attack of about ${MAX_DRIVE_AOA[0]}–${MAX_DRIVE_AOA[1]}°. Hold <kbd>Shift</kbd> for fine trim.</p>`,
      camera: 'top',
      overlays: view('forces', 'aoa'),
      ...figure('drive'),
      controls: ['mainSheet'],
      task: {
        label: `Trim for maximum drive: angle of attack ${MAX_DRIVE_AOA[0]}–${MAX_DRIVE_AOA[1]}° with no luffing, for 4 s`,
        holdSeconds: 4,
        check: (c) => inMaxDriveWindow(c.snap),
      },
      hint: (c) => {
        const t = trimOf(c.snap.sails.main);
        if (inMaxDriveWindow(c.snap)) return null;
        if (t.luffing >= 0.05 || t.aoa < MAX_DRIVE_AOA[0]) return `Angle of attack ${fmt(t.aoa, 0)}°: trim in a little with W — more angle, more lift.`;
        return `Angle of attack ${fmt(t.aoa, 0)}°: the flow is breaking away. Ease a touch with S.`;
      },
      showMe: (c) => { c.app.controls.autoTrim.main = true; },
    }),
    step({
      title: 'What you found',
      body: `<p>Too small an angle of attack and a sail luffs; too big and it stalls. In this simulator the mainsail luffs below about 5°, pulls hardest at about ${MAX_DRIVE_AOA[0]}–${MAX_DRIVE_AOA[1]}° and stalls beyond that. The jib, which you trim in lesson 7, behaves the same way.</p>
<p>Real sails behave the same way, which is why sailors trim all the time: every change of course, speed or wind changes the angle of attack.</p>`,
      camera: 'chase',
      overlays: view('aoa'),
    }),
  ],
  quiz: [
    {
      q: 'Lift acts…',
      options: ['along the apparent wind', 'at right angles to the apparent wind', 'straight up the mast'],
      correct: 1,
      why: '[[lift|Lift]] is by definition the part of the force at right angles to the flow; [[drag]] is the part along it.',
    },
    {
      q: 'In a stalled sail…',
      options: ['the luff flaps', 'the air breaks away from the lee side', 'the drive is at its biggest'],
      correct: 1,
      why: 'At too big an angle of attack the flow cannot follow the curved lee side and separates: lift falls, drag rises.',
    },
    {
      q: 'On a reach, where does a sail drive hardest?',
      options: ['Where it just stops luffing', 'Just short of the stall', 'Pulled in as far as it goes'],
      correct: 1,
      why: 'Lift keeps growing with the angle of attack until the flow starts to separate — the top of the [[groove]].',
    },
  ],
};
