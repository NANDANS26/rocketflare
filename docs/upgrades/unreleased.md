---
version: unreleased
previous: 0.20.0
date: null
breaking: true
migrations:
  - "agent_runs gains concurrency_key (nullable; active rows backfilled to ''); agent_runs_active_exclusive_idx becomes (tenant_id, agent_key, concurrency_key) over active rows with a key"
  - "agent_runs gains batch_id (uuid); new indexes agent_runs (tenant_id, status), partial agent_runs (tenant_id, batch_id) and partial ai_usage (tenant_id, agent_run_id)"
areas: [db, api, shared, cli, config, ui, docs]
touches_surfaces:
  - feature-agents
  - example-agent-summarize-text
  - example-agent-research-topic
  - example-agent-triage-research
requires_surfaces: [feature-agents]
manual: false
---

## What changed

Agents can run many at once, in batches and fan-outs, with a usage row per call, budgets and tool-loop policies; plugin agents can ask questions; and `pnpm web agent:replay` re-runs past runs with today's code.

- `agent_runs.concurrency_key` is the exclusive slot a run holds: `''` for an exclusive agent (one per organisation), `enqueueRun({ concurrencyKey })` for one active run per key, NULL for `exclusive: false` (no slot, never `deduplicated`). The unique index is `(tenant_id, agent_key, concurrency_key)` over active rows with a key; `findActiveRun` takes the key (default `''`). `triage-research` is now `exclusive: false`. From PR #77.
- The plugin `AgentCtx` (`@/plugins/api`) gains `interrupt(ask)` and `chatModel { provider, model }`; `AgentInterruptAsk` / `AgentInterruptAnswer` are exported. `PROMPT_REGISTRY` is typed so a plugin's prompt key indexes it. `agent-runs`, `ai-prompts` and `agent-models` tests compare only the kit's own agents and prompts.
- Replay (D38): `replay.ts` (`replayRun`, `listReplayableRuns`, `diffJson`, `ReplayMissError`), `scripts/agent-replay.ts` + the `agent:replay` script (`--candidate`, `--live`), `ctx.once(key, fn, { replay: 'rerun' | 'inner' })`, `decideWithShapes` / `toDecision` exported from `decisions.ts`, the skill `rf-agent-replay`, and `PROCESS_TEST_TIMEOUT` on the `config` / `kit-only` vitest projects.
- `enqueueRun(db, cfg, env, input)` takes the config and enforces `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` (default 50, 429 `agent_runs_limit`) and `AGENT_TENANT_DAILY_COST_USD` (429 `ai_budget_exceeded`).
- `POST /api/agents/runs/batch` (`enqueueRunBatch`, `createAgentRunBatch{Request,Response}Schema`, `AGENT_RUN_BATCH_MAX` = 100): one non-exclusive agent (400 `agent_exclusive` otherwise), per-input errors, one `createBatch()` with a per-instance fallback; `GET /api/agents/runs?batchId=`.
- `ctx.scope(prefix)` and `ctx.map(key, items, fn, { concurrency, keyOf })` (`services/agents/fanout.ts`).
- The ledger is one `ai_usage` row PER CALL carrying `agent_run_id`, written as each call returns by the run's meter (`services/agents/budget.ts`) for every call through `ctx.chat.client` and `ctx.decide`, so a run cancelled mid-loop keeps every turn it paid for (issue #2, from PR #74). The example agents no longer call `recordUsage`; `ctx.recordUsage(call)` is for a client an agent builds itself; `GET /api/agents/runs/:id` returns `usage`.
- Budgets: `meta.budget { maxTokens, maxCostUsd }` over `AGENT_RUN_MAX_TOKENS` / `AGENT_RUN_MAX_COST_USD`, checked before each metered call across attempts; over → `failed`, event code `agent_budget_exceeded`, not retried.
- Policies (issue #1, from PR #73): `meta.policy { maxTurns, maxToolCalls, maxDurationSeconds, repeatedFailureLimit, onExhaustion }`, passed to `runToolLoop` as `policy`, counted across attempts (`ToolLoopCheckpoint.activeMs` carries active time). `'final-answer'` (default) forces one call to the terminal tool (`salvaged: true`); `'fail'` throws `ToolLoopExhaustedError` → `failed`, event code `agent_policy_exhausted`. No policy, no change. `research-topic`'s hand-written salvage is now its policy; `GET /api/agents` items carry `policy`, shown on the Agents page.
- `runToolLoop`'s `authorizeTool(call)` refuses a tool call by rule before it is gated or run (issue #3, from PR #75).
- CLI: `rocketflare agents list`, `agents run <key> --input x.json | --batch x.jsonl`, `agents runs list [--batch id]`. Rationale and known gaps: `docs/CONCEPTS.md` §9 "Agents", "Replay (D38)", "Volume (D39)" and "Policy (D39)".

## How to apply

1. Port `concurrencyKey` and `batchId`, the `agent_runs_active_exclusive_idx` columns and predicate, and the indexes `agent_runs_tenant_status_idx` and `agent_runs_tenant_batch_idx` into `apps/web/src/db/schema/agent-runs.ts`, and the partial index `ai_usage_tenant_run_idx` into `apps/web/src/db/schema/ai-usage.ts`.
2. Run `pnpm db:generate --name kit-agent-runs-concurrency`, add `UPDATE "agent_runs" SET "concurrency_key" = '' WHERE "status" IN ('queued', 'running', 'awaiting_input');--> statement-breakpoint` between its `ADD COLUMN` and `CREATE UNIQUE INDEX` so every active run keeps its tenant-wide slot, then run `pnpm db:migrate`.
3. Copy from the kit: `apps/web/src/api/services/agents/{replay,budget,fanout}.ts`, `apps/web/scripts/agent-replay.ts`, `apps/cli/src/commands/agents.ts`, `.claude/skills/rf-agent-replay/`, and the tests `apps/web/tests/api/{agent-replay,agent-volume,agent-runs-non-exclusive}.test.ts`, `apps/web/tests/config/{agent-replay-script,agent-policy}.test.ts`, `apps/cli/tests/agents.test.ts`.
4. Add `apps/web/tests/api/agent-volume.test.ts`, `apps/web/scripts/agent-replay.ts`, `apps/web/tests/config/agent-replay-script.test.ts` and `.claude/skills/rf-agent-replay/**` to the `feature-agents` surface's `paths` in `.rocketflare.json`.
5. Port the kit's diffs to `services/agents/{runs,runtime,registry,decisions}.ts`, `services/agents/examples/*.ts`, `services/ai/{kit,usage}.ts`, `services/prompts.ts`, `routes/agents.ts`, `plugins/api/{ai,index}.ts`, `packages/shared/src/ai/agents.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/ai/pricing.ts` (export `MICROCENTS_PER_USD`), `apps/web/src/config.ts`, `apps/web/src/ui/pages/agents/AgentsPage.tsx`, `apps/cli/src/cli.ts` and `apps/web/tests/mocks/bindings.ts` (`RecordingWorkflow.createBatch`, `failCreate`, `batches`).
6. Add `"agent:replay": "dotenv -e .dev.vars -- tsx scripts/agent-replay.ts"` to the `scripts` of `apps/web/package.json`, and `const PROCESS_TEST_TIMEOUT = 20_000 * LATENCY_FACTOR` plus `testTimeout: PROCESS_TEST_TIMEOUT` to the `config` (and `kit-only`, when present) projects of `apps/web/vitest.config.ts`.
7. Add `AGENT_MAX_ACTIVE_RUNS_PER_TENANT = "50"` and the commented budget block to the `[vars]` of BOTH `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`, the blank `AGENT_RUN_MAX_TOKENS=`, `AGENT_RUN_MAX_COST_USD=` and `AGENT_TENANT_DAILY_COST_USD=` lines to `apps/web/.dev.vars.example`, then run `pnpm web types`.
8. Run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.
9. Change every `enqueueRun(db, env, …)` in your own code to `enqueueRun(db, cfg, env, …)`.
10. In each of your own agents: delete every `recordUsage(...)` and every `onUsage` that writes usage (the runtime writes one row per call; a second write double-counts); add `{ replay: 'rerun' }` to every `ctx.once` whose `fn` is only a model call; set `exclusive: false` where two runs in one organisation never share state; add `budget` to an agent that runs at volume.
11. In each of your own `runToolLoop` agents, replace a hand-written turn cap and "no terminal call" salvage with `meta.policy` and `policy: meta.policy` on the loop, and drop the salvage code.
12. If you renamed or deleted `triage-research`, skip its edits and point `agent-replay.test.ts` at an agent you kept.
13. Tell anyone reading `ai_usage` that an agent run is now several rows (one per call), grouped by `agent_run_id`.

## Conflicts to expect

- `apps/web/src/api/services/agents/runs.ts` → `enqueueRun` gained `cfg`, the slot and the capacity gate → re-apply your enqueue changes after the slot lookup.
- `apps/web/src/api/services/agents/runtime.ts` → the `AgentContext` literal is `withFanout({ … })` with `recordUsage`, the client is wrapped by `meterChatClient`, and `executeRun` has a `ToolLoopExhaustedError` arm → keep your own fields inside the literal.
- `apps/web/src/api/services/agents/examples/*.ts` → `recordUsage` calls were deleted and `research-topic`'s salvage became `meta.policy` → delete yours the same way; never keep both.
- `apps/web/src/api/services/agents/decisions.ts` → `createDecide` ends in `decideWithShapes(...)` → keep your changes inside the raw decide function.
- `apps/web/tests/api/{agent-runs,ai-prompts,agent-models}.test.ts` → filtered to the kit's own agents and prompts → keep the filter and test your own in your own file.

## Verify

1. `pnpm gate` passes.
2. `psql "$DATABASE_URL" -c '\d agent_runs'` lists `concurrency_key text`, `batch_id uuid` and `agent_runs_active_exclusive_idx` UNIQUE on `(tenant_id, agent_key, concurrency_key) WHERE status IN (…) AND concurrency_key IS NOT NULL`.
3. `pnpm web agent:replay triage-research --tenant <slug>` prints one line per settled run and a summary line.
4. `pnpm cli agents list` marks `triage-research` as batchable, and `pnpm cli agents run triage-research --batch questions.jsonl` prints one run per line.
5. `select count(*) from ai_usage where agent_run_id is null and feature like 'agent:%' and at > now() - interval '1 hour'` is 0 after a run.
