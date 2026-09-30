// One import for the lesson files. The building blocks live in focused modules:
//  readings    — what a sailor reads off the boat (speeds, angles, trim, telltales, spinnaker, polars)
//  scenario    — starting situations, overlay sets, helm helpers
//  steps       — the step() builder, "Show me" demos run from the step's tick, per-step scratch state
//  manoeuvres  — tack and gybe detectors, and the demonstrations several lessons share
export { fromDeg, fromKn, toDeg, toKn } from '../../shared/units';
export * from './readings';
export * from './scenario';
export * from './steps';
export * from './manoeuvres';
