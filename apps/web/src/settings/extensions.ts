import {
  AGENT_PRESETS,
  extensionProfile,
  hasExtensionProfile,
  namedExtensionCommand,
  type AppSnapshot,
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
 * from, and the vendor's commands for the Harness's part.
 */

export const KIND_TITLE: Readonly<Record<ExtensionKind, string>> = { skills: '技能', commands: '命令', mcp: 'MCP', plugins: '插件' }

/** A kind this Harness does not report: said plainly, never an empty list that reads as 「none installed」. */
export const NOT_REPORTED = '这个 Harness 没有报告'
/** It reports this kind, but no ordinary session of its current definition has yet. */
export const NOT_YET = '还没有会话报告'
/** A session reported the kind, and it was empty. */
export const NONE = '没有'
/** The session reported other entries but did not obtain this list. */
export const UNREAD = '上次会话没有读到'
export const NOT_IMPLEMENTED = '尚未实现'
export const READING_REPORT = '正在读取会话报告…'
export const REPORT_UNAVAILABLE = '暂时无法读取会话报告'

export interface ExtensionEntry {
  key: string
  name: string
  description?: string
  /** Short: a skill's scope, or how Latch delivers its entry. */
  detail?: string
  /** The vendor command for this entry, typed in for the person; absent when there is none or its name is not plain. */
  remove?: string
}

type ReportStatus = 'reading' | 'unavailable'
type KindStatus = 'reported' | 'not-reported' | 'not-yet' | 'unread' | 'not-implemented' | ReportStatus

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
  reason?: string
  empty?: string
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

export function harnessKinds(
  harness: HarnessInfo,
  report: HarnessExtensionReport['report'],
  latch: LatchContext,
  pending?: ReportStatus,
): KindView[] {
  const preset = presetOf(harness)
  const profile = extensionProfile(preset)
  const support = harness.extensionSupport
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
          ...(skill.scope ? { detail: SCOPE[skill.scope] ?? skill.scope } : {}),
        }))
        if (report.skillsTruncated) view.truncated = true
      } else if (support?.reports.includes('skills')) view.status = report ? 'unread' : 'not-yet'
      if (harness.skills)
        view.latch.push({
          key: 'latch:agent-skills',
          name: '我的 Agent 的技能',
          detail: harness.skills === 'server' ? '经 latch-skills' : '原生加载',
        })
      if (servers.some(server => server.transport === 'stdio' && server.preset === 'computer'))
        view.latch.push({ key: 'latch:computer-guide', name: 'latch-operate-this-mac', detail: '经 latch-skills' })
    }
    if (kind === 'commands') {
      if (report) {
        view.status = 'reported'
        view.own = report.commands.map(command => ({
          key: `command:${command.name}`,
          name: `/${command.name}`,
          ...(command.description ? { description: command.description } : {}),
        }))
      } else if (support?.reports.includes('commands')) view.status = 'not-yet'
      // Templates for every Harness and those kept for this one; a project's own show only in that project.
      const templates = (latch.templates ?? []).filter(
        template => template.scope.kind === 'all' || (template.scope.kind === 'agent' && template.scope.id === harness.id),
      )
      for (const template of templates) view.latch.push({ key: `latch:template:${template.id}`, name: template.name, detail: '提示词模板' })
    }
    if (kind === 'mcp') {
      view.status = harness.ownMcp ? (harness.ownMcp.last ? 'reported' : 'not-yet') : 'not-reported'
      if (harness.ownMcp?.last)
        view.own = harness.ownMcp.last.servers.map(server => {
          const remove = namedExtensionCommand(commands?.remove, server.name)
          return { key: `mcp:${server.name}`, name: server.name, ...(remove ? { remove } : {}) }
        })
      view.latch = servers.map(server => ({
        key: `latch-mcp:${server.id}`,
        name: server.name,
        detail: server.scope.all ? '全部会话' : '部分 Agent 与项目',
      }))
    }
    if (kind === 'plugins') {
      if (support?.plugins === 'command-sources') {
        const plugins = report?.plugins
        view.status = plugins ? 'reported' : report ? 'unread' : 'not-yet'
        if (plugins) {
          view.own = plugins.names.map(name => ({ key: `plugin:${name}`, name }))
          if (plugins.truncated) view.truncated = true
        }
        view.empty = '没有扩展命令'
      } else if (support?.plugins === 'requires-sync') {
        view.status = 'not-implemented'
        view.reason = '读取清单时可能下载或更新账号里已安装的插件包。当前协议没有只读取清单的接口。'
      }
    }
    if (pending && kind !== 'mcp' && view.status === 'not-yet') view.status = pending
    return view
  })
}

/** Harnesses the page lists: the external ones this Host runs (an offer is not one yet; Latch 内置 is all Latch's). */
export function extensionHarnesses(harnesses: readonly HarnessInfo[]): HarnessInfo[] {
  return harnesses.filter(harness => harness.capabilities.permission.enforcement !== 'latch' && !harness.offer)
}

/** Only authority, relevant visible sources and their projects can invalidate a session report. */
export function extensionReportKey(snapshot: AppSnapshot, harnesses: readonly HarnessInfo[]): string {
  const drivers = new Set(harnesses.filter(harness => harness.commandCatalogue).map(harness => harness.id))
  const sources = snapshot.tasks
    .filter(
      task =>
        drivers.has(task.harnessId)
        && !task.agentPrivate
        && !task.agent
        && !task.personal
        && !task.generalChat
        && !task.imported
        && !task.automationId,
    )
    .map(task => JSON.stringify([task.id, task.harnessId, task.commandsVersion, task.workspaceId, task.worktree?.removed]))
    .sort()
  return JSON.stringify([
    snapshot.instanceId,
    snapshot.host.hostId,
    snapshot.device.id,
    snapshot.device.dataScope,
    snapshot.device.scopes.toSorted(),
    snapshot.tasksComplete,
    harnesses.map(harness => [harness.id, harness.commandCatalogue?.generation, harness.status]),
    sources,
    snapshot.catalog?.workspaces.map(project => [project.id, project.path, project.unavailable, project.folders, project.codeRoot]),
  ])
}

/** A row's summary under the Harness's name: what it has, counted, or that it has said nothing yet. */
export function harnessSummary(kinds: readonly KindView[]): string {
  const parts = kinds.flatMap(view => {
    const count = view.status === 'reported' ? view.own.length + view.latch.length : view.latch.length
    return count ? [`${view.title} ${count}`] : []
  })
  if (parts.length) return parts.join(' · ')
  if (kinds.some(view => view.status === 'reading')) return READING_REPORT
  if (kinds.some(view => view.status === 'unavailable')) return REPORT_UNAVAILABLE
  if (kinds.some(view => view.status === 'not-yet')) return NOT_YET
  if (kinds.some(view => view.status === 'unread' || view.truncated)) return UNREAD
  return kinds.some(view => view.status === 'reported') ? NONE : NOT_REPORTED
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
