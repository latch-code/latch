import { setTimeout as delay } from 'node:timers/promises'
import type { TaskSummary } from '@latch/protocol'
import { AppError } from '@latch/sdk'

/** Agent-to-agent handoffs after the first reply to one person's message. Nothing an agent writes raises it. */
export const RELAY_LIMIT = 3

type RelayState = 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface RelayResult {
  state: RelayState
  /** `changed`: an agent's settings differ from when the message was accepted, so the next one did not start. */
  reason?: 'changed'
  /** The sessions that ran, in order. */
  sessionIds: string[]
  /** What stopped the chain when a start or a read failed. */
  error?: unknown
}

export interface RelayOptions<Member> {
  /** In the order the person chose; the first answers the message. */
  members: readonly Member[]
  /** A hash of what the member runs with now: its instructions, Harness, mode, model and plugin code. */
  basis(member: Member): string
  start(member: Member, index: number): Promise<{ sessionId: string }>
  summary(sessionId: string): Promise<Pick<TaskSummary, 'status' | 'runId' | 'runOutcome'>>
  cancel(sessionId: string, runId?: string): Promise<unknown>
  pollMs?: number
}

const RUNNING = new Set<TaskSummary['status']>(['running', 'waiting-approval'])

/**
 * One person's message handed from agent to agent, each turn an ordinary session. A turn that does not complete ends the
 * chain, and a changed setting stops it before the next agent starts.
 */
export class RelayChain<Member> {
  /** Settles once the last turn that started has settled. */
  readonly done: Promise<RelayResult>
  private stopping = false
  private current?: string
  private readonly cancelled = new Set<string>()

  constructor(private readonly options: RelayOptions<Member>) {
    if (options.members.length === 0 || options.members.length > RELAY_LIMIT + 1)
      throw new AppError(400, 'relay-limit', `一条消息最多交给 ${RELAY_LIMIT + 1} 个 Agent 依次回复。`)
    const bases = options.members.map(member => options.basis(member))
    this.done = this.run(bases)
  }

  /** Stops the chain. Resolves only after the running turn has really settled, so a stop is never reported early. */
  async stop(): Promise<RelayResult> {
    this.stopping = true
    if (this.current) await this.cancelRun(this.current)
    return this.done
  }

  private async run(bases: string[]): Promise<RelayResult> {
    const sessionIds: string[] = []
    try {
      for (const [index, member] of this.options.members.entries()) {
        if (this.stopping) return { state: 'cancelled', sessionIds }
        if (this.options.members.some((each, at) => this.options.basis(each) !== bases[at]))
          return { state: 'interrupted', reason: 'changed', sessionIds }
        const { sessionId } = await this.options.start(member, index)
        sessionIds.push(sessionId)
        this.current = sessionId
        const outcome = await this.settled(sessionId)
        this.current = undefined
        if (this.stopping) return { state: 'cancelled', sessionIds }
        if (outcome !== 'completed') return { state: outcome ?? 'interrupted', sessionIds }
      }
      return { state: 'completed', sessionIds }
    } catch (error) {
      if (this.current) {
        // The turn's outcome is unknown: it is asked to stop, and the chain never moves past it.
        await this.options.cancel(this.current).catch(() => {})
        this.current = undefined
      }
      return { state: 'interrupted', sessionIds, error }
    }
  }

  private async settled(sessionId: string): Promise<TaskSummary['runOutcome']> {
    while (true) {
      const summary = await this.options.summary(sessionId)
      if (!RUNNING.has(summary.status)) return summary.runOutcome
      // A stop that arrived before the run was known is sent again once it is.
      if (this.stopping) await this.cancelRun(sessionId, summary.runId)
      await delay(this.options.pollMs ?? 100)
    }
  }

  private async cancelRun(sessionId: string, runId?: string): Promise<void> {
    const run = runId ?? (await this.options.summary(sessionId)).runId
    const key = `${sessionId}\n${run ?? ''}`
    if (this.cancelled.has(key)) return
    this.cancelled.add(key)
    await this.options.cancel(sessionId, run)
  }
}
