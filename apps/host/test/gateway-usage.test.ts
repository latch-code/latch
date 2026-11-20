import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelFailureClass, ModelWire } from '@latch/protocol'
import type { ModelDelta, ModelGatewayLease, ModelProvider, ModelRoute } from '@latch/sdk'
import { startFakeModels, type FakeReply } from '@latch/testkit'
import { ModelSpendStore, createModelMeter } from '../src/model-budgets.ts'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'
import { ModelScheduler } from '../src/model-scheduler.ts'
import { UsageLedger, usageLineSchema } from '../src/model-usage.ts'
import { scheduledProvider } from '../src/scheduled-provider.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const KEY_A = 'sk-usage-first-0123456789abcdefghijklmn'
const KEY_B = 'sk-usage-second-0123456789abcdefghijklm'
// Text a test can find again if any of it were kept.
const PROMPT = 'PROMPT-TEXT-7f3a what the person typed'
const TOOL_ARGUMENT = 'TOOL-ARGUMENT-91bc'
const REPLY = 'REPLY-TEXT-c2d4 what the model said'
const REASONING = 'REASONING-TEXT-55aa'
const HEADER = 'HEADER-VALUE-0e1f'
const QUERY = 'QUERY-VALUE-4b6d'

type Kind = GatewayService['kind']
const BASE: Record<Kind, string> = { 'openai-responses': '/v1', 'openai-compatible': '/v1', anthropic: '' }
const KIND: Record<ModelWire, Kind> = {
  responses: 'openai-responses',
  'chat-completions': 'openai-compatible',
  'anthropic-messages': 'anthropic',
}
const WIRES: ModelWire[] = ['responses', 'chat-completions', 'anthropic-messages']

/** A gateway with a real ledger and budgets in a temporary data directory, over fake services `a` (the session's) and `b`. */
async function setup(options: { a?: FakeReply[]; b?: FakeReply[]; upstream?: ModelWire; agent?: string; models?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'latch-gateway-usage-'))
  const a = await startFakeModels({ replies: options.a ?? [{ text: REPLY, reasoning: REASONING }] })
  const b = await startFakeModels({ replies: options.b ?? [{ text: 'from the second' }] })
  cleanups.push(() => a.close())
  cleanups.push(() => b.close())
  const upstream = options.upstream ?? 'responses'
  const services: Record<string, GatewayService | undefined> = {
    a: {
      kind: KIND[upstream],
      baseURL: `${a.origin}${BASE[KIND[upstream]]}`,
      apiKey: KEY_A,
      models: options.models ?? ['fake-model'],
      fingerprint: 'a1',
    },
    b: { kind: 'openai-responses', baseURL: `${b.origin}/v1`, apiKey: KEY_B, models: ['fake-model'], fingerprint: 'b1' },
  }
  const logs: string[] = []
  const ledger = await UsageLedger.open(dir, { log: text => void logs.push(text) })
  // Registered first, so it runs last: nothing is still being written when the directory goes.
  cleanups.splice(0, 0, () => ledger.flushed().then(() => rm(dir, { recursive: true, force: true })))
  const store = await ModelSpendStore.open(dir)
  const meter = createModelMeter({
    ledger,
    store,
    session: () => ({ ...(options.agent ? { agentId: options.agent } : {}), harness: 'fake-harness' }),
    builtIn: 'standard',
  })
  const scheduler = new ModelScheduler({ fingerprint: id => services[id]?.fingerprint })
  const switches: Array<{ providerId: string; candidate: number; reason: ModelFailureClass }> = []
  const server = new ModelGatewayServer({
    service: id => services[id],
    fetchFor: () => fetch as typeof fetch,
    log: text => void logs.push(text),
    scheduler,
    meter,
    fallback: async event => {
      switches.push({ providerId: event.providerId, candidate: event.candidate, reason: event.reason })
    },
  })
  await server.start()
  cleanups.push(() => server.close())
  const open = (entry: ModelWire, fallback = false): ModelGatewayLease => {
    const route: ModelRoute = {
      providerId: 'a',
      model: options.models?.[0] ?? 'fake-model',
      wire: entry,
      ...(entry !== upstream ? { upstream } : {}),
      origin: a.origin,
      ...(fallback
        ? { fallbacks: { 'fake-model': [{ providerId: 'b', model: 'fake-model', upstream: 'responses', origin: b.origin }] } }
        : {}),
    }
    return server.open({ sessionId: 'session-1', route })
  }
  /** Every ledger file's text, as it is on disk. */
  const written = async (): Promise<string> => {
    await ledger.flushed()
    const names = (await readdir(join(dir, 'gateway'))).filter(name => name.startsWith('usage-'))
    return (await Promise.all(names.map(name => readFile(join(dir, 'gateway', name), 'utf8')))).join('')
  }
  /** The month's sums beside the ledger: keys and numbers. */
  const sums = async (): Promise<string> => {
    await ledger.flushed()
    const names = (await readdir(join(dir, 'gateway'))).filter(name => name.startsWith('totals-'))
    return (await Promise.all(names.map(name => readFile(join(dir, 'gateway', name), 'utf8')))).join('\n')
  }
  const lines = async () =>
    (await written())
      .split('\n')
      .filter(Boolean)
      .map(text => usageLineSchema.parse(JSON.parse(text)))
  return { a, b, dir, logs, ledger, store, meter, server, open, written, sums, lines, switches, scheduler }
}

/** One request in the shape `entry` speaks, with text, a tool argument, a header and a query string to look for later. */
function ask(lease: ModelGatewayLease, entry: ModelWire, options: { stream?: boolean; signal?: AbortSignal } = {}): Promise<Response> {
  const stream = options.stream ?? true
  const extra = { 'content-type': 'application/json', 'x-trace': HEADER, cookie: `session=${HEADER}` }
  const init = (headers: Record<string, string>, body: unknown): RequestInit => ({
    method: 'POST',
    headers: { ...extra, ...headers },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const tool = { name: 'lookup', description: TOOL_ARGUMENT, parameters: { type: 'object', properties: {} } }
  if (entry === 'responses')
    return fetch(
      `${lease.baseURL}/responses?trace=${QUERY}`,
      init(
        { authorization: `Bearer ${lease.token}` },
        { model: 'fake-model', input: PROMPT, stream, tools: [{ type: 'function', ...tool }] },
      ),
    )
  if (entry === 'chat-completions')
    return fetch(
      `${lease.baseURL}/chat/completions?trace=${QUERY}`,
      init(
        { authorization: `Bearer ${lease.token}` },
        { model: 'fake-model', stream, messages: [{ role: 'user', content: PROMPT }], tools: [{ type: 'function', function: tool }] },
      ),
    )
  return fetch(
    `${lease.baseURL}/v1/messages?trace=${QUERY}`,
    init(
      { 'x-api-key': lease.token, 'anthropic-version': '2023-06-01' },
      {
        model: 'fake-model',
        max_tokens: 64,
        stream,
        messages: [{ role: 'user', content: PROMPT }],
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
      },
    ),
  )
}

const ALLOWED = new Set([
  'at',
  'sessionId',
  'agentId',
  'harness',
  'providerId',
  'model',
  'used',
  'outcome',
  'attempts',
  'fallback',
  'firstByteMs',
  'totalMs',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'cost',
])

function expectNothingKept(text: string, tokens: string[]): void {
  for (const secret of [
    PROMPT,
    'PROMPT-TEXT',
    TOOL_ARGUMENT,
    REPLY,
    'REPLY-TEXT',
    REASONING,
    HEADER,
    QUERY,
    KEY_A,
    KEY_B,
    'sk-usage',
    ...tokens,
  ])
    expect(text).not.toContain(secret)
  expect(text).not.toMatch(/lmg1\./u)
  expect(text).not.toMatch(/authorization|x-api-key|x-goog-api-key|cookie|bearer/iu)
  for (const row of text.split('\n').filter(Boolean)) {
    const parsed = JSON.parse(row) as Record<string, unknown>
    for (const key of Object.keys(parsed)) expect(ALLOWED.has(key), key).toBe(true)
    expect(Object.keys((parsed.cost as object | undefined) ?? {}).every(key => ['micros', 'currency', 'source'].includes(key))).toBe(true)
  }
}

describe('the usage ledger behind the gateway', () => {
  it.each(WIRES)('keeps names and numbers only of a %s request passed through: no text, key, header or query string', async entry => {
    const { open, written, sums, lines, logs } = await setup({ upstream: entry })
    const lease = open(entry)
    for (const stream of [true, false]) {
      const response = await ask(lease, entry, { stream })
      expect(response.status).toBe(200)
      // The reply did reach the harness whole, so its text was there to be kept.
      expect(await response.text()).toContain('REPLY-TEXT')
    }
    const text = await written()
    expectNothingKept(text, [lease.token])
    expectNothingKept(logs.join('\n'), [lease.token])
    // The month's sums beside it hold a service's ID and numbers: no session, no model, nothing that was said.
    const totals = await sums()
    for (const kept of [
      PROMPT,
      'PROMPT-TEXT',
      REPLY,
      'REPLY-TEXT',
      REASONING,
      HEADER,
      QUERY,
      KEY_A,
      'sk-usage',
      lease.token,
      'session-1',
      'fake-model',
    ])
      expect(totals).not.toContain(kept)
    expect(Object.keys((JSON.parse(totals) as { use: object }).use)).toEqual(['service:a'])
    const rows = await lines()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toMatchObject({
        sessionId: 'session-1',
        harness: 'fake-harness',
        providerId: 'a',
        model: 'fake-model',
        outcome: 'ok',
        attempts: 1,
        fallback: false,
      })
      expect(row.inputTokens).toBeGreaterThan(0)
      expect(row.outputTokens).toBeGreaterThan(0)
      expect(row.firstByteMs).toBeGreaterThanOrEqual(0)
      expect(row.totalMs).toBeGreaterThanOrEqual(row.firstByteMs!)
      expect(row.cost).toBeUndefined()
    }
  })

  it.each([
    ['responses', 'chat-completions'],
    ['anthropic-messages', 'chat-completions'],
    ['anthropic-messages', 'responses'],
    ['responses', 'anthropic-messages'],
  ] as Array<[ModelWire, ModelWire]>)('keeps nothing of a converted %s → %s request either', async (entry, upstream) => {
    const { open, written, lines } = await setup({ upstream })
    const lease = open(entry)
    const response = await ask(lease, entry)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('REPLY-TEXT')
    expectNothingKept(await written(), [lease.token])
    expect(await lines()).toMatchObject([{ providerId: 'a', outcome: 'ok', attempts: 1 }])
  })

  it('keeps nothing of a request that failed, was refused or was given up on, and says how each ended', async () => {
    const secretError = `upstream said ${PROMPT} and ${KEY_A}`
    const { a, open, written, lines } = await setup({
      a: [{ error: { status: 400, message: secretError } }, { text: REPLY, cut: true }, { text: REPLY, silentMs: 1500 }],
    })
    const lease = open('responses')
    expect((await ask(lease, 'responses')).status).toBe(400)
    await (await ask(lease, 'responses')).text()
    // The harness gives up while the model is still thinking.
    const controller = new AbortController()
    const pending = ask(lease, 'responses', { signal: controller.signal })
    pending.catch(() => {})
    await expect.poll(() => a.requests.length).toBe(3)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await expect.poll(async () => (await lines()).length, { timeout: 5000 }).toBe(3)
    expectNothingKept(await written(), [lease.token])
    expect((await lines()).map(row => row.outcome)).toEqual(['request', 'stream', 'aborted'])
  })

  it('writes the built-in harness’s requests into the same ledger, with nothing of what was said', async () => {
    const { ledger, meter, written, lines } = await setup()
    const raw: ModelProvider = {
      id: 'a',
      name: 'a',
      model: 'fake-model',
      async *stream(): AsyncIterable<ModelDelta> {
        yield { type: 'reasoning', text: REASONING }
        yield { type: 'text', text: REPLY }
        yield { type: 'tool-call', call: { id: 'call-1', name: 'lookup', arguments: { query: TOOL_ARGUMENT } } }
        yield { type: 'usage', inputTokens: 40, outputTokens: 8, cacheReadTokens: 10 }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    }
    const provider = scheduledProvider(raw, {
      scheduler: new ModelScheduler(),
      fallbacks: () => [],
      fingerprint: () => 'a1',
      fallback: async () => {},
      meter,
    })
    const deltas: ModelDelta[] = []
    for await (const delta of provider.stream({
      messages: [{ role: 'user', content: PROMPT }],
      tools: [],
      signal: new AbortController().signal,
      model: 'fake-model',
      run: { sessionId: 'session-1', runId: 'run-1' },
    }))
      deltas.push(delta)
    // No cost is known and no budget is near, so the turn is told nothing of spend.
    expect(deltas.map(delta => delta.type)).toEqual(['reasoning', 'text', 'tool-call', 'usage', 'finish'])
    await ledger.flushed()
    expectNothingKept(await written(), [])
    expect(await lines()).toMatchObject([
      {
        sessionId: 'session-1',
        providerId: 'a',
        model: 'fake-model',
        outcome: 'ok',
        attempts: 1,
        inputTokens: 40,
        outputTokens: 8,
        cacheReadTokens: 10,
      },
    ])
  })
})

describe('cost', () => {
  it('is written when the service reports it in its reply, and never otherwise without prices', async () => {
    const { open, lines } = await setup({
      upstream: 'chat-completions',
      a: [{ text: 'one', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00042 } }, { text: 'two' }],
    })
    const lease = open('chat-completions')
    await (await ask(lease, 'chat-completions')).text()
    await (await ask(lease, 'chat-completions')).text()
    const rows = await lines()
    expect(rows[0]!.cost).toEqual({ micros: 420, currency: 'USD', source: 'reported' })
    expect(rows[1]!.cost).toBeUndefined()
    expect(lease.takeTurn().spend).toEqual({ cost: [{ currency: 'USD', micros: 420 }] })
  })

  it('is worked out from prices the person entered for the answering service’s model, and says so', async () => {
    const { open, lines, store } = await setup({ a: [{ error: { status: 401, message: 'bad key' } }], b: [{ text: 'from the second' }] })
    // The session's own model has one price, the fallback's another: the one that answered is what counts.
    await store.setPrice('a', 'fake-model', { currency: 'USD', input: 1000, output: 1000 })
    await store.setPrice('b', 'fake-model', { currency: 'CNY', input: 2, output: 8 })
    const lease = open('responses', true)
    // A refused key is not tried again in place: the request goes straight to the fallback.
    const response = await ask(lease, 'responses')
    expect(response.status).toBe(200)
    await response.text()
    const [row] = await lines()
    expect(row).toMatchObject({ providerId: 'b', fallback: true, attempts: 2, outcome: 'ok' })
    expect(row!.cost).toEqual({ micros: row!.inputTokens! * 2 + row!.outputTokens! * 8, currency: 'CNY', source: 'prices' })
    expect(lease.takeTurn().spend?.cost).toEqual([{ currency: 'CNY', micros: row!.cost!.micros, priced: true }])
  })
})

describe('a reply’s own word on cost', () => {
  const chatUsage = (cost: unknown) => ({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost })

  it('is not believed when it is not a plain amount within reason: the tokens count, the cost stays unknown', async () => {
    const hostile = [-1, 1e9, 100.01, 'free', '0.5', null, { amount: 1 }, [1], true]
    const { open, lines } = await setup({
      upstream: 'chat-completions',
      a: [...hostile.map(cost => ({ text: 'x', usage: chatUsage(cost) })), { text: 'x', usage: chatUsage(0.5) }],
    })
    const lease = open('chat-completions')
    for (let index = 0; index <= hostile.length; index++) {
      const response = await ask(lease, 'chat-completions', { stream: index % 2 === 0 })
      expect(response.status).toBe(200)
      await response.text()
    }
    const rows = await lines()
    expect(rows).toHaveLength(hostile.length + 1)
    for (const row of rows.slice(0, hostile.length)) {
      expect(row).toMatchObject({ outcome: 'ok', inputTokens: 10, outputTokens: 5 })
      expect(row.cost).toBeUndefined()
    }
    expect(rows.at(-1)!.cost).toEqual({ micros: 500_000, currency: 'USD', source: 'reported' })
  })

  it('gives way to prices the person entered for the model', async () => {
    const { open, lines, store } = await setup({ upstream: 'chat-completions', a: [{ text: 'x', usage: chatUsage(50) }] })
    await store.setPrice('a', 'fake-model', { currency: 'CNY', input: 2, output: 8 })
    const lease = open('chat-completions')
    await (await ask(lease, 'chat-completions')).text()
    expect((await lines())[0]!.cost).toEqual({ micros: 10 * 2 + 5 * 8, currency: 'CNY', source: 'prices' })
  })
})

describe('what a reply reported before it ended badly', () => {
  it('is still counted when the stream breaks after it began', async () => {
    const { open, lines, store, meter } = await setup({ upstream: 'anthropic-messages', a: [{ text: REPLY, cut: true }] })
    await store.setBudget('service', 'a', { unit: 'tokens', limit: 1000 })
    const lease = open('anthropic-messages')
    await (await ask(lease, 'anthropic-messages')).text()
    await expect.poll(async () => (await lines()).length).toBe(1)
    const [row] = await lines()
    // The message's first event said what the input was; the reply never got to say how it ended.
    expect(row).toMatchObject({ outcome: 'stream', attempts: 1 })
    expect(row!.inputTokens).toBeGreaterThan(0)
    expect(meter.progress(store.budgetOf('service', 'a')!).used).toBe(row!.inputTokens! + row!.outputTokens!)
    // The turn counts the same tokens as the ledger, and still says the request did not complete.
    const [model] = lease.takeTurn().models
    expect(model).toMatchObject({ requests: 1, failed: 1, usage: { inputTokens: row!.inputTokens, outputTokens: row!.outputTokens } })
    expect(model).not.toHaveProperty('measured')
    expectNothingKept(JSON.stringify(row), [lease.token])
  })

  it('is still counted for the built-in harness when the person stops the turn mid-reply', async () => {
    const { meter, lines } = await setup()
    const controller = new AbortController()
    const raw: ModelProvider = {
      id: 'a',
      name: 'a',
      model: 'fake-model',
      async *stream(): AsyncIterable<ModelDelta> {
        yield { type: 'usage', inputTokens: 33, outputTokens: 2 }
        yield { type: 'text', text: REPLY }
        controller.abort()
        throw new Error('aborted')
      },
    }
    const provider = scheduledProvider(raw, {
      scheduler: new ModelScheduler(),
      fallbacks: () => [],
      fingerprint: () => 'a1',
      fallback: async () => {},
      meter,
    })
    const run = async () => {
      for await (const _delta of provider.stream({
        messages: [],
        tools: [],
        signal: controller.signal,
        model: 'fake-model',
        run: { sessionId: 'session-1', runId: 'run-1' },
      })) {
        // Read to its end.
      }
    }
    await expect(run()).rejects.toThrow()
    expect(await lines()).toMatchObject([{ outcome: 'aborted', inputTokens: 33, outputTokens: 2 }])
  })
})

describe('monthly budgets', () => {
  const expected: Record<ModelWire, (body: Record<string, unknown>) => void> = {
    responses: body => expect(body).toEqual({ error: { code: 'budget-exceeded', message: '本月预算已用完' } }),
    'chat-completions': body => expect(body).toEqual({ error: { code: 'budget-exceeded', message: '本月预算已用完' } }),
    'anthropic-messages': body =>
      expect(body).toEqual({ type: 'error', error: { type: 'billing_error', message: '本月预算已用完', code: 'budget-exceeded' } }),
  }

  it.each(WIRES)('refuse a new %s request in its own protocol’s shape once the service’s budget is used up', async entry => {
    const { open, store, a, lines } = await setup({ upstream: entry, a: [{ text: 'one' }, { text: 'two' }] })
    await store.setBudget('service', 'a', { unit: 'tokens', limit: 5 })
    const lease = open(entry)
    // The first request is under the budget when it arrives, and takes it over.
    expect((await ask(lease, entry)).status).toBe(200)
    await expect.poll(async () => (await lines()).length).toBe(1)
    const refused = await ask(lease, entry)
    expect(refused.status).toBe(402)
    expected[entry]((await refused.json()) as Record<string, unknown>)
    expect(a.requests).toHaveLength(1)
    expect((await lines()).map(row => [row.outcome, row.attempts])).toEqual([
      ['ok', 1],
      ['budget', 0],
    ])
    expect(lease.takeTurn()).toMatchObject({ requests: 2, models: [{ requests: 2, failed: 1 }], spend: { budget: 'over' } })
  })

  it('tell the session at 80%, and let it go on', async () => {
    const { open, store, lines } = await setup({ a: [{ text: 'one' }, { text: 'two' }] })
    const lease = open('responses')
    await (await ask(lease, 'responses')).text()
    const [first] = await lines()
    const used = first!.inputTokens! + first!.outputTokens!
    expect(lease.takeTurn().spend).toBeUndefined()
    // The next request brings the month to twice that: 80% of this limit.
    await store.setBudget('service', 'a', { unit: 'tokens', limit: Math.floor((used * 2) / 0.8) })
    const response = await ask(lease, 'responses')
    expect(response.status).toBe(200)
    await response.text()
    expect(lease.takeTurn().spend).toEqual({ budget: 'near' })
  })

  it('let a request already under way finish while new ones are refused', async () => {
    const { open, store, meter, a } = await setup({ a: [{ text: REPLY, silentMs: 400 }] })
    await store.setBudget('service', 'a', { unit: 'tokens', limit: 100 })
    const lease = open('responses')
    const flying = ask(lease, 'responses')
    await expect.poll(() => a.requests.length).toBe(1)
    // The month's budget runs out while the first reply is still coming.
    meter.record({
      at: Date.now(),
      sessionId: 'another',
      providerId: 'a',
      model: 'fake-model',
      outcome: 'ok',
      attempts: 1,
      fallback: false,
      totalMs: 1,
      usage: { inputTokens: 90, outputTokens: 20 },
    })
    expect((await ask(lease, 'responses')).status).toBe(402)
    const response = await flying
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('REPLY-TEXT')
    expect(a.requests).toHaveLength(1)
  })

  it('move a request on to 「出错时改用」 when the service’s own budget is used up, on record as that', async () => {
    const { open, store, a, b, switches, lines } = await setup()
    await store.setBudget('service', 'a', { unit: 'tokens', limit: 1 })
    const lease = open('responses', true)
    await (await ask(lease, 'responses')).text()
    await expect.poll(async () => (await lines()).length).toBe(1)
    const response = await ask(lease, 'responses')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('from the second')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(1)
    expect(switches).toEqual([{ providerId: 'a', candidate: 1, reason: 'budget' }])
    expect((await lines())[1]).toMatchObject({ providerId: 'b', fallback: true, attempts: 1, outcome: 'ok' })
  })

  it('never move an Agent’s request to another service when the Agent’s budget is used up', async () => {
    const { open, store, a, b, switches, lines } = await setup({ agent: 'agent-1' })
    await store.setBudget('agent', 'agent-1', { unit: 'tokens', limit: 1 })
    const lease = open('responses', true)
    await (await ask(lease, 'responses')).text()
    await expect.poll(async () => (await lines()).length).toBe(1)
    const refused = await ask(lease, 'responses')
    expect(refused.status).toBe(402)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('budget-exceeded')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(0)
    expect(switches).toEqual([])
    expect((await lines())[1]).toMatchObject({ outcome: 'budget', attempts: 0, agentId: 'agent-1', providerId: 'a' })
  })

  it('refuse the built-in harness the same way, and tell its turn what a request cost and that a budget is near', async () => {
    const { store, meter, switches } = await setup({ agent: 'agent-1' })
    await store.setPrice('a', 'fake-model', { currency: 'USD', input: 1, output: 1 })
    await store.setBudget('service', 'a', { unit: 'tokens', limit: 100 })
    const calls: string[] = []
    const raw = (id: string): ModelProvider => ({
      id,
      name: id,
      model: 'fake-model',
      async *stream(): AsyncIterable<ModelDelta> {
        calls.push(id)
        yield { type: 'text', text: `from ${id}` }
        yield { type: 'usage', inputTokens: 70, outputTokens: 15 }
        yield { type: 'finish', reason: 'stop' }
      },
    })
    const other = raw('b')
    const provider = scheduledProvider(raw('a'), {
      scheduler: new ModelScheduler(),
      fallbacks: () => [{ providerId: 'b', model: 'fake-model', fingerprint: 'b1', provider: () => other }],
      fingerprint: () => 'a1',
      fallback: async event => {
        switches.push({ providerId: event.providerId, candidate: event.candidate, reason: event.reason })
      },
      meter,
    })
    const run = async (runId: string) => {
      const deltas: ModelDelta[] = []
      for await (const delta of provider.stream({
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        model: 'fake-model',
        run: { sessionId: 'session-1', runId },
      }))
        deltas.push(delta)
      return deltas
    }
    // 85 of 100: near. The spend comes before the reply's last event.
    expect(await run('one')).toEqual([
      { type: 'text', text: 'from a' },
      { type: 'usage', inputTokens: 70, outputTokens: 15 },
      { type: 'spend', spend: { cost: [{ currency: 'USD', micros: 85, priced: true }], budget: 'near' } },
      { type: 'finish', reason: 'stop' },
    ])
    // 170 of 100 after the second.
    await run('two')
    // The service's budget is used up: the request goes to the fallback, on record as that.
    expect((await run('three'))[0]).toEqual({ type: 'route', providerId: 'b', model: 'fake-model' })
    expect(calls).toEqual(['a', 'a', 'b'])
    expect(switches).toEqual([{ providerId: 'a', candidate: 1, reason: 'budget' }])
    // The Agent's budget is the Agent's alone: nothing is asked of any service.
    await store.setBudget('agent', 'agent-1', { unit: 'tokens', limit: 10 })
    await expect(run('four')).rejects.toMatchObject({ status: 402, code: 'budget-exceeded', message: '本月预算已用完' })
    expect(calls).toHaveLength(3)
  })

  it('count every request of a turn, however many models it names', async () => {
    const names = Array.from({ length: 18 }, (_, index) => `model-${index + 1}`)
    const { open, store, meter, a, lines } = await setup({ models: names, a: names.map(() => ({ text: 'x' })) })
    const lease = open('responses')
    const request = (model: string) =>
      fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: 'hello', stream: true }),
      })
    // One reply's tokens, to set a budget the 17th request of the same turn uses up.
    await (await request(names[0]!)).text()
    const firstRows = await lines()
    expect(firstRows).toHaveLength(1)
    const [first] = firstRows
    const each = first!.inputTokens! + first!.outputTokens!
    await store.setBudget('service', 'a', { unit: 'tokens', limit: each * 17 })
    for (const name of names.slice(1, 17)) {
      const response = await request(name)
      expect(response.status).toBe(200)
      await response.text()
    }
    // The turn lists 16 models; the 17th request is on the ledger and in the budget all the same.
    const rows = await lines()
    expect(rows.map(row => row.model)).toEqual(names.slice(0, 17))
    expect(rows[16]).toMatchObject({ outcome: 'ok', inputTokens: first!.inputTokens, outputTokens: first!.outputTokens })
    expect(meter.progress(store.budgetOf('service', 'a')!)).toMatchObject({ used: each * 17, state: 'over' })
    const refused = await request(names[17]!)
    expect(refused.status).toBe(402)
    expect(a.requests).toHaveLength(17)
    expect((await lines())[17]).toMatchObject({ model: names[17], outcome: 'budget', attempts: 0 })
    const turn = lease.takeTurn()
    expect(turn.requests).toBe(18)
    expect(turn.models).toHaveLength(16)
  })

  it('have no reservation: requests that arrive together under the limit all go, and the next is refused', async () => {
    const replies = Array.from({ length: 5 }, () => ({ text: 'x', delayMs: 150 }))
    const { open, store, meter, a, lines } = await setup({ a: replies })
    const lease = open('responses')
    await store.setBudget('service', 'a', { unit: 'tokens', limit: 100 })
    meter.record({
      at: Date.now(),
      sessionId: 'another',
      providerId: 'a',
      model: 'fake-model',
      outcome: 'ok',
      attempts: 1,
      fallback: false,
      totalMs: 1,
      usage: { inputTokens: 90, outputTokens: 5 },
    })
    // 95 of 100: every one of the five is under the limit when it arrives.
    const responses = await Promise.all(replies.map(() => ask(lease, 'responses')))
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200])
    await Promise.all(responses.map(response => response.text()))
    await expect.poll(async () => (await lines()).length).toBe(6)
    const rows = (await lines()).slice(1)
    const used = meter.progress(store.budgetOf('service', 'a')!).used
    // Over by no more than what the five under way used; nothing after them is sent.
    expect(used).toBe(95 + rows.reduce((sum, row) => sum + row.inputTokens! + row.outputTokens!, 0))
    expect((await ask(lease, 'responses')).status).toBe(402)
    expect(a.requests).toHaveLength(5)
  })

  it('answer with a pause, not the budget, when another candidate is only held back for now', async () => {
    const { open, store, meter, a, b, lines } = await setup({
      b: Array.from({ length: 4 }, () => ({ error: { status: 401, message: 'bad key' } })),
    })
    await store.setBudget('service', 'a', { unit: 'tokens', limit: 10 })
    meter.record({
      at: Date.now(),
      sessionId: 'another',
      providerId: 'a',
      model: 'fake-model',
      outcome: 'ok',
      attempts: 1,
      fallback: false,
      totalMs: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    const lease = open('responses', true)
    // The first service is out of budget, so each request goes to the second, which refuses its key: its own failure.
    for (let index = 0; index < 4; index++) expect((await ask(lease, 'responses')).status).toBe(401)
    expect(a.requests).toHaveLength(0)
    expect(b.requests).toHaveLength(4)
    // Four failures in a row: the second is held back for a minute. It will open again, so this is a pause to wait out.
    const paused = await ask(lease, 'responses')
    expect(paused.status).toBe(503)
    expect(paused.headers.get('retry-after')).toBeTruthy()
    expect(((await paused.json()) as { error: { code: string } }).error.code).toBe('gateway-circuit-open')
    expect(b.requests).toHaveLength(4)
    expect((await lines()).at(-1)).toMatchObject({ outcome: 'circuit-open', attempts: 0 })
  })

  describe('with 「出错时改用」', () => {
    const spent = (providerId: string, tokens: number) => ({
      at: Date.now(),
      sessionId: 'another',
      providerId,
      model: 'fake-model',
      outcome: 'ok' as const,
      attempts: 1,
      fallback: false,
      totalMs: 1,
      usage: { inputTokens: tokens, outputTokens: 0 },
    })

    it('hold on both services: a request that leaves one for its budget is refused when the other’s is used up too', async () => {
      const { open, store, meter, a, b, switches, lines } = await setup()
      await store.setBudget('service', 'a', { unit: 'tokens', limit: 10 })
      await store.setBudget('service', 'b', { unit: 'tokens', limit: 10 })
      meter.record(spent('a', 10))
      meter.record(spent('b', 10))
      const lease = open('responses', true)
      const refused = await ask(lease, 'responses')
      expect(refused.status).toBe(402)
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('budget-exceeded')
      // Nothing was sent to either. Leaving the first is on record, as every move is before it is tried.
      expect(a.requests).toHaveLength(0)
      expect(b.requests).toHaveLength(0)
      expect(switches).toEqual([{ providerId: 'a', candidate: 1, reason: 'budget' }])
      expect((await lines()).at(-1)).toMatchObject({ outcome: 'budget', attempts: 0, providerId: 'a', fallback: false })
    })

    it('count a moved request against the service that answered, never the one it left, and stop at that service’s own limit', async () => {
      const failing = Array.from({ length: 3 }, () => ({ error: { status: 401, message: 'bad key' } }))
      const { open, store, meter, a, b, lines } = await setup({ a: failing, b: [{ text: 'one' }, { text: 'two' }] })
      await store.setBudget('service', 'a', { unit: 'tokens', limit: 1000 })
      const lease = open('responses', true)
      // The first service refuses its key; the second answers.
      expect((await ask(lease, 'responses')).status).toBe(200)
      await expect.poll(async () => (await lines()).length).toBe(1)
      const [moved] = await lines()
      const each = moved!.inputTokens! + moved!.outputTokens!
      expect(moved).toMatchObject({ providerId: 'b', fallback: true, attempts: 2 })
      // What the second service answered is the second's to count: the first's budget has not moved.
      expect(meter.progress(store.budgetOf('service', 'a')!).used).toBe(0)
      await store.setBudget('service', 'b', { unit: 'tokens', limit: each })
      expect(meter.progress(store.budgetOf('service', 'b')!)).toMatchObject({ used: each, state: 'over' })
      // The next turn: the first service fails again, and the second is out of budget. Moving on does not get past that:
      // nothing is sent to the second, and the answer is the first service's own failure.
      lease.takeTurn()
      const second = await ask(lease, 'responses')
      expect(second.status).toBe(401)
      expect(a.requests).toHaveLength(2)
      expect(b.requests).toHaveLength(1)
      // Within a turn that already moved, the request starts at the second service: its budget is asked there too.
      await store.setBudget('service', 'b', { unit: 'tokens', limit: each * 2 })
      lease.takeTurn()
      expect((await ask(lease, 'responses')).status).toBe(200)
      await expect.poll(async () => (await lines()).length).toBe(3)
      expect(meter.progress(store.budgetOf('service', 'b')!)).toMatchObject({ used: each * 2, state: 'over' })
      const sticky = await ask(lease, 'responses')
      expect(sticky.status).not.toBe(200)
      expect(b.requests).toHaveLength(2)
    })

    it('hold for the built-in harness the same way', async () => {
      const { store, meter } = await setup()
      await store.setBudget('service', 'a', { unit: 'tokens', limit: 10 })
      await store.setBudget('service', 'b', { unit: 'tokens', limit: 100 })
      meter.record(spent('a', 10))
      const calls: string[] = []
      const raw = (id: string): ModelProvider => ({
        id,
        name: id,
        model: 'fake-model',
        async *stream(): AsyncIterable<ModelDelta> {
          calls.push(id)
          yield { type: 'usage', inputTokens: 60, outputTokens: 0 }
          yield { type: 'finish', reason: 'stop' }
        },
      })
      const other = raw('b')
      const provider = scheduledProvider(raw('a'), {
        scheduler: new ModelScheduler(),
        fallbacks: () => [{ providerId: 'b', model: 'fake-model', fingerprint: 'b1', provider: () => other }],
        fingerprint: () => 'a1',
        fallback: async () => {},
        meter,
      })
      const run = async (runId: string) => {
        for await (const _delta of provider.stream({
          messages: [],
          tools: [],
          signal: new AbortController().signal,
          model: 'fake-model',
          run: { sessionId: 'session-1', runId },
        })) {
          // Read to its end.
        }
      }
      // The first is out of budget: the second answers, twice, and its own budget counts both.
      await run('one')
      await run('two')
      expect(calls).toEqual(['b', 'b'])
      expect(meter.progress(store.budgetOf('service', 'b')!)).toMatchObject({ used: 120, state: 'over' })
      expect(meter.progress(store.budgetOf('service', 'a')!).used).toBe(10)
      // Both used up: nothing is asked of either.
      await expect(run('three')).rejects.toMatchObject({ status: 402, code: 'budget-exceeded' })
      expect(calls).toHaveLength(2)
    })
  })
})
