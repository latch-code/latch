import { escapeSecurityText, type TaskSummary } from '@latch/protocol'
import { ChevronDownGlyph, FilterPills, Icon, IconButton, MoreGlyph, StatusWord } from '@latch/ui'
import { MarkTile } from '../components/BrandTile.tsx'
import { Menu, rowOf, type MenuSection } from '../components/overlays.tsx'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import { projectOf } from '../sessions.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { GROUP_LABELS, whoOf, WHO_CODE, type ListState } from './model.ts'
import { cardState, PriorityMark, TagChips, WhoMark } from './WorkBoardCard.tsx'

export const LIST_STATES: readonly ListState[] = ['all', 'attention', 'running', 'deliver', 'done', 'archived']
const STATE_LABELS: Record<ListState, string> = { all: '全部', ...GROUP_LABELS, archived: '已归档' }

function Row({
  task,
  shell,
  marked,
  menu,
  onOpen,
}: {
  task: TaskSummary
  shell: ShellState
  marked: boolean
  menu: MenuSection[]
  onOpen: (id: string) => void
}) {
  const connected = shell.connection === 'connected'
  const now = hostNow()
  const stopping = shell.stopping.has(task.id) || task.live?.activity === 'cancelling'
  const state = task.archived
    ? { tone: 'neutral' as const, words: '已归档' }
    : cardState(task, { connected, now, stopping, sharedFolder: false })
  const harness = shell.catalog?.harnesses.find(item => item.id === task.harnessId)
  const project = projectOf(task, shell.catalog?.workspaces ?? [])
  const title = escapeSecurityText(task.title || '未命名会话')
  return (
    <li className="work-board-row" data-work-session={task.id} data-marked={marked ? '' : undefined}>
      <button
        type="button"
        className="work-board-row-main"
        aria-current={marked ? 'true' : undefined}
        onClick={() => {
          onOpen(task.id)
        }}>
        <span className="work-board-row-title">
          <PriorityMark task={task} />
          <span className="work-board-card-title">{title}</span>
          <TagChips tags={task.tags} />
        </span>
        <StatusWord className="work-board-row-state" tone={state.tone}>
          {state.words}
        </StatusWord>
        <span className="work-board-row-project">{escapeSecurityText(project?.name ?? '无项目')}</span>
        <span className="work-board-row-harness">
          <MarkTile mark={harness?.capabilities.display.mark ?? task.harnessId} size={14} />
          <span>{escapeSecurityText(harness?.capabilities.display.label ?? task.harnessId ?? '')}</span>
        </span>
        <span className="work-board-row-who">{whoOf(task) === WHO_CODE ? 'Code' : <WhoMark task={task} shell={shell} />}</span>
        <time className="work-board-row-time" dateTime={task.updatedAt}>
          {relativeTime(task.updatedAt, new Date(now))}
        </time>
      </button>
      <span className="work-board-card-actions">
        <Menu
          label={`看板操作：${title}`}
          placement="bottom-end"
          context={rowOf('.work-board-row')}
          sections={menu}
          trigger={props => (
            <IconButton
              {...props}
              className="work-board-card-more"
              size="xs"
              label={`更多操作：${title}`}
              tooltip="更多操作"
              icon={MoreGlyph}
            />
          )}
        />
      </span>
    </li>
  )
}

/**
 * The list: one row per session, 已结束 in full and 已归档 under its own state. By group, priority and time, or (the
 * time heading pressed) by time alone. A row opens and has the same menu as a card.
 */
export function WorkBoardTable({
  rows,
  shell,
  state,
  onState,
  counts,
  order,
  onOrder,
  marked,
  menuFor,
  onOpen,
}: {
  rows: readonly TaskSummary[]
  shell: ShellState
  state: ListState
  onState: (state: ListState) => void
  counts: Partial<Record<ListState, number>>
  order: 'group' | 'time'
  onOrder: (order: 'group' | 'time') => void
  marked: string | null
  menuFor: (task: TaskSummary) => MenuSection[]
  onOpen: (id: string) => void
}) {
  useTicker(shell.connection === 'connected' ? 'minute' : false)
  return (
    <div className="work-board-table">
      <FilterPills
        className="work-board-states"
        label="状态"
        value={state}
        options={LIST_STATES.map(value => ({
          value,
          label: counts[value] === undefined ? STATE_LABELS[value] : `${STATE_LABELS[value]} ${counts[value]}`,
        }))}
        onValueChange={onState}
      />
      <div className="work-board-table-head">
        <span>会话</span>
        <span>状态</span>
        <span className="work-board-row-project">项目</span>
        <span className="work-board-row-harness">Harness</span>
        <span className="work-board-row-who">谁在做</span>
        <button
          type="button"
          className="work-board-order work-board-row-time"
          aria-pressed={order === 'time'}
          onClick={() => {
            onOrder(order === 'time' ? 'group' : 'time')
          }}>
          更新时间
          {order === 'time' && <Icon icon={ChevronDownGlyph} size={12} />}
        </button>
      </div>
      {rows.length ? (
        <ul className="work-board-rows" aria-label={STATE_LABELS[state]}>
          {rows.map(task => (
            <Row key={task.id} task={task} shell={shell} marked={marked === task.id} menu={menuFor(task)} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <div className="work-board-rows" data-empty="">
          <span className="work-board-empty-line" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
