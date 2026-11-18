import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CARD_NOTE_CHARS, escapeSecurityText, type TaskSummary, type WorkItemSummary } from '@latch/protocol'
import { Button, EditGlyph, FilterPills, MessageGlyph, NewSessionGlyph, PromptDialog, SegmentedControl, TrashGlyph } from '@latch/ui'
import { ListTodo, StickyNote } from 'lucide-react'
import type { SendingMessage } from '../core/sendingMessage.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { ConfirmDialog, type MenuSection } from '../components/overlays.tsx'
import { knownTags, SessionTagsDialog } from '../components/SessionTagsDialog.tsx'
import { api, errorMessage, isUncertain, MessageError } from '../core/api.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'
import { WorkbenchDecision } from '../shell/WorkbenchDecision.tsx'
import { useWorkbenchDelivery } from '../shell/useWorkbenchEvidence.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import {
  BOARD_GROUPS,
  boardColumns,
  groupOf,
  boardKey,
  filterOptions,
  filtering,
  firstPhoneState,
  groupCounts,
  GROUP_LABELS,
  listRows,
  NO_FILTERS,
  readBoardMemory,
  startAllItems,
  writeBoardMemory,
  type BoardCard,
  type BoardColumnGroup,
  type BoardFilters,
  type BoardMemory,
  type BoardView,
  type ListState,
} from './model.ts'
import { readPreferences, switchWorkView } from '../preferences.ts'
import { DropConfirm } from './DropConfirm.tsx'
import { dropTargets, type DropAction } from './drag.ts'
import { useBoardDrag } from './useBoardDrag.ts'
import type { CardWriteLine } from './WriteLine.tsx'
import { boardMarkSections } from '../sessionMenu.ts'
import { useBoardRequests } from './requests.ts'
import { WorkBoard } from './WorkBoard.tsx'
import { WorkBoardCard } from './WorkBoardCard.tsx'
import { AllFilters, FilterChips, FilterMenus } from './WorkBoardFilters.tsx'
import { ITEM_WRITE_COPY, useItemWrites } from './itemWrites.ts'
import { WorkBoardItemCard, type ItemCard } from './WorkBoardItemCard.tsx'
import { WorkBoardItemEdit } from './WorkBoardItemEdit.tsx'
import { ItemPage } from './ItemPage.tsx'
import { closeItemPage, openItemPage, useItemPage } from './itemPage.ts'
import { WorkBoardNew, type NewMode } from './WorkBoardNew.tsx'
import { WorkBoardTable } from './WorkBoardTable.tsx'
import { changeFor, type ChangeProposal, type TodoProposal } from './proposals.ts'
import { ProposalRecovery } from './ProposalRecovery.tsx'
import { WorkBoardProposalCard } from './WorkBoardProposalCard.tsx'
import { CardSuggestion } from './CardSuggestion.tsx'
import { AcceptedItems, ProposalReview } from './ProposalReview.tsx'

/** Below this width the board is one list with a state filter (two 240px columns, their gap and the sides). */
const NARROW = 524
/** The delivery facts are read for the top cards of 可交付 only, as many as one read takes. */
const DELIVERY_READS = 12

const COPY = defineCopy(
  {
    board: '看板',
    openConversation: '在对话中打开',
    edit: '编辑…',
    openItem: '打开待办',
    deleteItemMenu: '删除待办…',
    stopUnknown: '没有收到停止的确认',
    startAll: '全部开始',
    view: '看法',
    columns: '板',
    list: '表',
    create: '新建',
    state: '状态',
    stopSession: '停止会话',
    askStop: (title: string) => `停止「${title}」？`,
    untitled: '未命名会话',
    stop: '停止',
    notSaved: '没有保存',
    note: '备注',
    deleteItem: '删除待办',
    delete: '删除',
    askDelete: (title: string, count: number) => `删除待办「${title}」？${count ? `它的 ${formatNumber(count)} 个会话保留。` : ''}`,
    notDeleted: '没有删除',
    editNote: '修改备注…',
    addNote: '备注…',
    clearNote: '清除备注',
  },
  {
    board: 'Board',
    openConversation: 'Open conversation',
    edit: 'Edit…',
    openItem: 'Open to-do',
    deleteItemMenu: 'Delete to-do…',
    stopUnknown: 'The stop is still unconfirmed',
    startAll: 'Start all',
    view: 'View',
    columns: 'Board',
    list: 'List',
    create: 'New',
    state: 'Status',
    stopSession: 'Stop session',
    askStop: (title: string) => `Stop “${title}”?`,
    untitled: 'Untitled session',
    stop: 'Stop',
    notSaved: 'Couldn’t save',
    note: 'Note',
    deleteItem: 'Delete to-do',
    delete: 'Delete',
    askDelete: (title: string, count: number) =>
      `Delete “${title}”?${count ? ` ${plural(count, { one: '{n} session will remain.', other: '{n} sessions will remain.' })}` : ''}`,
    notDeleted: 'Couldn’t delete',
    editNote: 'Edit note…',
    addNote: 'Add note…',
    clearNote: 'Clear note',
  },
)

/** Whether the board itself is narrower than two columns: its own width, not the window's. */
function useNarrow(element: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return undefined
    const read = () => {
      const width = node.getBoundingClientRect().width
      if (width > 0) setNarrow(width < NARROW)
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [element])
  return narrow
}

/**
 * 看板: every card the Host gives (a 待办 with its sessions, or a session of none), in the Host's group, as five equal
 * columns or a list, filtered by project, Harness, who works on it and tags. A session's card opens it in 对话; a 待办's
 * opens its page on the board; coming back finds the card marked. The board starts sessions and keeps 待办 through 新建
 * without leaving, and starts a 待办 with 开始 or the whole 未开始 column with 全部开始.
 */
export function BoardSurface({ shell }: { shell: ShellState }) {
  const { snapshot, connection } = shell
  const key = boardKey(snapshot.device.id)
  const [memory, setMemory] = useState<BoardMemory>(() => readBoardMemory(key))
  const remember = (next: BoardMemory) => {
    setMemory(next)
    writeBoardMemory(key, next)
  }
  const setFilters = (filters: BoardFilters) => {
    remember({ ...memory, filters })
  }
  const setView = (view: BoardView) => {
    remember({ ...memory, view })
  }
  const [listState, setListState] = useState<ListState>('all')
  const [order, setOrder] = useState<'group' | 'time'>('group')
  const [phoneState, setPhoneState] = useState<BoardColumnGroup | null>(null)
  const [started, setStarted] = useState<string | null>(null)
  const [newSince, setNewSince] = useState<SendingMessage | null | undefined>(undefined)
  const [newMode, setNewMode] = useState<NewMode>({ kind: 'new' })
  // A 待办's page stands in the board's place while it is open.
  const itemPage = useItemPage(snapshot.device.id)
  const showItem = itemPage !== null && shell.catalog?.features?.workItems === true
  const [tagging, setTagging] = useState<WorkItemSummary | null>(null)
  const [editing, setEditing] = useState<WorkItemSummary | null>(null)
  const [deleting, setDeleting] = useState<WorkItemSummary | null>(null)
  const [noting, setNoting] = useState<{ kind: 'item'; item: WorkItemSummary } | { kind: 'session'; task: TaskSummary } | null>(null)
  const [reviewing, setReviewing] = useState<TodoProposal | null>(null)
  const [acceptedItems, setAcceptedItems] = useState<string[]>([])
  const writes = useItemWrites(shell.refresh)
  const proposalWrites = shell.proposalWrites
  const showAccepted = (ids: string[]) => {
    if (readPreferences().workView !== 'board') return
    if (ids.length > 1) setAcceptedItems(ids)
    else if (ids[0]) shell.openWorkItem(ids[0])
  }
  /** Sessions this page started from a 待办: one the snapshot lists outside it was not added (the 待办 was full). */
  const [startedFrom, setStartedFrom] = useState<ReadonlyArray<{ itemId: string; sessionId: string }>>([])
  const noteStarted = useCallback((itemId: string, sessionId: string) => {
    setStartedFrom(previous => [...previous, { itemId, sessionId }])
  }, [])
  const root = useRef<HTMLElement>(null)
  const narrow = useNarrow(root)
  useTicker(connection === 'connected' ? 'minute' : false)
  const now = hostNow()
  const tasks = snapshot.tasks
  const items = useMemo(() => snapshot.items ?? [], [snapshot.items])
  const proposals = useMemo(() => snapshot.workProposals ?? [], [snapshot.workProposals])
  const workspaces = shell.catalog?.workspaces ?? []
  const filters = memory.filters
  const filtered = filtering(filters)
  const columns = boardColumns(tasks, filters, workspaces, now, items, proposals)
  const column = (group: BoardColumnGroup) => columns.find(item => item.group === group)!
  const counts = groupCounts(tasks, now, items, proposals)
  const locale = useLocale()
  const options = useMemo(() => filterOptions(tasks, snapshot, items, proposals), [tasks, snapshot, items, proposals, locale])
  const marked = started ?? shell.selectedId
  /** A 待办's card is marked for itself, or for its session that was last opened or just started. */
  const markedCard = (card: BoardCard) =>
    marked !== null && (card.id === marked || (card.kind === 'item' && card.item.sessionIds.includes(marked)))
  const deliverable = column('deliver').cards
  const deliveryIds = useMemo(
    () => deliverable.flatMap(card => (card.kind === 'session' ? [card.id] : [])).slice(0, DELIVERY_READS),
    [deliverable],
  )
  const delivery = useDeliveryFor(shell, deliveryIds, !narrow && memory.view === 'board')

  const open = useCallback(
    (id: string) => {
      setStarted(null)
      shell.choose(id)
      switchWorkView('chat')
    },
    [shell],
  )
  // Back on the board, the card last opened (or just started or kept) is in view, marked.
  useEffect(() => {
    if (!marked || showItem) return
    const id = CSS.escape(marked)
    const card = root.current?.querySelector<HTMLElement>(`[data-work-session="${id}"], [data-work-item="${id}"]`)
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [marked, memory.view, narrow, showItem])
  const deviceId = snapshot.device.id
  const openItem = useCallback(
    (item: WorkItemSummary) => {
      setStarted(item.id)
      openItemPage(deviceId, item.id)
    },
    [deviceId],
  )

  const menuFor = (task: TaskSummary): MenuSection[] => {
    const marks = shell.boardMarks(task)
    const session = shell
      .sessionMenu(task)
      .flatMap(section => section.items)
      .filter(item => item.id === 'rename' || item.id === 'archive')
    return [
      ...(marks ? boardMarkSections(task, marks) : []),
      {
        id: 'session',
        items: [
          ...session,
          ...(marks
            ? noteItems(
                task.note,
                () => setNoting({ kind: 'session', task }),
                () => void noteSession(task, null),
              )
            : []),
          {
            id: 'open',
            label: COPY.openConversation,
            icon: MessageGlyph,
            onSelect: () => {
              open(task.id)
            },
          },
        ],
      },
    ]
  }
  const canStart = shell.homeComposerState.gate.kind === 'open'
  const canMark = shell.catalog !== undefined && shell.access.scopes.has('run')
  /** A session card's note, through the session's own metadata route. */
  const noteSession = async (task: TaskSummary, note: string | null) => {
    await api(`tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { note } })
    await shell.refresh()
  }
  /** 优先级, 标签…, 编辑… while it has no session, 打开, 删除待办: the same on a card, a row and a phone row. */
  const itemMenu = ({ item }: ItemCard): MenuSection[] => {
    const state = writes.states.get(item.id)?.state
    const sections: MenuSection[] = [
      ...(canMark
        ? boardMarkSections(item, {
            setPriority: priority => {
              void writes.patch(item, { priority: priority ?? 'mid' })
            },
            editTags: () => {
              setTagging(item)
            },
          })
        : []),
      {
        id: 'item',
        items: [
          ...(canMark && item.sessionIds.length === 0
            ? [
                {
                  id: 'edit',
                  label: COPY.edit,
                  icon: EditGlyph,
                  onSelect: () => {
                    setEditing(item)
                  },
                },
              ]
            : []),
          ...(canMark
            ? noteItems(
                item.note,
                () => setNoting({ kind: 'item', item }),
                () => void writes.patch(item, { note: null }),
              )
            : []),
          {
            id: 'open',
            label: COPY.openItem,
            icon: ListTodo,
            onSelect: () => {
              openItem(item)
            },
          },
        ],
      },
      ...(canMark
        ? [
            {
              id: 'danger',
              items: [
                {
                  id: 'delete',
                  label: COPY.deleteItemMenu,
                  icon: TrashGlyph,
                  danger: true,
                  onSelect: () => {
                    setDeleting(item)
                  },
                },
              ],
            },
          ]
        : []),
    ]
    return state === 'sending' || state === 'unknown'
      ? sections.map(section => ({
          ...section,
          items: section.items.map(action => (action.id === 'open' ? action : { ...action, disabledReason: ITEM_WRITE_COPY.blocked })),
        }))
      : sections
  }
  // Where 对话 stood before 新建: the new-session input targets a new session only on the start screen, so the dialog
  // moves 对话 there and puts it back once it closes.
  const beforeNew = useRef<ShellState['route'] | null>(null)
  const startNew = (mode: NewMode = { kind: 'new' }) => {
    beforeNew.current = shell.route
    shell.startNew()
    setNewMode(mode)
    setNewSince(shell.submission.sendingMessage)
  }
  const onNewStarted = useCallback(
    (sessionId: string) => {
      setStarted(sessionId)
      if (newMode.kind === 'start') noteStarted(newMode.item.id, sessionId)
    },
    [newMode, noteStarted],
  )
  const startItem = useCallback(
    (item: WorkItemSummary) => {
      beforeNew.current = shell.route
      shell.startNew()
      setNewMode({ kind: 'start', item })
      setNewSince(shell.submission.sendingMessage)
    },
    [shell],
  )
  const closeNew = useCallback(() => {
    setNewSince(undefined)
    const before = beforeNew.current
    beforeNew.current = null
    if (before && !(before.entry === 'sessions' && before.start)) shell.setRoute(before)
  }, [shell])
  useBoardRequests(request => {
    if (request.kind === 'new') {
      if (canStart) startNew()
      return
    }
    closeItemPage()
    setListState(request.group)
    setPhoneState(request.group)
    requestAnimationFrame(() => {
      const head = root.current?.querySelector<HTMLElement>(`.work-board-column[data-group="${request.group}"] .work-board-column-head`)
      head?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      head?.focus({ preventScroll: true })
    })
  })
  // Answered on the card, the first R1 request opens in 对话 like everything else the card leads to.
  const decisionShell = useMemo<ShellState>(
    () => ({
      ...shell,
      choose: (...args: Parameters<ShellState['choose']>) => {
        setStarted(null)
        shell.choose(...args)
        switchWorkView('chat')
      },
      openApproval: (...args: Parameters<ShellState['openApproval']>) => {
        setStarted(null)
        shell.openApproval(...args)
        switchWorkView('chat')
      },
    }),
    [shell],
  )
  // The first card in 等你处理 whose waiting session (its own, or a 待办's) takes an ordinary request answers it in place.
  const waitingOf = (card: BoardCard): TaskSummary | undefined =>
    card.kind === 'session'
      ? card.task
      : card.kind === 'proposal' || card.item.board.postId
        ? undefined
        : card.sessions.find(task => task.board?.group === 'attention' && answerable(task, snapshot.approvals))
  const decisionCard = column('attention').cards.find(card => {
    const task = waitingOf(card)
    return task !== undefined && answerable(task, snapshot.approvals)
  })
  // ---- Dragging between columns: a gesture whose drop performs the card's existing action ----------------------------
  const [stopAsk, setStopAsk] = useState<{ task: TaskSummary; point: { x: number; y: number } } | null>(null)
  /** Stops sent from a drop that the Host refused, with its reason; an unknown one is the shell's `cancelUncertain`. */
  const [stopRefused, setStopRefused] = useState<ReadonlyMap<string, string>>(() => new Map())
  const forgetStop = (id: string) => {
    setStopRefused(previous => {
      if (!previous.has(id)) return previous
      const next = new Map(previous)
      next.delete(id)
      return next
    })
  }
  const stop = (id: string) => {
    forgetStop(id)
    // The stop is acknowledged only when the Host says the run settled; until then the card stays where it says.
    shell.cancelSession(id).catch((cause: unknown) => {
      if (!isUncertain(cause)) setStopRefused(previous => new Map(previous).set(id, errorMessage(cause)))
    })
  }
  const stopUnknown = (id: string) => shell.cancelUncertain.has(id)
  const unconfirmed = (id: string) => {
    const state = writes.states.get(id)
    return (state !== undefined && state.state !== 'refused') || stopUnknown(id)
  }
  const placeOf = (id: string) => {
    const card = columns.flatMap(item => item.cards).find(item => item.id === id)
    if (!card) return undefined
    const stopping = card.kind === 'session' && (shell.stopping.has(id) || card.task.live?.activity === 'cancelling')
    return { source: groupOf(card), targets: dropTargets(card, { canStart, canMark, unconfirmed: unconfirmed(id), stopping }) }
  }
  const onDrop = (action: DropAction, point: { x: number; y: number }) => {
    switch (action.kind) {
      case 'start':
        startItem(action.item)
        return
      case 'finish':
      case 'reopen':
        void writes.patch(action.item, { closed: action.kind === 'finish' })
        return
      case 'stop':
        setStopAsk({ task: action.task, point })
        return
      case 'attend':
        void writes.attend(action.task.id, action.input)
    }
  }
  const drag = useBoardDrag({
    root,
    // A phone shows the list; a narrow desktop window still has the columns (2 + 2 + 1) and a mouse.
    enabled: !narrow && !showItem && memory.view === 'board',
    placeOf,
    onDrop,
  })
  /** What a session card says of a write the board sent for it: its attend, or a stop from a drop. */
  const sessionWrite = (id: string): CardWriteLine | undefined => {
    const own = writes.states.get(id)
    if (own) return own
    if (stopUnknown(id)) return { state: 'unknown', reason: COPY.stopUnknown }
    const refused = stopRefused.get(id)
    return refused === undefined ? undefined : { state: 'refused', reason: refused }
  }

  /** An agent's suggestion for a card, waiting for the person: 接受 makes it, 不要 drops it. */
  const suggestionFor = (target: { sessionId: string } | { itemId: string }) => {
    const proposal = changeFor(proposals, target)
    if (!proposal) return undefined
    return (
      <CardSuggestion
        proposal={proposal}
        shell={shell}
        write={proposalWrites.states.get(proposal.id)}
        canDecide={canMark}
        onAccept={(row: ChangeProposal) => {
          void proposalWrites.accept(row)
        }}
        onDismiss={(row: ChangeProposal) => {
          void proposalWrites.dismiss(row)
        }}
        onRetry={id => {
          void proposalWrites.retry(id)
        }}
        onForget={proposalWrites.forget}
      />
    )
  }
  const renderCard = (card: BoardCard, decide = false) => {
    if (card.kind === 'proposal')
      return (
        <WorkBoardProposalCard
          card={card}
          shell={shell}
          write={proposalWrites.states.get(card.id)}
          canDecide={canMark}
          onReview={setReviewing}
          onDismiss={proposal => {
            void proposalWrites.dismiss(proposal)
          }}
          onRetry={id => {
            void proposalWrites.retry(id).then(result => {
              if (result.ok && result.itemIds) showAccepted(result.itemIds)
            })
          }}
          onForget={proposalWrites.forget}
          onOpenSession={open}
        />
      )
    if (card.kind === 'item') {
      const waiting = decide ? waitingOf(card) : undefined
      return (
        <WorkBoardItemCard
          card={card}
          shell={shell}
          marked={markedCard(card)}
          menu={itemMenu(card)}
          write={writes.states.get(card.id)}
          onOpenItem={openItem}
          onOpenSession={open}
          onStart={canStart ? startItem : undefined}
          onDone={
            canMark
              ? item => {
                  void writes.patch(item, { closed: true })
                }
              : undefined
          }
          onRetry={id => {
            void writes.retry(id)
          }}
          onDismiss={writes.dismiss}
          decision={waiting ? <WorkbenchDecision task={waiting} shell={decisionShell} /> : undefined}
          suggestion={suggestionFor({ itemId: card.id })}
          outside={
            startedFrom.filter(
              entry =>
                entry.itemId === card.id
                && !items.some(other => other.sessionIds.includes(entry.sessionId))
                && tasks.some(task => task.id === entry.sessionId),
            ).length
          }
        />
      )
    }
    const { task } = card
    return (
      <WorkBoardCard
        task={task}
        shell={shell}
        marked={marked === task.id}
        delivery={delivery.get(task.id)}
        sharedFolder={
          !!task.cwd && !task.worktree && tasks.some(other => other.id !== task.id && !other.archived && other.cwd === task.cwd)
        }
        menu={menuFor(task)}
        onOpen={open}
        decision={decide ? <WorkbenchDecision task={task} shell={decisionShell} /> : undefined}
        write={sessionWrite(task.id)}
        onRetry={id => {
          if (writes.states.has(id)) void writes.retry(id)
          else stop(id)
        }}
        onDismiss={writes.states.has(task.id) ? writes.dismiss : stopRefused.has(task.id) && !stopUnknown(task.id) ? forgetStop : undefined}
        suggestion={suggestionFor({ sessionId: task.id })}
      />
    )
  }
  // 全部开始 passes by a 待办 whose 要求 came from outside content: each of those is started on its own, read first.
  const unstarted = startAllItems(column('todo').cards)
  const startAll =
    canStart && unstarted.length > 1 ? (
      <Button
        variant="ghost"
        size="xs"
        loading={writes.startingAll}
        onClick={() => {
          void writes.startAll(unstarted, noteStarted)
        }}>
        {COPY.startAll}
      </Button>
    ) : undefined
  const header = (
    <header className="work-board-head">
      <div className="work-board-filters">
        <FilterMenus options={options} filters={filters} onFilters={setFilters} />
        <FilterChips options={options} filters={filters} onFilters={setFilters} />
      </div>
      <div className="work-board-head-actions">
        <SegmentedControl
          label={COPY.view}
          value={memory.view}
          options={[
            { value: 'board', label: COPY.columns },
            { value: 'list', label: COPY.list },
          ]}
          onValueChange={setView}
        />
        <Button
          variant="outline"
          size="sm"
          icon={NewSessionGlyph}
          disabled={!canStart}
          onClick={() => {
            startNew()
          }}>
          {COPY.create}
        </Button>
      </div>
    </header>
  )
  const phoneGroup = phoneState ?? firstPhoneState(counts)
  let body
  if (narrow) {
    const shownDone = new Set(column('done').cards.map(card => card.id))
    const rows = listRows(tasks, phoneGroup, filters, workspaces, 'group', items, proposals).filter(
      card => phoneGroup !== 'done' || shownDone.has(card.id),
    )
    body = (
      <div className="work-board-phone">
        <div className="work-board-phone-bar">
          <FilterPills
            className="work-board-states"
            label={COPY.state}
            value={phoneGroup}
            options={BOARD_GROUPS.map(group => ({ value: group, label: `${GROUP_LABELS[group]} ${formatNumber(counts[group])}` }))}
            onValueChange={setPhoneState}
          />
          <div className="work-board-phone-actions">
            <AllFilters options={options} filters={filters} onFilters={setFilters} />
            <span className="work-board-phone-todo">
              {phoneGroup === 'todo' && startAll}
              <Button
                variant="outline"
                size="sm"
                icon={NewSessionGlyph}
                disabled={!canStart}
                onClick={() => {
                  startNew()
                }}>
                {COPY.create}
              </Button>
            </span>
          </div>
        </div>
        {rows.length ? (
          <ul className="work-board-phone-list" aria-label={GROUP_LABELS[phoneGroup]}>
            {rows.map(card => (
              <li key={card.id}>{renderCard(card)}</li>
            ))}
          </ul>
        ) : (
          <div className="work-board-phone-list" data-empty="">
            <span className="work-board-empty-line" aria-hidden="true" />
          </div>
        )}
      </div>
    )
  } else if (memory.view === 'list') {
    const listCounts = Object.fromEntries(
      (['all', ...BOARD_GROUPS] as const).map(state => [
        state,
        listRows(tasks, state, NO_FILTERS, workspaces, 'group', items, proposals).length,
      ]),
    )
    body = (
      <WorkBoardTable
        rows={listRows(tasks, listState, filters, workspaces, order, items, proposals)}
        shell={shell}
        state={listState}
        onState={setListState}
        counts={listCounts}
        order={order}
        onOrder={setOrder}
        marked={marked}
        menuFor={menuFor}
        itemMenu={itemMenu}
        writes={writes.states}
        onReview={canMark ? setReviewing : undefined}
        onOpenItem={openItem}
        onRetry={id => {
          void writes.retry(id)
        }}
        onDismiss={writes.dismiss}
        onOpen={open}
      />
    )
  } else {
    body = (
      <WorkBoard
        columns={columns}
        filtered={filtered}
        schedules={snapshot.automations ?? []}
        now={now}
        renderCard={card => renderCard(card, card === decisionCard)}
        todoAction={startAll}
        drag={drag.view}
        onPointerDown={drag.onPointerDown}
      />
    )
  }
  return (
    <section
      ref={root}
      className="board-surface work-board"
      aria-label={COPY.board}
      hidden={!shell.board}
      data-narrow={narrow ? '' : undefined}
      data-view={memory.view}>
      {showItem ? (
        <ItemPage shell={shell} itemId={itemPage} />
      ) : (
        <>
          {!narrow && header}
          <ProposalRecovery snapshot={snapshot} writes={proposalWrites} onAccepted={showAccepted} />
          <div className="work-board-body">{body}</div>
        </>
      )}
      <WorkBoardNew
        shell={shell}
        open={newSince !== undefined}
        mode={newMode}
        since={newSince ?? null}
        onClose={closeNew}
        onStarted={onNewStarted}
        onKept={setStarted}
      />
      {stopAsk && (
        <DropConfirm
          label={COPY.stopSession}
          question={COPY.askStop(escapeSecurityText(stopAsk.task.title || COPY.untitled))}
          confirmLabel={COPY.stop}
          point={stopAsk.point}
          onClose={() => {
            setStopAsk(null)
          }}
          onConfirm={() => {
            const id = stopAsk.task.id
            setStopAsk(null)
            stop(id)
          }}
        />
      )}
      {tagging && (
        <SessionTagsDialog
          task={tagging}
          known={knownTags([...tasks, ...items])}
          phone={shell.phone}
          onClose={() => {
            setTagging(null)
          }}
          onSave={async tags => {
            const result = await writes.patch(tagging, { tags })
            if (!result.ok && !result.unknown) {
              if (!result.blocked) writes.dismiss(tagging.id)
              throw new MessageError(result.reason ?? COPY.notSaved)
            }
          }}
        />
      )}
      {editing && (
        <WorkBoardItemEdit
          item={editing}
          writes={writes}
          phone={shell.phone}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
      {shell.board && reviewing && tasks.some(task => task.id === reviewing.from.sessionId) && (
        <ProposalReview
          proposal={reviewing}
          writes={proposalWrites}
          shell={shell}
          onClose={() => {
            setReviewing(null)
          }}
        />
      )}
      {shell.board && acceptedItems.length > 0 && <AcceptedItems ids={acceptedItems} shell={shell} onClose={() => setAcceptedItems([])} />}
      {noting && (
        <PromptDialog
          title={COPY.note}
          label={COPY.note}
          initial={(noting.kind === 'item' ? noting.item.note : noting.task.note) ?? ''}
          maxLength={CARD_NOTE_CHARS}
          onClose={() => {
            setNoting(null)
          }}
          onSubmit={async note => {
            if (noting.kind === 'session') {
              await noteSession(noting.task, note)
              return
            }
            const result = await writes.patch(noting.item, { note })
            if (!result.ok && !result.unknown) {
              if (!result.blocked) writes.dismiss(noting.item.id)
              throw new MessageError(result.reason ?? COPY.notSaved)
            }
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={COPY.deleteItem}
          danger
          confirmLabel={COPY.delete}
          message={COPY.askDelete(escapeSecurityText(deleting.title), deleting.sessionIds.length)}
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={async () => {
            const result = await writes.remove(deleting)
            if (!result.ok && !result.unknown) {
              if (!result.blocked) writes.dismiss(deleting.id)
              throw new MessageError(result.reason ?? COPY.notDeleted)
            }
          }}
        />
      )}
    </section>
  )
}

/** 备注… and, with one, 清除备注: the same on a session's card and a 待办's. */
function noteItems(note: string | undefined, edit: () => void, clear: () => void): MenuSection['items'] {
  return [
    { id: 'note', label: note ? COPY.editNote : COPY.addNote, icon: StickyNote, onSelect: edit },
    ...(note ? [{ id: 'note-clear', label: COPY.clearNote, icon: StickyNote, onSelect: clear }] : []),
  ]
}

/**
 * The first card in 等你处理 that waits on an ordinary request answers it in place: R1, and not one the Agent raised
 * for itself. Anything else is read in 对话.
 */
function answerable(task: TaskSummary, approvals: ShellState['snapshot']['approvals']): boolean {
  if (task.board?.reason !== 'approval') return false
  const own = approvals.filter(item => item.sessionId === task.id)
  return own.length > 0 && own.every(item => item.risk === 'R1' && !item.advisory)
}

/** The delivery facts of the cards in view, through the same authorized read as before; a device without them gets none. */
function useDeliveryFor(shell: ShellState, ids: readonly string[], active: boolean) {
  const read = useWorkbenchDelivery(shell.snapshot, shell.connection, active && ids.length > 0, ids)
  return read.entries
}
