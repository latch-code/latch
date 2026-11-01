import { useRef, useState, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, Copy, FolderOpen, FolderPlus, GripVertical, Pencil, Trash } from 'lucide-react'
import {
  escapeSecurityText,
  PROJECT_GLYPHS,
  type AppSnapshot,
  type ProjectGlyph,
  type WorkspaceFolder,
  type WorkspaceInfo,
} from '@latch/protocol'
import { Badge, Button, Icon, IconButton, InlineNotice, Menu, ValuePicker, useCopy } from '@latch/ui'
import { api, errorMessage, isUncertain } from '../core/api.ts'
import { describeFailure } from '../core/securityCopy.ts'
import { currentShell, revealLabel, type FolderResult, type ShellFolders } from '../core/shell.ts'
import { basename, relativeTime, statusLabels } from '../format.ts'
import { recentProjectSessions } from '../sessions.ts'
import { folderAccessText, PROJECT_ICONS, ProjectIcon, projectFolders, projectName, projectSessionCount } from '../projects.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ConfirmDialog, PromptDialog } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { IconTile, MiddleEllipsis, moreButton, NavRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'

function folderInUse(project: WorkspaceInfo, folder: WorkspaceFolder, snapshot: AppSnapshot): boolean {
  return snapshot.tasks.some(
    task =>
      (task.status === 'running' || task.status === 'waiting-approval')
      && (task.workspaceId === project.id || task.workspaceId === undefined)
      && (task.folders?.some(item => item.path === folder.path) || task.cwd === folder.path),
  )
}

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
  const active = snapshot.tasks.some(
    task => (task.status === 'running' || task.status === 'waiting-approval') && task.workspaceId === project.id,
  )

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
    else if (result.status === 'busy') setError('另一个系统对话框还没结束，请稍后再试。')
    else if (result.status === 'failed') setError(describeFailure(0, result.code, '没有完成文件夹操作，请同步项目后重试。'))
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
      setAnnouncement(`${basename(folders[from]!.path)} 已移到第 ${to + 1} 位${to === 0 ? '，现在是主文件夹' : ''}`)
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
        setError('只能拖入文件夹。')
        return
      }
      const files = Array.from(event.dataTransfer.files)
      void execute(async () => nativeResult(await shell.drop(project.id, files)))
    },
  }
  const missing = folders.filter(folder => folder.unavailable)
  return (
    <div className="project-editor">
      <SectionHeading
        title={escapeSecurityText(name)}
        description={`新会话在主文件夹「${escapeSecurityText(basename(folders[0]!.path))}」中启动。`}
      />
      {error && (
        <InlineNotice
          tone={retry ? 'warn' : 'error'}
          action={
            retry ? (
              <Button size="xs" loading={busy} onClick={() => void execute(retry.run)}>
                重试原操作
              </Button>
            ) : undefined
          }>
          {error}
        </InlineNotice>
      )}
      <SettingsGroup title="基本信息">
        <SettingsRow
          leading={<ProjectIcon project={project} />}
          title="名称"
          description={<VisibleText text={name} />}
          trailing={
            owner ? (
              <Button onClick={() => setRenaming(true)} disabled={busy} icon={Pencil}>
                重命名…
              </Button>
            ) : undefined
          }
        />
        <SettingsRow
          title="图标"
          trailing={
            owner ? (
              <ValuePicker
                label="项目图标"
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
              (PROJECT_ICONS[project.glyph ?? 'folder']?.label ?? '文件夹')
            )
          }
        />
        <SettingsRow title={`${projectSessionCount(project, snapshot.tasks)} 个会话`} description="已有会话保留开始时记录的文件夹。" />
      </SettingsGroup>
      {onOpenSession && (
        <SettingsGroup title="最近会话" caption="按最近更新排列，打开会话继续查看。">
          <div className="project-recent-sessions">
            {recent.map(task => (
              <NavRow
                key={task.id}
                title={<VisibleText text={task.title || '未命名会话'} />}
                label={`打开会话：${escapeSecurityText(task.title || '未命名会话')}`}
                description={`${task.archived ? '已归档 · ' : ''}${statusLabels[task.status]} · ${relativeTime(task.updatedAt)}`}
                onClick={() => onOpenSession(task.id)}
              />
            ))}
            {recent.length === 0 && <SettingsRow title="还没有可访问的会话" description="在这个项目开始工作后，会话会显示在这里。" />}
          </div>
        </SettingsGroup>
      )}
      {missing.length > 0 && (
        <InlineNotice tone="warn">{missing.length} 个文件夹暂不可用。项目已保留，恢复或重新选择之前不能在这里新建会话。</InlineNotice>
      )}
      {refused && (
        <InlineNotice
          tone="error"
          action={
            <Button size="xs" onClick={() => setRefused(null)}>
              知道了
            </Button>
          }>
          <span className="folder-refused">
            <strong>{refused.refused.length} 个文件夹没有加入</strong>
            {refused.added.length > 0 && <span>已加入其余 {refused.added.length} 个。</span>}
            {refused.refused.map(item => (
              <span key={item.path} className="folder-refused-line">
                <code>
                  <VisibleText text={item.path} />
                </code>
                <span>{describeFailure(item.status, item.code, item.message ?? '')}</span>
              </span>
            ))}
          </span>
        </InlineNotice>
      )}
      <SettingsGroup
        title="文件夹"
        meta={
          shell ? (
            <Button
              variant="ghost"
              icon={FolderPlus}
              loading={busy}
              disabled={folders.length >= 8}
              tooltip={folders.length >= 8 ? '每个项目最多 8 个文件夹' : undefined}
              onClick={() => pick()}>
              添加文件夹…
            </Button>
          ) : undefined
        }
        caption="Latch 内置可以读取这些文件夹中的文件，并把读到的内容发给模型服务；写入前会询问你。">
        <div className="project-folder-list" data-drop={over ? '' : undefined} {...folderDrop}>
          {over && (
            <p className="project-drop" role="status">
              松开以添加到「
              <VisibleText text={name} />」
            </p>
          )}
          {folders.map((folder, index) => {
            const base = basename(folder.path)
            const inUse = folderInUse(project, folder, snapshot)
            const removeReason = folders.length === 1 ? '项目至少要有一个文件夹' : inUse ? '有正在运行或等待批准的会话使用它' : undefined
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
                    label={`调整 ${escapeSecurityText(base)} 的顺序`}
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
                  leading={<IconTile icon={FolderOpen} />}
                  title={
                    <span className="settings-row-name">
                      <VisibleText text={base} />
                      {index === 0 && <Badge>主文件夹</Badge>}
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
                      label={`${escapeSecurityText(base)} 的更多操作`}
                      align="end"
                      trigger={moreButton(`${escapeSecurityText(base)} 的更多操作`)}
                      sections={[
                        {
                          id: 'file',
                          items: [
                            ...(shell && !folder.unavailable
                              ? [
                                  {
                                    id: 'reveal',
                                    label,
                                    icon: FolderOpen,
                                    onSelect: () => {
                                      void execute(async () => {
                                        const result = await shell.reveal(project.id, folder.id)
                                        if (result.status === 'failed') setError('找不到这个文件夹，请同步项目后重试。')
                                      })
                                    },
                                  },
                                ]
                              : []),
                            {
                              id: 'copy',
                              label: '复制路径',
                              icon: Copy,
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
                                          label: '设为主文件夹',
                                          disabledReason: busy ? '正在保存项目' : undefined,
                                          onSelect: () => order(index, 0),
                                        },
                                      ]
                                    : []),
                                  ...(index > 0
                                    ? [
                                        {
                                          id: 'up',
                                          label: '向上移动',
                                          icon: ArrowUp,
                                          disabledReason: busy ? '正在保存项目' : undefined,
                                          onSelect: () => order(index, index - 1),
                                        },
                                      ]
                                    : []),
                                  ...(index < folders.length - 1
                                    ? [
                                        {
                                          id: 'down',
                                          label: '向下移动',
                                          icon: ArrowDown,
                                          disabledReason: busy ? '正在保存项目' : undefined,
                                          onSelect: () => order(index, index + 1),
                                        },
                                      ]
                                    : []),
                                  ...(shell && folder.unavailable
                                    ? [
                                        {
                                          id: 'replace',
                                          label: '重新选择…',
                                          icon: FolderOpen,
                                          disabledReason: busy ? '正在保存项目' : inUse ? '有正在运行或等待批准的会话使用它' : undefined,
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
                                    label: '从项目中移除…',
                                    icon: Trash,
                                    danger: true,
                                    disabledReason: busy ? '正在保存项目' : removeReason,
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
          {currentShell() && owner
            ? '重新启动 Latch 桌面端后，可以在这里添加和重新选择文件夹。'
            : '添加项目和添加文件夹要在 Mac 上用桌面端完成。'}
        </p>
      )}
      {folders.length > 1 && (
        <SettingsGroup title="各 Harness 使用的文件夹" caption="Harness 以完全访问运行时，文件夹范围由 Harness 自己执行，不是隔离。">
          {snapshot.catalog?.harnesses
            .filter(harness => harness.status === 'ready')
            .map(harness => (
              <SettingsRow
                key={harness.id}
                leading={<HarnessTile harness={harness} size={24} />}
                title={harness.name}
                description={folderAccessText(harness, folders.length)}
              />
            ))}
        </SettingsGroup>
      )}
      {owner && (
        <SettingsGroup>
          <SettingsRow
            title="移除项目"
            description="文件夹中的文件不会被删除。"
            trailing={
              <Button
                variant="danger"
                disabled={busy || active}
                tooltip={active ? '有会话正在项目中运行，请先结束' : undefined}
                onClick={() => setRemoving('project')}>
                移除项目…
              </Button>
            }
          />
        </SettingsGroup>
      )}
      <span className="sr-only" role="status">
        {announcement || (copy.state === 'copied' ? '已复制路径' : copy.state === 'failed' ? '复制失败' : '')}
      </span>
      {renaming && (
        <PromptDialog
          title="重命名项目"
          label="名称"
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
              ? `移除项目「${escapeSecurityText(name)}」？`
              : `从项目中移除「${escapeSecurityText(basename(removing.path))}」？`
          }
          message="文件夹中的文件不会被删除。在这个项目中使用这些文件夹的已有会话仍可查看，但不能继续。"
          confirmLabel={removing === 'project' ? '移除项目' : '移除'}
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
