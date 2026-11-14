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
import { ModelRequestQueue } from '../src/model-request-queue.ts'
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
  it.each(['process closed', 'service changed'] as const)(
    'rechecks a queued request after its %s without sending a stale credential',
    async change => {
      const fake = await models()
      const service = responses(fake)
      const queue = new ModelRequestQueue({ active: 1, waiting: 4, bytes: 1024, waitMs: 30_000 })
      const release = await queue.acquire(new AbortController().signal, 0)
      const server = new ModelGatewayServer({ service: () => service, fetchFor: () => fetch, log: () => {}, queue })
      await server.start()
      cleanups.push(() => server.close())
      const lease = server.open({ sessionId: 'queued', route: route(fake) })
      const acquire = vi.spyOn(queue, 'acquire')
      const pending = ask(lease.baseURL, lease.token, { model: 'fake-model', input: 'hello' })
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))
      expect(fake.requests).toHaveLength(0)
      if (change === 'process closed') lease.close()
      else service.fingerprint = 'replacement'
      release()
      const result = await pending
      expect(result.status).toBe(401)
      expect(await result.text()).toContain('gateway-token')
      expect(fake.requests).toHaveLength(0)
      const next = await queue.acquire(new AbortController().signal, 0)
      next()
      queue.close()
    },
  )

  it.each(['responses', 'anthropic-messages'] as const)(
    'returns %s queue exhaustion without forwarding and keeps model listing available',
    async wire => {
      const fake = await models()
      const service = responses(fake, { kind: wire === 'responses' ? 'openai-responses' : 'anthropic' })
      const queue = new ModelRequestQueue({ active: 1, waiting: 0, bytes: 0, waitMs: 30_000 })
      const release = await queue.acquire(new AbortController().signal, 0)
      const server = new ModelGatewayServer({ service: () => service, fetchFor: () => fetch, log: () => {}, queue })
      await server.start()
      cleanups.push(() => server.close())
      const lease = server.open({ sessionId: 'queued', route: { ...route(fake), wire } })
      const base = wire === 'responses' ? lease.baseURL : `${lease.baseURL}/v1`
      const headers = { authorization: `Bearer ${lease.token}` }
      const listing = await fetch(`${base}/models`, { headers })
      expect(listing.status).toBe(200)
      await listing.text()
      const result = await fetch(`${base}/${wire === 'responses' ? 'responses' : 'messages'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'fake-model', input: 'hello' }),
      })
      expect(result.status).toBe(429)
      expect(result.headers.get('retry-after')).toBe('1')
      expect(await result.json()).toMatchObject({ error: { code: 'gateway-busy' } })
      expect(fake.requests).toHaveLength(0)
      release()
      queue.close()
    },
  )

  it('uses only the current Host thinking intent, while undeclared and mismatched explicit efforts still fail', async () => {
    const fake = await models()
    const service = responses(fake, {
      kind: 'openai-compatible',
      models: ['fake-model', 'with-thinking'],
      modelCapabilities: { 'with-thinking': { thinking: ['high'] } },
    })
    const { server } = await gateway({ svc: service })
    const lease = server.open({ sessionId: 'thinking', route: { ...route(fake), upstream: 'chat-completions' } })
    const body = { model: 'fake-model', input: 'hello', reasoning: { effort: 'medium', summary: 'auto' } }
    expect((await ask(lease.baseURL, lease.token, body)).status).toBe(400)
    expect(fake.requests).toHaveLength(0)
    lease.setThinking!('fake-model', null)
    const defaulted = await ask(lease.baseURL, lease.token, body)
    expect(defaulted.status).toBe(200)
    await defaulted.text()
    expect(fake.requests[0]?.body).not.toHaveProperty('reasoning_effort')
    expect(() => lease.setThinking!('fake-model', 'high')).toThrow('没有声明')
    expect(() => lease.setThinking!('missing', null)).toThrow()
    lease.setThinking!('with-thinking', 'high')
    expect((await ask(lease.baseURL, lease.token, { ...body, model: 'with-thinking' })).status).toBe(400)
    expect((await ask(lease.baseURL, lease.token, { model: 'with-thinking', input: 'hello' })).status).toBe(400)
    expect((await ask(lease.baseURL, lease.token, body)).status).toBe(400)
    expect(fake.requests).toHaveLength(1)
    const explicit = await ask(lease.baseURL, lease.token, { ...body, model: 'with-thinking', reasoning: { effort: 'high' } })
    expect(explicit.status).toBe(200)
    await explicit.text()
    expect(fake.requests[1]?.body).toHaveProperty('reasoning_effort', 'high')
    service.fingerprint = 'changed'
    expect(() => lease.setThinking!('with-thinking', null)).toThrow('设置已经变了')
  })

  it('removes an inherited effort without changing other Responses fields or exact number tokens', async () => {
    const fake = await models()
    let forwarded = ''
    const { server } = await gateway({ svc: responses(fake) }, () => async (url, init) => {
      forwarded = Buffer.from(init?.body as Uint8Array).toString('utf8')
      return fetch(url, init)
    })
    const lease = server.open({ sessionId: 'default-responses', route: route(fake) })
    lease.setThinking!('fake-model', null)
    const response = await raw(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: '{"model":"fake-model","input":"hello","reasoning":{"effort":"medium","summary":"auto"},"metadata":{"exact":9007199254740993}}',
    })
    expect(response.status).toBe(200)
    expect(forwarded).toContain('9007199254740993')
    expect(JSON.parse(forwarded).reasoning).toEqual({ summary: 'auto' })
    const invalid = await raw(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: '{"model":"fake-model","input":"hello","reasoning":{"effort":"medium"},"metadata":{"invalid":1e400}}',
    })
    expect(invalid.status).toBe(400)
    expect(fake.requests).toHaveLength(1)
  })

  it.each(['responses', 'chat-completions', 'anthropic-messages'] as const)('keeps non-Gemini model IDs exact over %s', async wire => {
    const fake = await models()
    const service = responses(fake, {
      kind: wire === 'responses' ? 'openai-responses' : wire === 'chat-completions' ? 'openai-compatible' : 'anthropic',
    })
    const { server } = await gateway({ svc: service })
    const modelRoute = { providerId: 'svc', model: 'fake-model', wire, origin: fake.origin }
    expect(() => server.open({ sessionId: 'wrong', route: { ...modelRoute, model: 'models/fake-model' } })).toThrow()
    const lease = server.open({ sessionId: 'exact', route: modelRoute })
    const path = wire === 'responses' ? '/responses' : wire === 'chat-completions' ? '/chat/completions' : '/v1/messages'
    const response = await fetch(`${lease.baseURL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}` },
      body: JSON.stringify({ model: 'models/fake-model', input: 'hi', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(403)
    expect(fake.requests).toHaveLength(0)
    service.models = ['models/fake-model']
    service.fingerprint = 'two'
    const prefixed = server.open({ sessionId: 'prefixed', route: { ...modelRoute, model: 'models/fake-model' } })
    expect(prefixed.models).toEqual(['models/fake-model'])
    const accepted = await fetch(`${prefixed.baseURL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${prefixed.token}` },
      body: JSON.stringify({ model: 'models/fake-model', input: 'hi', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(accepted.status).toBe(200)
    await accepted.text()
    expect(fake.requests[0]?.model).toBe('models/fake-model')
  })

  it('carries only declared capabilities under the same normalized model IDs, without sharing service state', async () => {
    const fake = await models()
    const service = responses(fake, {
      kind: 'gemini',
      baseURL: fake.origin,
      models: ['models/fake-model', 'without-capabilities'],
      modelCapabilities: { 'models/fake-model': { vision: true }, unlisted: { vision: false } },
    })
    const { server } = await gateway({ svc: service })
    const lease = server.open({ sessionId: 'task-1', route: route(fake, 'gemini') })
    expect(lease.models).toEqual(['fake-model', 'without-capabilities'])
    expect(lease.modelCapabilities).toEqual({ 'fake-model': { vision: true } })
    lease.modelCapabilities!['fake-model']!.vision = false
    expect(service.modelCapabilities!['models/fake-model']!.vision).toBe(true)
  })

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

  it('opens to each protocol only its own paths, and lists the models in its own shape', async () => {
    const fake = await models()
    const { server } = await gateway({
      responses: responses(fake),
      chat: responses(fake, { kind: 'openai-compatible' }),
      anthropic: responses(fake, { kind: 'anthropic', baseURL: fake.origin }),
    })
    const open = (providerId: string, wire: 'responses' | 'chat-completions' | 'anthropic-messages') =>
      server.open({ sessionId: 'task-1', route: { ...route(fake), providerId, wire } })
    const leases = {
      responses: open('responses', 'responses'),
      chat: open('chat', 'chat-completions'),
      anthropic: open('anthropic', 'anthropic-messages'),
    }
    expect(leases.chat.baseURL).toMatch(/\/v1$/u)
    expect(leases.anthropic.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    const port = new URL(leases.chat.baseURL).port
    const post = (token: string, path: string) =>
      raw(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', input: 'hi', messages: [{ role: 'user', content: 'hi' }] }),
      })
    const paths = [
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/v1beta/models/fake-model:generateContent',
    ]
    const statuses = async (token: string) => Promise.all(paths.map(async path => (await post(token, path)).status))
    expect(await statuses(leases.responses.token)).toEqual([200, 404, 404, 404, 404])
    expect(await statuses(leases.chat.token)).toEqual([404, 200, 404, 404, 404])
    // A token count passes to an Anthropic service only, uncounted as a reply.
    expect(await statuses(leases.anthropic.token)).toEqual([404, 404, 200, 200, 404])
    expect(fake.requests.map(request => request.path)).toEqual([
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/messages/count_tokens',
    ])
    expect(leases.anthropic.takeTurn()).toMatchObject({ requests: 5, models: [{ model: 'fake-model', requests: 1 }] })

    const list = async (lease: { baseURL: string; token: string }, headers: Record<string, string>) =>
      (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers })).json()
    expect(await list(leases.chat, { authorization: `Bearer ${leases.chat.token}` })).toEqual({
      object: 'list',
      data: [{ id: 'fake-model', object: 'model', owned_by: 'latch' }],
    })
    expect(await list(leases.anthropic, { 'x-api-key': leases.anthropic.token })).toEqual({
      data: [{ type: 'model', id: 'fake-model', display_name: 'fake-model' }],
      has_more: false,
      first_id: 'fake-model',
      last_id: 'fake-model',
    })
    // An Anthropic client reads Anthropic's error shape.
    const wrong = await post(leases.anthropic.token, '/v1/chat/completions')
    expect(JSON.parse(wrong.text)).toEqual({ type: 'error', error: { type: 'not_found_error', message: 'Latch 只转发模型请求' } })
  })

  it("forwards only each protocol's own headers, Anthropic's when passed through, and the service's request IDs", async () => {
    const fake = await models()
    const { server } = await gateway({
      chat: responses(fake, { kind: 'openai-compatible' }),
      anthropic: responses(fake, { kind: 'anthropic', baseURL: fake.origin }),
    })
    const chat = server.open({ sessionId: 'task-1', route: { ...route(fake), providerId: 'chat', wire: 'chat-completions' } })
    const anthropic = server.open({ sessionId: 'task-1', route: { ...route(fake), providerId: 'anthropic', wire: 'anthropic-messages' } })
    const extra = {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024',
      'openai-beta': 'x',
      'x-stainless-os': 'MacOS',
      cookie: 'a=1',
    }
    const first = await fetch(`${chat.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${chat.token}`, 'content-type': 'application/json', accept: 'text/event-stream', ...extra },
      body: JSON.stringify({ model: 'fake-model', messages: [], stream: true }),
    })
    expect(first.headers.get('x-request-id')).toBe('req_fake')
    await first.text()
    await (
      await fetch(`${anthropic.baseURL}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': anthropic.token, 'content-type': 'application/json', ...extra },
        body: JSON.stringify({ model: 'fake-model', messages: [], max_tokens: 10 }),
      })
    ).text()
    const [toChat, toAnthropic] = fake.requests
    expect(
      toChat!.headerNames.filter(
        name =>
          !['connection', 'content-length', 'host', 'user-agent', 'accept-encoding', 'accept-language', 'sec-fetch-mode'].includes(name),
      ),
    ).toEqual(['accept', 'authorization', 'content-type', 'openai-beta'])
    expect(toChat!.key).toBe(KEY)
    expect(toAnthropic!.headerNames).toEqual(expect.arrayContaining(['anthropic-beta', 'anthropic-version', 'x-api-key']))
    expect(toAnthropic!.headerNames).not.toEqual(expect.arrayContaining(['openai-beta']))
    for (const request of fake.requests) {
      expect(request.headerNames).not.toContain('cookie')
      expect(request.headerNames).not.toContain('x-stainless-os')
    }
    expect(toAnthropic!.key).toBe(KEY)
  })

  it('refuses a request a page sends, a token not its own unread and unlogged, and a body over 32 MiB', async () => {
    const fake = await models()
    const { server, logs } = await gateway({ svc: responses(fake) })
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    const body = JSON.stringify({ model: 'fake-model', input: 'hi' })
    const auth = { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' }
    const page: Array<Record<string, string>> = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-user': '?1' },
      { 'sec-fetch-mode': 'navigate' },
      { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' },
      { origin: 'null' },
    ]
    for (const headers of page)
      expect((await raw(`${lease.baseURL}/responses`, { method: 'POST', headers: { ...auth, ...headers }, body })).status).toBe(403)
    expect(fake.requests).toEqual([])
    // Node's own fetch says `Sec-Fetch-Mode: cors` and nothing more: a program, not a page.
    expect((await raw(`${lease.baseURL}/responses`, { method: 'POST', headers: { ...auth, 'sec-fetch-mode': 'cors' }, body })).status).toBe(
      200,
    )
    fake.requests.length = 0
    // Another program's login, as Claude Code would send its subscription token: refused, never sent on or logged.
    const foreign = 'sk-ant-oat01-another-programs-login-0123456789'
    const foreignHeaders: Array<Record<string, string>> = [
      { authorization: `Bearer ${foreign}` },
      { 'x-api-key': foreign },
      { 'x-goog-api-key': foreign },
    ]
    for (const headers of foreignHeaders) {
      const refused = await raw(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      })
      expect(refused.status).toBe(401)
      expect(refused.text).not.toContain(foreign)
    }
    const large = await fetch(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-model', input: 'x'.repeat(32 * 1024 * 1024) }),
    }).catch(() => undefined)
    if (large) expect(large.status).toBe(413)
    expect(fake.requests).toEqual([])
    expect(logs.join('\n')).not.toContain(foreign)
    expect(logs.join('\n')).not.toContain(lease.token)
  })

  it('reads Chat Completions and Anthropic usage, asking a streamed Chat reply for it', async () => {
    const fake = await models({
      replies: [{ text: 'chat says' }, { text: 'plain' }, { text: 'anthropic says', reasoning: 'hmm' }, { text: 'doc' }],
    })
    const { server } = await gateway({
      chat: responses(fake, { kind: 'openai-compatible' }),
      anthropic: responses(fake, { kind: 'anthropic', baseURL: fake.origin }),
    })
    const chat = server.open({ sessionId: 'task-1', route: { ...route(fake), providerId: 'chat', wire: 'chat-completions' } })
    const anthropic = server.open({ sessionId: 'task-1', route: { ...route(fake), providerId: 'anthropic', wire: 'anthropic-messages' } })
    const send = async (url: string, headers: Record<string, string>, body: unknown) =>
      (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).text()
    const bearer = { authorization: `Bearer ${chat.token}` }
    expect(await send(`${chat.baseURL}/chat/completions`, bearer, { model: 'fake-model', messages: [], stream: true })).toContain('says')
    expect(await send(`${chat.baseURL}/chat/completions`, bearer, { model: 'fake-model', messages: [] })).toContain('plain')
    expect(fake.requests[0]!.body).toMatchObject({ stream_options: { include_usage: true } })
    expect(fake.requests[1]!.body).not.toHaveProperty('stream_options')
    expect(chat.takeTurn()).toEqual({
      requests: 2,
      models: [{ model: 'fake-model', used: 'fake-model', requests: 2, measured: 2, usage: { inputTokens: 20, outputTokens: 10 } }],
    })
    const key = { 'x-api-key': anthropic.token }
    expect(await send(`${anthropic.baseURL}/v1/messages`, key, { model: 'fake-model', messages: [], stream: true })).toContain('says')
    expect(await send(`${anthropic.baseURL}/v1/messages`, key, { model: 'fake-model', messages: [] })).toContain('doc')
    expect(anthropic.takeTurn()).toEqual({
      requests: 2,
      models: [{ model: 'fake-model', used: 'fake-model', requests: 2, measured: 2, usage: { inputTokens: 20, outputTokens: 10 } }],
    })
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
      response.writeHead(401, { 'content-type': 'application/json', 'request-id': KEY })
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
    expect(failed.headers.get('request-id')).toBe('[redacted]')
    const text = await failed.text()
    expect(text).not.toContain(KEY)
    expect(JSON.parse(text)).toEqual({ error: { message: 'Incorrect API key provided: [redacted]', type: 'invalid_request_error' } })

    const moved = server.open({ sessionId: 'task-1', route: { ...route(fake), providerId: 'moved' } })
    const redirected = await ask(moved.baseURL, moved.token, { model: 'fake-model', input: 'hi' })
    expect(redirected.status).toBe(502)
    expect(await redirected.text()).not.toContain(KEY)
  })

  it.each(['process closed', 'service changed'] as const)('refuses a body completed after its %s', async change => {
    const fake = await models()
    const services: Record<string, GatewayService> = { svc: responses(fake) }
    const { server } = await gateway(services)
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    let sent!: ReturnType<typeof httpRequest>
    const answer = new Promise<number>((resolve, reject) => {
      sent = httpRequest(
        `${lease.baseURL}/responses`,
        { method: 'POST', headers: { authorization: `Bearer ${lease.token}` } },
        response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode!))
        },
      )
      sent.on('error', reject)
      sent.write('{"model":"fake-model",')
    })
    await vi.waitFor(() => expect(lease.requests()).toBe(1))
    if (change === 'process closed') lease.close()
    else services.svc = { ...services.svc!, fingerprint: 'new settings' }
    sent.end('"input":"never forward"}')
    expect(await answer).toBe(401)
    expect(fake.requests).toEqual([])
  })

  it.each(['application/json', 'text/event-stream'])(
    'redacts echoed credentials in a successful %s response across byte boundaries',
    async contentType => {
      const fake = { origin: 'http://127.0.0.1:9999' } as FakeModels
      const key = 'opaque-credential-A9_+/quoted"tail'
      const forms = [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]
      const payload = JSON.stringify({ type: 'error', error: { message: `失败：${key} ${encodeURIComponent(key)}` } })
      const text = contentType === 'text/event-stream' ? `event: error\ndata: ${payload}\n\n` : payload
      const bytes = new TextEncoder().encode(text)
      const { server } = await gateway(
        { svc: responses(fake, { apiKey: key }) },
        () => async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
                controller.close()
              },
            }),
            { headers: { 'content-type': contentType } },
          ),
      )
      const lease = server.open({ sessionId: 'task-1', route: route(fake) })
      const response = await ask(lease.baseURL, lease.token, { model: 'fake-model', input: 'hi', stream: true })
      expect(response.status).toBe(200)
      const received = await response.text()
      for (const form of forms) expect(received).not.toContain(form)
      expect(received).toContain('失败：')
      expect(received).toContain('[redacted]')
      expect(JSON.parse(contentType === 'text/event-stream' ? received.split('data: ')[1]!.trim() : received)).toMatchObject({
        type: 'error',
      })
    },
  )

  it.each([
    { name: 'ordinary Unicode', text: 'data: {"text":"🌱 你好 / quoted\\\""}\n\n', expected: 'data: {"text":"🌱 你好 / quoted\\\""}\n\n' },
    { name: 'a truncated key at EOF', text: 'data: {"error":"opaque-cred', expected: 'data: {"error":"[redacted]' },
  ])('preserves $name without buffering the whole reply', async ({ text, expected }) => {
    const fake = { origin: 'http://127.0.0.1:9999' } as FakeModels
    const bytes = new TextEncoder().encode(text)
    const { server } = await gateway(
      { svc: responses(fake, { apiKey: 'opaque-credential-for-stream' }) },
      () => async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const lease = server.open({ sessionId: 'task-1', route: route(fake) })
    const response = await ask(lease.baseURL, lease.token, { model: 'fake-model', input: 'hi', stream: true })
    expect(await response.text()).toBe(expected)
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
