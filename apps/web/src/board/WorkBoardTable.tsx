import { useState } from 'react'
import { escapeSecurityText, type TaskSummary, type WorkItemSummary } from '@latch/protocol'
import { ChevronDownGlyph, ChevronRightGlyph, FilterPills, Icon, IconButton, MoreGlyph, StatusWord } from '@latch/ui'
import { Lightbulb, ListTodo } from 'lucide-react'
import { MarkTile } from '../components/BrandTile.tsx'
import { Menu, rowOf, type MenuSection } from '../components/overlays.tsx'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import { projectOf } from '../sessions.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { ItemWriteState } from './itemWrites.ts'
import { cardUpdatedAt, GROUP_LABELS, whoOf, WHO_CODE, type BoardCard, type ListState } from './model.ts'
import { cardState, PriorityMark, TagChips, WhoMark } from './WorkBoardCard.tsx'
import { itemState, type ItemCard } from './WorkBoardItemCard.tsx'
import { ItemWriteLine } from './WriteLine.tsx'
import { pendingEntries, type TodoProposal } from './proposals.ts'
import { ExternalMark, ProposedBy } from './WorkBoardProposalCard.tsx'

export const LIST_STATES: readonly ListState[] = ['all', 'todo', 'attention', 'running', 'deliver', 'done', 'archived']
const STATE_LABELS: Record<ListState, string> = { all: '全部', ...GROUP_LABELS, archived: '已归档' }

function Row({
  task,
  shell,
  marked,
  menu,
  onOpen,
  nested = false,
}: {
  task: TaskSummary
  shell: ShellState
  marked: boolean
  menu: MenuSection[]
  onOpen: (id: string) => void
  /** A session of the 待办 above it. */
  nested?: boolean
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
    <li className="work-board-row" data-work-session={task.id} data-marked={marked ? '' : undefined} data-nested={nested ? '' : undefined}>
      <button
        type="button"
        className="work-board-row-main"
        aria-current={marked ? 'true' : undefined}
        onClick={() => {
          onOpen(task.id)
        }}>
        <span className="work-board-row-title">
          <PriorityMark task={task} reserve />
          <span className="work-board-card-title">{title}</span>
          <TagChips tags={task.tags} />
        </span>
        <StatusWord className="work-board-row-state" tone={state.tone}>
          {state.words}
        </StatusWord>
        <span className="work-board-row-project">{escapeSecurityText(project?.name ?? '无项目')}</span>
        <span className="work-board-row-harness">
          <MarkTile mark={harness?.capabilities.display.mark ?? task.harnessId} size={16} className="bare-mark" />
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

/** A 待办's row: its own place, then (unless folded) each of its sessions indented under it. */
function ItemRow({
  card,
  shell,
  marked,
  menu,
  sessionMenu,
  write,
  folded,
  onFold,
  onOpenItem,
  onOpen,
  onRetry,
  onDismiss,
}: {
  card: ItemCard
  shell: ShellState
  marked: string | null
  menu: MenuSection[]
  sessionMenu: (task: TaskSummary) => MenuSection[]
  write: ItemWriteState | undefined
  folded: boolean
  onFold: () => void
  onOpenItem: (item: WorkItemSummary) => void
  onOpen: (id: string) => void
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const { item, sessions } = card
  const connected = shell.connection === 'connected'
  const now = hostNow()
  const state = itemState(card, connected, now) ?? { tone: 'neutral' as const, words: GROUP_LABELS.todo }
  const workspaces = shell.catalog?.workspaces ?? []
  const suggested = item.projectId && item.projectId !== 'default' ? workspaces.find(entry => entry.id === item.projectId) : undefined
  const project = suggested ?? (sessions[0] ? projectOf(sessions[0], workspaces) : undefined)
  const harnessIds = sessions.length ? [...new Set(sessions.map(task => task.harnessId ?? ''))] : item.harnessId ? [item.harnessId] : []
  const harness = shell.catalog?.harnesses.find(entry => entry.id === harnessIds[0])
  const title = escapeSecurityText(item.title)
  const updatedAt = cardUpdatedAt(card)
  const isMarked = marked === item.id
  return (
    <>
      <li className="work-board-row" data-kind="item" data-work-item={item.id} data-marked={isMarked ? '' : undefined}>
        {sessions.length > 0 && (
          <IconButton
            className="work-board-row-fold"
            size="xs"
            label={folded ? `展开 ${title} 的会话` : `收起 ${title} 的会话`}
            icon={folded ? ChevronRightGlyph : ChevronDownGlyph}
            aria-expanded={!folded}
            onClick={onFold}
          />
        )}
        <button
          type="button"
          className="work-board-row-main"
          aria-current={isMarked ? 'true' : undefined}
          onClick={() => {
            onOpenItem(item)
          }}>
          <span className="work-board-row-title">
            <PriorityMark task={item} reserve />
            <Icon icon={ListTodo} size={14} className="work-board-item-glyph" />
            <span className="work-board-card-title">{title}</span>
            {sessions.length > 1 && <span className="work-board-row-count">{sessions.length}</span>}
            <TagChips tags={item.tags} />
          </span>
          <StatusWord className="work-board-row-state" tone={state.tone}>
            {state.words}
          </StatusWord>
          <span className="work-board-row-project">{escapeSecurityText(project?.name ?? '无项目')}</span>
          <span className="work-board-row-harness">
            {harnessIds.length > 0 && (
              <MarkTile mark={harness?.capabilities.display.mark ?? harnessIds[0]} size={16} className="bare-mark" />
            )}
            <span>
              {escapeSecurityText(harness?.capabilities.display.label ?? harnessIds[0] ?? '')}
              {harnessIds.length > 1 ? ` +${harnessIds.length - 1}` : ''}
            </span>
          </span>
          <span className="work-board-row-who">Code</span>
          <time className="work-board-row-time" dateTime={updatedAt}>
            {relativeTime(updatedAt, new Date(now))}
          </time>
        </button>
        {write && write.state !== 'sending' && (
          <span className="work-board-row-write">
            <ItemWriteLine
              state={write}
              onRetry={() => {
                onRetry(item.id)
              }}
              onDismiss={() => {
                onDismiss(item.id)
              }}
            />
          </span>
        )}
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
      {!folded
        && sessions.map(task => (
          <Row key={task.id} task={task} shell={shell} marked={marked === task.id} menu={sessionMenu(task)} onOpen={onOpen} nested />
        ))}
    </>
  )
}

/** An agent's proposal in the list: dashed and marked 提议, by who proposed it; it opens 审阅. Never a 待办's row. */
function ProposalRow({
  card,
  shell,
  onReview,
}: {
  card: Extract<BoardCard, { kind: 'proposal' }>
  shell: ShellState
  onReview: ((proposal: TodoProposal) => void) | undefined
}) {
  const { proposal } = card
  const entries = pendingEntries(proposal)
  const title = escapeSecurityText(proposal.goal ?? entries[0]?.title ?? '')
  const updatedAt = cardUpdatedAt(card)
  return (
    <li className="work-board-row" data-kind="proposal" data-work-proposal={proposal.id} data-external={proposal.external ? '' : undefined}>
      <button
        type="button"
        className="work-board-row-main"
        disabled={!onReview}
        onClick={() => {
          onReview?.(proposal)
        }}>
        <span className="work-board-row-title">
          <PriorityMark task={{}} reserve />
          <Icon icon={Lightbulb} size={14} className="work-board-proposal-glyph" />
          <span className="work-board-card-title">{title}</span>
          {entries.length > 1 && <span className="work-board-row-count">{entries.length}</span>}
        </span>
        <span className="work-board-row-state work-board-proposal-line">
          <StatusWord tone="neutral" className="work-board-proposal-word">
            提议
          </StatusWord>
          {proposal.external && <ExternalMark />}
        </span>
        <span className="work-board-row-project" />
        <span className="work-board-row-harness" />
        <span className="work-board-row-who">
          <ProposedBy proposal={proposal} shell={shell} />
        </span>
        <time className="work-board-row-time" dateTime={updatedAt}>
          {relativeTime(updatedAt, new Date(hostNow()))}
        </time>
      </button>
    </li>
  )
}

/**
 * The list: one row per card, 已结束 in full and 已归档 under its own state; a 待办's sessions are indented under it and
 * fold away. By group, priority and time, or (the time heading pressed) by time alone. A row opens and has the same
 * menu as its card.
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
  itemMenu,
  writes,
  onOpenItem,
  onRetry,
  onDismiss,
  onOpen,
  onReview,
}: {
  rows: readonly BoardCard[]
  shell: ShellState
  state: ListState
  onState: (state: ListState) => void
  counts: Partial<Record<ListState, number>>
  order: 'group' | 'time'
  onOrder: (order: 'group' | 'time') => void
  marked: string | null
  menuFor: (task: TaskSummary) => MenuSection[]
  itemMenu: (card: ItemCard) => MenuSection[]
  writes: ReadonlyMap<string, ItemWriteState>
  onOpenItem: (item: WorkItemSummary) => void
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
  onOpen: (id: string) => void
  /** 审阅 a proposal; absent where this device may not decide. */
  onReview?: ((proposal: TodoProposal) => void) | undefined
}) {
  useTicker(shell.connection === 'connected' ? 'minute' : false)
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
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
        <span>标题</span>
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
          {rows.map(card =>
            card.kind === 'proposal' ? (
              <ProposalRow key={card.id} card={card} shell={shell} onReview={onReview} />
            ) : card.kind === 'session' ? (
              <Row key={card.id} task={card.task} shell={shell} marked={marked === card.id} menu={menuFor(card.task)} onOpen={onOpen} />
            ) : (
              <ItemRow
                key={card.id}
                card={card}
                shell={shell}
                marked={marked}
                menu={itemMenu(card)}
                sessionMenu={menuFor}
                write={writes.get(card.id)}
                folded={folded.has(card.id)}
                onFold={() => {
                  setFolded(previous => {
                    const next = new Set(previous)
                    if (next.has(card.id)) next.delete(card.id)
                    else next.add(card.id)
                    return next
                  })
                }}
                onOpenItem={onOpenItem}
                onOpen={onOpen}
                onRetry={onRetry}
                onDismiss={onDismiss}
              />
            ),
          )}
        </ul>
      ) : (
        <div className="work-board-rows" data-empty="">
          <span className="work-board-empty-line" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
