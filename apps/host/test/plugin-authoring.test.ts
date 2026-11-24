import { randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PLUGIN_CREATION_GUIDE, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { readSessionDraft, sessionDraftKinds } from '../src/app-import.ts'
import { buildPages } from '../src/app-build.ts'
import { checkedPluginBundle } from '../src/plugin-package-bundle.ts'
import { SessionMetaStore } from '../src/session-meta.ts'
import { SessionFolders } from '../src/session-folders.ts'
import { canonicalPath } from '../src/paths.ts'
import { startTestHost } from './helpers/host.ts'

it('gives an explicit creation session a readable skill before its first model call, working examples and a durable Host identity', async () => {
  let bodySeen = ''
  const plugin: HarnessPlugin = {
    id: 'author-fixture',
    name: 'fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'author-fixture',
        name: 'fixture',
        model: 'local',
        async *stream({ messages }) {
          const guided = messages.some(message => message.role === 'system' && message.content === PLUGIN_CREATION_GUIDE)
          if (guided && !messages.some(message => message.role === 'tool')) {
            yield {
              type: 'tool-call',
              call: { id: 'read-author-guide', name: 'read_file', arguments: { path: 'latch-authoring/SKILL.md' } },
            }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            bodySeen = messages.findLast(message => message.role === 'tool')?.content ?? ''
            yield { type: 'text', text: 'ok' }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const host = await startTestHost({ sessionFolders: true, demo: false, plugins: [plugin] })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const body = {
      prompt: '做一个核对清单',
      requestId: randomUUID(),
      mode: 'agent',
      pluginCreation: true,
      model: { providerId: 'author-fixture', model: 'local' },
    }
    const initial = await owner.json<AppSnapshot>('snapshot')
    expect(initial.catalog?.features?.pluginCreation).toBe(true)
    expect(initial.catalog?.harnesses.find(item => item.id === 'standard')?.pluginCreation).toBe(true)
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { body })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages[0]?.text).toBe(body.prompt)
    expect(detail.summary).toMatchObject({ pluginCreation: true, sessionFolder: true })
    const proof = (await SessionMetaStore.open(host.dataDir)).get(sessionId)?.pluginCreation
    expect(proof).toMatch(/^[a-f0-9]{64}$/u)
    const folder = detail.summary.cwd!
    const reopened = new SessionFolders({
      dataDir: host.dataDir,
      root: host.workspaceRoot,
      canonicalRoot: await canonicalPath(host.workspaceRoot),
      clock: Date.now,
      now: Date.now,
      log() {},
    })
    expect(await reopened.authoringFolder(proof!)).toBe(await realpath(folder))
    expect(bodySeen).toContain('name: latch-plugin-authoring')
    expect(bodySeen).toContain('latch-plugin/latch-plugin.json')
    expect(bodySeen).toContain('latch-app/latch-app.json')
    expect(bodySeen).toContain('plugin-examples.json')
    expect(bodySeen).toContain('我的 Agent')
    expect(await sessionDraftKinds(folder, true)).toEqual([])
    const guides = join(folder, 'latch-authoring')
    const listings = JSON.parse(await readFile(join(guides, 'plugin-examples.json'), 'utf8')) as Array<{
      id: string
      zh: { name: string; use: string }
    }>
    expect(listings.map(item => item.id)).toContain('shift-handoff')
    expect(listings.every(item => item.zh.name && item.zh.use && !('installed' in item) && !('files' in item))).toBe(true)
    for (const kind of ['skill', 'tool']) {
      const files = await readdir(join(guides, 'examples', kind))
      const manifest = JSON.parse(await readFile(join(guides, 'examples', kind, 'latch-plugin.json'), 'utf8'))
      const contents = await Promise.all(
        files
          .filter(file => file !== 'latch-plugin.json')
          .map(async path => ({ path, content: await readFile(join(guides, 'examples', kind, path), 'utf8') })),
      )
      const sample = checkedPluginBundle({ manifest, files: contents })
      expect(Boolean(sample.executionHash)).toBe(kind === 'tool')
      expect(sample.bundle.manifest.skills).toHaveLength(1)
    }
    await cp(join(guides, 'examples/page'), join(folder, 'latch-app'), { recursive: true })
    const page = await readSessionDraft(folder, 'app')
    expect((await buildPages(page.bundle)).status).toBe('ok')
    await writeFile(join(folder, 'latch-app', 'index.tsx'), '// edited by the user')
    expect(await owner.json('tasks', { body })).toEqual({ sessionId })
    expect(await readFile(join(folder, 'latch-app', 'index.tsx'), 'utf8')).toBe('// edited by the user')
    const { pluginCreation: _creation, ...ordinary } = body
    expect((await owner.request('tasks', { body: ordinary })).status).toBe(409)
    const normal = await owner.json<{ sessionId: string }>('tasks', { body: { ...ordinary, requestId: randomUUID() } })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${normal.sessionId}`)).summary.status).toBe('idle')
    const plain = await owner.json<TaskDetail>(`tasks/${normal.sessionId}`)
    expect(plain.summary.pluginCreation).toBeUndefined()
    expect(await readdir(plain.summary.cwd!)).not.toContain('latch-authoring')
  } finally {
    await host.close()
  }
})

it('retries the same import after the draft file was removed without importing a newer version or changing its origin', async () => {
  const host = await startTestHost({ sessionFolders: true })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      body: { prompt: '做一个技能', mode: 'agent', pluginCreation: true, requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const folder = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd!
    await cp(join(folder, 'latch-authoring/examples/skill'), join(folder, 'latch-plugin'), { recursive: true })
    const body = { sessionId, kind: 'plugin', requestId: randomUUID() }
    const imported = await owner.json<{ package: { id: string; revision: string } }>('plugin-packages/import', { body })
    await rename(join(folder, 'latch-plugin'), join(folder, 'revised-sources'))
    const retry = await owner.json('plugin-packages/import', { body })
    expect(retry).toMatchObject({
      importedRevision: imported.package.revision,
      package: { id: imported.package.id, revision: imported.package.revision },
    })
    for (const changed of [{ kind: 'app' }, { sessionId: 'other-session' }]) {
      const response = await owner.request('plugin-packages/import', { body: { ...body, ...changed } })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'request-conflict' })
    }
  } finally {
    await host.close()
  }
})

it('binds both kinds of creator draft to the original private directory, including when another directory takes its name', async () => {
  const host = await startTestHost({ sessionFolders: true })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      body: { prompt: '做一个技能', requestId: randomUUID(), mode: 'agent', pluginCreation: true },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const folder = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd!
    const discover = () => owner.json<{ present: boolean }>(`plugin-packages/session-draft?sessionId=${sessionId}`)
    await cp(join(folder, 'latch-authoring/examples/skill'), join(folder, 'latch-plugin'), { recursive: true })
    expect(await discover()).toMatchObject({ present: true, kinds: ['plugin'] })
    await chmod(folder, 0o755)
    expect(await discover()).toMatchObject({ present: false })
    await chmod(folder, 0o700)
    const original = folder + '-original'
    await rename(folder, original)
    await mkdir(folder, { mode: 0o700 })
    await cp(join(original, 'latch-authoring/examples/skill'), join(folder, 'latch-plugin'), { recursive: true })
    await cp(join(original, 'latch-authoring/examples/page'), join(folder, 'latch-app'), { recursive: true })
    expect(await discover()).toMatchObject({ present: false })
    for (const kind of ['app', 'plugin']) {
      const refusal = await owner.request('plugin-packages/import', { body: { sessionId, kind, requestId: randomUUID() } })
      expect(refusal.status).toBe(409)
      expect(await refusal.json()).toMatchObject({ error: 'app-draft-missing' })
    }
    expect(await owner.json('plugin-packages')).toMatchObject({ packages: [] })
  } finally {
    await host.close()
  }
})

it('rejects a remote device, insufficient data scope, or a project start before preparing authoring files', async () => {
  const host = await startTestHost({ sessionFolders: true })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const remote = await host.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run', 'admin'] })
    const input = { prompt: 'a new skill', requestId: randomUUID(), mode: 'agent', pluginCreation: true }
    expect((await remote.request('tasks', { body: input })).status).toBe(403)
    expect((await owner.request('tasks', { body: { ...input, workspaceId: 'a-project' } })).status).toBe(409)
    expect((await owner.request('tasks', { body: { ...input, appDraft: true } })).status).toBe(409)
    await host.host.security.devices.setScopes(owner.id, { dataScope: 'files' }, { listener: 'unix' }, 'lpc-local')
    expect((await owner.request('tasks', { body: input })).status).toBe(403)
    expect((await readdir(host.workspaceRoot)).every(name => !/^\d{8}-[a-f0-9]{4}$/u.test(name))).toBe(true)
  } finally {
    await host.close()
  }
})
