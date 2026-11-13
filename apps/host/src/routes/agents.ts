import { z } from 'zod'
import type {
  AgentComputer,
  AgentHome,
  ChangedFile,
  CustomAgentDetail,
  CustomAgentList,
  GeneralAgentDetail,
  HostFeatures,
  MemoryProposalList,
  ScheduleResultList,
  TaskDetail,
  TaskSummary,
} from '@latch/protocol'
import { GENERAL_AGENT_ID } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { AgentActor, AgentMutation, CustomAgents } from '../custom-agents.ts'
import type { AgentPlans } from '../agent-plans.ts'
import type { Automations } from '../automations.ts'
import type { HostComputer } from '../computer.ts'
import { activityPage, libraryPage, sessionOwner } from '../agent-activity.ts'
import { json, jsonBody } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type Caller, type RouteContext, type RouteModule } from './registry.ts'

export interface AgentRouteDeps {
  agents: CustomAgents
  plans: () => AgentPlans
  automations: () => Automations
  /** The same gate a session of an agent uses: its instructions and memories are private. */
  access: (caller: Caller, write?: boolean) => AgentActor
  sessions: () => Promise<TaskSummary[]>
  plugins: () => CustomAgentList['plugins']
  /** A session's detail and the files its turns changed, for 资料库. */
  detail: (sessionId: string) => Promise<TaskDetail>
  sessionFiles: (sessionId: string) => Promise<ChangedFile[] | undefined>
  computer: () => HostComputer
  home: (owner: string) => Promise<AgentHome>
}

const deletion = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u) })
const AGENT = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)(?:\/memories(?:\/(mem_[a-f0-9-]{36})(\/undo)?)?)?$/u
const PROPOSALS = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)\/proposals(?:\/(prp_[a-f0-9-]{36})\/(save|dismiss))?$/u
/** Read-only views of an owner's own records: result cards waiting for a topic, 动态, 资料库 and 电脑. */
const VIEWS = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)\/(results|activity|library|computer|home)$/u

/** 我的 Agent and 通用. `/link/api/agents` keeps meaning engine definitions. */
export function createAgentRoutes(context: RouteContext, deps: AgentRouteDeps): RouteModule {
  const { agents } = deps
  const plans = { summary: (...args: Parameters<AgentPlans['summary']>) => deps.plans().summary(...args) }
  return {
    features: () => ({ customAgents: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (path !== '/link/api/custom-agents' && !path.startsWith('/link/api/custom-agents/')) return false
      const actor = deps.access(caller, method !== 'GET')
      const reply = <T>(result: AgentMutation<T>, code = 200) => {
        actor.authorize()
        if (!result.audited) res.setHeader('x-latch-audit', 'failed')
        context.refresh()
        json(res, result.value, code)
      }
      /** A change to what an agent's sessions and automations receive. */
      const edit = async <T>(owner: string, save: () => Promise<AgentMutation<T>>, code = 200) =>
        reply(
          await deps.automations().edit(owner === GENERAL_AGENT_ID ? undefined : owner, actor, save, () => agents.definitionHash(owner)),
          code,
        )
      if (method === 'GET') await agents.recover().catch(() => {})
      if (path === '/link/api/custom-agents') {
        if (method === 'GET') {
          const tasks = await deps.sessions()
          actor.authorize()
          const list: CustomAgentList = {
            general: { ...agents.general(), memoryCount: agents.memories(GENERAL_AGENT_ID).length },
            agents: agents.list().map(agent => plans.summary(agent, tasks)),
            plugins: deps.plugins(),
          }
          json(res, list)
          return true
        }
        if (method === 'POST') {
          reply(await agents.create((await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['create']>[0], actor), 201)
          return true
        }
        throw new AppError(404, 'not-found', '接口不存在。')
      }
      const view = VIEWS.exec(path)
      if (view) {
        if (method !== 'GET') throw new AppError(404, 'not-found', '接口不存在。')
        const owner = view[1]!,
          which = view[2]!
        // Each answers only for an owner that exists, and only to a device that may read Agents (the access above).
        agents.memories(owner)
        if (which === 'home') {
          const hint = await deps.home(owner)
          actor.authorize()
          json(res, hint)
          return true
        }
        const params = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
        const automations = deps.automations()
        if (which === 'results') {
          const list: ScheduleResultList = { results: automations.resultsOf(owner, null) }
          actor.authorize()
          json(res, list)
          return true
        }
        if (which === 'computer') {
          const computer = deps.computer()
          const view: AgentComputer = {
            computer: computer.view(),
            missed: automations.missedOf(owner).map(item => ({ ...item, cause: computer.cause(item.at) })),
          }
          actor.authorize()
          json(res, view)
          return true
        }
        // Its own sessions, by the owner each one ran for: a schedule moved to another Agent leaves its runs behind. A run
        // of 通用's schedule names no Agent and is no conversation with it, so it is 通用's while its schedule is.
        const general = new Set(owner === GENERAL_AGENT_ID ? automations.runsOf(owner).map(row => row.automation.id) : [])
        const sessions = (await deps.sessions()).filter(task => {
          const own = sessionOwner(task)
          return own === owner || (own === undefined && task.automationId !== undefined && general.has(task.automationId))
        })
        const page =
          which === 'activity'
            ? activityPage({
                sessions,
                automations: automations.runsOf(owner),
                results: automations.results().filter(item => item.owner === owner),
                memories: agents.memories(owner),
                changes: agents.memoryChanges(owner),
                proposals: agents.proposals(owner),
                before: params.get('before'),
              })
            : await libraryPage({
                sessions,
                detail: id => deps.detail(id),
                files: id => deps.sessionFiles(id),
                before: params.get('before'),
              })
        actor.authorize()
        json(res, page)
        return true
      }
      const proposal = PROPOSALS.exec(path)
      if (proposal) {
        const owner = proposal[1]!,
          proposalId = proposal[2],
          verb = proposal[3]
        if (method === 'GET' && !proposalId) {
          const list: MemoryProposalList = { proposals: agents.proposals(owner) }
          actor.authorize()
          json(res, list)
        } else if (method === 'POST' && proposalId && verb === 'save') {
          const { requestId } = deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          await edit(owner, () => agents.saveProposal(owner, proposalId, requestId, actor))
        } else if (method === 'POST' && proposalId && verb === 'dismiss') {
          const { requestId } = deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          reply(await agents.dismissProposal(owner, proposalId, requestId, actor))
        } else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      const match = AGENT.exec(path)
      if (!match) throw new AppError(404, 'not-found', '接口不存在。')
      const id = match[1]!,
        memoryId = match[2],
        undo = match[3] !== undefined,
        memories = path.includes('/memories'),
        general = id === GENERAL_AGENT_ID
      if (memories) {
        if (method === 'GET' && !memoryId) json(res, { memories: agents.memories(id) })
        else if (method === 'POST' && memoryId && undo) {
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['undoMemory']>[2]
          await edit(id, () => agents.undoMemory(id, memoryId, body, actor))
        } else if (method === 'DELETE' && memoryId && undo) {
          // 清除: a deleted memory's text goes now; nothing a session receives changes.
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['forgetChange']>[2]
          reply(await agents.forgetChange(id, memoryId, body, actor))
        } else if (undo) throw new AppError(404, 'not-found', '接口不存在。')
        else if (method === 'POST' && !memoryId) {
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['createMemory']>[1]
          await edit(id, () => agents.createMemory(id, body, actor), 201)
        } else if (method === 'PATCH' && memoryId) {
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['patchMemory']>[2]
          await edit(id, () => agents.patchMemory(id, memoryId, body, actor))
        } else if (method === 'DELETE' && memoryId) {
          const { requestId } = deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          await edit(id, () => agents.removeMemory(id, memoryId, requestId, actor))
        } else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      if (method === 'GET') {
        if (general) {
          const detail: GeneralAgentDetail = {
            general: agents.general(),
            memories: agents.memories(GENERAL_AGENT_ID),
            memoryChanges: agents.memoryChanges(GENERAL_AGENT_ID),
          }
          json(res, detail)
          return true
        }
        const tasks = await deps.sessions()
        actor.authorize()
        const agent = agents.get(id),
          { instructions, skills, tools, createdAt, updatedAt } = agent
        const detail: CustomAgentDetail = {
          agent: { ...plans.summary(agent, tasks), instructions, skills, ...(tools ? { tools } : {}), createdAt, updatedAt },
          memories: agents.memories(id),
          memoryChanges: agents.memoryChanges(id),
          sessions: tasks.filter(task => task.agent?.customAgentId === id),
        }
        json(res, detail)
      } else if (method === 'PATCH') {
        const body = await jsonBody(req, CONFIG_BODY_LIMIT)
        if (general) await edit(id, () => agents.patchGeneral(body as Parameters<CustomAgents['patchGeneral']>[0], actor))
        else await edit(id, () => agents.patch(id, body as Parameters<CustomAgents['patch']>[1], actor))
      } else if (method === 'DELETE' && !general) {
        const { requestId } = deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        await edit(id, () => agents.remove(id, requestId, actor))
      } else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
}
