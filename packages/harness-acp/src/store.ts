import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isFileChange, type FileChange, isFileMention, type FileMention, isAttachmentRef, type AttachmentRef } from '@latch/protocol'
import type { Message, SessionCommand, PlanEntry, SessionConfigOption, TaskSummary, UsageReport } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'
import type { ConfigSource } from './mapping.ts'

export interface AcpRecord {
  /** Absent until session/new succeeds. */
  acpSessionId?: string
  cwd: string
  agentVersion?: string
  /** Number of prompts sent in this task; scopes tool message IDs. */
  turnSeq: number
  /** Whether `config` came from `configOptions` or the legacy `models`/`modes` fields. */
  configSource?: ConfigSource
  /** The agent offered session/delete when this session was last bound, so removal may start it to ask. */
  deletable?: boolean
  /** Launch fingerprint the owner confirmed. Absent on sessions created before it existed; those cannot continue. */
  launchHash?: string
  /**
   * The definition's part of `launchHash`, without the project configuration, to tell which of the two changed.
   * Absent on sessions confirmed before project configuration counted, whose `launchHash` is only that part.
   */
  definitionHash?: string
  /** Mode the owner chose through Latch; overrides the profile's expected mode. */
  expectedMode?: string
  /** The agent changed its own mode beyond the expected one; the session no longer accepts input. */
  drift?: { at: string; observed: string }
  /** Preset whose permission profile applied when the session was created. */
  profilePresetId?: string
  /**
   * The real paths of the folders the agent receives besides `cwd`, in order, and how (`folderVia`). Both are part of
   * the confirmed launch; absent when the session passes no other folder.
   */
  folders?: string[]
  folderVia?: 'acp' | 'args'
}

export interface AcpTask {
  summary: TaskSummary
  messages: Message[]
  commands?: SessionCommand[]
  plan?: PlanEntry[]
  config?: SessionConfigOption[]
  /** The agent's latest report of its context window and cost. */
  usageReport?: UsageReport
  revision: number
  acp: AcpRecord
}

/** A deleted task keeps its creation receipt so a retried create is answered instead of repeated. */
export interface AcpReceipt {
  taskId: string
  payloadHash: string
  kind: 'create' | 'prompt'
  deleted?: boolean
}

export interface AcpState {
  version: 1
  tasks: Record<string, AcpTask>
  receipts: Record<string, AcpReceipt>
}

const usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
})
const toolDetail = z.object({
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']).optional(),
  title: z.string().optional(),
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
const message = z.object({
  fileRefs: z.array(z.custom<FileMention>(isFileMention)).max(32).optional(),
  outputs: z.array(z.custom<FileChange>(isFileChange)).max(1000).optional(),
  outputsPending: z.literal(true).optional(),
  outputsTruncated: z.literal(true).optional(),
  outputsUnavailable: z.literal(true).optional(),
  attachments: z.array(z.custom<AttachmentRef>(isAttachmentRef)).max(8).optional(),
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  text: z.string(),
  requestId: z.string().optional(),
  queuedAt: z.string().optional(),
  toolName: z.string().optional(),
  state: z.enum(['queued', 'awaiting-approval', 'running', 'completed', 'failed', 'cancelled']).optional(),
  reasoning: z.string().optional(),
  tool: toolDetail.optional(),
  usage: usage.optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  reasoningMs: z.number().nonnegative().optional(),
  model: z.string().optional(),
  providerId: z.string().optional(),
  turn: z
    .object({ endedAt: z.string().optional(), activeMs: z.number().nonnegative().optional(), waitMs: z.number().nonnegative().optional() })
    .optional(),
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
        status: z.enum(['idle', 'running', 'waiting-approval', 'cancelled', 'failed', 'interrupted']),
        cwd: z.string().optional(),
        model: z.string().optional(),
        mode: z.enum(['chat', 'agent']).optional(),
        usage: usage.optional(),
        permissionDrift: z.literal(true).optional(),
        workspaceId: z.string().optional(),
        folders: z.array(z.object({ id: z.string(), path: z.string() })).optional(),
        folderAccess: z.enum(['all', 'primary']).optional(),
        runId: z.string().min(1).max(128).optional(),
        runOutcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional(),
      }),
      messages: z.array(message),
      plan: z
        .array(
          z.object({
            content: z.string(),
            status: z.enum(['pending', 'in_progress', 'completed']),
            priority: z.enum(['high', 'medium', 'low']).optional(),
          }),
        )
        .optional(),
      config: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            category: z.string().optional(),
            description: z.string().optional(),
            currentValue: z.string(),
            options: z.array(z.object({ value: z.string(), name: z.string(), description: z.string().optional() })),
          }),
        )
        .optional(),
      commands: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            description: z.string().max(1000).optional(),
            inputHint: z.string().max(500).optional(),
          }),
        )
        .max(200)
        .optional(),
      usageReport: z
        .object({
          contextUsed: z.number().nonnegative().optional(),
          contextSize: z.number().nonnegative().optional(),
          cost: z.object({ amount: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/u) }).optional(),
          at: z.string(),
        })
        .optional(),
      revision: z.number().int().nonnegative(),
      acp: z.object({
        acpSessionId: z.string().optional(),
        cwd: z.string(),
        agentVersion: z.string().optional(),
        turnSeq: z.number().int().nonnegative(),
        configSource: z.enum(['options', 'legacy']).optional(),
        deletable: z.boolean().optional(),
        launchHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        definitionHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        expectedMode: z.string().optional(),
        drift: z.object({ at: z.string(), observed: z.string() }).optional(),
        profilePresetId: z.string().optional(),
        folders: z.array(z.string()).optional(),
        folderVia: z.enum(['acp', 'args']).optional(),
      }),
    }),
  ),
  receipts: z.record(
    z.string(),
    z.object({
      taskId: z.string(),
      payloadHash: z.string(),
      kind: z.enum(['create', 'prompt']),
      deleted: z.boolean().optional(),
    }),
  ),
})

export function emptyAcpState(): AcpState {
  return { version: 1, tasks: {}, receipts: {} }
}

export interface AcpStore {
  load(): Promise<AcpState>
  /** Atomically replaces the snapshot with already serialized state. */
  write(serialized: string): Promise<void>
  close(): Promise<void>
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Single-writer store under the driver's data directory: lock file, temp file, fsync, rename. */
export function createAcpStore(dataDir: string): AcpStore {
  const file = join(dataDir, 'acp.json')
  const lockFile = join(dataDir, 'acp.lock')
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
          throw new AppError(409, 'store-lock-invalid', 'Harness 数据锁无法验证，请确认没有另一个运行实例后删除 acp.lock')
        }
        try {
          process.kill(pid, 0)
        } catch (probeError) {
          if (codeOf(probeError) === 'ESRCH') {
            if ((await readFile(lockFile, 'utf8').catch(() => '')) === previous) await unlink(lockFile).catch(() => {})
            continue
          }
        }
        throw new AppError(409, 'store-in-use', '同一 Harness 数据目录已有运行实例，请关闭它或选择另一个目录')
      }
    }
    throw new AppError(409, 'store-in-use', '无法取得 Harness 数据目录的写入锁')
  }

  return {
    async load() {
      if (closed) throw new Error('ACP store is closed')
      if (!owned) await acquire()
      try {
        const value = stateSchema.parse(JSON.parse(await readFile(file, 'utf8'))) as AcpState
        for (const [id, task] of Object.entries(value.tasks)) {
          if (task.summary.id !== id) throw new Error('Task identity mismatch')
        }
        for (const receipt of Object.values(value.receipts)) {
          if (!value.tasks[receipt.taskId] && !(receipt.kind === 'create' && receipt.deleted))
            throw new Error('Receipt references a missing task')
        }
        loaded = true
        return value
      } catch (error) {
        if (codeOf(error) === 'ENOENT') {
          loaded = true
          return emptyAcpState()
        }
        await this.close()
        throw new AppError(
          500,
          'store-corrupt',
          `Harness 会话数据无法读取，原文件已保留：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    async write(serialized) {
      if (!owned || !loaded || closed) throw new Error('ACP store is not open')
      await writeFileAtomic(file, serialized, { prefix: '.acp-' })
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
