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
import { api, errorMessage, MessageError } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { ProjectIcon, projectFolders, projectName } from '../projects.tsx'
import { VisibleText } from './VisibleText.tsx'
import { rowOf } from './overlays.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    required: '请填写项目名称。',
    newIn: (value1: string | number) => `在 ${value1} 中新建会话`,
    newSession: '新会话',
    actions: (value1: string | number) => `${value1} 的项目操作`,
    rename: '重命名',
    addFolder: '添加文件夹…',
    saving: '正在保存项目',
    maxFolders: '每个项目最多 8 个文件夹',
    folderFailed: '没有完成文件夹操作，请在项目设置中重试。',
    dialogOpen: '另一个系统对话框还没结束。',
    foldersRefused: (count: number) => `${formatNumber(count)} 个文件夹没有加入。请在项目设置中查看文件夹。`,
    manageFolders: '管理文件夹…',
    projectName: '项目名称',
    save: '保存',
  },
  {
    required: 'Enter a project name.',
    newIn: (value1: string | number) => `New session in ${value1}`,
    newSession: 'New session',
    actions: (value1: string | number) => `Project actions for ${value1}`,
    rename: 'Rename',
    addFolder: 'Add folder…',
    saving: 'Saving project',
    maxFolders: 'Up to 8 folders per project',
    folderFailed: 'The folder change didn’t finish. Try again in project settings.',
    dialogOpen: 'Another system dialog is still open.',
    foldersRefused: (count: number) =>
      `${plural(count, { one: '{n} folder wasn’t', other: '{n} folders weren’t' })} added. See the folders in project settings.`,
    manageFolders: 'Manage folders…',
    projectName: 'Project name',
    save: 'Save',
  },
)

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
  lead,
  folded,
  onFold,
  count,
  actions,
  className,
}: {
  /** The project mark before its name. */
  lead?: ReactNode
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
        {lead}
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
      setError(COPY.required)
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
        <IconButton size="xs" label={COPY.newIn(projectName(project))} tooltip={COPY.newSession} icon={PlusGlyph} onClick={onNew} />
      )}
      {onEditProject && (
        <Menu
          label={COPY.actions(projectName(project))}
          align="end"
          context={rowOf('.shelf-head')}
          trigger={props => <IconButton {...props} size="xs" label={COPY.actions(projectName(project))} icon={MoreGlyph} />}
          sections={[
            {
              id: 'project',
              items: [
                // The heading's hover + as an item too, so the right-click menu offers it.
                ...(onNew && !project.unavailable ? [{ id: 'new', label: COPY.newSession, icon: PlusGlyph, onSelect: onNew }] : []),
                {
                  id: 'rename',
                  label: COPY.rename,
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
                        label: COPY.addFolder,
                        icon: FolderPlus,
                        disabledReason: busy ? COPY.saving : projectFolders(project).length >= 8 ? COPY.maxFolders : undefined,
                        onSelect: () => {
                          void operation(async () => {
                            const result = await folders.pick(project.id)
                            if (result.status === 'failed') throw new MessageError(COPY.folderFailed)
                            if (result.status === 'busy') throw new MessageError(COPY.dialogOpen)
                            if (result.status === 'added' && result.refused.length)
                              throw new MessageError(COPY.foldersRefused(result.refused.length))
                          })
                        },
                      },
                    ]
                  : []),
                { id: 'edit', label: COPY.manageFolders, icon: SettingsGlyph, onSelect: () => onEditProject(project.id) },
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
              label={COPY.projectName}
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
              {COPY.save}
            </Button>
          </form>
        </div>
      ) : onFold ? (
        <ShelfHead
          className="project-group-heading"
          lead={<ProjectIcon project={project} size={14} className="shelf-lead" />}
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
          <ProjectIcon project={project} size={14} className="shelf-lead" />
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
