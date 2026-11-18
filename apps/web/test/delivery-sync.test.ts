import { describe, expect, it } from 'vitest'
import type { GitDeliveryState } from '@latch/protocol'
import {
  abortable,
  abortReason,
  conflictPrompt,
  diverged,
  divergedPrompt,
  failureCopy,
  failureDetails,
  fetchReason,
  operationNote,
  pullReason,
  REASON,
  RUNNING_WORD,
  type WriteLimits,
} from '../src/panel/delivery/model.ts'
import { cloneCopy, cloneProgress } from '../src/settings/clone.ts'

const state = (extra: Partial<GitDeliveryState> = {}): GitDeliveryState => ({
  branch: 'main',
  head: 'a'.repeat(40),
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  fetchedAt: '2026-11-17T08:00:00.000Z',
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  hooks: [],
  filters: false,
  remote: 'origin',
  ...extra,
})
const free: WriteLimits = { offline: false, canWrite: true, readOnly: false, busy: false, turnRunning: false }

describe('获取 and 拉取', () => {
  it('can always fetch with somewhere to fetch from, even during a turn or an operation, since only refs change', () => {
    expect(fetchReason(state(), free)).toBeUndefined()
    expect(fetchReason(state({ gitOperation: 'merge' }), { ...free, turnRunning: true })).toBeUndefined()
    expect(fetchReason(state({ remote: undefined, upstream: undefined }), free)).toBe(REASON.noRemote)
    expect(fetchReason(state(), { ...free, offline: true })).toBe(REASON.offline)
    expect(fetchReason(state(), { ...free, canWrite: false })).toBe(REASON.permission)
    expect(fetchReason(state(), { ...free, busy: true })).toBe(REASON.busy)
  })

  it('pulls only with an upstream, after a fetch, and never on a branch that diverged, with one reason each', () => {
    expect(pullReason(state({ behind: 2 }), free)).toBeUndefined()
    expect(pullReason(state({ fetchedAt: undefined }), free)).toBe(REASON.notFetched)
    expect(pullReason(state({ ahead: 1, behind: 2 }), free)).toBe(REASON.diverged)
    expect(pullReason(state({ branch: undefined }), free)).toBe(REASON.detached)
    expect(pullReason(state({ upstream: undefined }), free)).toBe(REASON.noUpstream)
    expect(pullReason(state({ upstream: undefined, remote: undefined }), free)).toBe(REASON.noRemote)
    expect(pullReason(state({ gitOperation: 'rebase' }), free)).toBe('变基进行中')
    expect(pullReason(state({ filters: true }), free)).toBe(REASON.drivers)
    // The pull rewrites the work tree: an Agent's turn there comes first.
    expect(pullReason(state(), { ...free, turnRunning: true })).toBe(REASON.turn)
    expect(diverged(state({ ahead: 1, behind: 1 }))).toBe(true)
    expect(diverged(state({ ahead: 1, behind: 1, fetchedAt: undefined }))).toBe(false)
  })

  it('hands a diverged branch to the Agent as a question, never as a silent merge or rebase', () => {
    const text = divergedPrompt({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3 })
    expect(text).toContain('2 个上游没有的提交')
    expect(text).toContain('上游有 3 个')
    expect(text).toContain('先问我')
    expect(text).toContain('不要强制推送')
    expect(failureCopy('git-pull-diverged')?.label).toBe(REASON.diverged)
    expect(failureDetails({ ahead: 2, behind: 3 })).toMatchObject({ ahead: 2, behind: 3 })
  })
})

describe('冲突 and 中止', () => {
  it('offers to abort a known operation, and says where the terminal is still needed', () => {
    expect(abortable(state({ gitOperation: 'merge' }))).toBe('merge')
    expect(abortable(state({ gitOperation: 'unmerged' }))).toBeUndefined()
    expect(abortable(state())).toBeUndefined()
    expect(abortReason(state({ gitOperation: 'merge' }), free)).toBeUndefined()
    expect(abortReason(state({ gitOperation: 'merge', filters: true }), free)).toBe(REASON.drivers)
    expect(abortReason(state({ gitOperation: 'merge' }), { ...free, turnRunning: true })).toBe(REASON.turn)
    expect(operationNote('merge', true)).toBe('合并进行中')
    expect(operationNote('merge')).toBe('合并进行中，在终端里完成')
  })

  it('puts the conflicted paths in a fence the paths cannot close, with the command that finishes the operation', () => {
    const text = conflictPrompt({ operation: 'rebase', paths: ['src/a.ts', 'docs/```odd.md'], more: 3 })
    expect(text).toContain('````text\nsrc/a.ts\ndocs/```odd.md\n````')
    expect(text).toContain('还有 3 个')
    expect(text).toContain('git rebase --continue')
    expect(text).toContain('不要中止')
  })

  it('names each new write while it runs', () => {
    expect([RUNNING_WORD.fetch, RUNNING_WORD.pull, RUNNING_WORD.abort]).toEqual(['获取中…', '拉取中…', '中止中…'])
  })
})

describe('克隆仓库', () => {
  it('says each reason in short words, with the fine print for the hover', () => {
    expect(cloneCopy('clone-url-credentials').label).toBe('地址里带有凭据')
    expect(cloneCopy('clone-url-credentials').detail).toContain('凭据管理工具')
    expect(cloneCopy('clone-folder-exists').label).toBe('这个位置已有同名文件夹')
    expect(cloneCopy('anything-else').label).toBe('克隆失败')
    expect(cloneProgress({ progress: { phase: 'receiving', percent: 45 } })).toBe('接收中 45%')
    expect(cloneProgress({ progress: { phase: 'connecting' } })).toBe('连接中')
    expect(cloneProgress({})).toBe('克隆中')
  })
})

describe('仓库自己的配置', () => {
  it('turns 获取 and 拉取 off with the kind of setting, never its value', () => {
    const risky = state({ repoConfig: 'program', behind: 1 })
    expect(fetchReason(risky, free)).toBe('仓库配置里有会运行程序的设置')
    expect(pullReason(risky, free)).toBe('仓库配置里有会运行程序的设置')
    expect(fetchReason(state({ repoConfig: 'rewrite' }), free)).toBe('仓库配置里有地址改写（insteadOf）')
    expect(failureDetails({ kind: 'proxy' }).repoKind).toBe('proxy')
    expect(failureDetails({ kind: 'value-or-anything' }).repoKind).toBeUndefined()
    expect(failureCopy('git-repo-config')?.tone).toBe('warn')
  })
})
