import { memo, useEffect, useState, type ReactNode } from 'react'
import { escapeSecurityText, type TaskSummary, type WorkItem, type WorkItemSummary } from '@latch/protocol'
import {
  Button,
  ChevronDownGlyph,
  ChevronRightGlyph,
  Icon,
  IconButton,
  MoreGlyph,
  RunningEdge,
  StatusWord,
  type StatusTone,
} from '@latch/ui'
import { Lightbulb, ListTodo } from 'lucide-react'
import { BoardBranch, BoardHarness, BoardPlace } from './BoardPlace.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, errorMessage } from '../core/api.ts'
import { Menu, rowOf, type MenuSection } from '../components/overlays.tsx'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { harnessName } from '../core/harnessName.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'
import { relativeTime } from '../format.ts'
import { projectOf } from '../sessions.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { ItemWriteState } from './itemWrites.ts'
import { cardUpdatedAt, GROUP_LABELS, type BoardCard } from './model.ts'
import { BOARD_CARD_COPY, CardNote, cardState, PriorityMark, TagChips } from './WorkBoardCard.tsx'
import { ItemWriteLine } from './WriteLine.tsx'
import { ExternalMark, ProposedBy } from './WorkBoardProposalCard.tsx'
import { placeWords } from './items.ts'

export type ItemCard = Extract<BoardCard, { kind: 'item' }>

const COPY = defineCopy(
  {
    settled: '都已结束',
    closed: '已完成',
    merged: 'PR 已合并',
    reading: '读取中',
    noPrompt: '没有要求',
    session: (harness: string, title: string, state: string) => `${harness} ${title}：${state}`,
    newWorktree: '新工作树',
    outside: (count: number) => `${formatNumber(count)} 个未加入`,
    sessionsOf: (title: string) => `${title} 的会话`,
    prompt: '要求',
    start: '开始',
    done: '完成',
  },
  {
    settled: 'All sessions ended',
    closed: 'Done',
    merged: 'PR merged',
    reading: 'Loading',
    noPrompt: 'No instructions',
    session: (harness: string, title: string, state: string) => `${harness} ${title}: ${state}`,
    newWorktree: 'New worktree',
    outside: (count: number) => plural(count, { one: '{n} session outside this task', other: '{n} sessions outside this task' }),
    sessionsOf: (title: string) => `Sessions for ${title}`,
    prompt: 'Instructions',
    start: 'Start',
    done: 'Mark done',
  },
)

/** The card's line under its title, from the Host's place for the 待办: what its sessions need, or how far it is. */
export function itemState(card: ItemCard, connected: boolean, now: number): { tone: StatusTone; words: string } | undefined {
  const { item, sessions } = card
  const place = item.board
  switch (place.group) {
    case 'todo':
      return undefined
    case 'attention': {
      if (place.postId) {
        const words = placeWords(place)
        return connected
          ? { tone: place.reason === 'failed' ? 'failed' : 'waiting', words }
          : { tone: 'neutral', words: BOARD_CARD_COPY.previous(words) }
      }
      // The session the Host's reason comes from says it in its own words.
      const waiting = sessions.find(task => task.board?.group === 'attention' && task.board.reason === place.reason)
      if (waiting) return cardState(waiting, { connected, now, stopping: false, sharedFolder: false })
      const words = GROUP_LABELS.attention
      return connected ? { tone: 'waiting', words } : { tone: 'neutral', words: BOARD_CARD_COPY.previous(words) }
    }
    case 'running':
      return { tone: connected ? 'running' : 'neutral', words: GROUP_LABELS.running }
    case 'deliver':
      return { tone: 'neutral', words: place.reason === 'settled' ? COPY.settled : GROUP_LABELS.deliver }
    case 'done':
      return { tone: 'neutral', words: item.closedAt ? COPY.closed : COPY.merged }
  }
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
        <span className="work-board-item-prompt-wait" aria-label={COPY.reading} />
      ) : 'error' in read ? (
        <StatusWord tone="failed">{read.error}</StatusWord>
      ) : read.prompt ? (
        <VisibleText text={read.prompt} />
      ) : (
        <span className="work-board-item-hint">{COPY.noPrompt}</span>
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
  const label = harness ? harnessName(harness) : (task.harnessId ?? '')
  return (
    <li data-work-session={task.id}>
      <button
        type="button"
        className="work-board-item-session"
        aria-label={COPY.session(escapeSecurityText(label), escapeSecurityText(task.title || BOARD_CARD_COPY.untitled), state.words)}
        onClick={() => {
          onOpen(task.id)
        }}>
        <BoardHarness mark={harness?.capabilities.display.mark ?? task.harnessId} label={label} />
        <StatusWord className="work-board-item-session-state" tone={state.tone}>
          {state.words}
        </StatusWord>
        {branch && (
          <span className="work-board-item-session-branch">
            <BoardBranch branch={escapeSecurityText(branch)} worktree={task.worktree !== undefined} />
          </span>
        )}
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
  /** An agent's suggestion for this 待办's card, waiting for the person. */
  suggestion?: ReactNode
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
  suggestion,
}: ItemCardProps) {
  useLocale()
  const { item, sessions } = card
  const connected = shell.connection === 'connected'
  const live = sessions.some(task => task.status === 'running' || task.status === 'waiting-approval')
  useTicker(shell.board && !shell.settings ? (connected && live ? 'second' : 'minute') : false)
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
  // With one session its row says where things stand; the head says it only for what the row cannot (done).
  const headState = state && (item.board.postId || sessions.length !== 1 || unlisted > 0 || item.board.group === 'done') ? state : undefined
  const canFinish = !todo && onDone !== undefined && item.board.reason === 'settled'
  // 完成 alone sits on the project's line, so it adds no row of its own; a write's state takes the foot as before.
  const floatFoot = canFinish && (!write || write.state === 'sending')
  return (
    <article
      className="work-board-card"
      data-kind="item"
      data-work-item={item.id}
      data-marked={marked ? '' : undefined}
      data-tone={state?.tone}
      data-busy={busy ? '' : undefined}
      data-float-foot={floatFoot ? '' : undefined}>
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
        <BoardPlace
          harness={
            todo && (item.harnessId || harness)
              ? { mark: harness?.capabilities.display.mark ?? item.harnessId, label: harness ? harnessName(harness) : item.harnessId }
              : undefined
          }
          project={project?.name ?? BOARD_CARD_COPY.noProject}
          hint={todo && item.worktree === 'new' ? <span className="work-board-item-hint">{COPY.newWorktree}</span> : undefined}
        />
        {headState && (
          <StatusWord className="work-board-card-state" tone={headState.tone}>
            {headState.words}
          </StatusWord>
        )}
        {item.tags?.length ? <TagChips tags={item.tags} /> : null}
        <CardNote note={item.note} />
        {item.from && (
          <span className="work-board-proposal-line">
            <Icon icon={Lightbulb} size={12} className="work-board-proposal-glyph" />
            <ProposedBy proposal={{ from: item.from }} shell={shell} />
            {item.from.external && <ExternalMark />}
          </span>
        )}
        {outside > 0 && (
          <StatusWord className="work-board-card-state" tone="warn">
            {COPY.outside(outside)}
          </StatusWord>
        )}
        {connected && state?.tone === 'running' && <RunningEdge />}
      </button>
      {promptShown && <ItemPrompt item={item} />}
      {sessions.length > 0 && (
        <ul className="work-board-item-sessions" aria-label={COPY.sessionsOf(title)}>
          {sessions.map(task => (
            <SessionRow key={task.id} task={task} shell={shell} onOpen={onOpenSession} />
          ))}
          {unlisted > 0 && <li className="work-board-item-unlisted">+{formatNumber(unlisted)}</li>}
        </ul>
      )}
      {decision && <div className="work-board-item-decision">{decision}</div>}
      {suggestion}
      {(write || todo || canFinish) && (
        <div className="work-board-item-foot" data-float={floatFoot ? '' : undefined}>
          {todo && (
            <button
              type="button"
              className="work-board-item-prompt-toggle"
              aria-expanded={promptShown}
              onClick={() => {
                setShowPrompt(!promptShown)
              }}>
              <Icon icon={promptShown ? ChevronDownGlyph : ChevronRightGlyph} size={12} />
              {COPY.prompt}
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
              {COPY.start}
            </Button>
          )}
          {canFinish && (busy || !blocked) && (
            <Button
              size="xs"
              variant="outline"
              loading={busy}
              onClick={() => {
                onDone(item)
              }}>
              {COPY.done}
            </Button>
          )}
        </div>
      )}
      <span className="work-board-card-actions">
        <Menu
          label={BOARD_CARD_COPY.actions(title)}
          placement="bottom-end"
          context={rowOf('.work-board-card')}
          sections={menu}
          trigger={props => (
            <IconButton
              {...props}
              className="work-board-card-more"
              size="xs"
              label={BOARD_CARD_COPY.moreFor(title)}
              tooltip={BOARD_CARD_COPY.more}
              icon={MoreGlyph}
            />
          )}
        />
      </span>
    </article>
  )
})
