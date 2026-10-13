/**
 * Agent run approvals (Issue #3) — durable, tenant-scoped approvals for agent runs.
 * Defines the approval record, status, event data, and request/response shapes.
 */
import { z } from 'zod'

export const AGENT_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const
export const agentApprovalStatusSchema = z.enum(AGENT_APPROVAL_STATUSES)
export type AgentApprovalStatus = z.infer<typeof agentApprovalStatusSchema>

export const agentRunApprovalSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  runId: z.string().uuid(),
  key: z.string().min(1).max(200),
  payload: z.unknown(),
  status: agentApprovalStatusSchema,
  decidedByUserId: z.string().uuid().nullable(),
  decidedAt: z.coerce.date().nullable(),
  note: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type AgentRunApproval = z.infer<typeof agentRunApprovalSchema>

export const decideApprovalRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(2000).optional(),
})
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>

export const agentApprovalEventDataSchema = z
  .object({
    approvalId: z.string().uuid(),
    key: z.string(),
    status: agentApprovalStatusSchema,
    payload: z.unknown().optional(),
    note: z.string().nullable().optional(),
    decidedByUserId: z.string().uuid().nullable().optional(),
  })
  .passthrough()
export type AgentApprovalEventData = z.infer<typeof agentApprovalEventDataSchema>
