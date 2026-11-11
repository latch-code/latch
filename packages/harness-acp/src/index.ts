import { basename, isAbsolute } from 'node:path'
import { AGENT_PRESETS, isHarnessMark, type AgentPreset, type HarnessCapabilities, type HarnessInfo } from '@latch/protocol'
import type { HarnessDriver, HarnessPlugin } from '@latch/sdk'
import { catalogueReadOf } from './catalogue.ts'
import { AgentRuntime, CLIENT_VERSION } from './runtime.ts'
import { resolveCommand } from './command.ts'
import { harnessLogin, presetRecord } from './login.ts'
import { selectProfile, validateAgentDefinition } from './permission.ts'
import type { HarnessProfile } from './profiles/index.ts'
import { AgentHealth, resolveOptions, type AcpAgentOptions, type AgentRecord } from './types.ts'

export { agentProbePreview, probeAgent } from './probe.ts'
export { checkLogin, harnessLogin, loginCheckAddsDate, loginTerminalScript, presetRecord, setLoginPrograms } from './login.ts'
export { loadLoginShell } from './login-shell.ts'
export { personCommandDirectories, resolveCommand, setCommandSearch } from './command.ts'
export { launchHash, selectProfile, validateAgentDefinition } from './permission.ts'
export type { AcpAgentOptions, AgentRecord } from './types.ts'

/** PATH lookups touch the file system; status() is polled with every catalog. */
const LOOKUP_TTL_MS = 5_000
/** Bumped by an explicit re-check, so a command installed a moment ago is not hidden by an earlier lookup. */
let lookupEpoch = 0

/** Drops every agent's cached command lookup; the next status looks again. */
export function forgetCommandLookups(): void {
  lookupEpoch++
}

/**
 * What is missing for an agent to start, in words, or undefined when nothing is: the command, or for an adapter whose
 * program is installed, only the adapter.
 */
function missingParts(command: string, found: boolean, preset: AgentPreset | undefined): string | undefined {
  if (found) return undefined
  return preset?.agentCommand && resolveCommand(preset.agentCommand) !== undefined
    ? `已安装 ${preset.agentCommand}，还差让 Latch 连接它的适配器 ${command}`
    : `未找到命令 ${command}`
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
  const { approvals, readback, modeTiers } = profile.permission
  return { permission: { approvals, readback, ...(modeTiers ? { modeTiers: structuredClone(modeTiers) } : {}) } }
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
      // A command without a profile is one Latch knows nothing of, so nothing points it at the gateway either.
      ...(!gateway && (!profile || profile.ownModelsOnly) ? { ownOnly: true as const } : {}),
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
  const record = presetRecord(preset.id)!
  const { profile } = selectProfile(record)
  const login = harnessLogin(record)
  const folders = folderDeclaration(profile)
  return {
    id: preset.id,
    description: preset.description,
    status: 'ready',
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
  const protocol = selectProfile(record).profile?.wire === 'pi' ? 'pi 的 RPC 模式' : 'ACP'
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
        login: () => harnessLogin(record),
        status() {
          const preset = AGENT_PRESETS.find(item => item.id === record.presetId)
          const found = located() !== undefined
          const missing = missingParts(record.command, found, preset)
          // The preset's install command installs its own command, so it is offered only while that one is missing.
          const install = !found && preset?.install ? `。安装：${preset.install}` : ''
          if (missing) return { status: 'unavailable', statusMessage: `${missing}${install}` }
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
