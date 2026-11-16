import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentRecord,
  AppSnapshot,
  Automation,
  AutomationDetail,
  CustomAgent,
  CustomAgentList,
  ModelSpend,
  ModelUsageSummary,
  ProviderSettings,
  TaskDetail,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import { startFakeModels, type FakeModels, type FakeReply, type TestDevice } from '@latch/testkit'
import { HarnessHub } from '../src/hub.ts'
import { ModelSpendStore } from '../src/model-budgets.ts'
import { UsageLedger } from '../src/model-usage.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const budgetWrites = vi.hoisted(() => ({
  before: undefined as ((path: string) => Promise<void>) | undefined,
  after: undefined as ((path: string) => void) | undefined,
}))
vi.mock('@latch/core/node-kit', async original => {
  const actual = await original<typeof import('@latch/core/node-kit')>()
  return {
    ...actual,
    async writeFileAtomic(path: string, data: string, options?: Parameters<typeof actual.writeFileAtomic>[2]) {
      if (budgetWrites.before) await budgetWrites.before(path)
      await actual.writeFileAtomic(path, data, options)
      budgetWrites.after?.(path)
    },
  }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const KEY = 'sk-usage-host-0123456789abcdefghijklmno'
const PROMPT = 'PROMPT-TEXT-3c1e say something'
const REPLY = 'REPLY-TEXT-8d2f said'

async function models(replies: FakeReply[]): Promise<FakeModels> {
  const fake = await startFakeModels({ replies })
  cleanups.push(() => fake.close())
  return fake
}

async function host(options: TestHostOptions = {}) {
  const t = await startTestHost({
    demo: false,
    agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
    ...options,
  })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const admin = await t.enroll({ scopes: ['view', 'run', 'approve:standard', 'admin'] })
  // A phone as it is paired by default here: it may read and run, not administer.
  const phone = await t.enroll({ name: 'Phone', scopes: ['view', 'run'] })
  const service = async (name: string, baseURL: string) => {
    const created = await desktop.confirmed('providers', {
      method: 'POST',
      body: {
        name,
        kind: 'openai-compatible',
        baseURL,
        apiKey: KEY,
        models: ['fake-model'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
      },
    })
    expect(created.status).toBe(201)
    return ((await created.json()) as { provider: ProviderSettings }).provider
  }
  return { t, desktop, admin, phone, service }
}

const settled = (device: TestDevice, sessionId: string, status = 'idle') =>
  vi.waitFor(async () => expect((await device.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe(status), { timeout: 15_000 })

async function start(device: TestDevice, providerId: string, prompt = PROMPT): Promise<string> {
  const started = await device.request('tasks', {
    method: 'POST',
    body: { prompt, requestId: randomUUID(), mode: 'chat', harnessId: 'standard', model: { providerId, model: 'fake-model' } },
  })
  expect(started.status).toBe(201)
  return ((await started.json()) as { sessionId: string }).sessionId
}

const ledgerText = async (t: TestHost): Promise<string> => {
  const dir = join(t.dataDir, 'gateway')
  const names = (await readdir(dir)).filter(name => name.startsWith('usage-'))
  return (await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))).join('')
}

const spendBody = async (device: TestDevice, body: unknown) => ({
  ...(body as Record<string, unknown>),
  requestId: randomUUID(),
  baseRevision: (await device.json<ModelSpend>('model-spend')).revision,
})
const put = async (device: TestDevice, path: string, body: unknown) => {
  if (path === 'model-prices' || path === 'model-budgets') body = await spendBody(device, body)
  const response = await device.request(path, { method: 'PUT', body })
  return { status: response.status, body: (await response.json()) as { error?: string } }
}

const usage = (device: TestDevice, group: string, period = 'month') =>
  device.json<ModelUsageSummary>('model-usage', { method: 'POST', body: { period, group } })

describe('usage, prices and budgets in the Host', () => {
  it('writes a built-in turn into the ledger, sums it four ways for any device, and keeps it out of audit', async () => {
    const fake = await models([{ text: REPLY, usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.0021 } }])
    const { t, phone, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const sessionId = await start(admin, first.id)
    await settled(admin, sessionId)
    await vi.waitFor(async () => expect((await ledgerText(t)).trim().split('\n')).toHaveLength(1))
    const text = await ledgerText(t)
    for (const kept of [PROMPT, 'PROMPT-TEXT', REPLY, 'REPLY-TEXT', KEY, 'sk-usage', 'authorization']) expect(text).not.toContain(kept)
    expect(JSON.parse(text)).toMatchObject({
      sessionId,
      harness: 'standard',
      providerId: first.id,
      model: 'fake-model',
      outcome: 'ok',
      attempts: 1,
      fallback: false,
      inputTokens: 120,
      outputTokens: 30,
      cost: { micros: 2100, currency: 'USD', source: 'reported' },
    })
    const [file] = (await readdir(join(t.dataDir, 'gateway'))).filter(name => name.startsWith('usage-'))
    expect((await stat(join(t.dataDir, 'gateway', file!))).mode & 0o777).toBe(0o600)
    // The turn itself says what it cost, as the service reported it.
    const detail = await admin.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.find(message => message.role === 'user')?.turn?.spend).toEqual({ cost: [{ currency: 'USD', micros: 2100 }] })
    // A phone that may only read sees the same sums.
    const expected = { requests: 1, failed: 0, fallbacks: 0, measured: 1, usage: { inputTokens: 120, outputTokens: 30 }, uncosted: 0 }
    expect((await usage(phone, 'session')).rows).toMatchObject([{ sessionId, ...expected, cost: [{ currency: 'USD', micros: 2100 }] }])
    expect((await usage(phone, 'service', '7')).rows).toMatchObject([{ providerId: first.id, ...expected }])
    expect((await usage(phone, 'model', '30')).rows).toMatchObject([{ providerId: first.id, model: 'fake-model', ...expected }])
    expect((await usage(phone, 'agent', '90')).rows).toMatchObject([expected])
    const summary = await usage(phone, 'service')
    expect(summary).toMatchObject({ skipped: 0, truncated: false, timeZone: expect.any(String) })
    expect(JSON.stringify(summary)).not.toContain(KEY)
    expect((await phone.request('model-usage', { method: 'POST', body: { period: 'year', group: 'service' } })).status).toBe(400)
    // Usage is not audit: no audit record carries a token count or a cost.
    const audit = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
    expect(audit).not.toMatch(/inputTokens|outputTokens|micros/u)
    expect((await phone.json<AppSnapshot>('snapshot')).catalog?.features?.modelUsage).toBe(true)
  })

  it('lets only a device with admin change a price or a budget, with no confirmation on the Mac, and anyone read them', async () => {
    const fake = await models([{ text: 'one' }])
    const { t, phone, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const prices = { currency: 'CNY', input: 2, output: 8, cacheRead: 0.2 }
    const prompts = t.presence.requests.length
    // The phone has no admin: 403, and nothing is saved.
    expect(await put(phone, 'model-prices', { providerId: first.id, model: 'fake-model', prices })).toMatchObject({ status: 403 })
    expect(await put(phone, 'model-budgets', { scope: 'service', id: first.id, budget: { unit: 'tokens', limit: 1000 } })).toMatchObject({
      status: 403,
    })
    expect(await put(phone, 'model-budgets', { scope: 'service', id: first.id, budget: null })).toMatchObject({ status: 403 })
    expect(await phone.json<ModelSpend>('model-spend')).toMatchObject({ prices: [], budgets: [] })
    expect((await put(admin, 'model-prices', { providerId: first.id, model: 'fake-model', prices })).status).toBe(200)
    expect((await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: { unit: 'tokens', limit: 1000 } })).status).toBe(
      200,
    )
    expect(t.presence.requests).toHaveLength(prompts)
    const spend = await phone.json<ModelSpend>('model-spend')
    expect(spend.prices).toEqual([{ providerId: first.id, model: 'fake-model', ...prices }])
    expect(spend.budgets).toEqual([{ scope: 'service', id: first.id, unit: 'tokens', limit: 1000, used: 0 }])
    expect(spend.month).toMatch(/^\d{4}-\d{2}$/u)
    expect(spend.timeZone).toBeTruthy()
    expect((await stat(join(t.dataDir, 'gateway', 'budgets.json'))).mode & 0o777).toBe(0o600)
    // What names nothing saved, or is not a price or a budget, is refused.
    for (const body of [
      { providerId: first.id, model: 'not-listed', prices },
      { providerId: 'missing', model: 'fake-model', prices },
    ])
      expect((await put(admin, 'model-prices', body)).status).toBe(404)
    expect((await put(admin, 'model-prices', { providerId: first.id, model: 'fake-model', prices: { ...prices, input: -1 } })).status).toBe(
      400,
    )
    expect(
      (await put(admin, 'model-prices', { providerId: first.id, model: 'fake-model', prices: { ...prices, apiKey: 'x' } })).status,
    ).toBe(400)
    expect((await put(admin, 'model-budgets', { scope: 'service', id: 'missing', budget: { unit: 'tokens', limit: 5 } })).status).toBe(404)
    expect((await put(admin, 'model-budgets', { scope: 'agent', id: 'missing', budget: { unit: 'tokens', limit: 5 } })).status).toBe(403)
    expect((await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: { unit: 'cost', limit: 5 } })).status).toBe(400)
    // Removing is the same request with null, and works twice.
    expect((await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: null })).status).toBe(200)
    expect((await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: null })).status).toBe(200)
    expect((await put(admin, 'model-prices', { providerId: first.id, model: 'fake-model', prices: null })).status).toBe(200)
    expect(await phone.json<ModelSpend>('model-spend')).toMatchObject({ prices: [], budgets: [] })
  })

  it('warns the turn at 80%, then fails the next turn with the budget’s own words: no request, no demo model', async () => {
    const fake = await models([{ text: 'one' }, { text: 'two' }, { text: 'must not be asked' }])
    const { admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    // Each fake reply reports 10 input and 5 output tokens: 15 of 18 is past 80%, 30 is past all of it.
    await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: { unit: 'tokens', limit: 18 } })
    const sessionId = await start(admin, first.id)
    await settled(admin, sessionId)
    const turns = async () =>
      (await admin.json<TaskDetail>(`tasks/${sessionId}`)).messages
        .filter(message => message.role === 'user')
        .map(message => message.turn?.spend)
    expect(await turns()).toEqual([{ budget: 'near' }])
    expect((await admin.json<ModelSpend>('model-spend')).budgets).toMatchObject([{ used: 15, state: 'near' }])
    await admin.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    await settled(admin, sessionId)
    expect((await turns())[1]).toEqual({ budget: 'over' })
    await admin.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'once more', requestId: randomUUID() } })
    await settled(admin, sessionId, 'failed')
    const detail = await admin.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.findLast(message => message.role === 'system')?.text).toContain('本月预算已用完')
    expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['one', 'two'])
    expect(fake.requests).toHaveLength(2)
    expect((await usage(admin, 'service')).rows).toMatchObject([{ requests: 3, failed: 1, measured: 2 }])
  })

  const audit = async (t: TestHost) =>
    (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; target?: string; actor: { deviceId?: string }; detail: Record<string, unknown> })
      .filter(record => record.action.startsWith('model.'))

  it('puts every price and budget change on the audit trail first: who, whose, which fields, the old and new limit', async () => {
    const fake = await models([{ text: 'one' }])
    const { t, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const price = (prices: unknown) => put(admin, 'model-prices', { providerId: first.id, model: 'fake-model', prices })
    const budget = (value: unknown) => put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: value })
    await price({ currency: 'CNY', input: 2, output: 8 })
    // The same again changes nothing and leaves no record.
    await price({ currency: 'CNY', input: 2, output: 8 })
    await price({ currency: 'CNY', input: 2, output: 9, cacheRead: 0.2 })
    await price(null)
    await budget({ unit: 'tokens', limit: 1000 })
    await budget({ unit: 'tokens', limit: 1000 })
    await budget({ unit: 'tokens', limit: 500 })
    await budget({ unit: 'tokens', limit: 2000 })
    await price({ currency: 'USD', input: 1, output: 2 })
    expect((await budget({ unit: 'cost', currency: 'USD', limit: 5 })).status).toBe(200)
    await budget(null)
    const records = await audit(t)
    const modelHash = sha256Hex('fake-model')
    expect(records.map(record => [record.action, record.detail])).toEqual([
      ['model.prices.changed', { providerId: first.id, modelHash, fields: ['currency', 'input', 'output'], removed: false }],
      ['model.prices.changed', { providerId: first.id, modelHash, fields: ['output', 'cacheRead'], removed: false }],
      ['model.prices.changed', { providerId: first.id, modelHash, fields: ['currency', 'input', 'output', 'cacheRead'], removed: true }],
      ['model.budget.changed', { scope: 'service', id: first.id, fields: ['unit', 'limit'], removed: false, widening: false }],
      ['model.budget.changed', { scope: 'service', id: first.id, fields: ['limit'], removed: false, widening: false }],
      ['model.budget.changed', { scope: 'service', id: first.id, fields: ['limit'], removed: false, widening: true }],
      ['model.prices.changed', { providerId: first.id, modelHash, fields: ['currency', 'input', 'output'], removed: false }],
      ['model.budget.changed', { scope: 'service', id: first.id, fields: ['unit', 'currency', 'limit'], removed: false, widening: true }],
      ['model.budget.changed', { scope: 'service', id: first.id, fields: ['unit', 'currency', 'limit'], removed: true, widening: true }],
    ])
    for (const record of records) {
      expect(record.actor.deviceId).toBe(admin.id)
      expect(record.target).toBe(first.id)
    }
    // A model's name is not an ID: only its hash is on record. Detail holds IDs, hashes, enums and booleans: no amount.
    expect(JSON.stringify(records)).not.toContain('fake-model')
    for (const record of records) for (const value of Object.values(record.detail)) expect(typeof value).not.toBe('number')
  })

  it('does not let more be spent when the record cannot be written, and still lets less be spent', async () => {
    const fake = await models([{ text: 'one' }])
    const { t, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const budget = async (value: unknown) =>
      admin.request('model-budgets', { method: 'PUT', body: await spendBody(admin, { scope: 'service', id: first.id, budget: value }) })
    const saved = async () => (await admin.json<ModelSpend>('model-spend')).budgets[0]?.limit
    expect((await budget({ unit: 'tokens', limit: 1000 })).status).toBe(200)
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const spy = vi
      .spyOn(t.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action.startsWith('model.') ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    cleanups.push(async () => spy.mockRestore())
    // Raising the limit, removing the budget and any price change wait for their record: none is made.
    expect((await budget({ unit: 'tokens', limit: 5000 })).status).toBe(503)
    expect((await budget(null)).status).toBe(503)
    expect(await saved()).toBe(1000)
    const priced = await admin.request('model-prices', {
      method: 'PUT',
      body: await spendBody(admin, { providerId: first.id, model: 'fake-model', prices: { currency: 'USD', input: 1, output: 2 } }),
    })
    expect(priced.status).toBe(503)
    expect((await admin.json<ModelSpend>('model-spend')).prices).toEqual([])
    // Lowering it is made anyway, and the answer says the record failed.
    const lowered = await budget({ unit: 'tokens', limit: 100 })
    expect(lowered.status).toBe(200)
    expect(lowered.headers.get('x-latch-audit')).toBe('failed')
    expect(await saved()).toBe(100)
  })

  it('removes a service’s prices and budget with the service, and an Agent’s budget with the Agent', async () => {
    const fake = await models([{ text: 'one' }])
    const { t, desktop, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const second = await service('Second', `${fake.origin}/v1`)
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '资料整理',
        description: '查资料',
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: second.id, model: 'fake-model' },
        instructions: 'x',
        skills: [],
      },
    })
    for (const id of [first.id, second.id]) {
      await put(admin, 'model-prices', { providerId: id, model: 'fake-model', prices: { currency: 'USD', input: 1, output: 2 } })
      await put(admin, 'model-budgets', { scope: 'service', id, budget: { unit: 'tokens', limit: 1000 } })
    }
    expect((await put(desktop, 'model-budgets', { scope: 'agent', id: agent.id, budget: { unit: 'tokens', limit: 50 } })).status).toBe(200)
    const kept = async () => {
      const spend = await desktop.json<ModelSpend>('model-spend')
      return { prices: spend.prices.map(item => item.providerId), budgets: spend.budgets.map(item => `${item.scope}:${item.id}`) }
    }
    expect((await kept()).budgets).toHaveLength(3)
    expect((await admin.request(`providers/${first.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await kept()).toEqual({ prices: [second.id], budgets: [`service:${second.id}`, `agent:${agent.id}`] })
    await desktop.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
    await vi.waitFor(async () => expect(await kept()).toEqual({ prices: [second.id], budgets: [`service:${second.id}`] }))
    const stored = JSON.parse(await readFile(join(t.dataDir, 'gateway', 'budgets.json'), 'utf8')) as {
      prices: unknown[]
      budgets: unknown[]
    }
    expect(stored.prices).toHaveLength(1)
    expect(stored.budgets).toHaveLength(1)
  })

  it('refuses a cost budget that could not count what is spent: every model it covers needs prices in its currency', async () => {
    const fake = await models([{ text: 'one' }, { text: 'two' }])
    const { desktop, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const added = await admin.request(`providers/${first.id}`, { method: 'PUT', body: { models: ['fake-model', 'other-model'] } })
    expect(added.status).toBe(200)
    const cost = (currency: string) =>
      put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: { unit: 'cost', currency, limit: 5 } })
    const price = (model: string, currency: string) =>
      put(admin, 'model-prices', { providerId: first.id, model, prices: { currency, input: 1000, output: 1000 } })
    expect(await cost('CNY')).toMatchObject({ status: 400, body: { error: 'budget-cost-unknown' } })
    await price('fake-model', 'CNY')
    // One model of two is priced: still refused, and the answer names the other.
    const partial = await admin.request('model-budgets', {
      method: 'PUT',
      body: await spendBody(admin, { scope: 'service', id: first.id, budget: { unit: 'cost', currency: 'CNY', limit: 5 } }),
    })
    expect(partial.status).toBe(400)
    expect(((await partial.json()) as { message: string }).message).toContain('other-model')
    await price('other-model', 'USD')
    // Priced, in another currency: it would count for nothing in this budget.
    expect((await cost('CNY')).status).toBe(400)
    await price('other-model', 'CNY')
    expect((await cost('CNY')).status).toBe(200)
    expect((await cost('USD')).status).toBe(400)
    // A token budget asks for no prices.
    expect((await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: { unit: 'tokens', limit: 9 } })).status).toBe(200)
    // An Agent: the model it is set to use must be priced; 通用 has none of its own.
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '资料整理',
        description: '查资料',
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: first.id, model: 'fake-model' },
        instructions: 'x',
        skills: [],
      },
    })
    const agentCost = (id: string, currency: string) =>
      put(desktop, 'model-budgets', { scope: 'agent', id, budget: { unit: 'cost', currency, limit: 5 } })
    expect((await agentCost(agent.id, 'CNY')).status).toBe(200)
    expect(await agentCost(agent.id, 'USD')).toMatchObject({ status: 400, body: { error: 'budget-cost-unknown' } })
    expect(await agentCost('general', 'CNY')).toMatchObject({ status: 400, body: { error: 'budget-cost-unknown' } })
    expect((await put(desktop, 'model-budgets', { scope: 'agent', id: 'general', budget: { unit: 'tokens', limit: 9 } })).status).toBe(200)
  })

  it('names a session only to a device that may read it now: an Agent’s, or one deleted since, is counted without a name', async () => {
    const fake = await models([{ text: 'one' }, { text: 'two' }, { text: 'three' }])
    const { desktop, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const makeAgent = (name: string) =>
      desktop.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name,
          description: '查资料',
          harnessId: 'standard',
          mode: 'chat',
          model: { providerId: first.id, model: 'fake-model' },
          instructions: 'x',
          skills: [],
        },
      })
    const chat = async (agentId: string, prompt: string) => {
      const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { customAgentId: agentId, prompt, requestId: randomUUID() },
      })
      await settled(desktop, sessionId)
      return sessionId
    }
    const agent = await makeAgent('资料整理')
    // Each Agent has one chat, which cannot be deleted while the Agent exists: the deleted one is a removed Agent's.
    const left = await makeAgent('已删除')
    const plain = await start(admin, first.id)
    await settled(admin, plain)
    const topic = await chat(agent.id, 'private topic')
    const gone = await chat(left.id, 'another private topic')
    await put(desktop, 'model-budgets', { scope: 'agent', id: agent.id, budget: { unit: 'tokens', limit: 1000 } })
    await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: { unit: 'tokens', limit: 1000 } })
    await desktop.json(`custom-agents/${left.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
    // The private topic is deleted: no live session says it was private any more.
    expect((await desktop.request(`tasks/${gone}`, { method: 'DELETE' })).status).toBeLessThan(300)
    await desktop.json(`devices/${admin.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    const limited = admin
    for (const group of ['session', 'agent', 'service', 'model']) {
      const text = JSON.stringify(await usage(limited, group))
      for (const hidden of [topic, gone, agent.id, left.id]) expect(text, group).not.toContain(hidden)
    }
    // Its own session by name; the two private ones, the deleted one among them, in one row without a name.
    const sessions = (await usage(limited, 'session')).rows
    expect(sessions.find(row => row.sessionId === plain)).toMatchObject({ requests: 1 })
    expect(sessions.filter(row => row.sessionId === undefined)).toMatchObject([{ requests: 2 }])
    expect(sessions).toHaveLength(2)
    expect((await usage(limited, 'agent')).rows).toMatchObject([{ requests: 3 }])
    expect((await usage(limited, 'agent')).rows[0]).not.toHaveProperty('agentId')
    // The sums by service are whole: the requests happened, whoever may read them.
    expect((await usage(limited, 'service')).rows).toMatchObject([{ providerId: first.id, requests: 3 }])
    // No Agent's budget either.
    expect((await limited.json<ModelSpend>('model-spend')).budgets.map(item => item.scope)).toEqual(['service'])
    // The Mac itself still reads each by name, the deleted topic under its Agent.
    const all = (await usage(desktop, 'session')).rows
    expect(all.find(row => row.sessionId === topic)).toMatchObject({ requests: 1 })
    expect(all.find(row => row.sessionId === gone)).toBeUndefined()
    const agents = (await usage(desktop, 'agent')).rows
    expect(agents.find(row => row.agentId === agent.id)).toMatchObject({ requests: 1 })
    expect(agents.find(row => row.agentId === left.id)).toMatchObject({ requests: 1 })
  })

  it.each(['narrow', 'delete'] as const)(
    'anonymizes a private non-Agent session if access changes while reading the ledger: %s',
    async change => {
      const fake = await models([{ text: 'one' }])
      const { t, desktop, admin, service } = await host()
      const first = await service('First', `${fake.origin}/v1`)
      await desktop.confirmedJson(`devices/${admin.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
      const { general } = await desktop.json<CustomAgentList>('custom-agents')
      await desktop.json('custom-agents/general', {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: general.revision, instructions: 'Private general instructions' },
      })
      const sessionId = await start(admin, first.id)
      await settled(admin, sessionId)
      const { summary } = await admin.json<TaskDetail>(`tasks/${sessionId}`)
      expect(summary.agentPrivate).toBe(true)
      expect(summary.agent).toBeUndefined()
      await vi.waitFor(async () => expect(JSON.parse((await ledgerText(t)).trim())).toMatchObject({ sessionId }))
      expect(JSON.parse((await ledgerText(t)).trim())).not.toHaveProperty('agentId')
      expect((await usage(admin, 'session')).rows).toMatchObject([{ sessionId, requests: 1 }])

      const entered = deferred()
      const resume = deferred()
      const listTasks = HarnessHub.prototype.listTasks
      const read = UsageLedger.prototype.read
      let paused = false
      const list = vi.spyOn(HarnessHub.prototype, 'listTasks').mockImplementation(function (this: HarnessHub) {
        // Make the pre-change listing resolve immediately if the route asks for it while the ledger is still paused.
        return paused ? Promise.resolve([summary]) : listTasks.call(this)
      })
      const ledger = vi.spyOn(UsageLedger.prototype, 'read').mockImplementation(async function (this: UsageLedger, from, to) {
        paused = true
        entered.resolve()
        await resume.promise
        paused = false
        return read.call(this, from, to)
      })
      const pending = usage(admin, 'session')
      try {
        await entered.promise
        if (change === 'narrow') {
          await desktop.json(`devices/${admin.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
          expect((await admin.request(`tasks/${sessionId}`)).status).toBe(403)
        } else {
          expect((await desktop.request(`tasks/${sessionId}`, { method: 'DELETE' })).status).toBeLessThan(300)
        }
        resume.resolve()
        const { rows } = await pending
        expect(rows).toMatchObject([{ requests: 1 }])
        expect(rows[0]).not.toHaveProperty('sessionId')
      } finally {
        resume.resolve()
        await pending.catch(() => {})
        ledger.mockRestore()
        list.mockRestore()
      }
    },
  )

  it('requires prices in the cost budget’s currency for an Agent’s primary and every configured fallback', async () => {
    const a = await models([{ text: 'one' }])
    const b = await models([{ text: 'two' }])
    const { desktop, admin, service } = await host()
    const first = await service('First', `${a.origin}/v1`)
    const second = await service('Second', `${b.origin}/v1`)
    expect(
      (
        await put(admin, `providers/${first.id}`, {
          fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model' }] },
        })
      ).status,
    ).toBe(200)
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '资料整理',
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: first.id, model: 'fake-model' },
      },
    })
    const price = (providerId: string, currency: string) =>
      put(admin, 'model-prices', {
        providerId,
        model: 'fake-model',
        prices: { currency, input: 1, output: 2 },
      })
    const budget = () =>
      put(desktop, 'model-budgets', {
        scope: 'agent',
        id: agent.id,
        budget: { unit: 'cost', currency: 'USD', limit: 5 },
      })
    expect((await price(first.id, 'USD')).status).toBe(200)
    const missing = await budget()
    expect((await price(second.id, 'CNY')).status).toBe(200)
    const wrongCurrency = await budget()
    expect((await price(second.id, 'USD')).status).toBe(200)
    const fullyPriced = await budget()
    expect([missing, wrongCurrency, fullyPriced]).toMatchObject([
      { status: 400, body: { error: 'budget-cost-unknown' } },
      { status: 400, body: { error: 'budget-cost-unknown' } },
      { status: 200, body: { ok: true } },
    ])
  })

  it('answers the original writes after a lost reply without restoring older values over another device’s changes', async () => {
    const fake = await models([{ text: 'one' }])
    const root = await mkdtemp(join(tmpdir(), 'ls-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const options = { demo: false, dataDir: join(root, 'data'), workspaceRoot: join(root, 'work'), runtimeParent: join(root, 'r') }
    await mkdir(options.runtimeParent, { mode: 0o700 })
    const { t, desktop, admin, service } = await host(options)
    const first = await service('First', `${fake.origin}/v1`)
    const budget = (limit: number) => ({ scope: 'service', id: first.id, budget: { unit: 'tokens', limit } })
    const price = (input: number | null) => ({
      providerId: first.id,
      model: 'fake-model',
      prices: input === null ? null : { currency: 'USD', input, output: 2 },
    })
    await put(desktop, 'model-budgets', budget(100))
    await put(desktop, 'model-prices', price(1))
    // Both requests reach the Host. The sender discards its replies and later retries the same requests.
    const firstBudget = await spendBody(desktop, budget(200))
    await (await desktop.request('model-budgets', { method: 'PUT', body: firstBudget })).body?.cancel()
    const firstPrice = await spendBody(desktop, price(null))
    await (await desktop.request('model-prices', { method: 'PUT', body: firstPrice })).body?.cancel()
    expect(await desktop.json<ModelSpend>('model-spend')).toMatchObject({ prices: [], budgets: [{ limit: 200 }] })
    expect((await put(admin, 'model-budgets', budget(50))).status).toBe(200)
    expect((await put(admin, 'model-prices', price(3))).status).toBe(200)
    const auditBeforeRetry = await audit(t)
    await t.host.close()
    const next = await startTestHost(options)
    cleanups.push(() => next.close())
    expect(next.host.socketPath).toBe(t.host.socketPath)
    const budgetRetry = await desktop.json('model-budgets', { method: 'PUT', body: firstBudget })
    const priceRetry = await desktop.json('model-prices', { method: 'PUT', body: firstPrice })
    expect(budgetRetry).toEqual({ ok: true, revision: firstBudget.baseRevision + 1, replayed: true })
    expect(priceRetry).toEqual({ ok: true, revision: firstPrice.baseRevision + 1, replayed: true })
    expect(await desktop.json<ModelSpend>('model-spend')).toMatchObject({ budgets: [{ limit: 50 }], prices: [{ input: 3 }] })
    const conflict = await desktop.request('model-budgets', { method: 'PUT', body: { ...firstBudget, ...budget(400) } })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'request-conflict' })
    expect(await audit(next)).toEqual(auditBeforeRetry)
  })

  it('holds an uncertain atomic write and settles the same request without a second audit', async () => {
    const fake = await models([{ text: 'one' }])
    const { t, desktop, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const budget = (limit: number) => ({ scope: 'service', id: first.id, budget: { unit: 'tokens', limit } })
    expect((await put(desktop, 'model-budgets', budget(100))).status).toBe(200)
    const request = await spendBody(desktop, budget(200))
    const path = join(t.dataDir, 'gateway', 'budgets.json')
    budgetWrites.after = saved => {
      if (saved === path) throw new Error('Fixture lost confirmation after the atomic replacement')
    }
    const send = (device: TestDevice, body: object) => device.request('model-budgets', { method: 'PUT', body })
    try {
      const unknown = await send(desktop, request)
      expect(unknown.status).toBe(503)
      expect(await unknown.json()).toMatchObject({ error: 'model-spend-write-unknown' })
      expect((await ModelSpendStore.open(t.dataDir)).budgetOf('service', first.id)).toMatchObject({ limit: 200 })
      const rejected = await send(admin, await spendBody(admin, budget(50)))
      expect(await rejected.json()).toMatchObject({ error: 'model-spend-write-pending' })
      const changedBody = await send(desktop, { ...request, ...budget(300) })
      expect(await changedBody.json()).toMatchObject({ error: 'request-conflict' })
      const records = await audit(t)
      budgetWrites.after = undefined
      expect(await (await send(desktop, request)).json()).toEqual({ ok: true, revision: request.baseRevision + 1 })
      expect(await desktop.json<ModelSpend>('model-spend')).toMatchObject({ budgets: [{ limit: 200 }] })
      expect(await audit(t)).toEqual(records)
    } finally {
      budgetWrites.after = undefined
    }
  })

  it('requires all data access for an Agent budget without changing service budgets for a work admin', async () => {
    const fake = await models([{ text: 'one' }])
    const { t, desktop, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '私有资料',
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: first.id, model: 'fake-model' },
      },
    })
    const tokens = { unit: 'tokens', limit: 10 }
    expect((await put(desktop, 'model-budgets', { scope: 'agent', id: agent.id, budget: tokens })).status).toBe(200)
    expect((await put(admin, 'model-budgets', { scope: 'service', id: first.id, budget: tokens })).status).toBe(200)
    expect((await admin.request(`custom-agents/${agent.id}`)).status).toBe(403)
    const path = join(t.dataDir, 'gateway', 'budgets.json')
    const previous = await readFile(path, 'utf8')
    const records = await audit(t)
    const replies = []
    for (const body of [
      { scope: 'agent', id: 'general', budget: tokens },
      { scope: 'agent', id: agent.id, budget: null },
      { scope: 'agent', id: agent.id, budget: { unit: 'cost', currency: 'USD', limit: 5 } },
    ])
      replies.push(await put(admin, 'model-budgets', body))
    expect(replies).toMatchObject(Array.from({ length: 3 }, () => ({ status: 403, body: { error: 'agent-scope-required' } })))
    expect(await readFile(path, 'utf8')).toBe(previous)
    expect(await audit(t)).toEqual(records)
  })

  it('checks Agent data scope again after an in-flight budget audit', async () => {
    const { t, desktop, admin } = await host()
    await desktop.confirmedJson(`devices/${admin.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    const path = join(t.dataDir, 'gateway', 'budgets.json')
    const setup = { scope: 'agent', id: 'general', budget: { unit: 'tokens', limit: 10 } }
    expect((await put(desktop, 'model-budgets', setup)).status).toBe(200)
    const saved = await readFile(path, 'utf8')
    const reached = deferred()
    const release = deferred()
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const held = vi.spyOn(t.host.security.audit, 'append').mockImplementation(async event => {
      if (event.action === 'model.budget.changed' && event.actor.deviceId === admin.id) {
        reached.resolve()
        await release.promise
      }
      return append(event)
    })
    const pending = put(admin, 'model-budgets', { ...setup, budget: { ...setup.budget, limit: 20 } })
    try {
      await reached.promise
      await desktop.json(`devices/${admin.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
      release.resolve()
      expect(await pending).toMatchObject({ status: 403, body: { error: 'agent-scope-required' } })
      expect(await readFile(path, 'utf8')).toBe(saved)
    } finally {
      release.resolve()
      await pending.catch(() => {})
      held.mockRestore()
    }
  })

  it('does not let a stale unaudited budget decrease widen the limit another device just lowered', async () => {
    const fake = await models([{ text: 'one' }])
    const { t, desktop, admin, service } = await host()
    const first = await service('First', `${fake.origin}/v1`)
    const set = (device: TestDevice, limit: number, baseRevision: number) =>
      device.request('model-budgets', {
        method: 'PUT',
        body: {
          requestId: randomUUID(),
          baseRevision,
          scope: 'service',
          id: first.id,
          budget: { unit: 'tokens', limit },
        },
      })
    const budgetPath = join(t.dataDir, 'gateway', 'budgets.json')
    const savedLimit = async () => {
      const stored = JSON.parse(await readFile(budgetPath, 'utf8')) as {
        budgets: { id: string; limit: number }[]
      }
      return stored.budgets.find(item => item.id === first.id)?.limit
    }
    expect((await set(desktop, 100, (await desktop.json<ModelSpend>('model-spend')).revision)).status).toBe(200)
    const before = (await desktop.json<ModelSpend>('model-spend')).revision
    const lowerWriting = deferred()
    const releaseLower = deferred()
    const higherQueued = deferred()
    budgetWrites.before = async path => {
      if (path === budgetPath) {
        lowerWriting.resolve()
        await releaseLower.promise
      }
    }
    const classifications: boolean[] = []
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const barrier = vi.spyOn(t.host.security.audit, 'append').mockImplementation(async event => {
      if (event.action !== 'model.budget.changed' || event.actor.deviceId !== admin.id) return append(event)
      classifications.push((event.detail as { widening?: boolean }).widening === true)
      throw new AppError(503, 'audit-unavailable', '审计不可用')
    })
    const setBudget = ModelSpendStore.prototype.setBudget
    const queued = vi.spyOn(ModelSpendStore.prototype, 'setBudget').mockImplementation(function (this: ModelSpendStore, ...args) {
      if (args[2]?.limit === 50) higherQueued.resolve()
      return setBudget.apply(this, args)
    })
    const lower = set(desktop, 10, before)
    let higher: Promise<Response> | undefined
    try {
      await lowerWriting.promise
      expect(await savedLimit()).toBe(100)
      higher = set(admin, 50, before + 1)
      await higherQueued.promise
      releaseLower.resolve()
      expect((await lower).status).toBe(200)
      const refused = await higher
      expect({ status: refused.status, limit: await savedLimit(), classifications }).toEqual({
        status: 503,
        limit: 10,
        classifications: [true],
      })
    } finally {
      releaseLower.resolve()
      await Promise.allSettled([lower, higher])
      budgetWrites.before = undefined
      barrier.mockRestore()
      queued.mockRestore()
    }
  })

  it('stops the first turn of an Agent’s Standard chat before asking either service when that Agent’s budget is used', async () => {
    const reply = { text: 'from the primary', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    const a = await models([reply, reply, reply])
    const b = await models([{ text: 'fallback must not be asked' }])
    const { t, desktop, admin, service } = await host()
    const first = await service('First', `${a.origin}/v1`)
    const second = await service('Second', `${b.origin}/v1`)
    expect(
      (
        await put(admin, `providers/${first.id}`, {
          fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model' }] },
        })
      ).status,
    ).toBe(200)
    const makeAgent = async (name: string, limit: number) => {
      const agent = await desktop.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name,
          harnessId: 'standard',
          mode: 'chat',
          model: { providerId: first.id, model: 'fake-model' },
        },
      })
      expect((await put(desktop, 'model-budgets', { scope: 'agent', id: agent.id, budget: { unit: 'tokens', limit } })).status).toBe(200)
      return agent
    }
    const agent = await makeAgent('资料整理', 15)
    const other = await makeAgent('另一位', 30)
    const newTopic = (id: string) =>
      desktop.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), customAgentId: id, prompt: 'new topic' },
      })
    const terminal = (id: string) =>
      vi.waitFor(
        async () => {
          const current = await desktop.json<TaskDetail>(`tasks/${id}`)
          expect(['idle', 'failed']).toContain(current.summary.status)
          return current
        },
        { timeout: 6_000 },
      )
    // A run of its automation spends the Agent's budget without taking its one chat.
    const plan = await desktop.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '整理',
        customAgentId: agent.id,
        prompt: 'scheduled',
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
      },
    })
    await desktop.json(`automations/${plan.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    await vi.waitFor(
      async () => expect((await desktop.json<AutomationDetail>(`automations/${plan.id}`)).automation.lastRun?.state).toBe('completed'),
      { timeout: 8_000 },
    )
    const ran = (await desktop.json<AutomationDetail>(`automations/${plan.id}`)).automation.lastRun!.sessionId!
    const budgetOf = async (id: string) => (await desktop.json<ModelSpend>('model-spend')).budgets.find(item => item.id === id)
    expect(await budgetOf(agent.id)).toMatchObject({ scope: 'agent', used: 15, state: 'over' })
    // The chat's first turn is stopped; the other Agent's first turn and a Code session are not held by this budget.
    const [one, another, code] = await Promise.all([newTopic(agent.id), newTopic(other.id), start(admin, first.id)])
    const [detail, otherDetail, codeDetail] = await Promise.all([terminal(one.sessionId), terminal(another.sessionId), terminal(code)])
    expect(detail.summary).toMatchObject({ status: 'failed', agent: { customAgentId: agent.id } })
    expect(otherDetail.summary).toMatchObject({ status: 'idle', agent: { customAgentId: other.id } })
    expect(codeDetail.summary.status).toBe('idle')
    expect(codeDetail.summary.agent).toBeUndefined()
    expect(detail.messages.findLast(message => message.role === 'system')?.text).toContain('本月预算已用完')
    expect(a.requests).toHaveLength(3)
    expect(b.requests).toHaveLength(0)
    expect(await budgetOf(agent.id)).toMatchObject({ used: 15, state: 'over' })
    expect(await budgetOf(other.id)).toMatchObject({ used: 15 })
    expect((await desktop.json<AppSnapshot>('snapshot')).agentChats?.[agent.id]).toEqual({ state: 'ready', sessionId: one.sessionId })
    await vi.waitFor(async () => {
      const lines = (await ledgerText(t))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { sessionId: string })
      const record = (id: string) => lines.find(line => line.sessionId === id)
      expect(lines).toHaveLength(4)
      expect(record(ran)).toMatchObject({ agentId: agent.id, attempts: 1, outcome: 'ok' })
      expect(record(one.sessionId)).toMatchObject({ agentId: agent.id, attempts: 0, outcome: 'budget', fallback: false })
      expect(record(another.sessionId)).toMatchObject({ agentId: other.id, attempts: 1, outcome: 'ok' })
      expect(record(code)).toMatchObject({ attempts: 1, outcome: 'ok' })
      expect(record(code)).not.toHaveProperty('agentId')
    })
    expect(await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')).not.toContain('task.model.fallback')
  })
})
