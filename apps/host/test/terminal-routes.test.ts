// The terminal routes in a real Host, with a stand-in for latch-pty; the last case runs the real one on /bin/sh.
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalStreamEvents, TerminalSummary, TerminalText } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { buildTerminalHelper } from '../scripts/build-terminal.ts'
import type { HelperEvent, LaunchTerminal, TerminalLaunch, TerminalProcess } from '../src/terminal/helper.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class FakeTerminal implements TerminalProcess {
  readonly inputs: Buffer[] = []
  readonly sizes: Array<[number, number]> = []
  pendingInput = 0
  closed = false
  constructor(
    readonly launch: TerminalLaunch,
    readonly emit: (event: HelperEvent) => void,
  ) {}
  input(data: Uint8Array) {
    this.inputs.push(Buffer.from(data))
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows])
  }
  signal() {}
  pauseOutput() {}
  resumeOutput() {}
  close() {
    if (!this.closed) {
      this.closed = true
      this.emit({ type: 'exit', signal: 1 })
      this.emit({ type: 'gone' })
    }
    return Promise.resolve()
  }
}

/** A Host whose terminals are stand-ins, and each one started so far. */
async function hostWithTerminals(options: TestHostOptions = {}) {
  const launched: FakeTerminal[] = []
  const launch: LaunchTerminal = (spec, onEvent) => {
    const terminal = new FakeTerminal(spec, onEvent)
    launched.push(terminal)
    onEvent({ type: 'started', pid: 1 })
    return terminal
  }
  const t = await startTestHost({ tls: true, terminal: { launch, shell: { file: '/bin/sh', argv: ['sh'] } }, ...options })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
  return { t, desktop, launched }
}

async function startSession(device: TestDevice): Promise<string> {
  const { sessionId } = await device.json<{ sessionId: string }>('tasks', { body: { requestId: randomUUID(), prompt: '你好' } })
  return sessionId
}

async function openTerminal(device: TestDevice, sessionId: string, size = { cols: 80, rows: 24 }): Promise<TerminalSummary> {
  const response = await device.request(`tasks/${sessionId}/terminals`, { body: size })
  expect(response.status).toBe(201)
  return ((await response.json()) as { terminal: TerminalSummary }).terminal
}

async function refusal(response: Response): Promise<[number, string]> {
  return [response.status, ((await response.json()) as { error: string }).error]
}

/** Reads a terminal's event stream in the background, frame by frame; `done` turns true when the Host ends it. */
async function watch(device: TestDevice, path: string) {
  const controller = new AbortController()
  const response = await device.request(path, { signal: controller.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const state = { text: '', done: false }
  const decoder = new TextDecoder()
  const reading = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        state.done = true
        return
      }
      state.text += decoder.decode(next.value, { stream: true })
    }
  })().catch(() => {})
  cleanups.push(async () => {
    controller.abort()
    await reading
  })
  const frames = <E extends keyof TerminalStreamEvents>(event: E): Array<TerminalStreamEvents[E]> =>
    [...state.text.matchAll(/event: (\w+)\ndata: (.*)\n\n/gu)].filter(match => match[1] === event).map(match => JSON.parse(match[2]!))
  const output = () =>
    frames('output')
      .map(frame => Buffer.from(frame.data, 'base64').toString())
      .join('')
  return { state, frames, output }
}

async function archived(device: TestDevice, sessionId: string): Promise<boolean | undefined> {
  return (await device.json<{ summary: { archived?: boolean } }>(`tasks/${sessionId}`)).summary.archived
}

const features = async (device: TestDevice) =>
  (await device.json<{ catalog: { features: { terminal?: boolean } } }>('snapshot')).catalog.features.terminal

describe('terminal routes', () => {
  it('opens in the session folder after the audit record, types, resizes, watches, attaches and closes', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const sessionId = await startSession(desktop)
    const append = vi.spyOn(t.host.security.audit, 'append')
    const opened = await openTerminal(desktop, sessionId, { cols: 100, rows: 30 })
    expect(opened).toMatchObject({ sessionId, status: 'running', cols: 100, rows: 30, sizeOwner: true, shell: 'sh', busy: false })
    expect(launched[0]!.launch.cwd).toBe((await t.host.bridge.detail(sessionId)).summary.cwd)
    expect(append.mock.calls.map(([event]) => event).filter(event => event.action.startsWith('terminal.'))).toEqual([
      {
        action: 'terminal.open',
        actor: { deviceId: desktop.id, listener: 'unix', via: 'http' },
        detail: { sessionId, terminalId: opened.id },
      },
    ])

    const base = `tasks/${sessionId}/terminals`
    expect(await desktop.json<{ terminals: TerminalSummary[] }>(base)).toEqual({ terminals: [opened] })
    // The client never names a folder.
    expect(await refusal(await desktop.request(base, { body: { cols: 80, rows: 24, cwd: '/' } }))).toEqual([400, 'invalid-input'])

    const typed = await desktop.request(`${base}/${opened.id}/input`, { body: { data: Buffer.from('ls\r').toString('base64') } })
    expect(typed.status).toBe(200)
    expect(launched[0]!.inputs.map(data => data.toString())).toEqual(['ls\r'])
    expect(await refusal(await desktop.request(`${base}/${opened.id}/input`, { body: { data: 'not base64!' } }))).toEqual([
      400,
      'invalid-input',
    ])

    const resized = await desktop.json<{ terminal: TerminalSummary }>(`${base}/${opened.id}/resize`, { body: { cols: 120, rows: 40 } })
    expect(resized.terminal).toMatchObject({ cols: 120, rows: 40 })
    expect(launched[0]!.sizes).toEqual([[120, 40]])

    launched[0]!.emit({ type: 'output', data: Buffer.from('before\r\n') })
    const stream = await watch(desktop, `${base}/${opened.id}/stream`)
    await vi.waitFor(() => expect(stream.output()).toBe('before\r\n'))
    expect(stream.frames('terminal')[0]).toMatchObject({ id: opened.id, cols: 120 })
    launched[0]!.emit({ type: 'output', data: Buffer.from('  Local:   http://localhost:5173/\r\n') })
    await vi.waitFor(() => expect(stream.frames('terminal').at(-1)?.services).toEqual([{ origin: 'http://localhost:5173', port: 5173 }]))
    const end = stream.frames('output').at(-1)!
    const position = end.offset + Buffer.from(end.data, 'base64').length
    const again = await watch(desktop, `${base}/${opened.id}/stream?from=${position}`)
    await vi.waitFor(() => expect(again.frames('terminal')).toHaveLength(1))
    expect(again.output()).toBe('')
    expect(await refusal(await desktop.request(`${base}/${opened.id}/stream?from=-1`))).toEqual([400, 'invalid-input'])
    expect(await refusal(await desktop.request(`${base}/${opened.id}/stream?other=1`))).toEqual([400, 'invalid-input'])

    const attached = await desktop.json<TerminalText>(`${base}/${opened.id}/attach`, { body: { lines: 1 } })
    expect(attached).toMatchObject({ text: '  Local:   http://localhost:5173/', lines: 1, redacted: false })
    const selected = await desktop.json<TerminalText>(`${base}/${opened.id}/attach`, { body: { selection: 'chosen' } })
    expect(selected.text).toBe('chosen')

    launched[0]!.emit({ type: 'foreground', busy: true, name: 'vim' })
    await vi.waitFor(() => expect(stream.frames('terminal').at(-1)?.foreground).toBe('vim'))
    const busy = await desktop.request(`${base}/${opened.id}/close`, { body: {} })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: 'terminal-busy', foreground: 'vim' })
    expect((await desktop.request(`${base}/${opened.id}/close`, { body: { force: true } })).status).toBe(200)
    expect(launched[0]!.closed).toBe(true)
    await vi.waitFor(() => expect(stream.state.done).toBe(true))
    expect(stream.frames('closed')).toEqual([{}])
    expect(await refusal(await desktop.request(`${base}/${opened.id}/close`, { body: {} }))).toEqual([404, 'terminal-not-found'])
    expect(await desktop.json(base)).toEqual({ terminals: [] })
    expect(await refusal(await desktop.request(`tasks/missing/terminals`, { body: { cols: 80, rows: 24 } }))).toEqual([
      404,
      'task-not-found',
    ])
    expect(launched).toHaveLength(1)
  })

  it('accepts only host.sock on every route, and sets the flag only where a terminal opens', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    const viewer = await t.enroll({ listener: 'unix', name: 'Viewer', scopes: ['view'] })
    const sessionId = await startSession(desktop)
    const { id } = await openTerminal(desktop, sessionId)
    const base = `tasks/${sessionId}/terminals`
    const routes: Array<[string, { body: unknown } | undefined]> = [
      [base, undefined],
      [base, { body: { cols: 80, rows: 24 } }],
      [`${base}/${id}/stream`, undefined],
      [`${base}/${id}/input`, { body: { data: 'bHM=' } }],
      [`${base}/${id}/resize`, { body: { cols: 90, rows: 24 } }],
      [`${base}/${id}/attach`, { body: {} }],
      [`${base}/${id}/close`, { body: {} }],
    ]
    for (const [path, init] of routes) {
      for (const remote of [browser, phone]) expect(await refusal(await remote.request(path, init))).toEqual([403, 'local-only'])
      expect(await refusal(await viewer.request(path, init))).toEqual([403, 'scope-required'])
      expect((await t.raw('unix', `api/${path}`, init ?? {})).status).toBe(401)
    }
    // A malformed body is not even read elsewhere.
    expect(await refusal(await phone.request(`${base}/${id}/input`, { body: { nothing: true } }))).toEqual([403, 'local-only'])
    expect(launched).toHaveLength(1)
    expect(launched[0]!.inputs).toEqual([])
    expect(launched[0]!.closed).toBe(false)
    expect(await features(desktop)).toBe(true)
    for (const elsewhere of [browser, phone, viewer]) expect(await features(elsewhere)).toBeUndefined()
    // An unknown path under a terminal is no route at all.
    expect((await desktop.request(`${base}/${id}/unknown`, { body: {} })).status).toBe(404)
  })

  it('keeps the shell from a device on this computer whose data scope is work', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const work = await t.enroll({ listener: 'unix', name: 'Work window' })
    expect((await desktop.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    const sessionId = await startSession(desktop)
    const { id } = await openTerminal(desktop, sessionId)
    const base = `tasks/${sessionId}/terminals`
    const routes: Array<[string, { body: unknown } | undefined]> = [
      [base, undefined],
      [base, { body: { cols: 80, rows: 24 } }],
      [`${base}/${id}/stream`, undefined],
      [`${base}/${id}/input`, { body: { data: 'bHM=' } }],
      [`${base}/${id}/resize`, { body: { cols: 90, rows: 24 } }],
      [`${base}/${id}/attach`, { body: {} }],
      [`${base}/${id}/close`, { body: {} }],
    ]
    for (const [path, init] of routes) expect(await refusal(await work.request(path, init))).toEqual([403, 'terminal-scope'])
    expect(await features(work)).toBeUndefined()
    expect(launched).toHaveLength(1)
    expect(launched[0]!.inputs).toEqual([])
    expect(launched[0]!.closed).toBe(false)
  })

  it('has no flag and opens nothing without the component', async () => {
    const t = await startTestHost({ terminal: { binary: join(tmpdir(), `latch-no-pty-${randomUUID()}`) } })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    expect(await features(desktop)).toBeUndefined()
    const sessionId = await startSession(desktop)
    const [status, code] = await refusal(await desktop.request(`tasks/${sessionId}/terminals`, { body: { cols: 80, rows: 24 } }))
    expect(status).toBeGreaterThanOrEqual(501)
    expect(['terminal-unavailable', 'terminal-unsupported']).toContain(code)
  })

  it('starts no shell when the audit record fails', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const sessionId = await startSession(desktop)
    vi.spyOn(t.host.security.audit, 'append').mockRejectedValue(new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行'))
    expect(await refusal(await desktop.request(`tasks/${sessionId}/terminals`, { body: { cols: 80, rows: 24 } }))).toEqual([
      503,
      'audit-unavailable',
    ])
    expect(launched).toHaveLength(0)
    vi.restoreAllMocks()
    expect(await desktop.json(`tasks/${sessionId}/terminals`)).toEqual({ terminals: [] })
  })

  it('starts no shell for a device that lost its access while the open was audited', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const sessionId = await startSession(desktop)
    const { audit } = t.host.security
    const write = audit.append.bind(audit)
    const openedAfter = async (change: (device: TestDevice) => Promise<Response>) => {
      const device = await t.enroll({ listener: 'unix', name: 'Second Mac window' })
      const append = vi.spyOn(audit, 'append').mockImplementation(async event => {
        if (event.action === 'terminal.open') expect((await change(device)).status).toBe(200)
        return write(event)
      })
      const answer = await device.request(`tasks/${sessionId}/terminals`, { body: { cols: 80, rows: 24 } })
      append.mockRestore()
      return refusal(answer)
    }
    expect(await openedAfter(device => desktop.request(`devices/${device.id}`, { method: 'DELETE' }))).toEqual([401, 'device-revoked'])
    expect(await openedAfter(device => desktop.request(`devices/${device.id}`, { method: 'PATCH', body: { scopes: ['view'] } }))).toEqual([
      403,
      'scope-required',
    ])
    expect(await openedAfter(device => desktop.request(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'work' } }))).toEqual([
      403,
      'terminal-scope',
    ])
    expect(launched).toHaveLength(0)
    expect(await desktop.json(`tasks/${sessionId}/terminals`)).toEqual({ terminals: [] })
  })

  it('refuses to archive or delete from another device while a terminal runs, and leaves the session as it was', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    const sessionId = await startSession(desktop)
    await openTerminal(desktop, sessionId)
    const running = [409, 'terminal-running']
    expect(await refusal(await browser.request(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } }))).toEqual(running)
    expect(await refusal(await browser.request(`tasks/${sessionId}`, { method: 'DELETE' }))).toEqual(running)
    for (const action of ['archive', 'delete']) {
      const { results } = await browser.json<{ results: Array<{ ok: boolean; code?: string }> }>('tasks/batch', {
        body: { action, ids: [sessionId] },
      })
      expect(results).toEqual([expect.objectContaining({ id: sessionId, ok: false, code: 'terminal-running' })])
    }
    expect(await archived(desktop, sessionId)).toBeUndefined()
    expect(launched[0]!.closed).toBe(false)
    // What does not end a session passes.
    const renamed = await browser.request(`tasks/${sessionId}`, { method: 'PATCH', body: { title: '新标题' } })
    expect(renamed.status).toBe(200)
    expect((await browser.request(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: false } })).status).toBe(200)
    expect(launched[0]!.closed).toBe(false)

    // Once the shell has exited nothing runs there, and the other device may go on.
    launched[0]!.emit({ type: 'exit', code: 0 })
    expect((await browser.request(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })).status).toBe(200)
    expect(await archived(desktop, sessionId)).toBe(true)
  })

  it('on this computer, archive and delete end the terminals, a busy one only after it was closed with force', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const sessionId = await startSession(desktop)
    const base = `tasks/${sessionId}/terminals`
    const busy = await openTerminal(desktop, sessionId)
    await openTerminal(desktop, sessionId)
    const stream = await watch(desktop, `${base}/${busy.id}/stream`)
    launched[0]!.emit({ type: 'foreground', busy: true, name: 'vim' })
    expect(await refusal(await desktop.request(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } }))).toEqual([
      409,
      'terminal-busy',
    ])
    expect(await refusal(await desktop.request(`tasks/${sessionId}`, { method: 'DELETE' }))).toEqual([409, 'terminal-busy'])
    expect(await archived(desktop, sessionId)).toBeUndefined()
    expect(launched.map(terminal => terminal.closed)).toEqual([false, false])

    expect((await desktop.request(`${base}/${busy.id}/close`, { body: { force: true } })).status).toBe(200)
    await vi.waitFor(() => expect(stream.state.done).toBe(true))
    expect((await desktop.request(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })).status).toBe(200)
    expect(launched.map(terminal => terminal.closed)).toEqual([true, true])
    expect(await refusal(await desktop.request(base, { body: { cols: 80, rows: 24 } }))).toEqual([409, 'terminal-session-archived'])
    expect((await desktop.request(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: false } })).status).toBe(200)

    await openTerminal(desktop, sessionId)
    // A delete refused for its own reasons costs no shell.
    const refused = vi.spyOn(t.host.bridge, 'remove').mockRejectedValueOnce(new AppError(409, 'task-running', '任务仍在运行'))
    expect(await refusal(await desktop.request(`tasks/${sessionId}`, { method: 'DELETE' }))).toEqual([409, 'task-running'])
    expect(launched.at(-1)!.closed).toBe(false)
    refused.mockRestore()
    await vi.waitFor(async () => expect((await t.host.bridge.detail(sessionId)).summary.status).toBe('idle'))
    const deleted = await desktop.request(`tasks/${sessionId}`, { method: 'DELETE' })
    expect(await deleted.json()).toEqual({ deleted: true })
    expect(launched.at(-1)!.closed).toBe(true)
    expect(await refusal(await desktop.request(base, { body: { cols: 80, rows: 24 } }))).toEqual([404, 'task-not-found'])
  })

  it('ends a terminal opened as its session ends, whichever route ended it', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const sessionId = await startSession(desktop)
    await openTerminal(desktop, sessionId)
    launched[0]!.emit({ type: 'foreground', busy: true, name: 'vim' })
    // A session ended past the routes' check, as when a terminal opened right after it.
    await t.host.bridge.updateMeta(sessionId, { archived: true })
    await vi.waitFor(() => expect(launched[0]!.closed).toBe(true))
  })

  it('ends a stream as soon as its device is revoked', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const second = await t.enroll({ listener: 'unix', name: 'Second Mac window' })
    const sessionId = await startSession(desktop)
    const { id } = await openTerminal(second, sessionId)
    const stream = await watch(second, `tasks/${sessionId}/terminals/${id}/stream`)
    await vi.waitFor(() => expect(stream.frames('terminal')).toHaveLength(1))
    const revoked = await desktop.request(`devices/${second.id}`, { method: 'DELETE' })
    expect(revoked.status).toBe(200)
    await vi.waitFor(() => expect(stream.state.done).toBe(true))
    expect(stream.frames('closed')).toEqual([])
    const before = stream.state.text
    launched[0]!.emit({ type: 'output', data: Buffer.from('a secret printed later\r\n') })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stream.state.text).toBe(before)
  })

  it('ends a stream once its device loses run or the full data scope, before writing anything more', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const sessionId = await startSession(desktop)
    for (const change of [{ scopes: ['view'] }, { dataScope: 'work' }]) {
      const { id } = await openTerminal(desktop, sessionId)
      const second = await t.enroll({ listener: 'unix', name: 'Second Mac window' })
      const stream = await watch(second, `tasks/${sessionId}/terminals/${id}/stream`)
      await vi.waitFor(() => expect(stream.frames('terminal')).toHaveLength(1))
      expect((await desktop.request(`devices/${second.id}`, { method: 'PATCH', body: change })).status).toBe(200)
      launched.at(-1)!.emit({ type: 'output', data: Buffer.from('a secret printed later\r\n') })
      await vi.waitFor(() => expect(stream.state.done).toBe(true))
      expect(stream.output()).toBe('')
      expect(stream.frames('closed')).toEqual([])
    }
  })

  it('ends a stream once its credential is due for renewal or past its grace window', async () => {
    let clock = Date.now()
    const { desktop, launched } = await hostWithTerminals({ now: () => clock })
    const sessionId = await startSession(desktop)
    const { id } = await openTerminal(desktop, sessionId)
    const path = `tasks/${sessionId}/terminals/${id}/stream`
    const print = (text: string) => launched[0]!.emit({ type: 'output', data: Buffer.from(text) })

    const overdue = await watch(desktop, path)
    await vi.waitFor(() => expect(overdue.frames('terminal')).toHaveLength(1))
    clock += 25 * 3600_000
    print('after-deadline')
    await vi.waitFor(() => expect(overdue.state.done).toBe(true))
    expect(overdue.output()).toBe('')

    await desktop.renew()
    const rotated = await watch(desktop, path)
    await vi.waitFor(() => expect(rotated.output()).toBe('after-deadline'))
    clock += 2 * 60_000
    await desktop.renew()
    const current = await watch(desktop, path)
    await vi.waitFor(() => expect(current.output()).toBe('after-deadline'))
    // A rotated-out credential keeps its stream only through the grace window.
    print(' within-grace')
    await vi.waitFor(() => expect(rotated.output()).toBe('after-deadline within-grace'))
    clock += 2 * 60_000
    print(' after-grace')
    await vi.waitFor(() => expect(current.output()).toBe('after-deadline within-grace after-grace'))
    await vi.waitFor(() => expect(rotated.state.done).toBe(true))
    expect(rotated.output()).toBe('after-deadline within-grace')
    expect(current.state.done).toBe(false)
  })

  it('ends every terminal and stream when the Host stops', async () => {
    const launched: FakeTerminal[] = []
    const t = await startTestHost({
      terminal: {
        shell: { file: '/bin/sh', argv: ['sh'] },
        launch: (spec, onEvent) => {
          const terminal = new FakeTerminal(spec, onEvent)
          launched.push(terminal)
          onEvent({ type: 'started', pid: 1 })
          return terminal
        },
      },
    })
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const sessionId = await startSession(desktop)
    const { id } = await openTerminal(desktop, sessionId)
    const stream = await watch(desktop, `tasks/${sessionId}/terminals/${id}/stream`)
    await vi.waitFor(() => expect(stream.frames('terminal')).toHaveLength(1))
    launched[0]!.emit({ type: 'foreground', busy: true, name: 'vim' })
    await t.close()
    expect(launched[0]!.closed).toBe(true)
    await vi.waitFor(() => expect(stream.state.done).toBe(true))
    expect(stream.frames('closed')).toEqual([{}])
  })

  it('does not open where the session may no longer work', async () => {
    const { t, desktop, launched } = await hostWithTerminals()
    const sessionId = await startSession(desktop)
    const { cwd } = (await t.host.bridge.detail(sessionId)).summary
    await rm(cwd!, { recursive: true, force: true })
    expect(await refusal(await desktop.request(`tasks/${sessionId}/terminals`, { body: { cols: 80, rows: 24 } }))).toEqual([
      409,
      'terminal-folder-unavailable',
    ])
    expect(launched).toHaveLength(0)
    await mkdir(cwd!, { recursive: true })
  })

  it.runIf(process.platform === 'darwin')(
    'runs the real component: typed input comes back on the stream, and close leaves nothing',
    async () => {
      const compiled = await mkdtemp(join(tmpdir(), 'latch-pty-routes-'))
      cleanups.push(() => rm(compiled, { recursive: true, force: true }))
      const source = fileURLToPath(new URL('../../../native/macos/LatchTerminal.swift', import.meta.url))
      await mkdir(join(compiled, 'native/macos'), { recursive: true })
      await copyFile(source, join(compiled, 'native/macos/LatchTerminal.swift'))
      const binary = (await buildTerminalHelper(compiled))!
      const t = await startTestHost({ terminal: { binary, shell: { file: '/bin/sh', argv: ['sh', '-c', 'pwd; exec cat'] } } })
      cleanups.push(() => t.close())
      const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
      expect(await features(desktop)).toBe(true)
      const sessionId = await startSession(desktop)
      const { id } = await openTerminal(desktop, sessionId)
      const base = `tasks/${sessionId}/terminals/${id}`
      const stream = await watch(desktop, `${base}/stream`)
      await vi.waitFor(() => expect(stream.output()).toContain('\n'), { timeout: 10_000 })
      const typed = await desktop.request(`${base}/input`, { body: { data: Buffer.from('hello terminal\n').toString('base64') } })
      expect(typed.status).toBe(200)
      await vi.waitFor(() => expect(stream.output().match(/hello terminal/gu)?.length).toBe(2), { timeout: 10_000 })
      expect((await desktop.request(`${base}/close`, { body: {} })).status).toBe(200)
      await vi.waitFor(() => expect(stream.state.done).toBe(true))
      expect(await desktop.json(`tasks/${sessionId}/terminals`)).toEqual({ terminals: [] })
    },
    130_000,
  )
})
