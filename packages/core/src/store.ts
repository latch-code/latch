import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Approval, Message, TaskSummary } from '@latch/protocol'
import { AppError, type ModelMessage, type ToolCall } from '@latch/sdk'
import { writeFileAtomic } from './node-kit/atomic.ts'

export interface StoredTask {
  summary: TaskSummary
  messages: Message[]
  history: ModelMessage[]
  /** Model-visible instructions snapshotted at the start of the current/latest run. */
  skillContext?: string
  revision: number
  approval?: Approval
  /** Written before dispatch; an interrupted started call has an unknown outcome. */
  batch?: { calls: ToolCall[]; started: string[]; completed: string[] }
  /** Tools the user allowed for the rest of this session. */
  allowedTools?: string[]
}

export interface RequestReceipt {
  taskId: string
  payloadHash: string
}
export interface RuntimeState {
  version: 1
  tasks: Record<string, StoredTask>
  receipts: Record<string, RequestReceipt>
  /** Deleted task IDs. Their receipts stay so a retried request cannot recreate the task. */
  tombstones?: Record<string, { deletedAt: string }>
}

/** A commit atomically publishes tasks and their idempotency receipts together. */
export interface RuntimeStore {
  load(): Promise<RuntimeState>
  commit(state: RuntimeState): Promise<void>
  close(): Promise<void>
}

const callSchema = z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) })
const usageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
})
const turnSchema = z.object({
  endedAt: z.string().optional(),
  activeMs: z.number().nonnegative().optional(),
  waitMs: z.number().nonnegative().optional(),
})
// Every persisted field must be listed: z.object drops unknown keys on load.
const toolDetailSchema = z.object({
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']).optional(),
  title: z.string().optional(),
  toolTitle: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  locations: z.array(z.string()).optional(),
  diffs: z
    .array(
      z.object({
        path: z.string(),
        oldText: z.string().optional(),
        newText: z.string(),
        previous: z.enum(['none', 'text', 'unavailable']).optional(),
      }),
    )
    .optional(),
  decision: z
    .object({
      outcome: z.enum(['allowed', 'rejected', 'expired', 'cancelled']),
      at: z.string(),
      via: z.enum(['this-mac', 'other-device']).optional(),
    })
    .optional(),
})
const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  text: z.string(),
  requestId: z.string().optional(),
  toolName: z.string().optional(),
  state: z.enum(['queued', 'awaiting-approval', 'running', 'completed', 'failed', 'cancelled']).optional(),
  reasoning: z.string().optional(),
  tool: toolDetailSchema.optional(),
  usage: usageSchema.optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  reasoningMs: z.number().nonnegative().optional(),
  model: z.string().optional(),
  providerId: z.string().optional(),
  turn: turnSchema.optional(),
})
const historySchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(callSchema).optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
})
const stateSchema = z.object({
  version: z.literal(1),
  tasks: z.record(
    z.string(),
    z.object({
      summary: z.object({
        id: z.string(),
        title: z.string(),
        updatedAt: z.string(),
        createdAt: z.string().optional(),
        cwd: z.string().optional(),
        model: z.string().optional(),
        mode: z.enum(['chat', 'agent']).optional(),
        status: z.enum(['idle', 'running', 'waiting-approval', 'cancelled', 'failed', 'interrupted']),
        harnessId: z.string().optional(),
        providerId: z.string().optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        usage: usageSchema.optional(),
        workspaceId: z.string().optional(),
        folders: z.array(z.object({ id: z.string(), path: z.string() })).optional(),
        runId: z.string().min(1).max(128).optional(),
        skills: z.array(z.string()).optional(),
      }),
      messages: z.array(messageSchema),
      history: z.array(historySchema),
      skillContext: z.string().optional(),
      revision: z.number().int().nonnegative(),
      approval: z
        .object({
          id: z.string(),
          sessionId: z.string(),
          toolName: z.string(),
          toolCallId: z.string().optional(),
          reason: z.string(),
          arguments: z.string().optional(),
          requestedAt: z.string(),
          options: z
            .array(
              z.object({
                id: z.string(),
                label: z.string(),
                kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
              }),
            )
            .optional(),
          tool: toolDetailSchema.optional(),
          risk: z.enum(['R1', 'R2']).optional(),
          advisory: z.literal(true).optional(),
        })
        .optional(),
      batch: z.object({ calls: z.array(callSchema), started: z.array(z.string()), completed: z.array(z.string()) }).optional(),
      allowedTools: z.array(z.string()).optional(),
    }),
  ),
  receipts: z.record(z.string(), z.object({ taskId: z.string(), payloadHash: z.string() })),
  tombstones: z.record(z.string(), z.object({ deletedAt: z.string() })).optional(),
})

export function emptyRuntimeState(): RuntimeState {
  return { version: 1, tasks: {}, receipts: {} }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Local single-writer store. A rename never publishes a partially written snapshot. */
export function createSnapshotStore(dataDir: string): RuntimeStore {
  const file = join(dataDir, 'runtime.json')
  const lockFile = join(dataDir, 'runtime.lock')
  const token = randomUUID()
  let owned = false
  let loaded = false
  let closed = false

  async function acquire(): Promise<void> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await open(lockFile, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
          await handle.sync()
        } finally {
          await handle.close()
        }
        owned = true
        return
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') throw error
        let previous: string
        let pid: number
        try {
          previous = await readFile(lockFile, 'utf8')
          const value: unknown = JSON.parse(previous)
          if (
            typeof value !== 'object'
            || value === null
            || !('pid' in value)
            || !Number.isSafeInteger(value.pid)
            || Number(value.pid) <= 0
          )
            throw new Error('Invalid lock')
          pid = Number(value.pid)
        } catch (readError) {
          if (codeOf(readError) === 'ENOENT') continue
          throw new AppError(409, 'store-lock-invalid', '运行数据锁无法验证，请确认没有另一个运行实例后修复 runtime.lock')
        }
        try {
          process.kill(pid, 0)
        } catch (probeError) {
          if (codeOf(probeError) === 'ESRCH') {
            if ((await readFile(lockFile, 'utf8').catch(() => '')) === previous) await unlink(lockFile).catch(() => {})
            continue
          }
        }
        throw new AppError(409, 'store-in-use', '同一数据目录已有运行实例，请关闭它或选择另一个目录')
      }
    }
    throw new AppError(409, 'store-in-use', '无法取得运行数据目录的写入锁')
  }

  return {
    async load() {
      if (closed) throw new Error('Runtime store is closed')
      if (!owned) await acquire()
      try {
        const value = stateSchema.parse(JSON.parse(await readFile(file, 'utf8')))
        for (const [id, task] of Object.entries(value.tasks)) {
          if (task.summary.id !== id) throw new Error('Task identity mismatch')
        }
        const tombstones = value.tombstones ?? {}
        for (const id of Object.keys(tombstones)) {
          if (Object.hasOwn(value.tasks, id)) throw new Error('Deleted task is still present')
        }
        for (const receipt of Object.values(value.receipts)) {
          if (!Object.hasOwn(value.tasks, receipt.taskId) && !Object.hasOwn(tombstones, receipt.taskId)) {
            throw new Error('Receipt references a missing task')
          }
        }
        loaded = true
        return value
      } catch (error) {
        if (codeOf(error) === 'ENOENT') {
          loaded = true
          return emptyRuntimeState()
        }
        await this.close()
        throw new AppError(
          500,
          'store-corrupt',
          `运行数据无法读取，原文件已保留：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    async commit(state) {
      if (!owned || !loaded || closed) throw new Error('Runtime store is not open')
      await writeFileAtomic(file, `${JSON.stringify(state)}\n`, { prefix: '.runtime-' })
    },
    async close() {
      if (closed) return
      closed = true
      if (!owned) return
      owned = false
      const current = await readFile(lockFile, 'utf8').catch(() => '')
      try {
        const value: unknown = JSON.parse(current)
        if (typeof value === 'object' && value !== null && 'token' in value && value.token === token) await unlink(lockFile)
      } catch (error) {
        if (codeOf(error) !== 'ENOENT' && current !== '') throw error
      }
    },
  }
}
