// The Host's terminals: one login shell per terminal, in the session's or workspace's primary folder, on a pty that latch-pty
// (native/macos/LatchTerminal.swift) owns. The shell runs as the user, like any terminal: no approval, path rule or
// outbound policy applies to what runs in it. Everything here, reading output included, is for this computer (host.sock)
// alone: output is raw and may hold keys. Routes stay thin: each method takes the requester and does its own checks.
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { constants, homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import {
  HARNESS_LOGIN_SESSION,
  TERMINALS_PER_SESSION,
  isLocalListener,
  type ListenerClass,
  type LocalService,
  type TerminalSize,
  type TerminalSummary,
  type TerminalTarget,
  type TerminalText,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { redactSecrets } from '@latch/core/node-kit'
import { localOnly } from '../access.ts'
import { canonicalPath, isInsidePath, latchCodeRoot } from '../paths.ts'
import { loginShell, shellRunning, terminalEnvironment, type ShellCommand } from './environment.ts'
import {
  helperLauncher,
  type HelperEvent,
  type LaunchTerminal,
  type TerminalFailure,
  type TerminalProcess,
  type TerminalSignal,
} from './helper.ts'
import { LocalServiceDetector } from './localhost.ts'
import { PasteMode } from './paste-mode.ts'
import { Scrollback } from './scrollback.ts'
import { ATTACH_LINE_LIMIT, attachmentText, fromFirstWholeLine } from './text.ts'

export const SCROLLBACK_BYTES = 512 * 1024
/** All terminals' scrollback together, so at most 32 terminals on this computer at once. */
export const SCROLLBACK_TOTAL_BYTES = 16 * 1024 * 1024
/** The most one input call carries. */
export const INPUT_BYTES = 64 * 1024
/** Input the helper has not taken yet beyond this refuses more until the terminal catches up. */
const PENDING_INPUT_BYTES = 1024 * 1024
const SIZE_LIMIT = 1000
export const SELECTION_BYTES = 256 * 1024
/** Of the scrollback, 「加入对话」 decodes at most the newest this many bytes. */
const EXTRACT_BYTES = 256 * 1024
/** 「加入对话」: at most this many in a window. */
const EXTRACT_WINDOW_MS = 10_000
const EXTRACTS_PER_WINDOW = 20
const STREAMS_PER_TERMINAL = 8
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
}

/** The owning session or workspace is part of every terminal address. */
export type TerminalRef = TerminalTarget & { terminalId: string }

/**
 * A Harness's own login command in place of the plain shell. The Host resolves it from the Harness's definition; no
 * caller's text is part of it.
 */
export interface TerminalRun {
  /** One command line of plain words for the person's shell (`shellRunning`); the terminal ends when it does. */
  command: string
  /** Which Harness's login this is, and the name its tab carries. */
  login: { harnessId: string; name: string }
  /** Once, when the terminal is over or never started. `code`: the command's own exit code, when it ended by itself. */
  onEnd?(exit: { code?: number }): void
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
  /** Resolves a saved workspace before audit, with an identity check for the synchronous launch boundary. */
  workspaceFolder?(workspaceId: string): Promise<{ path: string; check(opened: BigIntStats): void }>
  /** Refuses a launch in a worktree whose removal has already started. */
  checkWorkingDirectory?(cwd: string): void
  /** Runs once an open is accepted and before the shell starts; a rejection stops it (audit before execution). */
  beforeOpen?(event: TerminalTarget & { terminalId: string; deviceId: string }): Promise<void>
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
  target: TerminalTarget
  owner: string
  shell: string
  cwd?: string
  folderName: string
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
  paste: PasteMode
  process?: TerminalProcess
  helperGone: boolean
  streams: Set<StreamState>
  starting?: { resolve(): void; reject(error: AppError): void }
  ending?: Promise<void>
  window: { start: number; bytes: number }
  outputPaused: boolean
  resumeTimer?: NodeJS.Timeout
  run?: TerminalRun
}

function startFailure(reason: TerminalFailure): AppError {
  if (reason === 'cwd') return new AppError(409, 'terminal-folder-unavailable', '会话的文件夹已不可用，不能在这里打开终端')
  if (reason === 'exec') return new AppError(500, 'terminal-shell-unavailable', '没能启动 shell，终端没有打开')
  return new AppError(500, 'terminal-start-failed', '终端没有启动，请重试')
}

function notFound(): AppError {
  return new AppError(404, 'terminal-not-found', '找不到这个终端')
}

function sameTarget(a: TerminalTarget, b: TerminalTarget): boolean {
  return a.sessionId === b.sessionId && a.workspaceId === b.workspaceId
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

/**
 * Whether closing would end something: a program the system reports in the foreground, or a login command, which runs
 * in the shell's own process group and so is never reported as one.
 */
function occupied(terminal: Terminal): boolean {
  return terminal.busy || (terminal.run !== undefined && (terminal.status === 'running' || terminal.status === 'starting'))
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

export class TerminalService {
  private readonly terminals = new Map<string, Terminal>()
  /** Closing terminals still count against the limits until their helper has really exited. */
  private readonly ending = new Set<Terminal>()
  private extracts = { start: 0, count: 0 }
  private stopping = false
  /** The Host is about to stop for an update (its install window is committed): nothing new reaches a shell. */
  private held = false
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

  /** While held, new terminals and typed input are refused, as new session starts are. */
  setHeld(held: boolean): void {
    this.held = held
  }

  private refuseWhileHeld(): void {
    if (this.held) throw new AppError(409, 'host-updating', '这台电脑正在安装更新，终端暂不接受输入。安装完成后再试。')
  }

  /** For the install gate: terminals running a command (a stop would end it) and the local services they announced. */
  activity(): { terminals: number; services: number } {
    const running = [...this.terminals.values()].filter(terminal => terminal.status === 'running')
    return {
      terminals: running.filter(occupied).length,
      services: running.reduce((sum, terminal) => sum + terminal.services.length, 0),
    }
  }

  /**
   * Whether a terminal's private directory lies inside the worktree. An open still resolving its directory and a
   * closing helper whose processes have not settled also protect the directory.
   */
  openInside(path: string): boolean {
    return this.usingDirectory(terminal => terminal.cwd === undefined || isInsidePath(terminal.cwd, path))
  }

  /** Whether any of these sessions has a terminal starting or running: a worktree is not removed under a shell. */
  openIn(sessionIds: ReadonlySet<string>): boolean {
    return this.usingDirectory(terminal => terminal.target.sessionId !== undefined && sessionIds.has(terminal.target.sessionId))
  }

  private usingDirectory(matches: (terminal: Terminal) => boolean): boolean {
    for (const terminal of this.terminals.values()) if (!terminal.helperGone && matches(terminal)) return true
    for (const terminal of this.ending) if (matches(terminal)) return true
    return false
  }

  list(target: TerminalTarget | string, requester: TerminalRequester): TerminalSummary[] {
    this.admit(requester)
    const owner = typeof target === 'string' ? { sessionId: target } : target
    return [...this.terminals.values()]
      .filter(terminal => sameTarget(terminal.target, owner) && terminal.status !== 'starting')
      .map(terminal => this.summary(terminal, requester))
  }

  /**
   * `authorize` runs once the open has been audited, right before the shell starts, and refuses by throwing an AppError.
   * `run`: a Harness's login command instead of a plain shell; under `HARNESS_LOGIN_SESSION` it starts in the home
   * folder, and nothing else opens there.
   */
  create(
    sessionId: string,
    requester: TerminalRequester,
    size: TerminalSize,
    authorize?: () => void,
    run?: TerminalRun,
  ): Promise<TerminalSummary & { sessionId: string }>
  create(target: TerminalTarget, requester: TerminalRequester, size: TerminalSize, authorize?: () => void): Promise<TerminalSummary>
  async create(
    target: TerminalTarget | string,
    requester: TerminalRequester,
    size: TerminalSize,
    authorize?: () => void,
    run?: TerminalRun,
  ): Promise<TerminalSummary> {
    this.refuseWhileHeld()
    this.admit(requester)
    if (this.unavailable === 'platform') throw new AppError(501, 'terminal-unsupported', '终端尚未实现：目前只支持 macOS')
    const launch = this.launch
    if (!launch) throw new AppError(503, 'terminal-unavailable', '终端组件不可用，请重新构建 Latch')
    if (this.stopping) throw new AppError(503, 'terminal-stopping', 'Latch 正在停止，不能打开终端')
    const { cols, rows } = checkedSize(size)
    const owner = typeof target === 'string' ? { sessionId: target } : target
    if (this.count(terminal => sameTarget(terminal.target, owner)) >= TERMINALS_PER_SESSION)
      throw new AppError(
        429,
        'terminal-limit',
        `每个${owner.workspaceId === undefined ? '会话' : '项目'}最多 ${TERMINALS_PER_SESSION} 个终端`,
      )
    if ((this.count(() => true) + 1) * SCROLLBACK_BYTES > SCROLLBACK_TOTAL_BYTES)
      throw new AppError(429, 'terminal-total-limit', '这台电脑上打开的终端太多了，请先关闭不用的终端')
    // Counted from here on, before anything is awaited, so concurrent opens cannot pass the limits together.
    const terminal: Terminal = {
      id: `term_${randomUUID()}`,
      target: owner,
      owner: requester.deviceId,
      shell: '',
      folderName: '',
      cols,
      rows,
      createdAt: this.now(),
      status: 'starting',
      helperGone: false,
      busy: false,
      services: [],
      scrollback: new Scrollback(SCROLLBACK_BYTES),
      detector: new LocalServiceDetector(),
      paste: new PasteMode(),
      streams: new Set(),
      window: { start: 0, bytes: 0 },
      outputPaused: false,
      ...(run ? { run: { ...run, login: { harnessId: run.login.harnessId, name: programName(run.login.name) ?? 'Harness' } } } : {}),
    }
    this.terminals.set(terminal.id, terminal)
    let directory: FileHandle | undefined
    try {
      const resolved: { path: string; check?(opened: BigIntStats): void } | 'removed' | undefined =
        owner.workspaceId !== undefined
          ? await this.options.workspaceFolder?.(owner.workspaceId)
          : owner.sessionId === HARNESS_LOGIN_SESSION
            ? run
              ? { path: homedir() }
              : undefined
            : await this.options.sessionFolder(owner.sessionId)
      if (resolved === undefined) {
        if (owner.workspaceId !== undefined) throw new AppError(404, 'workspace-not-found', '找不到该项目')
        throw new AppError(404, 'task-not-found', '找不到该会话')
      }
      if (resolved === 'removed' || !isAbsolute(resolved.path)) throw startFailure('cwd')
      const folder = await realpath(resolved.path).catch(() => {
        throw startFailure('cwd')
      })
      terminal.cwd = await canonicalPath(folder).catch(() => {
        throw startFailure('cwd')
      })
      directory = await open(folder, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW).catch(() => {
        throw startFailure('cwd')
      })
      const opened = await directory.stat({ bigint: true })
      const cwdFd = directory.fd
      const plain = this.options.shell ?? (await loginShell())
      const shell = run ? shellRunning(plain, run.command) : plain
      terminal.shell = basename(shell.file)
      terminal.folderName = basename(folder)
      // Closed while the folder was resolved (its session ended, the Host stops): no audit record, no shell.
      if (terminal.ending) throw new AppError(409, 'terminal-closed', '终端已关闭')
      await this.options.beforeOpen?.({ ...owner, terminalId: terminal.id, deviceId: requester.deviceId })
      if (terminal.ending) throw new AppError(409, 'terminal-closed', '终端已关闭')
      authorize?.()
      resolved.check?.(opened)
      this.options.checkWorkingDirectory?.(terminal.cwd)
      this.refuseWhileHeld()
      const env = terminalEnvironment({ hostEnv: this.options.hostEnv ?? process.env, shell: shell.file, folder })
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined
        const settle = (error?: AppError) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        terminal.starting = { resolve: () => settle(), reject: settle }
        terminal.process = launch({ file: shell.file, argv: shell.argv, env, cwd: folder, cwdFd, cols, rows }, event =>
          this.onEvent(terminal, event),
        )
        if (terminal.starting) timer = setTimeout(() => terminal.starting?.reject(startFailure('helper')), START_DEADLINE_MS)
      })
      return this.summary(terminal, requester)
    } catch (error) {
      terminal.starting = undefined
      await this.end(terminal)
      throw error instanceof AppError ? error : startFailure('helper')
    } finally {
      await directory?.close().catch(() => {})
    }
  }

  input(ref: TerminalRef, requester: TerminalRequester, data: Uint8Array): void {
    this.refuseWhileHeld()
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
    if (terminal.status === 'running' && occupied(terminal) && !options.force) throw busyError(terminal)
    await this.end(terminal)
  }

  /**
   * Whether the session may be archived or deleted now. On this computer a busy terminal holds it back under the rules
   * of `close`. Elsewhere any running terminal does, so archiving from another device never ends a shell on this one.
   */
  checkSessionEnd(sessionId: string, requester: TerminalRequester, options: { force?: boolean } = {}): void {
    const running = [...this.terminals.values()].filter(
      terminal => terminal.target.sessionId === sessionId && (terminal.status === 'running' || terminal.status === 'starting'),
    )
    if (!isLocalListener(requester.listener)) {
      if (running.length > 0) throw new AppError(409, 'terminal-running', '这个会话还有终端在运行，请先在 Mac 上关闭终端')
    } else if (!options.force) {
      const held = running.find(occupied)
      if (held) throw busyError(held)
    }
  }

  /** The session is archived or deleted: its terminals end, once `checkSessionEnd` lets them. */
  async closeSession(sessionId: string, requester: TerminalRequester, options: { force?: boolean } = {}): Promise<void> {
    this.checkSessionEnd(sessionId, requester, options)
    await Promise.all(
      [...this.terminals.values()].filter(terminal => terminal.target.sessionId === sessionId).map(terminal => this.end(terminal)),
    )
  }

  /** Project deletion must not orphan or implicitly stop a shell. The project queue bars another open until it ends. */
  checkWorkspaceEnd(workspaceId: string): void {
    if (this.usingDirectory(terminal => terminal.target.workspaceId === workspaceId))
      throw new AppError(409, 'workspace-terminal-open', '这个项目还有打开的终端，请在这台 Mac 上关闭后再移除。')
  }

  async forgetWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(
      [...this.terminals.values()].filter(terminal => terminal.target.workspaceId === workspaceId).map(terminal => this.end(terminal)),
    )
  }

  /** The Host stops: every terminal ends, and none opens again. */
  async shutdown(): Promise<void> {
    this.stopping = true
    await Promise.all([...this.terminals.values()].map(terminal => this.end(terminal)))
    await Promise.all([...this.ending].flatMap(terminal => terminal.ending ?? []))
  }

  /** Replays what is kept from `from` (or from the start), then live output, honouring the sink's back-pressure. */
  stream(ref: TerminalRef, requester: TerminalRequester, sink: TerminalStreamSink, options: { from?: number } = {}): TerminalStream {
    this.admit(requester)
    const terminal = this.find(ref)
    this.admitStream(terminal)
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
   * Its work is linear in input of bounded size, and it runs at most EXTRACTS_PER_WINDOW times per window.
   */
  extract(ref: TerminalRef, requester: TerminalRequester, options: { lines?: number; selection?: string } = {}): TerminalText {
    this.admit(requester)
    const terminal = this.find(ref)
    // A login prints device codes and links that carry them, which the best-effort redaction would not know.
    if (terminal.run) throw new AppError(409, 'terminal-login-output', '登录的输出不加入对话')
    const lines = options.lines ?? ATTACH_LINE_LIMIT
    if (!Number.isInteger(lines) || lines < 1 || lines > ATTACH_LINE_LIMIT)
      throw new AppError(400, 'terminal-lines-invalid', `一次最多加入 ${ATTACH_LINE_LIMIT} 行`)
    if (options.selection !== undefined && Buffer.byteLength(options.selection) > SELECTION_BYTES)
      throw new AppError(413, 'terminal-selection-too-large', '选中的内容过多')
    this.meterExtract()
    if (options.selection !== undefined) return attachmentText(options.selection, lines)
    const { scrollback } = terminal
    const start = Math.max(scrollback.start, scrollback.end - EXTRACT_BYTES)
    const raw = scrollback.read(start, scrollback.end - start)
    const onLine = start === 0 || (start > scrollback.start && scrollback.read(start - 1, 1)[0] === 0x0a)
    // All of the window, not only its last lines: redaction needs what surrounds them, and the work is linear.
    const text = attachmentText((onLine ? raw : fromFirstWholeLine(raw)).toString('utf8'), lines)
    return start === 0 ? text : { ...text, truncated: true }
  }

  private admit(requester: TerminalRequester): void {
    if (!isLocalListener(requester.listener)) throw localOnly()
  }

  private admitStream(terminal: Terminal): void {
    if (terminal.streams.size >= STREAMS_PER_TERMINAL)
      throw new AppError(429, 'terminal-streams', '同时查看这个终端的窗口过多，请先关闭其他窗口')
  }

  private meterExtract(): void {
    const now = this.now()
    if (now - this.extracts.start >= EXTRACT_WINDOW_MS) this.extracts = { start: now, count: 0 }
    if (this.extracts.count >= EXTRACTS_PER_WINDOW) throw new AppError(429, 'terminal-extract-busy', '加入对话太频繁，请稍后再试')
    this.extracts.count++
  }

  private find(ref: TerminalRef): Terminal {
    const terminal = this.terminals.get(ref.terminalId)
    if (!terminal || !sameTarget(terminal.target, ref) || terminal.status === 'starting') throw notFound()
    return terminal
  }

  private count(predicate: (terminal: Terminal) => boolean): number {
    let count = 0
    for (const terminal of this.terminals.values()) if (predicate(terminal)) count++
    for (const terminal of this.ending) if (predicate(terminal)) count++
    return count
  }

  private summary(terminal: Terminal, requester: TerminalRequester): TerminalSummary {
    return {
      id: terminal.id,
      ...terminal.target,
      shell: terminal.shell,
      folder: terminal.folderName,
      cols: terminal.cols,
      rows: terminal.rows,
      status: terminal.status === 'starting' ? 'running' : terminal.status,
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      ...(terminal.exitSignal !== undefined ? { exitSignal: terminal.exitSignal } : {}),
      busy: occupied(terminal),
      ...(terminal.status === 'running' && terminal.paste.on ? { prompt: terminal.paste.count } : {}),
      ...(terminal.foreground !== undefined ? { foreground: terminal.foreground } : {}),
      services: terminal.services.map(service => ({ ...service })),
      sizeOwner: requester.deviceId === terminal.owner,
      createdAt: new Date(terminal.createdAt).toISOString(),
      ...(terminal.run ? { login: { ...terminal.run.login } } : {}),
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
        terminal.helperGone = true
        clearTimeout(terminal.resumeTimer)
        terminal.resumeTimer = undefined
        return
    }
  }

  /** The login command is over: its caller hears once, with the exit code only when the command ended by itself. */
  private runEnded(terminal: Terminal): void {
    const run = terminal.run
    if (!run?.onEnd) return
    const { onEnd } = run
    delete run.onEnd
    onEnd(terminal.status === 'exited' && terminal.exitCode !== undefined ? { code: terminal.exitCode } : {})
  }

  private ended(terminal: Terminal): void {
    this.runEnded(terminal)
    terminal.busy = false
    terminal.foreground = undefined
    terminal.detector.clear()
    terminal.paste.clear()
    terminal.services = []
    this.changed(terminal)
  }

  private output(terminal: Terminal, data: Buffer): void {
    terminal.scrollback.append(data)
    const pasteChanged = terminal.paste.push(data)
    const servicesChanged = terminal.detector.push(data)
    if (servicesChanged) terminal.services = terminal.detector.services()
    if (pasteChanged || servicesChanged) this.changed(terminal)
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
        this.runEnded(terminal)
      }
    })()
    return terminal.ending
  }
}
