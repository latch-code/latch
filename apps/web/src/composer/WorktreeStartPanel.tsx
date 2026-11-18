import { useState } from 'react'

import type { WorktreeBase, WorktreeStart } from '@latch/protocol'
import { Hint, Icon, IconButton, SearchField, SegmentedControl, Spinner, CheckGlyph, ChevronLeftGlyph } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import type { BaseState } from './FolderControl.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    leftover: '残留',
    archived: '已归档',
    checkedOut: '已在另一个工作树检出',
    checkout: (value1: string) => `检出「${value1}」`,
    currentHead: '当前 HEAD',
    commit: (value1: string) => `提交 ${value1}`,
    back: '返回',
    title: '新工作树的起点',
    start: '起点',
    newBranch: '新分支',
    checkoutBranch: '检出分支',
    reuse: '沿用',
    noReusable: '没有可沿用的工作树',
    reuseProject: '沿用这个项目的工作树',
    searchWorktrees: '搜索工作树',
    branchName: '分支名',
    branchOrCommit: '分支名或提交',
    reading: '正在读取分支',
    noMatching: '没有匹配的',
    worktree: '工作树',
    branch: '分支',
    keepFiles: '保留它的文件与改动',
    commitsHere: '提交落在这个分支上',
    newLatchBranch: '新建 latch/ 分支',
    reuseDetail: '沿用这个项目里已归档会话或残留的工作树：文件、分支与未提交的改动保持原样。',
    commitsDetail: 'Agent 的提交直接落在这个分支上。同一个分支不能同时在两个工作树里检出；移除工作树时不删除它。',
    newBranchDetail: '从选中的分支或提交新建一个 latch/ 分支，原分支不变。未提交的改动不会带过去。',
  },
  {
    leftover: 'Left over',
    archived: 'Archived',
    checkedOut: 'Checked out in another worktree',
    checkout: (value1: string) => `Check out “${value1}”`,
    currentHead: 'Current HEAD',
    commit: (value1: string) => `Commit ${value1}`,
    back: 'Back',
    title: 'New worktree start',
    start: 'Start point',
    newBranch: 'New branch',
    checkoutBranch: 'Check out branch',
    reuse: 'Reuse',
    noReusable: 'No reusable worktrees',
    reuseProject: 'Reuse a worktree in this project',
    searchWorktrees: 'Search worktrees',
    branchName: 'Branch name',
    branchOrCommit: 'Branch or commit',
    reading: 'Reading branches',
    noMatching: 'No matching ',
    worktree: 'worktree',
    branch: 'branch',
    keepFiles: 'Keep its files and changes',
    commitsHere: 'Commits land on this branch',
    newLatchBranch: 'Create a latch/ branch',
    reuseDetail:
      'Reuse a worktree from an archived session or one left behind in this project. Its files, branch and uncommitted changes carry over.',
    commitsDetail:
      'The Agent commits directly to this branch. Each branch can be checked out in one worktree at a time. Removing this worktree leaves the branch in place.',
    newBranchDetail:
      'Create a latch/ branch from the selected branch or commit. The original branch stays where it is. Uncommitted changes stay in the current folder.',
  },
)

type Mode = 'new' | 'checkout' | 'reuse'

/** Rows shown at once; the search narrows the rest. */
const SHOWN = 60
const COMMIT = /^[0-9a-f]{7,64}$/u

interface Row {
  key: string
  start: WorktreeStart
  label: string
  meta?: string
  disabledReason?: string
}

function same(a: WorktreeStart | undefined, b: WorktreeStart): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

function rows(mode: Mode, base: WorktreeBase, query: string): Row[] {
  const typed = query.trim()
  const matches = (text: string) => text.toLowerCase().includes(typed.toLowerCase())
  const branches = (base.branches ?? []).filter(branch => matches(branch.name))
  const exact = (base.branches ?? []).some(branch => branch.name === typed)
  if (mode === 'reuse')
    return (base.reusable ?? [])
      .filter(entry => matches(entry.name) || (entry.branch !== undefined && matches(entry.branch)))
      .map(entry => ({
        key: entry.name,
        start: { from: 'reuse', name: entry.name },
        label: entry.name,
        meta: [entry.branch, entry.state === 'leftover' ? COPY.leftover : COPY.archived].filter(Boolean).join(' · '),
      }))
  if (mode === 'checkout')
    return [
      ...branches.map(branch => ({
        key: branch.name,
        start: { from: 'branch', branch: branch.name } as const,
        label: branch.name,
        meta: branch.commit.slice(0, 7),
        ...(branch.checkedOut ? { disabledReason: COPY.checkedOut } : {}),
      })),
      ...(typed && !exact ? [{ key: '\0typed', start: { from: 'branch', branch: typed } as const, label: COPY.checkout(typed) }] : []),
    ]
  return [
    ...(typed
      ? []
      : [{ key: '\0head', start: { from: 'head' } as const, label: COPY.currentHead, meta: base.branch ?? base.commit.slice(0, 7) }]),
    ...branches.map(branch => ({
      key: branch.name,
      start: { from: 'commit', ref: branch.name } as const,
      label: branch.name,
      meta: branch.commit.slice(0, 7),
    })),
    ...(typed && !exact
      ? [
          {
            key: '\0typed',
            start: { from: 'commit', ref: typed } as const,
            label: COMMIT.test(typed) ? COPY.commit(typed) : `「${typed}」`,
          },
        ]
      : []),
  ]
}

/**
 * 其他起点 in the folder menu's layer: a new branch from another local branch or commit, an existing branch checked
 * out, or an earlier worktree of the project reused. Typed names go to the Host as typed; it checks them.
 */
export function WorktreeStartPanel({
  base,
  current,
  onBack,
  onPick,
}: {
  base: BaseState | undefined
  current: WorktreeStart | undefined
  onBack: () => void
  onPick: (start: WorktreeStart) => void
}) {
  const initial: Mode = current?.from === 'branch' ? 'checkout' : current?.from === 'reuse' ? 'reuse' : 'new'
  const [mode, setMode] = useState<Mode>(initial)
  const [query, setQuery] = useState('')
  const ready = base?.state === 'ready' ? base.base : undefined
  const reusable = ready?.reusable?.length ?? 0
  const listed = ready ? rows(mode, ready, query) : []
  return (
    <div className="permission-list worktree-start">
      <header className="permission-list-head">
        <IconButton size="xs" icon={ChevronLeftGlyph} label={COPY.back} onClick={onBack} />
        <span>{COPY.title}</span>
      </header>
      <SegmentedControl<Mode>
        label={COPY.start}
        size="xs"
        value={mode}
        onValueChange={next => {
          setMode(next)
          setQuery('')
        }}
        options={[
          { value: 'new', label: COPY.newBranch },
          { value: 'checkout', label: COPY.checkoutBranch },
          {
            value: 'reuse',
            label: COPY.reuse,
            disabled: reusable === 0,
            title: reusable === 0 ? COPY.noReusable : COPY.reuseProject,
          },
        ]}
      />
      <SearchField
        label={mode === 'reuse' ? COPY.searchWorktrees : mode === 'checkout' ? COPY.branchName : COPY.branchOrCommit}
        value={query}
        onValueChange={setQuery}
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
      />
      {!ready ? (
        <p className="permission-list-note">{base?.state === 'refused' ? base.message : <Spinner size={12} label={COPY.reading} />}</p>
      ) : listed.length === 0 ? (
        <p className="permission-list-note">
          {COPY.noMatching}
          {mode === 'reuse' ? COPY.worktree : COPY.branch}
        </p>
      ) : (
        <div className="worktree-start-list" role="group" aria-label={COPY.start}>
          {listed.slice(0, SHOWN).map(row => {
            const selected = same(current, row.start) || (current === undefined && row.start.from === 'head')
            return (
              <button
                key={row.key}
                type="button"
                className="worktree-start-row"
                aria-pressed={selected}
                aria-disabled={row.disabledReason ? true : undefined}
                title={row.disabledReason}
                onClick={() => {
                  if (!row.disabledReason) onPick(row.start)
                }}>
                <span className="worktree-start-check">{selected && <Icon icon={CheckGlyph} size={14} />}</span>
                <span className="worktree-start-label">
                  <VisibleText text={row.label} />
                </span>
                {(row.disabledReason ?? row.meta) && (
                  <span className="worktree-start-meta">{row.disabledReason ?? <VisibleText text={row.meta!} />}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <Hint label={mode === 'reuse' ? COPY.keepFiles : mode === 'checkout' ? COPY.commitsHere : COPY.newLatchBranch}>
        {mode === 'reuse' ? COPY.reuseDetail : mode === 'checkout' ? COPY.commitsDetail : COPY.newBranchDetail}
      </Hint>
    </div>
  )
}
