import { useCallback, useEffect, useState } from 'react'
import { currentShell, type ShellLifecycle, type ShellLifecycleResult } from './shell.ts'

type Tone = 'neutral' | 'warn' | 'error'

/** Why the login item cannot be used here, or what it needs; empty when it works. */
export function loginItemNote(view: ShellLifecycle['loginItem']): string {
  if (view.reason === 'development') return '只有打包后的 Latch 应用能登记为登录项。当前是开发运行（pnpm desktop），打包版本尚未提供。'
  if (view.reason === 'platform') return '只在 macOS 上可用。'
  if (view.needsApproval) return '需要在「系统设置 › 通用 › 登录项」中允许 Latch。'
  return ''
}

/** Whether the Mac is being kept awake now, and why or why not. */
export function keepAwakeLine(view: ShellLifecycle['keepAwake']): string {
  if (!view.enabled) return '已关闭：有任务时电脑也会按系统设置休眠。'
  if (view.active)
    return view.cause === 'waiting'
      ? '保持唤醒中：有审批在等你处理。显示器仍按系统设置熄灭。'
      : '保持唤醒中：有会话正在运行。显示器仍按系统设置熄灭。'
  if (view.batteryLimitReached) return '正在使用电池：已保持唤醒 1 小时，之后电脑按系统设置休眠。'
  if (view.power === 'battery') return '正在使用电池：只在会话运行时保持唤醒，每次最长 1 小时。'
  return '没有运行中的会话或等待的审批，电脑按系统设置休眠。'
}

/** The Host as main sees it, for Settings and for the connection banner. */
export function hostLine(view: ShellLifecycle['host']): { text: string; tone: Tone } {
  switch (view.status) {
    case 'starting':
      return { text: 'Latch Host 正在启动…', tone: 'warn' }
    case 'restarting': {
      const seconds = Math.max(1, Math.round((view.restartInMs ?? 0) / 1000))
      return { text: `Latch Host 意外退出，${seconds} 秒后重新启动（10 分钟内第 ${view.crashes} 次）。`, tone: 'warn' }
    }
    case 'crash-loop':
      return {
        text: `Latch Host 在 10 分钟内意外退出 ${view.crashes} 次，已停止自动重启。请查看数据目录中的 host.log，再重新启动。`,
        tone: 'error',
      }
    case 'crashed':
      return view.reason === 'environment'
        ? { text: 'Latch Host 意外退出。它的设置来自环境变量，桌面端不能按原样启动，请重新运行 pnpm desktop。', tone: 'error' }
        : { text: 'Latch Host 意外退出。它不是由 Latch 桌面端启动的，不会自动重新启动。', tone: 'error' }
    case 'stopped':
      return { text: 'Latch Host 已停止。', tone: 'warn' }
    case 'unresponsive':
      return {
        text: 'Latch Host 没有响应：进程仍在，但无法通过 host.sock 核对。在它恢复应答之前，电脑不会为它保持唤醒。',
        tone: 'error',
      }
    case 'running':
      if (view.supervised) return { text: 'Latch Host 运行中。意外退出后会自动重新启动。', tone: 'neutral' }
      return view.reason === 'environment'
        ? { text: 'Latch Host 运行中。它的设置来自环境变量，意外退出后不会自动重新启动。', tone: 'neutral' }
        : { text: 'Latch Host 运行中。它不是由 Latch 桌面端启动的，意外退出后不会自动重新启动。', tone: 'neutral' }
  }
}

/** Whether 「启动 Host」 can help: the Host stopped, or main stopped restarting it. A Host it never started it cannot. */
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
      if (!result.ok) return result.message
      setView(result.lifecycle)
      return ''
    } catch {
      return '桌面端没有响应，请重试。'
    }
  }, [])
  return {
    view,
    setLoginItem: (enabled: boolean) => (api ? run(() => api.setLoginItem(enabled)) : Promise.resolve('')),
    setKeepAwake: (enabled: boolean) => (api ? run(() => api.setKeepAwake(enabled)) : Promise.resolve('')),
    restartHost: () => (api ? run(() => api.restartHost()) : Promise.resolve('')),
  }
}
