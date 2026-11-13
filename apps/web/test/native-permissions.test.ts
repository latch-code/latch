import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startServer } from '@latch/host'
import { FAKE_ACP_AGENT, startHostFixture } from '@latch/testkit'
import type { AppSnapshot, HarnessInfo, HostCatalog, TaskDetail } from '@latch/protocol'
import { draftPermission, permissionView } from '../src/composer/permission.ts'
import { forkedChoice, forkSource } from '../src/forkChoice.ts'

describe('native permission semantics from the Host', () => {
  let close: (() => Promise<void>) | undefined
  let initial: HarnessInfo
  let catalog: HostCatalog
  let antigravity: TaskDetail
  let qwen: TaskDetail

  beforeAll(async () => {
    const fixture = await startHostFixture(setup =>
      startServer({
        dataDir: setup.dataDir,
        workspaceRoot: setup.workspaceRoot,
        uiDir: setup.workspaceRoot,
        runtimeParent: setup.runtimeParent,
        presence: setup.presence,
        port: 0,
        demo: false,
        nativeNetwork: false,
      }),
    )
    close = () => fixture.close()
    const owner = await fixture.enroll({ listener: 'unix' })
    for (const id of ['qwen', 'antigravity'])
      await owner.confirmedJson('agents', {
        body: {
          id,
          name: id,
          presetId: id,
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: {
            FAKE_ACP_CONFIG: 'options',
            FAKE_ACP_MODES: id === 'qwen' ? 'plan,default,auto-edit,auto,yolo' : 'default,accept-edits,auto,plan',
            FAKE_ACP_INITIAL_MODE: 'default',
          },
        },
      })
    initial = (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'antigravity')!
    const create = async (harnessId: string, mode: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId,
          requestId: randomUUID(),
          prompt: 'echo ready',
          config: [{ configId: 'mode', value: mode }],
        },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 5_000 })
      return detail()
    }
    qwen = await create('qwen', 'plan')
    antigravity = await create('antigravity', 'default')
    catalog = (await owner.json<AppSnapshot>('snapshot')).catalog!
  })
  afterAll(async () => close?.())

  it('publishes Antigravity planning as a native option without a read-only permission tier', () => {
    expect(antigravity.permission?.modeTiers?.plan).toBeUndefined()
    expect(antigravity.config?.find(item => item.category === 'mode')?.options.some(item => item.value === 'plan')).toBe(true)
  })

  it('labels the initial Antigravity draft with its actual default name', () => {
    expect(initial.catalogue).toBeUndefined()
    expect(draftPermission(initial, 'agent')).toMatchObject({ label: '默认', line: '沿用 Antigravity 的工具权限规则' })
  })

  it('does not silently carry a read-only fork into Antigravity planning', () => {
    const source = forkSource(
      qwen,
      catalog.harnesses.find(item => item.id === 'qwen'),
    )
    expect(source.mode).toMatchObject({ value: 'plan', tier: 'plan' })
    const forked = forkedChoice(catalog, null, { harnessId: 'antigravity' }, source)
    expect(forked.choice.config?.mode).toBe('default')
    expect(forked.missed.some(line => line.includes('只看不改') && line.includes('默认'))).toBe(true)
  })

  it('keeps the native planning option available for an explicit choice without calling it read-only', () => {
    const harness = catalog.harnesses.find(item => item.id === 'antigravity')!
    const view = permissionView({
      harness,
      permission: antigravity.permission,
      config: antigravity.config!,
      access: { local: true, legacy: false },
    })!
    const plan = view.rows!.find(row => row.value === 'plan')
    expect(plan).toBeDefined()
    expect(plan?.tier).toBeUndefined()
    expect(plan?.icon).not.toBe('eye')
    expect(plan?.name).toBe(antigravity.config!.find(item => item.category === 'mode')!.options.find(item => item.value === 'plan')!.name)
    const source = forkSource(
      qwen,
      catalog.harnesses.find(item => item.id === 'qwen'),
    )
    const explicit = forkedChoice(catalog, null, { harnessId: 'antigravity', config: { mode: 'plan' } }, source)
    expect(explicit.choice.config?.mode).toBe('plan')
    expect(explicit.missed).toEqual([])
  })
})
