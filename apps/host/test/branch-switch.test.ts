import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@latch/sdk'
import { BranchReader, readGitLayout } from '../src/branch-reader.ts'
import { listBranches, listableBranch } from '../src/branch-list.ts'
import { BranchSwitcher, type SwitchCaller } from '../src/branch-switch.ts'
import { RepositoryHolds } from '../src/git-delivery.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SLOW = { timeout: 30_000 }
let next = 0
const id = () => `switch-request-${String(++next).padStart(4, '0')}`

/**
 * A repository on `main` with branches `feature/one` (a file of its own) and `fix/studio-sidebar-history-scroll`, an
 * empty home for the Host's restricted Git, and a folder where planted hooks and filters write a marker when they run.
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-branch-switch-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'),
    home = join(root, 'home'),
    marks = join(root, 'marks')
  await Promise.all([mkdir(repo), mkdir(home), mkdir(marks)])
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && name !== 'GIT_CONFIG_NOSYSTEM') delete env[name]
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim()
  const git = (...args: string[]) => gitIn(repo, ...args)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 'tester@example.invalid')
  await writeFile(join(repo, 'tracked.txt'), 'main\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  git('switch', '-q', '-c', 'feature/one')
  await writeFile(join(repo, 'tracked.txt'), 'feature\n')
  await writeFile(join(repo, 'only-feature.txt'), 'f\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feature')
  git('switch', '-q', 'main')
  git('branch', 'fix/studio-sidebar-history-scroll')
  /** A program that writes `name` into the marker folder when it runs. */
  const program = async (dir: string, name: string) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), `#!/bin/sh\necho ran >> '${join(marks, name)}'\ncat\n`)
    await chmod(join(dir, name), 0o755)
    return join(dir, name)
  }
  const ran = async () => (existsSync(marks) ? readdir(marks) : [])
  const moved: string[] = []
  const switcher = new BranchSwitcher({ holds: new RepositoryHolds(), home, log: () => {}, moved: folder => moved.push(folder) })
  const caller = (overrides: Partial<SwitchCaller> = {}) => {
    const audits: unknown[] = [],
      results: Array<{ outcome: string; code?: string }> = []
    let held = 0
    return {
      deviceId: 'dev_test',
      workspaceId: 'ws-1',
      folder: repo,
      prepare: async () => {},
      authorize: async () => {},
      hold: () => {
        held++
        return () => {
          held--
        }
      },
      audit: async (detail: unknown) => {
        audits.push(detail)
      },
      result: async (event: { outcome: string; code?: string }) => {
        results.push(event)
      },
      audits,
      results,
      held: () => held,
      ...overrides,
    }
  }
  return { root, repo, home, marks, git, gitIn, program, ran, switcher, caller, moved }
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('the branch list', () => {
  it('reads loose and packed refs, the current branch first, and leaves out what it cannot name or follow', SLOW, async () => {
    const f = await fixture()
    f.git('branch', 'packed/only')
    f.git('pack-refs', '--all')
    // Loose again after packing: the loose file is the newer and wins, and the name is listed once.
    f.git('branch', '-f', 'feature/one', 'feature/one')
    f.git('branch', 'zz-loose')
    // Names a person could not send back, or that look like a secret, or are too long: left out and counted.
    const commit = f.git('rev-parse', 'HEAD')
    await writeFile(join(f.repo, '.git', 'refs', 'heads', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), `${commit}\n`)
    await mkdir(join(f.repo, '.git', 'refs', 'heads', 'x'.repeat(200)))
    await writeFile(join(f.repo, '.git', 'refs', 'heads', 'x'.repeat(200), 'y'.repeat(60)), `${commit}\n`)
    await writeFile(join(f.repo, '.git', 'refs', 'heads', '-dash'), `${commit}\n`)
    await writeFile(join(f.repo, '.git', 'refs', 'heads', '@{-1}'), `${commit}\n`)
    await writeFile(join(f.repo, '.git', 'refs', 'heads', 'hidden‮name'), `${commit}\n`)
    // A symbolic ref and a link to a ref file elsewhere: neither is followed.
    await writeFile(join(f.repo, '.git', 'refs', 'heads', 'symbolic'), 'ref: refs/heads/main\n')
    const outside = join(f.root, 'outside-ref')
    await writeFile(outside, `${commit}\n`)
    await symlink(outside, join(f.repo, '.git', 'refs', 'heads', 'linked'))
    const listing = await listBranches((await readGitLayout(f.repo))!)
    expect(listing.current).toBe('main')
    expect(listing.branches.map(item => item.name)).toEqual([
      'main',
      'feature/one',
      'fix/studio-sidebar-history-scroll',
      'packed/only',
      'zz-loose',
    ])
    expect(listing.more).toBe(7)
    expect(JSON.stringify(listing)).not.toContain('sk-ant')
  })

  it('marks a branch another worktree holds and says what a detached HEAD is at', SLOW, async () => {
    const f = await fixture()
    f.git('worktree', 'add', '-q', join(f.root, 'other'), 'feature/one')
    const listing = await listBranches((await readGitLayout(f.repo))!)
    expect(listing.branches.find(item => item.name === 'feature/one')).toEqual({ name: 'feature/one', checkedOut: true })
    // From the linked worktree, main is the one held elsewhere.
    const fromOther = await listBranches((await readGitLayout(join(f.root, 'other')))!)
    expect(fromOther.branches[0]).toEqual({ name: 'feature/one' })
    expect(fromOther.branches.find(item => item.name === 'main')).toEqual({ name: 'main', checkedOut: true })
    f.git('switch', '-q', '--detach', 'HEAD')
    const detached = await listBranches((await readGitLayout(f.repo))!)
    expect(detached.current).toBeUndefined()
    expect(detached.detached).toBe(f.git('rev-parse', '--short=7', 'HEAD'))
  })

  it('lists at most 2,000 branches and counts the rest', SLOW, async () => {
    const f = await fixture()
    const commit = f.git('rev-parse', 'HEAD')
    f.git('pack-refs', '--all')
    const packed = await readFile(join(f.repo, '.git', 'packed-refs'), 'utf8')
    const extra = Array.from({ length: 2_100 }, (_, index) => `${commit} refs/heads/bulk/${String(index).padStart(4, '0')}`)
    await writeFile(join(f.repo, '.git', 'packed-refs'), `${packed}${extra.join('\n')}\n`)
    const listing = await listBranches((await readGitLayout(f.repo))!)
    expect(listing.branches).toHaveLength(2_000)
    expect(listing.branches[0]).toEqual({ name: 'main' })
    // main, feature/one, fix/…, and 2,100 more: 2,103 in all.
    expect(listing.more).toBe(103)
  })

  it('refuses a reftable repository rather than calling it empty', SLOW, async () => {
    const f = await fixture()
    await mkdir(join(f.repo, '.git', 'reftable'))
    await expect(f.switcher.list(f.repo)).rejects.toMatchObject({ code: 'branches-unreadable' })
  })

  it('accepts only names Git would take as a branch and a person can send back', () => {
    for (const name of ['main', 'feature/one', 'fix/studio-sidebar-history-scroll', 'release-1.2', '中文分支'])
      expect(listableBranch(name)).toBe(true)
    for (const name of [
      '-x',
      'HEAD',
      '@',
      'a..b',
      'a@{1}',
      'a/',
      'a.',
      '.a',
      'a/.b',
      'a.lock',
      'a b',
      'a~1',
      'a:b',
      'a//b',
      'x'.repeat(257),
    ])
      expect(listableBranch(name)).toBe(false)
  })
})

describe('switching', () => {
  it('switches with the audit record first, and runs no hook of the repository', SLOW, async () => {
    const f = await fixture()
    // Hooks a switch would run in your Git: in the repository's hooks folder, and your global one.
    await f.program(join(f.repo, '.git', 'hooks'), 'post-checkout')
    await f.program(join(f.repo, '.git', 'hooks'), 'reference-transaction')
    await f.program(join(f.home, 'hooks'), 'post-checkout')
    f.gitIn(f.home, 'config', '--global', 'core.hooksPath', join(f.home, 'hooks'))
    const caller = f.caller()
    const result = await f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' })
    expect(result).toEqual({ branch: 'feature/one', head: f.git('rev-parse', 'HEAD') })
    expect(f.git('branch', '--show-current')).toBe('feature/one')
    expect(await readFile(join(f.repo, 'only-feature.txt'), 'utf8')).toBe('f\n')
    expect(await f.ran()).toEqual([])
    expect(caller.audits).toHaveLength(1)
    expect(caller.audits[0]).toMatchObject({ fromHash: expect.any(String), toHash: expect.any(String), preHead: expect.any(String) })
    expect(JSON.stringify(caller.audits)).not.toContain('feature')
    expect(caller.results).toEqual([{ requestHash: expect.any(String), outcome: 'done', head: result.head }])
    expect(caller.held()).toBe(0)
    expect(f.moved).toContain(f.repo)
  })

  it('answers a retry with the same answer, and a lost answer by finding HEAD already there', SLOW, async () => {
    const f = await fixture()
    const requestId = id()
    const first = await f.switcher.switch(f.caller(), { requestId, branch: 'feature/one' })
    const caller = f.caller()
    expect(await f.switcher.switch(caller, { requestId, branch: 'feature/one' })).toEqual({ ...first, replay: true })
    expect((await refusal(f.switcher.switch(caller, { requestId, branch: 'main' }))).code).toBe('request-conflict')
    // Another Host process never saw the answer: HEAD is there already, so nothing runs and nothing is recorded.
    const again = new BranchSwitcher({ holds: new RepositoryHolds(), home: f.home, log: () => {}, moved: () => {} })
    expect(await again.switch(caller, { requestId, branch: 'feature/one' })).toEqual({ ...first, unchanged: true })
    expect(caller.audits).toEqual([])
  })

  it('switches only to a name its own listing gives', SLOW, async () => {
    const f = await fixture()
    const commit = f.git('rev-parse', 'HEAD')
    await writeFile(join(f.repo, '.git', 'refs', 'heads', '-dash'), `${commit}\n`)
    const caller = f.caller()
    for (const branch of ['-dash', '--orphan=x', 'HEAD~1', commit, 'refs/heads/feature/one', 'missing', '../main'])
      expect((await refusal(f.switcher.switch(caller, { requestId: id(), branch }))).code).toBe('branch-switch-unknown')
    expect(caller.audits).toEqual([])
    expect(f.git('branch', '--show-current')).toBe('main')
  })

  it('refuses a filter driver in any scope and hooks the repository sets, naming the kind and never the value', SLOW, async () => {
    const f = await fixture()
    const smudge = await f.program(join(f.root, 'bin'), 'smudge')
    // A smudge filter the branch's attributes name: your Git would run it for only-feature.txt.
    f.git('config', 'filter.mark.smudge', smudge)
    f.git('config', 'filter.mark.clean', smudge)
    await writeFile(join(f.repo, '.git', 'info', 'attributes'), '* filter=mark\n')
    const caller = f.caller()
    const filtered = await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))
    expect(filtered).toMatchObject({ status: 409, code: 'branch-switch-config', details: { kind: 'filter' } })
    expect(filtered.message).not.toContain(smudge)
    f.git('config', '--unset', 'filter.mark.smudge')
    f.git('config', '--unset', 'filter.mark.clean')
    // In your global configuration only: refused too, as a pull is.
    f.gitIn(f.home, 'config', '--global', 'filter.lfs.smudge', smudge)
    expect((await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))).details).toEqual({ kind: 'filter' })
    f.gitIn(f.home, 'config', '--global', '--unset', 'filter.lfs.smudge')
    // A hooks folder or a configured hook the repository sets for itself.
    f.git('config', 'core.hooksPath', '.husky')
    expect((await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))).details).toEqual({ kind: 'hook' })
    f.git('config', '--unset', 'core.hooksPath')
    f.git('config', 'hook.mark.command', smudge)
    f.git('config', 'hook.mark.event', 'post-checkout')
    expect((await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))).details).toEqual({ kind: 'hook' })
    expect(caller.audits).toEqual([])
    expect(f.git('branch', '--show-current')).toBe('main')
    expect(await f.ran()).toEqual([])
  })

  it('refuses a filter that appears after the first check, before Git starts', SLOW, async () => {
    const f = await fixture()
    const smudge = await f.program(join(f.root, 'bin'), 'smudge')
    await writeFile(join(f.repo, '.git', 'info', 'attributes'), '* filter=mark\n')
    let calls = 0
    const caller = f.caller({
      // The second check is the one right before Git starts: the repository gains a filter in between.
      authorize: async () => {
        if (++calls === 2) {
          f.git('config', 'filter.mark.smudge', smudge)
          f.git('config', 'filter.mark.required', 'true')
        }
      },
    })
    const refused = await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))
    expect(refused.code).toBe('branch-switch-config')
    expect(caller.audits).toHaveLength(1)
    expect(caller.results).toMatchObject([{ outcome: 'failed', code: 'branch-switch-config' }])
    expect(f.git('branch', '--show-current')).toBe('main')
    expect(await f.ran()).toEqual([])
  })

  it('lets Git refuse uncommitted changes it would overwrite, and never overwrites an ignored file', SLOW, async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'tracked.txt'), 'edited here\n')
    const caller = f.caller()
    const dirty = await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))
    expect(dirty).toMatchObject({ status: 409, code: 'branch-switch-local-changes' })
    expect(await readFile(join(f.repo, 'tracked.txt'), 'utf8')).toBe('edited here\n')
    expect(f.git('branch', '--show-current')).toBe('main')
    expect(caller.results).toMatchObject([{ outcome: 'failed', code: 'branch-switch-local-changes' }])
    f.git('checkout', '--', 'tracked.txt')
    // The branch tracks a file that is ignored here and holds something of yours.
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), 'only-feature.txt\n')
    await writeFile(join(f.repo, 'only-feature.txt'), 'mine\n')
    expect((await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))).code).toBe('branch-switch-local-changes')
    expect(await readFile(join(f.repo, 'only-feature.txt'), 'utf8')).toBe('mine\n')
    // An edit the switch keeps (a file both branches have the same) does not stop it.
    await rm(join(f.repo, 'only-feature.txt'))
    await writeFile(join(f.repo, 'untracked-note.txt'), 'note\n')
    expect((await f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' })).branch).toBe('feature/one')
    expect(await readFile(join(f.repo, 'untracked-note.txt'), 'utf8')).toBe('note\n')
  })

  it('refuses during a merge or a rebase, and a branch another worktree holds', SLOW, async () => {
    const f = await fixture()
    const caller = f.caller()
    for (const marker of ['MERGE_HEAD', 'rebase-merge']) {
      const path = join(f.repo, '.git', marker)
      if (marker === 'MERGE_HEAD') await writeFile(path, `${f.git('rev-parse', 'HEAD')}\n`)
      else await mkdir(path)
      expect((await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))).code).toBe('git-operation-in-progress')
      await rm(path, { recursive: true })
    }
    f.git('worktree', 'add', '-q', join(f.root, 'other'), 'feature/one')
    expect((await refusal(f.switcher.switch(caller, { requestId: id(), branch: 'feature/one' }))).code).toBe('branch-switch-checked-out')
    expect(caller.audits).toEqual([])
    expect(f.git('branch', '--show-current')).toBe('main')
  })

  it('runs nothing when the audit record cannot be written, or a check right before Git refuses', SLOW, async () => {
    const f = await fixture()
    const unrecorded = f.caller({
      audit: async () => {
        throw new Error('disk full')
      },
    })
    await expect(f.switcher.switch(unrecorded, { requestId: id(), branch: 'feature/one' })).rejects.toThrow('disk full')
    expect(f.git('branch', '--show-current')).toBe('main')
    expect(unrecorded.held()).toBe(0)
    let calls = 0
    const narrowed = f.caller({
      authorize: async () => {
        if (++calls === 2) throw new AppError(409, 'branch-switch-turn-running', '有会话正在运行')
      },
    })
    expect((await refusal(f.switcher.switch(narrowed, { requestId: id(), branch: 'feature/one' }))).code).toBe('branch-switch-turn-running')
    expect(narrowed.results).toMatchObject([{ outcome: 'failed', code: 'refused' }])
    expect(f.git('branch', '--show-current')).toBe('main')
  })

  it('is one Git write at a time per repository', SLOW, async () => {
    const f = await fixture()
    const holds = new RepositoryHolds()
    const switcher = new BranchSwitcher({ holds, home: f.home, log: () => {}, moved: () => {} })
    const common = join(f.repo, '.git')
    const release = holds.take(common, 'delivery')!
    expect((await refusal(switcher.switch(f.caller(), { requestId: id(), branch: 'feature/one' }))).code).toBe('git-busy')
    release()
    expect((await switcher.switch(f.caller(), { requestId: id(), branch: 'feature/one' })).branch).toBe('feature/one')
  })
})

describe('the branch cache', () => {
  it('reads a folder again at once when its HEAD moved', async () => {
    let branch = 'main',
      reads = 0,
      changed = 0
    const reader = new BranchReader({
      now: () => 1_000,
      changed: () => {
        changed++
      },
      read: async () => {
        reads++
        return branch
      },
    })
    expect(reader.branchOf('/repo')).toBeUndefined()
    await expect.poll(() => reader.branchOf('/repo')).toBe('main')
    branch = 'feature/one'
    // Within the 30 seconds the cache would keep: without the invalidation the old name stays.
    expect(reader.branchOf('/repo')).toBe('main')
    reader.invalidate(['/elsewhere', '/repo'])
    await expect.poll(() => reader.branchOf('/repo')).toBe('feature/one')
    expect(reads).toBe(2)
    expect(changed).toBe(2)
    await reader.close()
  })
})
