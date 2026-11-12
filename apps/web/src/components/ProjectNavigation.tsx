import { useRef, useState, type ReactNode } from 'react'
import { FolderPlus } from 'lucide-react'
import type { WorkspaceInfo } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  IconButton,
  InlineNotice,
  Menu,
  TextField,
  ChevronRightGlyph,
  MoreGlyph,
  EditGlyph,
  PlusGlyph,
  SettingsGlyph,
} from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { projectFolders, projectName } from '../projects.tsx'
import { VisibleText } from './VisibleText.tsx'

export interface ProjectNavigationActions {
  onEditProject?: (id: string) => void
  onProjectsChanged?: () => void
}

/**
 * A shelf's header (20): its name, the chevron that folds it (on hover, or always while folded), and at the right a
 * count or the shelf's actions, which take the count's place on hover.
 */
export function ShelfHead({
  label,
  folded,
  onFold,
  count,
  actions,
  className,
}: {
  label: ReactNode
  folded: boolean
  onFold: () => void
  count?: number
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={className ? `shelf-head ${className}` : 'shelf-head'} data-folded={folded ? '' : undefined}>
      <button type="button" className="shelf-toggle" aria-expanded={!folded} onClick={onFold}>
        <span className="shelf-label">{label}</span>
        <ChevronRightGlyph className="shelf-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
      <span className="shelf-tail">
        {count !== undefined && <span className="shelf-count">{count}</span>}
        {actions && <span className="shelf-actions">{actions}</span>}
      </span>
    </div>
  )
}

/** Project edits keep the list in place; only structural changes open the editor. */
export function ProjectGroupHeading({
  project,
  folded = false,
  onFold,
  count,
  onNew,
  onEditProject,
  onProjectsChanged,
}: {
  project: WorkspaceInfo
  folded?: boolean
  /** Absent on a phone, where shelves do not fold. */
  onFold?: () => void
  count?: number
  onNew?: () => void
} & ProjectNavigationActions) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(projectName(project))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const committing = useRef(false)
  const folders = shellFolders()
  const operation = async (run: () => Promise<void>) => {
    if (committing.current) return
    committing.current = true
    setBusy(true)
    setError('')
    try {
      await run()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      committing.current = false
      setBusy(false)
      onProjectsChanged?.()
    }
  }
  const save = () => {
    if (!name.trim()) {
      setError('请填写项目名称。')
      return
    }
    void operation(async () => {
      await api(`workspaces/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: { name: name.trim() } })
      setRenaming(false)
    })
  }
  const actions = !renaming && (
    <>
      {onNew && !project.unavailable && (
        <IconButton size="xs" label={`在 ${projectName(project)} 中新建会话`} tooltip="新会话" icon={PlusGlyph} onClick={onNew} />
      )}
      {onEditProject && (
        <Menu
          label={`${projectName(project)} 的项目操作`}
          align="end"
          trigger={props => <IconButton {...props} size="xs" label={`${projectName(project)} 的项目操作`} icon={MoreGlyph} />}
          sections={[
            {
              id: 'project',
              items: [
                {
                  id: 'rename',
                  label: '重命名',
                  icon: EditGlyph,
                  onSelect: () => {
                    setName(projectName(project))
                    setRenaming(true)
                  },
                },
                ...(folders
                  ? [
                      {
                        id: 'add',
                        label: '添加文件夹…',
                        icon: FolderPlus,
                        disabledReason: busy ? '正在保存项目' : projectFolders(project).length >= 8 ? '每个项目最多 8 个文件夹' : undefined,
                        onSelect: () => {
                          void operation(async () => {
                            const result = await folders.pick(project.id)
                            if (result.status === 'failed') throw new Error('没有完成文件夹操作，请在项目设置中重试。')
                            if (result.status === 'busy') throw new Error('另一个系统对话框还没结束。')
                            if (result.status === 'added' && result.refused.length)
                              throw new Error(`${result.refused.length} 个文件夹没有加入。请在项目设置中查看文件夹。`)
                          })
                        },
                      },
                    ]
                  : []),
                { id: 'edit', label: '管理文件夹…', icon: SettingsGlyph, onSelect: () => onEditProject(project.id) },
              ],
            },
          ]}
        />
      )}
    </>
  )
  return (
    <>
      {renaming ? (
        <div className="project-group-heading shelf-rename">
          <form
            className="project-inline-name"
            onSubmit={event => {
              event.preventDefault()
              save()
            }}>
            <TextField
              autoFocus
              label="项目名称"
              maxLength={80}
              value={name}
              disabled={busy}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setRenaming(false)
                  setError('')
                }
              }}
            />
            <Button size="xs" loading={busy} type="submit">
              保存
            </Button>
          </form>
        </div>
      ) : onFold ? (
        <ShelfHead
          className="project-group-heading"
          folded={folded}
          onFold={onFold}
          count={folded ? count : undefined}
          actions={actions}
          label={
            <span title={project.unavailable}>
              <VisibleText text={projectName(project)} />
            </span>
          }
        />
      ) : (
        <div className="project-group-heading phone-shelf-heading">
          <span className="project-group-name" title={project.unavailable}>
            <VisibleText text={projectName(project)} />
          </span>
          <span className="phone-group-rule" />
          {actions}
        </div>
      )}
      {project.unavailable && (
        <p className="project-group-caption">
          <VisibleText text={project.unavailable} />
        </p>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}
