import { ArchiveRestore, Eraser, FolderPlus, FolderX, ListMinus, ListPlus, Mail, Tag } from 'lucide-react'
import { ArchiveGlyph, CheckGlyph, DownloadGlyph, CopyGlyph, EditGlyph, PinGlyph, UnpinGlyph, TrashGlyph } from '@latch/ui'
import type { BoardPriority, TaskSummary } from '@latch/protocol'
import type { MenuSection } from './components/overlays.tsx'
import { isActive } from './format.ts'
import { defineCopy } from './core/i18n.ts'

const COPY = defineCopy(
  {
    high: '高',
    medium: '中',
    low: '低',
    tags: '标签…',
    priority: '优先级',
    export: '导出 Markdown',
    rename: '重命名',
    unpin: '取消置顶',
    pin: '置顶',
    unread: '标为未读',
    join: '加入待办…',
    leave: '移出待办',
    copy: '复制为 Markdown',
    keep: '保留上下文',
    clear: '清空上下文',
    clearBusy: '这一轮结束后才能清空上下文',
    save: '存为项目…',
    unarchive: '取消归档',
    archive: '归档',
    removeWorktree: '移除工作树…',
    worktreeBusy: '这一轮结束后才能移除工作树',
    delete: '删除',
    deleteBusy: '运行中的会话需要先停止',
  },
  {
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    tags: 'Tags…',
    priority: 'Priority',
    export: 'Export Markdown',
    rename: 'Rename',
    unpin: 'Unpin',
    pin: 'Pin',
    unread: 'Mark as unread',
    join: 'Add to to-do…',
    leave: 'Remove from to-do',
    copy: 'Copy as Markdown',
    keep: 'Keep context',
    clear: 'Clear context',
    clearBusy: 'Clear context after this turn ends',
    save: 'Save as project…',
    unarchive: 'Unarchive',
    archive: 'Archive',
    removeWorktree: 'Remove worktree…',
    worktreeBusy: 'Remove the worktree after this turn ends',
    delete: 'Delete',
    deleteBusy: 'Stop the session before deleting',
  },
)

/** What `PATCH /tasks/:id` changes from a menu; `priority: 'mid'` removes it. */
export interface SessionPatch {
  pinned?: boolean
  archived?: boolean
  tags?: string[] | null
  priority?: BoardPriority | 'mid'
}

/** 标签… and 优先级 of a session, offered only where the Host groups sessions and the device may change them. */
export interface BoardMarkActions {
  /** Undefined is 中, the default. */
  setPriority: (priority: BoardPriority | undefined) => void
  editTags: () => void
}

const PRIORITIES: ReadonlyArray<{ value: BoardPriority | undefined; id: string; label: string }> = [
  {
    value: 'high',
    id: 'priority-high',
    get label() {
      return COPY.high
    },
  },
  {
    value: undefined,
    id: 'priority-mid',
    get label() {
      return COPY.medium
    },
  },
  {
    value: 'low',
    id: 'priority-low',
    get label() {
      return COPY.low
    },
  },
]

/**
 * 标签… and the three priorities, the chosen one checked: the same items in the session menu and on a board card's ⋯,
 * so both read and change the same Host metadata.
 */
export function boardMarkSections(task: Pick<TaskSummary, 'priority'>, actions: BoardMarkActions): MenuSection[] {
  return [
    { id: 'tags', items: [{ id: 'tags', label: COPY.tags, icon: Tag, onSelect: actions.editTags }] },
    {
      id: 'priority',
      label: COPY.priority,
      items: PRIORITIES.map(({ value, id, label }) => ({
        id,
        label,
        ...(task.priority === value ? { icon: CheckGlyph } : {}),
        onSelect: () => {
          if (task.priority !== value) actions.setPriority(value)
        },
      })),
    },
  ]
}

export interface SessionActions {
  rename: () => void
  /** 标签… and 优先级 (`boardMarkSections`). */
  marks?: BoardMarkActions | undefined
  /** A Code session on a Host with 待办: 加入待办… while it is in none, 移出待办 while it is in one. */
  item?: { join: () => void } | { leave: () => void } | undefined
  pin: () => void
  archive?: () => void
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
  remove?: () => void
}

/**
 * The one session menu: the title row's ⋯ (and its title), a sidebar row's ⋯ and a phone row held down all draw this.
 * The open session has eight items; any other row seven, since only the open one can clear its context; a Host that
 * groups sessions adds 标签… and 优先级 for a device that may change them, and one with 待办 加入待办… or 移出待办. While a turn
 * runs or waits, 清空上下文 and 删除 stay in place, greyed, each with the reason under it. 同步最新状态 is not here: the
 * connection's own notice retries. A Host without a catalog predates rename, pin, archive and delete, so only export
 * remains there.
 */
export function sessionMenuSections(task: TaskSummary, actions: SessionActions, manage: boolean): MenuSection[] {
  const exportItem = { id: 'export', label: COPY.export, icon: DownloadGlyph, onSelect: actions.export }
  if (!manage) return [{ id: 'manage', items: [exportItem] }]
  return [
    {
      id: 'manage',
      items: [
        { id: 'rename', label: COPY.rename, icon: EditGlyph, onSelect: actions.rename },
        { id: 'pin', label: task.pinned ? COPY.unpin : COPY.pin, icon: task.pinned ? UnpinGlyph : PinGlyph, onSelect: actions.pin },
        ...(actions.unread ? [{ id: 'unread', label: COPY.unread, icon: Mail, onSelect: actions.unread }] : []),
      ],
    },
    ...(actions.marks ? boardMarkSections(task, actions.marks) : []),
    ...(actions.item
      ? [
          {
            id: 'item',
            items: [
              'join' in actions.item
                ? { id: 'item-join', label: COPY.join, icon: ListPlus, onSelect: actions.item.join }
                : { id: 'item-leave', label: COPY.leave, icon: ListMinus, onSelect: actions.item.leave },
            ],
          },
        ]
      : []),
    {
      id: 'share',
      items: [...(actions.copy ? [{ id: 'copy', label: COPY.copy, icon: CopyGlyph, onSelect: actions.copy }] : []), exportItem],
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
                      label: actions.clearing ? COPY.keep : COPY.clear,
                      icon: Eraser,
                      disabled: !actions.clearing && isActive(task.status),
                      disabledReason: COPY.clearBusy,
                      onSelect: actions.clear,
                    },
                  ]
                : []),
              ...(actions.saveProject ? [{ id: 'save-project', label: COPY.save, icon: FolderPlus, onSelect: actions.saveProject }] : []),
            ],
          },
        ]
      : []),
    ...(actions.archive || actions.removeWorktree
      ? [
          {
            id: 'archive',
            items: [
              ...(actions.archive
                ? [
                    {
                      id: 'archive',
                      label: task.archived ? COPY.unarchive : COPY.archive,
                      icon: task.archived ? ArchiveRestore : ArchiveGlyph,
                      onSelect: actions.archive,
                    },
                  ]
                : []),
              // Archiving keeps the worktree; removing it is its own step.
              ...(actions.removeWorktree
                ? [
                    {
                      id: 'remove-worktree',
                      label: COPY.removeWorktree,
                      icon: FolderX,
                      disabled: isActive(task.status),
                      disabledReason: COPY.worktreeBusy,
                      onSelect: actions.removeWorktree,
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    ...(actions.remove
      ? [
          {
            id: 'danger',
            items: [
              {
                id: 'delete',
                label: COPY.delete,
                icon: TrashGlyph,
                danger: true,
                disabled: isActive(task.status),
                disabledReason: COPY.deleteBusy,
                onSelect: actions.remove,
              },
            ],
          },
        ]
      : []),
  ]
}
