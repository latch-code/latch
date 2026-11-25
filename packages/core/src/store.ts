import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  COST_CURRENCIES,
  CONTEXT_STEP_LIMIT,
  CONTEXT_TOOL_CONTRIBUTION_LIMIT,
  isFileMention,
  isFileChange,
  type FileChange,
  type FileMention,
  isAttachmentRef,
  type AttachmentRef,
  type Approval,
  type Message,
  type DriverTaskSummary,
  type RequestContext,
  type RequestContextStep,
} from '@latch/protocol'
import { AppError, type ModelMessage, type ToolCall } from '@latch/sdk'
import { writeFileAtomic } from './node-kit/atomic.ts'
import { ERROR_CODE, runEndSchema } from './run-end.ts'

export interface StoredHistory extends Omit<ModelMessage, 'attachments'> {
  attachmentRefs?: AttachmentRef[]
  /** Internal only. The result was appended after this observation, before its first inclusion. */
  contextToolSource?: { resultId: string; turnId: string; afterSequence: number }
}
export interface StoredTask {
  summary: DriverTaskSummary
  messages: Message[]
  history: StoredHistory[]
  requestContext?: RequestContext
  contextSteps?: RequestContextStep[]
  /** Crash marker. It becomes a public observation only after dispatch, or when recovery finds the outcome unknown. */
  pendingContextStep?: RequestContextStep
  /** Cleared when the first observation after this reset is recorded, even if preparing the request needs a retry. */
  contextResetPending?: true
  /** Model-visible instructions snapshotted at the start of the current/latest run. */
  skillContext?: string
  revision: number
  approval?: Approval
  /** Written before dispatch; an interrupted started call has an unknown outcome. */
  batch?: { calls: ToolCall[]; started: string[]; completed: string[] }
  /** Tools the user allowed for the rest of this session. */
  allowedTools?: string[]
  /** The session's level (`BuiltinMode`); absent or unreadable: 先问你. */
  permissionMode?: string
  /** A call that may have read outside content ran since the context last started over: proposals are external. */
  outsideRead?: true
  /** How many memories this session has proposed through `propose_memory`. */
  proposals?: number
  /** Created with `workProposals`: its runs offer the board's proposal tools. */
  workProposals?: true
  pluginCreation?: true
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

const callSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  signature: z.object({ by: z.string().max(512), value: z.string().max(1024 * 1024), scope: z.literal('turn').optional() }).optional(),
})
const usageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
})
// What a turn's model requests cost, when the Host knew, and a budget's state: amounts and enums only.
const spendSchema = z.object({
  cost: z
    .array(z.object({ currency: z.enum(COST_CURRENCIES), micros: z.number().nonnegative(), priced: z.literal(true).optional() }))
    .max(COST_CURRENCIES.length)
    .optional(),
  budget: z.enum(['near', 'over']).optional(),
})
const count = z.number().int().nonnegative()
const requestContext = z.strictObject({
  at: z.iso.datetime(),
  userMessages: count,
  assistantMessages: count,
  toolResults: count,
  tools: count,
  skills: count,
  images: count,
  inputTokens: count.optional(),
  creator: z.literal(true).optional(),
})
const contextToolSource = z.strictObject({ resultId: z.uuid(), turnId: z.uuid() })
const contextToolContribution = z.strictObject({
  bytes: count,
  inclusion: z.enum(['new', 'replayed', 'unknown']),
  source: contextToolSource.optional(),
})
const contextStep = requestContext.extend({
  sequence: z.number().int().positive(),
  turnId: z.string().min(1).max(256),
  bytes: z.strictObject({ instructions: count, skills: count, toolSchemas: count, user: count, assistant: count, toolResults: count }),
  toolContributions: z
    .strictObject({
      largest: z.array(contextToolContribution).max(CONTEXT_TOOL_CONTRIBUTION_LIMIT),
      added: z.array(contextToolContribution).max(CONTEXT_TOOL_CONTRIBUTION_LIMIT),
    })
    .optional(),
  unmeasuredTools: count.optional(),
  toolCalls: count,
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  outputTokens: count.optional(),
  durationMs: count.optional(),
  freshContext: z.literal(true).optional(),
})
const turnSchema = z.object({
  endedAt: z.string().optional(),
  activeMs: z.number().nonnegative().optional(),
  waitMs: z.number().nonnegative().optional(),
  // Only the steps a 「出错时改用」 service answered: its ID and model, never content.
  routed: z
    .object({
      requests: count,
      models: z
        .array(
          z.object({
            model: z.string().max(200),
            used: z.string().max(200).optional(),
            requests: count,
            provider: z.string().max(128).optional(),
            fallback: count.optional(),
          }),
        )
        .max(16),
      direct: z.literal(true).optional(),
    })
    .optional(),
  spend: spendSchema.optional(),
})
// Every persisted field must be listed: z.object drops unknown keys on load.
const toolDetailSchema = z.object({
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']).optional(),
  title: z.string().optional(),
  toolTitle: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  outputWithoutFiles: z.string().optional(),
  locations: z.array(z.string()).optional(),
  actions: z
    .array(z.object({ kind: z.enum(['read', 'list', 'search']), path: z.string().optional(), query: z.string().optional() }))
    .max(16)
    .optional(),
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
  judged: z
    .object({
      by: z.string().max(200),
      outcome: z.enum(['approved', 'denied', 'none', 'unasked', 'referred']),
      own: z.literal(true).optional(),
      reason: z.string().max(300).optional(),
    })
    .optional(),
  blocked: z.object({ by: z.string().max(200), source: z.enum(['model', 'rule']), reason: z.string().max(1000).optional() }).optional(),
})
const messageSchema = z.object({
  origin: z.enum(['mcp-prompt', 'conversation-reference', 'agent-mention']).optional(),
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
  freshContext: z.literal(true).optional(),
  toolName: z.string().optional(),
  contextToolId: z.uuid().optional(),
  state: z.enum(['queued', 'awaiting-approval', 'running', 'completed', 'failed', 'cancelled']).optional(),
  interrupted: z.literal(true).optional(),
  errorCode: z.string().regex(ERROR_CODE).optional(),
  reasoning: z.string().optional(),
  tool: toolDetailSchema.optional(),
  usage: usageSchema.optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  reasoningMs: z.number().nonnegative().optional(),
  model: z.string().optional(),
  providerId: z.string().optional(),
  thinking: z.string().max(200).optional(),
  turn: turnSchema.optional(),
  turnId: z.string().max(128).optional(),
})
const historySchema = z.object({
  attachmentRefs: z.array(z.custom<AttachmentRef>(isAttachmentRef)).max(8).optional(),
  contextToolSource: contextToolSource.extend({ afterSequence: count }).optional(),
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
        effort: z.string().optional(),
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
        runOutcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional(),
        runEnd: runEndSchema.optional(),
        skills: z.array(z.string()).optional(),
        personal: z.strictObject({ assistantId: z.string().min(1).max(128), groupId: z.string().min(1).max(128).optional() }).optional(),
        agent: z.strictObject({ customAgentId: z.string().min(1).max(128) }).optional(),
        agentPrivate: z.literal(true).optional(),
        generalChat: z.literal(true).optional(),
        pluginIds: z.array(z.string().min(1).max(64)).max(64).optional(),
      }),
      messages: z.array(messageSchema),
      history: z.array(historySchema),
      skillContext: z.string().optional(),
      requestContext: requestContext.optional(),
      contextSteps: z.array(contextStep).max(CONTEXT_STEP_LIMIT).optional(),
      pendingContextStep: contextStep.optional(),
      contextResetPending: z.literal(true).optional(),
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
      permissionMode: z.string().max(16).optional(),
      outsideRead: z.literal(true).optional(),
      proposals: z.number().int().min(0).max(1000).optional(),
      workProposals: z.literal(true).optional(),
      pluginCreation: z.literal(true).optional(),
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
