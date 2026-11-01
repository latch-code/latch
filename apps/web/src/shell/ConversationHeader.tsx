import { useRef, type RefObject } from 'react'
import { ChevronDown, ChevronLeft, Ellipsis, Folder, GitCompare, PanelRight, Pencil, RefreshCw, ShieldAlert } from 'lucide-react'
import { escapeSecurityText, type HarnessInfo, type TaskSummary } from '@latch/protocol'
import { harnessName } from '../composerChoice.ts'
import { LEVEL_LABELS, LEVEL_TOOLTIPS } from '../core/permissions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { connectionLabels, connectionProblem } from '../components/Sidebar.tsx'
import { ICON_STROKE, IconButton, StatusPill } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import type { ConversationHeaderSlots, HeaderToggle } from './slots.ts'
import type { ShellState } from './useShellLayout.tsx'

/** The session's state when it is not the default: running and done say nothing here (the run bar says running). */
function sessionPill(summary: TaskSummary, cancelling: boolean) {
  if (cancelling) return <StatusPill tone="neutral">正在停止</StatusPill>
  if (summary.status === 'failed') return <StatusPill tone="err">失败</StatusPill>
  if (summary.status === 'cancelled') return <StatusPill tone="neutral">已停止</StatusPill>
  if (summary.status === 'interrupted') return <StatusPill tone="neutral">已中断</StatusPill>
  return null
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

const fullAccessPill = (
  <StatusPill tone="neutral" className="level-pill" title={LEVEL_TOOLTIPS.L3}>
    <ShieldAlert size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
    {LEVEL_LABELS.L3}
  </StatusPill>
)

/**
 * A phone's session page header (52): the round way back to the session list, the title (a button with chevron-down that
 * opens the session's menu, 同步最新状态 included) over where it runs, its branch and its states that are not the default,
 * and 会话信息. A session just started is pushed before the Host lists it: until then the header
 * keeps its shape with the title 新会话, and the menu and 会话信息 wait for it.
 */
function PhoneTopBar({
  summary,
  source,
  cancelling,
  level,
  demo,
  onBack,
  inspectorOpen,
  onInspector,
  inspectorRef,
  menu,
  connection,
  onRefresh,
  changes,
}: {
  changes?: HeaderToggle | undefined
  summary?: TaskSummary
  source?: string
  cancelling: boolean
  level?: 'L1' | 'L3'
  demo: boolean
  onBack?: () => void
  inspectorOpen: boolean
  onInspector: () => void
  inspectorRef?: RefObject<HTMLButtonElement | null>
  menu: MenuSection[]
  connection: ConnectionStatus
  onRefresh: () => void
}) {
  const title = summary ? summary.title || '未命名会话' : '新会话'
  const state = summary && sessionPill(summary, cancelling)
  const where = summary && source
  const fullAccess = summary !== undefined && level === 'L3'
  const branch = summary?.branch
  return (
    <header className="topbar" data-phone="">
      {onBack && <IconButton size="lg" className="topbar-back" label="返回会话列表" icon={ChevronLeft} onClick={onBack} />}
      <div className="topbar-title">
        <h1 title={title}>
          <TitleMenu title={title} sections={summary ? menu : []} />
        </h1>
        {(where || state || fullAccess || branch || demo || connectionProblem(connection)) && (
          <div className="topbar-subline">
            {where && <span className="topbar-source-text">{where}</span>}
            {state}
            {fullAccess && (
              <span className="topbar-full-access" title={LEVEL_TOOLTIPS.L3}>
                {LEVEL_LABELS.L3}
              </span>
            )}
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
          <IconButton ref={inspectorRef} size="lg" label="会话信息" icon={PanelRight} pressed={inspectorOpen} onClick={onInspector} />
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
 * The conversation's half of the title row. Left: the breadcrumb, project / title (a button that opens the session's
 * menu, with the rename pencil on hover), then where it runs and its state when that is not the default. Right: the
 * connection only when it is not healthy, full access, the demo model, the surfaces' slots, the panel toggle and ⋯.
 * Phones draw their own header in the conversation's page (above).
 */
export function SessionHeader({
  identity,
  summary,
  harness,
  project,
  cancelling,
  level,
  demo,
  phone,
  onBack,
  onRename,
  inspectorOpen,
  onInspector,
  inspectorRef,
  sessionMenu,
  menu,
  connection,
  onRefresh,
  onFiles,
  filesOpen,
  slots = {},
}: {
  identity?: string
  summary?: TaskSummary
  harness?: Pick<HarnessInfo, 'id' | 'name' | 'source'>
  /** The basename of the session's working directory. */
  project?: string
  cancelling: boolean
  /** Who enforces the session's permissions; omitted on Hosts that do not report it. Only full access (L3) shows here:
   * asking before each step is the default, so the inspector alone states it. */
  level?: 'L1' | 'L3'
  demo: boolean
  phone: boolean
  /** Phones: back to the session list. */
  onBack?: () => void
  onRename?: () => void
  /** The panel is shown, beside the conversation or in its place. */
  inspectorOpen: boolean
  onInspector: () => void
  /** The toggle, which takes focus back when the page of 会话信息 closes. */
  inspectorRef?: RefObject<HTMLButtonElement | null>
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
  const source = [identity ?? (harness ? harnessName(harness) : undefined), summary?.branch && escapeSecurityText(summary.branch)]
    .filter(Boolean)
    .join(' · ')
  if (phone)
    return (
      <PhoneTopBar
        summary={summary}
        source={[
          identity ?? (harness ? [harnessName(harness), project].filter(Boolean).join(' · ') : undefined),
          summary?.branch && escapeSecurityText(summary.branch),
        ]
          .filter(Boolean)
          .join(' · ')}
        cancelling={cancelling}
        level={level}
        demo={demo}
        onBack={onBack}
        inspectorOpen={inspectorOpen}
        onInspector={onInspector}
        inspectorRef={inspectorRef}
        menu={menu}
        connection={connection}
        onRefresh={onRefresh}
        changes={slots.changes}
      />
    )
  const desktop = currentShell() !== null
  return (
    <header className="topbar">
      <div className="topbar-title">
        {summary && project && (
          <span className="topbar-crumb" title={project}>
            <Folder size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            <span className="topbar-source-text">{project}</span>
            <span className="topbar-crumb-separator" aria-hidden="true">
              /
            </span>
          </span>
        )}
        <h1 title={summary ? title : undefined}>
          <TitleMenu title={title} sections={summary ? sessionMenu : []} />
        </h1>
        {summary && onRename && <IconButton className="topbar-rename" label="重命名会话" icon={Pencil} size="xs" onClick={onRename} />}
        {summary && harness && source && (
          <span className="topbar-source" title={source}>
            <HarnessTile harness={harness} size={16} />
            <span className="topbar-source-text">{source}</span>
          </span>
        )}
        {summary && sessionPill(summary, cancelling)}
      </div>
      <div className="topbar-actions">
        <ConnectionPill connection={connection} onRefresh={onRefresh} />
        {summary && level === 'L3' && fullAccessPill}
        {demo && (
          <StatusPill tone="warn" title="此会话使用演示模型，回复由本地脚本生成">
            演示模型
          </StatusPill>
        )}
        {slots.gitAction}
        {slots.terminal && <Toggle toggle={slots.terminal} />}
        {slots.changes && <Toggle toggle={slots.changes} />}
        {onFiles && <IconButton label="浏览项目文件" icon={Folder} pressed={filesOpen} onClick={onFiles} />}
        {summary && (
          <IconButton
            ref={inspectorRef}
            label="会话信息"
            icon={PanelRight}
            shortcut={desktop ? '⌥⌘B' : 'Alt Shift B'}
            pressed={inspectorOpen}
            onClick={onInspector}
          />
        )}
        {menu.length > 0 && (
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
    harnessName: identityName,
    inspectorToggle,
    canBrowseFiles,
    browseFiles,
    filesVisible,
    topHarness,
    project,
    selectedId,
    stopping,
    access,
    level,
    demo,
    phone,
    back,
    setRenaming,
    columnOpen,
    pageMode,
    infoPage,
    toggleInspector,
    titleMenu,
    topMenu,
    connection,
    resync,
    canViewChanges,
    changesOpen,
    toggleChanges,
    fileTabs,
    current,
  } = shell
  const desktop = currentShell() !== null
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
      identity={summary?.personal ? identityName : undefined}
      inspectorRef={inspectorToggle}
      onFiles={canBrowseFiles ? browseFiles : undefined}
      filesOpen={filesVisible}
      summary={summary}
      harness={topHarness}
      project={project}
      cancelling={selectedId !== null && stopping.has(selectedId)}
      level={access.legacy ? undefined : level}
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
      inspectorOpen={columnOpen || (pageMode && infoPage)}
      onInspector={toggleInspector}
      sessionMenu={titleMenu}
      menu={topMenu}
      connection={connection}
      onRefresh={() => {
        void resync()
      }}
      slots={
        canViewChanges
          ? {
              changes: {
                label: '变更',
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
