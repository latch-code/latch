import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlarmClock,
  Box,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Folder,
  Info,
  Keyboard,
  LockKeyhole,
  MonitorSmartphone,
  Puzzle,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react'
import type { AppSnapshot } from '@latch/protocol'
import { useViewport } from '../breakpoints.ts'
import { deviceAccess, type DeviceAccess } from '../core/permissions.ts'
import { SETTINGS_ADMIN_HIDDEN } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { SettingsNavigationProvider, type SettingsNavigation } from './navigation.tsx'
import { deferredComponent } from '../components/DeferredContent.tsx'
import { Icon, IconButton, SearchField, type LucideIcon } from '@latch/ui'
import { entrySections, type AgentPageTarget, type PageEntry, type SettingsSection, type ShellRoute } from '../shell/routes.ts'

export type { SettingsSection }

const AboutSettings = deferredComponent(async () => ({ default: (await import('./AboutSettings.tsx')).AboutSettings }), '关于')
const AgentsSettings = deferredComponent(async () => ({ default: (await import('./AgentsSettings.tsx')).AgentsSettings }), '引擎设置')
const DevicesSettings = deferredComponent(async () => ({ default: (await import('./DevicesSettings.tsx')).DevicesSettings }), '设备设置')
const GeneralSettings = deferredComponent(async () => ({ default: (await import('./GeneralSettings.tsx')).GeneralSettings }), '通用设置')
const PluginsSettings = deferredComponent(async () => ({ default: (await import('./PluginsSettings.tsx')).PluginsSettings }), '插件设置')
const ProvidersSettings = deferredComponent(
  async () => ({ default: (await import('./ProvidersSettings.tsx')).ProvidersSettings }),
  '模型服务设置',
)
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
  general: '外观 主题 深色 浅色 发送消息 回车 新文档 自动打开 通知 登录时打开 唤醒 名称',
  providers: '服务 密钥 key 添加服务 用量 tokens 显示的模型 已确认的地址 地址 出站',
  engines: '已安装 可以安装 启动方式 环境变量 命令 agent',
  workspaces: '文件夹 新建项目 快照',
  shortcuts: '键盘',
  devices: '手机 配对 邀请 撤销 限制 policy 开始新会话',
  about: '版本 开源许可',
}

/** The sections a search names: by their label or by the words on their rows, case aside. */
export function searchSections<T extends { id: SettingsSection; label: string }>(list: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...list]
  return list.filter(section => `${section.label} ${SEARCH_TERMS[section.id] ?? ''}`.toLocaleLowerCase().includes(needle))
}

const ENTRY_LABELS: Record<PageEntry, string> = { agents: 'Agent', automations: '自动化', plugins: '插件', phone: '手机', settings: '设置' }

/**
 * `admin`: needs the device's 管理此 Host scope. `catalog`: needs the Host APIs that come with a snapshot catalog.
 * `secured`: needs a Host with device confirmation (its policy and device APIs); older Hosts lack them.
 * `feature`: needs a feature the Host reports, on a device that may read personal data.
 */
const sections: Array<{
  id: SettingsSection
  label: string
  icon: LucideIcon
  admin: boolean
  catalog?: boolean
  secured?: boolean
  feature?: 'personal' | 'personalRoutines'
}> = [
  { id: 'general', label: '通用', icon: SlidersHorizontal, admin: false },
  { id: 'providers', label: '模型', icon: Box, admin: true, catalog: true },
  { id: 'engines', label: '引擎', icon: Cpu, admin: true, catalog: true },
  { id: 'assistants', label: '个人助手', icon: UsersRound, admin: false, feature: 'personal' },
  { id: 'routines', label: '例行任务', icon: AlarmClock, admin: false, feature: 'personalRoutines' },
  { id: 'workspaces', label: '项目', icon: Folder, admin: true, catalog: true },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard, admin: false },
  { id: 'plugins', label: '插件', icon: Puzzle, admin: true },
  { id: 'devices', label: '设备', icon: MonitorSmartphone, admin: false, secured: true },
  { id: 'about', label: '关于', icon: Info, admin: false },
]

export const sectionLabel = (id: SettingsSection): string => sections.find(section => section.id === id)!.label

/** The line under the sections of a device that lacks 管理此 Host: some sections are hidden, and where to grant it. */
export function hiddenSectionsCaption(snapshot: AppSnapshot, access: DeviceAccess): string | undefined {
  if (access.admin || access.legacy) return undefined
  return sections.some(section => section.admin && (snapshot.catalog || !section.catalog)) ? SETTINGS_ADMIN_HIDDEN : undefined
}

export function settingsSections(snapshot: AppSnapshot, access: DeviceAccess = deviceAccess(snapshot, currentShell())): SettingsSection[] {
  return sections
    .filter(
      section =>
        (access.admin || !section.admin)
        && (snapshot.catalog || !section.catalog)
        && (!access.legacy || !section.secured)
        && (!section.feature
          || (snapshot.catalog?.features?.[section.feature] === true && snapshot.device.dataScope === 'all' && access.scopes.has('view'))),
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

/** The section a page entry shows now, for what stands over the page (个人助手 and 例行任务 draw there). */
export function entrySection(route: ShellRoute, allowed: readonly SettingsSection[], phone: boolean): SettingsSection | null {
  if (route.entry === 'sessions') return null
  const ids = entrySections(route.entry, phone).filter(id => allowed.includes(id))
  return settingsPanel(ids, route.section ?? null, phone, null).active
}

/**
 * A page entry of the shell: the entry's sections in the panel next to the rail and the chosen one in the main area, with
 * its name in the title row. It covers the session's columns without unmounting them, so the conversation keeps its
 * state. On phones the section list is the root and a section, and each page inside it, is pushed over the level before.
 */
export function SettingsPage({
  snapshot,
  access: given,
  entry = 'settings',
  section: chosen = null,
  initialProjectId,
  initialAgent,
  titleSlot,
  onSection,
  onChanged,
  onOpenSession,
}: {
  snapshot: AppSnapshot
  access?: DeviceAccess
  entry?: PageEntry
  /** The chosen section; absent, a wide window shows the first and a phone shows the list. */
  section?: SettingsSection | null
  initialProjectId?: string
  initialAgent?: AgentPageTarget
  /** Where the page puts its title on wide windows. */
  titleSlot?: HTMLElement | null
  /** Opens a section, of this entry or another. Without an argument, goes back to this entry's list. */
  onSection: (section?: SettingsSection) => void
  onChanged: () => void
  onOpenSession?: (id: string) => void
}) {
  const phone = useViewport() === 'phone'
  const access = given ?? deviceAccess(snapshot, currentShell())
  const allowed = settingsSections(snapshot, access)
  const ids = entrySections(entry, phone).filter(id => allowed.includes(id))
  const available = ids.flatMap(id => sections.filter(section => section.id === id))
  const [query, setQuery] = useState('')
  const found = searchSections(available, query)
  const searchable = entry === 'settings' && available.length > 1
  const search = useRef<HTMLDivElement>(null)
  const caption = entry === 'settings' ? hiddenSectionsCaption(snapshot, access) : undefined
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

  // Pages open inside the section on a phone, and the way back from the top one.
  const [layers, setLayers] = useState<HTMLElement | null>(null)
  const [depth, setDepthState] = useState(0)
  const levelBack = useRef<(() => void) | undefined>(undefined)
  const setDepth = useCallback((next: number, back: (() => void) | undefined) => {
    levelBack.current = back
    setDepthState(next)
  }, [])
  // 插件 lists its plugins beside the rail and titles the page with the one it shows; every other entry lists sections.
  const objectEntry = entry === 'plugins' && !phone
  const [navSlot, setNavSlot] = useState<HTMLElement | null>(null)
  const navigation: SettingsNavigation = {
    phone,
    section: current?.label ?? '',
    layers,
    setDepth,
    navSlot,
    titleSlot: titleSlot ?? null,
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
    <section aria-label={ENTRY_LABELS[entry]} className="settings-page" data-entry={entry} onKeyDown={escape}>
      {!phone && !objectEntry && titleSlot && current && createPortal(<h1 className="titlebar-page-title">{current.label}</h1>, titleSlot)}
      <SettingsNavigationProvider value={navigation}>
        <div ref={layout} className="settings-layout" data-level={level}>
          <div className="settings-nav-pane" inert={pushed || undefined}>
            {phone && (
              <header className="settings-bar">
                <span />
                <h2>{ENTRY_LABELS[entry]}</h2>
              </header>
            )}
            {searchable && (
              <div ref={search} className="settings-search">
                <SearchField
                  variant="ghost"
                  label="搜索设置"
                  placeholder="搜索设置"
                  value={query}
                  onValueChange={setQuery}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && found[0]) open(found[0].id)
                  }}
                />
                {!phone && !query && (
                  <span className="settings-search-key" aria-hidden="true">
                    /
                  </span>
                )}
              </div>
            )}
            {objectEntry && <div ref={setNavSlot} className="settings-objects" />}
            <div
              ref={tabs}
              hidden={objectEntry}
              className="settings-nav"
              role="tablist"
              aria-orientation="vertical"
              aria-label={`${ENTRY_LABELS[entry]}分类`}
              onKeyDown={keydown}>
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
                  <Icon icon={section.icon} size={phone ? 20 : 16} />
                  <span>{section.label}</span>
                  {phone && <Icon icon={ChevronRight} size={16} className="chevron" />}
                </button>
              ))}
            </div>
            {found.length === 0 && <p className="settings-nav-caption">没有找到「{query.trim()}」</p>}
            {caption && (
              <p className="settings-nav-caption">
                <Icon icon={LockKeyhole} size={14} />
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
                  <IconButton label="返回" icon={ChevronLeft} onClick={back} />
                  <h2>{current?.label}</h2>
                </header>
              )}
              <div className="settings-scroll">
                {panel !== null && (
                  <div key={panel} className="settings-content settings-enter">
                    {panel === 'general' && <GeneralSettings snapshot={snapshot} admin={access.admin} onChanged={onChanged} />}
                    {panel === 'providers' && <ProvidersSettings snapshot={snapshot} access={access} onChanged={onChanged} />}
                    {panel === 'engines' && (
                      <AgentsSettings snapshot={snapshot} access={access} onChanged={onChanged} initialPage={initialAgent} />
                    )}
                    {panel === 'shortcuts' && <ShortcutsSettings />}
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
                      <PluginsSettings onManage={onSection} snapshot={snapshot} access={access} onChanged={onChanged} />
                    )}
                    {panel === 'devices' && <DevicesSettings snapshot={snapshot} access={access} onChanged={onChanged} />}
                    {panel === 'about' && <AboutSettings snapshot={snapshot} access={access} />}
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
