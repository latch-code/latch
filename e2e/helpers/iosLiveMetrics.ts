import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { TestDevice } from '@latch/testkit'
import type { TestHost } from './host.ts'

const KINDS = ['task-state', 'task-delta', 'tasks-invalidated', 'refresh', 'host-state', 'heartbeat', 'snapshot', 'detail'] as const

/** Read existing owner-only counters and fixture message identities; never persist text, URLs or credentials. */
export async function iosLiveMetrics(target: TestHost, owner: TestDevice) {
  const traffic = await owner.json<{
    kinds: Record<string, { count: number; bytes: number }>
    connections: Array<{ listener: string; frames: number; bytes: number; heartbeats: number; closedAt?: string }>
  }>('traffic')
  const tasks = []
  for (const task of (await target.host.bridge.listTasks()).slice(0, 12)) {
    // This read is deliberately in-process: the observer must not inflate the App's GET /tasks counter.
    const detail = await target.host.bridge.detail(task.id)
    const last = detail.messages.findLast(message => message.role === 'assistant')
    tasks.push({
      id: task.id,
      status: task.status,
      messages: detail.messages.length,
      users: detail.messages.filter(message => message.role === 'user').length,
      approvals: detail.approvals.length,
      ...(detail.liveMessageId ? { live: { id: detail.liveMessageId, bytes: Buffer.byteLength(detail.liveText) } } : {}),
      ...(last ? { lastAssistant: { id: last.id, bytes: Buffer.byteLength(last.text) } } : {}),
    })
  }
  return {
    at: Date.now(),
    kinds: Object.fromEntries(KINDS.map(kind => [kind, { count: traffic.kinds[kind]!.count, bytes: traffic.kinds[kind]!.bytes }])),
    connections: traffic.connections.map(connection => ({
      listener: connection.listener,
      frames: connection.frames,
      bytes: connection.bytes,
      heartbeats: connection.heartbeats,
      closed: connection.closedAt !== undefined,
    })),
    tasks,
  }
}

/** Five-second, bounded samples survive the manual run; an explicit .metrics flag may request an extra sample. */
export function iosLiveMetricRecorder(output: string, targets: Array<{ host: TestHost; owner: TestDevice }>) {
  const samples: Array<{ hosts: Array<{ host: number; value: Awaited<ReturnType<typeof iosLiveMetrics>> | { unavailable: true } }> }> = []
  let previous = 0
  return async (force = false) => {
    if (!force && Date.now() - previous < 5000) return
    previous = Date.now()
    const hosts = []
    for (const [index, target] of targets.entries()) {
      const value = await iosLiveMetrics(target.host, target.owner).catch(() => ({ unavailable: true as const }))
      hosts.push({ host: index + 1, value })
    }
    if (samples.length >= 2048) samples.pop()
    samples.push({ hosts })
    await writeFile(join(output, 'traffic.json'), JSON.stringify(samples, null, 2) + '\n', { mode: 0o600 })
  }
}

/** Actual ACP history, populated through the normal Host API before opening the App. */
export async function seedIosStream(target: TestHost, owner: TestDevice, harnessId: string, turns = 10, bytes = 20_000) {
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { harnessId, mode: 'agent', prompt: `big ${bytes}`, requestId: randomUUID() },
  })
  const settled = () => expect.poll(async () => (await target.host.bridge.detail(sessionId)).summary.status).toBe('idle')
  await settled()
  for (let index = 1; index < turns; index++) {
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: `big ${bytes}`, requestId: randomUUID() } })
    await settled()
  }
  await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title: '原生流式验收' } })
  return sessionId
}
