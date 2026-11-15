import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { canDelegate } from '../agents/model.ts'
import { ArrowLeft, BarChart3, Cable } from 'lucide-react'
import type { AppSnapshot } from '@latch/protocol'
import { useViewport } from '../breakpoints.ts'
import { deviceAccess, type DeviceAccess } from '../core/permissions.ts'
import { computerName, SETTINGS_ADMIN_HIDDEN } from '../core/securityCopy.ts'
import { currentShell, shellComputers } from '../core/shell.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { SettingsNavigationProvider, type SettingsNavigation } from './navigation.tsx'
import { deferredComponent } from '../components/DeferredContent.tsx'
import {
  ICON_STROKE,
  Icon,
  IconButton,
  Kbd,
  SearchField,
  type IconComponent,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  FolderGlyph,
  InfoGlyph,
  KeyboardGlyph,
  LaptopGlyph,
  LockGlyph,
  DevicesGlyph,
  PluginsGlyph,
  SettingsGlyph,
  HarnessGlyph,
  ModelGlyph,
} from '@latch/ui'
import { settingsSectionsAt, type AgentPageTarget, type PageEntry, type SettingsSection } from '../shell/routes.ts'

export type { SettingsSection }

const AboutSettings = deferredComponent(async () => ({ default: (await import('./AboutSettings.tsx')).AboutSettings }), '关于')
const AgentsSettings = deferredComponent(async () => ({ default: (await import('./AgentsSettings.tsx')).AgentsSettings }), '设置')
const PhoneDevicesPage = deferredComponent(
  async () => ({ default: (await import('./devices/PhoneDevicesPage.tsx')).PhoneDevicesPage }),
  '设备',
)
const ComputersSettings = deferredComponent(async () => ({ default: (await import('./ComputersSettings.tsx')).ComputersSettings }), '电脑')
const GeneralSettings = deferredComponent(async () => ({ default: (await import('./GeneralSettings.tsx')).GeneralSettings }), '通用设置')
const PluginsSettings = deferredComponent(async () => ({ default: (await import('./PluginsSettings.tsx')).PluginsSettings }), '插件设置')
const ProvidersSettings = deferredComponent(
  async () => ({ default: (await import('./ProvidersSettings.tsx')).ProvidersSettings }),
  '模型服务设置',
)
const ModelUsagePage = deferredComponent(async () => ({ default: (await import('./ModelUsagePage.tsx')).ModelUsagePage }), '用量')
const McpSettings = deferredComponent(async () => ({ default: (await import('./McpSettings.tsx')).McpSettings }), 'MCP')
const ShortcutsSettings = deferredComponent(
  async () => ({ default: (await import('./ShortcutsSettings.tsx')).ShortcutsSettings }),
  '快捷键',
)
const WorkspacesSettings = deferredComponent(
  async () => ({ default: (await import('./WorkspacesSettings.tsx')).WorkspacesSettings }),
  '项目设置',
)

/** What each section holds, so 搜索设置 finds a setting by the words on its row. */
const SEARCH_TERMS: Partial<Record<SettingsSection, string>> = {
  general: '外观 主题 深色 浅色 布局 侧栏 顶栏 按项目 按状态 发送消息 回车 新文档 自动打开 通知 唤醒 名称',
  providers: '服务 密钥 key 添加服务 添加模型服务 用量 tokens 显示的模型 已确认的地址 地址 出站',
  usage: '用量 tokens 请求 失败 花费 预算',
  engines: '已安装 可以安装 怎么装 自定义启动方式 启动方式 环境变量 命令 agent',
  mcp: 'mcp 服务器 工具 连接器 npx 命令',
  workspaces: '文件夹 添加项目 新建项目 快照',
  plugins: '工具 技能 扩展',
  shortcuts: '键盘',
  devices: '设备 手机 连接手机 二维码 配对 重命名 移除 撤销 浏览器 在浏览器中打开 关于连接 policy 开始新会话',
  computers: '添加电脑 其他电脑 移除 切换 打开',
  about: '版本 许可与条款',
}

/** The sections a search names: by their label or by the words on their rows, case aside. */
export function searchSections<T extends { id: SettingsSection; label: string }>(list: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...list]
  return list.filter(section => `${section.label} ${SEARCH_TERMS[section.id] ?? ''}`.toLocaleLowerCase().includes(needle))
}

/**
 * `admin`: needs the device's 管理此 Host scope. `catalog`: needs the Host APIs that come with a snapshot catalog.
 * `secured`: needs a Host with device confirmation (its policy and device APIs); older Hosts lack them. `shell`: needs the
 * desktop app's list of computers.
 */
const sections: Array<{
  id: SettingsSection
  label: string
  icon: IconComponent
  admin: boolean
  catalog?: boolean
  secured?: boolean
  shell?: boolean
  /** A Host feature the section's routes need. */
  feature?: 'mcp' | 'modelUsage'
}> = [
  { id: 'general', label: '通用', icon: SettingsGlyph, admin: false },
  { id: 'providers', label: '模型', icon: ModelGlyph, admin: true, catalog: true },
  { id: 'usage', label: '用量', icon: BarChart3, admin: false, catalog: true, feature: 'modelUsage' },
  { id: 'engines', label: 'Harness', icon: HarnessGlyph, admin: true, catalog: true },
  { id: 'mcp', label: 'MCP', icon: Cable, admin: true, catalog: true, feature: 'mcp' },
  { id: 'workspaces', label: '项目', icon: FolderGlyph, admin: true, catalog: true },
  { id: 'plugins', label: '插件', icon: PluginsGlyph, admin: true },
  { id: 'devices', label: '设备', icon: DevicesGlyph, admin: false, secured: true },
  { id: 'computers', label: '电脑', icon: LaptopGlyph, admin: false, shell: true },
  { id: 'shortcuts', label: '快捷键', icon: KeyboardGlyph, admin: false },
  { id: 'about', label: '关于', icon: InfoGlyph, admin: false },
]

export const sectionLabel = (id: SettingsSection): string => sections.find(section => section.id === id)!.label

/** The line under the sections of a device that lacks 管理此 Host: some sections are hidden, and where to grant it. */
export function hiddenSectionsCaption(snapshot: AppSnapshot, access: DeviceAccess): string | undefined {
  if (access.admin || access.legacy) return undefined
  return sections.some(section => section.admin && (snapshot.catalog || !section.catalog))
    ? SETTINGS_ADMIN_HIDDEN(computerName(snapshot.hostName))
    : undefined
}

export function settingsSections(snapshot: AppSnapshot, access: DeviceAccess = deviceAccess(snapshot, currentShell())): SettingsSection[] {
  return sections
    .filter(
      section =>
        (access.admin || !section.admin)
        && (snapshot.catalog || !section.catalog)
        && (!access.legacy || !section.secured)
        && (!section.shell || shellComputers() !== null)
        && (!section.feature || snapshot.catalog?.features?.[section.feature] === true),
    )
    .map(section => section.id)
}

/** A remembered section may disappear while its module loads; hidden permissions must unmount its body immediately. */
export function settingsPanel(
  ids: readonly SettingsSection[],
  chosen: SettingsSection | null,
  phone: boolean,
  shown: SettingsSection | null,
): {
  active: SettingsSection | null
  panel: SettingsSection | null
} {
  const active = chosen && ids.includes(chosen) ? chosen : phone ? null : (ids[0] ?? null)
  const panel = active ?? (shown && ids.includes(shown) ? shown : null)
  return { active, panel }
}

/**
 * 设置: its sections where the sidebar stands, under the way back and the search, and the chosen one in the main area
 * under its name. 设备 is a section like the others; a device opens as a page inside it. The page covers the session's
 * columns without unmounting them, so the conversation keeps its state. On phones the section list is the root and a
 * section, and each page inside it, is pushed over the level before.
 */
export function SettingsPage({
  snapshot,
  access: given,
  section: chosen = null,
  initialProjectId,
  initialAgent,
  onBack,
  onSection,
  onChanged,
  onOpenSession,
  onOpenApp,
}: {
  snapshot: AppSnapshot
  access?: DeviceAccess
  /** Always 设置; the shell names the entry it shows. */
  entry?: PageEntry
  /** The chosen section; absent, a wide window shows the first and a phone shows the list. */
  section?: SettingsSection | null
  initialProjectId?: string
  initialAgent?: AgentPageTarget
  /** The title row; the page names itself above its content instead, so it leaves the row empty. */
  titleSlot?: HTMLElement | null
  /** Not drawn here: the count of what waits is the space switch's and the home's. */
  waiting?: number
  /** Back to the sessions, on wide windows. */
  onBack?: () => void
  /** Opens a section. Without an argument, goes back to the section list. */
  onSection: (section?: SettingsSection) => void
  onChanged: () => void
  onOpenSession?: (id: string) => void
  /** Opens an applied plugin page (设置 › 插件's 新应用). */
  onOpenApp?: (target: { pluginId: string; appId: string }) => void
}) {
  const phone = useViewport() === 'phone'
  const access = given ?? deviceAccess(snapshot, currentShell())
  const allowed = settingsSections(snapshot, access)
  const ids = settingsSectionsAt(phone).filter(id => allowed.includes(id))
  const available = ids.flatMap(id => sections.filter(section => section.id === id))
  const [query, setQuery] = useState('')
  const found = searchSections(available, query)
  const searchable = available.length > 1
  const search = useRef<HTMLDivElement>(null)
  const caption = hiddenSectionsCaption(snapshot, access)
  // On phones the last section stays laid out under the list, so going back slides it away instead of blanking it.
  const [shown, setShown] = useState<SettingsSection | null>(chosen ?? (phone ? null : (ids[0] ?? null)))
  const { active, panel } = settingsPanel(ids, chosen, phone, shown)
  const chosenAllowed = chosen === null || ids.includes(chosen)
  const shownAllowed = shown === null || ids.includes(shown)
  useLayoutEffect(() => {
    if (!shownAllowed) setShown(null)
    if (!chosenAllowed || !shownAllowed) {
      if (document.activeElement === document.body)
        (tabs.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? tabs.current?.querySelector('button'))?.focus({
          preventScroll: true,
        })
    }
  }, [chosenAllowed, shownAllowed])
  const tabs = useRef<HTMLDivElement>(null)
  const layout = useRef<HTMLDivElement>(null)
  const current = available.find(section => section.id === panel)
  const pushed = phone && active !== null

  // Pages open inside the section (on a phone each over the level before), and the way back from the top one.
  const [layers, setLayers] = useState<HTMLElement | null>(null)
  const [depth, setDepthState] = useState(0)
  const levelBack = useRef<(() => void) | undefined>(undefined)
  const setDepth = useCallback((next: number, back: (() => void) | undefined) => {
    levelBack.current = back
    setDepthState(next)
  }, [])
  const navigation: SettingsNavigation = {
    phone,
    section: current?.label ?? '',
    layers,
    setDepth,
  }
  const level = !phone ? undefined : depth > 0 && pushed ? 'page' : pushed ? 'section' : 'root'

  const open = (id: SettingsSection) => {
    setShown(id)
    onSection(id)
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    if (found.length === 0) return
    const index = found.findIndex(section => section.id === active)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? found.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length
    const target = found[next]
    if (!phone) open(target.id)
    tabs.current?.querySelector<HTMLButtonElement>(`#settings-tab-${target.id}`)?.focus()
  }
  const back = () => {
    onSection()
    requestAnimationFrame(() => {
      tabs.current?.querySelector<HTMLButtonElement>(`#settings-tab-${panel}`)?.focus({ preventScroll: true })
    })
  }
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    // A sheet or menu inside the page takes its own Esc; React would bubble it here through a portal too.
    if (event.key !== 'Escape' || !phone || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest('dialog, [popover]')) return
    if (level === 'page') levelBack.current?.()
    else if (pushed) back()
  }
  // On a phone the section pushed over its list holds a place in the browser's history (the pages inside a section hold
  // theirs in SettingsPages), so the platform's back returns one level.
  useBackLayer(pushed, back)

  // `/` goes to the search unless the person is typing somewhere or a sheet is open.
  useEffect(() => {
    if (!searchable || phone) return undefined
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, dialog, [popover]')))
        return
      event.preventDefault()
      search.current?.querySelector('input')?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [searchable, phone])

  return (
    <section aria-label="设置" className="settings-page" data-entry="settings" onKeyDown={escape}>
      <SettingsNavigationProvider value={navigation}>
        <div ref={layout} className="settings-layout" data-level={level}>
          <div className="settings-nav-pane" inert={pushed || undefined}>
            {phone && (
              <header className="settings-bar">
                <span />
                <h2>设置</h2>
              </header>
            )}
            {!phone && onBack && (
              <div className="settings-back-line">
                <button type="button" className="sidebar-nav-row" onClick={onBack}>
                  <ArrowLeft size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
                  <span>返回</span>
                </button>
              </div>
            )}
            {searchable && (
              <div ref={search} className="settings-search">
                <SearchField
                  label="搜索设置"
                  placeholder="搜索设置"
                  value={query}
                  onValueChange={setQuery}
                  trailing={!phone && !query ? <Kbd>/</Kbd> : undefined}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && found[0]) open(found[0].id)
                  }}
                />
              </div>
            )}
            <div ref={tabs} className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="设置分类" onKeyDown={keydown}>
              {found.map(section => (
                <button
                  key={section.id}
                  id={`settings-tab-${section.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active === section.id}
                  aria-controls="settings-panel"
                  tabIndex={active === section.id || (active === null && section.id === (shown ?? available[0].id)) ? 0 : -1}
                  onClick={() => {
                    open(section.id)
                  }}>
                  <Icon icon={section.icon} size={phone ? 20 : 16} solid={active === section.id} />
                  <span>{section.label}</span>
                  {phone && <Icon icon={ChevronRightGlyph} size={16} className="chevron" />}
                </button>
              ))}
            </div>
            {found.length === 0 && <p className="settings-nav-caption">没有找到「{query.trim()}」</p>}
            {caption && (
              <p className="settings-nav-caption">
                <Icon icon={LockGlyph} size={14} />
                <span>{caption}</span>
              </p>
            )}
          </div>
          {/* On phones the panel is laid out off-screen from the start, so the first section slides in too. */}
          {(panel !== null || phone) && (
            <section
              className="settings-panel"
              role={panel !== null ? 'tabpanel' : undefined}
              id="settings-panel"
              aria-labelledby={panel !== null ? `settings-tab-${panel}` : undefined}
              aria-hidden={panel === null || undefined}
              inert={(phone && (!pushed || level === 'page')) || undefined}>
              {phone && (
                <header className="settings-bar">
                  <IconButton label="返回" icon={ChevronLeftGlyph} onClick={back} />
                  <h2>{current?.label}</h2>
                </header>
              )}
              <div className="settings-scroll">
                {panel !== null && (
                  <div key={panel} className="settings-content settings-enter">
                    {/* The section's name heads it; a page opened inside it names itself under its way back. */}
                    {!phone && depth === 0 && current && <h1 className="settings-title">{current.label}</h1>}
                    {panel === 'general' && <GeneralSettings snapshot={snapshot} admin={access.admin} onChanged={onChanged} />}
                    {panel === 'providers' && <ProvidersSettings snapshot={snapshot} access={access} onChanged={onChanged} />}
                    {panel === 'usage' && <ModelUsagePage snapshot={snapshot} access={access} />}
                    {panel === 'engines' && <AgentsSettings snapshot={snapshot} onChanged={onChanged} initialPage={initialAgent} />}
                    {panel === 'mcp' && <McpSettings snapshot={snapshot} />}
                    {panel === 'shortcuts' && (
                      <ShortcutsSettings
                        spaces={snapshot.catalog?.features?.customAgents === true}
                        delegate={canDelegate(snapshot, access)}
                      />
                    )}
                    {panel === 'workspaces' && (
                      <WorkspacesSettings
                        snapshot={snapshot}
                        access={access}
                        onChanged={onChanged}
                        initialProjectId={initialProjectId}
                        {...(access.scopes.has('view') && onOpenSession ? { onOpenSession } : {})}
                      />
                    )}
                    {panel === 'plugins' && (
                      <PluginsSettings
                        snapshot={snapshot}
                        access={access}
                        onChanged={onChanged}
                        {...(access.scopes.has('view') && onOpenSession ? { onOpenSession } : {})}
                        {...(onOpenApp ? { onOpenApp } : {})}
                      />
                    )}
                    {panel === 'devices' && <PhoneDevicesPage snapshot={snapshot} access={access} onChanged={onChanged} />}
                    {panel === 'computers' && <ComputersSettings />}
                    {panel === 'about' && (
                      <AboutSettings
                        snapshot={snapshot}
                        access={access}
                        {...(access.scopes.has('view') && onOpenSession ? { onOpenSession } : {})}
                      />
                    )}
                  </div>
                )}
              </div>
            </section>
          )}
          {phone && <div ref={setLayers} className="settings-levels" />}
        </div>
      </SettingsNavigationProvider>
    </section>
  )
}
