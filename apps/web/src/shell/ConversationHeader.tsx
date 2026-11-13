import { useRef, type ReactNode, type RefObject } from 'react'
import { appRef, listedApps, originTitle } from '../plugin-pages/model.ts'
import { FolderGit2, GitCompare } from 'lucide-react'
import { escapeSecurityText, type ChangeTotals, type HarnessInfo, type RunLive, type TaskSummary } from '@latch/protocol'
import { harnessName } from '../composerChoice.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
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
  TerminalGlyph,
  PanelRightGlyph,
  EditGlyph,
  BranchGlyph,
  LaptopGlyph,
  Icon,
} from '@latch/ui'
import { importedMark } from '../history/model.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { rowStatus, runningWords, silentWords } from '../sessions.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { contextWords } from '../composer/permission.ts'
import { currentShell } from '../core/shell.ts'
import { shortcutButtonKeys } from '../workbenchShortcuts.ts'
import type { ConversationHeaderSlots, HeaderToggle } from './slots.ts'
import { CrumbRow, SessionFacts, SessionFolders } from './SessionEnvironment.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { topicOwner } from '../agents/chat.ts'
import { TopicFrame } from '../agents/TopicFrame.tsx'
import { sourceCrumb } from '../handoffs/model.ts'
import { computerName } from '../core/securityCopy.ts'

/** The session's state when it is not the default: running and done say nothing here (the run bar says running). */
function sessionPill(summary: TaskSummary, cancelling: boolean) {
  if (cancelling) return <StatusPill tone="neutral">正在停止</StatusPill>
  if (summary.status === 'failed') return <StatusPill tone="err">失败</StatusPill>
  if (summary.status === 'cancelled') return <StatusPill tone="neutral">已停止</StatusPill>
  if (summary.status === 'interrupted') return <StatusPill tone="neutral">已中断</StatusPill>
  return null
}

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
      return <StatusPill tone="neutral">正在停止</StatusPill>
    case 'waiting':
      return <StatusWord tone="waiting">等你处理</StatusWord>
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
      return <StatusPill tone="err">失败</StatusPill>
    case 'ended':
      return <StatusPill tone={status.unknown > 0 || status.word === '已强制停止' ? 'warn' : 'neutral'}>{status.word}</StatusPill>
    default:
      return null
  }
}

/**
 * 改动 in the title row. Once the page has read the session's totals (the panel was opened), the button writes them
 * after its glyph and the key that toggles it as caps; before that it is the plain toggle, and nothing is guessed.
 */
function ChangesToggle({ toggle, totals }: { toggle: HeaderToggle; totals?: ChangeTotals | undefined }) {
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
      {toggle.dot && <span className="topbar-toggle-dot" />}
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
      label={`会话：${title}`}
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
 * The project in the breadcrumb, which opens where the session really runs: its branch as the Host read it, its folders
 * and how full the context is. A branch that could not be verified says so; it does not mean there is no repository.
 */
function ProjectCrumb({
  project,
  summary,
  usage,
  children,
  after,
}: {
  /** Absent for a session in a folder of its own: the glyph alone keeps the way to its path. */
  project?: string | undefined
  summary: TaskSummary
  usage?: { contextUsed?: number; contextSize?: number } | undefined
  children?: ReactNode
  after?: ReactNode
}) {
  const context = contextWords(usage)
  const worktree = summary.worktree && (summary.branch ?? summary.worktree.branch)
  const lead = summary.worktree?.removed ? '工作树已移除' : '工作树'
  return (
    <span className="topbar-crumb">
      <Popover
        label="项目"
        width={320}
        side="bottom"
        align="start"
        trigger={props => (
          <button
            {...props}
            type="button"
            className="topbar-crumb-button"
            title={project ?? '会话的文件夹'}
            aria-label={`${project ? `项目：${project}` : '会话的文件夹'}${worktree ? `，${lead} · ${escapeSecurityText(worktree)}` : ''}`}>
            {worktree ? (
              <FolderGit2 size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            ) : (
              <FolderGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            )}
            {project && (
              <span className="topbar-crumb-text">
                <VisibleText text={project} />
              </span>
            )}
            {worktree && (
              <span className="topbar-crumb-worktree">
                {lead} · <VisibleText text={worktree} />
              </span>
            )}
          </button>
        )}>
        <div className="crumb-body">
          <CrumbRow label="分支">{summary.branch ? <VisibleText text={summary.branch} /> : '读不到分支'}</CrumbRow>
          {children}
          {context && <CrumbRow label="上下文">{context.words.replace(/^上下文已用 /u, '')}</CrumbRow>}
          {after}
        </div>
      </Popover>
      {project && (
        <span className="topbar-crumb-separator" aria-hidden="true">
          /
        </span>
      )}
      {!worktree && summary.branch && (
        <span className="topbar-session-branch">
          <Icon icon={BranchGlyph} size={14} />
          <VisibleText text={summary.branch} />
        </span>
      )}
    </span>
  )
}

/** Where a handed-off session came from: 「来自 <来源会话>」, a link when this device lists the source. */
export interface HeaderSource {
  title?: string | undefined
  onOpen?: (() => void) | undefined
}
function SourceLink({ source }: { source: HeaderSource }) {
  const glyph = <EnterGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
  if (!source.title || !source.onOpen)
    return (
      <span className="topbar-agent topbar-handoff">
        {glyph}
        {source.title ? (
          <span>
            来自 <VisibleText text={source.title} />
          </span>
        ) : (
          <span>来自另一个会话</span>
        )}
      </span>
    )
  return (
    <button type="button" className="topbar-agent topbar-handoff" title={`打开 ${source.title}`} onClick={source.onOpen}>
      {glyph}
      <span>
        来自 <VisibleText text={source.title} />
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
  source,
  cancelling,
  demo,
  onBack,
  panelOpen,
  onPanel,
  panelRef,
  menu,
  connection,
  changes,
  frame,
  from,
  imported,
}: {
  changes?: HeaderToggle | undefined
  frame?: ReactNode
  from?: HeaderSource | undefined
  imported?: HeaderImported | undefined
  summary?: TaskSummary
  source?: string
  cancelling: boolean
  demo: boolean
  onBack?: () => void
  panelOpen: boolean
  onPanel: () => void
  panelRef?: RefObject<HTMLButtonElement | null>
  menu: MenuSection[]
  connection: ConnectionStatus
}) {
  const title = summary ? summary.title || '未命名会话' : '新会话'
  const state = summary && sessionPill(summary, cancelling)
  const where = summary && source
  const branch = summary?.worktree ? `工作树 · ${summary.branch ?? summary.worktree.branch}` : summary?.branch
  // A conversation in 我的 Agent: its Agent's frame stands in the title's place, the topic under the name.
  if (frame)
    return (
      <header className="topbar topbar-frame" data-phone="">
        {onBack && <IconButton size="lg" className="topbar-back" label="返回" icon={ChevronLeftGlyph} onClick={onBack} />}
        {frame}
      </header>
    )
  return (
    <header className="topbar" data-phone="">
      {onBack && <IconButton size="lg" className="topbar-back" label="返回会话列表" icon={ChevronLeftGlyph} onClick={onBack} />}
      <div className="topbar-title">
        <h1 title={title}>
          <TitleMenu title={title} sections={summary ? menu : []} />
        </h1>
        {(where || state || branch || demo || from || imported || connectionProblem(connection)) && (
          <div className="topbar-subline">
            {from && <SourceLink source={from} />}
            {imported && <ImportedMark mark={imported} />}
            {where && <span className="topbar-source-text">{where}</span>}
            {state}
            {branch && <span className="topbar-branch">{escapeSecurityText(branch)}</span>}
            {demo && (
              <StatusPill tone="warn" title="此会话使用演示模型，回复由本地脚本生成">
                演示
              </StatusPill>
            )}
            <ConnectionPill connection={connection} />
          </div>
        )}
      </div>
      {summary && (
        <span className="topbar-phone-actions">
          {changes && (
            <IconButton size="lg" label={changes.label} icon={changes.icon} pressed={changes.pressed} onClick={changes.onToggle} />
          )}
          <IconButton ref={panelRef} size="lg" label="侧边面板" icon={PanelRightGlyph} pressed={panelOpen} onClick={onPanel} />
        </span>
      )}
    </header>
  )
}

function Toggle({ toggle }: { toggle: HeaderToggle }) {
  return (
    <IconButton
      label={toggle.label}
      icon={toggle.icon}
      shortcut={toggle.shortcut}
      pressed={toggle.pressed}
      badge={toggle.dot ? <span className="topbar-toggle-dot" /> : undefined}
      onClick={toggle.onToggle}
    />
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
  harness,
  project,
  computer,
  usage,
  cancelling,
  demo,
  phone,
  onBack,
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
  imported,
}: {
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
  harness?: Pick<HarnessInfo, 'capabilities' | 'status'> | undefined
  /** The basename of the session's working directory. */
  project?: string
  computer?: string
  /** What the engine last reported about its context. */
  usage?: { contextUsed?: number; contextSize?: number } | undefined
  cancelling: boolean
  demo: boolean
  phone: boolean
  /** Phones: back to the session list. */
  onBack?: () => void
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
  const title = summary ? summary.title || '未命名会话' : '新会话'
  if (phone)
    return (
      <PhoneTopBar
        summary={summary}
        source={harness ? [harnessName(harness), project].filter(Boolean).join(' · ') : undefined}
        cancelling={cancelling}
        demo={demo}
        onBack={onBack}
        panelOpen={panelOpen}
        onPanel={onPanel}
        panelRef={panelRef}
        menu={menu}
        connection={connection}
        changes={slots.changes}
        frame={frame}
        from={from}
        imported={imported}
      />
    )
  const desktop = currentShell() !== null
  return (
    <header className="topbar">
      <div className="topbar-title">
        {summary && frame}
        {summary && !frame && (project || (summary.mode !== 'chat' && summary.cwd)) && (
          <ProjectCrumb project={project} summary={summary} usage={usage} after={crumb?.after}>
            {crumb?.folders}
          </ProjectCrumb>
        )}
        {summary && !frame && from && (
          <span className="topbar-crumb">
            <SourceLink source={from} />
            <span className="topbar-crumb-separator" aria-hidden="true">
              /
            </span>
          </span>
        )}
        {summary && !frame && imported && (
          <span className="topbar-crumb">
            <ImportedMark mark={imported} />
            <span className="topbar-crumb-separator" aria-hidden="true">
              /
            </span>
          </span>
        )}
        {summary && !frame && (
          <h1 title={title}>
            <TitleMenu title={title} sections={sessionMenu} />
          </h1>
        )}
        {summary && !frame && onRename && (
          <IconButton className="topbar-rename" label="重命名会话" icon={EditGlyph} size="xs" onClick={onRename} />
        )}
        {summary && !frame && computer && (
          <span className="topbar-computer">
            <Icon icon={LaptopGlyph} size={14} />
            {computer}
          </span>
        )}
        {summary && !frame && <TitleStatus summary={summary} cancelling={cancelling} frozen={connectionProblem(connection)} />}
      </div>
      <div className="topbar-actions">
        <ConnectionPill connection={connection} />
        {demo && (
          <StatusPill tone="warn" title="此会话使用演示模型，回复由本地脚本生成">
            演示模型
          </StatusPill>
        )}
        {slots.gitAction}
        {slots.terminal && <Toggle toggle={slots.terminal} />}
        {slots.changes && <ChangesToggle toggle={slots.changes} totals={changesTotals} />}
        {/* A session reaches its files through the panel; a new one has no panel yet, only this. */}
        {onFiles && !summary && <IconButton label="浏览项目文件" icon={FolderGlyph} pressed={filesOpen} onClick={onFiles} />}
        {summary && (
          <IconButton
            ref={panelRef}
            label="侧边面板"
            icon={PanelRightGlyph}
            shortcut={desktop ? '⌥⌘B' : 'Alt Shift B'}
            pressed={panelOpen}
            onClick={onPanel}
          />
        )}
        {summary && menu.length > 0 && (
          <Menu
            label="会话操作"
            placement="bottom-end"
            sections={menu}
            trigger={props => <IconButton {...props} label="会话操作" icon={MoreGlyph} />}
          />
        )}
      </div>
    </header>
  )
}

/** The session header with the shell's state. */
export function ConversationHeader({ shell }: { shell: ShellState }) {
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
    canTerminal,
    terminalOpen,
    toggleTerminal,
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
  const importedFrom = summary?.imported && snapshot.catalog?.harnesses.find(harness => harness.id === summary.imported!.from)
  const imported = summary && importedMark(summary, importedFrom ? harnessName(importedFrom) : undefined)
  const handedFrom = snapshot.catalog?.features?.handoffs ? sourceCrumb(snapshot, summary?.id) : undefined
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
  const showing = changesOpen && !fileTabs.active
  if (showing && summary && latest) seen.current.set(summary.id, latest)
  const unread =
    !showing
    && latest !== undefined
    && !!summary
    && seen.current.get(summary.id) !== latest
    && !!current?.messages
      .slice(current.messages.findLastIndex(message => message.role === 'user'))
      .some(message => message.outputs?.length)
  return (
    <SessionHeader
      panelRef={panelToggle}
      onFiles={canBrowseFiles ? browseFiles : undefined}
      filesOpen={filesVisible}
      summary={summary}
      harness={topHarness}
      project={project}
      computer={computerName(snapshot.hostName)}
      usage={current?.usageReport}
      cancelling={selectedId !== null && stopping.has(selectedId)}
      demo={demo}
      phone={phone}
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
      changesTotals={shell.changesTotals}
      {...(topicOf && summary
        ? {
            frame: (
              <TopicFrame
                shell={shell}
                owner={topicOf}
                current={summary.id}
                title={summary.title || '未命名会话'}
                actions={
                  phone ? (
                    <>
                      <IconButton
                        ref={panelToggle}
                        size="lg"
                        label="侧边面板"
                        icon={PanelRightGlyph}
                        pressed={panelShown}
                        onClick={togglePanel}
                      />
                      {topMenu.length > 0 && (
                        <Menu
                          label="会话操作"
                          placement="bottom-end"
                          sections={topMenu}
                          trigger={props => <IconButton {...props} size="lg" label="会话操作" icon={MoreGlyph} />}
                        />
                      )}
                    </>
                  ) : undefined
                }
              />
            ),
          }
        : {})}
      {...(handedFrom
        ? {
            from: {
              title: handedFrom.title,
              onOpen: handedFrom.title
                ? () => {
                    shell.choose(handedFrom.sourceId)
                  }
                : undefined,
            },
          }
        : pageOrigin
          ? { from: pageOrigin }
          : {})}
      imported={imported}
      onPanel={togglePanel}
      sessionMenu={titleMenu}
      menu={topMenu}
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
        ...(canTerminal && !phone
          ? {
              terminal: {
                label: '终端',
                icon: TerminalGlyph,
                shortcut: desktop ? '⌘J' : 'Alt J',
                pressed: terminalOpen && !fileTabs.active,
                onToggle: toggleTerminal,
              },
            }
          : {}),
        ...(canViewChanges
          ? {
              changes: {
                label: '改动',
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
