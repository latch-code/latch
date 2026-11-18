import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { FolderPlus } from 'lucide-react'
import { escapeSecurityText, type AppSnapshot, type WorkspaceInfo } from '@latch/protocol'
import type { DeviceAccess } from '../core/permissions.ts'
import { api, errorMessage, MessageError } from '../core/api.ts'
import { computerName, describeFailure, SETUP_COPY } from '../core/securityCopy.ts'
import { currentShell, revealLabel, shellFolders, type FolderResult, type ShellFolders } from '../core/shell.ts'
import { DELETION_COPY } from '../deletionCopy.ts'
import { basename } from '../format.ts'
import { ProjectIcon, projectFolders } from '../projects.tsx'
import { CodeRootNotice } from '../components/CodeRootNotice.tsx'
import { ConfirmDialog } from '../components/overlays.tsx'
import {
  Button,
  InlineNotice,
  Menu,
  PromptDialog,
  StatusPill,
  type ActionMenuSection,
  FolderGlyph,
  FolderOpenGlyph,
  EditGlyph,
  TrashGlyph,
} from '@latch/ui'
import { FoldRows, IconTile, Loading, MiddleEllipsis, moreButton, NoteLine, ObjectRow, SettingsGroup, SettingsRow } from './common.tsx'
import { ProjectEditor } from './ProjectEditor.tsx'
import { useCloneProject } from './CloneProject.tsx'
import { SettingsPages } from './navigation.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    restart: '重新启动 Latch 后，可以在这里添加项目。',
    snapshotLimit: '快照保留 20 轮，最多 2 GB',
    snapshotDetail: '每个会话保留最近 20 轮的文件快照，每个项目最多占用 2 GB，满了先删最早的。',
    rename: '重命名…',
    addFolder: '添加文件夹…',
    edit: '编辑…',
    remove: '移除…',
    default: '默认',
    unavailable: '不可用',
    checkFailed: '本次检查没通过',
    ok: '知道了',
    notAdded: '没有添加项目：这次操作没有完成，请重试。',
    choosing: '选择中…',
    addProject: '添加项目',
    projects: '项目',
    dropFolders: '只能拖入文件夹',
    dropToAdd: '松开以用这些文件夹添加项目',
    noProjects: '还没有项目',
    chooseFirst: '选择一个文件夹，或把文件夹拖到这里',
    defaultFolder: '默认文件夹',
    removeProject: '移除项目',
    renameProject: '重命名项目',
    name: '名称',
    locked: (message: string) => `${message}。`,
    manage: (name: string) => `管理项目：${name}`,
    folders: (count: number) => `${formatNumber(count)} 个文件夹 ·`,
    actions: (name: string) => `${name} 的操作`,
    refused: (count: number) => `${formatNumber(count)} 个文件夹没有加入`,
    otherAdded: (count: number) => `已加入其余 ${formatNumber(count)} 个。`,
    confirmRemove: (name: string) => `移除「${name}」？`,
  },
  {
    restart: 'Restart Latch to add projects here.',
    snapshotLimit: 'Snapshots: 20 turns, up to 2 GB',
    snapshotDetail: 'Each session keeps file snapshots of its last 20 turns. Each project uses up to 2 GB. The oldest snapshots go first.',
    rename: 'Rename…',
    addFolder: 'Add folder…',
    edit: 'Edit…',
    remove: 'Remove…',
    default: 'Default',
    unavailable: 'Unavailable',
    checkFailed: 'Didn’t pass the last check',
    ok: 'OK',
    notAdded: 'Project not added: the action didn’t finish. Try again.',
    choosing: 'Choosing…',
    addProject: 'Add project',
    projects: 'Projects',
    dropFolders: 'Only folders can be dropped',
    dropToAdd: 'Drop to add these folders as projects',
    noProjects: 'No projects yet',
    chooseFirst: 'Choose a folder, or drag one here',
    defaultFolder: 'Default folder',
    removeProject: 'Remove project',
    renameProject: 'Rename project',
    name: 'Name',
    locked: (message: string) => `${message}.`,
    manage: (name: string) => `Manage project ${name}`,
    folders: (count: number) => `${plural(count, { one: '{n} folder', other: '{n} folders' })} ·`,
    actions: (name: string) => `Actions for ${name}`,
    refused: (count: number) => plural(count, { one: '{n} folder wasn’t added', other: '{n} folders weren’t added' }),
    otherAdded: (count: number) => `Added the other ${plural(count, { one: '{n} folder', other: '{n} folders' })}.`,
    confirmRemove: (name: string) => `Remove “${name}”?`,
  },
)

/** On another device: where projects are added, by the computer's name. */
const lockedCaption = (hostName?: string) => COPY.locked(SETUP_COPY.addProjectElsewhere(computerName(hostName)))

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
                label: COPY.rename,
                icon: EditGlyph,
                onSelect: () => {
                  onRename(workspace)
                },
              },
            ]
          : []),
        ...(onAddFolder ? [{ id: 'add', label: COPY.addFolder, icon: FolderPlus, onSelect: onAddFolder }] : []),
        ...(folders && !disabled
          ? [
              {
                id: 'reveal',
                label,
                icon: FolderOpenGlyph,
                onSelect: () => {
                  void folders.reveal(workspace.id)
                },
              },
            ]
          : []),
        ...(onEdit ? [{ id: 'edit', label: COPY.edit, icon: EditGlyph, onSelect: onEdit }] : []),
      ],
    },
    ...(owner
      ? [
          {
            id: 'danger',
            items: [
              {
                id: 'remove',
                label: COPY.remove,
                icon: TrashGlyph,
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
        label={COPY.manage(name)}
        dim={disabled}
        leading={<ProjectIcon project={workspace} />}
        title={
          <span className="settings-row-name">
            {name}
            {isDefault && <span className="settings-row-note">{COPY.default}</span>}
            {disabled && <StatusPill tone="warn">{COPY.unavailable}</StatusPill>}
          </span>
        }
        description={
          disabled ? (
            <span className="workspace-unavailable">{workspace.unavailable || COPY.checkFailed}</span>
          ) : (
            <span className="project-row-where">
              <span>{COPY.folders(members.length)}</span>
              <MiddleEllipsis text={path} />
            </span>
          )
        }
        {...(onEdit ? { onOpen: onEdit } : {})}
        trailing={
          sections.some(section => section.items.length > 0) ? (
            <Menu label={COPY.actions(name)} align="end" sections={sections} trigger={moreButton(COPY.actions(name))} />
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
          {COPY.ok}
        </Button>
      }>
      <span className="folder-refused">
        <strong>{COPY.refused(result.refused.length)}</strong>
        {result.added.length > 0 && <span>{COPY.otherAdded(result.added.length)}</span>}
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
 * panel (添加项目…) or folders dropped from Finder, which main confirms natively and adds itself, so the page never
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
  // Another computer's page in the desktop app has no folder panel to restart into: it says where to add, as a browser does.
  const desktop = currentShell() !== null && currentShell()?.remote !== true
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
    } else if (result.status === 'failed') setError(COPY.notAdded)
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

  const cloning = useCloneProject(snapshot.catalog?.features?.gitSync === true ? folders : null, workspaceId => {
    onChanged()
    void load()
    if (snapshot.catalog?.projectFolders) setEditing(workspaceId)
  })
  const defaultId = snapshot.catalog?.defaults.workspaceId
  const start = workspaces?.find(workspace => workspace.id === 'default')
  const projects = workspaces?.filter(workspace => workspace.id !== 'default') ?? []
  const caption = folders ? undefined : desktop && owner ? COPY.restart : lockedCaption(snapshot.hostName)
  const addAction = folders ? (
    <span className="workspaces-actions">
      {cloning.button}
      <Button variant="outline" icon={FolderPlus} loading={picking} onClick={() => void pick()}>
        {picking ? COPY.choosing : COPY.addProject}
      </Button>
    </span>
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
          {cloning.status}
          {refused && (
            <RefusedNotice
              result={refused}
              onClose={() => {
                setRefused(null)
              }}
            />
          )}
          <SettingsGroup
            title={COPY.projects}
            meta={addAction}
            caption={caption}
            captionIcon="lock"
            note={<NoteLine brief={{ label: COPY.snapshotLimit, detail: COPY.snapshotDetail }} />}>
            {folders && drag !== 'none' && (
              <div className="project-drop" role="status">
                {drag === 'files' ? COPY.dropFolders : COPY.dropToAdd}
              </div>
            )}
            {projects.length === 0 && (
              <SettingsRow
                leading={<IconTile icon={FolderGlyph} />}
                title={COPY.noProjects}
                {...(folders ? { description: COPY.chooseFirst } : {})}
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
                  label={COPY.defaultFolder}
                  leading={<IconTile icon={FolderGlyph} />}
                  title={<span className="settings-row-name">{COPY.defaultFolder}</span>}
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
          title={COPY.confirmRemove(removing.name || basename(removing.path))}
          confirmLabel={COPY.removeProject}
          danger
          message={DELETION_COPY.projectRemoval}
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            try {
              await api(`workspaces/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new MessageError(errorMessage(cause), { cause })
            }
            onChanged()
            await load()
          }}
        />
      )}
      {renaming && (
        <PromptDialog
          title={COPY.renameProject}
          label={COPY.name}
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
