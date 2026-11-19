// The built-in harness's way through the Host's model scheduler: the same candidates, failure classes, retries, health
// and limits as a harness that reaches a service through the gateway, without the loopback port. A service's provider is
// wrapped once; the wrapped one tries the run's candidates in order until one starts to answer.
import { AsyncLocalStorage } from 'node:async_hooks'
import { AppError, type ModelDelta, type ModelProvider } from '@latch/sdk'
import type { ModelFailureClass, TokenUsage, UsageOutcome } from '@latch/protocol'
import type { ModelMeter } from './model-budgets.ts'
import { classifyStatus, type AttemptFailure, type AttemptTimer, type DispatchResult, type ModelScheduler } from './model-scheduler.ts'
import { ProviderError } from './plugins/providers/http.ts'

/** One service a run's request may go to, as the Host has it when the run's first request arrives. */
export interface ProviderCandidate {
  providerId: string
  model: string
  fingerprint: string
  /** The service's own provider while it is still what `fingerprint` names; undefined once it is off, gone or changed. */
  provider(): ModelProvider | undefined
}

export interface ScheduledProviderDeps {
  scheduler: ModelScheduler
  /** What `model` of `providerId` falls back to now, in order, without the service itself. */
  fallbacks(providerId: string, model: string): ProviderCandidate[]
  fingerprint(providerId: string): string
  /** On record before a request moves on; a throw keeps it where it is. */
  fallback(event: { sessionId: string; providerId: string; candidate: number; reason: ModelFailureClass }): Promise<void>
  /** Monthly budgets and the usage ledger, the same ones the gateway goes through. */
  meter?: ModelMeter
  now?: () => number
}

/**
 * The request under way in this async context: whose it is, for the permit it waits for, and its first-byte clock, which
 * the service's own fetch moves when the response arrives and holds while the request waits for the Host's permit.
 */
export const scheduledRequest = new AsyncLocalStorage<{ sessionId: string; providerId: string; timer: AttemptTimer }>()

interface Turn {
  candidates: Map<string, ProviderCandidate[]>
  moved: Map<string, number>
}

interface Opened {
  iterator: AsyncIterator<ModelDelta>
  first: IteratorResult<ModelDelta>
}

/** Runs remembered at a time: each keeps its candidates and where it moved to until newer runs push it out. */
const MAX_TURNS = 256
const RETRIABLE_CODES = new Set(['empty-response', 'invalid-content-type', 'stream-incomplete'])

type Sorted = Exclude<ModelFailureClass, 'unavailable' | 'circuit-open'>

/** How a provider's failure before its first delta is sorted; undefined for one that is not the service's to answer for. */
function sortFailure(error: unknown): Sorted | undefined {
  if (error instanceof AppError) return undefined
  if (error instanceof ProviderError) {
    if (error.code === 'http-error' && error.status !== undefined) return classifyStatus(error.status, error.message) as Sorted
    // A provider's own timeout is a silence like any other: the request may still be running there.
    if (error.code === 'timeout') return 'timeout'
    if (error.code === 'network-error') return 'network'
    return RETRIABLE_CODES.has(error.code) ? 'server' : 'request'
  }
  return 'network'
}

export function scheduledProvider(raw: ModelProvider, deps: ScheduledProviderDeps): ModelProvider {
  const turns = new Map<string, Turn>()
  const turnOf = (key: string | undefined): Turn => {
    const fresh = (): Turn => ({ candidates: new Map(), moved: new Map() })
    if (key === undefined) return fresh()
    let turn = turns.get(key)
    if (!turn) {
      turns.set(key, (turn = fresh()))
      if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value!)
    }
    return turn
  }
  return {
    ...raw,
    async *stream(request): AsyncIterable<ModelDelta> {
      const model = request.model ?? raw.model
      const { signal, run } = request
      const turn = turnOf(run ? `${run.sessionId}\n${run.runId}` : undefined)
      let candidates = turn.candidates.get(model)
      if (!candidates) {
        const own: ProviderCandidate = { providerId: raw.id, model, fingerprint: deps.fingerprint(raw.id), provider: () => raw }
        // Without a run there is no session to put a switch on record for, so nothing is switched.
        candidates = [own, ...(run ? deps.fallbacks(raw.id, model) : [])]
        turn.candidates.set(model, candidates)
      }
      const sessionId = run?.sessionId ?? ''
      const { meter } = deps
      const now = deps.now ?? (() => deps.scheduler.clock.now())
      const arrived = now()
      // The request's line in the usage ledger, written once: names and numbers, nothing the request or the reply said.
      const usage: {
        written: boolean
        attempts: number
        at: number
        firstByteMs?: number
        tokens?: TokenUsage
        cost?: number
      } = { written: false, attempts: 0, at: 0 }
      const writeUsage = (outcome: UsageOutcome) => {
        if (!meter || usage.written) return undefined
        usage.written = true
        const asked = candidates[usage.at]!
        return meter.record({
          at: arrived,
          ...(sessionId ? { sessionId } : {}),
          providerId: asked.providerId,
          model: asked.model,
          outcome,
          attempts: usage.attempts,
          fallback: usage.at > 0,
          ...(usage.firstByteMs !== undefined ? { firstByteMs: usage.firstByteMs } : {}),
          totalMs: now() - arrived,
          ...(usage.tokens ? { usage: usage.tokens } : {}),
          ...(usage.cost !== undefined ? { reportedCost: usage.cost } : {}),
        })
      }
      // An Agent's budget is that Agent's alone: used up, its request goes to no service at all.
      if (sessionId && meter?.agentOver(sessionId)) {
        writeUsage('budget')
        throw new AppError(402, 'budget-exceeded', '本月预算已用完')
      }
      let overBudget = false
      let result: DispatchResult<Opened, unknown>
      try {
        result = await deps.scheduler.dispatch<Opened, unknown>({
          sessionId,
          candidates,
          ...(turn.moved.has(model) ? { start: turn.moved.get(model)! } : {}),
          signal,
          attempt: async (index, attemptSignal, timer) => {
            const candidate = candidates[index]!
            const provider = candidate.provider()
            if (!provider) return { skip: true }
            // Used up like the balance at the service: the next candidate is asked, on record first.
            if (meter?.serviceOver(candidate.providerId)) {
              overBudget = true
              return { skip: true, reason: 'budget' }
            }
            usage.attempts++
            usage.at = index
            // Another model has its own thinking levels: it runs with its default rather than not at all.
            const effort =
              index === 0 || (request.effort && provider.modelCapabilities?.[candidate.model]?.thinking?.includes(request.effort))
                ? request.effort
                : undefined
            const { effort: _effort, run: _run, ...rest } = request
            const iterator = provider
              .stream({ ...rest, signal: attemptSignal, model: candidate.model, ...(effort ? { effort } : {}) })
              [Symbol.asyncIterator]()
            try {
              const first = await scheduledRequest.run({ sessionId, providerId: candidate.providerId, timer }, () => iterator.next())
              // The first event of any kind, for a provider whose fetch is not the Host's.
              timer.began()
              return { ok: true, value: { iterator, first } }
            } catch (error) {
              await iterator.return?.().catch(() => {})
              if (attemptSignal.aborted) throw error
              const sorted = sortFailure(error)
              // What only this candidate cannot do says nothing against the ones after it.
              if (index > 0 && (sorted === undefined || sorted === 'request')) {
                if (error instanceof AppError && error.code === 'gateway-busy') throw error
                return { skip: true }
              }
              if (sorted === undefined) throw error
              const failure: AttemptFailure<unknown> = {
                class: sorted,
                reply: error,
                // Shown again while the breaker keeps requests from the service: what it said, as the run would have.
                ...(error instanceof Error && error.message ? { reason: error.message.slice(0, 300) } : {}),
              }
              return { ok: false, ...failure }
            }
          },
          timedOut: () => new ProviderError('模型服务没有在时限内开始回复。', 'timeout'),
          beforeSwitch: (from, to, reason) => deps.fallback({ sessionId, providerId: candidates[from]!.providerId, candidate: to, reason }),
        })
      } catch (error) {
        writeUsage(signal.aborted ? 'aborted' : error instanceof AppError && error.code === 'gateway-busy' ? 'busy' : 'request')
        throw error
      }
      if (!result.ok) {
        if (result.failure) usage.at = result.index
        // A candidate that is only held back opens again by itself: the budget is the answer only when nothing else could be.
        const refused = overBudget && result.failure === undefined && !result.changed && result.retryAfterMs === undefined
        writeUsage(result.failure ? result.failure.class : result.changed ? 'unavailable' : refused ? 'budget' : 'circuit-open')
        // A real failure stays a failure: the service's own error, never another model's answer.
        if (result.failure) throw result.failure.reply
        // The service was edited while the run was under way: the run says so, as it did before there were candidates.
        if (result.changed) throw new AppError(409, 'model-route-changed', '模型服务的设置已经变了，请重新选择模型。')
        if (refused) throw new AppError(402, 'budget-exceeded', '本月预算已用完')
        throw new AppError(
          503,
          'provider-circuit-open',
          `这个模型服务一直出错，Latch 暂时没有向它发送请求。请稍后再试。${result.reason ? `最近一次：${result.reason}` : ''}`,
        )
      }
      if (result.index > 0) turn.moved.set(model, result.index)
      else turn.moved.delete(model)
      const { iterator } = result.value
      usage.at = result.index
      usage.firstByteMs = now() - arrived
      // Stopped by the caller unless the reply runs to its end or breaks by itself.
      let end: 'complete' | 'broken' | 'aborted' = 'aborted'
      try {
        const answered = candidates[result.index]!
        if (result.index > 0) yield { type: 'route', providerId: answered.providerId, model: answered.model }
        let next = result.value.first
        while (!next.done) {
          const delta = next.value
          if (delta.type === 'usage') {
            const { type: _type, cost, ...tokens } = delta
            usage.tokens = tokens
            if (cost !== undefined) usage.cost = cost
          }
          // Counted before the reply's last event, so the turn that ends on it knows what it cost.
          if (delta.type === 'finish') {
            const spend = writeUsage('ok')
            if (spend) yield { type: 'spend', spend }
          }
          yield delta
          next = await iterator.next()
        }
        end = 'complete'
      } catch (error) {
        if (!signal.aborted) end = 'broken'
        throw error
      } finally {
        await iterator.return?.().catch(() => {})
        writeUsage(end === 'complete' ? 'ok' : end === 'broken' ? 'stream' : 'aborted')
        result.done(end)
      }
    },
  }
}
