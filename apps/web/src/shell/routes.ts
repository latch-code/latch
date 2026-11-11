export type SettingsSection = 'general' | 'providers' | 'engines' | 'workspaces' | 'plugins' | 'devices' | 'shortcuts' | 'about'

/** Where the shell can be: the sessions, or 设置, which takes the panel's place and the main area. */
export type ShellEntry = 'sessions' | 'settings'
export type PageEntry = Exclude<ShellEntry, 'sessions'>

/** A page inside the Agent section that something else can open. */
export type AgentPageTarget = { kind: 'presets' } | { kind: 'agent'; id: string }

export interface ShellRoute {
  entry: ShellEntry
  /** The chosen section of 设置; absent, a wide window shows the first one and a phone shows the list. */
  section?: SettingsSection
  /** The project a 项目 section opens on. */
  projectId?: string
  /** The page an Agent section opens on. */
  agent?: AgentPageTarget
}

/** 设置's sections on wide windows, in their order; 设备 is one of them, its devices pages inside it. */
const WIDE_SECTIONS: readonly SettingsSection[] = [
  'general',
  'providers',
  'engines',
  'workspaces',
  'plugins',
  'devices',
  'shortcuts',
  'about',
]

/** A phone has no keyboard to list. */
const PHONE_SECTIONS: readonly SettingsSection[] = WIDE_SECTIONS.filter(section => section !== 'shortcuts')

export function settingsSectionsAt(phone: boolean): readonly SettingsSection[] {
  return phone ? PHONE_SECTIONS : WIDE_SECTIONS
}

/** The entries this device can use: 设置 is drawn when at least one of its sections is open to it. */
export function visibleEntries(allowed: readonly SettingsSection[], phone: boolean): ShellEntry[] {
  return settingsSectionsAt(phone).some(section => allowed.includes(section)) ? ['sessions', 'settings'] : ['sessions']
}
