import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPluginPackageTemplate,
  PLUGIN_MARKETPLACE_PAGE,
  type AppSnapshot,
  type CustomAgent,
  type PluginInfo,
  type PluginCatalogCheckResult,
  type PluginCatalogPreview,
  type PluginCatalogStage,
  type PluginPackageReview,
  type PluginPackageDetail,
  type PluginPackageSummary,
  type ConfirmationTicket,
  type PluginPackageBundle,
  type TaskDetail,
} from '@latch/protocol'
import type { ModelMessage, ModelProvider } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { officialCatalogFixture } from './helpers/official-catalog.ts'
import type { TestDevice } from '@latch/testkit'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(options: Parameters<typeof startTestHost>[0] = {}) {
  const host = await startTestHost(options)
  cleanup.push(() => host.close())
  return { host, owner: await host.enroll({ listener: 'unix' }) }
}
async function create(owner: TestDevice, bundle: PluginPackageBundle) {
  return (await owner.json<{ package: PluginPackageDetail }>('plugin-packages', { body: { requestId: randomUUID(), bundle } })).package
}
async function apply(owner: TestDevice, record: PluginPackageDetail) {
  return owner.request(`plugin-packages/${record.id}/apply`, { body: { requestId: randomUUID(), revision: record.revision } })
}
async function granted(owner: TestDevice, host: TestHost, record: PluginPackageDetail) {
  const input = { requestId: randomUUID(), revision: record.revision },
    route = `plugin-packages/${record.id}/apply`
  const denied = await owner.request(route, { body: input })
  expect(denied.status).toBe(403)
  const confirmation = ((await denied.json()) as { confirmation: ConfirmationTicket }).confirmation
  expect(confirmation).toMatchObject({
    action: 'plugin.package.apply',
    form: 'plugin.package.apply',
    reason: expect.stringMatching(/^应用插件「.+」$/u),
  })
  await expect
    .poll(async () => (await owner.json<{ confirmation: ConfirmationTicket }>(`confirmations/${confirmation.id}`)).confirmation.status)
    .toBe('approved')
  expect(host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply').at(-1)?.requireBiometric).toBe(true)
  const applied = await owner.json<{ package: PluginPackageDetail }>(route, { body: input, confirmation: confirmation.id })
  return { ...applied, input, confirmation }
}
it('ships the marketplace as a plugin, persists disable, and withdraws only its workspace contribution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-marketplace-restart-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspaceRoot)
  const { host, owner } = await fixture({ workspaceRoot, dataDir })
  const browser = await host.enroll({ scopes: ['view'] })
  const { pluginId } = PLUGIN_MARKETPLACE_PAGE
  const pluginRoute = `plugins/${encodeURIComponent(pluginId)}`
  const catalog = async (device: TestDevice) => (await device.json<AppSnapshot>('snapshot')).catalog
  expect((await catalog(browser))?.workspacePages).toContainEqual(PLUGIN_MARKETPLACE_PAGE)
  expect((await browser.request('plugin-packages')).status).toBe(403)
  expect((await browser.request(pluginRoute, { body: { enabled: false } })).status).toBe(403)
  expect(host.host.registry.list().find(plugin => plugin.id === pluginId)?.enabled).toBe(true)

  const { plugins } = await owner.json<{ plugins: PluginInfo[] }>(pluginRoute, { body: { enabled: false } })
  expect(plugins.find(plugin => plugin.id === pluginId)).toMatchObject({ enabled: false, builtIn: true, capabilities: [] })
  expect((await catalog(browser))?.workspacePages).toBeUndefined()
  expect((await owner.json<AppSnapshot>('snapshot')).tasksComplete).toBe(true)
  expect((await catalog(owner))?.features).toMatchObject({ pluginPackages: true, pluginNpmRegistry: true })
  expect((await owner.request('plugin-packages')).status).toBe(200)
  await host.close()

  const restarted = await fixture({ workspaceRoot, dataDir })
  expect((await catalog(restarted.owner))?.workspacePages).toBeUndefined()
  const enabled = await restarted.owner.json<{ plugins: PluginInfo[] }>(pluginRoute, { body: { enabled: true } })
  expect(enabled.plugins.find(plugin => plugin.id === pluginId)).toMatchObject({
    enabled: true,
    builtIn: true,
    capabilities: ['workspace:marketplace'],
  })
  expect((await catalog(restarted.owner))?.workspacePages).toContainEqual(PLUGIN_MARKETPLACE_PAGE)
})

it('keeps loading a legacy module that previously chose the marketplace ID without offering it as a bundled page', async () => {
  const id = PLUGIN_MARKETPLACE_PAGE.pluginId
  const { owner } = await fixture({
    plugins: [
      {
        id,
        name: 'Existing user module',
        version: '1',
        description: '',
        activate: ctx => ctx.registerSkill({ id: 'review', name: 'Review', description: '', content: 'Review the work.' }),
      },
    ],
  })
  const catalog = (await owner.json<AppSnapshot>('snapshot')).catalog
  expect(catalog?.workspacePages).toBeUndefined()
  expect(catalog?.skills).toContainEqual(expect.objectContaining({ pluginId: id, id: `${id}:review` }))
  const { plugins } = await owner.json<{ plugins: PluginInfo[] }>('plugins')
  expect(plugins.find(plugin => plugin.id === id)).not.toHaveProperty('builtIn')
})

it('reviews and stages the exact bundled release, keeping other sources and never enabling a reviewed draft', async () => {
  const { host, owner } = await fixture()
  const viewer = await host.enroll({ listener: 'loopback-tcp' })
  const pluginId = 'release-review'
  const route = 'plugin-packages/catalog'
  const preview = (id: string) => owner.json<PluginCatalogPreview>(`${route}/preview`, { body: { pluginId: id } })
  const body = (revision: string, id = pluginId) => ({ pluginId: id, revision, requestId: randomUUID() })
  expect((await viewer.request(`${route}/preview`, { body: { pluginId } })).status).toBe(403)
  expect((await viewer.request('plugin-packages/review', { body: { bundle: createPluginPackageTemplate('tool') } })).status).toBe(403)
  expect((await owner.request(`${route}/preview`, { body: { pluginId: 'not-in-the-catalog' } })).status).toBe(404)
  expect((await owner.request(`${route}/stage`, { body: body('0'.repeat(64), 'not-in-the-catalog') })).status).toBe(404)

  const candidate = await preview(pluginId)
  expect(candidate.review).toMatchObject({
    version: candidate.bundle.manifest.version,
    source: { kind: 'catalog', version: candidate.bundle.manifest.version },
    confirmationRequired: true,
    hostModules: ['host.mjs'],
    panels: [expect.objectContaining({ entry: 'panel.mjs' })],
    findings: expect.arrayContaining([
      expect.objectContaining({ kind: 'host-access' }),
      expect.objectContaining({ kind: 'workbench-access' }),
    ]),
  })
  expect(candidate.review.toolNames).toHaveLength(1)
  expect((await owner.request(`plugin-packages/${pluginId}`)).status).toBe(404)
  expect((await owner.request(`${route}/stage`, { body: body('0'.repeat(64)) })).status).toBe(409)
  const request = body(candidate.review.revision)
  const staged = await owner.json<{ package: PluginPackageDetail }>(`${route}/stage`, { body: request })
  expect(staged.package).toMatchObject({
    catalog: { revision: candidate.review.revision, version: candidate.review.version },
    catalogUpdate: { version: candidate.review.version, status: 'current' },
    review: candidate.review,
    enabled: false,
  })
  expect(host.host.registry.list().some(item => item.id === pluginId)).toBe(false)
  expect((await owner.request(`${route}/stage`, { body: request })).status).toBe(201)
  expect(host.presence.requests.filter(item => item.preview.action === 'plugin.package.apply')).toHaveLength(0)

  const text = await preview('shift-handoff')
  const unrelated = await create(owner, text.bundle)
  const collision = await preview(unrelated.id)
  expect(collision).toMatchObject({ updateStatus: 'different-source', updateAvailable: false })
  const update = { installId: collision.installed!.installId, baseRevision: unrelated.revision }
  expect((await owner.request(`${route}/stage`, { body: { ...body(text.review.revision, unrelated.id), update } })).status).toBe(409)
  expect((await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${unrelated.id}`)).package).toEqual(unrelated)
})

it('checks the official catalog and updates an existing bundled installation through a reviewed draft', async () => {
  const github = officialCatalogFixture()
  const { host, owner } = await fixture({ pluginRegistryFetch: github.fetch })
  const route = 'plugin-packages/catalog'
  const pluginId = 'context-insights'
  const preview = () => owner.json<PluginCatalogPreview>(`${route}/preview`, { body: { pluginId } })
  const stage = (body: PluginCatalogStage) => owner.json<{ package: PluginPackageDetail }>(`${route}/stage`, { body })
  const read = async () => (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${pluginId}`)).package
  const local = await preview()
  const installed = await stage({ pluginId, revision: local.review.revision, requestId: randomUUID() })
  await granted(owner, host, installed.package)
  const remote = await host.enroll({ listener: 'loopback-tcp' })
  expect((await remote.request(`${route}/check`, { body: { force: true } })).status).toBe(403)
  expect((await owner.request(`${route}/check`, { body: { repository: 'https://example.com' } })).status).toBe(400)
  expect(github.fetch).not.toHaveBeenCalled()

  const commit = github.publishContext('9.0.0', '\n// New panel.\n')
  const check = () => owner.json<PluginCatalogCheckResult>(`${route}/check`, { body: { force: true } })
  const result = await check()
  expect(result.plugins).toHaveLength(4)
  expect(result.plugins.find(item => item.id === pluginId)).toMatchObject({ commit, version: '9.0.0', updateStatus: 'available' })
  const known = (await owner.json<{ packages: PluginPackageSummary[] }>('plugin-packages')).packages
  expect(known.find(item => item.id === pluginId)?.catalogUpdate).toEqual({ version: '9.0.0', status: 'available' })
  const candidate = await preview()
  expect(candidate.review.source).toEqual({ kind: 'catalog', version: '9.0.0', commit })
  expect(candidate.review.comparison).toMatchObject({ revision: local.review.revision, changedSource: false, changedExecution: true })
  const input = {
    pluginId,
    revision: candidate.review.revision,
    requestId: randomUUID(),
    update: { installId: candidate.installed!.installId, baseRevision: local.review.revision },
  }
  const staged = (await stage(input)).package
  expect(staged).toMatchObject({
    catalog: { revision: input.revision, version: '9.0.0', commit },
    appliedRevision: local.review.revision,
    appliedVersion: local.review.version,
    review: { source: candidate.review.source, confirmationRequired: true },
  })
  github.publishContext('9.1.0', '\n// Another panel.\n')
  await check()
  expect((await stage(input)).package.revision).toBe(input.revision)
  const applied = await granted(owner, host, staged)
  expect(applied.package.appliedRevision).toBe(input.revision)
  expect((await read()).catalogUpdate).toEqual({ version: '9.1.0', status: 'available' })
})

it('projects actual contents and permission changes while rejecting stale reviewed activation', async () => {
  const { host, owner } = await fixture()
  const id = 'review-scope'
  const bundle = createPluginPackageTemplate('skill', id)
  const first = await create(owner, bundle)
  const route = `plugin-packages/${id}`
  const activate = (revision: string, baseAppliedRevision: string | null) =>
    owner.request(`${route}/apply`, { body: { revision, baseAppliedRevision, requestId: randomUUID() } })
  expect((await activate(first.revision, null)).status).toBe(200)
  const secondBundle = structuredClone(bundle)
  secondBundle.manifest.version = '1.1.0'
  secondBundle.files[0]!.content += 'Edited guidance.'
  const second = (
    await owner.json<{ package: PluginPackageDetail }>(route, {
      method: 'PUT',
      body: { bundle: secondBundle, baseRevision: first.revision, requestId: randomUUID() },
    })
  ).package
  expect(second.review).toMatchObject({
    baseAppliedRevision: first.revision,
    comparison: {
      revision: first.revision,
      version: first.version,
      manifestChanged: true,
      changedExecution: false,
      changedFiles: [{ path: 'SKILL.md', change: 'modified' }],
    },
  })
  expect((await activate(second.revision, null)).status).toBe(409)
  expect((await activate(second.revision, first.revision)).status).toBe(200)
  const { review } = await owner.json<{ review: PluginPackageReview }>(`${route}/review?operation=rollback&revision=${first.revision}`)
  expect(review).toMatchObject({
    revision: first.revision,
    baseAppliedRevision: second.revision,
    comparison: { revision: second.revision },
  })
  expect(
    (
      await owner.request(`${route}/rollback`, {
        body: { revision: first.revision, baseAppliedRevision: review.baseAppliedRevision, requestId: randomUUID() },
      })
    ).status,
  ).toBe(200)
  expect((await owner.request(`${route}/enabled`, { body: { enabled: false, requestId: randomUUID() } })).status).toBe(200)
  expect(
    (
      await owner.request(`${route}/enabled`, {
        body: { enabled: true, baseAppliedRevision: second.revision, requestId: randomUUID() },
      })
    ).status,
  ).toBe(409)
  expect(host.host.registry.list().find(item => item.id === id)?.enabled ?? false).toBe(false)
  expect(
    (
      await owner.request(`${route}/enabled`, {
        body: { enabled: true, baseAppliedRevision: first.revision, requestId: randomUUID() },
      })
    ).status,
  ).toBe(200)
  expect(host.host.registry.list().find(item => item.id === id)?.enabled).toBe(true)
})

it('rejects a review from a removed installation even when its replacement has identical revisions', async () => {
  const { host, owner } = await fixture()
  const id = 'reviewed-installation'
  const route = `plugin-packages/${id}`
  const firstBundle = createPluginPackageTemplate('skill', id)
  const secondBundle = structuredClone(firstBundle)
  secondBundle.manifest.version = '2.0.0'
  const reviewFor = async (operation: 'apply' | 'rollback' | 'enable', revision: string) =>
    (await owner.json<{ review: PluginPackageReview }>(`${route}/review?operation=${operation}&revision=${revision}`)).review
  const reviewed = ({ installId, baseAppliedRevision }: PluginPackageReview) => ({ reviewedInstallId: installId, baseAppliedRevision })
  const write = (action: string, body: Record<string, unknown>) =>
    owner.request(`${route}/${action}`, { body: { requestId: randomUUID(), ...body } })
  const updateAndDisable = async (first: PluginPackageDetail) => {
    const second = (
      await owner.json<{ package: PluginPackageDetail }>(route, {
        method: 'PUT',
        body: { bundle: secondBundle, baseRevision: first.revision, requestId: randomUUID() },
      })
    ).package
    expect((await apply(owner, second)).status).toBe(200)
    expect((await write('enabled', { enabled: false })).status).toBe(200)
    return second
  }

  const first = await create(owner, firstBundle)
  const oldApply = await reviewFor('apply', first.revision)
  expect(oldApply).toMatchObject({ baseAppliedRevision: null, installId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u) })
  const appliedRequest = { requestId: randomUUID(), revision: first.revision, ...reviewed(oldApply) }
  expect((await owner.request(`${route}/apply`, { body: appliedRequest })).status).toBe(200)
  expect((await owner.request(`${route}/apply`, { body: appliedRequest })).status).toBe(200)
  const second = await updateAndDisable(first)
  const oldRollback = await reviewFor('rollback', first.revision)
  const oldEnable = await reviewFor('enable', second.revision)
  expect(oldRollback.installId).toBe(oldApply.installId)
  expect(oldEnable.installId).toBe(oldApply.installId)
  expect((await owner.request(route, { method: 'DELETE', body: { requestId: randomUUID(), baseRevision: second.revision } })).status).toBe(
    200,
  )

  const recreated = await create(owner, firstBundle)
  const freshApply = await reviewFor('apply', recreated.revision)
  expect(freshApply).toMatchObject({ revision: oldApply.revision, baseAppliedRevision: oldApply.baseAppliedRevision })
  expect(freshApply.installId).not.toBe(oldApply.installId)
  expect((await write('apply', { revision: first.revision, ...reviewed(oldApply) })).status).toBe(409)
  expect((await owner.request(`${route}/apply`, { body: appliedRequest })).status).toBe(410)
  expect(host.host.registry.list().find(item => item.id === id)?.enabled ?? false).toBe(false)
  expect((await write('apply', { revision: first.revision, ...reviewed(freshApply) })).status).toBe(200)

  const latest = await updateAndDisable(recreated)
  const freshRollback = await reviewFor('rollback', recreated.revision)
  const freshEnable = await reviewFor('enable', latest.revision)
  expect(freshRollback).toMatchObject({ revision: oldRollback.revision, baseAppliedRevision: oldRollback.baseAppliedRevision })
  expect(freshEnable).toMatchObject({ revision: oldEnable.revision, baseAppliedRevision: oldEnable.baseAppliedRevision })
  expect((await write('rollback', { revision: first.revision, ...reviewed(oldRollback) })).status).toBe(409)
  expect((await write('enabled', { enabled: true, ...reviewed(oldEnable) })).status).toBe(409)
  const unchanged = (await owner.json<{ package: PluginPackageDetail }>(route)).package
  expect(unchanged).toMatchObject({ appliedRevision: second.revision, enabled: false })
  expect((await write('enabled', { enabled: true, ...reviewed(freshEnable) })).status).toBe(200)
  expect((await write('rollback', { revision: first.revision, ...reviewed(freshRollback) })).status).toBe(200)
})

it('binds a completed Mac confirmation to the reviewed installation', async () => {
  const { host, owner } = await fixture()
  const bundle = createPluginPackageTemplate('tool', 'review-confirmed-installation')
  const first = await create(owner, bundle)
  const route = `plugin-packages/${first.id}`
  const request = {
    revision: first.revision,
    reviewedInstallId: first.review.installId,
    baseAppliedRevision: null,
    requestId: randomUUID(),
  }
  const stepup = await owner.request(`${route}/apply`, { body: request })
  expect(stepup.status).toBe(403)
  const { confirmation } = (await stepup.json()) as { confirmation: ConfirmationTicket }
  await expect
    .poll(async () => (await owner.json<{ confirmation: ConfirmationTicket }>(`confirmations/${confirmation.id}`)).confirmation.status)
    .toBe('approved')
  expect((await owner.request(route, { method: 'DELETE', body: { requestId: randomUUID(), baseRevision: first.revision } })).status).toBe(
    200,
  )
  const replacement = await create(owner, bundle)

  const changed = await owner.request(`${route}/apply`, {
    body: { ...request, reviewedInstallId: replacement.review.installId },
    confirmation: confirmation.id,
  })
  expect(changed.status).toBe(409)
  expect(await changed.json()).toMatchObject({ error: 'confirmation-mismatch' })
  expect(host.host.registry.list().some(item => item.id === first.id)).toBe(false)
})

describe('local custom plugin application', () => {
  it('sends the selected installed skill and tool to a Standard Agent and returns the approved tool result to the model', async () => {
    const bundle = createPluginPackageTemplate('tool', 'handoff-check')
    const toolName = 'handoff_check_uppercase'
    const skillText = 'Use the uppercase tool on the handoff reference.'
    bundle.manifest.skills = [{ id: 'handoff', name: '交接清单', description: '', file: 'SKILL.md' }]
    bundle.files.push({ path: 'SKILL.md', content: skillText })

    const requests: Array<{ tools: string[]; messages: ModelMessage[] }> = []
    const provider: ModelProvider = {
      id: 'handoff-provider',
      name: 'Local fixture',
      model: 'local',
      async *stream({ tools, messages }) {
        const names = tools.map(tool => tool.name)
        requests.push({ tools: names, messages: structuredClone(messages) })
        const last = messages.at(-1)
        if (last?.role === 'user' && names.includes(toolName)) {
          yield { type: 'tool-call', call: { id: 'handoff-call', name: toolName, arguments: { text: last.content } } }
          yield { type: 'finish', reason: 'tool-calls' }
        } else {
          yield { type: 'text', text: last?.role === 'tool' ? last.content : 'No tool result' }
          yield { type: 'finish', reason: 'stop' }
        }
      },
    }
    const { host, owner } = await fixture({
      demo: false,
      plugins: [{ id: provider.id, name: provider.name, version: '1', description: '', activate: ctx => ctx.registerProvider(provider) }],
    })
    const installed = await granted(owner, host, await create(owner, bundle))
    const packageId = installed.package.id
    const agent = await owner.json<CustomAgent>('custom-agents', {
      body: {
        requestId: randomUUID(),
        name: '交接核对',
        harnessId: 'standard',
        mode: 'agent',
        model: { providerId: provider.id, model: provider.model },
        skills: [`${packageId}:handoff`],
        tools: [packageId],
      },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), customAgentId: agent.id, prompt: 'handoff-42' },
    })
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).summary.status).toBe('waiting-approval')
    expect(requests).toHaveLength(1)
    expect(requests.at(0)?.tools).toContain(toolName)
    expect(requests.at(0)?.messages).toContainEqual({ role: 'system', content: expect.stringContaining(skillText) })
    const approval = (await detail()).approvals.at(0)
    expect(approval).toMatchObject({ risk: 'R2', toolName, toolCallId: 'handoff-call' })
    await owner.json(`approvals/${approval?.id}`, { body: { decision: 'allow' } })
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    expect(requests).toHaveLength(2)
    expect(requests.at(1)?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'handoff-call', content: 'HANDOFF-42' })
    expect((await detail()).messages.at(-1)).toMatchObject({ role: 'assistant', text: 'HANDOFF-42' })
  })
  it('binds imported executable dependencies to a fresh approval and refuses disguising a module as a skill', async () => {
    const { host, owner } = await fixture(),
      bundle = createPluginPackageTemplate('tool', 'dependency-tool')
    const dependency = bundle.files[0]!.content
    bundle.files = [
      { path: 'host.mjs', content: "import plugin from './helper.mjs'; export default plugin" },
      { path: 'helper.mjs', content: dependency },
    ]
    const draft = await create(owner, bundle)
    await granted(owner, host, draft)
    bundle.manifest.skills = [{ id: 'disguised', name: 'Disguised module', description: '', file: 'helper.mjs' }]
    expect(
      (
        await owner.request(`plugin-packages/${draft.id}`, {
          method: 'PUT',
          body: { requestId: randomUUID(), baseRevision: draft.revision, bundle },
        })
      ).status,
    ).toBe(400)
    bundle.manifest.skills = []
    bundle.files[1]!.content = dependency.replace('toUpperCase()', 'toLowerCase()')
    const changed = (
      await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: draft.revision, bundle },
      })
    ).package
    expect(changed.executionHash).not.toBe(draft.executionHash)
    expect(changed.trusted).toBe(false)
    await granted(owner, host, changed)
    const lease = host.host.registry.acquire('demo')
    try {
      expect(
        await lease.tools
          .find(tool => tool.name === 'dependency_tool_uppercase')!
          .execute(
            { text: 'HELLO' },
            { sessionId: 's', callId: 'c', workspaceRoot: host.workspaceRoot, signal: new AbortController().signal },
          ),
      ).toEqual({ text: 'hello' })
    } finally {
      lease.release()
    }
    expect(host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply')).toHaveLength(2)
  })
  it('rolls back failed activation, retains the applied module and keeps private diagnostics out of the HTTP response', async () => {
    const { host, owner } = await fixture(),
      bundle = createPluginPackageTemplate('tool', 'rollback-tool')
    const draft = await create(owner, bundle)
    await granted(owner, host, draft)
    bundle.files[0]!.content = "export default {activate(){throw new Error('private fixture diagnostic')}}"
    const saved = (
      await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: draft.revision, bundle },
      })
    ).package
    const failed = await owner.confirmed(`plugin-packages/${draft.id}/apply`, {
      body: { requestId: randomUUID(), revision: saved.revision },
    })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: 'plugin-package-activation-failed', message: expect.stringContaining('旧版和草稿已保留') })
    const retained = (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package
    expect(retained).toMatchObject({ state: 'update-available', enabled: true, revision: saved.revision, appliedRevision: draft.revision })
    const lease = host.host.registry.acquire('demo')
    try {
      expect(lease.tools.some(tool => tool.name === 'rollback_tool_uppercase')).toBe(true)
    } finally {
      lease.release()
    }
    expect(await readdir(join(host.dataDir, 'plugin-packages/generations'))).toHaveLength(1)
  })
  it('refuses publication after a device loses its complete data scope during the awaited audit write', async () => {
    const { host, owner } = await fixture(),
      draft = await create(owner, createPluginPackageTemplate('skill', 'revoked-guide'))
    const append = host.host.security.audit.append.bind(host.host.security.audit),
      spy = vi.spyOn(host.host.security.audit, 'append')
    spy.mockImplementation(async input => {
      const result = await append(input)
      if (input.action === 'plugin.package.changed' && 'operation' in input.detail && input.detail.operation === 'apply')
        await host.host.security.devices.changeScopes(owner.id, { dataScope: 'work' }, { deviceId: owner.id, listener: 'unix' }, 'none')
      return result
    })
    try {
      expect((await apply(owner, draft)).status).toBe(403)
      expect(host.host.registry.skills().some(skill => skill.pluginId === draft.id)).toBe(false)
      const disk = JSON.parse(await readFile(join(host.dataDir, 'plugin-packages/assets.json'), 'utf8')) as {
        packages: Array<{ enabled: boolean; appliedRevision?: string }>
      }
      expect(disk.packages[0]).toMatchObject({ enabled: false })
      expect(disk.packages[0]!.appliedRevision).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
  it('reports a declared Harness that cannot start as unavailable instead of claiming all capabilities are working', async () => {
    const { host, owner } = await fixture(),
      bundle = createPluginPackageTemplate('tool', 'invalid-driver')
    bundle.files[0]!.content =
      "export default {activate(ctx){ctx.registerHarness({id:'invalid-driver',name:'Invalid fixture',version:'1',create(){throw new Error('Fixture cannot start')}})}}"
    const draft = await create(owner, bundle),
      result = await granted(owner, host, draft)
    expect(result.package).toMatchObject({ state: 'applied', enabled: true, unavailableReason: expect.stringContaining('未能启动') })
    expect((await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package.unavailableReason).toBe(
      result.package.unavailableReason,
    )
  })
  it('keeps an old run generation until release while audit failure does not prevent disabling or removal', async () => {
    const { host, owner } = await fixture(),
      draft = await create(owner, createPluginPackageTemplate('skill', 'leased-guide'))
    expect((await apply(owner, draft)).status).toBe(200)
    const sourceRoot = join(host.dataDir, 'plugin-packages/generations'),
      lease = host.host.registry.acquire('demo')
    try {
      expect(await readdir(sourceRoot)).toHaveLength(1)
      const audit = vi.spyOn(host.host.security.audit, 'append')
      audit.mockRejectedValueOnce(new Error('audit write failed'))
      const disabled = await owner.request(`plugin-packages/${draft.id}/enabled`, { body: { requestId: randomUUID(), enabled: false } })
      expect(disabled.status).toBe(200)
      expect(disabled.headers.get('x-latch-audit')).toBe('failed')
      const next = host.host.registry.acquire('demo')
      try {
        expect((next.skills ?? []).some(skill => skill.id === 'leased-guide:guide')).toBe(false)
      } finally {
        next.release()
      }
      expect((lease.skills ?? []).some(skill => skill.id === 'leased-guide:guide')).toBe(true)
      expect(await readdir(sourceRoot)).toHaveLength(1)
      audit.mockRejectedValueOnce(new Error('audit write failed'))
      const removed = await owner.request(`plugin-packages/${draft.id}`, {
        method: 'DELETE',
        body: { requestId: randomUUID(), baseRevision: draft.revision },
      })
      expect(removed.status).toBe(200)
      expect(removed.headers.get('x-latch-audit')).toBe('failed')
      expect(await readdir(sourceRoot)).toHaveLength(1)
    } finally {
      lease.release()
      vi.restoreAllMocks()
    }
    await vi.waitFor(async () => expect(await readdir(sourceRoot)).toHaveLength(0))
  })

  it('keeps the new private asset directory protected even for a legacy workspace equal to the Host data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-package-private-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const { host } = await fixture({ dataDir: root, workspaceRoot: root }),
      lease = host.host.registry.acquire('demo')
    try {
      const read = lease.tools.find(tool => tool.name === 'read_file')!
      const context = { sessionId: 's', callId: 'c', workspaceRoot: root, signal: new AbortController().signal }
      for (const path of ['plugin-packages/assets.json', 'PLUGIN-PACKAGES/assets.json'])
        await expect(read.execute({ path }, context)).rejects.toThrow('私有数据目录')
    } finally {
      lease.release()
    }
  })
  it('mounts a custom Harness and preserves its running session when replacement or deletion cannot safely unload it', async () => {
    const { host, owner } = await fixture(),
      bundle = createPluginPackageTemplate('tool', 'harness-owner')
    bundle.files[0]!.content = `import {randomUUID} from 'node:crypto';
export default {activate(ctx) {ctx.registerHarness({id:'custom-harness',name:'Custom Harness',version:'1',capabilities:{modes:['chat'],models:'agent'},create(){
  const tasks=new Map();let changed=()=>{};
  return {async start(){},async close(){},subscribe(listener){changed=listener;return()=>{changed=()=>{}}},async listTasks(){return [...tasks.values()].map(task=>task.summary)},approvals(){return[]},
    async createTask(input){const id='custom-'+randomUUID();tasks.set(id,{summary:{id,title:input.prompt,status:'running',updatedAt:new Date().toISOString(),mode:'chat',cwd:input.cwd},messages:[{id:randomUUID(),role:'user',text:input.prompt,requestId:input.requestId}],approvals:[],liveText:'',cursor:0});changed(id);return{sessionId:id}},
    async detail(id){return structuredClone(tasks.get(id))},async cancel(id){const task=tasks.get(id);task.summary.status='idle';changed(id)},async decide(){return false},async prompt(){throw new Error('Not needed by fixture')}
  }
}})}}\n`
    const draft = await create(owner, bundle)
    await granted(owner, host, draft)
    const started = await owner.confirmed('tasks', {
      body: { requestId: randomUUID(), prompt: 'Custom fixture session', harnessId: 'custom-harness', mode: 'chat' },
    })
    expect(started.status, await started.clone().text()).toBe(201)
    const { sessionId } = (await started.json()) as { sessionId: string }
    const blocked = await owner.request(`plugin-packages/${draft.id}`, {
      method: 'DELETE',
      body: { requestId: randomUUID(), baseRevision: draft.revision },
    })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ error: 'plugin-in-use', message: expect.stringContaining('先停止') })
    expect((await host.host.bridge.detail(sessionId)).summary.status).toBe('running')
    const edited = structuredClone(bundle)
    edited.manifest.description = 'Changed description while running'
    const saved = (
      await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: draft.revision, bundle: edited },
      })
    ).package
    expect((await apply(owner, saved)).status).toBe(409)
    expect((await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package.appliedRevision).toBe(draft.revision)
    expect((await owner.request(`plugin-packages/${draft.id}/enabled`, { body: { requestId: randomUUID(), enabled: false } })).status).toBe(
      409,
    )
    await host.host.bridge.cancel(sessionId)
    expect(
      (
        await owner.request(`plugin-packages/${draft.id}`, {
          method: 'DELETE',
          body: { requestId: randomUUID(), baseRevision: saved.revision },
        })
      ).status,
    ).toBe(200)
    expect(host.host.registry.harnesses().some(driver => driver.id === 'custom-harness')).toBe(false)
  })
  it('creates, exports, edits, applies and disables a real skill/static panel without a system confirmation', async () => {
    const { host, owner } = await fixture(),
      bundle = createPluginPackageTemplate('skill', 'my-guide')
    const draft = await create(owner, bundle)
    expect(draft).toMatchObject({ state: 'draft', enabled: false, trusted: true, capabilities: [] })
    expect(host.host.registry.skills().some(skill => skill.pluginId === draft.id)).toBe(false)
    const applied = await apply(owner, draft)
    expect(applied.status).toBe(200)
    expect(host.host.registry.revisionSnapshot([draft.id])).toEqual({ persistent: true, revisions: { [draft.id]: draft.revision } })
    expect(host.host.registry.skills()).toMatchObject([expect.objectContaining({ id: 'my-guide:guide' })])
    expect((await owner.json<{ plugins: PluginInfo[] }>('plugins')).plugins.find(plugin => plugin.id === draft.id)?.editable).toBe(true)
    const exported = await owner.json<{ bundle: PluginPackageBundle }>(`plugin-packages/${draft.id}/export`)
    expect(exported.bundle.manifest.id).toBe(draft.id)
    const edited = structuredClone(exported.bundle)
    edited.files[0]!.content = 'Updated private workflow instructions'
    const saved = (
      await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: draft.revision, bundle: edited },
      })
    ).package
    expect(saved.state).toBe('update-available')
    expect((await apply(owner, saved)).status).toBe(200)
    expect(host.host.registry.revisionSnapshot([draft.id])).toEqual({ persistent: true, revisions: { [draft.id]: saved.revision } })
    expect(host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply')).toHaveLength(0)
    const disabled = await owner.request(`plugin-packages/${draft.id}/enabled`, { body: { requestId: randomUUID(), enabled: false } })
    expect(disabled.status).toBe(200)
    expect(host.host.registry.skills()).not.toContainEqual(expect.objectContaining({ id: 'my-guide:guide' }))
    expect((await owner.request(`plugin-packages/${draft.id}/enabled`, { body: { requestId: randomUUID(), enabled: true } })).status).toBe(
      200,
    )
    expect((await owner.request(`plugins/${draft.id}`, { body: { enabled: false } })).status).toBe(409)
    expect(
      (
        await owner.request(`plugin-packages/${draft.id}`, {
          method: 'DELETE',
          body: { requestId: randomUUID(), baseRevision: saved.revision },
        })
      ).status,
    ).toBe(200)
    expect((await owner.request(`plugin-packages/${draft.id}`)).status).toBe(404)
  })
  it('does not import a Host module before confirmation and replays the exact application without a second activation', async () => {
    const { host, owner } = await fixture(),
      marker = join(host.root, 'activation.log')
    const bundle = createPluginPackageTemplate('tool', 'local-upper')
    bundle.files[0]!.content =
      `import {appendFile} from 'node:fs/promises';await appendFile(${JSON.stringify(marker)},'imported\\n');`
      + bundle.files[0]!.content.replace(
        'activate(ctx) {',
        `async activate(ctx) { await appendFile(${JSON.stringify(marker)},'activated\\n');`,
      )
    bundle.manifest.skills = [{ id: 'guide', name: 'guide', description: '', file: 'SKILL.md' }]
    bundle.files.push({ path: 'SKILL.md', content: 'old guide' })
    const draft = await create(owner, bundle)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await granted(owner, host, draft)
    expect(result.package).toMatchObject({ state: 'applied', enabled: true, trusted: true })
    const lines = () => readFile(marker, 'utf8')
    expect(await lines()).toBe('imported\nactivated\n')
    await owner.json(`plugin-packages/${draft.id}/apply`, { body: result.input, confirmation: result.confirmation.id })
    expect(await lines()).toBe('imported\nactivated\n')
    const tool = host.host.registry.acquire('demo')
    try {
      expect(
        await tool.tools
          .find(tool => tool.name === 'local_upper_uppercase')!
          .execute(
            { text: 'hello' },
            { sessionId: 's', callId: 'c', workspaceRoot: host.workspaceRoot, signal: new AbortController().signal },
          ),
      ).toEqual({ text: 'HELLO' })
    } finally {
      tool.release()
    }
    bundle.files[1]!.content = 'new guide'
    const saved = (
      await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: draft.revision, bundle },
      })
    ).package
    expect(saved.executionHash).toBe(draft.executionHash)
    expect((await apply(owner, saved)).status).toBe(200)
    expect(host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply')).toHaveLength(1)
    bundle.files[0]!.content += '\n// changed executable'
    const changed = (
      await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: saved.revision, bundle },
      })
    ).package
    expect(changed.trusted).toBe(false)
    await granted(owner, host, changed)
    expect(host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply')).toHaveLength(2)
  })
  it('names the Context projection in the confirmation when a trusted client panel opts in', async () => {
    const { host, owner } = await fixture()
    const bundle = createPluginPackageTemplate('react-ui', 'context-review')
    const draft = await create(owner, bundle)
    await granted(owner, host, draft)
    const confirmLines = () =>
      host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply').at(-1)?.preview.lines
    const contextLine = { label: '读取会话上下文统计的面板', value: '1' }
    expect(confirmLines()).not.toContainEqual(contextLine)
    bundle.manifest.panels![0]!.context = true
    const changed = (
      await owner.json<{ package: PluginPackageDetail }>('plugin-packages/' + draft.id, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: draft.revision, bundle },
      })
    ).package
    expect(changed).toMatchObject({ trusted: false, appliedRevision: draft.revision })
    expect(host.host.registry.uiPanels().find(panel => panel.pluginId === draft.id)).not.toHaveProperty('context')
    await granted(owner, host, changed)
    expect(confirmLines()).toContainEqual(contextLine)
    expect(host.host.registry.uiPanels().find(panel => panel.pluginId === draft.id)).toHaveProperty('context', true)
  })
  it('restores the applied generation and exact trust across Host restarts without applying an unapproved draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-package-restart-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspaceRoot = join(root, 'workspace'),
      dataDir = join(root, 'data')
    await mkdir(workspaceRoot)
    const { host, owner } = await fixture({ workspaceRoot, dataDir }),
      bundle = createPluginPackageTemplate('react-ui', 'notes')
    const draft = await create(owner, bundle)
    await granted(owner, host, draft)
    bundle.files[0]!.content += '\n// unapproved draft'
    await owner.json(`plugin-packages/${draft.id}`, {
      method: 'PUT',
      body: { requestId: randomUUID(), baseRevision: draft.revision, bundle },
    })
    await host.close()
    const restarted = await fixture({ workspaceRoot, dataDir })
    const record = (await restarted.owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package
    expect(record).toMatchObject({ state: 'update-available', enabled: true, trusted: false, appliedRevision: draft.revision })
    expect(restarted.host.host.registry.revisionSnapshot([draft.id])).toEqual({
      persistent: true,
      revisions: { [draft.id]: draft.revision },
    })
    expect(restarted.host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply')).toHaveLength(0)
    const panel = restarted.host.host.registry.uiPanels().find(panel => panel.pluginId === draft.id)!
    const lease = restarted.host.host.registry.acquireClientPanel(panel.id, panel.moduleHash!)
    try {
      expect(lease.source).not.toContain('unapproved draft')
    } finally {
      lease.release()
    }
    const prior = await restarted.owner.request(`plugin-packages/${draft.id}/enabled`, {
      body: { requestId: randomUUID(), enabled: false },
    })
    expect(prior.status).toBe(200)
    expect(
      (await restarted.owner.request(`plugin-packages/${draft.id}/enabled`, { body: { requestId: randomUUID(), enabled: true } })).status,
    ).toBe(200)
    expect(restarted.host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply')).toHaveLength(0)
  })
  it('refuses remote and reduced-scope callers, reserved IDs and escaping asset files', async () => {
    const { host, owner } = await fixture(),
      browser = await host.enroll({ scopes: ['view', 'run', 'admin'] }),
      bundle = createPluginPackageTemplate('skill')
    await owner.confirmed(`devices/${browser.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    for (const path of ['plugin-packages', 'plugin-packages/my-plugin', 'plugin-packages/my-plugin/export'])
      expect((await browser.request(path)).status).toBe(403)
    expect((await browser.request('plugin-packages', { body: { requestId: randomUUID(), bundle } })).status).toBe(403)
    expect(
      (
        await owner.request('plugin-packages', {
          body: { requestId: randomUUID(), bundle: { ...bundle, manifest: { ...bundle.manifest, id: 'standard-harness' } } },
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await owner.request('plugin-packages', {
          body: { requestId: randomUUID(), bundle: { ...bundle, files: [...bundle.files, { path: '../escape', content: 'never write' }] } },
        })
      ).status,
    ).toBe(400)
    expect((await owner.request(`devices/${owner.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    expect((await owner.request('plugin-packages')).status).toBe(403)
    expect((await owner.request('plugin-packages', { body: { requestId: randomUUID(), bundle } })).status).toBe(403)
  })
})
