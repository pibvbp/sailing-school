# Sailing School

An interactive, photoreal 3D sailing school that runs in the browser. It shows how the wind actually
drives a sailboat: apparent wind, lift and drag on the main, jib and spinnaker, the keel, heel and
balance, tacking and gybing. It is built on a real physics model, not on canned animation.

> 🚧 Under construction. The design is in [`docs/superpowers/specs`](docs/superpowers/specs) and the
> build plan in [`docs/superpowers/plans`](docs/superpowers/plans).

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5180 — demos at /demos/
pnpm test         # unit tests (physics, flow solver, lessons engine)
pnpm typecheck
pnpm build        # static site in dist/ (GitHub Pages base /sailing-school/)
node scripts/snap.mjs index.html snaps/app.png --wait 3000   # headless screenshot
```

## Licence

MIT. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
