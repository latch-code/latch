import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileTrackingInput, FileTrackingResult } from '@latch/sdk'
import { createFileTrackingService } from '../src/files/output-tracker.ts'
import { sessionReferences } from '../src/files/references.ts'
import { FileReferenceStore } from '../src/files/reference-store.ts'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})
async function fixture(options: Partial<Parameters<typeof createFileTrackingService>[0]> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-outputs-')))
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'project'),
    privateDir = join(root, 'private')
  await mkdir(privateDir, { recursive: true })
  const changes: FileTrackingResult[] = []
  const service = createFileTrackingService({ protectedPaths: [privateDir], platform: 'linux', settleMs: 0, ...options })
  cleanup.push(() => service.close())
  const input: FileTrackingInput = {
    sessionId: 'task',
    runId: 'run',
    folders: [{ id: 'main', path: root }],
    onChange: value => changes.push(value),
  }
  return { root, base, privateDir, service, input, changes }
}
describe('bounded per-run workspace changes', () => {
  it('tracks a managed home only for its verified session and stops after verification changes', async () => {
    const f = await fixture()
    const credentialRoot = join(f.base, '.latch')
    const general = join(credentialRoot, 'agent-homes', 'general')
    await mkdir(general, { recursive: true })
    let allowed = true
    const service = createFileTrackingService({
      protectedPaths: [credentialRoot],
      managedHome: { protectedAncestor: credentialRoot, permits: async (id, path) => id === 'task' && path === general && allowed },
      platform: 'linux',
      settleMs: 0,
    })
    cleanup.push(() => service.close())
    const input = { ...f.input, folders: [{ id: 'main', path: general }] }
    const other = await service.start({ ...input, sessionId: 'other' })
    expect(await other.finish()).toEqual({ files: [], unavailable: true })

    const handle = await service.start(input)
    await writeFile(join(general, 'report.txt'), 'text')
    expect(await handle.finish()).toMatchObject({ files: [{ path: 'report.txt' }] })

    const later = await service.start(input)
    await writeFile(join(general, 'later.txt'), 'text')
    allowed = false
    expect(await later.finish()).toEqual({ files: [], unavailable: true })
  })

  it('receives actual native recursive watcher events when the platform supports them', async () => {
    const f = await fixture({ platform: process.platform, settleMs: 2000 })
    const handle = await f.service.start(f.input)
    await writeFile(join(f.root, 'actual.txt'), 'real watcher')
    expect(await handle.finish()).toMatchObject({ files: [{ path: 'actual.txt' }] })
  })
  it('detects modifications, late writes and deletion without guessing creation from timestamps on scan-only platforms', async () => {
    const f = await fixture({ settleMs: 35 })
    await writeFile(join(f.root, 'changed.md'), 'before')
    await writeFile(join(f.root, 'gone.txt'), 'before')
    const handle = await f.service.start(f.input)
    await writeFile(join(f.root, 'changed.md'), 'after changed')
    await rm(join(f.root, 'gone.txt'))
    const result = handle.finish()
    await writeFile(join(f.root, 'late.txt'), 'late')
    expect(await result).toMatchObject({
      files: [
        { root: 'main', path: 'changed.md', change: 'modified', kind: 'markdown' },
        { root: 'main', path: 'gone.txt', change: 'deleted' },
        { root: 'main', path: 'late.txt', change: 'modified' },
      ],
    })
    expect(await handle.finish()).toEqual(await result)
  })
  it('excludes protected directories, symlinks, secret names/content and build output', async () => {
    const f = await fixture()
    const outside = join(f.base, 'outside.txt')
    await writeFile(outside, 'outside')
    const handle = await f.service.start(f.input)
    for (const directory of ['node_modules', '.git', 'dist', 'build', '.venv']) {
      await mkdir(join(f.root, directory))
      await writeFile(join(f.root, directory, 'ignored.txt'), 'private output')
    }
    await writeFile(join(f.privateDir, 'hidden.txt'), 'private')
    await writeFile(join(f.root, '.env'), 'PASSWORD=value')
    await writeFile(join(f.root, 'ordinary.txt'), ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '))
    await symlink(outside, join(f.root, 'linked.txt'))
    await writeFile(join(f.root, 'note.txt.tmp'), 'temp')
    await writeFile(join(f.root, 'report.txt'), 'public report')
    expect((await handle.finish()).files.map(file => file.path)).toEqual(['report.txt'])
  })
  it('reports partial discovery when the scan or path budget is exhausted', async () => {
    const f = await fixture({ entryLimit: 2, pathLimit: 1 })
    const handle = await f.service.start(f.input)
    await Promise.all(['a.txt', 'b.txt', 'c.txt'].map(path => writeFile(join(f.root, path), 'text')))
    const result = await handle.finish()
    expect(result.truncated).toBe(true)
    expect(result.files.length).toBeLessThanOrEqual(1)
  })
  // The watcher is the platform's own, as in the first test.
  it.runIf(process.platform === 'darwin')(
    'does not call the record incomplete for a folder too large to scan while a watcher reports every change',
    async () => {
      const f = await fixture({ platform: 'darwin', entryLimit: 2, settleMs: 2000 })
      // More than the scan reaches: the baseline is unfinished, as in a large repository.
      await Promise.all(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(path => writeFile(join(f.root, path), 'old')))
      await new Promise(resolve => setTimeout(resolve, 20))
      const handle = await f.service.start(f.input)
      await writeFile(join(f.root, 'made.txt'), 'new')
      await writeFile(join(f.root, 'e.txt'), 'changed')
      const result = await handle.finish()
      expect(result.files.map(file => file.path).toSorted()).toEqual(['e.txt', 'made.txt'])
      expect(result.truncated).toBeUndefined()
      expect(result.unavailable).toBeUndefined()
    },
  )
  it('still says so when an unscanned folder has to be compared by scanning at the end', async () => {
    const f = await fixture({
      platform: 'darwin',
      entryLimit: 2,
      watch: () => {
        throw new Error('unavailable')
      },
    })
    await Promise.all(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(path => writeFile(join(f.root, path), 'old')))
    await new Promise(resolve => setTimeout(resolve, 20))
    const handle = await f.service.start(f.input)
    const result = await handle.finish()
    expect(result.truncated).toBe(true)
    // Files that were never touched since before the run are not reported as changed for want of a baseline.
    expect(result.files).toEqual([])
  })
  it('keeps watcher debounce separate from the settlement deadline and publishes bounded live changes', async () => {
    let changed!: (path: string | null) => void
    const stop = vi.fn()
    const f = await fixture({
      platform: 'darwin',
      settleMs: 40,
      watch: (_root, callback) => {
        changed = callback
        return stop
      },
    })
    const handle = await f.service.start(f.input)
    // A new file counts as created when its birth time is at or after the start, and Linux stamps files from a coarse
    // clock that can lag the start by a few milliseconds: write it a moment later.
    await new Promise(resolve => setTimeout(resolve, 50))
    await writeFile(join(f.root, 'new.txt'), 'new')
    const finish = handle.finish()
    changed('new.txt')
    const result = await finish
    expect(result.files).toMatchObject([{ path: 'new.txt', change: 'created' }])
    expect(stop).toHaveBeenCalledTimes(1)
    expect(f.changes.some(value => value.files.length === 1)).toBe(true)
  })
  it('reports unreadability instead of inventing deletion when a previously observed parent becomes inaccessible', async () => {
    let changed!: (path: string | null) => void
    const f = await fixture({
      platform: 'darwin',
      watch: (_root, callback) => {
        changed = callback
        return () => {}
      },
    })
    const directory = join(f.root, 'restricted')
    await mkdir(directory)
    await writeFile(join(directory, 'before.txt'), 'before')
    const handle = await f.service.start(f.input)
    try {
      await chmod(directory, 0)
      changed('restricted/before.txt')
      const result = await handle.finish()
      expect(result.files).toEqual([])
      expect(result.unavailable).toBe(true)
    } finally {
      await chmod(directory, 0o700)
    }
  })
  it('falls back to the bounded end scan on a watcher failure and refuses unregistered roots', async () => {
    const f = await fixture({
      platform: 'darwin',
      watch: () => {
        throw new Error('unavailable')
      },
      allowedRoot: async root => root.id === 'main',
    })
    expect(await (await f.service.start({ ...f.input, folders: [{ id: 'foreign', path: f.root }] })).finish()).toEqual({
      files: [],
      unavailable: true,
    })
    const handle = await f.service.start(f.input)
    await writeFile(join(f.root, 'found.txt'), 'text')
    expect(await handle.finish()).toMatchObject({ files: [{ path: 'found.txt' }], truncated: true })
  })
  it('shutdown ends pending grace promptly, closes resources, and refuses new trackers', async () => {
    const stop = vi.fn()
    const f = await fixture({ platform: 'darwin', settleMs: 2000, watch: () => stop })
    const handle = await f.service.start(f.input)
    const pending = handle.finish()
    await f.service.close()
    expect(await pending).toMatchObject({ truncated: true })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await (await f.service.start(f.input)).finish()).toMatchObject({ unavailable: true })
  })
  it('authorizes explicit output roots in work scope and notices late updates after a message was indexed', async () => {
    const f = await fixture()
    const roots = f.input.folders
    const store = await FileReferenceStore.open(join(f.base, 'data'))
    const detail = {
      summary: { harnessId: 'standard', id: 'task', title: 'title', updatedAt: '', status: 'idle' as const, runId: 'run' },
      messages: [{ id: 'reply', role: 'assistant' as const, text: 'done' }],
      approvals: [],
      cursor: 0,
      liveText: '',
    }
    expect(await store.references('task', detail, roots, '')).toEqual(new Set())
    const output = { root: 'main', path: 'output/report.md', change: 'modified' as const }
    const late = { ...detail, messages: [{ ...detail.messages[0]!, outputs: [output] }] }
    expect(await store.references('task', late, roots, '')).toContain('main\noutput/report.md')
    const live = { ...detail, fileChanges: { runId: 'run', files: [{ ...output, path: 'live.md' }], state: 'watching' as const } }
    expect(await store.references('task', live, roots, '')).toContain('main\nlive.md')
    expect(sessionReferences({ ...live, fileChanges: { ...live.fileChanges, runId: 'old' } }, roots, '')).not.toContain('main\nlive.md')
  })
})
