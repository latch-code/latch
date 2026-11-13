import { describe, expect, it } from 'vitest'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'

const call = { type: 'function_call', name: 'read', call_id: 'call_a', arguments: '{}' }
const result = { type: 'function_call_output', call_id: 'call_a', output: 'done' }
const fields = (input: unknown[]) => ({
  model: 'test-model',
  input,
  tools: [
    { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } },
    { type: 'custom', name: 'patch' },
  ],
})

async function fixture() {
  const sent: string[] = []
  const service: GatewayService = {
    kind: 'openai-compatible',
    baseURL: 'https://history.example.test/v1',
    apiKey: 'fixture-key',
    models: ['test-model'],
    fingerprint: 'fixed',
  }
  const gateway = new ModelGatewayServer({
    service: () => service,
    log: () => {},
    fetchFor: () => async (_url, init) => {
      sent.push(Buffer.from(init.body as Uint8Array).toString('utf8'))
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    },
  })
  await gateway.start()
  const lease = gateway.open({
    sessionId: 'history-test',
    route: {
      providerId: 'test',
      model: 'test-model',
      origin: 'https://history.example.test:443',
      wire: 'responses',
      upstream: 'chat-completions',
    },
  })
  return {
    sent,
    post: (body: string) =>
      fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
        body,
      }),
    close: async () => {
      lease.close()
      await gateway.close()
    },
  }
}

describe('Responses full-history validation before outbound fetch', () => {
  it.each([
    ['orphan result', [result]],
    ['missing result', [call]],
    ['reused call ID', [call, result, call, result]],
    ['function result for custom call', [{ type: 'custom_tool_call', name: 'patch', call_id: 'call_a', input: 'patch' }, result]],
    ['custom result for function call', [call, { ...result, type: 'custom_tool_call_output' }]],
    ['message before all results', [call, { role: 'user', content: 'continue without the result' }, result]],
    ['malformed arguments', [{ ...call, arguments: '{' }, result]],
    ['non-finite argument number', [{ ...call, arguments: '{"n":1e400}' }, result]],
  ])('rejects %s with HTTP 400 and no upstream call', async (_name, input) => {
    const f = await fixture()
    try {
      const reply = await f.post(JSON.stringify(fields(input as unknown[])))
      expect(reply.status).toBe(400)
      expect(f.sent).toHaveLength(0)
      expect(await reply.json()).toMatchObject({ error: { message: expect.any(String) } })
    } finally {
      await f.close()
    }
  })

  it.each(['tool', 'format'])('rejects a non-finite %s schema number before forwarding', async kind => {
    const f = await fixture()
    try {
      const body =
        kind === 'tool'
          ? '{"model":"test-model","input":"hello","tools":[{"type":"function","name":"read","parameters":{"type":"number","maximum":1e400}}]}'
          : '{"model":"test-model","input":"hello","text":{"format":{"type":"json_schema","name":"result","schema":{"type":"number","maximum":1e400}}}}'
      expect((await f.post(body)).status).toBe(400)
      expect(f.sent).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('keeps valid parallel results contiguous, with exact argument tokens and the complete conversation', async () => {
    const f = await fixture()
    try {
      const argumentsText = '{"id":9007199254740993,"fraction":0.10000000000000000001,"zero":-0}'
      const input = [
        { role: 'developer', content: 'system first' },
        { role: 'user', content: 'read and patch' },
        { ...call, arguments: argumentsText },
        { type: 'custom_tool_call', name: 'patch', call_id: 'call_b', input: 'raw patch text' },
        { type: 'custom_tool_call_output', call_id: 'call_b', output: 'patch done' },
        result,
        { role: 'assistant', content: 'finished' },
        { role: 'user', content: 'continue' },
      ]
      expect((await f.post(JSON.stringify(fields(input)))).status).toBe(200)
      expect(f.sent).toHaveLength(1)
      const outgoing = JSON.parse(f.sent[0]!) as { messages: Array<Record<string, unknown>> }
      expect(outgoing.messages.map(item => item.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'assistant', 'user'])
      expect(outgoing.messages[2]?.tool_calls).toMatchObject([
        { function: { arguments: argumentsText } },
        { function: { arguments: '{"content":"raw patch text"}' } },
      ])
      expect(outgoing.messages.slice(3, 5).map(item => item.tool_call_id)).toEqual(['call_b', 'call_a'])
      expect(outgoing.messages.at(-1)?.content).toBe('continue')
    } finally {
      await f.close()
    }
  })

  it('preserves finite numeric tokens in tool and output schemas over the HTTP wire', async () => {
    const f = await fixture()
    try {
      const body =
        '{"model":"test-model","input":"hello","tools":[{"type":"function","name":"read","parameters":{"type":"number","maximum":9007199254740993,"minimum":-0}}],"text":{"format":{"type":"json_schema","name":"result","schema":{"type":"number","multipleOf":0.10000000000000000001}}}}'
      expect((await f.post(body)).status).toBe(200)
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0]).toContain('"maximum":9007199254740993')
      expect(f.sent[0]).toContain('"minimum":-0')
      expect(f.sent[0]).toContain('"multipleOf":0.10000000000000000001')
    } finally {
      await f.close()
    }
  })
})
