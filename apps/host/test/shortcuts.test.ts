import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_RESERVED,
  DEFAULT_SHORTCUTS,
  FIXED_SHORTCUTS,
  MENU_RESERVED,
  SHORTCUT_ACTIONS,
  SHORTCUT_CLIENTS,
  SYSTEM_RESERVED,
  effectiveShortcuts,
  shortcutRefusal,
  shortcutsIssues,
  type AppSnapshot,
  type ShortcutsReceipt,
  type ShortcutsState,
} from '@latch/protocol'
import { ShortcutsStore } from '../src/shortcuts.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const desktop = (bindings: Record<string, string>) => ({ schema: 1, client: 'desktop', bindings })
const browser = (bindings: Record<string, string>) => ({ schema: 1, client: 'browser', bindings })

describe('a shortcuts document', () => {
  it('passes every default binding through its own rules, on both kinds of client', () => {
    for (const client of SHORTCUT_CLIENTS)
      for (const action of SHORTCUT_ACTIONS) {
        const chord = DEFAULT_SHORTCUTS[action][client]
        if (chord !== null) expect(shortcutRefusal(client, {}, action, chord), `${client} ${action}`).toBeNull()
      }
  })

  it('refuses, never corrects: unknown fields and actions, chords outside the grammar, reserved and taken keys', () => {
    expect(shortcutsIssues(desktop({}))).toEqual([])
    expect(shortcutsIssues(desktop({ new: 'Mod+Shift+KeyY' }))).toEqual([])
    const fields = (value: unknown) => shortcutsIssues(value).map(issue => issue.field)
    expect(fields({ ...desktop({}), css: 'x' })).toEqual(['css'])
    expect(fields({ schema: 2, client: 'desktop', bindings: {} })).toEqual(['schema'])
    expect(fields({ schema: 1, client: 'phone', bindings: {} })).toEqual(['client'])
    expect(fields(desktop({ approve: 'Mod+KeyY' }))).toEqual(['bindings.approve'])
    // A bare key, a Shift-only chord, a modifier out of order, an unknown key and text that is not a chord.
    for (const chord of ['KeyY', 'Shift+KeyY', 'Shift+Mod+KeyY', 'Mod+KeyÉ', 'Mod+Delete', 'Mod+KeyY; x', '', 'mod+keyy'])
      expect(shortcutsIssues(desktop({ new: chord })).length, chord).toBe(1)
    // The system's, the menu's and a browser's own keys; the desktop app is no browser.
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+Space')).toEqual({ kind: 'system' })
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+KeyQ')).toEqual({ kind: 'system' })
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+KeyC')).toEqual({ kind: 'menu' })
    expect(shortcutRefusal('browser', {}, 'palette', 'Mod+KeyT')).toEqual({ kind: 'browser' })
    expect(shortcutRefusal('desktop', {}, 'palette', 'Mod+KeyT')).toBeNull()
    // Taken: by another action, by its rebinding, or by a fixed key (approving never moves).
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+KeyK')).toEqual({ kind: 'conflict', action: 'palette' })
    expect(shortcutRefusal('desktop', { palette: 'Mod+KeyY' }, 'new', 'Mod+KeyK')).toBeNull()
    expect(shortcutRefusal('desktop', { palette: 'Mod+KeyY' }, 'new', 'Mod+KeyY')).toEqual({ kind: 'conflict', action: 'palette' })
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+Enter')).toEqual({ kind: 'fixed', label: '允许选中的请求' })
    expect(shortcutRefusal('desktop', {}, 'new', 'Mod+Digit3')).toEqual({ kind: 'fixed', label: '跳到第 N 个会话' })
    expect(shortcutRefusal('browser', {}, 'browser', 'Alt+KeyY')).toEqual({ kind: 'unavailable' })
    expect(fields(desktop({ new: 'Mod+KeyY', palette: 'Mod+KeyY' }))).toEqual(['bindings.new', 'bindings.palette'])
    // A default written out is noise: absent means the default.
    expect(fields(desktop({ new: 'Mod+KeyN' }))).toEqual(['bindings.new'])
    // Every reserved and fixed chord is a chord of the grammar, so none is reserved by accident only.
    for (const chord of [...SYSTEM_RESERVED, ...BROWSER_RESERVED, ...MENU_RESERVED, ...FIXED_SHORTCUTS.desktop.map(entry => entry.chord)])
      expect(shortcutRefusal('desktop', {}, 'usage', chord), chord).not.toEqual({ kind: 'invalid' })
  })

  it('binds each delivery action independently and preserves editor shortcuts on both clients', () => {
    for (const client of SHORTCUT_CLIENTS) {
      const bindings = { 'send-now': 'Mod+Alt+Enter', 'queue-message': 'Mod+Shift+Enter' }
      expect(effectiveShortcuts(client, {}).has('send-now')).toBe(false)
      expect(effectiveShortcuts(client, {}).has('queue-message')).toBe(false)
      expect(shortcutsIssues({ schema: 1, client, bindings })).toEqual([])
      const active = effectiveShortcuts(client, bindings)
      expect(active.get('send-now')).toBe('Mod+Alt+Enter')
      expect(active.get('queue-message')).toBe('Mod+Shift+Enter')
      expect(shortcutRefusal(client, bindings, 'send-now', 'Mod+Shift+Enter')).toEqual({ kind: 'conflict', action: 'queue-message' })
      for (const action of ['send-now', 'queue-message'] as const) {
        expect(shortcutRefusal(client, {}, action, 'Mod+Enter')).toEqual({ kind: 'fixed', label: '允许选中的请求' })
        for (const chord of [
          'Alt+Enter',
          'Mod+KeyC',
          'Mod+KeyX',
          'Mod+KeyV',
          'Mod+Shift+KeyV',
          'Mod+KeyA',
          'Mod+KeyZ',
          'Mod+KeyY',
          'Mod+Shift+KeyZ',
          'Alt+Backspace',
          'Mod+Shift+ArrowRight',
        ])
          expect(shortcutRefusal(client, {}, action, chord), chord).not.toBeNull()
      }
    }
  })
})

describe('the shortcuts store', () => {
  const open = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-shortcuts-'))
    dirs.push(dir)
    return { dir, store: await ShortcutsStore.open(dir) }
  }
  const device = 'dev_AAAAAAAAAAAAAAAAAAAAAA'
  const other = 'dev_BBBBBBBBBBBBBBBBBBBBBB'

  it('opens old bindings that already use Mod+Shift+Enter and persists new sends for a different device', async () => {
    const { dir } = await open()
    const old = desktop({ new: 'Mod+Shift+Enter' })
    await writeFile(
      join(dir, 'shortcuts.json'),
      JSON.stringify({
        version: 1,
        devices: { [device]: { revision: 3, at: new Date().toISOString(), doc: old, receipts: [] } },
      }),
      { mode: 0o600 },
    )
    const store = await ShortcutsStore.open(dir)
    expect(store.state(device)).toEqual({ revision: 3, doc: old })
    const doc = browser({ 'send-now': 'Mod+Shift+Enter', 'queue-message': 'Mod+Alt+Enter' })
    await store.write({ deviceId: other, requestId: randomUUID(), baseRevision: 0, change: { kind: 'apply', doc } })
    const reopened = await ShortcutsStore.open(dir)
    expect(reopened.state(device)).toEqual({ revision: 3, doc: old })
    expect(reopened.state(other)).toEqual({ revision: 1, doc })
  })

  it('keeps each device apart, saves a 0600 file, replays a request and refuses its ID for another change', async () => {
    const { dir, store } = await open()
    const requestId = randomUUID()
    const doc = desktop({ new: 'Mod+Shift+KeyY' })
    const first = await store.write({ deviceId: device, requestId, baseRevision: 0, change: { kind: 'apply', doc } })
    expect(first).toEqual({ requestId, applied: 1, replayed: false, revision: 1, doc })
    expect(store.state(other)).toEqual({ revision: 0, doc: null })
    expect((await stat(join(dir, 'shortcuts.json'))).mode & 0o777).toBe(0o600)
    expect(await store.write({ deviceId: device, requestId, baseRevision: 0, change: { kind: 'apply', doc } })).toMatchObject({
      applied: 1,
      replayed: true,
    })
    await expect(
      store.write({ deviceId: device, requestId, baseRevision: 0, change: { kind: 'apply', doc: desktop({}) } }),
    ).rejects.toMatchObject({ code: 'request-id-reused' })
    // Another device's same request ID is its own.
    expect(
      await store.write({ deviceId: other, requestId, baseRevision: 0, change: { kind: 'apply', doc: browser({ new: 'Alt+KeyY' }) } }),
    ).toMatchObject({
      applied: 1,
    })
    await expect(
      store.write({ deviceId: device, requestId: randomUUID(), baseRevision: 0, change: { kind: 'apply', doc: desktop({}) } }),
    ).rejects.toMatchObject({ code: 'shortcuts-conflict' })
    await expect(
      store.write({
        deviceId: device,
        requestId: randomUUID(),
        baseRevision: 1,
        change: { kind: 'apply', doc: desktop({ new: 'Mod+KeyC' }) },
      }),
    ).rejects.toMatchObject({ code: 'shortcuts-invalid', message: '新会话：菜单占用' })
    const reset = await store.write({ deviceId: device, requestId: randomUUID(), baseRevision: 1, change: { kind: 'reset' } })
    expect(reset).toMatchObject({ revision: 2, doc: null, applied: 2 })
    const again = await ShortcutsStore.open(dir, { known: id => id === other })
    expect(again.state(device)).toEqual({ revision: 0, doc: null })
    expect(again.state(other)).toMatchObject({ revision: 1 })
  })

  it('writes nothing when nothing changes: a reset on the defaults leaves the file as it was', async () => {
    const { dir, store } = await open()
    await store.write({
      deviceId: device,
      requestId: randomUUID(),
      baseRevision: 0,
      change: { kind: 'apply', doc: desktop({ new: 'Mod+Shift+KeyY' }) },
    })
    await store.write({ deviceId: device, requestId: randomUUID(), baseRevision: 1, change: { kind: 'reset' } })
    const before = await stat(join(dir, 'shortcuts.json'))
    for (let index = 0; index < 5; index++)
      expect(await store.write({ deviceId: device, requestId: randomUUID(), baseRevision: 2, change: { kind: 'reset' } })).toMatchObject({
        revision: 2,
        applied: 2,
        replayed: false,
      })
    const after = await stat(join(dir, 'shortcuts.json'))
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
  })

  it('starts on the defaults over a file it cannot use, and keeps that file aside', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-shortcuts-'))
    dirs.push(dir)
    await writeFile(
      join(dir, 'shortcuts.json'),
      JSON.stringify({
        version: 1,
        devices: { [device]: { revision: 1, at: new Date().toISOString(), doc: desktop({ new: 'Mod+Space' }), receipts: [] } },
      }),
    )
    const logs: string[] = []
    const store = await ShortcutsStore.open(dir, { log: text => logs.push(text) })
    expect(store.state(device)).toEqual({ revision: 0, doc: null })
    expect((await readdir(dir)).some(name => name.startsWith('shortcuts.json.unreadable-'))).toBe(true)
    expect(logs[0]).toMatch(/原文件保留为/u)
  })
})

describe('shortcut routes', { timeout: 30_000 }, () => {
  it('lets each device read and write only its own bindings, and says it has the feature', async () => {
    const t = await startTestHost()
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    expect((await owner.json<AppSnapshot>('snapshot')).catalog?.features?.shortcuts).toBe(true)
    const doc = browser({ palette: 'Alt+KeyY' })
    const body = { requestId: randomUUID(), baseRevision: 0, doc }
    const receipt = await phone.json<ShortcutsReceipt>('shortcuts', { method: 'POST', body })
    expect(receipt).toMatchObject({ applied: 1, revision: 1, doc })
    expect(await phone.json<ShortcutsState>('shortcuts')).toEqual({ revision: 1, doc })
    // The desktop app reads its own (nothing yet), never the phone's.
    expect(await owner.json<ShortcutsState>('shortcuts')).toEqual({ revision: 0, doc: null })
    // A refusal names the action and why; an unknown body field is refused; no credential gets nothing.
    const refused = await owner.request('shortcuts', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 0, doc: desktop({ new: 'Mod+KeyK' }) },
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: 'shortcuts-invalid', message: '新会话：已用于「搜索」' })
    expect((await owner.request('shortcuts', { method: 'POST', body: { ...body, deviceId: phone.id } })).status).toBe(400)
    expect((await t.raw('loopback-tcp', 'api/shortcuts')).status).toBe(401)
    const reset = await phone.json<ShortcutsReceipt>('shortcuts/reset', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 1 },
    })
    expect(reset).toMatchObject({ revision: 2, doc: null })
    const saved = JSON.parse(await readFile(join(t.dataDir, 'shortcuts.json'), 'utf8')) as { devices: Record<string, unknown> }
    expect(Object.keys(saved.devices)).toEqual([phone.id])
  })
})
