import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { BoardGroup, TaskSummary } from '@latch/protocol'
import { Button, FilterPills, MessageGlyph, NewSessionGlyph, SegmentedControl } from '@latch/ui'
import type { SendingMessage } from '../core/sendingMessage.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import type { MenuSection } from '../components/overlays.tsx'
import { WorkbenchDecision } from '../shell/WorkbenchDecision.tsx'
import { useWorkbenchDelivery } from '../shell/useWorkbenchEvidence.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import {
  BOARD_GROUPS,
  boardColumns,
  boardKey,
  filterOptions,
  filtering,
  firstPhoneState,
  groupCounts,
  GROUP_LABELS,
  listRows,
  NO_FILTERS,
  readBoardMemory,
  writeBoardMemory,
  type BoardFilters,
  type BoardMemory,
  type BoardView,
  type ListState,
} from './model.ts'
import { switchWorkView } from '../preferences.ts'
import { boardMarkSections } from '../sessionMenu.ts'
import { useBoardRequests } from './requests.ts'
import { WorkBoard } from './WorkBoard.tsx'
import { WorkBoardCard } from './WorkBoardCard.tsx'
import { AllFilters, FilterChips, FilterMenus } from './WorkBoardFilters.tsx'
import { WorkBoardNew } from './WorkBoardNew.tsx'
import { WorkBoardTable } from './WorkBoardTable.tsx'

/** Below this width the board is one list with a state filter (two 240px columns, their gap and the sides). */
const NARROW = 524
/** The delivery facts are read for the top cards of 可交付 only, as many as one read takes. */
const DELIVERY_READS = 12

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
 * 看板: every session the Host marks as a card, in the Host's group, as four equal columns or a list, filtered by
 * project, Harness, who works on it and tags. A card opens its session in 对话; coming back finds it marked. The board
 * starts sessions through 新建 without leaving.
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
  const [phoneState, setPhoneState] = useState<BoardGroup | null>(null)
  const [started, setStarted] = useState<string | null>(null)
  const [newSince, setNewSince] = useState<SendingMessage | null | undefined>(undefined)
  const root = useRef<HTMLElement>(null)
  const narrow = useNarrow(root)
  useTicker(connection === 'connected' ? 'minute' : false)
  const now = hostNow()
  const tasks = snapshot.tasks
  const workspaces = shell.catalog?.workspaces ?? []
  const filters = memory.filters
  const filtered = filtering(filters)
  const columns = boardColumns(tasks, filters, workspaces, now)
  const counts = groupCounts(tasks, now)
  const options = useMemo(() => filterOptions(tasks, snapshot), [tasks, snapshot])
  const marked = started ?? shell.selectedId
  const deliverable = columns.find(column => column.group === 'deliver')!.cards
  const deliveryIds = useMemo(() => deliverable.slice(0, DELIVERY_READS).map(task => task.id), [deliverable])
  const delivery = useDeliveryFor(shell, deliveryIds, !narrow && memory.view === 'board')

  const open = useCallback(
    (id: string) => {
      setStarted(null)
      shell.choose(id)
      switchWorkView('chat')
    },
    [shell],
  )
  // Back on the board, the session last opened (or just started) is in view, its card marked.
  useEffect(() => {
    if (!marked) return
    const card = root.current?.querySelector<HTMLElement>(`[data-work-session="${CSS.escape(marked)}"]`)
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [marked, memory.view, narrow])

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
          {
            id: 'open',
            label: '在对话中打开',
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
  // Where 对话 stood before 新建: the new-session input targets a new session only on the start screen, so the dialog
  // moves 对话 there and puts it back once it closes.
  const beforeNew = useRef<ShellState['route'] | null>(null)
  const startNew = () => {
    beforeNew.current = shell.route
    shell.startNew()
    setNewSince(shell.submission.sendingMessage)
  }
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
  const decisionId = columns[0].cards.find(task => answerable(task, snapshot.approvals))?.id
  const renderCard = (task: TaskSummary, decide = false) => (
    <WorkBoardCard
      task={task}
      shell={shell}
      marked={marked === task.id}
      delivery={delivery.get(task.id)}
      sharedFolder={!!task.cwd && !task.worktree && tasks.some(other => other.id !== task.id && !other.archived && other.cwd === task.cwd)}
      menu={menuFor(task)}
      onOpen={open}
      decision={decide ? <WorkbenchDecision task={task} shell={decisionShell} /> : undefined}
    />
  )
  const header = (
    <header className="work-board-head">
      <div className="work-board-filters">
        <FilterMenus options={options} filters={filters} onFilters={setFilters} />
        <FilterChips options={options} filters={filters} onFilters={setFilters} />
      </div>
      <div className="work-board-head-actions">
        <SegmentedControl
          label="看法"
          value={memory.view}
          options={[
            { value: 'board', label: '板' },
            { value: 'list', label: '表' },
          ]}
          onValueChange={setView}
        />
        <Button variant="outline" size="sm" icon={NewSessionGlyph} disabled={!canStart} onClick={startNew}>
          新建
        </Button>
      </div>
    </header>
  )
  const phoneGroup = phoneState ?? firstPhoneState(counts)
  let body
  if (narrow) {
    const rows = listRows(tasks, phoneGroup, filters, workspaces, 'group').filter(
      task => phoneGroup !== 'done' || columns[3].cards.includes(task),
    )
    body = (
      <div className="work-board-phone">
        <div className="work-board-phone-bar">
          <FilterPills
            className="work-board-states"
            label="状态"
            value={phoneGroup}
            options={BOARD_GROUPS.map(group => ({ value: group, label: `${GROUP_LABELS[group]} ${counts[group]}` }))}
            onValueChange={setPhoneState}
          />
          <div className="work-board-phone-actions">
            <AllFilters options={options} filters={filters} onFilters={setFilters} />
            <Button variant="outline" size="sm" icon={NewSessionGlyph} disabled={!canStart} onClick={startNew}>
              新建
            </Button>
          </div>
        </div>
        {rows.length ? (
          <ul className="work-board-phone-list" aria-label={GROUP_LABELS[phoneGroup]}>
            {rows.map(task => (
              <li key={task.id}>{renderCard(task)}</li>
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
      (['all', ...BOARD_GROUPS] as const).map(state => [state, listRows(tasks, state, NO_FILTERS, workspaces, 'group').length]),
    )
    body = (
      <WorkBoardTable
        rows={listRows(tasks, listState, filters, workspaces, order)}
        shell={shell}
        state={listState}
        onState={setListState}
        counts={listCounts}
        order={order}
        onOrder={setOrder}
        marked={marked}
        menuFor={menuFor}
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
        renderCard={task => renderCard(task, task.id === decisionId)}
      />
    )
  }
  return (
    <section
      ref={root}
      className="board-surface work-board"
      aria-label="看板"
      data-narrow={narrow ? '' : undefined}
      data-view={memory.view}>
      {!narrow && header}
      <div className="work-board-body">{body}</div>
      <WorkBoardNew shell={shell} open={newSince !== undefined} since={newSince ?? null} onClose={closeNew} onStarted={setStarted} />
    </section>
  )
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
