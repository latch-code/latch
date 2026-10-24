import type { RefObject } from 'react'
import { ChevronDown, Ellipsis, Inbox, Menu as MenuIcon, PanelLeft, PanelRight, RefreshCw, ShieldAlert, SquarePen } from 'lucide-react'
import type { HarnessInfo, TaskSummary } from '@latch/protocol'
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

/**
 * Session identity and its controls. Left: the title (a button that opens the session's menu), then where it runs
 * (the harness tile, harness · project) and its state when that is not the default. Right: the connection only when
 * it is not healthy, full access, the demo model, the inspector toggle and ⋯.
 */
export function TopBar({
  summary,
  harness,
  project,
  cancelling,
  level,
  demo,
  phone,
  drawerOpen,
  onDrawer,
  onNew,
  sidebarCollapsed,
  onExpandSidebar,
  expandRef,
  approvals = 0,
  onApprovals,
  inspectorOpen,
  onInspector,
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
  drawerOpen: boolean
  onDrawer?: () => void
  onNew: () => void
  /** From 1024px, the sidebar is shut: the top bar offers to open it and to start a new session. */
  sidebarCollapsed?: boolean
  /** Present from 1024px, where the sidebar can be shut. */
  onExpandSidebar?: () => void
  expandRef?: RefObject<HTMLButtonElement | null>
  /** While the sidebar is shut, what waits for the person stays one click away here. */
  approvals?: number
  onApprovals?: () => void
  inspectorOpen: boolean
  onInspector: () => void
  /** Rename, pin, archive, export and delete: the title button's menu. */
  sessionMenu: MenuSection[]
  /** ⋯: the session's actions and 同步最新状态. */
  menu: MenuSection[]
  connection: ConnectionStatus
  onRefresh: () => void
}) {
  // The button shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  const title = summary ? summary.title || '未命名会话' : '新会话'
  const source = harness ? [harness.name, project].filter(Boolean).join(' · ') : undefined
  return (
    <header className="topbar">
      {onDrawer && (
        <IconButton label="打开会话列表" icon={MenuIcon} aria-controls="session-navigation" aria-expanded={drawerOpen} onClick={onDrawer} />
      )}
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
          {summary && sessionMenu.length > 0 && !phone ? (
            <Menu
              label={`会话：${title}`}
              placement="bottom-start"
              sections={sessionMenu}
              trigger={props => (
                <button {...props} type="button" className="topbar-title-button">
                  <span className="topbar-title-text">{title}</span>
                  <ChevronDown className="topbar-title-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                </button>
              )}
            />
          ) : (
            <span className="topbar-title-text">{title}</span>
          )}
        </h1>
        {summary && harness && source && !phone && (
          <span className="topbar-source" title={source}>
            <HarnessTile harness={harness} size={16} />
            <span className="topbar-source-text">{source}</span>
          </span>
        )}
        {summary && sessionPill(summary, cancelling)}
      </div>
      <div className="topbar-actions">
        {connectionProblem(connection) && (
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
        )}
        {summary && level === 'L3' && (
          <StatusPill tone="warn" className="level-pill" title={LEVEL_LABELS.L3}>
            <ShieldAlert size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            完全访问
          </StatusPill>
        )}
        {demo && (
          <StatusPill tone="warn" title="此会话使用演示模型，回复由本地脚本生成">
            {phone ? '演示' : '演示模型'}
          </StatusPill>
        )}
        {phone && <IconButton label="新建会话" icon={SquarePen} onClick={onNew} />}
        {summary && !phone && <IconButton label="会话详情" icon={PanelRight} pressed={inspectorOpen} onClick={onInspector} />}
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
