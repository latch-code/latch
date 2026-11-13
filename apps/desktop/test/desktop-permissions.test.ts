import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
type Details = { isMainFrame: boolean; requestingUrl?: string }
interface Contents {
  getURL(): string
  isDestroyed(): boolean
}
interface Gesture {
  mouse(input: { type: string; button: string }): void
  recent(ms: number): boolean
  take(): boolean
}
const { appPermissionHandlers, createExternalGesture } = require('../src/proxy.cjs') as {
  appPermissionHandlers(
    home: string,
    window: {
      fromWebContents(contents: Contents): { webContents: Contents } | null
      homeOf(contents: Contents): string
      isPreviewTab(contents: Contents): boolean
      gestureOf(contents: Contents): Gesture | undefined
    },
  ): {
    request(contents: Contents, permission: string, callback: (granted: boolean) => void, details: Details): void
    check(contents: Contents | null, permission: string, origin: string, details: Details): boolean
  }
  createExternalGesture(now?: () => number): Gesture
}

const REMOTE = `h-${'a'.repeat(52)}`
const WRITE = 'clipboard-sanitized-write'

/** main's world in miniature: windows own their page, homes and gestures per contents, preview tabs on the side. */
function shell() {
  let clock = 0
  const windows = new Map<Contents, { webContents: Contents }>()
  const homes = new Map<Contents, string>()
  const gestures = new Map<Contents, Gesture>()
  const previews = new Set<Contents>()
  const page = (url: string, options: { home?: string; window?: boolean; preview?: boolean } = {}) => {
    const contents: Contents = { getURL: () => url, isDestroyed: () => false }
    if (options.window !== false) windows.set(contents, { webContents: contents })
    if (options.home) homes.set(contents, options.home)
    if (options.preview) previews.add(contents)
    gestures.set(
      contents,
      createExternalGesture(() => clock),
    )
    return contents
  }
  const handlers = (home: string) =>
    appPermissionHandlers(home, {
      fromWebContents: contents => windows.get(contents) ?? null,
      homeOf: contents => homes.get(contents) ?? 'app',
      isPreviewTab: contents => previews.has(contents),
      gestureOf: contents => gestures.get(contents),
    })
  const asked = (home: string, contents: Contents, permission: string, details: Details) => {
    const { request, check } = handlers(home)
    let granted: boolean | undefined
    request(
      contents,
      permission,
      value => {
        granted = value
      },
      details,
    )
    return [granted, check(contents, permission, '', details)]
  }
  const press = (contents: Contents) => gestures.get(contents)!.mouse({ type: 'mouseUp', button: 'left' })
  return { page, asked, press, handlers, tick: (ms: number) => (clock += ms), gestures }
}

describe('app page permissions', () => {
  it('lets this Mac’s top-level page write the clipboard without a press', () => {
    const { page, asked } = shell()
    const top = { isMainFrame: true, requestingUrl: 'latch://app/link/' }
    expect(asked('app', page('latch://app/link/'), WRITE, top)).toEqual([true, true])
  })

  it('lets another computer’s page write only within five seconds of a native press, which stays unspent', () => {
    const { page, asked, press, tick, gestures } = shell()
    const remote = page(`latch://${REMOTE}/link/`, { home: REMOTE })
    const top = { isMainFrame: true, requestingUrl: `latch://${REMOTE}/link/` }
    expect(asked(REMOTE, remote, WRITE, top)).toEqual([false, false])
    press(remote)
    tick(4000)
    expect(asked(REMOTE, remote, WRITE, top)).toEqual([true, true])
    tick(1500)
    expect(asked(REMOTE, remote, WRITE, top)).toEqual([false, false])
    press(remote)
    expect(asked(REMOTE, remote, WRITE, top)).toEqual([true, true])
    // A link opened by the same press still has it.
    expect(gestures.get(remote)!.take()).toBe(true)
  })

  it('refuses reading the clipboard and every other permission', () => {
    const { page, asked } = shell()
    const top = { isMainFrame: true, requestingUrl: 'latch://app/link/' }
    for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'notifications', 'media', 'unknown'])
      expect(asked('app', page('latch://app/link/'), permission, top)).toEqual([false, false])
  })

  it('refuses subframes, preview tabs, views that are not the window’s page and another computer’s page', () => {
    const { page, asked, handlers } = shell()
    const local = page('latch://app/link/')
    for (const requestingUrl of ['latch-frame://preview/html.html', 'latch-frame://app/runtime.html', 'latch://app/link/'])
      expect(asked('app', local, WRITE, { isMainFrame: false, requestingUrl })).toEqual([false, false])
    const top = { isMainFrame: true, requestingUrl: 'latch://app/link/' }
    expect(asked('app', page('latch://app/link/', { preview: true }), WRITE, top)).toEqual([false, false])
    expect(
      asked('app', page('https://example.test/', { preview: true, window: false }), WRITE, {
        isMainFrame: true,
        requestingUrl: 'https://example.test/',
      }),
    ).toEqual([false, false])
    // A view laid over the window, even on this Mac's origin, is not the window's own page.
    expect(asked('app', page('latch://app/link/', { window: false }), WRITE, top)).toEqual([false, false])
    // A remote window's page asking under this Mac's home, and the other way round.
    expect(
      asked('app', page(`latch://${REMOTE}/link/`, { home: REMOTE }), WRITE, {
        isMainFrame: true,
        requestingUrl: `latch://${REMOTE}/link/`,
      }),
    ).toEqual([false, false])
    expect(asked(REMOTE, local, WRITE, top)).toEqual([false, false])
    expect(asked('app', local, WRITE, { isMainFrame: true })).toEqual([false, false])
    expect(handlers('app').check(null, WRITE, 'latch://app', top)).toBe(false)
  })
})
