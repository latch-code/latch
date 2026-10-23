import { Archive, ArchiveRestore, Download, PenLine, Pin, PinOff, Trash } from 'lucide-react'
import type { TaskSummary } from '../shared/types.ts'
import type { MenuSection } from './components/overlays.tsx'
import { isActive } from './format.ts'

export interface SessionActions {
  rename: () => void
  pin: () => void
  archive: () => void
  export: () => void
  remove: () => void
}

/** A Host without a catalog predates rename, pin, archive and delete, so only export remains there. */
export function sessionMenuSections(task: TaskSummary, actions: SessionActions, manage: boolean): MenuSection[] {
  const exportItem = { id: 'export', label: '导出 Markdown', icon: Download, onSelect: actions.export }
  if (!manage) return [{ id: 'manage', items: [exportItem] }]
  return [
    { id: 'manage', items: [
      { id: 'rename', label: '重命名', icon: PenLine, onSelect: actions.rename },
      { id: 'pin', label: task.pinned ? '取消置顶' : '置顶', icon: task.pinned ? PinOff : Pin, onSelect: actions.pin },
      { id: 'archive', label: task.archived ? '取消归档' : '归档', icon: task.archived ? ArchiveRestore : Archive, onSelect: actions.archive },
      exportItem,
    ] },
    { id: 'danger', items: [
      { id: 'delete', label: '删除', icon: Trash, danger: true, disabled: isActive(task.status), disabledReason: '运行中的会话需要先停止', onSelect: actions.remove },
    ] },
  ]
}
