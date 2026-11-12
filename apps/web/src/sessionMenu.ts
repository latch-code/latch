import { ArchiveRestore, Eraser, FolderPlus, FolderX, Mail } from 'lucide-react'
import { ArchiveGlyph, DownloadGlyph, CopyGlyph, EditGlyph, PinGlyph, UnpinGlyph, TrashGlyph } from '@latch/ui'
import type { TaskSummary } from '@latch/protocol'
import type { MenuSection } from './components/overlays.tsx'
import { isActive } from './format.ts'

export interface SessionActions {
  rename: () => void
  pin: () => void
  archive: () => void
  export: () => void
  /** The open session: its next prompt starts a new context, or (`clearing`) no longer does. */
  clear?: () => void
  clearing?: boolean
  /** A session in its own folder, on the Mac: keep the folder as a project. */
  saveProject?: () => void
  unread?: () => void
  copy?: () => void
  /** A session in a Latch worktree that is still there: 移除工作树…, which shows what it has first. */
  removeWorktree?: () => void
  remove: () => void
}

/**
 * The one session menu: the title row's ⋯ (and its title), a sidebar row's ⋯ and a phone row held down all draw this.
 * The open session has eight items; any other row seven, since only the open one can clear its context. While a turn
 * runs or waits, 清空上下文 and 删除 stay in place, greyed, each with the reason under it. 同步最新状态 is not here: the
 * connection's own notice retries. A Host without a catalog predates rename, pin, archive and delete, so only export
 * remains there.
 */
export function sessionMenuSections(task: TaskSummary, actions: SessionActions, manage: boolean): MenuSection[] {
  const exportItem = { id: 'export', label: '导出 Markdown', icon: DownloadGlyph, onSelect: actions.export }
  if (!manage) return [{ id: 'manage', items: [exportItem] }]
  return [
    {
      id: 'manage',
      items: [
        { id: 'rename', label: '重命名', icon: EditGlyph, onSelect: actions.rename },
        { id: 'pin', label: task.pinned ? '取消置顶' : '置顶', icon: task.pinned ? UnpinGlyph : PinGlyph, onSelect: actions.pin },
        ...(actions.unread ? [{ id: 'unread', label: '标为未读', icon: Mail, onSelect: actions.unread }] : []),
      ],
    },
    {
      id: 'share',
      items: [...(actions.copy ? [{ id: 'copy', label: '复制为 Markdown', icon: CopyGlyph, onSelect: actions.copy }] : []), exportItem],
    },
    ...(actions.saveProject || actions.clear
      ? [
          {
            id: 'context',
            items: [
              ...(actions.clear
                ? [
                    {
                      id: 'clear',
                      label: actions.clearing ? '保留上下文' : '清空上下文',
                      icon: Eraser,
                      disabled: !actions.clearing && isActive(task.status),
                      disabledReason: '这一轮结束后才能清空上下文',
                      onSelect: actions.clear,
                    },
                  ]
                : []),
              ...(actions.saveProject ? [{ id: 'save-project', label: '存为项目…', icon: FolderPlus, onSelect: actions.saveProject }] : []),
            ],
          },
        ]
      : []),
    {
      id: 'archive',
      items: [
        {
          id: 'archive',
          label: task.archived ? '取消归档' : '归档',
          icon: task.archived ? ArchiveRestore : ArchiveGlyph,
          onSelect: actions.archive,
        },
        // Archiving keeps the worktree; removing it is its own step.
        ...(actions.removeWorktree
          ? [
              {
                id: 'remove-worktree',
                label: '移除工作树…',
                icon: FolderX,
                disabled: isActive(task.status),
                disabledReason: '这一轮结束后才能移除工作树',
                onSelect: actions.removeWorktree,
              },
            ]
          : []),
      ],
    },
    {
      id: 'danger',
      items: [
        {
          id: 'delete',
          label: '删除',
          icon: TrashGlyph,
          danger: true,
          disabled: isActive(task.status),
          disabledReason: '运行中的会话需要先停止',
          onSelect: actions.remove,
        },
      ],
    },
  ]
}
