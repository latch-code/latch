export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'engines'
  | 'mcp'
  | 'extensions'
  | 'workspaces'
  | 'plugins'
  | 'devices'
  | 'relays'
  | 'data'
  | 'computers'
  | 'shortcuts'
  | 'about'

/**
 * The shell's sessions, Agent pages, plugin pages, settings and bundled marketplace view.
 */
export type ShellEntry = 'sessions' | 'agents' | 'apps' | 'settings' | 'marketplace'
export type PageEntry = Exclude<ShellEntry, 'sessions'>

/** A page inside the Agent section that something else can open. */
export type AgentPageTarget = { kind: 'presets' } | { kind: 'agent'; id: string }

export interface ShellRoute {
  entry: ShellEntry
  /** 对话's start screen (the new session's input) covers the conversation without changing its selected session. */
  start?: boolean
  /** The chosen section of 设置; absent, a wide window shows the first one and a phone shows the list. */
  section?: SettingsSection
  /** The project a 项目 section opens on. */
  projectId?: string
  /** The plugin whose details should open in 设置 › 插件. */
  pluginId?: string
  /** The page an Agent section opens on. */
  agent?: AgentPageTarget
  /** 我的 Agent: the Agent whose page is open, and its tab; absent, the space's own 总览 (a phone's roster). */
  myAgent?: MyAgentTarget
  /** 我的 Agent: 全部话题, every topic grouped by its Agent, in the place of the 总览. */
  topics?: boolean
  /** 应用: the plugin page that is open (`apps/<pluginId>/<appId>`); absent, the list. */
  app?: AppTarget
}

export interface AppTarget {
  pluginId: string
  appId: string
}

/** The profile's section a link opens at (`agents/:id/memory` …); `delegate`, the old 委托 tab, opens the conversation. */
export type MyAgentTab = 'delegate' | 'memory' | 'schedules' | 'settings'
export interface MyAgentTarget {
  /** An Agent's ID, `general` for 通用, or `new` for the form that creates one. */
  id: string
  tab?: MyAgentTab
  /** A new topic: the next message starts a new session of the Agent instead of continuing the current one. */
  topic?: 'new'
}

/** Sections in reading and keyboard order. Each group is shown only when it contains an available section. */
export const SETTINGS_GROUPS = {
  preferences: ['general', 'appearance', 'shortcuts'],
  tools: ['providers', 'engines', 'mcp', 'extensions', 'plugins'],
  workspace: ['workspaces', 'data'],
  connections: ['devices', 'computers', 'relays'],
  product: ['about'],
} as const satisfies Record<string, readonly SettingsSection[]>

const WIDE_SECTIONS = Object.values(SETTINGS_GROUPS).flat()

/** A phone has no keyboard to list. */
const PHONE_SECTIONS: readonly SettingsSection[] = WIDE_SECTIONS.filter(section => section !== 'shortcuts')

export function settingsSectionsAt(phone: boolean): readonly SettingsSection[] {
  return phone ? PHONE_SECTIONS : WIDE_SECTIONS
}

/**
 * The entries this device can use: 我的 Agent where the Host has them, 应用 where plugin pages are applied, and 设置 when
 * at least one of its sections is open to it.
 */
export function visibleEntries(
  allowed: readonly SettingsSection[],
  phone: boolean,
  agents = false,
  apps = false,
): Exclude<ShellEntry, 'marketplace'>[] {
  return [
    'sessions',
    ...(agents ? (['agents'] as const) : []),
    ...(apps ? (['apps'] as const) : []),
    ...(settingsSectionsAt(phone).some(section => allowed.includes(section)) ? (['settings'] as const) : []),
  ]
}
