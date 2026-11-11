import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, FolderGit2 } from 'lucide-react'
import type { WorkspaceInfo, WorktreeBase } from '@latch/protocol'
import { ValuePicker } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { BriefHint } from './BriefHint.tsx'
import { BranchSegment, StatusSegment } from './ComposerStatus.tsx'

type Where = 'folder' | 'worktree'

/** Where a new worktree would start, as the Host last said, or why it cannot make one. */
type BaseState = { state: 'reading' } | { state: 'ready'; base: WorktreeBase } | { state: 'refused'; message: string }

const WORKTREE_COPY = {
  folder: '当前文件夹',
  worktree: '新工作树',
  folderLine: '直接在项目文件夹里改',
  uncommitted: '不带未提交的改动',
  /** A worktree separates files only: ports, processes and this computer's permissions stay shared (no isolation implied). */
  shared: { label: '工作树只分开文件', detail: '端口、进程和这台电脑上的权限仍然共用。' },
} as const

/** 从 main 的 3f2a1c9; a detached HEAD has no branch to name. */
function baseWords(base: WorktreeBase): string {
  const commit = base.commit.slice(0, 7)
  return base.branch ? `从 ${base.branch} 的 ${commit}` : `从 ${commit}`
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
 * that ends in an ellipsis, so the warning goes first and a long branch name is what gets cut.
 */
function worktreeLine(base: BaseState | undefined): string | undefined {
  if (base?.state === 'refused') return undefined
  // The warning first: a long branch name is what the ellipsis cuts, never the warning.
  if (base?.state === 'ready') return `${WORKTREE_COPY.uncommitted} · ${baseWords(base.base)}`
  return `${WORKTREE_COPY.uncommitted} · 正在读取分支…`
}

/**
 * 当前文件夹 / 新工作树, for a new session in a Git project. The second says where it starts and that uncommitted
 * changes stay behind; a project where the Host cannot make one has it disabled with the Host's reason.
 */
export function FolderControl({
  project,
  worktree,
  onWorktree,
  disabled,
  variant = 'inline',
  branch,
}: {
  project: WorkspaceInfo
  /** In the status line: the project's branch, shown while the session would start in the project folder. */
  branch?: string | undefined
  worktree: boolean
  onWorktree: (worktree: boolean) => void
  disabled: boolean
  variant?: 'inline' | 'row'
}) {
  const { base, read } = useWorktreeBase(project.id)
  // Picked earlier: the base is shown beside it, so it is read without opening the menu.
  useEffect(() => {
    if (worktree) read()
  }, [worktree, read])
  const value: Where = worktree ? 'worktree' : 'folder'
  const picker = (
    <ValuePicker<Where>
      label="文件夹"
      variant={variant}
      {...(variant === 'row' ? { className: 'new-sheet-row' } : { size: 'xs' as const })}
      leading={worktree ? FolderGit2 : Folder}
      value={value}
      disabled={disabled}
      width={360}
      align="start"
      onOpenChange={open => {
        if (open) read()
      }}
      options={[
        { value: 'folder', label: WORKTREE_COPY.folder, description: WORKTREE_COPY.folderLine },
        {
          value: 'worktree',
          label: WORKTREE_COPY.worktree,
          ...(worktreeLine(base) ? { description: escapeHiddenCharacters(worktreeLine(base)!) } : {}),
          ...(base?.state === 'refused' ? { disabledReason: base.message } : {}),
        },
      ]}
      footer={<BriefHint brief={WORKTREE_COPY.shared} className="model-note" />}
      onValueChange={next => {
        onWorktree(next === 'worktree')
      }}
    />
  )
  if (variant === 'row') return picker
  // In the status line: the choice is the folder segment, and the branch segment says where a new worktree starts.
  return (
    <>
      <StatusSegment kind="folder">{picker}</StatusSegment>
      {worktree && base?.state === 'ready' ? (
        <BranchSegment branch={baseWords(base.base)} base />
      ) : (
        !worktree && branch && <BranchSegment branch={branch} />
      )}
    </>
  )
}
