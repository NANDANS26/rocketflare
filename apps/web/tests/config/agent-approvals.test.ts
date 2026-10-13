/**
 * Regression tests for Agent Approvals and Tool Authorization (Issue #3).
 * Tests pure logic, schema validation, authorizeTool hook behavior,
 * and approval decision transitions without requiring Docker.
 */
import {
  ACTIVE_RUN_STATUSES,
  CLAIMABLE_RUN_STATUSES,
  isRunActive,
} from '@rocketflare/shared/ai/agents'
import {
  agentApprovalStatusSchema,
  agentRunApprovalSchema,
  decideApprovalRequestSchema,
} from '@rocketflare/shared/ai/approvals'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentApprovalRejectedError, AgentPausedError } from '@/api/services/agents/runs'
import {
  callStructuredTool,
  runToolLoop,
  type Tool,
  ToolAuthorizationError,
} from '@/api/services/ai/kit'
import { FakeChatClient } from '../helpers/ai'

describe('Agent Approval Schemas & Statuses (Issue #3)', () => {
  it('validates agent approval statuses', () => {
    expect(agentApprovalStatusSchema.parse('pending')).toBe('pending')
    expect(agentApprovalStatusSchema.parse('approved')).toBe('approved')
    expect(agentApprovalStatusSchema.parse('rejected')).toBe('rejected')
    expect(() => agentApprovalStatusSchema.parse('unknown')).toThrow()
  })

  it('validates decide approval request schema', () => {
    expect(decideApprovalRequestSchema.parse({ decision: 'approve' })).toEqual({
      decision: 'approve',
    })
    expect(
      decideApprovalRequestSchema.parse({
        decision: 'reject',
        note: 'Not authorized for sensitive action',
      })
    ).toEqual({
      decision: 'reject',
      note: 'Not authorized for sensitive action',
    })
    expect(() => decideApprovalRequestSchema.parse({ decision: 'maybe' })).toThrow()
  })

  it('validates agent run approval row schema', () => {
    const approval = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      runId: '33333333-3333-4333-8333-333333333333',
      key: 'deploy-prod',
      payload: { environment: 'production', version: '1.2.0' },
      status: 'pending',
      decidedByUserId: null,
      decidedAt: null,
      note: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const parsed = agentRunApprovalSchema.parse(approval)
    expect(parsed.key).toBe('deploy-prod')
    expect(parsed.status).toBe('pending')
  })

  it('recognizes awaiting_approval as an active state holding the exclusive slot', () => {
    expect(isRunActive('awaiting_approval')).toBe(true)
    expect(ACTIVE_RUN_STATUSES).toContain('awaiting_approval')
    expect(CLAIMABLE_RUN_STATUSES).not.toContain('awaiting_approval')
  })
})

describe('Run-level Tool Authorization Hook (Issue #3)', () => {
  const echoTool: Tool = {
    name: 'echo',
    description: 'echoes input',
    schema: z.object({ text: z.string() }),
    handler: vi.fn(async ({ text }) => text),
  }

  const terminalTool: Tool = {
    name: 'finish',
    description: 'terminal tool',
    schema: z.object({ summary: z.string() }),
    // terminal tool has no handler
  }

  it('allows tool execution when authorizeTool returns true', async () => {
    const client = new FakeChatClient([
      {
        toolUses: [{ id: 'call_1', name: 'echo', input: { text: 'hello' } }],
      },
      {
        toolUses: [{ id: 'call_2', name: 'finish', input: { summary: 'done' } }],
      },
    ])

    const authorizeTool = vi.fn().mockResolvedValue(true)

    const result = await runToolLoop(client, {
      model: 'test-model',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'run' }],
      tools: [echoTool, terminalTool],
      authorizeTool,
    })

    expect(authorizeTool).toHaveBeenCalledWith(
      'echo',
      { text: 'hello' },
      { turn: 1, toolUseId: 'call_1' }
    )
    expect(echoTool.handler).toHaveBeenCalledWith({ text: 'hello' })
    expect(result.stopReason).not.toBe('max_turns')
    expect(result.terminalTool).toBe('finish')
  })

  it('denies tool execution without running the handler when authorizeTool returns false', async () => {
    const handler = vi.fn()
    const sensitiveTool: Tool = {
      name: 'delete_database',
      description: 'deletes db',
      schema: z.object({ dbName: z.string() }),
      handler,
    }

    const client = new FakeChatClient([
      {
        toolUses: [{ id: 'call_delete', name: 'delete_database', input: { dbName: 'prod' } }],
      },
      {
        toolUses: [{ id: 'call_finish', name: 'finish', input: { summary: 'could not delete' } }],
      },
    ])

    const authorizeTool = vi.fn().mockResolvedValue(false)

    const result = await runToolLoop(client, {
      model: 'test-model',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'run delete' }],
      tools: [sensitiveTool, terminalTool],
      authorizeTool,
    })

    expect(authorizeTool).toHaveBeenCalledWith(
      'delete_database',
      { dbName: 'prod' },
      { turn: 1, toolUseId: 'call_delete' }
    )
    // The sensitive tool handler MUST NOT be executed
    expect(handler).not.toHaveBeenCalled()

    // The tool result message returned to the model should be isError: true
    const toolResultMsg = result.messages.find(
      m =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()
    const content = toolResultMsg ? (toolResultMsg.content as any[]) : []
    const block: any = content.find((b: any) => b.toolUseId === 'call_delete')
    expect(block.isError).toBe(true)
    expect(block.content).toContain('not authorized')
  })

  it('denies tool execution with a custom reason when authorizeTool returns { allow: false, reason }', async () => {
    const handler = vi.fn()
    const sensitiveTool: Tool = {
      name: 'send_email',
      description: 'sends email',
      schema: z.object({ to: z.string() }),
      handler,
    }

    const client = new FakeChatClient([
      {
        toolUses: [{ id: 'call_email', name: 'send_email', input: { to: 'victim@test.com' } }],
      },
      {
        toolUses: [{ id: 'call_finish', name: 'finish', input: { summary: 'blocked' } }],
      },
    ])

    const authorizeTool = vi.fn().mockResolvedValue({
      allow: false,
      reason: 'Outbound email is disabled by organisation policy',
    })

    const result = await runToolLoop(client, {
      model: 'test-model',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'send email' }],
      tools: [sensitiveTool, terminalTool],
      authorizeTool,
    })

    expect(handler).not.toHaveBeenCalled()
    const toolResultMsg = result.messages.find(
      m =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()
    const content = toolResultMsg ? (toolResultMsg.content as any[]) : []
    const block: any = content.find((b: any) => b.toolUseId === 'call_email')
    expect(block.isError).toBe(true)
    expect(block.content).toContain('Outbound email is disabled by organisation policy')
  })
})

describe('Agent Errors for Human Approvals (Issue #3)', () => {
  it('instantiates AgentPausedError with key and payload', () => {
    const err = new AgentPausedError('approval_123', { amount: 500 })
    expect(err.name).toBe('AgentPausedError')
    expect(err.key).toBe('approval_123')
    expect(err.payload).toEqual({ amount: 500 })
    expect(err.message).toContain('approval_123')
  })

  it('instantiates AgentApprovalRejectedError with key and optional note', () => {
    const err = new AgentApprovalRejectedError('approval_123', 'Budget exceeded')
    expect(err.name).toBe('AgentApprovalRejectedError')
    expect(err.key).toBe('approval_123')
    expect(err.note).toBe('Budget exceeded')
    expect(err.message).toContain('Budget exceeded')
  })
})

describe('Direct Structured Tool Authorization (Issue #3)', () => {
  const structuredTool = {
    name: 'export_data',
    description: 'exports customer data',
    schema: z.object({ target: z.string(), rows: z.number() }),
  }

  it('allows structured tool output when authorizeTool allows', async () => {
    const client = new FakeChatClient([
      {
        toolUses: [
          { id: 'call_export_1', name: 'export_data', input: { target: 'csv', rows: 10 } },
        ],
      },
    ])
    const authorizeTool = vi.fn().mockResolvedValue(true)

    const result = await callStructuredTool(client, {
      model: 'test-model',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'export 10 rows' }],
      tool: structuredTool,
      authorizeTool,
    })

    expect(result).toEqual({ target: 'csv', rows: 10 })
    expect(authorizeTool).toHaveBeenCalledWith(
      'export_data',
      { target: 'csv', rows: 10 },
      { turn: 1, toolUseId: 'call_export_1' }
    )
  })

  it('throws ToolAuthorizationError and blocks output when authorizeTool denies', async () => {
    const client = new FakeChatClient([
      {
        toolUses: [
          { id: 'call_export_2', name: 'export_data', input: { target: 's3', rows: 1000 } },
        ],
      },
    ])
    const authorizeTool = vi.fn().mockResolvedValue({
      allow: false,
      reason: 'Export to external storage is restricted',
    })

    await expect(
      callStructuredTool(client, {
        model: 'test-model',
        system: 'system prompt',
        messages: [{ role: 'user', content: 'export to s3' }],
        tool: structuredTool,
        authorizeTool,
      })
    ).rejects.toThrow(ToolAuthorizationError)

    await expect(
      callStructuredTool(
        new FakeChatClient([
          {
            toolUses: [
              { id: 'call_export_3', name: 'export_data', input: { target: 's3', rows: 1000 } },
            ],
          },
        ]),
        {
          model: 'test-model',
          system: 'system prompt',
          messages: [{ role: 'user', content: 'export to s3' }],
          tool: structuredTool,
          authorizeTool: () => false,
        }
      )
    ).rejects.toThrow(/Tool execution denied: 'export_data' is not authorized for this run/)
  })

  it('remains backward compatible when authorizeTool is omitted', async () => {
    const client = new FakeChatClient([
      {
        toolUses: [
          { id: 'call_export_4', name: 'export_data', input: { target: 'json', rows: 5 } },
        ],
      },
    ])

    const result = await callStructuredTool(client, {
      model: 'test-model',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'export json' }],
      tool: structuredTool,
    })

    expect(result).toEqual({ target: 'json', rows: 5 })
  })
})
