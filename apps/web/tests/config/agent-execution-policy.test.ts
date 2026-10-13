import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runToolLoop, type Tool } from '@/api/services/ai/kit'
import { FakeChatClient } from '../helpers/ai'

const testInputSchema = z.object({ query: z.string() })
const testOutputSchema = z.object({ answer: z.string() })

const searchTool: Tool<{ query: string }> = {
  name: 'search',
  description: 'Search knowledge',
  schema: testInputSchema,
  handler: async ({ query }) => {
    if (query === 'fail') {
      throw new Error('search failed')
    }
    return JSON.stringify({ results: [`result for ${query}`] })
  },
}

const finalAnswerTool: Tool<{ answer: string }> = {
  name: 'final_answer',
  description: 'Provide final answer',
  schema: testOutputSchema,
}

describe('agent execution policy and exhaustion in runToolLoop', () => {
  it('1. salvages answer with final-answer when loop exhausts turns without terminal tool call', async () => {
    const client = new FakeChatClient([
      // Turn 1: model returns search tool call
      {
        toolUses: [{ name: 'search', input: { query: 'test' } }],
      },
      // Turn 2: model returns prose without terminal tool call (exhausted turns)
      {
        text: 'I have found enough information.',
      },
      // Salvage turn (forced structured tool call): model returns final answer
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Salvaged answer' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      policy: {
        maxTurns: 2,
        onExhaustion: 'final-answer',
      },
    })

    expect(res.stopReason).toBe('exhausted')
    expect(res.terminalTool).toBe('final_answer')
    expect(res.terminalInput).toEqual({ answer: 'Salvaged answer' })
    expect(res.turns).toBe(2)
  })

  it('2. produces a failed run with fail on exhaustion', async () => {
    const client = new FakeChatClient([
      {
        toolUses: [{ name: 'search', input: { query: 'test' } }],
      },
      {
        text: 'I have found enough information.',
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      policy: {
        maxTurns: 2,
        onExhaustion: 'fail',
      },
    })

    expect(res.stopReason).toBe('no_tool_call')
    expect(res.terminalInput).toBeNull()
    expect(res.terminalTool).toBeNull()
  })

  it('3. repeated identical failing tool calls stop at repeatedFailureLimit', async () => {
    const client = new FakeChatClient([
      {
        toolUses: [{ name: 'search', input: { query: 'fail' } }],
      },
      {
        toolUses: [{ name: 'search', input: { query: 'fail' } }],
      },
      {
        toolUses: [{ name: 'search', input: { query: 'fail' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      policy: {
        maxTurns: 10,
        repeatedFailureLimit: 2,
        onExhaustion: 'fail',
      },
    })

    expect(res.stopReason).toBe('repeated_failures')
    expect(res.terminalInput).toBeNull()
    expect(client.calls.length).toBe(2)
  })

  it('4. a successful tool call resets consecutive failure counter', async () => {
    const client = new FakeChatClient([
      // Turn 1: fail
      {
        toolUses: [{ name: 'search', input: { query: 'fail' } }],
      },
      // Turn 2: success (resets counter)
      {
        toolUses: [{ name: 'search', input: { query: 'ok' } }],
      },
      // Turn 3: fail
      {
        toolUses: [{ name: 'search', input: { query: 'fail' } }],
      },
      // Turn 4: terminal answer
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Done' } }],
      },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      policy: {
        maxTurns: 10,
        repeatedFailureLimit: 2,
        onExhaustion: 'fail',
      },
    })

    expect(res.stopReason).toBe('tool_use')
    expect(res.terminalTool).toBe('final_answer')
    expect(res.terminalInput).toEqual({ answer: 'Done' })
    expect(res.turns).toBe(4)
  })

  it('5. maxTurns, maxToolCalls, and maxDuration are enforced', async () => {
    // 5a. maxTurns
    const clientTurns = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { query: '1' } }] },
      { toolUses: [{ name: 'search', input: { query: '2' } }] },
      { toolUses: [{ name: 'search', input: { query: '3' } }] },
    ])
    const resTurns = await runToolLoop(clientTurns, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      policy: {
        maxTurns: 2,
        onExhaustion: 'fail',
      },
    })
    expect(resTurns.stopReason).toBe('max_turns')
    expect(resTurns.turns).toBe(2)

    // 5b. maxToolCalls
    const clientTools = new FakeChatClient([
      {
        toolUses: [
          { name: 'search', input: { query: '1' } },
          { name: 'search', input: { query: '2' } },
          { name: 'search', input: { query: '3' } },
        ],
      },
    ])
    const resTools = await runToolLoop(clientTools, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      policy: {
        maxToolCalls: 2,
        onExhaustion: 'fail',
      },
    })
    expect(resTools.stopReason).toBe('max_tool_calls')

    // 5c. maxDuration
    const slowSearchTool: Tool<{ query: string }> = {
      name: 'search',
      description: 'Search knowledge',
      schema: testInputSchema,
      handler: async ({ query }) => {
        await new Promise(r => setTimeout(r, 10))
        return JSON.stringify({ results: [`result for ${query}`] })
      },
    }
    const clientDuration = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { query: '1' } }] },
      { toolUses: [{ name: 'search', input: { query: '2' } }] },
    ])
    const resDuration = await runToolLoop(clientDuration, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [slowSearchTool, finalAnswerTool],
      policy: {
        maxDuration: 0.005, // 5 milliseconds
        onExhaustion: 'fail',
      },
    })
    expect(resDuration.stopReason).toBe('max_duration')
  })

  it('6. global hard ceilings cannot be exceeded by agent policy', async () => {
    const client = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { query: '1' } }] },
      { toolUses: [{ name: 'search', input: { query: '2' } }] },
      { toolUses: [{ name: 'search', input: { query: '3' } }] },
      { toolUses: [{ name: 'search', input: { query: '4' } }] },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      maxTurns: 3, // global ceiling
      policy: {
        maxTurns: 10, // policy attempts to exceed global ceiling
        onExhaustion: 'fail',
      },
    })

    // Stopped at 3 turns due to global ceiling
    expect(res.turns).toBe(3)
    expect(res.stopReason).toBe('max_turns')
  })

  it('7. existing agents without an explicit policy remain compatible', async () => {
    const client = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { query: '1' } }] },
      { toolUses: [{ name: 'final_answer', input: { answer: 'Legacy success' } }] },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
    })

    expect(res.terminalTool).toBe('final_answer')
    expect(res.terminalInput).toEqual({ answer: 'Legacy success' })
    expect(res.turns).toBe(2)
  })

  it('8. salvage failure is reported as failure, not false success', async () => {
    const client = new FakeChatClient([
      // Turn 1: tool call
      { toolUses: [{ name: 'search', input: { query: '1' } }] },
      // Salvage attempt 1 & 2 fail (return invalid input for final_answer)
      { toolUses: [{ name: 'final_answer', input: { invalid: 123 } }] },
      { toolUses: [{ name: 'final_answer', input: { invalid: 456 } }] },
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'You are a test agent',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [searchTool, finalAnswerTool],
      policy: {
        maxTurns: 1,
        onExhaustion: 'final-answer',
      },
    })

    // callStructuredTool fails after 2 attempts with invalid input;
    // handleExhaustion catches this and returns failure
    expect(res.terminalInput).toBeNull()
    expect(res.terminalTool).toBeNull()
    expect(res.stopReason).toBe('max_turns')
  })
})
