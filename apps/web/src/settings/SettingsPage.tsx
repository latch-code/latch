import { useRef, useState, type KeyboardEvent } from 'react'
import { Bot, ChevronLeft, ChevronRight, Folder, Info, MonitorSmartphone, Puzzle, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import type { AppSnapshot } from '@latch/protocol'
import { useViewport } from '../breakpoints.ts'
import { ICON_STROKE, type LucideIcon } from '../icons.tsx'
import { deviceAccess, hostView, type DeviceAccess } from '../core/permissions.ts'
import { currentShell } from '../core/shell.ts'
import { DevModeChip } from '../components/DevModeChip.tsx'
import { Modal } from '../components/overlays.tsx'
import { AboutSettings } from './AboutSettings.tsx'
import { AgentsSettings } from './AgentsSettings.tsx'
import { DevicesSettings } from './DevicesSettings.tsx'
import { GeneralSettings } from './GeneralSettings.tsx'
import { LegacyProviderSettings } from './LegacyProviderSettings.tsx'
import { PluginsSettings } from './PluginsSettings.tsx'
import { ProvidersSettings } from './ProvidersSettings.tsx'
import { WorkspacesSettings } from './WorkspacesSettings.tsx'

export type SettingsSection = 'general' | 'providers' | 'agents' | 'workspaces' | 'plugins' | 'devices' | 'about'
/**
 * `admin`: needs the device's 管理此 Host scope. `catalog`: needs the Host APIs that come with a snapshot
 * catalog. `devices`: needs the device API of a Host with device confirmation; older Hosts lack them.
 */
const sections: Array<{ id: SettingsSection; label: string; icon: LucideIcon; admin: boolean; catalog?: boolean; devices?: boolean }> = [
  { id: 'general', label: '通用', icon: SlidersHorizontal, admin: false },
  { id: 'providers', label: '模型服务', icon: Sparkles, admin: true },
  { id: 'agents', label: 'Agent', icon: Bot, admin: true, catalog: true },
  { id: 'workspaces', label: '项目', icon: Folder, admin: true, catalog: true },
  { id: 'plugins', label: '插件', icon: Puzzle, admin: true },
  { id: 'devices', label: '设备', icon: MonitorSmartphone, admin: false, devices: true },
  { id: 'about', label: '关于', icon: Info, admin: false },
]

export function settingsSections(snapshot: AppSnapshot, access: DeviceAccess = deviceAccess(snapshot, currentShell())): SettingsSection[] {
  return sections
    .filter(section => (access.admin || !section.admin) && (snapshot.catalog || !section.catalog) && (!access.legacy || !section.devices))
    .map(section => section.id)
}

/** Full-page settings: two columns on wider screens, push navigation on phones. */
export function SettingsPage({
  snapshot,
  access: given,
  initial,
  onClose,
  onChanged,
}: {
  snapshot: AppSnapshot
  access?: DeviceAccess
  initial?: SettingsSection
  onClose: () => void
  onChanged: () => void
}) {
  const phone = useViewport() === 'phone'
  const access = given ?? deviceAccess(snapshot, currentShell())
  const ids = settingsSections(snapshot, access)
  const available = sections.filter(section => ids.includes(section.id))
  const [chosen, setChosen] = useState<SettingsSection | null>(
    initial && available.some(section => section.id === initial) ? initial : null,
  )
  const active = chosen ?? (phone ? null : 'general')
  const tabs = useRef<HTMLDivElement>(null)
  const current = available.find(section => section.id === active)

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
    const target = available[next]!
    setChosen(target.id)
    tabs.current?.querySelector<HTMLButtonElement>(`#settings-tab-${target.id}`)?.focus()
  }

  return (
    <Modal label="设置" variant={phone ? 'page' : 'dialog'} className="settings-modal" onClose={onClose}>
      <header className="modal-header settings-header">
        {phone && active !== null && (
          <button
            type="button"
            className="icon-button"
            aria-label="返回"
            title="返回"
            onClick={() => {
              setChosen(null)
            }}>
            <ChevronLeft size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        )}
        <h2>{phone && current ? current.label : '设置'}</h2>
        {phone && hostView(snapshot)?.devMode && <DevModeChip />}
        <button type="button" className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}>
          <X size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      </header>
      <div className="settings-layout">
        <div
          ref={tabs}
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label="设置分类"
          hidden={phone && active !== null}
          onKeyDown={keydown}>
          {available.map(section => (
            <button
              key={section.id}
              id={`settings-tab-${section.id}`}
              type="button"
              role="tab"
              aria-selected={active === section.id}
              aria-controls="settings-panel"
              tabIndex={active === section.id || (active === null && section.id === available[0]!.id) ? 0 : -1}
              onClick={() => {
                setChosen(section.id)
              }}>
              <section.icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>{section.label}</span>
              {phone && <ChevronRight className="chevron" size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            </button>
          ))}
        </div>
        {active !== null && (
          <section className="settings-panel" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${active}`}>
            {active === 'general' && <GeneralSettings snapshot={snapshot} admin={access.admin} onChanged={onChanged} />}
            {active === 'providers'
              && (snapshot.catalog ? (
                <ProvidersSettings snapshot={snapshot} access={access} phone={phone} onChanged={onChanged} />
              ) : (
                <LegacyProviderSettings onChanged={onChanged} />
              ))}
            {active === 'agents' && <AgentsSettings snapshot={snapshot} access={access} onChanged={onChanged} />}
            {active === 'workspaces' && <WorkspacesSettings snapshot={snapshot} access={access} onChanged={onChanged} />}
            {active === 'plugins' && <PluginsSettings />}
            {active === 'devices' && <DevicesSettings snapshot={snapshot} access={access} phone={phone} onChanged={onChanged} />}
            {active === 'about' && <AboutSettings snapshot={snapshot} />}
          </section>
        )}
      </div>
    </Modal>
  )
}
