export type SettingsSection = 'general' | 'providers' | 'engines' | 'workspaces' | 'plugins' | 'devices' | 'shortcuts' | 'about'

/** Where the shell can be: the sessions, or a page that takes the panel's place and the main area. */
export type ShellEntry = 'sessions' | 'phone' | 'settings'
export type PageEntry = Exclude<ShellEntry, 'sessions'>

/** A page inside the Agent section that something else can open. */
export type AgentPageTarget = { kind: 'presets' } | { kind: 'agent'; id: string }

export interface ShellRoute {
  entry: ShellEntry
  /** The chosen section of a page entry; absent, a wide window shows the first one and a phone shows the list. */
  section?: SettingsSection
  /** The project a 项目 section opens on. */
  projectId?: string
  /** The page an Agent section opens on. */
  agent?: AgentPageTarget
}

/** Each page's sections on wide windows; the order is the page's own. */
const WIDE_SECTIONS: Record<PageEntry, readonly SettingsSection[]> = {
  phone: ['devices'],
  settings: ['general', 'providers', 'engines', 'workspaces', 'plugins', 'shortcuts', 'about'],
}

/** A phone has two tabs, so everything but the sessions is inside 设置, and it has no keyboard to list. */
const PHONE_SECTIONS: Partial<Record<PageEntry, readonly SettingsSection[]>> = {
  settings: ['general', 'providers', 'engines', 'workspaces', 'plugins', 'devices', 'about'],
}

export function entrySections(entry: PageEntry, phone: boolean): readonly SettingsSection[] {
  return phone ? (PHONE_SECTIONS[entry] ?? []) : WIDE_SECTIONS[entry]
}

/** The entry a section belongs to at this width, for what opens a section from elsewhere. */
export function entryOfSection(section: SettingsSection, phone: boolean): PageEntry {
  const entries: PageEntry[] = ['phone', 'settings']
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
export function visibleEntries(allowed: readonly SettingsSection[], phone: boolean): ShellEntry[] {
  const entries: PageEntry[] = phone ? ['settings'] : ['phone', 'settings']
  return ['sessions', ...entries.filter(entry => entrySections(entry, phone).some(section => allowed.includes(section)))]
}
