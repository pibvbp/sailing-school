## What and why

<!-- What does this change, and why? Link the issue it closes, e.g. "Closes #123". -->

## How I checked it

<!-- Tick what you ran. The last three are needed only when the change touches their area. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:perf`: simulation, flow solver or overlays
- [ ] `pnpm test:audio`: sound
- [ ] `pnpm e2e`: start-up, interface, build or deployment

## Checklist

- [ ] Physics: the ORC envelope and plausibility tests pass, and `src/sim/data/polars.json` is regenerated with `pnpm polars`.
- [ ] Lessons: every task still needs the learner, and "Show me" still completes it (the curriculum tests).
- [ ] Visuals: before-and-after screenshots below, with the same camera, time of day and quality tier.
- [ ] Docs: the README and `docs/` are updated if behaviour, controls or numbers changed.
- [ ] Third-party code: the licence header is kept and `THIRD_PARTY_NOTICES.md` is updated.

## Screenshots

<!-- For visual changes: before / after, taken with scripts/snap.mjs or in the browser. -->
