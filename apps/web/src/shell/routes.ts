export type SettingsSection =
  | 'general'
  | 'computer'
  | 'providers'
  | 'agents'
  | 'assistants'
  | 'routines'
  | 'workspaces'
  | 'plugins'
  | 'devices'
  | 'about'

/** The rail's entries, top group then bottom group. A phone shows 会话, Agent and 设置 as its tabs. */
export type RailEntry = 'sessions' | 'agents' | 'automations' | 'plugins' | 'phone' | 'settings'
export type PageEntry = Exclude<RailEntry, 'sessions'>

export interface ShellRoute {
  entry: RailEntry
  /** The chosen section of a page entry; absent, a wide window shows the first one and a phone shows the list. */
  section?: SettingsSection
  /** The project a 项目 section opens on. */
  projectId?: string
}

/** Each page entry's sections on wide windows; what is left over lives in 设置. */
const WIDE_SECTIONS: Record<PageEntry, readonly SettingsSection[]> = {
  agents: ['agents', 'assistants'],
  automations: ['routines'],
  plugins: ['plugins'],
  phone: ['devices'],
  settings: ['general', 'computer', 'providers', 'workspaces', 'about'],
}

/** A phone has three tabs: 自动化 sits inside Agent, and 插件 and 手机 sit inside 设置. */
const PHONE_SECTIONS: Partial<Record<PageEntry, readonly SettingsSection[]>> = {
  agents: ['agents', 'assistants', 'routines'],
  settings: ['general', 'computer', 'providers', 'workspaces', 'plugins', 'devices', 'about'],
}

export function entrySections(entry: PageEntry, phone: boolean): readonly SettingsSection[] {
  return phone ? (PHONE_SECTIONS[entry] ?? []) : WIDE_SECTIONS[entry]
}

/** The entry a section belongs to at this width, for what opens a section from elsewhere. */
export function entryOfSection(section: SettingsSection, phone: boolean): PageEntry {
  const entries: PageEntry[] = ['agents', 'automations', 'plugins', 'phone', 'settings']
  return entries.find(entry => entrySections(entry, phone).includes(section)) ?? 'settings'
}

/**
 * The same place at this width, when the window crosses the phone breakpoint: a section stays open under whichever entry
 * holds it here, and an entry a phone has no tab for opens its first section inside the tab that holds it.
 */
export function routeAtWidth(route: ShellRoute, phone: boolean): ShellRoute {
  if (route.entry === 'sessions') return route
  const section = route.section ?? (phone && !PHONE_SECTIONS[route.entry] ? WIDE_SECTIONS[route.entry][0] : undefined)
  if (section === undefined) return route
  const entry = entryOfSection(section, phone)
  return entry === route.entry && section === route.section ? route : { ...route, entry, section }
}

/** The entries this device can use: one whose every section is closed to it is not drawn. */
export function visibleEntries(allowed: readonly SettingsSection[], phone: boolean): RailEntry[] {
  const entries: PageEntry[] = phone ? ['agents', 'settings'] : ['agents', 'automations', 'plugins', 'phone', 'settings']
  return ['sessions', ...entries.filter(entry => entrySections(entry, phone).some(section => allowed.includes(section)))]
}
