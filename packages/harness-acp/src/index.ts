import { basename, isAbsolute } from 'node:path'
import {
  AGENT_PRESETS,
  ATTACHMENT_FILE_BYTES,
  extensionProfile,
  isHarnessMark,
  isRetiredAgentPreset,
  runsPresetFallback,
  type AgentPreset,
  type HarnessCapabilities,
  type HarnessInfo,
} from '@latch/protocol'
import { AppError, type HarnessDriver, type HarnessPlugin } from '@latch/sdk'
import { catalogueReadOf } from './catalogue.ts'
import { AgentRuntime, CLIENT_VERSION } from './runtime.ts'
import { commandMoved, RETIRED_HARNESS_NOTE, resolveCommand } from './command.ts'
import { harnessLogin, presetRecord, readOwnVersion } from './login.ts'
import { commandName, selectProfile, validateAgentDefinition } from './permission.ts'
import type { HarnessProfile } from './profiles/index.ts'
import type { ReleaseLookup } from './update-command.ts'
import {
  assertVersion,
  compareVersions as versionOrder,
  forgetVersions,
  knownVersion,
  lastVersion,
  settleVersions,
  tooOld,
  tooOldText,
  installedRelease,
  releaseGate,
  versionRefusal,
  wasRead,
} from './version.ts'
import { AgentHealth, resolveOptions, type AcpAgentOptions, type AgentRecord } from './types.ts'

export { agentProbePreview, probeAgent } from './probe.ts'
export { checkLogin, harnessLogin, loginCheckAddsDate, loginTerminalScript, presetRecord, setLoginPrograms } from './login.ts'
export { accountEnvironment } from './environment.ts'
export { loadLoginShell, loginShellValues } from './login-shell.ts'
export { compareVersions, onVersionChange } from './version.ts'
export { claudeConfigDir } from './claude-store.ts'
export { personCommandDirectories, personPathDirectories, resolveCommand, setCommandSearch } from './command.ts'
export { DSH_CONSULTATION_GUARD_VERSION } from './profiles/dsh-mode.ts'
export { commandName, isRetiredAdapterDefinition, launchHash, selectProfile, validateAgentDefinition } from './permission.ts'
export type { AcpAgentOptions, AgentRecord, CliStoreAccess } from './types.ts'
export type { QuotaReport } from './quota.ts'
export type { ReleaseLookup } from './update-command.ts'
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
  return path ? tooOld(record, knownVersion(record, path) ?? lastVersion(record, path), undefined, path) : undefined
}

/**
 * Where to ask whether a newer release of a found command that is new enough is out, the way it was installed (npm, or
 * Homebrew for a formula or cask its profile names), the version it printed, and the command that updates such an install
 * (undefined when its layout says nothing). Uses a version already read by `minimumVersion` or `releases`.
 */
export function updateSource(
  record: AgentRecord,
  path: string | undefined,
): { lookup: ReleaseLookup; current: string; channel?: 'claude'; claudeDirectory?: string; command?: string } | undefined {
  const gate = releaseGate(selectProfile(record).profile)
  if (!path || !gate?.source) return undefined
  const verdict = knownVersion(record, path) ?? lastVersion(record, path)
  if (!verdict?.version || verdict.tooOld) return undefined
  const release = installedRelease(gate, path)
  if (!release) return undefined
  return {
    lookup: release.lookup,
    current: verdict.version,
    // The channel names an npm dist-tag; Homebrew has one release per formula or cask.
    ...(gate.source.channel === 'claude' && release.lookup.registry === 'npm'
      ? { channel: gate.source.channel, ...(record.accountDirectory ? { claudeDirectory: record.accountDirectory } : {}) }
      : {}),
    ...(release.command ? { command: release.command } : {}),
  }
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
  return path ? versionRefusal(record, knownVersion(record, path), undefined, undefined, path) : undefined
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
  path ? tooOldText(record, knownVersion(record, path) ?? lastVersion(record, path), undefined, path) : undefined

/**
 * A preset as a draft would save it now: its own command, or its `fallback` adapter when only the adapter is installed.
 * A command that is here but too old is refused, never swapped: the adapter would run that same program (`CODEX_PATH`).
 */
export function presetRoute(presetId: string): AgentRecord | undefined {
  const record = presetRecord(presetId)
  const fallback = AGENT_PRESETS.find(item => item.id === presetId)?.fallback
  if (!record || !fallback) return record
  const path = resolveCommand(record.command)
  // An adapter that is the same program takes over when that program is known to be too old for the preset's own
  // protocol: OpenCode before 2.2.6 still answers `opencode acp`.
  if (path !== undefined)
    return fallback.command === record.command && outdatedCommand(record, path) ? { ...record, args: [...fallback.args] } : record
  return resolveCommand(fallback.command) ? { ...record, command: fallback.command, args: [...fallback.args] } : record
}

/**
 * The definition a draft saves once its command's version is read: the preset's own when that program is new enough or
 * unknown, else its same-program adapter (`opencode acp`). Reads the version, at most once per file; changes nothing else.
 */
export async function presetRouteAfterVersion(record: AgentRecord): Promise<AgentRecord> {
  const preset = AGENT_PRESETS.find(item => item.id === record.presetId)
  const fallback = preset?.fallback
  if (!preset || !fallback || fallback.command !== preset.command || record.command !== preset.command) return record
  if (runsPresetFallback(preset, commandName(record.command), record.args) || record.args.length) return record
  const path = resolveCommand(record.command)
  if (!path) return record
  try {
    await assertVersion(record, path)
    return record
  } catch (error) {
    if (error instanceof AppError && error.code === 'harness-version-unsupported') return { ...record, args: [...fallback.args] }
    throw error
  }
}

/** What each preset saved before it ran its own program: the adapter route, as a draft wrote it then. */
const BEFORE_DIRECT: Readonly<Record<string, { command: string; args: readonly string[] }>> = {
  'claude-agent': { command: 'claude-agent-acp', args: [] },
  opencode: { command: 'opencode', args: ['acp'] },
}

/**
 * A definition a preset saved on its adapter before the preset had a program of its own, as it should be now: the
 * preset's own command, when that program is installed and its version is read and new enough. Undefined for anything
 * else: a definition the person changed in any way (another command or path, an argument, a variable), one already
 * moved, one saved or changed since (`routeKept`), a program missing, too old, or whose version cannot be read (looked
 * at again on a later start). The program run for its version is the one the adapter itself drives.
 */
export async function directRouteFor(record: AgentRecord, timeoutMs = 10_000): Promise<AgentRecord | undefined> {
  const before = record.presetId ? BEFORE_DIRECT[record.presetId] : undefined
  if (!before || record.migratedFrom || record.routeKept || !record.enabled) return undefined
  if (record.command !== before.command || Object.keys(record.env).length > 0) return undefined
  if (record.args.length !== before.args.length || record.args.some((arg, index) => arg !== before.args[index])) return undefined
  const target = presetRecord(record.presetId!)
  if (!target || (target.command === record.command && target.args.length === record.args.length)) return undefined
  const path = resolveCommand(target.command)
  const gate = selectProfile(target).profile?.minimumVersion
  if (!path || !gate) return undefined
  const version = await readOwnVersion(target, path, { timeoutMs }, gate).catch(() => undefined)
  const order = version === undefined ? undefined : versionOrder(version, gate.minimum)
  if (order === undefined || order < 0) return undefined
  const { lastProbe: _probe, probedDefinitionHash: _probed, ...kept } = record
  return {
    ...kept,
    command: target.command,
    args: [...target.args],
    confirmedCommand: path,
    ...(record.startedHash !== undefined ? { startedHash: null } : {}),
    migratedFrom: {
      command: record.command,
      args: [...record.args],
      ...(record.confirmedCommand !== undefined ? { confirmedCommand: record.confirmedCommand } : {}),
    },
  }
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
  const fallback = runsPresetFallback(preset, commandName(record.command), record.args) ? preset.fallback : undefined
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
  const { approvals, readback, modeTiers, modeGlyphs, modeLadder, expectedMode } = profile.permission
  // Only modes Latch has a word for are offered before a read: a ladder mode without one is the harness's own.
  const modes = modeLadder?.filter(mode => modeTiers?.[mode])
  return {
    permission: {
      approvals,
      readback,
      ...(modeTiers ? { modeTiers: structuredClone(modeTiers) } : {}),
      ...(modeGlyphs ? { modeGlyphs: structuredClone(modeGlyphs) } : {}),
      ...(readback === 'mode' && expectedMode && modes?.includes(expectedMode) ? { modes, startMode: expectedMode } : {}),
    },
  }
}

const ACP_CAPABILITIES = {
  modes: ['agent'],
  attachments: { images: true, text: true, textBytes: ATTACHMENT_FILE_BYTES },
} satisfies HarnessDriver['capabilities']

/**
 * What every ACP agent is, with what its profile knows. Its models are known from its own sessions; a profile that points
 * it at the Host's gateway names the protocols Latch can forward for it. Without a profile whether it asks is unknown,
 * which counts as not asking.
 */
function agentFacts(
  name: string,
  presetId: string | undefined,
  profile: HarnessProfile | undefined,
  hostQuota = false,
  claudeStore = false,
): HarnessCapabilities {
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
      // A session moves by restarting the idle agent on the new route and resuming it; see `routeSwitch`.
      ...(gateway ? { routeSwitch: gateway.sessionBoundToRoute ? ('services' as const) : ('any' as const) } : {}),
      // Codex's app-server reports its limits on its own wire; another profile through its own quota source, or the Host
      // reads them for it (`readQuota`).
      ...(profile?.quota || profile?.wire === 'codex' || hostQuota ? { quota: true as const } : {}),
    },
    permission: { enforcement: profile?.permission.approvals === 'prompts' ? 'harness' : 'none', rejectionNote: false },
    tools: { shell: true, fileMentions: true },
    display: { label: name, ...(isHarnessMark(presetId) ? { mark: presetId } : {}) },
    // Its wire forks pi's own session files, Codex's threads, or Claude's transcripts where the Host lets it.
    ...(profile?.wire === 'pi' || profile?.wire === 'codex' || (profile?.wire === 'claude' && claudeStore)
      ? { fork: 'native' as const }
      : {}),
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
  const wire = profile?.wire
  const { reports, plugins } = extensionProfile(wire ?? (preset.id === 'dsh' ? 'dsh' : undefined))
  const login = harnessLogin(record)
  const folders = folderDeclaration(profile)
  const outdated = outdatedLine(record, resolveCommand(record.command))
  return {
    id: preset.id,
    description:
      runsPresetFallback(preset, commandName(record.command), record.args) && preset.fallback
        ? preset.fallback.description
        : preset.description,
    ...(outdated
      ? { status: 'unavailable' as const, statusMessage: `${preset.name} ${outdated}`, statusReason: 'outdated' as const }
      : { status: 'ready' as const }),
    capabilities: agentFacts(preset.name, preset.id, profile),
    modes: [...ACP_CAPABILITIES.modes],
    attachments: { ...ACP_CAPABILITIES.attachments },
    agentContext: 'first-turn',
    pluginCreation: true,
    level: 'L3',
    ...skillsOf(preset.id),
    extensionSupport: { reports: wire === 'cursor' ? [] : reports, ...(plugins ? { plugins } : {}) },
    ...(folders.folderAccess ? { projectFolders: folders.folderAccess as NonNullable<HarnessInfo['projectFolders']> } : {}),
    ...permissionDeclaration(profile),
    ...(login ? { login } : {}),
    catalogueRead: catalogueReadOf(profile),
    offer: { presetId: preset.id },
  }
}

/**
 * Whether the Host may bring in this harness's own sessions: its profile says so and its wire lists and loads (pi's
 * answers neither); Claude's direct wire only where the Host lets it read Claude's store.
 */
/**
 * Whether the driver offers 接入已有会话: pi has no command that lists its sessions and Claude's direct wire reads Claude's
 * store, so both only where the Host lets them read CLI stores.
 */
function historyImport(profile: HarnessProfile | undefined, limits: ReturnType<typeof resolveOptions>): boolean {
  return (
    profile?.historyImport !== undefined
    && (profile.wire !== 'pi' || limits.cliStore !== undefined)
    && (profile.wire !== 'claude' || limits.claudeStore)
  )
}

const historyRuleOf = (profile: HarnessProfile | undefined) =>
  typeof profile?.historyImport === 'object' ? profile.historyImport : undefined

/** Plugin `agent-<id>` contributing one ACP HarnessDriver whose id is the agent's id. Throws for a definition Latch refuses to run. */
export function createAcpAgentPlugin(agent: AgentRecord, options: AcpAgentOptions = {}): HarnessPlugin {
  const validation = validateAgentDefinition(agent)
  if (!validation.ok) throw validation.error
  const limits = resolveOptions(options)
  const record: AgentRecord = structuredClone(agent)
  const retired = isRetiredAgentPreset(record.presetId)
  const selection = selectProfile(record)
  const wire = selection.profile?.wire
  const { reports, plugins } = extensionProfile(wire ?? (selection.preset?.id === 'dsh' ? 'dsh' : undefined))
  const protocol =
    wire === 'pi' ? 'pi 的 RPC 模式' : wire === 'codex' ? 'Codex 的 app-server' : wire === 'claude' ? 'Claude Agent SDK' : 'ACP'
  const description =
    wire === 'cursor'
      ? '通过 Cursor 官方 SDK（@cursor/sdk）在 Latch 的独立进程里运行 Cursor，用定义里的 CURSOR_API_KEY；不逐次询问。'
      : `通过 ${protocol} 运行 ${commandLine(record)}；模型、登录与工具权限由该 Harness 自身管理。`
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
        capabilities: {
          ...ACP_CAPABILITIES,
          ...agentFacts(record.name, record.presetId, selectProfile(record).profile, limits.readQuota !== undefined, limits.claudeStore),
        },
        agentContext: 'first-turn',
        pluginCreation: true,
        ...skillsOf(record.presetId),
        // The Cursor SDK runner has no command catalogue. cursor-agent's ACP route can advertise one.
        extensionSupport: { reports: wire === 'cursor' ? [] : reports, ...(plugins ? { plugins } : {}) },
        ...folderDeclaration(selectProfile(record).profile),
        ...permissionDeclaration(selectProfile(record).profile),
        ...(historyImport(selectProfile(record).profile, limits) ? { historyImport: true as const } : {}),
        ...(historyImport(selectProfile(record).profile, limits) && historyRuleOf(selectProfile(record).profile)?.deletes
          ? { historyDelete: true as const }
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
            return { status: 'unavailable', statusMessage: commandMoved(record.name).message, statusReason: 'moved' }
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
