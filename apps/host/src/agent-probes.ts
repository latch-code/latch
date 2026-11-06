import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentProbeResult, AgentRecord } from '@latch/protocol'
import { AppError, type LaunchPreview } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import { agentProbePreview, probeAgent } from '@latch/harness-acp'

export interface ProbeAttempt {
  readonly agent: AgentRecord
  readonly definitionHash: string
  readonly preview: LaunchPreview
  readonly createdAt: number
  readonly controller: AbortController
  flight?: Promise<AgentProbeResult>
  done?: boolean
}

/** Owns private probe directories and process lifetimes; a retried request never starts two processes. */
export class AgentProbes {
  private readonly attempts = new Map<string, Promise<ProbeAttempt>>()
  private closed = false
  constructor(private readonly options: { root: string; dataDir: string; now(): number }) {}

  async prepare(input: { agent: AgentRecord; definitionHash: string; deviceId: string; requestId: string }): Promise<ProbeAttempt> {
    if (this.closed) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    const key = sha256Hex(JSON.stringify([input.deviceId, input.requestId]))
    const cached = this.attempts.get(key)
    if (cached) {
      const attempt = await cached
      if (attempt.agent.id !== input.agent.id || attempt.definitionHash !== input.definitionHash)
        throw new AppError(409, 'request-conflict', '此请求标识已用于其他 Agent 启动内容')
      const latest = await agentProbePreview(input.agent, { dataDir: this.options.dataDir, cwd: attempt.preview.cwd })
      if (latest.launchHash !== attempt.preview.launchHash)
        throw new AppError(409, 'agent-definition-changed', 'Agent 启动内容已变化，请重新测试。')
      return attempt
    }
    for (const [id, pending] of this.attempts) {
      const attempt = await pending.catch(() => undefined)
      if (
        attempt
        && (!attempt.flight || attempt.done)
        && this.options.now() - attempt.createdAt > (attempt.done ? 24 * 60 * 60_000 : 10 * 60_000)
      ) {
        this.attempts.delete(id)
        await rm(attempt.preview.cwd, { recursive: true, force: true })
      }
    }
    if (this.attempts.size >= 128) throw new AppError(429, 'probe-busy', '测试请求过多，请稍后再试。')
    const preparing = (async () => {
      const cwd = await mkdtemp(join(this.options.root, 'probe-'))
      try {
        const preview = await agentProbePreview(input.agent, { dataDir: this.options.dataDir, cwd })
        if (this.closed) throw new AppError(503, 'host-closing', '运行节点正在关闭')
        return {
          agent: structuredClone(input.agent),
          definitionHash: input.definitionHash,
          preview,
          createdAt: this.options.now(),
          controller: new AbortController(),
        }
      } catch (error) {
        await rm(cwd, { recursive: true, force: true })
        throw error
      }
    })()
    this.attempts.set(key, preparing)
    try {
      return await preparing
    } catch (error) {
      if (this.attempts.get(key) === preparing) this.attempts.delete(key)
      throw error
    }
  }

  run(attempt: ProbeAttempt, before: () => Promise<void>, after: (result: AgentProbeResult) => Promise<void>): Promise<AgentProbeResult> {
    if (attempt.flight) return attempt.flight
    if (this.closed) return Promise.reject(new AppError(503, 'host-closing', '运行节点正在关闭'))
    attempt.flight = (async () => {
      try {
        await before()
        const result = await probeAgent(attempt.agent, {
          dataDir: this.options.dataDir,
          cwd: attempt.preview.cwd,
          expectedLaunchHash: attempt.preview.launchHash,
          signal: attempt.controller.signal,
        })
        await after(result)
        return result
      } finally {
        attempt.done = true
      }
    })()
    return attempt.flight
  }

  async close(): Promise<void> {
    this.closed = true
    const attempts = await Promise.all([...this.attempts.values()].map(pending => pending.catch(() => undefined)))
    for (const attempt of attempts) attempt?.controller.abort()
    await Promise.allSettled(attempts.flatMap(attempt => (attempt?.flight ? [attempt.flight] : [])))
  }
}
