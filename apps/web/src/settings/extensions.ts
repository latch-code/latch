import {
  AGENT_PRESETS,
  extensionProfile,
  hasExtensionProfile,
  namedExtensionCommand,
  type ExtensionCommands,
  type ExtensionKind,
  type HarnessExtensionReport,
  type HarnessInfo,
  type McpServerView,
  type PluginInfo,
  type PromptTemplate,
} from '@latch/protocol'

/**
 * 设置 › 扩展's model: per Harness, what it reports of each kind and what Latch gives it, each marked by where it comes
 * from, and the vendor's own commands to change the Harness's part. Pure, so the three states a kind can be in (reported,
 * not reported by this Harness, reported but no session yet) are tested apart.
 */

export type ExtensionMark = 'harness' | 'latch'
export const MARK_LABEL: Readonly<Record<ExtensionMark, string>> = { harness: 'Harness 自带', latch: 'Latch 提供' }

export const KIND_TITLE: Readonly<Record<ExtensionKind, string>> = { skills: '技能', commands: '命令', mcp: 'MCP', plugins: '插件' }

/** A kind this Harness does not report: said plainly, never an empty list that reads as 「none installed」. */
export const NOT_REPORTED = '这个 Harness 没有报告'
/** It reports this kind, but no ordinary session of its current definition has yet. */
export const NOT_YET = '还没有会话报告'
/** A session reported the kind, and it was empty. */
export const NONE = '没有'
/** It reports this kind, but its last session could not read it (Codex's skill directory failed): unknown, not none. */
export const UNREAD = '上次会话没有读到'
/** Its protocol has it and Latch does not read it yet. */
export const NOT_IMPLEMENTED = '尚未实现'

export interface ExtensionEntry {
  key: string
  name: string
  description?: string
  mark: ExtensionMark
  /** Short: a skill's scope, or how Latch delivers its entry. */
  detail?: string
  /** The vendor command for this entry, typed in for the person; absent when there is none or its name is not plain. */
  remove?: string
}

type KindStatus = 'reported' | 'not-reported' | 'not-yet' | 'unread' | 'not-implemented'

export interface KindView {
  kind: ExtensionKind
  title: string
  /** The Harness's own part. MCP's comes from `HarnessInfo.ownMcp` and is drawn by its own group. */
  status: KindStatus
  own: ExtensionEntry[]
  latch: ExtensionEntry[]
  truncated?: true
  /** The vendor commands for this kind, or why there are none. */
  commands?: ExtensionCommands
  absent?: string
  /** With `not-implemented`: why. */
  reason?: string
}

export interface LatchContext {
  /** Latch's MCP servers; undefined while unknown. */
  mcpServers?: readonly McpServerView[]
  /** Latch's prompt templates. */
  templates?: readonly PromptTemplate[]
}

const SCOPE: Readonly<Record<string, string>> = { project: '项目', user: '用户', system: '系统', admin: '管理员', temporary: '临时' }

export const presetOf = (harness: Pick<HarnessInfo, 'capabilities'>): string | undefined => harness.capabilities.display.mark

/** Receives Latch's MCP servers (`latch-skills`, `latch-browser` and each server the session is given). */
export const takesLatchServers = (harness: Pick<HarnessInfo, 'skills'>): boolean => harness.skills === 'server'

function absentReason(kind: ExtensionKind, preset: boolean): string {
  if (!preset) return '这个 Harness 不是 Latch 的预设，不知道它的命令'
  return kind === 'skills' || kind === 'commands' ? '它没有文档化的安装命令；技能与命令随插件或项目文件而来' : '它没有文档化的安装命令'
}

export function harnessKinds(harness: HarnessInfo, report: HarnessExtensionReport['report'], latch: LatchContext): KindView[] {
  const preset = presetOf(harness)
  const profile = extensionProfile(preset)
  // A preset Latch knows, with or without documented commands; anything else is a custom definition.
  const known = hasExtensionProfile(preset) || AGENT_PRESETS.some(item => item.id === preset)
  const servers = takesLatchServers(harness) ? (latch.mcpServers ?? []).filter(server => server.enabled) : []
  return (['skills', 'commands', 'mcp', 'plugins'] as const).map(kind => {
    const commands = profile.commands[kind]
    const view: KindView = {
      kind,
      title: KIND_TITLE[kind],
      status: 'not-reported',
      own: [],
      latch: [],
      ...(commands ? { commands } : { absent: absentReason(kind, known) }),
    }
    if (kind === 'skills') {
      if (report?.skills) {
        view.status = 'reported'
        view.own = report.skills.map(skill => ({
          key: `skill:${skill.invocation}`,
          name: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          mark: 'harness' as const,
          ...(skill.scope ? { detail: SCOPE[skill.scope] ?? skill.scope } : {}),
        }))
        if (report.skillsTruncated) view.truncated = true
      } else if (profile.reports.includes('skills')) view.status = report ? 'unread' : 'not-yet'
      if (harness.skills)
        view.latch.push({
          key: 'latch:agent-skills',
          name: '我的 Agent 的技能',
          mark: 'latch',
          detail: harness.skills === 'server' ? '经 latch-skills' : '原生加载',
        })
      if (servers.some(server => server.transport === 'stdio' && server.preset === 'computer'))
        view.latch.push({ key: 'latch:computer-guide', name: 'latch-operate-this-mac', mark: 'latch', detail: '经 latch-skills' })
    }
    if (kind === 'commands') {
      if (report) {
        view.status = 'reported'
        view.own = report.commands.map(command => ({
          key: `command:${command.name}`,
          name: `/${command.name}`,
          ...(command.description ? { description: command.description } : {}),
          mark: 'harness' as const,
        }))
      } else if (profile.reports.includes('commands')) view.status = 'not-yet'
      // Templates for every Harness and those kept for this one; a project's own show only in that project.
      const templates = (latch.templates ?? []).filter(
        template => template.scope.kind === 'all' || (template.scope.kind === 'agent' && template.scope.id === harness.id),
      )
      for (const template of templates)
        view.latch.push({ key: `latch:template:${template.id}`, name: template.name, mark: 'latch', detail: '提示词模板' })
    }
    if (kind === 'mcp') {
      view.status = harness.ownMcp ? (harness.ownMcp.last ? 'reported' : 'not-yet') : 'not-reported'
      if (harness.ownMcp?.last)
        view.own = harness.ownMcp.last.servers.map(server => {
          const remove = namedExtensionCommand(commands?.remove, server.name)
          return { key: `mcp:${server.name}`, name: server.name, mark: 'harness' as const, ...(remove ? { remove } : {}) }
        })
      view.latch = servers.map(server => ({
        key: `latch-mcp:${server.id}`,
        name: server.name,
        mark: 'latch' as const,
        detail: server.scope.all ? '全部会话' : '部分 Agent 与项目',
      }))
    }
    const unread = profile.unread?.[kind]
    if (unread && view.status === 'not-reported') {
      view.status = 'not-implemented'
      view.reason = unread
    }
    return view
  })
}

/** Harnesses the page lists: the external ones this Host runs (an offer is not one yet; Latch 内置 is all Latch's). */
export function extensionHarnesses(harnesses: readonly HarnessInfo[]): HarnessInfo[] {
  return harnesses.filter(harness => harness.capabilities.permission.enforcement !== 'latch' && !harness.offer)
}

/** A row's summary under the Harness's name: what it has, counted, or that it has said nothing yet. */
export function harnessSummary(kinds: readonly KindView[]): string {
  const parts = kinds.flatMap(view => {
    const count = view.status === 'reported' ? view.own.length + view.latch.length : view.latch.length
    return count ? [`${view.title} ${count}`] : []
  })
  return parts.length ? parts.join(' · ') : NOT_YET
}

/**
 * Latch's own plugins: data (skills and data panels, no code) and, apart, executable Host modules, which are trusted
 * local code for local developers. Latch's built-in parts (`managed`) are not plugins to list.
 */
export function latchPlugins(plugins: readonly PluginInfo[]): { data: PluginInfo[]; code: PluginInfo[] } {
  const listed = plugins.filter(plugin => !plugin.managed && !plugin.builtIn)
  const dataOnly = (plugin: PluginInfo) =>
    plugin.package !== undefined
    && plugin.capabilities.every(capability => capability.startsWith('skill:') || capability.startsWith('data:'))
  return { data: listed.filter(dataOnly), code: listed.filter(plugin => !dataOnly(plugin)) }
}

/** What a plugin provides, counted: 技能 2 · 数据面板 1. */
export function pluginProvides(plugin: PluginInfo, pages = 0): string {
  const count = (prefix: string) => plugin.capabilities.filter(capability => capability.startsWith(prefix)).length
  const parts: Array<[string, number]> = [
    ['技能', count('skill:')],
    ['数据面板', count('data:')],
    ['页面', pages],
    ['工具', count('tool:')],
    ['面板', count('ui:')],
    ['模型', count('provider:')],
    ['Harness', count('harness:')],
    ['连接', count('transport:')],
  ]
  const shown = parts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`)
  return shown.length ? shown.join(' · ') : plugin.description
}
