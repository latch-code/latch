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
  attentionOf,
  waitingCount,
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
      pending = controller.set({ completion: true, approval: true, title: false })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const closing = controller.close().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    release()
    await pending
    await closing
    expect(controller.view().consent).toBe('accepted')
    expect(changed).not.toHaveBeenCalled()
    expect(await controller.set({ completion: false, approval: false, title: false })).toBeUndefined()
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
    expect(controller.view()).toMatchObject({ supported: false, consent: 'unasked' })
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
  it("follows each Agent's switch for its topics and its scheduled runs, and leaves everything else on", async () => {
    let time = 10_000
    const agent = 'agt_00000000-0000-4000-8000-000000000001'
    const topic = { id: 'topic', status: 'running', agent: { customAgentId: agent } } as Record<string, unknown>
    const run = { id: 'run', status: 'running', automationId: 'auto_1' } as Record<string, unknown>
    const other = { id: 'other', status: 'running' } as Record<string, unknown>
    const snapshot = {
      tasks: [topic, run, other],
      approvals: [] as Array<Record<string, unknown>>,
      customAgents: [{ id: agent, notifications: { completed: false, failed: true, waiting: false } }],
      automations: [{ id: 'auto_1', customAgentId: agent }],
    }
    const show = vi.fn()
    const save = vi.fn()
    const controller = createNotifications({
      snapshot: async () => structuredClone(snapshot),
      focused: () => false,
      supported: () => true,
      show,
      open: vi.fn(),
      save,
      now: () => time,
    })
    cleanup.push(() => controller.close())
    await controller.poll()
    // Completed while 完成 is off for this Agent: no notification, and no first-time opt-in from it either.
    topic.status = 'idle'
    topic.runOutcome = 'completed'
    run.status = 'idle'
    run.runOutcome = 'completed'
    await controller.poll()
    expect(show).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(controller.view().consent).toBe('unasked')
    // Another session completes: as before.
    other.status = 'idle'
    other.runOutcome = 'completed'
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    // 失败 is on; 需要你处理 is off for the Agent's approvals and questions.
    time += 20_000
    topic.status = 'running'
    run.status = 'running'
    run.runOutcome = undefined
    await controller.poll()
    topic.status = 'failed'
    topic.runOutcome = 'failed'
    snapshot.approvals.push({ id: 'ap', sessionId: 'run' })
    run.status = 'waiting-approval'
    run.pendingQuestions = 1
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(2)
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ body: '一个会话失败了。' }))
  })
  it('turns notifications on at the first real ending in the background and keeps a choice across restart', async () => {
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
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: true, approval: true })
    expect(JSON.stringify(changed.mock.calls)).not.toContain(task.title)
    expect(show).toHaveBeenCalledTimes(1)
    show.mockClear()
    await controller.set({ completion: false, approval: false, title: false })
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: false, approval: false })
    const restarted = create()
    cleanup.push(() => restarted.close())
    restarted.configure(await readPreferences(directory))
    task.status = 'running'
    await restarted.poll()
    task.status = 'failed'
    await restarted.poll()
    expect(restarted.view()).toMatchObject({ consent: 'accepted', completion: false, approval: false })
    expect((await stat(join(directory, 'notifications.json'))).mode & 0o077).toBe(0)
  })
  it('serializes the first background ending and explicit settings, keeps failed writes invisible, and preserves the title choice on enable', async () => {
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
    const off = controller.set({ completion: false, approval: false, title: false }),
      enable = controller.set({ completion: true, approval: true, title: true })
    expect(controller.view().consent).toBe('unasked')
    release()
    await polling
    await off
    await enable
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: true, approval: true, title: true })
    expect((writes.at(-1) as { consent: string }).consent).toBe('accepted')
    save.mockRejectedValueOnce(new Error('disk failed'))
    await expect(controller.set({ completion: false, approval: false, title: true })).rejects.toThrow('disk failed')
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: true, approval: true })
    await controller.set({ completion: false, approval: false, title: true })
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: false, approval: false, title: true })
    expect(show).toHaveBeenCalledTimes(1)
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
    const set = handlers.get('latch:notifications:set')!
    expect(await set('child-frame', { completion: true, approval: true, title: false })).toBeUndefined()
    expect(await set('top-frame', Object.create({ completion: true, approval: true, title: true }))).toBeUndefined()
    expect(await set('top-frame', { completion: true, approval: true, title: false, sessionId: 'forged' })).toBeUndefined()
    expect(await set('top-frame', { completion: true, approval: true, title: false })).toMatchObject({
      completion: true,
      approval: true,
      title: false,
      consent: 'accepted',
    })
    expect(handlers.get('latch:notifications:get')!('child-frame')).toBeUndefined()
  })
  it('exposes only finite state/choice values through the real preload and retains the old session-click subscription', async () => {
    const state = { completion: false, approval: false, title: false, supported: true, consent: 'unasked' },
      invoke = vi.fn(async () => state)
    const listeners = new Map<string, (event: unknown, value: unknown) => void>()
    let shell:
      | {
          notifications: {
            get: () => Promise<unknown>
            set: (input: unknown) => Promise<unknown>
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
    expect(await shell!.notifications.set({ completion: true, approval: true, title: false, text: 'never forwarded' })).toBeUndefined()
    expect(invoke).toHaveBeenCalledTimes(1)
    // A click that reopens the window arrives before the page subscribes: it waits for the first subscriber, once.
    listeners.get('latch:notifications:open')!({}, 'not a session id')
    listeners.get('latch:notifications:open')!({}, 'early')
    const changed = vi.fn(),
      clicked = vi.fn(),
      unsubscribe = shell!.notifications.subscribeState(changed),
      unclick = shell!.notifications.subscribe(clicked)
    expect(clicked.mock.calls).toEqual([['early']])
    listeners.get('latch:notifications:state')!({}, { ...state, body: 'no text' })
    listeners.get('latch:notifications:state')!({}, { ...state, consent: 'invalid' })
    expect(changed).not.toHaveBeenCalled()
    listeners.get('latch:notifications:state')!({}, state)
    expect(changed).toHaveBeenCalledWith(state)
    listeners.get('latch:notifications:open')!({}, 'a')
    listeners.get('latch:notifications:open')!({}, 'not a session id')
    expect(clicked.mock.calls).toEqual([['early'], ['a']])
    unsubscribe()
    unclick()
    // Only the early holders for 新会话 from another window and 「检查更新…」 are left, until the page subscribes to them.
    expect([...listeners.keys()]).toEqual(['latch:computers:start-here', 'latch:updates:show'])
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
    // The Dock says what 等你处理 lists: one session with three requests is one.
    expect(badge).toHaveBeenLastCalledWith(1)
    snapshot.approvals = []
    await controller.poll()
    expect(badge).toHaveBeenLastCalledWith(0)
    snapshot = {
      tasks: [
        { id: 'a', title: 'private', status: 'idle' },
        { id: 'quiet', title: 'private', status: 'running', live: { silent: true } },
        { id: 'busy', title: 'private', status: 'running', live: {} },
        {
          id: 'unknown',
          title: 'private',
          status: 'running',
          live: { lastEventAt: '2026-11-01T00:00:00.000Z', unrecognized: { at: '2026-11-01T00:00:00.000Z' } },
        },
        {
          id: 'went-on',
          title: 'private',
          status: 'running',
          live: { lastEventAt: '2026-11-01T00:00:09.000Z', unrecognized: { at: '2026-11-01T00:00:00.000Z' } },
        },
        { id: 'stopped', title: 'private', status: 'waiting-approval', live: { activity: 'cancelling' } },
        { id: 'asks', title: 'private', status: 'waiting-approval' },
        { id: 'question', title: 'private', status: 'running', pendingQuestions: 1 },
        // A silence left over from a run that has ended is not waiting on anybody.
        { id: 'over', title: 'private', status: 'failed', live: { silent: true } },
      ] as typeof snapshot.tasks,
      approvals: [],
    }
    await controller.poll()
    expect(badge).toHaveBeenLastCalledWith(3)
    expect(show).toHaveBeenCalledTimes(3)
    expect(show.mock.calls.at(-1)?.[0]).toMatchObject({ body: '有一个问题等你回答。' })
  })
  it('tells of a new question from the agent under the approval preference, once, and opens its session', async () => {
    const snapshot = {
      tasks: [{ id: 'q', title: 'private', status: 'running', pendingQuestions: 0 }],
      approvals: [] as Array<{ id: string; sessionId: string }>,
    }
    const show = vi.fn(),
      open = vi.fn()
    let time = 50_000
    const controller = createNotifications({
      snapshot: async () => snapshot,
      focused: () => false,
      supported: () => true,
      show,
      open,
      now: () => time,
    })
    controller.configure({ completion: false, approval: true, title: false })
    await controller.poll()
    snapshot.tasks[0]!.pendingQuestions = 1
    await controller.poll()
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Latch', body: '有一个问题等你回答。' }))
    show.mock.calls[0]![0].onClick()
    expect(open).toHaveBeenCalledWith('q')
    // The same question on the next read is not news; answered, nothing is either.
    time += 20_000
    await controller.poll()
    snapshot.tasks[0]!.pendingQuestions = 0
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    // Off with the approval preference.
    controller.configure({ completion: true, approval: false, title: false })
    time += 20_000
    snapshot.tasks[0]!.pendingQuestions = 1
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('fails closed on preferences and turns notifications on at the first real ending in the background', async () => {
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
    expect(show).toHaveBeenCalledTimes(1)
    expect(controller.view()).toMatchObject({ consent: 'accepted', completion: true, approval: true, title: false })
  })
})

describe('what waits, from Host snapshots', () => {
  it('lists a session exactly where the Host’s board rule does (board-v1)', async () => {
    const { waits } = JSON.parse(await readFile('packages/testkit/vectors/board-v1.json', 'utf8')) as {
      waits: Array<{ name: string; task: { id: string; updatedAt: string }; approval: boolean; wait: string | null }>
    }
    const kinds: Record<string, string> = { approval: 'approval', question: 'question', unrecognized: 'stuck' }
    for (const { name, task, approval, wait } of waits) {
      const approvals = approval ? [{ id: 'a-1', sessionId: task.id, requestedAt: task.updatedAt }] : []
      expect(attentionOf({ tasks: [task], approvals }).items[0]?.kind ?? null, name).toBe(wait === null ? null : kinds[wait])
    }
  })

  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 12, 8, 0, seconds)).toISOString()
  const snapshot = {
    tasks: [
      { id: 'approve', title: '添加币种筛选', status: 'waiting-approval', updatedAt: at(1), live: { lastEventAt: at(1) } },
      { id: 'ask', title: '问题\u202e反转', status: 'running', pendingQuestions: 2, updatedAt: at(2), live: { lastEventAt: at(2) } },
      { id: 'silent', title: '安静', status: 'running', updatedAt: at(3), live: { silent: true, lastEventAt: at(3) } },
      { id: 'odd', title: 'x'.repeat(200), status: 'running', updatedAt: at(4), live: { lastEventAt: at(4), unrecognized: { at: at(5) } } },
      { id: 'stopping', title: '停', status: 'waiting-approval', updatedAt: at(6), live: { activity: 'cancelling' } },
      { id: 'run', title: '跑', status: 'running', updatedAt: at(7), live: { lastEventAt: at(7) } },
      { id: 'done', title: '完', status: 'idle', updatedAt: at(8) },
    ],
    approvals: [
      { id: 'a1', sessionId: 'approve', requestedAt: at(9), reason: '写入 /secret', arguments: '{}' },
      { id: 'a0', sessionId: 'approve', requestedAt: at(1), reason: '写入 /secret', arguments: '{}' },
      { id: 'a2', sessionId: 'stopping', requestedAt: at(6), reason: 'x' },
      { id: 'a3', sessionId: 'elsewhere', requestedAt: at(10), reason: 'x' },
    ],
  }

  it('lists the sessions the Dock counts, by kind and when each began to wait, with titles cut to one line of 80', () => {
    const result = attentionOf(snapshot, { now: Date.UTC(2026, 10, 12, 9) })
    expect(result.count).toBe(waitingCount(snapshot))
    expect(result.count).toBe(4)
    expect(result.running).toBe(2)
    expect(result.items).toEqual([
      { taskId: 'elsewhere', title: '', kind: 'approval', since: at(10) },
      { taskId: 'odd', title: 'x'.repeat(80), kind: 'stuck', since: at(5) },
      { taskId: 'ask', title: '问题反转', kind: 'question', since: at(2) },
      { taskId: 'approve', title: '添加币种筛选', kind: 'approval', since: at(1) },
    ])
    expect(JSON.stringify(result)).not.toContain('/secret')
    expect(attentionOf(snapshot, { limit: 2 }).items.map((item: { taskId: string }) => item.taskId)).toEqual(['elsewhere', 'odd'])
    expect(attentionOf(snapshot, { limit: 2 }).count).toBe(4)
    // A question holds the session at waiting-approval: it is listed as a question, not a request.
    const held = { tasks: [{ id: 'held', title: 't', status: 'waiting-approval', pendingQuestions: 1 }], approvals: [] }
    expect(attentionOf(held, { now: Date.UTC(2026, 10, 12, 9) }).items).toEqual([
      expect.objectContaining({ taskId: 'held', kind: 'question' }),
    ])
  })

  it('leaves out entries a Host should not have sent, and caps the running count', () => {
    const odd = {
      tasks: [
        null,
        'x',
        { id: 'has space', status: 'waiting-approval' },
        { id: 'ok', status: 'waiting-approval', title: 'a', updatedAt: at(1) },
        ...Array.from({ length: 100_001 }, (_, index) => ({ id: `r${index}`, status: 'running' })),
      ],
      approvals: [null, { sessionId: 'has space' }, { sessionId: 7 }],
    }
    const result = attentionOf(odd)
    expect(result.items.map((item: { taskId: string }) => item.taskId)).toEqual(['ok'])
    expect(result.running).toBe(100_000)
  })

  it('notifies another computer’s new request under the same preferences, its name first, and opens that computer on click', async () => {
    const show = vi.fn(),
      openRemote = vi.fn(),
      open = vi.fn()
    let focused = false,
      time = 100_000
    const controller = createNotifications({
      now: () => time,
      snapshot: async () => ({ tasks: [], approvals: [] }),
      focused: () => focused,
      supported: () => true,
      show,
      open,
      openRemote,
    })
    cleanup.push(() => controller.close())
    controller.configure({ version: 1, preferences: { completion: true, approval: true, title: false }, consent: 'accepted' })
    const task = { id: 'remote-1', title: '添加币种筛选', status: 'running' }
    const before = { tasks: [task], approvals: [] }
    await controller.observeRemote('b'.repeat(52), 'build-mini', before)
    expect(show).not.toHaveBeenCalled()
    const asking = { tasks: [{ ...task, status: 'waiting-approval' }], approvals: [{ id: 'ap', sessionId: 'remote-1' }] }
    await controller.observeRemote('b'.repeat(52), 'build-mini', asking)
    await controller.observeRemote('b'.repeat(52), 'build-mini', asking)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0]![0]).toMatchObject({ title: 'build-mini · Latch', body: '有一个请求等你处理。' })
    show.mock.calls[0]![0].onClick()
    expect(openRemote).toHaveBeenCalledWith('b'.repeat(52), 'remote-1')
    expect(open).not.toHaveBeenCalled()

    // The title preference shows the session's title after the name; this Mac's own have no name.
    controller.configure({ version: 1, preferences: { completion: true, approval: true, title: true }, consent: 'accepted' })
    time += 11_000
    await controller.observeRemote('b'.repeat(52), 'build-mini', { tasks: [{ ...task, status: 'idle' }], approvals: [] })
    expect(show.mock.calls[1]![0]).toMatchObject({ title: 'build-mini · 添加币种筛选', body: '一个会话已完成。' })

    // A name or title with invisible characters cannot pose as another computer's line.
    time += 11_000
    await controller.observeRemote('b'.repeat(52), 'evil\u202E · build-mini\u2028', {
      tasks: [{ ...task, title: 'x\u202Ey', status: 'running' }],
      approvals: [],
    })
    await controller.observeRemote('b'.repeat(52), 'evil\u202E · build-mini\u2028', {
      tasks: [{ ...task, title: 'x\u202Ey', status: 'idle' }],
      approvals: [],
    })
    expect(show.mock.calls[2]![0].title).toBe('evil · build-mini · xy')
    show.mockClear()
    show.mockImplementation(() => {})
    // Each computer has its own baseline: the same session ID on another computer is its own first sight.
    await controller.observeRemote('c'.repeat(52), 'other', asking)
    expect(show).toHaveBeenCalledTimes(0)
    // A window in front: nothing is shown, from any computer.
    focused = true
    await controller.observeRemote('c'.repeat(52), 'other', { tasks: [{ ...task, status: 'idle' }], approvals: [] })
    expect(show).toHaveBeenCalledTimes(0)
    // A removed computer starts again from a fresh baseline.
    focused = false
    controller.forgetRemote('b'.repeat(52))
    await controller.observeRemote('b'.repeat(52), 'build-mini', asking)
    expect(show).toHaveBeenCalledTimes(0)
    // A malformed snapshot is ignored, not thrown.
    await controller.observeRemote('b'.repeat(52), 'build-mini', { tasks: [null], approvals: [] })
    expect(show).toHaveBeenCalledTimes(0)
  })

  it('gives the Dock this Mac’s own count; main adds the other computers that answer', async () => {
    const badge = vi.fn()
    const controller = createNotifications({
      snapshot: async () => snapshot,
      focused: () => true,
      supported: () => true,
      show: vi.fn(),
      open: vi.fn(),
      badge,
    })
    cleanup.push(() => controller.close())
    await controller.poll()
    expect(badge).toHaveBeenCalledWith(4)
  })
})
