import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message, TaskDetail, TaskStatus } from '@latch/protocol'
import type { Turn } from '../src/conversation.ts'
import {
  foldedRows,
  foldSummary,
  liveFacts,
  livePhase,
  outcomeWords,
  phaseText,
  resendWarning,
  runElapsed,
  separators,
  sideEffects,
  toolDuration,
  toolLabel,
  turnOutcome,
  turnsOf,
  turnText,
  turnTimes,
  turnTimeTip,
  turnUsage,
} from '../src/conversation.ts'
import { Transcript } from '../src/components/Transcript.tsx'
import { hostNow, observeHostTime, resetHostClock } from '../src/core/hostClock.ts'

const T0 = Date.parse('2026-10-24T06:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const noop = () => {}

const user = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: 'user', text: `问 ${id}`, ...extra })
const reply = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: 'assistant',
  text,
  state: 'completed',
  ...extra,
})
const tool = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: 'tool',
  text: '',
  toolName: 'read_file',
  state: 'completed',
  ...extra,
})

/** The first turn of `messages`. */
function firstTurn(messages: Message[]): Turn {
  const [turn] = turnsOf(messages)
  if (!turn) throw new Error('no turn')
  return turn
}

/** A local time on 24 October 2026. */
const day = (hours: number, minutes = 0) => new Date(2026, 9, 24, hours, minutes).toISOString()

/** What resending a turn with one tool of `kind` in `state` might repeat. */
function effects(kind: 'read' | 'edit' | 'execute' | 'other' | undefined, state: Message['state'], output = '') {
  return sideEffects(firstTurn([user('u'), tool('t', { state, tool: { ...(kind ? { kind } : {}), output } })]))
}

function detail(messages: Message[], extra: Partial<TaskDetail> = {}, status: TaskStatus = 'idle'): TaskDetail {
  return { summary: { id: 's', title: 't', status, updatedAt: '' }, messages, approvals: [], liveText: '', cursor: 1, ...extra }
}

afterEach(() => {
  resetHostClock()
})

describe('turns of a conversation', () => {
  it('groups each prompt with what answered it and keeps content before any prompt as its own turn', () => {
    const turns = turnsOf([reply('lead', '早'), user('u1'), reply('a1', '一'), tool('tool:1'), user('u2')])
    expect(turns.map(turn => [turn.key, turn.replies.map(message => message.id)])).toEqual([
      ['lead:lead', ['lead']],
      ['u1', ['a1', 'tool:1']],
      ['u2', []],
    ])
  })

  it('reads the outcome of the latest turn from the session and of earlier ones from their own messages', () => {
    const turn = firstTurn([user('u'), reply('a', '部分', { state: 'cancelled' })])
    expect(turnOutcome(turn, 'failed')).toBe('failed')
    expect(turnOutcome(turn, 'interrupted')).toBe('interrupted')
    expect(turnOutcome(turn, 'idle')).toBe('completed')
    expect(turnOutcome(turn, undefined)).toBe('stopped')
    const failed = firstTurn([user('u'), { id: 'n', role: 'system', text: '模型服务返回错误', state: 'failed' }])
    expect(turnOutcome(failed, undefined)).toBe('failed')
  })

  it('copies every prose block of the turn and sums its usage, keeping a part only when every step reported it', () => {
    const turn = firstTurn([
      user('u'),
      reply('a1', '先读文件。', { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 } }),
      tool('tool:1'),
      reply('a2', '完成了。', { usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 150, reasoningTokens: 5 } }),
    ])
    expect(turnText(turn)).toBe('先读文件。\n\n完成了。')
    expect(turnUsage(turn)).toEqual({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 230 })
  })
})

describe('process rows', () => {
  it('says what a tool does in the tense of its state, with its object, or its own title when it names none', () => {
    const read = { toolName: 'read_file', tool: { kind: 'read' as const, title: 'read_file', input: '{"path":"src/app.ts"}' } }
    expect(toolLabel({ ...read, state: 'running' })).toEqual({ verb: '正在读取', object: 'src/app.ts', mono: true })
    expect(toolLabel({ ...read, state: 'completed' })).toEqual({ verb: '读取', object: 'src/app.ts', mono: true })
    expect(
      toolLabel({ toolName: 'x', state: 'completed', tool: { kind: 'execute', title: 'Run pnpm test', input: '{"command":"pnpm test"}' } }),
    ).toEqual({
      verb: '运行',
      object: 'pnpm test',
      mono: true,
    })
    // An agent's title already begins with its verb: it stands alone rather than as 「运行 Run …」.
    expect(toolLabel({ toolName: 'execute', state: 'running', tool: { kind: 'execute', title: 'Run pnpm test' } })).toEqual({
      object: 'Run pnpm test',
      mono: false,
    })
    expect(
      toolLabel({ toolName: 'edit', state: 'completed', tool: { kind: 'edit', title: 'Edit a.txt', locations: ['/w/a.txt:3'] } }),
    ).toEqual({
      verb: '修改',
      object: '/w/a.txt:3',
      mono: true,
    })
  })

  it('times a tool from its start after any approval to its end, ticks while it runs and shows nothing without times', () => {
    expect(toolDuration(tool('t', { createdAt: at(0), startedAt: at(35_000), completedAt: at(37_400) }), T0)).toEqual({
      ms: 2400,
      live: false,
    })
    expect(toolDuration(tool('t', { createdAt: at(0), completedAt: at(1500) }), T0)).toEqual({ ms: 1500, live: false })
    expect(toolDuration(tool('t', { state: 'running', startedAt: at(0) }), T0 + 3200)).toEqual({ ms: 3200, live: true })
    expect(toolDuration(tool('t', { state: 'awaiting-approval', createdAt: at(0) }), T0 + 9000)).toBeUndefined()
    expect(toolDuration(tool('t'), T0)).toBeUndefined()
  })
})

describe('the fold after a settled turn', () => {
  const messages = [
    user('u'),
    reply('a1', '先看看接口。', { reasoning: '想', reasoningMs: 6000 }),
    tool('tool:read', { tool: { kind: 'read' }, createdAt: at(0), startedAt: at(0), completedAt: at(2400) }),
    reply('a2', '找到原因了。'),
    tool('tool:write', { tool: { kind: 'edit', diffs: [{ path: 'a.ts', newText: 'x' }] } }),
    reply('a3', '已修复。'),
  ]

  it('folds the process before the answer and keeps evidence, failures and the prose that introduces them in view', () => {
    const turn = firstTurn(messages)
    expect(foldedRows(turn, 'completed').map(message => message.id)).toEqual(['a1', 'tool:read'])
    expect(foldSummary(foldedRows(turn, 'completed'))).toBe('已处理 · 思考 6 秒 · 读取 1 个文件 · 用时 2.4 秒')
    for (const outcome of ['failed', 'stopped', 'interrupted'] as const) expect(foldedRows(turn, outcome)).toEqual([])
    const failing = firstTurn([user('u'), tool('tool:a', { state: 'failed' }), reply('a', '结束。')])
    expect(foldedRows(failing, 'completed')).toEqual([])
    const plain = firstTurn([user('u'), reply('a', '只是回答。')])
    expect(foldedRows(plain, 'completed')).toEqual([])
  })

  it('names at most three kinds and counts the rest', () => {
    const rows = (['read', 'edit', 'execute', 'search', 'fetch'] as const).map((kind, index) => tool(`t${index}`, { tool: { kind } }))
    expect(foldSummary(rows)).toBe('已处理 · 读取 1 个文件 · 修改 1 个文件 · 运行 1 条命令 · 等 2 项')
  })
})

describe('time separators', () => {
  it('opens the transcript and every prompt on another day or more than an hour after the message before it', () => {
    const marks = separators([
      user('u1', { createdAt: day(9) }),
      reply('a1', '一', { createdAt: day(9), completedAt: day(9, 1) }),
      user('u2', { createdAt: day(10) }),
      reply('a2', '二', { createdAt: day(10), completedAt: day(10, 1) }),
      user('u3', { createdAt: day(11, 2) }),
      reply('a3', '三', { createdAt: new Date(2026, 9, 24, 23, 59).toISOString() }),
      user('u4', { createdAt: new Date(2026, 9, 25, 0, 1).toISOString() }),
      user('old'),
      user('u5', { createdAt: new Date(2026, 9, 25, 9).toISOString() }),
    ])
    // 59 minutes after the reply before it: no separator; 61 minutes: one, on the same day as the first.
    expect([...marks.keys()]).toEqual(['u1', 'u3', 'u4'])
    expect(marks.get('u3')?.sameDay).toBe(true)
    expect(marks.get('u4')?.sameDay).toBe(false)
  })
})

describe('resending a turn', () => {
  it('asks first only when a tool that may change something ran, failed, stopped or has an unknown outcome', () => {
    expect(resendWarning(effects('read', 'completed'), false)).toBeUndefined()
    expect(resendWarning(effects('edit', 'queued'), false)).toBeUndefined()
    expect(resendWarning(effects('execute', 'cancelled', 'TOOL_NOT_STARTED: …'), false)).toBeUndefined()
    expect(resendWarning(effects('edit', 'completed'), false)).toBe(
      '上一次已经执行了 1 个操作：修改 1 个文件。重新发送后，Agent 可能再次执行它们。',
    )
    expect(resendWarning(effects('execute', 'failed'), true)).toBe(
      '上一次已经执行了 1 个操作：运行 1 条命令。重新发送后，Agent 可能再次执行它们。完全访问会话不会逐项询问。',
    )
    expect(resendWarning(effects(undefined, 'completed'), false)).toContain('调用 1 次其他工具')
    expect(resendWarning(effects('execute', 'running'), false)).toBe(
      '上一次有 1 个操作结果未知，可能已经执行。重新发送后，Agent 可能再次执行它们。',
    )
    expect(resendWarning(effects('other', 'failed', 'TOOL_OUTCOME_UNKNOWN: …'), false)).toContain('结果未知')
  })

  it('offers 重新发送 only on the latest turn that did not simply finish, and sends its prompt again', () => {
    const sent: string[] = []
    const render = (status: TaskStatus) =>
      renderToStaticMarkup(
        createElement(Transcript, {
          detail: detail([user('u1'), reply('a1', '好'), user('u2'), reply('a2', '部分', { state: 'failed' })], {}, status),
          approvals: [],
          busy: new Map(),
          onDecide: noop,
          harnessName: 'Latch',
          retry: { fullAccess: false, onResend: prompt => sent.push(prompt) },
        }),
      )
    expect(render('failed').match(/>重新发送</g)).toHaveLength(1)
    expect(render('idle')).not.toContain('重新发送')
  })
})

describe('the live run', () => {
  it('measures the run on the Host clock without approval waits, frozen while one is open', () => {
    const running = detail([], { runStartedAt: at(0), runWaitMs: 5000 }, 'running')
    expect(runElapsed(running, T0 + 20_000)).toBe(15_000)
    const waiting = { ...running, runWaitingSince: at(17_000) }
    expect(runElapsed(waiting, T0 + 20_000)).toBe(12_000)
    expect(runElapsed(waiting, T0 + 60_000)).toBe(12_000)
    expect(runElapsed(detail([]), T0)).toBeUndefined()
  })

  it('follows the Host clock, ignoring an offset that changed by less than a second', () => {
    observeHostTime(new Date(T0).toISOString(), T0 - 30_000)
    const shifted = hostNow() - Date.now()
    expect(shifted).toBe(30_000)
    observeHostTime(new Date(T0 + 500).toISOString(), T0 - 30_000)
    expect(hostNow() - Date.now()).toBe(30_000)
    observeHostTime('not a time')
    expect(hostNow() - Date.now()).toBe(30_000)
  })

  it('says what the run does: stopping, waiting for you, a running tool, the reply, reasoning, starting or the model', () => {
    const base = detail([user('u')], {}, 'running')
    const phase = (extra: Partial<TaskDetail>, opts: { cancelling?: boolean; approvals?: number } = {}) =>
      phaseText(livePhase({ ...base, ...extra }, { cancelling: false, approvals: 0, hostNow: T0 + 12_000, ...opts }), 'Codex')
    expect(phase({}, { cancelling: true })).toBe('正在停止…')
    expect(phase({}, { approvals: 1 })).toBe('等你批准')
    expect(
      phase({ messages: [user('u'), tool('t', { state: 'running', tool: { kind: 'execute', input: '{"command":"pnpm test"}' } })] }),
    ).toBe('正在运行 pnpm test')
    // A tool without a kind Latch reads says 正在执行 with its title; so does the driver's own phase.
    expect(phase({ messages: [user('u'), tool('t', { state: 'running', toolName: 'mcp_lookup' })] })).toBe('正在执行 mcp_lookup')
    expect(phase({ activity: { phase: 'tool', toolName: 'lookup' } })).toBe('正在执行 lookup')
    expect(phase({ liveText: '好' })).toBe('正在回复')
    expect(phase({ liveReasoning: '想' })).toBe('正在思考')
    expect(phase({ activity: { phase: 'starting', since: at(5000) } })).toBe('正在启动 Codex…')
    expect(phase({ activity: { phase: 'starting', since: at(0) } })).toBe('Codex 启动较慢，仍在等待进程就绪…')
    expect(phase({ activity: { phase: 'model' } })).toBe('等待模型…')
  })

  it('reports output so far, the context an agent reported, and a stall after two quiet minutes', () => {
    const turn = firstTurn([user('u'), reply('a', '一', { usage: { inputTokens: 8200, outputTokens: 900 } })])
    const running = detail([], { lastOutputAt: at(0) }, 'running')
    expect(liveFacts(running, turn, T0 + 119_000)).toMatchObject({ tokens: '输出 900 tokens' })
    expect(liveFacts(running, turn, T0 + 119_000).stalled).toBeUndefined()
    expect(liveFacts(running, turn, T0 + 121_000).stalled).toBe('2 分钟没有新输出')
    const agent = detail([], { usageReport: { contextUsed: 74_210, contextSize: 200_000, at: at(0) } }, 'running')
    expect(liveFacts(agent, turnsOf([user('u')])[0], T0)).toMatchObject({
      tokens: '上下文 74.2k tokens',
      tokensTitle: '由 Agent 报告：74,210 tokens',
    })
    expect(liveFacts({ ...running, activity: { phase: 'approval' } }, turn, T0 + 400_000).stalled).toBeUndefined()
  })
})

/** A local time on 24 October 2026, in milliseconds and as the Host writes it. */
const ms = (hours: number, minutes: number, seconds = 0) => new Date(2026, 9, 24, hours, minutes, seconds).getTime()
const iso = (hours: number, minutes: number, seconds = 0) => new Date(ms(hours, minutes, seconds)).toISOString()

/** A settled transcript of `messages` whose session ended as `status`. */
const settledTranscript = (messages: Message[], status: TaskStatus) =>
  renderToStaticMarkup(
    createElement(Transcript, {
      detail: detail(messages, {}, status),
      approvals: [],
      busy: new Map(),
      onDecide: noop,
      harnessName: 'Latch',
    }),
  )

/** A transcript whose latest turn streams its first words, in a session that uses fixture-large. */
const streamingTranscript = (status: TaskStatus) =>
  renderToStaticMarkup(
    createElement(Transcript, {
      detail: {
        ...detail([user('u')], { liveText: '正在写', liveMessageId: 'live' }, status),
        summary: { id: 's', title: 't', status, updatedAt: '', model: 'fixture-large', providerId: 'fixture' },
      },
      approvals: [],
      busy: new Map(),
      onDecide: noop,
      harnessName: 'Latch',
      active: status === 'running',
    }),
  )

describe('a settled turn', () => {
  const now = ms(18, 0)

  it('says a stopped turn kept part of its reply only when it has prose, and an interrupted one kept content only when it has any', () => {
    expect(outcomeWords(firstTurn([user('u'), reply('a', '部分', { state: 'cancelled' })]), 'stopped')).toEqual([
      '已停止',
      '保留了部分回复',
    ])
    expect(outcomeWords(firstTurn([user('u'), tool('t', { state: 'cancelled' })]), 'stopped')).toEqual(['已停止'])
    expect(outcomeWords(firstTurn([user('u')]), 'stopped')).toEqual(['已停止'])
    expect(outcomeWords(firstTurn([user('u'), tool('t')]), 'interrupted')).toEqual(['回复中断', '保留了部分内容'])
    expect(outcomeWords(firstTurn([user('u')]), 'interrupted')).toEqual(['回复中断'])
    expect(outcomeWords(firstTurn([user('u')]), 'failed')).toEqual(['失败'])
    expect(outcomeWords(firstTurn([user('u'), reply('a', '好')]), 'completed')).toEqual([])
  })

  it('is dated by when its reply was sent, with its start, end, working time and approval wait in the tooltip', () => {
    const turn = firstTurn([
      user('u', { createdAt: iso(14, 31, 5), turn: { endedAt: iso(14, 32, 37), activeMs: 72_000, waitMs: 20_000 } }),
      reply('a', '好', { completedAt: iso(14, 32, 36) }),
    ])
    const times = turnTimes(turn)
    expect(times.sentAt).toBe(ms(14, 32, 37))
    expect(turnTimeTip(times, 'completed', now)).toBe('10月24日 14:31:05 开始 · 14:32:37 完成 · 用时 1 分 12 秒（不含等待批准 20 秒）')
    expect(turnTimeTip({ ...times, waitMs: 0 }, 'stopped', now)).toBe('10月24日 14:31:05 开始 · 14:32:37 停止 · 用时 1 分 12 秒')
    // History without the turn's end falls back to the last reply's completion; an interrupted turn has no duration.
    const older = firstTurn([
      user('u', { createdAt: iso(23, 59, 50) }),
      reply('a', '好', { completedAt: new Date(ms(24, 0, 20)).toISOString() }),
    ])
    expect(turnTimes(older).sentAt).toBe(ms(24, 0, 20))
    expect(turnTimeTip({ ...turnTimes(older), activeMs: 30_000 }, 'interrupted', now)).toBe(
      '10月24日 23:59:50 开始 · 10月25日 00:00:20 结束',
    )
    expect(turnTimeTip({}, 'completed', now)).toBeUndefined()

    // The footer shows the reply's time, not the prompt's (which is under the bubble), and no separate duration.
    const html = renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail(turn.user ? [turn.user, ...turn.replies] : []),
        approvals: [],
        busy: new Map(),
        onDecide: noop,
        harnessName: 'Latch',
      }),
    )
    const footer = html.slice(html.indexOf('class="turn-footer'))
    expect(footer).toContain(`<time dateTime="${iso(14, 32, 37)}"`)
    expect(footer).not.toContain(`<time dateTime="${iso(14, 31, 5)}"`)
    expect(footer).toContain('14:32:37 完成 · 用时 1 分 12 秒（不含等待批准 20 秒）')
    expect(footer).not.toMatch(/class="turn-fact"[^>]*>用时/)
  })

  it('writes the outcome from what the turn kept', () => {
    const kept = settledTranscript([user('u'), reply('a', '部分', { state: 'cancelled' })], 'cancelled')
    expect(kept).toContain('>已停止</span><span class="turn-fact">保留了部分回复</span>')
    const nothing = settledTranscript([user('u'), tool('t', { state: 'cancelled' })], 'cancelled')
    expect(nothing).toContain('>已停止</span>')
    expect(nothing).not.toContain('保留了部分')
  })

  it('names the model of a running turn from the run before its first step records one', () => {
    expect(streamingTranscript('running')).toContain('<span class="assistant-meta-model">· fixture-large</span>')
    // A settled turn names only the model its steps recorded.
    expect(streamingTranscript('idle')).not.toContain('assistant-meta-model')
  })
})
