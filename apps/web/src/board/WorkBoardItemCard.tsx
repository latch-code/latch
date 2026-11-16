import { memo, useEffect, useState, type ReactNode } from 'react'
import { escapeSecurityText, type TaskSummary, type WorkItem, type WorkItemSummary } from '@latch/protocol'
import {
  Button,
  ChevronDownGlyph,
  ChevronRightGlyph,
  FolderGlyph,
  Icon,
  IconButton,
  MoreGlyph,
  RunningEdge,
  StatusWord,
  type StatusTone,
} from '@latch/ui'
import { ListTodo } from 'lucide-react'
import { MarkTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, errorMessage } from '../core/api.ts'
import { Menu, rowOf, type MenuSection } from '../components/overlays.tsx'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import { projectOf } from '../sessions.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { ItemWriteState } from './itemWrites.ts'
import { cardUpdatedAt, GROUP_LABELS, type BoardCard } from './model.ts'
import { cardState, PriorityMark, TagChips } from './WorkBoardCard.tsx'

export type ItemCard = Extract<BoardCard, { kind: 'item' }>

/** The card's line under its title, from the Host's place for the 待办: what its sessions need, or how far it is. */
export function itemState(card: ItemCard, connected: boolean, now: number): { tone: StatusTone; words: string } | undefined {
  const { item, sessions } = card
  const place = item.board
  switch (place.group) {
    case 'todo':
      return undefined
    case 'attention': {
      // The session the Host's reason comes from says it in its own words.
      const waiting = sessions.find(task => task.board?.group === 'attention' && task.board.reason === place.reason)
      if (waiting) return cardState(waiting, { connected, now, stopping: false, sharedFolder: false })
      const words = GROUP_LABELS.attention
      return connected ? { tone: 'waiting', words } : { tone: 'neutral', words: `上次状态：${words}` }
    }
    case 'running':
      return { tone: connected ? 'running' : 'neutral', words: GROUP_LABELS.running }
    case 'deliver':
      return { tone: 'neutral', words: place.reason === 'settled' ? '都已结束' : GROUP_LABELS.deliver }
    case 'done':
      return { tone: 'neutral', words: item.closedAt ? '已完成' : 'PR 已合并' }
  }
}

/** The card's own write: sending, an unknown result with 重试 and 放弃, or the Host's refusal. */
export function ItemWriteLine({
  state,
  onRetry,
  onDismiss,
}: {
  state: ItemWriteState | undefined
  onRetry: () => void
  onDismiss: () => void
}) {
  if (!state || state.state === 'sending') return null
  if (state.state === 'refused')
    return (
      <span className="work-board-item-write" data-state="refused">
        <StatusWord tone="failed">{state.reason}</StatusWord>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          知道了
        </Button>
      </span>
    )
  return (
    <span className="work-board-item-write" data-state="unknown" title={state.reason}>
      <StatusWord tone="warn">结果未知</StatusWord>
      <Button size="xs" onClick={onRetry}>
        重试
      </Button>
      <Button size="xs" variant="ghost" onClick={onDismiss}>
        放弃
      </Button>
    </span>
  )
}

/**
 * The 待办's full 要求, read from the Host for the revision the card shows (the snapshot has no prompts): what 开始 and
 * 全部开始 would send, so it can be read on the card before either.
 */
function ItemPrompt({ item }: { item: WorkItemSummary }) {
  const [read, setRead] = useState<{ revision: number; prompt: string } | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    setRead(null)
    api<{ item: WorkItem }>(`work/items/${encodeURIComponent(item.id)}`)
      .then(({ item: full }) => {
        if (live) setRead({ revision: full.revision, prompt: full.prompt })
      })
      .catch((cause: unknown) => {
        if (live) setRead({ error: errorMessage(cause) })
      })
    return () => {
      live = false
    }
  }, [item.id, item.revision])
  return (
    <div className="work-board-item-prompt" aria-live="polite">
      {read === null ? (
        <span className="work-board-item-prompt-wait" aria-label="读取中" />
      ) : 'error' in read ? (
        <StatusWord tone="failed">{read.error}</StatusWord>
      ) : read.prompt ? (
        <VisibleText text={read.prompt} />
      ) : (
        <span className="work-board-item-hint">没有要求</span>
      )}
    </div>
  )
}

/** One session of a 待办: its Harness, what it needs or how far it is, its branch. It opens the session in 对话. */
function SessionRow({ task, shell, onOpen }: { task: TaskSummary; shell: ShellState; onOpen: (id: string) => void }) {
  const connected = shell.connection === 'connected'
  const now = hostNow()
  const stopping = shell.stopping.has(task.id) || task.live?.activity === 'cancelling'
  const state = cardState(task, { connected, now, stopping, sharedFolder: false })
  const harness = shell.catalog?.harnesses.find(item => item.id === task.harnessId)
  const branch = task.worktree ? (task.branch ?? task.worktree.branch) : task.branch
  const label = harness?.capabilities.display.label ?? task.harnessId ?? ''
  return (
    <li data-work-session={task.id}>
      <button
        type="button"
        className="work-board-item-session"
        aria-label={`${escapeSecurityText(label)} ${escapeSecurityText(task.title || '未命名会话')}：${state.words}`}
        onClick={() => {
          onOpen(task.id)
        }}>
        <MarkTile mark={harness?.capabilities.display.mark ?? task.harnessId} size={14} label={label} />
        <StatusWord className="work-board-item-session-state" tone={state.tone}>
          {state.words}
        </StatusWord>
        {branch && <span className="work-board-item-session-branch">{escapeSecurityText(branch)}</span>}
      </button>
    </li>
  )
}

export interface ItemCardProps {
  card: ItemCard
  shell: ShellState
  marked: boolean
  menu: MenuSection[]
  write: ItemWriteState | undefined
  /** The 待办's page on the board. */
  onOpenItem: (item: WorkItemSummary) => void
  onOpenSession: (id: string) => void
  /** 开始: the 新建 input with its prompt and suggestions. Absent where this device may not start sessions. */
  onStart?: ((item: WorkItemSummary) => void) | undefined
  /** 完成: every session ended and the person has not marked it done. */
  onDone?: ((item: WorkItemSummary) => void) | undefined
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
  /** In 等你处理: the request of the session it waits on, answered on the card. */
  decision?: ReactNode
  /** Sessions started from it that the Host could not add (it was full): they stand as cards of their own. */
  outside?: number
}

/**
 * A 待办 on the board: priority, title and time; its suggested Harness and project; what its sessions need or how far
 * it is, as the Host places it; tags; then each session as a row. Before it has one, 开始. The card opens the 待办; a
 * session's row opens that session; ⋯, a right click or the menu key open the 待办's menu.
 */
export const WorkBoardItemCard = memo(function WorkBoardItemCard({
  card,
  shell,
  marked,
  menu,
  write,
  onOpenItem,
  onOpenSession,
  onStart,
  onDone,
  onRetry,
  onDismiss,
  decision,
  outside = 0,
}: ItemCardProps) {
  const { item, sessions } = card
  const connected = shell.connection === 'connected'
  const live = sessions.some(task => task.status === 'running' || task.status === 'waiting-approval')
  useTicker(connected && live ? 'second' : 'minute')
  const now = hostNow()
  const state = itemState(card, connected, now)
  const harness = shell.catalog?.harnesses.find(entry => entry.id === item.harnessId)
  const workspaces = shell.catalog?.workspaces ?? []
  const suggested = item.projectId && item.projectId !== 'default' ? workspaces.find(entry => entry.id === item.projectId) : undefined
  const project = suggested ?? (sessions[0] ? projectOf(sessions[0], workspaces) : undefined)
  const title = escapeSecurityText(item.title)
  const unlisted = item.sessionIds.length - sessions.length
  const todo = item.board.group === 'todo'
  const busy = write?.state === 'sending'
  const blocked = write !== undefined && write.state !== 'refused'
  const updatedAt = cardUpdatedAt(card)
  // A start refused because the 待办 changed shows the 要求 as it now is, read again.
  const stale = write?.state === 'refused' && write.code === 'item-changed'
  const [showPrompt, setShowPrompt] = useState(false)
  useEffect(() => {
    if (stale) setShowPrompt(true)
  }, [stale])
  const promptShown = todo && (showPrompt || stale)
  return (
    <article
      className="work-board-card"
      data-kind="item"
      data-work-item={item.id}
      data-marked={marked ? '' : undefined}
      data-tone={state?.tone}
      data-busy={busy ? '' : undefined}>
      <button
        type="button"
        className="work-board-card-main"
        aria-current={marked ? 'true' : undefined}
        onClick={() => {
          onOpenItem(item)
        }}>
        <span className="work-board-card-head">
          <PriorityMark task={item} />
          <Icon icon={ListTodo} size={14} className="work-board-item-glyph" />
          <span className="work-board-card-title">{title}</span>
          <time dateTime={updatedAt}>{relativeTime(updatedAt, new Date(now))}</time>
        </span>
        <span className="work-board-card-place">
          {todo && (item.harnessId || harness) && (
            <MarkTile mark={harness?.capabilities.display.mark ?? item.harnessId} size={14} label={harness?.capabilities.display.label} />
          )}
          <span className="work-board-card-project">
            <Icon icon={FolderGlyph} size={12} />
            <span>{escapeSecurityText(project?.name ?? '无项目')}</span>
          </span>
          {todo && item.worktree === 'new' && <span className="work-board-item-hint">新工作树</span>}
        </span>
        {state && (
          <StatusWord className="work-board-card-state" tone={state.tone}>
            {state.words}
          </StatusWord>
        )}
        {item.tags?.length ? <TagChips tags={item.tags} /> : null}
        {outside > 0 && (
          <StatusWord className="work-board-card-state" tone="warn">
            {`${outside} 个未加入`}
          </StatusWord>
        )}
        {connected && state?.tone === 'running' && <RunningEdge />}
      </button>
      {promptShown && <ItemPrompt item={item} />}
      {sessions.length > 0 && (
        <ul className="work-board-item-sessions" aria-label={`${title} 的会话`}>
          {sessions.map(task => (
            <SessionRow key={task.id} task={task} shell={shell} onOpen={onOpenSession} />
          ))}
          {unlisted > 0 && <li className="work-board-item-unlisted">+{unlisted}</li>}
        </ul>
      )}
      {decision && <div className="work-board-item-decision">{decision}</div>}
      {(write || todo || (onDone && item.board.reason === 'settled')) && (
        <div className="work-board-item-foot">
          {todo && (
            <button
              type="button"
              className="work-board-item-prompt-toggle"
              aria-expanded={promptShown}
              onClick={() => {
                setShowPrompt(!promptShown)
              }}>
              <Icon icon={promptShown ? ChevronDownGlyph : ChevronRightGlyph} size={12} />
              要求
            </button>
          )}

          <ItemWriteLine
            state={write}
            onRetry={() => {
              onRetry(item.id)
            }}
            onDismiss={() => {
              onDismiss(item.id)
            }}
          />
          {todo && onStart && (busy || !blocked) && (
            <Button
              size="xs"
              variant="outline"
              loading={busy}
              onClick={() => {
                onStart(item)
              }}>
              开始
            </Button>
          )}
          {!todo && onDone && item.board.reason === 'settled' && (busy || !blocked) && (
            <Button
              size="xs"
              variant="outline"
              loading={busy}
              onClick={() => {
                onDone(item)
              }}>
              完成
            </Button>
          )}
        </div>
      )}
      <span className="work-board-card-actions">
        <Menu
          label={`看板操作：${title}`}
          placement="bottom-end"
          context={rowOf('.work-board-card')}
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
    </article>
  )
})
