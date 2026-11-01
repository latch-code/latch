import { NewProjectRow, ProjectGroupHeading, ShelfHead, type ProjectNavigationActions } from './ProjectNavigation.tsx'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Archive, ChevronLeft, Ellipsis, Pin, Plus, Search, SquarePen, X } from 'lucide-react'
import type { AppSnapshot, HarnessInfo, TaskSummary } from '@latch/protocol'
import { BUILTIN_HARNESS_NAME, sessionHarness } from '../composerChoice.ts'
import { currentShell } from '../core/shell.ts'
import { relativeTime } from '../format.ts'
import { useListMotion, usePresence } from '../hooks/useListMotion.ts'
import { projectName } from '../projects.tsx'
import {
  filterSessions,
  groupSessions,
  isOneLine,
  projectOf,
  readFolded,
  shelvesKey,
  rowMeta,
  rowStatus,
  waitsOnYou,
  writeFolded,
  type SessionFilter,
  type SessionGroup,
} from '../sessions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { HarnessTile } from './BrandTile.tsx'
import { Menu, type MenuSection } from './overlays.tsx'
import { SessionStatus, statusLabel, useLastConfirmed } from './SessionStatus.tsx'
import { Collapse, ICON_STROKE, IconButton } from '@latch/ui'

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

/** The harness's name on a row: the built-in one by its product name, one no longer listed by its ID. */
export const harnessLabel = (harness: TaskHarness) => (harness.source === 'builtin' ? BUILTIN_HARNESS_NAME : (harness.name ?? harness.id))

/**
 * The word for what ran a session. Sessions do not record an Agent yet, so every one is 通用; the mark and its tooltip
 * name the engine.
 */
export const SESSION_AGENT = '通用'

const shortcutFor = (key: string) => (currentShell() ? `⌘${key}` : `Alt ${key}`)

const SessionItem = memo(function SessionItem({
  task,
  harness,
  project,
  inWaitingShelf,
  selected,
  unread,
  stopping,
  frozen,
  leaving,
  now,
  onSelect,
  menu,
}: {
  task: TaskSummary
  harness: TaskHarness
  /** Named on the second line in 等你处理, where the shelf no longer says where the session belongs. */
  project: string | undefined
  inWaitingShelf: boolean
  selected: boolean
  unread: boolean
  stopping: boolean
  /** The connection is down: 上次确认 10:42. */
  frozen: string | null
  /** Removed from the list: it folds away and takes no input. */
  leaving: boolean
  now: number
  onSelect: (id: string) => void
  menu: (task: TaskSummary) => MenuSection[]
}) {
  const title = task.title || '未命名会话'
  const time = relativeTime(task.updatedAt, new Date(now))
  const status = rowStatus(task, { unread, stopping, frozen: frozen !== null })
  const oneLine = isOneLine(status)
  const engine = harnessLabel(harness)
  const meta = rowMeta(task, status, inWaitingShelf ? (project ?? '对话') : undefined)
  // While the connection is down the row says less, not that what it last knew stopped mattering.
  const strong =
    status.kind === 'waiting'
    || status.kind === 'silent'
    || status.kind === 'failed'
    || status.kind === 'unread'
    || (status.kind === 'frozen' && waitsOnYou(task))
  const sections = menu(task)
  const archive = task.archived ? undefined : sections.flatMap(section => section.items).find(item => item.id === 'archive')
  const said = statusLabel(status, task.live)
  return (
    <li className="session-entry" data-flip-id={task.id} data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
      <div
        className={`session-item ${selected ? 'is-selected' : ''} ${strong ? 'is-strong' : ''} ${status.kind === 'unread' ? 'is-unread' : ''}`}
        data-lines={oneLine ? 1 : 2}>
        <button
          type="button"
          className="session-item-main"
          data-task-id={leaving ? undefined : task.id}
          aria-current={selected ? 'page' : undefined}
          title={oneLine ? [SESSION_AGENT, engine, task.branch, time].filter(Boolean).join(' · ') : undefined}
          onClick={() => {
            onSelect(task.id)
          }}>
          <span className="session-line">
            {task.pinned && <Pin className="session-pin" size={12} strokeWidth={ICON_STROKE[12]} aria-label="已置顶" />}
            <span className="session-title">{title}</span>
            <SessionStatus
              className="session-status"
              status={status}
              live={task.live}
              inWaitingShelf={inWaitingShelf}
              time={time}
              dateTime={task.updatedAt}
            />
          </span>
          {!oneLine && (
            <span className="session-meta">
              <span className="session-mark" title={engine}>
                <HarnessTile harness={{ id: harness.id, source: harness.source }} size={14} />
              </span>
              <span>{SESSION_AGENT}</span>
              {meta && <span className="session-meta-rest">{`· ${meta}`}</span>}
              {status.kind === 'frozen' && <span className="session-frozen">{frozen}</span>}
            </span>
          )}
          <span className="sr-only">{`，${engine}${said ? `，${said}` : ''}${time ? `，${time}` : ''}`}</span>
        </button>
        <span className="session-actions">
          {archive && (
            <IconButton
              className="session-item-archive"
              size="xs"
              label={`归档：${title}`}
              tooltip="归档"
              icon={Archive}
              onClick={() => archive.onSelect()}
            />
          )}
          <Menu
            label={`会话操作：${title}`}
            placement="bottom-end"
            sections={sections}
            trigger={props => (
              <IconButton
                {...props}
                className="session-item-more"
                size="xs"
                label={`更多操作：${title}`}
                tooltip="更多操作"
                icon={Ellipsis}
              />
            )}
          />
        </span>
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
  frozen,
  folded,
  onFold,
  now,
  onSelect,
  onNewIn,
  onNewChat,
  onCreateProject,
  onEditProject,
  onProjectsChanged,
  menu,
}: ProjectNavigationActions & {
  group: SessionGroup
  snapshot: AppSnapshot
  /** The filter the list shows; rows leave at once when it changes. */
  context: string
  /** Called once rows that left have folded away. */
  settled: () => void
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  frozen: string | null
  folded: boolean
  onFold: () => void
  now: number
  onSelect: (id: string) => void
  onNewIn?: (workspaceId: string) => void
  onNewChat?: () => void
  menu: (task: TaskSummary) => MenuSection[]
}) {
  const rows = usePresence(group.tasks, task => task.id, context, settled)
  const workspaceId = group.workspaceId
  const waiting = group.id === 'waiting'
  const workspaces = snapshot.catalog?.workspaces
  const count = group.tasks.length
  return (
    <section className="session-group" aria-label={group.label} data-shelf={group.id} data-flip-id={`group:${group.id}`} data-flip-scope="">
      {group.project ? (
        <ProjectGroupHeading
          project={group.project}
          folded={folded}
          onFold={onFold}
          count={count}
          onNew={workspaceId && onNewIn ? () => onNewIn(workspaceId) : undefined}
          onCreateProject={onCreateProject}
          onEditProject={onEditProject}
          onProjectsChanged={onProjectsChanged}
        />
      ) : (
        <ShelfHead
          label={group.label}
          folded={folded}
          onFold={onFold}
          count={waiting || folded ? count : undefined}
          actions={
            group.id === 'other' && onNewChat ? (
              <IconButton size="xs" label="新对话" tooltip="新对话" icon={Plus} onClick={onNewChat} />
            ) : undefined
          }
        />
      )}
      <Collapse open={!folded}>
        <ul>
          {rows.map(({ item: task, leaving }) => {
            const project = waiting && workspaces ? projectOf(task, workspaces) : undefined
            return (
              <SessionItem
                key={task.id}
                task={task}
                harness={taskHarness(snapshot, task)}
                project={project && projectName(project)}
                inWaitingShelf={waiting}
                selected={!leaving && task.id === selectedId}
                unread={task.id !== selectedId && isUnread(task)}
                stopping={cancelling.has(task.id)}
                frozen={frozen}
                leaving={leaving}
                now={now}
                onSelect={onSelect}
                menu={menu}
              />
            )
          })}
        </ul>
      </Collapse>
    </section>
  )
}

/** The shelves this device has folded, remembered per device. */
function useFoldedShelves(key: string) {
  const [folded, setFolded] = useState(() => readFolded(key))
  const toggle = useCallback(
    (id: string) => {
      setFolded(previous => {
        const next = new Set(previous)
        if (!next.delete(id)) next.add(id)
        writeFolded(key, next)
        return next
      })
    },
    [key],
  )
  return [folded, toggle] as const
}

/**
 * The session panel: 新会话 and 搜索 (the palette searches), then the shelves 等你处理, each project, 对话 and a quiet
 * 已归档 row. A shelf folds with its chevron; what ended up there stays one click away.
 */
export function Sidebar({
  snapshot,
  archiveBatch,
  archiveUndo,
  selectedId,
  isUnread,
  cancelling,
  filter,
  onFilter,
  onSelect,
  onNew,
  onNewIn,
  onNewChat,
  onSearch,
  onCreateProject,
  onEditProject,
  onProjectsChanged,
  newActive = false,
  drawer,
  onClose,
  connection,
  onRefresh,
  sessionMenu,
  now,
  keepAwake,
}: ProjectNavigationActions & {
  snapshot: AppSnapshot
  archiveBatch?: import('react').ReactNode
  /** The line that offers to take back an archive, while it can. */
  archiveUndo?: import('react').ReactNode
  /** The desktop app is keeping this Mac awake: why, for the title of the line that says so. */
  keepAwake?: string
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  filter: SessionFilter
  onFilter: (filter: SessionFilter) => void
  onSelect: (id: string) => void
  onNew: () => void
  /** Starts a new session in a saved project; absent where this device cannot start one. */
  onNewIn?: (workspaceId: string) => void
  onNewChat?: () => void
  onSearch: () => void
  /** The new-session page is open: 新会话 shows as a toggle that is on. */
  newActive?: boolean
  drawer: boolean
  onClose: () => void
  connection: ConnectionStatus
  onRefresh: () => void
  sessionMenu: (task: TaskSummary) => MenuSection[]
  now: number
}) {
  const list = useRef<HTMLElement>(null)
  const [folded, toggleShelf] = useFoldedShelves(shelvesKey(snapshot.device.id))
  const frozen = useLastConfirmed(connection, snapshot)
  const archived = filter === 'archived'
  const visible = useMemo(() => filterSessions(snapshot.tasks, filter, ''), [snapshot.tasks, filter])
  const projectSections = snapshot.catalog?.projectFolders !== undefined && !archived
  const groups = groupSessions(visible, snapshot.catalog?.workspaces, {
    includeEmpty: projectSections,
    ...(archived ? {} : { waitingFrom: snapshot.tasks }),
  })
  const archivedCount = snapshot.tasks.filter(task => task.archived).length
  const noProjects = !snapshot.catalog?.workspaces.some(item => item.id !== 'default')
  const context = filter
  const signature = groups.map(group => `${group.id}:${folded.has(group.id) ? '' : group.tasks.map(task => task.id).join(',')}`).join('|')
  const remeasure = useListMotion(list, context, signature)
  return (
    <div className="sidebar-body">
      <div className="sidebar-top">
        <div className="sidebar-nav-line">
          <button
            type="button"
            className="sidebar-nav-row"
            aria-label="新建会话"
            aria-pressed={drawer ? undefined : newActive}
            onClick={onNew}>
            <SquarePen size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span>新会话</span>
            {!drawer && <span className="sidebar-shortcut">{shortcutFor('N')}</span>}
          </button>
          {drawer && <IconButton label="关闭会话列表" icon={X} onClick={onClose} />}
        </div>
        <button type="button" className="sidebar-nav-row" aria-label="搜索" onClick={onSearch}>
          <Search size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span>搜索</span>
          {!drawer && <span className="sidebar-shortcut">{/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</span>}
        </button>
      </div>
      {archiveBatch}
      <nav ref={list} className="session-list" aria-label="会话列表" data-session-filter={filter}>
        {archived && (
          <button
            type="button"
            className="archived-back"
            onClick={() => {
              onFilter('all')
            }}>
            <ChevronLeft size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            <span>已归档</span>
            <span className="archived-count">{archivedCount}</span>
          </button>
        )}
        {groups.length === 0 ? (
          <div className="list-empty">
            <p>{snapshot.tasks.length === 0 ? '会话会保存在这里' : archived ? '没有已归档的会话' : '暂无会话'}</p>
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
              frozen={frozen}
              folded={folded.has(group.id)}
              onFold={() => {
                toggleShelf(group.id)
              }}
              now={now}
              onSelect={onSelect}
              onNewIn={onNewIn}
              onNewChat={onNewChat}
              menu={sessionMenu}
              onCreateProject={onCreateProject}
              onEditProject={onEditProject}
              onProjectsChanged={onProjectsChanged}
            />
          ))
        )}
        {projectSections && noProjects && onCreateProject && <NewProjectRow onCreateProject={onCreateProject} />}
        {archivedCount > 0 && !archived && (
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
      {archiveUndo}
      {/* Connection trouble is the rail's dot and the header's words. While the desktop app keeps this Mac awake, a few quiet words say so. */}
      {keepAwake && connection === 'connected' && (
        <footer className="sidebar-footer">
          <button type="button" className="connection-badge connection-connected" title={`${keepAwake} · 同步最新状态`} onClick={onRefresh}>
            {KEEP_AWAKE_LABEL}
          </button>
        </footer>
      )}
    </div>
  )
}
