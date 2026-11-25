import { useRef, useState, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, FolderPlus, GripVertical, Send } from 'lucide-react'
import {
  escapeSecurityText,
  PROJECT_GLYPHS,
  type AppSnapshot,
  type ProjectGlyph,
  type WorkspaceFolder,
  type WorkspaceInfo,
} from '@latch/protocol'
import {
  Badge,
  Button,
  Icon,
  IconButton,
  InlineNotice,
  Menu,
  ValuePicker,
  useCopy,
  CopyGlyph,
  FolderOpenGlyph,
  EditGlyph,
  ShieldGlyph,
  TrashGlyph,
} from '@latch/ui'
import { api, errorMessage, isUncertain } from '../core/api.ts'
import { computerName, describeFailure, SETUP_COPY } from '../core/securityCopy.ts'
import { currentShell, revealLabel, type FolderResult, type ShellFolders } from '../core/shell.ts'
import { basename, relativeTime, statusLabels } from '../format.ts'
import { DELETION_COPY } from '../deletionCopy.ts'
import { recentProjectSessions } from '../sessions.ts'
import {
  folderAccessText,
  folderInUse,
  projectInUse,
  PROJECT_EDIT_COPY,
  PROJECT_ICONS,
  ProjectIcon,
  projectFolders,
  projectName,
  projectSessionCount,
} from '../projects.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ConfirmDialog, PromptDialog } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { modelFromKey, modelGroups, modelKey } from '../components/pickerOptions.tsx'
import { LeftoverWorktrees } from './LeftoverWorktrees.tsx'
import { IconTile, MiddleEllipsis, moreButton, NavRow, NoteLine, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { harnessName } from '../core/harnessName.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    foldersOnly: '只能拖入文件夹。',
    retry: '重试原操作',
    details: '基本信息',
    name: '名称',
    rename: '重命名…',
    icon: '图标',
    folder: '文件夹',
    defaultModel: '默认模型',
    defaultModelHint: '这个项目的新会话用',
    unset: '不设',
    unavailable: '现在不能用',
    recent: '最近会话',
    untitled: '未命名会话',
    empty: '还没有可访问的会话',
    restoreFolders: '恢复或重新选择之前不能新建会话',
    ok: '知道了',
    modelScope: '读到的内容会发给模型服务',
    modelScopeDetail: 'Latch 内置可以读取这些文件夹中的文件，并把读到的内容发给模型服务；写入前会询问你。',
    folderNotFound: '找不到这个文件夹，请同步项目后重试。',
    copyPath: '复制路径',
    makeMain: '设为主文件夹',
    saving: '正在保存项目',
    moveUp: '向上移动',
    moveDown: '向下移动',
    reselect: '重新选择…',
    removeFolder: '从项目中移除…',
    restart: '重新启动 Latch 后，可以在这里添加和重新选择文件夹。',
    harnessFolders: '各 Harness 使用的文件夹',
    removeAction: '移除项目…',
    copied: '已复制路径',
    copyFailed: '复制失败',
    renameProject: '重命名项目',
    moved: (name: string, position: number) => `${name} 已移到第 ${formatNumber(position)} 位${position === 1 ? '，现在是主文件夹' : ''}`,
    sessions: (count: number) => `${formatNumber(count)} 个会话`,
    openSession: (name: string) => `打开会话：${name}`,
    archived: '已归档 · ',
    foldersUnavailable: (count: number) => `${formatNumber(count)} 个文件夹不可用`,
    refused: (count: number) => `${formatNumber(count)} 个文件夹没有加入`,
    addedOthers: (count: number) => `已加入其余 ${formatNumber(count)} 个。`,
    drop: (name: string) => `松开以添加到「${name}」`,
    reorder: (name: string) => `调整 ${name} 的顺序`,
    folderActions: (name: string) => `${name} 的更多操作`,
    editOnHost: (name: string) => `添加项目和添加文件夹要在 ${name} 上的 Latch 里完成。`,
  },
  {
    foldersOnly: 'Only folders can be dropped.',
    retry: 'Retry original action',
    details: 'Details',
    name: 'Name',
    rename: 'Rename…',
    icon: 'Icon',
    folder: 'Folder',
    defaultModel: 'Default model',
    defaultModelHint: 'Applies to new sessions in this project',
    unset: 'None',
    unavailable: 'Unavailable',
    recent: 'Recent sessions',
    untitled: 'Untitled session',
    empty: 'No sessions you can open',
    restoreFolders: 'Restore or reselect to start new sessions',
    ok: 'OK',
    modelScope: 'What it reads goes to the model service',
    modelScopeDetail:
      'Latch built-in can read files in these folders and sends what it reads to the model service. It asks you before writing.',
    folderNotFound: 'Folder not found. Sync the project and try again.',
    copyPath: 'Copy path',
    makeMain: 'Make main folder',
    saving: 'Saving project',
    moveUp: 'Move up',
    moveDown: 'Move down',
    reselect: 'Reselect…',
    removeFolder: 'Remove from project…',
    restart: 'Restart Latch to add and reselect folders here.',
    harnessFolders: 'Folders each Harness uses',
    removeAction: 'Remove project…',
    copied: 'Path copied',
    copyFailed: 'Couldn’t copy',
    renameProject: 'Rename project',
    moved: (name: string, position: number) =>
      position === 1 ? `${name} is now the main folder` : `Moved ${name} to position ${formatNumber(position)}`,
    sessions: (count: number) => plural(count, { one: '{n} session', other: '{n} sessions' }),
    openSession: (name: string) => `Open session ${name}`,
    archived: 'Archived · ',
    foldersUnavailable: (count: number) => plural(count, { one: '{n} folder unavailable', other: '{n} folders unavailable' }),
    refused: (count: number) => plural(count, { one: '{n} folder wasn’t added', other: '{n} folders weren’t added' }),
    addedOthers: (count: number) => plural(count, { one: 'The other folder was added.', other: 'The other {n} folders were added.' }),
    drop: (name: string) => `Drop to add to “${name}”`,
    reorder: (name: string) => `Reorder ${name}`,
    folderActions: (name: string) => `More actions for ${name}`,
    editOnHost: (name: string) => `Add projects and folders in Latch on ${name}.`,
  },
)

/** 「不设」 in the project's 默认模型: the Harness's own default stands. */
const NO_MODEL = '~none'

export function ProjectEditor({
  project,
  snapshot,
  owner,
  shell,
  reload,
  onChanged,
  onRemoved,
  onOpenSession,
}: {
  project: WorkspaceInfo
  snapshot: AppSnapshot
  owner: boolean
  shell: ShellFolders | null
  reload(): Promise<void>
  onChanged(): void
  onRemoved(): void
  onOpenSession?(id: string): void
}) {
  useLocale()
  const folders = projectFolders(project)
  const name = projectName(project)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState<{ run(): Promise<unknown> } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState<WorkspaceFolder | 'project' | null>(null)
  const [refused, setRefused] = useState<Extract<FolderResult, { status: 'added' }> | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [over, setOver] = useState(false)
  const dragged = useRef<string | null>(null)
  const copy = useCopy()
  const label = revealLabel(currentShell()?.platform)
  const endpoint = `workspaces/${encodeURIComponent(project.id)}`
  const recent = recentProjectSessions(project.id, snapshot.tasks, snapshot.catalog?.workspaces ?? [project])
  const active = projectInUse(project, snapshot)

  const execute = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setRetry(null)
    try {
      await operation()
      onChanged()
      await reload()
    } catch (cause) {
      setError(errorMessage(cause))
      if (isUncertain(cause)) setRetry({ run: operation })
    } finally {
      setBusy(false)
    }
  }
  const nativeResult = async (result: FolderResult) => {
    if (result.status === 'added') setRefused(result.refused.length ? result : null)
    else if (result.status === 'busy') setError(PROJECT_EDIT_COPY.systemDialog)
    else if (result.status === 'failed') setError(describeFailure(0, result.code, { fallback: PROJECT_EDIT_COPY.folderActionFailed }))
  }
  const pick = (replace?: string) => {
    if (shell) void execute(async () => nativeResult(await shell.pick(project.id, replace)))
  }
  const order = (from: number, to: number) => {
    if (!owner || busy || from === to || to < 0 || to >= folders.length) return
    const ids = folders.map(folder => folder.id)
    const [id] = ids.splice(from, 1)
    ids.splice(to, 0, id!)
    void execute(async () => {
      await api(endpoint, { method: 'PATCH', body: { order: ids } })
      setAnnouncement(COPY.moved(basename(folders[from]!.path), to + 1))
    })
  }
  const folderDrop = {
    onDragOver: (event: DragEvent) => {
      if (!shell || !event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      setOver(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false)
    },
    onDrop: (event: DragEvent) => {
      if (!shell || !event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      setOver(false)
      const items = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file')
      if (!items.length || items.some(item => item.webkitGetAsEntry()?.isDirectory !== true)) {
        setError(COPY.foldersOnly)
        return
      }
      const files = Array.from(event.dataTransfer.files)
      void execute(async () => nativeResult(await shell.drop(project.id, files)))
    },
  }
  const missing = folders.filter(folder => folder.unavailable)
  return (
    <div className="project-editor">
      <SectionHeading title={escapeSecurityText(name)} />
      {error && (
        <InlineNotice
          tone={retry ? 'warn' : 'error'}
          action={
            retry ? (
              <Button size="xs" loading={busy} onClick={() => void execute(retry.run)}>
                {COPY.retry}
              </Button>
            ) : undefined
          }>
          {error}
        </InlineNotice>
      )}
      <SettingsGroup title={COPY.details}>
        <SettingsRow
          leading={<ProjectIcon project={project} />}
          title={COPY.name}
          description={<VisibleText text={name} />}
          trailing={
            owner ? (
              <Button onClick={() => setRenaming(true)} disabled={busy} icon={EditGlyph}>
                {COPY.rename}
              </Button>
            ) : undefined
          }
        />
        <SettingsRow
          title={COPY.icon}
          trailing={
            owner ? (
              <ValuePicker
                label={PROJECT_EDIT_COPY.projectIcon}
                value={project.glyph ?? 'folder'}
                disabled={busy}
                groups={[
                  {
                    id: 'glyphs',
                    options: PROJECT_GLYPHS.map(value => ({
                      value,
                      label: PROJECT_ICONS[value].label,
                      media: <Icon icon={PROJECT_ICONS[value].icon} size={16} />,
                    })),
                  },
                ]}
                onValueChange={value => {
                  void execute(() => api(endpoint, { method: 'PATCH', body: { glyph: value as ProjectGlyph } }))
                }}
              />
            ) : (
              (PROJECT_ICONS[project.glyph ?? 'folder']?.label ?? COPY.folder)
            )
          }
        />
        {(owner || project.defaultModel) && snapshot.catalog && (
          <SettingsRow
            title={COPY.defaultModel}
            trailing={
              owner ? (
                <ValuePicker
                  label={COPY.defaultModel}
                  value={project.defaultModel ? modelKey(project.defaultModel) : NO_MODEL}
                  disabled={busy}
                  searchable={snapshot.catalog.providers.reduce((sum, provider) => sum + provider.models.length, 0) >= 8}
                  width="sm"
                  header={{ title: COPY.defaultModelHint }}
                  groups={[
                    { id: '~none', options: [{ value: NO_MODEL, label: COPY.unset }] },
                    ...modelGroups(snapshot.catalog).filter(group => group.options.length > 0),
                    // A saved model that is off or gone now is still shown as what is saved.
                    ...(project.defaultModel
                    && !snapshot.catalog.providers.some(
                      provider => provider.id === project.defaultModel!.providerId && provider.models.includes(project.defaultModel!.model),
                    )
                      ? [
                          {
                            id: '~saved',
                            label: COPY.unavailable,
                            options: [{ value: modelKey(project.defaultModel), label: project.defaultModel.model }],
                          },
                        ]
                      : []),
                  ]}
                  onValueChange={value => {
                    const next = value === NO_MODEL ? null : modelFromKey(value)
                    if ((next ? modelKey(next) : NO_MODEL) === (project.defaultModel ? modelKey(project.defaultModel) : NO_MODEL)) return
                    void execute(() => api(endpoint, { method: 'PATCH', body: { defaultModel: next } }))
                  }}
                />
              ) : (
                <code className="settings-mono">{project.defaultModel?.model}</code>
              )
            }
          />
        )}
        <SettingsRow title={COPY.sessions(projectSessionCount(project, snapshot.tasks))} />
      </SettingsGroup>
      {onOpenSession && (
        <SettingsGroup title={COPY.recent}>
          <div className="project-recent-sessions">
            {recent.map(task => (
              <NavRow
                key={task.id}
                title={<VisibleText text={task.title || COPY.untitled} />}
                label={COPY.openSession(escapeSecurityText(task.title || COPY.untitled))}
                description={`${task.archived ? COPY.archived : ''}${statusLabels[task.status]} · ${relativeTime(task.updatedAt)}`}
                onClick={() => onOpenSession(task.id)}
              />
            ))}
            {recent.length === 0 && <SettingsRow title={COPY.empty} />}
          </div>
        </SettingsGroup>
      )}
      {missing.length > 0 && (
        <InlineNotice tone="warn" title={COPY.foldersUnavailable(missing.length)}>
          {COPY.restoreFolders}
        </InlineNotice>
      )}
      {refused && (
        <InlineNotice
          tone="error"
          action={
            <Button size="xs" onClick={() => setRefused(null)}>
              {COPY.ok}
            </Button>
          }>
          <span className="folder-refused">
            <strong>{COPY.refused(refused.refused.length)}</strong>
            {refused.added.length > 0 && <span>{COPY.addedOthers(refused.added.length)}</span>}
            {refused.refused.map(item => (
              <span key={item.path} className="folder-refused-line">
                <code>
                  <VisibleText text={item.path} />
                </code>
                <span>{describeFailure(item.status, item.code, item.message === undefined ? {} : { host: item.message })}</span>
              </span>
            ))}
          </span>
        </InlineNotice>
      )}
      <SettingsGroup
        title={COPY.folder}
        meta={
          shell ? (
            <Button
              variant="ghost"
              icon={FolderPlus}
              loading={busy}
              disabled={folders.length >= 8}
              tooltip={folders.length >= 8 ? PROJECT_EDIT_COPY.folderLimit : undefined}
              onClick={() => pick()}>
              {PROJECT_EDIT_COPY.addFolder}
            </Button>
          ) : undefined
        }
        note={
          <NoteLine
            icon={Send}
            brief={{
              label: COPY.modelScope,
              detail: COPY.modelScopeDetail,
            }}
          />
        }>
        <div className="project-folder-list" data-drop={over ? '' : undefined} {...folderDrop}>
          {over && (
            <p className="project-drop" role="status">
              <VisibleText text={COPY.drop(name)} />
            </p>
          )}
          {folders.map((folder, index) => {
            const base = basename(folder.path)
            const inUse = folderInUse(project, folder, snapshot)
            const removeReason = folders.length === 1 ? PROJECT_EDIT_COPY.needsFolder : inUse ? PROJECT_EDIT_COPY.folderInUse : undefined
            return (
              <div
                className="project-folder"
                key={folder.id}
                data-unavailable={folder.unavailable ? '' : undefined}
                onDragOver={event => {
                  if (dragged.current !== null) event.preventDefault()
                }}
                onDrop={event => {
                  if (dragged.current === null) return
                  event.preventDefault()
                  event.stopPropagation()
                  const from = folders.findIndex(item => item.id === dragged.current)
                  dragged.current = null
                  if (from >= 0) order(from, index)
                }}>
                {owner && folders.length > 1 && (
                  <IconButton
                    className="project-folder-grip"
                    label={COPY.reorder(escapeSecurityText(base))}
                    icon={GripVertical}
                    disabled={busy}
                    draggable={!busy}
                    onDragStart={event => {
                      dragged.current = folder.id
                      event.dataTransfer.setData('application/x-latch-folder', folder.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      dragged.current = null
                    }}
                    onKeyDown={event => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      order(index, index + (event.key === 'ArrowUp' ? -1 : 1))
                    }}
                  />
                )}
                <SettingsRow
                  leading={<IconTile icon={FolderOpenGlyph} />}
                  title={
                    <span className="settings-row-name">
                      <VisibleText text={base} />
                      {index === 0 && <Badge>{PROJECT_EDIT_COPY.main}</Badge>}
                    </span>
                  }
                  dim={folder.unavailable !== undefined}
                  description={
                    folder.unavailable ? (
                      <span>
                        <VisibleText text={folder.unavailable} /> · <VisibleText text={folder.path} />
                      </span>
                    ) : (
                      <MiddleEllipsis text={escapeSecurityText(folder.path)} className="settings-mono" />
                    )
                  }
                  trailing={
                    <Menu
                      label={COPY.folderActions(escapeSecurityText(base))}
                      align="end"
                      trigger={moreButton(COPY.folderActions(escapeSecurityText(base)))}
                      sections={[
                        {
                          id: 'file',
                          items: [
                            ...(shell && !folder.unavailable
                              ? [
                                  {
                                    id: 'reveal',
                                    label,
                                    icon: FolderOpenGlyph,
                                    onSelect: () => {
                                      void execute(async () => {
                                        const result = await shell.reveal(project.id, folder.id)
                                        if (result.status === 'failed') setError(COPY.folderNotFound)
                                      })
                                    },
                                  },
                                ]
                              : []),
                            {
                              id: 'copy',
                              label: COPY.copyPath,
                              icon: CopyGlyph,
                              onSelect: () => {
                                void copy.copy(folder.path)
                              },
                            },
                          ],
                        },
                        ...(owner
                          ? [
                              {
                                id: 'edit',
                                items: [
                                  ...(index !== 0
                                    ? [
                                        {
                                          id: 'primary',
                                          label: COPY.makeMain,
                                          disabledReason: busy ? COPY.saving : undefined,
                                          onSelect: () => order(index, 0),
                                        },
                                      ]
                                    : []),
                                  ...(index > 0
                                    ? [
                                        {
                                          id: 'up',
                                          label: COPY.moveUp,
                                          icon: ArrowUp,
                                          disabledReason: busy ? COPY.saving : undefined,
                                          onSelect: () => order(index, index - 1),
                                        },
                                      ]
                                    : []),
                                  ...(index < folders.length - 1
                                    ? [
                                        {
                                          id: 'down',
                                          label: COPY.moveDown,
                                          icon: ArrowDown,
                                          disabledReason: busy ? COPY.saving : undefined,
                                          onSelect: () => order(index, index + 1),
                                        },
                                      ]
                                    : []),
                                  ...(shell && folder.unavailable
                                    ? [
                                        {
                                          id: 'replace',
                                          label: COPY.reselect,
                                          icon: FolderOpenGlyph,
                                          disabledReason: busy ? COPY.saving : inUse ? PROJECT_EDIT_COPY.folderInUse : undefined,
                                          onSelect: () => pick(folder.id),
                                        },
                                      ]
                                    : []),
                                ],
                              },
                              {
                                id: 'remove',
                                items: [
                                  {
                                    id: 'remove',
                                    label: COPY.removeFolder,
                                    icon: TrashGlyph,
                                    danger: true,
                                    disabledReason: busy ? COPY.saving : removeReason,
                                    onSelect: () => setRemoving(folder),
                                  },
                                ],
                              },
                            ]
                          : []),
                      ]}
                    />
                  }
                />
              </div>
            )
          })}
        </div>
      </SettingsGroup>
      {!shell && (
        <p className="settings-caption">
          {currentShell() && currentShell()?.remote !== true && owner ? COPY.restart : COPY.editOnHost(computerName(snapshot.hostName))}
        </p>
      )}
      {folders.length > 1 && (
        <SettingsGroup title={COPY.harnessFolders} note={<NoteLine icon={ShieldGlyph} brief={SETUP_COPY.externalFolders} />}>
          {snapshot.catalog?.harnesses
            .filter(harness => harness.status === 'ready')
            .map(harness => (
              <SettingsRow
                key={harness.id}
                leading={<HarnessTile harness={harness} size={24} />}
                title={harnessName(harness)}
                description={folderAccessText(harness, folders.length)}
              />
            ))}
        </SettingsGroup>
      )}
      {owner && folders.length === 1 && project.branch !== undefined && snapshot.catalog?.features?.worktreeLifecycle && (
        <LeftoverWorktrees project={project} />
      )}
      {owner && (
        <SettingsGroup>
          <SettingsRow
            title={PROJECT_EDIT_COPY.remove}
            trailing={
              <Button
                variant="danger"
                disabled={busy || active}
                tooltip={active ? PROJECT_EDIT_COPY.projectInUse : undefined}
                onClick={() => setRemoving('project')}>
                {COPY.removeAction}
              </Button>
            }
          />
        </SettingsGroup>
      )}
      <span className="sr-only" role="status">
        {announcement || (copy.state === 'copied' ? COPY.copied : copy.state === 'failed' ? COPY.copyFailed : '')}
      </span>
      {renaming && (
        <PromptDialog
          title={COPY.renameProject}
          label={COPY.name}
          initial={name}
          maxLength={80}
          onClose={() => setRenaming(false)}
          onSubmit={async value => {
            await api(endpoint, { method: 'PATCH', body: { name: value } })
            onChanged()
            await reload()
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={
            removing === 'project'
              ? PROJECT_EDIT_COPY.confirmProject(escapeSecurityText(name))
              : PROJECT_EDIT_COPY.confirmFolder(escapeSecurityText(basename(removing.path)))
          }
          message={removing === 'project' ? DELETION_COPY.projectRemoval : DELETION_COPY.folderRemoval}
          confirmLabel={removing === 'project' ? PROJECT_EDIT_COPY.remove : PROJECT_EDIT_COPY.removeConfirm}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(removing === 'project' ? endpoint : `${endpoint}/folders/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            onChanged()
            await reload()
            if (removing === 'project') onRemoved()
          }}
        />
      )}
    </div>
  )
}
