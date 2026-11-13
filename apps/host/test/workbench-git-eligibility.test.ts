import { execFileSync } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { GitDelivery } from '../src/git-delivery.ts'
import { SessionMetaStore } from '../src/session-meta.ts'
import { WorkbenchDeliveryReader } from '../src/workbench-delivery.ts'

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, access: vi.fn(fs.access), lstat: vi.fn(fs.lstat) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const cleanups: Array<() => Promise<unknown>> = []
beforeEach(() => {
  vi.mocked(access).mockReset().mockImplementation(actual.access)
  vi.mocked(lstat).mockReset().mockImplementation(actual.lstat)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

async function fixture() {
  const root = await actual.realpath(await mkdtemp(join(tmpdir(), 'latch-workbench-git-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const folder = join(root, 'project')
  await mkdir(folder)
  const pr = vi.fn(async () => ({ checks: [] }))
  const state = vi.fn(async () => {
    throw new AppError(409, 'git-not-repository', 'private path and raw details')
  })
  const reader = new WorkbenchDeliveryReader({ now: Date.now, state, pr })
  const read = () => reader.read([{ sessionId: 'session', folder, boundPr: true }])
  return { root, folder, pr, state, reader, read }
}

describe('workbench Git eligibility', () => {
  it('distinguishes an actual ordinary directory from a damaged Git repository and observes later initialization', async () => {
    const f = await fixture()
    const home = join(f.root, 'home')
    const data = join(f.root, 'data')
    const broken = join(f.root, 'broken')
    await Promise.all([mkdir(home), mkdir(data), mkdir(join(broken, '.git'), { recursive: true })])
    await writeFile(join(broken, '.git', 'HEAD'), 'invalid HEAD\n')
    const delivery = new GitDelivery({ receipts: await SessionMetaStore.open(data), home, hostEnv: { HOME: home }, log: () => {} })
    cleanups.push(() => delivery.close())
    const reader = new WorkbenchDeliveryReader({ now: Date.now, state: folder => delivery.state(folder), pr: f.pr })
    const targets = [f.folder, broken].map((folder, i) => ({ sessionId: `s${i}`, folder, boundPr: true }))
    const before = await reader.read(targets)
    expect(before.entries[0]).toEqual({ sessionId: 's0', observedAt: expect.any(String), notApplicable: 'not-repository' })
    expect(before.entries[1]).toEqual({
      sessionId: 's1',
      observedAt: expect.any(String),
      error: { code: 'git-not-repository', message: '暂时无法读取交付状态' },
    })
    expect(f.pr).not.toHaveBeenCalled()
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], {
      cwd: f.folder,
      env: { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
    })
    await writeFile(join(f.folder, 'new.txt'), 'new\n')
    const after = await reader.read([{ sessionId: 's0', folder: f.folder, boundPr: false }])
    expect(after.entries[0]?.state).toMatchObject({ branch: 'main', untracked: 1 })
    expect(after.entries[0]?.notApplicable).toBeUndefined()
  })

  it('coalesces the proof for a shared folder, never queries a bound PR and does not suppress unrelated failures', async () => {
    const f = await fixture()
    const result = await f.reader.read(Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}`, folder: f.folder, boundPr: true })))
    expect(result.entries.every(entry => entry.notApplicable === 'not-repository' && !entry.error && !entry.state)).toBe(true)
    expect(f.state).toHaveBeenCalledTimes(1)
    expect(f.pr).not.toHaveBeenCalled()
    f.state.mockRejectedValueOnce(new AppError(503, 'git-failed', 'private failure'))
    expect((await f.read()).entries[0]?.error?.code).toBe('git-failed')
  })

  it.each(['directory', 'file', 'symlink'] as const)('keeps an existing .git %s as a read error', async kind => {
    const f = await fixture()
    const path = join(f.folder, '.git')
    if (kind === 'directory') await mkdir(path)
    else if (kind === 'file') await writeFile(path, 'invalid gitdir')
    else await symlink(join(f.root, 'missing'), path)
    expect((await f.read()).entries[0]).toMatchObject({ error: { code: 'git-not-repository' } })
  })

  it.each(['missing', 'file', 'symlink'] as const)('keeps a %s session folder as a read error', async kind => {
    const f = await fixture()
    await rm(f.folder, { recursive: true })
    if (kind === 'file') await writeFile(f.folder, 'not a directory')
    if (kind === 'symlink') {
      await mkdir(join(f.root, 'elsewhere'))
      await symlink(join(f.root, 'elsewhere'), f.folder)
    }
    expect((await f.read()).entries[0]).toMatchObject({ error: { code: 'git-not-repository' } })
  })

  it('keeps a directory permission failure as a read error without exposing its details', async () => {
    const f = await fixture()
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('private EACCES details'), { code: 'EACCES' }))
    const result = await f.read()
    expect(result.entries[0]?.error).toEqual({ code: 'git-not-repository', message: '暂时无法读取交付状态' })
    expect(JSON.stringify(result)).not.toMatch(/private|EACCES/)
  })

  it.each(['replace-folder', 'add-git', 'add-and-remove-git'] as const)('rejects a %s race after .git was observed absent', async race => {
    const f = await fixture()
    let changed = false
    vi.mocked(lstat).mockImplementation(async (path, options) => {
      try {
        return await actual.lstat(path, options)
      } catch (error) {
        if (String(path) === join(f.folder, '.git') && !changed) {
          changed = true
          if (race === 'replace-folder') {
            await rename(f.folder, join(f.root, 'previous'))
            await mkdir(f.folder)
          } else {
            await mkdir(join(f.folder, '.git'))
            if (race === 'add-and-remove-git') await rm(join(f.folder, '.git'), { recursive: true })
          }
        }
        throw error
      }
    })
    expect((await f.read()).entries[0]?.error?.code).toBe('git-not-repository')
    expect(changed).toBe(true)
  })

  it('does not interpret an inaccessible .git as absence', async () => {
    const f = await fixture()
    vi.mocked(lstat).mockImplementation((path, options) => {
      if (String(path) === join(f.folder, '.git')) return Promise.reject(Object.assign(new Error('private denied'), { code: 'EACCES' }))
      return actual.lstat(path, options)
    })
    expect((await f.read()).entries[0]?.error?.code).toBe('git-not-repository')
  })

  it('rejects an ancestor symlink redirected for the metadata read and restored before the final identity check', async () => {
    const f = await fixture()
    await mkdir(join(f.folder, '.git'))
    const empty = join(f.root, 'empty')
    await mkdir(join(empty, 'project'), { recursive: true })
    const alias = join(f.root, 'alias')
    await symlink(f.root, alias)
    const folder = join(alias, 'project')
    vi.mocked(lstat).mockImplementation(async (path, options) => {
      if (String(path) !== join(folder, '.git')) return actual.lstat(path, options)
      await rm(alias)
      await symlink(empty, alias)
      try {
        return await actual.lstat(path, options)
      } finally {
        await rm(alias)
        await symlink(f.root, alias)
      }
    })
    const result = await f.reader.read([{ sessionId: 'session', folder, boundPr: true }])
    expect(result.entries[0]?.error?.code).toBe('git-not-repository')
    expect(result.entries[0]?.notApplicable).toBeUndefined()
  })

  it('rejects a canonical ancestor replaced for the metadata read and restored before the final identity check', async () => {
    const f = await fixture()
    const parent = join(f.root, 'parent')
    const saved = join(f.root, 'saved')
    await mkdir(parent)
    const folder = join(parent, 'project')
    await rename(f.folder, folder)
    await mkdir(join(folder, '.git'))
    let changed = false
    vi.mocked(lstat).mockImplementation(async (path, options) => {
      if (String(path) !== join(folder, '.git')) return actual.lstat(path, options)
      changed = true
      await rename(parent, saved)
      await mkdir(folder, { recursive: true })
      try {
        return await actual.lstat(path, options)
      } finally {
        await rm(parent, { recursive: true })
        await rename(saved, parent)
      }
    })
    const result = await f.reader.read([{ sessionId: 'session', folder, boundPr: true }])
    expect(result.entries[0]?.error?.code).toBe('git-not-repository')
    expect(result.entries[0]?.notApplicable).toBeUndefined()
    expect(changed).toBe(true)
  })
})
