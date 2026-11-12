import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { BrowserBroker, originClass, type BrowserAuditInput, type BrowserCallInput, type BrowserTab } from '../src/browser-broker.ts'
import { classifyBrowserCall, classifyStandardCall } from '../src/risk.ts'

const DEVICE = `dev_${'A'.repeat(22)}`
const TAB = `brw_${'T'.repeat(22)}`
const OTHER_TAB = `brw_${'U'.repeat(22)}`

/** A stand-in for the provider's SSE response: what the broker writes, as events. */
class FakeStream extends EventEmitter {
  writableEnded = false
  events: Array<{ event: string; data: any }> = []
  writeHead() {
    return this
  }
  write(chunk: string) {
    const match = /^event: (.+)\ndata: (.*)\n\n$/su.exec(chunk)
    if (match) this.events.push({ event: match[1]!, data: JSON.parse(match[2]!) })
    this.emit('wrote')
    return true
  }
  end(chunk?: string) {
    if (chunk) this.write(chunk)
    this.writableEnded = true
    this.emit('close')
    return this
  }
  /** The next event of this name, written now or later. */
  next(name: string, after = 0): Promise<any> {
    return new Promise(resolve => {
      const look = () => {
        const found = this.events.slice(after).find(item => item.event === name)
        if (!found) return
        this.off('wrote', look)
        resolve(found.data)
      }
      this.on('wrote', look)
      look()
    })
  }
}

function setup(options: { audit?: (input: BrowserAuditInput) => Promise<void>; takeoverMs?: number; settleMs?: number } = {}) {
  const order: string[] = []
  const audits: BrowserAuditInput[] = []
  const broker = new BrowserBroker({
    auditCall: async input => {
      order.push('audit')
      audits.push(input)
      await options.audit?.(input)
    },
    takeoverMs: options.takeoverMs ?? 10_000,
    settleMs: options.settleMs ?? 200,
    deadlineMs: 5_000,
    longDeadlineMs: 5_000,
  })
  const stream = new FakeStream()
  const providerId = broker.register(DEVICE)
  expect(broker.openStream(DEVICE, providerId, stream as unknown as ServerResponse)).toBe(true)
  stream.on('wrote', () => {
    const last = stream.events.at(-1)
    if (last?.event === 'call') order.push('call')
  })
  const tabs = (list: Array<Partial<BrowserTab>>) =>
    broker.reportTabs(
      DEVICE,
      providerId,
      list.map(tab => ({
        tabId: TAB,
        sessionId: 's1',
        title: '夹具',
        url: 'http://127.0.0.1:5173/',
        loading: false,
        control: null,
        opener: 'agent',
        ...tab,
      })) as BrowserTab[],
    )
  return { broker, stream, providerId, order, audits, tabs }
}

const call = (input: Partial<BrowserCallInput>): BrowserCallInput => ({
  sessionId: 's1',
  projectId: 'p1',
  tool: 'browser_click',
  args: { tabId: TAB, ref: 'e1' },
  risk: 'R1',
  signal: new AbortController().signal,
  ...input,
})

describe('browser broker', () => {
  it('fails at once with browser-unavailable when no desktop app has registered, and never queues', async () => {
    const broker = new BrowserBroker({ auditCall: async () => {} })
    expect(broker.available()).toBe(false)
    await expect(broker.call(call({}))).resolves.toEqual({ ok: false, error: 'browser-unavailable', dispatched: false })
    // A registration without its stream is no provider either.
    broker.register(DEVICE)
    await expect(broker.call(call({}))).resolves.toMatchObject({ error: 'browser-unavailable' })
  })

  it('writes the audit record before sending, with classes and hashes only, and does not send when the write fails', async () => {
    const { broker, stream, order, audits, tabs } = setup()
    tabs([{}])
    const pending = broker.call(call({ args: { tabId: TAB, ref: 'e1' } }))
    const sent = await stream.next('call')
    expect(order).toEqual(['audit', 'call'])
    expect(sent).toMatchObject({ sessionId: 's1', projectId: 'p1', tool: 'browser_click', origin: 'http://127.0.0.1:5173', risk: 'R1' })
    expect(audits[0]).toEqual({
      sessionId: 's1',
      callId: sent.callId,
      tool: 'browser_click',
      tabId: TAB,
      origin: 'loopback',
      originHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      risk: 'R1',
    })
    expect(JSON.stringify(audits)).not.toContain('5173')
    broker.settle(DEVICE, { callId: sent.callId, ok: true, dispatched: true, text: '已点击。' })
    await expect(pending).resolves.toEqual({ ok: true, text: '已点击。', dispatched: true })

    const failing = setup({ audit: async () => Promise.reject(new Error('disk full')) })
    failing.tabs([{}])
    await expect(failing.broker.call(call({}))).resolves.toEqual({ ok: false, error: 'audit-failed', dispatched: false })
    expect(failing.stream.events.filter(item => item.event === 'call')).toEqual([])
  })

  it('confirms a stop only after main reports the call settled, and leaves an action unknown when main never does', async () => {
    const { broker, stream, tabs } = setup()
    tabs([{}])
    const stop = new AbortController()
    const pending = broker.call(call({ signal: stop.signal }))
    const sent = await stream.next('call')
    let done = false
    void pending.then(() => (done = true))
    stop.abort()
    const cancel = await stream.next('cancel')
    expect(cancel).toEqual({ callId: sent.callId })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(done).toBe(false)
    broker.settle(DEVICE, { callId: sent.callId, ok: false, dispatched: false, error: 'cancelled' })
    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled', dispatched: false })

    // Main never answers the cancel: the click may have happened.
    const second = new AbortController()
    const silent = broker.call(call({ signal: second.signal }))
    const count = stream.events.length
    await stream.next('call', count)
    second.abort()
    await expect(silent).resolves.toEqual({ ok: false, error: 'result-unknown', dispatched: true })

    // A read that main does not settle just fails: it changed nothing.
    const third = new AbortController()
    const read = broker.call(call({ tool: 'browser_read', args: { tabId: TAB }, risk: 'R0', signal: third.signal }))
    await stream.next('call', stream.events.length)
    third.abort()
    await expect(read).resolves.toEqual({ ok: false, error: 'cancelled', dispatched: false })
  })

  it('fails reads and leaves actions unknown when the provider goes away mid-call', async () => {
    const { broker, stream, tabs } = setup()
    tabs([{}])
    const action = broker.call(call({}))
    await stream.next('call')
    stream.end()
    await expect(action).resolves.toEqual({ ok: false, error: 'result-unknown', dispatched: true })
    expect(broker.available()).toBe(false)
    expect(broker.tabsOf('s1')).toEqual([])
  })

  it('refuses tabs off this Mac, other sessions’ tabs and non-local addresses before main sees anything', async () => {
    const { broker, stream, tabs } = setup()
    tabs([{ url: 'https://example.com/login' }, { tabId: OTHER_TAB, sessionId: 's2' }])
    await expect(broker.call(call({}))).resolves.toEqual({ ok: false, error: 'not-local', dispatched: false })
    await expect(broker.call(call({ tool: 'browser_read', args: { tabId: TAB }, risk: 'R0' }))).resolves.toMatchObject({
      error: 'not-local',
    })
    await expect(broker.call(call({ args: { tabId: OTHER_TAB, ref: 'e1' } }))).resolves.toMatchObject({ error: 'not-found' })
    await expect(broker.call(call({ tool: 'browser_open', args: { url: 'https://example.com/' } }))).resolves.toMatchObject({
      error: 'not-local',
    })
    await expect(broker.call(call({ tool: 'browser_open', args: { url: 'http://192.168.1.4:3000/' } }))).resolves.toMatchObject({
      error: 'not-local',
    })
    expect(stream.events.filter(item => item.event === 'call')).toEqual([])
    // Listing and closing work anywhere.
    const close = broker.call(call({ tool: 'browser_close', args: { tabId: TAB }, risk: 'R1' }))
    const sent = await stream.next('call')
    expect(sent.tool).toBe('browser_close')
    broker.settle(DEVICE, { callId: sent.callId, ok: true, dispatched: true, text: '已关闭。' })
    await expect(close).resolves.toMatchObject({ ok: true })
  })

  it('names the runtime’s tool call and the approval in the audit record, so it matches approval.decided', async () => {
    const { broker, stream, tabs, audits } = setup()
    tabs([{}])
    const click = broker.call(call({ toolCallId: 'call_7', approvalId: 'approval-7' }))
    const sent = await stream.next('call')
    expect(audits.at(-1)).toMatchObject({ toolCallId: 'call_7', approvalId: 'approval-7', callId: sent.callId })
    broker.settle(DEVICE, { callId: sent.callId, ok: true, dispatched: true, text: '已点击。' })
    await expect(click).resolves.toMatchObject({ ok: true })
  })

  it('holds a call while the person has the tab, as waiting time, and gives up after the takeover limit', async () => {
    const { broker, stream, tabs } = setup({ takeoverMs: 300 })
    tabs([{ control: 'person' }])
    let waits = 0
    let closed = 0
    const pending = broker.call(
      call({
        waitForUser: () => {
          waits++
          return () => closed++
        },
      }),
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stream.events.filter(item => item.event === 'call')).toEqual([])
    expect(waits).toBe(1)
    tabs([{ control: null }])
    const sent = await stream.next('call')
    expect(closed).toBe(1)
    broker.settle(DEVICE, { callId: sent.callId, ok: true, dispatched: true, text: '已点击。' })
    await expect(pending).resolves.toMatchObject({ ok: true })

    tabs([{ control: 'person' }])
    await expect(broker.call(call({}))).resolves.toEqual({ ok: false, error: 'taken-over', dispatched: false })
  })

  it('waits again when main finds the tab taken over as the call arrives', async () => {
    const { broker, stream, tabs } = setup()
    tabs([{}])
    const pending = broker.call(call({}))
    const first = await stream.next('call')
    broker.settle(DEVICE, { callId: first.callId, ok: false, dispatched: false, error: 'taken-over' })
    await new Promise(resolve => setTimeout(resolve, 30))
    tabs([{ control: null }])
    const second = await stream.next('call', stream.events.findIndex(item => item.data?.callId === first.callId) + 1)
    expect(second.callId).not.toBe(first.callId)
    broker.settle(DEVICE, { callId: second.callId, ok: true, dispatched: true, text: '已点击。' })
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('learns where a tab went and which references name sensitive fields, and takes a picture sent before the result', async () => {
    const { broker, stream, tabs } = setup()
    tabs([{}])
    expect(broker.refSensitive('s1', TAB, 'e3')).toBeUndefined()
    const pending = broker.call(call({ tool: 'browser_screenshot', args: { tabId: TAB }, risk: 'R0' }))
    const sent = await stream.next('call')
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(16)])
    expect(broker.putImage(DEVICE, sent.callId, Buffer.from('not a png'))).toBe(false)
    expect(broker.putImage(DEVICE, sent.callId, png)).toBe(true)
    broker.settle(DEVICE, {
      callId: sent.callId,
      ok: true,
      dispatched: false,
      text: '截图',
      image: true,
      tab: { tabId: TAB, url: 'http://127.0.0.1:5173/login', title: '登录' },
      refs: { e3: true, e4: false },
    })
    await expect(pending).resolves.toMatchObject({ ok: true, image: png })
    expect(broker.refSensitive('s1', TAB, 'e3')).toBe(true)
    expect(broker.refSensitive('s1', TAB, 'e4')).toBe(false)
    expect(broker.refSensitive('s2', TAB, 'e4')).toBeUndefined()
    expect(broker.tabsOf('s1')[0]?.url).toBe('http://127.0.0.1:5173/login')
  })

  it('takes only the current provider: a new registration ends the old stream and its calls', async () => {
    const { broker, stream, tabs, providerId } = setup()
    tabs([{}])
    const pending = broker.call(call({}))
    await stream.next('call')
    const next = broker.register(DEVICE)
    expect(next).not.toBe(providerId)
    expect(stream.events.at(-1)?.event).toBe('ended')
    await expect(pending).resolves.toMatchObject({ error: 'result-unknown' })
    expect(broker.reportTabs(DEVICE, providerId, [])).toBe(false)
    expect(broker.openStream(`dev_${'B'.repeat(22)}`, next, new FakeStream() as unknown as ServerResponse)).toBe(false)
  })
})

describe('browser risk', () => {
  const local = { tab: { origin: 'loopback' as const, opener: 'agent' as const } }
  it('reads are R0, actions R1 and typing into a sensitive or unread field R2, wherever the tab is', () => {
    for (const tool of [
      'browser_tabs',
      'browser_read',
      'browser_find',
      'browser_screenshot',
      'browser_scroll',
      'browser_console',
      'browser_network',
      'browser_wait',
      'browser_viewport',
    ])
      expect(classifyBrowserCall(tool, {}, local), tool).toEqual({ risk: 'R0' })
    for (const tool of ['browser_open', 'browser_navigate', 'browser_click', 'browser_key', 'browser_select'])
      for (const origin of ['loopback', 'private', 'internet', 'none'] as const)
        expect(classifyBrowserCall(tool, {}, { tab: { origin, opener: 'agent' } }), `${tool} ${origin}`).toEqual({ risk: 'R1' })
    expect(classifyBrowserCall('browser_type', {}, { ...local, sensitive: false })).toEqual({ risk: 'R1' })
    expect(classifyBrowserCall('browser_type', {}, { ...local, sensitive: true })).toEqual({ risk: 'R2', reason: 'sensitive-field' })
    expect(classifyBrowserCall('browser_type', {}, local)).toEqual({ risk: 'R2', reason: 'sensitive-field' })
    expect(classifyBrowserCall('browser_close', {}, local)).toEqual({ risk: 'R0' })
    expect(classifyBrowserCall('browser_close', {}, { tab: { origin: 'internet', opener: 'person' } })).toEqual({ risk: 'R1' })
  })

  it('gives the browser classes only to the Host’s own plugin', () => {
    const base = { toolName: 'browser_click', args: {}, demo: false, folders: [] }
    expect(classifyStandardCall({ ...base, pluginId: 'browser', browser: local })).toEqual({ risk: 'R1' })
    expect(classifyStandardCall({ ...base, pluginId: 'someone-else', browser: local })).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
    expect(classifyStandardCall({ ...base, toolName: 'browser_read', pluginId: 'someone-else' })).toEqual({
      risk: 'R2',
      reason: 'unlisted-tool',
    })
  })

  it('places addresses on this Mac, the local network or the internet', () => {
    expect(originClass('http://localhost:5173/')).toBe('loopback')
    expect(originClass('http://app.localhost/')).toBe('loopback')
    expect(originClass('http://127.4.0.1/')).toBe('loopback')
    expect(originClass('http://[::1]:3000/')).toBe('loopback')
    expect(originClass('http://192.168.0.2/')).toBe('private')
    expect(originClass('http://printer.local/')).toBe('private')
    expect(originClass('https://example.com/')).toBe('internet')
    expect(originClass('about:blank')).toBe('none')
    // The same set as main's agentLocalHost: IPv4-mapped 127/8 is this Mac, 0.0.0.0 and :: are not.
    expect(originClass('http://[::ffff:127.0.0.1]:3000/')).toBe('loopback')
    expect(originClass('http://[::ffff:10.0.0.1]/')).not.toBe('loopback')
    expect(originClass('http://0.0.0.0:3000/')).not.toBe('loopback')
    expect(originClass('http://[::]:3000/')).not.toBe('loopback')
    expect(originClass('')).toBe('none')
  })
})
