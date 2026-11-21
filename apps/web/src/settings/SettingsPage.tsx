import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { canDelegate } from '../agents/model.ts'
import { Radio, Blocks, Cable, Database, Palette } from 'lucide-react'
import type { AppSnapshot } from '@latch/protocol'
import { useViewport } from '../breakpoints.ts'
import { defineCopy } from '../core/i18n.ts'
import { deviceAccess, type DeviceAccess } from '../core/permissions.ts'
import { computerName, SETTINGS_ADMIN_HIDDEN } from '../core/securityCopy.ts'
import { currentShell, shellComputers } from '../core/shell.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { SettingsNavigationProvider, type SettingsNavigation } from './navigation.tsx'
import { OpenExtensions } from './extensionsLinkContext.ts'
import { deferredComponent } from '../components/DeferredContent.tsx'
import { ProvidersSection } from './ProvidersSection.tsx'
import { ModelSettingsReads, settingsReadAudience } from './modelSettingsReads.ts'
import {
  CloseGlyph,
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
import { SETTINGS_GROUPS, settingsSectionsAt, type AgentPageTarget, type SettingsSection } from '../shell/routes.ts'

export type { SettingsSection }

const SECTION_LABELS = defineCopy<Record<SettingsSection, string>>(
  {
    general: '通用',
    appearance: '外观',
    providers: '模型',
    engines: 'Harness',
    mcp: 'MCP',
    extensions: '扩展',
    workspaces: '项目',
    plugins: '插件',
    devices: '设备',
    relays: '连接转发',
    data: '数据',
    computers: '电脑',
    shortcuts: '快捷键',
    about: '关于',
  },
  {
    general: 'General',
    appearance: 'Appearance',
    providers: 'Models',
    engines: 'Harness',
    mcp: 'MCP',
    extensions: 'Extensions',
    workspaces: 'Projects',
    plugins: 'Plugins',
    devices: 'Devices',
    relays: 'Relays',
    data: 'Data',
    computers: 'Computers',
    shortcuts: 'Shortcuts',
    about: 'About',
  },
)

const COPY = defineCopy(
  {
    settings: '设置',
    generalLoading: '通用设置',
    pluginsLoading: '插件设置',
    projectsLoading: '项目设置',
    close: '关闭设置',
    search: '搜索设置',
    categories: '设置分类',
    back: '返回',
  },
  {
    settings: 'Settings',
    generalLoading: 'general settings',
    pluginsLoading: 'plugin settings',
    projectsLoading: 'project settings',
    close: 'Close settings',
    search: 'Search settings',
    categories: 'Settings categories',
    back: 'Back',
  },
)

const GROUP_LABELS = defineCopy(
  { preferences: '使用偏好', tools: '模型与工具', workspace: '项目与数据', connections: '设备与连接', product: '产品信息' },
  {
    preferences: 'Preferences',
    tools: 'Models & tools',
    workspace: 'Projects & data',
    connections: 'Devices & connections',
    product: 'Product',
  },
)

const NO_MATCH = defineCopy({ text: (query: string) => `没有找到「${query}」` }, { text: (query: string) => `No results for “${query}”` })

const AboutSettings = deferredComponent(
  async () => ({ default: (await import('./AboutSettings.tsx')).AboutSettings }),
  () => SECTION_LABELS.about,
)
const AgentsSettings = deferredComponent(
  async () => ({ default: (await import('./AgentsSettings.tsx')).AgentsSettings }),
  () => COPY.settings,
)
const PhoneDevicesPage = deferredComponent(
  async () => ({ default: (await import('./devices/PhoneDevicesPage.tsx')).PhoneDevicesPage }),
  () => SECTION_LABELS.devices,
)
const ComputersSettings = deferredComponent(
  async () => ({ default: (await import('./ComputersSettings.tsx')).ComputersSettings }),
  () => SECTION_LABELS.computers,
)
const GeneralSettings = deferredComponent(
  async () => ({ default: (await import('./GeneralSettings.tsx')).GeneralSettings }),
  () => COPY.generalLoading,
)
const AppearanceSettings = deferredComponent(
  async () => ({ default: (await import('./GeneralSettings.tsx')).AppearanceSettings }),
  () => SECTION_LABELS.appearance,
)
const PluginsSettings = deferredComponent(
  async () => ({ default: (await import('./PluginsSettings.tsx')).PluginsSettings }),
  () => COPY.pluginsLoading,
)
const ExtensionsSettings = deferredComponent(
  async () => ({ default: (await import('./ExtensionsSettings.tsx')).ExtensionsSettings }),
  () => SECTION_LABELS.extensions,
)
const McpSettings = deferredComponent(
  async () => ({ default: (await import('./McpSettings.tsx')).McpSettings }),
  () => SECTION_LABELS.mcp,
)
const RelaySettings = deferredComponent(
  async () => ({ default: (await import('./RelaySettings.tsx')).RelaySettings }),
  () => SECTION_LABELS.relays,
)
const DataSettings = deferredComponent(
  async () => ({ default: (await import('./DataSettings.tsx')).DataSettings }),
  () => SECTION_LABELS.data,
)
const ShortcutsSettings = deferredComponent(
  async () => ({ default: (await import('./ShortcutsSettings.tsx')).ShortcutsSettings }),
  () => SECTION_LABELS.shortcuts,
)
const WorkspacesSettings = deferredComponent(
  async () => ({ default: (await import('./WorkspacesSettings.tsx')).WorkspacesSettings }),
  () => COPY.projectsLoading,
)

/** What each section holds, so 搜索设置 finds a setting by the words on its row. */
const SEARCH_TERMS = defineCopy<Partial<Record<SettingsSection, string>>>(
  {
    general: '布局 侧栏 顶栏 按项目 按状态 发送消息 回车 工作过程 新文档 自动打开 通知 唤醒 名称 语言 界面语言',
    appearance:
      '主题 深色 浅色 配色 工作台配色 黑白 墨灰 石墨 雾蓝 暖灰 浮层材质 磨砂 实色 通透 设备主色 强调色 深蓝 青绿 鸢尾紫 背景 背景效果 粒子 01 密度 紧凑 动效 自定义 主色 圆角 字号 恢复默认',
    providers: '服务 密钥 key 添加服务 添加模型服务 单价 预算 显示的模型 已确认的地址 地址 出站',
    engines: '已安装 可以安装 怎么装 自定义启动方式 启动方式 环境变量 命令 agent',
    mcp: 'mcp 服务器 工具 连接器 npx 命令',
    extensions: '技能 命令 插件 mcp 安装 卸载 更新 harness 自带 latch 提供',
    workspaces: '文件夹 添加项目 新建项目 快照',
    plugins: '工具 技能 页面 数据面板',
    shortcuts: '键盘',
    data: '数据目录 保留 多久 大小 安全记录 审计 记录 导出 隐私',
    devices: '设备 手机 连接手机 二维码 配对 重命名 移除 撤销 浏览器 在浏览器中打开 关于连接 policy 开始新会话',
    relays: '转发服务 中继 直连 直接连接 自建 cloudflare workers linux 服务器 配置文件 中继文件 添加中继',
    computers: '添加电脑 其他电脑 移除 切换 打开',
    about: '版本 许可与条款',
  },
  {
    general: 'layout sidebar title bar project status send enter work details documents auto open notification awake name language',
    appearance:
      'theme dark light palette monochrome graphite mist blue warm grey floating panel material solid frosted clear glass device accent follow workbench deep blue teal iris background effects particles 01 density compact motion customize accent corners fonts defaults',
    providers: 'service key add model service price spend budget visible models confirmed addresses',
    engines: 'installed install how to install startup command environment variables Agent',
    mcp: 'mcp server tools connector npx command',
    extensions: 'skills commands plugins mcp install uninstall update harness built-in latch',
    workspaces: 'folder add project create snapshot',
    plugins: 'tools skills pages data panels',
    shortcuts: 'keyboard',
    data: 'data directory retention size audit log activity records export privacy',
    devices: 'device phone connect qr code pair rename remove privacy browser open start session',
    relays: 'relay direct self-hosted cloudflare workers linux server relay file add',
    computers: 'add computer other remove switch open',
    about: 'versions licenses terms',
  },
)

/** The sections a search names: by their label or by the words on their rows, case aside. */
export function searchSections<T extends { id: SettingsSection; label: string }>(list: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...list]
  const matches = list.filter(section => `${section.label} ${SEARCH_TERMS[section.id] ?? ''}`.toLocaleLowerCase().includes(needle))
  return matches.sort(
    (a, b) => Number(b.label.toLocaleLowerCase().startsWith(needle)) - Number(a.label.toLocaleLowerCase().startsWith(needle)),
  )
}

/**
 * `admin`: needs the device's 管理此 Host scope. `catalog`: needs the Host APIs that come with a snapshot catalog.
 * `secured`: needs a Host with device confirmation (its policy and device APIs); older Hosts lack them. `shell`: needs the
 * desktop app's list of computers.
 */
const sections: Array<{
  id: SettingsSection
  icon: IconComponent
  admin: boolean
  catalog?: boolean
  secured?: boolean
  shell?: boolean
  /** A Host feature the section's routes need. */
  feature?: 'mcp' | 'extensions' | 'data'
  /** Needs data scope `all`: it spans every session and device, private ones included. */
  allData?: boolean
}> = [
  { id: 'general', icon: SettingsGlyph, admin: false },
  { id: 'appearance', icon: Palette, admin: false },
  { id: 'providers', icon: ModelGlyph, admin: true, catalog: true },
  { id: 'engines', icon: HarnessGlyph, admin: true, catalog: true },
  { id: 'mcp', icon: Cable, admin: true, catalog: true, feature: 'mcp' },
  { id: 'extensions', icon: Blocks, admin: true, catalog: true, feature: 'extensions' },
  { id: 'workspaces', icon: FolderGlyph, admin: true, catalog: true },
  { id: 'plugins', icon: PluginsGlyph, admin: true },
  { id: 'devices', icon: DevicesGlyph, admin: false, secured: true },
  { id: 'relays', icon: Radio, admin: true, secured: true },
  { id: 'data', icon: Database, admin: true, catalog: true, feature: 'data', allData: true },
  { id: 'computers', icon: LaptopGlyph, admin: false, shell: true },
  { id: 'shortcuts', icon: KeyboardGlyph, admin: false },
  { id: 'about', icon: InfoGlyph, admin: false },
]

export const sectionLabel = (id: SettingsSection): string => SECTION_LABELS[id]

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
        && (!section.feature || snapshot.catalog?.features?.[section.feature] === true)
        && (!section.allData || access.device?.dataScope === 'all'),
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
  onClose,
  onSection,
  onChanged,
  onOpenSession,
  onOpenApp,
}: {
  snapshot: AppSnapshot
  access?: DeviceAccess
  /** The chosen section; absent, a wide window shows the first and a phone shows the list. */
  section?: SettingsSection | null
  initialProjectId?: string
  initialAgent?: AgentPageTarget
  /** Closes the settings panel, returning to the underlying workbench. */
  onClose: () => void
  /** Opens a section. Without an argument, goes back to the section list. */
  onSection: (section?: SettingsSection) => void
  onChanged: () => void
  onOpenSession?: (id: string) => void
  /** Opens an applied plugin page (设置 › 插件's 新应用). */
  onOpenApp?: (target: { pluginId: string; appId: string }) => void
}) {
  const phone = useViewport() === 'phone'
  const access = given ?? deviceAccess(snapshot, currentShell())
  const audience = settingsReadAudience(snapshot, access)
  const [reads, setReads] = useState(() => new ModelSettingsReads(audience))
  if (reads.audience !== audience) setReads(new ModelSettingsReads(audience))
  const allowed = settingsSections(snapshot, access)
  const ids = settingsSectionsAt(phone).filter(id => allowed.includes(id))
  const available = ids.flatMap(id =>
    sections.filter(section => section.id === id).map(section => ({ ...section, label: sectionLabel(id) })),
  )
  const [query, setQuery] = useState('')
  // A Harness's 扩展 page, opened from its 设置 › Harness page or from 设置 › MCP.
  const [extensionsHarness, setExtensionsHarness] = useState<string>()
  // Asked for once: leaving the section forgets it, so coming back shows the list.
  if (extensionsHarness !== undefined && chosen !== 'extensions') setExtensionsHarness(undefined)
  const openExtensions = useCallback(
    (harnessId?: string) => {
      setExtensionsHarness(harnessId)
      onSection('extensions')
    },
    [onSection],
  )
  const found = searchSections(available, query)
  const groupStarts = new Map<SettingsSection, string>()
  if (!query.trim() && available.length > 6) {
    for (const key of Object.keys(SETTINGS_GROUPS) as Array<keyof typeof SETTINGS_GROUPS>) {
      const first = SETTINGS_GROUPS[key].find(id => ids.includes(id))
      if (first) groupStarts.set(first, GROUP_LABELS[key])
    }
  }
  const searchable = available.length > 1
  const search = useRef<HTMLDivElement>(null)
  const caption = hiddenSectionsCaption(snapshot, access)
  // On phones the last section stays laid out under the list, so going back slides it away instead of blanking it.
  const [shown, setShown] = useState<SettingsSection | null>(chosen ?? (phone ? null : (ids[0] ?? null)))
  const { active, panel } = settingsPanel(ids, chosen, phone, shown)
  const currentTab = found.some(item => item.id === (active ?? shown)) ? (active ?? shown) : found[0]?.id
  const chosenAllowed = chosen === null || ids.includes(chosen)
  const shownAllowed = shown === null || ids.includes(shown)
  useLayoutEffect(() => {
    if (!shownAllowed) setShown(null)
    if (!chosenAllowed) onSection()
    if (!chosenAllowed || !shownAllowed) {
      if (document.activeElement === document.body)
        (tabs.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? tabs.current?.querySelector('button'))?.focus({
          preventScroll: true,
        })
    }
  }, [chosenAllowed, shownAllowed, onSection])
  const tabs = useRef<HTMLDivElement>(null)
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
    const focused = event.target instanceof Element ? event.target.closest('[role="tab"]')?.id : undefined
    const index = found.findIndex(section => `settings-tab-${section.id}` === focused)
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
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest('dialog:not(.settings-overlay), [popover]')) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.preventDefault()
      return
    }
    if (!pushed) return
    event.preventDefault()
    if (level === 'page') levelBack.current?.()
    else back()
  }
  // On a phone the section pushed over its list holds a place in the browser's history (the pages inside a section hold
  // theirs in SettingsPages), so the platform's back returns one level.
  useBackLayer(phone, onClose)
  useBackLayer(pushed, back)

  // `/` goes to the search unless the person is typing somewhere or a sheet is open.
  useEffect(() => {
    if (!searchable || phone) return undefined
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.closest('.settings-page')) return
      if (target.isContentEditable || target.closest('input, textarea, select, dialog:not(.settings-overlay), [popover]')) return
      event.preventDefault()
      search.current?.querySelector('input')?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [searchable, phone])

  return (
    <section className="settings-page" data-entry="settings" onKeyDown={escape}>
      <header className="settings-overlay-header">
        <h2>{COPY.settings}</h2>
        <IconButton label={COPY.close} icon={CloseGlyph} data-testid="close-settings" data-autofocus="" onClick={onClose} />
      </header>
      <SettingsNavigationProvider value={navigation}>
        <OpenExtensions.Provider value={ids.includes('extensions') ? openExtensions : undefined}>
          <div className="settings-layout" data-level={level}>
            <div className="settings-nav-pane" inert={pushed || undefined}>
              {searchable && (
                <div ref={search} className="settings-search">
                  <SearchField
                    label={COPY.search}
                    placeholder={COPY.search}
                    value={query}
                    onValueChange={setQuery}
                    trailing={!phone && !query ? <Kbd>/</Kbd> : undefined}
                    onKeyDown={event => {
                      if (!found[0] || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                      if (event.key === 'Enter') open(found[0].id)
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        tabs.current?.querySelector<HTMLButtonElement>('button')?.focus()
                      }
                    }}
                  />
                </div>
              )}
              <div
                ref={tabs}
                className="settings-nav"
                role="tablist"
                aria-orientation="vertical"
                aria-label={COPY.categories}
                onKeyDown={keydown}>
                {found.map(section => (
                  <Fragment key={section.id}>
                    {groupStarts.has(section.id) && (
                      <span role="presentation" className="settings-nav-heading">
                        {groupStarts.get(section.id)}
                      </span>
                    )}
                    <button
                      id={`settings-tab-${section.id}`}
                      type="button"
                      role="tab"
                      aria-selected={active === section.id}
                      aria-controls="settings-panel"
                      tabIndex={currentTab === section.id ? 0 : -1}
                      onClick={() => {
                        open(section.id)
                      }}>
                      <Icon icon={section.icon} size={phone ? 20 : 16} solid={active === section.id} />
                      <span>{section.label}</span>
                      {phone && <Icon icon={ChevronRightGlyph} size={16} className="chevron" />}
                    </button>
                  </Fragment>
                ))}
              </div>
              {found.length === 0 && <p className="settings-nav-caption">{NO_MATCH.text(query.trim())}</p>}
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
                    <IconButton label={COPY.back} icon={ChevronLeftGlyph} onClick={back} />
                    <h2>{current?.label}</h2>
                  </header>
                )}
                <div className="settings-scroll">
                  {panel !== null && (
                    // 设备 (its list, a device's permissions, pairing) keeps the product's own tokens under every customisation.
                    <div
                      key={panel}
                      className={panel === 'providers' ? 'settings-content' : 'settings-content settings-enter'}
                      data-lock={panel === 'devices' ? '' : undefined}>
                      {/* The section's name heads it; a page opened inside it names itself under its way back. */}
                      {!phone && depth === 0 && current && <h1 className="settings-title">{current.label}</h1>}
                      {panel === 'general' && <GeneralSettings snapshot={snapshot} admin={access.admin} onChanged={onChanged} />}
                      {panel === 'appearance' && <AppearanceSettings snapshot={snapshot} admin={access.admin} onChanged={onChanged} />}
                      {panel === 'providers' && (
                        <ProvidersSection key={reads.audience} snapshot={snapshot} access={access} reads={reads} onChanged={onChanged} />
                      )}
                      {panel === 'engines' && <AgentsSettings snapshot={snapshot} onChanged={onChanged} initialPage={initialAgent} />}
                      {panel === 'mcp' && <McpSettings snapshot={snapshot} />}
                      {panel === 'extensions' && (
                        <ExtensionsSettings
                          snapshot={snapshot}
                          {...(extensionsHarness ? { initialHarness: extensionsHarness } : {})}
                          onSection={onSection}
                        />
                      )}
                      {panel === 'shortcuts' && (
                        <ShortcutsSettings
                          spaces={snapshot.catalog?.features?.customAgents === true}
                          delegate={canDelegate(snapshot, access)}
                          editable={snapshot.catalog?.features?.shortcuts === true}
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
                      {panel === 'relays' && (
                        <RelaySettings
                          key={`${snapshot.host.hostId}:${access.admin && access.local}`}
                          hostId={snapshot.host.hostId}
                          access={access}
                        />
                      )}
                      {panel === 'data' && <DataSettings />}
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
            {phone && <div ref={setLayers} className="settings-levels" data-lock={panel === 'devices' ? '' : undefined} />}
          </div>
        </OpenExtensions.Provider>
      </SettingsNavigationProvider>
    </section>
  )
}
