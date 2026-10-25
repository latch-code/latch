/** The subset of ACP v1 that Latch reads. Everything from the agent is untrusted and parsed tolerantly. */
import { z } from 'zod'

export const PROTOCOL_VERSION = 1
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

export const initializeResult = z.object({
  protocolVersion: z.number().int(),
  agentCapabilities: z
    .object({
      loadSession: z.boolean().nullish(),
      // Each capability counts when present; additionalDirectories only as an object, as ACP defines it.
      sessionCapabilities: z
        .object({ resume: z.unknown().optional(), delete: z.unknown().optional(), additionalDirectories: z.unknown().optional() })
        .nullish()
        .catch(undefined),
    })
    .nullish()
    .catch(undefined),
  authMethods: z
    .array(z.object({ id: z.string(), name: z.string(), description: optionalText }))
    .nullish()
    .catch(undefined),
  agentInfo: z.object({ name: optionalText, version: optionalText }).nullish().catch(undefined),
})

export const selectOption = z.object({ value: z.string(), name: z.string(), description: optionalText })
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
})
export type ToolFields = z.infer<typeof toolFields>

export const updateEnvelope = z.object({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
})
export const chunkUpdate = z.object({ content: contentBlock, messageId: optionalText })
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
  cost: z
    .object({ amount: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/u) })
    .nullish()
    .catch(undefined),
})

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

export const promptResult = z.object({
  stopReason: z.string(),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }).nullish().catch(undefined),
})
export const cancelRequest = z.object({ requestId: z.union([z.string(), z.number()]) })
