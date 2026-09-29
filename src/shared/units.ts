import { DEG, KN } from './math';

export const toKn = (ms: number): number => ms / KN;
export const fromKn = (kn: number): number => kn * KN;
export const toDeg = (rad: number): number => rad / DEG;
export const fromDeg = (deg: number): number => deg * DEG;

/** Compass degrees 0–359 for display. */
export const compassDeg = (rad: number): number => {
  const d = Math.round(toDeg(rad)) % 360;
  return d < 0 ? d + 360 : d;
};
