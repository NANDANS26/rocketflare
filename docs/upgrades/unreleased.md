---
version: unreleased
previous: 0.18.1
date: null
breaking: false
migrations: []
areas: [config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`scripts/lib/kit-manifest.mjs` validates the kit contract's two new optional fields, `launchProvides.oidc.callbackPath` and `signedOutPath`, as Launch's zod schema does, defaulting both to Rocketflare's own paths.

- `scripts/lib/kit-manifest.mjs` → `callbackPath` (default `/auth/oidc/callback`) and `signedOutPath` (default `/login?signedOut=1`) must each be a path on the app's origin: one leading `/`, no scheme, host, whitespace or `#`; aligned with the meta-kit's copy (launch-kit 0.1.4).

## How to apply

1. Copy `scripts/lib/kit-manifest.mjs` and `apps/web/tests/config/launch-kit-manifest.test.ts` from the kit over your own; neither names the app.
2. Leave `launch.kit.json` as it is unless your app moved its sign-in routes: the defaults are this kit's `/auth/oidc/callback` and `/login?signedOut=1`.

## Conflicts to expect

None.

## Verify

1. `node scripts/kit-check.mjs` prints `✔ conforms to the Launch kit contract (schema 1)` and exits 0.
