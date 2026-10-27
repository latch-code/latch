// The Host's terminals: one login shell per terminal, in the session's primary folder, on a pty that latch-pty
// (native/macos/LatchTerminal.swift) owns. The shell runs as the user, like any terminal: no approval, path rule or
// outbound policy applies to what runs in it. Only this computer (host.sock) opens, types in, resizes and closes a
// terminal; every other device may only watch. Routes stay thin: each method takes the requester and does its own checks.
import { randomUUID } from 'node:crypto'
import { lstat, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { isLocalListener, type DataScope, type ListenerClass } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { redactSecrets } from '@latch/core/node-kit'
import { localOnly } from '../access.ts'
import { latchCodeRoot } from '../paths.ts'
import { loginShell, terminalEnvironment, type ShellCommand } from './environment.ts'
import {
  helperLauncher,
  type HelperEvent,
  type LaunchTerminal,
  type TerminalFailure,
  type TerminalProcess,
  type TerminalSignal,
} from './helper.ts'
import { LocalServiceDetector, type LocalService } from './localhost.ts'
import { Scrollback } from './scrollback.ts'
import { ATTACH_LINE_LIMIT, attachmentText, tailOfLines, type TerminalText } from './text.ts'

export const TERMINALS_PER_SESSION = 8
export const SCROLLBACK_BYTES = 512 * 1024
/** All terminals' scrollback together, so at most 32 terminals on this computer at once. */
export const SCROLLBACK_TOTAL_BYTES = 16 * 1024 * 1024
/** The most one input call carries. */
const INPUT_BYTES = 64 * 1024
/** Input the helper has not taken yet beyond this refuses more until the terminal catches up. */
const PENDING_INPUT_BYTES = 1024 * 1024
const SIZE_LIMIT = 1000
const SELECTION_BYTES = 256 * 1024
/** Of the scrollback, 「加入对话」 decodes at most the newest this many bytes. */
const EXTRACT_BYTES = 256 * 1024
/** 「加入对话」 per device: at most this many in a window. */
const EXTRACT_WINDOW_MS = 10_000
const EXTRACTS_PER_WINDOW = 20
/**
 * Watchers per terminal. This computer has slots of its own, so watchers elsewhere can never lock it out of its own
 * terminal, and no device takes more than its share.
 */
const LOCAL_STREAMS = 8
const REMOTE_STREAMS = 8
const STREAMS_PER_DEVICE = 4
const STREAM_CHUNK_BYTES = 64 * 1024
/**
 * A terminal that prints more than this in a window is not read again until the window ends (8 MiB/s): a runaway
 * program waits instead of taking the Host's time from every other session.
 */
const OUTPUT_WINDOW_MS = 250
const OUTPUT_WINDOW_BYTES = 2 * 1024 * 1024
const START_DEADLINE_MS = 10_000
const SIGNALS: ReadonlySet<TerminalSignal> = new Set(['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL'])

/** Who asks. The service applies the input rule itself rather than trusting each route to. */
export interface TerminalRequester {
  /** The listener the request arrived on: only host.sock counts as this computer. */
  listener: ListenerClass
  /** The requesting device; the device that opened a terminal decides its size. */
  deviceId: string
  /** Away from host.sock, output reaches only a device whose data scope is `all`, as file contents do. */
  dataScope: DataScope
}

/** A terminal is always addressed together with its session, which the route has already authorized. */
export interface TerminalRef {
  sessionId: string
  terminalId: string
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalSummary {
  id: string
  sessionId: string
  /** The shell's name and the folder's, for the tab: 「zsh · latch」. */
  shell: string
  folder: string
  cols: number
  rows: number
  status: 'running' | 'exited' | 'failed'
  exitCode?: number
  exitSignal?: string
  /** A program other than the shell has the terminal: closing asks first. */
  busy: boolean
  /** That program's name, when the system reports one. */
  foreground?: string
  /** Development servers the output announced, newest first. */
  services: LocalService[]
  /** The requester may open, type in and close terminals (this computer only). */
  writable: boolean
  /** The requester decides this terminal's size. */
  sizeOwner: boolean
  createdAt: string
}

export type TerminalStreamEvent =
  /** First, and again after output whenever the summary changed (size, foreground, services, exit). */
  | { type: 'terminal'; terminal: TerminalSummary }
  /** `offset` is where `data` starts in everything the terminal printed; replays and live output never overlap. */
  | { type: 'output'; offset: number; data: Buffer }
  /** Output before `offset` is no longer kept: the reader clears its screen and continues from there. */
  | { type: 'reset'; offset: number }

export interface TerminalStreamSink {
  /** Returns false when the transport is full: no more output until `resume()`. */
  write(event: TerminalStreamEvent): boolean
  /** The terminal was closed or the Host stops. */
  end(): void
}

export interface TerminalStream {
  /** The transport drained: continue from where the stream stopped. */
  resume(): void
  close(): void
}

export interface TerminalServiceOptions {
  /**
   * The session's primary folder, which the Host takes from the session record: undefined when there is no such
   * session, `removed` when its folder is no longer one the session may use. No caller ever names a folder.
   */
  sessionFolder(sessionId: string): Promise<{ path: string } | 'removed' | undefined>
  /** Runs once an open is accepted and before the shell starts; a rejection stops it (audit before execution). */
  beforeOpen?(event: { sessionId: string; terminalId: string; deviceId: string }): Promise<void>
  hostEnv?: NodeJS.ProcessEnv
  now?: () => number
  log?: (text: string) => void
  /** Test seams; the Host never sets them. */
  launch?: LaunchTerminal
  shell?: ShellCommand
}

interface StreamState {
  requester: TerminalRequester
  sink: TerminalStreamSink
  cursor: number
  paused: boolean
  closed: boolean
  /** The summary changed: it follows the output that was there when it did. */
  summaryDue: boolean
}

interface Terminal {
  id: string
  sessionId: string
  owner: string
  shell: string
  folder: string
  cols: number
  rows: number
  createdAt: number
  status: 'starting' | TerminalSummary['status']
  exitCode?: number
  exitSignal?: string
  busy: boolean
  foreground?: string
  services: LocalService[]
  scrollback: Scrollback
  detector: LocalServiceDetector
  process?: TerminalProcess
  streams: Set<StreamState>
  starting?: { resolve(): void; reject(error: AppError): void }
  ending?: Promise<void>
  window: { start: number; bytes: number }
  outputPaused: boolean
  resumeTimer?: NodeJS.Timeout
}

function startFailure(reason: TerminalFailure): AppError {
  if (reason === 'cwd') return new AppError(409, 'terminal-folder-unavailable', '会话的文件夹已不可用，不能在这里打开终端')
  if (reason === 'exec') return new AppError(500, 'terminal-shell-unavailable', '没能启动 shell，终端没有打开')
  return new AppError(500, 'terminal-start-failed', '终端没有启动，请重试')
}

function notFound(): AppError {
  return new AppError(404, 'terminal-not-found', '找不到这个终端')
}

/** A program other than the shell runs in the terminal: closing it needs the user's confirmation first. */
function busyError(terminal: Terminal): AppError {
  return new AppError(
    409,
    'terminal-busy',
    terminal.foreground ? `「${terminal.foreground}」还在运行，确认后再关闭` : '终端里还有程序在运行，确认后再关闭',
    terminal.foreground ? { foreground: terminal.foreground } : undefined,
  )
}

function checkedSize(size: TerminalSize): TerminalSize {
  const valid = (value: number) => Number.isInteger(value) && value >= 1 && value <= SIZE_LIMIT
  if (!valid(size.cols) || !valid(size.rows)) throw new AppError(400, 'terminal-size-invalid', `终端的行列数应在 1 到 ${SIZE_LIMIT} 之间`)
  return { cols: size.cols, rows: size.rows }
}

/** Names reach every watching device: no control or invisible characters, no secret shapes, short. */
function programName(name: string): string | undefined {
  const clean = redactSecrets(name.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim()).slice(0, 64)
  return clean === '' ? undefined : clean
}

function signalName(number: number): string {
  return Object.entries(constants.signals).find(([, value]) => value === number)?.[0] ?? `SIG${number}`
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false
}

export class TerminalService {
  private readonly terminals = new Map<string, Terminal>()
  /** Closing terminals still count against the limits until their helper has really exited. */
  private readonly ending = new Set<Terminal>()
  private readonly extracts = new Map<string, { start: number; count: number }>()
  private stopping = false
  private readonly now: () => number

  private constructor(
    /** Why there is no terminal here: not macOS, or the helper is missing. */
    readonly unavailable: 'platform' | 'helper' | undefined,
    private readonly launch: LaunchTerminal | undefined,
    private readonly options: TerminalServiceOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  static async open(options: TerminalServiceOptions, binary = join(latchCodeRoot(), 'dist/native/latch-pty')): Promise<TerminalService> {
    if (options.launch) return new TerminalService(undefined, options.launch, options)
    if (process.platform !== 'darwin') return new TerminalService('platform', undefined, options)
    const info = await lstat(binary).catch(() => undefined)
    const usable = !!info?.isFile() && !!(info.mode & 0o111)
    return usable ? new TerminalService(undefined, helperLauncher(binary), options) : new TerminalService('helper', undefined, options)
  }

  get available(): boolean {
    return this.unavailable === undefined
  }

  list(sessionId: string, requester: TerminalRequester): TerminalSummary[] {
    return [...this.terminals.values()]
      .filter(terminal => terminal.sessionId === sessionId && terminal.status !== 'starting')
      .map(terminal => this.summary(terminal, requester))
  }

  async create(sessionId: string, requester: TerminalRequester, size: TerminalSize): Promise<TerminalSummary> {
    this.admit(requester)
    if (this.unavailable === 'platform') throw new AppError(501, 'terminal-unsupported', '终端尚未实现：目前只支持 macOS')
    const launch = this.launch
    if (!launch) throw new AppError(503, 'terminal-unavailable', '终端组件不可用，请重新构建 Latch')
    if (this.stopping) throw new AppError(503, 'terminal-stopping', 'Latch 正在停止，不能打开终端')
    const { cols, rows } = checkedSize(size)
    if (this.count(terminal => terminal.sessionId === sessionId) >= TERMINALS_PER_SESSION)
      throw new AppError(429, 'terminal-limit', `每个会话最多 ${TERMINALS_PER_SESSION} 个终端`)
    if ((this.count(() => true) + 1) * SCROLLBACK_BYTES > SCROLLBACK_TOTAL_BYTES)
      throw new AppError(429, 'terminal-total-limit', '这台电脑上打开的终端太多了，请先关闭不用的终端')
    // Counted from here on, before anything is awaited, so concurrent opens cannot pass the limits together.
    const terminal: Terminal = {
      id: `term_${randomUUID()}`,
      sessionId,
      owner: requester.deviceId,
      shell: '',
      folder: '',
      cols,
      rows,
      createdAt: this.now(),
      status: 'starting',
      busy: false,
      services: [],
      scrollback: new Scrollback(SCROLLBACK_BYTES),
      detector: new LocalServiceDetector(),
      streams: new Set(),
      window: { start: 0, bytes: 0 },
      outputPaused: false,
    }
    this.terminals.set(terminal.id, terminal)
    try {
      const resolved = await this.options.sessionFolder(sessionId)
      if (resolved === undefined) throw new AppError(404, 'task-not-found', '找不到该会话')
      if (resolved === 'removed' || !isAbsolute(resolved.path) || !(await isDirectory(resolved.path))) throw startFailure('cwd')
      const folder = resolved.path
      const shell = this.options.shell ?? (await loginShell())
      terminal.shell = basename(shell.file)
      terminal.folder = basename(folder)
      // Closed while the folder was resolved (its session ended, the Host stops): no audit record, no shell.
      if (terminal.ending) throw new AppError(409, 'terminal-closed', '终端已关闭')
      await this.options.beforeOpen?.({ sessionId, terminalId: terminal.id, deviceId: requester.deviceId })
      if (terminal.ending) throw new AppError(409, 'terminal-closed', '终端已关闭')
      const env = terminalEnvironment({ hostEnv: this.options.hostEnv ?? process.env, shell: shell.file, folder })
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined
        const settle = (error?: AppError) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        terminal.starting = { resolve: () => settle(), reject: settle }
        terminal.process = launch({ file: shell.file, argv: shell.argv, env, cwd: folder, cols, rows }, event =>
          this.onEvent(terminal, event),
        )
        if (terminal.starting) timer = setTimeout(() => terminal.starting?.reject(startFailure('helper')), START_DEADLINE_MS)
      })
      return this.summary(terminal, requester)
    } catch (error) {
      terminal.starting = undefined
      await this.end(terminal)
      throw error instanceof AppError ? error : startFailure('helper')
    }
  }

  input(ref: TerminalRef, requester: TerminalRequester, data: Uint8Array): void {
    this.admit(requester)
    const terminal = this.find(ref)
    if (terminal.status !== 'running' || !terminal.process) throw new AppError(409, 'terminal-ended', '终端已结束')
    if (data.length > INPUT_BYTES) throw new AppError(413, 'terminal-input-too-large', `一次最多输入 ${INPUT_BYTES / 1024} KB`)
    if (data.length === 0) return
    if (terminal.process.pendingInput + data.length > PENDING_INPUT_BYTES)
      throw new AppError(429, 'terminal-input-busy', '终端还没处理完之前的输入，请稍后再试')
    terminal.process.input(data)
  }

  /** One size owner: the device that opened the terminal. Watching from elsewhere never resizes it. */
  resize(ref: TerminalRef, requester: TerminalRequester, size: TerminalSize): TerminalSummary {
    this.admit(requester)
    const terminal = this.find(ref)
    if (requester.deviceId !== terminal.owner) throw new AppError(409, 'terminal-size-owner', '终端的大小由打开它的设备决定')
    const { cols, rows } = checkedSize(size)
    if (terminal.status === 'running' && terminal.process && (cols !== terminal.cols || rows !== terminal.rows)) {
      terminal.process.resize(cols, rows)
      terminal.cols = cols
      terminal.rows = rows
      this.changed(terminal)
    }
    return this.summary(terminal, requester)
  }

  /** Sent to the program in the foreground, as Ctrl-C would be. */
  signal(ref: TerminalRef, requester: TerminalRequester, signal: TerminalSignal): void {
    this.admit(requester)
    const terminal = this.find(ref)
    if (!SIGNALS.has(signal)) throw new AppError(400, 'terminal-signal-invalid', '不支持这个信号')
    if (terminal.status !== 'running' || !terminal.process) throw new AppError(409, 'terminal-ended', '终端已结束')
    terminal.process.signal(signal)
  }

  /** Closing a terminal in which a program still runs needs `force`, which the client sends once the user confirmed. */
  async close(ref: TerminalRef, requester: TerminalRequester, options: { force?: boolean } = {}): Promise<void> {
    this.admit(requester)
    const terminal = this.find(ref)
    if (terminal.status === 'running' && terminal.busy && !options.force) throw busyError(terminal)
    await this.end(terminal)
  }

  /**
   * The session is archived or deleted. On this computer its terminals end under the rules of `close`. Elsewhere the
   * request is refused while any of them runs, so archiving from another device never ends a shell on this one.
   */
  async closeSession(sessionId: string, requester: TerminalRequester, options: { force?: boolean } = {}): Promise<void> {
    const terminals = [...this.terminals.values()].filter(terminal => terminal.sessionId === sessionId)
    const running = terminals.filter(terminal => terminal.status === 'running' || terminal.status === 'starting')
    if (!isLocalListener(requester.listener)) {
      if (running.length > 0) throw new AppError(409, 'terminal-running', '这个会话还有终端在运行，请先在 Mac 上关闭终端')
    } else if (!options.force) {
      const occupied = running.find(terminal => terminal.busy)
      if (occupied) throw busyError(occupied)
    }
    await Promise.all(terminals.map(terminal => this.end(terminal)))
  }

  /** The Host stops: every terminal ends, and none opens again. */
  async shutdown(): Promise<void> {
    this.stopping = true
    await Promise.all([...this.terminals.values()].map(terminal => this.end(terminal)))
    await Promise.all([...this.ending].flatMap(terminal => terminal.ending ?? []))
  }

  /** Replays what is kept from `from` (or from the start), then live output, honouring the sink's back-pressure. */
  stream(ref: TerminalRef, requester: TerminalRequester, sink: TerminalStreamSink, options: { from?: number } = {}): TerminalStream {
    this.admitOutput(requester)
    const terminal = this.find(ref)
    this.admitStream(terminal, requester)
    const { scrollback } = terminal
    const from = options.from
    const resumes = from !== undefined && Number.isSafeInteger(from) && from >= scrollback.start && from <= scrollback.end
    const state: StreamState = {
      requester,
      sink,
      cursor: resumes ? from : scrollback.replayStart(),
      paused: false,
      closed: false,
      summaryDue: false,
    }
    terminal.streams.add(state)
    sink.write({ type: 'terminal', terminal: this.summary(terminal, requester) })
    if (from !== undefined && !resumes && !sink.write({ type: 'reset', offset: state.cursor })) state.paused = true
    this.pump(terminal, state)
    return {
      resume: () => {
        if (state.closed) return
        state.paused = false
        this.pump(terminal, state)
      },
      close: () => {
        state.closed = true
        terminal.streams.delete(state)
      },
    }
  }

  /**
   * 「加入对话」: the selection the client sends, or the last lines of the output, as plain text through redactSecrets.
   * Its work is linear in input of bounded size, and each device may ask EXTRACTS_PER_WINDOW times per window.
   */
  extract(ref: TerminalRef, requester: TerminalRequester, options: { lines?: number; selection?: string } = {}): TerminalText {
    this.admitOutput(requester)
    const terminal = this.find(ref)
    const lines = options.lines ?? ATTACH_LINE_LIMIT
    if (!Number.isInteger(lines) || lines < 1 || lines > ATTACH_LINE_LIMIT)
      throw new AppError(400, 'terminal-lines-invalid', `一次最多加入 ${ATTACH_LINE_LIMIT} 行`)
    if (options.selection !== undefined && Buffer.byteLength(options.selection) > SELECTION_BYTES)
      throw new AppError(413, 'terminal-selection-too-large', '选中的内容过多')
    this.meterExtract(requester.deviceId)
    if (options.selection !== undefined) return attachmentText(options.selection, lines)
    const { scrollback } = terminal
    const start = Math.max(scrollback.replayStart(), scrollback.end - EXTRACT_BYTES)
    const raw = tailOfLines(scrollback.read(start, scrollback.end - start), lines + 1)
    return attachmentText(raw.toString('utf8'), lines)
  }

  private admit(requester: TerminalRequester): void {
    if (!isLocalListener(requester.listener)) throw localOnly()
  }

  /** A terminal shows anything the shell prints, files and keys included. */
  private admitOutput(requester: TerminalRequester): void {
    if (!isLocalListener(requester.listener) && requester.dataScope !== 'all')
      throw new AppError(403, 'terminal-scope', '这台设备的数据范围不包括终端的输出')
  }

  private admitStream(terminal: Terminal, requester: TerminalRequester): void {
    const local = isLocalListener(requester.listener)
    let pool = 0
    let device = 0
    for (const state of terminal.streams) {
      if (isLocalListener(state.requester.listener) === local) pool++
      if (state.requester.deviceId === requester.deviceId) device++
    }
    if (pool >= (local ? LOCAL_STREAMS : REMOTE_STREAMS) || device >= STREAMS_PER_DEVICE)
      throw new AppError(429, 'terminal-streams', '同时查看这个终端的窗口过多，请先关闭其他窗口')
  }

  private meterExtract(deviceId: string): void {
    const now = this.now()
    let window = this.extracts.get(deviceId)
    if (!window || now - window.start >= EXTRACT_WINDOW_MS) {
      // Windows that ended go, so the map holds only devices that asked in the last window.
      for (const [id, entry] of this.extracts) if (now - entry.start >= EXTRACT_WINDOW_MS) this.extracts.delete(id)
      window = { start: now, count: 0 }
      this.extracts.set(deviceId, window)
    }
    if (window.count >= EXTRACTS_PER_WINDOW) throw new AppError(429, 'terminal-extract-busy', '加入对话太频繁，请稍后再试')
    window.count++
  }

  private find(ref: TerminalRef): Terminal {
    const terminal = this.terminals.get(ref.terminalId)
    if (!terminal || terminal.sessionId !== ref.sessionId || terminal.status === 'starting') throw notFound()
    return terminal
  }

  private count(predicate: (terminal: Terminal) => boolean): number {
    let count = 0
    for (const terminal of this.terminals.values()) if (predicate(terminal)) count++
    for (const terminal of this.ending) if (predicate(terminal)) count++
    return count
  }

  private summary(terminal: Terminal, requester: TerminalRequester): TerminalSummary {
    const local = isLocalListener(requester.listener)
    return {
      id: terminal.id,
      sessionId: terminal.sessionId,
      shell: terminal.shell,
      folder: terminal.folder,
      cols: terminal.cols,
      rows: terminal.rows,
      status: terminal.status === 'starting' ? 'running' : terminal.status,
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      ...(terminal.exitSignal !== undefined ? { exitSignal: terminal.exitSignal } : {}),
      busy: terminal.busy,
      ...(terminal.foreground !== undefined ? { foreground: terminal.foreground } : {}),
      services: terminal.services.map(service => ({ ...service })),
      writable: local,
      sizeOwner: local && requester.deviceId === terminal.owner,
      createdAt: new Date(terminal.createdAt).toISOString(),
    }
  }

  private onEvent(terminal: Terminal, event: HelperEvent): void {
    switch (event.type) {
      case 'started':
        if (terminal.status !== 'starting') return
        terminal.status = 'running'
        terminal.starting?.resolve()
        terminal.starting = undefined
        return
      case 'output':
        this.output(terminal, event.data)
        return
      case 'foreground': {
        const foreground = event.busy ? programName(event.name) : undefined
        if (terminal.busy === event.busy && terminal.foreground === foreground) return
        terminal.busy = event.busy
        terminal.foreground = foreground
        this.changed(terminal)
        return
      }
      case 'exit':
        terminal.status = 'exited'
        if (event.code !== undefined) terminal.exitCode = event.code
        if (event.signal !== undefined) terminal.exitSignal = signalName(event.signal)
        this.ended(terminal)
        return
      case 'failed':
        if (terminal.starting) {
          terminal.starting.reject(startFailure(event.reason))
          terminal.starting = undefined
          return
        }
        if (terminal.status !== 'running') return
        terminal.status = 'failed'
        this.options.log?.(`终端 ${terminal.id} 意外结束（${event.reason}）`)
        this.ended(terminal)
        return
      case 'gone':
        clearTimeout(terminal.resumeTimer)
        terminal.resumeTimer = undefined
        return
    }
  }

  private ended(terminal: Terminal): void {
    terminal.busy = false
    terminal.foreground = undefined
    terminal.detector.clear()
    terminal.services = []
    this.changed(terminal)
  }

  private output(terminal: Terminal, data: Buffer): void {
    terminal.scrollback.append(data)
    if (terminal.detector.push(data)) {
      terminal.services = terminal.detector.services()
      this.changed(terminal)
    }
    this.meter(terminal, data.length)
    for (const state of terminal.streams) this.pump(terminal, state)
  }

  private meter(terminal: Terminal, bytes: number): void {
    const now = this.now()
    if (now - terminal.window.start >= OUTPUT_WINDOW_MS) terminal.window = { start: now, bytes: 0 }
    terminal.window.bytes += bytes
    if (terminal.window.bytes < OUTPUT_WINDOW_BYTES || terminal.outputPaused || !terminal.process) return
    terminal.outputPaused = true
    terminal.process.pauseOutput()
    terminal.resumeTimer = setTimeout(
      () => {
        terminal.outputPaused = false
        terminal.resumeTimer = undefined
        terminal.process?.resumeOutput()
      },
      Math.max(1, terminal.window.start + OUTPUT_WINDOW_MS - now),
    )
  }

  /** Every watcher hears of the change once it has the output printed before it. */
  private changed(terminal: Terminal): void {
    for (const state of terminal.streams) {
      state.summaryDue = true
      this.pump(terminal, state)
    }
  }

  private pump(terminal: Terminal, state: StreamState): void {
    const { scrollback } = terminal
    while (!state.paused && !state.closed) {
      if (state.cursor < scrollback.start) {
        state.cursor = scrollback.replayStart()
        if (!state.sink.write({ type: 'reset', offset: state.cursor })) state.paused = true
      } else if (state.cursor < scrollback.end) {
        const offset = state.cursor
        const data = scrollback.read(offset, STREAM_CHUNK_BYTES)
        state.cursor += data.length
        if (!state.sink.write({ type: 'output', offset, data })) state.paused = true
      } else if (state.summaryDue) {
        state.summaryDue = false
        if (!state.sink.write({ type: 'terminal', terminal: this.summary(terminal, state.requester) })) state.paused = true
      } else return
    }
  }

  private end(terminal: Terminal): Promise<void> {
    terminal.ending ??= (async () => {
      this.terminals.delete(terminal.id)
      this.ending.add(terminal)
      clearTimeout(terminal.resumeTimer)
      terminal.starting?.reject(new AppError(409, 'terminal-closed', '终端已关闭'))
      terminal.starting = undefined
      const streams = [...terminal.streams]
      terminal.streams.clear()
      for (const state of streams) {
        state.closed = true
        state.sink.end()
      }
      try {
        await terminal.process?.close()
      } finally {
        this.ending.delete(terminal)
      }
    })()
    return terminal.ending
  }
}
