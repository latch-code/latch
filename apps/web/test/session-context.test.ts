import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ContextWindowBreakdown, Message, RequestContextStep, SessionContext, UiPanelInfo } from '@latch/protocol'
import * as ui from '@latch/ui'
import { isBundledContextPanel, parsePanelMemory } from '../src/panel/panelTabs.ts'
import { projectSessionContext } from '../src/panel/sessionContext.ts'

const at = '2026-11-24T00:00:00.000Z'
const counts = {
  at,
  userMessages: 2,
  assistantMessages: 1,
  toolResults: 1,
  tools: 4,
  skills: 1,
  images: 0,
  inputTokens: 0,
  creator: true as const,
}
const step = (sequence: number, turnId: string): RequestContextStep => ({
  ...counts,
  sequence,
  turnId,
  bytes: { instructions: 12, skills: 34, toolSchemas: 56, user: 78, assistant: 90, toolResults: 12 },
  toolCalls: 1,
  status: 'completed',
  outputTokens: 10,
  durationMs: 250,
  ...(sequence === 1 ? { freshContext: true } : {}),
})
const user = (id: string, extra?: Partial<Message>): Message => ({
  id,
  role: 'user',
  text: 'PRIVATE_MESSAGE',
  createdAt: at,
  requestId: 'PRIVATE_REQUEST',
  ...extra,
})
const tool = (id: string, name: string, extra?: Partial<Message>): Message => ({
  id,
  role: 'tool',
  text: 'PRIVATE_RESULT',
  toolName: name,
  tool: { kind: 'read', title: 'PRIVATE_TITLE', input: '/PRIVATE_PATH', output: 'PRIVATE_OUTPUT' },
  reasoning: 'PRIVATE_REASONING',
  ...extra,
})

it('gives Standard panels only request counts and measurements for views of actual turn openers', () => {
  const messages = [
    user('PRIVATE_TURN_ONE', { freshContext: true }),
    user('PRIVATE_STEER', { steered: true }),
    tool('PRIVATE_TOOL_ONE', 'read_file', { startedAt: at, completedAt: '2026-11-24T00:00:04.000Z' }),
    tool('PRIVATE_TOOL_TWO', 'read_file', { state: 'failed' }),
    tool('PRIVATE_TOOL_THREE', 'PRIVATE_ARBITRARY_IDENTIFIER', { state: 'failed', interrupted: true }),
  ]
  const request = { ...counts, rawInput: 'PRIVATE_RAW_REQUEST' }
  const steps = [
    { ...step(1, messages[0]!.id), raw: 'PRIVATE_RAW_STEP', bytes: { ...step(1, '').bytes, hidden: 'PRIVATE_RAW_BYTES' } },
    step(2, messages[1]!.id),
    step(3, 'PRIVATE_LOST_TURN'),
  ]
  const { context, messageByRef } = projectSessionContext({ harnessId: 'standard', messages, requestContext: request, contextSteps: steps })
  expect(context.request).toEqual(counts)
  expect(context.steps[0]).toMatchObject({ inputTokens: 0, outputTokens: 10, durationMs: 250, freshContext: true, turn: { number: 1 } })
  expect(context.steps.slice(1).map(item => item.turn)).toEqual([undefined, undefined])
  const turn = context.steps[0]!.turn!
  expect(messageByRef.get(turn.ref)).toBe(messages[0]!.id)
  expect(messageByRef.get(messages[0]!.id)).toBeUndefined()
  expect(context.tools).toEqual({
    total: 3,
    failures: 1,
    groups: [
      { name: 'read_file', calls: 2, failed: 1, longestMs: 4000 },
      { name: 'read', calls: 1, failed: 0, longestMs: 0 },
    ],
  })
  expect(context.freshAt).toBe(at)
  expect(JSON.stringify(context)).not.toContain('PRIVATE_')
})

it('keeps current turn references through live updates and drops them when the target or the mount is gone', () => {
  const turn = user('first')
  const input = { harnessId: 'standard', messages: [turn], contextSteps: [step(1, turn.id)] }
  const first = projectSessionContext(input)
  const ref = first.context.steps[0]!.turn!.ref
  const next = projectSessionContext({ ...input, messages: [turn, user('second')], contextSteps: [step(2, turn.id)] }, first)
  expect(next.context.steps[0]!.turn!.ref).toBe(ref)
  const removed = projectSessionContext({ ...input, messages: [user('second')] }, next)
  expect(removed.messageByRef.has(ref)).toBe(false)
  const reopened = projectSessionContext(input)
  expect(reopened.messageByRef.has(ref)).toBe(false)
})

it('only reveals uniquely matched tool results in their original turns and rotates references as they leave the view', () => {
  const firstTurn = user('PRIVATE_FIRST')
  const secondTurn = user('PRIVATE_SECOND', { freshContext: true })
  const firstTool = tool('PRIVATE_FIRST_TOOL', 'PRIVATE_TOOL_NAME', { contextToolId: 'PRIVATE_FIRST_RESULT' })
  const secondTool = tool('PRIVATE_SECOND_TOOL', 'read_file', { contextToolId: 'PRIVATE_SECOND_RESULT' })
  const firstResult = { bytes: 300, inclusion: 'replayed' as const, source: { turnId: firstTurn.id, resultId: firstTool.contextToolId! } }
  const secondResult = { bytes: 100, inclusion: 'new' as const, source: { turnId: secondTurn.id, resultId: secondTool.contextToolId! } }
  const wrongTurn = { bytes: 200, inclusion: 'unknown' as const, source: { ...firstResult.source, turnId: secondTurn.id } }
  const contextSteps: RequestContextStep[] = [
    {
      ...step(2, secondTurn.id),
      toolContributions: {
        largest: [{ ...firstResult, rawContent: 'PRIVATE_RAW_RESULT' } as typeof firstResult, wrongTurn, secondResult],
        added: [secondResult],
      },
    },
  ]
  const input = { harnessId: 'standard', messages: [firstTurn, firstTool, secondTurn, secondTool], contextSteps }
  const first = projectSessionContext(input)
  const { largest, added } = first.context.steps[0]!.toolContributions!
  expect(largest[0]).toMatchObject({ bytes: 300, inclusion: 'replayed', name: 'read' })
  expect(largest[1]).toEqual({ bytes: 200, inclusion: 'unknown' })
  expect(added[0]).toMatchObject({ bytes: 100, inclusion: 'new', name: 'read_file', toolRef: largest[2]!.toolRef })
  const ref = largest[0]!.toolRef!
  const turnRef = first.context.steps[0]!.turn!.ref
  expect(first.toolMessageByRef.get(ref)).toBe(firstTool.id)
  expect(first.messageByRef.has(ref)).toBe(false)
  expect(first.toolMessageByRef.has(turnRef)).toBe(false)
  expect(first.toolMessageByRef.has(firstTool.id)).toBe(false)
  expect(first.toolMessageByRef.has(firstTool.contextToolId!)).toBe(false)
  expect(JSON.stringify(first.context)).not.toContain('PRIVATE_')

  const reconnected = projectSessionContext({ ...input, messages: structuredClone(input.messages) }, first)
  expect(reconnected.toolMessageByRef.get(ref)).toBe(firstTool.id)
  const reusedRowId = projectSessionContext({ ...input, messages: [...input.messages, { ...secondTool, id: firstTool.id }] }, reconnected)
  expect(reusedRowId.toolMessageByRef.size).toBe(0)
  const duplicatedResult = projectSessionContext(
    { ...input, messages: [...input.messages, { ...firstTool, id: 'PRIVATE_DUPLICATE' }] },
    first,
  )
  expect(duplicatedResult.toolMessageByRef.has(ref)).toBe(false)
  const reopened = projectSessionContext(input)
  expect(reopened.toolMessageByRef.has(ref)).toBe(false)
})

it('keeps zero and gaps in ACP window history and uses finite tool kinds and timestamps', () => {
  const { context } = projectSessionContext({
    harnessId: 'codex',
    messages: [
      user('PRIVATE_ONE', { turn: { contextWindow: { at, used: 0, size: 500 } } }),
      user('PRIVATE_NO_REPORT'),
      user('PRIVATE_FUTURE_TURN', { turn: { contextWindow: { at: 'PRIVATE_DRIVER_FIELD', used: 101 } } }),
      user('PRIVATE_FOUR', { turn: { contextWindow: { at, used: 120 } } }),
      tool('PRIVATE_TOOL', 'read_file'),
    ],
    requestContext: counts,
    contextSteps: [step(1, 'PRIVATE_ONE')],
    usageReport: {
      at,
      contextUsed: 120,
      contextSize: 500,
      configuredContextSize: true,
      cost: { amount: 100, currency: 'PRIVATE_CURRENCY' },
    },
  })
  expect(context.kind).toBe('harness')
  expect(context.request).toBeUndefined()
  expect(context.steps).toEqual([])
  expect(context.window).toEqual({ at, used: 120, size: 500, configuredSize: true })
  expect(context.windows.map(row => [row.turn.number, row.window?.used])).toEqual([
    [1, 0],
    [2, undefined],
    [3, undefined],
    [4, 120],
  ])
  expect(context.tools.groups).toEqual([{ name: 'read', calls: 1, failed: 0, longestMs: 0 }])
  expect(JSON.stringify(context)).not.toContain('PRIVATE_')
})

it('sanitizes the full Claude breakdown and keeps window deltas within comparable samples', () => {
  const time = (second: number) => new Date(Date.parse(at) + second * 1000).toISOString()
  const measured = (number: number, used: number, size: number, epoch: number, source: 'claude-sdk' | 'acp' = 'claude-sdk') =>
    user(`PRIVATE_TURN_${number}`, { createdAt: time(number), turn: { contextWindow: { at: time(number), used, size, epoch, source } } })
  const messages = [
    measured(1, 0, 50, 0),
    measured(2, 8, 50, 0),
    measured(3, 8, 50, 0),
    user('PRIVATE_GAP'),
    measured(5, 7, 50, 0),
    measured(6, 9, 60, 0),
    measured(7, 10, 60, 1),
    { ...measured(8, 1, 60, 1), freshContext: true as const },
    measured(9, 3, 60, 1),
    measured(10, 3, 60, 1, 'acp'),
  ]
  const breakdown = {
    measurement: 'full' as const,
    categories: [
      { kind: 'used', id: 'messages', tokens: 3 },
      { kind: 'used', id: 'PRIVATE_CATEGORY', tokens: 2, name: 'PRIVATE_LABEL' },
      { kind: 'PRIVATE_KIND', tokens: 6 },
      { kind: 'free', id: 'free_space', tokens: 55 },
    ],
    messageBreakdown: { toolCalls: 0, userMessages: 2, attachments: -1, rawText: 'PRIVATE_CONTENT' },
    providerUsage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, currency: 'PRIVATE_CURRENCY' },
  } as unknown as ContextWindowBreakdown
  const reported = messages[7]!.turn!.contextWindow!
  reported.breakdown = { measurement: 'full', categories: [{ kind: 'used', id: 'messages', tokens: 1 }] }
  const { context, messageByRef } = projectSessionContext({
    harnessId: 'claude',
    messages,
    usageReport: { at: time(9), contextUsed: 5, contextSize: 60, contextEpoch: 1, contextSource: 'claude-sdk', breakdown },
    contextEvents: [
      {
        id: 'PRIVATE_COMPACTION',
        at: time(9),
        turnId: 'PRIVATE_TURN_9',
        source: 'claude-sdk',
        status: 'completed',
        trigger: 'auto',
        beforeTokens: 17,
        afterTokens: 3,
      },
    ],
  })
  expect(context.window).toEqual({
    at: time(9),
    used: 5,
    size: 60,
    epoch: 1,
    source: 'claude-sdk',
    breakdown: {
      measurement: 'full',
      categories: [
        { kind: 'used', id: 'messages', tokens: 3 },
        { kind: 'used', tokens: 2 },
        { kind: 'free', id: 'free_space', tokens: 55 },
      ],
      messageBreakdown: { toolCalls: 0, userMessages: 2 },
      providerUsage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0 },
    },
  })
  expect(context.windows.map(row => row.delta)).toEqual([
    undefined,
    8,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  expect(context.windows[7]!.window?.breakdown).toEqual(reported.breakdown)
  expect(context.windows[8]!.window?.breakdown).toBeUndefined()
  expect(context.events?.map(event => event.kind)).toEqual(['reset', 'compaction'])
  expect(context.events?.[1]).toMatchObject({
    at: time(9),
    source: 'claude-sdk',
    status: 'completed',
    trigger: 'auto',
    beforeTokens: 17,
    afterTokens: 3,
  })
  expect(messageByRef.get(context.events![0]!.turn!.ref)).toBe('PRIVATE_TURN_8')
  expect(messageByRef.get(context.events![1]!.turn!.ref)).toBe('PRIVATE_TURN_9')
  expect(JSON.stringify(context)).not.toContain('PRIVATE_')
})

it('keeps older latest-request records and allows a session with no context measurements', () => {
  const empty = { kind: 'standard', steps: [], windows: [], tools: { total: 0, failures: 0, groups: [] } }
  expect(projectSessionContext({ harnessId: 'standard', messages: [] }).context).toEqual(empty)
  expect(projectSessionContext({ harnessId: 'standard', messages: [], requestContext: counts }).context).toEqual({
    ...empty,
    request: counts,
  })
})

it('shows Context plugin tool times starting at one second and keeps model request milliseconds', async () => {
  const { default: Panel }: { default: React.ComponentType<ui.ContextPluginPanelProps<SessionContext>> } = await import(
    new URL('../../../examples/context-insights/panel.mjs', import.meta.url).href
  )
  const turn = user('turn')
  const messages = [
    turn,
    tool('quick', 'list_files', { state: 'failed', startedAt: at, completedAt: '2026-11-24T00:00:00.999Z' }),
    tool('one-second', 'read_file', { state: 'completed', startedAt: at, completedAt: '2026-11-24T00:00:01.000Z' }),
    tool('longer', 'list_folders', { state: 'completed', startedAt: at, completedAt: '2026-11-24T00:00:02.500Z' }),
  ]
  const { context } = projectSessionContext({ harnessId: 'standard', messages, contextSteps: [step(1, turn.id)] })
  const html = renderToStaticMarkup(
    React.createElement(Panel, { react: React, ui, locale: 'zh-CN', context, revealTurn() {}, revealTool() {} }),
  )
  expect(html).toContain('<dt>请求耗时</dt><dd>250 ms</dd>')
  expect(html).toContain('>1 次失败</span></small>')
  expect(html).not.toContain('999 ms')
  expect(html).toContain('单次最长实测 1 s</small>')
  expect(html).toContain('单次最长实测 2.5 s</small>')
})

it('matches the bundled module bytes as well as the Context declaration and keeps the built-in tab key', () => {
  const hash = 'a'.repeat(64)
  const panel: UiPanelInfo = {
    id: 'context-insights:insights',
    pluginId: 'context-insights',
    pluginName: 'Context',
    title: 'Context',
    moduleHash: hash,
    context: true,
  }
  expect(isBundledContextPanel(panel, hash)).toBe(true)
  expect(isBundledContextPanel({ ...panel, moduleHash: 'b'.repeat(64) }, hash)).toBe(false)
  const { context: _context, ...ordinary } = panel
  expect(isBundledContextPanel(ordinary, hash)).toBe(false)
  expect(parsePanelMemory({ tabs: ['overview', 'context'], active: 'context' })).toEqual({
    tabs: ['overview', 'context'],
    active: 'context',
  })
})
