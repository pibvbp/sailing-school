# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-01

First public release.

### Added

- **Lessons.** 18 guided lessons in six modules: First steps, How sails work, Trim and balance, Manoeuvres, Spinnaker
  and Tactics.
  - Every task is checked against the live simulation.
  - Hints react to what the boat is doing, and "Show me" lets the crew demonstrate.
  - Each lesson ends with a short quiz, and progress is saved in the browser.
  - Each step switches on only the overlays it talks about, and a lesson gives the learner's own overlays and camera
    back when it ends.
- **Free sail.** A windward–leeward course, with settings for the wind speed (4–25 knots) and direction, gusts,
  wind shifts (up to ±15°, every 60–300 s) and the time of day. An autopilot holds a close reach until you take the
  tiller.
- **Sail lab.** The boat is towed at a steady speed on a fixed heading. You set the apparent wind angle, the wind and
  the tow speed (held just under the wind speed), and read each sail's lift and drag coefficients, lift-to-drag
  ratio, drive and heeling force.
- **Physics.** A real-time simulation of the Kestrel 25, a fictional 25 ft keelboat, at a fixed 120 Hz:
  - a wind gradient with gusts, lulls and shifts, and the apparent wind at every sail section;
  - strip-theory sails, with luffing, attached-flow, stall and reversed-flow coefficients calibrated against the ORC
    VPP 2023 tables;
  - main–jib upwash, downwash and backwinding, and blanketing;
  - a boom on a one-sided mainsheet and traveler, a jib clew on two sheets with backing and a whisker pole, pushing
    the boom by hand, and a symmetric spinnaker whose shape follows its pole, sheet and leech;
  - hull resistance, keel and rudder foils that work at any angle, leeway, cross-flow drag, windage, the righting
    moment and helm balance;
  - a crew that tacks, gybes, hoists, douses, hikes and trims, and an autopilot for heading, true wind angle or
    apparent wind angle;
  - events such as crash gybes, being in irons, round-ups, spinnaker collapses and backwinding.
- **Polars.** The polar table is the steady state of the same simulation, regenerated with `pnpm polars`. It drives
  the polar chart, the target speeds and the laylines.
- **Overlays:** the wind triangle, force vectors, the points-of-sail wheel, airflow particles, a live flow slice with a
  pressure map, angle-of-attack colouring on the sails, x-ray water with a leeway picture at the keel, part labels,
  laylines, the track, a telltale close-up and a polar chart. Tags are laid out so that they never overlap one another
  or hide under a panel or the wind dial, and they hold their place while the boat rocks.
- **Instruments.** Boat speed, VMG, heading and course over ground, true and apparent wind, heel, leeway and rudder,
  and a round wind instrument.
- **Five cameras:** chase, helm, top (wind at the top of the screen), sail view and free. They keep the boat in the
  part of the window that the panels leave free, on a phone as well.
- **Graphics.**
  - An FFT ocean with whitecaps that break and fade, sun glitter, gust patches, a wake, the boat's own waves and bow
    spray, adapted from ABYSSAL and wave-riders.
  - A physically based sky with ray-marched volumetric cumulus clouds that drift with the wind, dim the sun when
    they cross it and are reflected in the sea, and a sun that follows the time of day. The default sky is scattered
    fair-weather cumulus that leave the boat in the sun most of the time.
  - Distant land with a lighthouse, and race marks that ride the waves.
  - A procedural boat with its crew, and translucent cloth sails with telltales, a windex and a burgee.
  - An AgX tone-mapped post chain, and four quality tiers with an automatic governor.
- **Sound.** A procedural soundscape of wind, water, flogging sails, the boom crashing across, the spinnaker collapsing
  and refilling, and winches, with no recordings.
- **Controls.** Keyboard, mouse and touch, with a phone layout that has an on-screen tiller and sheet sliders. The
  tiller can self-centre or stay where you leave it. Help covers the keys, the colours and a glossary of 98 sailing
  terms.
- **Tests.**
  - Unit tests of the physics, the flow solver, the rendering maths, the UI and the audio.
  - Playthroughs of every lesson in the real simulation.
  - Performance budgets, a real-WebAudio suite and end-to-end smoke tests.
- **Project.** Continuous integration and deployment to GitHub Pages, plus the README, the docs on the physics,
  architecture, rendering and writing lessons, and the contributing guide, code of conduct, security policy and issue
  templates.

[Unreleased]: https://github.com/pibvbp/sailing-school/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pibvbp/sailing-school/releases/tag/v1.0.0
