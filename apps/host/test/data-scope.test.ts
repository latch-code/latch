import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, CustomAgentList, Device, Message, TaskDetail, TurnChanges } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { insideRootsSync } from '../src/paths.ts'
import { filesTaskContent } from '../src/task-content.ts'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const folders: string[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

const SLOW = { timeout: 15_000 }

async function host(dataDir?: string): Promise<TestHost> {
  const t = await startTestHost(dataDir ? { dataDir } : {})
  hosts.push(t)
  return t
}

async function status(response: Response): Promise<[number, string | undefined]> {
  const text = await response.text()
  return [response.status, text ? (JSON.parse(text) as { error?: string }).error : undefined]
}

/** One settled `shell-edit` turn in a Git work tree, started on this Mac. */
async function session(t: TestHost) {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: t.workspaceRoot, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
  const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
  })
  const turns = async () => (await owner.json<{ turns: TurnChanges[] }>(`tasks/${sessionId}/changes/turns`)).turns
  await expect.poll(async () => (await turns()).at(-1)?.state, SLOW).toBe('settled')
  return { owner, sessionId }
}

describe('the data scope of a newly connected browser', () => {
  it('is the project files by default, named so in the confirmation, and a browser may ask for less', async () => {
    const t = await host()
    const browser = await t.enroll({ scopes: ['view', 'run'] })
    expect(browser.device.dataScope).toBe('files')
    expect(t.presence.requests.at(-1)?.preview).toMatchObject({ action: 'device.enroll' })
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '数据范围', value: '会话与项目的文件' })
    const narrow = await t.enroll({ scopes: ['view'], dataScope: 'work' })
    expect(narrow.device.dataScope).toBe('work')
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '数据范围', value: '工作' })
    // This Mac's own app sees everything, as before.
    expect((await t.enroll({ listener: 'unix' })).device.dataScope).toBe('all')
  })

  it("reads the session's files and changes, and nothing outside the project folders", async () => {
    const t = await host()
    const { sessionId } = await session(t)
    const browser = await t.enroll({ scopes: ['view', 'run'] })
    const work = await t.enroll({ scopes: ['view', 'run'], dataScope: 'work' })
    const changes = `tasks/${sessionId}/changes?scope=turn`
    const listing = `tasks/${sessionId}/files/list`
    expect((await browser.request(changes)).status).toBe(200)
    expect((await browser.request(listing)).status).toBe(200)
    expect(await status(await work.request(changes))).toEqual([403, 'file-scope'])
    expect(await status(await work.request(listing))).toEqual([403, 'file-scope'])
    // A terminal is a shell of this account, other CLIs' sessions and 我的 Agent are private: none of them.
    // Terminals open only on this Mac; there too a window of this scope gets none.
    const window = await t.enroll({ listener: 'unix', scopes: ['view', 'run'], dataScope: 'files' })
    expect(await status(await window.request(`tasks/${sessionId}/terminals`, { body: { cols: 80, rows: 24 } }))).toEqual([
      403,
      'terminal-scope',
    ])
    expect(await status(await browser.request('history/sources'))).toEqual([403, 'history-scope'])
    expect(await status(await browser.request('custom-agents'))).toEqual([403, 'agent-scope-required'])
  })
})

describe('the data scope of a device already connected', () => {
  it('is kept as stored across a restart, and only this Mac widens it, with a confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-scope-'))
    folders.push(root)
    const dataDir = join(root, 'data')
    const t = await host(dataDir)
    const work = await t.enroll({ scopes: ['view', 'run', 'admin'], dataScope: 'work' })
    const other = await t.enroll({ scopes: ['view'] })
    await t.close()
    hosts.splice(hosts.indexOf(t), 1)
    const again = await host(dataDir)
    // Read back from the store the restarted Host loaded.
    expect(again.host.security.devices.get(work.id)?.dataScope).toBe('work')
    expect(again.host.security.devices.get(other.id)?.dataScope).toBe('files')
    const owner = await again.enroll({ listener: 'unix' })
    // Another device may not widen it, not even its own; this Mac does, with the confirmation naming the scope.
    const remote = await again.enroll({ scopes: ['view', 'run', 'admin'] })
    expect(await status(await remote.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'files' } }))).toEqual([
      403,
      'local-only',
    ])
    const asked = await owner.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'files' } })
    expect(await status(asked.clone())).toEqual([403, 'stepup-required'])
    const widened = await owner.confirmedJson<{ device: Device }>(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'files' } })
    expect(widened.device.dataScope).toBe('files')
    expect(again.presence.requests.at(-1)?.preview).toMatchObject({
      action: 'device.grant',
      subject: { slots: { change: '查看项目文件' } },
    })
    expect(again.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '数据范围', value: '会话与项目的文件' })
    // Narrowing needs nothing.
    const before = again.presence.requests.length
    const narrowed = await remote.json<{ device: Device }>(`devices/${other.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    expect(narrowed.device.dataScope).toBe('work')
    expect(again.presence.requests).toHaveLength(before)
  })
})

describe('what a `files` device reads of a tool that touched files', () => {
  const SENTINEL = 'FILE_BYTES_SENTINEL_5530'
  /** One finished read and one edit for `path`, as a session's history records them. */
  const detail = (path: string): TaskDetail =>
    ({
      summary: { id: 'task-x', status: 'idle' },
      approvals: [],
      messages: [
        {
          id: 'm1',
          role: 'tool',
          toolName: 'read_file',
          text: SENTINEL,
          createdAt: '2026-11-16T00:00:00.000Z',
          tool: { kind: 'read', title: path, locations: [path], output: SENTINEL, outputWithoutFiles: '已读取' },
        },
        {
          id: 'm2',
          role: 'tool',
          toolName: 'write_file',
          text: '已写入',
          createdAt: '2026-11-16T00:00:01.000Z',
          tool: {
            kind: 'edit',
            title: path,
            input: JSON.stringify({ path, content: SENTINEL }),
            diffs: [{ path, oldText: '', newText: SENTINEL }],
          },
        },
      ] as Message[],
    }) as unknown as TaskDetail

  async function layout() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-scope-paths-')))
    folders.push(root)
    const project = join(root, 'project')
    const other = join(root, 'other-project')
    const outside = join(root, 'outside')
    for (const directory of [project, other, outside]) await mkdir(directory)
    await writeFile(join(project, 'in.txt'), 'x')
    await writeFile(join(outside, 'secret.txt'), 'x')
    await writeFile(join(other, 'theirs.txt'), 'x')
    await symlink(join(outside, 'deep'), join(project, 'link'))
    await mkdir(join(outside, 'deep'))
    await writeFile(join(outside, 'deep', 'secret.txt'), 'x')
    const inside = (path: string) => insideRootsSync(path, [project])
    return { project, other, outside, inside }
  }

  it('reads the path from each key tools name it with', async () => {
    const { inside } = await layout()
    for (const key of ['notebook_path', 'target_file', 'absolute_path']) {
      const shown = filesTaskContent(
        {
          summary: { id: 'task-y', status: 'idle' },
          approvals: [],
          messages: [
            {
              id: 'm1',
              role: 'tool',
              toolName: 'edit',
              text: '',
              createdAt: '2026-11-16T00:00:00.000Z',
              tool: { kind: 'edit', title: 'edit', input: JSON.stringify({ [key]: 'in.txt', content: SENTINEL }) },
            },
          ],
        } as unknown as TaskDetail,
        inside,
      )
      // Named inside: shown. A key not read as a path would leave no path, and nothing would be shown.
      expect(JSON.stringify(shown), key).toContain(SENTINEL)
    }
  })

  it('shows the bytes of a file inside the session folders', async () => {
    const { project, inside } = await layout()
    for (const path of ['in.txt', join(project, 'in.txt'), 'new/not-yet.txt'])
      expect(JSON.stringify(filesTaskContent(detail(path), inside)), path).toContain(SENTINEL)
  })

  it('withholds them for a symlink out of the project, a `..` path, another project and a file elsewhere', async () => {
    const { other, outside, inside } = await layout()
    for (const path of [
      'link/secret.txt',
      'link/../secret.txt',
      '../outside/secret.txt',
      '~/secret.txt',
      join(other, 'theirs.txt'),
      join(outside, 'secret.txt'),
      '/etc/hosts',
    ]) {
      const shown = filesTaskContent(detail(path), inside)
      expect(JSON.stringify(shown), path).not.toContain(SENTINEL)
      // The row stays, with its path, as a `work` device sees it.
      expect(shown.messages.map(message => message.tool?.locations)).toEqual([[path], [path]])
    }
  })
})

describe('private sessions for a `files` device', () => {
  const provider: HarnessPlugin = {
    id: 'scope-provider',
    name: 'fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'scope-provider',
        name: 'fixture',
        model: 'fixture',
        async *stream() {
          yield { type: 'text', text: 'PRIVATE_ANSWER_4411' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }

  it('leaves them out of the detail, the snapshot and the event stream', async () => {
    const t = await startTestHost({ plugins: [provider] })
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const list = await owner.json<CustomAgentList>('custom-agents')
    await owner.json('custom-agents/general', {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'PRIVATE RULES' },
    })
    const browser = await t.enroll({ scopes: ['view', 'run'] })
    expect(browser.device.dataScope).toBe('files')
    const controller = new AbortController()
    const events = await browser.request('events', { signal: controller.signal })
    let streamed = ''
    const reading = (async () => {
      const reader = events.body!.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const next = await reader.read()
        if (next.done) return
        streamed += decoder.decode(next.value, { stream: true })
      }
    })().catch(() => {})
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Private plan', requestId: randomUUID(), mode: 'chat', model: { providerId: 'scope-provider', model: 'fixture' } },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary).toMatchObject({ agentPrivate: true })
    expect(await status(await browser.request(`tasks/${sessionId}`))).toEqual([403, 'agent-scope-required'])
    const snapshot = await browser.json<AppSnapshot>('snapshot')
    expect(snapshot.tasks.map(task => task.id)).not.toContain(sessionId)
    controller.abort()
    await reading
    expect(streamed).not.toContain(sessionId)
    expect(streamed).not.toContain('PRIVATE_ANSWER_4411')
  })
})
