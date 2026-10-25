import { ProjectGroupHeading, ProjectsHeading, type ProjectNavigationActions } from './ProjectNavigation.tsx'
import { Fragment, memo, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { ChevronRight, Inbox, Laptop, Plus, RefreshCw, Search, Settings, SquarePen } from 'lucide-react'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { BUILTIN_HARNESS_NAME } from '../composerChoice.ts'
import { relativeTime, statusLabels } from '../format.ts'
import { useListMotion, usePresence } from '../hooks/useListMotion.ts'
import {
  filterSessions,
  groupSessions,
  sessionFact,
  sessionFilterLabels,
  sessionSlot,
  type SessionFilter,
  type SessionGroup,
} from '../sessions.ts'
import { HarnessTile } from './BrandTile.tsx'
import { ActionSheet, type MenuSection } from './overlays.tsx'
import { taskHarness, type TaskHarness } from './Sidebar.tsx'
import { Button, Collapse, Count, FilterPills, ICON_STROKE, IconButton, SearchField, StatusSlot, useLivePrevious } from '@latch/ui'

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

/** The harness's name on a row: the built-in one by its product name, one no longer listed by its ID. */
const harnessLabel = (harness: TaskHarness) => (harness.source === 'builtin' ? BUILTIN_HARNESS_NAME : (harness.name ?? harness.id))

const PhoneRow = memo(function PhoneRow({
  task,
  harness,
  selected,
  held,
  unread,
  cancelling,
  leaving,
  now,
  onSelect,
  onHold,
}: {
  task: TaskSummary
  harness: TaskHarness
  selected: boolean
  /** Its menu is open: the row stays pressed, so it is clear what the menu acts on. */
  held: boolean
  unread: boolean
  cancelling: boolean
  leaving: boolean
  now: number
  onSelect: (id: string) => void
  onHold: (task: TaskSummary) => void
}) {
  const title = task.title || '未命名会话'
  const time = relativeTime(task.updatedAt, new Date(now))
  // The list is the phone's root: a running session always turns its comet here.
  const slot = sessionSlot(task, false, unread)
  const name = harnessLabel(harness)
  const fact = sessionFact(task, slot, cancelling, time)
  const hold = useHold(() => {
    onHold(task)
  })
  return (
    <li className="phone-entry" data-flip-id={task.id} data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
      <button
        type="button"
        className={`phone-row ${selected ? 'is-selected' : ''} ${held ? 'is-held' : ''} ${unread ? 'is-unread' : ''}`}
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
          <span className="phone-row-title">{title}</span>
          <StatusSlot
            className="phone-row-status"
            status={slot}
            size={16}
            waiting={statusLabels['waiting-approval']}
            failed={task.permissionDrift && task.status !== 'failed' ? '权限已变化' : statusLabels.failed}
            time={time}
            dateTime={task.updatedAt}
          />
        </span>
        <span className="phone-row-meta" aria-hidden="true">
          <HarnessTile harness={{ id: harness.id, source: harness.source }} size={16} />
          <span className="phone-row-meta-text">{fact ? `${name} · ${fact}` : name}</span>
        </span>
        <span className="sr-only">{`，${name}，${cancelling ? '正在取消' : statusLabels[task.status]}${task.permissionDrift ? '，权限模式已变化' : ''}${unread ? '，有新内容' : ''}${time ? `，${time}` : ''}`}</span>
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
  now: number
  onSelect: (id: string) => void
  onNewIn?: (workspaceId: string) => void
  onHold: (task: TaskSummary) => void
}) {
  const rows = usePresence(group.tasks, task => task.id, context, settled)
  const workspaceId = group.workspaceId
  return (
    <section className="phone-group" aria-label={group.label} data-flip-id={`group:${group.id}`} data-flip-scope="">
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
        {rows.map(({ item: task, leaving }) => (
          <PhoneRow
            key={task.id}
            task={task}
            harness={taskHarness(snapshot, task)}
            selected={!leaving && task.id === selectedId}
            held={!leaving && task.id === heldId}
            unread={task.id !== selectedId && isUnread(task)}
            cancelling={cancelling.has(task.id)}
            leaving={leaving}
            now={now}
            onSelect={onSelect}
            onHold={onHold}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * The phone's root page, on the ground: 会话 with settings, search and 新建会话; the filter pills (with 已归档 once
 * something is archived); then, as paper cards, 等你处理 while something waits and a card per group (置顶, then each
 * project). A row is 64 high: the title and its status slot, then the harness and one more fact. Opening a row pushes
 * the session over this page; holding it opens its menu as a sheet. The list ends with the computer it comes from and
 * 同步最新状态.
 */
export function PhoneSessionList({
  snapshot,
  searchResults,
  archiveBatch,
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
  onCreateProject,
  onEditProject,
  onProjectsChanged,
  onApprovals,
  onSettings,
  onRefresh,
  sessionMenu,
  now,
  banners,
}: ProjectNavigationActions & {
  snapshot: AppSnapshot
  searchResults?: import('react').ReactNode
  archiveBatch?: import('react').ReactNode
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  search: string
  onSearch: (value: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** The search row is open under the header. */
  searching: boolean
  onSearching: (open: boolean) => void
  filter: SessionFilter
  onFilter: (filter: SessionFilter) => void
  onSelect: (id: string) => void
  onNew: () => void
  onNewIn?: (workspaceId: string) => void
  onApprovals: () => void
  onSettings: () => void
  /** 同步最新状态: reads the Host's state again. */
  onRefresh: () => Promise<void>
  sessionMenu: (task: TaskSummary) => MenuSection[]
  now: number
  /** Notices about the connection and the Host, at the top of the list. */
  banners?: ReactNode
}) {
  const list = useRef<HTMLElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const [held, setHeld] = useState<TaskSummary | null>(null)
  const [syncing, setSyncing] = useState(false)
  const empty = snapshot.tasks.length === 0
  const closeSearch = () => {
    onSearch('')
    onSearching(false)
    // The search row folds away and cannot keep focus: it goes back to the button that opened it.
    searchButton.current?.focus({ preventScroll: true })
  }
  const visible = filterSessions(snapshot.tasks, filter, search)
  const projectSections = snapshot.catalog?.projectFolders !== undefined && !search && filter === 'all'
  const groups = groupSessions(visible, snapshot.catalog?.workspaces, { includeEmpty: projectSections })
  const approvals = snapshot.approvals.length
  // The card shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  const archivedCount = snapshot.tasks.filter(task => task.archived).length
  const filters: SessionFilter[] =
    archivedCount > 0 || filter === 'archived' ? ['all', 'chat', 'agent', 'archived'] : ['all', 'chat', 'agent']
  const context = `${filter}\u0000${search}`
  const signature = groups.map(group => `${group.id}:${group.tasks.map(task => task.id).join(',')}`).join('|')
  const remeasure = useListMotion(list, context, signature)
  const heldTask = held ? snapshot.tasks.find(task => task.id === held.id) : undefined
  const heldMenu = useMemo(() => (heldTask ? sessionMenu(heldTask) : null), [heldTask, sessionMenu])
  return (
    <div className="phone-list-page">
      <header className="phone-list-head">
        <h1>会话</h1>
        <IconButton size="lg" label="设置" icon={Settings} onClick={onSettings} />
        <IconButton
          ref={searchButton}
          size="lg"
          label="搜索会话"
          icon={Search}
          pressed={searching}
          onClick={() => {
            if (searching) closeSearch()
            else onSearching(true)
          }}
        />
        <IconButton size="lg" label="新建会话" icon={SquarePen} onClick={onNew} />
      </header>
      <Collapse open={searching} className="phone-search-collapse">
        <div className="phone-search" inert={!searching || undefined}>
          <SearchField
            ref={searchRef}
            className="phone-search-field"
            label="搜索会话"
            placeholder="搜索标题"
            value={search}
            onValueChange={onSearch}
          />
          <Button variant="ghost" onClick={closeSearch}>
            取消
          </Button>
        </div>
      </Collapse>
      {/* With nothing to filter yet, there are no filters. */}
      {!empty && (
        <div className="phone-filters">
          <FilterPills
            label="筛选会话"
            value={filter}
            options={filters.map(value => ({ value, label: sessionFilterLabels[value] }))}
            onValueChange={onFilter}
          />
        </div>
      )}
      <div className="phone-list-scroll">
        {archiveBatch}
        {searchResults}
        {banners}
        {approvals > 0 && (
          <button type="button" className="phone-inbox" onClick={onApprovals}>
            <Inbox className="phone-inbox-icon" size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />
            <span className="phone-inbox-label">等你处理</span>
            <Count tone="warn" value={approvals} from={approvalsBefore} />
            <ChevronRight className="phone-inbox-chevron" size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          </button>
        )}
        <nav ref={list} className="phone-sessions" aria-label="会话列表" data-session-filter={filter}>
          {groups.length === 0 ? (
            <div className="phone-empty">
              <p>{search ? '没有匹配的会话' : empty ? '还没有会话' : filter === 'archived' ? '没有已归档的会话' : '暂无此类会话'}</p>
              {empty && !search && (
                <>
                  <span>会话会保存在这里，在任何已连接设备上继续。</span>
                  <Button size="xs" onClick={onNew}>
                    新建会话
                  </Button>
                </>
              )}
            </div>
          ) : (
            groups.map((group, index) => (
              <Fragment key={group.id}>
                {projectSections && group.id !== 'pinned' && (index === 0 || groups[index - 1]?.id === 'pinned') && (
                  <ProjectsHeading
                    empty={!snapshot.catalog?.workspaces.some(item => item.id !== 'default')}
                    onCreateProject={onCreateProject}
                  />
                )}
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
                  now={now}
                  onSelect={onSelect}
                  onNewIn={onNewIn}
                  onHold={setHeld}
                  onEditProject={onEditProject}
                  onProjectsChanged={onProjectsChanged}
                />
              </Fragment>
            ))
          )}
          {projectSections && groups.every(group => group.id === 'pinned') && (
            <ProjectsHeading empty={!snapshot.catalog?.workspaces.some(item => item.id !== 'default')} onCreateProject={onCreateProject} />
          )}
        </nav>
        <footer className="phone-list-foot">
          <Laptop className="phone-list-foot-icon" size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span className="phone-list-host" title={snapshot.hostName}>
            {snapshot.hostName || '执行端'}
          </span>
          <Button
            size="xs"
            variant="ghost"
            icon={RefreshCw}
            loading={syncing}
            onClick={() => {
              setSyncing(true)
              void onRefresh().finally(() => {
                setSyncing(false)
              })
            }}>
            同步最新状态
          </Button>
        </footer>
      </div>
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
