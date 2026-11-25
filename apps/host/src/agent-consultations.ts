import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { CUSTOM_AGENT_ID, GENERAL_AGENT_ID, type consultationScope } from '@latch/protocol'
import type { ConsultationChange } from './custom-agents.ts'
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
  scope: Exclude<ReturnType<typeof consultationScope>, 'off'>
  owner: string
  requestId: string
  caller: DeviceCaller
}

type BoundPrompt = PersonPrompt & { agentsGrant: symbol; externalGrant: symbol; receiverGeneration: number }

/** Only a person's actual prompt grants a turn. Starting a peer, retrying a receipt, or restoring a process grants nothing. */
export class ConsultationTurns {
  private readonly input = new AsyncLocalStorage<BoundPrompt | undefined>()
  private readonly runs = new Map<string, BoundPrompt & { runId: string }>()
  private readonly grants = new Map<string, { agents: symbol; external: symbol }>()

  private receiverGeneration = 0
  private readonly receiverChanges = new Map<string, number>()

  prompt<T>(person: PersonPrompt | undefined, start: () => T): T {
    if (!person) return this.input.run(undefined, start)
    let granted = this.grants.get(person.owner)
    if (!granted) {
      granted = { agents: Symbol(), external: Symbol() }
      this.grants.set(person.owner, granted)
    }
    return this.input.run(
      { ...person, agentsGrant: granted.agents, externalGrant: granted.external, receiverGeneration: this.receiverGeneration },
      start,
    )
  }

  /** A re-enable applies to new human input, including when an older prompt has yet to acquire a run ID. */
  changed(owner: string, { outgoing, receiverChanged }: ConsultationChange): void {
    if (outgoing === 'all') this.grants.delete(owner)
    if (outgoing === 'external') {
      const granted = this.grants.get(owner)
      if (granted) granted.external = Symbol()
    }
    if (receiverChanged) this.receiverChanges.set(owner, ++this.receiverGeneration)
  }

  forget(owner: string): void {
    this.grants.delete(owner)
    this.receiverChanges.delete(owner)
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
    return {
      owner: person.owner,
      caller: person.caller,
      requestId: person.requestId,
      scope: person.externalGrant === granted.external ? person.scope : ('builtin' as const),
      receiverUnchanged: (id: string) => (this.receiverChanges.get(id) ?? 0) <= person.receiverGeneration,
    }
  }
}

export const consultDenied = () => new AppError(403, 'agent-consult-denied', '当前聊天、设备或 Agent 设置不允许主动协作。')
