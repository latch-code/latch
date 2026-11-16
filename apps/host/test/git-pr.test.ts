import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitPrBinding } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { installFakeGh, type FakeGh, type FakeGhState } from '@latch/testkit'
import { GitDelivery, type DeliveryAuditEvent, type DeliveryCaller } from '../src/git-delivery.ts'
import { ghFailure, logExcerpt, LOG_BYTES, readPrList, readPrView, repoOfPr, repoOfUrl } from '../src/git-pr.ts'
import { SessionMetaStore } from '../src/session-meta.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SLOW = { timeout: 30_000 }
const GH_TOKEN = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SECRET = 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const id = (n: number) => `request-${String(n).padStart(4, '0')}`

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

/**
 * A repository on branch `feature`, pushed to a local bare repository that its `origin` names as GitHub through a push
 * URL, a fake `gh` first on the delivery runner's PATH, and a Host environment holding tokens that must not reach `gh`.
 */
async function fixture(
  initial: Partial<FakeGhState> = {},
  options: { url?: string; branch?: string; profile?: Record<string, string> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'latch-git-pr-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'),
    home = join(root, 'home'),
    dataDir = join(root, 'data'),
    bare = join(root, 'remote.git')
  await Promise.all([mkdir(repo), mkdir(home), mkdir(dataDir)])
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && name !== 'GIT_CONFIG_NOSYSTEM') delete env[name]
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim()
  const git = (...args: string[]) => gitIn(repo, ...args)
  gitIn(root, 'init', '-q', '--bare', '-b', 'main', bare)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 'tester@example.invalid')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  git('remote', 'add', 'origin', options.url ?? 'https://github.com/acme/widgets.git')
  git('config', 'remote.origin.pushurl', bare)
  git('push', '-q', '-u', 'origin', 'main')
  const branch = options.branch ?? 'feature'
  git('switch', '-q', '-c', branch)
  await writeFile(join(repo, 'a.txt'), 'two\n')
  git('commit', '-q', '-am', 'Add the currency filter')
  git('push', '-q', '-u', 'origin', branch)
  const gh = await installFakeGh(join(root, 'gh'), { headSha: git('rev-parse', 'HEAD'), ...initial }, options.profile)
  cleanups.push(async () => {
    expect(await gh.violations()).toEqual([])
  })
  const bindings = new Map<string, GitPrBinding>()
  let store: SessionMetaStore | undefined
  const delivery = async (timeouts: { prCreate?: number } = {}) => {
    store ??= await SessionMetaStore.open(dataDir)
    return new GitDelivery({
      receipts: store,
      prs: {
        get: sessionId => bindings.get(sessionId),
        bind: async (sessionId, pr) => {
          bindings.set(sessionId, pr)
        },
        unbind: async sessionId => {
          bindings.delete(sessionId)
        },
      },
      home,
      hostEnv: {
        HOME: home,
        USER: 'tester',
        PATH: '/usr/bin:/bin',
        TMPDIR: root,
        GH_TOKEN,
        GITHUB_TOKEN: GH_TOKEN,
        GH_ENTERPRISE_TOKEN: GH_TOKEN,
        LATCH_API_KEY: SECRET,
      },
      shell: gh.shell,
      timeouts,
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
  return { root, repo, dataDir, git, gh, bindings, delivery, caller }
}

const creates = async (gh: FakeGh) => (await gh.calls()).filter(args => args[0] === 'pr' && args[1] === 'create')
const input = { title: 'Add the currency filter', body: 'Closes #4\n\n- filter\n', base: 'main' }

describe('the pull request step', () => {
  it('reads repositories from the remote URL forms Git takes, and nothing else', () => {
    expect(repoOfUrl('https://github.com/acme/widgets.git')?.full).toBe('github.com/acme/widgets')
    expect(repoOfUrl('git@github.com:acme/widgets.git')?.full).toBe('github.com/acme/widgets')
    expect(repoOfUrl('ssh://git@github.com:22/acme/widgets')?.full).toBe('github.com/acme/widgets')
    expect(repoOfUrl('git@github.com-work:acme/widgets.git')?.full).toBe('github.com/acme/widgets')
    expect(repoOfUrl('https://user@ghe.example.com/team/app')?.full).toBe('ghe.example.com/team/app')
    for (const url of [
      '/srv/remote.git',
      'file:///srv/remote.git',
      'https://github.com/acme',
      'https://github.com/a/b/c',
      'https://github.com/-x/../y',
      '',
    ])
      expect(repoOfUrl(url), url).toBeUndefined()
    expect(repoOfPr('https://github.com/acme/widgets/pull/12')).toMatchObject({ number: 12, repo: { full: 'github.com/acme/widgets' } })
    expect(repoOfPr('https://github.com/acme/widgets/pull/12?x=1')).toBeUndefined()
  })

  it('tells a missing gh, a logged-out gh, an unknown repository and an unreachable GitHub apart', () => {
    expect(ghFailure({ code: 127, stderr: 'sh: line 0: exec: gh: not found' }).code).toBe('gh-missing')
    expect(ghFailure({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }).code).toBe('gh-logged-out')
    expect(ghFailure({ code: 1, stderr: 'HTTP 401: Bad credentials' }).code).toBe('gh-logged-out')
    expect(ghFailure({ code: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'a/b'." }).code).toBe('gh-no-remote')
    expect(ghFailure({ code: 1, stderr: 'dial tcp: lookup api.github.com: no such host' }).code).toBe('gh-unreachable')
    expect(ghFailure({ code: 1, stderr: 'a pull request for branch "x" into branch "main" already exists' }, true).code).toBe(
      'pr-exists-elsewhere',
    )
    const refused = ghFailure({ code: 1, stderr: `GraphQL: No commits between main and x (createPullRequest) ${SECRET}` }, true)
    expect(refused.code).toBe('pr-create-failed')
    expect(String(refused.details?.tail)).toContain('No commits between')
    expect(String(refused.details?.tail)).not.toContain(SECRET)
  })

  it('maps checks to pass, fail, pending and skipped, and offers the log of a failed Actions job only', () => {
    const view = readPrView(
      JSON.stringify({
        number: 3,
        url: 'https://github.com/acme/widgets/pull/3',
        title: 'T\u001b[31m',
        state: 'OPEN',
        isDraft: true,
        reviewDecision: 'CHANGES_REQUESTED',
        headRefOid: 'a'.repeat(40),
        headRefName: 'feature',
        baseRefName: 'main',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
          {
            __typename: 'CheckRun',
            name: 'test',
            workflowName: 'CI',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/11/job/22',
          },
          { __typename: 'CheckRun', name: 'deploy', status: 'IN_PROGRESS', conclusion: '' },
          { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
          { __typename: 'Something' },
        ],
      }),
      repoOfUrl('https://github.com/acme/widgets')!,
    )
    expect(view.pr).toMatchObject({ number: 3, title: 'T', draft: true, reviewDecision: 'changes-requested', state: 'open' })
    expect(view.checks.map(check => [check.name, check.state, check.job])).toEqual([
      ['lint', 'pass', undefined],
      ['test', 'fail', '22'],
      ['deploy', 'pending', undefined],
      ['docs', 'skipped', undefined],
      ['ci/legacy', 'fail', undefined],
    ])
  })

  it('cuts a failed log to its last 200 lines and 32 KiB, without control sequences or secrets', () => {
    const lines = Array.from({ length: 400 }, (_, n) => `test\tRun tests\t2026-11-12T10:00:00.0000000Z line ${n}`)
    lines.push(`test\tRun tests\t2026-11-12T10:00:01.0000000Z \u001b[31m##[error]expected 1, received 2 ${SECRET}\u001b[0m`)
    const excerpt = logExcerpt(lines.join('\n'))
    const kept = excerpt.text.split('\n')
    expect(kept).toHaveLength(200)
    expect(excerpt.truncated).toBe(true)
    expect(kept.at(-1)).toMatch(/^error: expected 1, received 2 /u)
    expect(excerpt.text).not.toContain(SECRET)
    expect(excerpt.text).not.toContain('\u001b')
    expect(excerpt.text).not.toContain('2026-11-12T')
    const wide = logExcerpt(Array.from({ length: 100 }, () => 'x'.repeat(1000)).join('\n'))
    expect(Buffer.byteLength(wide.text)).toBeLessThanOrEqual(LOG_BYTES)
    expect(wide.truncated).toBe(true)
  })

  it('creates a pull request through your gh, audited first, with the body in a file and no token anywhere', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const caller = f.caller()
    const result = await delivery.createPr(caller, { requestId: id(1), ...input, draft: true })
    expect(result).toEqual({ pr: { number: 1, url: 'https://github.com/acme/widgets/pull/1', base: 'main', head: 'feature' } })
    expect(f.bindings.get('session-1')).toEqual(result.pr)
    const [create] = await creates(f.gh)
    expect(create).toEqual(
      expect.arrayContaining(['--repo', 'github.com/acme/widgets', '--head=feature', '--base=main', `--title=${input.title}`, '--draft']),
    )
    // The body travels in a 0600 file, never as an argument.
    expect(create!.join(' ')).not.toContain('Closes #4')
    expect(await f.gh.bodies()).toEqual([input.body])
    expect((await f.gh.calls()).flat()).not.toContain('token')
    expect(caller.audits.map(event => event.action)).toEqual(['git.pr.create'])
    expect(caller.audits[0]!.detail).toMatchObject({ draft: true })
    expect(JSON.stringify(caller.audits)).not.toMatch(/Closes|currency|feature|acme/u)
    expect(caller.results).toEqual([{ operation: 'pr', outcome: 'done', number: 1 }])

    // The same request again: the receipt answers, gh does not run.
    const calls = (await f.gh.calls()).length
    expect(await delivery.createPr(caller, { requestId: id(1), ...input, draft: true })).toMatchObject({ replay: true, pr: { number: 1 } })
    expect((await f.gh.calls()).length).toBe(calls)
    expect((await failure(delivery.createPr(caller, { requestId: id(1), ...input }))).code).toBe('request-conflict')
  })

  it('binds the open pull request of the branch instead of making a second one', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    await delivery.createPr(f.caller(), { requestId: id(1), ...input })
    f.bindings.clear()
    const caller = f.caller()
    const again = await delivery.createPr(caller, { requestId: id(2), ...input, title: 'Another title' })
    expect(again).toEqual({ pr: expect.objectContaining({ number: 1 }), linked: true })
    expect(await creates(f.gh)).toHaveLength(1)
    expect(caller.audits.map(event => event.action)).toEqual(['git.pr.link'])
    expect(caller.audits[0]!.detail).toMatchObject({ number: 1 })
    expect(f.bindings.get('session-1')?.number).toBe(1)
  })

  it('looks the branch up again when a creation’s result is unknown, and does not make it twice', SLOW, async () => {
    const f = await fixture({ createDelayMs: 20_000 })
    const delivery = await f.delivery({ prCreate: 1_500 })
    const caller = f.caller()
    expect((await failure(delivery.createPr(caller, { requestId: id(1), ...input }))).code).toBe('git-result-unknown')
    expect(f.bindings.size).toBe(0)
    expect(caller.results).toEqual([{ operation: 'pr', outcome: 'unknown' }])
    const retry = await delivery.createPr(caller, { requestId: id(1), ...input })
    expect(retry).toEqual({ pr: expect.objectContaining({ number: 1, head: 'feature' }), replay: true })
    expect(await creates(f.gh)).toHaveLength(1)
    expect(f.bindings.get('session-1')?.number).toBe(1)
  })

  it('refuses before anything runs: logged out, gh missing, no GitHub remote, branch not pushed, audit not written', SLOW, async () => {
    const f = await fixture({ loggedIn: false })
    const delivery = await f.delivery()
    const caller = f.caller()
    expect((await failure(delivery.createPr(caller, { requestId: id(1), ...input }))).code).toBe('gh-logged-out')
    expect((await failure(delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: true, title: true }))).code).toBe(
      'gh-logged-out',
    )
    await f.gh.setMissing(true)
    expect((await failure(delivery.createPr(caller, { requestId: id(2), ...input }))).code).toBe('gh-missing')
    await f.gh.setMissing(false)
    await f.gh.update(state => {
      state.loggedIn = true
    })
    expect(caller.audits).toEqual([])

    const refusing = f.caller({
      audit: async () => {
        throw new Error('audit down')
      },
    })
    await expect(delivery.createPr(refusing, { requestId: id(3), ...input })).rejects.toThrow('audit down')
    expect(await creates(f.gh)).toHaveLength(0)

    f.git('switch', '-q', '-c', 'local-only')
    expect((await failure(delivery.createPr(caller, { requestId: id(4), ...input }))).code).toBe('pr-not-pushed')
    f.git('remote', 'set-url', 'origin', join(f.root, 'remote.git'))
    const calls = (await f.gh.calls()).length
    expect((await failure(delivery.createPr(caller, { requestId: id(5), ...input }))).code).toBe('gh-no-remote')
    expect((await failure(delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: false, title: false }))).code).toBe(
      'gh-no-remote',
    )
    expect((await f.gh.calls()).length).toBe(calls)
    expect((await failure(delivery.createPr(caller, { requestId: id(6), ...input, title: 'two\nlines' }))).code).toBe('pr-input-invalid')
    expect((await failure(delivery.createPr(caller, { requestId: id(7), ...input, base: '--exec=x' }))).code).toBe('pr-input-invalid')
  })

  it('makes no pull request with nothing to merge: from the base into itself, or with no commit the base lacks', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const caller = f.caller()
    expect((await delivery.state(f.repo)).base).toEqual({ name: 'main', ahead: 1 })
    f.git('switch', '-q', 'main')
    expect((await delivery.state(f.repo)).base).toEqual({ name: 'main', ahead: 0 })
    expect((await failure(delivery.createPr(caller, { requestId: id(1), ...input }))).code).toBe('pr-nothing-ahead')
    f.git('switch', '-q', '-c', 'same')
    f.git('push', '-q', '-u', 'origin', 'same')
    expect((await delivery.state(f.repo)).base).toEqual({ name: 'main', ahead: 0 })
    expect((await failure(delivery.createPr(caller, { requestId: id(2), ...input }))).code).toBe('pr-nothing-ahead')
    expect(await creates(f.gh)).toHaveLength(0)
    expect(caller.audits).toEqual([])
  })

  it('reads the bound pull request, its checks, reviews and comments, and a failed job’s log', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const before = await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: true, title: true })
    expect(before).toEqual({ checks: [], draft: { title: 'Add the currency filter', base: 'main' } })
    expect(
      (await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: false, title: false })).draft?.title,
    ).toBeUndefined()
    await delivery.createPr(f.caller(), { requestId: id(1), ...input })
    await f.gh.update(state => {
      const pr = state.prs[0]!
      pr.reviewDecision = 'CHANGES_REQUESTED'
      pr.statusCheckRollup = [
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        {
          __typename: 'CheckRun',
          name: 'test (node 24)',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/7/job/42',
        },
      ]
      pr.reviews = [
        { author: { login: 'rev' }, state: 'CHANGES_REQUESTED', body: 'Round JPY to 0 decimals.', submittedAt: '2026-11-12T10:02:00Z' },
      ]
      pr.comments = [{ author: { login: 'pat' }, body: 'Looks close.', createdAt: '2026-11-12T10:01:00Z' }]
      pr.lineComments = [
        { user: { login: 'rev' }, path: 'src/a.ts', line: 18, body: `unused ${SECRET}`, created_at: '2026-11-12T10:03:00Z' },
      ]
      state.logs['42'] =
        `test (node 24)\tRun tests\t2026-11-12T10:00:00.0000000Z FAIL rounds JPY\ntest (node 24)\tRun tests\t2026-11-12T10:00:00.0000000Z token ${SECRET}`
    })
    const state = await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: true, title: true })
    expect(state.pr).toMatchObject({ number: 1, reviewDecision: 'changes-requested', headSha: f.git('rev-parse', 'HEAD') })
    expect(state.checks.map(check => [check.name, check.state, check.job])).toEqual([
      ['lint', 'pass', undefined],
      ['test (node 24)', 'fail', '42'],
    ])
    expect(state.discussion?.map(item => [item.kind, item.author, item.review, item.path, item.line])).toEqual([
      ['comment', 'pat', undefined, undefined, undefined],
      ['review', 'rev', 'changes-requested', undefined, undefined],
      ['line', 'rev', undefined, 'src/a.ts', 18],
    ])
    expect(JSON.stringify(state)).not.toContain(SECRET)
    // A device without the files' scope: no discussion, and gh is not asked for it.
    const calls = (await f.gh.calls()).length
    const narrow = await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: false, title: false })
    expect(narrow.discussion).toBeUndefined()
    expect((await f.gh.calls()).slice(calls).flat().join(' ')).not.toMatch(/reviews|comments/u)

    const log = await delivery.checkLog({ sessionId: 'session-1', folder: f.repo, job: '42' })
    expect(log).toEqual({ name: 'test (node 24)', text: expect.stringContaining('[Run tests]\nFAIL rounds JPY') })
    expect(log.text).not.toContain(SECRET)
    // Only a failed job of the bound pull request's checks.
    expect((await failure(delivery.checkLog({ sessionId: 'session-1', folder: f.repo, job: '99' }))).code).toBe('pr-check-not-found')
    expect((await failure(delivery.checkLog({ sessionId: 'session-2', folder: f.repo, job: '42' }))).code).toBe('pr-check-not-found')
  })

  it('never runs gh against a host that is not GitHub, and keeps a profile’s enterprise token from gh', SLOW, async () => {
    expect(repoOfUrl('https://github.com-evil.attacker.dev/o/r')?.host).toBe('github.com-evil.attacker.dev')
    expect(repoOfUrl('https://github.com:443/o/r')?.full).toBe('github.com/o/r')
    const where = repoOfUrl('https://github.com/acme/widgets')!
    const list = JSON.stringify([
      { number: 9, url: 'https://github.com/victim/private/pull/9', headRefName: 'feature', baseRefName: 'main', isCrossRepository: false },
      {
        number: 3,
        url: 'https://github.com/acme/widgets/pull/3',
        headRefName: 'feature',
        baseRefName: 'm'.repeat(300),
        isCrossRepository: false,
      },
    ])
    // The other repository's is not this branch's; the second exists but its base is too long to keep.
    expect(readPrList(list, 'feature', where)).toEqual({ open: [], exists: true })
    const job = (url: string) =>
      readPrView(
        JSON.stringify({
          number: 1,
          url: 'https://github.com/acme/widgets/pull/1',
          state: 'OPEN',
          headRefName: 'f',
          baseRefName: 'main',
          statusCheckRollup: [{ __typename: 'CheckRun', name: 't', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: url }],
        }),
        where,
      ).checks[0]!.job
    expect(job('https://github.com/acme/widgets/actions/runs/1/job/2')).toBe('2')
    expect(job('https://github.com/victim/private/actions/runs/1/job/2')).toBeUndefined()

    const enterprise = { GH_ENTERPRISE_TOKEN: GH_TOKEN, GITHUB_ENTERPRISE_TOKEN: GH_TOKEN, GH_HOST: 'git.attacker.dev' }
    const f = await fixture({}, { url: 'https://git.attacker.dev/acme/widgets.git', profile: enterprise })
    const delivery = await f.delivery()
    const caller = f.caller()
    expect((await failure(delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: true, title: true }))).code).toBe(
      'gh-no-remote',
    )
    expect((await failure(delivery.createPr(caller, { requestId: id(1), ...input }))).code).toBe('gh-no-remote')
    // Only `gh auth status --hostname`, which prints no token; nothing else ran against the host.
    expect((await f.gh.calls()).every(args => args.join(' ') === 'auth status --hostname git.attacker.dev')).toBe(true)
    expect(caller.audits).toEqual([])
  })

  it('runs gh against a GitHub Enterprise Server only once gh has a login for it', SLOW, async () => {
    const f = await fixture(
      { hosts: ['ghe.corp.example'], repo: 'ghe.corp.example/acme/widgets' },
      { url: 'git@ghe.corp.example:acme/widgets.git' },
    )
    const delivery = await f.delivery()
    expect(await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: false, title: false })).toEqual({
      checks: [],
      draft: { base: 'main' },
    })
    expect((await f.gh.calls()).map(args => args.slice(0, 2).join(' '))).toEqual(['auth status', 'repo view'])
  })

  it('refuses a branch the metadata could not hold, and never writes metadata it could not read back', SLOW, async () => {
    const branch = `${'x'.repeat(150)}/${'y'.repeat(150)}`
    const f = await fixture({}, { branch })
    const delivery = await f.delivery()
    const caller = f.caller()
    expect((await failure(delivery.createPr(caller, { requestId: id(1), ...input }))).code).toBe('pr-input-invalid')
    expect(caller.audits).toEqual([])
    expect(await f.gh.calls()).toEqual([])
    const store = await SessionMetaStore.open(f.dataDir)
    const bad = { number: 1, url: 'https://github.com/acme/widgets/pull/1', base: 'main', head: branch }
    await expect(store.update('session-1', current => ({ ...current, pr: bad }))).rejects.toMatchObject({ code: 'session-meta-invalid' })
    await store.update('session-1', current => ({ ...current, title: 'still fine' }))
    expect((await SessionMetaStore.open(f.dataDir)).get('session-1')).toEqual({ title: 'still fine' })
  })

  it('substitutes only whole placeholder arguments: a title holding =BODY reaches gh as typed', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    const title = 'Allow a=BODY and b=MESSAGE --body-file=BODY'
    await delivery.createPr(f.caller(), { requestId: id(1), ...input, title })
    const [create] = await creates(f.gh)
    expect(create).toContain(`--title=${title}`)
    expect(create!.filter(arg => arg.startsWith('--body-file=')).length).toBe(1)
    expect(create!.join(' ')).not.toContain(f.root)
  })

  it('lists the newest line comments, says when older ones were left out, and maps a gone log to pr-check-not-found', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    await delivery.createPr(f.caller(), { requestId: id(1), ...input })
    await f.gh.update(state => {
      const pr = state.prs[0]!
      pr.lineComments = Array.from({ length: 130 }, (_, n) => ({
        user: { login: 'rev' },
        path: 'a.ts',
        line: n + 1,
        body: `note ${n}`,
        created_at: `2026-11-12T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`,
      }))
      pr.statusCheckRollup = [
        {
          __typename: 'CheckRun',
          name: 'test',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/7/job/42',
        },
      ]
    })
    const state = await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: true, title: true })
    expect(state.discussionCapped).toBe(true)
    expect(state.discussion).toHaveLength(100)
    expect(state.discussion!.at(-1)!.body).toBe('note 129')
    expect(state.discussion![0]!.body).toBe('note 30')
    expect((await failure(delivery.checkLog({ sessionId: 'session-1', folder: f.repo, job: '42' }))).code).toBe('pr-check-not-found')
  })

  it('lets the next push make a new pull request once the bound one is merged', SLOW, async () => {
    const f = await fixture()
    const delivery = await f.delivery()
    await delivery.createPr(f.caller(), { requestId: id(1), ...input })
    await f.gh.update(state => {
      state.prs[0]!.state = 'MERGED'
    })
    // Merged, nothing new pushed: still bound.
    expect((await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: false, title: false })).pr?.state).toBe('merged')
    await writeFile(join(f.repo, 'a.txt'), 'three\n')
    f.git('commit', '-q', '-am', 'More')
    f.git('push', '-q')
    const next = await delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: false, title: true })
    expect(next).toEqual({ checks: [], draft: { title: 'More', base: 'main' } })
    expect(f.bindings.size).toBe(0)
    expect((await delivery.createPr(f.caller(), { requestId: id(2), ...input })).pr.number).toBe(2)
  })

  for (const [base, bound] of [
    ['release@2', true],
    ['发布/v2', true],
    ['b'.repeat(300), false],
  ] as const)
    it(`never makes a second pull request when one is open into ${base.length > 20 ? 'a 300-character base' : base}`, SLOW, async () => {
      const f = await fixture()
      await f.gh.update(state => {
        state.prs.push({
          number: 7,
          url: 'https://github.com/acme/widgets/pull/7',
          title: 'Earlier',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: '',
          headRefName: 'feature',
          baseRefName: base,
          headRefOid: null,
          isCrossRepository: false,
          statusCheckRollup: [],
          reviews: [],
          comments: [],
          lineComments: [],
        })
      })
      const delivery = await f.delivery()
      const caller = f.caller()
      const attempt = delivery.createPr(caller, { requestId: id(1), ...input })
      if (bound) {
        expect(await attempt).toEqual({
          pr: { number: 7, url: 'https://github.com/acme/widgets/pull/7', base, head: 'feature' },
          linked: true,
        })
        expect(caller.audits.map(event => event.action)).toEqual(['git.pr.link'])
        // What was bound is what the metadata takes.
        const store = await SessionMetaStore.open(f.dataDir)
        await store.update('session-1', current => ({ ...current, pr: f.bindings.get('session-1')! }))
      } else {
        expect((await failure(attempt)).code).toBe('pr-exists-elsewhere')
        expect(caller.audits).toEqual([])
      }
      expect(await creates(f.gh)).toHaveLength(0)
    })

  it('says logged out, not "not GitHub", when an Enterprise Server login has expired', SLOW, async () => {
    const f = await fixture(
      { hosts: ['ghe.corp.example'], expiredHosts: ['ghe.corp.example'], repo: 'ghe.corp.example/acme/widgets' },
      { url: 'git@ghe.corp.example:acme/widgets.git' },
    )
    const delivery = await f.delivery()
    expect((await failure(delivery.prState({ sessionId: 'session-1', folder: f.repo, discussion: false, title: false }))).code).toBe(
      'gh-logged-out',
    )
  })
})
