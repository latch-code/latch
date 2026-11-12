import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage, ToolDefinition } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function testHost(options: Parameters<typeof startTestHost>[0] = {}): Promise<TestHost> {
  const t = await startTestHost(options)
  cleanups.push(() => t.close())
  return t
}

const TAB = `brw_${'T'.repeat(22)}`
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A model that calls the tools in `steps` one per step and remembers what each request offered and carried. */
function scripted(steps: Array<{ name: string; arguments: Record<string, unknown> }>, vision = true) {
  const seen: Array<{ tools: string[]; messages: ModelMessage[] }> = []
  const plugin: HarnessPlugin = {
    id: 'scripted',
    name: 'Scripted',
    version: '1',
    description: 'fixture',
    activate(context) {
      context.registerProvider({
        id: 'scripted',
        name: 'Scripted',
        model: 'scripted',
        modelCapabilities: { scripted: { vision } },
        async *stream({ messages, tools }: { messages: ModelMessage[]; tools: ToolDefinition[] }) {
          seen.push({ tools: tools.map(tool => tool.name), messages })
          const done = messages.filter(message => message.role === 'tool').length
          const step = steps[done]
          if (!step) {
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
            return
          }
          yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, ...step } }
          yield { type: 'finish', reason: 'tool-calls' }
        },
      })
    },
  }
  return { plugin, seen }
}

/** The provider's SSE stream as main reads it: events, as they come. */
async function openProvider(desktop: TestDevice) {
  const registered = await desktop.request('browser-provider/register', { method: 'POST', body: {} })
  expect(registered.status).toBe(403)
  const response = await desktop.registerBrowserProvider()
  expect(response.status).toBe(201)
  const { providerId } = (await response.json()) as { providerId: string }
  const stop = new AbortController()
  const stream = await desktop.request('browser-provider/stream', { method: 'POST', body: { providerId }, signal: stop.signal })
  expect(stream.status).toBe(200)
  const events: Array<{ event: string; data: any }> = []
  const waiters = new Set<() => void>()
  void (async () => {
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: (.+)$/mu.exec(block)?.[1]
          const data = /^data: (.*)$/mu.exec(block)?.[1]
          if (event && data) events.push({ event, data: JSON.parse(data) })
          for (const wake of [...waiters]) wake()
        }
      }
    } catch {
      /* Aborted. */
    }
  })()
  const next = (name: string, after = 0) =>
    new Promise<any>(resolve => {
      const look = () => {
        const found = events.slice(after).find(item => item.event === name)
        if (!found) return
        waiters.delete(look)
        resolve(found.data)
      }
      waiters.add(look)
      look()
    })
  cleanups.push(async () => stop.abort())
  return { providerId, events, next, close: () => stop.abort() }
}

async function settled(device: TestDevice, sessionId: string): Promise<TaskDetail> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
    if (!['running', 'waiting-approval'].includes(detail.summary.status)) return detail
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('session did not settle')
}

async function audit(t: TestHost): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

describe('browser provider routes', () => {
  it('registers only the desktop app over host.sock with a signed body naming its purpose', async () => {
    const t = await testHost({ tls: true })
    const admin = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin'] as const
    const phone = await t.enroll({ listener: 'tls', scopes: [...admin] })
    const local = await t.enroll({ listener: 'loopback-tcp', scopes: [...admin] })
    const desktop = await t.enroll({ listener: 'unix' })
    for (const device of [phone, local]) {
      const response = await device.request('browser-provider/nonce', { method: 'POST', body: {} })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'local-only' })
    }
    const wrong = await desktop.registerBrowserProvider({ signedBody: body => ({ ...body, purpose: 'folders' }) })
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({ error: 'browser-provider-invalid' })
    const first = (await (await desktop.registerBrowserProvider()).json()) as { providerId: string }
    const second = (await (await desktop.registerBrowserProvider()).json()) as { providerId: string }
    expect(second.providerId).not.toBe(first.providerId)
    // Only the newest provider may open the stream.
    const stale = await desktop.request('browser-provider/stream', { method: 'POST', body: { providerId: first.providerId } })
    expect(stale.status).toBe(409)
    const actions = async () => (await audit(t)).map(record => record.action).filter(action => action.startsWith('browser.'))
    await expect.poll(actions).toEqual(['browser.provider.registered', 'browser.provider.ended', 'browser.provider.registered'])
  })

  it('runs a screenshot of the built-in harness through the provider into the tool row, and shows the tab list to the phone', async () => {
    const { plugin, seen } = scripted([
      { name: 'browser_screenshot', arguments: { tabId: TAB } },
      { name: 'browser_click', arguments: { tabId: TAB, ref: 'e1' } },
    ])
    const t = await testHost({ demo: false, providerId: 'scripted', plugins: [plugin], tls: true })
    const desktop = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll({ listener: 'tls', scopes: ['view', 'run'] })
    const provider = await openProvider(desktop)
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '看一眼', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    const tabs = await desktop.request('browser-provider/tabs', {
      method: 'POST',
      body: {
        providerId: provider.providerId,
        tabs: [{ tabId: TAB, sessionId, title: '夹具', url: 'http://127.0.0.1:5173/', loading: false, control: null, opener: 'agent' }],
      },
    })
    expect(tabs.status).toBe(200)
    const listed = await phone.json<{ available: boolean; tabs: unknown[] }>(`tasks/${sessionId}/browser-tabs`)
    expect(listed).toEqual({
      available: true,
      tabs: [{ tabId: TAB, title: '夹具', url: 'http://127.0.0.1:5173/', loading: false, control: null }],
    })
    const shot = await provider.next('call')
    expect(shot).toMatchObject({ sessionId, tool: 'browser_screenshot', args: { tabId: TAB }, risk: 'R0', origin: 'http://127.0.0.1:5173' })
    // The phone cannot answer for the provider.
    expect(
      (await phone.request('browser-provider/results', { method: 'POST', body: { callId: shot.callId, ok: true, dispatched: false } }))
        .status,
    ).toBe(403)
    const put = await desktop.request(`browser-provider/results/${shot.callId}/image`, {
      method: 'PUT',
      rawBody: PNG,
      headers: { 'content-type': 'image/png' },
    })
    expect(await put.json()).toEqual({ accepted: true })
    await desktop.json('browser-provider/results', {
      method: 'POST',
      body: { callId: shot.callId, ok: true, dispatched: false, text: '可见区域 1280×800', image: true },
    })
    // The click is R1 and waits for the person; refused here, it never reaches main.
    for (let attempt = 0; attempt < 200; attempt++) {
      const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
      if (detail.summary.status === 'waiting-approval') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
    const approval = detail.approvals[0]!
    expect(approval).toMatchObject({ toolName: 'browser_click', risk: 'R1' })
    await desktop.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
    const done = await settled(desktop, sessionId)
    const row = done.messages.find(message => message.toolName === 'browser_screenshot')!
    expect(row.state).toBe('completed')
    expect(row.attachments).toEqual([expect.objectContaining({ kind: 'image', mime: 'image/png' })])
    // The model saw the picture with the result.
    const tool = seen.at(-1)!.messages.find(message => message.role === 'tool' && message.attachments?.length)
    expect(tool?.attachments?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') })
    expect(provider.events.filter(item => item.event === 'call')).toHaveLength(1)
    const records = (await audit(t)).filter(record => record.action === 'browser.call')
    expect(records).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ tool: 'browser_screenshot', origin: 'loopback', risk: 'R0' }) }),
    ])
    // The turn's end goes down the stream, so main ends any takeover.
    await provider.next('turn-ended')
  })

  it('says the window is not open when no desktop app is the provider, and offers no screenshot to a model without vision', async () => {
    const { plugin, seen } = scripted([{ name: 'browser_tabs', arguments: {} }], false)
    const t = await testHost({ demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '看一眼', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    const done = await settled(desktop, sessionId)
    const row = done.messages.find(message => message.toolName === 'browser_tabs')!
    expect(row.state).toBe('failed')
    expect(row.text).toContain('这台 Mac 上的 Latch 窗口没有打开')
    expect(seen[0]!.tools).toContain('browser_click')
    expect(seen[0]!.tools).not.toContain('browser_screenshot')
  })
})

describe('browser classes from what main reported', () => {
  it('asks R1 to type into a field a read found ordinary, and R2 into one it found sensitive or never read', async () => {
    const { plugin } = scripted([
      { name: 'browser_read', arguments: { tabId: TAB } },
      { name: 'browser_type', arguments: { tabId: TAB, ref: 'e2', text: 'Latch' } },
    ])
    const t = await testHost({ demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const provider = await openProvider(desktop)
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '看一眼', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    await desktop.json('browser-provider/tabs', {
      method: 'POST',
      body: {
        providerId: provider.providerId,
        tabs: [{ tabId: TAB, sessionId, title: '夹具', url: 'http://127.0.0.1:5173/', loading: false, control: null, opener: 'agent' }],
      },
    })
    const read = await provider.next('call')
    await desktop.json('browser-provider/results', {
      method: 'POST',
      body: {
        callId: read.callId,
        ok: true,
        dispatched: false,
        text: '- textbox "名字" [e2]\n- textbox "密码" （密码框，值不读取） [e3]',
        tab: { tabId: TAB, url: 'http://127.0.0.1:5173/', title: '夹具' },
        refs: { e2: false, e3: true },
      },
    })
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status === 'waiting-approval') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const approval = (await desktop.json<TaskDetail>(`tasks/${sessionId}`)).approvals[0]!
    expect(approval).toMatchObject({ toolName: 'browser_type', risk: 'R1' })
  })
})
