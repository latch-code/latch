import { useCallback, useEffect, useState } from 'react'
import { currentShell, type ShellUpdates, type UpdateView } from './shell.ts'

/** The shell's update actions, only when every one of them is there (an older shell or a browser has none). */
export function shellUpdates(): ShellUpdates | null {
  const updates = currentShell()?.updates
  if (!updates) return null
  return (['get', 'check', 'download', 'install', 'cancelWaiting', 'setAutoDownload', 'onChange'] as const).every(
    key => typeof updates[key] === 'function',
  )
    ? updates
    : null
}

/**
 * The desktop app's update state, kept current from main's pushes; null in a browser or an older shell. Each action
 * resolves when main answered; main's view then arrives as the new state.
 */
export function useShellUpdates() {
  const api = shellUpdates()
  const [view, setView] = useState<UpdateView | null>(null)
  useEffect(() => {
    if (!api) return
    let alive = true
    const unsubscribe = api.onChange(next => {
      if (alive) setView(next)
    })
    void api.get().then(
      next => {
        if (alive && next) setView(next)
      },
      () => {},
    )
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])
  const run = useCallback(async (action: () => Promise<UpdateView | undefined>) => {
    try {
      const next = await action()
      if (next) setView(next)
    } catch {
      // Main went away; the view stays as it was and the next push corrects it.
    }
  }, [])
  return {
    view,
    check: () => (api ? run(() => api.check()) : Promise.resolve()),
    download: () => (api ? run(() => api.download()) : Promise.resolve()),
    install: (when: 'now' | 'at-quit' = 'now') => (api ? run(() => api.install(when)) : Promise.resolve()),
    cancelWaiting: () => (api ? run(() => api.cancelWaiting()) : Promise.resolve()),
    setAutoDownload: (enabled: boolean) => (api ? run(() => api.setAutoDownload(enabled)) : Promise.resolve()),
  }
}
