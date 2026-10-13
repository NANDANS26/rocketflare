/**
 * ApprovalRequiredPanel (Issue #3) — renders pending human approval asks for a run.
 * Allows an authorized user to review payload, provide an optional note, and Approve or Reject.
 */
import { CheckCircleIcon, ExclamationTriangleIcon, XCircleIcon } from '@heroicons/react/24/outline'
import type { AgentRunApproval } from '@rocketflare/shared/ai/approvals'
import { useState } from 'react'
import { useDecideApproval } from '@/ui/hooks/useAgents'

export function ApprovalRequiredPanel({
  runId,
  approval,
  canAnswer,
  approverLabel,
}: {
  runId: string
  approval: AgentRunApproval
  canAnswer: boolean
  approverLabel: string
}) {
  const decide = useDecideApproval(runId)
  const [note, setNote] = useState('')

  const handleDecision = (decision: 'approve' | 'reject') => {
    decide.mutate({
      key: approval.key,
      decision,
      note: note.trim() || undefined,
    })
  }

  const payloadString =
    typeof approval.payload === 'object' && approval.payload !== null
      ? JSON.stringify(approval.payload, null, 2)
      : String(approval.payload)

  return (
    <div
      className="alert alert-warning border border-warning/30 shadow-md p-4 rounded-lg"
      role="region"
      aria-label="Approval required"
    >
      <div className="flex items-start gap-3 w-full">
        <ExclamationTriangleIcon
          className="w-6 h-6 text-warning shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-base text-base-content">
              Approval Required: <span className="font-mono text-sm">{approval.key}</span>
            </h3>
            <span className="badge badge-warning badge-sm uppercase font-mono tracking-wider">
              {approval.status}
            </span>
          </div>

          <p className="text-sm text-base-content/80">
            This agent run paused execution to request human authorization.
          </p>

          {payloadString && payloadString !== '{}' && (
            <div className="mt-2 bg-base-200/60 p-2.5 rounded border border-base-300 font-mono text-xs overflow-x-auto max-h-48">
              <pre>{payloadString}</pre>
            </div>
          )}

          {canAnswer ? (
            <div className="mt-3 pt-2 border-t border-warning/20 space-y-3">
              <div>
                <label
                  htmlFor="approval-note"
                  className="block text-xs font-medium text-base-content/70 mb-1"
                >
                  Optional note / rationale:
                </label>
                <input
                  id="approval-note"
                  type="text"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Explain your decision..."
                  disabled={decide.isPending}
                  className="input input-sm input-bordered w-full max-w-md bg-base-100"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleDecision('approve')}
                  disabled={decide.isPending}
                  className="btn btn-sm btn-success gap-1.5"
                >
                  <CheckCircleIcon className="w-4 h-4" aria-hidden="true" />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => handleDecision('reject')}
                  disabled={decide.isPending}
                  className="btn btn-sm btn-error btn-outline gap-1.5"
                >
                  <XCircleIcon className="w-4 h-4" aria-hidden="true" />
                  Reject
                </button>
                {decide.isPending && (
                  <span className="loading loading-spinner loading-xs text-base-content/60" />
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 text-xs text-base-content/70 italic">
              Awaiting decision by {approverLabel}.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
