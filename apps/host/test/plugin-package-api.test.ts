import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPluginPackageTemplate,
  type PluginInfo,
  type PluginPackageDetail,
  type ConfirmationTicket,
  type PluginPackageBundle,
} from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'
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
  const denied = await owner.request(route, { body: input, headers: { 'x-latch-shell-confirmation': '1' } })
  expect(denied.status).toBe(403)
  const confirmation = ((await denied.json()) as { confirmation: ConfirmationTicket }).confirmation
  expect(confirmation).toMatchObject({
    action: 'plugin.package.apply',
    form: 'plugin.package.apply',
    reason: expect.stringMatching(/^应用插件「.+」$/u),
  })
  expect(confirmation.confirmationMethod).toBeUndefined()
  await expect
    .poll(async () => (await owner.json<{ confirmation: ConfirmationTicket }>(`confirmations/${confirmation.id}`)).confirmation.status)
    .toBe('approved')
  expect(host.presence.requests.filter(request => request.preview.action === 'plugin.package.apply').at(-1)?.requireBiometric).toBe(true)
  const applied = await owner.json<{ package: PluginPackageDetail }>(route, { body: input, confirmation: confirmation.id })
  return { ...applied, input, confirmation }
}
describe('local custom plugin application', () => {
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
