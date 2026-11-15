import { useSyncExternalStore } from 'react'
import {
  HARNESS_LOGIN_SESSION,
  type HarnessLoginTerminalResponse,
  type HostFeatures,
  type TerminalListResponse,
  type TerminalSummary,
} from '@latch/protocol'
import { api, ApiError, MessageError, type ApiOptions } from '../../core/api.ts'

/**
 * Where 「在终端里登录」 runs. `latch`: one of Latch's own terminals, in the session's 终端 tab when a session is in view
 * and can have one, otherwise in a dialog bound to no session. `system`: this Mac's default terminal app, where the Host
 * offers no Latch terminal to this device. `none`: any other device, which only shows the command.
 */
export type LoginSurface = { kind: 'none' } | { kind: 'system' } | { kind: 'latch'; sessionId?: string }

export function loginSurface(features: Pick<HostFeatures, 'terminal' | 'loginTerminal'> | undefined, sessionId?: string): LoginSurface {
  if (features?.terminal === true) return { kind: 'latch', ...(sessionId !== undefined ? { sessionId } : {}) }
  return features?.loginTerminal === true ? { kind: 'system' } : { kind: 'none' }
}

/** How a login command stands, by its terminal alone: `ended` left with code 0, which says nothing yet about the login. */
export type LoginRunState = 'running' | 'ended' | 'failed'

export function loginRunState(terminal: Pick<TerminalSummary, 'status' | 'exitCode'>): LoginRunState {
  if (terminal.status === 'running') return 'running'
  return terminal.status === 'exited' && terminal.exitCode === 0 ? 'ended' : 'failed'
}

export interface LoginRun {
  harnessId: string
  method?: string
  /** `HARNESS_LOGIN_SESSION` for a login outside any session. */
  sessionId: string
  terminal: TerminalSummary
  state: LoginRunState
}

type Request = <T>(path: string, options?: ApiOptions) => Promise<T>
/** Starts calling `run` every `ms`; the result stops it. */
type Every = (run: () => void, ms: number) => () => void

const POLL_MS = 1000
/** The panel sizes the terminal to its own area as soon as it shows it; until then, a terminal's usual size. */
const OPENING_SIZE = { cols: 80, rows: 24 }
const keyOf = (harnessId: string, method?: string) => `${harnessId}\n${method ?? ''}`
const terminalsOf = (sessionId: string) => `tasks/${encodeURIComponent(sessionId)}/terminals`

/**
 * The login commands this page started in Latch terminals, one per Harness and login. A run outlives the row that
 * started it (a transcript row unmounts, 设置 closes), so it is followed here: by what a terminal's own stream reports,
 * and by asking the Host for the terminal list once a second while a command runs. Only the Host says how it ended.
 */
export class LoginRuns {
  private readonly runs = new Map<string, LoginRun>()
  private readonly listeners = new Set<() => void>()
  private stopPolling: (() => void) | undefined
  private polling = false
  /** The run a surface should bring into view; `nonce` changes each time it is asked for. */
  private asked: { run: LoginRun; nonce: number } | undefined

  constructor(
    private readonly request: Request = api,
    private readonly every: Every = (run, ms) => {
      const timer = setInterval(run, ms)
      return () => clearInterval(timer)
    },
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  runOf(harnessId: string, method?: string): LoginRun | undefined {
    return this.runs.get(keyOf(harnessId, method))
  }

  /** The run asked into view, for the surface that shows its terminal. */
  revealed(): { run: LoginRun; nonce: number } | undefined {
    return this.asked
  }

  /** The login outside any session that the dialog shows. */
  detached(): LoginRun | undefined {
    const run = this.asked?.run
    return run && run.sessionId === HARNESS_LOGIN_SESSION ? this.runs.get(keyOf(run.harnessId, run.method)) : undefined
  }

  /**
   * Runs the Harness's login command in a Latch terminal. The Host resolves the command from the Harness; this names
   * only the Harness, a login it advertised, and the session whose terminal tab takes it. One still running is shown
   * again instead of started twice.
   */
  async start(input: { harnessId: string; method?: string; sessionId?: string }): Promise<LoginRun> {
    const key = keyOf(input.harnessId, input.method)
    const before = this.runs.get(key)
    if (before?.state === 'running') {
      this.reveal(before)
      return before
    }
    // The ended terminal of an earlier try makes way, so tries do not pile up as tabs.
    if (before) await this.close(before).catch(() => undefined)
    const { terminal } = await this.request<HarnessLoginTerminalResponse>(
      `harnesses/${encodeURIComponent(input.harnessId)}/login-terminal`,
      {
        method: 'POST',
        body: {
          ...(input.method !== undefined ? { method: input.method } : {}),
          terminal: { ...OPENING_SIZE, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) },
        },
        timeoutMs: 20_000,
      },
    )
    if (!terminal) throw new MessageError('终端没有打开，请重试')
    const run: LoginRun = {
      harnessId: input.harnessId,
      ...(input.method !== undefined ? { method: input.method } : {}),
      sessionId: terminal.sessionId,
      terminal,
      state: loginRunState(terminal),
    }
    this.runs.set(key, run)
    this.reveal(run)
    this.watch()
    return run
  }

  reveal(run: LoginRun): void {
    this.asked = { run, nonce: (this.asked?.nonce ?? 0) + 1 }
    this.changed()
  }

  /** A terminal's summary, from its stream or the Host's list. */
  report(terminal: TerminalSummary): void {
    for (const [key, run] of this.runs) {
      if (run.terminal.id !== terminal.id) continue
      const state = loginRunState(terminal)
      // The terminal's own stream keeps its screen current; here only how the command stands matters.
      if (state === run.state) return
      this.runs.set(key, { ...run, terminal, state })
      this.changed()
      return
    }
  }

  /** The terminal was closed: nothing is left to say about that try. */
  gone(terminalId: string): void {
    for (const [key, run] of this.runs) {
      if (run.terminal.id !== terminalId) continue
      this.runs.delete(key)
      if (this.asked?.run.terminal.id === terminalId) this.asked = undefined
      this.changed()
      return
    }
  }

  /** Closes the run's terminal. A command still running needs `force`, which is sent once the person confirmed. */
  async close(run: LoginRun, force = run.state !== 'running'): Promise<void> {
    try {
      await this.request(`${terminalsOf(run.sessionId)}/${encodeURIComponent(run.terminal.id)}/close`, {
        method: 'POST',
        body: force ? { force: true } : {},
      })
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 404)) throw cause
    }
    this.gone(run.terminal.id)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
    this.watch()
  }

  /** Asks the Host while any command runs, and stops asking once none does. */
  private watch(): void {
    const running = [...this.runs.values()].some(run => run.state === 'running')
    if (running && !this.stopPolling) this.stopPolling = this.every(() => void this.poll(), POLL_MS)
    else if (!running && this.stopPolling) {
      this.stopPolling()
      this.stopPolling = undefined
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const sessions = new Set([...this.runs.values()].filter(run => run.state === 'running').map(run => run.sessionId))
      for (const sessionId of sessions) {
        // No answer says nothing: the next round asks again.
        const listed = await this.request<TerminalListResponse>(terminalsOf(sessionId)).catch(() => undefined)
        if (!listed) continue
        for (const run of [...this.runs.values()].filter(item => item.sessionId === sessionId && item.state === 'running')) {
          const terminal = listed.terminals.find(item => item.id === run.terminal.id)
          if (terminal) this.report(terminal)
          else this.gone(run.terminal.id)
        }
      }
    } finally {
      this.polling = false
    }
  }
}

export const loginRuns = new LoginRuns()

/** The login this page started for the Harness (and advertised login), while its terminal exists. */
export function useLoginRun(harnessId: string, method?: string): LoginRun | undefined {
  const read = () => loginRuns.runOf(harnessId, method)
  return useSyncExternalStore(loginRuns.subscribe, read, read)
}

/** The login terminal a session's 终端 tab should bring into view. */
export function useRevealedLogin(sessionId: string | undefined): { terminalId: string; nonce: number } | undefined {
  const read = () => loginRuns.revealed()
  const asked = useSyncExternalStore(loginRuns.subscribe, read, read)
  return asked && sessionId !== undefined && asked.run.sessionId === sessionId
    ? { terminalId: asked.run.terminal.id, nonce: asked.nonce }
    : undefined
}

/** The login outside any session, for its dialog. */
export function useDetachedLogin(): LoginRun | undefined {
  const read = () => loginRuns.detached()
  return useSyncExternalStore(loginRuns.subscribe, read, read)
}
