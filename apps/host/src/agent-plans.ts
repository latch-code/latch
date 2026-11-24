import type {
  AgentExecutionContext,
  AgentNote,
  DataScope,
  AgentSkillBody,
  AutomationConfig,
  CustomAgent,
  CustomAgentSummary,
  HarnessInfo,
  ModelRef,
  PluginInfo,
  SkillInfo,
  TaskSummary,
} from '@latch/protocol'
import { GENERAL_AGENT_ID } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { agentContext, assertAgentWorksHere, generalFacts, type AgentSessionSelection, type CustomAgents } from './custom-agents.ts'
import type { AutomationPlan } from './automations.ts'

const WORK_COMPUTER = '这个助手在另一台电脑上工作。请打开它的工作电脑继续。'
const STANDARD = 'standard'
const STANDARD_PLUGIN = 'standard-harness'

interface Options {
  agents: Pick<CustomAgents, 'get' | 'general' | 'memories' | 'definitionHash'>
  harness(id: string): HarnessInfo | undefined
  plugins(): PluginInfo[]
  skills(): SkillInfo[]
  skillBodies(ids: readonly string[]): AgentSkillBody[]
  defaultModel(): ModelRef | undefined
  modelAvailable(model: ModelRef): boolean
  providerOwner(providerId: string): string | undefined
  /** The revision each plugin runs at, and whether those revisions can be trusted across a restart. */
  revisions(ids: string[]): { revisions: Record<string, string>; hashed: unknown; persistent: boolean }
  projectUsable(projectId: string): boolean
  /** The project's 默认模型 while this harness can use it now. */
  projectModel(projectId: string | undefined, harnessId: string): ModelRef | undefined
  automationAllowed(harnessId: string): boolean
  /** What a run's folders depend on: the policy, the start directory and the project's folders. */
  environment(projectId: string | undefined): unknown
  /** 「它做过什么」 for this Agent now (`agent-digest.ts`); absent while nothing happened lately. */
  digest?(owner: string): AgentNote | undefined
}

/** Turns saved agents into what a session of them receives. Nothing here is taken from a request. */
export class AgentPlans {
  constructor(private readonly options: Options) {}

  /** Why a session cannot start on this agent now, in words for the person. */
  unavailable(agent: CustomAgent): string | undefined {
    if (agent.workComputer) return WORK_COMPUTER
    if (agent.defaultProjectId && !this.options.projectUsable(agent.defaultProjectId)) return '默认项目已移除，请更新这个 Agent。'
    const harness = this.options.harness(agent.harnessId)
    if (!harness || harness.status !== 'ready') return '这个 Harness 暂时不可用，请检查电脑上的配置。'
    if (!harness.agentContext) return '这个 Harness 收不到 Agent 的指令。'
    const enabled = new Set(this.options.plugins().map(plugin => plugin.id))
    if (harness.capabilities.models.owner === 'latch') {
      if (agent.tools?.some(id => !enabled.has(id))) return '选择的插件已停用或移除，请更新这个 Agent。'
      const model = agent.model ?? this.options.defaultModel()
      if (!model || !this.options.modelAvailable(model)) return '选择的模型服务暂不可用，请在电脑上检查模型配置。'
    }
    const known = new Set(this.options.skills().map(skill => skill.id))
    if (harness.skills && agent.skills.some(id => !known.has(id))) return '选择的技能已停用或移除，请更新这个 Agent。'
    return undefined
  }

  /** For an import: whether the Harness a file names is here and ready, takes an Agent's instructions, and can run schedules. */
  harnessFor(harnessId: string): { id: string; ready: boolean; label?: string; canSchedule: boolean } {
    const harness = this.options.harness(harnessId)
    const ready = harness?.status === 'ready' && harness.agentContext !== undefined
    return {
      id: harnessId,
      ready,
      ...(harness ? { label: harness.capabilities.display.label } : {}),
      canSchedule: ready && this.options.automationAllowed(harnessId),
    }
  }

  summary(agent: CustomAgent, tasks: readonly TaskSummary[]): CustomAgentSummary {
    const { instructions: _i, skills, tools: _t, createdAt: _c, updatedAt: _u, ...rest } = agent
    const unavailableReason = this.unavailable(agent)
    return {
      ...rest,
      skillCount: skills.length,
      memoryCount: this.options.agents.memories(agent.id).length,
      sessionCount: tasks.filter(task => task.agent?.customAgentId === agent.id).length,
      available: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
      canAutomate: unavailableReason === undefined && this.options.automationAllowed(agent.harnessId),
      generalFacts: this.factCounts(agent),
    }
  }

  /** 「认识你」 as the Agent's page shows it: how many of 通用's confirmed memories its turns carry now, of how many. */
  private factCounts(agent: CustomAgent): { sent: number; total: number } {
    const { facts, total } = generalFacts(this.options.agents.memories(GENERAL_AGENT_ID))
    return { sent: agent.generalFactsOff ? 0 : facts.length, total }
  }

  /** The request's choices on top of the agent's defaults: changing them affects only this session. */
  selection(
    agent: CustomAgent,
    chosen: { harnessId?: string; mode?: 'chat' | 'agent'; model?: ModelRef; workspaceId?: string },
  ): AgentSessionSelection {
    const harnessId = chosen.harnessId ?? agent.harnessId
    // Another engine has its own models and modes, so the agent's say nothing about it.
    const own = harnessId === agent.harnessId
    const model = chosen.model ?? (own ? agent.model : undefined)
    const workspaceId = chosen.workspaceId ?? agent.defaultProjectId
    const config =
      own && this.options.harness(harnessId)?.capabilities.models.owner !== 'latch'
        ? Object.entries(agent.engineOptions ?? {}).map(([configId, value]) => ({ configId, value }))
        : []
    return {
      harnessId,
      mode: chosen.mode ?? (own ? agent.mode : 'agent'),
      ...(model ? { model } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(config.length ? { config } : {}),
    }
  }

  /**
   * The context of one of 我的 Agent on an engine, for a turn a device sends. A start also asks `unavailable`; an open
   * session keeps its own model. Only a device with data scope `all` gets 「认识你」 and 「它做过什么」 into the turn: the
   * Agent's reply may repeat them. Neither is in the revision, so they apply as they stand when the turn is sent, as 通用
   * does for a Code session.
   */
  agentContext(id: string, harnessId: string, scope: DataScope | undefined): AgentExecutionContext {
    const agent = this.options.agents.get(id)
    assertAgentWorksHere(agent)
    return this.build(agent, harnessId, scope === 'all')
  }

  /** What a session on this engine that picks no other agent receives; undefined while 通用 has nothing to add. */
  generalContext(harnessId: string): AgentExecutionContext | undefined {
    const delivery = this.options.harness(harnessId)?.agentContext
    if (!delivery) return undefined
    const { instructions, skills: chosen } = this.options.agents.general(),
      memories = this.options.agents.memories(GENERAL_AGENT_ID),
      skills = this.generalSkills(chosen)
    if (!instructions.trim() && !memories.length && skills === undefined) return undefined
    const harness = this.options.harness(harnessId)!
    return agentContext({
      delivery,
      revision: this.options.agents.definitionHash(GENERAL_AGENT_ID),
      ...this.skillDelivery(harness, skills),
      brief: {
        agentName: '通用',
        engineName: harness.capabilities.display.label,
        instructions,
        memories,
        skillNames: this.skillNames(harness, skills ?? []),
      },
    })
  }

  /**
   * A conversation with 通用: what any session on the Harness gets from 通用, and on a Harness that can call it,
   * `propose_memory`. Such a conversation always has a context, so its turns stay private even while 通用 is empty.
   */
  generalChatContext(harnessId: string, base: AgentExecutionContext | undefined): AgentExecutionContext | undefined {
    const harness = this.options.harness(harnessId)
    if (!harness || !canPropose(harness)) return base
    return {
      ...(base ?? { instructions: '', revision: this.options.agents.definitionHash(GENERAL_AGENT_ID) }),
      proposals: true,
      ...(harnessId === STANDARD ? { generalChat: true as const } : {}),
    }
  }

  /** Only a scheduled dispatch is unattended; an explicit manual run keeps its caller's normal session authority. */
  automation(
    config: AutomationConfig | Pick<AutomationConfig, 'customAgentId' | 'model' | 'projectId'>,
    trigger: 'schedule' | 'manual' = 'schedule',
  ): AutomationPlan {
    const agent = config.customAgentId ? this.options.agents.get(config.customAgentId) : undefined
    const workspaceId = config.projectId
    const harnessId = agent?.harnessId ?? STANDARD
    const harness = this.options.harness(harnessId)
    if (!harness || harness.status !== 'ready')
      throw new AppError(409, 'agent-unavailable', '这个 Harness 暂时不可用，请检查电脑上的配置。')
    if (workspaceId && !this.options.projectUsable(workspaceId))
      throw new AppError(409, 'workspace-unavailable', '找不到所选项目，或它暂不可用。')
    const hostModel = harness.capabilities.models.owner === 'latch'
    // The run's own choice, the Agent's, the project's 默认模型, then the Host's default where the harness has none of its own.
    // An Agent on a Harness with its own models may have picked one of those among its options: that is the Agent's
    // choice too, so the project's default stays out of its way, as it does when a session sends start options.
    const ownOptions = !hostModel && Object.keys(agent?.engineOptions ?? {}).length > 0
    const model =
      config.model
      ?? agent?.model
      ?? (ownOptions ? undefined : this.options.projectModel(workspaceId, harnessId))
      ?? (hostModel ? this.options.defaultModel() : undefined)
    if (hostModel && (!model || !this.options.modelAvailable(model))) throw new AppError(409, 'provider-unavailable', '请先配置模型服务。')
    const provider = model ? this.options.providerOwner(model.providerId) : undefined
    if (hostModel && !provider) throw new AppError(409, 'provider-unavailable', '模型服务不可用。')
    if (agent) {
      const reason = this.unavailable(agent)
      if (reason) throw new AppError(409, 'agent-unavailable', reason)
    }
    const owner = agent?.id ?? GENERAL_AGENT_ID,
      plugins = this.options.plugins()
    // A run's capabilities are every plugin that could give it tools or skills, so one turned on later changes what was
    // turned on. An engine or a model service alone gives it nothing, and most have no revision that survives a restart.
    const skills = agent?.skills ?? this.generalSkills(this.options.agents.general().skills)
    const tools =
      agent?.tools
      ?? plugins
        .filter(plugin => plugin.capabilities.some(item => item.startsWith('tool:') || item.startsWith('skill:')))
        .map(plugin => plugin.id)
    const skillOwners = skills ? skills.map(id => id.slice(0, id.indexOf(':'))) : tools
    const owners = harnessId === STANDARD ? [STANDARD_PLUGIN, provider!, ...tools, ...skillOwners] : [...skillOwners]
    const snapshot = this.options.revisions([...new Set(owners)])
    // A run's basis covers what it receives, so neither 「认识你」 nor 「它做过什么」 goes in: a fact confirmed in 通用 would
    // otherwise pause every schedule. The person's own later turns in that session carry them.
    const context = agent ? this.build(agent, harnessId, false) : this.generalContext(harnessId)
    const definition = this.options.agents.definitionHash(owner)
    const mode = agent?.mode ?? 'agent'
    const choices = !hostModel ? Object.entries(agent?.engineOptions ?? {}).map(([configId, value]) => ({ configId, value })) : []
    return {
      basis: sha256Hex(
        canonicalJson({
          definition,
          harnessId,
          mode,
          ...(model ? { model } : {}),
          tools: agent?.tools ?? null,
          revisions: snapshot.hashed,
          environment: this.options.environment(workspaceId),
        }),
      ),
      persistent: snapshot.persistent,
      harnessId,
      mode,
      ...(choices.length ? { config: choices } : {}),
      ...(model ? { model } : {}),
      agentContext: {
        ...(context ?? { instructions: '', revision: definition }),
        expectedRevisions: snapshot.revisions,
        ...(trigger === 'schedule' ? { unattended: true } : {}),
      },
    }
  }

  /** Nobody chose 通用 for a session, so a skill whose plugin went away drops out rather than stopping ordinary work. */
  private generalSkills(skills: string[] | undefined): string[] | undefined {
    if (!skills) return undefined
    const known = new Set(this.options.skills().map(skill => skill.id))
    return skills.filter(id => known.has(id))
  }

  private build(agent: CustomAgent, harnessId: string, personal: boolean): AgentExecutionContext {
    const harness = this.options.harness(harnessId)
    if (!harness?.agentContext) throw new AppError(409, 'agent-unavailable', '这个 Harness 收不到 Agent 的指令。')
    const facts = personal && !agent.generalFactsOff ? generalFacts(this.options.agents.memories(GENERAL_AGENT_ID)).facts : []
    const digest = personal ? this.options.digest?.(agent.id) : undefined
    return agentContext({
      agent: { customAgentId: agent.id },
      delivery: harness.agentContext,
      revision: this.options.agents.definitionHash(agent.id),
      ...(agent.tools ? { pluginIds: agent.tools } : {}),
      ...this.skillDelivery(harness, agent.skills),
      proposals: canPropose(harness),
      brief: {
        agentName: agent.name,
        engineName: harness.capabilities.display.label,
        instructions: agent.instructions,
        memories: this.options.agents.memories(agent.id),
        skillNames: this.skillNames(harness, agent.skills),
        ...(facts.length ? { facts } : {}),
        ...(digest ? { digest } : {}),
      },
    })
  }

  /** On an engine that cannot take skills they are simply not sent, and the agent's page says so. */
  private skillDelivery(harness: HarnessInfo, skills: string[] | undefined): { skillIds?: string[]; skillBodies?: AgentSkillBody[] } {
    if (!skills) return {}
    if (harness.skills === 'native') return { skillIds: skills }
    return harness.skills === 'server' && skills.length ? { skillBodies: this.options.skillBodies(skills) } : {}
  }

  private skillNames(harness: HarnessInfo, ids: readonly string[]): string[] {
    if (harness.skills !== 'server') return []
    const skills = this.options.skills()
    return ids.flatMap(id => skills.find(skill => skill.id === id)?.name ?? [])
  }
}

/**
 * Whether an Agent's session on this Harness can propose memories: the built-in one through its own tool, an external
 * one through the skills server. A Harness that takes no MCP servers (pi) cannot; only 「记住…」 works there.
 */
export function canPropose(harness: Pick<HarnessInfo, 'agentContext' | 'skills'>): boolean {
  return harness.agentContext === 'private' || harness.skills === 'server'
}
