import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, TaskSummary } from '@latch/protocol'
import { AppError, type HarnessDriver, type ModelProvider, type Bridge } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import { HarnessHub, type HarnessMount } from '../src/hub.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-hub-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function hub(dataDir?: string, defaultId = 'standard') {
  const log = vi.fn()
  const value = await HarnessHub.open({ dataDir: dataDir ?? (await directory()), defaultId: () => defaultId, log })
  cleanups.push(() => value.close())
  return { hub: value, log }
}

function summary(id: string, status: TaskSummary['status'] = 'idle'): TaskSummary {
  return { id, title: `Task ${id}`, status, updatedAt: new Date().toISOString() }
}

/** An external Bridge backed by plain arrays the test can mutate. */
function external(tasks: TaskSummary[] = [], approvals: Approval[] = [], extra: Partial<Bridge> = {}) {
  let notify: (sessionId?: string) => void = () => {}
  const mocks = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTasks: vi.fn(async () => structuredClone(tasks)),
    detail: vi.fn(async (sessionId: string) => {
      const found = tasks.find(task => task.id === sessionId)
      if (!found) throw new AppError(404, 'task-not-found', 'missing')
      return {
        summary: structuredClone(found),
        messages: [],
        approvals: approvals.filter(item => item.sessionId === sessionId),
        liveText: '',
        cursor: 1,
      }
    }),
    createTask: vi.fn<Bridge['createTask']>(async () => ({ sessionId: `created-${randomUUID()}` })),
    prompt: vi.fn<Bridge['prompt']>(async () => {}),
    cancel: vi.fn(async () => {}),
    approvals: vi.fn(() => structuredClone(approvals)),
    decide: vi.fn<Bridge['decide']>(async () => true),
    subscribe: (listener: (sessionId?: string) => void) => {
      notify = listener
      return () => {
        notify = () => {}
      }
    },
  } satisfies Bridge
  // Overrides replace behaviour only; the mock handles stay typed for assertions.
  const bridge = Object.assign(mocks, extra) as typeof mocks & Pick<Bridge, 'remove' | 'setConfig'>
  return { bridge, notify: (sessionId?: string) => notify(sessionId) }
}

function driver(id: string, extra: Partial<HarnessDriver> = {}): HarnessDriver {
  return {
    id,
    name: `Driver ${id}`,
    version: '1',
    create: () => {
      throw new Error('mounted through HarnessMount.create')
    },
    ...extra,
  }
}

function mount(bridge: Bridge, extra: Partial<HarnessMount> = {}): HarnessMount & { release: ReturnType<typeof vi.fn> } {
  return { create: () => bridge, release: vi.fn(), source: 'plugin', ...extra } as HarnessMount & { release: ReturnType<typeof vi.fn> }
}

function approval(id: string, sessionId: string): Approval {
  return { id, sessionId, toolName: 'write', reason: 'fixture', requestedAt: new Date().toISOString() }
}

describe('harness hub routing', () => {
  it('routes sessions verbatim between the Standard runtime and an external driver without injecting Host fields', async () => {
    const dataDir = await directory()
    const provider: ModelProvider = {
      id: 'fixture',
      name: 'Fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const standard = createRuntime({
      dataDir: join(dataDir, 'sessions'),
      workspaceRoot: dataDir,
      providerId: 'fixture',
      registry: { acquire: () => ({ provider, tools: [], release() {} }) },
    })
    const outside = external([summary('ext-1')])
    const { hub: value } = await hub(dataDir)
    const notified: Array<string | undefined> = []
    value.subscribe(sessionId => {
      notified.push(sessionId)
    })
    await value.attach(
      driver('standard'),
      mount(standard, { source: 'builtin', capabilities: { modes: ['chat', 'agent'], models: 'host' } }),
    )
    await value.attach(driver('ext'), mount(outside.bridge))

    const { sessionId } = await value.createTask({ prompt: 'hello', requestId: randomUUID(), mode: 'chat' })
    expect(sessionId).toMatch(/^task-/)
    await vi.waitFor(async () => expect((await value.detail(sessionId)).summary.status).toBe('idle'))
    expect(notified).toContain(sessionId)
    const tasks = await value.listTasks()
    expect(tasks.map(task => [task.id, task.harnessId])).toEqual(
      expect.arrayContaining([
        [sessionId, 'standard'],
        ['ext-1', 'ext'],
      ]),
    )
    expect((await value.detail('ext-1')).summary.harnessId).toBe('ext')

    const input = { prompt: 'external', requestId: randomUUID(), mode: 'agent' as const }
    outside.bridge.createTask.mockResolvedValueOnce({ sessionId: 'ext-2' })
    expect(await value.createTask({ ...input, harnessId: 'ext' })).toEqual({ sessionId: 'ext-2' })
    expect(outside.bridge.createTask).toHaveBeenCalledExactlyOnceWith(input)
    expect(await value.harnessOf('ext-2')).toBe('ext')
    await value.prompt('ext-1', 'next', 'request-1')
    expect(outside.bridge.prompt).toHaveBeenLastCalledWith('ext-1', 'next', 'request-1')
    await value.prompt('ext-1', 'switch', 'request-2', { model: { providerId: 'p', model: 'm' } })
    expect(outside.bridge.prompt).toHaveBeenLastCalledWith('ext-1', 'switch', 'request-2', { model: { providerId: 'p', model: 'm' } })
    await expect(value.detail('nowhere')).rejects.toMatchObject({ status: 404, code: 'task-not-found' })
    await expect(value.createTask({ ...input, harnessId: 'missing' })).rejects.toMatchObject({ status: 409, code: 'harness-unavailable' })
  })

  it('discovers routes for sessions it has not seen, such as after a restart', async () => {
    const outside = external([summary('known-later')])
    const { hub: value } = await hub()
    await value.attach(driver('ext'), mount(outside.bridge))
    await value.cancel('known-later')
    expect(outside.bridge.cancel).toHaveBeenCalledWith('known-later')
    expect(outside.bridge.listTasks).toHaveBeenCalledOnce()
  })

  it('routes approvals by listing, passes options through, and refuses an ambiguous ID', async () => {
    const first = external([summary('s-a')], [approval('a-1', 's-a'), approval('dup', 's-a')])
    const second = external([summary('s-b')], [approval('b-1', 's-b'), approval('dup', 's-b')])
    const detailOnly = external([summary('s-c')], [], {})
    detailOnly.bridge.detail.mockImplementation(async (sessionId: string) => ({
      summary: summary(sessionId),
      messages: [],
      approvals: [approval('c-1', sessionId)],
      liveText: '',
      cursor: 1,
    }))
    const { hub: value, log } = await hub()
    await value.attach(driver('first'), mount(first.bridge))
    await value.attach(driver('second'), mount(second.bridge))
    await value.attach(driver('third'), mount(detailOnly.bridge))

    expect(
      value
        .approvals()
        .map(item => item.id)
        .sort(),
    ).toEqual(['a-1', 'b-1', 'dup', 'dup'])
    expect(await value.decide('a-1', 'allow', { optionId: 'allow_always' })).toBe(true)
    expect(first.bridge.decide).toHaveBeenCalledExactlyOnceWith('a-1', 'allow', { optionId: 'allow_always' })
    expect(await value.decide('b-1', 'reject')).toBe(true)
    expect(second.bridge.decide).toHaveBeenCalledExactlyOnceWith('b-1', 'reject')
    expect(await value.decide('dup', 'allow')).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dup'))
    expect(await value.decide('unknown', 'allow')).toBe(false)
    expect(await value.decide('c-1', 'allow')).toBe(false)
    await value.detail('s-c')
    expect(await value.decide('c-1', 'allow')).toBe(true)
    expect(detailOnly.bridge.decide).toHaveBeenCalledExactlyOnceWith('c-1', 'allow')
    expect(first.bridge.decide).toHaveBeenCalledOnce()
    expect(second.bridge.decide).toHaveBeenCalledOnce()
  })

  it('keeps the first claim on a session ID collision and logs it once', async () => {
    const first = external([summary('same')])
    const second = external([summary('same'), summary('only-second')])
    const { hub: value, log } = await hub()
    await value.attach(driver('first'), mount(first.bridge))
    await value.attach(driver('second'), mount(second.bridge))
    for (let round = 0; round < 2; round++) {
      const tasks = await value.listTasks()
      expect(tasks.filter(task => task.id === 'same').map(task => task.harnessId)).toEqual(['first'])
      expect(tasks.find(task => task.id === 'only-second')?.harnessId).toBe('second')
    }
    expect(log.mock.calls.filter(([text]) => String(text).includes('same'))).toHaveLength(1)
    second.notify('same')
    await value.detail('same')
    expect(second.bridge.detail).not.toHaveBeenCalled()
    second.bridge.createTask.mockResolvedValueOnce({ sessionId: 'same' })
    await expect(value.createTask({ prompt: 'x', requestId: randomUUID(), harnessId: 'second' })).rejects.toMatchObject({
      status: 502,
      code: 'session-id-collision',
    })
  })
})

describe('harness hub isolation and lifecycle', () => {
  it('serves the other drivers when one cannot list its sessions', async () => {
    const healthy = external([summary('ok')])
    const broken = external([], [], {
      listTasks: vi.fn(async () => {
        throw new Error('backend offline')
      }),
    })
    const { hub: value, log } = await hub()
    await value.attach(driver('healthy'), mount(healthy.bridge))
    await value.attach(driver('broken'), mount(broken.bridge))
    expect((await value.listTasks()).map(task => task.id)).toEqual(['ok'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend offline'))
  })

  it('lists an optional driver that fails to start as unavailable but rethrows a required one', async () => {
    const failing = external([], [], {
      start: vi.fn(async () => {
        throw new Error('binary missing')
      }),
    })
    const { hub: value } = await hub()
    const optional = mount(failing.bridge)
    const info = await value.attach(driver('optional'), optional)
    expect(info).toMatchObject({ id: 'optional', status: 'unavailable', statusMessage: expect.stringContaining('binary missing') })
    expect(optional.release).toHaveBeenCalledOnce()
    expect(failing.bridge.close).toHaveBeenCalledOnce()
    expect(value.has('optional')).toBe(false)
    expect(value.drivers().map(item => [item.id, item.status])).toEqual([['optional', 'unavailable']])
    await expect(value.createTask({ prompt: 'x', requestId: randomUUID(), harnessId: 'optional' })).rejects.toMatchObject({
      code: 'harness-unavailable',
    })

    const required = mount(
      external([], [], {
        start: vi.fn(async () => {
          throw new Error('locked')
        }),
      }).bridge,
      { required: true },
    )
    await expect(value.attach(driver('required'), required)).rejects.toThrow('locked')
    expect(required.release).toHaveBeenCalledOnce()
    expect(value.info('required')).toBeUndefined()

    const duplicate = mount(external().bridge)
    await value.attach(driver('twice'), mount(external().bridge))
    await expect(value.attach(driver('twice'), duplicate)).rejects.toMatchObject({ code: 'harness-exists' })
    expect(duplicate.release).toHaveBeenCalledOnce()
  })

  it('routes to a driver only after it has started, and retires one detached while starting', async () => {
    let finishStart!: () => void
    const slow = external([summary('slow-1')], [], {
      start: vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishStart = resolve
          }),
      ),
    })
    const { hub: value } = await hub()
    const mounted = mount(slow.bridge)
    const attaching = value.attach(driver('slow'), mounted)
    await vi.waitFor(() => expect(slow.bridge.start).toHaveBeenCalled())
    expect(value.has('slow')).toBe(false)
    expect(value.info('slow')).toMatchObject({ status: 'unavailable', statusMessage: '正在启动' })
    await expect(value.createTask({ prompt: 'x', requestId: randomUUID(), harnessId: 'slow' })).rejects.toMatchObject({
      code: 'harness-unavailable',
    })
    await expect(value.attach(driver('slow'), mount(external().bridge))).rejects.toMatchObject({ code: 'harness-exists' })
    await value.detach('slow')
    finishStart()
    await expect(attaching).rejects.toMatchObject({ code: 'harness-detached' })
    expect(slow.bridge.close).toHaveBeenCalledOnce()
    expect(mounted.release).toHaveBeenCalledOnce()
    expect(value.drivers()).toEqual([])
  })

  it('detaches a driver only after its sessions settle, then forgets its routes', async () => {
    const tasks = [summary('busy', 'running')]
    const outside = external(tasks)
    const { hub: value } = await hub()
    const mounted = mount(outside.bridge)
    await value.attach(driver('ext'), mounted)
    await value.detail('busy')
    await expect(value.detach('ext')).rejects.toMatchObject({ status: 409, code: 'harness-busy' })
    expect(value.has('ext')).toBe(true)
    tasks[0]!.status = 'idle'
    await value.detach('ext')
    expect(outside.bridge.close).toHaveBeenCalledOnce()
    expect(mounted.release).toHaveBeenCalledOnce()
    expect(value.drivers()).toEqual([])
    await expect(value.detail('busy')).rejects.toMatchObject({ status: 404 })
    await value.detach('ext')
  })

  it('refuses to detach while a driver is still accepting a new session, turn or option change', async () => {
    // Like a runtime that persists before it publishes: in-flight work is not listed yet.
    const tasks = [summary('ext-1')]
    const settle: Array<() => void> = []
    const gate = <T>(value: T) =>
      new Promise<T>(resolve => {
        settle.push(() => resolve(value))
      })
    const outside = external(tasks, [], { setConfig: vi.fn(() => gate(undefined)) })
    outside.bridge.createTask.mockImplementationOnce(() => gate({ sessionId: 'ext-new' }))
    outside.bridge.prompt.mockImplementationOnce(() => gate(undefined))
    const { hub: value } = await hub()
    const mounted = mount(outside.bridge)
    await value.attach(driver('ext'), mounted)
    await value.detail('ext-1')

    const calls = [
      value.createTask({ prompt: 'new', requestId: randomUUID(), harnessId: 'ext' }),
      value.prompt('ext-1', 'next', randomUUID()),
      value.setConfig('ext-1', 'model', 'fast'),
    ]
    for (let pending = calls.length; pending > 0; pending--) {
      await vi.waitFor(() => expect(settle).toHaveLength(pending))
      await expect(value.detach('ext')).rejects.toMatchObject({ status: 409, code: 'harness-busy' })
      expect(value.has('ext')).toBe(true)
      settle.shift()!()
      await calls[calls.length - pending]
    }
    expect(await calls[0]).toEqual({ sessionId: 'ext-new' })
    expect(await value.harnessOf('ext-new')).toBe('ext')
    await value.detach('ext')
    expect(mounted.release).toHaveBeenCalledOnce()
    await expect(value.createTask({ prompt: 'late', requestId: randomUUID(), harnessId: 'ext' })).rejects.toMatchObject({
      code: 'harness-unavailable',
    })
  })

  it('reports capabilities, readiness and source for the catalog', async () => {
    const { hub: value } = await hub()
    await value.attach(driver('plain'), mount(external().bridge))
    await value.attach(
      driver('agent', {
        capabilities: { modes: ['agent'], models: 'agent' },
        status: () => ({ status: 'unavailable', statusMessage: '未安装' }),
      }),
      mount(external().bridge, { source: 'acp' }),
    )
    expect(value.drivers()).toEqual([
      { id: 'plain', name: 'Driver plain', source: 'plugin', status: 'ready', modes: ['chat', 'agent'], models: 'agent', level: 'L3' },
      {
        id: 'agent',
        name: 'Driver agent',
        source: 'acp',
        status: 'unavailable',
        statusMessage: '未安装',
        modes: ['agent'],
        models: 'agent',
        level: 'L3',
      },
    ])
  })

  it('reports which folders of a project each driver receives, and passes them only to one that takes them all', async () => {
    const { hub: value } = await hub()
    const previews = new Map<string, ReturnType<typeof vi.fn>>()
    for (const [id, extra] of [
      ['all', { projectFolders: 'all' }],
      ['capped', { projectFolders: 'all', folderAccess: { access: 'all', max: 5 } }],
      ['zero', { projectFolders: 'all', folderAccess: { access: 'all', max: 0 } }],
      ['asks', { folderAccess: { access: 'primary-asks' } }],
      ['claims', { folderAccess: { access: 'all', max: 5 } }],
      ['plain', {}],
    ] as Array<[string, Partial<HarnessDriver>]>) {
      const launchPreview = vi.fn(async ({ cwd }: { cwd: string }) => ({
        launchHash: 'a'.repeat(64),
        command: '/bin/agent',
        args: [],
        envNames: [],
        cwd,
        verified: false,
        approvals: 'prompts' as const,
        readback: 'none' as const,
        notes: [],
      }))
      previews.set(id, launchPreview)
      await value.attach(driver(id, extra), mount(external([], [], { launchPreview }).bridge, { source: 'acp' }))
    }
    expect(Object.fromEntries(value.drivers().map(info => [info.id, info.projectFolders ?? null]))).toEqual({
      all: { access: 'all' },
      capped: { access: 'all', max: 5 },
      zero: { access: 'all' },
      asks: { access: 'primary-asks' },
      // Only a driver that receives every folder is shown as using them.
      claims: null,
      plain: null,
    })
    const project = {
      workspaceId: 'proj',
      folders: [
        { id: 'api', path: '/w/api' },
        { id: 'web', path: '/w/web' },
      ],
    }
    await value.launchPreviewOf('capped', '/w/api', project)
    expect(previews.get('capped')).toHaveBeenCalledWith({ cwd: '/w/api', ...project })
    await value.launchPreviewOf('asks', '/w/api', project)
    expect(previews.get('asks')).toHaveBeenCalledWith({ cwd: '/w/api' })
  })

  it('closes every driver in reverse order, releases every lease, and reports cleanup failures', async () => {
    const order: string[] = []
    const first = external([], [], {
      close: vi.fn(async () => {
        order.push('first')
      }),
    })
    const second = external([], [], {
      close: vi.fn(async () => {
        order.push('second')
        throw new Error('stuck')
      }),
    })
    const value = await HarnessHub.open({ dataDir: await directory(), defaultId: () => 'first', log: vi.fn() })
    const mounts = [mount(first.bridge), mount(second.bridge)]
    await value.attach(driver('first'), mounts[0]!)
    await value.attach(driver('second'), mounts[1]!)
    await expect(value.close()).rejects.toThrow('Harness hub cleanup failed')
    expect(order).toEqual(['second', 'first'])
    for (const item of mounts) expect(item.release).toHaveBeenCalledOnce()
  })
})

describe('permission levels', () => {
  it('labels builtin sessions L1 and ACP or plugin sessions L3, with the matching permission summary', async () => {
    const builtin = external([summary('b-1')])
    const acp = external([summary('a-1')], [], {
      detail: vi.fn(async (sessionId: string) => ({
        summary: summary(sessionId),
        messages: [],
        approvals: [],
        liveText: '',
        cursor: 1,
        // A bridge cannot raise its own level or claim Latch enforces it.
        permission: {
          level: 'L1' as const,
          enforcer: 'LATCH' as const,
          readback: 'mode' as const,
          expectedMode: 'read-only',
          notes: ['note'],
        },
      })),
    })
    const plugin = external([summary('p-1')])
    const { hub: value } = await hub()
    await value.attach(driver('standard'), mount(builtin.bridge, { source: 'builtin' }))
    await value.attach(driver('agent'), mount(acp.bridge, { source: 'acp' }))
    await value.attach(driver('plugin'), mount(plugin.bridge))
    expect(value.levelOf('standard')).toBe('L1')
    expect(value.levelOf('agent')).toBe('L3')
    expect(value.levelOf('plugin')).toBe('L3')
    expect(value.levelOf('missing')).toBe('L3')
    expect(value.sourceOf('agent')).toBe('acp')
    expect(Object.fromEntries((await value.listTasks()).map(task => [task.id, task.level]))).toEqual({
      'b-1': 'L1',
      'a-1': 'L3',
      'p-1': 'L3',
    })
    expect((await value.detail('b-1')).permission).toEqual({ level: 'L1', enforcer: 'LATCH', notes: [] })
    expect((await value.detail('a-1')).permission).toEqual({
      level: 'L3',
      enforcer: 'NONE',
      readback: 'mode',
      expectedMode: 'read-only',
      notes: ['note'],
    })
    expect((await value.detail('p-1')).permission).toEqual({
      level: 'L3',
      enforcer: 'NONE',
      notes: ['第三方 Harness 插件，Latch 无法核实其执行范围'],
    })
  })

  it('passes launch hashes, widen consent, config classification and launch previews through unchanged', async () => {
    const preview = {
      launchHash: 'a'.repeat(64),
      command: '/bin/agent',
      args: [],
      envNames: ['A'],
      cwd: '/tmp',
      verified: true,
      approvals: 'prompts' as const,
      readback: 'mode' as const,
      notes: [],
    }
    const setConfig = vi.fn(async () => {})
    const classifyConfigChange = vi.fn(async () => 'wider' as const)
    const launchPreview = vi.fn(async () => preview)
    const acp = external([summary('a-1')], [], { setConfig, classifyConfigChange, launchPreview })
    const plain = external([summary('p-1')])
    const { hub: value } = await hub()
    await value.attach(driver('agent'), mount(acp.bridge, { source: 'acp' }))
    await value.attach(driver('plain'), mount(plain.bridge))
    acp.bridge.createTask.mockResolvedValueOnce({ sessionId: 'a-2' })
    await value.createTask({ prompt: 'x', requestId: 'r', harnessId: 'agent', expectedLaunchHash: 'b'.repeat(64) })
    expect(acp.bridge.createTask).toHaveBeenCalledWith({ prompt: 'x', requestId: 'r', expectedLaunchHash: 'b'.repeat(64) })
    await value.setConfig('a-1', 'mode', 'auto', { allowWiden: true })
    expect(setConfig).toHaveBeenCalledWith('a-1', 'mode', 'auto', { allowWiden: true })
    expect(await value.classifyConfigChange('a-1', 'mode', 'auto')).toBe('wider')
    expect(await value.classifyConfigChange('p-1', 'mode', 'auto')).toBe('neutral')
    expect(await value.launchPreviewOf('agent', '/tmp')).toEqual(preview)
    expect(launchPreview).toHaveBeenCalledWith({ cwd: '/tmp' })
    expect(await value.launchPreviewOf('plain', '/tmp')).toBeUndefined()
    await expect(value.launchPreviewOf('missing', '/tmp')).rejects.toMatchObject({ code: 'harness-unavailable' })
  })

  it('reports unsandboxed activity only while an L3 session runs or waits for approval', async () => {
    const builtinTasks = [summary('b-1', 'running')]
    const acpTasks = [summary('a-1', 'idle')]
    const { hub: value } = await hub()
    await value.attach(driver('standard'), mount(external(builtinTasks).bridge, { source: 'builtin' }))
    await value.attach(driver('agent'), mount(external(acpTasks).bridge, { source: 'acp' }))
    expect(await value.hasUnsandboxedActivity()).toBe(false)
    acpTasks[0]!.status = 'waiting-approval'
    expect(await value.hasUnsandboxedActivity()).toBe(true)
    acpTasks[0]!.status = 'running'
    expect(await value.hasUnsandboxedActivity()).toBe(true)
    acpTasks[0]!.status = 'cancelled'
    expect(await value.hasUnsandboxedActivity()).toBe(false)
  })

  it('finds a pending approval by ID, including one a driver reports only in its detail', async () => {
    const listed = external([summary('s-a')], [approval('a-1', 's-a')])
    const detailOnly = external([summary('s-c', 'waiting-approval')])
    detailOnly.bridge.detail.mockImplementation(async (sessionId: string) => ({
      summary: summary(sessionId, 'waiting-approval'),
      messages: [],
      approvals: [approval('c-1', sessionId)],
      liveText: '',
      cursor: 1,
    }))
    const { hub: value } = await hub()
    await value.attach(driver('first'), mount(listed.bridge))
    await value.attach(driver('third'), mount(detailOnly.bridge))
    expect(await value.findApproval('a-1')).toMatchObject({ harnessId: 'first', approval: { id: 'a-1' } })
    expect(await value.findApproval('c-1')).toBeUndefined()
    await value.detail('s-c')
    expect(await value.findApproval('c-1')).toMatchObject({ harnessId: 'third', approval: { id: 'c-1' } })
    expect(await value.findApproval('missing')).toBeUndefined()
  })
})

describe('host-level session metadata', () => {
  it('keeps title, pin and archive overrides for every harness across restarts', async () => {
    const dataDir = await directory()
    const outside = external([summary('s-1'), summary('s-2')])
    const first = await HarnessHub.open({ dataDir, defaultId: () => 'ext', log: vi.fn() })
    await first.attach(driver('ext'), mount(outside.bridge))
    const notified = vi.fn()
    first.subscribe(notified)
    expect(await first.updateMeta('s-1', { title: '重命名的会话', pinned: true })).toMatchObject({
      id: 's-1',
      title: '重命名的会话',
      pinned: true,
      harnessId: 'ext',
    })
    expect(notified).toHaveBeenCalledWith('s-1')
    expect((await stat(join(dataDir, 'sessions-meta.json'))).mode & 0o777).toBe(0o600)
    await first.close()

    const second = await HarnessHub.open({ dataDir, defaultId: () => 'ext', log: vi.fn() })
    cleanups.push(() => second.close())
    await second.attach(driver('ext'), mount(outside.bridge))
    const listed = await second.listTasks()
    expect(listed.find(task => task.id === 's-1')).toMatchObject({ title: '重命名的会话', pinned: true })
    expect(listed.find(task => task.id === 's-2')).not.toHaveProperty('pinned')
    const restored = await second.updateMeta('s-1', { title: null, pinned: false, archived: true })
    expect(restored).toMatchObject({ title: 'Task s-1', archived: true })
    expect(restored).not.toHaveProperty('pinned')
    await expect(second.updateMeta('missing', { pinned: true })).rejects.toMatchObject({ status: 404 })
  })

  it('deletes through the driver and drops the overlay, or reports what the driver cannot do', async () => {
    const dataDir = await directory()
    const remove = vi.fn(async () => {})
    const setConfig = vi.fn(async () => {})
    const capable = external([summary('s-1')], [], { remove, setConfig })
    const limited = external([summary('s-2')])
    const { hub: value } = await hub(dataDir)
    await value.attach(driver('capable'), mount(capable.bridge))
    await value.attach(driver('limited'), mount(limited.bridge))
    await value.updateMeta('s-1', { archived: true })
    await value.remove('s-1')
    expect(remove).toHaveBeenCalledExactlyOnceWith('s-1')
    expect(JSON.parse(await readFile(join(dataDir, 'sessions-meta.json'), 'utf8'))).toEqual({ version: 1, sessions: [] })
    await expect(value.remove('s-2')).rejects.toMatchObject({ status: 409, code: 'delete-unsupported' })
    await expect(value.setConfig('s-2', 'model', 'x')).rejects.toMatchObject({ status: 501, code: 'not-supported' })
    capable.bridge.listTasks.mockResolvedValue([summary('s-3')])
    await value.setConfig('s-3', 'model', 'fast')
    expect(setConfig).toHaveBeenCalledExactlyOnceWith('s-3', 'model', 'fast')
  })

  it('refuses a corrupt metadata file instead of replacing it', async () => {
    const dataDir = await directory()
    await writeFile(join(dataDir, 'sessions-meta.json'), '{broken')
    await expect(HarnessHub.open({ dataDir, defaultId: () => 'standard' })).rejects.toMatchObject({ status: 500, code: 'config-corrupt' })
    expect(await readFile(join(dataDir, 'sessions-meta.json'), 'utf8')).toBe('{broken')
  })
})
