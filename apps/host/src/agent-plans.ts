import type {
  AgentExecutionContext,
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
import { agentContext, type AgentSessionSelection, type CustomAgents } from './custom-agents.ts'
import type { AutomationPlan } from './automations.ts'

const STANDARD = 'standard'
const STANDARD_PLUGIN = 'standard-harness'

interface Options {
  agents: CustomAgents
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
  /** What a run's folders depend on: the policy, the start directory and the project's folders. */
  environment(projectId: string | undefined): unknown
}

/** Turns saved agents into what a session of them receives. Nothing here is taken from a request. */
export class AgentPlans {
  constructor(private readonly options: Options) {}

  /** Why a session cannot start on this agent now, in words for the person. */
  unavailable(agent: CustomAgent): string | undefined {
    if (agent.defaultProjectId && !this.options.projectUsable(agent.defaultProjectId)) return '默认项目已移除，请更新这个 Agent。'
    const harness = this.options.harness(agent.harnessId)
    if (!harness || harness.status !== 'ready') return '这个引擎暂时不可用，请检查电脑上的配置。'
    if (!harness.agentContext) return '这个引擎收不到 Agent 的指令。'
    const enabled = new Set(this.options.plugins().map(plugin => plugin.id))
    if (harness.models === 'host') {
      if (agent.tools?.some(id => !enabled.has(id))) return '选择的插件已停用或移除，请更新这个 Agent。'
      const model = agent.model ?? this.options.defaultModel()
      if (!model || !this.options.modelAvailable(model)) return '选择的模型服务暂不可用，请在电脑上检查模型配置。'
    }
    const known = new Set(this.options.skills().map(skill => skill.id))
    if (harness.skills && agent.skills.some(id => !known.has(id))) return '选择的技能已停用或移除，请更新这个 Agent。'
    return undefined
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
      canAutomate: unavailableReason === undefined && agent.harnessId === STANDARD,
    }
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
    return {
      harnessId,
      mode: chosen.mode ?? (own ? agent.mode : 'agent'),
      ...(model ? { model } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    }
  }

  /** The context of one of 我的 Agent on an engine. A start also asks `unavailable`; an open session keeps its own model. */
  agentContext(id: string, harnessId: string): AgentExecutionContext {
    return this.build(this.options.agents.get(id), harnessId)
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
        engineName: harness.name,
        instructions,
        memories,
        skillNames: this.skillNames(harness, skills ?? []),
      },
    })
  }

  /** What an unattended run needs, for the built-in engine only: a run nobody watches cannot answer a full-access prompt. */
  automation(config: AutomationConfig): AutomationPlan {
    const agent = config.customAgentId ? this.options.agents.get(config.customAgentId) : undefined
    if (agent && agent.harnessId !== STANDARD) throw new AppError(409, 'automation-engine', '自动化目前只能用 Latch 引擎运行。')
    if (config.projectId && !this.options.projectUsable(config.projectId))
      throw new AppError(409, 'workspace-unavailable', '找不到所选项目，或它暂不可用。')
    const model = config.model ?? agent?.model ?? this.options.defaultModel()
    if (!model || !this.options.modelAvailable(model)) throw new AppError(409, 'provider-unavailable', '请先配置模型服务。')
    const provider = this.options.providerOwner(model.providerId)
    if (!provider) throw new AppError(409, 'provider-unavailable', '模型服务不可用。')
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
    const snapshot = this.options.revisions([...new Set([STANDARD_PLUGIN, provider, ...tools, ...skillOwners])])
    const context = agent ? this.build(agent, STANDARD) : this.generalContext(STANDARD)
    const definition = this.options.agents.definitionHash(owner)
    const mode = agent?.mode ?? 'agent'
    return {
      basis: sha256Hex(
        canonicalJson({
          definition,
          mode,
          model,
          tools: agent?.tools ?? null,
          revisions: snapshot.hashed,
          environment: this.options.environment(config.projectId),
        }),
      ),
      persistent: snapshot.persistent,
      mode,
      model,
      agentContext: {
        ...(context ?? { instructions: '', revision: definition }),
        expectedRevisions: snapshot.revisions,
      },
    }
  }

  /** Nobody chose 通用 for a session, so a skill whose plugin went away drops out rather than stopping ordinary work. */
  private generalSkills(skills: string[] | undefined): string[] | undefined {
    if (!skills) return undefined
    const known = new Set(this.options.skills().map(skill => skill.id))
    return skills.filter(id => known.has(id))
  }

  private build(agent: CustomAgent, harnessId: string): AgentExecutionContext {
    const harness = this.options.harness(harnessId)
    if (!harness?.agentContext) throw new AppError(409, 'agent-unavailable', '这个引擎收不到 Agent 的指令。')
    return agentContext({
      agent: { customAgentId: agent.id },
      delivery: harness.agentContext,
      revision: this.options.agents.definitionHash(agent.id),
      ...(agent.tools ? { pluginIds: agent.tools } : {}),
      ...this.skillDelivery(harness, agent.skills),
      brief: {
        agentName: agent.name,
        engineName: harness.name,
        instructions: agent.instructions,
        memories: this.options.agents.memories(agent.id),
        skillNames: this.skillNames(harness, agent.skills),
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
