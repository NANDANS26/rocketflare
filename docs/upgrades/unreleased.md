---
version: unreleased
previous: 0.20.0
date: null
breaking: false
migrations: ["agent_runs gains exclusive (default true); agent_runs_active_exclusive_idx covers only rows where it is true"]
areas: [db, api, shared, docs]
touches_surfaces: [feature-agents]
requires_surfaces: [feature-agents]
manual: false
---

## What changed

An agent can now declare `exclusive: false` and run any number of times at once per organisation, and a plugin agent can ask a person questions through `ctx.interrupt`.

- `agent_runs` gains `exclusive` (default `true`); `enqueueRun` copies the agent's `meta.exclusive` onto the row, and `agent_runs_active_exclusive_idx` covers only rows where it is true. A non-exclusive agent's enqueue is never `deduplicated`. Every kit agent stays exclusive. Why: `docs/CONCEPTS.md` §9 (Agents).
- The plugin `AgentCtx` (`@/plugins/api`) gains `interrupt(ask)` and `chatModel { provider, model }`; `AgentInterruptAsk` and `AgentInterruptAnswer` are exported beside it.
- `PROMPT_REGISTRY` is typed so a plugin's prompt key indexes it; the first plugin to declare a prompt failed typecheck in `services/prompts.ts`.
- `tests/api/agent-runs.test.ts`, `ai-prompts.test.ts` and `agent-models.test.ts` compare only the kit's own agents and prompts, so an installed plugin's agent or prompt no longer fails them.

## How to apply

1. Port the `exclusive` column and the narrowed `agent_runs_active_exclusive_idx` predicate in `apps/web/src/db/schema/agent-runs.ts`, then run `pnpm db:generate --name kit-agent-runs-non-exclusive` and `pnpm db:migrate`; every existing row defaults to `exclusive = true` and keeps its guarantee.
2. Port the `exclusive: agent.meta.exclusive` value and the `!agent.meta.exclusive` rethrow in `enqueueRun` (`apps/web/src/api/services/agents/runs.ts`).
3. Port `interrupt` and `chatModel` into `AgentCtx` and `agentCtx()` in `apps/web/src/plugins/api/ai.ts`, export `AgentInterruptAsk` and `AgentInterruptAnswer` from `apps/web/src/plugins/api/index.ts`, then run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.
4. Port the type assertion on `PROMPT_REGISTRY` in `apps/web/src/api/services/prompts.ts`.
5. Nothing to do for an app whose agents are all exclusive: no behaviour changes until an agent declares `exclusive: false`.

## Conflicts to expect

- `apps/web/tests/api/agent-runs.test.ts` → the `GET /api/agents` case filters to `CORE_AGENT_KEYS` → keep the filter and add any app agent to its own test.
- `apps/web/tests/api/ai-prompts.test.ts`, `apps/web/tests/api/agent-models.test.ts` → the prompt lists filter to `CORE_PROMPT_REGISTRY` → keep the filter.

## Verify

1. `pnpm gate` passes.
2. `pnpm web test:api -- agent-runs-non-exclusive` passes: two active runs of a non-exclusive agent in one organisation, and an exclusive agent's second enqueue still refused with 409 `agent_run_active`.
3. `psql "$DATABASE_URL" -c '\d agent_runs'` lists `exclusive boolean not null default true` and the index predicate `WHERE exclusive AND status IN (…)`.
