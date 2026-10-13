/**
 * Tests for runToolLoop per-turn usage tap (Issue #2).
 *
 * Verifies:
 * 1. Cancellation after turn two emits usage for exactly turns 1 and 2.
 * 2. Checkpoint resume does NOT re-emit checkpoint usage; only newly executed turns are emitted.
 * 3. Successful completion emits per-turn usage for all executed turns.
 * 4. Failure after turn one still preserves turn one's usage via the callback.
 */

import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AiError } from '@/api/services/ai/errors'
import { runToolLoop, type Tool, type ToolLoopCheckpoint } from '@/api/services/ai/kit'
import { FakeChatClient } from '../helpers/ai'

const lookupTool = (handler = vi.fn(async () => 'result')): Tool<{ q: string }> => ({
  name: 'lookup',
  description: 'Look something up',
  schema: z.object({ q: z.string() }),
  handler,
})

const terminalTool: Tool<{ answer: string }> = {
  name: 'submit_answer',
  description: 'Submit final answer',
  schema: z.object({ answer: z.string() }),
}

describe('runToolLoop onUsage callback', () => {
  it('calls onUsage per executed turn, preserving turns 1 and 2 when cancelled after turn 2', async () => {
    const controller = new AbortController()
    const onUsage = vi.fn()
    const recordedTurns: Array<{ usage: TokenUsage; turn: number }> = []
    onUsage.mockImplementation((usage: TokenUsage, turn: number) => {
      recordedTurns.push({ usage, turn })
    })

    const client = new FakeChatClient([
      // Turn 1
      {
        toolUses: [{ name: 'lookup', input: { q: 'step 1' } }],
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      // Turn 2
      {
        toolUses: [{ name: 'lookup', input: { q: 'step 2' } }],
        usage: { inputTokens: 50, outputTokens: 15 },
      },
      // Turn 3 (should not execute)
      {
        toolUses: [{ name: 'submit_answer', input: { answer: 'final' } }],
        usage: { inputTokens: 60, outputTokens: 20 },
      },
    ])

    // Cancel after turn 2
    let turnsSeen = 0
    await expect(
      runToolLoop(client, {
        model: 'fake-model',
        system: 'System prompt',
        messages: [{ role: 'user', content: 'Go' }],
        tools: [lookupTool(), terminalTool],
        signal: controller.signal,
        onUsage,
        onStep: async step => {
          turnsSeen = step.turn
          if (turnsSeen === 2) {
            controller.abort()
          }
        },
      })
    ).rejects.toThrow(/cancelled/)

    expect(recordedTurns).toEqual([
      { usage: { inputTokens: 40, outputTokens: 10 }, turn: 1 },
      { usage: { inputTokens: 50, outputTokens: 15 }, turn: 2 },
    ])
    expect(client.calls).toHaveLength(2)
  })

  it('does not re-emit restored checkpoint usage on resume; only emits newly executed turns', async () => {
    const onUsage = vi.fn()
    const checkpoint: ToolLoopCheckpoint = {
      turns: 1,
      usage: { inputTokens: 40, outputTokens: 10 },
      messages: [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'step 1' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', content: 'result', isError: false },
          ],
        },
      ],
    }

    const client = new FakeChatClient([
      // Turn 2 executed in this attempt
      {
        toolUses: [{ name: 'submit_answer', input: { answer: 'done' } }],
        usage: { inputTokens: 60, outputTokens: 20 },
      },
    ])

    const result = await runToolLoop(client, {
      model: 'fake-model',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Go' }],
      tools: [lookupTool(), terminalTool],
      resume: checkpoint,
      onUsage,
    })

    expect(result.turns).toBe(2)
    // Cumulative usage on result includes the restored checkpoint usage
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30 })

    // But onUsage callback ONLY receives newly executed turns from this attempt
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 60, outputTokens: 20 }, 2)
  })

  it('accounts for all executed turns on successful completion', async () => {
    const onUsage = vi.fn()
    const client = new FakeChatClient([
      {
        toolUses: [{ name: 'lookup', input: { q: 'query' } }],
        usage: { inputTokens: 30, outputTokens: 10 },
      },
      {
        toolUses: [{ name: 'submit_answer', input: { answer: 'final' } }],
        usage: { inputTokens: 70, outputTokens: 25 },
      },
    ])

    const result = await runToolLoop(client, {
      model: 'fake-model',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Go' }],
      tools: [lookupTool(), terminalTool],
      onUsage,
    })

    expect(result.terminalInput).toEqual({ answer: 'final' })
    expect(result.turns).toBe(2)
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 35 })
    expect(onUsage).toHaveBeenCalledTimes(2)
    expect(onUsage).toHaveBeenNthCalledWith(1, { inputTokens: 30, outputTokens: 10 }, 1)
    expect(onUsage).toHaveBeenNthCalledWith(2, { inputTokens: 70, outputTokens: 25 }, 2)
  })

  it('records turn 1 usage even when the provider fails on turn 2', async () => {
    const onUsage = vi.fn()
    const client = new FakeChatClient([
      {
        toolUses: [{ name: 'lookup', input: { q: 'step 1' } }],
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      {
        error: new AiError('unavailable', 'anthropic_compatible', 'provider overloaded'),
      },
    ])

    await expect(
      runToolLoop(client, {
        model: 'fake-model',
        system: 'System prompt',
        messages: [{ role: 'user', content: 'Go' }],
        tools: [lookupTool(), terminalTool],
        onUsage,
      })
    ).rejects.toThrow(/provider overloaded/)

    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 10 }, 1)
  })
})
