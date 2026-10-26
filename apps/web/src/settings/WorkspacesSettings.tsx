import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Folder, FolderOpen, FolderPlus, Trash } from 'lucide-react'
import { escapeSecurityText, type AppSnapshot, type WorkspaceFolder, type WorkspaceInfo } from '@latch/protocol'
import type { DeviceAccess } from '../core/permissions.ts'
import { api, errorMessage } from '../core/api.ts'
import { describeFailure } from '../core/securityCopy.ts'
import { currentShell, revealLabel, shellFolders, type FolderResult, type ShellFolders } from '../core/shell.ts'
import { basename } from '../format.ts'
import { ProjectIcon, projectFolders } from '../projects.tsx'
import { CodeRootNotice } from '../components/CodeRootNotice.tsx'
import { ConfirmDialog } from '../components/overlays.tsx'
import { Badge, Button, IconButton, InlineNotice, Menu, StatusPill } from '@latch/ui'
import { CopyButton } from '../components/ui.tsx'
import { FoldRows, IconTile, Loading, MiddleEllipsis, moreButton, NavRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { ProjectEditor } from './ProjectEditor.tsx'
import { SettingsPages } from './navigation.tsx'

const LOCKED_CAPTION = '新建项目要在运行 Latch 的电脑上用桌面端完成。'
const RESTART_CAPTION = '重新启动 Latch 桌面端后，可以在这里新建项目。'

/** A folder's row: its name, its full path keeping the end in view, and one way to find it (Finder here, else copy). */
function FolderRow({
  workspace,
  folders,
  folder,
  primary = false,
}: {
  workspace: WorkspaceInfo
  folders: ShellFolders | null
  folder?: WorkspaceFolder
  primary?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const label = revealLabel(currentShell()?.platform)
  return (
    <SettingsRow
      className="folder-row"
      dim={folder?.unavailable !== undefined}
      leading={<IconTile icon={FolderOpen} />}
      title={
        <span className="settings-row-name">
          {escapeSecurityText(basename(folder?.path ?? workspace.path))}
          {primary && <Badge>主文件夹</Badge>}
        </span>
      }
      description={
        failed || folder?.unavailable ? (
          <span className="folder-missing">
            {folder?.unavailable ? escapeSecurityText(folder.unavailable) : '找不到这个文件夹'} ·{' '}
            {escapeSecurityText(folder?.path ?? workspace.path)}
          </span>
        ) : (
          <MiddleEllipsis text={escapeSecurityText(folder?.path ?? workspace.path)} className="settings-mono" />
        )
      }
      trailing={
        folders && !folder?.unavailable ? (
          <IconButton
            label={label}
            icon={FolderOpen}
            onClick={() => {
              void folders.reveal(workspace.id, folder?.id).then(result => {
                setFailed(result.status === 'failed' && result.code === 'missing')
              })
            }}
          />
        ) : (
          <CopyButton text={folder?.path ?? workspace.path} label="复制路径" />
        )
      }
    />
  )
}

/**
 * A saved project as its own card: a head row with its name (默认 when new sessions start there; 不可用 with the
 * Host's reason when this run cannot use it) and its ⋯ menu, then its folder. One the Host disabled for this run stays
 * listed with its reason so it can be removed.
 */
export function ProjectCard({
  workspace,
  owner,
  isDefault,
  folders,
  onRemove,
  onEdit,
}: {
  workspace: WorkspaceInfo
  owner: boolean
  isDefault: boolean
  folders: ShellFolders | null
  onRemove: (workspace: WorkspaceInfo) => void
  onEdit?: () => void
}) {
  const disabled = workspace.unavailable !== undefined
  const name = workspace.name || basename(workspace.path)
  const members = projectFolders(workspace)
  return (
    <div className={`settings-card project-card${disabled ? ' is-unavailable' : ''}`}>
      {onEdit ? (
        <NavRow
          leading={<ProjectIcon project={workspace} />}
          record
          dim={disabled}
          label={`管理项目：${escapeSecurityText(name)}`}
          title={
            <span className="settings-row-name">
              {escapeSecurityText(name)}
              {isDefault && <Badge>默认</Badge>}
              {disabled && <StatusPill tone="warn">不可用</StatusPill>}
            </span>
          }
          description={
            workspace.unavailable
            ?? (members.length > 1
              ? `${members.length} 个文件夹 · 主文件夹 ${escapeSecurityText(basename(workspace.path))}`
              : escapeSecurityText(workspace.path))
          }
          onClick={onEdit}
        />
      ) : (
        <SettingsRow
          className="project-head"
          leading={<IconTile icon={Folder} />}
          record
          dim={disabled}
          title={
            <span className="settings-row-name">
              {name}
              {isDefault && <Badge>默认</Badge>}
              {disabled && <StatusPill tone="warn">不可用</StatusPill>}
            </span>
          }
          description={
            disabled ? (
              <span className="workspace-unavailable">{workspace.unavailable || '此项目本次未通过检查，不能用于新会话。'}</span>
            ) : isDefault ? (
              '新会话默认在这里启动'
            ) : undefined
          }
          trailing={
            owner ? (
              <Menu
                label={`${name} 的操作`}
                align="end"
                sections={[
                  {
                    id: 'project',
                    items: [
                      {
                        id: 'remove',
                        label: '移除项目…',
                        icon: Trash,
                        danger: true,
                        onSelect: () => {
                          onRemove(workspace)
                        },
                      },
                    ],
                  },
                ]}
                trigger={moreButton(`${name} 的操作`)}
              />
            ) : undefined
          }
        />
      )}
      {members.map((folder, index) => (
        <FolderRow key={folder.id} workspace={workspace} folder={folder} primary={onEdit !== undefined && index === 0} folders={folders} />
      ))}
      {workspace.codeRoot && <CodeRootNotice workspace={workspace} className="project-code-root" />}
    </div>
  )
}

/** Paths the Host did not add, each with its reason (the catalog's words for a security code); the others were added. */
function RefusedNotice({ result, onClose }: { result: Extract<FolderResult, { status: 'added' }>; onClose: () => void }) {
  return (
    <InlineNotice
      tone="error"
      action={
        <Button size="xs" onClick={onClose}>
          知道了
        </Button>
      }>
      <span className="folder-refused">
        <strong>{result.refused.length} 个文件夹没有加入</strong>
        {result.added.length > 0 && <span>已加入其余 {result.added.length} 个。</span>}
        {result.refused.map(item => (
          <span key={item.path} className="folder-refused-line">
            <code className="settings-mono">{item.path}</code>
            <span>{describeFailure(item.status, item.code, item.message ?? '')}</span>
          </span>
        ))}
      </span>
    </InlineNotice>
  )
}

/** Whether a drag carries only folders: dropping files is refused before anything is asked. */
function draggedFolders(event: DragEvent): 'folders' | 'files' | 'none' {
  if (!event.dataTransfer.types.includes('Files')) return 'none'
  const items = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file')
  // While dragging, entries are not readable yet; the drop says whether each one is a folder.
  if (event.type !== 'drop') return 'folders'
  return items.length > 0 && items.every(item => item.webkitGetAsEntry()?.isDirectory === true) ? 'folders' : 'files'
}

/**
 * Settings › 项目. Projects are added only in the Latch desktop app on the computer that runs Latch: the native open
 * panel (新建项目…) or folders dropped from Finder, which main confirms natively and adds itself, so the page never
 * sends a path. Elsewhere the page says where to do it. Any admin device can remove a project.
 */
export function WorkspacesSettings({
  snapshot,
  access,
  onChanged,
  initialProjectId,
  onComputer,
  onOpenSession,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'admin'>
  onChanged: () => void
  initialProjectId?: string
  onComputer?: () => void
  onOpenSession?: (id: string) => void
}) {
  const owner = access.admin
  const folders = owner ? shellFolders() : null
  const desktop = currentShell() !== null
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[] | null>(snapshot.catalog?.workspaces ?? null)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<WorkspaceInfo | null>(null)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<string | null>(initialProjectId ?? null)
  const [refused, setRefused] = useState<Extract<FolderResult, { status: 'added' }> | null>(null)
  const [drag, setDrag] = useState<'none' | 'over' | 'files'>('none')
  const depth = useRef(0)
  const load = useCallback(async () => {
    try {
      setWorkspaces((await api<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces)
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  /** A native add finished: new rows appear (no toast); refused folders say why; a cancel says nothing. */
  const settle = (result: FolderResult) => {
    if (result.status === 'added') {
      if (result.added.length > 0) {
        onChanged()
        void load()
        if (snapshot.catalog?.projectFolders) setEditing(result.added[0]!.workspaceId)
      }
      setRefused(result.refused.length > 0 ? result : null)
    } else if (result.status === 'failed') setError('没有添加项目：桌面端无法完成这次操作，请重试。')
  }
  const pick = async () => {
    if (!folders || picking) return
    setPicking(true)
    setError('')
    setRefused(null)
    try {
      settle(await folders.pick())
    } finally {
      setPicking(false)
    }
  }
  const dropZone = folders
    ? {
        onDragEnter: (event: DragEvent) => {
          if (draggedFolders(event) === 'none') return
          event.preventDefault()
          depth.current++
          setDrag('over')
        },
        onDragOver: (event: DragEvent) => {
          if (draggedFolders(event) === 'none') return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setDrag('none')
        },
        onDrop: (event: DragEvent) => {
          const kind = draggedFolders(event)
          if (kind === 'none') return
          event.preventDefault()
          depth.current = 0
          if (kind === 'files') {
            setDrag('files')
            setTimeout(() => {
              setDrag('none')
            }, 1200)
            return
          }
          setDrag('none')
          setError('')
          setRefused(null)
          void folders.drop(Array.from(event.dataTransfer.files)).then(settle)
        },
      }
    : {}

  const defaultId = snapshot.catalog?.defaults.workspaceId
  const start = workspaces?.find(workspace => workspace.id === 'default')
  const projects = workspaces?.filter(workspace => workspace.id !== 'default') ?? []
  const addAction = folders ? (
    <Button icon={FolderPlus} loading={picking} onClick={() => void pick()}>
      {picking ? '选择中…' : '新建项目…'}
    </Button>
  ) : undefined
  const caption = folders ? undefined : desktop && owner ? RESTART_CAPTION : LOCKED_CAPTION
  const main = (
    <div className="projects" data-drop={drag === 'none' ? undefined : drag} {...dropZone}>
      <SectionHeading
        title="项目"
        description={
          snapshot.catalog?.projectFolders ? '项目由一个或多个文件夹组成，新会话在主文件夹中启动。' : '新会话在所选项目的文件夹中启动。'
        }
        action={addAction}
      />
      {workspaces === null ? (
        error ? (
          <InlineNotice tone="error">{error}</InlineNotice>
        ) : (
          <Loading />
        )
      ) : (
        <>
          {refused && (
            <RefusedNotice
              result={refused}
              onClose={() => {
                setRefused(null)
              }}
            />
          )}
          <SettingsGroup
            title="项目"
            meta={projects.length > 0 ? `${projects.length} 个项目` : undefined}
            bare
            caption={caption}
            captionIcon={desktop && owner && !folders ? 'info' : 'lock'}>
            {folders && drag !== 'none' && (
              <div className="project-drop" role="status">
                {drag === 'files' ? '只能拖入文件夹' : '松开以用这些文件夹新建项目'}
              </div>
            )}
            {projects.length === 0 ? (
              <div className="settings-card">
                <SettingsRow
                  leading={<IconTile icon={Folder} />}
                  title="还没有项目"
                  description={
                    folders ? '用页头的「新建项目…」选择一个文件夹，或把文件夹拖到这里' : '把一个文件夹作为项目，新会话就可以在其中工作'
                  }
                />
              </div>
            ) : (
              <FoldRows items={projects} keyOf={workspace => workspace.id} className="project-cards">
                {workspace => (
                  <ProjectCard
                    workspace={workspace}
                    owner={owner}
                    isDefault={workspace.id === defaultId}
                    folders={folders}
                    onRemove={setRemoving}
                    {...(snapshot.catalog?.projectFolders ? { onEdit: () => setEditing(workspace.id) } : {})}
                  />
                )}
              </FoldRows>
            )}
          </SettingsGroup>
          {start && (
            <SettingsGroup
              title="启动目录"
              // In Latch's program directory the warning already says the way out is a new project; it is said once.
              caption={
                start.codeRoot ? 'Host 启动时使用的目录，不能移除。' : 'Host 启动时使用的目录，不能移除；要在其他文件夹中工作，请新建项目。'
              }>
              <SettingsRow
                className="project-head"
                leading={<IconTile icon={Folder} />}
                record
                title={
                  <span className="settings-row-name">
                    启动目录
                    {start.id === defaultId && <Badge>默认</Badge>}
                  </span>
                }
                description={start.id === defaultId ? '新会话默认在这里启动' : undefined}
              />
              <FolderRow workspace={start} folders={folders} />
              {start.codeRoot && (
                <CodeRootNotice
                  workspace={start}
                  className="project-code-root"
                  {...(folders
                    ? {
                        onNewProject: () => {
                          void pick()
                        },
                      }
                    : {})}
                />
              )}
            </SettingsGroup>
          )}
        </>
      )}
      {error && workspaces !== null && <InlineNotice tone="error">{error}</InlineNotice>}
      {removing && (
        <ConfirmDialog
          title={`移除项目「${removing.name || basename(removing.path)}」？`}
          confirmLabel="移除项目"
          danger
          message="文件夹中的文件不会被删除。"
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            try {
              await api(`workspaces/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause), { cause })
            }
            onChanged()
            await load()
          }}
        />
      )}
    </div>
  )
  const project = editing === null ? undefined : workspaces?.find(workspace => workspace.id === editing && workspace.id !== 'default')
  return (
    <SettingsPages
      main={main}
      levels={
        project
          ? [
              {
                key: project.id,
                title: project.name || basename(project.path),
                onBack: () => setEditing(null),
                content: (
                  <ProjectEditor
                    project={project}
                    snapshot={snapshot}
                    owner={owner}
                    shell={folders}
                    reload={load}
                    onChanged={onChanged}
                    onRemoved={() => setEditing(null)}
                    {...(onComputer ? { onComputer } : {})}
                    {...(onOpenSession ? { onOpenSession } : {})}
                  />
                ),
              },
            ]
          : []
      }
    />
  )
}
