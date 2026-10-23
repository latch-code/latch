import { Ellipsis, Menu as MenuIcon, PanelRight, RefreshCw, SquarePen } from 'lucide-react'
import type { TaskSummary } from '../../shared/types.ts'
import { LEVEL_LABELS } from '../permissions.ts'
import type { ConnectionStatus } from '../useHarness.ts'
import { ICON_STROKE } from '../icons.tsx'
import { Menu, type MenuSection } from './overlays.tsx'
import { connectionLabels } from './Sidebar.tsx'
import { Badge, IconButton, StatusPill } from './ui.tsx'

/** Session identity and its controls; the connection shows here only when it is not healthy. */
export function TopBar({ summary, cancelling, level, runtime, demo, phone, drawerOpen, onDrawer, onNew, inspectorOpen, onInspector, menu, connection, onRefresh }: {
  summary?: TaskSummary
  cancelling: boolean
  /** Who enforces the session's permissions; omitted on Hosts that do not report it. */
  level?: 'L1' | 'L3'
  /** "Harness · model" for the session. */
  runtime?: string
  demo: boolean
  phone: boolean
  drawerOpen: boolean
  onDrawer?: () => void
  onNew: () => void
  inspectorOpen: boolean
  onInspector: () => void
  menu: MenuSection[]
  connection: ConnectionStatus
  onRefresh: () => void
}) {
  return <header className="topbar">
    {onDrawer && <IconButton label="打开会话列表" icon={MenuIcon} aria-controls="session-navigation" aria-expanded={drawerOpen} onClick={onDrawer} />}
    <div className="topbar-title">
      <h1 title={summary?.title}>{summary ? summary.title || '未命名会话' : '新会话'}</h1>
      {summary && <StatusPill status={summary.status} cancelling={cancelling} />}
    </div>
    <div className="topbar-actions">
      {/* Phones keep the title readable: the state shows as a dot, named by its label. */}
      {connection !== 'connected' && <button type="button" className={`connection-pill connection-${connection}${phone ? ' is-compact' : ''}`}
        aria-label={connectionLabels[connection]} title={`${connectionLabels[connection]} · 同步最新状态`} onClick={onRefresh}>
        <i aria-hidden="true" />{!phone && connectionLabels[connection]}<RefreshCw size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </button>}
      {summary && level === 'L3' && <Badge tone="warn" title={LEVEL_LABELS.L3}>{phone ? 'L3' : LEVEL_LABELS.L3}</Badge>}
      {summary && level === 'L1' && !phone && <span className="level-badge" title={LEVEL_LABELS.L1}>{LEVEL_LABELS.L1}</span>}
      {summary && runtime && !phone && <span className="runtime-badge" title={runtime}>{runtime}</span>}
      {demo && <Badge tone="warn" title="此会话使用演示模型，回复由本地脚本生成">{phone ? '演示' : '演示模型'}</Badge>}
      {phone && <IconButton label="新建会话" icon={SquarePen} onClick={onNew} />}
      {summary && !phone && <IconButton label="会话详情" icon={PanelRight} pressed={inspectorOpen} onClick={onInspector} />}
      {summary && <Menu label="会话操作" placement="bottom-end" sections={menu}
        trigger={props => <button type="button" className="icon-button" aria-label="会话操作" title="会话操作" {...props}><Ellipsis size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>} />}
    </div>
  </header>
}
