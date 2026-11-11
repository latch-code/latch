import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, FolderGit2 } from 'lucide-react'
import type { WorkspaceInfo, WorktreeBase, WorktreeStart } from '@latch/protocol'
import { MenuFooterLink, ValuePicker } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { BriefHint } from './BriefHint.tsx'
import { BranchSegment, StatusSegment } from './ComposerStatus.tsx'
import { WorktreeStartPanel } from './WorktreeStartPanel.tsx'

type Where = 'folder' | 'worktree'

/** Where a new worktree would start, as the Host last said, or why it cannot make one. */
export type BaseState = { state: 'reading' } | { state: 'ready'; base: WorktreeBase } | { state: 'refused'; message: string }

export const HEAD_START: WorktreeStart = { from: 'head' }

const WORKTREE_COPY = {
  folder: '当前文件夹',
  worktree: '新工作树',
  folderLine: '直接在项目文件夹里改',
  uncommitted: '不带未提交的改动',
  otherStart: '其他起点…',
  /** A worktree separates files only: ports, processes and this computer's permissions stay shared (no isolation implied). */
  shared: { label: '工作树只分开文件', detail: '端口、进程和这台电脑上的权限仍然共用。' },
} as const

/** 从 main 的 3f2a1c9; a detached HEAD has no branch to name. */
export function baseWords(base: WorktreeBase): string {
  const commit = base.commit.slice(0, 7)
  return base.branch ? `从 ${base.branch} 的 ${commit}` : `从 ${commit}`
}

/** Where a start point begins, in a few words: 从 feature/x、检出 feature/x、沿用 20261112-ab12. */
export function startWords(start: WorktreeStart, base: WorktreeBase | undefined): string | undefined {
  switch (start.from) {
    case 'head':
      return base && baseWords(base)
    case 'commit': {
      const branch = base?.branches?.find(item => item.name === start.ref)
      return branch ? `从 ${branch.name} 的 ${branch.commit.slice(0, 7)}` : `从 ${start.ref}`
    }
    case 'branch':
      return `检出 ${start.branch}`
    case 'reuse':
      return `沿用 ${start.name}`
  }
}

/** Reads the base each time it is asked for, so the menu shows HEAD as it is now; a reply for another project is dropped. */
function useWorktreeBase(projectId: string) {
  const [held, setHeld] = useState<{ projectId: string; base: BaseState }>()
  const asked = useRef(0)
  const base = held?.projectId === projectId ? held.base : undefined
  const read = useCallback(() => {
    const ask = ++asked.current
    const settle = (next: BaseState) => {
      if (asked.current === ask) setHeld({ projectId, base: next })
    }
    setHeld(previous =>
      previous?.projectId === projectId && previous.base.state === 'ready' ? previous : { projectId, base: { state: 'reading' } },
    )
    void api<WorktreeBase>(`workspaces/${encodeURIComponent(projectId)}/worktree`).then(
      reply => {
        settle({ state: 'ready', base: reply })
      },
      (cause: unknown) => {
        settle({ state: 'refused', message: errorMessage(cause) })
      },
    )
  }, [projectId])
  return { base, read }
}

/**
 * What stays behind, then where it starts; a refusal says only why, as the item's reason. The line is one line
 * that ends in an ellipsis, so the warning goes first and a long branch name is what gets cut. A reused worktree keeps
 * what it has, so it has no warning.
 */
function worktreeLine(base: BaseState | undefined, start: WorktreeStart): string | undefined {
  if (base?.state === 'refused') return undefined
  const words = startWords(start, base?.state === 'ready' ? base.base : undefined)
  if (start.from === 'reuse') return words
  // The warning first: a long branch name is what the ellipsis cuts, never the warning.
  return `${WORKTREE_COPY.uncommitted} · ${words ?? '正在读取分支…'}`
}

/**
 * 当前文件夹 / 新工作树, for a new session in a Git project. The second says where it starts and that uncommitted
 * changes stay behind; a project where the Host cannot make one has it disabled with the Host's reason. With `starts`,
 * 其他起点… picks another branch or commit, an existing branch to check out, or a worktree to reuse.
 */
export function FolderControl({
  project,
  worktree,
  onWorktree,
  disabled,
  variant = 'inline',
  branch,
  starts = false,
}: {
  project: WorkspaceInfo
  /** In the status line: the project's branch, shown while the session would start in the project folder. */
  branch?: string | undefined
  worktree: WorktreeStart | undefined
  onWorktree: (worktree: WorktreeStart | undefined) => void
  disabled: boolean
  variant?: 'inline' | 'row'
  /** Offers start points other than the folder's HEAD. */
  starts?: boolean
}) {
  const { base, read } = useWorktreeBase(project.id)
  const [choosing, setChoosing] = useState(false)
  // Picked earlier: the base is shown beside it, so it is read without opening the menu.
  const picked = worktree !== undefined
  useEffect(() => {
    if (picked) read()
  }, [picked, read])
  const value: Where = picked ? 'worktree' : 'folder'
  const start = worktree ?? HEAD_START
  const line = worktreeLine(base, start)
  const picker = (
    <ValuePicker<Where>
      label="文件夹"
      variant={variant}
      {...(variant === 'row' ? { className: 'new-sheet-row' } : { size: 'xs' as const })}
      leading={picked ? FolderGit2 : Folder}
      value={value}
      disabled={disabled}
      width={360}
      align="start"
      onOpenChange={open => {
        if (open) read()
        else setChoosing(false)
      }}
      options={[
        { value: 'folder', label: WORKTREE_COPY.folder, description: WORKTREE_COPY.folderLine },
        {
          value: 'worktree',
          label: WORKTREE_COPY.worktree,
          ...(line ? { description: escapeHiddenCharacters(line) } : {}),
          ...(base?.state === 'refused' ? { disabledReason: base.message } : {}),
        },
      ]}
      footer={
        <>
          {starts && base?.state !== 'refused' && (
            <MenuFooterLink
              onClick={() => {
                setChoosing(true)
              }}>
              {WORKTREE_COPY.otherStart}
            </MenuFooterLink>
          )}
          <BriefHint brief={WORKTREE_COPY.shared} className="model-note" />
        </>
      }
      panel={
        choosing ? (
          <WorktreeStartPanel
            base={base}
            current={worktree}
            onBack={() => {
              setChoosing(false)
            }}
            onPick={next => {
              setChoosing(false)
              onWorktree(next)
            }}
          />
        ) : undefined
      }
      onValueChange={next => {
        // Choosing 新工作树 again keeps the start point picked under 其他起点….
        onWorktree(next === 'worktree' ? (worktree ?? HEAD_START) : undefined)
      }}
    />
  )
  if (variant === 'row') return picker
  // In the status line: the choice is the folder segment, and the branch segment says where a new worktree starts.
  const words = picked ? startWords(start, base?.state === 'ready' ? base.base : undefined) : undefined
  return (
    <>
      <StatusSegment kind="folder">{picker}</StatusSegment>
      {picked && words && (start.from !== 'head' || base?.state === 'ready') ? (
        <BranchSegment branch={words} base />
      ) : (
        !picked && branch && <BranchSegment branch={branch} />
      )}
    </>
  )
}
