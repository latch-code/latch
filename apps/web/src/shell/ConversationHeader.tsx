import { useRef, type ReactNode, type RefObject } from 'react'
import { Bot, ChevronDown, ChevronLeft, Ellipsis, Folder, FolderGit2, GitCompare, PanelRight, Pencil, RefreshCw } from 'lucide-react'
import { escapeSecurityText, type ChangeTotals, type HarnessInfo, type RunLive, type TaskSummary } from '@latch/protocol'
import { harnessName } from '../composerChoice.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { connectionLabels, connectionProblem } from '../components/Sidebar.tsx'
import { Button, ICON_STROKE, IconButton, Popover, StatusPill, StatusWord } from '@latch/ui'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { rowStatus, runningWords, silentWords } from '../sessions.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { contextWords } from '../composer/permission.ts'
import { currentShell } from '../core/shell.ts'
import { shortcutButtonKeys } from '../workbenchShortcuts.ts'
import type { ConversationHeaderSlots, HeaderToggle } from './slots.ts'
import { CrumbRow, SessionFacts, SessionFolders } from './SessionEnvironment.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { sessionAgent } from '../agents/model.ts'

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

/** The connection only when it is not healthy: its name and the retry glyph, which syncs the latest state. */
function ConnectionPill({ connection, onRefresh }: { connection: ConnectionStatus; onRefresh: () => void }) {
  if (!connectionProblem(connection)) return null
  return (
    <button
      type="button"
      className={`connection-pill connection-${connection}`}
      title={`${connectionLabels[connection]} · 同步最新状态`}
      onClick={onRefresh}>
      {connectionLabels[connection]}
      <span className="connection-pill-retry">
        · 重试
        <RefreshCw size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </span>
    </button>
  )
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
          <ChevronDown className="topbar-title-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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
            aria-label={`${project ? `项目：${project}` : '会话的文件夹'}${worktree ? `，工作树 · ${escapeSecurityText(worktree)}` : ''}`}>
            {worktree ? (
              <FolderGit2 size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            ) : (
              <Folder size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            )}
            {project && (
              <span className="topbar-crumb-text">
                <VisibleText text={project} />
              </span>
            )}
            {worktree && (
              <span className="topbar-crumb-worktree">
                工作树 · <VisibleText text={worktree} />
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
    </span>
  )
}

/** The Agent a session was delegated to, as 「为 <Agent> 委托」, which goes back to the Agent's page. */
export interface HeaderAgent {
  name: string
  onOpen: () => void
}
function AgentLink({ agent }: { agent: HeaderAgent }) {
  return (
    <button type="button" className="topbar-agent" title={`回到 ${agent.name}`} onClick={agent.onOpen}>
      <Bot size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      <span>
        为 <VisibleText text={agent.name} /> 委托
      </span>
    </button>
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
  onRefresh,
  changes,
  agent,
}: {
  changes?: HeaderToggle | undefined
  agent?: HeaderAgent | undefined
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
  onRefresh: () => void
}) {
  const title = summary ? summary.title || '未命名会话' : '新会话'
  const state = summary && sessionPill(summary, cancelling)
  const where = summary && source
  const branch = summary?.worktree ? `工作树 · ${summary.branch ?? summary.worktree.branch}` : summary?.branch
  return (
    <header className="topbar" data-phone="">
      {onBack && <IconButton size="lg" className="topbar-back" label="返回会话列表" icon={ChevronLeft} onClick={onBack} />}
      <div className="topbar-title">
        <h1 title={title}>
          <TitleMenu title={title} sections={summary ? menu : []} />
        </h1>
        {(where || state || branch || demo || agent || connectionProblem(connection)) && (
          <div className="topbar-subline">
            {agent && <AgentLink agent={agent} />}
            {where && <span className="topbar-source-text">{where}</span>}
            {state}
            {branch && <span className="topbar-branch">{escapeSecurityText(branch)}</span>}
            {demo && (
              <StatusPill tone="warn" title="此会话使用演示模型，回复由本地脚本生成">
                演示
              </StatusPill>
            )}
            <ConnectionPill connection={connection} onRefresh={onRefresh} />
          </div>
        )}
      </div>
      {summary && (
        <span className="topbar-phone-actions">
          {changes && (
            <IconButton size="lg" label={changes.label} icon={changes.icon} pressed={changes.pressed} onClick={changes.onToggle} />
          )}
          <IconButton ref={panelRef} size="lg" label="侧边面板" icon={PanelRight} pressed={panelOpen} onClick={onPanel} />
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
  onRefresh,
  onFiles,
  filesOpen,
  slots = {},
  crumb,
  changesTotals,
  agent,
}: {
  /** The session belongs to one of 我的 Agent. */
  agent?: HeaderAgent | undefined
  /** The session's change totals, once the page has read them. */
  changesTotals?: ChangeTotals | undefined
  /** What the breadcrumb's popover says of this session, beyond its branch. */
  crumb?: { folders?: ReactNode; after?: ReactNode }
  summary?: TaskSummary
  harness?: Pick<HarnessInfo, 'capabilities' | 'status'> | undefined
  /** The basename of the session's working directory. */
  project?: string
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
  onRefresh: () => void
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
        onRefresh={onRefresh}
        changes={slots.changes}
        agent={agent}
      />
    )
  const desktop = currentShell() !== null
  return (
    <header className="topbar">
      <div className="topbar-title">
        {summary && (project || (summary.mode !== 'chat' && summary.cwd)) && (
          <ProjectCrumb project={project} summary={summary} usage={usage} after={crumb?.after}>
            {crumb?.folders}
          </ProjectCrumb>
        )}
        {summary && agent && (
          <span className="topbar-crumb">
            <AgentLink agent={agent} />
            <span className="topbar-crumb-separator" aria-hidden="true">
              /
            </span>
          </span>
        )}
        {summary && (
          <h1 title={title}>
            <TitleMenu title={title} sections={sessionMenu} />
          </h1>
        )}
        {summary && onRename && <IconButton className="topbar-rename" label="重命名会话" icon={Pencil} size="xs" onClick={onRename} />}
        {summary && <TitleStatus summary={summary} cancelling={cancelling} frozen={connectionProblem(connection)} />}
      </div>
      <div className="topbar-actions">
        <ConnectionPill connection={connection} onRefresh={onRefresh} />
        {demo && (
          <StatusPill tone="warn" title="此会话使用演示模型，回复由本地脚本生成">
            演示模型
          </StatusPill>
        )}
        {slots.gitAction}
        {slots.terminal && <Toggle toggle={slots.terminal} />}
        {slots.changes && <ChangesToggle toggle={slots.changes} totals={changesTotals} />}
        {/* A session reaches its files through the panel; a new one has no panel yet, only this. */}
        {onFiles && !summary && <IconButton label="浏览项目文件" icon={Folder} pressed={filesOpen} onClick={onFiles} />}
        {summary && (
          <IconButton
            ref={panelRef}
            label="侧边面板"
            icon={PanelRight}
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
            trigger={props => <IconButton {...props} label="会话操作" icon={Ellipsis} />}
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
    resync,
    canViewChanges,
    changesOpen,
    toggleChanges,
    fileTabs,
    current,
    snapshot,
    owner,
    openSettings,
    openMyAgent,
  } = shell
  const desktop = currentShell() !== null
  const delegated = sessionAgent(snapshot, summary)
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
      panelOpen={columnOpen || (pageMode && infoPage)}
      changesTotals={shell.changesTotals}
      {...(delegated
        ? {
            agent: {
              name: delegated.name,
              onOpen: () => {
                openMyAgent({ id: delegated.id, tab: 'delegate' })
              },
            },
          }
        : {})}
      onPanel={togglePanel}
      sessionMenu={titleMenu}
      menu={topMenu}
      connection={connection}
      onRefresh={() => {
        void resync()
      }}
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
      slots={
        canViewChanges
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
          : {}
      }
    />
  )
}
