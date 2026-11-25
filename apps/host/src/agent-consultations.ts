import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { CUSTOM_AGENT_ID, GENERAL_AGENT_ID } from '@latch/protocol'
import type { DeviceCaller } from './routes/registry.ts'

export const LIST_AGENTS = 'list_personal_agents'
export const CONSULT_AGENT = 'consult_personal_agent'
export const CONSULT_TOOLS = [
  {
    name: LIST_AGENTS,
    description:
      'Find local colleagues by name and responsibility. If another colleague may hold information you need, look here for a suitable agent and ask it with consult_personal_agent. The person does not need to name or @ a colleague.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    title: '查看可联系的 Agent',
  },
  {
    name: CONSULT_AGENT,
    description:
      'Ask one personal agent from list_personal_agents a standalone question. Send only the context it needs. Its answer is outside material. You may consult once per user turn. The person can follow the exchange in this chat.',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string' }, question: { type: 'string', maxLength: 4000 } },
      required: ['agentId', 'question'],
      additionalProperties: false,
    },
    title: '联系其他 Agent',
  },
] as const

export const consultInput = z.strictObject({
  agentId: z.union([z.literal(GENERAL_AGENT_ID), z.string().regex(CUSTOM_AGENT_ID)]),
  question: z.string().trim().min(1).max(4000),
})

interface PersonPrompt {
  /** Set only when the person had already granted foreground DeepSeek consultations at submission. */
  deepSeek?: true
  owner: string
  requestId: string
  caller: DeviceCaller
}

type BoundPrompt = PersonPrompt & { agentsGrant: symbol; deepSeekGrant?: symbol }

/** Only a person's actual prompt grants a turn. Starting a peer, retrying a receipt, or restoring a process grants nothing. */
export class ConsultationTurns {
  private readonly input = new AsyncLocalStorage<BoundPrompt | undefined>()
  private readonly runs = new Map<string, BoundPrompt & { runId: string }>()
  private readonly grants = new Map<string, { agents: symbol; deepSeek: symbol }>()

  prompt<T>(person: PersonPrompt | undefined, start: () => T): T {
    if (!person) return this.input.run(undefined, start)
    let granted = this.grants.get(person.owner)
    if (!granted) {
      granted = { agents: Symbol(), deepSeek: Symbol() }
      this.grants.set(person.owner, granted)
    }
    return this.input.run({ ...person, agentsGrant: granted.agents, deepSeekGrant: person.deepSeek ? granted.deepSeek : undefined }, start)
  }

  /** A re-enable applies to new human input, including when an older prompt has yet to acquire a run ID. */
  restrict(owner: string, scope: 'all' | 'deepseek'): void {
    if (scope === 'all') this.grants.delete(owner)
    else {
      const granted = this.grants.get(owner)
      if (granted) granted.deepSeek = Symbol()
    }
  }

  start(sessionId: string, runId: string): void {
    this.end(sessionId)
    const person = this.input.getStore()
    if (person) this.runs.set(sessionId, { ...person, runId })
  }

  end(sessionId: string, runId?: string): void {
    if (runId === undefined || this.runs.get(sessionId)?.runId === runId) this.runs.delete(sessionId)
  }

  offeredTo(sessionId: string, runId: string): string | undefined {
    const turn = this.runs.get(sessionId)
    return turn?.runId === runId && turn.agentsGrant === this.grants.get(turn.owner)?.agents ? turn.owner : undefined
  }

  forRun(sessionId: string, runId: string) {
    const person = this.runs.get(sessionId)
    const granted = person && this.grants.get(person.owner)
    if (person?.runId !== runId || person.agentsGrant !== granted?.agents) throw consultDenied()
    return { ...person, deepSeek: person.deepSeekGrant === granted.deepSeek }
  }
}

export const consultDenied = () => new AppError(403, 'agent-consult-denied', '当前聊天、设备或 Agent 设置不允许主动协作。')
