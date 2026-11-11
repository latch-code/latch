import { ProjectGroupHeading, ShelfHead, type ProjectNavigationActions } from './ProjectNavigation.tsx'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Archive, ChevronLeft, Ellipsis, FolderGit2, FolderPlus, Pin, Plus, Search, Settings, Smartphone, SquarePen, X } from 'lucide-react'
import { escapeSecurityText, type AppSnapshot, type HarnessInfo, type TaskSummary } from '@latch/protocol'
import { HARNESS_MARKS, harnessArt, presetOf } from '../brands.ts'
import { sessionHarness } from '../composerChoice.ts'
import { currentShell } from '../core/shell.ts'
import { relativeTime } from '../format.ts'
import { useListMotion, usePresence } from '../hooks/useListMotion.ts'
import { projectName } from '../projects.tsx'
import {
  filterSessions,
  groupSessions,
  projectOf,
  readFolded,
  shelvesKey,
  rowModel,
  rowStatus,
  unknownNote,
  waitKind,
  waitsOnYou,
  writeFolded,
  type SessionFilter,
  type SessionGroup,
} from '../sessions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { MarkTile } from './BrandTile.tsx'
import { Menu, type MenuSection } from './overlays.tsx'
import { SessionStatus, statusLabel, useLastConfirmed, WaitWords } from './SessionStatus.tsx'
import { Collapse, ICON_STROKE, IconButton } from '@latch/ui'
import type { ShellEntry } from '../shell/routes.ts'

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
 * The harness a session runs on, for its row: the catalog's facts, or, for one no longer listed (a removed agent), its ID
 * and the icon of the preset that ID was made from. A row describes the session, not the agent's state now, so its tile
 * never draws whether the harness is currently usable.
 */
export interface TaskHarness {
  id: string
  label: string
  mark?: string | undefined
}
export function taskHarness(snapshot: AppSnapshot, task: TaskSummary): TaskHarness {
  const known = sessionHarness(snapshot.catalog, task)
  return known
    ? { id: known.id, label: known.capabilities.display.label, mark: known.capabilities.display.mark }
    : { id: task.harnessId, label: task.harnessId, mark: presetOf(task.harnessId, HARNESS_MARKS) }
}

const shortcutFor = (key: string) => (currentShell() ? `⌘${key}` : `Alt ${key}`)

/** Something wrong with reaching the Mac: the sentence for the dot beside 手机, and how bad it is. A healthy state has none. */
function connectionTrouble(
  connection: ConnectionStatus,
  hostProblem: { text: string } | null,
): { tone: 'warn' | 'error'; text: string } | null {
  if (connection === 'offline') return { tone: 'warn', text: '这台设备已离线' }
  if (hostProblem) return { tone: 'error', text: hostProblem.text }
  if (connection === 'reconnecting') return { tone: 'warn', text: '正在重新连接' }
  return null
}

/**
 * A session row, always two lines: the title with the time or what the run is doing, then the Harness's 12px mark and
 * the model (the Harness's name too where its mark is the neutral glyph). In 等你处理 the second line says what waits
 * instead of the model, and the project, since the shelf no longer says where the session belongs.
 */
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
  const engine = harness.label
  const named = harnessArt(harness.mark).kind === 'glyph'
  const model = rowModel(task)
  const wait = inWaitingShelf && (status.kind === 'waiting' || status.kind === 'silent') ? waitKind(task) : undefined
  const note = unknownNote(task, status)
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
  const worktree = task.worktree ? `工作树 · ${escapeSecurityText(task.branch ?? task.worktree.branch)}` : undefined
  const branch = task.branch === undefined ? undefined : escapeSecurityText(task.branch)
  return (
    <li className="session-entry" data-flip-id={task.id} data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
      <div
        className={`session-item ${selected ? 'is-selected' : ''} ${strong ? 'is-strong' : ''} ${status.kind === 'unread' ? 'is-unread' : ''}`}>
        <button
          type="button"
          className="session-item-main"
          data-task-id={leaving ? undefined : task.id}
          aria-current={selected ? 'page' : undefined}
          title={[engine, model, worktree ?? branch].filter(Boolean).join(' · ')}
          onClick={() => {
            onSelect(task.id)
          }}>
          <span className="session-line">
            {task.pinned && <Pin className="session-pin" size={12} strokeWidth={ICON_STROKE[12]} aria-label="已置顶" />}
            {worktree && <FolderGit2 className="session-worktree" size={12} strokeWidth={ICON_STROKE[12]} aria-label={worktree} />}
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
          <span className="session-meta" aria-hidden="true">
            <span className="session-mark">
              <MarkTile mark={harness.mark} size={14} />
            </span>
            {wait ? (
              <span className="session-wait">
                <WaitWords wait={wait} live={task.live} />
              </span>
            ) : (
              <span className="session-model" data-default={task.modelRoute?.model || task.model ? undefined : ''}>
                {model}
              </span>
            )}
            {named && <span className="session-harness">{engine}</span>}
            {wait && <span className="session-meta-rest">{`· ${project ?? '无项目'}`}</span>}
            {note && <span className="session-meta-rest">{`· ${note}`}</span>}
            {status.kind === 'frozen' && <span className="session-frozen">{frozen}</span>}
          </span>
          <span className="sr-only">{`，${engine}，${wait?.kind === 'asks' ? wait.words : model}${said ? `，${said}` : ''}${note ? `，${note}` : ''}${time ? `，${time}` : ''}`}</span>
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
  onNewWithoutProject,
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
  onNewWithoutProject?: () => void
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
            group.id === 'other' && onNewWithoutProject ? (
              <IconButton size="xs" label="新会话" tooltip="新会话" icon={Plus} onClick={onNewWithoutProject} />
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
 * The whole navigation of a wide window: 新会话 and 搜索 (the palette searches); the shelves
 * 等你处理, each project, 无项目 and a quiet 已归档 row; at the foot 添加项目, 手机 and 设置. A shelf folds with its chevron;
 * what ended up there stays one click away.
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
  onNewWithoutProject,
  onSearch,
  onCreateProject,
  onEditProject,
  onProjectsChanged,
  entries,
  onEntry,
  hostProblem,
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
  onNewWithoutProject?: () => void
  onSearch: () => void
  /** The new-session page is open: 新会话 shows as a toggle that is on. */
  newActive?: boolean
  drawer: boolean
  onClose: () => void
  connection: ConnectionStatus
  onRefresh: () => void
  sessionMenu: (task: TaskSummary) => MenuSection[]
  now: number
  onCreateProject?: () => void
  entries: readonly ShellEntry[]
  onEntry: (entry: ShellEntry) => void
  hostProblem: { text: string } | null
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
  const trouble = connectionTrouble(connection, hostProblem)
  const desktop = currentShell() !== null
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
              onNewWithoutProject={onNewWithoutProject}
              menu={sessionMenu}
              onEditProject={onEditProject}
              onProjectsChanged={onProjectsChanged}
            />
          ))
        )}
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
      {/* While the desktop app keeps this Mac awake, a few quiet words say so. */}
      {keepAwake && connection === 'connected' && (
        <div className="sidebar-footer">
          <button type="button" className="connection-badge connection-connected" title={`${keepAwake} · 同步最新状态`} onClick={onRefresh}>
            {KEEP_AWAKE_LABEL}
          </button>
        </div>
      )}
      <nav className="sidebar-foot" aria-label="主导航">
        {onCreateProject && (
          <button type="button" className="sidebar-add-project" onClick={onCreateProject}>
            <FolderPlus size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span>添加项目</span>
          </button>
        )}
        <span className="sidebar-foot-spacer" />
        {trouble && (
          <span className="sidebar-trouble" data-tone={trouble.tone} role="status" title={trouble.text}>
            <span className="sr-only">{trouble.text}</span>
          </span>
        )}
        {entries.includes('phone') && (
          <IconButton
            label="手机"
            icon={Smartphone}
            onClick={() => {
              onEntry('phone')
            }}
          />
        )}
        {entries.includes('settings') && (
          <IconButton
            label="设置"
            icon={Settings}
            shortcut={desktop ? '⌘,' : 'Alt ,'}
            onClick={() => {
              onEntry('settings')
            }}
          />
        )}
      </nav>
    </div>
  )
}
