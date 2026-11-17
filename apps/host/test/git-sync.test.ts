import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@latch/sdk'
import { GitDelivery, transportOf, type DeliveryAuditEvent, type DeliveryCaller } from '../src/git-delivery.ts'
import { SessionMetaStore } from '../src/session-meta.ts'
import { configHookGit } from './helpers/config-hooks.ts'
import { installFakeSsh } from './helpers/fake-ssh.ts'
import { findGit } from '../src/changes/git.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SLOW = { timeout: 30_000 }

/**
 * A repository whose `origin` is a bare repository on disk, tracking `main`, and a second clone (`other`) that moves the
 * remote on; hooks write a marker when they run, wherever they are: the repository, the remote, your global hooks.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'latch-git-sync-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'),
    remote = join(root, 'remote.git'),
    other = join(root, 'other'),
    home = join(root, 'home'),
    marks = join(root, 'marks'),
    dataDir = join(root, 'data')
  await Promise.all([mkdir(repo), mkdir(home), mkdir(marks), mkdir(dataDir)])
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && name !== 'GIT_CONFIG_NOSYSTEM') delete env[name]
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim()
  const git = (...args: string[]) => gitIn(repo, ...args)
  gitIn(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 'tester@example.invalid')
  await writeFile(join(repo, 'tracked.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', '-u', 'origin', 'main')
  gitIn(root, 'clone', '-q', remote, other)
  gitIn(other, 'config', 'user.name', 'Other')
  gitIn(other, 'config', 'user.email', 'other@example.invalid')
  const hook = async (dir: string, name: string) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), `#!/bin/sh\necho ran >> '${join(marks, name)}'\n`)
    await chmod(join(dir, name), 0o755)
  }
  /** A commit in `other`, pushed to the remote. */
  const upstreamCommit = async (file: string, text: string) => {
    await writeFile(join(other, file), text)
    gitIn(other, 'add', '.')
    gitIn(other, 'commit', '-q', '-m', `edit ${file}`)
    gitIn(other, 'push', '-q', 'origin', 'main')
    return gitIn(other, 'rev-parse', 'HEAD')
  }
  const delivery = async (git?: string) => {
    const store = await SessionMetaStore.open(dataDir)
    return new GitDelivery({
      ...(git ? { git } : {}),
      receipts: store,
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1' },
      shell: async () => ({ file: '/bin/sh', argv: ['sh'] }),
      log: () => {},
    })
  }
  const caller = (overrides: Partial<DeliveryCaller> = {}) => {
    const audits: DeliveryAuditEvent[] = [],
      results: unknown[] = []
    return {
      sessionId: 'session-1',
      deviceId: 'dev_test',
      folder: repo,
      authorize: async () => {},
      audit: async (event: DeliveryAuditEvent) => {
        audits.push(event)
      },
      result: async (event: unknown) => {
        results.push(event)
      },
      audits,
      results,
      ...overrides,
    }
  }
  return { root, repo, remote, other, home, marks, git, gitIn, hook, upstreamCommit, delivery, caller }
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

let next = 0
const id = () => `request-${String(++next).padStart(4, '0')}`

describe('fetch and pull', () => {
  it('measures behind only after a fetch, which updates the counts and runs no hook anywhere', SLOW, async () => {
    const f = await fixture()
    // Hooks a fetch could reach: the repository's own (`reference-transaction` runs on every ref update), your global
    // hooks directory, and the remote's.
    await f.hook(join(f.repo, '.git', 'hooks'), 'reference-transaction')
    await f.hook(join(f.home, 'hooks'), 'post-merge')
    await f.hook(join(f.home, 'hooks'), 'reference-transaction')
    f.gitIn(f.home, 'config', '--global', 'core.hooksPath', join(f.home, 'hooks'))
    await f.hook(join(f.remote, 'hooks'), 'post-update')
    await f.hook(join(f.remote, 'hooks'), 'reference-transaction')
    const tip = await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    // The fixture's own push ran some of them; only what the Host runs from here counts.
    await rm(f.marks, { recursive: true, force: true })
    await mkdir(f.marks)
    const delivery = await f.delivery()
    const before = await delivery.state(f.repo)
    expect(before).toMatchObject({ ahead: 0, behind: 0, upstream: 'origin/main' })
    const caller = f.caller()
    const fetched = await delivery.fetch(caller, { requestId: id() })
    expect(fetched.remote).toBe('origin')
    expect(Date.parse(fetched.fetchedAt)).not.toBeNaN()
    const after = await delivery.state(f.repo)
    expect(after).toMatchObject({ ahead: 0, behind: 1, fetchedAt: fetched.fetchedAt })
    expect(f.git('rev-parse', 'refs/remotes/origin/main')).toBe(tip)
    // The work tree and HEAD are left alone.
    expect(f.git('rev-parse', 'HEAD')).not.toBe(tip)
    expect(caller.audits).toEqual([
      {
        action: 'git.fetch',
        detail: expect.objectContaining({ remote: 'upstream', transport: 'file', remoteHash: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
      },
    ])
    expect(JSON.stringify(caller.audits)).not.toContain(f.remote)
    expect(caller.results).toEqual([{ operation: 'fetch', outcome: 'done' }])
    expect(existsSync(join(f.marks, 'reference-transaction'))).toBe(false)
    expect(existsSync(join(f.marks, 'post-update'))).toBe(false)
  })

  it('pulls by fast-forward only, with no hook, and says when there is nothing to take in', SLOW, async () => {
    const f = await fixture()
    await f.hook(join(f.repo, '.git', 'hooks'), 'post-merge')
    await f.hook(join(f.repo, '.git', 'hooks'), 'reference-transaction')
    await f.hook(join(f.repo, '.git', 'hooks'), 'post-checkout')
    const tip = await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    const delivery = await f.delivery()
    const caller = f.caller()
    const pulled = await delivery.pull(caller, { requestId: id() })
    expect(pulled).toMatchObject({ remote: 'origin', updated: true, head: tip, commits: 1 })
    expect(f.git('rev-parse', 'HEAD')).toBe(tip)
    expect(f.git('status', '--porcelain')).toBe('')
    // A fast-forward: no merge commit.
    expect(f.git('rev-list', '--count', '--merges', 'HEAD')).toBe('0')
    expect(caller.audits.map(event => event.action)).toEqual(['git.pull'])
    expect(caller.results).toEqual([{ operation: 'pull', outcome: 'done', commit: tip }])
    for (const name of ['post-merge', 'reference-transaction', 'post-checkout']) expect(existsSync(join(f.marks, name))).toBe(false)
    expect(existsSync(join(f.marks, 'post-update'))).toBe(false)
    const again = await delivery.pull(f.caller(), { requestId: id() })
    expect(again).toMatchObject({ updated: false, head: tip, commits: 0 })
  })

  it('refuses a diverged branch with both counts and merges or rebases nothing', SLOW, async () => {
    const f = await fixture()
    await f.upstreamCommit('upstream.txt', 'theirs\n')
    await writeFile(join(f.repo, 'mine.txt'), 'mine\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'mine')
    const head = f.git('rev-parse', 'HEAD')
    const delivery = await f.delivery()
    const caller = f.caller()
    const error = await refusal(delivery.pull(caller, { requestId: id() }))
    expect(error).toMatchObject({ status: 409, code: 'git-pull-diverged', details: { ahead: 1, behind: 1 } })
    expect(f.git('rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(join(f.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(existsSync(join(f.repo, 'upstream.txt'))).toBe(false)
    expect(caller.results).toEqual([{ operation: 'pull', outcome: 'failed', code: 'git-pull-diverged' }])
    // The fetch it made shows in the state: diverged, as of now.
    expect(await delivery.state(f.repo)).toMatchObject({ ahead: 1, behind: 1, fetchedAt: expect.any(String) })
  })

  it('leaves the repository as it was when the upstream would overwrite uncommitted changes', SLOW, async () => {
    const f = await fixture()
    await f.upstreamCommit('tracked.txt', 'one\ntheirs\n')
    await writeFile(join(f.repo, 'tracked.txt'), 'one\nmine, not committed\n')
    const head = f.git('rev-parse', 'HEAD')
    const delivery = await f.delivery()
    const error = await refusal(delivery.pull(f.caller(), { requestId: id() }))
    expect(error).toMatchObject({ status: 409, code: 'git-pull-local-changes' })
    expect(f.git('rev-parse', 'HEAD')).toBe(head)
    expect(f.git('diff', '--stat')).toContain('tracked.txt')
  })

  it('refuses a pull without an upstream, on a detached HEAD, or with a filter driver, before any audit', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    f.git('checkout', '-q', '-b', 'topic')
    const caller = f.caller()
    expect(await refusal(delivery.pull(caller, { requestId: id() }))).toMatchObject({ code: 'git-no-upstream' })
    f.git('checkout', '-q', '--detach')
    expect(await refusal(delivery.pull(caller, { requestId: id() }))).toMatchObject({ code: 'git-detached' })
    f.git('checkout', '-q', 'main')
    f.git('config', 'filter.lfs.smudge', `sh -c 'echo ran >> ${join(f.marks, 'smudge')}; cat'`)
    expect(await refusal(delivery.pull(caller, { requestId: id() }))).toMatchObject({ code: 'git-drivers' })
    f.git('config', '--unset', 'filter.lfs.smudge')
    f.git('config', 'merge.mine.driver', 'true')
    expect(await refusal(delivery.pull(caller, { requestId: id() }))).toMatchObject({ code: 'git-drivers' })
    expect(caller.audits).toEqual([])
  })

  it('opens only the remote’s own transport, and refuses remote helpers and refspecs that write local branches', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const caller = f.caller()
    const marker = join(f.marks, 'ext')
    // A configuration that allows `ext::` for any command still gets no transport but the remote's own.
    f.git('config', 'protocol.ext.allow', 'always')
    f.git('remote', 'set-url', 'origin', `ext::sh -c touch% ${marker}`)
    expect(await refusal(delivery.fetch(caller, { requestId: id() }))).toMatchObject({ status: 409, code: 'git-remote-form' })
    // `insteadOf` is applied before the transport is chosen.
    f.git('remote', 'set-url', 'origin', 'evil:repo')
    f.git('config', `url.ext::sh -c touch% ${marker}#.insteadOf`, 'evil:')
    expect(await refusal(delivery.fetch(caller, { requestId: id() }))).toMatchObject({ code: 'git-remote-form' })
    f.git('config', '--remove-section', `url.ext::sh -c touch% ${marker}#`)
    f.git('remote', 'set-url', 'origin', f.remote)
    f.git('config', 'remote.origin.vcs', 'evil')
    expect(await refusal(delivery.fetch(caller, { requestId: id() }))).toMatchObject({ code: 'git-remote-form' })
    f.git('config', '--unset', 'remote.origin.vcs')
    f.git('config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*')
    expect(await refusal(delivery.fetch(caller, { requestId: id() }))).toMatchObject({ code: 'git-remote-form' })
    expect(caller.audits).toEqual([])
    expect(existsSync(marker)).toBe(false)
    // A local remote's `uploadpack` is a program run here: it is fixed for the fetch.
    f.git('config', '--unset-all', 'remote.origin.fetch')
    f.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    f.git('config', 'remote.origin.uploadpack', `sh -c 'touch ${marker}; exec git-upload-pack "$@"' --`)
    await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    await delivery.fetch(caller, { requestId: id() })
    expect(existsSync(marker)).toBe(false)
    expect((await delivery.state(f.repo)).behind).toBe(1)
  })

  it('runs nothing when the audit is not written', SLOW, async () => {
    const f = await fixture()
    await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    const delivery = await f.delivery()
    const caller = f.caller({
      audit: async () => {
        throw new AppError(503, 'audit-unavailable', '审计没有写入')
      },
    })
    expect(await refusal(delivery.fetch(caller, { requestId: id() }))).toMatchObject({ code: 'audit-unavailable' })
    expect(await refusal(delivery.pull(caller, { requestId: id() }))).toMatchObject({ code: 'audit-unavailable' })
    expect(existsSync(join(f.repo, '.git', 'FETCH_HEAD'))).toBe(false)
    expect((await delivery.state(f.repo)).behind).toBe(0)
  })

  it('classifies transports as Git does', () => {
    expect(transportOf('https://github.com/acme/widgets.git')).toBe('https')
    expect(transportOf('http://example.test/x')).toBe('http')
    expect(transportOf('ssh://git@example.test/x')).toBe('ssh')
    expect(transportOf('git@example.test:acme/x.git')).toBe('ssh')
    expect(transportOf('/srv/git/x.git')).toBe('file')
    expect(transportOf('file:///srv/git/x.git')).toBe('file')
    expect(transportOf('../x')).toBe('file')
    for (const url of ['git://example.test/x', 'ext::sh -c x', 'fd::3', 'hg::https://x', 'persistent-https://x', '-uhack', ''])
      expect(transportOf(url)).toBeUndefined()
  })
})

describe('conflicts and abort', () => {
  /** A branch `theirs` that changes the line `main` changes too. */
  async function conflicting() {
    const f = await fixture()
    f.git('checkout', '-q', '-b', 'theirs')
    await writeFile(join(f.repo, 'tracked.txt'), 'theirs\n')
    f.git('commit', '-q', '-am', 'theirs')
    f.git('checkout', '-q', 'main')
    await writeFile(join(f.repo, 'tracked.txt'), 'mine\n')
    f.git('commit', '-q', '-am', 'mine')
    return { ...f, head: f.git('rev-parse', 'HEAD') }
  }
  const fails = (run: () => void) => expect(run).toThrow()

  it('shows a merge with its conflicted files, and abort puts everything back as before it', SLOW, async () => {
    const f = await conflicting()
    await f.hook(join(f.repo, '.git', 'hooks'), 'post-checkout')
    await f.hook(join(f.repo, '.git', 'hooks'), 'reference-transaction')
    fails(() => f.git('merge', 'theirs'))
    // The marker hooks above ran for the merge itself in the terminal; only what follows counts.
    await rm(f.marks, { recursive: true, force: true })
    await mkdir(f.marks)
    const delivery = await f.delivery()
    expect(await delivery.state(f.repo)).toMatchObject({ gitOperation: 'merge', conflicted: ['tracked.txt'] })
    // Every other write waits for it; a pull says so too.
    expect(await refusal(delivery.pull(f.caller(), { requestId: id() }))).toMatchObject({ code: 'git-operation-in-progress' })
    const wrong = f.caller()
    expect(await refusal(delivery.abort(wrong, { requestId: id(), operation: 'rebase' }))).toMatchObject({
      code: 'git-operation-changed',
      details: { operation: 'merge' },
    })
    expect(wrong.audits).toEqual([])
    const caller = f.caller()
    expect(await delivery.abort(caller, { requestId: id(), operation: 'merge' })).toEqual({ operation: 'merge', head: f.head })
    expect(existsSync(join(f.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(f.git('rev-parse', 'HEAD')).toBe(f.head)
    expect(f.git('status', '--porcelain')).toBe('')
    expect(caller.audits).toEqual([
      { action: 'git.abort', detail: expect.objectContaining({ operation: 'merge', preHead: f.head, conflicted: 1 }) },
    ])
    expect(caller.results).toEqual([{ operation: 'abort', outcome: 'done', commit: f.head }])
    expect(existsSync(join(f.marks, 'post-checkout'))).toBe(false)
    expect(existsSync(join(f.marks, 'reference-transaction'))).toBe(false)
    expect(await refusal(delivery.abort(f.caller(), { requestId: id(), operation: 'merge' }))).toMatchObject({ code: 'git-no-operation' })
  })

  it('shows a rebase with its conflicted files, and abort returns the branch to where it was', SLOW, async () => {
    const f = await conflicting()
    fails(() => f.git('rebase', 'theirs'))
    const delivery = await f.delivery()
    expect(await delivery.state(f.repo)).toMatchObject({ gitOperation: 'rebase', conflicted: ['tracked.txt'] })
    expect(await delivery.abort(f.caller(), { requestId: id(), operation: 'rebase' })).toEqual({ operation: 'rebase', head: f.head })
    expect(f.git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(f.git('rev-parse', 'HEAD')).toBe(f.head)
    expect(existsSync(join(f.repo, '.git', 'rebase-merge'))).toBe(false)
    expect(f.git('status', '--porcelain')).toBe('')
  })

  it('aborts a cherry-pick; a permission lost before Git runs leaves the operation as it was', SLOW, async () => {
    const f = await conflicting()
    fails(() => f.git('cherry-pick', 'theirs'))
    const delivery = await f.delivery()
    expect((await delivery.state(f.repo)).gitOperation).toBe('cherry-pick')
    let calls = 0
    const revoked = f.caller({
      authorize: async () => {
        // The check before the audit passes; the one right before Git runs does not.
        if (++calls > 1) throw new AppError(403, 'device-revoked', '设备已撤销')
      },
    })
    expect(await refusal(delivery.abort(revoked, { requestId: id(), operation: 'cherry-pick' }))).toMatchObject({ code: 'device-revoked' })
    expect(existsSync(join(f.repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(true)
    expect(await delivery.abort(f.caller(), { requestId: id(), operation: 'cherry-pick' })).toMatchObject({ operation: 'cherry-pick' })
    expect(existsSync(join(f.repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(false)
    expect(f.git('rev-parse', 'HEAD')).toBe(f.head)
  })
})

const hookGit = configHookGit()
describe.skipIf(!hookGit)('hooks from configuration (Git 2.54 and later)', () => {
  it('runs none in a fetch or a pull, from the repository or your global configuration', SLOW, async () => {
    const f = await fixture()
    const trap = async (name: string) => {
      const path = join(f.root, `${name}.sh`)
      await writeFile(path, `#!/bin/sh\necho ran >> '${join(f.marks, name)}'\n`)
      await chmod(path, 0o755)
      return path
    }
    f.git('config', 'hook.refs.event', 'reference-transaction')
    f.git('config', 'hook.refs.command', await trap('local-refs'))
    f.git('config', 'hook.merged.event', 'post-merge')
    f.git('config', 'hook.merged.command', await trap('local-merge'))
    f.gitIn(f.home, 'config', '--global', 'hook.global.event', 'reference-transaction')
    f.gitIn(f.home, 'config', '--global', 'hook.global.command', await trap('global-refs'))
    // This Git does run them: an update of a ref here sets the markers off.
    execFileSync(hookGit!, ['update-ref', 'refs/heads/probe', 'HEAD'], {
      cwd: f.repo,
      env: { HOME: f.home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' },
    })
    expect(existsSync(join(f.marks, 'local-refs'))).toBe(true)
    expect(existsSync(join(f.marks, 'global-refs'))).toBe(true)
    await rm(f.marks, { recursive: true, force: true })
    await mkdir(f.marks)
    const tip = await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    await rm(f.marks, { recursive: true, force: true })
    await mkdir(f.marks)
    const delivery = await f.delivery(hookGit)
    await delivery.fetch(f.caller(), { requestId: id() })
    expect((await delivery.pull(f.caller(), { requestId: id() })).head).toBe(tip)
    expect(await readdir(f.marks)).toEqual([])
  })
})

describe('the repository’s own configuration', () => {
  /** A command that leaves a marker if it ever runs. */
  const trapCommand = (f: Awaited<ReturnType<typeof fixture>>, name: string) => `sh -c 'touch ${join(f.marks, name)}'`

  it('refuses 获取 and 拉取 before the audit when it sets a program, credentials or where they go, by kind', SLOW, async () => {
    const f = await fixture()
    await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    const delivery = await f.delivery()
    const cases: Array<[key: string, value: string, kind: string]> = [
      ['core.sshCommand', trapCommand(f, 'ssh'), 'program'],
      ['core.askPass', trapCommand(f, 'askpass'), 'program'],
      ['core.gitProxy', trapCommand(f, 'gitproxy'), 'program'],
      ['ssh.variant', 'simple', 'program'],
      ['credential.helper', `!${trapCommand(f, 'helper')}`, 'credential'],
      ['credential.https://github.com.username', 'someone', 'credential'],
      ['http.proxy', 'http://127.0.0.1:9', 'proxy'],
      ['http.https://github.com.proxy', 'http://127.0.0.1:9', 'proxy'],
      ['remote.origin.proxy', 'http://127.0.0.1:9', 'proxy'],
      ['http.sslVerify', 'false', 'tls'],
      ['http.https://github.com.sslCAInfo', '/tmp/ca.pem', 'tls'],
      ['http.sslCAPath', '/tmp/ca', 'tls'],
      ['http.extraHeader', 'Authorization: Bearer x', 'header'],
      ['http.cookieFile', '/tmp/cookies', 'header'],
      ['url.https://evil.example/.insteadOf', 'https://github.com/', 'rewrite'],
      ['url.https://evil.example/.pushInsteadOf', 'https://github.com/', 'rewrite'],
    ]
    for (const [key, value, kind] of cases) {
      f.git('config', key, value)
      expect((await delivery.state(f.repo)).repoConfig, key).toBe(kind)
      const caller = f.caller()
      for (const run of [() => delivery.fetch(caller, { requestId: id() }), () => delivery.pull(caller, { requestId: id() })]) {
        const error = await refusal(run())
        expect([key, error.status, error.code, error.details]).toEqual([key, 409, 'git-repo-config', { kind }])
        expect(error.message).not.toContain(value)
      }
      expect(caller.audits, key).toEqual([])
      f.git('config', '--unset-all', key)
    }
    expect(existsSync(join(f.repo, '.git', 'FETCH_HEAD'))).toBe(false)
    expect(await readdir(f.marks)).toEqual([])
    // Gone again: fetched as before.
    expect((await delivery.state(f.repo)).repoConfig).toBeUndefined()
    await delivery.fetch(f.caller(), { requestId: id() })
  })

  it('counts what the repository’s configuration includes, and its worktree configuration', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const included = join(f.root, 'included.gitconfig')
    await writeFile(included, `[credential]\n\thelper = !${trapCommand(f, 'included')}\n`)
    f.git('config', 'include.path', included)
    expect(await refusal(delivery.fetch(f.caller(), { requestId: id() }))).toMatchObject({
      code: 'git-repo-config',
      details: { kind: 'credential' },
    })
    f.git('config', '--unset', 'include.path')
    f.git('config', 'extensions.worktreeConfig', 'true')
    f.git('config', '--worktree', 'core.sshCommand', trapCommand(f, 'worktree'))
    expect(await refusal(delivery.fetch(f.caller(), { requestId: id() }))).toMatchObject({
      code: 'git-repo-config',
      details: { kind: 'program' },
    })
    expect(await readdir(f.marks)).toEqual([])
  })

  it('refuses a setting written after the plan, right before your Git starts', SLOW, async () => {
    const f = await fixture()
    await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    const delivery = await f.delivery()
    const caller = f.caller({
      // A turn writing the repository's configuration while the fetch is on its way.
      audit: async event => {
        caller.audits.push(event)
        f.git('config', 'core.sshCommand', trapCommand(f, 'late'))
      },
    })
    expect(await refusal(delivery.fetch(caller, { requestId: id() }))).toMatchObject({ code: 'git-repo-config' })
    expect(caller.results).toEqual([{ operation: 'fetch', outcome: 'failed', code: 'git-repo-config' }])
    expect(existsSync(join(f.repo, '.git', 'FETCH_HEAD'))).toBe(false)
  })

  it('honours the same settings in your global configuration, as a terminal does', SLOW, async () => {
    const f = await fixture()
    const fake = await installFakeSsh({ root: f.root, served: f.root, marks: f.marks, git: findGit()! })
    // Your own ssh command, from your global configuration: the fetch goes through it.
    f.gitIn(f.home, 'config', '--global', 'core.sshCommand', join(f.root, 'fake-ssh-bin', 'ssh'))
    f.gitIn(f.home, 'config', '--global', 'http.proxy', 'http://127.0.0.1:9')
    f.gitIn(f.home, 'config', '--global', 'credential.helper', 'cache')
    f.git('remote', 'set-url', 'origin', 'git@example.test:remote.git')
    const tip = await f.upstreamCommit('tracked.txt', 'one\ntwo\n')
    const store = await SessionMetaStore.open(join(f.root, 'data'))
    const delivery = new GitDelivery({
      receipts: store,
      home: f.home,
      hostEnv: { HOME: f.home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: f.root, GIT_CONFIG_NOSYSTEM: '1' },
      shell: fake.shell,
      log: () => {},
    })
    expect((await delivery.state(f.repo)).repoConfig).toBeUndefined()
    await delivery.fetch(f.caller(), { requestId: id() })
    expect(f.git('rev-parse', 'refs/remotes/origin/main')).toBe(tip)
    expect(existsSync(join(f.marks, 'ssh-calls'))).toBe(true)
  })

  it('fetches over plain http only from this computer', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    f.git('remote', 'set-url', 'origin', 'http://example.test/remote.git')
    expect(await refusal(delivery.fetch(f.caller(), { requestId: id() }))).toMatchObject({ code: 'git-remote-form' })
    f.git('remote', 'set-url', 'origin', 'http://127.0.0.1:9/remote.git')
    // Planned and run: nothing listens there.
    expect(await refusal(delivery.fetch(f.caller(), { requestId: id() }))).toMatchObject({ code: 'git-fetch-unreachable' })
  })
})
