import { AppError } from '@latch/sdk'
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
const keyOf = (session: string, device: string, rid: string) => JSON.stringify([session, device, rid])
const unknown = () => new AppError(503, 'config-outcome-unknown', '配置结果尚未确认，请查询原请求，不能重复执行。')
/** A driver refuses with this before anything reaches the agent (`Bridge.setConfig`), so the change certainly did not apply. */
const notSent = (error: unknown) => error instanceof AppError && error.code === 'task-running'

/** A durable fence before the external call. Reading or replaying a receipt never calls the Agent. */
export class ConfigRequests {
  private readonly flights = new Map<string, Flight>()
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

  async apply(sessionId: string, actor: Actor, input: Input, execute: (begin: () => Promise<void>) => Promise<void>): Promise<void> {
    if (this.closed) throw new AppError(503, 'host-closing', '电脑正在停止，请稍后查询原请求。')
    const key = keyOf(sessionId, actor.deviceId, input.requestId),
      hash = sha256Hex(canonicalJson({ configId: input.configId, value: input.value })),
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
    execute: (begin: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    let reserving = false
    const record = (state: State) =>
      this.receipts.recordConfig(sessionId, {
        kind: 'config',
        deviceId: actor.deviceId,
        requestId: input.requestId,
        payloadHash: hash,
        state,
        at: new Date(this.now()).toISOString(),
      })
    try {
      await actor.authorize()
      await execute(async () => {
        await actor.authorize()
        reserving = true
        await record('pending')
        await actor.authorize()
      })
      if (!reserving) throw new AppError(500, 'config-fence-missing', '配置修改缺少持久回执。')
      await record('applied')
      this.preparations.delete(key)
    } catch (error) {
      if (!reserving && error instanceof AppError && error.code === 'stepup-required') throw error
      const uncertain = reserving && !notSent(error)
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

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.flights.values()].map(row => row.promise))
  }
}
