// @vitest-isolate
// Mocks the agent registry, so this file needs its own module registry.
/**
 * `meta.exclusive: false` (D7): an agent that holds one person's conversation — several people
 * mid-way at once is the normal case — opts out of the one-active-run-per-tenant guarantee. The
 * row carries the flag so the partial unique index can read it: every enqueue is a run of its own,
 * never `deduplicated`, while an exclusive agent's second enqueue still answers the first run.
 *
 * No kit agent is non-exclusive, so `summarize-text` is made one here by mocking the registry's
 * `getAgent` — the only place `enqueueRun` reads the definition from.
 */
import { createAgentRunResponseSchema } from '@rocketflare/shared/ai/agents'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { agentRuns } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

vi.mock('@/api/services/agents/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/agents/registry')>()
  return {
    ...actual,
    getAgent: (key: Parameters<typeof actual.getAgent>[0]) => {
      const agent = actual.getAgent(key)
      return key === 'summarize-text'
        ? { ...agent, meta: { ...agent.meta, exclusive: false } }
        : agent
    },
  }
})

const db = setupTestDatabase()

const start = (
  cookie: Record<string, string>,
  env: ReturnType<typeof createTestEnv>,
  agentKey: string,
  input: unknown
) =>
  request(
    '/api/agents/runs?strict=1',
    { method: 'POST', headers: cookie },
    { env, json: { agentKey, input } }
  )

describe('non-exclusive agents', () => {
  it('two active runs of one agent in one tenant, each its own row and Workflow instance', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const env = createTestEnv()

    const first = await start(cookie, env, 'summarize-text', { text: 'First text.' })
    const second = await start(cookie, env, 'summarize-text', { text: 'Second text.' })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    const a = createAgentRunResponseSchema.parse(await json(first))
    const b = createAgentRunResponseSchema.parse(await json(second))
    expect(b.id).not.toBe(a.id)
    expect(b.deduplicated).toBe(false)
    expect(stubs(env).workflow?.created).toHaveLength(2)

    const rows = await db
      .select({ exclusive: agentRuns.exclusive, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.tenantId, tenant.id), eq(agentRuns.agentKey, 'summarize-text')))
    expect(rows).toEqual([
      { exclusive: false, status: 'queued' },
      { exclusive: false, status: 'queued' },
    ])
  })

  it('an exclusive agent beside it keeps the guarantee: the row says so, and a second enqueue is refused', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const env = createTestEnv()

    const first = await start(cookie, env, 'research-topic', { topic: 'Volcanoes' })
    expect(first.status).toBe(202)
    const run = createAgentRunResponseSchema.parse(await json(first))
    const [row] = await db
      .select({ exclusive: agentRuns.exclusive })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
    expect(row?.exclusive).toBe(true)

    const again = await start(cookie, env, 'research-topic', { topic: 'Glaciers' })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({
      code: 'agent_run_active',
      details: { runId: run.id },
    })
  })
})
