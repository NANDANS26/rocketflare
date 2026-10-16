---
version: unreleased
previous: 0.20.0
date: null
breaking: false
migrations: ["agent_runs gains concurrency_key (nullable; active rows backfilled to ''); agent_runs_active_exclusive_idx becomes (tenant_id, agent_key, concurrency_key) over active rows with a key"]
areas: [db, api, shared, docs]
touches_surfaces: [feature-agents]
requires_surfaces: [feature-agents]
manual: false
---

## What changed

An agent can now declare `exclusive: false` and run any number of times at once per organisation, a caller can narrow the exclusive slot to one run per key, and a plugin agent can ask questions through `ctx.interrupt`.

- `agent_runs` gains `concurrency_key`, the exclusive slot a run holds: `''` for an exclusive agent (one per organisation), the caller's `enqueueRun({ concurrencyKey })` to narrow it to one active run per key, NULL for an `exclusive: false` agent, which holds no slot and is never `deduplicated`. `agent_runs_active_exclusive_idx` is now `(tenant_id, agent_key, concurrency_key)` over active rows with a key, and `findActiveRun` takes the key as a fourth argument (default `''`). Every kit agent stays exclusive. Why: `docs/CONCEPTS.md` §9 (Agents).
- The plugin `AgentCtx` (`@/plugins/api`) gains `interrupt(ask)` and `chatModel { provider, model }`; `AgentInterruptAsk` and `AgentInterruptAnswer` are exported beside it.
- `PROMPT_REGISTRY` is typed so a plugin's prompt key indexes it; the first plugin to declare a prompt failed typecheck in `services/prompts.ts`.
- `tests/api/agent-runs.test.ts`, `ai-prompts.test.ts` and `agent-models.test.ts` compare only the kit's own agents and prompts, so an installed plugin's agent or prompt no longer fails them.

## How to apply

1. Port the `concurrencyKey` column and the `agent_runs_active_exclusive_idx` columns and predicate in `apps/web/src/db/schema/agent-runs.ts`, then run `pnpm db:generate --name kit-agent-runs-concurrency`.
2. Add `UPDATE "agent_runs" SET "concurrency_key" = '' WHERE "status" IN ('queued', 'running', 'awaiting_input');--> statement-breakpoint` to the generated SQL between the `ADD COLUMN` and the `CREATE UNIQUE INDEX`, so every run active at migration time keeps its tenant-wide slot, then run `pnpm db:migrate`.
3. Port `EnqueueRunInput.concurrencyKey`, the `concurrencyKey` written by `enqueueRun`, its `concurrencyKey === null` rethrow and the fourth `concurrencyKey` parameter of `findActiveRun` in `apps/web/src/api/services/agents/runs.ts`; a call of `findActiveRun` with three arguments keeps reading the tenant-wide slot.
4. Port `interrupt` and `chatModel` into `AgentCtx` and `agentCtx()` in `apps/web/src/plugins/api/ai.ts`, export `AgentInterruptAsk` and `AgentInterruptAnswer` from `apps/web/src/plugins/api/index.ts`, then run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.
5. Port the type assertion on `PROMPT_REGISTRY` in `apps/web/src/api/services/prompts.ts`.
6. Nothing more to do for an app whose agents are all exclusive: no behaviour changes until an agent declares `exclusive: false` or a caller passes `concurrencyKey`.

## Conflicts to expect

- `apps/web/tests/api/agent-runs.test.ts` → the `GET /api/agents` case filters to `CORE_AGENT_KEYS` → keep the filter and add any app agent to its own test.
- `apps/web/tests/api/ai-prompts.test.ts`, `apps/web/tests/api/agent-models.test.ts` → the prompt lists filter to `CORE_PROMPT_REGISTRY` → keep the filter.

## Verify

1. `pnpm gate` passes.
2. `pnpm web test:api -- agent-runs-non-exclusive` passes: two active runs of a non-exclusive agent in one organisation with a NULL `concurrency_key`, an exclusive agent's second enqueue still refused with 409 `agent_run_active`, and `enqueueRun({ concurrencyKey })` deduplicating per key.
3. `psql "$DATABASE_URL" -c '\d agent_runs'` lists `concurrency_key text` and `agent_runs_active_exclusive_idx` UNIQUE on `(tenant_id, agent_key, concurrency_key) WHERE status IN (…) AND concurrency_key IS NOT NULL`.
