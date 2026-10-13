/**
 * `agent_run_approvals` (Issue #3) — durable, tenant-scoped approvals for agent runs.
 *
 * One row per approval ask (`ctx.approve(key, payload)`).
 * The run pauses (`agent_runs.status = 'awaiting_approval'`).
 * A person decides (`approved` or `rejected`) via the decision API.
 * Resuming the run checks `agent_run_approvals` by `(run_id, key)`:
 * - If approved, returns the decision metadata.
 * - If rejected, throws `AgentApprovalRejectedError` and the run settles cancelled.
 */
import { AGENT_APPROVAL_STATUSES, type AgentApprovalStatus } from '@rocketflare/shared/ai/approvals'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const agentRunApprovals = pgTable(
  'agent_run_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: AGENT_APPROVAL_STATUSES })
      .$type<AgentApprovalStatus>()
      .notNull()
      .default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note'),
    ...timestamps(),
  },
  table => [
    uniqueIndex('agent_run_approvals_run_key_idx').on(table.runId, table.key),
    index('agent_run_approvals_tenant_run_idx').on(table.tenantId, table.runId),
    index('agent_run_approvals_tenant_status_idx').on(
      table.tenantId,
      table.status,
      table.createdAt.desc()
    ),
    tenantIsolation('agent_run_approvals'),
  ]
)

export const agentRunApprovalsRelations = relations(agentRunApprovals, ({ one }) => ({
  tenant: one(tenants, { fields: [agentRunApprovals.tenantId], references: [tenants.id] }),
  run: one(agentRuns, { fields: [agentRunApprovals.runId], references: [agentRuns.id] }),
  decidedBy: one(users, {
    fields: [agentRunApprovals.decidedByUserId],
    references: [users.id],
  }),
}))

export type AgentRunApprovalRow = typeof agentRunApprovals.$inferSelect
export type NewAgentRunApprovalRow = typeof agentRunApprovals.$inferInsert
