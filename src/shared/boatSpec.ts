// Kestrel 25 — every dimension used by the physics and the renderer (spec §6).
//   x: metres forward of the centre-of-gravity station
//   y: metres to starboard
//   h: metres above the design waterline (body z = −h)
// Change numbers here only; physics and geometry both read this file.

export interface XH { readonly x: number; readonly h: number }
export interface XYH { readonly x: number; readonly y: number; readonly h: number }

export const BOAT = {
  name: 'Kestrel 25',
  hull: {
    loa: 7.6,
    lwl: 6.4,
    beam: 2.6,
    bwl: 2.2,
    canoeDraft: 0.36,
    draft: 1.45,
    stemDeck: { x: 3.95, h: 0.98 },
    stemWL: { x: 3.3, h: 0 },
    transomDeck: { x: -3.65, h: 0.74 },
    transomWL: { x: -3.1, h: 0 },
    maxBeamX: -0.3,
    freeboard: { bow: 0.98, mast: 0.8, min: 0.72, minX: -1.5, stern: 0.74 },
    deckCamber: 0.06,
    /** Canoe-body wetted surface (m²). */
    wettedArea: 12.0,
    /** Hull lateral area used for cross-flow drag (m²). */
    lateralArea: 2.0,
    /** Projected windage areas (m²). */
    windageSide: 6.0,
    windageFront: 2.0,
  },
  mass: {
    boat: 1400,
    crew: 240,
    total: 1640,
    /** Centre of gravity height with the crew on the centreline (below the waterline). */
    cgH: -0.12,
    /** Roll and yaw inertia including added mass (kg·m²). */
    ixx: 2750,
    izz: 9000,
    /** Added mass as a fraction of total mass. */
    addedSurge: 0.05,
    addedSway: 0.8,
    /** Lateral reach of the crew's centre of gravity when hiking (m from the centreline). */
    crewHikeY: 1.05,
  },
  /** Righting lever GZ (m) against heel (deg). GM ≈ 0.95 m. */
  gz: [
    [0, 0], [10, 0.163], [20, 0.31], [30, 0.425], [40, 0.505], [50, 0.55], [60, 0.56],
    [70, 0.535], [80, 0.475], [90, 0.39], [110, 0.18], [130, -0.05], [180, -0.3],
  ] as ReadonlyArray<readonly [number, number]>,
  cabin: { xAft: -1.3, xFwd: 2.0, heightAft: 0.4, heightFwd: 0.3, widthAft: 1.5, widthFwd: 1.0 },
  cockpit: { xAft: -3.45, xFwd: -1.3, width: 1.6, soleH: 0.35, seatH: 0.62 },
  mast: { x: 1.05, baseH: 1.15, topH: 10.2, sectionBase: [0.13, 0.08], sectionTop: [0.08, 0.06] },
  spreaders: { h: 5.6, length: 0.85, sweepDeg: 5 },
  chainplates: { x: 0.95, y: 1.15, h: 0.8 },
  forestay: { tack: { x: 3.9, h: 0.98 }, head: { x: 1.12, h: 10.05 } },
  backstay: { top: { x: 0.98, h: 10.1 }, bottom: { x: -3.6, h: 0.74 } },
  boom: {
    gooseneck: { x: 0.98, h: 2.0 },
    length: 3.3,
    /** Distance from the gooseneck to the mainsheet attachment (end-boom sheeting). */
    sheetAttach: 3.1,
    traveler: { x: -2.15, h: 0.62, halfWidth: 0.8 },
    vangAttach: 0.9,
    mass: 18,
    /** Boom + sail + entrained-air inertia about the gooseneck (kg·m²). */
    inertia: 90,
    /** Hard stop where the boom meets the shrouds (deg). */
    maxAngleDeg: 80,
  },
  main: {
    P: 8.0,
    E: 3.1,
    area: 14.6,
    battens: 4,
    camberBase: 0.11,
    draftBase: 0.48,
    roachFactor: 1.18,
    headWidth: 0.15,
  },
  jib: {
    tack: { x: 3.88, h: 1.05 },
    head: { x: 1.23, h: 9.7 },
    luff: 9.05,
    LP: 3.05,
    foot: 3.33,
    clewH: 1.45,
    area: 13.8,
    lead: { xFwd: 0.2, xAft: -0.4, y: 0.75, h: 1.1 },
    camberBase: 0.12,
    draftBase: 0.42,
    /** Clew swing inertia (kg·m²). */
    inertia: 6,
  },
  spinnaker: {
    SL: 9.2,
    foot: 5.2,
    halfWidth: 3.9,
    area: 32,
    head: { x: 1.2, h: 10.2 },
    poleLength: 2.9,
    poleMastH: 1.9,
    poleTipH: [1.6, 3.4],
    sheetBlock: { x: -3.4, y: 1.1, h: 0.75 },
    guyBlock: { x: -0.3, y: 1.25, h: 0.8 },
  },
  keel: {
    rootChord: 1.0,
    rootH: -0.36,
    tipChord: 0.65,
    tipH: -1.45,
    sweepDeg: 12,
    rootLEX: 0.87,
    area: 0.9,
    cp: { x: 0.55, h: -0.87 },
    arEff: 2.85,
    tc: 0.12,
    stallDeg: 14,
  },
  rudder: {
    stockX: -2.85,
    rootChord: 0.4,
    rootH: -0.15,
    tipChord: 0.28,
    tipH: -1.15,
    area: 0.34,
    cp: { x: -2.85, h: -0.62 },
    arEff: 4.5,
    tc: 0.12,
    stallDeg: 22,
    maxAngleDeg: 35,
    rateDegS: 60,
  },
  tiller: { length: 1.05, headH: 0.72 },
} as const;

export type BoatSpec = typeof BOAT;
