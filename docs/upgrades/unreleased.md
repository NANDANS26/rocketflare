---
version: unreleased
previous: 0.20.0
date: null
breaking: false
migrations: []
areas:
  - agents
  - ai
touches_surfaces:
  - shared
  - web
requires_surfaces: []
manual: false
---

## What changed

Enforce per-agent execution policies and centralize salvage on budget exhaustion across agent tool loops.

- Added optional `policy` to shared `AgentMeta` (`maxTurns`, `maxToolCalls`, `maxDuration`, `repeatedFailureLimit`, `onExhaustion`).
- Enforced turn, tool-call, duration budgets, and consecutive tool failure limits centrally in `runToolLoop`.
- Centralized salvage logic for `onExhaustion: 'final-answer'`, falling back to a structured call over the terminal tool.
- Displayed agent execution policy limits on the Agents page UI.

## How to apply

1. Run `pnpm install` and `pnpm typecheck` to verify updated shared `AgentMeta` types.
2. If custom agents implement custom salvage routines, remove the duplicate fallback and configure `policy: { onExhaustion: 'final-answer' }` on their `AgentMeta`.

## Conflicts to expect

`apps/web/src/api/services/ai/kit.ts` → `runToolLoop` policy support → merge policy loop controls.

## Verify

1. Run `pnpm --filter @rocketflare/web exec vitest run --project config tests/config/agent-execution-policy.test.ts`.
2. Run `pnpm typecheck`.
3. Run `pnpm lint`.
