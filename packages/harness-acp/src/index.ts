import { basename, isAbsolute } from 'node:path'
import {
  AGENT_PRESETS,
  isHarnessMark,
  isRetiredAgentPreset,
  type AgentPreset,
  type HarnessCapabilities,
  type HarnessInfo,
} from '@latch/protocol'
import type { HarnessDriver, HarnessPlugin } from '@latch/sdk'
import { catalogueReadOf } from './catalogue.ts'
import { AgentRuntime, CLIENT_VERSION } from './runtime.ts'
import { commandMoved, RETIRED_HARNESS_NOTE, resolveCommand } from './command.ts'
import { harnessLogin, presetRecord } from './login.ts'
import { commandName, selectProfile, validateAgentDefinition } from './permission.ts'
import type { HarnessProfile } from './profiles/index.ts'
import {
  assertVersion,
  forgetVersions,
  knownVersion,
  lastVersion,
  settleVersions,
  tooOld,
  tooOldText,
  versionRefusal,
  wasRead,
} from './version.ts'
import { AgentHealth, resolveOptions, type AcpAgentOptions, type AgentRecord } from './types.ts'

export { agentProbePreview, probeAgent } from './probe.ts'
export { checkLogin, harnessLogin, loginCheckAddsDate, loginTerminalScript, presetRecord, setLoginPrograms } from './login.ts'
export { loadLoginShell } from './login-shell.ts'
export { compareVersions, onVersionChange } from './version.ts'
export { personCommandDirectories, personPathDirectories, resolveCommand, setCommandSearch } from './command.ts'
export { commandName, launchHash, selectProfile, validateAgentDefinition } from './permission.ts'
export type { AcpAgentOptions, AgentRecord } from './types.ts'
export { withHarnessPromptSource, harnessPromptSource } from './prompt-source.ts'

/** PATH lookups touch the file system; status() is polled with every catalog. */
const LOOKUP_TTL_MS = 5_000
/** Bumped by an explicit re-check, so a command installed a moment ago is not hidden by an earlier lookup. */
let lookupEpoch = 0

/** Drops every agent's cached command lookup; the next status looks again. */
export function forgetCommandLookups(): void {
  lookupEpoch++
  forgetVersions()
}

/**
 * Why a found command cannot run yet, by the version it printed, and how to upgrade it: undefined when it is new enough,
 * unknown or not read yet. It reads nothing itself; a re-check, a start or choosing the preset does.
 */
export function outdatedCommand(record: AgentRecord, path: string | undefined): { need: string; upgrade: string } | undefined {
  return path ? tooOld(record, knownVersion(record, path) ?? lastVersion(record, path)) : undefined
}

/**
 * Whether this command has a version it must reach and nothing has read it yet: a preset nobody confirmed is never run
 * for its version, so settings can say only that it was found.
 */
export function versionUnread(record: AgentRecord, path: string | undefined): boolean {
  if (!path || !selectProfile(record).profile?.minimumVersion) return false
  return (knownVersion(record, path) ?? lastVersion(record, path)) === undefined
}

/** The refusal a saved definition gets while its command is known to be too old. */
export function outdatedRefusal(record: AgentRecord) {
  const path = resolveCommand(record.command)
  return path ? versionRefusal(record, knownVersion(record, path)) : undefined
}

/**
 * Reads the version of a definition's command now and refuses one too old for its preset (409
 * `harness-version-unsupported`); an unreadable version, or a command not found, passes.
 */
export async function assertCommandVersion(record: AgentRecord): Promise<void> {
  const path = resolveCommand(record.command)
  if (path) await assertVersion(record, path)
}

/** The same as one line, with the upgrade command. */
const outdatedLine = (record: AgentRecord, path: string | undefined): string | undefined =>
  path ? tooOldText(record, knownVersion(record, path) ?? lastVersion(record, path)) : undefined

/**
 * A preset as a draft would save it now: its own command, or its `fallback` adapter when only the adapter is installed.
 * A command that is here but too old is refused, never swapped: the adapter would run that same program (`CODEX_PATH`).
 */
export function presetRoute(presetId: string): AgentRecord | undefined {
  const record = presetRecord(presetId)
  const fallback = AGENT_PRESETS.find(item => item.id === presetId)?.fallback
  if (!record || !fallback || resolveCommand(record.command) !== undefined) return record
  return resolveCommand(fallback.command) ? { ...record, command: fallback.command, args: [...fallback.args] } : record
}

/**
 * Reads the versions of these definitions' commands, and of these presets' when one was read before (chosen once), at
 * most `timeoutMs`, so that a re-check answers with them. A preset never chosen is not run.
 */
export function recheckVersions(records: readonly AgentRecord[], timeoutMs: number, chosen: readonly AgentRecord[] = []): Promise<void> {
  const items = records.map(record => ({ record, path: resolveCommand(record.command) }))
  for (const record of chosen) {
    const path = resolveCommand(record.command)
    if (path && wasRead(record, path)) items.push({ record, path })
  }
  return settleVersions(items, timeoutMs)
}

/**
 * What is missing for an agent to start, in words, or undefined when nothing is: the command, or for an adapter whose
 * program is installed, only the adapter.
 */
function missingParts(command: string, found: boolean, drives: string | undefined): string | undefined {
  if (found) return undefined
  return drives && resolveCommand(drives) !== undefined
    ? `已安装 ${drives}，还差让 Latch 连接它的适配器 ${command}`
    : `未找到命令 ${command}`
}

/**
 * What a definition's command is of its preset: the preset's own program, or its adapter (`fallback`) for any other
 * command of a preset that has one. The install command and the program an adapter drives follow.
 */
function routeOf(record: AgentRecord): { install?: string; drives?: string } {
  const preset = AGENT_PRESETS.find(item => item.id === record.presetId)
  if (!preset) return {}
  const fallback = preset.fallback && commandName(record.command) !== preset.command ? preset.fallback : undefined
  if (fallback) return { install: fallback.install, ...(fallback.drives ? { drives: fallback.drives } : {}) }
  return { ...(preset.install ? { install: preset.install } : {}), ...(preset.agentCommand ? { drives: preset.agentCommand } : {}) }
}

/** Short form for pickers; the full command stays in the agent settings. */
function commandLine(record: AgentRecord): string {
  const line = [record.command, ...record.args].map(part => (isAbsolute(part) ? basename(part) : part)).join(' ')
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/** Whether the driver takes a project's folders, by its profile, and what clients are told about the others. */
function folderDeclaration(profile: HarnessProfile | undefined): Pick<HarnessDriver, 'projectFolders' | 'folderAccess'> {
  const folders = profile?.folders
  if (folders)
    return { projectFolders: 'all', folderAccess: { access: 'all', ...(folders.via === 'args' ? { max: folders.maxExtra + 1 } : {}) } }
  return profile?.folderAccess ? { folderAccess: { access: profile.folderAccess } } : {}
}

/** What a draft may say before the agent has started: the profile's facts, for an agent Latch has a profile for. */
function permissionDeclaration(profile: HarnessProfile | undefined): Pick<HarnessDriver, 'permission'> {
  if (!profile) return {}
  const { approvals, readback, modeTiers, modeLadder, expectedMode } = profile.permission
  // Only modes Latch has a word for are offered before a read: a ladder mode without one is the harness's own.
  const modes = modeLadder?.filter(mode => modeTiers?.[mode])
  return {
    permission: {
      approvals,
      readback,
      ...(modeTiers ? { modeTiers: structuredClone(modeTiers) } : {}),
      ...(readback === 'mode' && expectedMode && modes?.includes(expectedMode) ? { modes, startMode: expectedMode } : {}),
    },
  }
}

const ACP_CAPABILITIES = {
  modes: ['agent'],
  attachments: { images: true, text: true, textBytes: 25 * 1024 * 1024 },
} satisfies HarnessDriver['capabilities']

/**
 * What every ACP agent is, with what its profile knows. Its models are known from its own sessions; a profile that points
 * it at the Host's gateway names the protocols Latch can forward for it. Without a profile whether it asks is unknown,
 * which counts as not asking.
 */
function agentFacts(name: string, presetId: string | undefined, profile: HarnessProfile | undefined): HarnessCapabilities {
  const gateway = profile?.gateway
  return {
    models: {
      owner: 'harness',
      catalogue: 'session-check',
      wires: [...(gateway?.wires ?? [])],
      ...(gateway?.experimental ? { experimental: true as const } : {}),
      ...(gateway?.knownOnly ? { knownOnly: true as const } : {}),
      ...(gateway?.credentialInherited ? { credentialInherited: true as const } : {}),
      // A command without a profile is one Latch knows nothing of, so nothing points it at the gateway either.
      ...(!gateway && (!profile || profile.ownModelsOnly) ? { ownOnly: true as const } : {}),
      ...(profile?.thinkingPerModel ? { thinkingPerModel: true as const } : {}),
      ...(profile?.thinkingInModel ? { thinkingInModel: true as const } : {}),
      ...(profile?.wire === 'codex' && gateway ? { serviceThinking: true as const } : {}),
      // Codex's app-server reports its limits on its own wire; another profile through its own quota source.
      ...(profile?.quota || profile?.wire === 'codex' ? { quota: true as const } : {}),
    },
    permission: { enforcement: profile?.permission.approvals === 'prompts' ? 'harness' : 'none', rejectionNote: false },
    tools: { shell: true, fileMentions: true },
    display: { label: name, ...(isHarnessMark(presetId) ? { mark: presetId } : {}) },
    // Its wire forks pi's own session files.
    ...(profile?.wire === 'pi' ? { fork: 'native' as const } : {}),
  }
}

/** ACP asks every agent to accept MCP servers over stdio; a preset says when one is known not to. */
const skillsOf = (presetId: string | undefined): Pick<HarnessDriver, 'skills'> =>
  AGENT_PRESETS.find(item => item.id === presetId)?.skillServer === false ? {} : { skills: 'server' }

/**
 * A preset found on this computer as a session draft sees it before its definition exists: what its driver would declare.
 * Describing it starts nothing and saves nothing.
 */
export function presetOffer(preset: AgentPreset): HarnessInfo {
  const record = presetRoute(preset.id)!
  const { profile } = selectProfile(record)
  const login = harnessLogin(record)
  const folders = folderDeclaration(profile)
  const outdated = outdatedLine(record, resolveCommand(record.command))
  return {
    id: preset.id,
    description: record.command !== preset.command && preset.fallback ? preset.fallback.description : preset.description,
    ...(outdated
      ? { status: 'unavailable' as const, statusMessage: `${preset.name} ${outdated}`, statusReason: 'outdated' as const }
      : { status: 'ready' as const }),
    capabilities: agentFacts(preset.name, preset.id, profile),
    modes: [...ACP_CAPABILITIES.modes],
    attachments: { ...ACP_CAPABILITIES.attachments },
    agentContext: 'first-turn',
    level: 'L3',
    ...skillsOf(preset.id),
    ...(folders.folderAccess ? { projectFolders: folders.folderAccess as NonNullable<HarnessInfo['projectFolders']> } : {}),
    ...permissionDeclaration(profile),
    ...(login ? { login } : {}),
    catalogueRead: catalogueReadOf(profile),
    offer: { presetId: preset.id },
  }
}

/** Plugin `agent-<id>` contributing one ACP HarnessDriver whose id is the agent's id. Throws for a definition Latch refuses to run. */
export function createAcpAgentPlugin(agent: AgentRecord, options: AcpAgentOptions = {}): HarnessPlugin {
  const validation = validateAgentDefinition(agent)
  if (!validation.ok) throw validation.error
  const limits = resolveOptions(options)
  const record: AgentRecord = structuredClone(agent)
  const retired = isRetiredAgentPreset(record.presetId)
  const wire = selectProfile(record).profile?.wire
  const protocol = wire === 'pi' ? 'pi 的 RPC 模式' : wire === 'codex' ? 'Codex 的 app-server' : 'ACP'
  const description = `通过 ${protocol} 运行 ${commandLine(record)}；模型、登录与工具权限由该 Harness 自身管理。`
  return {
    id: `agent-${record.id}`,
    name: record.name,
    version: CLIENT_VERSION,
    description,
    activate(context) {
      const health = new AgentHealth()
      const bridges = new Set<AgentRuntime>()
      let lookup: { at: number; epoch: number; path?: string } | undefined
      const located = (): string | undefined => {
        const at = Date.now()
        if (!lookup || lookup.epoch !== lookupEpoch || at - lookup.at > LOOKUP_TTL_MS)
          lookup = { at, epoch: lookupEpoch, path: resolveCommand(record.command) }
        return lookup.path
      }
      const driver: HarnessDriver = {
        id: record.id,
        name: record.name,
        version: CLIENT_VERSION,
        description,
        capabilities: { ...ACP_CAPABILITIES, ...agentFacts(record.name, record.presetId, selectProfile(record).profile) },
        agentContext: 'first-turn',
        ...skillsOf(record.presetId),
        ...folderDeclaration(selectProfile(record).profile),
        ...permissionDeclaration(selectProfile(record).profile),
        ...(selectProfile(record).profile?.historyImport && selectProfile(record).profile?.wire !== 'pi'
          ? { historyImport: true as const }
          : {}),
        seededStart: true,
        login: () => (retired ? undefined : harnessLogin(record)),
        status() {
          if (retired) return { status: 'unavailable', statusMessage: `${record.name} ${RETIRED_HARNESS_NOTE}` }
          const route = routeOf(record)
          const found = located() !== undefined
          const missing = missingParts(record.command, found, route.drives)
          // The install command installs this command, so it is offered only while that one is missing.
          const install = !found && route.install ? `。安装：${route.install}` : ''
          if (missing) return { status: 'unavailable', statusMessage: `${missing}${install}` }
          const outdated = outdatedLine(record, located())
          if (outdated) return { status: 'unavailable', statusMessage: `${record.name} ${outdated}`, statusReason: 'outdated' }
          const path = located()
          if (record.confirmedCommand !== undefined && path !== undefined && path !== record.confirmedCommand)
            return { status: 'unavailable', statusMessage: commandMoved(record.name).message }
          if (health.pausedUntil())
            return { status: 'unavailable', statusMessage: `${record.name} 在一分钟内连续崩溃 3 次，已暂停自动重启，请稍后再试` }
          return health.lastError ? { status: 'ready', statusMessage: `上次运行异常：${health.lastError}` } : { status: 'ready' }
        },
        create(hostOptions) {
          const bridge: AgentRuntime = new AgentRuntime(record, hostOptions, health, limits, () => bridges.delete(bridge))
          bridges.add(bridge)
          return bridge
        },
      }
      context.registerHarness(driver)
      // The Host closes its bridges before releasing the driver; this only covers ones it did not close.
      context.onDispose(async () => {
        await Promise.allSettled([...bridges].map(bridge => bridge.close()))
        bridges.clear()
      })
    },
  }
}
