import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Folder,
  Info,
  Laptop,
  LockKeyhole,
  MonitorSmartphone,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import type { AppSnapshot } from '@latch/protocol'
import { useViewport } from '../breakpoints.ts'
import { deviceAccess, hostView, type DeviceAccess } from '../core/permissions.ts'
import { SETTINGS_ADMIN_HIDDEN } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import { DevModeChip } from '../components/DevModeChip.tsx'
import { Modal } from '../components/overlays.tsx'
import { useBackLayer } from '../hooks/backStack.ts'
import { AboutSettings } from './AboutSettings.tsx'
import { AgentsSettings } from './AgentsSettings.tsx'
import { ComputerSettings } from './ComputerSettings.tsx'
import { DevicesSettings } from './DevicesSettings.tsx'
import { GeneralSettings } from './GeneralSettings.tsx'
import { LegacyProviderSettings } from './LegacyProviderSettings.tsx'
import { SettingsNavigationProvider, type SettingsNavigation } from './navigation.tsx'
import { PluginsSettings } from './PluginsSettings.tsx'
import { ProvidersSettings } from './ProvidersSettings.tsx'
import { WorkspacesSettings } from './WorkspacesSettings.tsx'
import { Button, Count, Icon, IconButton, type LucideIcon } from '@latch/ui'

export type SettingsSection = 'general' | 'computer' | 'providers' | 'agents' | 'workspaces' | 'plugins' | 'devices' | 'about'
/**
 * `admin`: needs the device's 管理此 Host scope. `catalog`: needs the Host APIs that come with a snapshot catalog.
 * `secured`: needs a Host with device confirmation (its policy and device APIs); older Hosts lack them.
 */
const sections: Array<{ id: SettingsSection; label: string; icon: LucideIcon; admin: boolean; catalog?: boolean; secured?: boolean }> = [
  { id: 'general', label: '通用', icon: SlidersHorizontal, admin: false },
  { id: 'computer', label: '电脑', icon: Laptop, admin: false, secured: true },
  { id: 'providers', label: '模型服务', icon: Sparkles, admin: true },
  { id: 'agents', label: 'Agent 成员', icon: Bot, admin: true, catalog: true },
  { id: 'workspaces', label: '项目', icon: Folder, admin: true, catalog: true },
  { id: 'plugins', label: '插件', icon: Puzzle, admin: true },
  { id: 'devices', label: '设备', icon: MonitorSmartphone, admin: false, secured: true },
  { id: 'about', label: '关于', icon: Info, admin: false },
]

/** The line under the sections of a device that lacks 管理此 Host: some sections are hidden, and where to grant it. */
export function hiddenSectionsCaption(snapshot: AppSnapshot, access: DeviceAccess): string | undefined {
  if (access.admin || access.legacy) return undefined
  return sections.some(section => section.admin && (snapshot.catalog || !section.catalog)) ? SETTINGS_ADMIN_HIDDEN : undefined
}

export function settingsSections(snapshot: AppSnapshot, access: DeviceAccess = deviceAccess(snapshot, currentShell())): SettingsSection[] {
  return sections
    .filter(section => (access.admin || !section.admin) && (snapshot.catalog || !section.catalog) && (!access.legacy || !section.secured))
    .map(section => section.id)
}

/** 「返回会话」 names what waits there, so its count is read out as well. */
const returnLabel = (waiting: number) => (waiting > 0 ? `返回会话（${waiting} 项等你处理）` : '返回会话')

/**
 * Full-page settings. From 768px the section navigation sits on the ground where the session list was, with 「返回会话」
 * and the waiting count on top, and the section is a sheet of paper beside it; on phones the section list is the root
 * and a section, and each page inside it, is pushed over the level before. It is a modal page, so the conversation
 * behind it keeps its state and the local confirmation dialog still opens over it. Leaving fades the page out before
 * the conversation shows again.
 */
export function SettingsPage({
  snapshot,
  access: given,
  initial,
  initialProjectId,
  onClose,
  onChanged,
}: {
  snapshot: AppSnapshot
  access?: DeviceAccess
  initial?: SettingsSection
  initialProjectId?: string
  onClose: () => void
  onChanged: () => void
}) {
  const phone = useViewport() === 'phone'
  const access = given ?? deviceAccess(snapshot, currentShell())
  const ids = settingsSections(snapshot, access)
  const available = sections.filter(section => ids.includes(section.id))
  const caption = hiddenSectionsCaption(snapshot, access)
  const [chosen, setChosen] = useState<SettingsSection | null>(
    initial && available.some(section => section.id === initial) ? initial : null,
  )
  const active = chosen ?? (phone ? null : 'general')
  // On phones the last section stays laid out under the list, so going back slides it away instead of blanking it.
  const [shown, setShown] = useState<SettingsSection | null>(active)
  const panel = active ?? shown
  const tabs = useRef<HTMLDivElement>(null)
  const layout = useRef<HTMLDivElement>(null)
  const current = available.find(section => section.id === panel)
  const waiting = snapshot.approvals.length
  const devMode = hostView(snapshot)?.devMode === true
  const pushed = phone && active !== null

  // Pages open inside the section on a phone, and the way back from the top one.
  const [layers, setLayers] = useState<HTMLElement | null>(null)
  const [depth, setDepthState] = useState(0)
  const levelBack = useRef<(() => void) | undefined>(undefined)
  const setDepth = useCallback((next: number, back: (() => void) | undefined) => {
    levelBack.current = back
    setDepthState(next)
  }, [])
  const navigation: SettingsNavigation = { phone, section: current?.label ?? '', layers, setDepth }
  const level = !phone ? undefined : depth > 0 && pushed ? 'page' : pushed ? 'section' : 'root'

  // Leaving fades the page out (120ms) and only then gives the window back to the conversation.
  const [closing, setClosing] = useState(false)
  const latestClose = useRef(onClose)
  useEffect(() => {
    latestClose.current = onClose
  })
  const leave = () => {
    setClosing(true)
  }
  useEffect(() => {
    if (!closing) return undefined
    const dialog = layout.current?.closest('dialog')
    let done = false
    const finish = () => {
      if (done) return
      done = true
      latestClose.current()
    }
    const ended = (event: AnimationEvent) => {
      if (event.target === dialog && event.animationName === 'settings-leave') finish()
    }
    dialog?.addEventListener('animationend', ended)
    // Should the fade not run at all (a hidden window), the page still goes.
    const fallback = setTimeout(finish, 400)
    return () => {
      dialog?.removeEventListener('animationend', ended)
      clearTimeout(fallback)
    }
  }, [closing])

  const open = (id: SettingsSection) => {
    setChosen(id)
    setShown(id)
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const index = available.findIndex(section => section.id === active)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? available.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length
    const target = available[next]
    if (!phone) open(target.id)
    tabs.current?.querySelector<HTMLButtonElement>(`#settings-tab-${target.id}`)?.focus()
  }
  const back = () => {
    setChosen(null)
    requestAnimationFrame(() => {
      tabs.current?.querySelector<HTMLButtonElement>(`#settings-tab-${panel}`)?.focus({ preventScroll: true })
    })
  }
  const escape = () => {
    if (level === 'page') levelBack.current?.()
    else if (pushed) back()
    else leave()
  }
  // On a phone the page and the section pushed over its list each hold a place in the browser's history (the pages inside
  // a section hold theirs in SettingsPages), so the platform's back returns one level.
  useBackLayer(phone && !closing, leave)
  useBackLayer(pushed && !closing, back)

  return (
    <Modal label="设置" variant="page" className={closing ? 'settings-page is-leaving' : 'settings-page'} onClose={escape}>
      <SettingsNavigationProvider value={navigation}>
        <div ref={layout} className="settings-layout" data-level={level}>
          <div className="settings-nav-pane" inert={pushed || undefined}>
            {phone ? (
              <header className="settings-bar">
                <IconButton label={returnLabel(waiting)} icon={ChevronLeft} onClick={leave} />
                {/* The button's name already says how many wait; the count beside it shows the same number. */}
                {waiting > 0 && (
                  <span className="settings-bar-count" aria-hidden="true">
                    <Count value={waiting} tone="warn" />
                  </span>
                )}
                <h2>设置</h2>
                {devMode && !pushed && <DevModeChip />}
              </header>
            ) : (
              <div className="settings-nav-head">
                <Button variant="ghost" icon={ChevronLeft} className="settings-return" aria-label={returnLabel(waiting)} onClick={leave}>
                  返回会话
                  {waiting > 0 && <Count value={waiting} tone="warn" />}
                </Button>
              </div>
            )}
            {!phone && (
              <p className="settings-nav-label" aria-hidden="true">
                设置
              </p>
            )}
            <div ref={tabs} className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="设置分类" onKeyDown={keydown}>
              {available.map(section => (
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
                  {devMode && pushed && <DevModeChip />}
                </header>
              )}
              <div className="settings-scroll">
                {panel !== null && (
                  <div key={panel} className="settings-content settings-enter">
                    {panel === 'general' && <GeneralSettings snapshot={snapshot} admin={access.admin} onChanged={onChanged} />}
                    {panel === 'computer' && <ComputerSettings snapshot={snapshot} access={access} onChanged={onChanged} />}
                    {panel === 'providers'
                      && (snapshot.catalog ? (
                        <ProvidersSettings snapshot={snapshot} access={access} onChanged={onChanged} />
                      ) : (
                        <LegacyProviderSettings onChanged={onChanged} />
                      ))}
                    {panel === 'agents' && <AgentsSettings snapshot={snapshot} access={access} onChanged={onChanged} />}
                    {panel === 'workspaces' && (
                      <WorkspacesSettings
                        snapshot={snapshot}
                        access={access}
                        onChanged={onChanged}
                        initialProjectId={initialProjectId}
                        onComputer={() => open('computer')}
                      />
                    )}
                    {panel === 'plugins' && <PluginsSettings onManage={open} />}
                    {panel === 'devices' && <DevicesSettings snapshot={snapshot} access={access} phone={phone} onChanged={onChanged} />}
                    {panel === 'about' && <AboutSettings snapshot={snapshot} />}
                  </div>
                )}
              </div>
            </section>
          )}
          {phone && <div ref={setLayers} className="settings-levels" />}
        </div>
      </SettingsNavigationProvider>
    </Modal>
  )
}
