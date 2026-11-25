# Contributing

Thanks for wanting to help! A few notes so your change lands smoothly:

- **Edit `src/`, then run `npm run build`.** `dist/coverflux.js` and `web/coverflux-web.js` are generated and committed; CI fails if they are stale.
- **`npm test` must pass.** Beat-engine changes: also run `npm run beat-eval -- <your songs>` against reference beats (see `tools/analyze/`) and include the numbers in the PR. Don't commit third-party audio or its reference beats.
- **New modes** go into the SCENE shader in `src/core.js` (a `mXxx(vec2 p)` function + an entry in `PRESETS`). A mode must be a closed loop: identity at `uPhi = 0` and `uPhi = 1`. Check with `npm run modes`.
- **New platforms** need a host adapter in `src/adapters/` (interface documented at the top of `src/core.js`).
- Keep UI strings bilingual via `t("Deutsch", "English")`.
- Respect `prefers-reduced-motion`.
