import type { ReactNode } from 'react'
import type { WorkspaceInfo } from '@latch/protocol'
import { ICON_STROKE, IconButton, Menu, ChevronRightGlyph, MoreGlyph, EditGlyph, PlusGlyph } from '@latch/ui'
import { ProjectIcon, projectName } from '../projects.tsx'
import { VisibleText } from './VisibleText.tsx'
import { rowOf } from './overlays.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    newIn: (name: string) => `在 ${name} 中新建会话`,
    newSession: '新会话',
    actions: (name: string) => `${name} 的项目操作`,
    editProject: '编辑项目…',
  },
  {
    newIn: (name: string) => `New session in ${name}`,
    newSession: 'New session',
    actions: (name: string) => `Project actions for ${name}`,
    editProject: 'Edit project…',
  },
)

export interface ProjectNavigationActions {
  onEditProject?: (id: string) => void
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

export function ProjectGroupHeading({
  project,
  folded = false,
  onFold,
  count,
  onNew,
  onEditProject,
}: {
  project: WorkspaceInfo
  folded?: boolean
  /** Absent on a phone, where shelves do not fold. */
  onFold?: () => void
  count?: number
  onNew?: () => void
} & ProjectNavigationActions) {
  const name = projectName(project)
  const start = project.unavailable ? undefined : onNew
  const actions = (
    <>
      {start && <IconButton size="xs" label={COPY.newIn(name)} tooltip={COPY.newSession} icon={PlusGlyph} onClick={start} />}
      {onEditProject && (
        <Menu
          label={COPY.actions(name)}
          align="end"
          context={rowOf('.shelf-head')}
          trigger={props => <IconButton {...props} size="xs" label={COPY.actions(name)} icon={MoreGlyph} />}
          sections={[
            {
              id: 'project',
              items: [
                ...(start ? [{ id: 'new', label: COPY.newSession, icon: PlusGlyph, onSelect: start }] : []),
                { id: 'edit', label: COPY.editProject, icon: EditGlyph, onSelect: () => onEditProject(project.id) },
              ],
            },
          ]}
        />
      )}
    </>
  )
  return (
    <>
      {onFold ? (
        <ShelfHead
          className="project-group-heading"
          lead={<ProjectIcon project={project} size={14} className="shelf-lead" />}
          folded={folded}
          onFold={onFold}
          count={folded ? count : undefined}
          actions={actions}
          label={
            <span title={project.unavailable}>
              <VisibleText text={name} />
            </span>
          }
        />
      ) : (
        <div className="project-group-heading phone-shelf-heading">
          <ProjectIcon project={project} size={14} className="shelf-lead" />
          <span className="project-group-name" title={project.unavailable}>
            <VisibleText text={name} />
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
    </>
  )
}
