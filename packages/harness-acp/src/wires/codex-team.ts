import { z } from 'zod'

const nativeId = z.string().min(1).max(512)
const agentName = z.string().min(1).max(512)

export const codexTeamThread = z.object({
  id: nativeId,
  parentThreadId: nativeId.nullish(),
  agentNickname: agentName.nullish().catch(undefined),
  agentRole: agentName.nullish().catch(undefined),
})

export const codexTeamThreadPage = z.object({
  data: z.array(z.unknown()).max(100),
  nextCursor: z.string().max(4096).nullish(),
})

const memberState = z.enum(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'])
const collaboration = z.object({
  type: z.literal('collabAgentToolCall'),
  id: nativeId,
  tool: z.literal('spawnAgent'),
  status: z.enum(['inProgress', 'completed', 'failed', 'interrupted']),
  senderThreadId: nativeId,
  receiverThreadIds: z.array(nativeId).max(64),
  prompt: z
    .string()
    .max(64 * 1024)
    .nullish()
    .catch(undefined),
  agentsStates: z.record(nativeId, z.object({ status: memberState })),
})

const activity = z.object({
  type: z.literal('subAgentActivity'),
  id: nativeId,
  kind: z.enum(['started', 'interacted', 'interrupted', 'completed']),
  agentThreadId: nativeId,
  agentPath: agentName,
})

export const codexTeamItem = z.discriminatedUnion('type', [collaboration, activity])
export const codexTeamTurn = z.object({
  id: nativeId,
  status: z.enum(['inProgress', 'completed', 'failed', 'interrupted']),
  error: z
    .object({ message: z.string().max(64 * 1024) })
    .nullish()
    .catch(undefined),
})

const historyItem = z.object({
  type: z.literal('agentMessage'),
  text: z.string().max(64 * 1024),
  phase: z.enum(['commentary', 'final_answer']).nullish(),
})
export const codexTeamHistory = z.object({ data: z.array(codexTeamTurn).max(8) })
export const codexTeamHistoryItems = z.object({ data: z.array(z.unknown()).max(24) })

export function teamHistoryResult(items: unknown[]): string | undefined {
  const messages = items.flatMap(item => {
    const parsed = historyItem.safeParse(item)
    return parsed.success && parsed.data.phase !== 'commentary' ? [parsed.data.text] : []
  })
  return messages.at(-1)
}

export const codexTeamFeatures = z.object({
  data: z.array(z.object({ name: z.string(), enabled: z.boolean() })).max(200),
  nextCursor: z.string().max(4096).nullish(),
})

export type CodexTeamItem = z.infer<typeof codexTeamItem>
export type CodexTeamThread = z.infer<typeof codexTeamThread>

type TeamWorkState = { state: 'running' | 'idle' | 'unknown'; stopReason?: 'end_turn' | 'cancelled'; error?: 'failed' }

export interface CodexMemberUpdate {
  title?: string
  description?: string
  parentTurnId?: string
  childTurnId?: string
  result?: string
  failure?: string
  state?: TeamWorkState
  recovered?: true
}

interface Member {
  parentId: string
  parentTurnId?: string
  title?: string
  childTurnId?: string
  terminal?: TeamWorkState
  active?: true
  restored?: true
  result?: string
  failure?: string
  previousTurns?: Set<string>
}

/** A new wire follows only proved descendants of the thread it was opened for. */
export class CodexTeam {
  private readonly members = new Map<string, Member>()

  constructor(
    readonly rootId: string,
    private readonly publish: (id: string, update: CodexMemberUpdate) => void,
  ) {}

  owns(id: string): boolean {
    return this.members.has(id)
  }

  hasActiveMember(id?: string): boolean {
    const active = (member?: Member) => member?.active === true && (member.parentTurnId !== undefined || member.restored === true)
    return id === undefined ? [...this.members.values()].some(active) : active(this.members.get(id))
  }

  activeMembers(): Array<{ threadId: string; turnId: string }> {
    return [...this.members].flatMap(([threadId, member]) =>
      this.hasActiveMember(threadId) && member.childTurnId ? [{ threadId, turnId: member.childTurnId }] : [],
    )
  }

  spawnTargets(item: CodexTeamItem): string[] {
    if (item.type === 'subAgentActivity') return item.kind === 'started' ? [item.agentThreadId] : []
    if (item.tool !== 'spawnAgent' || item.senderThreadId !== this.rootId || item.status !== 'completed') return []
    return item.receiverThreadIds.filter(id => item.agentsStates[id]?.status !== 'notFound')
  }

  acceptsTurn(id: string, turnId: unknown): boolean {
    const member = this.members.get(id)
    return member !== undefined && !member.terminal && (member.childTurnId === undefined || member.childTurnId === turnId)
  }

  acceptThread(thread: CodexTeamThread): boolean {
    if (!thread.parentThreadId) return false
    const member = this.accept(thread.id, thread.parentThreadId)
    if (!member) return false
    const title = thread.agentNickname ?? thread.agentRole ?? undefined
    if (title && title !== member.title) {
      member.title = title
      if (member.parentTurnId && member.parentId === this.rootId) this.publish(thread.id, { title, parentTurnId: member.parentTurnId })
    }
    return true
  }

  observeItem(threadId: string, turnId: string, item: CodexTeamItem): void {
    if (threadId !== this.rootId) return
    for (const id of this.spawnTargets(item))
      this.spawn(
        id,
        turnId,
        item.type === 'subAgentActivity' ? item.agentPath : undefined,
        item.type === 'collabAgentToolCall' ? (item.prompt ?? undefined) : undefined,
      )
  }

  start(id: string, turnId: string): void {
    const member = this.members.get(id)
    if (!member || member.childTurnId === turnId || member.previousTurns?.has(turnId)) return
    const incoming = turnTime(turnId)
    const current = turnTime(member.childTurnId)
    if (incoming !== undefined && current !== undefined && incoming < current) return
    // Only a new observed child turn, rather than a late tool or snapshot, can reopen a member.
    if (member.childTurnId) {
      member.previousTurns ??= new Set()
      if (member.previousTurns.size < 64) member.previousTurns.add(member.childTurnId)
      else return
    }
    member.childTurnId = turnId
    member.active = true
    delete member.terminal
    delete member.result
    delete member.failure
    if (member.parentTurnId || member.restored)
      this.publish(id, {
        ...(member.parentTurnId ? { parentTurnId: member.parentTurnId } : {}),
        childTurnId: turnId,
        state: { state: 'running' },
      })
  }

  finish(id: string, turnId: string, status: string, failure?: string): void {
    const member = this.members.get(id)
    if (!member || member.terminal || (member.childTurnId && member.childTurnId !== turnId)) return
    const state = terminalState(status)
    if (!state) return
    member.childTurnId = turnId
    member.terminal = state
    delete member.active
    if (status === 'failed' && failure) member.failure = failure
    if (member.parentTurnId || member.restored)
      this.publish(id, {
        ...(member.parentTurnId ? { parentTurnId: member.parentTurnId } : {}),
        childTurnId: turnId,
        state,
        ...(member.result ? { result: member.result } : {}),
        ...(member.failure ? { failure: member.failure } : {}),
      })
  }

  output(id: string, turnId: string, text: string): void {
    const member = this.members.get(id)
    if (!member || (member.childTurnId && member.childTurnId !== turnId) || (member.terminal && member.result)) return
    member.childTurnId = turnId
    this.reportResult(id, member, text)
  }

  restoreMember(thread: CodexTeamThread): boolean {
    if (thread.parentThreadId !== this.rootId || !this.acceptThread(thread)) return false
    const member = this.members.get(thread.id)!
    if (member.restored) return true
    member.restored = true
    if (!member.parentTurnId && member.childTurnId)
      this.publish(thread.id, {
        childTurnId: member.childTurnId,
        ...(member.title ? { title: member.title } : {}),
        ...(member.result ? { result: member.result } : {}),
        ...(member.failure ? { failure: member.failure } : {}),
        ...(member.terminal ? { state: member.terminal } : member.active ? { state: { state: 'running' } } : {}),
      })
    return true
  }

  recover(id: string, childTurnId: string, status: 'completed' | 'failed', result?: string, failure?: string): void {
    const member = this.members.get(id)
    // A live event may have proven a more recent turn while the read was in flight.
    if (!member?.restored || member.parentTurnId || member.childTurnId) return
    const state = terminalState(status)
    if (!state) return
    member.childTurnId = childTurnId
    member.terminal = state
    if (result) member.result = result
    if (status === 'failed' && failure) member.failure = failure
    this.publish(id, {
      recovered: true,
      childTurnId,
      ...(member.title ? { title: member.title } : {}),
      state,
      ...(result ? { result } : {}),
      ...(status === 'failed' && failure ? { failure } : {}),
    })
  }

  private accept(id: string, parentId: string): Member | undefined {
    if (id === this.rootId || id === parentId || (parentId !== this.rootId && !this.members.has(parentId))) return
    const known = this.members.get(id)
    if (known) return known.parentId === parentId ? known : undefined
    if (this.members.size >= 256) return
    const member = { parentId }
    this.members.set(id, member)
    return member
  }

  private spawn(id: string, turnId: string, title: string | undefined, description: string | undefined): void {
    const member = this.members.get(id)
    if (member?.parentId !== this.rootId || member.parentTurnId) return
    member.parentTurnId = turnId
    if (title) member.title ??= title
    this.publish(id, {
      parentTurnId: turnId,
      ...(member.childTurnId ? { childTurnId: member.childTurnId } : {}),
      ...(member.title ? { title: member.title } : {}),
      ...(description ? { description } : {}),
      ...(member.result ? { result: member.result } : {}),
      ...(member.failure ? { failure: member.failure } : {}),
      state: member.terminal ?? { state: 'running' },
    })
  }

  private reportResult(id: string, member: Member, text: string): void {
    if (!text.trim() || text === member.result) return
    member.result = text.slice(0, 16_000)
    if (member.childTurnId && (member.parentTurnId || member.restored))
      this.publish(id, {
        ...(member.parentTurnId ? { parentTurnId: member.parentTurnId } : {}),
        childTurnId: member.childTurnId,
        result: member.result,
      })
  }
}

/** Codex-generated turn IDs are UUIDv7, with the start timestamp in their first 48 bits. */
function turnTime(id: string | undefined): number | undefined {
  const parts = id && /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.exec(id)
  return parts ? Number.parseInt(parts[1]! + parts[2]!, 16) : undefined
}

function terminalState(status: string): TeamWorkState | undefined {
  if (status === 'completed') return { state: 'idle', stopReason: 'end_turn' }
  if (status === 'failed') return { state: 'idle', error: 'failed' }
  if (status === 'interrupted') return { state: 'idle', stopReason: 'cancelled' }
  if (status === 'unknown') return { state: 'unknown' }
}
