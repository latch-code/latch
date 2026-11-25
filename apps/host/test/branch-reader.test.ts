import * as childProcess from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskSummary } from '@latch/protocol'
import { setKnownSecrets } from '@latch/core/node-kit'
import type { Bridge, HarnessDriver } from '@latch/sdk'
import { BranchReader, readGitBranch } from '../src/branch-reader.ts'
import { HarnessHub } from '../src/hub.ts'
vi.mock('node:child_process', { spy: true })
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, realpath: vi.fn(fs.realpath) }
})
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-branch-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function repository() {
  const root = await directory(),
    git = join(root, '.git')
  await mkdir(git)
  await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  return { root, git }
}
async function worktree() {
  const { root: main, git } = await repository(),
    root = await directory(),
    admin = join(git, 'worktrees', 'fixture')
  for (const path of [join(git, 'objects'), join(git, 'refs'), admin]) await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(join(root, '.git'), `gitdir: ${admin}\n`)
  await writeFile(join(admin, 'gitdir'), join(root, '.git') + '\n')
  await writeFile(join(admin, 'commondir'), '../..\n')
  await writeFile(join(admin, 'HEAD'), 'ref: refs/heads/feature/worktree\n')
  return { main, git, root, admin }
}
const summary = (cwd: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'standard',
  id: 'session',
  title: 'Fixture',
  cwd,
  status: 'idle',
  updatedAt: '2026-10-26T00:00:00Z',
  ...extra,
})
describe('read-only Git branch metadata', () => {
  it('checks the saved real path again before returning the branch', async () => {
    const { root } = await repository()
    const saved = await realpath(root)
    expect(await readGitBranch(saved, { requireRealPath: true })).toBe('main')
    // A temporary fixture reports that this path now resolves to another folder.
    vi.mocked(realpath).mockResolvedValueOnce(saved).mockResolvedValueOnce(join(saved, 'moved'))
    expect(await readGitBranch(saved, { requireRealPath: true })).toBeUndefined()
  })

  it('omits names containing a Host-known value without a credential prefix', async () => {
    const { root, git } = await repository()
    const value = 'synthetic-test-value'
    await writeFile(join(git, 'HEAD'), `ref: refs/heads/work/${value}\n`)
    setKnownSecrets('branch-reader-test', [value])
    try {
      expect(await readGitBranch(root)).toBeUndefined()
    } finally {
      setKnownSecrets('branch-reader-test', [])
    }
  })

  it('reads a project folder no session has run in, and refuses a relative path', async () => {
    const read = vi.fn(async () => 'main'),
      changed = vi.fn(),
      reader = new BranchReader({ read, changed })
    cleanup.push(() => reader.close())
    expect(reader.branchOf('relative/path')).toBeUndefined()
    expect(reader.branchOf('/tmp/project')).toBeUndefined()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(reader.branchOf('/tmp/project')).toBe('main')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads normal and detached HEADs without starting Git, redacts secret-shaped names and escapes hidden text', async () => {
    const { root, git } = await repository(),
      spawn = vi.mocked(childProcess.spawn),
      exec = vi.mocked(childProcess.execFile)
    expect(await readGitBranch(root)).toBe('main')
    await writeFile(join(git, 'HEAD'), 'a'.repeat(40) + '\n')
    expect(await readGitBranch(root)).toBe('分离于 aaaaaaa')
    await writeFile(join(git, 'HEAD'), 'b'.repeat(64) + '\n')
    expect(await readGitBranch(root)).toBe('分离于 bbbbbbb')
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/change\u202Etitle\n')
    expect(await readGitBranch(root)).toBe('change\\u{202E}title')
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/sk-ant-' + 'a'.repeat(80) + '\n')
    expect(await readGitBranch(root)).toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })
  it('accepts an internal gitdir and an exact trusted external linked-worktree layout, including canonical path aliases', async () => {
    const root = await directory(),
      admin = join(root, 'metadata')
    await mkdir(admin)
    await writeFile(join(root, '.git'), 'gitdir: metadata\n')
    await writeFile(join(admin, 'HEAD'), 'ref: refs/heads/internal\n')
    expect(await readGitBranch(root)).toBe('internal')
    const linked = await worktree()
    expect(await readGitBranch(linked.root)).toBe('feature/worktree')
  })
  it('refuses arbitrary external gitdirs, wrong reverse bindings, wrong commondir and writable metadata', async () => {
    const root = await directory(),
      outside = await directory()
    await writeFile(join(root, '.git'), `gitdir: ${outside}\n`)
    await writeFile(join(outside, 'HEAD'), 'ref: refs/heads/private\n')
    expect(await readGitBranch(root)).toBeUndefined()
    const linked = await worktree()
    await writeFile(join(linked.admin, 'gitdir'), join(root, '.git') + '\n')
    expect(await readGitBranch(linked.root)).toBeUndefined()
    await writeFile(join(linked.admin, 'gitdir'), join(linked.root, '.git') + '\n')
    await writeFile(join(linked.admin, 'commondir'), '../../../outside\n')
    expect(await readGitBranch(linked.root)).toBeUndefined()
    await writeFile(join(linked.admin, 'commondir'), '../..\n')
    await chmod(join(linked.admin, 'HEAD'), 0o666)
    expect(await readGitBranch(linked.root)).toBeUndefined()
  })
  it('refuses symlink directories and heads, oversized/malformed/invalid UTF8 data and lost roots', async () => {
    const { root, git } = await repository(),
      other = await directory(),
      file = join(other, 'HEAD')
    await writeFile(file, 'ref: refs/heads/outside\n')
    await rm(join(git, 'HEAD'))
    await symlink(file, join(git, 'HEAD'))
    expect(await readGitBranch(root)).toBeUndefined()
    await rm(join(git, 'HEAD'))
    await writeFile(join(git, 'HEAD'), 'x'.repeat(4097))
    expect(await readGitBranch(root)).toBeUndefined()
    await writeFile(join(git, 'HEAD'), new Uint8Array([0xff, 0xfe, 0xff]))
    expect(await readGitBranch(root)).toBeUndefined()
    await writeFile(join(git, 'HEAD'), 'ref: refs/tags/not-a-branch\n')
    expect(await readGitBranch(root)).toBeUndefined()
    await rm(git, { recursive: true })
    await symlink(other, git)
    expect(await readGitBranch(root)).toBeUndefined()
    expect(await readGitBranch(join(root, 'missing'))).toBeUndefined()
    expect(await readGitBranch('relative')).toBeUndefined()
  })
})
describe('nonblocking branch snapshots', () => {
  it('deduplicates per-root reads, refreshes after thirty seconds and a settled run, and drops driver assertions', async () => {
    let now = 0,
      branch: string | undefined = 'main'
    const read = vi.fn(async () => branch),
      changed = vi.fn(),
      reader = new BranchReader({ read, now: () => now, changed })
    cleanup.push(() => reader.close())
    const task = summary('/tmp/fixture')
    expect(reader.decorate({ ...task, branch: 'forged' }).branch).toBeUndefined()
    reader.decorate({ ...task, id: 'same-root' })
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(read).toHaveBeenCalledTimes(1)
    expect(reader.decorate(task).branch).toBe('main')
    now = 29_999
    reader.decorate(task)
    expect(read).toHaveBeenCalledTimes(1)
    now = 30_000
    branch = 'next'
    reader.decorate(task)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(reader.decorate(task).branch).toBe('next')
    reader.decorate({ ...task, status: 'running', runId: 'round-two' })
    branch = undefined
    reader.decorate({ ...task, runId: 'round-two', updatedAt: '2026-10-26T00:00:01Z' })
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3))
    expect(reader.decorate(task).branch).toBeUndefined()
  })
  it('holds four real reads without a queue, ignores stale completion and waits for actual shutdown settlement', async () => {
    const releases: Array<(value: string) => void> = [],
      read = vi.fn(() => new Promise<string>(resolve => releases.push(resolve))),
      changed = vi.fn(),
      reader = new BranchReader({ read, changed })
    for (let i = 0; i < 10; i++) reader.decorate(summary('/tmp/root-' + i, { id: 's' + i }))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
    const task = summary('/tmp/root-0', { id: 's0', status: 'running', runId: 'new' })
    reader.decorate(task)
    reader.decorate({ ...task, status: 'idle' })
    releases[0]!('stale')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5))
    expect(reader.decorate({ ...task, status: 'idle' }).branch).toBeUndefined()
    let closed = false
    const closing = reader.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    for (const release of releases) release('late')
    await closing
    expect(changed).not.toHaveBeenCalled()
    expect(reader.decorate({ ...task, branch: 'forged' }).branch).toBeUndefined()
  })
  it('decorates real Hub list/detail/summary projections without persisting metadata supplied by a driver', async () => {
    const { root, git } = await repository(),
      hub = await HarnessHub.open({ dataDir: await directory(), defaultId: () => 'fixture' })
    cleanup.push(() => hub.close())
    const task = summary(root, { branch: 'forged' }),
      bridge: Bridge = {
        async start() {},
        async close() {},
        async listTasks() {
          return [structuredClone(task)]
        },
        async detail() {
          return { summary: structuredClone(task), messages: [], approvals: [], liveText: '', cursor: 0 }
        },
        async createTask() {
          throw new Error('Not used')
        },
        async prompt() {},
        async cancel() {},
        approvals() {
          return []
        },
        async decide() {
          return true
        },
        subscribe() {
          return () => {}
        },
      },
      driver: HarnessDriver = { id: 'fixture', name: 'Fixture', version: '1', create: () => bridge }
    await hub.attach(driver, { kind: 'plugin', create: () => bridge, release: () => {} })
    expect((await hub.summary(task.id)).branch).not.toBe('forged')
    await vi.waitFor(async () => expect((await hub.summary(task.id)).branch).toBe('main'))
    expect((await hub.listTasks())[0]!.branch).toBe('main')
    expect((await hub.detail(task.id)).summary.branch).toBe('main')
    task.status = 'running'
    await hub.summary(task.id)
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/after-run\n')
    task.status = 'idle'
    task.updatedAt = '2026-10-26T00:01:00Z'
    await hub.summary(task.id)
    await vi.waitFor(async () => expect((await hub.summary(task.id)).branch).toBe('after-run'))
  })
})
