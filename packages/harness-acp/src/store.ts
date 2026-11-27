import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CONTEXT_EVENT_LIMIT,
  COST_CURRENCIES,
  GATEWAY_LOSSES,
  MAX_MODEL_FALLBACKS,
  MODEL_WIRES,
  isFileChange,
  type FileChange,
  isFileMention,
  type FileMention,
  isAttachmentRef,
  readSessionSkills,
  type AttachmentRef,
  type SessionSkill,
} from '@latch/protocol'
import type { ModelRoute } from '@latch/sdk'
import type {
  AgentBrief,
  AgentNote,
  ContextCompactionEvent,
  Message,
  SessionCommand,
  PlanEntry,
  SessionConfigOption,
  DriverTaskSummary,
  HarnessCatalogue,
  HarnessQuota,
  TokenUsage,
  UsageReport,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'
import { ERROR_CODE, runEndSchema } from '@latch/core/run-end'
import type { ConfigSource } from './mapping.ts'
import { MAX_STEPS } from './subagents.ts'
import { harnessQuota } from './quota.ts'
import { contextBreakdown, contextCompaction, contextEpoch, contextSource } from './context-telemetry.ts'

export interface AcpRecord {
  /** Absent until session/new succeeds. */
  acpSessionId?: string
  cwd: string
  /** Draft project identity for command suggestions, including profiles that do not take additional folders. */
  commandContext?: { workspaceId?: string }
  agentVersion?: string
  /** Number of prompts sent in this task; scopes tool message IDs. */
  turnSeq: number
  /** Advances on an explicit successful compaction or when Latch starts a fresh context. */
  contextEpoch?: number
  /** The agent's first-turn block until a turn has actually carried it to the engine. */
  brief?: AgentBrief
  /** The latest digest note the Host gave (`AgentExecutionContext.note`), until a turn carries it. */
  note?: AgentNote
  /** The key of the last note a turn of this context carried; a fresh context forgets it. */
  noteSent?: string
  /** Whether `config` came from `configOptions` or the legacy `models`/`modes` fields. */
  configSource?: ConfigSource
  /** The agent offered session/delete when this session was last bound, so removal may start it to ask. */
  deletable?: boolean
  /**
   * What the harness's own settings decide beside Latch's mode, as read when this session was last bound: OpenCode's
   * saved 「总是允许」 of the project, whether pi trusts the project's `.pi`. Display only, short lines.
   */
  permissionFacts?: string[]
  /** Launch fingerprint the owner confirmed. Absent on sessions created before it existed; those cannot continue. */
  launchHash?: string
  /**
   * The definition's part of `launchHash`, without the project configuration, to tell which of the two changed.
   * Absent on sessions confirmed before project configuration counted, whose `launchHash` is only that part.
   */
  definitionHash?: string
  /** Mode the owner chose through Latch; overrides the profile's expected mode. */
  expectedMode?: string
  /** For each opaque Codex member, the Host's hash of its last observed work turn. */
  codexMemberTurns?: Record<string, string>
  /** Process-level permission selection included in this session's launch fingerprint. */
  launchMode?: string
  /** A Host-owned per-model generation setting written into a private process configuration. */
  launchThinking?: { model: string; value: string }
  /** The agent changed its own mode beyond the expected one; the session no longer accepts input. */
  drift?: { at: string; observed: string }
  /** Preset whose permission profile applied when the session was created. */
  profilePresetId?: string
  /**
   * The real paths of the folders the agent receives besides `cwd`, in order, and how (`folderVia`). Both are part of
   * the launch on record; absent when the session passes no other folder.
   */
  folders?: string[]
  folderVia?: 'acp' | 'args'
  /** The session has an agent's skills in its own folder, served to the engine read-only. */
  skills?: true
  /** Its agent may propose memories through the skills server (`proposals.jsonl` in that directory). */
  proposals?: true
  /** Its agent may propose for the board through the same server and file (`CreateTaskInput.workProposals`). */
  workProposals?: true
  pluginCreation?: true
  /** How many lines of that file the Host has been handed. */
  proposalsRead?: number
  /** Byte offset in that file just past the last line handed over. */
  proposalsOffset?: number
  /** Lines taken and then cleared from the file; they still count toward the session's limit. */
  proposalsCleared?: number
  /** The rounds file of the team tools (`send_to_members`): lines handed to the Host, the byte past them, lines cleared. */
  roundsRead?: number
  roundsOffset?: number
  roundsCleared?: number
  /** A scheduled run: whatever it proposes is external, and its idle process is reclaimed as a Code session's. */
  unattended?: true
  /**
   * What the draft chose, set before the first prompt and dropped once set. `category` and `label` are what the catalogue
   * said when the session was created, to name a choice the agent no longer offers.
   */
  startConfig?: StartChoice[]
  /** The gateway route the session started on, which the launch fingerprint covers. */
  route?: ModelRoute
  /** The route's model was chosen on the agent's session; until then the next bind chooses it. */
  routeModelSet?: true
  /** A route's thinking value requiring continuity; an unsupported report cannot silently replace it with a default. */
  routeThinking?: string
  /**
   * A move to another route under way: the route it left, written in the same step as the new one and dropped once the
   * move is done (or, for a session carried onto another provider, once the agent's new session is on record). Found on
   * start, the move did not finish, and the session goes back to this route.
   */
  routeMove?: { route?: ModelRoute; launchHash: string; routeModelSet?: true; model?: string; serviceModel?: string }
  /** A prompt asked for a new context and no user message has been recorded on the agent's new session yet. */
  contextCleared?: true
  /** Outside content reached this context by a way no tool row shows (`Bridge.markOutsideContent`); gone when it starts over. */
  outsideRead?: true
  /** The agent's sessions from before each new context, which removing the task deletes too. */
  earlierSessionIds?: string[]
  /**
   * A fork of another session of this driver (`CreateTaskInput.fork`): tried as the agent's own fork when the session
   * first opens, and dropped when it cannot be, so the first prompt sends the Host's text record. `native` once the
   * agent forked, from then on the first prompt leaves the text record out.
   */
  fork?: { taskId: string; upToMessageId: string; prefixLength: number; instead?: string; native?: true }
  /**
   * Brought in from the agent's own session `agentSessionId`, which Latch did not start: removing the task, or clearing
   * its context, never deletes that session in the agent. `cwd`: the real path of `AcpRecord.cwd` when it was brought in;
   * every start, resume and prompt requires it unchanged and inside the primary folder (409 `workspace-changed`).
   */
  imported?: { agentSessionId: string; cwd: string }
  /** Text that goes before the first message (`CreateTaskInput.seed`), until a turn has recorded it. */
  seed?: string
  /** Latest session-scoped token total reported for `acpSessionId`, so later turns and native forks subtract what came before. */
  sessionUsage?: TokenUsage
  /** Tokens of `acpSessionId` from before this task (an imported session or a native fork), excluded from `summary.usage`. */
  sessionOriginUsage?: TokenUsage
  /** `acpSessionId` began with turns Latch never measured; the first session-scoped report becomes `sessionOriginUsage`. */
  sessionUnmeasuredOrigin?: true
  /** Session-scoped cost before this task began on `acpSessionId`. */
  sessionCost?: { amount: number; currency: string }
  /** Tokens accumulated by earlier contexts of this task before `clearContext` opened a new session. */
  priorContextsUsage?: TokenUsage
  /** Session-scoped totals after recent user messages of `acpSessionId`, for native forks at an earlier turn. */
  turnSessionTotals?: Record<string, { usage?: TokenUsage; cost?: { amount: number; currency: string } }>
}

export interface StartChoice {
  configId: string
  value: string
  category?: string
  label?: string
}

/** The catalogue of one definition, with what it was learned from. */
export interface AcpCatalogue extends HarnessCatalogue {
  definitionHash: string
  launchHash: string
  agentVersion?: string
}

export interface AcpTask {
  summary: DriverTaskSummary
  messages: Message[]
  commands?: SessionCommand[]
  skills?: SessionSkill[]
  skillsTruncated?: true
  plan?: PlanEntry[]
  config?: SessionConfigOption[]
  /** The agent's latest report of its context window and cost. */
  usageReport?: UsageReport
  contextEvents?: ContextCompactionEvent[]
  revision: number
  acp: AcpRecord
}

/** A deleted task keeps its creation receipt so a retried create is answered instead of repeated. */
export interface AcpReceipt {
  taskId: string
  payloadHash: string
  kind: 'create' | 'prompt' | 'steer'
  deleted?: boolean
  /** A steer: `sending` until the agent answers, and for good when no answer came. */
  steer?: 'sending' | 'injected' | 'prompt-required'
}

/** What `initialize` said the agent takes in a prompt, for the definition it started with. */
export interface AcpPromptCapabilities {
  definitionHash: string
  images: boolean
  embeddedContext: boolean
  at: string
}

/** The last read of a definition's catalogue without a turn; a harness read once by selection is not read so again. */
export interface AcpCatalogueRead {
  definitionHash: string
  at: string
  ok: boolean
  message?: string
  /** The failure's `AppError` code. */
  code?: string
}

/**
 * What a session on a model of a service through the gateway reported of the options that follow the model, kept for
 * drafts on the same pair: only under the definition it ran and the service's declaration it ran with
 * (`declarationHash`, see `serviceDeclarationHash`), so a change to either leaves it unused.
 */
export interface AcpServiceOptions {
  definitionHash: string
  providerId: string
  model: string
  declarationHash: string
  options: SessionConfigOption[]
  reportedAt: string
}

export interface AcpState {
  version: 1
  tasks: Record<string, AcpTask>
  receipts: Record<string, AcpReceipt>
  catalogue?: AcpCatalogue
  /** Newest first, bounded (`MAX_SERVICE_OPTIONS`). */
  serviceOptions?: AcpServiceOptions[]
  catalogueRead?: AcpCatalogueRead
  promptCapabilities?: AcpPromptCapabilities
  /** Model IDs a person typed, for every definition of this harness. */
  customModels?: string[]
  /** The subscription's limits as the program last said them, for the definition that said them: shown after a restart. */
  quota?: AcpQuota
}

interface AcpQuota {
  definitionHash: string
  value: HarnessQuota
}

const usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
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
const routedTurn = z.object({
  requests: count,
  dropped: z.array(z.enum(GATEWAY_LOSSES)).max(GATEWAY_LOSSES.length).optional(),
  chosen: z.string().max(200).optional(),
  models: z
    .array(
      z.object({
        model: z.string().max(200),
        used: z.string().max(200).optional(),
        requests: count,
        failed: count.optional(),
        measured: count.optional(),
        open: count.optional(),
        usage: usage.optional(),
        provider: z.string().max(128).optional(),
        fallback: count.optional(),
      }),
    )
    .max(16),
  spend: spendSchema.optional(),
})
const toolDetail = z.object({
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']).optional(),
  title: z.string().optional(),
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
      subagentStopped: z.literal(true).optional(),
    })
    .optional(),
  judged: z.object({ by: z.string(), outcome: z.enum(['approved', 'denied', 'none', 'unasked']) }).optional(),
  blocked: z.object({ by: z.string(), source: z.enum(['model', 'rule']), reason: z.string().optional() }).optional(),
  plan: z
    .string()
    .max(64 * 1024)
    .optional(),
  imageGeneration: z.literal(true).optional(),
})
const agentBrief = z.object({ segments: z.array(z.object({ source: z.enum(['latch', 'user', 'material']), text: z.string() })) })
// Its steps are messages, and may hold its own subagents.
const subagent: z.ZodType = z.lazy(() =>
  z.object({
    title: z.string(),
    description: z.string().optional(),
    team: z
      .object({
        id: z.string().max(128),
        memberId: z.string().max(128),
        userMessageId: z.string().max(128).optional(),
        result: z.string().max(16_000).optional(),
        failure: z.string().max(2_000).optional(),
      })
      .optional(),
    status: z.enum(['running', 'waiting', 'done', 'failed', 'cancelled', 'unknown']).optional(),
    steps: z.array(message).max(MAX_STEPS),
    truncated: z.literal(true).optional(),
  }),
)
const message = z.object({
  agentBrief: agentBrief.optional(),
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
  teamRequest: z.literal(true).optional(),
  steered: z.literal(true).optional(),
  freshContext: z.literal(true).optional(),
  nativeFork: z.literal(true).optional(),
  imported: z.literal(true).optional(),
  toolName: z.string().optional(),
  state: z.enum(['queued', 'awaiting-approval', 'running', 'completed', 'failed', 'cancelled']).optional(),
  interrupted: z.literal(true).optional(),
  errorCode: z.string().regex(ERROR_CODE).optional(),
  reasoning: z.string().optional(),
  tool: toolDetail.optional(),
  usage: usage.optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  reasoningMs: z.number().nonnegative().optional(),
  model: z.string().optional(),
  providerId: z.string().optional(),
  thinking: z.string().max(200).optional(),
  turn: z
    .object({
      endedAt: z.string().optional(),
      activeMs: z.number().nonnegative().optional(),
      waitMs: z.number().nonnegative().optional(),
      contextWindow: z
        .object({
          at: z.string(),
          used: z.number().nonnegative(),
          size: z.number().positive().optional(),
          source: contextSource.optional(),
          epoch: contextEpoch.optional(),
          breakdown: contextBreakdown.optional(),
        })
        .optional(),
      routed: routedTurn.optional(),
      usage: usage.optional(),
      stream: z.object({ outputTokens: z.number().positive(), ms: z.number().positive() }).optional(),
    })
    .optional(),
  turnId: z.string().max(128).optional(),
  subagent: subagent.optional(),
})
const configOption = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  description: z.string().optional(),
  source: z.literal('launch').optional(),
  currentValue: z.string(),
  options: z.array(
    z.object({ value: z.string(), name: z.string(), description: z.string().optional(), unavailable: z.string().optional() }),
  ),
})
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const catalogue = z.object({
  definitionHash: hash,
  launchHash: hash,
  agentVersion: z.string().optional(),
  options: z.array(configOption),
  perModel: z.array(z.object({ model: z.string(), options: z.array(configOption) })),
  reportedAt: z.string(),
  source: z.enum(['session', 'check']),
})
const serviceOptions = z.object({
  definitionHash: hash,
  providerId: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  declarationHash: hash,
  options: z.array(configOption),
  reportedAt: z.string(),
})
const catalogueRead = z.object({
  definitionHash: hash,
  at: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
  code: z.string().max(100).optional(),
})
const promptCapabilities = z.object({ definitionHash: hash, images: z.boolean(), embeddedContext: z.boolean(), at: z.string() })
const startChoice = z.object({
  configId: z.string(),
  value: z.string(),
  category: z.string().optional(),
  label: z.string().optional(),
})
/**
 * A route's protocol as it may be on disk: `gemini` is one Latch no longer forwards. A session saved with it still
 * reads back, so the file opens and nothing in it is lost; continuing it is refused where a route is opened.
 */
const storedWire = z.enum([...MODEL_WIRES, 'gemini'])

const storedRoute = z.object({
  providerId: z.string().min(1).max(128),
  model: z.string().min(1).max(200),
  wire: storedWire,
  upstream: storedWire.optional(),
  origin: z.string().min(1).max(300),
  fallbacks: z
    .record(
      z.string().min(1).max(200),
      z
        .array(
          z.object({
            providerId: z.string().min(1).max(128),
            model: z.string().min(1).max(200),
            upstream: storedWire,
            origin: z.string().min(1).max(300),
          }),
        )
        .min(1)
        .max(MAX_MODEL_FALLBACKS),
    )
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
        commandsVersion: z.string().uuid().optional(),
        workspaceId: z.string().optional(),
        folders: z.array(z.object({ id: z.string(), path: z.string() })).optional(),
        folderAccess: z.enum(['all', 'primary']).optional(),
        runId: z.string().min(1).max(128).optional(),
        runOutcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional(),
        runEnd: runEndSchema.optional(),
        agent: z.strictObject({ customAgentId: z.string().min(1).max(128) }).optional(),
        agentPrivate: z.literal(true).optional(),
        modelRoute: z
          .object({
            providerId: z.string().min(1).max(128),
            model: z.string().min(1).max(200),
            bypassed: z.literal(true).optional(),
            fallbacks: z
              .array(z.object({ providerId: z.string().min(1).max(128), model: z.string().min(1).max(200) }))
              .max(MAX_MODEL_FALLBACKS)
              .optional(),
          })
          .optional(),
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
      config: z.array(configOption).optional(),
      skills: z.custom<SessionSkill[]>(value => readSessionSkills(value) !== undefined).optional(),
      skillsTruncated: z.literal(true).optional(),
      commands: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            description: z.string().max(1000).optional(),
            inputHint: z.string().max(500).optional(),
            idleOnly: z.literal(true).optional(),
          }),
        )
        .max(200)
        .optional(),
      usageReport: z
        .object({
          contextUsed: z.number().nonnegative().optional(),
          contextSize: z.number().nonnegative().optional(),
          contextSource: contextSource.optional(),
          contextEpoch: contextEpoch.optional(),
          breakdown: contextBreakdown.optional(),
          configuredContextSize: z.literal(true).optional(),
          cost: z.object({ amount: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/u) }).optional(),
          at: z.string(),
        })
        .optional(),
      contextEvents: z.array(contextCompaction).max(CONTEXT_EVENT_LIMIT).optional(),
      revision: z.number().int().nonnegative(),
      acp: z.object({
        acpSessionId: z.string().optional(),
        cwd: z.string(),
        commandContext: z.strictObject({ workspaceId: z.string().min(1).max(256).optional() }).optional(),
        agentVersion: z.string().optional(),
        turnSeq: z.number().int().nonnegative(),
        contextEpoch: contextEpoch.optional(),
        brief: agentBrief.optional(),
        note: z.object({ key: z.string().regex(/^[0-9a-f]{64}$/u), segments: agentBrief.shape.segments }).optional(),
        noteSent: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .optional(),
        configSource: z.enum(['options', 'legacy']).optional(),
        deletable: z.boolean().optional(),
        permissionFacts: z.array(z.string().max(300)).max(24).optional(),
        launchHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        definitionHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        expectedMode: z.string().optional(),
        codexMemberTurns: z.record(z.string().regex(/^[0-9a-f]{64}$/u), z.string().regex(/^[0-9a-f]{64}$/u)).optional(),
        launchMode: z.string().optional(),
        launchThinking: z.object({ model: z.string(), value: z.string() }).optional(),
        drift: z.object({ at: z.string(), observed: z.string() }).optional(),
        profilePresetId: z.string().optional(),
        folders: z.array(z.string()).optional(),
        folderVia: z.enum(['acp', 'args']).optional(),
        skills: z.literal(true).optional(),
        /** Its agent may propose memories through the skills server; the Host has read this many of its lines. */
        proposals: z.literal(true).optional(),
        workProposals: z.literal(true).optional(),
        pluginCreation: z.literal(true).optional(),
        proposalsRead: z.number().int().min(0).max(1000).optional(),
        proposalsOffset: z.number().int().min(0).max(1_048_576).optional(),
        proposalsCleared: z.number().int().min(0).max(1000).optional(),
        roundsRead: z.number().int().min(0).max(1000).optional(),
        roundsOffset: z.number().int().min(0).max(1_048_576).optional(),
        roundsCleared: z.number().int().min(0).max(1000).optional(),
        unattended: z.literal(true).optional(),
        startConfig: z.array(startChoice).optional(),
        route: storedRoute.optional(),
        routeModelSet: z.literal(true).optional(),
        routeThinking: z.string().max(200).optional(),
        routeMove: z
          .object({
            route: storedRoute.optional(),
            launchHash: z.string().regex(/^[0-9a-f]{64}$/),
            routeModelSet: z.literal(true).optional(),
            model: z.string().max(1024).optional(),
            serviceModel: z.string().max(200).optional(),
          })
          .optional(),
        contextCleared: z.literal(true).optional(),
        outsideRead: z.literal(true).optional(),
        earlierSessionIds: z.array(z.string()).optional(),
        fork: z
          .object({
            taskId: z.string(),
            upToMessageId: z.string(),
            prefixLength: z.number().int().nonnegative(),
            instead: z.string().optional(),
            native: z.literal(true).optional(),
          })
          .optional(),
        imported: z.object({ agentSessionId: z.string().min(1).max(512), cwd: z.string().min(1).max(4096) }).optional(),
        seed: z.string().max(1_000_000).optional(),
        sessionUsage: usage.optional(),
        sessionOriginUsage: usage.optional(),
        sessionUnmeasuredOrigin: z.literal(true).optional(),
        sessionCost: z.object({ amount: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/u) }).optional(),
        priorContextsUsage: usage.optional(),
        turnSessionTotals: z
          .record(
            z.string().max(128),
            z.object({
              usage: usage.optional(),
              cost: z.object({ amount: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/u) }).optional(),
            }),
          )
          .optional(),
      }),
    }),
  ),
  receipts: z.record(
    z.string(),
    z.object({
      taskId: z.string(),
      payloadHash: z.string(),
      kind: z.enum(['create', 'prompt', 'steer']),
      deleted: z.boolean().optional(),
      steer: z.enum(['sending', 'injected', 'prompt-required']).optional(),
    }),
  ),
  // Only a cache: one that does not read back is dropped rather than keeping the sessions from opening.
  catalogue: catalogue.optional().catch(undefined),
  serviceOptions: z.array(serviceOptions).optional().catch(undefined),
  catalogueRead: catalogueRead.optional().catch(undefined),
  promptCapabilities: promptCapabilities.optional().catch(undefined),
  customModels: z.array(z.string()).optional(),
  quota: z.object({ definitionHash: hash, value: harnessQuota }).optional().catch(undefined),
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
