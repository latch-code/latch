import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HARNESS_LOGIN_SESSION, type HarnessLogin, type TerminalSummary } from '@latch/protocol'
import { HarnessLoginSteps, loginRunWord } from '../src/components/HarnessLogin.tsx'
import { ApiError } from '../src/core/api.ts'
import { LoginRuns, loginRunState, loginSurface, type LoginSurface } from '../src/panel/terminal/loginRuns.ts'
import { tabName } from '../src/panel/terminal/model.ts'

const terminal = (over: Partial<TerminalSummary> = {}): TerminalSummary => ({
  id: 'term_1',
  sessionId: HARNESS_LOGIN_SESSION,
  shell: 'zsh',
  folder: 'me',
  cols: 80,
  rows: 24,
  status: 'running',
  busy: true,
  services: [],
  sizeOwner: true,
  createdAt: '2026-11-15T03:00:00.000Z',
  login: { harnessId: 'qwen', name: 'Qwen Code' },
  ...over,
})

/** A stand-in for the Host: every call is kept, the terminal list is what the test last set, and the poll runs by hand. */
function fakeHost() {
  const calls: Array<{ path: string; body?: unknown }> = []
  const state = {
    listed: [] as TerminalSummary[],
    next: terminal(),
    failOpen: undefined as Error | undefined,
    polls: [] as Array<() => void>,
  }
  const runs = new LoginRuns(
    (path, options) => {
      calls.push({ path, ...(options?.body !== undefined ? { body: options.body } : {}) })
      if (path.endsWith('/login-terminal')) {
        if (state.failOpen) return Promise.reject(state.failOpen)
        state.listed = [state.next]
        return Promise.resolve({ opened: true, terminal: state.next } as never)
      }
      if (path.endsWith('/close')) {
        state.listed = []
        return Promise.resolve({ closed: true } as never)
      }
      return Promise.resolve({ terminals: state.listed } as never)
    },
    run => {
      state.polls.push(run)
      return () => state.polls.splice(state.polls.indexOf(run), 1)
    },
  )
  const poll = async () => {
    for (const run of [...state.polls]) run()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { runs, calls, state, poll }
}

describe('where 「在终端里登录」 runs', () => {
  it('is a Latch terminal where the Host offers this device one, the session’s when a session can have it', () => {
    expect(loginSurface({ terminal: true, loginTerminal: true }, 'task_1')).toEqual({ kind: 'latch', sessionId: 'task_1' })
    expect(loginSurface({ terminal: true, loginTerminal: true })).toEqual({ kind: 'latch' })
  })

  it('stays this Mac’s default terminal app where there is no Latch terminal, and only the command on any other device', () => {
    // This Mac, but the component is missing or the window's data scope is work.
    expect(loginSurface({ loginTerminal: true }, 'task_1')).toEqual({ kind: 'system' })
    // A phone, a browser, another computer; and a Host that is not on macOS offers neither.
    expect(loginSurface({})).toEqual({ kind: 'none' })
    expect(loginSurface(undefined, 'task_1')).toEqual({ kind: 'none' })
  })

  const login: HarnessLogin = { command: 'qwen', note: '进入 Qwen Code 后输入 /auth，按提示登录。' }
  const steps = (surface: LoginSurface) => renderToStaticMarkup(createElement(HarnessLoginSteps, { harnessId: 'qwen', login, surface }))

  it('shows the button on this Mac and none elsewhere, with the command to copy either way', () => {
    for (const surface of [{ kind: 'latch' }, { kind: 'latch', sessionId: 'task_1' }, { kind: 'system' }] satisfies LoginSurface[]) {
      expect(steps(surface)).toContain('在终端里登录')
      expect(steps(surface)).not.toContain('在这台 Mac 的终端里运行这条命令')
    }
    const remote = steps({ kind: 'none' })
    expect(remote).not.toContain('在终端里登录')
    expect(remote).toContain('复制登录命令')
    expect(remote).toContain('在这台 Mac 的终端里运行这条命令。')
  })
})

describe('a login command in a Latch terminal', () => {
  it('asks the Host with the Harness, the advertised login and the session only: no command leaves the page', async () => {
    const { runs, calls, state } = fakeHost()
    state.next = terminal({ sessionId: 'task_1' })
    const run = await runs.start({ harnessId: 'qwen code', method: 'device', sessionId: 'task_1' })
    expect(calls).toEqual([
      { path: 'harnesses/qwen%20code/login-terminal', body: { method: 'device', terminal: { cols: 80, rows: 24, sessionId: 'task_1' } } },
    ])
    expect(run).toMatchObject({ harnessId: 'qwen code', method: 'device', sessionId: 'task_1', state: 'running' })
    // The session's 终端 tab is asked to show it; no dialog opens for a login that has a session.
    expect(runs.revealed()?.run.terminal.id).toBe('term_1')
    expect(runs.detached()).toBeUndefined()
  })

  it('outside a session opens under the reserved ID, in the dialog', async () => {
    const { runs, calls } = fakeHost()
    await runs.start({ harnessId: 'qwen' })
    expect(calls[0]!.body).toEqual({ terminal: { cols: 80, rows: 24 } })
    expect(runs.detached()).toMatchObject({ sessionId: HARNESS_LOGIN_SESSION, state: 'running' })
  })

  it('shows the one still running instead of starting a second, and replaces one that ended', async () => {
    const { runs, calls, state, poll } = fakeHost()
    await runs.start({ harnessId: 'qwen' })
    const before = runs.revealed()!.nonce
    await runs.start({ harnessId: 'qwen' })
    expect(calls.filter(call => call.path.endsWith('/login-terminal'))).toHaveLength(1)
    expect(runs.revealed()!.nonce).toBe(before + 1)

    state.listed = [terminal({ status: 'exited', exitCode: 1, busy: false })]
    await poll()
    expect(runs.runOf('qwen')?.state).toBe('failed')
    state.next = terminal({ id: 'term_2' })
    await runs.start({ harnessId: 'qwen' })
    expect(calls.slice(-2)).toEqual([
      { path: `tasks/${HARNESS_LOGIN_SESSION}/terminals/term_1/close`, body: { force: true } },
      { path: 'harnesses/qwen/login-terminal', body: { terminal: { cols: 80, rows: 24 } } },
    ])
    expect(runs.runOf('qwen')?.terminal.id).toBe('term_2')
  })

  it('follows the Host’s list while the command runs, and stops asking once it has ended', async () => {
    const { runs, calls, state, poll } = fakeHost()
    const seen: Array<string | undefined> = []
    runs.subscribe(() => seen.push(runs.runOf('qwen')?.state))
    await runs.start({ harnessId: 'qwen' })
    expect(state.polls).toHaveLength(1)
    await poll()
    expect(runs.runOf('qwen')?.state).toBe('running')
    state.listed = [terminal({ status: 'exited', exitCode: 0, busy: false })]
    await poll()
    expect(runs.runOf('qwen')?.state).toBe('ended')
    expect(state.polls).toHaveLength(0)
    expect(seen.at(-1)).toBe('ended')
    expect(calls.filter(call => call.path === `tasks/${HARNESS_LOGIN_SESSION}/terminals`)).toHaveLength(2)
  })

  it('forgets a run whose terminal the person closed, and keeps the row’s error when the Host refuses', async () => {
    const { runs, state, poll } = fakeHost()
    await runs.start({ harnessId: 'qwen' })
    state.listed = []
    await poll()
    expect(runs.runOf('qwen')).toBeUndefined()
    expect(runs.detached()).toBeUndefined()
    expect(state.polls).toHaveLength(0)

    state.failOpen = new ApiError(404, 'harness-no-login', 'Latch 不知道这个 Harness 的登录命令。')
    await expect(runs.start({ harnessId: 'claude-agent' })).rejects.toMatchObject({ code: 'harness-no-login' })
    expect(runs.runOf('claude-agent')).toBeUndefined()
  })

  it('takes a stream’s report at once, and leaves a running command alone until the person confirmed', async () => {
    const { runs, calls } = fakeHost()
    const run = await runs.start({ harnessId: 'qwen' })
    runs.report(terminal({ status: 'exited', exitSignal: 'SIGHUP', busy: false }))
    expect(runs.runOf('qwen')?.state).toBe('failed')
    await runs.close(run)
    expect(calls.at(-1)).toEqual({ path: `tasks/${HARNESS_LOGIN_SESSION}/terminals/term_1/close`, body: {} })
    expect(runs.runOf('qwen')).toBeUndefined()
  })
})

describe('what a row says of a login command', () => {
  it('reads how the command stands from its terminal alone', () => {
    expect(loginRunState({ status: 'running' })).toBe('running')
    expect(loginRunState({ status: 'exited', exitCode: 0 })).toBe('ended')
    expect(loginRunState({ status: 'exited', exitCode: 1 })).toBe('failed')
    expect(loginRunState({ status: 'exited' })).toBe('failed')
    expect(loginRunState({ status: 'failed' })).toBe('failed')
  })

  it('says 已登录 only on the Harness’s own word, never on an exit code', () => {
    expect(loginRunWord(undefined, { asked: false })).toBeUndefined()
    expect(loginRunWord('running', { asked: false })).toBe('登录中')
    expect(loginRunWord('failed', { asked: false })).toBe('失败')
    // Code 0: still 登录中 until the check has answered.
    expect(loginRunWord('ended', { asked: false })).toBe('登录中')
    expect(loginRunWord('ended', { asked: true, status: 'authenticated' })).toBe('已登录')
    // Left the program without logging in: the row above still says 还没登录.
    expect(loginRunWord('ended', { asked: true, status: 'unauthenticated' })).toBeUndefined()
    // A Harness that cannot say.
    expect(loginRunWord('ended', { asked: true, status: 'unknown' })).toBe('已结束')
    expect(loginRunWord('ended', { asked: true })).toBe('已结束')
  })

  it('names a login’s tab after its Harness and any other 终端 N', () => {
    expect(tabName({ number: 2, summary: terminal() })).toBe('Qwen Code')
    const { login: _login, ...plain } = terminal()
    expect(tabName({ number: 2, summary: plain })).toBe('终端 2')
  })
})
