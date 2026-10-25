import { useRef, useState } from 'react'
import { Ellipsis, FolderPlus, Pencil, Plus, Settings } from 'lucide-react'
import type { WorkspaceInfo } from '@latch/protocol'
import { Button, IconButton, InlineNotice, Menu, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { ProjectIcon, projectFolders, projectName } from '../projects.tsx'
import { VisibleText } from './VisibleText.tsx'

export interface ProjectNavigationActions {
  onCreateProject?: () => void
  onEditProject?: (id: string) => void
  onProjectsChanged?: () => void
}

export function ProjectsHeading({ empty, onCreateProject }: { empty: boolean } & ProjectNavigationActions) {
  return (
    <div className="projects-navigation">
      <div className="projects-navigation-heading">
        <span>项目</span>
        {onCreateProject && <IconButton size="xs" label="新建项目" icon={Plus} onClick={onCreateProject} />}
      </div>
      {empty && (
        <div className="projects-navigation-empty">
          <span>还没有项目</span>
          {onCreateProject ? (
            <Button variant="ghost" size="xs" icon={FolderPlus} onClick={onCreateProject}>
              新建项目…
            </Button>
          ) : (
            <span>在运行 Latch 的电脑上用桌面端新建项目。</span>
          )}
        </div>
      )}
    </div>
  )
}

/** Project edits keep the list in place; only structural changes open the editor. */
export function ProjectGroupHeading({
  project,
  onNew,
  onEditProject,
  onProjectsChanged,
}: {
  project: WorkspaceInfo
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
  return (
    <>
      <div className="project-group-heading">
        <ProjectIcon project={project} size={14} />
        {renaming ? (
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
        ) : (
          <span className="project-group-name" title={project.unavailable}>
            <VisibleText text={projectName(project)} />
          </span>
        )}
        {!renaming && onNew && !project.unavailable && (folders !== null || project.remoteStart !== false) && (
          <IconButton size="xs" label={`在 ${projectName(project)} 中新建会话`} icon={Plus} onClick={onNew} />
        )}
        {!renaming && onEditProject && (
          <Menu
            label={`${projectName(project)} 的项目操作`}
            align="end"
            trigger={props => <IconButton {...props} size="xs" label={`${projectName(project)} 的项目操作`} icon={Ellipsis} />}
            sections={[
              {
                id: 'project',
                items: [
                  {
                    id: 'rename',
                    label: '重命名',
                    icon: Pencil,
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
                          disabledReason: busy
                            ? '正在保存项目'
                            : projectFolders(project).length >= 8
                              ? '每个项目最多 8 个文件夹'
                              : undefined,
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
                  { id: 'edit', label: '管理文件夹…', icon: Settings, onSelect: () => onEditProject(project.id) },
                ],
              },
            ]}
          />
        )}
      </div>
      {project.unavailable && (
        <p className="project-group-caption">
          <VisibleText text={project.unavailable} />
        </p>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}
