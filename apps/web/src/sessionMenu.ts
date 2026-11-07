import { Archive, ArchiveRestore, Download, Eraser, FolderPlus, GitFork, Mail, Copy, PenLine, Pin, PinOff, Trash } from 'lucide-react'
import type { TaskSummary } from '@latch/protocol'
import type { MenuSection } from './components/overlays.tsx'
import { isActive } from './format.ts'

export interface SessionActions {
  rename: () => void
  pin: () => void
  archive: () => void
  export: () => void
  fork?: () => void
  /** The open session: its next prompt starts a new context, or (`clearing`) no longer does. */
  clear?: () => void
  clearing?: boolean
  /** A session in its own folder, on the Mac: keep the folder as a project. */
  saveProject?: () => void
  unread?: () => void
  copy?: () => void
  remove: () => void
}

/** A Host without a catalog predates rename, pin, archive and delete, so only export remains there. */
export function sessionMenuSections(task: TaskSummary, actions: SessionActions, manage: boolean): MenuSection[] {
  const exportItem = { id: 'export', label: '导出 Markdown', icon: Download, onSelect: actions.export }
  if (!manage) return [{ id: 'manage', items: [exportItem] }]
  return [
    {
      id: 'manage',
      items: [
        { id: 'rename', label: '重命名', icon: PenLine, onSelect: actions.rename },
        { id: 'pin', label: task.pinned ? '取消置顶' : '置顶', icon: task.pinned ? PinOff : Pin, onSelect: actions.pin },
        ...(actions.unread ? [{ id: 'unread', label: '标为未读', icon: Mail, onSelect: actions.unread }] : []),
      ],
    },
    {
      id: 'share',
      items: [...(actions.copy ? [{ id: 'copy', label: '复制为 Markdown', icon: Copy, onSelect: actions.copy }] : []), exportItem],
    },
    ...(actions.fork || actions.saveProject || actions.clear
      ? [
          {
            id: 'fork',
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
              ...(actions.fork ? [{ id: 'fork', label: '从这里分叉', icon: GitFork, onSelect: actions.fork }] : []),
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
          icon: task.archived ? ArchiveRestore : Archive,
          onSelect: actions.archive,
        },
      ],
    },
    {
      id: 'danger',
      items: [
        {
          id: 'delete',
          label: '删除',
          icon: Trash,
          danger: true,
          disabled: isActive(task.status),
          disabledReason: '运行中的会话需要先停止',
          onSelect: actions.remove,
        },
      ],
    },
  ]
}
