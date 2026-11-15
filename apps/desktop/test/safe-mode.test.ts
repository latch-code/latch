import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const menus = require('../src/menu.cjs') as {
  menuTemplate(input: { packaged: boolean; onCheckForUpdates(): void; onSafeMode?(): void }): Array<{
    label: string
    submenu: Array<{ id?: string; label?: string; enabled?: boolean; accelerator?: string; click?(): void }>
  }>
  safeModeUrl(current: string): string | null
  openSafeMode(contents: unknown, timers?: { wait?: (run: () => void, ms: number) => unknown; home?: string }): boolean
}

const REMOTE = `h-${'abcdefghijklmnopqrstuvwxyz234567'.repeat(2).slice(0, 52)}`

/** A window's contents as main sees them: what it was asked to load, and how often it was loaded again. */
function contents(url: string, options: { answers?: boolean; destroyed?: boolean } = {}) {
  const calls = { loaded: [] as string[], reloads: 0, waits: [] as Array<{ run: () => void; ms: number }> }
  type Listener = (event: object, url: string, isMainFrame: boolean) => void
  const listeners = new Map<string, Listener>()
  let settle: () => void = () => {}
  let fail: () => void = () => {}
  return {
    calls,
    /** The fragment landed in the page. */
    landed: (target = calls.loaded.at(-1)!, isMainFrame = true) => {
      if (isMainFrame) url = target
      listeners.get('did-navigate-in-page')?.({}, target, isMainFrame)
    },
    move: (target: string) => {
      url = target
    },
    /** The load main asked for settled. */
    settled: () => settle(),
    failed: () => fail(),
    listenerCount: () => listeners.size,
    timers: { wait: (run: () => void, ms: number) => calls.waits.push({ run, ms }) },
    value: {
      getURL: () => url,
      isDestroyed: () => options.destroyed === true,
      once: (name: string, listener: Listener) => void listeners.set(name, listener),
      on: (name: string, listener: Listener) => void listeners.set(name, listener),
      removeListener: (name: string, listener: Listener) => {
        if (listeners.get(name) === listener) listeners.delete(name)
      },
      loadURL: (target: string) => {
        calls.loaded.push(target)
        return new Promise<void>((done, reject) => {
          settle = done
          fail = () => reject(new Error('fixture load failed'))
        })
      },
      reloadIgnoringCache: () => void calls.reloads++,
    },
  }
}

describe('用默认外观打开', () => {
  it('is in 显示, always on, and asks nothing of the page', () => {
    let opened = 0
    const view = menus.menuTemplate({ packaged: true, onCheckForUpdates: () => {}, onSafeMode: () => opened++ })[2]!
    expect(view.label).toBe('显示')
    const item = view.submenu.find(entry => entry.id === 'safe-mode')!
    expect([item.label, item.enabled, item.accelerator]).toEqual(['用默认外观打开', undefined, undefined])
    item.click!()
    expect(opened).toBe(1)
    // Without a handler the item does nothing instead of failing.
    expect(() =>
      menus.menuTemplate({ packaged: true, onCheckForUpdates: () => {} })[2]!.submenu.find(entry => entry.id === 'safe-mode')!.click!(),
    ).not.toThrow()
  })

  it('sends a Latch page of this app to itself with #safe as the fragment, and nothing else anywhere', () => {
    expect(menus.safeModeUrl('latch://app/link/')).toBe('latch://app/link/#safe')
    expect(menus.safeModeUrl(`latch://${REMOTE}/link/?x=1#pair=abc`)).toBe(`latch://${REMOTE}/link/?x=1#safe`)
    // The fragment is the whole request: the origin, the path and the query stay the window's own.
    const target = new URL(menus.safeModeUrl('latch://app/link/index.html')!)
    expect([target.protocol, target.host, target.pathname, target.search, target.hash]).toEqual([
      'latch:',
      'app',
      '/link/index.html',
      '',
      '#safe',
    ])
    for (const other of [
      'about:blank',
      'file:///Users/a/link/index.html',
      'https://example.com/link/',
      'http://127.0.0.1:4317/link/',
      'latch://app/other',
      'latch://user:pass@app/link/',
      'latch://app:42/link/',
      'latch://evil.example/link/',
      // Another computer's home is exactly `h-` and 52 base32 characters, as the preload has it.
      'latch://h-abc123/link/',
      `latch://${REMOTE}x/link/`,
      `latch://${REMOTE.toUpperCase()}/other`,
      'latch://h-0189/link/',
      'not a url',
      '',
    ])
      expect(menus.safeModeUrl(other), other).toBeNull()
  })

  it('loads the window again once the fragment has landed, and only once', async () => {
    const page = contents('latch://app/link/')
    expect(menus.openSafeMode(page.value, page.timers)).toBe(true)
    expect([page.calls.loaded, page.calls.reloads]).toEqual([['latch://app/link/#safe'], 0])
    page.landed()
    expect(page.calls.reloads).toBe(1)
    // The load settling and the timer both come after: neither loads the page a second time.
    page.settled()
    await Promise.resolve()
    expect(page.calls.waits.map(wait => wait.ms)).toEqual([1_000])
    page.calls.waits[0]!.run()
    expect(page.calls.reloads).toBe(1)
  })

  it('waits for the exact main-frame address and leaves the other computer alone', () => {
    const local = contents('latch://app/link/')
    const remote = contents(`latch://${REMOTE}/link/?x=1`)
    expect(menus.openSafeMode(local.value, local.timers)).toBe(true)
    local.landed('latch-frame://app/preview/html.html#1', false)
    local.landed('latch://app/link/another#safe')
    expect(local.calls.reloads).toBe(0)
    local.landed()
    expect(local.calls.reloads).toBe(1)
    expect(local.listenerCount()).toBe(0)
    expect(remote.calls.loaded).toHaveLength(0)
    expect(menus.openSafeMode(remote.value, { ...remote.timers, home: 'app' })).toBe(false)
    expect(menus.openSafeMode(remote.value, { ...remote.timers, home: REMOTE })).toBe(true)
    remote.landed()
    expect(remote.calls.reloads).toBe(1)
    expect(local.calls.reloads).toBe(1)
  })

  it('does not reload a failed navigation or a window that has moved away', async () => {
    const failed = contents('latch://app/link/')
    menus.openSafeMode(failed.value, failed.timers)
    failed.failed()
    await Promise.resolve()
    failed.landed()
    failed.calls.waits[0]!.run()
    expect(failed.calls.reloads).toBe(0)
    expect(failed.listenerCount()).toBe(0)

    const moved = contents('latch://app/link/?x=1')
    menus.openSafeMode(moved.value, moved.timers)
    moved.move(`latch://${REMOTE}/link/`)
    moved.settled()
    await Promise.resolve()
    moved.calls.waits[0]!.run()
    expect(moved.calls.reloads).toBe(0)
    expect(moved.listenerCount()).toBe(0)
  })

  it('loads it again after a second when the page never answers, and does nothing to a window that is gone or shows something else', () => {
    const silent = contents('latch://app/link/')
    menus.openSafeMode(silent.value, silent.timers)
    expect(silent.calls.reloads).toBe(0)
    silent.move('latch://app/link/#safe')
    silent.calls.waits[0]!.run()
    expect(silent.calls.reloads).toBe(1)
    for (const other of [contents('https://example.com/link/'), contents('latch://app/link/', { destroyed: true })]) {
      expect(menus.openSafeMode(other.value, other.timers)).toBe(false)
      expect([other.calls.loaded, other.calls.reloads, other.calls.waits]).toEqual([[], 0, []])
    }
    expect(menus.openSafeMode(null)).toBe(false)
    expect(menus.openSafeMode(undefined)).toBe(false)
  })
})
