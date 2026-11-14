import { expect, it } from 'vitest'
import { startFakeModels } from '@latch/testkit'

it.each([false, true])('lets a Responses client resolve its own deferred tool before a namespaced call (stream=%s)', async stream => {
  const upstream = await startFakeModels({
    replies: [
      { search: { input: { query: 'latch-skills propose_memory', limit: 4 } } },
      { tool: { namespace: 'latch-skills', name: 'propose_memory', input: { content: 'A preference' } } },
    ],
  })
  const request = async (input: unknown[]) => {
    const response = await fetch(`${upstream.origin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture', input, stream }),
    })
    expect(response.ok).toBe(true)
    if (!stream) return response.json() as Promise<{ output: Array<Record<string, unknown>> }>
    const events = (await response.text())
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as { type: string; item?: unknown; response?: { output: Array<Record<string, unknown>> } })
    const completed = events.find(event => event.type === 'response.completed')!.response!
    expect(events.filter(event => event.type === 'response.output_item.done').map(event => event.item)).toEqual(completed.output)
    return completed
  }
  try {
    const discovered = (await request([])).output[0]!
    expect(discovered).toMatchObject({
      type: 'tool_search_call',
      execution: 'client',
      status: 'completed',
      arguments: { query: 'latch-skills propose_memory', limit: 4 },
    })
    expect(discovered).not.toHaveProperty('tools')
    const loaded = { type: 'tool_search_output', call_id: discovered.call_id, execution: 'client', status: 'completed', tools: [] }
    const invoked = (await request([discovered, loaded])).output[0]!
    expect(invoked).toMatchObject({
      type: 'function_call',
      namespace: 'latch-skills',
      name: 'propose_memory',
      arguments: '{"content":"A preference"}',
    })
    expect(invoked.call_id).not.toBe(discovered.call_id)
    expect(upstream.requests).toHaveLength(2)
    expect(upstream.requests[1]!.body).toMatchObject({ input: [discovered, loaded] })
  } finally {
    await upstream.close()
  }
})
