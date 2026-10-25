import type { RefObject } from 'react'
import { ChevronDown, ChevronLeft, Ellipsis, Inbox, PanelLeft, PanelRight, RefreshCw, ShieldAlert, SquarePen } from 'lucide-react'
import type { HarnessInfo, TaskSummary } from '@latch/protocol'
import { harnessName } from '../composerChoice.ts'
import { LEVEL_LABELS } from '../core/permissions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { HarnessTile } from './BrandTile.tsx'
import { Menu, type MenuSection } from './overlays.tsx'
import { connectionLabels, connectionProblem } from './Sidebar.tsx'
import { Count, ICON_STROKE, IconButton, StatusPill, useLivePrevious } from '@latch/ui'

/** The session's state when it is not the default: running and done say nothing here (the run bar says running). */
function sessionPill(summary: TaskSummary, cancelling: boolean) {
  if (cancelling) return <StatusPill tone="neutral">正在取消</StatusPill>
  if (summary.status === 'failed') return <StatusPill tone="err">失败</StatusPill>
  if (summary.status === 'cancelled') return <StatusPill tone="neutral">已取消</StatusPill>
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
  <StatusPill tone="warn" className="level-pill" title={LEVEL_LABELS.L3}>
    <ShieldAlert size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
    完全访问
  </StatusPill>
)

/**
 * A phone's session page header, on the ground (52): the way back to the session list, the title in the middle (a
 * button with chevron-down that opens the session's menu, 同步最新状态 included) over where it runs and its states that
 * are not the default, and 会话信息. A session just started is pushed before the Host lists it: until then the header
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
}: {
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
  return (
    <header className="topbar" data-phone="">
      {onBack && <IconButton size="lg" className="topbar-back" label="返回会话列表" icon={ChevronLeft} onClick={onBack} />}
      <div className="topbar-title">
        <h1 title={title}>
          <TitleMenu title={title} sections={summary ? menu : []} />
        </h1>
        {(where || state || fullAccess || demo || connectionProblem(connection)) && (
          <div className="topbar-subline">
            {where && <span className="topbar-source-text">{where}</span>}
            {state}
            {fullAccess && fullAccessPill}
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
        <IconButton ref={inspectorRef} size="lg" label="会话信息" icon={PanelRight} pressed={inspectorOpen} onClick={onInspector} />
      )}
    </header>
  )
}

/**
 * Session identity and its controls. Left: the title (a button that opens the session's menu), then where it runs
 * (the harness tile, harness · project) and its state when that is not the default. Right: the connection only when
 * it is not healthy, full access, the demo model, the inspector toggle and ⋯. Phones draw their own header (above).
 */
export function TopBar({
  summary,
  harness,
  project,
  cancelling,
  level,
  demo,
  phone,
  onBack,
  onNew,
  sidebarCollapsed,
  onExpandSidebar,
  expandRef,
  approvals = 0,
  onApprovals,
  inspectorOpen,
  onInspector,
  inspectorRef,
  sessionMenu,
  menu,
  connection,
  onRefresh,
}: {
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
  onNew: () => void
  /** From 1024px, the sidebar is shut: the top bar offers to open it and to start a new session. */
  sidebarCollapsed?: boolean
  /** Present from 1024px, where the sidebar can be shut. */
  onExpandSidebar?: () => void
  expandRef?: RefObject<HTMLButtonElement | null>
  /** While the sidebar is shut, what waits for the person stays one click away here. */
  approvals?: number
  onApprovals?: () => void
  /** 会话信息 is shown, as the column beside the paper or as a page in the conversation's place. */
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
}) {
  // The button shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  const title = summary ? summary.title || '未命名会话' : '新会话'
  const source = harness ? [harnessName(harness), project].filter(Boolean).join(' · ') : undefined
  if (phone)
    return (
      <PhoneTopBar
        summary={summary}
        source={source}
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
      />
    )
  return (
    <header className="topbar">
      {onExpandSidebar && (
        // Kept in place from 1024px and unfolded in step with the sidebar's track, so the title glides instead of jumping.
        <div
          className="topbar-sidebar-actions"
          data-open={sidebarCollapsed ? '' : undefined}
          inert={!sidebarCollapsed || undefined}
          aria-hidden={sidebarCollapsed ? undefined : true}>
          <div className="topbar-sidebar-actions-inner">
            <IconButton
              ref={expandRef}
              label="展开侧栏"
              icon={PanelLeft}
              aria-controls="session-navigation"
              aria-expanded={false}
              onClick={onExpandSidebar}
            />
            <IconButton label="新建会话" icon={SquarePen} pressed={summary === undefined} onClick={onNew} />
            {approvals > 0 && onApprovals && (
              <IconButton
                label={`${approvals} 项等你处理`}
                icon={Inbox}
                badge={<Count tone="warn" value={approvals} from={approvalsBefore} />}
                onClick={onApprovals}
              />
            )}
          </div>
        </div>
      )}
      <div className="topbar-title">
        <h1 title={summary ? title : undefined}>
          <TitleMenu title={title} sections={summary ? sessionMenu : []} />
        </h1>
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
        {summary && <IconButton ref={inspectorRef} label="会话信息" icon={PanelRight} pressed={inspectorOpen} onClick={onInspector} />}
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
