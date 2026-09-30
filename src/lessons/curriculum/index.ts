// The curriculum (spec §11.2), in teaching order.
import type { Lesson } from '../types';
import { meetTheBoat } from './01-meet-the-boat';
import { findingTheWind } from './02-finding-the-wind';
import { pointsOfSail } from './03-points-of-sail';
import { apparentWind } from './04-apparent-wind';
import { sailIsAWing } from './05-sail-is-a-wing';
import { driveAndHeel } from './06-drive-and-heel';
import { jibTelltalesLesson } from './07-jib-telltales';
import { mainsailTrim } from './08-mainsail-trim';
import { mainAndJib } from './09-main-and-jib';
import { keelAndBalance } from './10-keel-and-balance';
import { tacking } from './11-tacking';
import { outOfIrons } from './12-out-of-irons';
import { gybing } from './13-gybing';
import { running } from './14-running';
import { spinnakerBasics } from './15-spinnaker-basics';
import { spinnakerReachingRunning } from './16-spinnaker-reaching-running';
import { spinnakerGybeDouse } from './17-spinnaker-gybe-douse';
import { sailingSmart } from './18-sailing-smart';

export const CURRICULUM: readonly Lesson[] = [
  meetTheBoat,
  findingTheWind,
  pointsOfSail,
  apparentWind,
  sailIsAWing,
  driveAndHeel,
  jibTelltalesLesson,
  mainsailTrim,
  mainAndJib,
  keelAndBalance,
  tacking,
  outOfIrons,
  gybing,
  running,
  spinnakerBasics,
  spinnakerReachingRunning,
  spinnakerGybeDouse,
  sailingSmart,
];
