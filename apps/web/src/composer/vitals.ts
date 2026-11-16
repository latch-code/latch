import type { Message, TaskDetail, TaskSummary, TokenUsage } from '@latch/protocol'
import { turnsOf } from '../conversation.ts'
import { contextTotals, type ContextTotals } from './sessionTotals.ts'

/** From this share of the window on, the context ring turns amber. */
const CONTEXT_NEAR = 80

/**
 * What a session has done and used, for the line under its input: each item only when a real source reported it, never
 * estimated. Turns and steps are Latch's own record of the session; tokens, their cached share and the context are the
 * Harness's reports or, for a session through a model service, what Latch's gateway counted.
 */
export interface SessionVitals {
  /** Turns the person started, and the tool calls the agent made in them. */
  turns?: { turns: number; steps: number }
  /** Output tokens a second of the running turn: the Harness's own token count over its own streaming times. */
  speed?: number
  tokens?: {
    usage: TokenUsage
    total: number
    /** Cached input ÷ input, in whole percent; only when the source reported cached input. */
    cached?: number
    /** Who counted them: the Harness, or Latch's gateway. */
    by: 'harness' | 'gateway'
  }
  context?: ContextTotals & { near: boolean }
}

/** Speeds from a moment of streaming are noise. */
const MIN_STREAM_MS = 300

function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return { ...b }
  const sum: TokenUsage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
  for (const part of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const)
    if (a[part] !== undefined && b[part] !== undefined) sum[part] = a[part] + b[part]
  return sum
}

/** What the gateway counted over the session's turns; undefined when no turn went through it. */
function routedUsage(messages: readonly Message[]): TokenUsage | undefined {
  let usage: TokenUsage | undefined
  for (const message of messages)
    for (const model of message.role === 'user' ? (message.turn?.routed?.models ?? []) : [])
      if (model.usage) usage = addUsage(usage, model.usage)
  return usage
}

export function sessionVitals(
  summary: Pick<TaskSummary, 'id' | 'usage' | 'status'>,
  detail: Pick<TaskDetail, 'summary' | 'messages' | 'usageReport'> | null | undefined,
): SessionVitals {
  const own = detail?.summary.id === summary.id ? detail : undefined
  const vitals: SessionVitals = {}
  const messages = own?.messages ?? []
  const turns = turnsOf(messages).filter(turn => turn.user)
  if (turns.length > 0)
    vitals.turns = { turns: turns.length, steps: messages.filter(message => message.role === 'tool' && !message.subagent).length }
  const routed = summary.usage ? undefined : routedUsage(messages)
  const usage = summary.usage ?? routed
  if (usage && usage.inputTokens + usage.outputTokens > 0) {
    const cached =
      usage.cacheReadTokens !== undefined && usage.inputTokens > 0
        ? Math.min(100, Math.round((usage.cacheReadTokens / usage.inputTokens) * 100))
        : undefined
    vitals.tokens = {
      usage,
      total: usage.inputTokens + usage.outputTokens,
      ...(cached !== undefined ? { cached } : {}),
      by: routed ? 'gateway' : 'harness',
    }
  }
  const last = turns.at(-1)
  const running = summary.status === 'running' || summary.status === 'waiting-approval'
  const stats = last?.user?.turn
  // Both from the Harness: the turn's output tokens and how long its output streamed by its own times.
  if (running && stats?.stream && stats.stream.ms >= MIN_STREAM_MS)
    vitals.speed = Math.round(stats.stream.outputTokens / (stats.stream.ms / 1000))
  const context = contextTotals(own?.usageReport)
  if (context) vitals.context = { ...context, near: context.percent !== undefined && context.percent >= CONTEXT_NEAR }
  return vitals
}

/** Whether there is anything to show. */
export const hasVitals = (vitals: SessionVitals) => Object.values(vitals).some(value => value !== undefined)
