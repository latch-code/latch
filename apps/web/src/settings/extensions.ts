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
import { defineCopy, formatNumber } from '../core/i18n.ts'

/**
 * 设置 › 扩展's model: per Harness, what it reports of each kind and what Latch gives it, each marked by where it comes
 * from, and the vendor's commands for the Harness's part.
 */

export const EXTENSION_COPY = defineCopy(
  {
    title: '扩展',
    source: { harness: 'Harness 自带', latch: 'Latch 提供' },
    kind: { skills: '技能', commands: '命令', mcp: 'MCP', plugins: '插件' },
    notReported: '这个 Harness 没有报告',
    notYet: '还没有会话报告',
    none: '没有',
    unread: '上次会话没有读到',
    notImplemented: '尚未实现',
    reading: '正在读取会话报告…',
    reportUnavailable: '暂时无法读取会话报告',
    unknownCommands: 'Latch 没有这个 Harness 的内置配置，无法给出命令',
    noSkillCommands: '它没有文档化的安装命令；技能与命令随插件或项目文件而来',
    noCommands: '它没有文档化的安装命令',
    agentSkills: '我的 Agent 的技能',
    throughSkills: '经 latch-skills',
    nativeLoad: '原生加载',
    templates: '提示词模板',
    allSessions: '全部会话',
    scopedSessions: '部分 Agent 与项目',
    noExtensionCommands: '没有扩展命令',
    codexPluginReason: '读取清单时可能下载或更新账号里已安装的插件包。当前协议没有只读取清单的接口。',
    capability: { data: '数据面板', pages: '页面', tools: '工具', panels: '面板', models: '模型', harness: 'Harness', connections: '连接' },
  },
  {
    title: 'Extensions',
    source: { harness: 'From the Harness', latch: 'Provided by Latch' },
    kind: { skills: 'Skills', commands: 'Commands', mcp: 'MCP', plugins: 'Plugins' },
    notReported: 'This Harness provides no report',
    notYet: 'No session report yet',
    none: 'None',
    unread: 'Unavailable in the last session report',
    notImplemented: 'Not implemented yet',
    reading: 'Reading session report…',
    reportUnavailable: 'Session report temporarily unavailable',
    unknownCommands: 'Latch has no built-in commands for this custom Harness.',
    noSkillCommands: 'Skills and commands come from plugins or project files. This Harness documents no installation command for them.',
    noCommands: 'This Harness documents no installation command.',
    agentSkills: 'My Agents’ skills',
    throughSkills: 'Via latch-skills',
    nativeLoad: 'Loaded by the Harness',
    templates: 'Prompt templates',
    allSessions: 'All sessions',
    scopedSessions: 'Selected Agents and projects',
    noExtensionCommands: 'No extension commands',
    codexPluginReason:
      'Listing plugins can download or update bundles installed in your account. The current protocol has no read-only list.',
    capability: {
      data: 'Data panels',
      pages: 'Pages',
      tools: 'Tools',
      panels: 'Panels',
      models: 'Models',
      harness: 'Harness',
      connections: 'Connections',
    },
  },
)

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

const SCOPE = defineCopy<Readonly<Record<string, string>>>(
  { project: '项目', user: '用户', system: '系统', admin: '管理员', temporary: '临时' },
  { project: 'Project', user: 'User', system: 'System', admin: 'Admin', temporary: 'Temporary' },
)

export const presetOf = (harness: Pick<HarnessInfo, 'capabilities'>): string | undefined => harness.capabilities.display.mark

/** Receives Latch's MCP servers (`latch-skills`, `latch-browser` and each server the session is given). */
export const takesLatchServers = (harness: Pick<HarnessInfo, 'skills'>): boolean => harness.skills === 'server'

function absentReason(kind: ExtensionKind, preset: boolean): string {
  if (!preset) return EXTENSION_COPY.unknownCommands
  return kind === 'skills' || kind === 'commands' ? EXTENSION_COPY.noSkillCommands : EXTENSION_COPY.noCommands
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
      title: EXTENSION_COPY.kind[kind],
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
          name: EXTENSION_COPY.agentSkills,
          detail: harness.skills === 'server' ? EXTENSION_COPY.throughSkills : EXTENSION_COPY.nativeLoad,
        })
      if (servers.some(server => server.transport === 'stdio' && server.preset === 'computer'))
        view.latch.push({ key: 'latch:computer-guide', name: 'latch-operate-this-mac', detail: EXTENSION_COPY.throughSkills })
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
      for (const template of templates)
        view.latch.push({ key: `latch:template:${template.id}`, name: template.name, detail: EXTENSION_COPY.templates })
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
        detail: server.scope.all ? EXTENSION_COPY.allSessions : EXTENSION_COPY.scopedSessions,
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
        view.empty = EXTENSION_COPY.noExtensionCommands
      } else if (support?.plugins === 'requires-sync') {
        view.status = 'not-implemented'
        view.reason = EXTENSION_COPY.codexPluginReason
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
    return count ? [`${view.title} ${formatNumber(count)}`] : []
  })
  if (parts.length) return parts.join(' · ')
  if (kinds.some(view => view.status === 'reading')) return EXTENSION_COPY.reading
  if (kinds.some(view => view.status === 'unavailable')) return EXTENSION_COPY.reportUnavailable
  if (kinds.some(view => view.status === 'not-yet')) return EXTENSION_COPY.notYet
  if (kinds.some(view => view.status === 'unread' || view.truncated)) return EXTENSION_COPY.unread
  return kinds.some(view => view.status === 'reported') ? EXTENSION_COPY.none : EXTENSION_COPY.notReported
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
  const capability = EXTENSION_COPY.capability
  const parts: Array<[string, number]> = [
    [EXTENSION_COPY.kind.skills, count('skill:')],
    [capability.data, count('data:')],
    [capability.pages, pages],
    [capability.tools, count('tool:')],
    [capability.panels, count('ui:')],
    [capability.models, count('provider:')],
    [capability.harness, count('harness:')],
    [capability.connections, count('transport:')],
  ]
  const shown = parts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${formatNumber(n)}`)
  return shown.length ? shown.join(' · ') : plugin.description
}
