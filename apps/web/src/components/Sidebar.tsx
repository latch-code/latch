import { sessionsAwaitingReturn } from '../handoffs/model.ts'
import { ProjectGroupHeading, ShelfHead, type ProjectNavigationActions } from './ProjectNavigation.tsx'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import { escapeSecurityText, type AppSnapshot, type HarnessInfo, type TaskSummary } from '@latch/protocol'
import { HARNESS_MARKS, harnessArt, presetOf } from '../brands.ts'
import { sessionHarness } from '../composerChoice.ts'
import { hostView } from '../core/permissions.ts'
import { otherWaiting, useComputers, type OtherWaiting } from '../core/computers.ts'
import { OtherComputersWaiting } from './Computers.tsx'
import { relativeTime } from '../format.ts'
import { useListMotion, usePresence } from '../hooks/useListMotion.ts'
import { projectName } from '../projects.tsx'
import {
  filterSessions,
  groupSessions,
  inSpace,
  projectOf,
  readFolded,
  shelvesKey,
  rowModel,
  rowStatus,
  showsUnread,
  unknownNote,
  waitKind,
  waitsOnYou,
  writeFolded,
  type SessionFilter,
  type SessionGroup,
  type Space,
} from '../sessions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { MarkTile } from './BrandTile.tsx'
import { Menu, type MenuSection } from './overlays.tsx'
import { SessionRowGlyph, SessionStatus, statusLabel, useLastConfirmed, WaitWords } from './SessionStatus.tsx'
import { Collapse, ICON_STROKE, IconButton, ArchiveGlyph, ChevronLeftGlyph, MoreGlyph, PinGlyph, PlusGlyph } from '@latch/ui'
import { originTitle } from '../plugin-pages/model.ts'
import { connectionTrouble, NavFoot, NavTop, NewSessionRow, type SpacesProps } from '../shell/SpaceNav.tsx'

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
  handoffWaits = false,
  from,
}: {
  /** A handoff here waits for its result to be handed back. */
  handoffWaits?: boolean
  /** The plugin page that started it: 「来自 <页面名>」. */
  from?: string | undefined
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
    || showsUnread(status)
    || (status.kind === 'frozen' && waitsOnYou(task))
  const sections = menu(task)
  const archive = task.archived ? undefined : sections.flatMap(section => section.items).find(item => item.id === 'archive')
  const said = statusLabel(status, task.live)
  const worktree = task.worktree
    ? `${task.worktree.removed ? '工作树已移除' : '工作树'} · ${escapeSecurityText(task.branch ?? task.worktree.branch)}`
    : undefined
  const branch = task.branch === undefined ? undefined : escapeSecurityText(task.branch)
  return (
    <li className="session-entry" data-flip-id={task.id} data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
      <div
        className={`session-item ${selected ? 'is-selected' : ''} ${strong ? 'is-strong' : ''} ${showsUnread(status) ? 'is-unread' : ''}`}>
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
            <SessionRowGlyph status={status} />
            {task.pinned && (
              <PinGlyph className="session-pin" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-label="已置顶" />
            )}
            {worktree && (
              <FolderGit2 className="session-worktree" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-label={worktree} />
            )}
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
            {from && <span className="session-meta-rest session-from">{`· 来自 ${from}`}</span>}
            {handoffWaits && <span className="session-handoff">待交回</span>}
            {status.kind === 'frozen' && <span className="session-frozen">{frozen}</span>}
          </span>
          <span className="sr-only">{`，${engine}，${wait?.kind === 'asks' ? wait.words : model}${wait ? `，${project ?? '无项目'}` : ''}${said ? `，${said}` : ''}${note ? `，${note}` : ''}${from ? `，来自 ${from}` : ''}${handoffWaits ? '，待交回' : ''}${status.kind === 'frozen' ? `，${frozen}` : ''}${time ? `，${time}` : ''}`}</span>
        </button>
        <span className="session-actions">
          {archive && (
            <IconButton
              className="session-item-archive"
              size="xs"
              label={`归档：${title}`}
              tooltip="归档"
              icon={ArchiveGlyph}
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
                icon={MoreGlyph}
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
  others = [],
}: ProjectNavigationActions & {
  /** 等你处理 only: what waits on other computers, after this computer's own rows. */
  others?: readonly OtherWaiting[]
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
  const awaiting = sessionsAwaitingReturn(snapshot)
  const workspaceId = group.workspaceId
  const waiting = group.id === 'waiting'
  const workspaces = snapshot.catalog?.workspaces
  const count = group.tasks.length + others.reduce((sum, other) => sum + (other.live ? other.items.length : 0), 0)
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
          count={(waiting && count > 0) || folded ? count : undefined}
          actions={
            group.id === 'other' && onNewWithoutProject ? (
              <IconButton size="xs" label="新会话" tooltip="新会话" icon={PlusGlyph} onClick={onNewWithoutProject} />
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
                handoffWaits={awaiting.has(task.id)}
                from={originTitle(task, snapshot)}
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
        {waiting && <OtherComputersWaiting others={others} now={now} />}
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
 * The whole navigation of a wide window. At the top: the computer's name where the page is not the Latch app on that
 * computer, the switch between Code and 我的 Agent (where the Host has it), the place's primary and 搜索 (the palette
 * searches). Code lists its shelves: 等你处理, each project, 无项目 and a quiet 已归档 row, without the sessions delegated to
 * an Agent; 我的 Agent lists your Agents and their recent delegations. At the foot, shared: 添加项目 (on this Mac, in Code),
 * 应用 and 设置. A shelf folds with its chevron; what ended up there stays one click away.
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
  onSettings,
  hostProblem,
  newActive = false,
  drawer,
  onClose,
  connection,
  onRefresh,
  sessionMenu,
  now,
  keepAwake,
  apps,
  onManageComputers,
  spaces,
  agents,
  overview,
  onSchedules,
  computer,
  projectTree = false,
}: ProjectNavigationActions & {
  /** Opens 设置 › 电脑 (the computer menu's 管理电脑…). */
  onManageComputers?: () => void
  /** 应用 at the foot, where plugin pages are applied. */
  apps?: { current: boolean; onOpen: () => void } | undefined
  /** The two places, where the Host has 我的 Agent; without it there is only Code and no switch. */
  spaces?: SpacesProps | undefined
  /** 我的 Agent's primary (委托…) and list, drawn in its place. */
  agents?: { primary: import('react').ReactNode; list: import('react').ReactNode } | undefined
  overview?: { active: boolean; open: () => void }
  onSchedules?: () => void
  computer?: import('react').ReactNode
  projectTree?: boolean
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
  /** 设置, where this device can open it. */
  onSettings?: (() => void) | undefined
  hostProblem: { text: string } | null
}) {
  const inAgents = spaces?.space === 'agents' && agents !== undefined
  return (
    <div className="sidebar-body" data-space={spaces?.space ?? 'code'}>
      <NavTop
        snapshot={snapshot}
        spaces={spaces}
        primary={inAgents ? agents.primary : <NewSessionRow onNew={onNew} active={newActive} drawer={drawer} />}
        onSearch={onSearch}
        drawer={drawer}
        onClose={onClose}
        onManageComputers={onManageComputers}
        overview={overview}
        onSchedules={onSchedules}
        computerAtFoot={computer !== undefined}
      />
      {inAgents ? (
        agents.list
      ) : (
        <>
          {archiveBatch}
          <CodeList
            projectTree={projectTree}
            snapshot={snapshot}
            selectedId={selectedId}
            isUnread={isUnread}
            cancelling={cancelling}
            filter={filter}
            onFilter={onFilter}
            onSelect={onSelect}
            onNewIn={onNewIn}
            onNewWithoutProject={onNewWithoutProject}
            onEditProject={onEditProject}
            onProjectsChanged={onProjectsChanged}
            connection={connection}
            sessionMenu={sessionMenu}
            now={now}
            space={spaces ? 'code' : undefined}
          />
          {archiveUndo}
        </>
      )}
      {/* While the desktop app keeps this Mac awake, a few quiet words say so. */}
      {keepAwake && connection === 'connected' && (
        <div className="sidebar-footer">
          <button type="button" className="connection-badge connection-connected" title={`${keepAwake} · 同步最新状态`} onClick={onRefresh}>
            {KEEP_AWAKE_LABEL}
          </button>
        </div>
      )}
      {computer && <div className="sidebar-work-computer">{computer}</div>}
      <NavFoot
        apps={apps}
        settings={onSettings}
        trouble={connectionTrouble(connection, hostProblem)}
        onCreateProject={inAgents ? undefined : onCreateProject}
      />
    </div>
  )
}

/** Code's list: its shelves, without the sessions delegated to an Agent where the Host has 我的 Agent. */
function CodeList({
  snapshot,
  selectedId,
  isUnread,
  cancelling,
  filter,
  onFilter,
  onSelect,
  onNewIn,
  onNewWithoutProject,
  onEditProject,
  onProjectsChanged,
  connection,
  sessionMenu,
  now,
  space,
  projectTree,
}: ProjectNavigationActions & {
  snapshot: AppSnapshot
  selectedId: string | null
  isUnread: (task: TaskSummary) => boolean
  cancelling: ReadonlySet<string>
  filter: SessionFilter
  onFilter: (filter: SessionFilter) => void
  onSelect: (id: string) => void
  onNewIn?: ((workspaceId: string) => void) | undefined
  onNewWithoutProject?: (() => void) | undefined
  connection: ConnectionStatus
  sessionMenu: (task: TaskSummary) => MenuSection[]
  now: number
  space: Space | undefined
  projectTree: boolean
}) {
  const list = useRef<HTMLElement>(null)
  const [folded, toggleShelf] = useFoldedShelves(shelvesKey(snapshot.device.id))
  const frozen = useLastConfirmed(connection, snapshot)
  const archived = filter === 'archived'
  const own = useMemo(() => inSpace(snapshot.tasks, space), [snapshot.tasks, space])
  const visible = useMemo(() => filterSessions(snapshot.tasks, filter, '', space), [snapshot.tasks, filter, space])
  const projectSections = snapshot.catalog?.projectFolders !== undefined && !archived
  const computers = useComputers()
  // Only this Mac's page holds what waits on other computers (main gives it to no other page).
  const others = archived ? [] : otherWaiting(computers, hostView(snapshot)?.hostId)
  const grouped = groupSessions(visible, snapshot.catalog?.workspaces, {
    includeEmpty: projectSections,
    ...(archived || projectTree ? {} : { waitingFrom: own }),
  })
  const groups: SessionGroup[] =
    others.length > 0 && grouped[0]?.id !== 'waiting' ? [{ id: 'waiting', label: '等你处理', tasks: [] }, ...grouped] : grouped
  const archivedCount = own.filter(task => task.archived).length
  const context = filter
  const signature =
    groups.map(group => `${group.id}:${folded.has(group.id) ? '' : group.tasks.map(task => task.id).join(',')}`).join('|')
    + others
      .map(other => `|${other.computer.hostId}:${other.live ? other.items.map(item => item.taskId).join(',') : other.items.length}`)
      .join('')
  const remeasure = useListMotion(list, context, signature)
  return (
    <nav ref={list} className="session-list" aria-label="会话列表" data-session-filter={filter}>
      {archived && (
        <button
          type="button"
          className="archived-back"
          onClick={() => {
            onFilter('all')
          }}>
          <ChevronLeftGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <span>已归档</span>
          <span className="archived-count">{archivedCount}</span>
        </button>
      )}
      {groups.length === 0 ? (
        <div className="list-empty">
          <p>{own.length === 0 ? '会话会保存在这里' : archived ? '没有已归档的会话' : '暂无会话'}</p>
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
            {...(group.id === 'waiting' ? { others } : {})}
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
            <ArchiveGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </span>
          <span>已归档</span>
          <span className="archived-count">{archivedCount}</span>
        </button>
      )}
    </nav>
  )
}
