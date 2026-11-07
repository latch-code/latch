import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRecord, AppSnapshot, ProviderSettings, TaskDetail } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import { FAKE_ACP_AGENT, startFakeModels, type FakeModels, type TestDevice } from '@latch/testkit'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const KEY = 'sk-service-key-0123456789abcdefghij'

async function gateway(services: Record<string, GatewayService>, fetchFor = () => fetch as typeof fetch) {
  const logs: string[] = []
  const server = new ModelGatewayServer({ service: id => services[id], fetchFor, log: text => void logs.push(text) })
  await server.start()
  cleanups.push(() => server.close())
  return { server, logs }
}

async function models(replies?: Parameters<typeof startFakeModels>[0]): Promise<FakeModels> {
  const fake = await startFakeModels(replies)
  cleanups.push(() => fake.close())
  return fake
}

const responses = (fake: FakeModels, change: Partial<GatewayService> = {}): GatewayService => ({
  kind: 'openai-responses',
  baseURL: `${fake.origin}/v1`,
  apiKey: KEY,
  models: ['fake-model'],
  fingerprint: 'one',
  ...change,
})

const route = (fake: FakeModels, wire: 'responses' | 'gemini' = 'responses') => ({
  providerId: 'svc',
  model: 'fake-model',
  wire,
  origin: fake.origin,
})

/** A request whose headers, the Host header among them, are exactly what a test says. */
function raw(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const sent = httpRequest(new URL(url), { method: init.method ?? 'GET', headers: init.headers ?? {} }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => (text += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }))
    })
    sent.on('error', reject)
    sent.end(init.body)
  })
}

const ask = (base: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('model gateway', () => {
  it("forwards a harness's request with the service's key, never its own credential, and streams the reply back", async () => {
    const fake = await models({ replies: [{ text: 'through Latch' }] })
    const { server } = await gateway({ svc: responses(fake) })
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    expect(lease.token).toMatch(/^lmg1\.[A-Za-z0-9_-]{43}$/u)
    expect(lease.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
    const response = await ask(
      lease.baseURL,
      lease.token,
      { model: 'fake-model', input: 'hi', stream: true },
      {
        cookie: 'session=1',
        'x-api-key': lease.token,
        'openai-beta': 'responses=v1',
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.text()).toContain('through Latch')
    expect(fake.requests).toMatchObject([{ wire: 'responses', model: 'fake-model', key: KEY }])
    expect(fake.requests[0]!.headerNames).not.toContain('cookie')
    expect(fake.requests[0]!.headerNames).not.toContain('x-api-key')
    expect(fake.requests[0]!.headerNames).toContain('openai-beta')
    expect(lease.requests()).toBe(1)
    // Its own listing is the session's models, and asks the service nothing.
    const listed = await fetch(`${lease.baseURL}/models`, { headers: { authorization: `Bearer ${lease.token}` } })
    expect(await listed.json()).toEqual({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'latch' }] })
    expect(fake.requests).toHaveLength(1)
    expect(lease.requests()).toBe(1)
    expect(lease.models).toEqual(['fake-model'])
  })

  it('forwards Gemini requests with the key in its header and only the stream parameter', async () => {
    const fake = await models({ replies: [{ text: 'gemini says' }] })
    const { server } = await gateway({ svc: { ...responses(fake), kind: 'gemini', baseURL: fake.origin } })
    const lease = server.open({ sessionId: 'task-1', route: route(fake, 'gemini') })
    expect(lease.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    const response = await fetch(`${lease.baseURL}/v1beta/models/fake-model:streamGenerateContent?alt=sse&key=${lease.token}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': lease.token, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"says"')
    expect(fake.requests).toMatchObject([{ wire: 'gemini', model: 'fake-model', stream: true, key: KEY }])
    const other = await fetch(`${lease.baseURL}/v1beta/models/other-model:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': lease.token, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(other.status).toBe(403)
    expect(fake.requests).toHaveLength(1)
  })

  it('refuses another host, a page, an unknown token, another model, another path and a body that is not JSON', async () => {
    const fake = await models()
    const { server } = await gateway({ svc: responses(fake) })
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    const { port } = new URL(lease.baseURL)
    const auth = { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' }
    const body = JSON.stringify({ model: 'fake-model', input: 'hi' })
    const refused = [
      await raw(`${lease.baseURL}/responses`, { method: 'POST', headers: { ...auth, host: `evil.example:${port}` }, body }),
      await raw(`${lease.baseURL}/responses`, { method: 'POST', headers: { ...auth, origin: 'https://evil.example' }, body }),
      await raw(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { ...auth, authorization: `Bearer lmg1.${'x'.repeat(43)}` },
        body,
      }),
      await raw(`${lease.baseURL}/responses`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'gpt-other', input: 'hi' }) }),
      await raw(`${lease.baseURL}/chat/completions`, { method: 'POST', headers: auth, body }),
      await raw(`${lease.baseURL}/responses`, { method: 'POST', headers: auth, body: 'not json' }),
    ]
    expect(refused.map(item => item.status)).toEqual([403, 403, 401, 403, 404, 400])
    for (const item of refused) expect(item.text).not.toContain(lease.token)
    expect(fake.requests).toEqual([])
    // The last three carried this token: refused, they still reached Latch and went nowhere else.
    expect(lease.requests()).toBe(3)
  })

  it('stops a token when its process ends, when the service changes, and refuses to open one it cannot use', async () => {
    const fake = await models()
    const services: Record<string, GatewayService> = { svc: responses(fake) }
    const { server } = await gateway(services)
    const closed = server.open({ sessionId: 'task-1', route: route(fake) })
    closed.close()
    expect(closed.active()).toBe(false)
    expect((await ask(closed.baseURL, closed.token, { model: 'fake-model', input: 'hi' })).status).toBe(401)

    const changed = server.open({ sessionId: 'task-1', route: route(fake) })
    expect(changed.active()).toBe(true)
    services.svc = { ...services.svc!, fingerprint: 'two' }
    expect((await ask(changed.baseURL, changed.token, { model: 'fake-model', input: 'hi' })).status).toBe(401)
    expect(changed.active()).toBe(false)
    expect(changed.requests()).toBe(1)
    expect(fake.requests).toEqual([])

    expect(() => server.open({ sessionId: 'task-1', route: { ...route(fake), providerId: 'gone' } })).toThrow(
      expect.objectContaining({ code: 'model-route-unavailable' }),
    )
    expect(() => server.open({ sessionId: 'task-1', route: { ...route(fake), origin: 'https://elsewhere.example:443' } })).toThrow(
      expect.objectContaining({ code: 'model-route-changed' }),
    )
    expect(() => server.open({ sessionId: 'task-1', route: { ...route(fake), wire: 'gemini' } })).toThrow(
      expect.objectContaining({ code: 'model-route-changed' }),
    )
    expect(() => server.open({ sessionId: 'task-1', route: { ...route(fake), model: 'removed' } })).toThrow(
      expect.objectContaining({ code: 'model-unavailable' }),
    )
    // Every token is gone with the gateway.
    const last = server.open({ sessionId: 'task-1', route: route(fake) })
    await server.close()
    expect(last.active()).toBe(false)
  })

  it('takes the key out of what a service answers with, and follows no redirect', async () => {
    const echoing = createServer((request, response) => {
      if (request.url?.startsWith('/redirect')) {
        response.writeHead(302, { location: 'https://elsewhere.example/v1/responses' })
        response.end()
        return
      }
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, type: 'invalid_request_error' } }))
    })
    await new Promise<void>(resolve => echoing.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise(resolve => echoing.close(() => resolve())))
    const origin = `http://127.0.0.1:${(echoing.address() as AddressInfo).port}`
    const fake = { origin } as FakeModels
    const { server } = await gateway({
      svc: responses(fake),
      moved: responses(fake, { baseURL: `${origin}/redirect` }),
    })
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    const failed = await ask(lease.baseURL, lease.token, { model: 'fake-model', input: 'hi' })
    expect(failed.status).toBe(401)
    const text = await failed.text()
    expect(text).not.toContain(KEY)
    expect(JSON.parse(text)).toEqual({ error: { message: 'Incorrect API key provided: [redacted]', type: 'invalid_request_error' } })

    const moved = server.open({ sessionId: 'task-1', route: { ...route(fake), providerId: 'moved' } })
    const redirected = await ask(moved.baseURL, moved.token, { model: 'fake-model', input: 'hi' })
    expect(redirected.status).toBe(502)
    expect(await redirected.text()).not.toContain(KEY)
  })

  it('counts per turn the models asked for, what the service said answered and the tokens it reported, never the text', async () => {
    const fake = await models({
      replies: [{ text: 'first', reasoning: 'think' }, { text: 'second', answeredBy: 'fake-model-2' }, { text: 'third' }],
    })
    const { server } = await gateway({ svc: responses(fake, { models: ['fake-model', 'fake-model-large'] }) })
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    expect(lease.takeTurn()).toEqual({ requests: 0, models: [] })
    expect(await (await ask(lease.baseURL, lease.token, { model: 'fake-model', input: 'hi', stream: true })).text()).toContain('first')
    expect(await (await ask(lease.baseURL, lease.token, { model: 'fake-model', input: 'hi', stream: true })).text()).toContain('second')
    // Not streamed: the whole reply is one document.
    expect(await (await ask(lease.baseURL, lease.token, { model: 'fake-model-large', input: 'hi' })).json()).toMatchObject({
      model: 'fake-model-large',
    })
    expect((await ask(lease.baseURL, lease.token, { model: 'not-served', input: 'hi' })).status).toBe(403)
    await fetch(`${lease.baseURL}/models`, { headers: { authorization: `Bearer ${lease.token}` } })
    const turn = lease.takeTurn()
    expect(turn).toEqual({
      requests: 4,
      models: [
        {
          model: 'fake-model',
          used: 'fake-model-2',
          requests: 2,
          measured: 2,
          usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 2 },
        },
        {
          model: 'fake-model-large',
          used: 'fake-model-large',
          requests: 1,
          measured: 1,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
        },
        { model: 'not-served', requests: 1, failed: 1 },
      ],
    })
    expect(JSON.stringify(turn)).not.toMatch(/first|second|think|hi/u)
    // The next turn counts afresh; the total does not.
    expect(lease.takeTurn()).toEqual({ requests: 0, models: [] })
    expect(lease.requests()).toBe(4)
  })

  it('counts Gemini replies, streamed and not, with thoughts as output, and a failed reply as failed', async () => {
    const fake = await models({
      replies: [{ text: 'gemini says', reasoning: 'hmm' }, { text: 'once' }, { error: { status: 429, message: 'slow down' } }],
    })
    const { server } = await gateway({ svc: { ...responses(fake), kind: 'gemini', baseURL: fake.origin } })
    const lease = server.open({ sessionId: 'task-1', route: route(fake, 'gemini') })
    const call = (method: string) =>
      fetch(`${lease.baseURL}/v1beta/models/fake-model:${method}`, {
        method: 'POST',
        headers: { 'x-goog-api-key': lease.token, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      })
    expect((await (await call('streamGenerateContent?alt=sse')).text()).length).toBeGreaterThan(0)
    expect(await (await call('generateContent')).json()).toMatchObject({ modelVersion: 'fake-model' })
    expect((await call('generateContent')).status).toBe(429)
    expect(lease.takeTurn()).toEqual({
      requests: 3,
      models: [
        {
          model: 'fake-model',
          used: 'fake-model',
          requests: 3,
          failed: 1,
          measured: 2,
          usage: { inputTokens: 20, outputTokens: 12, reasoningTokens: 2 },
        },
      ],
    })
  })

  it('stops the request to the service when the harness gives up on it', async () => {
    let aborted!: () => void
    const gone = new Promise<void>(resolve => (aborted = resolve))
    const slow = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {}\n\n')
      request.on('close', () => aborted())
    })
    await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () =>
        new Promise(resolve => {
          slow.closeAllConnections()
          slow.close(() => resolve())
        }),
    )
    const fake = { origin: `http://127.0.0.1:${(slow.address() as AddressInfo).port}` } as FakeModels
    const { server } = await gateway({ svc: responses(fake) })
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    const controller = new AbortController()
    const response = await fetch(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', input: 'hi', stream: true }),
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await gone
    // A reply cut short tells nothing of its tokens: it counts as not completed. Taking the turn before it settles would
    // leave the settling to a turn already taken, so this waits for the gateway to see the end.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(lease.takeTurn().models).toEqual([{ model: 'fake-model', requests: 1, failed: 1 }])
  })

  /**
   * A Responses service that sends a reply's events and then holds the stream open, as a proxy or keep-alive may after
   * the reply is complete; `completed: false` holds it before the reply completes.
   */
  async function lingering(options: { completed: boolean }) {
    let closed!: () => void
    const gone = new Promise<void>(resolve => (closed = resolve))
    const service = createServer((request, response) => {
      const event = (type: string, data: Record<string, unknown>) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      event('response.created', { response: { model: 'fake-model-2', status: 'in_progress', usage: null } })
      event('response.output_text.delta', { delta: 'secret text' })
      if (options.completed)
        event('response.completed', {
          response: { model: 'fake-model-2', status: 'completed', usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } },
        })
      request.on('close', () => closed())
    })
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () =>
        new Promise(resolve => {
          service.closeAllConnections()
          service.close(() => resolve())
        }),
    )
    const fake = { origin: `http://127.0.0.1:${(service.address() as AddressInfo).port}` } as FakeModels
    const { server } = await gateway({ svc: responses(fake) })
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    const controller = new AbortController()
    const response = await fetch(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', input: 'hi', stream: true }),
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    /** Reads the reply as a harness does, until `text` has arrived. */
    const readUntil = async (text: string) => {
      let seen = ''
      while (!seen.includes(text)) {
        const next = await reader.read()
        if (next.done) throw new Error(`the reply ended before ${text}`)
        seen += decoder.decode(next.value, { stream: true })
      }
    }
    return { lease, readUntil, stop: () => controller.abort(), gone }
  }

  it("counts a reply's model and tokens as soon as the service says it completed, before the stream ends", async () => {
    const { lease, readUntil, stop } = await lingering({ completed: true })
    // A harness ends its turn on the completed event, while the service has not closed the stream yet.
    await readUntil('response.completed')
    const turn = lease.takeTurn()
    expect(turn).toEqual({
      requests: 1,
      models: [{ model: 'fake-model', used: 'fake-model-2', requests: 1, measured: 1, usage: { inputTokens: 7, outputTokens: 3 } }],
    })
    expect(JSON.stringify(turn)).not.toContain('secret')
    stop()
    // Counted once: the next turn starts empty.
    expect(lease.takeTurn()).toEqual({ requests: 0, models: [] })
  })

  it('does not count a reply as unfinished when the harness stops reading once the service said it completed', async () => {
    const { lease, readUntil, stop, gone } = await lingering({ completed: true })
    await readUntil('response.completed')
    stop()
    await gone
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(lease.takeTurn().models).toEqual([
      { model: 'fake-model', used: 'fake-model-2', requests: 1, measured: 1, usage: { inputTokens: 7, outputTokens: 3 } },
    ])
  })

  it('counts a request still under way when its turn is taken as open, not as a reply without tokens', async () => {
    const { lease, readUntil, stop } = await lingering({ completed: false })
    await readUntil('secret text')
    expect(lease.takeTurn().models).toEqual([{ model: 'fake-model', used: 'fake-model-2', requests: 1, open: 1 }])
    stop()
  })
})

describe('sessions of a harness with its own models on a saved service', () => {
  async function host() {
    const fake = await models({ replies: [{ text: 'via the gateway' }] })
    const t = await startTestHost({
      demo: false,
      agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
    })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll({ scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const service = async (kind: string, name: string, baseURL: string) => {
      const created = await desktop.confirmed('providers', {
        method: 'POST',
        body: { name, kind, baseURL, apiKey: KEY, models: ['fake-model'], defaultModel: 'fake-model', confirmOrigin: true },
      })
      expect(created.status).toBe(201)
      return ((await created.json()) as { provider: ProviderSettings }).provider
    }
    const gemini = await service('gemini', 'Gemini', fake.origin)
    const chat = await service('openai-compatible', 'Chat', `${fake.origin}/v1`)
    // The fake agent under Gemini CLI's preset: the profile applies by its ID, and no real program is ever looked up.
    const agent = await desktop.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'gemini',
        name: 'Gemini CLI',
        presetId: 'gemini',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: {
          FAKE_ACP_STATE: join(t.root, 'acp-state.json'),
          FAKE_ACP_LOG: join(t.root, 'acp.log'),
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_MODES: 'plan,default,autoEdit,yolo',
          FAKE_ACP_INITIAL_MODE: 'default',
        },
      },
    })
    expect(agent.status).toBe(201)
    return { t, fake, desktop, phone, gemini, chat }
  }

  const start = async (device: TestDevice, prompt: string, model: { providerId: string; model: string }) => {
    const response = await device.request('tasks', {
      method: 'POST',
      body: { prompt, requestId: randomUUID(), mode: 'agent', harnessId: 'gemini', model },
    })
    return { status: response.status, body: (await response.json()) as { sessionId?: string; error?: string; message?: string } }
  }

  const audit = async (dataDir: string) =>
    (await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; target?: string; detail: Record<string, unknown> })

  it('starts a session on a service the harness speaks, sends its turns through the gateway, and records the route', async () => {
    const { t, fake, phone, gemini } = await host()
    const harness = (await phone.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'gemini')!
    expect(harness.capabilities.models).toMatchObject({ owner: 'harness', wires: ['gemini'] })
    // A connected phone starts it like the Mac does: no confirmation for the route.
    const prompts = t.presence.requests.length
    const started = await start(phone, 'model hello', { providerId: gemini.id, model: 'fake-model' })
    expect(started.status).toBe(201)
    const sessionId = started.body.sessionId!
    await vi.waitFor(async () => expect((await phone.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), {
      timeout: 10_000,
    })
    const detail = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['model: via the gateway'])
    // The service's name is the Host's, from 设置 › 模型.
    expect(detail.summary.modelRoute).toEqual({ providerId: gemini.id, model: 'fake-model', name: 'Gemini' })
    expect(t.presence.requests).toHaveLength(prompts)
    // The service got its own key; the agent never had it.
    expect(fake.requests).toMatchObject([{ wire: 'gemini', model: 'fake-model', key: KEY }])
    const log = await readFile(join(t.root, 'acp.log'), 'utf8')
    expect(log).not.toContain(KEY)
    const recorded = { providerId: gemini.id, model: 'fake-model', wire: 'gemini', origin: fake.origin }
    const records = await audit(t.dataDir)
    for (const action of ['task.l3.start-requested', 'task.l3.started'])
      expect(records.findLast(record => record.action === action)).toMatchObject({
        detail: { providerId: gemini.id, routeHash: sha256Hex(canonicalJson(recorded)) },
      })
    const text = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
    expect(text).not.toContain(KEY)
    expect(text).not.toMatch(/lmg1\./u)

    // A request the gateway refuses still reached Latch: what it carried went nowhere else, so nothing is said.
    await phone.request(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'model as:gemini-2.5-flash', requestId: randomUUID() },
    })
    await vi.waitFor(
      async () => {
        const turn = await phone.json<TaskDetail>(`tasks/${sessionId}`)
        expect(turn.messages.filter(message => message.role === 'assistant')).toHaveLength(2)
        expect(turn.summary.status).toBe('idle')
      },
      { timeout: 10_000 },
    )
    const refused = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(refused.messages.findLast(message => message.role === 'assistant')?.text).toContain('model error 403')
    expect(refused.messages.filter(message => message.role === 'system').map(message => message.text)).toEqual([])
    expect(refused.summary.modelRoute).toEqual({ providerId: gemini.id, model: 'fake-model', name: 'Gemini' })
    expect((await audit(t.dataDir)).filter(record => record.action === 'task.model.bypassed')).toEqual([])

    // Gemini CLI's own helper calls ask for a fixed model by alias; the session's settings point them at its model.
    await phone.request(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'model helper:web-fetch', requestId: randomUUID() },
    })
    await vi.waitFor(
      async () => {
        const turn = await phone.json<TaskDetail>(`tasks/${sessionId}`)
        expect(turn.messages.filter(message => message.role === 'assistant')).toHaveLength(3)
        expect(turn.summary.status).toBe('idle')
      },
      { timeout: 10_000 },
    )
    const helped = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(helped.messages.findLast(message => message.role === 'assistant')?.text).toBe('model: via the gateway')
    expect(fake.requests.at(-1)).toMatchObject({ wire: 'gemini', model: 'fake-model', key: KEY })

    // A turn that answers without the service is said and recorded; the session goes on.
    await phone.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo plain', requestId: randomUUID() } })
    await vi.waitFor(async () => expect((await phone.json<TaskDetail>(`tasks/${sessionId}`)).summary.modelRoute?.bypassed).toBe(true), {
      timeout: 10_000,
    })
    expect((await audit(t.dataDir)).filter(record => record.action === 'task.model.bypassed')).toEqual([
      expect.objectContaining({ target: sessionId, detail: { sessionId } }),
    ])

    // Turned off, the session still names its service and says it is off; deleted, the name goes with it.
    expect((await phone.request(`providers/${gemini.id}`, { method: 'PUT', body: { enabled: false } })).status).toBe(200)
    expect((await phone.json<TaskDetail>(`tasks/${sessionId}`)).summary.modelRoute).toMatchObject({ name: 'Gemini', off: true })
    expect((await phone.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === sessionId)?.modelRoute).toMatchObject({
      name: 'Gemini',
      off: true,
    })
    expect((await phone.request(`providers/${gemini.id}`, { method: 'DELETE' })).status).toBe(200)
    const gone = (await phone.json<TaskDetail>(`tasks/${sessionId}`)).summary.modelRoute
    expect(gone).not.toHaveProperty('name')
    expect(gone).not.toHaveProperty('off')
  })

  it('refuses a pair that needs translation, a model the service does not list, and a service it cannot use, before anything starts', async () => {
    const { t, phone, gemini, chat } = await host()
    const translated = await start(phone, 'model hi', { providerId: chat.id, model: 'fake-model' })
    expect(translated).toMatchObject({
      status: 400,
      body: {
        error: 'model-route-unavailable',
        message: 'Gemini CLI 只说 Gemini 协议，Chat 用 Chat Completions，Latch 转换协议尚未实现。',
      },
    })
    expect(await start(phone, 'model hi', { providerId: gemini.id, model: 'other-model' })).toMatchObject({ status: 400 })
    expect(await start(phone, 'model hi', { providerId: 'missing', model: 'fake-model' })).toMatchObject({ status: 400 })
    expect((await phone.json<AppSnapshot>('snapshot')).tasks).toEqual([])
    expect(await readFile(join(t.root, 'acp.log'), 'utf8').catch(() => '')).toBe('')
  })
})
