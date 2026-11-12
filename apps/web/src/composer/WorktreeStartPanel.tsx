import { useState } from 'react'

import type { WorktreeBase, WorktreeStart } from '@latch/protocol'
import { Hint, Icon, IconButton, SearchField, SegmentedControl, Spinner, CheckGlyph, ChevronLeftGlyph } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import type { BaseState } from './FolderControl.tsx'

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
        meta: [entry.branch, entry.state === 'leftover' ? '残留' : '已归档'].filter(Boolean).join(' · '),
      }))
  if (mode === 'checkout')
    return [
      ...branches.map(branch => ({
        key: branch.name,
        start: { from: 'branch', branch: branch.name } as const,
        label: branch.name,
        meta: branch.commit.slice(0, 7),
        ...(branch.checkedOut ? { disabledReason: '已在另一个工作树检出' } : {}),
      })),
      ...(typed && !exact ? [{ key: '\0typed', start: { from: 'branch', branch: typed } as const, label: `检出「${typed}」` }] : []),
    ]
  return [
    ...(typed
      ? []
      : [{ key: '\0head', start: { from: 'head' } as const, label: '当前 HEAD', meta: base.branch ?? base.commit.slice(0, 7) }]),
    ...branches.map(branch => ({
      key: branch.name,
      start: { from: 'commit', ref: branch.name } as const,
      label: branch.name,
      meta: branch.commit.slice(0, 7),
    })),
    ...(typed && !exact
      ? [{ key: '\0typed', start: { from: 'commit', ref: typed } as const, label: COMMIT.test(typed) ? `提交 ${typed}` : `「${typed}」` }]
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
        <IconButton size="xs" icon={ChevronLeftGlyph} label="返回" onClick={onBack} />
        <span>新工作树的起点</span>
      </header>
      <SegmentedControl<Mode>
        label="起点"
        size="xs"
        value={mode}
        onValueChange={next => {
          setMode(next)
          setQuery('')
        }}
        options={[
          { value: 'new', label: '新分支' },
          { value: 'checkout', label: '检出分支' },
          {
            value: 'reuse',
            label: '沿用',
            disabled: reusable === 0,
            title: reusable === 0 ? '没有可沿用的工作树' : '沿用这个项目的工作树',
          },
        ]}
      />
      <SearchField
        label={mode === 'reuse' ? '搜索工作树' : mode === 'checkout' ? '分支名' : '分支名或提交'}
        value={query}
        onValueChange={setQuery}
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
      />
      {!ready ? (
        <p className="permission-list-note">{base?.state === 'refused' ? base.message : <Spinner size={12} label="正在读取分支" />}</p>
      ) : listed.length === 0 ? (
        <p className="permission-list-note">没有匹配的{mode === 'reuse' ? '工作树' : '分支'}</p>
      ) : (
        <div className="worktree-start-list" role="group" aria-label="起点">
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
      <Hint label={mode === 'reuse' ? '保留它的文件与改动' : mode === 'checkout' ? '提交落在这个分支上' : '新建 latch/ 分支'}>
        {mode === 'reuse'
          ? '沿用这个项目里已归档会话或残留的工作树：文件、分支与未提交的改动保持原样。'
          : mode === 'checkout'
            ? 'Agent 的提交直接落在这个分支上。同一个分支不能同时在两个工作树里检出；移除工作树时不删除它。'
            : '从选中的分支或提交新建一个 latch/ 分支，原分支不变。未提交的改动不会带过去。'}
      </Hint>
    </div>
  )
}
