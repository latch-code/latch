import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CONTEXT_STEP_LIMIT,
  CONTEXT_EVENT_LIMIT,
  CONTEXT_TOOL_CONTRIBUTION_LIMIT,
  CONTEXT_WINDOW_CATEGORY_IDS,
  type ContextPanelEvent,
  type ContextPanelToolContribution,
  type ContextWindowBreakdown,
  type Message,
  type RequestContext,
  type RequestContextToolContribution,
  type SessionContext,
  type TaskDetail,
} from '@latch/protocol'
import { countContextTools } from './contextToolStats.ts'

// Provider, MCP, plugin and ACP names can contain private data even when they look like identifiers.
const standardTools = new Set([
  'ask_user',
  'list_folders',
  'list_files',
  'read_file',
  'write_file',
  'recall_memory',
  'propose_memory',
  'propose_schedule',
  'browser_tabs',
  'browser_open',
  'browser_navigate',
  'browser_read',
  'browser_find',
  'browser_screenshot',
  'browser_scroll',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_wait',
  'browser_click',
  'browser_key',
  'browser_select',
  'browser_type',
  'browser_close',
  'device_list',
  'device_screenshot',
  'device_open_url',
  'device_set_appearance',
  'device_rotate',
  'device_apps',
  'device_launch',
  'device_tap',
  'device_swipe',
  'device_type_text',
  'device_press_key',
  'device_press_button',
  'write_report',
  'long_task',
])
const toolKinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'])

function toolGroup(message: Message, standard: boolean): string {
  if (standard && message.toolName && standardTools.has(message.toolName)) return message.toolName
  const kind = message.tool?.kind
  return kind && toolKinds.has(kind) ? kind : 'other'
}

function requestCounts(request: RequestContext): NonNullable<SessionContext['request']> {
  return {
    at: reportTime(request.at) ?? '',
    userMessages: request.userMessages,
    assistantMessages: request.assistantMessages,
    toolResults: request.toolResults,
    tools: request.tools,
    skills: request.skills,
    images: request.images,
    ...(request.inputTokens === undefined ? {} : { inputTokens: request.inputTokens }),
    ...(request.creator === true ? { creator: true } : {}),
  }
}

/** Drivers can supply reports with their own strings. Pass the time value only. */
function reportTime(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

const nonNegative = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0
const count = (value: number | undefined): value is number => nonNegative(value) && Number.isSafeInteger(value)
const contextSource = (value: unknown) => (value === 'acp' || value === 'claude-sdk' ? value : undefined)
const categoryIds = new Set<string>(CONTEXT_WINDOW_CATEGORY_IDS)
const messageFields = [
  'toolCalls',
  'toolResults',
  'attachments',
  'assistantMessages',
  'userMessages',
  'redirectedContext',
  'unattributed',
] as const

function windowBreakdown(value: ContextWindowBreakdown | undefined): ContextWindowBreakdown | undefined {
  if (!value || value.measurement !== 'full' || !Array.isArray(value.categories)) return undefined
  const categories: ContextWindowBreakdown['categories'] = []
  for (const category of value.categories) {
    if (!category) continue
    const { id, kind, tokens } = category
    if (!count(tokens) || (kind !== 'used' && kind !== 'free' && kind !== 'buffer' && kind !== 'deferred')) continue
    categories.push({ kind, tokens, ...(id && categoryIds.has(id) ? { id } : {}) })
  }
  const messageBreakdown = Object.fromEntries(
    messageFields.flatMap(field => {
      const tokens = value.messageBreakdown?.[field]
      return count(tokens) ? [[field, tokens]] : []
    }),
  )
  const usage = value.providerUsage
  return {
    measurement: value.measurement,
    categories,
    ...(Object.keys(messageBreakdown).length ? { messageBreakdown } : {}),
    ...(usage && count(usage.inputTokens) && count(usage.outputTokens)
      ? {
          providerUsage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(count(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(count(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          },
        }
      : {}),
  }
}

function latestWindow(report: TaskDetail['usageReport']): SessionContext['window'] {
  const at = reportTime(report?.at)
  if (!report || !at) return undefined
  const { contextUsed: used, contextSize: size } = report
  if (!nonNegative(used) && !nonNegative(size)) return undefined
  const source = contextSource(report.contextSource)
  const breakdown = source === 'claude-sdk' ? windowBreakdown(report.breakdown) : undefined
  return {
    at,
    ...(nonNegative(used) ? { used } : {}),
    ...(nonNegative(size) ? { size } : {}),
    ...(report.configuredContextSize === true ? { configuredSize: true } : {}),
    ...(source ? { source } : {}),
    ...(count(report.contextEpoch) ? { epoch: report.contextEpoch } : {}),
    ...(breakdown ? { breakdown } : {}),
  }
}

function turnWindow(message: Message): SessionContext['windows'][number]['window'] {
  const report = message.turn?.contextWindow
  const at = reportTime(report?.at)
  if (!report || !at || !nonNegative(report.used)) return undefined
  const source = contextSource(report.source)
  const breakdown = source === 'claude-sdk' ? windowBreakdown(report.breakdown) : undefined
  return {
    at,
    used: report.used,
    ...(nonNegative(report.size) ? { size: report.size } : {}),
    ...(source ? { source } : {}),
    ...(count(report.epoch) ? { epoch: report.epoch } : {}),
    ...(breakdown ? { breakdown } : {}),
  }
}

function toolLocations(messages: readonly Message[]) {
  const rows = new Map<string, { message: Message; turnId: string } | null>()
  const ids = new Set<string>()
  const repeated = new Set<string>()
  let turnId: string | undefined
  for (const message of messages) {
    if (ids.has(message.id)) repeated.add(message.id)
    else ids.add(message.id)
    if (message.role === 'user' && !message.steered) turnId = message.id
    if (message.role !== 'tool' || !message.contextToolId) continue
    const resultId = message.contextToolId
    rows.set(resultId, turnId && !rows.has(resultId) ? { message, turnId } : null)
  }
  return (source: RequestContextToolContribution['source']) => {
    if (!source) return undefined
    const row = rows.get(source.resultId)
    return row && row.turnId === source.turnId && !repeated.has(row.turnId) && !repeated.has(row.message.id) ? row.message : undefined
  }
}

function panelEvents(
  turns: readonly Message[],
  compactions: TaskDetail['contextEvents'],
  turnOf: (id: string) => ContextPanelEvent['turn'],
) {
  const events: Array<ContextPanelEvent & { turnId?: string }> = []
  for (const message of turns) {
    if (!message.freshContext) continue
    const at = reportTime(message.createdAt)
    if (at) events.push({ at, kind: 'reset', turnId: message.id })
  }
  for (const event of compactions ?? []) {
    const at = reportTime(event.at)
    const source = contextSource(event.source)
    const { status, trigger, beforeTokens, afterTokens, durationMs } = event
    if (!at || !source || !['in_progress', 'completed', 'failed', 'cancelled', 'unknown'].includes(status)) continue
    events.push({
      at,
      kind: 'compaction',
      source,
      status,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(trigger === 'auto' || trigger === 'manual' ? { trigger } : {}),
      ...(count(beforeTokens) ? { beforeTokens } : {}),
      ...(count(afterTokens) ? { afterTokens } : {}),
      ...(nonNegative(durationMs) ? { durationMs } : {}),
    })
  }
  return events
    .toSorted((a, b) => a.at.localeCompare(b.at))
    .slice(-CONTEXT_EVENT_LIMIT)
    .map(({ turnId, ...event }) => {
      const turn = turnId === undefined ? undefined : turnOf(turnId)
      return { ...event, ...(turn ? { turn } : {}) }
    })
}

type ContextRefCalls = {
  revealTurn(ref: string): void
  revealTool(ref: string): void
}

type ContextProjectionInput = {
  harnessId: string
  messages: readonly Message[]
  requestContext?: TaskDetail['requestContext']
  contextSteps?: TaskDetail['contextSteps']
  usageReport?: TaskDetail['usageReport']
  contextEvents?: TaskDetail['contextEvents']
}

interface ContextProjection {
  context: SessionContext
  messageByRef: ReadonlyMap<string, string>
  refByMessage: ReadonlyMap<string, string>
  toolMessageByRef: ReadonlyMap<string, string>
  toolRefByResult: ReadonlyMap<string, string>
}

/** The reference maps belong to the workbench and are kept out of the snapshot sent to the module. */
export function projectSessionContext(
  { harnessId, messages, requestContext, contextSteps, usageReport, contextEvents: compactions }: ContextProjectionInput,
  previous?: Pick<ContextProjection, 'refByMessage' | 'toolRefByResult'>,
): ContextProjection {
  const standard = harnessId === 'standard'
  const turns = messages.filter(message => message.role === 'user' && !message.steered)
  const byId = new Map(turns.map((message, index) => [message.id, index]))
  const messageByRef = new Map<string, string>()
  const refByMessage = new Map<string, string>()
  const toolMessageByRef = new Map<string, string>()
  const toolRefByResult = new Map<string, string>()
  const turnOf = (messageId: string) => {
    const index = byId.get(messageId)
    if (index === undefined) return undefined
    const ref = refByMessage.get(messageId) ?? previous?.refByMessage.get(messageId) ?? crypto.randomUUID()
    refByMessage.set(messageId, ref)
    messageByRef.set(ref, messageId)
    return { number: index + 1, ref }
  }
  const recentSteps = standard ? (contextSteps ?? []).slice(-CONTEXT_STEP_LIMIT) : []
  const locateTool = recentSteps.some(step => step.toolContributions) ? toolLocations(messages) : undefined
  const contributions = (rows: RequestContextToolContribution[]): ContextPanelToolContribution[] =>
    rows.slice(0, CONTEXT_TOOL_CONTRIBUTION_LIMIT).flatMap(({ bytes, inclusion, source }) => {
      if (!count(bytes) || (inclusion !== 'new' && inclusion !== 'replayed' && inclusion !== 'unknown')) return []
      const row = locateTool?.(source)
      if (!row || !source) return [{ bytes, inclusion }]
      const resultId = source.resultId
      const toolRef = toolRefByResult.get(resultId) ?? previous?.toolRefByResult.get(resultId) ?? crypto.randomUUID()
      toolRefByResult.set(resultId, toolRef)
      toolMessageByRef.set(toolRef, row.id)
      return [{ bytes, inclusion, name: toolGroup(row, standard), toolRef }]
    })
  const steps: SessionContext['steps'] = recentSteps.map(step => {
    const turn = turnOf(step.turnId)
    return {
      ...requestCounts(step),
      sequence: step.sequence,
      bytes: {
        instructions: step.bytes.instructions,
        skills: step.bytes.skills,
        toolSchemas: step.bytes.toolSchemas,
        user: step.bytes.user,
        assistant: step.bytes.assistant,
        toolResults: step.bytes.toolResults,
      },
      toolCalls: step.toolCalls,
      status: step.status,
      ...(step.unmeasuredTools === undefined ? {} : { unmeasuredTools: step.unmeasuredTools }),
      ...(step.outputTokens === undefined ? {} : { outputTokens: step.outputTokens }),
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      ...(step.freshContext === true ? { freshContext: true } : {}),
      ...(turn ? { turn } : {}),
      ...(step.toolContributions
        ? {
            toolContributions: {
              largest: contributions(step.toolContributions.largest),
              added: contributions(step.toolContributions.added),
            },
          }
        : {}),
    }
  })
  const events = panelEvents(turns, compactions, turnOf)
  const recent = turns.slice(-CONTEXT_STEP_LIMIT).map(message => ({ message, window: turnWindow(message) }))
  const windows = recent.some(row => row.window)
    ? recent.map(({ message, window }, index) => {
        const turn = turnOf(message.id)!
        if (!window) return { turn }
        const previousWindow = recent[index - 1]?.window
        const comparable =
          previousWindow
          && window.source
          && previousWindow.source === window.source
          && window.size !== undefined
          && window.size > 0
          && previousWindow.size === window.size
          && previousWindow.epoch === window.epoch
          && previousWindow.at <= window.at
          && !message.freshContext
          && !events.some(
            event => event.kind === 'compaction' && event.status === 'completed' && event.at >= previousWindow.at && event.at <= window.at,
          )
        return { turn, window, ...(comparable ? { delta: window.used - previousWindow.used } : {}) }
      })
    : []
  const request = standard && requestContext ? requestCounts(requestContext) : undefined
  const window = latestWindow(usageReport)
  const freshAt = reportTime(turns.findLast(message => message.freshContext)?.createdAt)
  return {
    context: {
      kind: standard ? 'standard' : 'harness',
      steps,
      windows,
      tools: countContextTools(messages, message => toolGroup(message, standard)),
      ...(request ? { request } : {}),
      ...(window ? { window } : {}),
      ...(events.length ? { events } : {}),
      ...(freshAt ? { freshAt } : {}),
    },
    messageByRef,
    refByMessage,
    toolMessageByRef,
    toolRefByResult,
  }
}

/** One mounted panel keeps its own committed references across live updates and reconnects. */
export function useSessionContext(
  detail: TaskDetail,
  onRevealTurn: ((messageId: string) => void) | undefined,
  onRevealTool: ((messageId: string) => void) | undefined,
): ContextRefCalls & { context: SessionContext } {
  const {
    summary: { id, harnessId },
    messages,
    requestContext,
    contextSteps,
    usageReport,
    contextEvents,
  } = detail
  const [committed] = useState(() => new Map<string, ContextProjection>())
  const projection = useMemo(
    () => projectSessionContext({ harnessId, messages, requestContext, contextSteps, usageReport, contextEvents }, committed.get(id)),
    [committed, id, harnessId, messages, requestContext, contextSteps, usageReport, contextEvents],
  )
  const reveal = useRef<ContextRefCalls | null>(null)
  useLayoutEffect(() => {
    committed.clear()
    committed.set(id, projection)
    reveal.current = {
      revealTurn(ref) {
        const messageId = projection.messageByRef.get(ref)
        if (messageId !== undefined) onRevealTurn?.(messageId)
      },
      revealTool(ref) {
        const messageId = projection.toolMessageByRef.get(ref)
        if (messageId !== undefined) onRevealTool?.(messageId)
      },
    }
    return () => {
      reveal.current = null
    }
  }, [committed, id, projection, onRevealTurn, onRevealTool])
  const revealTurn = useCallback((ref: string) => {
    if (typeof ref === 'string') reveal.current?.revealTurn(ref)
  }, [])
  const revealTool = useCallback((ref: string) => {
    if (typeof ref === 'string') reveal.current?.revealTool(ref)
  }, [])
  return { context: projection.context, revealTurn, revealTool }
}
