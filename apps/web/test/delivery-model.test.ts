import { describe, expect, it } from 'vitest'
import type { GitDeliveryState } from '@latch/protocol'
import { panelChoices } from '../src/panel/panelTabs.ts'
import {
  canPush,
  checkDuration,
  checkExcerpt,
  checksStale,
  checksSummary,
  commentExcerpt,
  commentPlace,
  deliveryStep,
  aheadBehind,
  nothingToMerge,
  prAvailable,
  failureCopy,
  failureDetails,
  fenceFor,
  groupRows,
  hookExcerpt,
  hooksDetail,
  operationNote,
  primaryAction,
  runningLabel,
  stageAllPaths,
  unknownAfter,
  writeEnd,
} from '../src/panel/delivery/model.ts'

const state = (extra: Partial<GitDeliveryState> = {}): GitDeliveryState => ({
  branch: 'main',
  head: 'a'.repeat(40),
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  hooks: [],
  filters: false,
  remote: 'origin',
  ...extra,
})

describe('the delivery tab', () => {
  it('says behind only as of the last fetch, with its time, and never 已是最新 without one', () => {
    expect(aheadBehind(state({ behind: 0 }))).toBe('已推送')
    expect(aheadBehind(state({ behind: 3 }))).toBe('已推送')
    expect(aheadBehind(state({ ahead: 2, behind: 3 }))).toBe('领先 2')
    const now = new Date('2026-11-16T09:00:00.000Z')
    const fetched = { fetchedAt: '2026-11-16T08:55:00.000Z' }
    expect(aheadBehind(state({ ...fetched }), now)).toBe('已是最新 · 5 分钟前拉取')
    expect(aheadBehind(state({ ...fetched, ahead: 2, behind: 3 }), now)).toBe('领先 2 · 落后 3 · 5 分钟前拉取')
    expect(aheadBehind(state({ fetchedAt: '2026-10-01T08:00:00.000Z' }), now)).toBe('已是最新 · 10/01 拉取')
    expect(aheadBehind(state({ upstream: undefined }))).toBe('新分支')
  })
  it('moves the one blue button from 暂存全部 to 提交 N 个文件 to 推送', () => {
    const changed = state({ unstaged: [{ path: 'a.ts', status: 'M' }], untracked: ['b.ts'], conflicted: ['c.ts'] })
    expect(deliveryStep(changed)).toBe('stage')
    expect(primaryAction(changed)).toEqual({ kind: 'stage', label: '暂存全部', paths: ['a.ts', 'b.ts', 'c.ts'] })
    const staged = state({
      staged: [
        { path: 'a.ts', status: 'M' },
        { path: 'd.ts', status: 'A' },
      ],
      untracked: ['b.ts'],
    })
    expect(deliveryStep(staged)).toBe('commit')
    expect(primaryAction(staged)).toEqual({ kind: 'commit', label: '提交 2 个文件' })
    expect(primaryAction(state({ ahead: 3 }))).toEqual({ kind: 'push', label: '推送 3 个提交' })
    // A branch the remote does not have yet: ahead is 0 without an upstream, and the push creates it.
    expect(primaryAction(state({ upstream: undefined }))).toEqual({ kind: 'push', label: '推送' })
    expect(deliveryStep(state())).toBe('done')
    expect(primaryAction(state())).toBeUndefined()
  })

  it('puts 推送 next on the phone right after a commit, while the files left out wait for a quieter button', () => {
    const leftOut = state({ ahead: 1, untracked: ['scratch.txt'] })
    expect(primaryAction(leftOut)).toMatchObject({ kind: 'stage' })
    expect(primaryAction(leftOut, { bound: true, justCommitted: true })).toEqual({ kind: 'push', label: '推送 1 个提交' })
    // Nowhere to push, or something staged again: the usual order.
    expect(
      primaryAction(state({ ahead: 1, untracked: ['x'], remote: undefined, upstream: undefined }), { bound: true, justCommitted: true }),
    ).toMatchObject({
      kind: 'stage',
    })
    expect(primaryAction(state({ ahead: 1, staged: [{ path: 'a.ts', status: 'M' }] }), { bound: true, justCommitted: true })).toMatchObject(
      {
        kind: 'commit',
      },
    )
  })

  it('offers a push only with a branch, a commit and a remote', () => {
    expect(canPush(state({ ahead: 1 }))).toBe(true)
    expect(canPush(state({ ahead: 1, remote: undefined, upstream: undefined }))).toBe(false)
    expect(canPush(state({ ahead: 1, branch: undefined }))).toBe(false)
    expect(canPush(state({ head: undefined, upstream: undefined }))).toBe(false)
    expect(primaryAction(state({ remote: undefined, upstream: undefined }))).toBeUndefined()
  })

  it('stages each path once, and lists a partly staged file in both groups', () => {
    const both = state({ staged: [{ path: 'a.ts', status: 'M' }], unstaged: [{ path: 'a.ts', status: 'M' }], conflicted: ['a.ts'] })
    expect(stageAllPaths(both)).toEqual(['a.ts'])
    expect(groupRows(both, 'staged')).toEqual([{ path: 'a.ts', word: '修改', staged: true }])
    expect(groupRows(both, 'unstaged')).toEqual([{ path: 'a.ts', word: '修改', staged: false }])
    expect(
      groupRows(
        state({
          unstaged: [
            { path: 'l', status: 'T' },
            { path: 'd', status: 'D' },
          ],
        }),
        'unstaged',
      ).map(row => row.word),
    ).toEqual(['类型变化', '删除'])
    expect(groupRows(state({ untracked: ['n'] }), 'untracked')[0]?.word).toBe('未跟踪')
  })

  it('names the running write and its hook', () => {
    expect(runningLabel({ kind: 'commit', hook: 'pre-commit' })).toBe('提交中… pre-commit')
    expect(runningLabel({ kind: 'push' })).toBe('推送中…')
  })

  it('says each fixed reason in a few words; no remote is not a failure', () => {
    expect(failureCopy('git-no-remote')).toEqual({ label: '没有远端，提交留在本地', tone: 'neutral' })
    expect(failureCopy('git-turn-running')?.label).toBe('Agent 正在改这个文件夹')
    expect(failureCopy('host-updating')?.label).toBe('这台电脑正在安装更新')
    expect(failureCopy('git-upstream-other-branch')).toMatchObject({ label: '上游是另一个分支', tone: 'neutral' })
    expect(failureCopy('git-push-remote-rejected')?.tone).toBe('failed')
    expect(failureCopy('git-operation-in-progress', 'rebase')?.label).toBe('变基进行中，在终端里完成')
    expect(operationNote(undefined)).toBe('合并/变基进行中，在终端里完成')
    expect(operationNote('unmerged')).toBe('合并/变基进行中，在终端里完成')
    // Drawn in their own way: the hook card and result unknown.
    expect(failureCopy('git-hook-failed')).toBeUndefined()
    expect(failureCopy('git-result-unknown')).toBeUndefined()
  })

  it('never takes host-updating as a failure, and keeps a pending request ID through it', () => {
    const pending = { kind: 'push', requestId: 'r-unknown' }
    // A first attempt during an install: refused, nothing changes, and the next press is a new request.
    const first = { kind: 'commit', requestId: 'r-new' }
    expect(writeEnd({ code: 'host-updating', uncertain: false })).toBe('updating')
    expect(unknownAfter(undefined, first, 'updating')).toBeUndefined()
    expect(unknownAfter(pending, first, 'updating')).toBe(pending)
    // The retry of an unknown result stays unknown, with the same request ID.
    expect(unknownAfter(pending, pending, 'updating')).toBe(pending)
    expect(writeEnd({ code: 'git-result-unknown', uncertain: true })).toBe('unknown')
    expect(unknownAfter(pending, pending, 'unknown')).toBe(pending)
    // Settled either way, the retry lets go of it; another write's answer does not.
    expect(unknownAfter(pending, pending, 'done')).toBeUndefined()
    expect(unknownAfter(pending, pending, 'failed')).toBeUndefined()
    expect(unknownAfter(pending, first, 'failed')).toBe(pending)
    expect(writeEnd({ code: 'git-push-auth', uncertain: false })).toBe('failed')
  })

  it('settles a retried commit, push or PR only on an answer from its receipt or the remote', () => {
    const after = (kind: 'commit' | 'push' | 'pr', input: { code?: string; uncertain?: boolean; replay?: boolean }) => {
      const pending = { kind, requestId: `r-${kind}` }
      const { replay = false, ...rest } = input
      return unknownAfter(pending, pending, writeEnd({ uncertain: false, ...rest, retry: { kind, replay } })) === pending
    }
    for (const kind of ['commit', 'push', 'pr'] as const) {
      // Refusals that say nothing about the first attempt: a route's 400, 403 or 429, a session check, a Host that did
      // not record or is closing, a network error, an update window.
      for (const code of [
        'invalid-input',
        'scope-required',
        'file-scope',
        'agent-scope-required',
        'rate-limited',
        'task-not-found',
        'session-read-only',
        'workspace-changed',
        'git-receipt-unsaved',
        'host-closing',
      ])
        expect(after(kind, { code })).toBe(true)
      expect(after(kind, { uncertain: true })).toBe(true)
      expect(after(kind, { code: 'git-result-unknown', uncertain: true })).toBe(true)
      expect(after(kind, { code: 'host-updating' })).toBe(true)
      // The receipt's answer lets go of it.
      expect(after(kind, { code: kind === 'commit' ? 'git-commit-not-made' : 'git-push-failed', replay: true })).toBe(false)
    }
    // A push failure the Host settles after reading the remote, and a PR it looked up first.
    expect(after('push', { code: 'git-push-remote-rejected' })).toBe(false)
    expect(after('push', { code: 'git-push-unreachable' })).toBe(false)
    expect(after('commit', { code: 'git-push-unreachable' })).toBe(true)
    expect(after('pr', { code: 'pr-create-failed' })).toBe(false)
    expect(after('pr', { code: 'gh-logged-out' })).toBe(true)
    // A first attempt's refusal is a failure as before.
    expect(writeEnd({ code: 'rate-limited', uncertain: false })).toBe('failed')
  })

  it('reads only the details it knows from a refusal', () => {
    expect(
      failureDetails({
        hook: 'pre-commit',
        exitCode: 1,
        tail: 'x',
        remoteLines: ['remote: no', 3],
        running: { kind: 'push', requestId: 'r1', startedAt: 't', hook: 'pre-push' },
        other: true,
      }),
    ).toEqual({
      hook: 'pre-commit',
      exitCode: 1,
      tail: 'x',
      remoteLines: ['remote: no'],
      running: { kind: 'push', requestId: 'r1', startedAt: 't', hook: 'pre-push' },
    })
    expect(failureDetails({ running: { kind: 'push' } })).toEqual({})
  })

  it('fences the hook output so nothing in it can close the fence, keeping only its end', () => {
    expect(fenceFor('plain')).toBe('```')
    expect(fenceFor('a ```` b')).toBe('`````')
    const excerpt = hookExcerpt({ hook: 'pre-commit', exitCode: 1, tail: 'lint failed\n```\nmore\n' })
    expect(excerpt).toBe('提交钩子 pre-commit 没通过，退出码 1，没有生成提交：\n\n````text\nlint failed\n```\nmore\n````')
    const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
    const cut = hookExcerpt({ tail: long, push: true })
    expect(cut.startsWith('推送前的钩子 pre-push 没通过，没有推送：')).toBe(true)
    expect(cut).toContain('line 199')
    expect(cut).not.toContain('line 119\n')
  })

  it('lists the hooks and the filters, and says whose account runs them', () => {
    expect(hooksDetail({ hooks: ['pre-commit', 'pre-push'], filters: true })).toBe(
      '仓库的钩子：pre-commit、pre-push。仓库配置了 filter 驱动（如 Git LFS），暂存与提交时照常运行。提交与推送以你在这台电脑上的账户运行，用你的凭据，与在终端里相同；这不是沙箱。',
    )
    expect(hooksDetail({ hooks: [], filters: false })).toMatch(/^仓库里没有可执行的钩子。提交与推送以你/u)
  })

  it('puts 交付 in the panel’s 「+」 after 改动, with P', () => {
    expect(panelChoices({ changes: true, files: true, delivery: true }).map(row => [row.label, row.letter])).toEqual([
      ['文件', 'F'],
      ['改动', 'D'],
      ['交付', 'P'],
    ])
  })

  it('adds PR after the push: 创建 PR is the blue button until a pull request is bound', () => {
    expect(prAvailable(state())).toBe(true)
    expect(prAvailable(state({ upstream: undefined }))).toBe(false)
    expect(prAvailable(state({ upstream: 'origin/other' }))).toBe(false)
    expect(deliveryStep(state(), { bound: false })).toBe('pr')
    expect(primaryAction(state(), { bound: false })).toEqual({ kind: 'pr', label: '创建 PR' })
    expect(deliveryStep(state(), { bound: true })).toBe('done')
    // Commits not pushed come first; a branch the remote does not have yet is pushed before any PR.
    expect(deliveryStep(state({ ahead: 1 }), { bound: false })).toBe('push')
    expect(deliveryStep(state({ upstream: undefined }), { bound: false })).toBe('push')
    // Nothing to merge: on the base branch itself, or no commit the base lacks. No 创建 PR is offered.
    expect(nothingToMerge(state({ base: { name: 'main', ahead: 0 } }))).toBe(true)
    expect(deliveryStep(state({ base: { name: 'main', ahead: 0 } }), { bound: false })).toBe('done')
    // A bound pull request still shows once its branch is merged into the base.
    expect(prAvailable(state({ base: { name: 'main', ahead: 0 } }))).toBe(true)
    expect(primaryAction(state({ branch: 'feat', upstream: 'origin/feat', base: { name: 'main', ahead: 0 } }), { bound: false })).toBe(
      undefined,
    )
    expect(deliveryStep(state({ branch: 'feat', upstream: 'origin/feat', base: { name: 'main', ahead: 2 } }), { bound: false })).toBe('pr')
  })

  it('sums up checks, marks those of another commit 旧提交, and times finished ones', () => {
    const check = (state: 'pass' | 'fail' | 'pending' | 'skipped') => ({ name: state, state })
    expect(checksSummary([])).toBeUndefined()
    expect(checksSummary([check('skipped')])).toBeUndefined()
    expect(checksSummary([check('pass'), check('skipped')])).toBe('pass')
    expect(checksSummary([check('pass'), check('pending')])).toBe('pending')
    expect(checksSummary([check('pending'), check('fail')])).toBe('fail')
    expect(checksStale({ headSha: 'a'.repeat(40) }, 'a'.repeat(40))).toBe(false)
    expect(checksStale({ headSha: 'a'.repeat(40) }, 'b'.repeat(40))).toBe(true)
    expect(checksStale({}, 'b'.repeat(40))).toBe(false)
    expect(checkDuration({ startedAt: '2026-11-12T10:00:00Z', completedAt: '2026-11-12T10:01:12Z' })).toBe('1:12')
    expect(checkDuration({ startedAt: '2026-11-12T10:00:00Z', completedAt: '2026-11-12T11:00:05Z' })).toBe('1:00:05')
    expect(checkDuration({ startedAt: '2026-11-12T10:00:00Z' })).toBeUndefined()
  })

  it('says gh missing, logged out and other platforms in short words, with the terminal command behind the Hint', () => {
    expect(failureCopy('gh-missing')).toMatchObject({ label: '没有 gh', tone: 'warn' })
    expect(failureCopy('gh-logged-out')).toEqual({ label: 'gh 未登录', tone: 'warn', detail: '在终端里运行 gh auth login。' })
    expect(failureCopy('gh-no-remote')).toMatchObject({ label: '这个远端不是 GitHub', tone: 'neutral', detail: '其他平台的 PR 尚未实现。' })
    for (const code of ['gh-unreachable', 'gh-failed', 'pr-exists-elsewhere', 'pr-not-pushed', 'pr-create-failed', 'pr-check-not-found'])
      expect(failureCopy(code), code).toBeDefined()
  })

  it('puts a failed check or a comment into the draft fenced, with the check name, the author and the place', () => {
    expect(checkExcerpt({ number: 12, check: 'test (node 24)', sha: 'abcdef1234567', text: 'FAIL a\n```\nb\n' })).toBe(
      'PR #12 的检查 test (node 24) 失败（abcdef1）：\n\n````text\nFAIL a\n```\nb\n````',
    )
    const line = { kind: 'line' as const, author: 'rev', path: 'src/a.ts', line: 18, body: 'unused import' }
    expect(commentPlace(line)).toBe('src/a.ts:18')
    expect(commentExcerpt({ number: 12, comment: line })).toBe('PR #12 · rev · src/a.ts:18：\n\n```text\nunused import\n```')
    expect(commentPlace({ kind: 'review', review: 'changes-requested' })).toBe('要求修改')
    expect(commentPlace({ kind: 'comment' })).toBe('评论')
    expect(commentExcerpt({ number: 3, comment: { kind: 'review', author: 'pat', review: 'approved', body: '' } })).toContain(
      '（没有正文）',
    )
  })
})
