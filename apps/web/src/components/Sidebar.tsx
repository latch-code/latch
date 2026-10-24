import { memo, type RefObject } from 'react'
import {
  Ellipsis,
  ListFilter,
  Monitor,
  MonitorSmartphone,
  PanelLeft,
  Search,
  Settings,
  ShieldAlert,
  Smartphone,
  SquarePen,
  X,
} from 'lucide-react'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { looksLikePhone, relativeTime, statusLabels } from '../format.ts'
import { ICON_STROKE, SessionGlyph } from '../icons.tsx'
import { filterSessions, groupSessions, sessionFilterLabels, type SessionFilter } from '../sessions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { DevModeChip } from './DevModeChip.tsx'
import { Menu, type MenuSection } from './overlays.tsx'
import { BrandMark, IconButton } from './ui.tsx'

export const connectionLabels: Record<ConnectionStatus, string> = {
  connected: '已连接',
  connecting: '同步中',
  reconnecting: '重新连接中',
  offline: '离线',
}

const SessionItem = memo(function SessionItem({
  task,
  selected,
  unread,
  cancelling,
  now,
  onSelect,
  menu,
}: {
  task: TaskSummary
  selected: boolean
  unread: boolean
  cancelling: boolean
  now: number
  onSelect: (id: string) => void
  menu: (task: TaskSummary) => MenuSection[]
}) {
  const title = task.title || '未命名会话'
  return (
    <li className={`session-item ${selected ? 'is-selected' : ''} ${unread ? 'is-unread' : ''}`}>
      <button
        type="button"
        className="session-item-main"
        data-task-id={task.id}
        aria-current={selected ? 'page' : undefined}
        onClick={() => {
          onSelect(task.id)
        }}>
        <span className="session-glyph">
          <SessionGlyph status={task.status} />
        </span>
        <span className="session-title">{title}</span>
        <span className="sr-only">{`，${cancelling ? '正在取消' : statusLabels[task.status]}${unread ? '，有新内容' : ''}`}</span>
        {unread && <i className="unread-dot" aria-hidden="true" />}
        <time className="session-time" dateTime={task.updatedAt}>
          {relativeTime(task.updatedAt, new Date(now))}
        </time>
      </button>
      <Menu
        label={`会话操作：${title}`}
        placement="bottom-end"
        sections={menu(task)}
        trigger={props => (
          <button type="button" className="icon-button session-item-more" aria-label={`更多操作：${title}`} title="更多操作" {...props}>
            <Ellipsis size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        )}
      />
    </li>
  )
})

export function Sidebar({
  snapshot,
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
  onApprovals,
  drawer,
  onClose,
  connection,
  onRefresh,
  onDevices,
  onSettings,
  sessionMenu,
  now,
  devMode = false,
}: {
  snapshot: AppSnapshot
  /** Show the dev-build chip in the footer (wide layouts; tablets show it in the rail, phones in settings). */
  devMode?: boolean
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  search: string
  onSearch: (value: string) => void
  searchRef: RefObject<HTMLInputElement>
  filter: SessionFilter
  onFilter: (filter: SessionFilter) => void
  onSelect: (id: string) => void
  onNew: () => void
  onApprovals: () => void
  drawer: boolean
  onClose: () => void
  connection: ConnectionStatus
  onRefresh: () => void
  onDevices: () => void
  onSettings: () => void
  sessionMenu: (task: TaskSummary) => MenuSection[]
  now: number
}) {
  const visible = filterSessions(snapshot.tasks, filter, search)
  const groups = groupSessions(visible, new Date(now))
  const approvals = snapshot.approvals.length
  const DeviceIcon = looksLikePhone(snapshot.device.name) ? Smartphone : Monitor
  const archivedCount = snapshot.tasks.filter(task => task.archived).length
  const filters: SessionFilter[] =
    archivedCount > 0 || filter === 'archived' ? ['all', 'chat', 'agent', 'archived'] : ['all', 'chat', 'agent']
  return (
    <>
      <div className="sidebar-brand">
        <BrandMark size={24} />
        <span className="brand-name">Latch</span>
        {drawer && <IconButton label="关闭会话列表" icon={X} onClick={onClose} />}
      </div>
      <div className="sidebar-actions">
        <button type="button" className="new-session-button" onClick={onNew}>
          <SquarePen size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>新建会话</span>
        </button>
        <label className="search-field">
          <Search size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={search}
            onChange={event => {
              onSearch(event.target.value)
            }}
            onKeyDown={event => {
              if (event.key === 'Escape' && search) {
                event.stopPropagation()
                onSearch('')
              }
            }}
          />
          {search ? (
            <button
              type="button"
              className="search-clear"
              aria-label="清除搜索"
              onClick={() => {
                onSearch('')
              }}>
              <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          ) : (
            !drawer && <kbd aria-hidden="true">{/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
          )}
        </label>
        {approvals > 0 && (
          <button type="button" className="approvals-row" onClick={onApprovals}>
            <ShieldAlert size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>待批准</span>
            <span className="count-pill">{approvals}</span>
          </button>
        )}
      </div>
      <div className="session-list-header">
        <span>{filter === 'all' ? '会话' : sessionFilterLabels[filter]}</span>
        {filter !== 'all' && (
          <button
            type="button"
            className="filter-chip"
            onClick={() => {
              onFilter('all')
            }}
            aria-label={`清除筛选：${sessionFilterLabels[filter]}`}>
            {sessionFilterLabels[filter]}
            <X size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        )}
        <Menu
          label="筛选会话"
          selection
          placement="bottom-end"
          sections={[
            {
              id: 'filters',
              items: filters.map(value => ({
                id: value,
                label: sessionFilterLabels[value],
                checked: filter === value,
                onSelect: () => {
                  onFilter(value)
                },
              })),
            },
          ]}
          trigger={props => (
            <button type="button" className="icon-button" aria-label="筛选会话" title="筛选会话" {...props}>
              <ListFilter size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          )}
        />
      </div>
      <nav className="session-list" aria-label="会话列表" data-session-filter={filter}>
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
            <section key={group.id} className="session-group" aria-label={group.label}>
              <h3 className="session-group-label">{group.label}</h3>
              <ul>
                {group.tasks.map(task => (
                  <SessionItem
                    key={task.id}
                    task={task}
                    selected={task.id === selectedId}
                    unread={task.id !== selectedId && isUnread(task)}
                    cancelling={cancelling.has(task.id)}
                    now={now}
                    onSelect={onSelect}
                    menu={sessionMenu}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
      <footer className="sidebar-footer">
        <span className="device-avatar" aria-hidden="true">
          <DeviceIcon size={16} strokeWidth={ICON_STROKE} />
        </span>
        <div className="device-meta">
          <span className="device-name-row">
            <strong title={snapshot.device.name}>{snapshot.device.name || '当前设备'}</strong>
            {devMode && <DevModeChip />}
          </span>
          <button type="button" className={`connection-button connection-${connection}`} title="同步最新状态" onClick={onRefresh}>
            <i aria-hidden="true" />
            {connectionLabels[connection]}
          </button>
        </div>
        <IconButton label="设备" icon={MonitorSmartphone} onClick={onDevices} />
        <IconButton label="设置" icon={Settings} onClick={onSettings} />
      </footer>
    </>
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
  onDevices,
  onSettings,
  connection,
  onRefresh,
  devMode = false,
}: {
  approvals: number
  devMode?: boolean
  drawerOpen: boolean
  onSessions: () => void
  onNew: () => void
  onSearch: () => void
  onApprovals: () => void
  onDevices: () => void
  onSettings: () => void
  connection: ConnectionStatus
  onRefresh: () => void
}) {
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
        <IconButton label={`${approvals} 项待批准`} icon={ShieldAlert} badge={approvals} className="is-warn" onClick={onApprovals} />
      )}
      <span className="rail-spacer" />
      {devMode && <DevModeChip compact />}
      <button
        type="button"
        className={`rail-connection connection-${connection}`}
        aria-label={connectionLabels[connection]}
        title={`${connectionLabels[connection]} · 同步最新状态`}
        onClick={onRefresh}>
        <i aria-hidden="true" />
      </button>
      <IconButton label="设备" icon={MonitorSmartphone} onClick={onDevices} />
      <IconButton label="设置" icon={Settings} onClick={onSettings} />
    </>
  )
}
