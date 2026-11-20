import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type Handle = { contents: unknown; reveal(): void; allowed(): void; close(): void }
type Guide = {
  show(): boolean
  close(): void
  mainFocused(): void
  owns(contents: unknown): boolean
  isOpen(): boolean
}
const guide = require('../src/local-network-guide.cjs') as {
  ALLOWED_MS: number
  FOCUS_GRACE_MS: number
  GUIDE_ALLOWED_URL: string
  GUIDE_CLOSE_CHANNEL: string
  GUIDE_CSP: string
  GUIDE_SIZE: { width: number; height: number }
  GUIDE_URL: string
  LOCAL_NETWORK_OPEN_CHANNEL: string
  POLL_MS: number
  TIMEOUT_MS: number
  createLocalNetworkGuide(options: {
    packaged: boolean
    openWindow(hooks: { onClosed(): void }): Handle
    readAccess(): Promise<string | undefined>
    timers?: unknown
    now?: () => number
  }): Guide
  guideBounds(workArea: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number }
  guidePage(input?: { icon?: string }): string
  guideResponse(request: Request, input: { icon?: string }): Response | undefined
  guideWindowOptions(input: { preload: string; bounds: object; darwin: boolean }): Record<string, unknown> & {
    webPreferences: Record<string, unknown>
  }
}

describe('the guide page', () => {
  it('loads nothing and connects nowhere: inline style, the inlined mark and one script whose hash the policy names', () => {
    const icon = `data:image/png;base64,${Buffer.from('png').toString('base64')}`
    const page = guide.guidePage({ icon })
    expect(page).toContain(`content="${guide.GUIDE_CSP}"`)
    expect(guide.GUIDE_CSP).toContain("default-src 'none'")
    expect(guide.GUIDE_CSP).not.toMatch(/connect-src|frame-src|'self'|'unsafe-eval'|https?:/u)
    const scripts = [...page.matchAll(/<script>([^<]*)<\/script>/gu)].map(match => match[1]!)
    expect(scripts).toHaveLength(1)
    const hash = createHash('sha256').update(scripts[0]!).digest('base64')
    expect(guide.GUIDE_CSP).toContain(`script-src 'sha256-${hash}'`)
    expect(scripts[0]).toBe("document.getElementById('close').addEventListener('click',()=>window.latchGuide.close())")
    expect(page).not.toMatch(/<a |<link|<iframe|<form|https?:\/\//u)
    expect(page).toContain('在「本地网络」里找到 Latch，打开它的开关')
    expect(page).toContain('已允许')
    expect(page).toContain(`<img src="${icon}"`)
    // The 已允许 state is the same document at #allowed.
    expect(guide.GUIDE_ALLOWED_URL).toBe(`${guide.GUIDE_URL}#allowed`)
    expect(page).toContain('id="allowed"')
    for (const bad of ['https://example.com/x.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AA"onerror="x'])
      expect(guide.guidePage({ icon: bad })).not.toContain('<img')
  })

  it('answers only a GET of its own address, with the policy as a header', async () => {
    const response = guide.guideResponse(new Request(guide.GUIDE_URL), {})
    expect(response?.headers.get('content-security-policy')).toBe(guide.GUIDE_CSP)
    expect(await response?.text()).toBe(guide.guidePage({}))
    for (const request of [
      new Request(guide.GUIDE_URL, { method: 'POST' }),
      new Request(`${guide.GUIDE_URL}?x`),
      new Request(`${guide.GUIDE_URL}/x`),
      new Request('latch://app/link/'),
    ])
      expect(guide.guideResponse(request, {})).toBeUndefined()
  })
})

describe('the guide window', () => {
  it('stands at the bottom centre of the work area, the card 48 px above its bottom', () => {
    const { width, height } = guide.GUIDE_SIZE
    const bounds = guide.guideBounds({ x: 1440, y: 25, width: 1920, height: 1055 })
    expect(bounds).toEqual({ x: 1440 + (1920 - width) / 2, y: 25 + 1055 - 48 - 88 - (height - 88) / 2, width, height })
  })

  it('floats, never takes focus or a Dock entry, and runs its page sandboxed and isolated with no Node', () => {
    const bounds = { x: 0, y: 0, ...guide.GUIDE_SIZE }
    const options = guide.guideWindowOptions({ preload: '/x/local-network-guide-preload.cjs', bounds, darwin: true })
    expect(options).toMatchObject({
      frame: false,
      transparent: true,
      focusable: false,
      acceptFirstMouse: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      resizable: false,
      type: 'panel',
    })
    expect(options.webPreferences).toMatchObject({
      preload: '/x/local-network-guide-preload.cjs',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false,
    })
    expect(guide.guideWindowOptions({ preload: '/x', bounds, darwin: false })).not.toHaveProperty('type')
  })
})

describe('when the guide opens and closes', () => {
  let clock = 0
  let access: string | undefined
  let opened: Array<Handle & { onClosed(): void }>
  beforeEach(() => {
    vi.useFakeTimers()
    clock = 0
    access = 'denied'
    opened = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  function make(packaged = true) {
    const readAccess = vi.fn(async () => access)
    const created = guide.createLocalNetworkGuide({
      packaged,
      readAccess,
      now: () => clock,
      timers: { setTimeout, clearTimeout, setInterval, clearInterval },
      openWindow: ({ onClosed }) => {
        const handle = {
          contents: { id: opened.length },
          reveal: vi.fn(),
          allowed: vi.fn(),
          close: vi.fn(() => onClosed()),
          onClosed,
        }
        opened.push(handle)
        return handle
      },
    })
    return { created, readAccess }
  }
  const advance = async (ms: number) => {
    clock += ms
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('opens only in the packaged app', () => {
    const { created } = make(false)
    expect(created.show()).toBe(false)
    expect(opened).toHaveLength(0)
    expect(created.isOpen()).toBe(false)
  })

  it('asks the Host once a second and, on allowed, shows 已允许 and closes 1.2 s later', async () => {
    const { created, readAccess } = make()
    expect(created.show()).toBe(true)
    await advance(guide.POLL_MS)
    expect(readAccess).toHaveBeenCalledTimes(1)
    // Unknown or still refused keeps it open.
    access = undefined
    await advance(guide.POLL_MS)
    expect(created.isOpen()).toBe(true)
    access = 'allowed'
    await advance(guide.POLL_MS)
    expect(opened[0]!.allowed).toHaveBeenCalledTimes(1)
    expect(opened[0]!.close).not.toHaveBeenCalled()
    await advance(guide.POLL_MS)
    expect(readAccess).toHaveBeenCalledTimes(3)
    await advance(guide.ALLOWED_MS - guide.POLL_MS)
    expect(opened[0]!.close).toHaveBeenCalledTimes(1)
    expect(created.isOpen()).toBe(false)
  })

  it('never asks twice at once, and a failed answer keeps it open', async () => {
    let release: (value: string) => void = () => {}
    const { created, readAccess } = make()
    readAccess.mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
    readAccess.mockRejectedValueOnce(new Error('down'))
    created.show()
    await advance(guide.POLL_MS * 3)
    expect(readAccess).toHaveBeenCalledTimes(1)
    release('denied')
    await advance(guide.POLL_MS)
    expect(readAccess).toHaveBeenCalledTimes(2)
    await advance(guide.POLL_MS)
    expect(created.isOpen()).toBe(true)
  })

  it('closes on × from its own page only', () => {
    const { created } = make()
    created.show()
    expect(created.owns({ id: 0 })).toBe(false)
    expect(created.owns(undefined)).toBe(false)
    expect(created.owns(opened[0]!.contents)).toBe(true)
    created.close()
    expect(opened[0]!.close).toHaveBeenCalledTimes(1)
    expect(created.owns(opened[0]!.contents)).toBe(false)
  })

  it('closes after five minutes, counted again from a second press, which reuses the window', async () => {
    const { created, readAccess } = make()
    created.show()
    await advance(guide.TIMEOUT_MS - 1000)
    expect(created.show()).toBe(true)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.reveal).toHaveBeenCalledTimes(1)
    await advance(guide.TIMEOUT_MS - 1000)
    expect(created.isOpen()).toBe(true)
    await advance(1000)
    expect(opened[0]!.close).toHaveBeenCalledTimes(1)
    const asked = readAccess.mock.calls.length
    await advance(guide.POLL_MS * 5)
    expect(readAccess).toHaveBeenCalledTimes(asked)
  })

  it('closes when this Mac’s window is focused again, but not on a bounce while System Settings opens', async () => {
    const { created } = make()
    created.show()
    await advance(guide.FOCUS_GRACE_MS - 500)
    created.mainFocused()
    expect(created.isOpen()).toBe(true)
    await advance(500)
    created.mainFocused()
    expect(opened[0]!.close).toHaveBeenCalledTimes(1)
  })

  it('forgets a window the system closed', async () => {
    const { created, readAccess } = make()
    created.show()
    opened[0]!.onClosed()
    expect(created.isOpen()).toBe(false)
    await advance(guide.POLL_MS * 3)
    expect(readAccess).not.toHaveBeenCalled()
    created.show()
    expect(opened).toHaveLength(2)
  })
})

describe('the preloads', () => {
  async function load(file: string, href = 'latch://app/link/') {
    const exposed = new Map<string, Record<string, (...args: unknown[]) => unknown>>()
    const send = vi.fn()
    const invoke = vi.fn(async () => true)
    runInNewContext(await readFile(file, 'utf8'), {
      process: { platform: 'darwin', isMainFrame: true, argv: [] },
      location: { href },
      URL,
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (name: string, value: Record<string, (...args: unknown[]) => unknown>) => exposed.set(name, value),
        },
        ipcRenderer: { send, invoke, on: () => {}, removeListener: () => {} },
        webUtils: { getPathForFile: () => '' },
      }),
    })
    return { exposed, send, invoke }
  }

  it('gives the guide page close() and nothing else, on the one channel main checks', async () => {
    const { exposed, send, invoke } = await load('apps/desktop/src/local-network-guide-preload.cjs', guide.GUIDE_URL)
    expect([...exposed.keys()]).toEqual(['latchGuide'])
    const api = exposed.get('latchGuide')!
    expect(Object.keys(api)).toEqual(['close'])
    expect(Object.isFrozen(api)).toBe(true)
    api.close!('anything', { x: 1 })
    expect(send).toHaveBeenCalledWith(guide.GUIDE_CLOSE_CHANNEL)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('gives this Mac’s page one call that sends nothing and answers a boolean', async () => {
    const { exposed, invoke } = await load('apps/desktop/src/preload.cjs')
    const local = exposed.get('latchShell')!.localNetwork as unknown as { openSettings(...args: unknown[]): Promise<unknown> }
    expect(Object.keys(local)).toEqual(['openSettings'])
    invoke.mockResolvedValueOnce('yes' as never)
    expect(await local.openSettings('x-apple.systempreferences:other')).toBe(false)
    expect(await local.openSettings()).toBe(true)
    expect(invoke).toHaveBeenCalledWith(guide.LOCAL_NETWORK_OPEN_CHANNEL)
    expect(invoke.mock.calls.every(call => (call as unknown[]).length === 1)).toBe(true)
    const remote = await load('apps/desktop/src/preload.cjs', `latch://h-${'a'.repeat(52)}/link/`)
    expect(remote.exposed.get('latchShell')).not.toHaveProperty('localNetwork')
  })

  it('main answers the open call only for its own page after a real press, and the close message only from the guide', async () => {
    const main = await readFile('apps/desktop/src/main.cjs', 'utf8')
    expect(main).toMatch(
      /ipcMain\.handle\(LOCAL_NETWORK_OPEN_CHANNEL, async event => \{\n\s+if \(!trusted\(event\) \|\| gestures\.get\(event\.sender\)\?\.take\(\) !== true\) return false/u,
    )
    expect(main).toMatch(/ipcMain\.on\(GUIDE_CLOSE_CHANNEL, event => \{\n\s+if \(localNetworkGuide\?\.owns\(event\.sender\)\)/u)
    expect(main).toContain("packaged: app.isPackaged && process.platform === 'darwin'")
  })
})
