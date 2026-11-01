import { basename, isAbsolute } from 'node:path'
import { AGENT_PRESETS } from '@latch/protocol'
import type { HarnessDriver, HarnessPlugin } from '@latch/sdk'
import { AcpBridge, CLIENT_VERSION } from './bridge.ts'
import { resolveCommand } from './command.ts'
import { selectProfile, validateAgentDefinition } from './permission.ts'
import type { HarnessProfile } from './profiles/index.ts'
import { AgentHealth, resolveOptions, type AcpAgentOptions, type AgentRecord } from './types.ts'

export { agentProbePreview, probeAgent } from './probe.ts'
export { resolveCommand } from './command.ts'
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
 * What is missing for an agent to start, in words, or undefined when nothing is: the command, or with an adapter
 * preset the adapter, the agent it connects to, or both.
 */
function missingParts(command: string, found: boolean, companion: string | undefined): string | undefined {
  if (!companion) return found ? undefined : `未找到命令 ${command}`
  const agent = resolveCommand(companion) !== undefined
  if (found && agent) return undefined
  if (found) return `已找到适配器 ${command}，还没找到 ${companion}`
  if (agent) return `已安装 ${companion}，还差让 Latch 连接它的适配器 ${command}`
  return `未找到 ${companion} 和它的适配器 ${command}`
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

/** Plugin `agent-<id>` contributing one ACP HarnessDriver whose id is the agent's id. Throws for a definition Latch refuses to run. */
export function createAcpAgentPlugin(agent: AgentRecord, options: AcpAgentOptions = {}): HarnessPlugin {
  const validation = validateAgentDefinition(agent)
  if (!validation.ok) throw validation.error
  const limits = resolveOptions(options)
  const record: AgentRecord = structuredClone(agent)
  const description = `通过 ACP 运行 ${commandLine(record)}；模型、登录与工具权限由该 Harness 自身管理。`
  return {
    id: `agent-${record.id}`,
    name: record.name,
    version: CLIENT_VERSION,
    description,
    activate(context) {
      const health = new AgentHealth()
      const bridges = new Set<AcpBridge>()
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
        capabilities: { modes: ['agent'], models: 'agent', attachments: { images: true, text: true, textBytes: 25 * 1024 * 1024 } },
        agentContext: 'first-turn',
        // ACP asks every agent to accept MCP servers over stdio; a preset says when one is known not to.
        ...(AGENT_PRESETS.find(item => item.id === record.presetId)?.skillServer === false ? {} : { skills: 'server' as const }),
        ...folderDeclaration(selectProfile(record).profile),
        status() {
          const preset = AGENT_PRESETS.find(item => item.id === record.presetId)
          const found = located() !== undefined
          const missing = missingParts(record.command, found, preset?.companion)
          // The preset's install command installs its own command, so it is offered only while that one is missing.
          const install = !found && preset?.install ? `。安装：${preset.install}` : ''
          if (missing) return { status: 'unavailable', statusMessage: `${missing}${install}` }
          if (health.pausedUntil())
            return { status: 'unavailable', statusMessage: `${record.name} 在一分钟内连续崩溃 3 次，已暂停自动重启，请稍后再试` }
          return health.lastError ? { status: 'ready', statusMessage: `上次运行异常：${health.lastError}` } : { status: 'ready' }
        },
        create(hostOptions) {
          const bridge: AcpBridge = new AcpBridge(record, hostOptions, health, limits, () => bridges.delete(bridge))
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
