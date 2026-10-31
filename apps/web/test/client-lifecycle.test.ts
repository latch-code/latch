import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostStateEvent } from '@latch/protocol'
import { connectEventStream } from '../src/core/eventStream.ts'
import { hostNoticeCopy, noticeOf, parseHostState } from '../src/core/hostState.ts'
import { hostLine, hostNeedsStart, keepAwakeLine, loginItemNote } from '../src/core/shellLifecycle.ts'
import type { ShellLifecycle } from '../src/core/shell.ts'

afterEach(() => {
  vi.useRealTimers()
})

const at = '2026-10-25T14:41:00.000Z'
const localTime = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const frame = (event: Partial<HostStateEvent>) => JSON.stringify({ type: 'host-state', instanceId: 'i', at, ...event })

describe('host state announcements', () => {
  it('reads only well-formed announcements', () => {
    expect(parseHostState(frame({ state: 'sleeping', reason: 'sleep', retryAfter: 10 }))).toMatchObject({ state: 'sleeping' })
    expect(parseHostState(frame({ state: 'awake' }))).toMatchObject({ state: 'awake' })
    for (const bad of [
      'not json',
      frame({ state: 'stopping' }),
      frame({ state: 'stopping', reason: 'restart' }),
      frame({ state: 'stopping', reason: 'later' as never, retryAfter: 2 }),
      frame({ state: 'stopping', reason: 'restart', retryAfter: 0 }),
      frame({ state: 'stopping', reason: 'restart', retryAfter: 1.5 }),
      frame({ state: 'gone' as never }),
      frame({ state: 'awake', at: 'yesterday' }),
      JSON.stringify({ type: 'refresh', instanceId: 'i', state: 'awake', at }),
    ])
      expect(parseHostState(bad), bad).toBeUndefined()
  })

  it('says precisely why the Host does not answer, instead of a generic reconnecting line', () => {
    const notice = (event: Partial<HostStateEvent>) => noticeOf(parseHostState(frame(event))!)!
    expect(noticeOf(parseHostState(frame({ state: 'awake' }))!)).toBeNull()
    expect(hostNoticeCopy(notice({ state: 'sleeping', reason: 'sleep', retryAfter: 10 }))).toEqual({
      title: `Mac 已休眠（${localTime} 起）`,
      body: 'Mac 唤醒后会自动重新连接。',
    })
    expect(hostNoticeCopy(notice({ state: 'stopping', reason: 'restart', retryAfter: 2 })).title).toBe('Mac 上的 Latch 正在重启')
    expect(hostNoticeCopy(notice({ state: 'stopping', reason: 'update', retryAfter: 10 })).title).toBe('Mac 上的 Latch 正在更新')
    expect(hostNoticeCopy(notice({ state: 'stopping', reason: 'shutdown', retryAfter: 15 }))).toEqual({
      title: `Mac 上的 Latch 已停止（${localTime} 起）`,
      body: 'Latch 再次启动后会自动重新连接。',
    })
    expect(notice({ state: 'stopping', reason: 'restart', retryAfter: 2 })).toEqual({
      state: 'stopping',
      reason: 'restart',
      at,
      retryAfter: 2,
    })
  })

  it('waits as long as the Host asked before each attempt until a stream opens, then backs off as usual', async () => {
    vi.useFakeTimers()
    let up = true
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (!up) throw new TypeError('connection refused')
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: refresh\ndata: 1\n\n'))
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const opened = vi.fn()
    const connection = connectEventStream(
      '/link/api/events',
      { onOpen: opened, onEvent: () => {}, onError: () => {}, onUnauthorized: () => 'retry' },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(opened).toHaveBeenCalledTimes(1)
    // The Host announced a restart with retryAfter 2 and went away.
    up = false
    connection.deferReconnect(2_000)
    expect(connection.open).toBe(false)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Still away: the next attempt also waits two seconds, where the backoff alone would wait one.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // The backoff grows past the floor (4 s for the third failure), and the Host is back by then.
    up = true
    await vi.advanceTimersByTimeAsync(3_999)
    expect(opened).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(opened).toHaveBeenCalledTimes(2)
    // Once a stream has opened, the usual backoff applies again.
    up = false
    connection.suspend()
    connection.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    const before = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock.mock.calls.length).toBe(before + 1)
    connection.close()
  })
})

const view = (patch: Partial<ShellLifecycle['host']> = {}): ShellLifecycle['host'] => ({
  status: 'running',
  supervised: true,
  crashes: 0,
  ...patch,
})

describe('desktop lifecycle copy', () => {
  it('names why the login item cannot be used, and what it needs', () => {
    expect(loginItemNote({ available: false, enabled: false, needsApproval: false, reason: 'development' })).toContain('开发运行')
    expect(loginItemNote({ available: false, enabled: false, needsApproval: false, reason: 'platform' })).toBe('只在 macOS 上可用。')
    expect(loginItemNote({ available: true, enabled: true, needsApproval: true })).toBe('需要在「系统设置 › 通用 › 登录项」中允许 Latch。')
    expect(loginItemNote({ available: true, enabled: true, needsApproval: false })).toBe('')
  })

  it('says whether the Mac is kept awake now and why', () => {
    const awake = (patch: Partial<ShellLifecycle['keepAwake']>) =>
      keepAwakeLine({ enabled: true, active: false, cause: null, power: 'ac', batteryLimitReached: false, ...patch })
    expect(awake({ active: true, cause: 'running' })).toBe('保持唤醒中：有会话正在运行。显示器仍按系统设置熄灭。')
    expect(awake({ active: true, cause: 'waiting' })).toBe('保持唤醒中：有审批在等你处理。显示器仍按系统设置熄灭。')
    expect(awake({ power: 'battery', batteryLimitReached: true })).toBe('正在使用电池：已保持唤醒 1 小时，之后电脑按系统设置休眠。')
    expect(awake({ power: 'battery' })).toBe('正在使用电池：只在会话运行时保持唤醒，每次最长 1 小时。')
    expect(awake({ enabled: false })).toBe('已关闭：有任务时电脑也会按系统设置休眠。')
    expect(awake({})).toBe('没有运行中的会话或等待的审批，电脑按系统设置休眠。')
  })

  it('reports restarts and a crash loop, and offers a start only where it can work', () => {
    expect(hostLine(view({ status: 'restarting', restartInMs: 1_800, crashes: 2 }))).toEqual({
      text: 'Latch Host 意外退出，2 秒后重新启动（10 分钟内第 2 次）。',
      tone: 'warn',
    })
    expect(hostLine(view({ status: 'crash-loop', crashes: 5 }))).toMatchObject({
      tone: 'error',
      text: expect.stringContaining('已停止自动重启'),
    })
    expect(hostLine(view({ supervised: false, reason: 'external' })).text).toContain('不是由 Latch 桌面端启动的')
    expect(hostLine(view({ supervised: false, reason: 'environment' })).text).toContain('环境变量')
    expect(hostLine(view({ status: 'unresponsive' }))).toMatchObject({ tone: 'error', text: expect.stringContaining('没有响应') })
    // A Host that is alive but does not answer cannot be stopped or started from here.
    expect(hostNeedsStart(view({ status: 'unresponsive' }))).toBe(false)
    expect(hostNeedsStart(view({ status: 'crash-loop' }))).toBe(true)
    expect(hostNeedsStart(view({ status: 'stopped' }))).toBe(true)
    expect(hostNeedsStart(view({ status: 'crashed', supervised: false }))).toBe(false)
    expect(hostNeedsStart(view())).toBe(false)
  })
})
