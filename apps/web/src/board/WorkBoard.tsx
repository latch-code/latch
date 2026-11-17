import type { AutomationSummary } from '@latch/protocol'
import { escapeSecurityText } from '@latch/protocol'
import {
  Count,
  Icon,
  PullRequestGlyph,
  RunningGlyph,
  ScheduleGlyph,
  StatusWord,
  Tooltip,
  WaitingGlyph,
  type IconComponent,
} from '@latch/ui'
import { Ban, CircleCheck, ListTodo } from 'lucide-react'
import type { PointerEvent, ReactNode } from 'react'
import { GROUP_LABELS, type BoardCard, type BoardColumn, type BoardColumnGroup } from './model.ts'
import type { BoardDragView } from './useBoardDrag.ts'

const GROUP_ICONS: Record<BoardColumnGroup, IconComponent> = {
  todo: ListTodo,
  attention: WaitingGlyph,
  running: RunningGlyph,
  deliver: PullRequestGlyph,
  done: CircleCheck,
}

/** The column's count: the whole column, or 「shown / whole」 while a filter narrows it. Amber only for 等你处理. */
function ColumnCount({ column, filtered }: { column: BoardColumn; filtered: boolean }) {
  const tone = column.group === 'attention' && column.total > 0 ? 'warn' : 'neutral'
  if (!filtered) return <Count value={column.total} tone={tone} label={`${column.total} 个`} />
  return (
    <span className="work-board-count" data-tone={tone} aria-label={`显示 ${column.cards.length} 个，共 ${column.total} 个`}>
      {column.cards.length} / {column.total}
    </span>
  )
}

/** The next times of the schedules that are on, under 进行中: what will start by itself. */
function Schedules({ schedules, now }: { schedules: readonly AutomationSummary[]; now: number }) {
  const next = schedules
    .filter(item => item.enabled && (item.nextRunAt || item.lastRun?.state === 'missed'))
    .toSorted((a, b) => (Date.parse(a.nextRunAt ?? '') || Infinity) - (Date.parse(b.nextRunAt ?? '') || Infinity))
    .slice(0, 3)
  if (!next.length) return null
  const at = (value: string) => {
    const time = new Date(value)
    const sameDay = new Date(now).toDateString() === time.toDateString()
    return sameDay
      ? time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : time.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return (
    <ul className="work-board-schedules" aria-label="定时任务">
      {next.map(item => (
        <li key={item.id}>
          <Icon icon={ScheduleGlyph} size={12} />
          <span className="work-board-schedule-name">{escapeSecurityText(item.name)}</span>
          {item.lastRun?.state === 'missed' && <StatusWord tone="warn">错过</StatusWord>}
          {item.nextRunAt && <time dateTime={item.nextRunAt}>{at(item.nextRunAt)}</time>}
        </li>
      ))}
    </ul>
  )
}

/** While a card is dragged: its own column, one it may be dropped on, or one it may not. */
function dropState(drag: BoardDragView | null | undefined, group: BoardColumnGroup): 'source' | 'target' | 'forbidden' | undefined {
  if (!drag) return undefined
  if (group === drag.source) return 'source'
  return drag.targets.has(group) ? 'target' : 'forbidden'
}

/**
 * The five columns, as equal cells that reflow by the board's own width (work-board.css): five in a row from 1280px,
 * 3 + 2 from 776px, 2 + 2 + 1 below. Every cell scrolls its own cards under a fixed head; an empty one is its head and
 * a quiet line, so the layout never depends on what a column holds. 未开始's head carries 全部开始.
 */
export function WorkBoard({
  columns,
  filtered,
  schedules,
  now,
  renderCard,
  todoAction,
  drag,
  onPointerDown,
}: {
  columns: readonly BoardColumn[]
  filtered: boolean
  schedules: readonly AutomationSummary[]
  now: number
  renderCard: (card: BoardCard, column: BoardColumn, index: number) => ReactNode
  /** In 未开始's head: 全部开始, while it has cards this device may start. */
  todoAction?: ReactNode
  /** A card being dragged: where it may go. */
  drag?: BoardDragView | null
  /** A press on a card's own button that may become a drag (useBoardDrag). */
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void
}) {
  return (
    <div className="work-board-columns" data-columns={columns.length} data-drag={drag ? '' : undefined} onPointerDown={onPointerDown}>
      {columns.map(column => {
        const drop = dropState(drag, column.group)
        return (
          <section
            key={column.group}
            className="work-board-column"
            data-group={column.group}
            data-drop={drop}
            data-over={drop === 'target' && drag?.over === column.group ? '' : undefined}
            aria-label={GROUP_LABELS[column.group]}>
            <header className="work-board-column-head" tabIndex={-1}>
              <Icon icon={GROUP_ICONS[column.group]} size={14} />
              <h3>{GROUP_LABELS[column.group]}</h3>
              <ColumnCount column={column} filtered={filtered} />
              {drop === 'forbidden' && (
                <Tooltip content="不能放到这里">
                  <span className="work-board-column-forbidden" role="img" aria-label="不能放到这里">
                    <Icon icon={Ban} size={14} />
                  </span>
                </Tooltip>
              )}
              {column.group === 'todo' && todoAction && <span className="work-board-column-action">{todoAction}</span>}
            </header>
            {column.cards.length ? (
              <ul className="work-board-cards">
                {column.cards.map((card, index) => (
                  <li key={card.id}>{renderCard(card, column, index)}</li>
                ))}
              </ul>
            ) : (
              <div className="work-board-cards" data-empty="">
                <span className="work-board-empty-line" aria-hidden="true" />
              </div>
            )}
            {column.group === 'running' && <Schedules schedules={schedules} now={now} />}
          </section>
        )
      })}
    </div>
  )
}
