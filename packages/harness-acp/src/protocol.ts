/** The subset of ACP v1 that Latch reads. Everything from the agent is untrusted and parsed tolerantly. */
import { z } from 'zod'
import { contextBreakdown, contextCompactionMetrics } from './context-telemetry.ts'

export const PROTOCOL_VERSION = 1
/** Wire-to-runtime metadata; native paths never belong to this update. */
export const SESSION_SKILLS_UPDATE = '_latch/skills_update'
/** In `_meta` of a session's setup answer from one of Latch's own wires: short lines on what the harness's settings decide. */
export const PERMISSION_FACTS = 'latch/permissionFacts'
/** In `session/resume` to Latch's own OpenCode wire: the session is one Latch started, whose leftover claim may go. */
export const RELEASE_CLAIM = 'latchReleaseClaim'

/**
 * What Latch tells every agent it can take. No file system or terminal, so agents keep those to themselves; questions
 * (`elicitation`, form mode only) where the Host can put them to the person, never URL mode, which would send them to a
 * page Latch cannot vouch for;
 * notices and compaction are shown in the transcript, so an agent reports them as such instead of as messages or tools;
 * subagents are shown where they began, and their requests for approval come to the session that started them.
 * `terminalLogin`: the agent may list logins that run its own program in a terminal on this computer, which Latch can
 * open; false for a harness whose vendor leaves signing in to its own flow.
 */
export function clientCapabilities(terminalLogin: boolean, questions = false) {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    ...(questions ? { elicitation: { form: {} } } : {}),
    session: { notices: {}, compaction: {} },
    subagents: {},
    ...(terminalLogin ? { auth: { terminal: true } } : {}),
  }
}
export type RpcId = string | number

export const RPC = {
  invalidParams: -32602,
  methodNotFound: -32601,
  internal: -32603,
  cancelled: -32800,
  authRequired: -32000,
  notFound: -32002,
} as const

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

const optionalText = z.string().nullish()

/** `providers/list`: what the agent lets a client route, without secrets. Bounded, since nothing else limits it. */
export const providersList = z.object({
  providers: z.array(z.object({ providerId: z.string().max(256), supported: z.array(z.string().max(64)).max(16) })).max(64),
})

export const initializeResult = z.object({
  protocolVersion: z.number().int(),
  agentCapabilities: z
    .object({
      loadSession: z.boolean().nullish(),
      promptCapabilities: z.object({ image: z.boolean().nullish(), embeddedContext: z.boolean().nullish() }).nullish().catch(undefined),
      // Each capability counts when present; additionalDirectories only as an object, as ACP defines it.
      sessionCapabilities: z
        .object({
          resume: z.unknown().optional(),
          list: z.unknown().optional(),
          delete: z.unknown().optional(),
          close: z.unknown().optional(),
          additionalDirectories: z.unknown().optional(),
        })
        .nullish()
        .catch(undefined),
      /** `logout` present: the agent logs out on request. */
      auth: z.object({ logout: z.unknown().optional() }).nullish().catch(undefined),
      /** Present: the agent takes `providers/list`, `providers/set` and `providers/disable`. */
      providers: z.unknown().optional(),
      /** `authStatus` present: the agent pushes `_auth/status_update` after initialize and on each change. */
      _meta: z.object({ authStatus: z.unknown().optional() }).nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
  /** `type` absent means the agent logs in itself through `authenticate`; Latch reads only `terminal`. */
  authMethods: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: optionalText,
        type: optionalText,
        args: z.array(z.string()).nullish().catch(undefined),
        env: z.record(z.string(), z.string()).nullish().catch(undefined),
      }),
    )
    .nullish()
    .catch(undefined),
  agentInfo: z.object({ name: optionalText, version: optionalText }).nullish().catch(undefined),
  /** `steering.supported`: the agent takes `_session/steering`, adding text to a running turn. */
  _meta: z
    .object({
      steering: z.object({ supported: z.boolean().nullish() }).nullish().catch(undefined),
      /** Grok Build's version, which it reports here and not in `agentInfo` (1.0.89). Read only for a profile that says so. */
      agentVersion: optionalText.catch(undefined),
      /** Grok Build's models and commands before any session; untrusted, read only by its profile. */
      modelState: z.unknown().optional(),
      availableCommands: z.unknown().optional(),
    })
    .nullish()
    .catch(undefined),
})

/** `session/list`: metadata only. Bounded per page; anything unreadable in a row drops that row, not the page. */
export const sessionList = z.object({
  sessions: z
    .array(z.unknown())
    .max(1000)
    .transform(rows =>
      rows.flatMap(row => {
        const parsed = z
          .object({
            sessionId: z.string().min(1).max(512),
            cwd: z.string().min(1).max(4096),
            title: z.string().nullish().catch(undefined),
            updatedAt: z.string().max(64).nullish().catch(undefined),
            /** Folders the session was granted over ACP besides its own; anything but an absent or empty list counts. */
            additionalDirectories: z.unknown().optional(),
          })
          .safeParse(row)
        return parsed.success ? [parsed.data] : []
      }),
    ),
  nextCursor: z.string().min(1).max(4096).nullish().catch(undefined),
})

/** On a select option's value: why it cannot be chosen now, which a client shows greyed with this line. */
export const UNAVAILABLE_META = 'latch/unavailable'
export const selectOption = z.object({
  value: z.string(),
  name: z.string(),
  description: optionalText,
  _meta: z.record(z.string(), z.unknown()).nullish().catch(undefined),
})
export const configOption = z.object({
  id: z.string().min(1).max(256),
  name: z.string(),
  description: optionalText,
  category: optionalText,
  type: z.string(),
  currentValue: z.unknown().optional(),
  options: z.array(z.union([selectOption, z.object({ group: z.string(), name: z.string(), options: z.array(selectOption) })])).optional(),
})
const modeState = z.object({
  currentModeId: z.string(),
  availableModes: z.array(z.object({ id: z.string(), name: z.string(), description: optionalText })),
})
const modelState = z.object({
  currentModelId: z.string(),
  availableModels: z.array(z.object({ modelId: z.string(), name: z.string(), description: optionalText })),
})
/** Result of session/new, session/load and session/resume. `models` is the legacy model selector. */
export const sessionState = z.object({
  sessionId: z.string().min(1).max(512).optional(),
  modes: modeState.nullish().catch(undefined),
  models: modelState.nullish().catch(undefined),
  configOptions: z.array(z.unknown()).nullish().catch(undefined),
})
export type SessionState = z.infer<typeof sessionState>

export const contentBlock = z.object({
  type: z.string(),
  data: z.string().max(7_000_000).optional(),
  mimeType: z.string().max(100).optional(),
  text: z.string().optional(),
  uri: z.string().optional(),
  name: z.string().optional(),
  resource: z.object({ uri: z.string().optional(), text: z.string().optional() }).optional(),
})
export type ContentBlock = z.infer<typeof contentBlock>

export const toolContent = z.object({
  type: z.string(),
  content: contentBlock.optional(),
  path: z.string().optional(),
  oldText: z.string().nullish(),
  newText: z.string().optional(),
})
export const toolLocation = z.object({ path: z.string(), line: z.number().int().nullish() })

/** Fields of `tool_call` and `tool_call_update`; an update carries only what changed. */
export const toolFields = z.object({
  toolCallId: z.string().min(1).max(256),
  title: optionalText,
  name: optionalText,
  kind: optionalText,
  status: optionalText,
  content: z.array(z.unknown()).nullish(),
  locations: z.array(z.unknown()).nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  /** Latch's native wires may separately identify the non-file part of a result. */
  outputWithoutFiles: z.string().optional(),
  /** What a native wire's Harness says a command does (Codex's parsed actions); see `toolActions`. */
  actions: z.array(z.unknown()).nullish(),
})
export type ToolFields = z.infer<typeof toolFields>

export const updateEnvelope = z.object({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
})
export const chunkUpdate = z.object({ content: contentBlock, messageId: optionalText })
export const commandsUpdate = z.object({
  availableCommands: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
        description: z.string().max(1000).optional(),
        input: z.object({ hint: z.string().max(500) }).nullish(),
      }),
    )
    .max(200),
})
export const planUpdate = z.object({
  entries: z.array(z.object({ content: z.string(), status: optionalText, priority: optionalText })),
})
export const modeUpdate = z.object({ currentModeId: z.string() })
export const configUpdate = z.object({ configOptions: z.array(z.unknown()) })
export const infoUpdate = z.object({ title: optionalText })
/** The agent's context window and, when it knows, its cost; fields it leaves out or sends malformed are dropped. */
export const usageUpdate = z.object({
  used: z.number().nonnegative().finite().optional().catch(undefined),
  size: z.number().positive().finite().optional().catch(undefined),
  _meta: z
    .object({
      latchClaudeContext: z
        .object({
          turnId: z.string().max(128).optional().catch(undefined),
          breakdown: contextBreakdown.optional().catch(undefined),
        })
        .optional(),
      latchCodexContext: z.object({ turnId: z.string().max(128).optional() }).optional(),
    })
    .optional()
    .catch(undefined),
  cost: z
    .object({ amount: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/u) })
    .nullish()
    .catch(undefined),
})

/** A live advisory from the agent, not part of its history. `severity` is an open set; unknown values read as info. */
export const noticeUpdate = z.object({
  severity: z.string().max(64).nullish(),
  title: z.string().min(1),
  description: z.string().nullish(),
})
/** One compaction, addressed by its ID; later reports patch it. `status` is an open set. */
export const compactionUpdate = z.object({
  compactionId: z.string().min(1).max(256),
  status: z.string().max(64),
  latchClaudeCompaction: contextCompactionMetrics
    .extend({ turnId: z.string().max(128).optional().catch(undefined) })
    .optional()
    .catch(undefined),
  summary: z.array(z.unknown()).nullish(),
  error: z.string().nullish(),
})
export const compactionChunk = z.object({ compactionId: z.string().min(1).max(256), content: contentBlock })

/** Any string: kinds Latch does not know are filtered out rather than failing the whole request. */
export const permissionKind = z.string().max(256)
export const permissionRequest = z.object({
  sessionId: z.string(),
  toolCall: toolFields,
  options: z
    .array(z.object({ optionId: z.string().min(1).max(256), name: z.string().max(2000), kind: permissionKind }))
    .min(1)
    .max(16)
    .refine(options => new Set(options.map(option => option.optionId)).size === options.length, 'Duplicate optionId'),
})
export type PermissionOption = z.infer<typeof permissionRequest>['options'][number]

const tokenCount = z.number().nonnegative().finite()
/** Tokens as ACP's prompt answer names them: input counts cached input, output counts thinking. */
const turnTokens = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cachedReadTokens: tokenCount.nullish().catch(undefined),
  cachedWriteTokens: tokenCount.nullish().catch(undefined),
  thoughtTokens: tokenCount.nullish().catch(undefined),
})
export type TurnTokens = z.infer<typeof turnTokens>
/**
 * The session update a wire that reads token counts itself sends while a turn runs (Codex's app-server): `TurnTokens`
 * beside `sessionUpdate`, with `scope` saying whether it counts the whole session or this turn.
 */
export const TOKENS_UPDATE = '_latch_tokens'
export const tokensUpdate = turnTokens.extend({
  scope: z.enum(['session', 'turn']),
  /** Latch's user message, when the wire matched the report's native turn. */
  turnId: z.string().max(128).optional(),
  /** This is the previous native turn's total, before the named Latch input. */
  beforeTurnId: z.string().max(128).optional(),
  /** This turn's output that streamed as text and reasoning, and for how long by the Harness's own times. */
  stream: z.object({ outputTokens: z.number().positive().finite(), ms: z.number().positive().finite() }).optional().catch(undefined),
})

/**
 * `_meta` key a wire that reads its Harness's image tool itself (Codex's app-server) puts on that tool's `tool_call` and
 * `tool_call_update`: the row is the picture's place, and an image block in its content is the picture, which the
 * runtime keeps as the row's attachment. Taken only from Latch's own wire.
 */
export const IMAGE_GENERATION_META = 'latch/imageGeneration'

export const promptResult = z.object({
  stopReason: z.string(),
  usage: turnTokens.nullish().catch(undefined),
})
/** The answer to `_session/steering`. `outcome` is an open set: anything but `injected` and `promptRequired` is a failure. */
export const steerResult = z.object({ outcome: z.enum(['injected', 'promptRequired', 'failed']) })
export const STEER_METHOD = '_session/steering'
/**
 * Latch's own request to a wire that forks the agent's record (`AgentWire.forks`): a new session holding the source
 * session's history as it stood before `before`, the time the source's next turn began. Params `{ sessionId, cwd,
 * before }`, answered like `session/new`; `ForkRefused` when the agent cannot, with the process left ready for one.
 */
export const FORK_METHOD = '_latch/session/fork'
/**
 * Latch's own request to a wire whose harness binds a session to the model provider it began on (Codex's app-server): the
 * session carried onto this process's provider as a new session with the same history. Params as `session/resume`'s,
 * answered like `session/new` with the new session's ID. Only while the session moves to another route.
 */
export const CARRY_METHOD = '_latch/session/carry'
/**
 * Latch's own request to a wire whose harness reports its own MCP servers (Codex's app-server): params `{ sessionId? }`,
 * answered `{ servers, truncated?, namesOnly? }` as `HarnessMcpServer`s. With the session's ID it reads that session's
 * servers as they are, starting nothing; without one, in a process with no session, what the harness has configured,
 * which Codex gives as names only (`namesOnly`, every state `unknown`).
 */
export const MCP_STATUS_METHOD = '_latch/mcp/status'
/**
 * Latch's own request to a wire that reads its harness's limits itself (Codex's app-server): params `{}`, answered with a
 * `QuotaReport`, or `null` when the process runs on a model service or the answer has no figure. It needs no session
 * and runs no turn; `RPC.authRequired` when the harness says it is not logged in.
 */
export const QUOTA_READ_METHOD = '_latch/quota/read'
/** The session update such a wire sends as the session's servers start: `{ sessionUpdate, servers }`, all of them. */
export const MCP_STATUS_UPDATE = '_latch_mcp_status'
/** What such a wire answers and sends, as the runtime keeps it: names, states, counts and origins only. */
export const ownMcpStatus = z.object({
  servers: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(1024),
        state: z.enum(['starting', 'ready', 'needs-login', 'failed', 'cancelled', 'disabled', 'not-started', 'unknown']),
        tools: z.number().int().min(0).max(100_000).optional(),
        origin: z.string().max(2048).optional(),
        login: z.string().max(128).optional(),
      }),
    )
    .max(200),
  truncated: z.literal(true).optional(),
  namesOnly: z.literal(true).optional(),
  hooks: z
    .array(
      z.strictObject({
        event: z.string().regex(/^[A-Za-z]{1,64}$/u),
        source: z.string().regex(/^[A-Za-z]{1,64}$/u),
        managed: z.boolean(),
        enabled: z.boolean(),
        trust: z
          .string()
          .regex(/^[A-Za-z]{1,64}$/u)
          .optional(),
      }),
    )
    .max(100)
    .optional(),
  hooksTruncated: z.literal(true).optional(),
})

export const cancelRequest = z.object({ requestId: z.union([z.string(), z.number()]) })

/**
 * Which kind of credential the agent uses, as it pushes it outside ACP. Only `kind` and `label` are read: the rest
 * (an account's email and organization among it) is dropped by the schema before anything keeps it.
 */
export const AUTH_STATUS_METHOD = '_auth/status_update'
export const authStatusUpdate = z.object({
  authStatus: z.object({ kind: z.string().max(64), label: z.string().max(2000).optional().catch(undefined) }),
})
