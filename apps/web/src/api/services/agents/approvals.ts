/**
 * `agent_run_approvals` (Issue #3) — durable, tenant-scoped approvals for agent runs.
 *
 * Implements create-or-read idempotency for `(run_id, key)`:
 * - `requestApproval`: inserts a pending approval or finds existing.
 * - `decideApproval`: atomic compare-and-set on `status = 'pending'`.
 * - `listApprovals` / `getApprovalByKey` / `getApproval`.
 */
import type { AgentApprovalStatus, AgentRunApproval } from '@rocketflare/shared/ai/approvals'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AgentRunApprovalRow, agentRunApprovals } from '../../../db/schema'

export interface RequestApprovalInput {
  tenantId: string
  runId: string
  key: string
  payload: unknown
}

export interface DecideApprovalInput {
  tenantId: string
  runId: string
  key: string
  decision: 'approve' | 'reject'
  note?: string | null
  userId: string
}

export function toAgentRunApproval(row: AgentRunApprovalRow): AgentRunApproval {
  return {
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    key: row.key,
    payload: row.payload,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Create or read an approval ask by `(run_id, key)`.
 * Idempotent: a second attempt that calls `ctx.approve` with the same key
 * returns the existing row rather than duplicating.
 */
export async function requestApproval(
  db: Database,
  input: RequestApprovalInput
): Promise<AgentRunApprovalRow> {
  const [inserted] = await db
    .insert(agentRunApprovals)
    .values({
      tenantId: input.tenantId,
      runId: input.runId,
      key: input.key,
      payload: input.payload ?? {},
      status: 'pending',
    })
    .onConflictDoNothing({ target: [agentRunApprovals.runId, agentRunApprovals.key] })
    .returning()

  if (inserted) return inserted
  const existing = await getApprovalByKey(db, input.tenantId, input.runId, input.key)
  if (!existing) throw new Error(`agent_run_approvals: ${input.key} neither inserted nor found`)
  return existing
}

export async function getApprovalByKey(
  db: Database,
  tenantId: string,
  runId: string,
  key: string
): Promise<AgentRunApprovalRow | null> {
  const row = await db.query.agentRunApprovals.findFirst({
    where: and(
      eq(agentRunApprovals.tenantId, tenantId),
      eq(agentRunApprovals.runId, runId),
      eq(agentRunApprovals.key, key)
    ),
  })
  return row ?? null
}

export async function getApproval(
  db: Database,
  tenantId: string,
  runId: string,
  approvalId: string
): Promise<AgentRunApprovalRow | null> {
  const row = await db.query.agentRunApprovals.findFirst({
    where: and(
      eq(agentRunApprovals.tenantId, tenantId),
      eq(agentRunApprovals.runId, runId),
      eq(agentRunApprovals.id, approvalId)
    ),
  })
  return row ?? null
}

export async function listApprovals(
  db: Database,
  tenantId: string,
  runId: string,
  status?: AgentApprovalStatus
): Promise<AgentRunApprovalRow[]> {
  return db
    .select()
    .from(agentRunApprovals)
    .where(
      and(
        eq(agentRunApprovals.tenantId, tenantId),
        eq(agentRunApprovals.runId, runId),
        status ? eq(agentRunApprovals.status, status) : undefined
      )
    )
    .orderBy(asc(agentRunApprovals.createdAt))
}

/**
 * Compare-and-set decision on `status = 'pending'`.
 * Returns the updated row, or null if it was not pending (e.g. already decided).
 */
export async function decideApproval(
  db: Database,
  input: DecideApprovalInput
): Promise<AgentRunApprovalRow | null> {
  const status: AgentApprovalStatus = input.decision === 'approve' ? 'approved' : 'rejected'
  const [row] = await db
    .update(agentRunApprovals)
    .set({
      status,
      note: input.note?.trim() || null,
      decidedByUserId: input.userId,
      decidedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentRunApprovals.tenantId, input.tenantId),
        eq(agentRunApprovals.runId, input.runId),
        eq(agentRunApprovals.key, input.key),
        eq(agentRunApprovals.status, 'pending')
      )
    )
    .returning()

  return row ?? null
}
