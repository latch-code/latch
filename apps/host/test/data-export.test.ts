import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { DataExportState, TaskDetail, TaskSummary } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { DataExports, type ExportSources } from '../src/data-export.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const roots: string[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const temp = async (name: string) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), name)))
  roots.push(root)
  return root
}

/** Answers every turn with the person's own words, so what they pasted is in the transcript twice. */
const echo: HarnessPlugin = {
  id: 'echo-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'echo-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream({ messages }) {
        const last = messages.at(-1)
        yield { type: 'text', text: `echo ${last?.role === 'user' ? JSON.stringify(last.content) : ''}` }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

/** Every file under `dir`, by its path relative to it. */
async function filesOf(dir: string, prefix = ''): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) for (const [name, text] of await filesOf(path, `${prefix}${entry.name}/`)) found.set(name, text)
    else found.set(`${prefix}${entry.name}`, await readFile(path, 'utf8'))
  }
  return found
}

/** String values of at least 12 characters anywhere in a JSON file: what a secret store holds. */
async function longStrings(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  if (!text) return []
  const out: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === 'string' && value.length >= 12) out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  try {
    walk(JSON.parse(text))
  } catch {
    for (const line of text.split('\n')) if (line.trim()) walk(JSON.parse(line))
  }
  return out
}

const MODEL_KEY = 'sk-planted-model-key-0123456789abcdef'
const MCP_SECRET = 'planted-mcp-secret-value-0123456789'
const HARNESS_ENV = 'planted-harness-env-value-0123456789'
const GATEWAY_TOKEN = `lmg1.${'A'.repeat(43)}`

describe('导出全部', () => {
  test('writes only allow-listed kinds: every planted secret stays out, and the manifest says what was written', async () => {
    const host = await startTestHost({ plugins: [echo] })
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    // A secret in every store an export must never read.
    const provider = await owner.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'Planted',
        kind: 'openai-responses',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: MODEL_KEY,
        models: ['m'],
        defaultModel: 'm',
        confirmOrigin: true,
      },
    })
    expect(provider.ok).toBe(true)
    await owner.confirmedJson('mcp/servers', {
      body: {
        requestId: randomUUID(),
        baseRevision: 0,
        name: 'planted',
        command: process.execPath,
        args: [],
        env: {},
        secrets: { TOKEN: MCP_SECRET },
        projectCwd: false,
        scope: { all: true, agents: [], projects: [] },
      },
    })
    const harness = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'planted-harness', name: 'Planted', command: process.execPath, args: [], env: { API_KEY: HARNESS_ENV } },
    })
    expect(harness.ok).toBe(true)
    // The person's own data: a session that pasted a key and a gateway credential, a memory, a 待办.
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        prompt: `记下这个对话 key=${MODEL_KEY} token=${GATEWAY_TOKEN}`,
        requestId: randomUUID(),
        model: { providerId: 'echo-provider', model: 'fixture' },
      },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 20_000 }).toBe('idle')
    await owner.json('custom-agents/general/memories', { method: 'POST', body: { requestId: randomUUID(), content: '喜欢简短的回答' } })
    await owner.json('work/items', { method: 'POST', body: { requestId: randomUUID(), title: '整理导出', prompt: '把数据导出来' } })

    const parent = await temp('latch-export-')
    const started = await owner.exportData({ parent })
    expect(started.status).toBe(202)
    const { export: first } = (await started.json()) as { export: DataExportState }
    let state = first
    await expect
      .poll(
        async () => {
          state = (await owner.json<{ export: DataExportState }>(`data/export/${first.id}`)).export
          return state.state
        },
        { timeout: 20_000 },
      )
      .toBe('done')
    const folder = join(parent, state.name)
    expect(await readdir(parent)).toEqual([state.name])
    const files = await filesOf(folder)
    const names = [...files.keys()].sort()
    expect(names).toContain(`sessions/${sessionId}.json`)
    expect(names).toContain(`sessions/${sessionId}.md`)
    expect(names).toContain('memory/general.json')
    expect(names).toContain('work.json')
    expect(names).toContain('settings.json')
    expect(names).toContain('manifest.json')
    // Only these places, nothing else.
    expect(
      names.every(name => /^(?:sessions\/[^/]+\.(?:json|md)|memory\/[^/]+\.json|work\.json|settings\.json|manifest\.json)$/u.test(name)),
    ).toBe(true)
    const all = [...files.values()].join('\n')
    expect(all).toContain('记下这个对话')
    expect(all).toContain('喜欢简短的回答')
    expect(all).toContain('整理导出')
    // Planted secrets and every long value of every secret store stay out.
    for (const secret of [MODEL_KEY, MCP_SECRET, HARNESS_ENV, GATEWAY_TOKEN]) expect(all).not.toContain(secret)
    const stores = [
      'providers.json',
      'mcp/secrets.json',
      'mcp/servers.json',
      'auth/devices.json',
      'auth/offline-enrollments.json',
      'settings.json',
    ]
    for (const store of stores) for (const value of await longStrings(join(host.dataDir, store))) expect(all).not.toContain(value)
    // No audit hash goes out.
    for (const line of (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8')).trim().split('\n'))
      expect(all).not.toContain((JSON.parse(line) as { hash: string }).hash)
    // The manifest lists what was written, with each file's hash.
    const manifest = JSON.parse(files.get('manifest.json')!) as { files: Array<{ path: string; bytes: number }>; excluded: unknown[] }
    expect(manifest.files.map(file => file.path).sort()).toEqual(names.filter(name => name !== 'manifest.json'))
    expect(manifest.excluded.length).toBeGreaterThan(0)
    for (const name of names) expect((await stat(join(folder, name))).mode & 0o077).toBe(0)
    // Audited before and after, with hashes and kinds only.
    const audit = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { seq: number; action: string; detail: Record<string, unknown> })
    const begun = audit.find(record => record.action === 'data.exported')!
    const ended = audit.find(record => record.action === 'data.export.result')!
    expect(begun.seq).toBeLessThan(ended.seq)
    expect(ended.detail).toMatchObject({ outcome: 'done', skipped: 0 })
    expect(JSON.stringify(begun)).not.toContain(parent)
  }, 120_000)

  test('only the desktop app, signed after its picker; a page, another body or a narrower device cannot start one', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const parent = await temp('latch-export-refused-')
    // Unsigned, as the renderer's own request would be.
    const refused = { error: 'folder-grant-invalid' }
    expect(
      await (await owner.request('data/export', { method: 'POST', body: { nonce: 'x', via: 'export', parent } })).json(),
    ).toMatchObject(refused)
    // Signed over another folder than the one sent.
    expect(await (await owner.exportData({ parent, signedBody: body => ({ ...body, parent: tmpdir() }) })).json()).toMatchObject(refused)
    const browser = await host.enroll({ listener: 'loopback-tcp' })
    expect((await browser.request('folder-grants', { method: 'POST', body: {} })).status).toBe(403)
    expect(await readdir(parent)).toEqual([])
  })

  test('never writes into a folder or link that is already there, and a folder that is a link resolves to its target', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const parent = await temp('latch-export-taken-')
    const elsewhere = await temp('latch-export-elsewhere-')
    // This minute's and the next minute's names are taken: one by a folder with a file in it, one by a link elsewhere.
    for (const offset of [0, 60_000]) {
      const stamp = new Date(Date.now() + offset).toISOString().slice(0, 16).replace('T', ' ').replace(':', '')
      await mkdir(join(parent, `Latch 导出 ${stamp}`))
      await writeFile(join(parent, `Latch 导出 ${stamp}`, 'mine.txt'), 'keep')
      await symlink(elsewhere, join(parent, `Latch 导出 ${stamp} 2`))
    }
    const started = await owner.exportData({ parent })
    expect(started.status).toBe(202)
    const { export: state } = (await started.json()) as { export: DataExportState }
    expect(state.name).toMatch(/ 3$/u)
    await expect.poll(async () => (await owner.json<{ export: DataExportState }>(`data/export/${state.id}`)).export.state).toBe('done')
    expect(await readdir(elsewhere)).toEqual([])
    for (const name of await readdir(parent))
      if (!name.endsWith(' 2') && !name.endsWith(' 3')) expect(await readdir(join(parent, name))).toEqual(['mine.txt'])
  })
})

describe('DataExports', () => {
  const sources = (wait?: Promise<void>): ExportSources => ({
    sessions: async () => [
      { id: 'task-1', title: 't', harnessId: 'standard', status: 'idle', updatedAt: '2026-11-17T00:00:00.000Z' } as TaskSummary,
    ],
    detail: async () => {
      await wait
      return {
        summary: {} as TaskSummary,
        messages: [{ id: 'm', role: 'user', text: 'hello' }],
        approvals: [],
        liveText: '',
        cursor: 0,
      } as TaskDetail
    },
    harnessName: () => 'Latch 内置',
    owners: () => [],
    workItems: () => [],
    settings: () => ({ appearance: { schema: 1 }, templates: [], projects: [] }),
  })

  test('writes a tool row as its name and state only, and no reasoning: an unshaped secret in either never goes out', async () => {
    const parent = await temp('latch-export-tools-')
    const planted: ExportSources = {
      ...sources(),
      detail: async () =>
        ({
          summary: {} as TaskSummary,
          messages: [
            { id: 'u', role: 'user', text: 'show me the env' },
            { id: 'a', role: 'assistant', text: 'here it is', reasoning: 'the password is hunter2-unshaped-reasoning' },
            { id: 't', role: 'tool', toolName: 'run', state: 'completed', text: 'DB_PASSWORD=hunter2-unshaped-tool-output' },
          ],
          approvals: [],
          liveText: '',
          cursor: 0,
        }) as TaskDetail,
    }
    const exports = new DataExports({ sources: planted, log: () => {} })
    const state = await exports.start({
      deviceId: 'dev_a',
      parent,
      hooks: { audit: async () => {}, result: async () => {}, recheck: () => {} },
    })
    await expect.poll(() => exports.get('dev_a', state.id).state).toBe('done')
    const written = [...(await filesOf(join(parent, state.name))).values()].join('\n')
    expect(written).toContain('show me the env')
    expect(written).toContain('"tool": "run"')
    expect(written).not.toContain('hunter2')
  })

  test('audits before it makes anything: an audit that fails leaves the chosen folder untouched', async () => {
    const parent = await temp('latch-export-audit-')
    const exports = new DataExports({ sources: sources(), log: () => {} })
    await expect(
      exports.start({
        deviceId: 'dev_a',
        parent,
        hooks: {
          audit: async () => {
            throw new Error('audit-unavailable')
          },
          result: async () => {},
          recheck: () => {},
        },
      }),
    ).rejects.toThrow('audit-unavailable')
    expect(await readdir(parent)).toEqual([])
  })

  test('a cancel stops between files and removes the folder it made, and only that; a revoked device stops it too', async () => {
    const parent = await temp('latch-export-cancel-')
    let release!: () => void
    const exports = new DataExports({ sources: sources(new Promise<void>(resolve => (release = resolve))), log: () => {} })
    const results: unknown[] = []
    const hooks = { audit: async () => {}, result: async (detail: unknown) => void results.push(detail), recheck: () => {} }
    const state = await exports.start({ deviceId: 'dev_a', parent, hooks })
    expect(await readdir(parent)).toEqual([state.name])
    const cancelled = exports.cancel('dev_a', state.id)
    release()
    expect((await cancelled).state).toBe('cancelled')
    expect(await readdir(parent)).toEqual([])
    expect(results).toEqual([expect.objectContaining({ outcome: 'cancelled', removed: true })])
    // Another device cannot read or cancel it.
    expect(() => exports.get('dev_b', state.id)).toThrow()

    let revoked = false
    const second = await exports.start({
      deviceId: 'dev_a',
      parent,
      hooks: {
        ...hooks,
        recheck: () => {
          if (revoked) throw new Error('device-revoked')
        },
      },
    })
    revoked = true
    await expect.poll(() => exports.get('dev_a', second.id).state).toBe('failed')
    expect(await readdir(parent)).toEqual([])
  })
})
