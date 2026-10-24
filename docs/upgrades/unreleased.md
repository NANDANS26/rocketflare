---
version: unreleased
previous: 0.22.0
date: null
breaking: false
migrations: []
areas: [api, ui, docs]
touches_surfaces:
  - feature-agents
  - feature-knowledge
requires_surfaces: []
manual: false
---

## What changed

Plugins can start agent runs from jobs, crons and inbound email with an idempotency key, agents and tools get `storage()`, converted text with NUL bytes now indexes, and unlabelled plugin nav groups share one block.

- `ctx.startAgentRun({ agentKey, tenantId, input, idempotencyKey?, concurrencyKey?, triggeredBy? })` → `{ runId, status, deduplicated }` on `JobCtx`, `CronCtx`, `EmailCtx` and `PublicCtx` (`BackgroundMethods`, `apps/web/src/plugins/api/agent-runs.ts`), through the route's own `enqueueRun` ([CONCEPTS §16](../CONCEPTS.md#16-plugins)).
- `enqueueRun({ idempotencyKey })`: the run id is derived from (tenant, agent, key) by `idempotentRunId`, so a repeat answers the first run, settled or not; no migration ([CONCEPTS §9](../CONCEPTS.md#9-ai-layer)).
- `@testkit/unit`: `makeJobCtx`, `makeCronCtx` and `makeEmailCtx` return `Fake{Job,Cron,Email}Ctx` with `startedRuns` (`{ input, result?, error? }[]`) and accept a `startAgentRun` replacement.
- `AgentCtx` and `ToolCtx` gain `storage()`, the same `FILES` service as every other context (`filesStorage` in `apps/web/src/plugins/api/storage.ts`).
- `stripControlChars` / `stripControlCharsDeep` (`apps/web/src/api/utils/core/text.ts`) remove NUL and C0 controls except tab, LF and CR before `documents.content`, `chunks.text` and every `ai_spans` string are written — Postgres refused them (22021 / 22P05).
- `composeNav` folds an unlabelled plugin nav group into an unlabelled group right before it, so several one-page plugins read as one list.
- `docs/upgrades/0.22.0.md` no longer declares `requires_surfaces: [feature-agents]`, which wrongly skipped the email slot for apps without the agent runtime; `docs/plugin-api.md` now expands `BackgroundMethods`.

## How to apply

1. Copy `apps/web/src/api/utils/core/text.ts` and `apps/web/tests/config/strip-control-chars.test.ts` from the kit.
2. Port the kit's diff to `apps/web/src/api/services/ai/ingest.ts` (`stripControlChars` on the converted text, the decoded upload text, `ingestText`'s text and each `chunks.text`) and to `apps/web/src/api/observability/span-store.ts` (`toSpanRow` strips `name`, `statusMessage`, `toolName`, `attributes` and `content`); skip the `ingest.ts` part when the `feature-knowledge` surface is absent.
3. Copy `apps/web/src/plugins/api/storage.ts` from the kit, then port the kit's diffs to `apps/web/src/plugins/api/{http,ai,jobs}.ts` so every `storage()` returns `filesStorage(env)` and `ToolCtx` / `AgentCtx` declare and build `storage()`.
4. When the `feature-agents` surface is present: port the `idempotencyKey` changes in `apps/web/src/api/services/agents/runs.ts` (`idempotentRunId`, `ensureInstance`, `isInstanceExistsError`, and the delete-on-create-failure branch of `enqueueRun`).
5. When the `feature-agents` surface is present: copy `apps/web/src/plugins/api/agent-runs.ts` from the kit, add `startAgentRun` to `BackgroundMethods` and `backgroundMethods()` in `apps/web/src/plugins/api/jobs.ts`, re-export `StartAgentRun`, `StartAgentRunInput` and `StartedAgentRun` from `apps/web/src/plugins/api/jobs.ts` and `apps/web/src/plugins/api/index.ts`, and copy `apps/web/tests/api/plugin-agent-runs.test.ts`.
6. When the `feature-agents` surface is present: add `apps/web/src/plugins/api/agent-runs.ts` and `apps/web/tests/api/plugin-agent-runs.test.ts` to its `paths` in `.rocketflare.json`, and `apps/web/src/plugins/api/jobs.ts#BackgroundMethods.startAgentRun`, `apps/web/src/plugins/api/index.ts#StartAgentRun` and `apps/web/tests/kit/unit.ts#recordingAgentRuns` to its `registries`.
7. Port the background builders in `apps/web/tests/kit/unit.ts` (`BackgroundCtxOptions`, `RecordedAgentRun`, `RecordsAgentRuns`, `recordingAgentRuns`, the `Fake{Job,Cron,Email}Ctx` types); without the `feature-agents` surface, leave those builders as they are.
8. Port the kit's diff to `composeNav` in `apps/web/src/ui/components/SideNav.tsx` and its case in `apps/web/tests/ui/sidenav.test.tsx`.
9. Add `'BackgroundMethods'`, `'StartAgentRunInput'` and `'StartedAgentRun'` to `EXPANDED` in `scripts/plugin-api-doc.mjs`, then run `node scripts/plugin-api-doc.mjs`.
10. In each of your own plugins, replace a hand-built `env.FILES` read in an agent or tool with `ctx.storage()`, and replace a job's workaround for starting a run (an HTTP call to `/api/agents/runs`, a direct `agent_runs` insert) with `ctx.startAgentRun({ …, idempotencyKey: '<what>:<id>' })`.

## Conflicts to expect

- `apps/web/src/ui/components/SideNav.tsx` → `composeNav` merges unlabelled groups → keep any nav ordering of your own beside the new branch.
- `apps/web/tests/kit/unit.ts` → the background builders return `Fake*Ctx` and take `BackgroundCtxOptions` → keep any builder options you added.
- `apps/web/src/plugins/api/jobs.ts` → `backgroundMethods(ctx)` takes the whole context and no longer builds R2 itself → keep any method you added.

## Verify

1. `pnpm gate` passes.
2. `pnpm web test:api -- plugin-agent-runs document-convert-job traces` passes, including "a redelivered job answers the first run — even after it settled — and starts nothing" and "a conversion with NUL and control characters in its text still stores and indexes".
3. `pnpm web test:ui -- sidenav` includes "folds unlabelled groups into the unlabelled group above them".
4. `node scripts/plugin-api-doc.mjs --check` reports the document up to date.
