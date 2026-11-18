import { useCallback, useEffect, useState } from 'react'
import { defineCopy, plural } from './i18n.ts'
import { describeFailure } from './securityCopy.ts'
import { currentShell, type ShellLifecycle, type ShellLifecycleResult } from './shell.ts'

type Tone = 'neutral' | 'warn' | 'error'

/** The desktop app's lifecycle lines: the login item, keeping awake and the Latch service as main sees it. */
const LIFECYCLE_COPY = defineCopy(
  {
    loginDevelopment: '只有打包后的 Latch 应用能设为登录项。当前是源码开发运行。',
    loginPlatform: '只在 macOS 上可用。',
    loginApproval: '需要在「系统设置 › 通用 › 登录项」中允许 Latch。',
    awakeScheduled: '保持唤醒中：定时任务快到点了',
    awakeWaiting: '保持唤醒中：有审批在等你',
    awakeRunning: '保持唤醒中：有会话在运行',
    batteryLimitReached: '用电池时已到 1 小时上限',
    batteryLimit: '用电池时每次最长 1 小时',
    starting: 'Latch 服务正在启动…',
    restarting: (seconds: number, crashes: number) => `Latch 服务意外退出，${seconds} 秒后重新启动（10 分钟内第 ${crashes} 次）。`,
    crashLoop: (crashes: number) =>
      `Latch 服务在 10 分钟内意外退出 ${crashes} 次，已停止自动重启。请查看数据目录中的 host.log，再重新启动。`,
    crashedEnvironment: 'Latch 服务意外退出。它的设置来自环境变量，请在原启动终端重新启动。',
    crashedExternal: 'Latch 服务意外退出。它不是由 Latch 应用启动的，不会自动重新启动。',
    stopped: 'Latch 服务已停止。',
    unresponsive: 'Latch 服务没有响应：进程仍在，但无法通过 host.sock 核对。在它恢复应答之前，这台 Mac 不会为它保持唤醒。',
    runningSupervised: 'Latch 服务运行中。意外退出后会自动重新启动。',
    runningEnvironment: 'Latch 服务运行中。它的设置来自环境变量，意外退出后不会自动重新启动。',
    runningExternal: 'Latch 服务运行中。它不是由 Latch 应用启动的，意外退出后不会自动重新启动。',
    appUnresponsive: 'Latch 应用没有响应，请重试。',
  } as const,
  {
    loginDevelopment: 'Only the packaged Latch app can be a login item. This copy is running from source.',
    loginPlatform: 'Only available on macOS.',
    loginApproval: 'Allow Latch in System Settings › General › Login Items.',
    awakeScheduled: 'Keeping awake for an upcoming scheduled task',
    awakeWaiting: 'Keeping awake: an approval needs you',
    awakeRunning: 'Keeping awake: a session is running',
    batteryLimitReached: 'Reached the 1-hour limit on battery',
    batteryLimit: 'Up to 1 hour at a time on battery',
    starting: 'The Latch service is starting…',
    restarting: (seconds: number, crashes: number) =>
      `The Latch service quit unexpectedly. Restarting in ${plural(seconds, { one: '{n} second', other: '{n} seconds' })} (${ordinal(crashes)} time in 10 minutes).`,
    crashLoop: (crashes: number) =>
      `The Latch service quit unexpectedly ${plural(crashes, { one: '{n} time', other: '{n} times' })} in 10 minutes, so automatic restarts stopped. Check host.log in the data folder, then start it again.`,
    crashedEnvironment:
      'The Latch service quit unexpectedly. Its settings came from environment variables, so restart it from the terminal where it was started.',
    crashedExternal: 'The Latch service quit unexpectedly. The Latch app did not start it, so it will not restart automatically.',
    stopped: 'The Latch service has stopped.',
    unresponsive:
      'The Latch service is not responding: the process is still there, but cannot be checked through host.sock. This Mac will not stay awake for it until it answers again.',
    runningSupervised: 'The Latch service is running. It restarts automatically if it quits unexpectedly.',
    runningEnvironment:
      'The Latch service is running. Its settings come from environment variables, so it will not restart automatically if it quits.',
    runningExternal: 'The Latch service is running. The Latch app did not start it, so it will not restart automatically if it quits.',
    appUnresponsive: 'The Latch app is not responding. Try again.',
  },
)

/** 1st, 2nd, 3rd, 4th… for the English restart count. */
function ordinal(count: number): string {
  const suffix = new Intl.PluralRules('en', { type: 'ordinal' }).select(count)
  return `${count}${suffix === 'one' ? 'st' : suffix === 'two' ? 'nd' : suffix === 'few' ? 'rd' : 'th'}`
}

/** Why the login item cannot be used here, or what it needs; empty when it works. */
export function loginItemNote(view: ShellLifecycle['loginItem']): string {
  if (view.reason === 'development') return LIFECYCLE_COPY.loginDevelopment
  if (view.reason === 'platform') return LIFECYCLE_COPY.loginPlatform
  if (view.needsApproval) return LIFECYCLE_COPY.loginApproval
  return ''
}

/** Whether the Mac is being kept awake now and why, in a few words; empty when the switch already says it all. */
export function keepAwakeLine(view: ShellLifecycle['keepAwake']): string {
  if (view.active && view.cause === 'schedule') return LIFECYCLE_COPY.awakeScheduled
  if (!view.enabled) return ''
  if (view.active) return view.cause === 'waiting' ? LIFECYCLE_COPY.awakeWaiting : LIFECYCLE_COPY.awakeRunning
  if (view.batteryLimitReached) return LIFECYCLE_COPY.batteryLimitReached
  if (view.power === 'battery') return LIFECYCLE_COPY.batteryLimit
  return ''
}

/** The Host as main sees it, for Settings and for the connection banner. */
export function hostLine(view: ShellLifecycle['host']): { text: string; tone: Tone } {
  switch (view.status) {
    case 'starting':
      return { text: LIFECYCLE_COPY.starting, tone: 'warn' }
    case 'restarting': {
      const seconds = Math.max(1, Math.round((view.restartInMs ?? 0) / 1000))
      return { text: LIFECYCLE_COPY.restarting(seconds, view.crashes), tone: 'warn' }
    }
    case 'crash-loop':
      return { text: LIFECYCLE_COPY.crashLoop(view.crashes), tone: 'error' }
    case 'crashed':
      return view.reason === 'environment'
        ? { text: LIFECYCLE_COPY.crashedEnvironment, tone: 'error' }
        : { text: LIFECYCLE_COPY.crashedExternal, tone: 'error' }
    case 'stopped':
      return { text: LIFECYCLE_COPY.stopped, tone: 'warn' }
    case 'unresponsive':
      return { text: LIFECYCLE_COPY.unresponsive, tone: 'error' }
    case 'running':
      if (view.supervised) return { text: LIFECYCLE_COPY.runningSupervised, tone: 'neutral' }
      return view.reason === 'environment'
        ? { text: LIFECYCLE_COPY.runningEnvironment, tone: 'neutral' }
        : { text: LIFECYCLE_COPY.runningExternal, tone: 'neutral' }
  }
}

/** Whether 「启动 Latch」 can help: the Host stopped, or main stopped restarting it. A Host it never started it cannot. */
export function hostNeedsStart(view: ShellLifecycle['host']): boolean {
  return view.status === 'crash-loop' || view.status === 'stopped'
}

/**
 * The desktop app's lifecycle state, kept current from main's pushes; null in a browser or an older shell. Actions
 * resolve with main's refusal message, or an empty string when they worked.
 */
export function useShellLifecycle() {
  const api = currentShell()?.lifecycle
  const [view, setView] = useState<ShellLifecycle | null>(null)
  useEffect(() => {
    if (!api) return
    let alive = true
    const unsubscribe = api.subscribe(next => {
      if (alive) setView(next)
    })
    void api.get().then(
      result => {
        if (alive && result.ok) setView(result.lifecycle)
      },
      () => {},
    )
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])
  const run = useCallback(async (action: () => Promise<ShellLifecycleResult>): Promise<string> => {
    try {
      const result = await action()
      if (!result.ok) return describeFailure(0, result.error)
      setView(result.lifecycle)
      return ''
    } catch {
      return LIFECYCLE_COPY.appUnresponsive
    }
  }, [])
  return {
    view,
    setLoginItem: (enabled: boolean) => (api ? run(() => api.setLoginItem(enabled)) : Promise.resolve('')),
    setKeepAwake: (enabled: boolean) => (api ? run(() => api.setKeepAwake(enabled)) : Promise.resolve('')),
    restartHost: () => (api ? run(() => api.restartHost()) : Promise.resolve('')),
  }
}
