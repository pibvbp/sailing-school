// Plain-English sailing glossary. Lesson text marks terms as [[key]] or [[key|shown text]];
// the lesson panel (and any HUD text) renders them as hoverable definitions.
// Keys are lower-case and hyphenated; lookups also accept the displayed term, aliases and simple plurals.

export interface GlossaryEntry {
  key: string;
  /** How the term is written in a definition card. */
  term: string;
  /** One sentence, plain English. */
  def: string;
  aliases?: readonly string[];
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  // Sail parts
  { key: 'luff', term: 'Luff', def: 'The front edge of a sail; when a sail "luffs" it flaps along this edge because the wind meets it too head-on.', aliases: ['luffing'] },
  { key: 'leech', term: 'Leech', def: 'The back edge of a sail, from the top corner down to the clew.' },
  { key: 'foot', term: 'Foot', def: 'The bottom edge of a sail.' },
  { key: 'tack-corner', term: 'Tack (corner)', def: 'The lower front corner of a sail, where it is fixed to the boat or the spinnaker pole.' },
  { key: 'clew', term: 'Clew', def: 'The lower back corner of a sail, where the sheet pulls on it.' },
  { key: 'head', term: 'Head', def: 'The top corner of a sail, pulled up the mast by the halyard.' },
  { key: 'battens', term: 'Battens', def: 'Stiff strips slid into pockets across the mainsail so its back edge keeps a smooth curve.', aliases: ['batten'] },

  // Ropes, spars and fittings
  { key: 'sheet', term: 'Sheet', def: 'The rope that pulls a sail in (trim) or lets it out (ease) — never a sheet of cloth.', aliases: ['sheets', 'mainsheet', 'jib sheet'] },
  { key: 'halyard', term: 'Halyard', def: 'The rope that hoists a sail up the mast.' },
  { key: 'traveler', term: 'Traveler', def: 'A track across the cockpit that slides the mainsheet\'s lower end to windward or leeward, changing the boom\'s angle without changing twist.', aliases: ['traveller'] },
  { key: 'vang', term: 'Vang', def: 'A tackle that pulls the boom down, keeping the top of the mainsail from twisting open.', aliases: ['kicker', 'boom vang'] },
  { key: 'outhaul', term: 'Outhaul', def: 'The line that stretches the mainsail\'s foot along the boom — pulling it flattens the lower sail.' },
  { key: 'cunningham', term: 'Cunningham', def: 'A line that pulls the mainsail\'s luff down, moving the deepest part of the sail forward and flattening it.' },
  { key: 'backstay', term: 'Backstay', def: 'The wire from the masthead to the stern; tightening it bends the mast, flattens the main and tightens the forestay.' },
  { key: 'forestay', term: 'Forestay', def: 'The wire from the bow to near the top of the mast that holds the mast up and carries the jib.' },
  { key: 'boom', term: 'Boom', def: 'The horizontal pole along the bottom of the mainsail — it swings across when you tack or gybe, so keep your head down.' },
  { key: 'mast', term: 'Mast', def: 'The tall vertical spar that holds the sails up.' },
  { key: 'mainsail', term: 'Mainsail', def: 'The big sail behind the mast, attached to the boom.', aliases: ['main'] },
  { key: 'jib', term: 'Jib', def: 'The triangular sail in front of the mast, set on the forestay.' },
  { key: 'spinnaker', term: 'Spinnaker', def: 'A large, light, balloon-shaped sail flown in front of the boat when sailing away from the wind.', aliases: ['kite', 'spinnakers'] },
  { key: 'spinnaker-pole', term: 'Spinnaker pole', def: 'A spar that holds the spinnaker\'s windward corner out from the mast.', aliases: ['pole'] },
  { key: 'guy', term: 'Guy', def: 'The windward spinnaker sheet: it runs through the end of the pole and sets the pole\'s angle.', aliases: ['afterguy'] },
  { key: 'whisker-pole', term: 'Whisker pole', def: 'A light pole that holds the jib out on the windward side when sailing straight downwind (wing-on-wing).' },
  { key: 'telltale', term: 'Telltale', def: 'A short ribbon on the sail that shows how the air is flowing over that side: streaming back is good.', aliases: ['tell-tale'] },
  { key: 'tiller', term: 'Tiller', def: 'The stick that turns the rudder — push it one way and the bow turns the other way.' },
  { key: 'rudder', term: 'Rudder', def: 'The underwater blade at the stern that steers the boat when water flows past it.' },
  { key: 'keel', term: 'Keel', def: 'The heavy fin under the boat that stops it sliding sideways and keeps it upright.' },
  { key: 'hull', term: 'Hull', def: 'The body of the boat — the part that floats.' },
  { key: 'cockpit', term: 'Cockpit', def: 'The sunken space near the stern where the crew sits and steers.' },
  { key: 'windex', term: 'Windex', def: 'The wind arrow at the masthead; it points into the wind the boat feels, toward where it comes from.', aliases: ['wind indicator', 'masthead wind indicator'] },

  // Directions
  { key: 'windward', term: 'Windward', def: 'The side of the boat (or direction) the wind is coming from.' },
  { key: 'leeward', term: 'Leeward', def: 'The side of the boat (or direction) the wind is blowing toward — pronounced "loo-ard".' },
  { key: 'port', term: 'Port', def: 'The left side of the boat when you face the bow; its light and telltales are red.' },
  { key: 'starboard', term: 'Starboard', def: 'The right side of the boat when you face the bow; its light and telltales are green.' },
  { key: 'bow', term: 'Bow', def: 'The front of the boat.' },
  { key: 'stern', term: 'Stern', def: 'The back of the boat.' },

  // Steering and manoeuvres
  { key: 'heading-up', term: 'Heading up', def: 'Turning the bow toward the wind.', aliases: ['head up', 'luffing up'] },
  { key: 'bearing-away', term: 'Bearing away', def: 'Turning the bow away from the wind.', aliases: ['bear away', 'bear off', 'bearing off'] },
  { key: 'tack', term: 'Tack', def: 'To tack is to turn the bow through the wind so it blows on the other side; the word also says which side the wind comes from (starboard tack = wind from the right).', aliases: ['tacks'] },
  { key: 'tacking', term: 'Tacking', def: 'Sailing upwind in a zigzag, turning the bow through the wind at each corner, because no boat can sail straight into the wind.' },
  { key: 'gybe', term: 'Gybe', def: 'Turning the stern through the wind so the boom swings across — controlled it is routine, by accident it is violent.', aliases: ['jibe', 'gybing', 'gybes'] },
  { key: 'crash-gybe', term: 'Crash gybe', def: 'An accidental gybe where the wind catches the back of the mainsail and slams the boom across the cockpit.', aliases: ['accidental gybe'] },
  { key: 'in-irons', term: 'In irons', def: 'Stuck pointing into the wind with the sails flapping, losing speed and unable to steer.', aliases: ['irons'] },
  { key: 'round-up', term: 'Round-up', def: 'When an overpowered boat heels so far that the rudder loses grip and the boat spins up into the wind.', aliases: ['broach', 'rounding up'] },
  { key: 'wing-on-wing', term: 'Wing-on-wing', def: 'Sailing dead downwind with the mainsail out on one side and the jib poled out on the other.', aliases: ['goose-winged'] },
  { key: 'by-the-lee', term: 'By the lee', def: 'Sailing so deep that the wind comes over the same side the boom is on — one step from an accidental gybe.' },
  { key: 'head-to-wind', term: 'Head to wind', def: 'Pointing straight into the wind, where the sails flap and cannot drive the boat.' },
  { key: 'sternway', term: 'Sternway', def: 'Moving backwards through the water — the rudder then steers the opposite way.' },
  { key: 'backing', term: 'Backing a sail', def: 'Holding a sail out against the wind so it presses on the sail\'s back — it pushes the boat backwards and swings the bow round, the way out of irons.', aliases: ['backed', 'back the jib', 'back the main', 'backing the jib', 'backing the main'] },
  { key: 'pinching', term: 'Pinching', def: 'Sailing so close to the wind that the sails start to luff and the boat slows down.', aliases: ['pinch'] },
  { key: 'feathering', term: 'Feathering', def: 'Steering a touch closer to the wind in a gust so the sails spill a little power and the boat heels less.' },
  { key: 'hoist', term: 'Hoist', def: 'To pull a sail up the mast with its halyard.', aliases: ['hoisting'] },
  { key: 'douse', term: 'Douse', def: 'To take a sail down quickly — usually the spinnaker, gathered in behind the mainsail.', aliases: ['dousing'] },

  // Points of sail
  { key: 'points-of-sail', term: 'Points of sail', def: 'The names for the boat\'s angle to the wind: close-hauled, close reach, beam reach, broad reach and run.', aliases: ['point of sail'] },
  { key: 'no-go-zone', term: 'No-go zone', def: 'The arc of about 40° either side of the wind where a sailboat cannot make headway.', aliases: ['no go zone', 'no-go'] },
  { key: 'close-hauled', term: 'Close-hauled', def: 'Sailing as close to the wind as the boat can (about 40–45° off it) with the sails pulled in tight.', aliases: ['beating', 'beat'] },
  { key: 'close-reach', term: 'Close reach', def: 'Sailing between close-hauled and a beam reach, with the wind forward of the side of the boat.' },
  { key: 'beam-reach', term: 'Beam reach', def: 'Sailing with the wind blowing straight across the side of the boat, at 90° to it.' },
  { key: 'broad-reach', term: 'Broad reach', def: 'Sailing with the wind coming from behind at an angle, over the back corner of the boat.' },
  { key: 'run', term: 'Run', def: 'Sailing with the wind coming from directly behind the boat.', aliases: ['running', 'dead downwind'] },

  // Wind
  { key: 'true-wind', term: 'True wind', def: 'The wind you would feel standing still — its speed (TWS) and angle to the bow (TWA).', aliases: ['tws', 'twa'] },
  { key: 'apparent-wind', term: 'Apparent wind', def: 'The wind you feel on the moving boat: the true wind combined with the wind made by the boat\'s own speed (AWS, AWA).', aliases: ['aws', 'awa'] },
  { key: 'gust', term: 'Gust', def: 'A short burst of stronger wind, seen coming as a dark patch on the water.', aliases: ['puff', 'gusts', 'puffs'] },
  { key: 'lull', term: 'Lull', def: 'A patch of lighter wind between gusts.', aliases: ['lulls'] },
  { key: 'lift-shift', term: 'Lift (wind shift)', def: 'A wind shift that lets you point closer to where you want to go upwind.' },
  { key: 'header', term: 'Header', def: 'A wind shift that forces you to bear away from where you want to go upwind.', aliases: ['knock', 'headers'] },
  { key: 'boat-wind', term: 'Boat wind', def: 'The headwind made by the boat\'s own motion, as strong as its speed — you would feel it even in a calm.', aliases: ['motion wind', 'induced wind'] },
  { key: 'wind-gradient', term: 'Wind gradient', def: 'The wind blows more slowly near the water than higher up, because the surface drags on it.', aliases: ['gradient'] },

  // How sails work
  { key: 'angle-of-attack', term: 'Angle of attack', def: 'The angle between the sail and the apparent wind meeting it — too small and it luffs, too big and it stalls.', aliases: ['aoa'] },
  { key: 'lift', term: 'Lift', def: 'The aerodynamic force at right angles to the airflow — the force that pulls a sail (or wing) along.' },
  { key: 'drag', term: 'Drag', def: 'The aerodynamic force along the airflow, pushing the sail downwind.' },
  { key: 'stall', term: 'Stall', def: 'When the angle of attack is too big, the air stops following the sail\'s leeward side and lift collapses into drag.', aliases: ['stalled', 'stalling'] },
  { key: 'groove', term: 'Groove', def: 'The narrow band of trim or steering where the sail neither luffs nor stalls and drives hardest.' },
  { key: 'twist', term: 'Twist', def: 'How much further out the top of a sail sits than the bottom, matching the wind that is stronger and freer aloft.' },
  { key: 'camber', term: 'Camber', def: 'How deep (curved) a sail is: deep sails give power, flat sails less heel.', aliases: ['depth', 'draft depth'] },
  { key: 'draft', term: 'Draft', def: 'Where along the sail its deepest point sits (forward or back).', aliases: ['draft position'] },
  { key: 'draft-stripes', term: 'Draft stripes', def: 'Dark lines printed across a sail so its depth and twist can be judged from below.', aliases: ['draft stripe'] },
  { key: 'backwinding', term: 'Backwinding', def: 'Air deflected by an over-trimmed jib hits the back of the mainsail near the mast and makes it bubble.', aliases: ['backwinded', 'backwind'] },
  { key: 'blanketing', term: 'Blanketing', def: 'One sail stealing another\'s wind by sitting in its wind shadow, as the main does to the jib on a run.', aliases: ['blanketed', 'wind shadow'] },
  { key: 'trim', term: 'Trim', def: 'To pull a sail in with its sheet; also the general word for how the sails are set.', aliases: ['trimming'] },
  { key: 'ease', term: 'Ease', def: 'To let a sheet out so the sail moves further from the boat.', aliases: ['easing'] },
  { key: 'drive', term: 'Drive', def: 'The part of the sails\' total force that points forward along the boat and pushes it ahead.', aliases: ['driving force'] },
  { key: 'heeling-force', term: 'Heeling force', def: 'The part of the sails\' total force that points across the boat, heeling it and pushing it to leeward.', aliases: ['side force'] },
  { key: 'centre-of-effort', term: 'Centre of effort', def: 'The point on the sails where their total force can be thought to act.', aliases: ['center of effort'] },
  { key: 'upwash', term: 'Upwash', def: 'Air bending toward a lifting sail before it arrives — the main\'s upwash lets the jib meet the wind from further aft.' },
  { key: 'downwash', term: 'Downwash', def: 'Air turned by a sail as it leaves the leech — the jib\'s downwash makes the main meet the wind from further forward.' },
  { key: 'slot', term: 'Slot', def: 'The gap between the jib\'s leech and the mainsail, where the two sails\' airflows meet.' },
  { key: 'luff-curl', term: 'Luff curl', def: 'The fold that rolls in along a spinnaker\'s luff when it is eased right to the edge — the sign of the fastest trim.', aliases: ['curl', 'curling'] },
  { key: 'depower', term: 'Depower', def: 'To reduce the sails\' force, and with it heel, by flattening, twisting or easing them.', aliases: ['depowering'] },

  // Boat behaviour
  { key: 'heel', term: 'Heel', def: 'The sideways lean of the boat caused by the wind pushing on the sails.', aliases: ['heeling'] },
  { key: 'hiking', term: 'Hiking', def: 'The crew sitting out on the high (windward) side so their weight holds the boat more upright.', aliases: ['hike'] },
  { key: 'heeling-moment', term: 'Heeling moment', def: 'The tipping effort of the sails\' side force high up against the keel\'s opposing force low down.' },
  { key: 'righting-moment', term: 'Righting moment', def: 'The effort of the boat\'s weight and buoyancy, plus the crew\'s weight, that pulls a heeled boat back upright.', aliases: ['righting couple'] },
  { key: 'leeway', term: 'Leeway', def: 'The sideways slip of the boat through the water — the angle between where it points and where it actually goes.' },
  { key: 'weather-helm', term: 'Weather helm', def: 'The boat\'s urge to turn toward the wind, so you have to hold the tiller to windward to go straight.' },
  { key: 'vmg', term: 'VMG', def: 'Velocity made good: how fast you are really getting upwind (or downwind), not just how fast the boat moves.', aliases: ['velocity made good'] },
  { key: 'polar', term: 'Polar', def: 'A chart of the boat\'s best speed at every wind angle for a given wind strength.', aliases: ['polars', 'polar diagram'] },
  { key: 'layline', term: 'Layline', def: 'The line from which you can just reach a mark on one tack without tacking again.', aliases: ['laylines'] },
];

const INDEX = new Map<string, GlossaryEntry>();
for (const g of GLOSSARY) {
  INDEX.set(g.key, g);
  INDEX.set(normalise(g.term), g);
  for (const a of g.aliases ?? []) INDEX.set(normalise(a), g);
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Find an entry by key, displayed term, alias or a simple plural ("telltales" → telltale). */
export function lookupTerm(keyOrTerm: string): GlossaryEntry | undefined {
  const n = normalise(keyOrTerm);
  const direct = INDEX.get(n) ?? INDEX.get(n.replace(/ /g, '-'));
  if (direct) return direct;
  if (n.endsWith('es') && INDEX.has(n.slice(0, -2))) return INDEX.get(n.slice(0, -2));
  if (n.endsWith('s')) return INDEX.get(n.slice(0, -1)) ?? INDEX.get(n.slice(0, -1).replace(/ /g, '-'));
  return undefined;
}

/** Markup used in lesson text: [[key]] or [[key|shown text]]. */
export const GLOSSARY_MARKUP = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface GlossaryRef { raw: string; key: string; text: string; entry: GlossaryEntry | undefined }

/** Every [[…]] reference in a text, resolved (entry undefined when the term is missing). */
export function glossaryRefs(text: string): GlossaryRef[] {
  const out: GlossaryRef[] = [];
  for (const m of text.matchAll(GLOSSARY_MARKUP)) {
    const key = m[1]!.trim();
    out.push({ raw: m[0], key, text: (m[2] ?? m[1]!).trim(), entry: lookupTerm(key) });
  }
  return out;
}

/** Plain text with the markup removed (for toasts, aria labels, logs). */
export function stripGlossary(text: string): string {
  return text.replace(GLOSSARY_MARKUP, (_m, key: string, shown?: string) => (shown ?? key).trim());
}
