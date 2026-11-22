import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { canonicalJson, redactSecrets, sha256Hex } from '@latch/core/node-kit'
import {
  GitDelivery,
  RepositoryHolds,
  deliveryEnvironment,
  readableTail,
  type DeliveryAuditEvent,
  type DeliveryCaller,
  type GitDeliveryOptions,
} from '../src/git-delivery.ts'
import { SessionMetaStore } from '../src/session-meta.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SECRET = 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SLOW = { timeout: 20_000 }

interface Fixture {
  root: string
  repo: string
  home: string
  marks: string
  git: (...args: string[]) => string
  gitIn: (cwd: string, ...args: string[]) => string
  hook: (name: string, body: string, dir?: string) => Promise<void>
  marked: (name: string) => boolean
  delivery: (options?: {
    timeouts?: { commit?: number; push?: number; stage?: number }
    holds?: RepositoryHolds
    git?: string
    receipts?: (store: SessionMetaStore) => GitDeliveryOptions['receipts']
  }) => Promise<GitDelivery>
  caller: (overrides?: Partial<DeliveryCaller>) => DeliveryCaller & { audits: DeliveryAuditEvent[]; results: unknown[] }
  dataDir: string
}

/** A repository with one commit, an empty home, and Hosts' stand-ins: a meta store, the caller's checks and audit. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'latch-git-delivery-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'),
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
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 'tester@example.invalid')
  await writeFile(join(repo, 'tracked.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const stores: SessionMetaStore[] = []
  return {
    root,
    repo,
    home,
    marks,
    dataDir,
    git,
    gitIn,
    async hook(name, body, dir = join(repo, '.git', 'hooks')) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, name), `#!/bin/sh\necho ran >> '${join(marks, name)}'\n${body}\n`)
      await chmod(join(dir, name), 0o755)
    },
    marked: name => existsSync(join(marks, name)),
    async delivery({ receipts: wrap, ...options } = {}) {
      const store = await SessionMetaStore.open(dataDir)
      stores.push(store)
      return new GitDelivery({
        receipts: wrap ? wrap(store) : store,
        home,
        hostEnv: {
          HOME: home,
          USER: 'tester',
          PATH: '/usr/bin:/bin',
          TMPDIR: root,
          LATCH_API_KEY: SECRET,
          LATCH_DATA_DIR: dataDir,
          NODE_OPTIONS: '--inspect',
          GIT_DIR: '/nowhere',
          SSH_ASKPASS: '/bin/echo',
        },
        shell: async () => ({ file: '/bin/sh', argv: ['-sh'] }),
        log: () => {},
        ...options,
      })
    },
    caller(overrides = {}) {
      const audits: DeliveryAuditEvent[] = [],
        results: unknown[] = []
      return {
        sessionId: 'session-1',
        deviceId: 'dev_test',
        folder: repo,
        authorize: async () => {},
        audit: async event => {
          audits.push(event)
        },
        result: async event => {
          results.push(event)
        },
        audits,
        results,
        ...overrides,
      }
    },
  }
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

/** A push receipt left pending by an attempt whose answer was lost, as a Host that stopped mid-push leaves it. */
async function recordPush(
  f: Fixture,
  requestId: string,
  localSha: string,
  extra: { setUpstream?: true; via?: 'upstream' | 'origin' } = {},
): Promise<void> {
  const store = await SessionMetaStore.open(f.dataDir)
  await store.recordGit('session-1', {
    kind: 'git',
    operation: 'push',
    requestId,
    deviceId: 'dev_test',
    payloadHash: sha256Hex(canonicalJson({ kind: 'push' })),
    state: 'pending',
    remote: 'origin',
    ref: 'refs/heads/main',
    localSha,
    via: 'upstream',
    ...extra,
    at: new Date().toISOString(),
  })
  await store.flush()
}

async function receiptOf(f: Fixture, requestId: string) {
  return (await SessionMetaStore.open(f.dataDir)).git('session-1', 'dev_test', requestId)
}

const id = (n: number) => `request-${String(n).padStart(4, '0')}`

describe('git delivery', () => {
  it('lists the status in four groups and reads ahead and behind from local refs only', async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git')
    f.gitIn(f.root, 'init', '-q', '--bare', remote)
    f.git('remote', 'add', 'origin', remote)
    f.git('push', '-q', '-u', 'origin', 'main')
    await writeFile(join(f.repo, 'tracked.txt'), 'two\n')
    f.git('commit', '-q', '-am', 'second')
    await writeFile(join(f.repo, 'staged.txt'), 'new\n')
    f.git('add', 'staged.txt')
    await writeFile(join(f.repo, 'tracked.txt'), 'three\n')
    await mkdir(join(f.repo, 'dir'))
    await writeFile(join(f.repo, 'dir', 'untracked file.txt'), 'u\n')
    const state = await (await f.delivery()).state(f.repo)
    expect(state).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      staged: [{ path: 'staged.txt', status: 'A' }],
      unstaged: [{ path: 'tracked.txt', status: 'M' }],
      untracked: ['dir/untracked file.txt'],
      conflicted: [],
      hooks: [],
      filters: false,
      remote: 'origin',
    })
    expect(state.head).toMatch(/^[0-9a-f]{40}$/u)
    expect(state.running).toBeUndefined()
    // Never fetched: the behind count says nothing, so no time comes with it. Your Git's fetch gives it one.
    expect(state.fetchedAt).toBeUndefined()
    f.git('fetch', '-q', 'origin')
    const fetched = await (await f.delivery()).state(f.repo)
    expect(Date.parse(fetched.fetchedAt ?? '')).toBeGreaterThan(Date.now() - 60_000)
  })

  it(
    'tells a branch pushed without -u from a new one: the remote has it, HEAD is ahead of it, and a push sets the upstream',
    SLOW,
    async () => {
      const f = await fixture()
      const remote = join(f.root, 'remote.git')
      f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
      f.git('remote', 'add', 'origin', remote)
      f.git('checkout', '-q', '-b', 'feature/offline-drafts')
      const delivery = await f.delivery()
      const fresh = await delivery.state(f.repo)
      expect(fresh).toMatchObject({ branch: 'feature/offline-drafts', remote: 'origin', ahead: 0 })
      expect(fresh.upstream).toBeUndefined()
      expect(fresh.remoteBranch).toBeUndefined()

      f.git('push', '-q', 'origin', 'feature/offline-drafts')
      expect((await delivery.state(f.repo)).remoteBranch).toEqual({ name: 'origin/feature/offline-drafts', ahead: 0 })
      await writeFile(join(f.repo, 'draft.txt'), 'draft\n')
      f.git('add', 'draft.txt')
      f.git('commit', '-q', '-m', 'draft')
      const ahead = await delivery.state(f.repo)
      expect(ahead.upstream).toBeUndefined()
      expect(ahead.remoteBranch).toEqual({ name: 'origin/feature/offline-drafts', ahead: 1 })

      expect(await delivery.push(f.caller(), { requestId: id(1) })).toMatchObject({ remote: 'origin', setUpstream: true })
      const tracked = await delivery.state(f.repo)
      expect(tracked).toMatchObject({ upstream: 'origin/feature/offline-drafts', ahead: 0 })
      expect(tracked.remoteBranch).toBeUndefined()
    },
  )

  it('runs no hook, fsmonitor or filter to read, stage without filters and unstage; a commit runs hooks unless skipped', SLOW, async () => {
    const f = await fixture()
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction', 'post-checkout'])
      await f.hook(name, 'exit 0')
    await writeFile(join(f.marks, 'monitor.sh'), `#!/bin/sh\necho ran >> '${join(f.marks, 'fsmonitor')}'\n`)
    await chmod(join(f.marks, 'monitor.sh'), 0o755)
    f.git('config', 'core.fsmonitor', join(f.marks, 'monitor.sh'))
    const delivery = await f.delivery()
    await writeFile(join(f.repo, 'tracked.txt'), 'changed\n')
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    const caller = f.caller()

    const state = await delivery.state(f.repo)
    expect(state.hooks).toEqual(['commit-msg', 'post-checkout', 'post-commit', 'post-index-change', 'pre-commit', 'reference-transaction'])
    expect(await delivery.stage(caller, { requestId: id(1), paths: ['tracked.txt', 'new.txt'] })).toEqual({ files: 2 })
    expect(await delivery.unstage(caller, { requestId: id(2), paths: ['new.txt'] })).toEqual({ files: 1 })
    expect((await delivery.state(f.repo)).staged).toEqual([{ path: 'tracked.txt', status: 'M' }])
    expect(f.marked('fsmonitor')).toBe(false)
    expect(['pre-commit', 'post-index-change', 'reference-transaction'].filter(name => f.marked(name))).toEqual([])

    const skipped = await delivery.commit(caller, { requestId: id(3), message: 'skip hooks', skipHooks: true })
    expect(f.marked('pre-commit')).toBe(false)
    expect(f.marked('commit-msg')).toBe(false)
    expect(f.git('rev-parse', 'HEAD')).toBe(skipped.commit)

    await delivery.stage(caller, { requestId: id(4), paths: ['new.txt'] })
    const made = await delivery.commit(caller, { requestId: id(5), message: 'with hooks\n\nbody' })
    expect(f.marked('pre-commit')).toBe(true)
    expect(f.marked('commit-msg')).toBe(true)
    expect(f.git('log', '-1', '--format=%B')).toBe('with hooks\n\nbody')
    expect(f.git('rev-parse', 'HEAD^')).toBe(skipped.commit)
    expect(made.commit).toBe(f.git('rev-parse', 'HEAD'))
    expect(caller.audits.map(event => event.action)).toEqual(['git.stage', 'git.unstage', 'git.commit', 'git.stage', 'git.commit'])
    expect(caller.audits[2]!.detail).toMatchObject({ hooks: [], skipHooks: true })
    expect(caller.audits[4]!.detail).toMatchObject({ hooks: expect.arrayContaining(['pre-commit', 'commit-msg']), skipHooks: false })
    // Never the message, a path or a hook's output.
    expect(JSON.stringify(caller.audits)).not.toMatch(/with hooks|new\.txt|tracked/u)
  })

  it(
    'gives your Git the terminal environment without Latch secrets, with no prompt, and the message outside its arguments',
    SLOW,
    async () => {
      const f = await fixture()
      await f.hook('pre-commit', `env > '${join(f.marks, 'env')}'\nps -o args= -p $PPID > '${join(f.marks, 'args')}'`)
      const delivery = await f.delivery()
      await writeFile(join(f.repo, 'new.txt'), 'new\n')
      const caller = f.caller()
      await delivery.stage(caller, { requestId: id(1), paths: ['new.txt'] })
      const message = 'a distinctive message 7f3a'
      await delivery.commit(caller, { requestId: id(2), message })
      const env = await readFile(join(f.marks, 'env'), 'utf8')
      expect(env).not.toContain(SECRET)
      expect(env).not.toMatch(/^(?:LATCH_|NODE_OPTIONS|SSH_ASKPASS=|GIT_ASKPASS)/mu)
      expect(env).not.toContain('/nowhere')
      expect(env).toMatch(/^GIT_TERMINAL_PROMPT=0$/mu)
      expect(env).toMatch(/^GCM_INTERACTIVE=never$/mu)
      expect(env).toMatch(/^SSH_ASKPASS_REQUIRE=never$/mu)
      expect(env).toMatch(new RegExp(`^HOME=${f.home}$`, 'mu'))
      const args = await readFile(join(f.marks, 'args'), 'utf8')
      expect(args).toContain('commit')
      expect(args).not.toContain(message)
      // The temporary folder with the message is gone.
      expect(args).toMatch(/--file=\S+/u)
      expect(existsSync(/--file=(\S+)/u.exec(args)![1]!)).toBe(false)
      const built = deliveryEnvironment({
        hostEnv: { HOME: '/h', LATCH_X: '1', NODE_OPTIONS: 'x', ELECTRON_RUN_AS_NODE: '1' },
        shell: '/bin/zsh',
        folder: '/f',
      })
      expect(Object.keys(built).filter(name => /^(?:LATCH_|NODE_|ELECTRON_)/u.test(name))).toEqual([])
      expect(built).toMatchObject({ TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' })
      expect(built.TERM_PROGRAM).toBeUndefined()
    },
  )

  it('stages through your Git, with its filters, only when the configuration names a filter; reading never runs one', SLOW, async () => {
    const f = await fixture()
    await writeFile(join(f.marks, 'clean.sh'), `#!/bin/sh\necho ran >> '${join(f.marks, 'clean')}'\ncat\n`)
    await chmod(join(f.marks, 'clean.sh'), 0o755)
    f.git('config', 'filter.mark.clean', join(f.marks, 'clean.sh'))
    await writeFile(join(f.repo, '.gitattributes'), '*.dat filter=mark\n')
    await writeFile(join(f.repo, 'a.dat'), 'data\n')
    const delivery = await f.delivery()
    const state = await delivery.state(f.repo)
    expect(state.filters).toBe(true)
    expect(f.marked('clean')).toBe(false)
    const caller = f.caller()
    expect(await delivery.stage(caller, { requestId: id(1), paths: ['a.dat', '.gitattributes'] })).toEqual({ files: 2, filtered: true })
    expect(f.marked('clean')).toBe(true)
    expect(caller.audits[0]!.detail).toMatchObject({ filtered: true, files: 2 })
    await rm(join(f.marks, 'clean'))
    expect(await delivery.unstage(caller, { requestId: id(2), paths: ['a.dat'] })).toEqual({ files: 1 })
    await delivery.state(f.repo)
    expect(f.marked('clean')).toBe(false)
  })

  it('refuses paths outside the repository, through a link or inside .git, before anything runs', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'x\n')
    await symlink(outside, join(f.repo, 'link'))
    const delivery = await f.delivery()
    const caller = f.caller()
    for (const path of ['../outside/secret.txt', '/etc/passwd', 'a/../tracked.txt', '.git/config', 'link/secret.txt', 'a//b', '.\\x'])
      expect((await failure(delivery.stage(caller, { requestId: id(1), paths: [path] }))).code, path).toBe('git-paths-invalid')
    expect(caller.audits).toEqual([])
  })

  it('writes the audit record first and runs nothing when it or the caller check fails', SLOW, async () => {
    const f = await fixture()
    await f.hook('pre-commit', 'exit 0')
    const delivery = await f.delivery()
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    f.git('add', 'new.txt')
    const head = f.git('rev-parse', 'HEAD')
    const objects = () => f.git('count-objects', '-v')
    const before = objects()
    const order: string[] = []
    const refused = f.caller({
      authorize: async () => {
        order.push('authorize')
      },
      audit: async () => {
        order.push('audit')
        throw new Error('disk full')
      },
    })
    await expect(delivery.commit(refused, { requestId: id(1), message: 'm' })).rejects.toThrow('disk full')
    expect(order).toEqual(['authorize', 'audit'])
    // Not even the index's tree was written.
    expect(objects()).toBe(before)
    const revoked = f.caller({
      authorize: async () => {
        throw new AppError(403, 'scope-required', 'no')
      },
    })
    expect((await failure(delivery.commit(revoked, { requestId: id(2), message: 'm' }))).code).toBe('scope-required')
    expect((await failure(delivery.push(revoked, { requestId: id(3) }))).code).toBe('git-no-remote')
    expect(revoked.audits).toEqual([])
    expect(f.git('rev-parse', 'HEAD')).toBe(head)
    expect(f.marked('pre-commit')).toBe(false)
    // Neither left a receipt: the same request may run once the record can be written.
    const ok = await delivery.commit(f.caller(), { requestId: id(1), message: 'm' })
    expect(ok.commit).toBe(f.git('rev-parse', 'HEAD'))
  })

  it('reports a failing hook by name with its redacted output, makes no commit and keeps the index', SLOW, async () => {
    const f = await fixture()
    await f.hook('pre-commit', `echo "lint failed near ${SECRET}" >&2\nprintf '\\033[31mred\\033[0m\\n'\nexit 3`)
    expect(redactSecrets(SECRET)).not.toBe(SECRET)
    const delivery = await f.delivery()
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    const caller = f.caller()
    await delivery.stage(caller, { requestId: id(1), paths: ['new.txt'] })
    const head = f.git('rev-parse', 'HEAD')
    const error = await failure(delivery.commit(caller, { requestId: id(2), message: 'nope' }))
    expect(error).toMatchObject({ status: 422, code: 'git-hook-failed', details: { hook: 'pre-commit', exitCode: 3 } })
    const tail = error.details!.tail as string
    expect(tail).toContain('lint failed near')
    expect(tail).toContain('red')
    expect(tail).not.toContain(SECRET)
    expect(tail).not.toContain('\u001b')
    expect(f.git('rev-parse', 'HEAD')).toBe(head)
    expect((await delivery.state(f.repo)).staged).toEqual([{ path: 'new.txt', status: 'A' }])
    // The same request answers the same failure and runs nothing again.
    await rm(join(f.marks, 'pre-commit'))
    expect(await failure(delivery.commit(caller, { requestId: id(2), message: 'nope' }))).toMatchObject({
      code: 'git-hook-failed',
      details: { hook: 'pre-commit', replay: true },
    })
    expect(f.marked('pre-commit')).toBe(false)
    expect(caller.results.at(-1)).toEqual({ operation: 'commit', outcome: 'failed', code: 'git-hook-failed' })
  })

  it('refuses a commit with nothing staged, with conflicts, without an identity, during a merge, and a reused request', async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const caller = f.caller()
    expect((await failure(delivery.commit(caller, { requestId: id(1), message: 'm' }))).code).toBe('git-nothing-staged')
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    f.git('add', 'new.txt')
    f.git('config', 'user.useConfigOnly', 'true')
    f.git('config', '--unset', 'user.email')
    expect((await failure(delivery.commit(caller, { requestId: id(2), message: 'm' }))).code).toBe('git-identity-missing')
    f.git('config', 'user.email', 'tester@example.invalid')
    await writeFile(join(f.repo, '.git', 'MERGE_HEAD'), `${f.git('rev-parse', 'HEAD')}\n`)
    for (const attempt of [
      () => delivery.commit(caller, { requestId: id(3), message: 'm' }),
      () => delivery.stage(caller, { requestId: id(4), paths: ['new.txt'] }),
      () => delivery.unstage(caller, { requestId: id(5), paths: ['new.txt'] }),
      () => delivery.push(caller, { requestId: id(6) }),
    ])
      expect((await failure(attempt())).code).toBe('git-operation-in-progress')
    await rm(join(f.repo, '.git', 'MERGE_HEAD'))
    const done = await delivery.commit(caller, { requestId: id(7), message: 'm' })
    expect((await failure(delivery.commit(caller, { requestId: id(7), message: 'other' }))).code).toBe('request-conflict')
    expect(await delivery.commit(caller, { requestId: id(7), message: 'm' })).toEqual({ commit: done.commit, replay: true })
    expect(caller.audits.map(event => event.action)).toEqual(['git.commit'])
  })

  it('runs one write per repository and shows it, with the hook it is in, to every reader', SLOW, async () => {
    const f = await fixture()
    const gate = join(f.marks, 'gate')
    await f.hook('pre-commit', `while [ ! -e '${gate}' ]; do sleep 0.1; done`)
    const delivery = await f.delivery()
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    f.git('add', 'new.txt')
    const committing = delivery.commit(f.caller(), { requestId: id(1), message: 'slow' })
    await vi.waitFor(
      async () => expect((await delivery.state(f.repo)).running).toMatchObject({ kind: 'commit', requestId: id(1), hook: 'pre-commit' }),
      {
        timeout: 10_000,
      },
    )
    const busy = await failure(delivery.stage(f.caller({ sessionId: 'session-2' }), { requestId: id(2), paths: ['tracked.txt'] }))
    expect(busy).toMatchObject({ code: 'git-busy', details: { running: { kind: 'commit', requestId: id(1) } } })
    // A retry of the same request waits for the same answer.
    const again = delivery.commit(f.caller(), { requestId: id(1), message: 'slow' })
    await writeFile(gate, '')
    const [first, second] = await Promise.all([committing, again])
    expect(second).toEqual(first)
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('2')
    expect((await delivery.state(f.repo)).running).toBeUndefined()
  })

  it('answers a commit stopped by its time limit as unknown, and a retry never runs it again', SLOW, async () => {
    const f = await fixture()
    await f.hook('pre-commit', 'sleep 30')
    const delivery = await f.delivery({ timeouts: { commit: 2_000 } })
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    f.git('add', 'new.txt')
    const caller = f.caller()
    expect(await failure(delivery.commit(caller, { requestId: id(1), message: 'm' }))).toMatchObject({
      status: 504,
      code: 'git-result-unknown',
    })
    expect(caller.results).toEqual([{ operation: 'commit', outcome: 'unknown' }])
    expect(f.marked('pre-commit')).toBe(true)
    await rm(join(f.marks, 'pre-commit'))
    // Git is gone, HEAD has not moved and nothing holds the index: no commit was made, and none is made now.
    await vi.waitFor(() => expect(existsSync(join(f.repo, '.git', 'index.lock'))).toBe(false), { timeout: 10_000 })
    expect((await failure(delivery.commit(caller, { requestId: id(1), message: 'm' }))).code).toBe('git-commit-not-made')
    expect(f.marked('pre-commit')).toBe(false)
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1')
  })

  it(
    'keeps receipts across a Host restart: a done commit replays, an unknown one is found or stays unknown, never amended',
    SLOW,
    async () => {
      const f = await fixture()
      await writeFile(join(f.repo, 'new.txt'), 'new\n')
      f.git('add', 'new.txt')
      const caller = f.caller()
      const made = await (await f.delivery()).commit(caller, { requestId: id(1), message: 'first try' })
      // A new process, reading the same file.
      const restarted = await f.delivery()
      expect(await restarted.commit(caller, { requestId: id(1), message: 'first try' })).toEqual({ commit: made.commit, replay: true })
      expect(f.git('rev-list', '--count', 'HEAD')).toBe('2')

      // A commit whose process ended with the Host: the receipt was still pending when it stopped.
      const preHead = f.git('rev-parse', 'HEAD')
      const tree = f.git('write-tree')
      const store = await SessionMetaStore.open(f.dataDir)
      const { sha256Hex, canonicalJson } = await import('@latch/core/node-kit')
      const pending = (requestId: string, message: string) =>
        store.recordGit('session-1', {
          kind: 'git',
          operation: 'commit',
          requestId,
          deviceId: 'dev_test',
          payloadHash: sha256Hex(canonicalJson({ kind: 'commit', message, skipHooks: false })),
          state: 'pending',
          preHead,
          headRef: 'refs/heads/main',
          indexTree: tree,
          subjectHash: sha256Hex(message),
          at: new Date().toISOString(),
        })
      await pending(id(2), 'made before the stop')
      await pending(id(3), 'never made')
      await store.flush()
      await writeFile(join(f.repo, 'later.txt'), 'later\n')
      f.git('add', 'later.txt')
      f.git('commit', '-q', '-m', 'made before the stop')
      const found = f.git('rev-parse', 'HEAD')
      const after = await f.delivery()
      expect(await after.commit(caller, { requestId: id(2), message: 'made before the stop' })).toEqual({ commit: found, replay: true })
      // Its parent is no longer HEAD: with Git's lock file present the outcome stays unknown, nothing runs.
      f.git('reset', '-q', '--soft', preHead)
      await writeFile(join(f.repo, '.git', 'index.lock'), '')
      expect((await failure(after.commit(caller, { requestId: id(3), message: 'never made' }))).code).toBe('git-result-unknown')
      await rm(join(f.repo, '.git', 'index.lock'))
      expect((await failure(after.commit(caller, { requestId: id(3), message: 'never made' }))).code).toBe('git-commit-not-made')
      expect(f.git('rev-parse', 'HEAD')).toBe(preHead)
      expect(f.git('log', '--format=%s')).not.toContain('never made')
    },
  )

  it('pushes to the upstream or to origin with the upstream set, never forced, and names why a push was refused', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const caller = f.caller()
    expect((await failure(delivery.push(caller, { requestId: id(1) }))).code).toBe('git-no-remote')
    const remote = join(f.root, 'remote.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', remote)
    await f.hook('pre-push', 'exit 0')

    const pushed = await delivery.push(caller, { requestId: id(2) })
    const head = f.git('rev-parse', 'HEAD')
    expect(pushed).toEqual({ remote: 'origin', ref: 'refs/heads/main', sha: head, setUpstream: true })
    expect(f.gitIn(remote, 'rev-parse', 'refs/heads/main')).toBe(head)
    expect(f.git('config', 'branch.main.remote')).toBe('origin')
    expect(f.git('config', 'branch.main.merge')).toBe('refs/heads/main')
    expect(f.marked('pre-push')).toBe(true)
    expect(caller.audits.at(-1)!.detail).toMatchObject({ remote: 'origin', setUpstream: true, localSha: head, hooks: ['pre-push'] })
    expect(JSON.stringify(caller.audits)).not.toContain(remote)
    expect(await delivery.push(caller, { requestId: id(2) })).toMatchObject({ sha: head, replay: true })

    // Someone else pushed first: refused as not a fast-forward, the remote keeps their commit.
    const other = join(f.root, 'other')
    f.gitIn(f.root, 'clone', '-q', remote, other)
    await writeFile(join(other, 'theirs.txt'), 'theirs\n')
    f.gitIn(other, 'add', '.')
    f.gitIn(other, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'theirs')
    f.gitIn(other, 'push', '-q', 'origin', 'main')
    const theirs = f.gitIn(other, 'rev-parse', 'HEAD')
    await writeFile(join(f.repo, 'mine.txt'), 'mine\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'mine')
    expect((await failure(delivery.push(caller, { requestId: id(3) }))).code).toBe('git-push-non-fast-forward')
    expect(f.gitIn(remote, 'rev-parse', 'refs/heads/main')).toBe(theirs)

    // The remote's own hook refuses: its `remote:` lines, redacted, and nothing else Git printed.
    f.git('fetch', '-q', 'origin')
    f.git('reset', '-q', '--hard', theirs)
    await writeFile(join(f.repo, 'again.txt'), 'again\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'again')
    await f.hook('pre-receive', `echo "policy says no ${SECRET}"\nexit 1`, join(remote, 'hooks'))
    const refused = await failure(delivery.push(caller, { requestId: id(4) }))
    expect(refused.code).toBe('git-push-remote-rejected')
    const lines = refused.details!.remoteLines as string[]
    expect(lines.join('\n')).toContain('policy says no')
    expect(lines.join('\n')).not.toContain(SECRET)
    expect(refused.details!.tail).toBeUndefined()
    expect(f.gitIn(remote, 'rev-parse', 'refs/heads/main')).toBe(theirs)

    // A failing pre-push hook is named; detached HEAD is refused.
    await f.hook('pre-push', 'exit 1')
    expect(await failure(delivery.push(caller, { requestId: id(5) }))).toMatchObject({
      code: 'git-hook-failed',
      details: { hook: 'pre-push' },
    })
    f.git('checkout', '-q', '--detach')
    expect((await failure(delivery.push(caller, { requestId: id(6) }))).code).toBe('git-detached')
  })

  it('pushes only to the branch of the same name: the upstream when it is that branch, else the push remote', SLOW, async () => {
    const f = await fixture()
    const up = join(f.root, 'up.git'),
      fork = join(f.root, 'fork.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', up)
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', fork)
    f.git('remote', 'add', 'up', up)
    f.git('remote', 'add', 'mine', fork)
    f.git('push', '-q', '-u', 'up', 'main')
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'b')
    const delivery = await f.delivery()
    const caller = f.caller()
    expect(await delivery.push(caller, { requestId: id(1) })).toEqual({
      remote: 'up',
      ref: 'refs/heads/main',
      sha: f.git('rev-parse', 'HEAD'),
    })
    expect(caller.audits[0]!.detail).toMatchObject({ remote: 'upstream', setUpstream: false })
    const upMain = f.gitIn(up, 'rev-parse', 'main')

    // A branch that tracks up/main: never pushed onto main.
    f.git('checkout', '-q', '-b', 'feature', '--track', 'up/main')
    await writeFile(join(f.repo, 'c.txt'), 'c\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'feature work')
    expect((await failure(delivery.push(caller, { requestId: id(2) }))).code).toBe('git-upstream-other-branch')
    expect(f.gitIn(up, 'rev-parse', 'main')).toBe(upMain)
    expect((await delivery.state(f.repo)).remote).toBeUndefined()

    // With a push remote it goes to that remote's branch of the same name.
    f.git('config', 'branch.feature.pushRemote', 'mine')
    expect((await delivery.state(f.repo)).remote).toBe('mine')
    expect(await delivery.push(caller, { requestId: id(3) })).toEqual({
      remote: 'mine',
      ref: 'refs/heads/feature',
      sha: f.git('rev-parse', 'HEAD'),
    })
    expect(f.gitIn(fork, 'rev-parse', 'feature')).toBe(f.git('rev-parse', 'HEAD'))
    expect(f.gitIn(up, 'rev-parse', 'main')).toBe(upMain)
    expect(caller.audits.at(-1)!.detail).toMatchObject({ remote: 'push-remote', setUpstream: false })
    // One that names no configured remote is refused, as is remote.pushDefault naming none.
    f.git('config', 'branch.feature.pushRemote', 'https://example.invalid/x.git')
    expect((await failure(delivery.push(caller, { requestId: id(4) }))).code).toBe('git-remote-invalid')
    f.git('config', '--unset', 'branch.feature.pushRemote')
    f.git('config', 'remote.pushDefault', 'nowhere')
    expect((await failure(delivery.push(caller, { requestId: id(5) }))).code).toBe('git-remote-invalid')
    f.git('config', '--unset', 'remote.pushDefault')

    // No tag goes along, whatever push.followTags says.
    f.git('checkout', '-q', 'main')
    f.git('config', 'push.followTags', 'true')
    f.git('tag', '-a', '-m', 'tag', 'v1')
    await writeFile(join(f.repo, 'd.txt'), 'd\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'd')
    await delivery.push(caller, { requestId: id(6) })
    expect(f.gitIn(up, 'tag', '--list')).toBe('')

    await rm(up, { recursive: true })
    expect((await failure(delivery.push(caller, { requestId: id(7) }))).code).toBe('git-push-unreachable')
  })

  it('takes a retried push as done when its first attempt landed and the remote moved on since', SLOW, async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', remote)
    f.git('push', '-q', '-u', 'origin', 'main')
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'b')
    const localSha = f.git('rev-parse', 'HEAD')
    // The first attempt landed, its answer was lost, and someone else pushed on top.
    f.git('push', '-q', 'origin', 'main')
    const other = join(f.root, 'other')
    f.gitIn(f.root, 'clone', '-q', remote, other)
    await writeFile(join(other, 'c.txt'), 'c\n')
    f.gitIn(other, 'add', '.')
    f.gitIn(other, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'c')
    f.gitIn(other, 'push', '-q', 'origin', 'main')
    f.git('fetch', '-q', 'origin')
    const store = await SessionMetaStore.open(f.dataDir)
    const { sha256Hex, canonicalJson } = await import('@latch/core/node-kit')
    await store.recordGit('session-1', {
      kind: 'git',
      operation: 'push',
      requestId: id(1),
      deviceId: 'dev_test',
      payloadHash: sha256Hex(canonicalJson({ kind: 'push' })),
      state: 'pending',
      remote: 'origin',
      ref: 'refs/heads/main',
      localSha,
      via: 'upstream',
      at: new Date().toISOString(),
    })
    await store.flush()
    const caller = f.caller()
    expect(await (await f.delivery()).push(caller, { requestId: id(1) })).toEqual({
      remote: 'origin',
      ref: 'refs/heads/main',
      sha: localSha,
    })
    expect(caller.results).toEqual([{ operation: 'push', outcome: 'done', commit: localSha }])
  })

  it(
    'keeps a retried push unknown when the remote moved to a commit it cannot check, or refuses it as not a fast-forward',
    SLOW,
    async () => {
      const f = await fixture()
      const remote = join(f.root, 'remote.git')
      f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
      f.git('remote', 'add', 'origin', remote)
      f.git('push', '-q', '-u', 'origin', 'main')
      const other = join(f.root, 'other')
      f.gitIn(f.root, 'clone', '-q', remote, other)
      const { sha256Hex, canonicalJson } = await import('@latch/core/node-kit')
      const pendingPush = async (requestId: string, localSha: string) => {
        const store = await SessionMetaStore.open(f.dataDir)
        await store.recordGit('session-1', {
          kind: 'git',
          operation: 'push',
          requestId,
          deviceId: 'dev_test',
          payloadHash: sha256Hex(canonicalJson({ kind: 'push' })),
          state: 'pending',
          remote: 'origin',
          ref: 'refs/heads/main',
          localSha,
          via: 'upstream',
          at: new Date().toISOString(),
        })
        await store.flush()
      }
      const theirs = async (name: string) => {
        f.gitIn(other, 'pull', '-q', '--ff-only', 'origin', 'main')
        await writeFile(join(other, name), `${name}\n`)
        f.gitIn(other, 'add', '.')
        f.gitIn(other, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', name)
        f.gitIn(other, 'push', '-q', 'origin', 'main')
        return f.gitIn(other, 'rev-parse', 'HEAD')
      }
      await writeFile(join(f.repo, 'b.txt'), 'b\n')
      f.git('add', '.')
      f.git('commit', '-q', '-m', 'b')
      const landed = f.git('rev-parse', 'HEAD')
      // The first attempt landed; another clone then moved the remote on to a commit this repository has not fetched.
      f.git('push', '-q', 'origin', 'main')
      const tip = await theirs('c.txt')
      await pendingPush(id(1), landed)
      const caller = f.caller()
      const delivery = await f.delivery()
      expect(await failure(delivery.push(caller, { requestId: id(1) }))).toMatchObject({
        status: 504,
        code: 'git-result-unknown',
        details: { remoteSha: tip },
      })
      expect(f.gitIn(remote, 'rev-parse', 'main')).toBe(tip)
      expect(caller.results).toEqual([{ operation: 'push', outcome: 'unknown' }])

      // A commit that never landed, retried after the remote moved on to one this repository knows: the push is
      // refused as not a fast-forward, which on a retry stays unknown rather than failed.
      f.git('fetch', '-q', 'origin')
      await writeFile(join(f.repo, 'd.txt'), 'd\n')
      f.git('add', '.')
      f.git('commit', '-q', '-m', 'd')
      await pendingPush(id(2), f.git('rev-parse', 'HEAD'))
      const again = await f.delivery()
      expect((await failure(again.push(caller, { requestId: id(2) }))).code).toBe('git-result-unknown')
      expect(f.gitIn(remote, 'rev-parse', 'main')).toBe(tip)
    },
  )

  it('answers a retried push from the remote after HEAD was detached, and never with a fresh refusal', SLOW, async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', remote)
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'b')
    const localSha = f.git('rev-parse', 'HEAD')
    // The first attempt (to origin, setting the upstream) landed and its answer was lost; then HEAD was detached.
    f.git('push', '-q', 'origin', 'main')
    await recordPush(f, id(1), localSha, { setUpstream: true, via: 'origin' })
    f.git('checkout', '-q', '--detach')
    // A merge under way refuses writes, but a retry has nothing new to say: it stays unknown, the receipt as it was.
    await writeFile(join(f.repo, '.git', 'MERGE_HEAD'), `${localSha}\n`)
    const caller = f.caller()
    const delivery = await f.delivery()
    expect(await failure(delivery.push(caller, { requestId: id(1) }))).toMatchObject({ status: 504, code: 'git-result-unknown' })
    expect(caller.audits).toEqual([])
    expect((await receiptOf(f, id(1)))?.state).toBe('unknown')
    await rm(join(f.repo, '.git', 'MERGE_HEAD'))
    // Detached: answered from the receipt's target, and the upstream, which needs a branch, is left alone.
    expect(await delivery.push(caller, { requestId: id(1) })).toEqual({ remote: 'origin', ref: 'refs/heads/main', sha: localSha })
    expect(caller.results).toEqual([{ operation: 'push', outcome: 'done', commit: localSha }])
    expect(() => f.git('config', 'branch.main.remote')).toThrow()
    expect(await receiptOf(f, id(1))).toMatchObject({ state: 'done' })
    expect((await receiptOf(f, id(1)))?.setUpstream).toBeUndefined()
    // A new push from a detached HEAD is still refused.
    expect((await failure(delivery.push(caller, { requestId: id(2) }))).code).toBe('git-detached')
  })

  it('keeps a retried push unknown while the remote cannot be reached, and settles it once the remote answers', SLOW, async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git'),
      away = join(f.root, 'away.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', remote)
    f.git('push', '-q', '-u', 'origin', 'main')
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'b')
    const localSha = f.git('rev-parse', 'HEAD')
    // The first attempt landed; then the remote went out of reach: `ls-remote` cannot tell and the push again fails.
    f.git('push', '-q', 'origin', 'main')
    await recordPush(f, id(1), localSha)
    await rename(remote, away)
    const caller = f.caller()
    const delivery = await f.delivery()
    expect(await failure(delivery.push(caller, { requestId: id(1) }))).toMatchObject({ status: 504, code: 'git-result-unknown' })
    expect(caller.results).toEqual([{ operation: 'push', outcome: 'unknown' }])
    expect((await receiptOf(f, id(1)))?.state).toBe('unknown')
    // Reachable again: the remote shows the commit, so the same request is done.
    await rename(away, remote)
    expect(await delivery.push(caller, { requestId: id(1) })).toEqual({ remote: 'origin', ref: 'refs/heads/main', sha: localSha })
    expect((await receiptOf(f, id(1)))?.state).toBe('done')
    expect(await delivery.push(caller, { requestId: id(1) })).toMatchObject({ sha: localSha, replay: true })

    // A first attempt that never landed, retried while `pre-push` refuses: the remote answered without the commit, so
    // the refusal settles it.
    await writeFile(join(f.repo, 'c.txt'), 'c\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'c')
    await recordPush(f, id(2), f.git('rev-parse', 'HEAD'))
    await f.hook('pre-push', 'exit 1')
    const settled = await f.delivery()
    expect((await failure(settled.push(caller, { requestId: id(2) }))).code).toBe('git-hook-failed')
    expect(await receiptOf(f, id(2))).toMatchObject({ state: 'failed', code: 'git-hook-failed' })
    // The same refusal while the remote cannot be reached says nothing about the first attempt.
    await recordPush(f, id(3), f.git('rev-parse', 'HEAD'))
    await rename(remote, away)
    expect((await failure((await f.delivery()).push(caller, { requestId: id(3) }))).code).toBe('git-result-unknown')
    expect((await receiptOf(f, id(3)))?.state).toBe('unknown')
  })

  it('keeps a retried commit unknown when its folder is no longer a repository', SLOW, async () => {
    const f = await fixture()
    const preHead = f.git('rev-parse', 'HEAD')
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    f.git('add', 'new.txt')
    const store = await SessionMetaStore.open(f.dataDir)
    await store.recordGit('session-1', {
      kind: 'git',
      operation: 'commit',
      requestId: id(1),
      deviceId: 'dev_test',
      payloadHash: sha256Hex(canonicalJson({ kind: 'commit', message: 'made', skipHooks: false })),
      state: 'pending',
      preHead,
      headRef: 'refs/heads/main',
      indexTree: f.git('write-tree'),
      subjectHash: sha256Hex('made'),
      at: new Date().toISOString(),
    })
    await store.flush()
    f.git('commit', '-q', '-m', 'made')
    const made = f.git('rev-parse', 'HEAD')
    const delivery = await f.delivery()
    await rename(join(f.repo, '.git'), join(f.root, 'git-away'))
    expect(await failure(delivery.commit(f.caller(), { requestId: id(1), message: 'made' }))).toMatchObject({
      status: 504,
      code: 'git-result-unknown',
    })
    await rename(join(f.root, 'git-away'), join(f.repo, '.git'))
    // On another branch whose HEAD is the old one: the commit may be on the first branch, so not "never made".
    f.git('checkout', '-q', '-b', 'other', preHead)
    expect((await failure(delivery.commit(f.caller(), { requestId: id(1), message: 'made' }))).code).toBe('git-result-unknown')
    f.git('checkout', '-q', 'main')
    expect(await delivery.commit(f.caller(), { requestId: id(1), message: 'made' })).toEqual({ commit: made, replay: true }) // Abandoned on the page, the same commit as a new request: what the first made is no longer staged, so nothing again.
    expect((await failure(delivery.commit(f.caller(), { requestId: id(2), message: 'made' }))).code).toBe('git-nothing-staged')
    expect(f.git('rev-parse', 'HEAD')).toBe(made)
  })

  it('keeps a retried push receipt when its write fails, so the next retry still sends the same commit', SLOW, async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git'),
      away = join(f.root, 'away.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', remote)
    f.git('push', '-q', '-u', 'origin', 'main')
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'b')
    const first = f.git('rev-parse', 'HEAD')
    await recordPush(f, id(1), first)
    await rename(remote, away)
    const unsaved = await f.delivery({
      receipts: store => ({
        git: (...args) => store.git(...args),
        recordGit: async () => {
          throw new Error('disk full')
        },
      }),
    })
    const caller = f.caller()
    expect((await failure(unsaved.push(caller, { requestId: id(1) }))).code).toBe('git-result-unknown')
    expect(await receiptOf(f, id(1))).toMatchObject({ localSha: first, remote: 'origin', ref: 'refs/heads/main' })
    // HEAD moves on; the remote is back. The retry sends the receipt's commit, not the new HEAD.
    await writeFile(join(f.repo, 'c.txt'), 'c\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'c')
    await rename(away, remote)
    expect(await (await f.delivery()).push(caller, { requestId: id(1) })).toMatchObject({ sha: first })
    expect(f.gitIn(remote, 'rev-parse', 'main')).toBe(first)
    // A new request pushes HEAD as any push does: a fast-forward, never forced.
    const head = f.git('rev-parse', 'HEAD')
    expect(await (await f.delivery()).push(caller, { requestId: id(2) })).toMatchObject({ sha: head })
    expect(f.gitIn(remote, 'rev-parse', 'main')).toBe(head)
  })

  it('settles a retried push the remote rejects only when the remote still lacks the commit afterwards', SLOW, async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', remote)
    f.git('push', '-q', '-u', 'origin', 'main')
    const commit = async (name: string) => {
      await writeFile(join(f.repo, name), `${name}\n`)
      f.git('add', '.')
      f.git('commit', '-q', '-m', name)
      return f.git('rev-parse', 'HEAD')
    }
    const caller = f.caller()
    // The server's hook refuses, and the remote still lacks the commit after: failed.
    await f.hook('pre-receive', 'exit 1', join(remote, 'hooks'))
    await recordPush(f, id(1), await commit('b.txt'))
    expect((await failure((await f.delivery()).push(caller, { requestId: id(1) }))).code).toBe('git-push-remote-rejected')
    expect(await receiptOf(f, id(1))).toMatchObject({ state: 'failed', code: 'git-push-remote-rejected' })
    // The first attempt lands while the hook refuses this one (as a slow hook on the first would): done.
    const landing = await commit('c.txt')
    await rm(join(remote, 'hooks', 'pre-receive'))
    f.git('push', '-q', 'origin', `${landing}:refs/heads/side`)
    await f.hook(
      'pre-receive',
      `env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git update-ref refs/heads/main ${landing}\nexit 1`,
      join(remote, 'hooks'),
    )
    await recordPush(f, id(2), landing)
    expect(await (await f.delivery()).push(caller, { requestId: id(2) })).toMatchObject({ sha: landing })
    expect(f.gitIn(remote, 'rev-parse', 'main')).toBe(landing)
    // The branch was locked by another update: never settled, even though the remote lacks the commit.
    await rm(join(remote, 'hooks', 'pre-receive'))
    await writeFile(join(remote, 'refs', 'heads', 'main.lock'), '')
    await recordPush(f, id(3), await commit('d.txt'))
    expect((await failure((await f.delivery()).push(caller, { requestId: id(3) }))).code).toBe('git-result-unknown')
    expect((await receiptOf(f, id(3)))?.state).toBe('unknown')
    await rm(join(remote, 'refs', 'heads', 'main.lock'))
    // The remote answers without the commit and the push cannot reach it: settled as that failure.
    f.git('config', 'remote.origin.receivepack', join(f.root, 'no-such-receive-pack'))
    await recordPush(f, id(4), f.git('rev-parse', 'HEAD'))
    expect((await failure((await f.delivery()).push(caller, { requestId: id(4) }))).code).toBe('git-push-unreachable')
    expect(await receiptOf(f, id(4))).toMatchObject({ state: 'failed', code: 'git-push-unreachable' })
  })

  it('never reads the remote of a retried push by a URL: a different push URL is unsure, and the push runs again', SLOW, async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', join(f.root, 'fetch-only.git'))
    f.git('config', 'remote.origin.pushurl', remote)
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'b')
    const sha = f.git('rev-parse', 'HEAD')
    f.git('push', '-q', 'origin', 'main')
    // Every Git the Host starts, restricted or yours, through a wrapper that records its arguments.
    const argv = join(f.root, 'argv.log'),
      wrapper = join(f.root, 'git-wrapper')
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argv}'\nexec ${execFileSync('/bin/sh', ['-c', 'command -v git']).toString('utf8').trim()} "$@"\n`,
    )
    await chmod(wrapper, 0o755)
    // The push cannot be told from the fetch URL, so it runs again; this time its hook refuses, and it stays unknown.
    await f.hook('pre-push', 'exit 1')
    await recordPush(f, id(1), sha)
    const caller = f.caller()
    expect((await failure((await f.delivery({ git: wrapper })).push(caller, { requestId: id(1) }))).code).toBe('git-result-unknown')
    expect(f.marked('pre-push')).toBe(true)
    // Without the hook it goes through: the same commit, already there.
    await rm(join(f.repo, '.git', 'hooks', 'pre-push'))
    expect(await (await f.delivery({ git: wrapper })).push(caller, { requestId: id(1) })).toMatchObject({ sha })
    const calls = await readFile(argv, 'utf8')
    // Unsure without asking the remote; the push names the remote, never its URL.
    expect(calls).not.toContain('ls-remote')
    expect(calls).toContain('push --porcelain')
    expect(calls).not.toContain(remote)
    // The same URLs, but a pushInsteadOf rewrites where a push goes: unsure too.
    f.git('config', '--unset', 'remote.origin.pushurl')
    f.git('remote', 'set-url', 'origin', remote)
    f.git('config', `url.${remote}.pushInsteadOf`, join(f.root, 'elsewhere.git'))
    await f.hook('pre-push', 'exit 1')
    await recordPush(f, id(2), sha)
    expect((await failure((await f.delivery()).push(caller, { requestId: id(2) }))).code).toBe('git-result-unknown')
  })

  it('lets the caller checks and an update window refuse a retried push, and records the upstream it really sets', SLOW, async () => {
    const f = await fixture()
    const remote = join(f.root, 'remote.git')
    f.gitIn(f.root, 'init', '-q', '--bare', '-b', 'main', remote)
    f.git('remote', 'add', 'origin', remote)
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', '.')
    f.git('commit', '-q', '-m', 'b')
    const sha = f.git('rev-parse', 'HEAD')
    f.git('push', '-q', 'origin', 'main')
    await recordPush(f, id(1), sha, { setUpstream: true, via: 'origin' })
    const denied = f.caller({
      authorize: async () => {
        throw new AppError(403, 'scope-required', 'no')
      },
    })
    expect((await failure((await f.delivery()).push(denied, { requestId: id(1) }))).code).toBe('scope-required')
    const updating = await f.delivery({ holds: new RepositoryHolds({ closed: () => true }) })
    expect((await failure(updating.push(f.caller(), { requestId: id(1) }))).code).toBe('host-updating')
    expect((await receiptOf(f, id(1)))?.state).toBe('unknown')
    // HEAD is on another branch now: done, without writing that branch's upstream, and the audit says so.
    f.git('checkout', '-q', '-b', 'other')
    const caller = f.caller()
    expect(await (await f.delivery()).push(caller, { requestId: id(1) })).toEqual({ remote: 'origin', ref: 'refs/heads/main', sha })
    expect(caller.audits.at(-1)!.detail).toMatchObject({ setUpstream: false })
    expect(() => f.git('config', 'branch.other.remote')).toThrow()
    expect(() => f.git('config', 'branch.main.remote')).toThrow()
  })

  it('settles when Git exits, even when a hook leaves a daemon holding its output, and frees the repository', SLOW, async () => {
    const f = await fixture()
    await f.hook('pre-commit', `/usr/bin/perl -e 'use POSIX; if (fork() == 0) { POSIX::setsid(); sleep 20; exit 0 }'\nexit 0`)
    const delivery = await f.delivery()
    await writeFile(join(f.repo, 'b.txt'), 'b\n')
    f.git('add', 'b.txt')
    const started = Date.now()
    const made = await delivery.commit(f.caller(), { requestId: id(1), message: 'second' })
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(made.commit).toBe(f.git('rev-parse', 'HEAD'))
    expect((await delivery.state(f.repo)).running).toBeUndefined()
  })

  it('makes captured output readable: escapes and progress overwrites resolved, secrets redacted, the end kept', () => {
    expect(readableTail(Buffer.from('\u001b[32mok\u001b[0m\nprogress 10%\rprogress 100%\n'))).toBe('ok\nprogress 100%')
    expect(readableTail(Buffer.from(`x ${SECRET}`))).not.toContain(SECRET)
    expect(readableTail(Buffer.from('abcdef'), 3)).toBe('def')
  })
})
