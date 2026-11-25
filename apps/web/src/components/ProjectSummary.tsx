import { useEffect, useState } from 'react'
import { ListTree } from 'lucide-react'
import type { ProjectFolderBranches, WorkspaceInfo } from '@latch/protocol'
import { BranchGlyph, Button, EditGlyph, FolderGlyph, Icon, InlineNotice, Popover, Tooltip, useLayerClose } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import { BranchName } from './MiddleEllipsis.tsx'
import { ProjectIcon, projectFolderLabels, projectFolders, projectName } from '../projects.tsx'
import { escapeHiddenCharacters, VisibleText } from './VisibleText.tsx'

const COPY = defineCopy(
  {
    title: (name: string) => `项目摘要：${name}`,
    folders: (count: number) => `${formatNumber(count)} 个文件夹`,
    primary: '主文件夹',
    loading: '正在读取分支…',
    edit: '编辑项目',
  },
  {
    title: (name: string) => `Project summary: ${name}`,
    folders: (count: number) => plural(count, { one: '{n} folder', other: '{n} folders' }),
    primary: 'Main folder',
    loading: 'Reading branches…',
    edit: 'Edit project',
  },
)

interface SummaryProps {
  project: WorkspaceInfo
  canReadBranches: boolean
  onEdit?: ((id: string) => void) | undefined
}

export function ProjectSummary(props: SummaryProps) {
  const [open, setOpen] = useState(false)
  const name = escapeHiddenCharacters(projectName(props.project))
  const label = COPY.title(name)
  return (
    <Popover
      label={label}
      title={name}
      size="md"
      frosted
      align="end"
      onOpenChange={setOpen}
      trigger={trigger => (
        <Button
          {...trigger}
          size="xs"
          variant="ghost"
          className="project-summary-trigger"
          icon={ListTree}
          aria-label={label}
          tooltip={label}>
          {formatNumber(projectFolders(props.project).length)}
        </Button>
      )}>
      {open && <SummaryBody key={props.project.id} {...props} />}
    </Popover>
  )
}

function SummaryBody({ project, canReadBranches, onEdit }: SummaryProps) {
  const close = useLayerClose()
  const folders = projectFolders(project)
  return (
    <section className="project-summary-body">
      <header className="project-summary-heading">
        <span className="project-summary-mark">
          <ProjectIcon project={project} size={20} />
        </span>
        <div className="project-summary-title">
          <strong title={escapeHiddenCharacters(projectName(project))}>
            <VisibleText text={projectName(project)} />
          </strong>
          <span>{COPY.folders(folders.length)}</span>
        </div>
        {onEdit && (
          <Button
            variant="ghost"
            size="sm"
            icon={EditGlyph}
            onClick={() => {
              close()
              onEdit(project.id)
            }}>
            {COPY.edit}
          </Button>
        )}
      </header>
      <FolderList
        key={JSON.stringify([canReadBranches, folders.map(folder => [folder.id, folder.path, folder.unavailable])])}
        project={project}
        canReadBranches={canReadBranches}
      />
    </section>
  )
}

/** Mounted for one open summary and one ordered set of folder identities. */
function FolderList({ project, canReadBranches }: Pick<SummaryProps, 'project' | 'canReadBranches'>) {
  const [branches, setBranches] = useState<ProjectFolderBranches>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!canReadBranches) return undefined
    let pending: AbortController | undefined
    const read = () => {
      pending?.abort()
      if (document.hidden) return
      const controller = new AbortController()
      pending = controller
      void api<ProjectFolderBranches>(`workspaces/${encodeURIComponent(project.id)}/folder-branches`, { signal: controller.signal })
        .then(reply => {
          if (controller.signal.aborted) return
          setBranches(reply)
          setError('')
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return
          setBranches(undefined)
          setError(errorMessage(cause))
        })
    }
    read()
    const timer = window.setInterval(read, 30_000)
    document.addEventListener('visibilitychange', read)
    return () => {
      pending?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [project.id, canReadBranches])
  const folders = projectFolders(project)
  const names = projectFolderLabels(folders)
  return (
    <>
      <ul className="project-summary-folders">
        {folders.map((folder, index) => {
          const branch = branches?.folders.find(item => item.id === folder.id && item.path === folder.path)?.branch
          return (
            <li key={folder.id}>
              <div className="project-summary-folder">
                <Tooltip content={<VisibleText text={folder.path} />}>
                  <span className="project-summary-location" tabIndex={0}>
                    <Icon icon={FolderGlyph} size={16} className="project-summary-folder-icon" />
                    <span className="project-summary-name">
                      <VisibleText text={names[index]!} />
                    </span>
                    {index === 0 && <span className="project-summary-primary">{COPY.primary}</span>}
                  </span>
                </Tooltip>
                {folder.unavailable ? (
                  <span className="project-summary-missing">
                    <VisibleText text={folder.unavailable} />
                  </span>
                ) : branch ? (
                  <Tooltip content={<VisibleText text={branch} />}>
                    <span className="project-summary-branch" tabIndex={0}>
                      <Icon icon={BranchGlyph} size={12} />
                      <BranchName branch={branch} />
                    </span>
                  </Tooltip>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : (
        canReadBranches
        && !branches && (
          <span className="project-summary-loading" role="status">
            {COPY.loading}
          </span>
        )
      )}
    </>
  )
}
