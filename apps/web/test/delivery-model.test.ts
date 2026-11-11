import { describe, expect, it } from 'vitest'
import type { GitDeliveryState } from '@latch/protocol'
import { launcherRows } from '../src/panel/PanelLauncher.tsx'
import {
  canPush,
  deliveryStep,
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

  it('puts 交付 in the launcher after 文件, without a key', () => {
    expect(launcherRows({ changes: true, files: true, delivery: true }).map(row => [row.label, row.letter])).toEqual([
      ['改动', 'D'],
      ['文件', 'F'],
      ['交付', undefined],
    ])
  })
})
