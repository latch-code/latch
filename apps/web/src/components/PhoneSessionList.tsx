import { sessionsAwaitingReturn } from '../handoffs/model.ts'
import { ProjectGroupHeading, type ProjectNavigationActions } from './ProjectNavigation.tsx'
import { memo, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { Archive, ChevronLeft, FolderGit2, Laptop, Pin, Plus, SquarePen } from 'lucide-react'
import { escapeSecurityText, type AppSnapshot, type TaskSummary } from '@latch/protocol'
import { deviceAccess } from '../core/permissions.ts'
import { computerName } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { relativeTime } from '../format.ts'
import { useListMotion, usePresence } from '../hooks/useListMotion.ts'
import { projectName } from '../projects.tsx'
import {
  filterSessions,
  groupSessions,
  projectOf,
  rowMeta,
  rowStatus,
  waitsOnYou,
  type SessionFilter,
  type SessionGroup,
} from '../sessions.ts'
import { MarkTile } from './BrandTile.tsx'
import { ActionSheet, type MenuSection } from './overlays.tsx'
import { SessionStatus, statusLabel, useLastConfirmed } from './SessionStatus.tsx'
import { taskHarness, type TaskHarness } from './Sidebar.tsx'
import { Button, ICON_STROKE, IconButton, SearchField } from '@latch/ui'

/** How long a finger rests on a row before its menu opens, and how far it may wander meanwhile. */
const HOLD_MS = 500
const HOLD_SLOP = 8

/**
 * Pressing and holding a row (touch or pen) opens its menu; so does the context-menu gesture or key. The click that
 * ends a hold does not also open the session.
 */
function useHold(onHold: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const held = useRef(false)
  const cancel = () => {
    clearTimeout(timer.current)
    start.current = null
  }
  return {
    /** Whether the press that just ended was a hold; asking clears it, so the next press starts fresh. */
    consume: () => {
      const was = held.current
      held.current = false
      return was
    },
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        held.current = false
        if (event.pointerType === 'mouse') return
        start.current = { x: event.clientX, y: event.clientY }
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          held.current = true
          start.current = null
          onHold()
        }, HOLD_MS)
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const from = start.current
        if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > HOLD_SLOP) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
    },
  }
}

const PhoneRow = memo(function PhoneRow({
  task,
  harness,
  project,
  inWaitingShelf,
  selected,
  held,
  unread,
  stopping,
  frozen,
  leaving,
  now,
  onSelect,
  onHold,
  handoffWaits = false,
}: {
  /** A handoff here waits for its result to be handed back. */
  handoffWaits?: boolean
  task: TaskSummary
  harness: TaskHarness
  project: string | undefined
  inWaitingShelf: boolean
  selected: boolean
  /** Its menu is open: the row stays pressed, so it is clear what the menu acts on. */
  held: boolean
  unread: boolean
  stopping: boolean
  frozen: string | null
  leaving: boolean
  now: number
  onSelect: (id: string) => void
  onHold: (task: TaskSummary) => void
}) {
  const title = task.title || '未命名会话'
  const time = relativeTime(task.updatedAt, new Date(now))
  const status = rowStatus(task, { unread, stopping, frozen: frozen !== null })
  const engine = harness.label
  const meta = rowMeta(task, status, inWaitingShelf ? (project ?? '无项目') : undefined)
  // While the connection is down the row says less, not that what it last knew stopped mattering.
  const strong =
    status.kind === 'waiting'
    || status.kind === 'silent'
    || status.kind === 'failed'
    || status.kind === 'unread'
    || (status.kind === 'frozen' && waitsOnYou(task))
  const said = statusLabel(status, task.live)
  const hold = useHold(() => {
    onHold(task)
  })
  return (
    <li className="phone-entry" data-flip-id={task.id} data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
      <button
        type="button"
        className={`phone-row ${selected ? 'is-selected' : ''} ${held ? 'is-held' : ''} ${strong ? 'is-strong' : ''} ${status.kind === 'unread' ? 'is-unread' : ''}`}
        data-task-id={leaving ? undefined : task.id}
        aria-current={selected ? 'page' : undefined}
        {...hold.handlers}
        onClick={() => {
          if (!hold.consume()) onSelect(task.id)
        }}
        onContextMenu={event => {
          event.preventDefault()
          onHold(task)
        }}>
        <span className="phone-row-line">
          {task.pinned && <Pin className="session-pin" size={12} strokeWidth={ICON_STROKE[12]} aria-label="已置顶" />}
          {task.worktree && (
            <FolderGit2
              className="session-worktree"
              size={12}
              strokeWidth={ICON_STROKE[12]}
              aria-label={`${task.worktree.removed ? '工作树已移除' : '工作树'} · ${escapeSecurityText(task.branch ?? task.worktree.branch)}`}
            />
          )}
          <span className="phone-row-title">{title}</span>
          <SessionStatus
            className="phone-row-status"
            status={status}
            live={task.live}
            inWaitingShelf={false}
            time={time}
            dateTime={task.updatedAt}
          />
        </span>
        <span className="phone-row-meta" aria-hidden="true">
          <span className="session-mark">
            <MarkTile mark={harness.mark} size={16} />
          </span>
          <span className="phone-row-meta-text">{meta ? `${engine} · ${meta}` : engine}</span>
          {handoffWaits && <span className="session-handoff">待交回</span>}
          {status.kind === 'frozen' && <span className="session-frozen">{frozen}</span>}
        </span>
        <span className="sr-only">{`，${engine}${said ? `，${said}` : ''}${handoffWaits ? '，待交回' : ''}${time ? `，${time}` : ''}`}</span>
      </button>
    </li>
  )
})

function PhoneGroup({
  group,
  snapshot,
  context,
  settled,
  selectedId,
  heldId,
  isUnread,
  cancelling,
  frozen,
  now,
  onSelect,
  onNewIn,
  onEditProject,
  onProjectsChanged,
  onHold,
}: ProjectNavigationActions & {
  group: SessionGroup
  snapshot: AppSnapshot
  context: string
  settled: () => void
  selectedId: string | null
  heldId: string | undefined
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  frozen: string | null
  now: number
  onSelect: (id: string) => void
  onNewIn?: (workspaceId: string) => void
  onHold: (task: TaskSummary) => void
}) {
  const rows = usePresence(group.tasks, task => task.id, context, settled)
  const awaiting = sessionsAwaitingReturn(snapshot)
  const workspaceId = group.workspaceId
  const waiting = group.id === 'waiting'
  const workspaces = snapshot.catalog?.workspaces
  return (
    <section className="phone-group" aria-label={group.label} data-shelf={group.id} data-flip-id={`group:${group.id}`} data-flip-scope="">
      {group.project ? (
        <ProjectGroupHeading
          project={group.project}
          onNew={workspaceId && onNewIn ? () => onNewIn(workspaceId) : undefined}
          onEditProject={onEditProject}
          onProjectsChanged={onProjectsChanged}
        />
      ) : (
        <div className="phone-group-head">
          <h2 className="phone-group-label">{group.label}</h2>
          {waiting && <span className="phone-group-count">{group.tasks.length}</span>}
          <span className="phone-group-rule" />
          {workspaceId !== undefined && onNewIn && (
            <IconButton
              className="phone-group-new"
              size="xs"
              label={`在 ${group.label} 中新建会话`}
              icon={Plus}
              onClick={() => {
                onNewIn(workspaceId)
              }}
            />
          )}
        </div>
      )}

      <ul className="phone-card">
        {rows.map(({ item: task, leaving }) => {
          const project = waiting && workspaces ? projectOf(task, workspaces) : undefined
          return (
            <PhoneRow
              handoffWaits={awaiting.has(task.id)}
              key={task.id}
              task={task}
              harness={taskHarness(snapshot, task)}
              project={project && projectName(project)}
              inWaitingShelf={waiting}
              selected={!leaving && task.id === selectedId}
              held={!leaving && task.id === heldId}
              unread={task.id !== selectedId && isUnread(task)}
              stopping={cancelling.has(task.id)}
              frozen={frozen}
              leaving={leaving}
              now={now}
              onSelect={onSelect}
              onHold={onHold}
            />
          )
        })}
      </ul>
    </section>
  )
}

/**
 * The phone's root page: 会话 with 新建会话, the search, then 等你处理 while something waits and a section per project,
 * with 已归档 at the end. A row is 64 high: the title and its status slot, then the engine's mark, the Agent and one more
 * fact. Opening a row pushes the session over this page; holding it opens its menu as a sheet. Elsewhere than the Latch
 * app on that computer, the computer's name heads the page.
 */
export function PhoneSessionList({
  snapshot,
  searchResults,
  archiveBatch,
  archiveUndo,
  connection,
  selectedId,
  isUnread,
  cancelling,
  search,
  onSearch,
  searchRef,
  searching,
  onSearching,
  filter,
  onFilter,
  onSelect,
  onNew,
  onNewIn,
  onEditProject,
  onProjectsChanged,
  sessionMenu,
  now,
  banners,
}: ProjectNavigationActions & {
  snapshot: AppSnapshot
  searchResults?: import('react').ReactNode
  archiveBatch?: import('react').ReactNode
  archiveUndo?: import('react').ReactNode
  connection: ConnectionStatus
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  search: string
  onSearch: (value: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** The search is in use: its 取消 shows. */
  searching: boolean
  onSearching: (open: boolean) => void
  filter: SessionFilter
  onFilter: (filter: SessionFilter) => void
  onSelect: (id: string) => void
  onNew: () => void
  onNewIn?: (workspaceId: string) => void
  /** No longer drawn here: the connection's own notices offer 重试. Kept until the shell stops passing it. */
  onRefresh?: () => Promise<void>
  sessionMenu: (task: TaskSummary) => MenuSection[]
  now: number
  /** Notices about the connection and the Host, at the top of the list. */
  banners?: ReactNode
}) {
  const list = useRef<HTMLElement>(null)
  const [held, setHeld] = useState<TaskSummary | null>(null)
  const empty = snapshot.tasks.length === 0
  const closeSearch = () => {
    onSearch('')
    onSearching(false)
    searchRef.current?.blur()
  }
  const frozen = useLastConfirmed(connection, snapshot)
  const archived = filter === 'archived'
  const visible = filterSessions(snapshot.tasks, filter, search)
  const browsing = !search && !archived
  const projectSections = snapshot.catalog?.projectFolders !== undefined && browsing
  const groups = groupSessions(visible, snapshot.catalog?.workspaces, {
    includeEmpty: projectSections,
    ...(browsing ? { waitingFrom: snapshot.tasks } : {}),
  })
  const archivedCount = snapshot.tasks.filter(task => task.archived).length
  const context = `${filter}\u0000${search}`
  const signature = groups.map(group => `${group.id}:${group.tasks.map(task => task.id).join(',')}`).join('|')
  const remeasure = useListMotion(list, context, signature)
  const heldTask = held ? snapshot.tasks.find(task => task.id === held.id) : undefined
  const heldMenu = useMemo(() => (heldTask ? sessionMenu(heldTask) : null), [heldTask, sessionMenu])
  const remote = !deviceAccess(snapshot, currentShell()).local
  return (
    <div className="phone-list-page">
      {remote && (
        <p className="phone-list-host" title={computerName(snapshot.hostName)}>
          <Laptop size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span className="phone-list-host-name">{computerName(snapshot.hostName)}</span>
        </p>
      )}
      <header className="phone-list-head">
        <h1>会话</h1>
        <IconButton size="lg" label="新建会话" icon={SquarePen} onClick={onNew} />
      </header>
      <div className="phone-search" data-searching={searching ? '' : undefined}>
        <SearchField
          ref={searchRef}
          className="phone-search-field"
          label="搜索会话"
          placeholder="搜索"
          value={search}
          onValueChange={onSearch}
          onFocus={() => {
            onSearching(true)
          }}
        />
        {searching && (
          <Button variant="ghost" onClick={closeSearch}>
            取消
          </Button>
        )}
      </div>
      <div className="phone-list-scroll">
        {archived && (
          <button
            type="button"
            className="phone-archived-back"
            onClick={() => {
              onFilter('all')
            }}>
            <ChevronLeft size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span>已归档</span>
            <span className="phone-archived-count">{archivedCount}</span>
          </button>
        )}
        {archiveBatch}
        {searchResults}
        {banners}
        <nav ref={list} className="phone-sessions" aria-label="会话列表" data-session-filter={filter}>
          {groups.length === 0 ? (
            <div className="phone-empty">
              <p>{search ? '没有匹配的会话' : empty ? '还没有会话' : archived ? '没有已归档的会话' : '暂无会话'}</p>
              {empty && !search && (
                <>
                  <span>会话会保存在这里</span>
                  <Button size="xs" onClick={onNew}>
                    新建会话
                  </Button>
                </>
              )}
            </div>
          ) : (
            groups.map(group => (
              <PhoneGroup
                key={group.id}
                group={group}
                snapshot={snapshot}
                context={context}
                settled={remeasure}
                selectedId={selectedId}
                heldId={heldTask?.id}
                isUnread={isUnread}
                cancelling={cancelling}
                frozen={frozen}
                now={now}
                onSelect={onSelect}
                onNewIn={onNewIn}
                onHold={setHeld}
                onEditProject={onEditProject}
                onProjectsChanged={onProjectsChanged}
              />
            ))
          )}
        </nav>
        {archivedCount > 0 && !archived && !search && (
          <button
            type="button"
            className="phone-archived-row"
            aria-label={`已归档的会话（${archivedCount}）`}
            onClick={() => {
              onFilter('archived')
            }}>
            <Archive size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span>已归档</span>
            <span className="phone-archived-count">{archivedCount}</span>
          </button>
        )}
      </div>
      {archiveUndo}
      <ActionSheet
        label={heldTask ? heldTask.title || '未命名会话' : '会话操作'}
        sections={heldMenu}
        onClose={() => {
          setHeld(null)
        }}
      />
    </div>
  )
}
