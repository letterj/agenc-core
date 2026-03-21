# Core Commands And Validation

This file maps the local validation surface for `agenc-core`.

## Core Repo Commands

```bash
npm install
npm run build
npm run typecheck
npm run test
npm run test:cross-repo-integration
npm run build:product-surfaces
npm run typecheck:product-surfaces
npm run test:product-surfaces
npm run typecheck:runtime-examples
npm run check:private-kernel-surface
npm run check:private-kernel-distribution
npm run check:proof-harness-boundary
npm run pack:smoke:skip-build
```

## When To Run What

- runtime, MCP, or docs-mcp change: `npm run build`, `npm run typecheck`, `npm run test`
- cross-repo runtime/protocol contract change: `npm run test:cross-repo-integration`
- dashboard, mobile, or demo-app change: `npm run build:product-surfaces`, `npm run typecheck:product-surfaces`, `npm run test:product-surfaces`
- internal example change: `npm run typecheck:runtime-examples`
- packaging or distribution change: `npm run check:private-kernel-distribution` and `npm run pack:smoke:skip-build`
- proof-harness surface change: `npm run check:proof-harness-boundary`

## Private Registry And Distribution

Useful distribution and registry commands include:

- `npm run private-registry:up`
- `npm run private-registry:down`
- `npm run private-registry:health`
- `npm run private-registry:rehearse`
- `npm run stage:private-kernel-distribution`
- `npm run dry-run:private-kernel-distribution`

Use the package policy docs in `docs/PRIVATE_KERNEL_DISTRIBUTION.md` and `docs/PRIVATE_KERNEL_SUPPORT_POLICY.md` for policy, not this command index.

