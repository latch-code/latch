import { SHELL_COPY } from './copy.ts'
import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { useRef, type ReactNode, type RefObject } from 'react'
import { appRef, listedApps, originTitle } from '../plugin-pages/model.ts'
import { FolderGit2, GitCompare, ListTodo } from 'lucide-react'
import { escapeSecurityText, type ChangeTotals, type HarnessInfo, type RunLive, type TaskSummary } from '@latch/protocol'
import { harnessName, usesDemoModel } from '../composerChoice.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import type { SendingMessage } from '../core/sendingMessage.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { connectionLabels, connectionProblem } from '../components/Sidebar.tsx'
import {
  Button,
  ICON_STROKE,
  IconButton,
  Popover,
  StatusPill,
  StatusWord,
  Tooltip,
  ChevronDownGlyph,
  ChevronLeftGlyph,
  EnterGlyph,
  MoreGlyph,
  FolderGlyph,
  HistoryGlyph,
  PanelRightGlyph,
  EditGlyph,
  BranchGlyph,
  LaptopGlyph,
  ScheduleGlyph,
  Icon,
} from '@latch/ui'
import { importedMark } from '../history/model.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { rowStatus, runningWords, silentWords } from '../sessions.ts'
import { BranchName } from '../components/MiddleEllipsis.tsx'
import { BranchSwitch, canSwitchBranch } from '../composer/BranchSwitch.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { currentShell } from '../core/shell.ts'
import { shortcutButtonKeys } from '../workbenchShortcuts.ts'
import type { ConversationHeaderSlots, HeaderToggle } from './slots.ts'
import { CrumbRow, SessionFacts, SessionFolders } from './SessionEnvironment.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { topicOwner } from '../agents/chat.ts'
import { TopicFrame } from '../agents/TopicFrame.tsx'
import { sessionSource } from '../sessionSource.ts'
import { computerName } from '../core/securityCopy.ts'
import { ComputerChip } from './ComputerChip.tsx'
import { itemOfSession } from '../board/items.ts'
import { openItemPage } from '../board/itemPage.ts'
import { switchWorkView } from '../preferences.ts'
import { defineCopy } from '../core/i18n.ts'

const HEADER_COPY = defineCopy(
  {
    forcedStop: '已强制停止',
    session: (title: string) => `会话：${title}`,
    project: (name: string) => `项目：${name}`,
    from: '来自',
    open: (title: string) => `打开 ${title}`,
    toDo: (title: string) => `待办：${title}`,
    worktree: (path: string) => `工作树 · ${path}`,
    worktreeBranch: '工作树的分支属于它的会话，不在这里切换',
  },
  {
    forcedStop: 'Force stopped',
    session: (title: string) => `Session: ${title}`,
    project: (name: string) => `Project: ${name}`,
    from: 'From ',
    open: (title: string) => `Open ${title}`,
    toDo: (title: string) => `To-do: ${title}`,
    worktree: (path: string) => `Worktree · ${path}`,
    worktreeBranch: 'A worktree’s branch belongs to its session and isn’t switched here',
  },
)

/** The clock's leaf: only these words re-render each second, and the shared ticker stops while the page is hidden. */
function RunningWords({ live }: { live: RunLive | undefined }) {
  useTicker('second')
  return <>{runningWords(live, hostNow())}</>
}

function SilentWords({ live }: { live: RunLive | undefined }) {
  useTicker('second')
  return <>{silentWords(live, hostNow())}</>
}

/**
 * The title row's state, in the sidebar's words: running with its clock, waiting on the person, gone quiet, stopping,
 * failed or how a run ended. A session at rest says nothing; while the connection is down nothing live is drawn (the
 * connection says so on the right).
 */
function TitleStatus({ summary, cancelling, frozen }: { summary: TaskSummary; cancelling: boolean; frozen: boolean }) {
  const status = rowStatus(summary, { stopping: cancelling, frozen })
  const live = summary.live
  switch (status.kind) {
    case 'stopping':
      return <StatusPill tone="neutral">{SHELL_COPY.stopping}</StatusPill>
    case 'waiting':
      return <StatusWord tone="waiting">{SHELL_COPY.attention}</StatusWord>
    case 'silent':
      return (
        <StatusWord tone="warn">
          <SilentWords live={live} />
        </StatusWord>
      )
    case 'running':
      return (
        <StatusWord tone="running">
          <RunningWords live={live} />
        </StatusWord>
      )
    case 'failed':
      return <StatusPill tone="err">{SHELL_COPY.failed}</StatusPill>
    case 'ended':
      return <StatusPill tone={status.unknown > 0 || status.word === HEADER_COPY.forcedStop ? 'warn' : 'neutral'}>{status.word}</StatusPill>
    default:
      return null
  }
}

/**
 * 改动 in the title row. Once the page has read the session's totals (the panel was opened), the button writes them
 * after its glyph and the key that toggles it as caps; before that it is the plain toggle, and nothing is guessed.
 */
function ChangesToggle({ toggle, totals }: { toggle: HeaderToggle; totals?: ChangeTotals | undefined }) {
  useShortcutBindings()
  if (!totals?.files) return <Toggle toggle={toggle} />
  const keys = shortcutButtonKeys('changes', currentShell() !== null)
  return (
    <span className="topbar-changes">
      <Button
        variant="ghost"
        icon={toggle.icon}
        aria-label={toggle.label}
        aria-pressed={toggle.pressed}
        tooltip={toggle.label}
        shortcut={toggle.shortcut}
        {...(keys ? { keys } : {})}
        onClick={toggle.onToggle}>
        <span className="topbar-changes-stat" aria-hidden="true">
          <span data-tone="add">+{totals.add}</span>
          <span data-tone="remove">−{totals.del}</span>
        </span>
      </Button>
      {toggle.dot && <span className="topbar-toggle-dot" aria-hidden="true" />}
    </span>
  )
}

/** The connection only when it is not healthy: its name. 重试 is the connection banner's, one per screen. */
function ConnectionPill({ connection }: { connection: ConnectionStatus }) {
  if (!connectionProblem(connection)) return null
  return <span className={`connection-pill connection-${connection}`}>{connectionLabels[connection]}</span>
}

/** The title: a button with chevron-down that opens the session's menu, or plain words where there is none. */
function TitleMenu({ title, sections }: { title: string; sections: MenuSection[] }) {
  if (sections.length === 0) return <span className="topbar-title-text">{title}</span>
  return (
    <Menu
      label={HEADER_COPY.session(title)}
      title={title}
      placement="bottom-start"
      sections={sections}
      trigger={props => (
        <button {...props} type="button" className="topbar-title-button">
          <span className="topbar-title-text">{title}</span>
          <ChevronDownGlyph className="topbar-title-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        </button>
      )}
    />
  )
}

/** One line of the breadcrumb's popover. */
/**
 * The project in the breadcrumb, which opens where the session really runs: its branch as the Host read it and its
 * folders. A branch that could not be verified says so; it does not mean there is no repository.
 */
function ProjectCrumb({
  project,
  summary,
  children,
  after,
  branchProject,
}: {
  /** Absent for a session in a folder of its own: 「不选项目」 keeps the way to its path. */
  project?: string | undefined
  /** The session works in this project's folder and this device may switch its branch. */
  branchProject?: string | undefined
  summary: TaskSummary
  children?: ReactNode
  after?: ReactNode
}) {
  const worktree = summary.worktree && (summary.branch ?? summary.worktree.branch)
  const lead = summary.worktree?.removed ? SHELL_COPY.worktreeRemoved : SHELL_COPY.worktree
  return (
    <span className="topbar-crumb">
      <Popover
        label={SHELL_COPY.project}
        size="sm"
        side="bottom"
        align="start"
        trigger={props => (
          <button
            {...props}
            type="button"
            className="topbar-crumb-button"
            title={project ?? SHELL_COPY.sessionFolder}
            aria-label={`${project ? HEADER_COPY.project(project) : SHELL_COPY.sessionFolder}${worktree ? `，${lead} · ${escapeSecurityText(worktree)}` : ''}`}>
            {/* Without a project there is no folder chip to draw: the words say so and still open where it runs. */}
            {worktree ? (
              <FolderGit2 size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            ) : project ? (
              <FolderGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            ) : null}
            {project ? (
              <span className="topbar-crumb-text">
                <VisibleText text={project} />
              </span>
            ) : (
              !worktree && <span className="topbar-crumb-text">{SHELL_COPY.noProject}</span>
            )}
            {worktree && (
              <span className="topbar-crumb-worktree" title={HEADER_COPY.worktreeBranch}>
                <span className="topbar-crumb-lead">{lead} · </span>
                <BranchName branch={worktree} />
              </span>
            )}
          </button>
        )}>
        <div className="crumb-body">
          <CrumbRow label={SHELL_COPY.branch}>
            {summary.branch ? <VisibleText text={summary.branch} /> : SHELL_COPY.branchUnavailable}
          </CrumbRow>
          {children}
          {after}
        </div>
      </Popover>
      {project && (
        <span className="topbar-crumb-separator" aria-hidden="true">
          /
        </span>
      )}
      {!worktree && summary.branch && branchProject && <BranchSwitch projectId={branchProject} branch={summary.branch} variant="header" />}
      {!worktree && summary.branch && !branchProject && (
        <span className="topbar-session-branch" title={escapeSecurityText(summary.branch)}>
          <Icon icon={BranchGlyph} size={14} />
          <BranchName branch={summary.branch} className="topbar-crumb-text" />
        </span>
      )}
    </span>
  )
}

/** Where a session came from: 「来自 <来源>」, a link when this device can open it. */
export interface HeaderSource {
  title?: string | undefined
  onOpen?: (() => void) | undefined
  /** What it came from, for the glyph: a handoff or a plugin page (the default), a fork, a schedule. */
  kind?: 'fork' | 'schedule' | undefined
}
const SOURCE_GLYPH = { fork: BranchGlyph, schedule: ScheduleGlyph } as const
function SourceLink({ source }: { source: HeaderSource }) {
  const Glyph = source.kind ? SOURCE_GLYPH[source.kind] : EnterGlyph
  const glyph = <Glyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
  if (!source.title || !source.onOpen)
    return (
      <span className="topbar-agent topbar-handoff">
        {glyph}
        {source.title ? (
          <span>
            {HEADER_COPY.from} <VisibleText text={source.title} />
          </span>
        ) : (
          <span>{SHELL_COPY.fromSession}</span>
        )}
      </span>
    )
  return (
    <button type="button" className="topbar-agent topbar-handoff" title={HEADER_COPY.open(source.title)} onClick={source.onOpen}>
      {glyph}
      <span>
        {HEADER_COPY.from} <VisibleText text={source.title} />
      </span>
    </button>
  )
}

/** The 待办 a session belongs to: its title, which opens its page in 看板. */
export interface HeaderItem {
  title: string
  onOpen: () => void
}
function ItemLink({ item }: { item: HeaderItem }) {
  return (
    <button
      type="button"
      className="topbar-agent topbar-item"
      title={HEADER_COPY.toDo(escapeSecurityText(item.title))}
      onClick={item.onOpen}>
      <ListTodo size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      <span className="topbar-item-title">
        <VisibleText text={item.title} />
      </span>
    </button>
  )
}

/** A session brought in from a harness's own earlier session: 「已接入」, and 「按文字重建」 when it was rebuilt as text. */
export interface HeaderImported {
  label: string
  detail: string
  rebuilt: boolean
}
function ImportedMark({ mark }: { mark: HeaderImported }) {
  return (
    <Tooltip content={mark.detail}>
      <span className="topbar-agent topbar-imported" tabIndex={0} aria-label={mark.detail} data-rebuilt={mark.rebuilt ? '' : undefined}>
        <HistoryGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        <span>{mark.label}</span>
      </span>
    </Tooltip>
  )
}

/**
 * A phone's session page header (52): the round way back to the session list, the title (a button with chevron-down that
 * opens the session's menu, 同步最新状态 included) over where it runs, its branch and its states that are not the default,
 * and the panel's toggle. A session just started is pushed before the Host lists it: until then the header
 * keeps its shape with the title 新会话, and the menu and the panel's toggle wait for it.
 */
function PhoneTopBar({
  summary,
  startingTitle,
  source,
  cancelling,
  demo,
  onBack,
  backLabel,
  panelOpen,
  onPanel,
  panelRef,
  menu,
  connection,
  changes,
  frame,
  from,
  item,
  imported,
  computerUse,
  branchProject,
}: {
  /** 「操控这台 Mac」 is in use in this session, or stopping. */
  computerUse?: 'on' | 'stopping' | undefined
  /** The session works in this project's folder and this device may switch its branch. */
  branchProject?: string | undefined
  item?: HeaderItem | undefined
  changes?: HeaderToggle | undefined
  frame?: ReactNode
  from?: HeaderSource | undefined
  imported?: HeaderImported | undefined
  summary?: TaskSummary
  startingTitle?: string | undefined
  source?: string
  cancelling: boolean
  demo: boolean
  onBack?: () => void
  backLabel?: string
  panelOpen: boolean
  onPanel: () => void
  panelRef?: RefObject<HTMLButtonElement | null>
  menu: MenuSection[]
  connection: ConnectionStatus
}) {
  const title = summary ? summary.title || SHELL_COPY.untitled : (startingTitle ?? SHELL_COPY.newSession)
  // The header is the one place a session's state is written, on a phone as on a wide window.
  const state = summary && <TitleStatus summary={summary} cancelling={cancelling} frozen={connectionProblem(connection)} />
  const where = summary && source
  const branch = summary?.worktree ? (summary.branch ?? summary.worktree.branch) : summary?.branch
  // A conversation in 我的 Agent: its Agent's frame stands in the title's place, the topic under the name.
  if (frame)
    return (
      <header className="topbar topbar-frame" data-phone="">
        {onBack && <IconButton size="lg" className="topbar-back" label={SHELL_COPY.back} icon={ChevronLeftGlyph} onClick={onBack} />}
        {frame}
      </header>
    )
  return (
    <header className="topbar" data-phone="">
      {onBack && (
        <IconButton
          size="lg"
          className="topbar-back"
          label={backLabel ?? SHELL_COPY.backToSessions}
          icon={ChevronLeftGlyph}
          onClick={onBack}
        />
      )}
      <div className="topbar-title">
        <h1 title={title}>
          <TitleMenu title={title} sections={summary ? menu : []} />
        </h1>
        {(where || state || branch || demo || from || item || imported || computerUse || connectionProblem(connection)) && (
          <div className="topbar-subline">
            {item && <ItemLink item={item} />}
            {from && <SourceLink source={from} />}
            {imported && <ImportedMark mark={imported} />}
            {where && <span className="topbar-source-text">{where}</span>}
            {state}
            {branch && branchProject && !summary?.worktree && <BranchSwitch projectId={branchProject} branch={branch} variant="subline" />}
            {branch && !(branchProject && !summary?.worktree) && (
              <span
                className="topbar-branch"
                title={escapeSecurityText(summary?.worktree ? `${HEADER_COPY.worktree(branch)} · ${HEADER_COPY.worktreeBranch}` : branch)}>
                {summary?.worktree && <span className="topbar-crumb-lead">{HEADER_COPY.worktree('')}</span>}
                <BranchName branch={branch} />
              </span>
            )}
            {demo && (
              <StatusPill tone="warn" title={SHELL_COPY.demoDetails}>
                {SHELL_COPY.demo}
              </StatusPill>
            )}
            {computerUse && summary && <ComputerChip sessionId={summary.id} stopping={computerUse === 'stopping'} />}
            <ConnectionPill connection={connection} />
          </div>
        )}
      </div>
      {summary && (
        <span className="topbar-phone-actions">
          {changes && (
            <IconButton size="lg" label={changes.label} icon={changes.icon} pressed={changes.pressed} onClick={changes.onToggle} />
          )}
          <IconButton ref={panelRef} size="lg" label={SHELL_COPY.sidePanel} icon={PanelRightGlyph} pressed={panelOpen} onClick={onPanel} />
        </span>
      )}
    </header>
  )
}

function Toggle({ toggle }: { toggle: HeaderToggle }) {
  const button = (
    <IconButton label={toggle.label} icon={toggle.icon} shortcut={toggle.shortcut} pressed={toggle.pressed} onClick={toggle.onToggle} />
  )
  if (!toggle.dot) return button
  return (
    <span className="topbar-toggle">
      {button}
      <span className="topbar-toggle-dot" aria-hidden="true" />
    </span>
  )
}

/**
 * The conversation's half of the title row, the work panel's top. Left: the breadcrumb, project / title (a button that
 * opens the session's menu, with the rename pencil on hover), then its state (running with its clock, waiting, or how it
 * ended). The project opens where it runs. Right: the connection only when it is not healthy, full access, the demo
 * model, the surfaces' slots (改动 with its totals once the page has them), the panel toggle and ⋯.
 * Phones draw their own header in the conversation's page (above).
 */
export function SessionHeader({
  summary,
  startingTitle,
  harness,
  project,
  computer,
  cancelling,
  demo,
  phone,
  onBack,
  backLabel,
  onRename,
  panelOpen,
  onPanel,
  panelRef,
  sessionMenu,
  menu,
  connection,
  onFiles,
  filesOpen,
  slots = {},
  crumb,
  changesTotals,
  frame,
  from,
  item,
  imported,
  computerUse,
  branchProject,
}: {
  /** The session works in this project's folder and this device may switch its branch. */
  branchProject?: string | undefined
  /** The 待办 the session belongs to. */
  item?: HeaderItem | undefined
  /** 「操控这台 Mac」 is in use in this session (its chip, with 停), or stopping. */
  computerUse?: 'on' | 'stopping' | undefined
  /** The session was brought in from a harness's own earlier session. */
  imported?: HeaderImported | undefined
  /** The session is a topic of a conversation in 我的 Agent: its Agent's frame stands in the title's place. */
  frame?: ReactNode
  /** The session received a handoff. */
  from?: HeaderSource | undefined
  /** The session's change totals, once the page has read them. */
  changesTotals?: ChangeTotals | undefined
  /** What the breadcrumb's popover says of this session, beyond its branch. */
  crumb?: { folders?: ReactNode; after?: ReactNode }
  summary?: TaskSummary
  startingTitle?: string | undefined
  harness?: Pick<HarnessInfo, 'capabilities' | 'status'> | undefined
  /** The basename of the session's working directory. */
  project?: string
  computer?: string
  cancelling: boolean
  demo: boolean
  phone: boolean
  /** Phones: back to the session list. */
  onBack?: () => void
  backLabel?: string
  onRename?: () => void
  /** The panel is shown, beside the conversation or in its place. */
  panelOpen: boolean
  onPanel: () => void
  /** The toggle, which takes focus back when the panel's page closes. */
  panelRef?: RefObject<HTMLButtonElement | null>
  /** Rename, pin, archive, export and delete: the title button's menu. */
  sessionMenu: MenuSection[]
  /** ⋯: the session's actions and 同步最新状态 (on phones, the title button's menu). */
  menu: MenuSection[]
  connection: ConnectionStatus
  onFiles?: () => void
  filesOpen?: boolean
  slots?: ConversationHeaderSlots
}) {
  const title = summary ? summary.title || SHELL_COPY.untitled : SHELL_COPY.newSession
  if (phone)
    return (
      <PhoneTopBar
        summary={summary}
        startingTitle={startingTitle}
        source={harness ? [harnessName(harness), project].filter(Boolean).join(' · ') : undefined}
        cancelling={cancelling}
        demo={demo}
        onBack={onBack}
        backLabel={backLabel}
        panelOpen={panelOpen}
        onPanel={onPanel}
        panelRef={panelRef}
        menu={menu}
        connection={connection}
        changes={slots.changes}
        frame={frame}
        from={from}
        item={item}
        imported={imported}
        computerUse={computerUse}
        branchProject={branchProject}
      />
    )
  // A session's actions end the line under its title, so the title has the head's whole width.
  const actions = (
    <div className="topbar-actions">
      {computerUse && summary && <ComputerChip sessionId={summary.id} stopping={computerUse === 'stopping'} />}
      <ConnectionPill connection={connection} />
      {demo && (
        <StatusPill tone="warn" title={SHELL_COPY.demoDetails}>
          {SHELL_COPY.demoModel}
        </StatusPill>
      )}
      {slots.gitAction}
      {slots.changes && <ChangesToggle toggle={slots.changes} totals={changesTotals} />}
      {/* A session reaches its files through the panel; a new one has no panel yet, only this. */}
      {onFiles && !summary && <IconButton label={SHELL_COPY.browseProjects} icon={FolderGlyph} pressed={filesOpen} onClick={onFiles} />}
      {summary && menu.length > 0 && (
        <Menu
          label={SHELL_COPY.sessionActions}
          placement="bottom-end"
          sections={menu}
          trigger={props => <IconButton {...props} label={SHELL_COPY.sessionActions} icon={MoreGlyph} />}
        />
      )}
    </div>
  )
  return (
    <header className="topbar">
      <div className="topbar-title">
        {startingTitle && (
          <div className="topbar-title-line">
            <h1 title={startingTitle}>
              <TitleMenu title={startingTitle} sections={[]} />
            </h1>
          </div>
        )}
        {summary && frame}
        {summary && !frame && (
          <>
            <div className="topbar-title-line">
              <div className="topbar-title-controls">
                <h1 title={title}>
                  <TitleMenu title={title} sections={sessionMenu} />
                </h1>
                {onRename && (
                  <IconButton className="topbar-rename" label={SHELL_COPY.renameSession} icon={EditGlyph} size="xs" onClick={onRename} />
                )}
              </div>
            </div>
            <div className="topbar-session-meta">
              {(project || (summary.mode !== 'chat' && summary.cwd)) && (
                <ProjectCrumb project={project} summary={summary} after={crumb?.after} branchProject={branchProject}>
                  {crumb?.folders}
                </ProjectCrumb>
              )}
              {item && <ItemLink item={item} />}
              {computer && (
                <span className="topbar-computer">
                  <Icon icon={LaptopGlyph} size={14} />
                  <span className="topbar-crumb-text">{computer}</span>
                </span>
              )}
            </div>
            {from && (
              <span className="topbar-crumb">
                <SourceLink source={from} />
                <span className="topbar-crumb-separator" aria-hidden="true">
                  /
                </span>
              </span>
            )}
            {imported && (
              <span className="topbar-crumb">
                <ImportedMark mark={imported} />
                <span className="topbar-crumb-separator" aria-hidden="true">
                  /
                </span>
              </span>
            )}
          </>
        )}
        {summary && !frame && <TitleStatus summary={summary} cancelling={cancelling} frozen={connectionProblem(connection)} />}
        {summary && !frame && actions}
      </div>
      {!(summary && !frame) && actions}
    </header>
  )
}

/** Below this the head's actions would wrap onto a third line beside an open panel. */
const HEAD_FOLD_WIDTH = 600

/** The session header with the shell's state. */
export function ConversationHeader({
  shell,
  starting,
  onStartBack,
}: {
  shell: ShellState
  starting: SendingMessage | null
  onStartBack: () => void
}) {
  const {
    summary,
    panelToggle,
    canBrowseFiles,
    browseFiles,
    filesVisible,
    topHarness,
    project,
    selectedId,
    stopping,
    access,
    demo,
    phone,
    back,
    setRenaming,
    columnOpen,
    pageMode,
    infoPage,
    togglePanel,
    titleMenu,
    topMenu,
    connection,
    canViewChanges,
    changesOpen,
    toggleChanges,
    fileTabs,
    current,
    snapshot,
    owner,
    openSettings,
    entries,
  } = shell
  const desktop = currentShell() !== null
  const topicOf = entries.includes('agents') ? topicOwner(summary) : undefined
  const panelShown = (columnOpen && !shell.profileColumn) || (pageMode && infoPage)
  // A conversation narrowed by the open panel (whose strip has 改动) keeps its head to two lines: 改动 goes into ⋯,
  // its key unchanged.
  const foldChanges = canViewChanges && !phone && columnOpen && !shell.profileColumn && shell.conversationWidth < HEAD_FOLD_WIDTH
  const importedFrom = summary?.imported && snapshot.catalog?.harnesses.find(harness => harness.id === summary.imported!.from)
  const imported = summary && importedMark(summary, importedFrom ? harnessName(importedFrom) : undefined)
  const source = summary ? sessionSource(snapshot, summary) : undefined
  // A session in its project's own folder (not a worktree, nor an Agent's home): its branch is that folder's, switchable.
  const branchProject =
    summary && !summary.worktree && !summary.personal && !summary.agent && summary.branch && canSwitchBranch(snapshot, access, connection)
      ? snapshot.catalog?.workspaces.find(
          item => item.id === summary.workspaceId && item.id !== 'default' && (item.folders?.[0]?.path ?? item.path) === summary.cwd,
        )?.id
      : undefined
  // Membership is read from the 待办 the snapshot lists, never from the session's own field.
  const item = summary && snapshot.catalog?.features?.workItems ? itemOfSession(snapshot, summary.id) : undefined
  // A session a plugin page started: 「来自 <页面名>」, the way back to the page while it is listed.
  const originApp = summary?.origin?.app
  const originPage = originApp ? listedApps(snapshot).find(page => appRef(page) === originApp) : undefined
  const pageOrigin =
    summary && originApp
      ? {
          title: originTitle(summary, snapshot),
          onOpen: originPage
            ? () => {
                shell.openApp({ pluginId: originPage.pluginId, appId: originPage.appId })
              }
            : undefined,
        }
      : undefined
  // A dot while the newest turn changed files nobody has opened here yet.
  const seen = useRef<Map<string, string>>(new Map())
  const latest = current?.messages.findLast(message => message.role === 'user')?.turnId
  const showing = shell.panelVisible && shell.panelSelected === 'changes'
  if (showing && summary && latest) seen.current.set(summary.id, latest)
  const unread =
    !showing
    && latest !== undefined
    && !!summary
    && seen.current.get(summary.id) !== latest
    && !!current?.messages
      .slice(current.messages.findLastIndex(message => message.role === 'user'))
      .some(message => message.outputs?.length)
  if (starting) {
    const { harnessId, workspaceId, model } = starting.submission
    const harness = snapshot.catalog?.harnesses.find(item => item.id === harnessId)
    const place = snapshot.catalog?.workspaces.find(item => item.id === workspaceId && item.id !== 'default')
    return (
      <SessionHeader
        startingTitle={`${harness ? harnessName(harness) : SHELL_COPY.newSession} · ${place ? escapeSecurityText(place.name) : SHELL_COPY.noProject}`}
        cancelling={false}
        demo={usesDemoModel(snapshot, harnessId, model?.providerId)}
        phone={phone}
        onBack={onStartBack}
        panelOpen={false}
        onPanel={() => {}}
        sessionMenu={[]}
        menu={[]}
        connection={connection}
      />
    )
  }
  return (
    <SessionHeader
      panelRef={panelToggle}
      onFiles={canBrowseFiles ? browseFiles : undefined}
      filesOpen={filesVisible}
      summary={summary}
      harness={topHarness}
      project={project}
      computer={computerName(snapshot.hostName)}
      cancelling={selectedId !== null && stopping.has(selectedId)}
      demo={demo}
      phone={phone}
      backLabel={shell.phoneBackLabel}
      onBack={() => {
        back()
      }}
      {...(summary
        ? {
            onRename: () => {
              setRenaming(summary)
            },
          }
        : {})}
      panelOpen={panelShown}
      branchProject={branchProject}
      changesTotals={shell.changesTotals}
      {...(topicOf && summary
        ? {
            frame: (
              <TopicFrame
                shell={shell}
                owner={topicOf}
                current={summary.id}
                title={summary.title || SHELL_COPY.untitled}
                actions={
                  phone ? (
                    <>
                      <IconButton
                        ref={panelToggle}
                        size="lg"
                        label={SHELL_COPY.sidePanel}
                        icon={PanelRightGlyph}
                        pressed={panelShown}
                        onClick={() => togglePanel()}
                      />
                      {topMenu.length > 0 && (
                        <Menu
                          label={SHELL_COPY.sessionActions}
                          placement="bottom-end"
                          sections={topMenu}
                          trigger={props => <IconButton {...props} size="lg" label={SHELL_COPY.sessionActions} icon={MoreGlyph} />}
                        />
                      )}
                    </>
                  ) : undefined
                }
              />
            ),
          }
        : {})}
      {...(source
        ? {
            from: {
              title: source.title,
              ...(source.kind !== 'handoff' ? { kind: source.kind } : {}),
              onOpen:
                source.kind === 'schedule'
                  ? () => {
                      shell.openMyAgent({ id: source.owner, tab: 'schedules' })
                    }
                  : source.listed
                    ? () => {
                        shell.choose(source.sessionId)
                      }
                    : undefined,
            },
          }
        : pageOrigin
          ? { from: pageOrigin }
          : {})}
      imported={imported}
      {...(item
        ? {
            item: {
              title: item.title,
              onOpen: () => {
                openItemPage(snapshot.device.id, item.id)
                switchWorkView('board')
              },
            },
          }
        : {})}
      computerUse={current?.computer && current.summary.id === summary?.id ? (current.computer.stopping ? 'stopping' : 'on') : undefined}
      onPanel={() => togglePanel()}
      sessionMenu={titleMenu}
      menu={
        foldChanges
          ? [
              {
                id: 'surfaces',
                items: [
                  {
                    id: 'changes',
                    label: SHELL_COPY.changes,
                    icon: GitCompare,
                    meta: desktop ? '⌘D' : 'Alt D',
                    onSelect: toggleChanges,
                  },
                ],
              },
              ...topMenu,
            ]
          : topMenu
      }
      connection={connection}
      {...(summary
        ? {
            crumb: {
              folders: (
                <SessionFolders
                  summary={summary}
                  snapshot={snapshot}
                  local={access.local}
                  admin={access.admin}
                  {...(owner && shell.shell
                    ? {
                        onNewProject: () => {
                          openSettings('workspaces')
                        },
                      }
                    : {})}
                />
              ),
              after: <SessionFacts summary={summary} detail={current} harness={topHarness} gate={shell.gate} />,
            },
          }
        : {})}
      slots={{
        ...(canViewChanges && !foldChanges
          ? {
              changes: {
                label: SHELL_COPY.changes,
                icon: GitCompare,
                shortcut: desktop ? '⌘D' : 'Alt D',
                pressed: showing,
                dot: unread,
                onToggle: toggleChanges,
              },
            }
          : {}),
      }}
    />
  )
}
