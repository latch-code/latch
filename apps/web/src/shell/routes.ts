export type SettingsSection = 'general' | 'providers' | 'engines' | 'workspaces' | 'plugins' | 'devices' | 'shortcuts' | 'about'

/** Where the shell can be: the sessions (Code), 我的 Agent, or 设置; a page takes the panel's place and the main area. */
export type ShellEntry = 'sessions' | 'agents' | 'settings'
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
  /** 我的 Agent: the Agent whose page is open, and its tab; absent, the list. */
  myAgent?: MyAgentTarget
}

export type MyAgentTab = 'delegate' | 'memory' | 'schedules' | 'settings'
export interface MyAgentTarget {
  /** An Agent's ID, `general` for 通用, or `new` for the form that creates one. */
  id: string
  tab?: MyAgentTab
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

/**
 * The entries this device can use: 我的 Agent where the Host has them, and 设置 when at least one of its sections is open
 * to it.
 */
export function visibleEntries(allowed: readonly SettingsSection[], phone: boolean, agents = false): ShellEntry[] {
  return [
    'sessions',
    ...(agents ? (['agents'] as const) : []),
    ...(settingsSectionsAt(phone).some(section => allowed.includes(section)) ? (['settings'] as const) : []),
  ]
}
