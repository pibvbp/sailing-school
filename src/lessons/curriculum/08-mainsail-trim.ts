// Lesson 8 — Mainsail trim and twist (spec §11.2): boom angle, traveler, leech telltales, the wind gradient and
// twist. Task: the top leech telltale streaming about half the time.
//
// Physics note: in the sim the mainsheet sets the twist (leech tension) and the traveler sets the boom angle.
// Upwind the apparent wind twists only ~3° over the height of the sail, so the fast trim is a firm leech with
// all four leech telltales near the edge of stalling — the top one streaming about half the time.
import type { SimSnapshot } from '../../sim/types';
import type { Lesson, LessonCtx } from '../types';
import {
  absTwa, autoTrim, awaDeg, fmt, frameDt, holdTwa, leechStreaming, mem, ramp, sailing, speedKn, step, topLeechTelltale, view,
} from './helpers';

/** Smoothed share of time (0…1) the top leech telltale streams: ~τ = 4 s. */
function topStreaming(c: LessonCtx): number {
  const box = mem(c, 'top', () => ({ ema: NaN }));
  const x = leechStreaming(topLeechTelltale(c.snap));
  const dt = frameDt(c, 'topDt');
  box.ema = Number.isNaN(box.ema) ? x : box.ema + (x - box.ema) * Math.min(1, dt / 4);
  return box.ema;
}

/** The lowest leech telltale's streaming share (instantaneous). */
function bottomStreaming(s: SimSnapshot): number {
  let low = s.sails.main.telltales[0] ?? null;
  for (const t of s.sails.main.telltales) if (low && -t.pos.z < -low.pos.z) low = t;
  return leechStreaming(low);
}

const anyFluttering = (s: SimSnapshot): boolean => s.sails.main.telltales.some((t) => t.state === 'fluttering');

export const mainsailTrim: Lesson = {
  id: 'mainsail-trim',
  module: 'Trim and balance',
  title: 'Mainsail trim and twist',
  summary: 'Boom angle, traveler, leech telltales — and why the top of the sail twists open.',
  setup: (c) => c.app.scenario(sailing({
    twsKn: 12, twa: 45, gustiness: 0.4, seed: 11,
    controls: { mainSheet: 0.85, traveler: 0, vang: 0.3, autoTrim: autoTrim(false, true, false) },
  })),
  steps: [
    step({
      title: 'Sheet, traveler and boom',
      body: `<p>The mainsheet does two jobs. It pulls the [[boom]] in toward the centreline, and it pulls it down, which tightens the [[leech]]. The [[traveler]] (<kbd>Q</kbd> to windward, <kbd>Z</kbd> to leeward) slides the sheet's lower end across the boat: it changes the boom's angle without changing the leech tension.</p>
<p>The four ribbons on the leech, one at each [[battens|batten]], are the main's telltales. They stream while the air leaves the sail smoothly, and vanish behind it when the flow stalls.</p>
<p>The sail-view camera (<kbd>4</kbd>) looks up the mainsail from below, so you can see its shape and the [[draft-stripes|draft stripes]]. The colours show the angle of attack at each height: blue luffing, green in the groove, red stalled.</p>`,
      camera: 'sail',
      overlays: view('aoa'),
      controls: ['helm'],
    }),
    step({
      title: 'The wind is stronger aloft',
      body: `<p>Friction with the water slows the wind near the surface: at boom height it blows only about three quarters as hard as at the masthead. This [[wind-gradient|wind gradient]] matters, because the boat wind is the same at every height.</p>
<p>So high up the true wind is a bigger part of the mix, and the apparent wind there comes from further aft — here about 3° upwind, and up to 10° on a reach. The wind triangle shows the apparent wind at the masthead and at deck level. To meet it at the right angle all the way up, the top of the sail must sit further out than the bottom: that is [[twist]].</p>`,
      camera: 'sail',
      overlays: view('windTriangle', 'aoa'),
      controls: ['helm'],
    }),
    step({
      title: 'Too much twist',
      body: `<p>Ease the mainsheet with <kbd>S</kbd> and look up. With less leech tension the top of the sail falls away to leeward first: the twist read-out grows, the top of the sail starts to [[luff]], and its telltales flutter. Too much twist throws away power at the top of the sail.</p>`,
      camera: 'sail',
      overlays: view('aoa'),
      controls: ['mainSheet'],
      task: {
        label: 'Ease the mainsheet until the top leech telltale flutters',
        holdSeconds: 1,
        check: (c) => topLeechTelltale(c.snap)?.state === 'fluttering',
      },
      hint: (c) => (topLeechTelltale(c.snap)?.state === 'fluttering' ? null : `Keep easing with S (twist is ${fmt(c.snap.sails.main.twistDeg, 0)}°) until the top of the sail luffs.`),
      showMe: (c) => {
        c.app.controls.autoTrim.main = false;
        return ramp({ mainSheet: 0.6 });
      },
    }),
    step({
      title: 'Leech firm, angle with the traveler',
      body: `<p>Upwind the wind twists only a few degrees, so the sail needs only a little twist. Sheet in firmly (<kbd>W</kbd>) to close the leech, then set the boom's angle with the traveler: <kbd>Z</kbd> drops it to leeward, <kbd>Q</kbd> pulls it up.</p>
<p>The classic target: the top leech telltale streaming about half the time — right on the edge of stalling — while the lowest one still streams. Then the whole sail works at its best angle of attack. Hold <kbd>Shift</kbd> for small moves.</p>`,
      camera: 'sail',
      overlays: view('aoa'),
      controls: ['mainSheet', 'traveler'],
      task: {
        label: 'Top leech telltale streaming about half the time, lower ones streaming, for 6 s',
        holdSeconds: 6,
        check: (c) => {
          const s = c.snap;
          const top = topStreaming(c);
          return absTwa(s) <= 55 && speedKn(s) >= 3.5 && !anyFluttering(s) && bottomStreaming(s) >= 0.3 && top >= 0.25 && top <= 0.75;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const top = (mem(c, 'top', () => ({ ema: NaN })).ema);
        if (anyFluttering(s)) return 'The top of the sail is still luffing — sheet in with W to firm up the leech.';
        if (bottomStreaming(s) < 0.3) return c.app.controls.mainSheet < 0.9
          ? 'The bottom of the sail is stalled: the boom is too close to the centreline. Firm up the leech with the mainsheet (W), then drop the traveler with Z.'
          : 'The bottom of the sail is stalled: the boom is too close to the centreline. Keep the sheet firm and drop the traveler a little with Z.';
        if (top > 0.75) return 'The top telltale streams all the time: raise the traveler a little with Q. (Sheeting harder with W also closes the top — the mainsheet sets the twist.)';
        if (top < 0.25) return 'The top telltale is stalled most of the time: drop the traveler a little with Z — or ease the mainsheet a touch with S to add twist.';
        return `Close — apparent wind ${fmt(Math.abs(awaDeg(s)), 0)}°. Hold it steady.`;
      },
      showMe: (c) => {
        const k = c.app.controls;
        k.autoTrim.main = false;
        k.mainSheet = 1;
        holdTwa(c, 45);
        // The crew watches the top telltale and works the traveler: stalled → down, streaming → up.
        return (cc) => {
          const t = topLeechTelltale(cc.snap);
          if (!t || t.state === 'fluttering') return;
          const dt = frameDt(cc, 'demoDt');
          const kk = cc.app.controls;
          kk.mainSheet = Math.min(1, kk.mainSheet + 0.3 * dt);
          kk.traveler = Math.max(-1, Math.min(1, kk.traveler + 0.35 * (0.5 - t.intensity) * dt));
        };
      },
    }),
    step({
      title: 'More or less twist',
      body: `<p>Less twist (sheet hard) points higher and powers up the top of the sail; more twist (sheet eased) spills power from the top. Sailors add twist in very light air, to keep the flow attached, and in strong wind, to spill power and reduce heel.</p>
<p>Off the wind the sheet pulls the boom in more than down, so the top twists away. There the [[vang]] holds the boom down and controls the twist instead.</p>`,
      camera: 'sail',
      overlays: view('aoa'),
    }),
  ],
  quiz: [
    {
      q: 'Why does a sail need twist?',
      options: [
        'The wind is stronger higher up, so aloft the apparent wind comes from further aft',
        'To make the sail look nicer',
        'Because the mast bends',
      ],
      correct: 0,
      why: 'With the [[wind-gradient|wind gradient]] the apparent wind swings aft with height, and the top of the sail follows it.',
    },
    {
      q: 'Which control changes the boom angle without changing the leech tension?',
      options: ['The mainsheet', 'The traveler', 'The outhaul'],
      correct: 1,
      why: 'The [[traveler]] moves the sheet’s lower end sideways; the sheet (and the vang) set the leech tension.',
    },
  ],
};
