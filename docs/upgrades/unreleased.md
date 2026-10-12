---
version: unreleased
previous: 0.19.0
date: null
breaking: false
migrations: []
areas: [api, config, docs]
touches_surfaces: [feature-agents, example-agent-triage-research]
requires_surfaces: []
manual: false
---

## What changed

Agent replay (D38): `pnpm web agent:replay <agent> --tenant <slug>` runs an agent's current code over its settled runs, answering every recorded decision, effect and interrupt from Postgres, and reports what would change — read-only, no model calls by default.

- New `apps/web/src/api/services/agents/replay.ts`: `replayRun`, `listReplayableRuns`, `diffJson`, `ReplayMissError`; strict and `--live` modes; per-run verdict, output diff and decision status (`served`/`drift`/`stale`/`asked`/`missing`/`unused`).
- New `apps/web/scripts/agent-replay.ts` and the `agent:replay` script in `apps/web/package.json`; `--candidate <file>` replays another definition with the same key.
- `--live` reads the tenant's knowledge base and prompts as they are today, borrows the Workers AI binding through wrangler's `getPlatformProxy`, and prints `liveReplayWarnings` when knowledge search would be degraded.
- `ctx.once(key, fn, { replay: 'rerun' })`: an optional third argument read only by a live replay; `triage-research` marks its answer call with it.
- `decisions.ts` exports `decideWithShapes` (the `sift`/`pick` shapes over any raw decide) and `toDecision`; `createDecide` is built on it, with no behaviour change.
- `apps/web/vitest.config.ts`: the `config` and `kit-only` projects get `testTimeout: PROCESS_TEST_TIMEOUT` (20 s × the latency factor) — their end-to-end tooling tests run child processes and timed out under a loaded gate.
- New skill `.claude/skills/rf-agent-replay`. Rationale and known gaps: `docs/CONCEPTS.md` §9 "Replay (D38)".

## How to apply

1. Copy `apps/web/src/api/services/agents/replay.ts`, `apps/web/scripts/agent-replay.ts`, `apps/web/tests/api/agent-replay.test.ts`, `apps/web/tests/config/agent-replay-script.test.ts` and `.claude/skills/rf-agent-replay/` from the kit.
2. Add `"agent:replay": "dotenv -e .dev.vars -- tsx scripts/agent-replay.ts"` to the `scripts` of `apps/web/package.json`.
3. In `apps/web/src/api/services/agents/decisions.ts`, move the `sift`/`pick` shapes out of `createDecide` into an exported `decideWithShapes(raw)`, have `createDecide` return `decideWithShapes(...)`, and export `toDecision`.
4. In `apps/web/src/api/services/agents/registry.ts`, add the exported `OnceOptions` interface (`{ replay?: 'serve' | 'rerun' }`) and change `AgentContext.once` to `once<T>(key, fn, options?: OnceOptions)`.
5. In each of your own agents, add `{ replay: 'rerun' }` as the third argument of every `ctx.once` whose `fn` is only a model call, and leave every `ctx.once` with a side effect unchanged.
6. In `apps/web/vitest.config.ts`, add `const PROCESS_TEST_TIMEOUT = 20_000 * LATENCY_FACTOR` after `LATENCY_FACTOR` and set `testTimeout: PROCESS_TEST_TIMEOUT` in the `test` block of the `config` project and of the `kit-only` project when it exists.
7. If you renamed `triage-research` or deleted it, skip its `{ replay: 'rerun' }` edit; the replay test drives it, so delete `apps/web/tests/api/agent-replay.test.ts` too or point the test at an agent you kept.

## Conflicts to expect

- `apps/web/src/api/services/agents/decisions.ts` → `createDecide`'s body now ends in `decideWithShapes(...)` → keep your own changes inside the raw decide function.
- `apps/web/src/api/services/agents/examples/triage-research.ts` → the `triage:answer` `once` gained a third argument and was reformatted → keep your edits to the call, add `{ replay: 'rerun' }`.

## Verify

1. `pnpm gate` passes.
2. `pnpm web agent:replay triage-research` lists the tenants that have runs of the agent, or says none do, and exits 2.
3. `pnpm web agent:replay triage-research --tenant <slug>` prints one line per settled run and a summary line.
