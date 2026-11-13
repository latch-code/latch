import { AppError, type ConfigReading, type ConfigRefusal } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { ConfigRecord, SessionReceipts } from './session-meta.ts'

type State = ConfigRecord['state']
interface Input {
  requestId: string
  configId: string
  value: string
}
interface Actor {
  deviceId: string
  authorize(): Promise<void>
}
interface Flight {
  hash: string
  promise: Promise<void>
  waiters: number
}
/** What the change asks the Driver to fence: the option's value before it and the change's audit entry. */
export interface ConfigBegin {
  prior?: string | undefined
  auditSeq?: number | undefined
}
type Begin = (context?: ConfigBegin) => Promise<void>
/** What 核对 found; `settled` when this check recorded the final state. */
export interface ConfigCheck {
  state: State
  settled: boolean
  reason?: 'running' | 'subagents' | 'unread' | 'neither'
  auditSeq?: number
}
const valueHash = (configId: string, value: string) => sha256Hex(canonicalJson({ configId, value }))
const keyOf = (session: string, device: string, rid: string) => JSON.stringify([session, device, rid])
const unknown = () => new AppError(503, 'config-outcome-unknown', '设置结果未知：没有收到 Agent 的确认。核对后再选。')
const REFUSALS: ReadonlySet<unknown> = new Set<ConfigRefusal>(['not-sent', 'refused'])
/**
 * A refusal that certainly did not apply (`Bridge.setConfig`): 409 `task-running` before anything reaches the agent, or
 * one marked with `details.configOutcome`.
 */
const notApplied = (error: unknown) =>
  error instanceof AppError && (error.code === 'task-running' || REFUSALS.has(error.details?.configOutcome))

/** The same error, marked as a refusal raised before the change reached the driver. */
export function notSentConfig(error: unknown): unknown {
  if (!(error instanceof AppError) || error.details?.configOutcome !== undefined) return error
  return new AppError(error.status, error.code, error.message, { ...error.details, configOutcome: 'not-sent' satisfies ConfigRefusal })
}

/** A durable fence before the external call. Reading or replaying a receipt never calls the Agent. */
export class ConfigRequests {
  private readonly flights = new Map<string, Flight>()
  private readonly checks = new Map<string, Promise<ConfigCheck>>()
  private readonly preparations = new Map<string, { deviceId: string; hash: string; unknown?: true }>()
  private closed = false
  private waiters = 0
  constructor(
    private readonly receipts: SessionReceipts,
    private readonly now: () => number = Date.now,
  ) {}

  state(sessionId: string, deviceId: string, requestId: string): State {
    const key = keyOf(sessionId, deviceId, requestId)
    if (this.preparations.get(key)?.unknown) return 'unknown'
    const saved = this.receipts.config(sessionId, deviceId, requestId)
    return saved?.state ?? (this.flights.has(key) ? 'pending' : 'unknown')
  }

  /** Writes the Agent may or may not have taken: in flight now, or left unknown when their receipt could not be written. */
  pending(): number {
    return this.flights.size + [...this.preparations].filter(([key, row]) => row.unknown && !this.flights.has(key)).length
  }

  async apply(sessionId: string, actor: Actor, input: Input, execute: (begin: Begin) => Promise<void>): Promise<void> {
    if (this.closed) throw new AppError(503, 'host-closing', '电脑正在停止，请稍后查询原请求。')
    const key = keyOf(sessionId, actor.deviceId, input.requestId),
      hash = valueHash(input.configId, input.value),
      saved = this.receipts.config(sessionId, actor.deviceId, input.requestId),
      preparing = this.preparations.get(key),
      flight = this.flights.get(key)
    if ((saved && saved.payloadHash !== hash) || (preparing && preparing.hash !== hash) || (flight && flight.hash !== hash))
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同配置。')
    if (flight) {
      if (flight.waiters >= 32 || this.waiters >= 256)
        throw new AppError(429, 'config-requests-busy', '正在等待的配置请求较多，请查询原请求。')
      flight.waiters++
      this.waiters++
      try {
        await flight.promise
        await actor.authorize()
        return
      } finally {
        flight.waiters--
        this.waiters--
      }
    }
    if (saved || preparing?.unknown) {
      await actor.authorize()
      if (this.state(sessionId, actor.deviceId, input.requestId) === 'applied') return
      if (saved?.state === 'failed') throw new AppError(409, 'config-request-failed', '这次配置修改已明确失败，请刷新后作为新修改提交。')
      throw unknown()
    }
    if (!preparing) {
      if (this.preparations.size >= 256 || [...this.preparations.values()].filter(row => row.deviceId === actor.deviceId).length >= 32)
        throw new AppError(429, 'config-requests-busy', '正在确认的配置请求较多，请先处理原请求。')
      this.preparations.set(key, { deviceId: actor.deviceId, hash })
    }
    const run = this.perform(sessionId, actor, input, hash, key, execute)
    this.flights.set(key, { hash, promise: run, waiters: 0 })
    try {
      await run
      await actor.authorize()
    } finally {
      if (this.flights.get(key)?.promise === run) this.flights.delete(key)
    }
  }

  private async perform(
    sessionId: string,
    actor: Actor,
    input: Input,
    hash: string,
    key: string,
    execute: (begin: Begin) => Promise<void>,
  ): Promise<void> {
    let reserving = false
    let fence: { priorHash?: string; auditSeq?: number } = {}
    const record = (state: State) =>
      this.receipts.recordConfig(sessionId, {
        kind: 'config',
        deviceId: actor.deviceId,
        requestId: input.requestId,
        payloadHash: hash,
        state,
        at: new Date(this.now()).toISOString(),
        ...fence,
      })
    try {
      await actor.authorize()
      await execute(async context => {
        await actor.authorize()
        reserving = true
        fence = {
          ...(context?.prior !== undefined ? { priorHash: valueHash(input.configId, context.prior) } : {}),
          ...(context?.auditSeq !== undefined ? { auditSeq: context.auditSeq } : {}),
        }
        await record('pending')
        await actor.authorize()
      })
      if (!reserving) throw new AppError(500, 'config-fence-missing', '配置修改缺少持久回执。')
      await record('applied')
      this.preparations.delete(key)
    } catch (error) {
      if (!reserving && error instanceof AppError && error.code === 'stepup-required') throw error
      const uncertain = reserving && !notApplied(error)
      try {
        await record(uncertain ? 'unknown' : 'failed')
        this.preparations.delete(key)
      } catch {
        const prepared = this.preparations.get(key)
        if (prepared) prepared.unknown = true
        throw unknown()
      }
      if (uncertain) throw unknown()
      throw error
    }
  }

  /**
   * 核对: settles an unknown change from what the agent reports now, never by sending it again. A reading the Driver
   * counts as the asked value is applied; one equal to the value before the change, read while the session is idle, is
   * failed; anything else (another device changed it meanwhile, no reading) stays unknown. Only the device that sent the
   * change can settle it, with the same content.
   */
  async check(sessionId: string, actor: Actor, input: Input, read: () => Promise<ConfigReading>): Promise<ConfigCheck> {
    if (this.closed) throw new AppError(503, 'host-closing', '电脑正在停止，请稍后查询原请求。')
    const key = keyOf(sessionId, actor.deviceId, input.requestId),
      hash = valueHash(input.configId, input.value),
      saved = this.receipts.config(sessionId, actor.deviceId, input.requestId),
      preparing = this.preparations.get(key)
    if ((saved && saved.payloadHash !== hash) || (preparing && preparing.hash !== hash))
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同配置。')
    await actor.authorize()
    const state = this.state(sessionId, actor.deviceId, input.requestId)
    // Nothing on record from this device under this identity: there is nothing to settle.
    if (state !== 'unknown' || (!saved && !preparing?.unknown)) return { state, settled: false }
    const running = this.checks.get(key)
    if (running) return running
    const run = (async (): Promise<ConfigCheck> => {
      const reading = await read()
      await actor.authorize()
      const audit = saved?.auditSeq !== undefined ? { auditSeq: saved.auditSeq } : {}
      if (reading.kind !== 'read')
        return { state: 'unknown', settled: false, reason: reading.kind === 'busy' ? reading.reason : 'unread', ...audit }
      const next: State | undefined = reading.asked
        ? 'applied'
        : saved?.priorHash !== undefined && valueHash(input.configId, reading.currentValue) === saved.priorHash
          ? 'failed'
          : undefined
      if (!next) return { state: 'unknown', settled: false, reason: 'neither', ...audit }
      try {
        await this.receipts.recordConfig(sessionId, {
          kind: 'config',
          deviceId: actor.deviceId,
          requestId: input.requestId,
          payloadHash: hash,
          state: next,
          at: new Date(this.now()).toISOString(),
          ...(saved?.priorHash !== undefined ? { priorHash: saved.priorHash } : {}),
          ...audit,
        })
      } catch {
        return { state: 'unknown', settled: false, ...audit }
      }
      this.preparations.delete(key)
      return { state: next, settled: true, ...audit }
    })()
    this.checks.set(key, run)
    try {
      return await run
    } finally {
      this.checks.delete(key)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.flights.values(), ...this.checks.values()].map(row => ('promise' in row ? row.promise : row)))
  }
}
