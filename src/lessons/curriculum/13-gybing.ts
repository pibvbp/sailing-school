// Lesson 13 — Gybing (spec §11.2): controlled vs accidental gybe, the accidental one demonstrated safely.
// Task: two gybes without a crash gybe event.
import type { Lesson, LessonCtx } from '../types';
import { absTwa, downKey, frameDt, GybeWatch, hasEvent, holdTwa, latch, mem, sailing, step, toDeg, twaDeg, view } from './helpers';

const GYBES = 2;

interface GybeLog { watch: GybeWatch; clean: number; crashes: number }
const log = (c: LessonCtx): GybeLog => mem(c, 'gybes', () => ({ watch: new GybeWatch(), clean: 0, crashes: 0 }));

export const gybing: Lesson = {
  id: 'gybing',
  module: 'Manoeuvres',
  title: 'Gybing',
  summary: 'Turn the stern through the wind under control — and see why an accidental gybe is dangerous.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 14, twa: 150 })),
  steps: [
    step({
      title: 'The gybe',
      body: `<p>To change tack going downwind you [[gybe]]: turn the <em>stern</em> through the wind. The wind then gets behind the mainsail and throws the boom across the whole cockpit — on a run the boom travels from one side to the other, nearly 160°.</p>
<p>Done under control it is routine. By accident, with the mainsheet eased right out, the boom slams across hard enough to injure anyone in its way and to damage the rig.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'An accidental gybe (safely)',
      body: `<p>See it happen here, where nobody gets hurt. Bear away past dead downwind (<kbd>←</kbd> on this tack) so the wind comes over the same side as the boom — sailing [[by-the-lee]]. Keep the mainsheet eased and wait: the wind catches the back of the main and slams the boom across.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
      task: {
        label: 'Let the boom crash across in an accidental gybe',
        check: (c) => latch(c, 'crash', hasEvent(c.snap, 'crashGybe')),
      },
      hint: (c) => {
        const s = c.snap;
        const a = absTwa(s);
        const boomSide = Math.sign(s.sails.main.boomAngle);
        const byTheLee = boomSide !== 0 && Math.sign(twaDeg(s)) === -boomSide;
        if (byTheLee) return 'You are by the lee — the wind is on the boom’s side. Hold on: the boom is about to go.';
        if (a < 165) return `Bear away further with ${downKey(s)}, past dead downwind.`;
        return `Keep turning with ${downKey(s)} until the wind comes from the boom’s side.`;
      },
      showMe: (c) => {
        const s = c.snap;
        // Past dead downwind onto the boom's side, with the main left eased.
        const boomSide = Math.sign(s.sails.main.boomAngle) || 1;
        holdTwa(c, 160, boomSide > 0 ? -1 : 1);
      },
    }),
    step({
      title: 'The controlled gybe',
      body: `<p>A controlled gybe keeps the boom's swing short:</p>
<ul><li><em>"Stand by to gybe!"</em> Bear away to a run.</li>
<li>Sheet the mainsail in toward the centreline (<kbd>W</kbd>), so the boom has only a short way to go.</li>
<li><em>"Gybe-oh!"</em> Turn the stern slowly through the wind; the boom comes across under control.</li>
<li>Ease the main out on the new side and steer onto your new course. The jib follows.</li></ul>
<p>Press <kbd>G</kbd> and the crew does exactly this with you.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
      onEnter: (c) => holdTwa(c, 150),
    }),
    step({
      title: 'Two clean gybes',
      body: `<p>Gybe twice without a crash: press <kbd>G</kbd>, or sail it yourself — sheet in, turn slowly through dead downwind, ease out on the new side.</p>`,
      camera: 'chase',
      overlays: view('wheel', 'track'),
      controls: ['helm', 'main', 'manoeuvres'],
      autoTrim: { main: true, jib: true },
      task: {
        label: `${GYBES} gybes without a crash gybe`,
        check: (c) => {
          const l = log(c);
          const r = l.watch.update(c.snap);
          if (r) {
            if (r.crashed) { l.crashes++; l.clean = 0; } else l.clean++;
          }
          return Math.min(1, l.clean / GYBES);
        },
      },
      hint: (c) => {
        const s = c.snap;
        const l = log(c);
        if (s.maneuver === 'gybe') return null;
        if (l.crashes > 0 && l.clean === 0) return 'That one crashed across. Sheet the main in before the stern passes through the wind (or press G), then ease out again.';
        if (absTwa(s) < 120) return `Bear away with ${downKey(s)} toward a broad reach first.`;
        return `Press G to gybe (${l.clean} of ${GYBES} done).`;
      },
      showMe: (c) => {
        Object.assign(c.app.controls.autoTrim, { main: true, jib: true });
        holdTwa(c, 150);
        let wait = 0;
        // Gybe whenever the boat is settled on a broad reach with the boom eased out.
        return (cc) => {
          const s = cc.snap;
          const dt = frameDt(cc, 'demoDt');
          if (s.maneuver !== null) { wait = 0; return; }
          wait += dt;
          if (absTwa(s) < 135) { holdTwa(cc, 150); return; }
          if (wait < 5 || Math.abs(toDeg(s.sails.main.boomAngle)) < 40) return;
          cc.app.controls.command = 'gybe';
          wait = 0;
        };
      },
    }),
  ],
  quiz: [
    {
      q: 'Before a controlled gybe you…',
      options: ['ease the mainsheet right out', 'sheet the mainsail in toward the centreline', 'let the jib go'],
      correct: 1,
      why: 'With the main pulled in, the boom only has a short way to swing when the wind gets behind it.',
    },
    {
      q: 'Sailing by the lee means…',
      options: ['the wind comes over the same side as the boom', 'sailing close-hauled', 'the jib is backed'],
      correct: 0,
      why: 'The wind is about to get behind the mainsail — one step from an accidental gybe.',
    },
  ],
};
