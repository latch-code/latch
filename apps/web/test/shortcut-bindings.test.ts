import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SHORTCUTS, shortcutRefusal, type ShortcutsReceipt } from '@latch/protocol'
import { ApiError, NoAnswerError } from '../src/core/api.ts'
import { ShortcutBindings, shortcutBindings } from '../src/core/shortcutBindings.ts'
import { recordedChord, rebound } from '../src/settings/ShortcutsSettings.tsx'
import { followUpShortcuts, shortcutKeys, shortcutMatches, shortcutRows, workbenchShortcut } from '../src/workbenchShortcuts.ts'

const key = (code: string, extra = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
const identity = { hostId: 'host-1', deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rebinding a shortcut', () => {
  it('keeps send and queue on their named keys when the primary action changes', () => {
    const bindings = vi.spyOn(shortcutBindings, 'bindings').mockReturnValue({})
    expect(followUpShortcuts('queue', false)).toEqual({ queue: null, steer: 'Mod+Shift+Enter' })
    bindings.mockReturnValue({ 'send-now': 'Mod+Alt+KeyG', 'queue-message': 'Mod+Shift+KeyM' })
    const rows = (followUpDefault: 'queue' | 'steer') =>
      shortcutRows(false, false, { followUpDefault })
        .filter(row => row.id === 'send-now' || row.id === 'queue-message')
        .map(row => row.keys)
    expect(rows('queue')).toEqual(['Ctrl Alt G', 'Enter · Ctrl Shift M'])
    expect(rows('steer')).toEqual(['Enter · Ctrl Alt G', 'Ctrl Shift M'])
  })

  it('preserves chords already assigned to other actions when choosing a secondary send shortcut', () => {
    vi.spyOn(shortcutBindings, 'bindings').mockReturnValue({ palette: 'Mod+Shift+Enter', usage: 'Mod+Alt+Enter' })
    expect(followUpShortcuts('steer', false)).toEqual({ steer: null, queue: 'Mod+Alt+Shift+Enter' })
  })

  it('keeps the keys every client had before anyone rebinds one', () => {
    const before: Record<string, [string | null, string | null]> = {
      settings: ['⌘,', 'Alt ,'],
      new: ['⌘N', 'Alt N'],
      'space-code': ['⇧⌘1', 'Ctrl Shift 1'],
      palette: ['⌘K', 'Ctrl K'],
      'side-panel': ['⌥⌘B', 'Alt Shift B'],
      previous: ['⇧⌘[', 'Alt ['],
      'next-approval': ['⌥⌘A', 'Alt Shift A'],
      browser: ['⇧⌘B', null],
      pick: ['⇧⌘S', null],
      find: ['⌘F', 'Ctrl F'],
      shortcuts: ['⌘/', 'Alt /'],
      'terminal-split': ['⌘\\', null],
      decide: ['⌘⏎ · esc', 'Ctrl Enter · Esc'],
    }
    for (const [id, [desktop, browser]] of Object.entries(before)) {
      expect(shortcutKeys(id as never, true, true), id).toBe(desktop)
      expect(shortcutKeys(id as never, false, false), id).toBe(browser)
    }
  })

  it('answers the rebound keys and no longer the old ones, everywhere they are printed or matched', () => {
    vi.spyOn(shortcutBindings, 'bindings').mockReturnValue({ new: 'Alt+Shift+KeyY', palette: 'Alt+KeyY', 'space-code': 'Alt+Shift+KeyC' })
    expect(workbenchShortcut(key('KeyY', { altKey: true, shiftKey: true }), false)).toBe('new')
    expect(workbenchShortcut(key('KeyN', { altKey: true }), false)).toBeNull()
    expect(workbenchShortcut(key('KeyC', { altKey: true, shiftKey: true }), false)).toEqual({ kind: 'space', space: 'code' })
    expect(workbenchShortcut(key('Digit1', { metaKey: true, shiftKey: true }), false)).toBeNull()
    expect(shortcutMatches(key('KeyY', { altKey: true }), 'palette', false)).toBe(true)
    expect(shortcutMatches(key('KeyK', { metaKey: true }), 'palette', false)).toBe(false)
    // A browser's Alt chord that types a character in a field is still typing.
    expect(shortcutMatches(key('KeyY', { altKey: true, key: '¥', typing: true }), 'palette', false)).toBe(false)
    expect(shortcutKeys('new', false, true)).toBe('Alt Shift Y')
    expect(shortcutRows(false, true).find(row => row.id === 'palette')?.keys).toBe('Alt Y')
    // The fixed keys stay where they were.
    expect(workbenchShortcut(key('Digit3', { altKey: true }), false)).toEqual({ kind: 'session', index: 3 })
  })

  it('refuses taken, fixed and reserved keys, naming what has them', () => {
    expect(shortcutRefusal('browser', {}, 'new', 'Alt+KeyB')).toEqual({ kind: 'conflict', action: 'sidebar' })
    expect(shortcutRefusal('browser', {}, 'new', 'Alt+Digit2')).toEqual({ kind: 'fixed', label: '跳到第 N 个会话' })
    expect(shortcutRefusal('browser', {}, 'new', 'Mod+KeyT')).toEqual({ kind: 'browser' })
    expect(shortcutRefusal('browser', {}, 'new', 'Mod+Space')).toEqual({ kind: 'system' })
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+KeyV')).toEqual({ kind: 'menu' })
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+KeyT')).toBeNull()
  })

  it('records a key press as a chord, and drops a binding that returns to its default', () => {
    expect(recordedChord(key('KeyY', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+KeyY')
    expect(recordedChord(key('KeyY', { ctrlKey: true, altKey: true }))).toBe('Mod+Alt+KeyY')
    expect(recordedChord(key('ShiftLeft', { shiftKey: true }))).toBeNull()
    expect(recordedChord(key('MetaRight', { metaKey: true }))).toBeNull()
    expect(rebound({ new: 'Alt+KeyY' }, 'new', DEFAULT_SHORTCUTS.new.browser)).toEqual({})
    expect(rebound({ new: 'Alt+KeyY' }, 'palette', 'Alt+KeyU')).toEqual({ new: 'Alt+KeyY', palette: 'Alt+KeyU' })
    expect(rebound({ new: 'Alt+KeyY', palette: 'Alt+KeyU' }, 'palette', null)).toEqual({ new: 'Alt+KeyY' })
  })
})

describe("this device's bindings", () => {
  const receipt = (revision: number, bindings: Record<string, string> | null, requestId: string): ShortcutsReceipt => ({
    revision,
    doc: bindings ? { schema: 1, client: 'browser', bindings } : null,
    requestId,
    applied: revision,
    replayed: false,
  })

  it('reads them from the Host, saves one, resets all, and starts from the defaults on another Host', async () => {
    const sent: unknown[] = []
    const store = new ShortcutBindings(
      async request => {
        sent.push(request)
        return request.kind === 'apply'
          ? receipt(request.baseRevision + 1, request.doc.bindings, request.requestId)
          : receipt(request.baseRevision + 1, null, request.requestId)
      },
      async () => ({ revision: 1, doc: { schema: 1, client: 'browser', bindings: { new: 'Alt+KeyY' } } }),
      () => 'browser',
    )
    await store.load(identity, true)
    expect(store.bindings()).toEqual({ new: 'Alt+KeyY' })
    expect(store.effective().get('new')).toBe('Alt+KeyY')
    expect(await store.apply({ new: 'Alt+KeyY', palette: 'Alt+KeyU' })).toEqual({ kind: 'done' })
    expect(sent.at(-1)).toMatchObject({ kind: 'apply', baseRevision: 1, doc: { client: 'browser', bindings: { palette: 'Alt+KeyU' } } })
    expect(store.snapshot().state.revision).toBe(2)
    expect(await store.reset()).toEqual({ kind: 'done' })
    expect(store.bindings()).toEqual({})
    await store.load({ ...identity, hostId: 'host-2' }, false)
    expect(store.snapshot().state).toEqual({ revision: 0, doc: null })
  })

  it("keeps a desktop document out of a browser's keys", async () => {
    const store = new ShortcutBindings(
      async () => {
        throw new Error('unused')
      },
      async () => ({ revision: 1, doc: { schema: 1, client: 'desktop', bindings: { new: 'Mod+KeyY' } } }),
      () => 'browser',
    )
    await store.load(identity, true)
    expect(store.bindings()).toEqual({})
  })

  it('keeps the original request when the answer does not come, and retries it with the same ID', async () => {
    const requests: Array<{ requestId: string }> = []
    let fail = true
    const store = new ShortcutBindings(
      async request => {
        requests.push(request)
        if (fail) throw new NoAnswerError()
        return receipt(1, request.kind === 'apply' ? request.doc.bindings : null, request.requestId)
      },
      async () => ({ revision: 0, doc: null }),
      () => 'browser',
    )
    await store.load(identity, true)
    expect(await store.apply({ new: 'Alt+KeyY' })).toEqual({ kind: 'unknown' })
    expect(store.snapshot().pending?.unknown?.retryable).toBe(true)
    // Nothing new is sent while the first one's result is unknown.
    expect(await store.apply({ new: 'Alt+KeyU' })).toEqual({ kind: 'busy' })
    fail = false
    expect(await store.retry()).toEqual({ kind: 'done' })
    expect(requests.map(request => request.requestId)).toEqual([requests[0]!.requestId, requests[0]!.requestId])
    expect(store.bindings()).toEqual({ new: 'Alt+KeyY' })
    expect(store.snapshot().pending).toBeUndefined()
  })

  it('says why the Host refused, and keeps nothing pending', async () => {
    const store = new ShortcutBindings(
      async () => {
        throw new ApiError(400, 'shortcuts-invalid', '新会话：浏览器保留')
      },
      async () => ({ revision: 0, doc: null }),
      () => 'browser',
    )
    await store.load(identity, true)
    expect(await store.apply({ new: 'Mod+KeyT' })).toEqual({ kind: 'refused', text: '新会话：浏览器保留' })
    expect(store.snapshot().pending).toBeUndefined()
  })
})
