import { sessionsAwaitingReturn } from '../handoffs/model.ts'
import { isPersonalChat } from '../agents/chat.ts'
import { ProjectGroupHeading, ShelfHead, type ProjectNavigationActions } from './ProjectNavigation.tsx'
import { Fragment, memo, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { Coffee, FolderGit2 } from 'lucide-react'
import { escapeSecurityText, type AppSnapshot, type HarnessInfo, type TaskSummary } from '@latch/protocol'
import { HARNESS_MARKS, harnessArt, presetOf } from '../brands.ts'
import { harnessName, sessionHarness } from '../composerChoice.ts'
import { defineCopy, useLocale } from '../core/i18n.ts'
import { hostView } from '../core/permissions.ts'
import { otherComputerLists, otherWaiting, useComputers, type OtherWaiting } from '../core/computers.ts'
import { OtherComputersSessions, OtherComputersWaiting } from './Computers.tsx'
import { relativeTime } from '../format.ts'
import { useListMotion, usePresence } from '../hooks/useListMotion.ts'
import { projectName } from '../projects.tsx'
import {
  filterSessions,
  groupSessions,
  inSpace,
  projectOf,
  shelvesKey,
  rowGateway,
  rowModel,
  rowStatus,
  showsUnread,
  unknownNote,
  waitWords,
  waitsOnYou,
  foldMembers,
  teamFoldKey,
  type SessionFilter,
  type SessionGroup,
  type Space,
} from '../sessions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import type { ComputersView } from '../core/shell.ts'
import { MarkTile } from './BrandTile.tsx'
import { TeamFold, useFoldedShelves } from './TeamFold.tsx'
import { Menu, rowOf, type MenuSection } from './overlays.tsx'
import { SessionRowGlyph, SessionStatus, statusLabel, useLastConfirmed } from './SessionStatus.tsx'
import {
  Collapse,
  ICON_STROKE,
  Icon,
  IconButton,
  Tooltip,
  ArchiveGlyph,
  ChevronLeftGlyph,
  MoreGlyph,
  PinGlyph,
  PlusGlyph,
  UnpinGlyph,
} from '@latch/ui'
import { originTitle } from '../plugin-pages/model.ts'
import { connectionTrouble, NavFoot, NavTop, NewSessionRow, type SpacesProps } from '../shell/SpaceNav.tsx'
import { SESSION_LIST_COPY as COPY } from './sessionList.copy.ts'

export const connectionLabels = defineCopy<Record<ConnectionStatus, string>>(
  { connected: '已连接', connecting: '同步中', reconnecting: '重新连接中', offline: '离线' },
  { connected: 'Connected', connecting: 'Syncing', reconnecting: 'Reconnecting', offline: 'Offline' },
)

/** What the glyph beside the computer's name says while the desktop app keeps this Mac awake. */
const SIDEBAR_COPY = defineCopy({ keepingAwake: '保持唤醒中' }, { keepingAwake: 'Keeping awake' })

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
    ? { id: known.id, label: harnessName(known), mark: known.capabilities.display.mark }
    : { id: task.harnessId, label: task.harnessId, mark: task.harnessId ? presetOf(task.harnessId, HARNESS_MARKS) : undefined }
}

/**
 * A session row: the Harness's icon with the row's state on its corner, then the title. The hover names the Harness,
 * the model the session runs on now where one was reported, and the gateway where the model goes through it. Where the
 * row has a second line (the other computers' rows), it carries what waits and the project in 等你处理.
 */
const SessionItem = memo(function SessionItem({
  task,
  harnessLabel,
  harnessMark,
  project,
  inWaitingShelf,
  inPinnedShelf = false,
  selected,
  unread,
  stopping,
  frozen,
  leaving,
  now,
  onSelect,
  menu,
  onPin,
  onArchive,
  clearing,
  handoffWaits = false,
  from,
  member = false,
  memberCount,
  membersFolded = false,
  onFoldMembers,
}: {
  /** A member of the team of the session above it: drawn one step in, on a thin line down from that session. */
  member?: boolean
  /** How many members sit under this session, whether they are folded away, and the way to fold them. */
  memberCount?: number | undefined
  membersFolded?: boolean | undefined
  onFoldMembers?: ((leadId: string) => void) | undefined
  /** A handoff here waits for its result to be handed back. */
  handoffWaits?: boolean
  /** The plugin page that started it: 「来自 <页面名>」. */
  from?: string | undefined
  task: TaskSummary
  harnessLabel: string
  harnessMark?: string | undefined
  /** Named on the second line in 等你处理, where the shelf no longer says where the session belongs. */
  project: string | undefined
  inWaitingShelf: boolean
  /** Drawn inside the 置顶 shelf above 项目, where the shelf itself says it is pinned. */
  inPinnedShelf?: boolean
  selected: boolean
  unread: boolean
  stopping: boolean
  /** The connection is down: 上次确认 10:42. */
  frozen: string | null
  /** Removed from the list: it folds away and takes no input. */
  leaving: boolean
  now: number
  onSelect: (id: string) => void
  menu: (task: TaskSummary, clearing?: boolean) => MenuSection[]
  onPin?: ((task: TaskSummary) => void) | undefined
  onArchive?: ((task: TaskSummary) => void) | undefined
  clearing?: boolean | undefined
}) {
  useLocale()
  const title = task.title || COPY.untitled
  const time = relativeTime(task.updatedAt, new Date(now))
  const status = rowStatus(task, { unread, stopping, frozen: frozen !== null })
  const engine = harnessLabel
  const named = harnessArt(harnessMark).kind === 'glyph'
  const model = rowModel(task)
  const gateway = model !== undefined && rowGateway(task)
  const wait = inWaitingShelf && status.kind === 'waiting' ? waitWords(task) : undefined
  const note = unknownNote(task, status)
  // While the connection is down the row says less, not that what it last knew stopped mattering.
  const strong =
    handoffWaits
    || status.kind === 'waiting'
    || status.kind === 'failed'
    || showsUnread(status)
    || (status.kind === 'frozen' && waitsOnYou(task))
  const said = statusLabel(status, task.live)
  const worktree = task.worktree
    ? `${task.worktree.removed ? COPY.worktreeRemoved : COPY.worktree} · ${escapeSecurityText(task.branch ?? task.worktree.branch)}`
    : undefined
  const branch = task.branch === undefined ? undefined : escapeSecurityText(task.branch)
  const details = [
    engine,
    wait ?? model,
    wait && (project ?? COPY.noProject),
    said,
    note,
    from && COPY.fromPage(from),
    handoffWaits && COPY.returnPending,
    status.kind === 'frozen' && frozen,
    time,
  ]
    .filter(Boolean)
    .map(word => COPY.detailSeparator + word)
    .join('')
  return (
    <li
      className="session-entry"
      data-team-member={member ? '' : undefined}
      data-flip-id={task.id}
      data-leaving={leaving ? '' : undefined}
      inert={leaving || undefined}>
      <div
        className={`session-item ${selected ? 'is-selected' : ''} ${strong ? 'is-strong' : ''} ${showsUnread(status) ? 'is-unread' : ''}`}>
        <Tooltip
          content={[title, engine, model, gateway && COPY.gatewayRoute, inPinnedShelf && project, worktree ?? branch]
            .filter(Boolean)
            .join(' · ')}
          describe={false}>
          <button
            type="button"
            className="session-item-main"
            data-task-id={leaving ? undefined : task.id}
            aria-current={selected ? 'page' : undefined}
            onClick={() => {
              onSelect(task.id)
            }}>
            <span className="session-line">
              <SessionRowGlyph status={status} mark={harnessMark} />
              {task.pinned && !inPinnedShelf && (
                <PinGlyph className="session-pin" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-label={COPY.pinned} />
              )}
              {worktree && (
                <FolderGit2 className="session-worktree" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-label={worktree} />
              )}
              <span className="session-title">{title}</span>
              {handoffWaits && (
                <span className="session-handoff" aria-hidden="true">
                  {COPY.returnPending}
                </span>
              )}
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
                <MarkTile mark={harnessMark} size={14} />
              </span>
              {wait ? <span className="session-wait">{wait}</span> : model !== undefined && <span className="session-model">{model}</span>}
              {named && <span className="session-harness">{engine}</span>}
              {wait && <span className="session-meta-rest">{`· ${project ?? COPY.noProject}`}</span>}
              {note && <span className="session-meta-rest">{`· ${note}`}</span>}
              {from && <span className="session-meta-rest session-from">{`· ${COPY.fromPage(from)}`}</span>}
              {status.kind === 'frozen' && <span className="session-frozen">{frozen}</span>}
            </span>
            <span className="sr-only">{details}</span>
          </button>
        </Tooltip>
        {memberCount !== undefined && onFoldMembers && (
          <TeamFold
            count={memberCount}
            folded={membersFolded}
            onToggle={() => {
              onFoldMembers(task.id)
            }}
          />
        )}
        <span className="session-actions">
          {onPin && !task.archived && (
            <IconButton
              className="session-item-pin"
              size="xs"
              label={task.pinned ? COPY.unpinSession(title) : COPY.pinSession(title)}
              tooltip={task.pinned ? COPY.unpin : COPY.pin}
              icon={task.pinned ? UnpinGlyph : PinGlyph}
              onClick={() => onPin(task)}
            />
          )}
          {onArchive && !task.archived && (
            <IconButton
              className="session-item-archive"
              size="xs"
              label={COPY.archiveSession(title)}
              tooltip={COPY.archive}
              icon={ArchiveGlyph}
              onClick={() => onArchive(task)}
            />
          )}
          <Menu
            label={COPY.actionsFor(title)}
            placement="bottom-end"
            context={rowOf('.session-item')}
            sections={() => menu(task, clearing)}
            frosted
            trigger={props => (
              <IconButton
                {...props}
                className="session-item-more"
                size="xs"
                label={COPY.moreFor(title)}
                tooltip={COPY.more}
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
  awaiting,
  context,
  settled,
  selectedId,
  isUnread,
  cancelling,
  frozen,
  folded,
  onFold,
  foldedSet,
  onFoldMembers,
  now,
  onSelect,
  onNewIn,
  onNewWithoutProject,
  onEditProject,
  menu,
  onPin,
  onArchive,
  clearing,
  others = [],
}: ProjectNavigationActions & {
  /** 等你处理 only: what waits on other computers, after this computer's own rows. */
  others?: readonly OtherWaiting[]
  group: SessionGroup
  snapshot: AppSnapshot
  awaiting: ReadonlySet<string>
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
  /** The shelves and the sessions whose members this device has folded, and the way to fold a session's members. */
  foldedSet: ReadonlySet<string>
  onFoldMembers: (leadId: string) => void
  now: number
  onSelect: (id: string) => void
  onNewIn?: (workspaceId: string) => void
  onNewWithoutProject?: () => void
  menu: (task: TaskSummary, clearing?: boolean) => MenuSection[]
  onPin?: ((task: TaskSummary) => void) | undefined
  onArchive?: ((task: TaskSummary) => void) | undefined
  clearing?: boolean | undefined
}) {
  const shown = useMemo(() => foldMembers(group.tasks, group.members, foldedSet), [group.tasks, group.members, foldedSet])
  const rows = usePresence(shown.tasks, task => task.id, context, settled)
  const workspaceId = group.workspaceId
  const waiting = group.id === 'waiting'
  const pinned = group.id === 'pinned'
  const workspaces = snapshot.catalog?.workspaces
  const manageable = snapshot.catalog !== undefined
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
        />
      ) : (
        <ShelfHead
          label={group.label}
          folded={folded}
          onFold={onFold}
          count={(waiting && count > 0) || folded ? count : undefined}
          actions={
            group.id === 'other' && onNewWithoutProject ? (
              <IconButton size="xs" label={COPY.newShort} tooltip={COPY.newShort} icon={PlusGlyph} onClick={onNewWithoutProject} />
            ) : undefined
          }
        />
      )}
      <Collapse open={!folded}>
        <ul>
          {rows.map(({ item: task, leaving }) => {
            const project = (waiting || pinned) && workspaces ? projectOf(task, workspaces) : undefined
            const harness = taskHarness(snapshot, task)
            const memberCount = shown.counts.get(task.id)
            const selected = !leaving && task.id === selectedId
            return (
              <SessionItem
                member={group.members?.has(task.id) === true}
                memberCount={memberCount}
                membersFolded={memberCount !== undefined ? foldedSet.has(teamFoldKey(task.id)) : false}
                onFoldMembers={memberCount !== undefined ? onFoldMembers : undefined}
                handoffWaits={awaiting.has(task.id)}
                from={originTitle(task, snapshot)}
                key={task.id}
                task={task}
                harnessLabel={harness.label}
                harnessMark={harness.mark}
                project={project && projectName(project)}
                inWaitingShelf={waiting}
                inPinnedShelf={pinned}
                selected={selected}
                unread={task.id !== selectedId && isUnread(task)}
                stopping={cancelling.has(task.id)}
                frozen={frozen}
                leaving={leaving}
                now={now}
                onSelect={onSelect}
                menu={menu}
                onPin={manageable ? onPin : undefined}
                onArchive={manageable && !isPersonalChat(snapshot, task) ? onArchive : undefined}
                clearing={selected ? clearing : undefined}
              />
            )
          })}
        </ul>
        {waiting && <OtherComputersWaiting others={others} now={now} />}
      </Collapse>
    </section>
  )
}

/**
 * The whole navigation of a wide window. At the top: the computer's name where the page is not the Latch app on that
 * computer, the switch between Code and 我的 Agent (where the Host has it), the place's primary and 搜索 (the palette
 * searches). Code lists its shelves: 等你处理, each project, 无项目 and a quiet 已归档 row, without the sessions delegated to
 * an Agent; 我的 Agent lists your Agents and their recent delegations. 「项目」 heads the projects with a + that adds one (on
 * this Mac). At the foot, shared: one row of icons (`NavFoot`). A shelf folds with its chevron; what ended up there stays one click away.
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
  onSettings,
  hostProblem,
  newActive = false,
  drawer,
  onClose,
  connection,
  sessionMenu,
  onPinSession,
  onArchiveSession,
  clearing,
  now,
  keepAwake,
  apps,
  computerChip,
  spaces,
  agents,
  overview,
  onSchedules,
  onMarketplace,
  marketplaceActive,
  quota,
  update,
  computerAtFoot = false,
  projectTree = false,
}: ProjectNavigationActions & {
  /** The computer popover in the sidebar's head (`NavTop`'s `computer`). */
  computerChip?: ((computers: ComputersView | undefined) => ReactNode) | undefined
  /** 应用 at the foot, where plugin pages are applied. */
  apps?: { current: boolean; onOpen: () => void } | undefined
  /** The two places, where the Host has 我的 Agent; without it there is only Code and no switch. */
  spaces?: SpacesProps | undefined
  /** 我的 Agent's primary (委托…) and list, drawn in its place. */
  agents?: { primary: import('react').ReactNode; list: import('react').ReactNode } | undefined
  overview?: { active: boolean; open: () => void }
  onSchedules?: () => void
  onMarketplace?: (() => void) | undefined
  marketplaceActive?: boolean | undefined
  /** 额度与用量 in the foot's row, where this window shows it there. */
  quota?: import('react').ReactNode
  /** 检查更新 at the right end of the foot's row. */
  update?: import('react').ReactNode
  /** The status bar names the computer, so the head does not. */
  computerAtFoot?: boolean
  projectTree?: boolean
  snapshot: AppSnapshot
  archiveBatch?: import('react').ReactNode
  /** The line that offers to take back an archive, while it can. */
  archiveUndo?: import('react').ReactNode
  /** The desktop app is keeping this Mac awake: why, for the hover of the glyph beside the computer's name. */
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
  sessionMenu: (task: TaskSummary, clearing?: boolean) => MenuSection[]
  onPinSession?: ((task: TaskSummary) => void) | undefined
  onArchiveSession?: ((task: TaskSummary) => void) | undefined
  clearing?: boolean | undefined
  now: number
  onCreateProject?: () => void
  /** 设置, where this device can open it. */
  onSettings?: (() => void) | undefined
  hostProblem: { text: string } | null
}) {
  const inAgents = spaces?.space === 'agents' && agents !== undefined
  const awake = keepAwake !== undefined && keepAwake !== '' && connection === 'connected'
  return (
    <div className="sidebar-body" data-space={spaces?.space ?? 'code'}>
      <NavTop
        snapshot={snapshot}
        spaces={spaces}
        primary={inAgents ? agents.primary : <NewSessionRow onNew={onNew} active={newActive} drawer={drawer} />}
        onSearch={onSearch}
        drawer={drawer}
        onClose={onClose}
        computer={computerChip}
        overview={overview}
        onSchedules={onSchedules}
        onMarketplace={onMarketplace}
        marketplaceActive={marketplaceActive}
        computerAtFoot={computerAtFoot}
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
            onCreateProject={onCreateProject}
            connection={connection}
            sessionMenu={sessionMenu}
            onPinSession={onPinSession}
            onArchiveSession={onArchiveSession}
            clearing={clearing}
            now={now}
            space={spaces ? 'code' : undefined}
          />
          {archiveUndo}
        </>
      )}
      <NavFoot
        apps={apps}
        quota={quota}
        settings={onSettings}
        trouble={connectionTrouble(connection, hostProblem)}
        update={update}
        // While the desktop app keeps this Mac awake, a small glyph in the row says so on hover.
        awake={
          awake && (
            <Tooltip content={keepAwake}>
              <span className="sidebar-awake" tabIndex={0} role="img" aria-label={SIDEBAR_COPY.keepingAwake}>
                <Icon icon={Coffee} size={14} />
              </span>
            </Tooltip>
          )
        }
      />
    </div>
  )
}

const SHELF_BODY = '.session-group > .ui-collapse'
const shelfLayoutMoving = (list: HTMLElement) =>
  list.querySelector(`${SHELF_BODY}:is([data-state='closing'], [data-state='open']:not([data-settled]))`) !== null

/** Code's list: its shelves, without the sessions delegated to an Agent where the Host has 我的 Agent. */
const CodeList = memo(function CodeList({
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
  onCreateProject,
  connection,
  sessionMenu,
  onPinSession,
  onArchiveSession,
  clearing,
  now,
  space,
  projectTree,
}: ProjectNavigationActions & {
  /** Adds a project: the + at the right of 「项目」, where this device can. */
  onCreateProject?: (() => void) | undefined
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
  sessionMenu: (task: TaskSummary, clearing?: boolean) => MenuSection[]
  onPinSession?: ((task: TaskSummary) => void) | undefined
  onArchiveSession?: ((task: TaskSummary) => void) | undefined
  clearing?: boolean | undefined
  now: number
  space: Space | undefined
  projectTree: boolean
}) {
  const list = useRef<HTMLElement>(null)
  const [folded, toggleShelf] = useFoldedShelves(shelvesKey(snapshot.device.id))
  const foldTeamMembers = useCallback(
    (leadId: string) => {
      toggleShelf(teamFoldKey(leadId))
    },
    [toggleShelf],
  )
  const frozen = useLastConfirmed(connection, snapshot)
  const locale = useLocale()
  const archived = filter === 'archived'
  const own = useMemo(() => inSpace(snapshot.tasks, space), [snapshot.tasks, space])
  const visible = useMemo(() => filterSessions(snapshot.tasks, filter, '', space), [snapshot.tasks, filter, space])
  const awaiting = useMemo(() => sessionsAwaitingReturn(snapshot), [snapshot.handoffs, snapshot.tasks])
  const projectSections = snapshot.catalog?.projectFolders !== undefined && !archived
  const computers = useComputers()
  // Only this Mac's page holds what waits on other computers (main gives it to no other page).
  const others = archived ? [] : otherWaiting(computers, hostView(snapshot)?.hostId)
  // The unified list's other computers (O2): only this Mac's page holds their sessions, in the Code space.
  const elsewhere =
    archived || space === 'agents'
      ? []
      : otherComputerLists(computers, hostView(snapshot)?.hostId).filter(list => list.count > 0 || !list.live)
  const grouped = useMemo(
    () =>
      groupSessions(visible, snapshot.catalog?.workspaces, {
        includeEmpty: projectSections,
        teams: snapshot.teams,
        ...(archived ? {} : { pinnedShelf: true }),
        ...(archived || projectTree ? {} : { waitingFrom: own }),
      }),
    [visible, snapshot.catalog?.workspaces, projectSections, snapshot.teams, archived, projectTree, own, locale],
  )
  const groups: SessionGroup[] =
    others.length > 0 && grouped[0]?.id !== 'waiting' ? [{ id: 'waiting', label: COPY.waiting, tasks: [] }, ...grouped] : grouped
  const archivedCount = useMemo(() => own.filter(task => task.archived).length, [own])
  const context = filter
  const signature =
    groups.map(group => `${group.id}:${folded.has(group.id) ? '' : group.tasks.map(task => task.id).join(',')}`).join('|')
    + others
      .map(other => `|${other.computer.hostId}:${other.live ? other.items.map(item => item.taskId).join(',') : other.items.length}`)
      .join('')
    + elsewhere.map(other => `|${other.hostId}:${folded.has(`computer:${other.hostId}`) ? '' : other.count}`).join('')
  // Collapse already moves the shelves in layout. Refresh the list's positions once the height transition ends.
  const remeasure = useListMotion(list, context, signature, shelfLayoutMoving)
  // 「项目」 heads the projects (and 无项目), after 等你处理 and 置顶; its + adds one.
  const headAt = groups.findIndex(group => group.id !== 'waiting' && group.id !== 'pinned')
  const projectsHead = !archived && (
    <div className="sidebar-group-label">
      <span>{COPY.projects}</span>
      {onCreateProject && (
        <IconButton size="xs" label={COPY.addProject} tooltip={COPY.addProject} icon={PlusGlyph} onClick={onCreateProject} />
      )}
    </div>
  )
  return (
    <nav
      ref={list}
      className="session-list"
      aria-label={COPY.navigation}
      data-session-filter={filter}
      onTransitionEnd={event => {
        if (
          event.propertyName === 'grid-template-rows'
          && event.elapsedTime > 0
          && event.target instanceof Element
          && event.target.matches(SHELF_BODY)
        )
          remeasure()
      }}>
      {archived && (
        <button
          type="button"
          className="archived-back"
          onClick={() => {
            onFilter('all')
          }}>
          <ChevronLeftGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <span>{COPY.archived}</span>
          <span className="archived-count">{archivedCount}</span>
        </button>
      )}
      {headAt < 0 && projectsHead}
      {groups.length === 0 ? (
        <div className="list-empty">
          <p>{own.length === 0 ? COPY.savedHere : archived ? COPY.noArchived : COPY.noSessions}</p>
        </div>
      ) : (
        groups.map((group, index) => (
          <Fragment key={group.id}>
            {index === headAt && projectsHead}
            <SessionGroupView
              group={group}
              snapshot={snapshot}
              awaiting={awaiting}
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
              foldedSet={folded}
              onFoldMembers={foldTeamMembers}
              now={now}
              onSelect={onSelect}
              onNewIn={onNewIn}
              onNewWithoutProject={onNewWithoutProject}
              menu={sessionMenu}
              onPin={onPinSession}
              onArchive={onArchiveSession}
              clearing={clearing}
              {...(group.id === 'waiting' ? { others } : {})}
              onEditProject={onEditProject}
            />
          </Fragment>
        ))
      )}
      <OtherComputersSessions lists={elsewhere} now={now} folded={folded} onFold={toggleShelf} />
      {archivedCount > 0 && !archived && (
        <button
          type="button"
          className="archived-row"
          aria-label={COPY.archivedCount(archivedCount)}
          onClick={() => {
            onFilter('archived')
          }}>
          <span className="sidebar-row-icon">
            <ArchiveGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </span>
          <span>{COPY.archived}</span>
          <span className="archived-count">{archivedCount}</span>
        </button>
      )}
    </nav>
  )
})
