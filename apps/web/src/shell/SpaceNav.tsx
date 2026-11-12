import type { ReactNode } from 'react'
import { FolderPlus, Send } from 'lucide-react'
import { GENERAL_AGENT_ID, type AppSnapshot } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  Icon,
  IconButton,
  SegmentedControl,
  CodeGlyph,
  PluginsGlyph,
  LaptopGlyph,
  PlusGlyph,
  SearchGlyph,
  SettingsGlyph,
  NewSessionGlyph,
  CloseGlyph,
} from '@latch/ui'
import { AgentAvatar, AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { ComputerMenu } from '../components/Computers.tsx'
import { useComputers } from '../core/computers.ts'
import { deviceAccess } from '../core/permissions.ts'
import { DEVICE_OFFLINE } from '../core/hostState.ts'
import { computerName } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import type { Space } from '../sessions.ts'
import { shortcutButtonKeys } from '../workbenchShortcuts.ts'
import { askDelegateFocus } from '../agents/delegateFocus.ts'
import type { ShellState } from './useShellLayout.tsx'

/** The switch's state: the place shown (none on pages both places share), the way to a place, and where something waits. */
export interface SpacesProps {
  space: Space | null
  onSpace: (space: Space) => void
  waits: Record<Space, boolean>
}

/** The places' names and glyphs, wherever a way to them is drawn. */
const SPACE_LABELS: Record<Space, string> = { code: 'Code', agents: '我的 Agent' }

/** The place's glyph; `solid` where it is the place you are in. */
function SpaceGlyph({ space, size = 16, solid = false }: { space: Space; size?: 16 | 20; solid?: boolean }) {
  return <Icon icon={space === 'agents' ? AgentsGlyph : CodeGlyph} size={size} solid={solid} />
}

/** The amber dot on the other place while something waits for you there. */
const WAITS_TITLE: Record<Space, string> = { code: 'Code 里有等你处理的会话', agents: '我的 Agent 里有等你处理的会话' }

/**
 * Code | 我的 Agent across the top of the sidebar: two places, not a filter. Choosing one changes the primary action, the
 * list and the home page with it. The place you are not in carries an amber dot while something waits there.
 */
function SpaceSwitch({ space, onSpace, waits }: SpacesProps) {
  const option = (value: Space) => {
    const dot = waits[value] && value !== space
    return {
      value,
      label: SPACE_LABELS[value],
      // The dot rides the glyph's corner, as on the shut sidebar's buttons, so the place's name keeps its room.
      icon: (
        <span className="space-glyph">
          <SpaceGlyph space={value} solid={value === space} />
          {dot && <span className="space-dot" aria-hidden="true" />}
        </span>
      ),
      ...(dot ? { title: WAITS_TITLE[value] } : {}),
    }
  }
  return (
    <SegmentedControl
      className="space-switch"
      label="Code 与我的 Agent"
      size="md"
      value={space}
      options={[option('code'), option('agents')]}
      onValueChange={onSpace}
    />
  )
}

/**
 * The places as two icon buttons, where the sidebar is shut: the title row keeps the way between them in reach, with the
 * same amber dot.
 */
export function SpaceButtons({ space, onSpace, waits }: SpacesProps) {
  const desktop = currentShell() !== null
  return (
    <span className="space-buttons" role="group" aria-label="Code 与我的 Agent">
      {(['code', 'agents'] as const).map(value => {
        const dot = waits[value] && value !== space
        return (
          <IconButton
            key={value}
            label={SPACE_LABELS[value]}
            icon={value === 'agents' ? AgentsGlyph : CodeGlyph}
            pressed={value === space}
            {...(dot ? { tooltip: WAITS_TITLE[value], badge: <span className="space-dot" /> } : {})}
            {...(desktop ? { shortcut: value === 'code' ? '⇧⌘1' : '⇧⌘2' } : {})}
            onClick={() => {
              if (value !== space) onSpace(value)
            }}
          />
        )
      })}
    </span>
  )
}

/** The keys that press 新会话 or 搜索, as caps on the row; a drawer is for touch and narrow windows, so it has none. */
function capsOf(id: 'new' | 'palette', drawer: boolean) {
  const keys = drawer ? null : shortcutButtonKeys(id, currentShell() !== null)
  return keys ? { keys } : {}
}

/** Code's primary: 新会话, on (pressed) while the new-session page is open. */
export function NewSessionRow({ onNew, active, drawer }: { onNew: () => void; active: boolean; drawer: boolean }) {
  return (
    <Button
      variant="ghost"
      className="sidebar-nav-row"
      aria-label="新建会话"
      data-space-primary=""
      aria-pressed={drawer ? undefined : active}
      {...capsOf('new', drawer)}
      onClick={onNew}>
      <NewSessionGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      <span>新会话</span>
    </Button>
  )
}

/**
 * 我的 Agent's primary: 新对话…, a choice of Agent (通用 first); choosing one opens a new topic with it, the input ready.
 * Without an Agent of your own the choice still has 通用, and 新建 Agent. The same key as 新会话 opens it.
 */
function DelegateRow({
  snapshot,
  drawer,
  canRun,
  offline,
  onDelegate,
  onNew,
  compact = false,
}: {
  snapshot: Pick<AppSnapshot, 'customAgents' | 'device'>
  drawer: boolean
  canRun: boolean
  offline: boolean
  onDelegate: (id: string) => void
  onNew: () => void
  /** The shut sidebar's title row: an icon button. */
  compact?: boolean
}) {
  const agents = snapshot.customAgents ?? []
  const sections: MenuSection[] = [
    {
      id: 'agents',
      items: [
        ...(snapshot.device.dataScope === 'all'
          ? [
              {
                id: GENERAL_AGENT_ID,
                label: '通用',
                leading: <AgentAvatar avatar="general" size={16} />,
                ...(offline ? { disabled: true, disabledReason: 'Mac 不在线' } : {}),
                onSelect: () => {
                  onDelegate(GENERAL_AGENT_ID)
                },
              },
            ]
          : []),
        ...agents.map(agent => ({
          id: agent.id,
          label: agent.name,
          leading: <AgentAvatar avatar={agent.avatar} size={16} />,
          ...(offline
            ? { disabled: true, disabledReason: 'Mac 不在线' }
            : agent.available
              ? {}
              : { disabled: true, disabledReason: agent.unavailableReason ?? '现在不能开始' }),
          onSelect: () => {
            onDelegate(agent.id)
          },
        })),
      ],
    },
    ...(canRun
      ? [
          {
            id: 'new',
            items: [
              {
                id: 'new-agent',
                label: '新建 Agent',
                leading: <PlusGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />,
                ...(offline ? { disabled: true, disabledReason: 'Mac 不在线' } : {}),
                onSelect: onNew,
              },
            ],
          },
        ]
      : []),
  ].filter(section => section.items.length > 0)
  if (!canRun || sections.length === 0) return null
  return (
    <Menu
      label="和谁对话"
      sections={sections}
      trigger={props =>
        compact ? (
          <IconButton {...props} data-delegate-trigger="" data-space-primary="" label="新对话…" icon={Send} />
        ) : (
          <Button
            {...props}
            variant="ghost"
            className="sidebar-nav-row"
            data-delegate-trigger=""
            data-space-primary=""
            {...capsOf('new', drawer)}>
            <Send size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span>新对话…</span>
          </Button>
        )
      }
    />
  )
}

/**
 * The top of the sidebar on wide windows, the same in both places: the computer (where the page is not the Latch app on
 * it, or a menu of computers in the desktop app), the switch between the places, the place's primary and 搜索.
 */
export function NavTop({
  snapshot,
  spaces,
  primary,
  onSearch,
  drawer,
  onClose,
  onManageComputers,
  className,
}: {
  snapshot: AppSnapshot
  /** Absent where the Host has no 我的 Agent: there is only Code, and no switch. */
  spaces?: SpacesProps | undefined
  primary: ReactNode
  onSearch: () => void
  drawer: boolean
  onClose?: (() => void) | undefined
  onManageComputers?: (() => void) | undefined
  className?: string
}) {
  const computers = useComputers()
  const several = computers !== undefined && computers.computers.length > 1
  // 「这台电脑」 is only the Latch app on the Host's own socket; a loopback browser is told which computer it is reading.
  const remote = !deviceAccess(snapshot, currentShell()).local
  return (
    <div className={className ? `sidebar-top ${className}` : 'sidebar-top'}>
      {several ? (
        <ComputerMenu snapshot={snapshot} view={computers} onManage={onManageComputers} />
      ) : (
        remote && (
          <p className="sidebar-host" title={computerName(snapshot.hostName)}>
            <LaptopGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span className="sidebar-host-name">{computerName(snapshot.hostName)}</span>
          </p>
        )
      )}
      {spaces && (
        <div className="sidebar-nav-line">
          <SpaceSwitch {...spaces} />
          {drawer && onClose && <IconButton label="关闭会话列表" icon={CloseGlyph} onClick={onClose} />}
        </div>
      )}
      <div className="sidebar-nav-line">
        {primary}
        {drawer && onClose && !spaces && <IconButton label="关闭会话列表" icon={CloseGlyph} onClick={onClose} />}
      </div>
      <Button variant="ghost" className="sidebar-nav-row" aria-label="搜索" {...capsOf('palette', drawer)} onClick={onSearch}>
        <SearchGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
        <span>搜索</span>
      </Button>
    </div>
  )
}

/** Something wrong with reaching the Mac: the sentence for the dot beside 设置, and how bad it is. A healthy state has none. */
export function connectionTrouble(
  connection: ConnectionStatus,
  hostProblem: { text: string } | null,
): { tone: 'warn' | 'error'; text: string } | null {
  if (connection === 'offline') return { tone: 'warn', text: DEVICE_OFFLINE }
  if (hostProblem) return { tone: 'error', text: hostProblem.text }
  if (connection === 'reconnecting') return { tone: 'warn', text: '正在重新连接' }
  return null
}

/**
 * The foot, shared by both places and always in reach: 添加项目 (Code, in the Latch app on this Mac), 应用 where plugin
 * pages are applied, and 设置 with the trouble dot while the Mac cannot be reached as it should.
 */
export function NavFoot({
  apps,
  settings,
  trouble,
  onCreateProject,
}: {
  apps?: { current: boolean; onOpen: () => void } | undefined
  settings?: (() => void) | undefined
  trouble: { tone: 'warn' | 'error'; text: string } | null
  onCreateProject?: (() => void) | undefined
}) {
  const desktop = currentShell() !== null
  return (
    <nav className="sidebar-foot" aria-label="主导航">
      {onCreateProject && (
        <button type="button" className="sidebar-nav-row sidebar-add-project" onClick={onCreateProject}>
          <FolderPlus size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span>添加项目</span>
        </button>
      )}
      {apps && (
        <button
          type="button"
          className="sidebar-nav-row sidebar-foot-row"
          aria-current={apps.current ? 'page' : undefined}
          onClick={apps.onOpen}>
          <PluginsGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span>应用</span>
        </button>
      )}
      {(settings || trouble) && (
        <div className="sidebar-nav-line sidebar-foot-line">
          {settings ? (
            <Button
              variant="ghost"
              className="sidebar-nav-row sidebar-settings"
              icon={SettingsGlyph}
              shortcut={desktop ? '⌘,' : 'Alt ,'}
              onClick={settings}>
              设置
            </Button>
          ) : (
            <span className="sidebar-foot-spacer" />
          )}
          {trouble && (
            <span className="sidebar-trouble" data-tone={trouble.tone} role="status" title={trouble.text}>
              <span className="sr-only">{trouble.text}</span>
            </span>
          )}
        </div>
      )}
    </nav>
  )
}

/** The switch's state and way, where the Host has 我的 Agent. */
export function shellSpaces(shell: Pick<ShellState, 'entries' | 'space' | 'goSpace' | 'waits' | 'route'>): SpacesProps | undefined {
  if (!shell.entries.includes('agents')) return undefined
  // 应用 and 设置 belong to both places: neither segment is chosen there, and either goes back to its place.
  const shared = shell.route.entry === 'apps' || shell.route.entry === 'settings'
  return { space: shared ? null : shell.space, onSpace: shell.goSpace, waits: shell.waits }
}

/** 新对话… as the shell draws it: a choice of Agent, which opens a new topic with it, the input ready. */
export function ShellDelegate({ shell, compact = false }: { shell: ShellState; compact?: boolean }) {
  return (
    <DelegateRow
      snapshot={shell.snapshot}
      drawer={shell.drawerMode}
      canRun={shell.access.scopes.has('run')}
      offline={shell.connection === 'offline'}
      compact={compact}
      onDelegate={id => {
        askDelegateFocus()
        shell.openMyAgent({ id, topic: 'new' })
      }}
      onNew={() => {
        shell.openMyAgent({ id: 'new' })
      }}
    />
  )
}

/** The foot as the shell draws it, from any of the sidebar's places. */
export function ShellNavFoot({ shell, onCreateProject }: { shell: ShellState; onCreateProject?: (() => void) | undefined }) {
  return (
    <NavFoot
      apps={shell.entries.includes('apps') ? { current: shell.route.entry === 'apps', onOpen: () => shell.openApp() } : undefined}
      settings={shell.entries.includes('settings') ? () => shell.goEntry('settings') : undefined}
      trouble={connectionTrouble(shell.connection, shell.hostProblem)}
      onCreateProject={onCreateProject}
    />
  )
}
