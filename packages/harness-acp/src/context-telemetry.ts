import { CONTEXT_WINDOW_CATEGORY_IDS, type ContextWindowBreakdown, type ContextWindowCategory } from '@latch/protocol'
import { z } from 'zod'

const tokenCount = z.number().int().nonnegative()
const optionalCount = tokenCount.optional().catch(undefined)
const categoryId = z.enum(CONTEXT_WINDOW_CATEGORY_IDS)
const categoryKind = z.enum(['used', 'free', 'buffer', 'deferred'])
const categoryKinds = {
  system_prompt: 'used',
  system_tools: 'used',
  mcp_tools: 'used',
  mcp_instructions: 'used',
  mcp_tools_deferred: 'deferred',
  system_tools_deferred: 'deferred',
  custom_agents: 'used',
  memory_files: 'used',
  skills: 'used',
  messages: 'used',
  autocompact_buffer: 'buffer',
  compact_buffer: 'buffer',
  free_space: 'free',
} satisfies Record<z.infer<typeof categoryId>, ContextWindowCategory['kind']>

export const contextSource = z.enum(['claude-sdk', 'acp'])
export const contextEpoch = tokenCount
export const contextBreakdown = z.object({
  measurement: z.literal('full'),
  categories: z
    .array(z.object({ id: categoryId.optional(), kind: categoryKind, tokens: tokenCount }))
    .max(CONTEXT_WINDOW_CATEGORY_IDS.length + categoryKind.options.length),
  messageBreakdown: z
    .object({
      toolCalls: tokenCount.optional(),
      toolResults: tokenCount.optional(),
      attachments: tokenCount.optional(),
      assistantMessages: tokenCount.optional(),
      userMessages: tokenCount.optional(),
      redirectedContext: tokenCount.optional(),
      unattributed: tokenCount.optional(),
    })
    .optional(),
  providerUsage: z
    .object({
      inputTokens: tokenCount,
      outputTokens: tokenCount,
      cacheReadTokens: tokenCount,
      cacheWriteTokens: tokenCount,
    })
    .optional(),
})

export const compactionStatus = z.enum(['in_progress', 'completed', 'failed', 'cancelled', 'unknown'])
const compactionMetrics = {
  trigger: z.enum(['auto', 'manual']).optional().catch(undefined),
  beforeTokens: optionalCount,
  afterTokens: optionalCount,
  durationMs: optionalCount,
}
export const contextCompactionMetrics = z.object(compactionMetrics)
export const contextCompaction = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  at: z.string(),
  turnId: z.string().max(128).optional(),
  source: contextSource,
  status: compactionStatus,
  ...compactionMetrics,
})

const claudeCategory = z.object({
  id: z.string().max(80).optional().catch(undefined),
  kind: categoryKind,
  tokens: tokenCount,
})
const claudeContext = z.object({
  categories: z.array(z.unknown()).max(128).optional().catch(undefined),
  messageBreakdown: z
    .object({
      toolCallTokens: optionalCount,
      toolResultTokens: optionalCount,
      attachmentTokens: optionalCount,
      assistantMessageTokens: optionalCount,
      userMessageTokens: optionalCount,
      redirectedContextTokens: optionalCount,
      unattributedTokens: optionalCount,
    })
    .optional()
    .catch(undefined),
  apiUsage: z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_read_input_tokens: tokenCount,
      cache_creation_input_tokens: tokenCount,
    })
    .nullish()
    .catch(undefined),
})

/** The full SDK response's window rows, with released IDs and counts. Named lists and message details stay on the wire. */
export function claudeContextBreakdown(raw: unknown): ContextWindowBreakdown | undefined {
  const source = claudeContext.safeParse(raw).data
  if (!source) return undefined
  const rows: ContextWindowCategory[] = []
  const seen = new Set<string>()
  const other = new Map<ContextWindowCategory['kind'], number>()
  for (const item of source.categories ?? []) {
    const row = claudeCategory.safeParse(item).data
    if (!row) continue
    if (row.id) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
    }
    const id = categoryId.safeParse(row.id).data
    if (id && categoryKinds[id] === row.kind) rows.push({ id, kind: row.kind, tokens: row.tokens })
    else other.set(row.kind, (other.get(row.kind) ?? 0) + row.tokens)
  }
  for (const [kind, tokens] of other) if (Number.isSafeInteger(tokens)) rows.push({ kind, tokens })

  const message = source.messageBreakdown
  const messageBreakdown = message && {
    toolCalls: message.toolCallTokens,
    toolResults: message.toolResultTokens,
    attachments: message.attachmentTokens,
    assistantMessages: message.assistantMessageTokens,
    userMessages: message.userMessageTokens,
    redirectedContext: message.redirectedContextTokens,
    unattributed: message.unattributedTokens,
  }
  const api = source.apiUsage
  const providerUsage = api && {
    inputTokens: api.input_tokens + api.cache_read_input_tokens + api.cache_creation_input_tokens,
    outputTokens: api.output_tokens,
    cacheReadTokens: api.cache_read_input_tokens,
    cacheWriteTokens: api.cache_creation_input_tokens,
  }
  const breakdown = {
    ...(messageBreakdown && Object.values(messageBreakdown).some(value => value !== undefined) ? { messageBreakdown } : {}),
    ...(providerUsage && Number.isSafeInteger(providerUsage.inputTokens) ? { providerUsage } : {}),
  }
  if (!rows.length && !breakdown.messageBreakdown && !breakdown.providerUsage) return undefined
  return { measurement: 'full', categories: rows, ...breakdown }
}

const claudeCompaction = z.object({
  trigger: compactionMetrics.trigger,
  pre_tokens: optionalCount,
  post_tokens: optionalCount,
  duration_ms: optionalCount,
})

export function claudeCompactionMetrics(raw: unknown): z.infer<typeof contextCompactionMetrics> | undefined {
  const compact = claudeCompaction.safeParse(raw).data
  if (!compact) return undefined
  return {
    ...(compact.trigger === undefined ? {} : { trigger: compact.trigger }),
    ...(compact.pre_tokens === undefined ? {} : { beforeTokens: compact.pre_tokens }),
    ...(compact.post_tokens === undefined ? {} : { afterTokens: compact.post_tokens }),
    ...(compact.duration_ms === undefined ? {} : { durationMs: compact.duration_ms }),
  }
}
