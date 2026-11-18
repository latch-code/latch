// Deleting an Agent and its home (docs/CUSTOM-AGENTS.md#删除-agent): removed for good, or written into a zip first;
// only the home the Host recorded and that matches its record now; everything else left and reported.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { AgentFolderExport, AgentFolderResult, AgentFolderView, LeftoverAgentFolder, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { AppError } from '@latch/sdk'
import { latchCodeRoot } from '../src/paths.ts'
import { buildHomeHelper } from '../scripts/build-home.ts'
import { archiveLabel } from '../src/agent-folders.ts'
import type { LaunchTerminal } from '../src/terminal/helper.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const run = promisify(execFile)
const roots: string[] = []
const hosts: TestHost[] = []
let compiled: string
let binary: string

const plugin: HarnessPlugin = {
  id: 'agent-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'agent-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: 'Answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
const model = { providerId: 'agent-provider', model: 'fixture' }

async function tempRoot(prefix = 'latch-agent-folders-') {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

/** A terminal that starts and ends at once: enough for the Host to decide whether to open one. */
const launch: LaunchTerminal = (_spec, onEvent) => {
  onEvent({ type: 'started', pid: 1 })
  return {
    pendingInput: 0,
    input() {},
    resize() {},
    signal() {},
    pauseOutput() {},
    resumeOutput() {},
    close() {
      onEvent({ type: 'exit', signal: 1 })
      onEvent({ type: 'gone' })
      return Promise.resolve()
    },
  }
}

async function boot(root: string, workspace = 'workspace') {
  const host = await startTestHost({
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, workspace),
    plugins: [plugin],
    homeHelper: binary,
    terminal: { launch, shell: { file: '/bin/sh', argv: ['sh'] } },
  })
  hosts.push(host)
  return host
}

async function stop(host: TestHost) {
  hosts.splice(hosts.indexOf(host), 1)
  await host.close()
}

type Device = Pick<Awaited<ReturnType<TestHost['enroll']>>, 'request' | 'json'>

/** The same device on a Host started again over the same data. */
function rebind(host: TestHost, credential: string): Device {
  const request: Device['request'] = (path, init = {}) =>
    host.raw('unix', `api/${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Latch-Device ${credential}` },
      ...(init.body !== undefined ? { body: init.body as object } : {}),
    })
  return {
    request,
    async json<T>(path: string, init?: Parameters<Device['request']>[1]) {
      const response = await request(path, init)
      const body = (await response.json()) as T
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, body })
      return body
    },
  } as Device
}

async function settled(owner: Device, id: string) {
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
}

/** One of my Agents after a first message: its home made, a few files in it, and a link to a file outside it. */
async function agentWithHome(root = '') {
  const base = root || (await tempRoot())
  const host = await boot(base)
  const owner = await host.enroll({ listener: 'unix' })
  const agent = await owner.json<{ id: string }>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '整理/文件',
      description: '',
      harnessId: 'standard',
      mode: 'agent',
      model,
      instructions: '',
      skills: [],
    },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'Hello', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  const home = join(base, 'workspace', 'helpers', agent.id)
  await mkdir(join(home, 'notes'))
  await writeFile(join(home, 'notes', 'a.txt'), 'alpha')
  await writeFile(join(home, 'b.md'), 'bravo!')
  const outside = join(base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await symlink(outside, join(home, 'link'))
  return { root: base, host, owner, agent, sessionId, home, outside }
}

async function auditRows(host: TestHost) {
  return (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; target?: string; detail?: Record<string, unknown> })
}

/** What the dialog shows before deleting: each home it may remove, by key, with its counts. */
const view = async (owner: Device, id: string): Promise<AgentFolderView> => {
  const response = await owner.request(`custom-agents/${id}/folders`)
  return response.ok ? ((await response.json()) as AgentFolderView) : { contents: 'none', homes: [] }
}

/** Deletes as the dialog does: `delete` sends back what it was shown (`seen`, read now unless given). */
const remove = async (owner: Device, id: string, folder?: 'delete', requestId = randomUUID(), seen?: AgentFolderView['homes']) =>
  owner.request(`custom-agents/${id}`, {
    method: 'DELETE',
    body: { requestId, ...(folder ? { folder, seen: seen ?? (await view(owner, id)).homes } : {}) },
  })

async function exported(owner: Device, requestId: string): Promise<AgentFolderExport> {
  let state: AgentFolderExport | undefined
  await expect
    .poll(
      async () => {
        state = (await owner.json<{ export: AgentFolderExport }>(`custom-agents/folder-exports/${requestId}`)).export
        return state.state
      },
      { timeout: 15_000 },
    )
    .not.toBe('running')
  return state!
}

const gone = (path: string) =>
  lstat(path).then(
    () => false,
    () => true,
  )

describe.skipIf(process.platform !== 'darwin')('an Agent’s home when the Agent is deleted', () => {
  beforeAll(async () => {
    // Built from source into a scratch code root; its self-test (a directory swapped for a link mid-removal) runs here.
    compiled = await mkdtemp(join(tmpdir(), 'latch-home-build-'))
    await mkdir(join(compiled, 'native/macos'), { recursive: true })
    await copyFile(join(latchCodeRoot(), 'native/macos/LatchHome.swift'), join(compiled, 'native/macos/LatchHome.swift'))
    binary = (await buildHomeHelper(compiled))!
  }, 180_000)
  afterAll(async () => {
    if (compiled) await rm(compiled, { recursive: true, force: true })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const host of hosts.splice(0).reverse()) await host.close()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  test('永久删除 removes the home for good, never what a link in it points at, audited before and after', async () => {
    const { host, owner, agent, home, outside, sessionId } = await agentWithHome()
    expect(await view(owner, agent.id)).toEqual({
      contents: 'files',
      homes: [{ key: expect.stringMatching(/^[0-9a-f]{32}$/u), entries: 4, bytes: 11 }],
    })
    const response = await remove(owner, agent.id, 'delete')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: agent.id, folder: { outcome: 'deleted', removed: 1, left: 0 } })
    expect(await gone(home)).toBe(true)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    const rows = (await auditRows(host)).filter(row => row.action.startsWith('agent.folder.'))
    expect(rows.map(row => row.action)).toEqual(['agent.folder.removing', 'agent.folder.removed'])
    expect(rows[1]!.detail).toMatchObject({ customAgentId: agent.id, outcome: 'deleted', entries: 4 })
    // No path or name in the record.
    expect(JSON.stringify(rows)).not.toContain(home)
    expect(JSON.stringify(rows)).not.toContain('a.txt')
    // Its conversations stay to read; a message to them is refused and never makes the home again.
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.id).toBe(sessionId)
    const again = await owner.request(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'still there?', requestId: randomUUID() },
    })
    expect(again.status).toBe(409)
    expect(await gone(home)).toBe(true)
    const records = JSON.parse(await readFile(join(host.dataDir, 'session-folders.json'), 'utf8')) as { homes?: Record<string, object> }
    expect(JSON.stringify(records.homes ?? {})).not.toContain(agent.id)
  })

  test('a retry of the same deletion gets the same answer; a page that does not ask keeps the folder', async () => {
    const { owner, agent, home } = await agentWithHome()
    const requestId = randomUUID()
    const first = (await (await remove(owner, agent.id, undefined, requestId)).json()) as { folder: AgentFolderResult }
    expect(first.folder).toEqual({ outcome: 'kept', reason: 'unconfirmed', removed: 0, left: 1 })
    const retry = (await (await remove(owner, agent.id, undefined, requestId)).json()) as { folder: AgentFolderResult }
    expect(retry.folder).toEqual(first.folder)
    expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
  })

  test('deleting an Agent already gone never reaches the homes its older deletion kept', async () => {
    const { host, owner, agent, home } = await agentWithHome()
    await remove(owner, agent.id)
    const runner = await host.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'all' })
    const again = (await (await remove(runner, agent.id, 'delete')).json()) as { folder?: AgentFolderResult }
    expect(again.folder?.outcome).toBe('kept')
    expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
  })

  test('a foreign entry beside the home, or one at its plain name, is never touched', async () => {
    const { owner, agent, home, root } = await agentWithHome()
    const sibling = join(root, 'workspace', 'helpers', `${agent.id}-0badc0de`)
    await mkdir(sibling, { mode: 0o700 })
    await writeFile(join(sibling, 'theirs.txt'), 'theirs')
    expect(((await (await remove(owner, agent.id, 'delete')).json()) as { folder: AgentFolderResult }).folder.outcome).toBe('deleted')
    expect(await gone(home)).toBe(true)
    expect(await readFile(join(sibling, 'theirs.txt'), 'utf8')).toBe('theirs')
  })

  test('an export whose record cannot be written starts nothing; a cancelled one deletes nothing', async () => {
    const { host, owner, agent, home, root } = await agentWithHome()
    const parent = join(root, 'picked')
    await mkdir(parent)
    const append = host.host.security.audit.append.bind(host.host.security.audit)
    const spy = vi
      .spyOn(host.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action === 'agent.folder.exporting' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    const refused = await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId: randomUUID(),
      parent,
    })
    expect(refused.status).toBe(503)
    expect(await readdir(parent)).toEqual([])
    spy.mockRestore()
    // Large enough (sparse) that the export is still writing when it is cancelled.
    await truncate(join(home, 'b.md'), 1536 * 1024 * 1024)
    const requestId = randomUUID()
    await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId,
      parent,
    })
    const cancelled = (
      await owner.json<{ export: AgentFolderExport }>(`custom-agents/folder-exports/${requestId}/cancel`, { method: 'POST', body: {} })
    ).export
    expect(cancelled).toMatchObject({ state: 'cancelled', archives: [] })
    expect(await readdir(parent)).toEqual([])
    expect((await readdir(home)).sort()).toEqual(['b.md', 'link', 'notes'])
    expect((await owner.request(`custom-agents/${agent.id}`)).status).toBe(200)
  })

  test('a replaced home, a wider mode or a link at its path is left as it is and reported', async () => {
    for (const change of ['replaced', 'mode', 'link'] as const) {
      const { owner, agent, home, root } = await agentWithHome()
      if (change === 'replaced') {
        await rename(home, join(root, 'original'))
        await mkdir(home, { mode: 0o700 })
        await writeFile(join(home, 'other.txt'), 'other')
      } else if (change === 'mode') await chmod(home, 0o755)
      else {
        await rename(home, join(root, 'original'))
        await symlink(join(root, 'original'), home)
      }
      const body = (await (await remove(owner, agent.id, 'delete')).json()) as { folder: AgentFolderResult }
      expect(body.folder, change).toEqual({ outcome: 'left', reason: 'unverified', removed: 0, left: 1 })
      if (change === 'replaced') expect(await readFile(join(home, 'other.txt'), 'utf8')).toBe('other')
      if (change !== 'mode') expect(await readFile(join(root, 'original', 'b.md'), 'utf8')).toBe('bravo!')
      else expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
    }
  })

  test('a home a terminal is open in is left, and the export is refused before anything is written', async () => {
    const { owner, agent, home, sessionId, root } = await agentWithHome()
    expect((await owner.request(`tasks/${sessionId}/terminals`, { method: 'POST', body: { cols: 80, rows: 24 } })).status).toBe(201)
    const parent = join(root, 'picked')
    await mkdir(parent)
    const refused = await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId: randomUUID(),
      parent,
    })
    expect(refused.status).toBe(409)
    expect(await readdir(parent)).toEqual([])
    const body = (await (await remove(owner, agent.id, 'delete')).json()) as { folder: AgentFolderResult }
    expect(body.folder).toEqual({ outcome: 'left', reason: 'in-use', removed: 0, left: 1 })
    expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
  })

  test('a home with nothing at its path is reported absent and no longer recorded', async () => {
    const { owner, agent, home } = await agentWithHome()
    await rm(home, { recursive: true })
    const body = (await (await remove(owner, agent.id, 'delete')).json()) as { folder: AgentFolderResult }
    expect(body.folder).toEqual({ outcome: 'none', removed: 0, left: 0 })
    expect(await gone(home)).toBe(true)
  })

  test('when the record of removing cannot be written the Agent is still deleted and its home stays', async () => {
    const { host, owner, agent, home } = await agentWithHome()
    const append = host.host.security.audit.append.bind(host.host.security.audit)
    vi.spyOn(host.host.security.audit, 'append').mockImplementation(event =>
      event.action === 'agent.folder.removing' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
    const body = (await (await remove(owner, agent.id, 'delete')).json()) as { folder: AgentFolderResult }
    expect(body.folder).toEqual({ outcome: 'left', reason: 'audit-failed', removed: 0, left: 1 })
    expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
    expect((await owner.request(`custom-agents/${agent.id}`)).status).toBe(404)
  })

  test('homes under another start directory are found through the Host’s own session records and removed', async () => {
    const first = await agentWithHome()
    await stop(first.host)
    const moved = await boot(first.root, 'other-workspace')
    const owner = rebind(moved, first.owner.credential)
    const sent = await owner.json<{ sessionId: string }>(`tasks/${first.sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'moved', requestId: randomUUID() },
    })
    await settled(owner, sent.sessionId)
    const second = join(first.root, 'other-workspace', 'helpers', first.agent.id)
    await writeFile(join(second, 'here.txt'), 'here')
    const body = (await (await remove(owner, first.agent.id, 'delete')).json()) as { folder: AgentFolderResult }
    expect(body.folder).toEqual({ outcome: 'deleted', removed: 2, left: 0 })
    expect(await gone(first.home)).toBe(true)
    expect(await gone(second)).toBe(true)
    expect(await readFile(join(first.outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  test('导出后删除: the zip holds exactly the home’s files, and the Agent and home go only after it is verified', async () => {
    const { owner, agent, home, outside, root } = await agentWithHome()
    const parent = join(root, 'picked')
    await mkdir(parent)
    const requestId = randomUUID()
    const started = await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId,
      parent,
    })
    expect(started.status).toBe(202)
    const state = await exported(owner, requestId)
    expect(state).toMatchObject({ state: 'done', phase: 'delete', folder: { outcome: 'deleted', removed: 1, left: 0 } })
    expect(state.archives).toHaveLength(1)
    const archive = join(parent, state.archives![0]!)
    expect(state.archives![0]).toMatch(/^整理 文件 .+\.zip$/u)
    expect((await lstat(archive)).mode & 0o777).toBe(0o600)
    const unpacked = join(root, 'unpacked')
    await run('/usr/bin/ditto', ['-x', '-k', archive, unpacked], { env: {} })
    expect(await readdir(unpacked)).toEqual(['整理 文件'])
    expect((await readdir(join(unpacked, '整理 文件'))).sort()).toEqual(['b.md', 'notes'])
    expect(await readFile(join(unpacked, '整理 文件', 'notes', 'a.txt'), 'utf8')).toBe('alpha')
    expect(await readFile(join(unpacked, '整理 文件', 'b.md'), 'utf8')).toBe('bravo!')
    await run('/usr/bin/unzip', ['-tq', archive], { env: {} })
    expect(await gone(home)).toBe(true)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect((await owner.request(`custom-agents/${agent.id}`)).status).toBe(404)
  })

  test('an export that fails, is too large or cannot be written deletes nothing', async () => {
    const { owner, agent, home, root } = await agentWithHome()
    // Too large: a sparse file past the limit is refused before anything is written.
    await truncate(join(home, 'b.md'), 3 * 1024 * 1024 * 1024)
    const parent = join(root, 'picked')
    await mkdir(parent)
    const requestId = randomUUID()
    expect(
      (
        await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
          via: 'agent-folder',
          agentId: agent.id,
          requestId,
          parent,
        })
      ).status,
    ).toBe(202)
    const state = await exported(owner, requestId)
    expect(state).toMatchObject({ state: 'failed', code: 'agent-folder-too-large', archives: [] })
    expect(state.bytes).toBeGreaterThan(3 * 1024 * 1024 * 1024)
    expect(await readdir(parent)).toEqual([])
    expect((await readdir(home)).sort()).toEqual(['b.md', 'link', 'notes'])
    expect((await owner.request(`custom-agents/${agent.id}`)).status).toBe(200)
    // A folder it cannot write into.
    await truncate(join(home, 'b.md'), 6)
    await chmod(parent, 0o500)
    const second = randomUUID()
    await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId: second,
      parent,
    })
    expect(await exported(owner, second)).toMatchObject({ state: 'failed', code: 'export-folder-invalid' })
    await chmod(parent, 0o700)
    expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
    expect((await owner.request(`custom-agents/${agent.id}`)).status).toBe(200)
  })

  test('export is the desktop’s only: a browser device can delete for good, never export', async () => {
    const { host, owner, agent, home, root } = await agentWithHome()
    const browser = await host.enroll({ listener: 'loopback-tcp', dataScope: 'all' })
    const parent = join(root, 'picked')
    await mkdir(parent)
    const unsigned = await browser.request(`custom-agents/${agent.id}/folder-export`, {
      method: 'POST',
      body: { nonce: 'x', via: 'agent-folder', agentId: agent.id, requestId: randomUUID(), parent },
    })
    expect(unsigned.status).toBeGreaterThanOrEqual(400)
    expect(await readdir(parent)).toEqual([])
    const body = (await (await remove(browser, agent.id, 'delete')).json()) as { folder: AgentFolderResult }
    expect(body.folder.outcome).toBe('deleted')
    expect(await gone(home)).toBe(true)
    void owner
  })

  test('every route of a deleted Agent’s session fails soft once its home is gone, and none makes it again', async () => {
    const { host, owner, agent, home, sessionId } = await agentWithHome()
    await remove(owner, agent.id, 'delete')
    expect(await gone(home)).toBe(true)
    const calls: Array<[string, string, object?]> = [
      ['GET', `tasks/${sessionId}`],
      ['GET', `tasks/${sessionId}/files/list?dir=`],
      ['POST', `tasks/${sessionId}/files/resolve`, { paths: ['b.md'] }],
      ['POST', `tasks/${sessionId}/files/search`, { query: 'b' }],
      ['POST', `tasks/${sessionId}/files/grep`, { query: 'bravo' }],
      ['GET', `tasks/${sessionId}/changes`],
      ['POST', `tasks/${sessionId}/terminals`, { cols: 80, rows: 24 }],
      ['POST', 'attachments/capabilities', { selection: { harnessId: 'standard' }, sessionId }],
      ['POST', `custom-agents/${agent.id}/warm`, {}],
      ['GET', `custom-agents/${agent.id}/home`],
      ['POST', `tasks/${sessionId}/prompt`, { prompt: 'again', requestId: randomUUID() }],
    ]
    for (const [method, path, body] of calls) {
      const response = await owner.request(path, { method, ...(body ? { body } : {}) })
      expect(response.status, `${method} ${path}`).toBeLessThan(500)
    }
    expect(await gone(home)).toBe(true)
    expect((await auditRows(host)).filter(row => row.action === 'agent.home.assigned' && row.target === agent.id)).toHaveLength(1)
  })

  test('a plain delete removes only what the dialog showed: a file added after it opened keeps the folder', async () => {
    const { owner, agent, home } = await agentWithHome()
    for (const name of ['notes', 'b.md', 'link']) await rm(join(home, name), { recursive: true })
    const shown = await view(owner, agent.id)
    expect(shown.contents).toBe('empty')
    await writeFile(join(home, 'arrived.txt'), 'late')
    const body = (await (await remove(owner, agent.id, 'delete', randomUUID(), shown.homes)).json()) as { folder: AgentFolderResult }
    expect(body.folder).toEqual({ outcome: 'left', reason: 'changed', removed: 0, left: 1 })
    expect(await readFile(join(home, 'arrived.txt'), 'utf8')).toBe('late')
    expect((await owner.request(`custom-agents/${agent.id}`)).status).toBe(404)
    // Asking to delete without saying what was shown is refused before anything happens.
    const second = await agentWithHome()
    const bare = await second.owner.request(`custom-agents/${second.agent.id}`, {
      method: 'DELETE',
      body: { requestId: randomUUID(), folder: 'delete' },
    })
    expect(bare.status).toBe(400)
    expect((await second.owner.request(`custom-agents/${second.agent.id}`)).status).toBe(200)
  })

  test('导出后删除 never deletes what it did not export: an empty home that gains a file, an unreadable one', async () => {
    // Empty when exported, a file arrives before the deletion: the home is left, the file with it.
    const empty = await agentWithHome()
    for (const name of ['notes', 'b.md', 'link']) await rm(join(empty.home, name), { recursive: true })
    const parent = join(empty.root, 'picked')
    await mkdir(parent)
    const append = empty.host.host.security.audit.append.bind(empty.host.host.security.audit)
    vi.spyOn(empty.host.host.security.audit, 'append').mockImplementation(async event => {
      // Between the verified export and the removal: as the Agent itself is deleted.
      if (event.action === 'agent.changed' && (event.detail as { operation?: string }).operation === 'delete')
        await writeFile(join(empty.home, 'arrived.txt'), 'late')
      return append(event)
    })
    let requestId = randomUUID()
    await empty.owner.signedFolderRequest(`custom-agents/${empty.agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: empty.agent.id,
      requestId,
      parent,
    })
    expect(await exported(empty.owner, requestId)).toMatchObject({ state: 'done', folder: { outcome: 'left', reason: 'changed' } })
    expect(await readFile(join(empty.home, 'arrived.txt'), 'utf8')).toBe('late')
    vi.restoreAllMocks()

    // A home it cannot read is a failed export: nothing is deleted.
    const closed = await agentWithHome()
    const picked = join(closed.root, 'picked')
    await mkdir(picked)
    await chmod(closed.home, 0o300)
    requestId = randomUUID()
    await closed.owner.signedFolderRequest(`custom-agents/${closed.agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: closed.agent.id,
      requestId,
      parent: picked,
    })
    expect(await exported(closed.owner, requestId)).toMatchObject({ state: 'failed', code: 'agent-folder-unreadable', archives: [] })
    await chmod(closed.home, 0o700)
    expect(await readdir(picked)).toEqual([])
    expect(await readFile(join(closed.home, 'b.md'), 'utf8')).toBe('bravo!')
    expect((await closed.owner.request(`custom-agents/${closed.agent.id}`)).status).toBe(200)
  })

  test('导出后删除 leaves a home under another start directory that was not there when the export began', async () => {
    const first = await agentWithHome()
    await stop(first.host)
    const moved = await boot(first.root, 'other-workspace')
    const owner = rebind(moved, first.owner.credential)
    const sent = await owner.json<{ sessionId: string }>(`tasks/${first.sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'moved', requestId: randomUUID() },
    })
    await settled(owner, sent.sessionId)
    const second = join(first.root, 'other-workspace', 'helpers', first.agent.id)
    await writeFile(join(second, 'here.txt'), 'here')
    // The first start directory is away (an unmounted disk) when the export starts, and back before the deletion.
    const away = join(first.root, 'workspace-away')
    await rename(join(first.root, 'workspace'), away)
    const append = moved.host.security.audit.append.bind(moved.host.security.audit)
    vi.spyOn(moved.host.security.audit, 'append').mockImplementation(async event => {
      if (event.action === 'agent.changed' && (event.detail as { operation?: string }).operation === 'delete')
        await rename(away, join(first.root, 'workspace'))
      return append(event)
    })
    const parent = join(first.root, 'picked')
    await mkdir(parent)
    const requestId = randomUUID()
    // The desktop app on this Mac, as the second Host knows it.
    const desk = await moved.enroll({ listener: 'unix' })
    const started = await desk.signedFolderRequest(`custom-agents/${first.agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: first.agent.id,
      requestId,
      parent,
    })
    expect(started.status).toBe(202)
    const state = await exported(desk, requestId)
    expect(state).toMatchObject({ state: 'done', folder: { outcome: 'left', reason: 'unconfirmed', removed: 1, left: 1 } })
    expect(await gone(second)).toBe(true)
    expect(await readFile(join(first.home, 'b.md'), 'utf8')).toBe('bravo!')
  })

  test('a removal waits for an export of the same Agent, and a cancel after the last archive still cancels', async () => {
    const { host, owner, agent, home, root } = await agentWithHome()
    const parent = join(root, 'picked')
    await mkdir(parent)
    // Refused while the export runs.
    await truncate(join(home, 'b.md'), 1536 * 1024 * 1024)
    let requestId = randomUUID()
    await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId,
      parent,
    })
    const during = await remove(owner, agent.id, 'delete', randomUUID(), [])
    expect(during.status).toBe(409)
    expect(await during.json()).toMatchObject({ error: 'agent-folder-exporting' })
    await owner.json(`custom-agents/folder-exports/${requestId}/cancel`, { method: 'POST', body: {} })
    await truncate(join(home, 'b.md'), 6)
    // The cancel lands after the last archive was written and checked, before anything is deleted.
    const append = host.host.security.audit.append.bind(host.host.security.audit)
    const second = randomUUID()
    vi.spyOn(host.host.security.audit, 'append').mockImplementation(async event => {
      if (event.action === 'agent.folder.exported' && (event.detail as { outcome?: string }).outcome === 'done') {
        void owner.request(`custom-agents/folder-exports/${second}/cancel`, { method: 'POST', body: {} })
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      return append(event)
    })
    requestId = second
    await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId,
      parent,
    })
    expect(await exported(owner, requestId)).toMatchObject({ state: 'cancelled', archives: [] })
    expect(await readdir(parent)).toEqual([])
    expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
    expect((await owner.request(`custom-agents/${agent.id}`)).status).toBe(200)
  })

  test('the archive goes nowhere it exports or removes, keeps a backslash out of its names, and a long name still exports', async () => {
    const { host, owner, agent, home, root } = await agentWithHome()
    for (const parent of [home, join(root, 'workspace', 'helpers'), host.dataDir]) {
      const refused = await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
        via: 'agent-folder',
        agentId: agent.id,
        requestId: randomUUID(),
        parent,
      })
      expect(refused.status, parent).toBe(400)
    }
    expect(Buffer.byteLength(archiveLabel('整理'.repeat(40)))).toBeLessThanOrEqual(120)
    expect(Buffer.byteLength(archiveLabel('🗂️'.repeat(80)))).toBeLessThanOrEqual(120)
    const long = archiveLabel('长'.repeat(80))
    expect(long.length).toBeGreaterThan(30)
    await writeFile(join(home, 'a\\b.txt'), 'slash')
    const parent = join(root, 'picked')
    await mkdir(parent)
    const requestId = randomUUID()
    await owner.signedFolderRequest(`custom-agents/${agent.id}/folder-export`, {
      via: 'agent-folder',
      agentId: agent.id,
      requestId,
      parent,
    })
    const state = await exported(owner, requestId)
    expect(state).toMatchObject({ state: 'done' })
    // Only the named archive, under the Host's local time: the temporary file it was written under is gone.
    expect(await readdir(parent)).toEqual(state.archives)
    const now = new Date()
    expect(state.archives![0]).toContain(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
    const unpacked = join(root, 'unpacked')
    await run('/usr/bin/ditto', ['-x', '-k', join(parent, state.archives![0]!), unpacked], { env: {} })
    const [top] = await readdir(unpacked)
    expect((await readdir(join(unpacked, top!))).sort()).toEqual(['a∖b.txt', 'b.md', 'notes'])
  })

  test('设置 › 数据 lists the homes of Agents already deleted and removes one only when asked', async () => {
    const { owner, agent, home } = await agentWithHome()
    await remove(owner, agent.id)
    const { folders } = await owner.json<{ folders: LeftoverAgentFolder[] }>('data/agent-folders')
    expect(folders).toEqual([{ key: expect.stringMatching(/^[0-9a-f]{32}$/u), path: home, contents: 'files', entries: 4, bytes: 11 }])
    expect(await readFile(join(home, 'b.md'), 'utf8')).toBe('bravo!')
    // What the row showed must still hold: one more file and it stays.
    await writeFile(join(home, 'later.txt'), 'x')
    const changed = await owner.json<{ folder: AgentFolderResult }>(`data/agent-folders/${folders[0]!.key}`, {
      method: 'DELETE',
      body: { requestId: randomUUID(), entries: folders[0]!.entries, bytes: folders[0]!.bytes },
    })
    expect(changed.folder).toMatchObject({ outcome: 'left', reason: 'changed' })
    expect(await readFile(join(home, 'later.txt'), 'utf8')).toBe('x')
    await rm(join(home, 'later.txt'))
    const removed = await owner.json<{ folder: AgentFolderResult }>(`data/agent-folders/${folders[0]!.key}`, {
      method: 'DELETE',
      body: { requestId: randomUUID(), entries: folders[0]!.entries, bytes: folders[0]!.bytes },
    })
    expect(removed.folder.outcome).toBe('deleted')
    expect(await gone(home)).toBe(true)
    expect((await owner.json<{ folders: LeftoverAgentFolder[] }>('data/agent-folders')).folders).toEqual([])
  })
})
