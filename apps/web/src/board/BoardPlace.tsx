import { Fragment, type ReactNode } from 'react'
import { escapeSecurityText } from '@latch/protocol'
import { BranchGlyph, FolderGlyph, Icon } from '@latch/ui'
import { FolderGit2 } from 'lucide-react'
import { MarkTile } from '../components/BrandTile.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy({ worktree: '工作树' }, { worktree: 'Worktree' })

/** The Harness's mark bare at 16, as the sidebar's rows draw it; its name on hover and for a screen reader. */
export function BoardHarness({ mark, label }: { mark: string | undefined; label: string | undefined }) {
  return (
    <span className="work-board-harness" title={label || undefined}>
      <MarkTile mark={mark} size={16} bare label={label || undefined} />
    </span>
  )
}

/** A branch: the branch glyph (the worktree's where it is one) and the name in mono. */
export function BoardBranch({ branch, worktree = false }: { branch: string; worktree?: boolean }) {
  return (
    <span className="work-board-card-branch" title={branch}>
      {worktree ? <FolderGit2 size={12} aria-label={COPY.worktree} /> : <Icon icon={BranchGlyph} size={12} />}
      <span>{branch}</span>
    </span>
  )
}

/**
 * A card's place line: the Harness, who (for 我的 Agent), the project and the branch, each its own item between quiet
 * middle dots. When the line is short the branch gives way first, then the project's name; the Harness's mark never.
 */
export function BoardPlace({
  harness,
  who,
  project,
  branch,
  worktree = false,
  hint,
}: {
  harness?: { mark: string | undefined; label: string | undefined } | undefined
  who?: ReactNode
  /** The project's name; null leaves the project out (a session of 我的 Agent). */
  project: string | null
  branch?: string | undefined
  worktree?: boolean
  /** Words that close the line, such as 新工作树 on a 待办 that has not started. */
  hint?: ReactNode
}) {
  const items: Array<{ key: string; node: ReactNode }> = []
  if (harness) items.push({ key: 'harness', node: <BoardHarness mark={harness.mark} label={harness.label} /> })
  if (who) items.push({ key: 'who', node: who })
  if (project !== null)
    items.push({
      key: 'project',
      node: (
        <span className="work-board-card-project" title={escapeSecurityText(project)}>
          <Icon icon={FolderGlyph} size={12} />
          <span>{escapeSecurityText(project)}</span>
        </span>
      ),
    })
  if (branch) items.push({ key: 'branch', node: <BoardBranch branch={branch} worktree={worktree} /> })
  if (hint) items.push({ key: 'hint', node: hint })
  return (
    <span className="work-board-card-place">
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && (
            <span className="work-board-place-dot" aria-hidden="true">
              ·
            </span>
          )}
          {item.node}
        </Fragment>
      ))}
    </span>
  )
}
