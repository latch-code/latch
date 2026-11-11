import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LISTENER_CLASSES, TERMINALS_PER_SESSION } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { HelperEvent, LaunchTerminal, TerminalLaunch, TerminalProcess, TerminalSignal } from '../src/terminal/helper.ts'
import {
  SCROLLBACK_BYTES,
  SCROLLBACK_TOTAL_BYTES,
  TerminalService,
  type TerminalRequester,
  type TerminalServiceOptions,
  type TerminalStreamEvent,
} from '../src/terminal/service.ts'

const mac: TerminalRequester = { listener: 'unix', deviceId: 'dev_mac' }
const secondDevice: TerminalRequester = { listener: 'unix', deviceId: 'dev_other' }
const phone: TerminalRequester = { listener: 'native-direct', deviceId: 'dev_phone' }
const remote = LISTENER_CLASSES.filter(listener => listener !== 'unix')
// Assembled at run time, so the source never holds a key-shaped line.
const modelKey = ['sk', 'proj', 'a1B2'.repeat(8)].join('-')

class FakeTerminal implements TerminalProcess {
  readonly inputs: Buffer[] = []
  readonly sizes: Array<[number, number]> = []
  readonly signals: TerminalSignal[] = []
  pendingInput = 0
  paused = false
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
  signal(signal: TerminalSignal) {
    this.signals.push(signal)
  }
  pauseOutput() {
    this.paused = true
  }
  resumeOutput() {
    this.paused = false
  }
  close() {
    if (!this.closed) {
      this.closed = true
      this.emit({ type: 'exit', signal: 1 })
      this.emit({ type: 'gone' })
    }
    return Promise.resolve()
  }
  print(text: string | Buffer) {
    this.emit({ type: 'output', data: Buffer.from(text) })
  }
}

let folder = ''
let launched: FakeTerminal[] = []
/** What the next launched helper reports first; `started` unless a test says otherwise. */
let firstEvent: HelperEvent | undefined

const launch: LaunchTerminal = (spec, onEvent) => {
  const terminal = new FakeTerminal(spec, onEvent)
  launched.push(terminal)
  const event = firstEvent
  if (event) queueMicrotask(() => onEvent(event))
  return terminal
}

function helperAt(index: number): FakeTerminal {
  const terminal = launched[index]
  if (!terminal) throw new Error(`no terminal ${index}`)
  return terminal
}

async function service(options: Partial<TerminalServiceOptions> = {}): Promise<TerminalService> {
  return TerminalService.open({
    sessionFolder: id => Promise.resolve(id.startsWith('missing') ? undefined : { path: folder }),
    hostEnv: {
      HOME: '/Users/me',
      USER: 'me',
      LATCH_API_KEY: 'model-key-value',
      OPENAI_API_KEY: 'model-key-value',
      NODE_OPTIONS: '--inspect',
    },
    launch,
    ...options,
  })
}

/** A sink that records events and reports a full transport while `full` is set. */
function recorder() {
  const events: TerminalStreamEvent[] = []
  const sink = {
    full: false,
    ended: false,
    events,
    write(event: TerminalStreamEvent) {
      events.push(event)
      return !sink.full
    },
    end() {
      sink.ended = true
    },
    output() {
      return Buffer.concat(events.flatMap(event => (event.type === 'output' ? [event.data] : []))).toString()
    },
    last() {
      return events.findLast(event => event.type === 'terminal')
    },
  }
  return sink
}

async function rejection(action: Promise<unknown> | (() => unknown)): Promise<AppError> {
  try {
    await (typeof action === 'function' ? action() : action)
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'latch-terminal-folder-')))
  launched = []
  firstEvent = { type: 'started', pid: 4242 }
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(folder, { recursive: true, force: true })
})

const coloured = (bytes: number) => '\x1b[31mx\x1b[0m'.repeat(Math.ceil(bytes / 10)).slice(0, bytes)

describe('terminal service', () => {
  it('opens, types in, resizes, signals and closes terminals only for this computer; every other listener only watches', async () => {
    const terminals = await service()
    for (const listener of remote) {
      const requester: TerminalRequester = { listener, deviceId: 'dev_remote' }
      expect((await rejection(terminals.create('s1', requester, { cols: 80, rows: 24 }))).code).toBe('local-only')
    }
    expect(launched).toHaveLength(0)
    const opened = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    expect(opened).toMatchObject({ status: 'running', sizeOwner: true, cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: opened.id }
    for (const listener of remote) {
      const requester: TerminalRequester = { listener, deviceId: 'dev_mac' }
      expect((await rejection(() => terminals.input(ref, requester, Buffer.from('rm -rf ~\r')))).code).toBe('local-only')
      expect((await rejection(() => terminals.resize(ref, requester, { cols: 40, rows: 10 }))).code).toBe('local-only')
      expect((await rejection(() => terminals.signal(ref, requester, 'SIGINT'))).code).toBe('local-only')
      expect((await rejection(terminals.close(ref, requester, { force: true }))).code).toBe('local-only')
      expect((await rejection(() => terminals.list('s1', requester))).code).toBe('local-only')
      const watcher = recorder()
      expect((await rejection(() => terminals.stream(ref, requester, watcher))).code).toBe('local-only')
      expect(watcher.events).toEqual([])
      expect((await rejection(() => terminals.extract(ref, requester))).code).toBe('local-only')
    }
    const helper = helperAt(0)
    expect([helper.inputs, helper.sizes, helper.signals]).toEqual([[], [], []])
    terminals.input(ref, mac, Buffer.from('ls\r'))
    terminals.signal(ref, mac, 'SIGINT')
    expect(helper.inputs.map(String)).toEqual(['ls\r'])
    expect(helper.signals).toEqual(['SIGINT'])
    await terminals.close(ref, mac)
    expect(helper.closed).toBe(true)
    expect(terminals.list('s1', mac)).toEqual([])
  })

  it('starts the login shell in the folder the Host resolves for the session, with a scrubbed environment', async () => {
    const sessionFolder = vi.fn((id: string) =>
      Promise.resolve(id === 'removed' ? ('removed' as const) : { path: id === 'deleted' ? join(folder, 'deleted') : folder }),
    )
    const terminals = await service({ sessionFolder })
    await terminals.create('s1', mac, { cols: 100, rows: 30 })
    expect(sessionFolder).toHaveBeenCalledWith('s1')
    const spec = helperAt(0).launch
    expect(spec.cwd).toBe(folder)
    expect(spec.argv[0]).toMatch(/^-/u)
    expect([spec.cols, spec.rows]).toEqual([100, 30])
    expect(spec.env).toMatchObject({ HOME: '/Users/me', USER: 'me', PWD: folder, TERM: 'xterm-256color', SHELL: spec.file })
    expect(Object.keys(spec.env).filter(name => /^(?:LATCH_|OPENAI_|NODE_)/iu.test(name))).toEqual([])
    expect((await rejection(terminals.create('removed', mac, { cols: 80, rows: 24 }))).code).toBe('terminal-folder-unavailable')
    expect((await rejection(terminals.create('deleted', mac, { cols: 80, rows: 24 }))).code).toBe('terminal-folder-unavailable')
    expect(launched).toHaveLength(1)
    const missing = await rejection((await service()).create('missing-session', mac, { cols: 80, rows: 24 }))
    expect([missing.status, missing.code]).toEqual([404, 'task-not-found'])
  })

  it('audits an open before the shell starts, and starts nothing when the audit fails', async () => {
    const opened: unknown[] = []
    const audited = await service({
      beforeOpen: event => {
        opened.push({ ...event, launched: launched.length })
        return Promise.resolve()
      },
    })
    const summary = await audited.create('s1', mac, { cols: 80, rows: 24 })
    expect(opened).toEqual([{ sessionId: 's1', terminalId: summary.id, deviceId: 'dev_mac', launched: 0 }])
    const failing = await service({ beforeOpen: () => Promise.reject(new AppError(500, 'audit-failed', '审计写入失败')) })
    expect((await rejection(failing.create('s1', mac, { cols: 80, rows: 24 }))).code).toBe('audit-failed')
    expect(launched).toHaveLength(1)
    expect(failing.list('s1', mac)).toEqual([])
  })

  it('allows eight terminals per session, also when they are opened at once, and caps all scrollback together', async () => {
    const terminals = await service()
    const results = await Promise.allSettled(
      Array.from({ length: TERMINALS_PER_SESSION + 2 }, () => terminals.create('s1', mac, { cols: 80, rows: 24 })),
    )
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(TERMINALS_PER_SESSION)
    const refused = results.flatMap(result => (result.status === 'rejected' && result.reason instanceof AppError ? [result.reason] : []))
    expect(refused.map(error => [error.status, error.code])).toEqual([
      [429, 'terminal-limit'],
      [429, 'terminal-limit'],
    ])
    const total = SCROLLBACK_TOTAL_BYTES / SCROLLBACK_BYTES
    for (let index = TERMINALS_PER_SESSION; index < total; index++)
      await terminals.create(`s${Math.floor(index / TERMINALS_PER_SESSION) + 1}`, mac, { cols: 80, rows: 24 })
    expect((await rejection(terminals.create('another', mac, { cols: 80, rows: 24 }))).code).toBe('terminal-total-limit')
    const [first] = terminals.list('s1', mac)
    if (!first) throw new Error('no terminal')
    await terminals.close({ sessionId: 's1', terminalId: first.id }, mac)
    await terminals.create('another', mac, { cols: 80, rows: 24 })
    expect((await rejection(terminals.create('s1', mac, { cols: 0, rows: 24 }))).code).toBe('terminal-size-invalid')
  })

  it('lets only the device that opened a terminal resize it, and tells watchers the new size after the output before it', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const watcher = recorder()
    terminals.stream(ref, mac, watcher)
    expect((await rejection(() => terminals.resize(ref, secondDevice, { cols: 50, rows: 20 }))).code).toBe('terminal-size-owner')
    expect((await rejection(() => terminals.resize(ref, phone, { cols: 50, rows: 20 }))).code).toBe('local-only')
    const helper = helperAt(0)
    expect(helper.sizes).toEqual([])
    helper.print('before\r\n')
    watcher.full = true
    helper.print('held back\r\n')
    expect(terminals.resize(ref, mac, { cols: 120, rows: 40 })).toMatchObject({ cols: 120, rows: 40, sizeOwner: true })
    expect(helper.sizes).toEqual([[120, 40]])
    // The new size waits behind the output the watcher has not taken yet.
    expect(watcher.last()).toMatchObject({ terminal: { cols: 80, rows: 24 } })
    expect(watcher.events.map(event => event.type)).toEqual(['terminal', 'output', 'output'])
  })

  it('replays the scrollback and then live output without gaps or repeats, and stops while the transport is full', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const helper = helperAt(0)
    helper.print('$ pnpm test\r\n')
    const slow = recorder()
    slow.full = true
    const handle = terminals.stream(ref, mac, slow)
    helper.print('a'.repeat(100_000))
    helper.print('b'.repeat(100_000))
    // One output event went out before the transport filled; the rest waits in the scrollback, not in memory per stream.
    expect(slow.events.filter(event => event.type === 'output')).toHaveLength(1)
    slow.full = false
    handle.resume()
    expect(slow.output()).toBe(`$ pnpm test\r\n${'a'.repeat(100_000)}${'b'.repeat(100_000)}`)
    let next = 0
    for (const event of slow.events) {
      if (event.type !== 'output') continue
      expect(event.offset).toBe(next)
      next = event.offset + event.data.length
    }
    helper.print('live\r\n')
    expect(slow.output().endsWith('live\r\n')).toBe(true)
    // A reconnect from the last offset gets only what came after it.
    const again = recorder()
    terminals.stream(ref, mac, again, { from: next })
    expect(again.output()).toBe('live\r\n')
    handle.close()
    helper.print('after close\r\n')
    expect(slow.output().includes('after close')).toBe(false)
  })

  it('keeps 512 KiB of scrollback and tells a reader that fell behind it to start again', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const helper = helperAt(0)
    const behind = recorder()
    behind.full = true
    const handle = terminals.stream(ref, mac, behind)
    for (let index = 0; index < 12; index++) helper.print(`${String(index).padStart(6, '0')}${'x'.repeat(65_529)}\n`)
    behind.full = false
    handle.resume()
    expect(behind.events.some(event => event.type === 'reset')).toBe(true)
    expect(behind.output().endsWith(`000011${'x'.repeat(65_529)}\n`)).toBe(true)
    const fresh = recorder()
    terminals.stream(ref, mac, fresh)
    expect(fresh.output()).toMatch(/^0000(?:0[4-9]|1[01])x/u)
    expect(fresh.output().length).toBeLessThanOrEqual(SCROLLBACK_BYTES)
    const stale = recorder()
    terminals.stream(ref, mac, stale, { from: 10 })
    expect(stale.events.map(event => event.type).slice(0, 2)).toEqual(['terminal', 'reset'])
  })

  it('stops reading a terminal that prints more than 8 MiB a second until the window ends', async () => {
    vi.useFakeTimers()
    const terminals = await service()
    const created = terminals.create('s1', mac, { cols: 80, rows: 24 })
    await vi.runAllTimersAsync()
    await created
    const helper = helperAt(0)
    helper.print(Buffer.alloc(1024 * 1024, 0x61))
    expect(helper.paused).toBe(false)
    helper.print(Buffer.alloc(1024 * 1024, 0x62))
    expect(helper.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(helper.paused).toBe(false)
  })

  it('announces the local services the output names, newest first, and forgets them when the shell ends', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const watcher = recorder()
    terminals.stream(ref, mac, watcher)
    const helper = helperAt(0)
    helper.print('  VITE v7.1.4  ready in 412 ms\r\n\r\n  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n')
    helper.print('Storybook at http://127.0.0.1:6006/?token=abc\r\nagain http://localhost:5173/\r\n')
    expect(terminals.list('s1', mac)[0]?.services).toEqual([
      { origin: 'http://localhost:5173', port: 5173 },
      { origin: 'http://127.0.0.1:6006', port: 6006 },
    ])
    expect(watcher.last()).toMatchObject({ terminal: { services: [{ port: 5173 }, { port: 6006 }] } })
    helper.emit({ type: 'exit', code: 130 })
    expect(terminals.list('s1', mac)[0]).toMatchObject({ status: 'exited', exitCode: 130, services: [] })
    expect((await rejection(() => terminals.input(ref, mac, Buffer.from('x')))).code).toBe('terminal-ended')
  })

  it('reports terminals running a command and their local services to the install gate', async () => {
    const terminals = await service()
    await terminals.create('s1', mac, { cols: 80, rows: 24 })
    await terminals.create('s1', mac, { cols: 80, rows: 24 })
    expect(terminals.activity()).toEqual({ terminals: 0, services: 0 })
    const helper = helperAt(0)
    helper.emit({ type: 'foreground', busy: true, name: 'node' })
    helper.print('  ➜  Local:   http://localhost:5173/\r\n')
    expect(terminals.activity()).toEqual({ terminals: 1, services: 1 })
    helper.emit({ type: 'exit', code: 0 })
    expect(terminals.activity()).toEqual({ terminals: 0, services: 0 })
  })

  it('refuses new terminals and typed input while the Host is about to stop for an update', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    terminals.setHeld(true)
    expect((await rejection(() => terminals.input({ sessionId: 's1', terminalId: id }, mac, Buffer.from('ls\r')))).code).toBe(
      'host-updating',
    )
    expect((await rejection(terminals.create('s1', mac, { cols: 80, rows: 24 }))).code).toBe('host-updating')
    terminals.setHeld(false)
    terminals.input({ sessionId: 's1', terminalId: id }, mac, Buffer.from('ls\r'))
  })

  it('asks before closing a terminal in which a program still runs', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const watcher = recorder()
    terminals.stream(ref, mac, watcher)
    const helper = helperAt(0)
    helper.emit({ type: 'foreground', busy: true, name: 'node' })
    expect(terminals.list('s1', mac)[0]).toMatchObject({ busy: true, foreground: 'node' })
    const busy = await rejection(terminals.close(ref, mac))
    expect([busy.status, busy.code, busy.details]).toEqual([409, 'terminal-busy', { foreground: 'node' }])
    expect(helper.closed).toBe(false)
    await terminals.close(ref, mac, { force: true })
    expect(helper.closed).toBe(true)
    expect(watcher.ended).toBe(true)
    expect((await rejection(() => terminals.input(ref, mac, Buffer.from('x')))).code).toBe('terminal-not-found')
  })

  it('attaches the selection or the last lines as plain text, with secrets redacted on the Host', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const rows = Array.from({ length: 300 }, (_, row) => `row ${row}\r\n`).join('')
    helperAt(0).print(`\x1b[32m$\x1b[0m cat .env\r\nOPENAI_API_KEY=${modelKey}\r\n${rows}`)
    const tail = terminals.extract(ref, mac)
    expect(tail).toMatchObject({ lines: 200, truncated: true, redacted: false })
    expect(tail.text.split('\n').at(-1)).toBe('row 299')
    expect(terminals.extract(ref, mac, { lines: 3 }).text).toBe('row 297\nrow 298\nrow 299')
    const selection = terminals.extract(ref, mac, { selection: `$ cat .env\nOPENAI_API_KEY=${modelKey}\n` })
    expect(selection).toEqual({
      text: '$ cat .env\nOPENAI_API_KEY=[redacted]',
      lines: 2,
      truncated: false,
      redacted: true,
      mayContainSecret: true,
    })
    expect((await rejection(() => terminals.extract(ref, mac, { lines: 201 }))).code).toBe('terminal-lines-invalid')
    expect((await rejection(() => terminals.extract({ sessionId: 'other', terminalId: id }, mac))).code).toBe('terminal-not-found')
  })

  it('bounds the work of 「加入对话」 on crafted output, and how often each device may ask', async () => {
    let clock = Date.parse('2026-10-27T00:00:00Z')
    const terminals = await service({ now: () => clock })
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const wide = 'x'.repeat(4000)
    for (const crafted of [`${wide}${'\x1b[2Ky'.repeat(50_000)}`, `${wide}${'\x1b[1K'.repeat(60_000)}`]) {
      let started = performance.now()
      terminals.extract(ref, mac, { selection: crafted })
      expect(performance.now() - started).toBeLessThan(1000)
      helperAt(0).print(crafted)
      started = performance.now()
      terminals.extract(ref, mac)
      expect(performance.now() - started).toBeLessThan(1000)
    }
    for (let asked = 4; asked < 20; asked++) terminals.extract(ref, mac, { lines: 1 })
    const busy = await rejection(() => terminals.extract(ref, mac, { lines: 1 }))
    expect([busy.status, busy.code]).toEqual([429, 'terminal-extract-busy'])
    // The window ends.
    clock += 10_000
    terminals.extract(ref, mac, { lines: 1 })
  })

  it('caps the watchers of a terminal', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    const watchers = Array.from({ length: 8 }, () => terminals.stream(ref, mac, recorder()))
    const full = await rejection(() => terminals.stream(ref, secondDevice, recorder()))
    expect([full.status, full.code]).toEqual([429, 'terminal-streams'])
    watchers[0].close()
    terminals.stream(ref, secondDevice, recorder())
  })

  it('refuses oversized input and input the terminal has not caught up with', async () => {
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    const ref = { sessionId: 's1', terminalId: id }
    expect((await rejection(() => terminals.input(ref, mac, Buffer.alloc(64 * 1024 + 1)))).code).toBe('terminal-input-too-large')
    helperAt(0).pendingInput = 1024 * 1024
    expect((await rejection(() => terminals.input(ref, mac, Buffer.from('x')))).code).toBe('terminal-input-busy')
  })

  it('attaches the last lines of a cut window however few line breaks it holds', async () => {
    for (const width of [3913, 3000, 5000]) {
      const terminals = await service()
      const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
      helperAt(launched.length - 1).print(`${'x'.repeat(width - 2)}\r\n`.repeat(Math.ceil(700_000 / width)))
      const text = terminals.extract({ sessionId: 's1', terminalId: id }, mac)
      expect(text.truncated).toBe(true)
      expect(text.lines).toBe(Math.floor((32_000 + 1) / (width - 1)))
    }
  })

  it('never attaches the tail of a secret that the read window cut', async () => {
    const window = 256 * 1024
    const key = `sk-proj-${'Ab12'.repeat(40)}`
    for (const cutInto of [8, 20, 100]) {
      const terminals = await service()
      const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
      const ref = { sessionId: 's1', terminalId: id }
      const after = window - (key.length - cutInto)
      helperAt(launched.length - 1).print(`first ${key}${coloured(after - 8)}\r\nkept\r\n`)
      const text = terminals.extract(ref, mac)
      expect(text.text).toBe('kept')
      expect(text.truncated).toBe(true)
      const unbroken = await terminals.create('s1', mac, { cols: 80, rows: 24 })
      helperAt(launched.length - 1).print(`first ${key}${coloured(after)}`)
      expect(terminals.extract({ sessionId: 's1', terminalId: unbroken.id }, mac)).toEqual({
        text: '',
        lines: 0,
        truncated: true,
        redacted: false,
        mayContainSecret: false,
      })
    }
    const terminals = await service()
    const { id } = await terminals.create('s1', mac, { cols: 80, rows: 24 })
    // The window starts right after a line break: that first line is whole, so it stays.
    helperAt(launched.length - 1).print(`older\nwhole ${coloured(window - 7)}\n`)
    const whole = terminals.extract({ sessionId: 's1', terminalId: id }, mac)
    expect(whole.text.startsWith('whole x')).toBe(true)
    expect(whole.truncated).toBe(true)
  })

  it('reports a shell that could not start, and frees its place', async () => {
    firstEvent = { type: 'failed', reason: 'exec' }
    const terminals = await service()
    const failed = await rejection(terminals.create('s1', mac, { cols: 80, rows: 24 }))
    expect([failed.status, failed.code]).toEqual([500, 'terminal-shell-unavailable'])
    firstEvent = { type: 'failed', reason: 'cwd' }
    expect((await rejection(terminals.create('s1', mac, { cols: 80, rows: 24 }))).code).toBe('terminal-folder-unavailable')
    expect(launched.every(terminal => terminal.closed)).toBe(true)
    expect(terminals.list('s1', mac)).toEqual([])
  })

  it("ends an archived session's terminals only from this computer, busy ones only when forced, and every terminal when the Host stops", async () => {
    const terminals = await service()
    await terminals.create('s1', mac, { cols: 80, rows: 24 })
    await terminals.create('s1', mac, { cols: 80, rows: 24 })
    await terminals.create('s2', mac, { cols: 80, rows: 24 })
    helperAt(0).emit({ type: 'foreground', busy: true, name: 'vim' })
    for (const listener of remote) {
      const elsewhere = await rejection(terminals.closeSession('s1', { ...phone, listener }))
      expect([elsewhere.status, elsewhere.code]).toEqual([409, 'terminal-running'])
    }
    const busy = await rejection(terminals.closeSession('s1', mac))
    expect([busy.status, busy.code, busy.details]).toEqual([409, 'terminal-busy', { foreground: 'vim' }])
    expect(launched.map(terminal => terminal.closed)).toEqual([false, false, false])
    await terminals.closeSession('s1', mac, { force: true })
    expect(launched.map(terminal => terminal.closed)).toEqual([true, true, false])
    expect(terminals.list('s2', mac)).toHaveLength(1)
    await terminals.closeSession('s1', phone)
    firstEvent = undefined
    const starting = terminals.create('s3', mac, { cols: 80, rows: 24 })
    await vi.waitFor(() => expect(launched).toHaveLength(4))
    await terminals.shutdown()
    expect(launched.every(terminal => terminal.closed)).toBe(true)
    expect((await rejection(starting)).code).toBe('terminal-closed')
    expect((await rejection(terminals.create('s2', mac, { cols: 80, rows: 24 }))).code).toBe('terminal-stopping')
  })

  it('offers no terminal without the helper, and says so plainly', async () => {
    const missing = await TerminalService.open({ sessionFolder: () => Promise.resolve({ path: folder }) }, join(folder, 'latch-pty'))
    expect(missing.available).toBe(false)
    const error = await rejection(missing.create('s1', mac, { cols: 80, rows: 24 }))
    expect([error.status, error.code]).toEqual(
      process.platform === 'darwin' ? [503, 'terminal-unavailable'] : [501, 'terminal-unsupported'],
    )
  })
})
