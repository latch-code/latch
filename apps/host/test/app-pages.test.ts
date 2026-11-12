import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AppCapabilities,
  AppDataDocument,
  AppDataStatus,
  AppDiagnostic,
  AppLastReply,
  AppLookup,
  AppMigrationLease,
  AppSnapshot,
  CustomAgentList,
  PluginPackageBundle,
  PluginPackageDetail,
  TaskDetail,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import { checkedPluginBundle } from '../src/plugin-package-bundle.ts'
import { driverRequestId } from '../src/routes/apps.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const PLUGIN = 'release-check'
const TOKEN = `lmg1.${'A'.repeat(43)}`
const APP = `${PLUGIN}/main`
const ALL: AppCapabilities = {
  'tasks.read': true,
  'tasks.start': { projects: 'any' },
  'tasks.continue': true,
  'tasks.readOwn': true,
  storage: ['plugin', 'project', 'session'],
}

function appBundle(
  options: { capabilities?: AppCapabilities; dataVersion?: number; version?: string; id?: string; extra?: Record<string, unknown> } = {},
): PluginPackageBundle {
  const version = options.version ?? '1.0.0'
  return {
    manifest: {
      formatVersion: 2,
      id: options.id ?? PLUGIN,
      name: '发布检查',
      version,
      description: '发布前逐项检查。',
      apps: [
        {
          id: 'main',
          title: '发布检查',
          icon: 'list-checks',
          entry: 'src/index.js',
          dataVersion: options.dataVersion ?? 1,
          capabilities: structuredClone(options.capabilities ?? ALL),
          ...options.extra,
        },
      ],
    },
    files: [{ path: 'src/index.js', content: `export default function Page() { return null } // ${version}` }],
  }
}

async function fixture(options: TestHostOptions = {}) {
  const host = await startTestHost(options)
  cleanup.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  return { host, owner }
}

async function save(owner: TestDevice, bundle: PluginPackageBundle): Promise<PluginPackageDetail> {
  const existing = await owner.request(`plugin-packages/${bundle.manifest.id}`)
  if (existing.status === 404)
    return (await owner.json<{ package: PluginPackageDetail }>('plugin-packages', { body: { requestId: randomUUID(), bundle } })).package
  const current = ((await existing.json()) as { package: PluginPackageDetail }).package
  return (
    await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${bundle.manifest.id}`, {
      method: 'PUT',
      body: { requestId: randomUUID(), baseRevision: current.revision, bundle },
    })
  ).package
}

/** Applies with whatever confirmation the Host asks for; returns the package and how many confirmations it took. */
async function install(host: TestHost, owner: TestDevice, bundle: PluginPackageBundle) {
  const draft = await save(owner, bundle)
  const before = confirmations(host)
  const response = await owner.confirmed(`plugin-packages/${draft.id}/apply`, {
    body: { requestId: randomUUID(), revision: draft.revision },
  })
  expect(response.status).toBe(200)
  const pkg = ((await response.json()) as { package: PluginPackageDetail }).package
  return { pkg, confirmed: confirmations(host) - before, via: { app: APP, revision: pkg.appliedRevision! } }
}

const confirmations = (host: TestHost) => host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply').length

async function audits(host: TestHost): Promise<Array<{ action: string; actor: { deviceId?: string }; detail: Record<string, unknown> }>> {
  return (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; actor: { deviceId?: string }; detail: Record<string, unknown> })
}

async function settled(host: TestHost, sessionId: string) {
  await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
}

async function generalRules(owner: TestDevice): Promise<void> {
  const list = await owner.json<CustomAgentList>('custom-agents')
  await owner.json('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'GENERAL RULES' },
  })
}

async function defineFake(host: TestHost, owner: TestDevice, env: Record<string, string> = {}): Promise<void> {
  const created = await owner.confirmed('agents', {
    body: {
      id: 'fake',
      name: 'Fake agent',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_STATE: join(host.root, 'acp-state.json'), ...env },
    },
  })
  expect(created.status).toBe(201)
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

const start = (device: TestDevice, via: unknown, extra: Record<string, unknown> = {}) =>
  device.request('tasks', { body: { via, requestId: randomUUID(), prompt: '检查发布', ...extra } })

const query = (via: { app: string; revision: string }) => `app=${encodeURIComponent(via.app)}&revision=${via.revision}`

describe('plugin page manifests', () => {
  it('accepts format 2 pages, keeps format 1 unchanged, and refuses unknown capabilities, limits and SDK ranges', () => {
    expect(checkedPluginBundle(appBundle()).bundle.manifest.apps).toHaveLength(1)
    expect(checkedPluginBundle(appBundle()).executionHash).toBeUndefined()
    const legacy = {
      manifest: { formatVersion: 1, id: 'old', name: 'Old', version: '1', description: '' },
      files: [],
    }
    expect(checkedPluginBundle(legacy).bundle.manifest.formatVersion).toBe(1)
    const refused = (change: (bundle: PluginPackageBundle) => void) => {
      const bundle = appBundle()
      change(bundle)
      return () => checkedPluginBundle(bundle)
    }
    expect(refused(bundle => ((bundle.manifest.apps![0]!.capabilities as Record<string, unknown>)['tasks.approve'] = true))).toThrow()
    expect(
      refused(bundle => ((bundle.manifest.apps![0]!.capabilities as Record<string, unknown>).storage = ['plugin', 'device'])),
    ).toThrow()
    expect(refused(bundle => (bundle.manifest.apps![0]!.capabilities = { 'tasks.continue': true }))).toThrow()
    expect(
      refused(bundle => (bundle.manifest.apps = Array.from({ length: 5 }, (_, i) => ({ ...bundle.manifest.apps![0]!, id: `p${i}` })))),
    ).toThrow()
    expect(refused(bundle => (bundle.manifest.apps![0]!.entry = 'missing.tsx'))).toThrow()
    expect(refused(bundle => (bundle.manifest.apps![0]!.entry = 'page.mjs'))).toThrow()
    expect(refused(bundle => Object.assign(bundle.manifest, { requires: { appSdk: '^2' } }))).toThrow()
    expect(refused(bundle => Object.assign(bundle.manifest.apps![0]!, { secure: true }))).toThrow()
    // Nothing in a name or title can read as the confirmation's own wording.
    for (const text of ['X」，页面可以：只显示', '『X』', 'X:Y', 'X：Y', 'X\nY']) {
      expect(refused(bundle => (bundle.manifest.name = text))).toThrow()
      expect(refused(bundle => (bundle.manifest.apps![0]!.title = text))).toThrow()
    }
    // Pages need format 2.
    expect(() => checkedPluginBundle({ ...legacy, manifest: { ...legacy.manifest, apps: appBundle().manifest.apps } })).toThrow()
    expect(checkedPluginBundle({ ...appBundle(), manifest: { ...appBundle().manifest, requires: { appSdk: '^1.2' } } })).toBeTruthy()
  })
})

describe('applying plugin pages', () => {
  it('confirms the first apply and wider capabilities once, audits narrower updates, and rolls back without a confirmation', async () => {
    const { host, owner } = await fixture()
    const first = await install(host, owner, appBundle())
    expect(first.confirmed).toBe(1)
    const preview = host.presence.requests.at(-1)!.preview
    expect(preview.lines).toContainEqual({
      label: '页面「发布检查」可以',
      value: '查看会话列表；开始会话（任何项目）；继续它开始的会话；读它开始的会话的回复；保存数据（插件自己的、按项目、按会话）',
    })
    expect(preview.lines.some(line => line.label === '可执行内容摘要')).toBe(false)
    expect(preview.subject).toMatchObject({ form: 'plugin.package.apply-pages' })
    expect(preview.reason).toBe(
      '让插件页面可以：开始会话（任何项目）、继续它的会话、读它的会话回复、查看会话列表、保存数据（插件「发布检查」）',
    )

    const same = await install(host, owner, appBundle({ version: '1.0.1' }))
    expect(same.confirmed).toBe(0)
    const narrower = await install(host, owner, appBundle({ version: '1.0.2', capabilities: { 'tasks.read': true } }))
    expect(narrower.confirmed).toBe(0)
    // What was approved before stays approved: going back to it asks nothing.
    expect((await install(host, owner, appBundle({ version: '1.0.3' }))).confirmed).toBe(0)
    const narrowerProjects = await install(
      host,
      owner,
      appBundle({ version: '1.1.0', capabilities: { ...ALL, 'tasks.start': { projects: ['default'] } } }),
    )
    expect(narrowerProjects.confirmed).toBe(0)
    const twoPages = appBundle({ version: '2.0.0' })
    twoPages.manifest.apps!.push({ ...twoPages.manifest.apps![0]!, id: 'second', title: '第二页' })
    const widened = await install(host, owner, twoPages)
    expect(widened.confirmed).toBe(1)
    const trust = (await audits(host)).filter(record => record.action === 'plugin.package.app-trust').map(record => record.detail.trust)
    expect(trust).toEqual([
      'confirmed',
      'capabilities-approved',
      'capabilities-approved',
      'capabilities-approved',
      'capabilities-approved',
      'confirmed',
    ])

    const listed = (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${PLUGIN}`)).package
    expect(listed.rollbackRevisions?.map(item => item.version)).toEqual(['1.1.0', '1.0.3', '1.0.2', '1.0.1', '1.0.0'])
    const back = await owner.request(`plugin-packages/${PLUGIN}/rollback`, {
      body: { requestId: randomUUID(), revision: first.pkg.appliedRevision },
    })
    expect(back.status).toBe(200)
    expect(confirmations(host)).toBe(2)
    const rolled = ((await back.json()) as { package: PluginPackageDetail }).package
    expect(rolled).toMatchObject({ appliedRevision: first.pkg.appliedRevision, state: 'update-available' })
    const snapshot = await owner.json<AppSnapshot>('snapshot')
    expect(snapshot.catalog?.features?.appPages).toBe(1)
    expect(snapshot.apps).toEqual([
      expect.objectContaining({ pluginId: PLUGIN, appId: 'main', revision: first.pkg.appliedRevision, version: '1.0.0', status: 'ready' }),
    ])
    expect((await audits(host)).filter(record => record.action === 'plugin.package.app-trust').at(-1)?.detail).toMatchObject({
      operation: 'rollback',
      trust: 'capabilities-approved',
    })
    const missing = await owner.request(`plugin-packages/${PLUGIN}/rollback`, {
      body: { requestId: randomUUID(), revision: 'f'.repeat(64) },
    })
    expect(missing.status).toBe(404)
  })

  it('refuses a confirmation-bound apply while a full-access session waits, and applies an approved set anyway', async () => {
    const { host, owner } = await fixture({
      agentPlugin: agent => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
    })
    expect(
      (
        await owner.confirmed('agents', {
          body: {
            id: 'fake',
            name: 'Fake agent',
            command: process.execPath,
            args: [FAKE_ACP_AGENT],
            env: { FAKE_ACP_STATE: join(host.root, 'acp-state.json'), FAKE_ACP_MODES: 'read-only,auto' },
          },
        })
      ).status,
    ).toBe(201)
    await install(host, owner, appBundle())
    const waiting = await owner.json<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), prompt: 'permission', harnessId: 'fake' },
    })
    await expect.poll(() => host.host.bridge.approvals().some(item => item.sessionId === waiting.sessionId), { timeout: 10_000 }).toBe(true)
    const bundle = appBundle({ version: '2.0.0' })
    bundle.manifest.apps!.push({ ...bundle.manifest.apps![0]!, id: 'second', title: '第二页' })
    const draft = await save(owner, bundle)
    const blocked = await owner.request(`plugin-packages/${PLUGIN}/apply`, { body: { requestId: randomUUID(), revision: draft.revision } })
    expect(blocked.status).toBe(409)
    expect(await errorOf(blocked)).toBe('presence-blocked')
    const same = await save(owner, appBundle({ version: '1.0.1' }))
    expect(
      (await owner.request(`plugin-packages/${PLUGIN}/apply`, { body: { requestId: randomUUID(), revision: same.revision } })).status,
    ).toBe(200)
  })
})

describe('sessions a page starts', () => {
  it('starts through the same start with its origin, replays one request ID, looks it up across restarts, and reads its reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-app-restart-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspaceRoot = join(root, 'workspace'),
      dataDir = join(root, 'data')
    await mkdir(workspaceRoot)
    const { host, owner } = await fixture({ dataDir, workspaceRoot })
    const { via } = await install(host, owner, appBundle())
    const requestId = randomUUID()
    const body = { via, requestId, prompt: '检查发布', title: '发布检查 · 1.0' }
    const first = await owner.request('tasks', { body })
    expect(first.status).toBe(201)
    const { sessionId } = (await first.json()) as { sessionId: string }
    await settled(host, sessionId)
    const again = await owner.json<{ sessionId: string }>('tasks', { body })
    expect(again.sessionId).toBe(sessionId)
    const snapshot = await owner.json<AppSnapshot>('snapshot')
    expect(snapshot.tasks.filter(task => task.origin?.app === APP)).toEqual([
      expect.objectContaining({ id: sessionId, origin: { app: APP, requestId }, title: '发布检查 · 1.0' }),
    ])
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    // The driver keeps a request ID derived from the page's, so no other start can collide with it.
    const kept = detail.messages.find(message => message.role === 'user')?.requestId
    expect(kept).not.toBe(requestId)
    expect(kept).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(driverRequestId(APP, 'x'.repeat(22), requestId)).not.toBe(driverRequestId(APP, 'y'.repeat(22), requestId))
    expect((await audits(host)).filter(record => record.action === 'app.task.start')).toHaveLength(1)

    const lookup = await owner.json<AppLookup>(`apps/${PLUGIN}/pages/main/lookup/${requestId}?revision=${via.revision}`)
    expect(lookup).toEqual({ status: 'found', sessionId })
    expect(await owner.json<AppLookup>(`apps/${PLUGIN}/pages/main/lookup/${randomUUID()}?revision=${via.revision}`)).toEqual({
      status: 'not-found',
    })
    const reply = await owner.json<AppLastReply>(
      `apps/${PLUGIN}/pages/main/sessions/${encodeURIComponent(sessionId)}/last-reply?revision=${via.revision}`,
    )
    expect(reply).toMatchObject({ sessionId, status: 'idle', reply: { text: expect.any(String) } })
    expect(reply.reply!.text.length).toBeGreaterThan(0)

    const continued = await owner.request(`tasks/${encodeURIComponent(sessionId)}/prompt`, {
      body: { via, requestId: randomUUID(), prompt: '再看一次' },
    })
    expect(continued.status).toBe(200)
    await settled(host, sessionId)

    // A session started by hand is not the page's, for input or for its reply.
    const manual = await owner.json<{ sessionId: string }>('tasks', { body: { requestId: randomUUID(), prompt: 'manual' } })
    await settled(host, manual.sessionId)
    const foreign = await owner.request(`tasks/${encodeURIComponent(manual.sessionId)}/prompt`, {
      body: { via, requestId: randomUUID(), prompt: 'hijack' },
    })
    expect(foreign.status).toBe(403)
    expect(await errorOf(foreign)).toBe('app-capability-denied')
    expect(
      (
        await owner.request(
          `apps/${PLUGIN}/pages/main/sessions/${encodeURIComponent(manual.sessionId)}/last-reply?revision=${via.revision}`,
        )
      ).status,
    ).toBe(403)

    await host.close()
    const restarted = await fixture({ dataDir, workspaceRoot })
    expect(await restarted.owner.json<AppLookup>(`apps/${PLUGIN}/pages/main/lookup/${requestId}?revision=${via.revision}`)).toEqual({
      status: 'found',
      sessionId,
    })
    const replayed = await restarted.owner.json<{ sessionId: string }>('tasks', { body })
    expect(replayed.sessionId).toBe(sessionId)
    expect((await audits(restarted.host)).filter(record => record.action === 'app.task.start')).toHaveLength(1)
  })

  it('refuses stale revisions, undeclared capabilities, other projects, wider options, devices without run, and too many starts', async () => {
    const { host, owner } = await fixture()
    const { via } = await install(host, owner, appBundle({ capabilities: { 'tasks.start': { projects: ['default'] } } }))
    const stale = await start(owner, { app: APP, revision: 'a'.repeat(64) })
    expect([stale.status, await errorOf(stale)]).toEqual([409, 'app-revision-stale'])
    const otherApp = await start(owner, { app: `${PLUGIN}/other`, revision: via.revision })
    expect(otherApp.status).toBe(404)
    const project = await start(owner, via, { workspaceId: 'elsewhere' })
    expect([project.status, await errorOf(project)]).toEqual([403, 'app-capability-denied'])
    for (const extra of [
      { config: [{ configId: 'mode', value: 'yolo' }] },
      { worktree: true },
      { forkOf: { taskId: 'x', upToMessageId: 'y' } },
    ])
      expect((await start(owner, via, extra)).status).toBe(400)
    const viewer = await host.enroll({ scopes: ['view'] })
    const noRun = await start(viewer, via)
    expect([noRun.status, await errorOf(noRun)]).toEqual([403, 'scope-required'])
    expect((await owner.request(`apps/${PLUGIN}/pages/main/sessions/x/last-reply?revision=${via.revision}`)).status).toBe(403)
    const statuses: number[] = []
    for (let index = 0; index < 7; index++) statuses.push((await start(owner, via)).status)
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 429])
    // The limit is per device: another device still starts.
    const other = await host.enroll({ scopes: ['view', 'run'] })
    expect((await start(other, via)).status).toBe(201)
    // Disabled, the page can do nothing.
    await owner.json(`plugin-packages/${PLUGIN}/enabled`, { body: { requestId: randomUUID(), enabled: false } })
    const disabled = await start(other, via)
    expect([disabled.status, await errorOf(disabled)]).toEqual([409, 'app-disabled'])
    expect((await owner.json<AppSnapshot>('snapshot')).apps).toEqual([expect.objectContaining({ status: 'disabled' })])
    const diagnostics = await owner.json<{ diagnostics: AppDiagnostic[] }>(`apps/${PLUGIN}/diagnostics?${query(via)}`).catch(error => error)
    expect(diagnostics).toMatchObject({ status: 409 })
  })

  it('starts without private context, and refuses every page call on a session a person later made private', async () => {
    const { host, owner } = await fixture()
    const { via } = await install(host, owner, appBundle())
    await generalRules(owner)
    const requestId = randomUUID()
    const body = { via, requestId, prompt: '检查发布' }
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { body })
    await settled(host, sessionId)
    // Started from a device with all data, the page's session still carries none of it.
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary).not.toHaveProperty('agentPrivate')
    const page = `apps/${PLUGIN}/pages/main`
    expect((await owner.request(`${page}/sessions/${encodeURIComponent(sessionId)}/last-reply?revision=${via.revision}`)).status).toBe(200)
    // A person's own turn brings private context in; from then on the page cannot touch the session from any device.
    await owner.json(`tasks/${encodeURIComponent(sessionId)}/prompt`, { body: { requestId: randomUUID(), prompt: '我的' } })
    await settled(host, sessionId)
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary).toMatchObject({ agentPrivate: true })
    const refusals = [
      await owner.request(`${page}/sessions/${encodeURIComponent(sessionId)}/last-reply?revision=${via.revision}`),
      await owner.request(`${page}/lookup/${requestId}?revision=${via.revision}`),
      await owner.request('tasks', { body }),
      await owner.request(`tasks/${encodeURIComponent(sessionId)}/prompt`, { body: { via, requestId: randomUUID(), prompt: 'x' } }),
      await owner.request(`apps/${PLUGIN}/data/${encodeURIComponent(`session:${sessionId}`)}/k`, {
        method: 'PUT',
        body: { via, requestId: randomUUID(), ifVersion: 0, value: 1 },
      }),
    ]
    for (const response of refusals) {
      const text = await response.text()
      expect([response.status, JSON.parse(text).error]).toEqual([403, 'app-private-session'])
    }
  })

  it('refuses page input once a person changed the session permission mode', async () => {
    const { host, owner } = await fixture({
      agentPlugin: agent => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
    })
    await defineFake(host, owner, { FAKE_ACP_MODES: 'read-only,auto', FAKE_ACP_CONFIG: 'options' })
    const { via } = await install(host, owner, appBundle())
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      body: { via, requestId: randomUUID(), prompt: 'hello', harnessId: 'fake' },
    })
    await settled(host, sessionId)
    const send = () =>
      owner.request(`tasks/${encodeURIComponent(sessionId)}/prompt`, { body: { via, requestId: randomUUID(), prompt: 'again' } })
    const firstSend = await send()
    expect([firstSend.status, await firstSend.text()]).toEqual([200, expect.any(String)])
    await settled(host, sessionId)
    expect(
      (await owner.request(`tasks/${encodeURIComponent(sessionId)}/config`, { body: { configId: 'mode', value: 'auto' } })).status,
    ).toBe(200)
    const refused = await send()
    expect([refused.status, await errorOf(refused)]).toEqual([409, 'app-session-changed'])
  })

  it('refuses page input once a person gave the session a standing allowance, also one given before the start was recorded', async () => {
    const { host, owner } = await fixture()
    const { via } = await install(host, owner, appBundle())
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      body: { via, requestId: randomUUID(), prompt: '生成需要审批的报告' },
    })
    await expect.poll(() => host.host.bridge.approvals().some(item => item.sessionId === sessionId), { timeout: 10_000 }).toBe(true)
    const approval = host.host.bridge.approvals().find(item => item.sessionId === sessionId)!
    expect(approval.options?.some(option => option.kind === 'allow_always')).toBe(true)
    await owner.json(`approvals/${approval.id}`, { body: { decision: 'allow', optionId: 'allow_always', requestId: randomUUID() } })
    await settled(host, sessionId)
    const refused = await owner.request(`tasks/${encodeURIComponent(sessionId)}/prompt`, {
      body: { via, requestId: randomUUID(), prompt: 'again' },
    })
    expect([refused.status, await errorOf(refused)]).toEqual([409, 'app-session-changed'])

    // A change that lands between the start and its origin record is not the page's baseline.
    const manual = await owner.json<{ sessionId: string }>('tasks', { body: { requestId: randomUUID(), prompt: 'x' } })
    await settled(host, manual.sessionId)
    await host.host.bridge.markOriginChanged(manual.sessionId)
    await host.host.bridge.recordOrigin(manual.sessionId, { app: APP, requestId: randomUUID(), install: 'A'.repeat(22), level: 'L1' })
    expect(host.host.bridge.originOf(manual.sessionId)).toMatchObject({ changed: true })
  })

  it('gives a plugin created again under a deleted ID none of the old sessions or data unless its confirmation says so', async () => {
    const { host, owner } = await fixture()
    const first = await install(host, owner, appBundle({ capabilities: { 'tasks.start': { projects: 'any' }, 'tasks.readOwn': true } }))
    const requestId = randomUUID()
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { body: { via: first.via, requestId, prompt: 'x' } })
    await settled(host, sessionId)
    const record = (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${PLUGIN}`)).package
    await owner.json(`plugin-packages/${PLUGIN}`, { method: 'DELETE', body: { requestId: randomUUID(), baseRevision: record.revision } })
    const again = await install(host, owner, appBundle({ capabilities: { 'tasks.start': { projects: 'any' }, 'tasks.readOwn': true } }))
    expect(await owner.json<AppLookup>(`apps/${PLUGIN}/pages/main/lookup/${requestId}?revision=${again.via.revision}`)).toEqual({
      status: 'not-found',
    })
    expect(
      (await owner.request(`apps/${PLUGIN}/pages/main/sessions/${encodeURIComponent(sessionId)}/last-reply?revision=${again.via.revision}`))
        .status,
    ).toBe(403)
    // Its own start with the same request ID is a new session.
    const fresh = await owner.json<{ sessionId: string }>('tasks', { body: { via: again.via, requestId, prompt: 'x' } })
    expect(fresh.sessionId).not.toBe(sessionId)
  })

  it('takes over kept data only through a confirmation that says so on the system sheet', async () => {
    const { host, owner } = await fixture()
    const storage: AppCapabilities = { storage: ['plugin'] }
    const first = await install(host, owner, appBundle({ capabilities: storage }))
    await owner.json(`apps/${PLUGIN}/data/plugin/k`, {
      method: 'PUT',
      body: { via: first.via, requestId: randomUUID(), ifVersion: 0, value: 'kept' },
    })
    const record = (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${PLUGIN}`)).package
    await owner.json(`plugin-packages/${PLUGIN}`, { method: 'DELETE', body: { requestId: randomUUID(), baseRevision: record.revision } })
    const again = await install(host, owner, appBundle({ capabilities: storage }))
    expect(again.confirmed).toBe(1)
    expect(host.presence.requests.at(-1)!.preview.reason).toBe('让插件页面可以：保存数据、接上保留的数据（插件「发布检查」）')
    const read = await owner.json<{ document: AppDataDocument }>(`apps/${PLUGIN}/data/plugin/k?${query(again.via)}`)
    expect(read.document.value).toBe('kept')
  })
})

describe('plugin page storage', () => {
  it('keeps documents by scope with versions, receipts, scope checks, SSE and session deletion', async () => {
    const { host, owner } = await fixture()
    const { via } = await install(
      host,
      owner,
      appBundle({ capabilities: { 'tasks.start': { projects: 'any' }, storage: ['plugin', 'session'] } }),
    )
    const put = (device: TestDevice, scope: string, key: string, value: unknown, ifVersion: number, requestId = randomUUID()) =>
      device.request(`apps/${PLUGIN}/data/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { via, requestId, ifVersion, value },
      })
    const events = await openStream(owner)
    const requestId = randomUUID()
    const created = await put(owner, 'plugin', 'checklist/main', { items: ['tests'] }, 0, requestId)
    expect(await created.json()).toEqual({ version: 1 })
    const replay = await put(owner, 'plugin', 'checklist/main', { items: ['tests'] }, 0, requestId)
    expect(await replay.json()).toEqual({ version: 1, replay: true })
    const reused = await put(owner, 'plugin', 'checklist/main', { items: ['other'] }, 0, requestId)
    expect([reused.status, await errorOf(reused)]).toEqual([409, 'request-conflict'])
    const stale = await put(owner, 'plugin', 'checklist/main', { items: [] }, 0)
    expect([stale.status, await errorOf(stale)]).toEqual([409, 'app-data-conflict'])
    expect((await put(owner, 'plugin', 'checklist/main', { items: ['tests', 'docs'] }, 1)).status).toBe(200)
    const read = await owner.json<{ document: AppDataDocument }>(
      `apps/${PLUGIN}/data/plugin/${encodeURIComponent('checklist/main')}?${query(via)}`,
    )
    expect(read.document).toMatchObject({ scope: 'plugin', key: 'checklist/main', version: 2, value: { items: ['tests', 'docs'] } })
    await expect.poll(() => events.text, { timeout: 5_000 }).toContain('"type":"app.data"')
    expect(events.text).toContain(`"pluginId":"${PLUGIN}","scope":"plugin","key":"checklist/main","version":2`)

    // Undeclared scopes are refused; so is a device without run, which may still read.
    const project = await put(owner, 'project:default', 'x', 1, 0)
    expect([project.status, await errorOf(project)]).toEqual([403, 'app-capability-denied'])
    const viewer = await host.enroll({ scopes: ['view'] })
    expect((await put(viewer, 'plugin', 'x', 1, 0)).status).toBe(403)
    expect((await viewer.request(`apps/${PLUGIN}/data?scope=plugin&${query(via)}`)).status).toBe(200)
    const bogus = await owner.request(
      `apps/${PLUGIN}/data?scope=plugin&app=${encodeURIComponent('other-plugin/main')}&revision=${via.revision}`,
    )
    expect(bogus.status).toBe(400)
    expect((await put(owner, 'plugin', 'big', 'x'.repeat(300 * 1024), 0)).status).toBe(413)

    // A session's documents follow the session: a missing one is refused, a private one needs the data scope.
    expect((await put(owner, 'session:nope', 'k', 1, 0)).status).toBe(404)
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { body: { via, requestId: randomUUID(), prompt: '检查' } })
    await settled(host, sessionId)
    const sessionScope = `session:${sessionId}`
    expect((await put(owner, sessionScope, 'result', { pass: true }, 0)).status).toBe(200)
    await generalRules(owner)
    const secret = await owner.json<{ sessionId: string }>('tasks', { body: { via, requestId: randomUUID(), prompt: '私有' } })
    await settled(host, secret.sessionId)
    expect((await put(owner, `session:${secret.sessionId}`, 'result', 1, 0)).status).toBe(200)
    await owner.json(`tasks/${encodeURIComponent(secret.sessionId)}/prompt`, { body: { requestId: randomUUID(), prompt: '我的' } })
    await settled(host, secret.sessionId)
    const work = await host.enroll({ scopes: ['view', 'run'] })
    await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    for (const device of [work, owner])
      expect(
        (await device.request(`apps/${PLUGIN}/data?scope=${encodeURIComponent(`session:${secret.sessionId}`)}&${query(via)}`)).status,
      ).toBe(403)
    expect((await work.request(`apps/${PLUGIN}/data?scope=${encodeURIComponent(sessionScope)}&${query(via)}`)).status).toBe(200)
    const workEvents = await openStream(work)
    expect((await put(owner, 'plugin', 'after', 1, 0)).status).toBe(200)
    await expect.poll(() => workEvents.text, { timeout: 5_000 }).toContain('"key":"after"')
    // A deleted session's documents are announced only to devices with all data.
    const ownerEvents = await openStream(owner)
    expect((await owner.request(`tasks/${encodeURIComponent(secret.sessionId)}`, { method: 'DELETE' })).status).toBe(200)
    await expect.poll(() => ownerEvents.text, { timeout: 5_000 }).toContain(`session:${secret.sessionId}`)
    expect(workEvents.text).not.toContain(secret.sessionId)

    expect((await owner.request(`tasks/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })).status).toBe(200)
    await expect
      .poll(
        async () => (await owner.json<{ documents: AppDataDocument[] }>(`apps/${PLUGIN}/data?scope=plugin&${query(via)}`)).documents.length,
      )
      .toBe(2)
    await expect
      .poll(() => readFile(join(host.dataDir, 'plugin-data', PLUGIN, 'gen-1', 'data.json'), 'utf8'), { timeout: 5_000 })
      .not.toContain(sessionId)
    const file = await stat(join(host.dataDir, 'plugin-data', PLUGIN, 'gen-1', 'data.json'))
    expect(file.mode & 0o777).toBe(0o600)
    expect((await stat(join(host.dataDir, 'plugin-data', PLUGIN))).mode & 0o777).toBe(0o700)
  })

  it('migrates to a new generation under one lease, switches generations on rollback, and says when data is newer', async () => {
    const { host, owner } = await fixture()
    const v1 = await install(host, owner, appBundle({ capabilities: { storage: ['plugin'] } }))
    const write = (via: { app: string; revision: string }, key: string, value: unknown, ifVersion = 0) =>
      owner.request(`apps/${PLUGIN}/data/plugin/${key}`, { method: 'PUT', body: { via, requestId: randomUUID(), ifVersion, value } })
    expect((await write(v1.via, 'items', ['a'])).status).toBe(200)
    const v2 = await install(host, owner, appBundle({ version: '2.0.0', dataVersion: 2, capabilities: { storage: ['plugin'] } }))
    expect(v2.confirmed).toBe(0)
    expect((await owner.json<AppSnapshot>('snapshot')).apps?.[0]?.status).toBe('needs-migration')
    const blocked = await owner.request(`apps/${PLUGIN}/data?scope=plugin&${query(v2.via)}`)
    expect([blocked.status, await errorOf(blocked)]).toEqual([409, 'app-data-migration-required'])
    // The old page revision is no longer the applied one.
    expect((await owner.request(`apps/${PLUGIN}/data?scope=plugin&${query(v1.via)}`)).status).toBe(409)

    const lease = await owner.json<AppMigrationLease>(`apps/${PLUGIN}/data/migrate/lease`, { body: { via: v2.via } })
    expect(lease).toMatchObject({ fromGeneration: 1, fromVersion: 1, toVersion: 2, documents: [expect.objectContaining({ key: 'items' })] })
    const other = await host.enroll({ scopes: ['view', 'run'] })
    const second = await other.request(`apps/${PLUGIN}/data/migrate/lease`, { body: { via: v2.via } })
    expect([second.status, await errorOf(second)]).toEqual([409, 'app-data-migrating'])
    expect((await other.json<AppDataStatus>(`apps/${PLUGIN}/data/status?${query(v2.via)}`)).status).toBe('migrating')
    const theirs = await other.request(`apps/${PLUGIN}/data/migrate`, {
      body: { via: v2.via, requestId: randomUUID(), lease: lease.lease, fromGeneration: 1, toVersion: 2, documents: [] },
    })
    expect([theirs.status, await errorOf(theirs)]).toEqual([409, 'app-data-lease-lost'])
    const migrate = {
      via: v2.via,
      requestId: randomUUID(),
      lease: lease.lease,
      fromGeneration: 1,
      toVersion: 2,
      documents: [{ scope: 'plugin', key: 'items', value: { list: ['a'] } }],
    }
    expect(await owner.json(`apps/${PLUGIN}/data/migrate`, { body: migrate })).toEqual({ generation: 2 })
    expect(await owner.json(`apps/${PLUGIN}/data/migrate`, { body: migrate })).toEqual({ generation: 2, replay: true })
    expect((await audits(host)).find(record => record.action === 'app.data.migrate')?.detail).toMatchObject({
      pluginId: PLUGIN,
      fromGeneration: 1,
      toGeneration: 2,
      fromVersion: 1,
      toVersion: 2,
      documents: 1,
    })
    expect((await write(v2.via, 'items', { list: ['a', 'b'] }, 1)).status).toBe(200)

    // Rollback to 1.0.0 uses generation 1 again; forward again finds generation 2.
    await owner.json(`plugin-packages/${PLUGIN}/rollback`, { body: { requestId: randomUUID(), revision: v1.via.revision } })
    const old = await owner.json<{ documents: AppDataDocument[] }>(`apps/${PLUGIN}/data?scope=plugin&${query(v1.via)}`)
    expect(old.documents.map(item => item.value)).toEqual([['a']])
    await owner.json(`plugin-packages/${PLUGIN}/rollback`, { body: { requestId: randomUUID(), revision: v2.via.revision } })
    const current = await owner.json<{ documents: AppDataDocument[] }>(`apps/${PLUGIN}/data?scope=plugin&${query(v2.via)}`)
    expect(current.documents.map(item => item.value)).toEqual([{ list: ['a', 'b'] }])
  })

  it('hands a migration only the page scopes and usable sessions, and carries the rest forward unchanged', async () => {
    const { host, owner } = await fixture({
      agentPlugin: agent => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
    })
    await defineFake(host, owner)
    const pages = (dataVersion: number, version: string) => {
      const bundle = appBundle({ version, dataVersion, capabilities: { storage: ['plugin'] } })
      bundle.manifest.apps!.push({
        ...bundle.manifest.apps![0]!,
        id: 'runner',
        title: '运行',
        capabilities: { 'tasks.start': { projects: 'any' }, storage: ['session', 'project'] },
      })
      return bundle
    }
    const v1 = await install(host, owner, pages(1, '1.0.0'))
    const runner = { app: `${PLUGIN}/runner`, revision: v1.via.revision }
    const write = (scope: string, value: string) =>
      owner.json(`apps/${PLUGIN}/data/${encodeURIComponent(scope)}/k`, {
        method: 'PUT',
        body: { via: runner, requestId: randomUUID(), ifVersion: 0, value },
      })
    const plain = await owner.json<{ sessionId: string }>('tasks', { body: { via: runner, requestId: randomUUID(), prompt: 'x' } })
    await settled(host, plain.sessionId)
    const gone = await owner.json<{ sessionId: string }>('tasks', {
      body: { via: runner, requestId: randomUUID(), prompt: 'x', harnessId: 'fake' },
    })
    await settled(host, gone.sessionId)
    await write('project:default', 'project doc')
    await write(`session:${plain.sessionId}`, 'plain doc')
    await write(`session:${gone.sessionId}`, 'harness gone doc')
    await generalRules(owner)
    await owner.json(`tasks/${encodeURIComponent(plain.sessionId)}/prompt`, { body: { requestId: randomUUID(), prompt: '我的' } })
    await settled(host, plain.sessionId)
    const v2 = await install(host, owner, pages(2, '2.0.0'))
    expect((await owner.request('plugins/agent-fake', { body: { enabled: false } })).status).toBe(200)

    // The storage-only page sees its own scope; the runner never sees the now-private session or the one it cannot find.
    const mainLease = await owner.json<AppMigrationLease>(`apps/${PLUGIN}/data/migrate/lease`, {
      body: { via: { app: APP, revision: v2.via.revision } },
    })
    expect(mainLease.documents).toEqual([])
    const lease = await owner.json<AppMigrationLease>(`apps/${PLUGIN}/data/migrate/lease`, {
      body: { via: { ...runner, revision: v2.via.revision } },
    })
    expect(lease.documents.map(item => item.value)).toEqual(['project doc'])
    await owner.json(`apps/${PLUGIN}/data/migrate`, {
      body: {
        via: { ...runner, revision: v2.via.revision },
        requestId: randomUUID(),
        lease: lease.lease,
        fromGeneration: lease.fromGeneration,
        toVersion: 2,
        documents: [{ scope: 'project:default', key: 'k', value: 'project doc v2' }],
      },
    })
    const stored = await readFile(join(host.dataDir, 'plugin-data', PLUGIN, 'gen-2', 'data.json'), 'utf8')
    expect(stored).toContain('project doc v2')
    expect(stored).toContain('plain doc')
    expect(stored).toContain('harness gone doc')
  })

  it('reports data newer than the code, keeps the last three generations, and deletes data only when asked', async () => {
    const { host, owner } = await fixture()
    let latest = await install(host, owner, appBundle({ dataVersion: 1, capabilities: { storage: ['plugin'] } }))
    await owner.json(`apps/${PLUGIN}/data/plugin/k`, {
      method: 'PUT',
      body: { via: latest.via, requestId: randomUUID(), ifVersion: 0, value: 0 },
    })
    for (const version of [2, 3, 4]) {
      latest = await install(
        host,
        owner,
        appBundle({ version: `${version}.0.0`, dataVersion: version, capabilities: { storage: ['plugin'] } }),
      )
      const lease = await owner.json<AppMigrationLease>(`apps/${PLUGIN}/data/migrate/lease`, { body: { via: latest.via } })
      await owner.json(`apps/${PLUGIN}/data/migrate`, {
        body: {
          via: latest.via,
          requestId: randomUUID(),
          lease: lease.lease,
          fromGeneration: lease.fromGeneration,
          toVersion: version,
          documents: [{ scope: 'plugin', key: 'k', value: version }],
        },
      })
    }
    expect((await readdir(join(host.dataDir, 'plugin-data', PLUGIN))).filter(name => name.startsWith('gen-')).toSorted()).toEqual([
      'gen-2',
      'gen-3',
      'gen-4',
    ])
    const rolled = await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${PLUGIN}`)
    const first = rolled.package.rollbackRevisions!.at(-1)!
    await owner.json(`plugin-packages/${PLUGIN}/rollback`, { body: { requestId: randomUUID(), revision: first.revision } })
    const via = { app: APP, revision: first.revision }
    expect((await owner.json<AppDataStatus>(`apps/${PLUGIN}/data/status?${query(via)}`)).status).toBe('data-newer')
    expect((await owner.json<AppSnapshot>('snapshot')).apps?.[0]?.status).toBe('data-newer')
    const refused = await owner.request(`apps/${PLUGIN}/data?scope=plugin&${query(via)}`)
    expect([refused.status, await errorOf(refused)]).toEqual([409, 'app-data-newer'])

    const record = (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${PLUGIN}`)).package
    await owner.json(`plugin-packages/${PLUGIN}`, { method: 'DELETE', body: { requestId: randomUUID(), baseRevision: record.revision } })
    expect(await readdir(join(host.dataDir, 'plugin-data'))).toContain(PLUGIN)
    const again = await install(host, owner, appBundle({ version: '4.0.0', dataVersion: 4, capabilities: { storage: ['plugin'] } }))
    expect((await owner.json<{ document: AppDataDocument }>(`apps/${PLUGIN}/data/plugin/k?${query(again.via)}`)).document.value).toBe(4)
    await owner.json(`plugin-packages/${PLUGIN}`, {
      method: 'DELETE',
      body: { requestId: randomUUID(), baseRevision: again.pkg.revision, deleteData: true },
    })
    expect(await readdir(join(host.dataDir, 'plugin-data'))).not.toContain(PLUGIN)
    expect((await audits(host)).find(record => record.action === 'app.data.removed')?.detail).toEqual({ pluginId: PLUGIN, documents: 3 })
  })
})

describe('plugin page limits', () => {
  it('limits document writes per page and device, and escapes page titles in the confirmation lines', async () => {
    const { host, owner } = await fixture()
    const bundle = appBundle({ capabilities: { storage: ['plugin'] } })
    bundle.manifest.apps![0]!.title = '发布\u202E检查'
    const { via } = await install(host, owner, bundle)
    expect(host.presence.requests.at(-1)!.preview.lines.map(line => line.label)).toContain('页面「发布\\u{202E}检查」可以')
    const statuses: number[] = []
    for (let index = 0; index < 61; index++)
      statuses.push(
        (
          await owner.request(`apps/${PLUGIN}/data/plugin/k${index}`, {
            method: 'PUT',
            body: { via, requestId: randomUUID(), ifVersion: 0, value: index },
          })
        ).status,
      )
    expect(statuses.slice(0, 60).every(status => status === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
  })
})

describe('plugin page diagnostics', () => {
  it('keeps the last 200 per page, redacted, and limits reports per device', async () => {
    const { host, owner } = await fixture()
    const { via } = await install(host, owner, appBundle({ capabilities: {} }))
    const report = (message: string) =>
      owner.request(`apps/${PLUGIN}/diagnostics`, { body: { via, source: 'runtime', code: 'uncaught', message } })
    expect((await report(`TypeError near ${TOKEN}`)).status).toBe(201)
    const listed = await owner.json<{ diagnostics: AppDiagnostic[] }>(`apps/${PLUGIN}/diagnostics?${query(via)}`)
    expect(listed.diagnostics).toHaveLength(1)
    expect(listed.diagnostics[0]!.message).not.toContain(TOKEN)
    expect(listed.diagnostics[0]).toMatchObject({ appId: 'main', source: 'runtime', code: 'uncaught' })
    const statuses: number[] = []
    for (let index = 0; index < 20; index++) statuses.push((await report(`error ${index}`)).status)
    expect(statuses.filter(status => status === 429)).toHaveLength(1)
    // A refused capability is a bridge diagnostic, without the Host's own error text.
    await owner.request('tasks', { body: { via, requestId: randomUUID(), prompt: 'x' } })
    const stored = await readFile(join(host.dataDir, 'plugin-data', PLUGIN, 'diagnostics.json'), 'utf8')
    expect((await stat(join(host.dataDir, 'plugin-data', PLUGIN, 'diagnostics.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(stored).entries).toHaveLength(20)
  })
})

/** Reads the event stream in the background. */
async function openStream(device: TestDevice): Promise<{ text: string }> {
  const controller = new AbortController()
  cleanup.push(async () => controller.abort())
  const response = await device.request('events', { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const state = { text: '' }
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        state.text += decoder.decode(value, { stream: true })
      }
    } catch {
      // Aborted at cleanup.
    }
  })()
  return state
}
