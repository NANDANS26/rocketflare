import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  InterruptRequested,
  runToolLoop,
  type Tool,
  type ToolLoopEvent,
  ToolLoopExhaustedError,
} from '@/api/services/ai/kit'
import { FakeChatClient } from '../helpers/ai'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const dummySchema = z.object({ id: z.string(), delayMs: z.number().optional() })
const finalAnswerSchema = z.object({ answer: z.string() })

const finalAnswerTool: Tool<{ answer: string }> = {
  name: 'final_answer',
  description: 'Provide final answer',
  schema: finalAnswerSchema,
}

describe('bounded concurrent tool execution in runToolLoop', () => {
  it('1. executes independent tool calls concurrently when cap > 1', async () => {
    let active = 0
    let maxActive = 0

    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'async_worker',
      description: 'Worker tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 30 }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(delayMs)
        active -= 1
        return `done-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'async_worker', input: { id: '1', delayMs: 40 } },
          { name: 'async_worker', input: { id: '2', delayMs: 40 } },
          { name: 'async_worker', input: { id: '3', delayMs: 40 } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'All done' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxConcurrentToolCalls: 3,
      },
    })

    expect(res.terminalTool).toBe('final_answer')
    expect(res.terminalInput).toEqual({ answer: 'All done' })
    expect(maxActive).toBe(3)
  })

  it('2. bounds concurrency to maxConcurrentToolCalls cap', async () => {
    let active = 0
    let maxActive = 0

    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'async_worker',
      description: 'Worker tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 30 }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(delayMs)
        active -= 1
        return `done-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'async_worker', input: { id: '1', delayMs: 30 } },
          { name: 'async_worker', input: { id: '2', delayMs: 30 } },
          { name: 'async_worker', input: { id: '3', delayMs: 30 } },
          { name: 'async_worker', input: { id: '4', delayMs: 30 } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Done' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxConcurrentToolCalls: 2,
      },
    })

    expect(res.terminalTool).toBe('final_answer')
    expect(maxActive).toBe(2)
  })

  it('3. strictly preserves sequential execution when cap is 1', async () => {
    let active = 0
    let maxActive = 0

    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'async_worker',
      description: 'Worker tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 20 }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(delayMs)
        active -= 1
        return `done-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'async_worker', input: { id: '1', delayMs: 20 } },
          { name: 'async_worker', input: { id: '2', delayMs: 20 } },
          { name: 'async_worker', input: { id: '3', delayMs: 20 } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Sequential done' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxConcurrentToolCalls: 1,
      },
    })

    expect(res.terminalTool).toBe('final_answer')
    expect(maxActive).toBe(1)
  })

  it('4. defaults to concurrency cap of 4 when policy or cap is unspecified', async () => {
    let active = 0
    let maxActive = 0

    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'async_worker',
      description: 'Worker tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 30 }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(delayMs)
        active -= 1
        return `done-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'async_worker', input: { id: '1', delayMs: 30 } },
          { name: 'async_worker', input: { id: '2', delayMs: 30 } },
          { name: 'async_worker', input: { id: '3', delayMs: 30 } },
          { name: 'async_worker', input: { id: '4', delayMs: 30 } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Default cap done' } }],
      },
    ])

    // No policy provided
    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
    })

    expect(res.terminalTool).toBe('final_answer')
    expect(maxActive).toBe(4)
  })

  it('5. safely handles invalid cap values by falling back to default 4', async () => {
    let active = 0
    let maxActive = 0

    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'async_worker',
      description: 'Worker tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 30 }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(delayMs)
        active -= 1
        return `done-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'async_worker', input: { id: '1', delayMs: 30 } },
          { name: 'async_worker', input: { id: '2', delayMs: 30 } },
          { name: 'async_worker', input: { id: '3', delayMs: 30 } },
          { name: 'async_worker', input: { id: '4', delayMs: 30 } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Fallback done' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxConcurrentToolCalls: 0 as any, // invalid 0
      },
    })

    expect(res.terminalTool).toBe('final_answer')
    expect(maxActive).toBe(4)
  })

  it('6. strictly preserves model-requested order when tools complete out of order', async () => {
    const completionOrder: string[] = []
    const events: ToolLoopEvent[] = []

    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'order_tool',
      description: 'Order test tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 0 }) => {
        await delay(delayMs)
        completionOrder.push(id)
        return `result-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          // Tool 1 takes 50ms, Tool 2 takes 10ms (completes first)
          { name: 'order_tool', input: { id: 'slow_first', delayMs: 50 } },
          { name: 'order_tool', input: { id: 'fast_second', delayMs: 10 } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Done' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxConcurrentToolCalls: 2,
      },
      onEvent: event => {
        events.push(event)
      },
    })

    // Confirm that fast_second actually completed before slow_first
    expect(completionOrder).toEqual(['fast_second', 'slow_first'])

    // Confirm onEvent tool_result events were emitted in model order (slow_first, then fast_second)
    const resultEvents = events.filter(e => e.kind === 'tool_result' && e.name === 'order_tool')
    expect(resultEvents.map(e => (e.kind === 'tool_result' ? e.resultText : ''))).toEqual([
      'result-slow_first',
      'result-fast_second',
    ])

    // Confirm messages transcript user turn contains results in model order
    const userTurn = res.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
    )
    expect(userTurn).toBeDefined()
    if (userTurn && Array.isArray(userTurn.content)) {
      expect(userTurn.content).toHaveLength(2)
      expect((userTurn.content[0] as any).content).toBe('result-slow_first')
      expect((userTurn.content[1] as any).content).toBe('result-fast_second')
    }
  })

  it('7. safely handles tool errors without losing other concurrent tool results', async () => {
    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'flaky_tool',
      description: 'Flaky tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 10 }) => {
        await delay(delayMs)
        if (id === 'error_call') {
          throw new Error('Explosion in tool')
        }
        return `success-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'flaky_tool', input: { id: 'error_call', delayMs: 10 } },
          { name: 'flaky_tool', input: { id: 'ok_call', delayMs: 20 } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Recovered' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxConcurrentToolCalls: 2,
      },
    })

    expect(res.terminalTool).toBe('final_answer')
    const userTurn = res.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
    )
    expect(userTurn).toBeDefined()
    if (userTurn && Array.isArray(userTurn.content)) {
      expect(userTurn.content).toHaveLength(2)
      expect((userTurn.content[0] as any).isError).toBe(true)
      expect((userTurn.content[0] as any).content).toContain('Explosion in tool')
      expect((userTurn.content[1] as any).isError).toBe(false)
      expect((userTurn.content[1] as any).content).toBe('success-ok_call')
    }
  })

  it('8. rethrows InterruptRequested from inside a handler and settles in-flight siblings cleanly', async () => {
    let siblingFinished = false

    const testTool: Tool<{ id: string; delayMs?: number }> = {
      name: 'interrupt_tool',
      description: 'Interrupt tool',
      schema: dummySchema,
      handler: async ({ id, delayMs = 10 }) => {
        if (id === 'interrupt_call') {
          throw new InterruptRequested([
            {
              key: 'test_interrupt',
              toolCallId: 'call_1',
              spec: { kind: 'approval', message: 'Approve?' },
            },
          ])
        }
        await delay(delayMs)
        siblingFinished = true
        return 'sibling-done'
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'interrupt_tool', input: { id: 'interrupt_call' } },
          { name: 'interrupt_tool', input: { id: 'sibling_call', delayMs: 20 } },
        ],
      },
    ])

    await expect(
      runToolLoop(client, {
        model: 'test-model',
        system: 'test',
        messages: [{ role: 'user', content: 'run' }],
        tools: [testTool, finalAnswerTool],
        policy: {
          maxConcurrentToolCalls: 2,
        },
      })
    ).rejects.toThrow(InterruptRequested)

    expect(siblingFinished).toBe(true)
  })

  it('9. bounds total tool calls with maxToolCalls during concurrent turn and answers all calls', async () => {
    let callsExecuted = 0

    const testTool: Tool<{ id: string }> = {
      name: 'counter_tool',
      description: 'Counter tool',
      schema: dummySchema,
      handler: async ({ id }) => {
        callsExecuted += 1
        return `done-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'counter_tool', input: { id: '1' } },
          { name: 'counter_tool', input: { id: '2' } },
          { name: 'counter_tool', input: { id: '3' } },
          { name: 'counter_tool', input: { id: '4' } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Salvaged answer' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxToolCalls: 2,
        maxConcurrentToolCalls: 4,
        onExhaustion: 'final-answer',
      },
    })

    expect(res.stopReason).toBe('max_tool_calls')
    expect(res.salvaged).toBe(true)
    expect(res.terminalInput).toEqual({ answer: 'Salvaged answer' })
    expect(callsExecuted).toBe(2)

    // All 4 tool calls in the turn must receive a tool_result in the transcript
    const userTurn = res.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
    )
    expect(userTurn).toBeDefined()
    if (userTurn && Array.isArray(userTurn.content)) {
      expect(userTurn.content).toHaveLength(4)
      expect((userTurn.content[2] as any).content).toContain('Not run')
      expect((userTurn.content[3] as any).content).toContain('Not run')
    }
  })

  it('10. stops at repeatedFailureLimit under concurrent execution and throws when onExhaustion is fail', async () => {
    const testTool: Tool<{ id: string }> = {
      name: 'failing_tool',
      description: 'Failing tool',
      schema: dummySchema,
      handler: async ({ id }) => {
        throw new Error(`Failure in ${id}`)
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'failing_tool', input: { id: '1' } },
          { name: 'failing_tool', input: { id: '2' } },
          { name: 'failing_tool', input: { id: '3' } },
        ],
      },
    ])

    const err = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        repeatedFailureLimit: 2,
        maxConcurrentToolCalls: 3,
        onExhaustion: 'fail',
      },
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ToolLoopExhaustedError)
    expect(err).toMatchObject({ reason: 'repeated_failures' })
  })

  it('11. respects authorizeTool before concurrent execution', async () => {
    let callExecuted = false

    const testTool: Tool<{ id: string }> = {
      name: 'worker_tool',
      description: 'Worker tool',
      schema: dummySchema,
      handler: async ({ id }) => {
        if (id === 'allowed') callExecuted = true
        return `done-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'worker_tool', input: { id: 'blocked' } },
          { name: 'worker_tool', input: { id: 'allowed' } },
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Done' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [testTool, finalAnswerTool],
      policy: {
        maxConcurrentToolCalls: 2,
      },
      authorizeTool: async ({ input }) => {
        const id = (input as { id: string }).id
        if (id === 'blocked') return { allow: false, reason: 'id blocked' }
        return { allow: true }
      },
    })

    expect(res.terminalTool).toBe('final_answer')
    expect(callExecuted).toBe(true)

    const userTurn = res.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
    )
    expect(userTurn).toBeDefined()
    if (userTurn && Array.isArray(userTurn.content)) {
      expect((userTurn.content[0] as any).content).toContain(
        'This call was refused by policy: id blocked'
      )
      expect((userTurn.content[1] as any).content).toBe('done-allowed')
    }
  })
})
