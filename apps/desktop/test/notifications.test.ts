import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const {
  createNotifications,
  validPreferences,
  readPreferences,
  writePreferences,
  handleNotificationRequests,
} = require('../src/notifications.cjs')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
describe('Host-authorized notifications', () => {
  it('waits for a queued preference write at close without publishing to a closed window', async () => {
    let release: () => void = () => {}
    const changed = vi.fn(),
      save = vi.fn(async () => {
        await new Promise<void>(done => {
          release = done
        })
      }),
      controller = createNotifications({
        snapshot: async () => undefined,
        focused: () => false,
        supported: () => true,
        show: vi.fn(),
        open: vi.fn(),
        save,
        changed,
      }),
      settled = vi.fn(),
      pending = controller.respond({ choice: 'enable' })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const closing = controller.close().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    release()
    await pending
    await closing
    expect(controller.view().consent).toBe('accepted')
    expect(changed).not.toHaveBeenCalled()
    expect(await controller.respond({ choice: 'decline' })).toBeUndefined()
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('does not ask for opt-in or pretend to send notifications on an unsupported system', async () => {
    const task = { id: 'a', status: 'running' },
      show = vi.fn(),
      save = vi.fn()
    const controller = createNotifications({
      snapshot: async () => ({ tasks: [task], approvals: [] }),
      focused: () => false,
      supported: () => false,
      show,
      open: vi.fn(),
      save,
    })
    cleanup.push(() => controller.close())
    await controller.poll()
    task.status = 'failed'
    await controller.poll()
    expect(controller.view()).toMatchObject({ supported: false, needsConsent: false, consent: 'unasked' })
    expect(save).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    controller.configure({ completion: true, approval: true, title: false })
    task.status = 'running'
    await controller.poll()
    task.status = 'idle'
    await controller.poll()
    expect(show).not.toHaveBeenCalled()
  })
  it('uses a fixed failure template, suppresses cancelled/interrupted and foreground events, and never duplicates a settled snapshot', async () => {
    let focused = false,
      time = 10_000
    const task = { id: 'a', title: 'Private fixture', status: 'running', runOutcome: undefined as string | undefined },
      show = vi.fn(),
      open = vi.fn()
    const controller = createNotifications({
      snapshot: async () => ({ tasks: [task], approvals: [] }),
      focused: () => focused,
      supported: () => true,
      show,
      open,
      now: () => time,
    })
    cleanup.push(() => controller.close())
    controller.configure({ completion: true, approval: true, title: false })
    await controller.poll()
    task.status = 'failed'
    task.runOutcome = 'failed'
    await controller.poll()
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Latch', body: '一个会话失败了。' }))
    show.mock.calls[0]![0].onClick()
    expect(open).toHaveBeenCalledWith('a')
    for (const status of ['cancelled', 'interrupted']) {
      task.status = 'running'
      task.runOutcome = undefined
      await controller.poll()
      task.status = status
      task.runOutcome = status
      time += 10_000
      await controller.poll()
    }
    task.status = 'running'
    await controller.poll()
    task.status = 'idle'
    task.runOutcome = 'interrupted'
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    task.status = 'running'
    task.runOutcome = undefined
    await controller.poll()
    focused = true
    task.status = 'failed'
    task.runOutcome = 'failed'
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
  })
  it('persists the first background consent event and a declined choice across restart without exposing session data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-notification-consent-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    let focused = true
    const task = { id: 'a', title: 'Never publish this title', status: 'running' },
      changed = vi.fn(),
      show = vi.fn()
    const create = () =>
      createNotifications({
        snapshot: async () => ({ tasks: [task], approvals: [] }),
        focused: () => focused,
        supported: () => true,
        show,
        open: vi.fn(),
        changed,
        save: (value: unknown) => writePreferences(directory, value),
      })
    const controller = create()
    cleanup.push(() => controller.close())
    await controller.poll()
    task.status = 'idle'
    await controller.poll()
    expect(controller.view().consent).toBe('unasked')
    task.status = 'running'
    await controller.poll()
    focused = false
    task.status = 'failed'
    await controller.poll()
    expect(controller.view()).toMatchObject({ needsConsent: true, consent: 'pending', completion: false, approval: false })
    expect(JSON.stringify(changed.mock.calls)).not.toContain(task.title)
    expect(show).not.toHaveBeenCalled()
    await controller.respond({ choice: 'decline' })
    expect(controller.view()).toMatchObject({ needsConsent: false, consent: 'declined' })
    const restarted = create()
    cleanup.push(() => restarted.close())
    restarted.configure(await readPreferences(directory))
    task.status = 'running'
    await restarted.poll()
    task.status = 'failed'
    await restarted.poll()
    expect(restarted.view()).toMatchObject({ consent: 'declined', completion: false, approval: false, needsConsent: false })
    expect((await stat(join(directory, 'notifications.json'))).mode & 0o077).toBe(0)
  })
  it('serializes pending consent and explicit settings, keeps failed writes invisible, and preserves the title choice on enable', async () => {
    const task = { id: 'a', status: 'running' },
      changed = vi.fn(),
      writes: unknown[] = [],
      show = vi.fn()
    let release: () => void = () => {}
    const save = vi.fn(async (value: unknown) => {
      writes.push(structuredClone(value))
    })
    save.mockImplementationOnce(async (value: unknown) => {
      writes.push(structuredClone(value))
      await new Promise<void>(done => {
        release = done
      })
    })
    const controller = createNotifications({
      snapshot: async () => ({ tasks: [task], approvals: [] }),
      focused: () => false,
      supported: () => true,
      show,
      open: vi.fn(),
      changed,
      save,
    })
    cleanup.push(() => controller.close())
    await controller.poll()
    task.status = 'idle'
    const polling = controller.poll()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const decline = controller.respond({ choice: 'decline' }),
      enable = controller.set({ completion: true, approval: true, title: true })
    expect(controller.view().consent).toBe('unasked')
    release()
    await polling
    await decline
    await enable
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: true, approval: true, title: true, needsConsent: false })
    expect((writes.at(-1) as { consent: string }).consent).toBe('accepted')
    await controller.respond({ choice: 'enable' })
    expect(controller.view().title).toBe(true)
    save.mockRejectedValueOnce(new Error('disk failed'))
    await expect(controller.respond({ choice: 'decline' })).rejects.toThrow('disk failed')
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: true, approval: true })
    await controller.respond({ choice: 'decline' })
    expect(controller.view()).toMatchObject({ consent: 'declined', completion: false, approval: false })
    expect(show).not.toHaveBeenCalled()
  })
  it('migrates legacy preferences and refuses invalid or untrusted IPC without accepting notification text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-notification-legacy-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, 'notifications.json'), JSON.stringify({ completion: true, approval: false, title: false }))
    expect(await readPreferences(directory)).toMatchObject({
      version: 1,
      consent: 'accepted',
      preferences: { completion: true, approval: false, title: false },
    })
    const controller = createNotifications({
      snapshot: async () => undefined,
      focused: () => false,
      supported: () => true,
      show: vi.fn(),
      open: vi.fn(),
    })
    cleanup.push(() => controller.close())
    controller.configure(await readPreferences(directory))
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
    handleNotificationRequests({
      ipcMain: { handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => handlers.set(channel, handler) },
      trusted: (event: unknown) => event === 'top-frame',
      controller,
    })
    const respond = handlers.get('latch:notifications:respond')!,
      set = handlers.get('latch:notifications:set')!
    expect(await respond('child-frame', { choice: 'enable' })).toBeUndefined()
    expect(await respond('top-frame', { choice: 'enable', body: 'Arbitrary text' })).toBeUndefined()
    expect(await respond('top-frame', { choice: 'unknown' })).toBeUndefined()
    expect(await set('top-frame', Object.create({ completion: true, approval: true, title: true }))).toBeUndefined()
    expect(await set('top-frame', { completion: true, approval: true, title: false, sessionId: 'forged' })).toBeUndefined()
    expect(await respond('top-frame', { choice: 'enable' })).toMatchObject({
      completion: true,
      approval: true,
      title: false,
      consent: 'accepted',
    })
    expect(handlers.get('latch:notifications:get')!('child-frame')).toBeUndefined()
  })
  it('exposes only finite state/choice values through the real preload and retains the old session-click subscription', async () => {
    const state = { completion: false, approval: false, title: false, supported: true, needsConsent: true, consent: 'pending' },
      invoke = vi.fn(async () => state)
    const listeners = new Map<string, (event: unknown, value: unknown) => void>()
    let shell:
      | {
          notifications: {
            get: () => Promise<unknown>
            respond: (input: unknown) => Promise<unknown>
            subscribeState: (listener: (value: unknown) => void) => () => void
            subscribe: (listener: (value: unknown) => void) => () => void
          }
        }
      | undefined
    runInNewContext(await readFile('apps/desktop/src/preload.cjs', 'utf8'), {
      process: { platform: 'darwin' },
      require: (name: string) => {
        if (name !== 'electron') throw new Error('unexpected preload import')
        return {
          contextBridge: {
            exposeInMainWorld: (_name: string, value: typeof shell) => {
              shell = value
            },
          },
          ipcRenderer: {
            invoke,
            on: (name: string, listener: (event: unknown, value: unknown) => void) => listeners.set(name, listener),
            removeListener: (name: string) => listeners.delete(name),
          },
          webUtils: { getPathForFile: () => '' },
        }
      },
    })
    expect(await shell!.notifications.get()).toEqual(state)
    expect(await shell!.notifications.respond({ choice: 'enable', text: 'never forwarded' })).toBeUndefined()
    expect(invoke).toHaveBeenCalledTimes(1)
    await shell!.notifications.respond({ choice: 'decline' })
    expect(invoke).toHaveBeenLastCalledWith('latch:notifications:respond', { choice: 'decline' })
    const changed = vi.fn(),
      clicked = vi.fn(),
      unsubscribe = shell!.notifications.subscribeState(changed),
      unclick = shell!.notifications.subscribe(clicked)
    listeners.get('latch:notifications:state')!({}, { ...state, body: 'no text' })
    listeners.get('latch:notifications:state')!({}, { ...state, consent: 'invalid' })
    expect(changed).not.toHaveBeenCalled()
    listeners.get('latch:notifications:state')!({}, state)
    expect(changed).toHaveBeenCalledWith(state)
    listeners.get('latch:notifications:open')!({}, 'a')
    expect(clicked).toHaveBeenCalledWith('a')
    unsubscribe()
    unclick()
    expect(listeners.size).toBe(0)
    invoke.mockResolvedValueOnce({ ...state, consent: 'invalid' })
    expect(await shell!.notifications.get()).toBeUndefined()
  })
  it('ignores the initial snapshot, honors foreground and preferences, throttles a session, and opens only Host session IDs', async () => {
    let focused = false,
      time = 10_000
    let snapshot = { tasks: [{ id: 'a', title: 'private', status: 'running' }], approvals: [] as Array<{ id: string; sessionId: string }> }
    const show = vi.fn(),
      open = vi.fn(),
      badge = vi.fn()
    const controller = createNotifications({
      snapshot: async () => snapshot,
      focused: () => focused,
      supported: () => true,
      show,
      open,
      badge,
      now: () => time,
    })
    controller.configure({ completion: true, approval: true, title: false })
    await controller.poll()
    expect(show).not.toHaveBeenCalled()
    snapshot.tasks[0]!.status = 'idle'
    await controller.poll()
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Latch', body: '一个会话已完成。' }))
    show.mock.calls[0]![0].onClick()
    expect(open).toHaveBeenCalledWith('a')
    snapshot.approvals = [{ id: 'one', sessionId: 'a' }]
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    time += 10_000
    focused = true
    snapshot.approvals.push({ id: 'two', sessionId: 'a' })
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    focused = false
    snapshot.approvals.push({ id: 'three', sessionId: 'a' })
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(2)
    expect(badge).toHaveBeenLastCalledWith(3)
  })
  it('fails closed on preferences and host errors and asks for consent without notifying by default', async () => {
    let snapshot = { tasks: [{ id: 'a', status: 'running' }], approvals: [] }
    const show = vi.fn(),
      controller = createNotifications({
        snapshot: async () => snapshot,
        focused: () => false,
        supported: () => true,
        show,
        open: vi.fn(),
        badge: vi.fn(),
      })
    expect(validPreferences({ completion: true, approval: false, title: false, text: 'untrusted' })).toBe(false)
    await controller.poll()
    snapshot.tasks[0]!.status = 'idle'
    await controller.poll()
    expect(show).not.toHaveBeenCalled()
    expect(controller.view().needsConsent).toBe(true)
  })
})
