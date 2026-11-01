import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Folder, FolderOpen, FolderPlus, Pencil, Trash } from 'lucide-react'
import { escapeSecurityText, type AppSnapshot, type WorkspaceInfo } from '@latch/protocol'
import type { DeviceAccess } from '../core/permissions.ts'
import { api, errorMessage } from '../core/api.ts'
import { describeFailure } from '../core/securityCopy.ts'
import { currentShell, revealLabel, shellFolders, type FolderResult, type ShellFolders } from '../core/shell.ts'
import { basename } from '../format.ts'
import { ProjectIcon, projectFolders } from '../projects.tsx'
import { CodeRootNotice } from '../components/CodeRootNotice.tsx'
import { ConfirmDialog } from '../components/overlays.tsx'
import { Button, InlineNotice, Menu, PromptDialog, StatusPill, type ActionMenuSection } from '@latch/ui'
import { FoldRows, IconTile, Loading, MiddleEllipsis, moreButton, ObjectRow, SettingsGroup, SettingsRow } from './common.tsx'
import { ProjectEditor } from './ProjectEditor.tsx'
import { SettingsPages } from './navigation.tsx'

const LOCKED_CAPTION = '新建项目要在运行 Latch 的电脑上用桌面端完成。'
const RESTART_CAPTION = '重新启动 Latch 桌面端后，可以在这里新建项目。'

/** Where a project's history stops, as the Host keeps it: the limits are the Host's own, not a setting. */
const HISTORY_CAP = '每个会话保留最近 20 轮的文件快照，每个项目最多占用 2 GB，满了先删最早的。'

/**
 * A project as one row: its glyph, its name, how many folders and where the first one is, and a ⋯ menu. A project the
 * Host disabled for this run stays listed with its reason so it can be removed. Only a Host with several folders per
 * project has an editor to open.
 */
export function ProjectRow({
  workspace,
  owner,
  isDefault,
  folders,
  onRemove,
  onRename,
  onEdit,
  onAddFolder,
}: {
  workspace: WorkspaceInfo
  owner: boolean
  isDefault: boolean
  folders: ShellFolders | null
  onRemove: (workspace: WorkspaceInfo) => void
  onRename?: (workspace: WorkspaceInfo) => void
  onEdit?: () => void
  onAddFolder?: () => void
}) {
  const disabled = workspace.unavailable !== undefined
  const name = escapeSecurityText(workspace.name || basename(workspace.path))
  const members = projectFolders(workspace)
  const label = revealLabel(currentShell()?.platform)
  const path = escapeSecurityText(workspace.path)
  const sections: ActionMenuSection[] = [
    {
      id: 'project',
      items: [
        ...(onRename
          ? [
              {
                id: 'rename',
                label: '重命名…',
                icon: Pencil,
                onSelect: () => {
                  onRename(workspace)
                },
              },
            ]
          : []),
        ...(onAddFolder ? [{ id: 'add', label: '添加文件夹…', icon: FolderPlus, onSelect: onAddFolder }] : []),
        ...(folders && !disabled
          ? [
              {
                id: 'reveal',
                label,
                icon: FolderOpen,
                onSelect: () => {
                  void folders.reveal(workspace.id)
                },
              },
            ]
          : []),
        ...(onEdit ? [{ id: 'edit', label: '编辑…', icon: Pencil, onSelect: onEdit }] : []),
      ],
    },
    ...(owner
      ? [
          {
            id: 'danger',
            items: [
              {
                id: 'remove',
                label: '移除…',
                icon: Trash,
                danger: true,
                onSelect: () => {
                  onRemove(workspace)
                },
              },
            ],
          },
        ]
      : []),
  ]
  return (
    <>
      <ObjectRow
        className="project-row"
        label={`管理项目：${name}`}
        dim={disabled}
        leading={<ProjectIcon project={workspace} />}
        title={
          <span className="settings-row-name">
            {name}
            {isDefault && <span className="settings-row-note">默认</span>}
            {disabled && <StatusPill tone="warn">不可用</StatusPill>}
          </span>
        }
        description={
          disabled ? (
            <span className="workspace-unavailable">{workspace.unavailable || '此项目本次未通过检查，不能用于新会话。'}</span>
          ) : (
            <span className="project-row-where">
              <span>{members.length} 个文件夹 ·</span>
              <MiddleEllipsis text={path} />
            </span>
          )
        }
        {...(onEdit ? { onOpen: onEdit } : {})}
        trailing={
          sections.some(section => section.items.length > 0) ? (
            <Menu label={`${name} 的操作`} align="end" sections={sections} trigger={moreButton(`${name} 的操作`)} />
          ) : undefined
        }
      />
      {workspace.codeRoot && <CodeRootNotice workspace={workspace} className="project-code-root" />}
    </>
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
  onOpenSession,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'admin'>
  onChanged: () => void
  initialProjectId?: string
  onOpenSession?: (id: string) => void
}) {
  const owner = access.admin
  const folders = owner ? shellFolders() : null
  const desktop = currentShell() !== null
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[] | null>(snapshot.catalog?.workspaces ?? null)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<WorkspaceInfo | null>(null)
  const [renaming, setRenaming] = useState<WorkspaceInfo | null>(null)
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
  const caption = folders ? undefined : desktop && owner ? RESTART_CAPTION : LOCKED_CAPTION
  const addAction = folders ? (
    <Button variant="outline" icon={FolderPlus} loading={picking} onClick={() => void pick()}>
      {picking ? '选择中…' : '新建项目'}
    </Button>
  ) : undefined
  const multi = snapshot.catalog?.projectFolders !== undefined
  const main = (
    <div className="projects" data-drop={drag === 'none' ? undefined : drag} {...dropZone}>
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
          <SettingsGroup title="项目" meta={addAction} caption={caption ? `${caption} ${HISTORY_CAP}` : HISTORY_CAP} captionIcon={null}>
            {folders && drag !== 'none' && (
              <div className="project-drop" role="status">
                {drag === 'files' ? '只能拖入文件夹' : '松开以用这些文件夹新建项目'}
              </div>
            )}
            {projects.length === 0 && (
              <SettingsRow
                leading={<IconTile icon={Folder} />}
                title="还没有项目"
                description={folders ? '选择一个文件夹，或把文件夹拖到这里' : '把一个文件夹作为项目，新会话就可以在其中工作'}
              />
            )}
            <FoldRows items={projects} keyOf={workspace => workspace.id} className="project-rows">
              {workspace => (
                <ProjectRow
                  workspace={workspace}
                  owner={owner}
                  isDefault={workspace.id === defaultId}
                  folders={folders}
                  onRemove={setRemoving}
                  {...(owner ? { onRename: setRenaming } : {})}
                  {...(multi ? { onEdit: () => setEditing(workspace.id) } : {})}
                  {...(multi && folders
                    ? {
                        onAddFolder: () => {
                          void folders.pick(workspace.id).then(settle)
                        },
                      }
                    : {})}
                />
              )}
            </FoldRows>
            {start && (
              <>
                <ObjectRow
                  className="project-row"
                  label="启动目录"
                  leading={<IconTile icon={Folder} />}
                  title={
                    <span className="settings-row-name">
                      启动目录
                      {start.id === defaultId && <span className="settings-row-note">默认</span>}
                    </span>
                  }
                  description={<MiddleEllipsis text={escapeSecurityText(start.path)} />}
                  trailing={
                    folders ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          void folders.reveal(start.id)
                        }}>
                        {revealLabel(currentShell()?.platform)}
                      </Button>
                    ) : undefined
                  }
                />
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
              </>
            )}
          </SettingsGroup>
        </>
      )}
      {error && workspaces !== null && <InlineNotice tone="error">{error}</InlineNotice>}
      {removing && (
        <ConfirmDialog
          title={`移除「${removing.name || basename(removing.path)}」？`}
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
      {renaming && (
        <PromptDialog
          title="重命名项目"
          label="名称"
          initial={renaming.name || basename(renaming.path)}
          maxLength={80}
          onClose={() => {
            setRenaming(null)
          }}
          onSubmit={async value => {
            await api(`workspaces/${encodeURIComponent(renaming.id)}`, { method: 'PATCH', body: { name: value } })
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
