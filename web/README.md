# @tetsuo-ai/web

Private dashboard/client surface for AgenC operators.

This workspace owns the web dashboard build under `src/`, static assets under
`public/`, and browser-facing tests under `tests/`.

Local commands:

```bash
npm --prefix web run dev
npm --prefix web run build
npm --prefix web run typecheck
npm --prefix web run test
npm --prefix web run test:e2e
```

This is a product surface inside `agenc-core`, not a public builder package.

