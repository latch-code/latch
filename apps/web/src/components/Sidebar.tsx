import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import { Archive, Ellipsis, Inbox, Laptop, PanelLeft, Plus, Search, Settings, SquarePen, X } from 'lucide-react'
import type { AppSnapshot, HarnessInfo, TaskSummary } from '@latch/protocol'
import { sessionHarness } from '../composerChoice.ts'
import { relativeTime, statusLabels } from '../format.ts'
import { useListMotion, usePresence } from '../hooks/useListMotion.ts'
import { filterSessions, groupSessions, sessionFilterLabels, sessionSlot, type SessionFilter, type SessionGroup } from '../sessions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { HarnessTile } from './BrandTile.tsx'
import { DevModeChip } from './DevModeChip.tsx'
import { Menu, type MenuSection } from './overlays.tsx'
import { Count, FilterPills, ICON_STROKE, IconButton, Kbd, SearchField, StatusSlot, useLivePrevious, type CometSize } from '@latch/ui'
import { BrandMark } from './ui.tsx'

export const connectionLabels: Record<ConnectionStatus, string> = {
  connected: '已连接',
  connecting: '同步中',
  reconnecting: '重新连接中',
  offline: '离线',
}

/** The footer's quiet line, in place of 已连接, while the desktop app keeps this Mac awake. */
const KEEP_AWAKE_LABEL = '保持唤醒中'

/** The connection is named only when it is not healthy. */
export const connectionProblem = (connection: ConnectionStatus) => connection === 'reconnecting' || connection === 'offline'

/**
 * The harness a session runs on, for its tile: the catalog's entry, or, for one no longer listed (a removed agent), an
 * agent of that ID; a session from before harnesses were recorded ran on the built-in one. A row describes the
 * session, not the agent's state now, so its tile never draws whether the harness is currently usable.
 */
export type TaskHarness = Pick<HarnessInfo, 'id' | 'source'> & Partial<Pick<HarnessInfo, 'name'>>
export function taskHarness(snapshot: AppSnapshot, task: TaskSummary): TaskHarness {
  const known = sessionHarness(snapshot.catalog, task)
  if (known) return known
  return task.harnessId !== undefined && task.harnessId !== 'standard'
    ? { id: task.harnessId, source: 'acp' }
    : { id: 'standard', source: 'builtin' }
}

const searchKey = () => (/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K')

const SessionItem = memo(function SessionItem({
  task,
  harness,
  selected,
  unread,
  cancelling,
  leaving,
  now,
  size,
  onSelect,
  menu,
}: {
  task: TaskSummary
  harness: TaskHarness
  selected: boolean
  unread: boolean
  cancelling: boolean
  /** Removed from the list: it folds away and takes no input. */
  leaving: boolean
  now: number
  /** The status slot's size: 12 in the sidebar. */
  size: CometSize
  onSelect: (id: string) => void
  menu: (task: TaskSummary) => MenuSection[]
}) {
  const title = task.title || '未命名会话'
  const time = relativeTime(task.updatedAt, new Date(now))
  return (
    <li className="session-entry" data-flip-id={task.id} data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
      <div className={`session-item ${selected ? 'is-selected' : ''} ${unread ? 'is-unread' : ''}`}>
        <button
          type="button"
          className="session-item-main"
          data-task-id={leaving ? undefined : task.id}
          aria-current={selected ? 'page' : undefined}
          onClick={() => {
            onSelect(task.id)
          }}>
          <HarnessTile harness={{ id: harness.id, source: harness.source }} size={20} className="session-tile" />
          <span className="session-title">{title}</span>
          <span className="sr-only">{`，${harness?.name ? `${harness.name}，` : ''}${cancelling ? '正在取消' : statusLabels[task.status]}${task.permissionDrift ? '，权限模式已变化' : ''}${unread ? '，有新内容' : ''}${time ? `，${time}` : ''}`}</span>
          <StatusSlot
            className="session-status"
            status={sessionSlot(task, selected, unread)}
            size={size}
            waiting={statusLabels['waiting-approval']}
            failed={task.permissionDrift && task.status !== 'failed' ? '权限已变化' : statusLabels.failed}
            time={time}
            dateTime={task.updatedAt}
          />
        </button>
        {!task.archived && menu(task).some(section => section.items.some(item => item.id === 'archive')) && (
          <IconButton
            className="session-item-archive"
            label={`归档：${title}`}
            icon={Archive}
            onClick={() =>
              menu(task)
                .flatMap(section => section.items)
                .find(item => item.id === 'archive')
                ?.onSelect()
            }
          />
        )}
        <Menu
          label={`会话操作：${title}`}
          placement="bottom-end"
          sections={menu(task)}
          trigger={props => (
            <IconButton {...props} className="session-item-more" label={`更多操作：${title}`} tooltip="更多操作" icon={Ellipsis} />
          )}
        />
      </div>
    </li>
  )
})

function SessionGroupView({
  group,
  snapshot,
  context,
  settled,
  selectedId,
  isUnread,
  cancelling,
  now,
  size,
  onSelect,
  onNewIn,
  menu,
}: {
  group: SessionGroup
  snapshot: AppSnapshot
  /** The filter and search the list shows; rows leave at once when it changes. */
  context: string
  /** Called once rows that left have folded away. */
  settled: () => void
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  now: number
  size: CometSize
  onSelect: (id: string) => void
  onNewIn?: (workspaceId: string) => void
  menu: (task: TaskSummary) => MenuSection[]
}) {
  const rows = usePresence(group.tasks, task => task.id, context, settled)
  const workspaceId = group.workspaceId
  return (
    <section className="session-group" aria-label={group.label} data-flip-id={`group:${group.id}`} data-flip-scope="">
      <div className="session-group-head">
        <h3 className="session-group-label">{group.label}</h3>
        {workspaceId !== undefined && onNewIn && (
          <IconButton
            className="session-group-new"
            size="xs"
            label={`在 ${group.label} 中新建会话`}
            icon={Plus}
            onClick={() => {
              onNewIn(workspaceId)
            }}
          />
        )}
      </div>
      <ul>
        {rows.map(({ item: task, leaving }) => (
          <SessionItem
            key={task.id}
            task={task}
            harness={taskHarness(snapshot, task)}
            selected={!leaving && task.id === selectedId}
            unread={task.id !== selectedId && isUnread(task)}
            cancelling={cancelling.has(task.id)}
            leaving={leaving}
            now={now}
            size={size}
            onSelect={onSelect}
            menu={menu}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * The session column: the brand with 新建会话 and collapse, the search with its filters, 等你处理, the sessions in
 * groups (pinned, then by project) and the computer this Host runs on with settings.
 */
export function Sidebar({
  snapshot,
  searchResults,
  archiveBatch,
  selectedId,
  isUnread,
  cancelling,
  search,
  onSearch,
  searchRef,
  filter,
  onFilter,
  onSelect,
  onNew,
  onNewIn,
  newActive = false,
  onApprovals,
  drawer,
  onClose,
  onCollapse,
  collapseRef,
  connection,
  onRefresh,
  onSettings,
  sessionMenu,
  now,
  devMode = false,
  keepAwake,
}: {
  snapshot: AppSnapshot
  searchResults?: import('react').ReactNode
  archiveBatch?: import('react').ReactNode
  /** Show the dev-build chip in the footer (wide layouts; tablets show it in the rail, phones in settings). */
  devMode?: boolean
  /** The desktop app is keeping this Mac awake: why, for the title of the connection line. */
  keepAwake?: string
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  search: string
  onSearch: (value: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  filter: SessionFilter
  onFilter: (filter: SessionFilter) => void
  onSelect: (id: string) => void
  onNew: () => void
  /** Starts a new session in a saved project; absent where this device cannot start one. */
  onNewIn?: (workspaceId: string) => void
  /** The new-session page is open: 新建会话 shows as a toggle that is on. */
  newActive?: boolean
  onApprovals: () => void
  drawer: boolean
  onClose: () => void
  /** Shuts the column (from 1024px). */
  onCollapse?: () => void
  collapseRef?: RefObject<HTMLButtonElement | null>
  connection: ConnectionStatus
  onRefresh: () => void
  onSettings: () => void
  sessionMenu: (task: TaskSummary) => MenuSection[]
  now: number
}) {
  const list = useRef<HTMLElement>(null)
  const searchBox = useRef<HTMLDivElement>(null)
  const [searching, setSearching] = useState(false)
  /**
   * A press that began inside the search and has not ended in its click yet. Safari and iOS do not focus a button that
   * is clicked or tapped, so pressing a filter pill blurs the search with nowhere for focus to go (with a mouse while
   * the button is down, on touch only after the finger has lifted, just before the click): the pills must stay open,
   * and usable, until the click lands.
   */
  const pressedInside = useRef(false)
  useEffect(() => {
    const press = (event: PointerEvent) => {
      const box = searchBox.current
      pressedInside.current = box !== null && event.target instanceof Node && box.contains(event.target)
    }
    const settle = () => {
      pressedInside.current = false
    }
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('pointercancel', settle, true)
    document.addEventListener('click', settle, true)
    return () => {
      document.removeEventListener('pointerdown', press, true)
      document.removeEventListener('pointercancel', settle, true)
      document.removeEventListener('click', settle, true)
    }
  }, [])
  useEffect(() => {
    if (!searching) return undefined
    // A press elsewhere ends the search's use, wherever focus went; a press inside it never closes it.
    const pressAway = (event: PointerEvent) => {
      const box = searchBox.current
      if (box && event.target instanceof Node && !box.contains(event.target) && !box.contains(document.activeElement)) setSearching(false)
    }
    document.addEventListener('pointerdown', pressAway, true)
    return () => {
      document.removeEventListener('pointerdown', pressAway, true)
    }
  }, [searching])
  const visible = filterSessions(snapshot.tasks, filter, search)
  const groups = groupSessions(visible, snapshot.catalog?.workspaces)
  const approvals = snapshot.approvals.length
  // The row shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  const archivedCount = snapshot.tasks.filter(task => task.archived).length
  const filters: SessionFilter[] =
    archivedCount > 0 || filter === 'archived' ? ['all', 'chat', 'agent', 'archived'] : ['all', 'chat', 'agent']
  const showFilters = searching || search !== '' || filter !== 'all'
  // A new filter or search redraws the list at once; changes from the Host move and fold its rows.
  const context = `${filter}\u0000${search}`
  const signature = groups.map(group => `${group.id}:${group.tasks.map(task => task.id).join(',')}`).join('|')
  const remeasure = useListMotion(list, context, signature)
  return (
    <div className="sidebar-body">
      <div className="sidebar-head">
        <span className="sidebar-brand">
          <BrandMark size={20} />
          <span className="brand-name">Latch</span>
        </span>
        <IconButton label="新建会话" icon={SquarePen} pressed={drawer ? undefined : newActive} onClick={onNew} />
        {drawer ? (
          <IconButton label="关闭会话列表" icon={X} onClick={onClose} />
        ) : (
          onCollapse && <IconButton ref={collapseRef} label="收起侧栏" icon={PanelLeft} onClick={onCollapse} />
        )}
      </div>
      <div
        ref={searchBox}
        className="sidebar-search"
        onFocus={() => {
          setSearching(true)
        }}
        onBlur={event => {
          // Focus left for somewhere outside, or went nowhere outside a press inside the search (which keeps the pills
          // open until its click lands); a press elsewhere also closes them (above).
          const leaving = event.relatedTarget === null ? !pressedInside.current : !event.currentTarget.contains(event.relatedTarget)
          if (leaving) setSearching(false)
        }}>
        <SearchField
          ref={searchRef}
          className="search-field"
          variant="ghost"
          label="搜索会话"
          placeholder="搜索"
          value={search}
          onValueChange={onSearch}
          trailing={drawer ? undefined : <Kbd>{searchKey()}</Kbd>}
        />
        <div className="sidebar-filters" data-open={showFilters ? '' : undefined} inert={!showFilters || undefined}>
          <div className="sidebar-filters-inner">
            <FilterPills
              label="筛选会话"
              value={filter}
              options={filters.map(value => ({ value, label: sessionFilterLabels[value] }))}
              onValueChange={onFilter}
            />
          </div>
        </div>
      </div>
      {approvals > 0 && (
        <button type="button" className="approvals-row" onClick={onApprovals}>
          <span className="sidebar-row-icon">
            <Inbox size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </span>
          <span>等你处理</span>
          <Count tone="warn" value={approvals} from={approvalsBefore} />
        </button>
      )}
      {archiveBatch}
      <nav ref={list} className="session-list" aria-label="会话列表" data-session-filter={filter}>
        {groups.length === 0 ? (
          <div className="list-empty">
            <p>
              {search
                ? '没有匹配的会话'
                : snapshot.tasks.length === 0
                  ? '会话会保存在这里'
                  : filter === 'archived'
                    ? '没有已归档的会话'
                    : '暂无此类会话'}
            </p>
            {snapshot.tasks.length === 0 && <span>在任何已连接设备上继续。</span>}
          </div>
        ) : (
          groups.map(group => (
            <SessionGroupView
              key={group.id}
              group={group}
              snapshot={snapshot}
              context={context}
              settled={remeasure}
              selectedId={selectedId}
              isUnread={isUnread}
              cancelling={cancelling}
              now={now}
              size={12}
              onSelect={onSelect}
              onNewIn={onNewIn}
              menu={sessionMenu}
            />
          ))
        )}
        {searchResults}
        {archivedCount > 0 && filter !== 'archived' && !search && (
          <button
            type="button"
            className="archived-row"
            aria-label={`已归档的会话（${archivedCount}）`}
            onClick={() => {
              onFilter('archived')
            }}>
            <span className="sidebar-row-icon">
              <Archive size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            </span>
            <span>已归档</span>
            <span className="archived-count">{archivedCount}</span>
          </button>
        )}
      </nav>
      <footer className="sidebar-footer">
        <Laptop className="host-icon" size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
        <span className="host-name" title={snapshot.hostName}>
          {snapshot.hostName || '执行端'}
        </span>
        {devMode && <DevModeChip />}
        {/*
         * A healthy connection is not named. While the desktop app keeps this Mac awake the same place says so in a few
         * quiet words that never shrink, as wide as the amber badge; the reason is in its title.
         */}
        {(connectionProblem(connection) || (keepAwake && connection === 'connected')) && (
          <button
            type="button"
            className={`connection-badge connection-${connection}`}
            title={keepAwake ? `${keepAwake} · 同步最新状态` : '同步最新状态'}
            onClick={onRefresh}>
            {connection === 'connected' ? KEEP_AWAKE_LABEL : connectionLabels[connection]}
          </button>
        )}
        <span className="sidebar-footer-spacer" />
        <IconButton label="设置" icon={Settings} onClick={onSettings} />
      </footer>
    </div>
  )
}

/** Tablet: a 56px rail keeps the main destinations one tap away; the list slides over. */
export function Rail({
  approvals,
  drawerOpen,
  onSessions,
  onNew,
  onSearch,
  onApprovals,
  onSettings,
  devMode = false,
}: {
  approvals: number
  devMode?: boolean
  drawerOpen: boolean
  onSessions: () => void
  onNew: () => void
  onSearch: () => void
  onApprovals: () => void
  onSettings: () => void
}) {
  // The button shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  return (
    <>
      <BrandMark size={24} />
      <IconButton
        label="打开会话列表"
        icon={PanelLeft}
        aria-controls="session-navigation"
        aria-expanded={drawerOpen}
        onClick={onSessions}
      />
      <IconButton label="新建会话" icon={SquarePen} onClick={onNew} />
      <IconButton label="搜索会话" icon={Search} onClick={onSearch} />
      {approvals > 0 && (
        <IconButton
          label={`${approvals} 项等你处理`}
          icon={Inbox}
          badge={<Count tone="warn" value={approvals} from={approvalsBefore} />}
          onClick={onApprovals}
        />
      )}
      <span className="rail-spacer" />
      {devMode && <DevModeChip compact />}
      <IconButton label="设置" icon={Settings} onClick={onSettings} />
    </>
  )
}
