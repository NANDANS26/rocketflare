---
version: unreleased
previous: 0.20.0
date: null
breaking: false
migrations: ["agent_runs gains concurrency_key (nullable; active rows backfilled to ''); agent_runs_active_exclusive_idx becomes (tenant_id, agent_key, concurrency_key) over active rows with a key"]
areas: [db, api, shared, config, docs]
touches_surfaces: [feature-agents, example-agent-triage-research]
requires_surfaces: [feature-agents]
manual: false
---

## What changed

An agent can now run many times at once per organisation (`exclusive: false`, or one active run per `concurrencyKey`), a plugin agent can ask questions through `ctx.interrupt`, and `pnpm web agent:replay` re-runs an agent's settled runs with today's code.

- `agent_runs` gains `concurrency_key`, the exclusive slot a run holds: `''` for an exclusive agent (one per organisation), the caller's `enqueueRun({ concurrencyKey })` to narrow it to one active run per key, NULL for an `exclusive: false` agent, which holds no slot and is never `deduplicated`. `agent_runs_active_exclusive_idx` is now `(tenant_id, agent_key, concurrency_key)` over active rows with a key, and `findActiveRun` takes the key as a fourth argument (default `''`). Every kit agent stays exclusive. Why: `docs/CONCEPTS.md` §9 (Agents).
- The plugin `AgentCtx` (`@/plugins/api`) gains `interrupt(ask)` and `chatModel { provider, model }`; `AgentInterruptAsk` and `AgentInterruptAnswer` are exported beside it.
- `PROMPT_REGISTRY` is typed so a plugin's prompt key indexes it; the first plugin to declare a prompt failed typecheck in `services/prompts.ts`.
- `tests/api/agent-runs.test.ts`, `ai-prompts.test.ts` and `agent-models.test.ts` compare only the kit's own agents and prompts, so an installed plugin's agent or prompt no longer fails them.
- Agent replay (D38): `pnpm web agent:replay <agent> --tenant <slug>` runs an agent's current code over its settled runs, answering every recorded decision, effect and interrupt from Postgres, and reports what would change — read-only, no model calls by default.
- New `apps/web/src/api/services/agents/replay.ts`: `replayRun`, `listReplayableRuns`, `diffJson`, `ReplayMissError`; strict and `--live` modes; per-run verdict, output diff and decision status (`served`/`drift`/`stale`/`asked`/`missing`/`unused`).
- New `apps/web/scripts/agent-replay.ts` and the `agent:replay` script in `apps/web/package.json`; `--candidate <file>` replays another definition with the same key.
- `--live` reads the tenant's knowledge base and prompts as they are today, borrows the Workers AI binding through wrangler's `getPlatformProxy`, and prints `liveReplayWarnings` when knowledge search would be degraded.
- `ctx.once(key, fn, { replay: 'rerun' })`: an optional third argument read only by a live replay; `triage-research` marks its answer call with it.
- `decisions.ts` exports `decideWithShapes` (the `sift`/`pick` shapes over any raw decide) and `toDecision`; `createDecide` is built on it, with no behaviour change.
- `apps/web/vitest.config.ts`: the `config` and `kit-only` projects get `testTimeout: PROCESS_TEST_TIMEOUT` (20 s × the latency factor) — their end-to-end tooling tests run child processes and timed out under a loaded gate.
- New skill `.claude/skills/rf-agent-replay`. Rationale and known gaps: `docs/CONCEPTS.md` §9 "Replay (D38)".

## How to apply

1. Port the `concurrencyKey` column and the `agent_runs_active_exclusive_idx` columns and predicate in `apps/web/src/db/schema/agent-runs.ts`, then run `pnpm db:generate --name kit-agent-runs-concurrency`.
2. Add `UPDATE "agent_runs" SET "concurrency_key" = '' WHERE "status" IN ('queued', 'running', 'awaiting_input');--> statement-breakpoint` to the generated SQL between the `ADD COLUMN` and the `CREATE UNIQUE INDEX`, so every run active at migration time keeps its tenant-wide slot, then run `pnpm db:migrate`.
3. Port `EnqueueRunInput.concurrencyKey`, the `concurrencyKey` written by `enqueueRun`, its `concurrencyKey === null` rethrow and the fourth `concurrencyKey` parameter of `findActiveRun` in `apps/web/src/api/services/agents/runs.ts`; a call of `findActiveRun` with three arguments keeps reading the tenant-wide slot.
4. Port `interrupt` and `chatModel` into `AgentCtx` and `agentCtx()` in `apps/web/src/plugins/api/ai.ts`, export `AgentInterruptAsk` and `AgentInterruptAnswer` from `apps/web/src/plugins/api/index.ts`, then run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.
5. Port the type assertion on `PROMPT_REGISTRY` in `apps/web/src/api/services/prompts.ts`.
6. Copy `apps/web/src/api/services/agents/replay.ts`, `apps/web/scripts/agent-replay.ts`, `apps/web/tests/api/agent-replay.test.ts`, `apps/web/tests/config/agent-replay-script.test.ts` and `.claude/skills/rf-agent-replay/` from the kit.
7. Add `"agent:replay": "dotenv -e .dev.vars -- tsx scripts/agent-replay.ts"` to the `scripts` of `apps/web/package.json`.
8. In `apps/web/src/api/services/agents/decisions.ts`, move the `sift`/`pick` shapes out of `createDecide` into an exported `decideWithShapes(raw)`, have `createDecide` return `decideWithShapes(...)`, and export `toDecision`.
9. In `apps/web/src/api/services/agents/registry.ts`, add the exported `OnceOptions` interface (`{ replay?: 'serve' | 'rerun' }`) and change `AgentContext.once` to `once<T>(key, fn, options?: OnceOptions)`.
10. In each of your own agents, add `{ replay: 'rerun' }` as the third argument of every `ctx.once` whose `fn` is only a model call, and leave every `ctx.once` with a side effect unchanged.
11. In `apps/web/vitest.config.ts`, add `const PROCESS_TEST_TIMEOUT = 20_000 * LATENCY_FACTOR` after `LATENCY_FACTOR` and set `testTimeout: PROCESS_TEST_TIMEOUT` in the `test` block of the `config` project and of the `kit-only` project when it exists.
12. If you renamed `triage-research` or deleted it, skip its `{ replay: 'rerun' }` edit; the replay test drives it, so delete `apps/web/tests/api/agent-replay.test.ts` too or point the test at an agent you kept.

## Conflicts to expect

- `apps/web/tests/api/agent-runs.test.ts` → the `GET /api/agents` case filters to `CORE_AGENT_KEYS` → keep the filter and add any app agent to its own test.
- `apps/web/tests/api/ai-prompts.test.ts`, `apps/web/tests/api/agent-models.test.ts` → the prompt lists filter to `CORE_PROMPT_REGISTRY` → keep the filter.
- `apps/web/src/api/services/agents/decisions.ts` → `createDecide`'s body now ends in `decideWithShapes(...)` → keep your own changes inside the raw decide function.
- `apps/web/src/api/services/agents/examples/triage-research.ts` → the `triage:answer` `once` gained a third argument and was reformatted → keep your edits to the call, add `{ replay: 'rerun' }`.

## Verify

1. `pnpm gate` passes.
2. `pnpm web test:api -- agent-runs-non-exclusive` passes: two active runs of a non-exclusive agent in one organisation with a NULL `concurrency_key`, an exclusive agent's second enqueue still refused with 409 `agent_run_active`, and `enqueueRun({ concurrencyKey })` deduplicating per key.
3. `psql "$DATABASE_URL" -c '\d agent_runs'` lists `concurrency_key text` and `agent_runs_active_exclusive_idx` UNIQUE on `(tenant_id, agent_key, concurrency_key) WHERE status IN (…) AND concurrency_key IS NOT NULL`.
4. `pnpm web agent:replay triage-research` lists the tenants that have runs of the agent, or says none do, and exits 2.
5. `pnpm web agent:replay triage-research --tenant <slug>` prints one line per settled run and a summary line.
