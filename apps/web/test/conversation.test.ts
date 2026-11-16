import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff, Message, RunLive, TaskDetail, TaskStatus, TaskSummary } from '@latch/protocol'
import type { Turn } from '../src/conversation.ts'
import {
  sameData,
  stableTurns,
  projectTurns,
  liveTurn,
  livePhase,
  outcomeWords,
  phaseText,
  runClock,
  runEndLine,
  runStatus,
  turnBlocks,
  quietGroupWords,
  alwaysShown,
  linesBelow,
  workFolds,
  foldWords,
  failureReason,
  deliveryWords,
  diffStat,
  type TurnBlock,
  resendWarning,
  runElapsed,
  sideEffects,
  toolDuration,
  decisionLine,
  appliedDiffs,
  ranDespite,
  shownToolOutput,
  shownToolState,
  unrunOutcome,
  toolHeading,
  toolLabel,
  turnOutcome,
  turnsOf,
  turnText,
  turnTimes,
  turnTimeTip,
  turnUsage,
  settingSwitches,
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
  return {
    summary: { harnessId: 'standard', id: 's', title: 't', status, updatedAt: '' },
    messages,
    approvals: [],
    liveText: '',
    cursor: 1,
    ...extra,
  }
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

  it('keeps text added to a running turn in that turn, as the person said it, between what came before and after', () => {
    const steered = user('s', { text: '也看看测试', steered: true })
    const turns = turnsOf([user('u1'), reply('a1', '在读'), steered, reply('a2', '看过测试了'), user('u2')])
    expect(turns.map(turn => [turn.key, turn.replies.map(message => message.id)])).toEqual([
      ['u1', ['a1', 's', 'a2']],
      ['u2', []],
    ])
    const html = renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail([user('u1'), reply('a1', '在读'), steered, reply('a2', '看过测试了')]),
        approvals: [],
        harnessName: 'Latch',
      }),
    )
    // One prompt opens the turn; the added text is a bubble in the reply, marked, and never a second turn.
    expect(html.match(/data-turn=/gu)).toHaveLength(1)
    expect(html.indexOf('在读')).toBeLessThan(html.indexOf('也看看测试'))
    expect(html.indexOf('也看看测试')).toBeLessThan(html.indexOf('看过测试了'))
    expect(html).toContain('已追加到本轮')
  })

  it('shows a subagent as one work row with its name and own word for how it is doing, and nothing it did until opened', () => {
    const row = tool('subagent:1', {
      toolName: 'subagent',
      state: 'running',
      subagent: { title: 'Test runner', status: 'running', steps: [reply('step', '跑完了')] },
    })
    const html = renderToStaticMarkup(
      createElement(Transcript, { detail: detail([user('u'), row], {}, 'running'), approvals: [], harnessName: 'Codex' }),
    )
    expect(html).toContain('子 Agent')
    expect(html).toContain('Test runner')
    expect(html).toContain('运行中')
    expect(html).toContain('aria-expanded="false"')
    expect(livePhase(detail([user('u'), row], {}, 'running'), { cancelling: false, approvals: 0, hostNow: T0 })).toEqual({
      kind: 'tool',
      text: '子 Agent Test runner 运行中',
    })
  })

  it('offers 停止 on a subagent that can be stopped alone, and reads 正在停止… until it says it stopped', () => {
    const row = (subagent: Partial<NonNullable<Message['subagent']>>) =>
      tool('subagent:1', {
        toolName: 'subagent',
        state: 'running',
        subagent: { title: 'Test runner', status: 'running', steps: [], ...subagent },
      })
    const render = (message: Message, stop?: (id: string) => Promise<void>) =>
      renderToStaticMarkup(
        createElement(Transcript, {
          detail: detail([user('u'), message], {}, 'running'),
          approvals: [],
          harnessName: 'Codex',
          ...(stop ? { onStopSubagent: stop } : {}),
        }),
      )
    const stop = async () => {}
    expect(render(row({ stoppable: true }), stop)).toContain('aria-label="停止子 Agent Test runner"')
    // Only where it said it can be, and only where this page may stop the session.
    expect(render(row({}), stop)).not.toContain('停止子 Agent')
    expect(render(row({ stoppable: true }))).not.toContain('停止子 Agent')
    const stopping = render(row({ stopping: true }), stop)
    expect(stopping).toContain('正在停止…')
    expect(stopping).not.toContain('运行中')
    expect(stopping).not.toContain('停止子 Agent')
    expect(
      livePhase(detail([user('u'), row({ stopping: true })], {}, 'running'), { cancelling: false, approvals: 0, hostNow: T0 }),
    ).toEqual({
      kind: 'tool',
      text: '子 Agent Test runner 正在停止…',
    })
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
  it('says what a tool does with its object in one tense, a file by its name, or its own title when it names none', () => {
    const read = { toolName: 'read_file', tool: { kind: 'read' as const, title: 'read_file', input: '{"path":"src/app.ts"}' } }
    expect(toolLabel({ ...read, state: 'running' })).toEqual({ verb: '读取', object: 'app.ts', mono: false })
    expect(toolLabel({ ...read, state: 'completed' })).toEqual({ verb: '读取', object: 'app.ts', mono: false })
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
      toolLabel({ toolName: 'edit', state: 'completed', tool: { kind: 'edit', title: 'Edit a.txt', locations: ['/w/a.txt'] } }),
    ).toEqual({
      verb: '编辑',
      object: 'a.txt',
      mono: false,
    })
  })

  it('names a file edit by what it does to the file', () => {
    const edit = (diffs: FileDiff[]) => toolLabel({ toolName: 'write_file', state: 'completed', tool: { kind: 'edit', diffs } })
    expect(edit([{ path: 'src/a.ts', oldText: 'x\n', newText: 'y\n' }])).toEqual({ verb: '编辑', object: 'a.ts', mono: false })
    expect(edit([{ path: 'src/new.ts', oldText: '', previous: 'none', newText: 'a\nb\nc\n' }])).toEqual({
      verb: '新建',
      object: 'new.ts · 3 行',
      mono: false,
    })
    // A missing previous text alone never proves the file is new.
    expect(edit([{ path: 'src/a.ts', newText: 'y\n' }]).verb).toBe('编辑')
    expect(
      edit([
        { path: 'a', newText: '' },
        { path: 'b', newText: '' },
      ]),
    ).toEqual({ verb: '编辑', object: '2 个文件', mono: false })
    expect(diffStat({ diffs: [{ path: 'a', oldText: 'x\n', newText: 'y\nz\n' }] })).toEqual({ add: 2, del: 1 })
    expect(diffStat({})).toBeUndefined()
  })

  it('names a tool that declares a title by that title and its object, and an untitled one by its raw name in mono', () => {
    const write = {
      toolName: 'write_file',
      tool: { kind: 'edit' as const, toolTitle: '写入文件', title: 'write_file', input: '{"path":"notes/plan.md"}' },
    }
    expect(toolLabel({ ...write, state: 'completed' })).toEqual({ verb: '写入文件', object: 'plan.md', mono: false })
    expect(toolLabel({ ...write, state: 'running' })).toEqual({ verb: '写入文件', object: 'plan.md', mono: false })
    expect(toolHeading(write.tool, write.toolName)).toBe('写入文件 notes/plan.md')
    // Listing the workspace root names no object; a tool without arguments is its title alone.
    const list = {
      toolName: 'list_files',
      state: 'completed' as const,
      tool: { kind: 'search' as const, toolTitle: '列出文件', input: '{"path":"."}' },
    }
    expect(toolLabel(list)).toEqual({ object: '列出文件', mono: false })
    expect(toolHeading({ toolTitle: '运行长任务', input: '{}' }, 'long_task')).toBe('运行长任务')
    // A plugin tool without a title is not guessed at: its identifier, in mono.
    expect(toolLabel({ toolName: 'send_mail', state: 'completed', tool: { title: 'send_mail', input: '{"to":"a"}' } })).toEqual({
      object: 'send_mail',
      mono: true,
    })
    expect(toolHeading({ title: 'send_mail' }, 'send_mail')).toBe('send_mail')
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
    // A call asked about and never started: from its record to its end is the wait for a person, not run time.
    const asked = { createdAt: at(0), completedAt: at(4200) }
    const rejected = { outcome: 'rejected' as const, at: at(4200) }
    expect(toolDuration(tool('t', { ...asked, state: 'failed', tool: { decision: rejected } }), T0)).toBeUndefined()
    expect(toolDuration(tool('t', { ...asked, tool: { decision: { outcome: 'allowed', at: at(4000) } } }), T0)).toBeUndefined()
    expect(toolDuration(tool('t', { ...asked, state: 'failed', text: 'APPROVAL_REJECTED: 用户拒绝了本次工具调用。' }), T0)).toBeUndefined()
    expect(
      toolDuration(tool('t', { ...asked, startedAt: at(4000), tool: { decision: { outcome: 'allowed', at: at(4000) } } }), T0),
    ).toEqual({ ms: 200, live: false })
  })
})

describe("a turn's blocks and its fold", () => {
  const messages = [
    user('u', { turn: { activeMs: 133_000 } }),
    reply('a1', '先看看接口。', { reasoning: '想', reasoningMs: 6000 }),
    tool('tool:read', { tool: { kind: 'read' }, createdAt: at(0), startedAt: at(0), completedAt: at(2400) }),
    reply('a2', '找到原因了。'),
    tool('tool:write', { tool: { kind: 'edit', diffs: [{ path: 'a.ts', newText: 'x' }] } }),
    reply('a3', '已修复。'),
  ]
  const shape = (blocks: TurnBlock[]) =>
    blocks.map(block =>
      block.kind === 'work'
        ? block.items.map(item =>
            item.kind === 'reads'
              ? `reads:${item.messages.length}`
              : item.kind === 'steps'
                ? `steps:${item.count}`
                : `${item.kind}:${item.message.id}`,
          )
        : block.message.id,
    )

  it("keeps prose in reading order between the work, a block's reasoning before its prose", () => {
    expect(shape(turnBlocks(firstTurn(messages)))).toEqual([['thinking:a1'], 'a1', ['tool:tool:read'], 'a2', ['tool:tool:write'], 'a3'])
  })

  it('folds a turn that finished, worked and answered; never a failed or stopped one, or one that ended without a word', () => {
    const turn = firstTurn(messages)
    expect(workFolds(turn, 'completed')).toBe(true)
    for (const outcome of ['failed', 'stopped', 'interrupted'] as const) expect(workFolds(turn, outcome)).toBe(false)
    expect(workFolds(turn, undefined)).toBe(false)
    expect(workFolds(firstTurn([user('u'), reply('a', '只是回答。')]), 'completed')).toBe(false)
    expect(workFolds(firstTurn([user('u'), tool('t', { tool: { kind: 'read' } })]), 'completed')).toBe(false)
  })

  it('says how long the turn worked, and any failure the fold would hide', () => {
    expect(foldWords(firstTurn(messages))).toBe('已工作 2 分 13 秒')
    expect(foldWords(firstTurn([user('u'), tool('t', { tool: { kind: 'read' } })]))).toBe('已工作')
    expect(foldWords(firstTurn([user('u', { turn: { activeMs: 5000 } }), tool('t', { state: 'failed', text: 'x' })]))).toBe(
      '已工作 5 秒 · 1 步失败',
    )
    // A Harness's own model stopping a request is its verdict, not a failed step, and the fold does not hide it.
    const review = (id: string, outcome: 'approved' | 'denied', state: 'completed' | 'failed') =>
      tool(id, { state, text: 'x', tool: { kind: 'think', judged: { by: 'Codex', outcome } } })
    expect(foldWords(firstTurn([user('u'), review('r1', 'approved', 'completed'), review('r2', 'denied', 'failed')]))).toBe(
      '已工作 · 模型拦下 1 次',
    )
    // Inside a subagent, and a subagent it started, a verdict is just as unasked.
    const subagent = (id: string, steps: Message[]) => tool(id, { text: 'x', subagent: { title: id, status: 'done', steps } })
    expect(
      foldWords(
        firstTurn([
          user('u'),
          subagent('review', [review('s1', 'denied', 'failed'), subagent('inner', [review('s2', 'denied', 'failed')])]),
          review('r1', 'denied', 'failed'),
        ]),
      ),
    ).toBe('已工作 · 模型拦下 3 次')
    // A call the Harness refused itself before it ran is no failed step either; its model's and its rules' are named.
    const blocked = (id: string, source: 'model' | 'rule', judged?: 'denied') =>
      tool(id, {
        state: 'failed',
        text: 'x',
        tool: {
          kind: 'execute',
          blocked: { by: 'Claude Agent', source },
          ...(judged ? { judged: { by: 'Claude Agent', outcome: judged } } : {}),
        },
      })
    expect(
      foldWords(
        firstTurn([
          user('u'),
          blocked('b1', 'model', 'denied'),
          blocked('b2', 'model'),
          blocked('b3', 'rule'),
          subagent('inner', [blocked('s1', 'rule')]),
        ]),
      ),
    ).toBe('已工作 · 模型拦下 2 次 · 规则拦下 2 次')
  })

  it('takes a call the Harness refused before it ran as one that changed nothing and took no time', () => {
    const refused = tool('b', {
      state: 'failed',
      text: 'x',
      createdAt: '2026-11-07T10:00:00.000Z',
      completedAt: '2026-11-07T10:00:03.000Z',
      tool: { kind: 'edit', blocked: { by: 'Claude Agent', source: 'rule' }, diffs: [{ path: 'a.ts', newText: 'y\n' }] },
    })
    expect(shownToolState(refused)).toBe('blocked')
    expect(appliedDiffs(refused)).toEqual([])
    expect(toolDuration(refused, Date.parse('2026-11-07T10:00:05.000Z'))).toBeUndefined()
    expect(sideEffects(firstTurn([user('u'), refused]))).toEqual({ edits: 0, commands: 0, others: 0, unknown: 0 })
    // A row that only says it failed is still a failure.
    expect(shownToolState(tool('f', { state: 'failed', text: 'x', tool: { kind: 'edit' } }))).toBe('failed')
  })

  it('joins three or more consecutive finished quiet steps into one row, in a running turn as in a settled one', () => {
    const read = (id: string, extra: Partial<Message> = {}) => tool(id, { tool: { kind: 'read' }, ...extra })
    const turn = (...replies: Message[]) => turnBlocks(firstTurn([user('u'), ...replies]))
    expect(shape(turn(read('r1'), read('r2'), tool('e', { tool: { kind: 'edit' } })))).toEqual([['tool:r1', 'tool:r2', 'tool:e']])
    expect(shape(turn(read('r1'), read('r2'), tool('s', { tool: { kind: 'search' } }), tool('e', { tool: { kind: 'edit' } })))).toEqual([
      ['reads:3', 'tool:e'],
    ])
    // The step still running stays out, and joins once it finishes.
    expect(shape(turn(read('r1'), read('r2'), read('r3'), read('r4', { state: 'running' })))).toEqual([['reads:3', 'tool:r4']])
    expect(shape(turn(read('r1'), read('r2'), read('r3'), read('r4')))).toEqual([['reads:4']])
    // A failed step in the middle keeps both sides apart; neither side reaches three.
    expect(shape(turn(read('r1'), read('r2'), read('f', { state: 'failed', text: 'x' }), read('r3'), read('r4')))).toEqual([
      ['tool:r1', 'tool:r2', 'tool:f', 'tool:r3', 'tool:r4'],
    ])
    // Commands, edits, decided, refused, interrupted and unknown steps, and steps with pictures never join.
    const never = [
      tool('c', { tool: { kind: 'execute', input: '{"command":"ls"}' } }),
      tool('d', { tool: { kind: 'read', decision: { outcome: 'allowed', at: at(0) } } }),
      tool('b', { tool: { kind: 'read', judged: { by: 'Codex', outcome: 'unasked' } } }),
      tool('i', { tool: { kind: 'read' }, state: 'failed', interrupted: true }),
      tool('p', {
        tool: { kind: 'read' },
        attachments: [{ id: 'a', name: 'shot.png', mime: 'image/png', kind: 'image', size: 1, sha256: 'x' }],
      }),
    ]
    for (const step of never)
      expect(shape(turn(read('r1'), read('r2'), step, read('r3')))).toEqual([['tool:r1', 'tool:r2', `tool:${step.id}`, 'tool:r3']])
    // A command its Harness classified joins as what it does; one it did not classify does not.
    const acted = (id: string, actions: NonNullable<Message['tool']>['actions'], command = 'x') =>
      tool(id, { tool: { kind: 'execute', input: JSON.stringify({ command }), ...(actions ? { actions } : {}) } })
    const mixed = [
      acted('a1', [{ kind: 'read', path: 'a' }]),
      acted('a2', [{ kind: 'list', path: 'docs' }]),
      acted('a3', [
        { kind: 'read', path: 'b' },
        { kind: 'search', query: 'x' },
      ]),
      read('r'),
    ]
    expect(shape(turn(...mixed, acted('u', undefined)))).toEqual([['reads:4', 'tool:u']])
    // The words count what the steps themselves say, nothing else.
    expect(quietGroupWords(mixed)).toBe('读取 3 个文件，列出 1 个文件夹，搜索 1 次')
    expect(quietGroupWords([read('r1'), read('r2'), read('r3')])).toBe('读取 3 个文件')
    // A classified command that pipes, chains or redirects is a command: never a quiet step, never in a group, and at
    // 只留失败 it is hidden or shown exactly as a command is.
    const piped = acted('p', [{ kind: 'read', path: 'list' }], 'cat list | xargs rm')
    expect(shape(turn(read('r1'), read('r2'), piped, read('r3')))).toEqual([['tool:r1', 'tool:r2', 'tool:p', 'tool:r3']])
    expect(toolLabel(piped)).toEqual({ verb: '运行', object: 'cat list | xargs rm', mono: true })
    expect(alwaysShown(piped)).toBe(false)
    expect(alwaysShown({ ...piped, state: 'failed', text: 'x' })).toBe(true)
    // The numbers come from the box itself.
    expect(linesBelow({ scrollHeight: 1000, clientHeight: 320, scrollTop: 0 }, 18)).toBe(38)
    expect(linesBelow({ scrollHeight: 1000, clientHeight: 320, scrollTop: 680 }, 18)).toBe(0)
    expect(linesBelow({ scrollHeight: 320, clientHeight: 320, scrollTop: 0 }, 18)).toBe(0)
    expect(linesBelow({ scrollHeight: 330, clientHeight: 320, scrollTop: 0 }, 18)).toBe(1)
    expect(linesBelow({ scrollHeight: 1000, clientHeight: 320, scrollTop: 0 }, Number.NaN)).toBe(0)
  })

  it('leaves every row, only what always shows, or those with the rest folded, by the level the reader chose', () => {
    const read = (id: string, extra: Partial<Message> = {}) => tool(id, { tool: { kind: 'read' }, ...extra })
    const replies = [
      reply('a1', '', { reasoning: '想' }),
      read('r1'),
      read('r2'),
      read('r3'),
      tool('f', { state: 'failed', text: 'boom', tool: { kind: 'execute', input: '{"command":"x"}' } }),
      tool('e', { tool: { kind: 'edit', diffs: [{ path: 'a.ts', newText: 'x' }] } }),
      tool('w', { state: 'awaiting-approval', tool: { kind: 'execute', input: '{"command":"y"}' } }),
      tool('run', { state: 'running', tool: { kind: 'execute', input: '{"command":"z"}' } }),
      reply('a2', '说明'),
      read('r4'),
      tool('q', { toolName: 'ask_user' }),
      { id: 'n', role: 'system', state: 'failed', text: '模型服务出错' } satisfies Message,
    ]
    const turn = firstTurn([user('u'), ...replies])
    expect(shape(turnBlocks(turn, 'all'))).toEqual([
      ['thinking:a1', 'reads:3', 'tool:f', 'tool:e', 'tool:w', 'tool:run'],
      'a2',
      ['tool:r4'],
      'q',
      'n',
    ])
    // Only what went wrong or waits; a block with nothing left is gone. Prose, questions and failure notes are untouched.
    expect(shape(turnBlocks(turn, 'failures'))).toEqual([['tool:f', 'tool:w'], 'a2', 'q', 'n'])
    // The rest folded between the rows that always show, counted by the steps it holds.
    // Thoughts are no steps: the first fold holds a thought and three reads.
    expect(shape(turnBlocks(turn, 'folded'))).toEqual([['steps:3', 'tool:f', 'steps:1', 'tool:w', 'steps:1'], 'a2', ['steps:1'], 'q', 'n'])
    expect(shape(turnBlocks(firstTurn([user('u'), reply('t', '', { reasoning: '想' }), reply('a', '好')]), 'folded'))).toEqual([
      ['steps:0'],
      'a',
    ])
    // The block keeps its key at every level, so a change of level remounts nothing above it.
    for (const level of ['all', 'failures', 'folded'] as const) expect(turnBlocks(turn, level)[0]).toMatchObject({ key: 'work:a1' })
  })

  it('never hides a call that waits, went wrong, has an unknown result or contradicts its approval, nor a subagent that can be stopped', () => {
    const base = { tool: { kind: 'execute' as const, input: '{"command":"x"}' } }
    const shown = [
      tool('a', { ...base, state: 'awaiting-approval' }),
      tool('b', { ...base, state: 'failed', text: 'x' }),
      tool('c', { ...base, state: 'cancelled' }),
      tool('d', { ...base, state: 'failed', interrupted: true }),
      tool('e', { ...base, state: 'failed', text: 'TOOL_OUTCOME_UNKNOWN: 结果未知' }),
      tool('f', { state: 'failed', tool: { ...base.tool, decision: { outcome: 'rejected', at: at(0) } } }),
      tool('g', { state: 'failed', tool: { ...base.tool, blocked: { by: 'Codex', source: 'rule' } } }),
      tool('h', { state: 'completed', startedAt: at(0), tool: { ...base.tool, decision: { outcome: 'rejected', at: at(0) } } }),
      tool('i', { state: 'running', subagent: { title: 'Runner', steps: [], stoppable: true } }),
      tool('j', { state: 'completed', subagent: { title: 'Runner', steps: [tool('s', { ...base, state: 'failed', text: 'x' })] } }),
    ]
    for (const message of shown) expect([message.id, alwaysShown(message)]).toEqual([message.id, true])
    const hidden = [
      tool('k', base),
      tool('l', { ...base, state: 'running' }),
      tool('m', { ...base, state: 'queued' }),
      tool('n', { state: 'completed', subagent: { title: 'Runner', steps: [tool('s', base)], status: 'done' } }),
      tool('o', { state: 'completed', tool: { ...base.tool, decision: { outcome: 'allowed', at: at(0) } } }),
    ]
    for (const message of hidden) expect([message.id, alwaysShown(message)]).toEqual([message.id, false])
  })

  it('keeps a growing group under its first step, so it keeps its place and whether it is open', () => {
    const read = (id: string, extra: Partial<Message> = {}) => tool(id, { tool: { kind: 'read' }, ...extra })
    const key = (...replies: Message[]) => {
      const block = turnBlocks(firstTurn([user('u'), ...replies]))[0]!
      return block.kind === 'work' ? [block.key, block.items[0]!.kind === 'reads' ? block.items[0]!.messages[0]!.id : undefined] : []
    }
    expect(key(read('r1'), read('r2'), read('r3'))).toEqual(['work:r1', 'r1'])
    expect(key(read('r1'), read('r2'), read('r3'), read('r4'), read('r5', { state: 'running' }))).toEqual(['work:r1', 'r1'])
  })

  it("keeps the work block's key from its first row, so rows join it without remounting it", () => {
    const before = turnBlocks(firstTurn([user('u'), tool('t1')]))
    const after = turnBlocks(firstTurn([user('u'), tool('t1'), tool('t2')]))
    expect(before[0]).toMatchObject({ key: 'work:t1' })
    expect(after[0]).toMatchObject({ key: 'work:t1' })
  })

  it('keeps a question out of the fold: it is what the person said', () => {
    const blocks = turnBlocks(firstTurn([user('u'), tool('q', { toolName: 'ask_user' }), tool('t'), reply('a', '好')]))
    expect(shape(blocks)).toEqual(['q', ['tool:t'], 'a'])
    expect(workFolds(firstTurn([user('u'), tool('q', { toolName: 'ask_user' }), reply('a', '好')]), 'completed')).toBe(false)
  })

  it("gives a failed row the first line of what it reported, without the runtime's code, cut", () => {
    expect(failureReason({ state: 'failed', text: 'TOOL_ERROR: 2 个测试没有通过\nFAIL a.ts' })).toBe('2 个测试没有通过')
    // The runtime's code is for the model: the output as shown starts with what the tool said.
    expect(shownToolOutput({ state: 'failed', text: 'TOOL_ERROR: 2 个测试没有通过\nFAIL a.ts' })).toBe('2 个测试没有通过\nFAIL a.ts')
    // History the Host summarises for a device that may not read it joins each fact, code first, after a blank line
    // (apps/host/src/task-content.ts).
    expect(
      shownToolOutput({
        state: 'failed',
        text: 'TOOL_OUTCOME_UNKNOWN: 结果未知，请先核对它做了什么。Latch 不会自动重做。\n\nTOOL_ERROR: 工具报告失败，详细输出未向此设备显示。',
      }),
    ).toBe('结果未知，请先核对它做了什么。Latch 不会自动重做。\n\n工具报告失败，详细输出未向此设备显示。')
    expect(failureReason({ state: 'failed', text: '' })).toBe('没有成功')
    // A call that reported nothing carries its arguments as its text; a line of JSON says nothing about why.
    expect(failureReason({ state: 'failed', text: '{\n  "command": "ls"\n}', tool: { input: '{\n  "command": "ls"\n}' } })).toBe('没有成功')
    expect(failureReason({ state: 'failed', text: 'x'.repeat(200) })).toHaveLength(121)
    // A runner's output passes cases before it names the error; the row says the error, without its colours.
    expect(
      failureReason({
        state: 'failed',
        text: ' \u001b[32m✓\u001b[39m renders\n \u001b[31m×\u001b[39m connects\n   \u001b[31mError: connect ECONNREFUSED\u001b[39m',
      }),
    ).toBe('Error: connect ECONNREFUSED')
    expect(failureReason({ state: 'failed', text: ' ✓ keeps the key\n × clears the key\n   AssertionError: expected kept' })).toBe(
      'AssertionError: expected kept',
    )
  })
})

describe('decided approvals', () => {
  const decision = (outcome: 'allowed' | 'rejected' | 'expired' | 'cancelled') => ({ outcome, at: day(14, 32) })
  const call = (extra: Partial<Message>) => ({ text: '', ...extra })

  it('shows a call its approval kept from running by how the approval ended, and a person’s choice with its time', () => {
    expect(shownToolState(call({ state: 'failed', tool: { decision: decision('rejected') } }))).toBe('rejected')
    expect(shownToolState(call({ state: 'failed', tool: { decision: decision('cancelled') } }))).toBe('cancelled')
    expect(shownToolState(call({ state: 'cancelled', tool: { decision: decision('expired') } }))).toBe('expired')
    expect(shownToolState(call({ state: 'failed', tool: { decision: decision('allowed') } }))).toBe('failed')
    expect(shownToolState(call({ state: 'awaiting-approval', tool: { decision: decision('rejected') } }))).toBe('awaiting-approval')
    const now = new Date(2026, 9, 24, 18).getTime()
    expect(decisionLine({ ...decision('rejected'), via: 'other-device' }, now)).toEqual({
      text: '已拒绝 · 14:32',
      title: '2026年10月24日 周六 14:32:00 · 在其他设备上决定',
      full: '已拒绝 · 2026年10月24日 周六 14:32:00 · 在其他设备上决定',
    })
    expect(decisionLine(decision('allowed'), new Date(2026, 9, 25, 9).getTime()).text).toBe('已允许 · 昨天 14:32')
    expect(decisionLine(decision('cancelled'), now)).toMatchObject({
      text: '已取消（会话停止）',
      title: expect.not.stringContaining('没有执行'),
    })
    expect(decisionLine({ ...decision('cancelled'), subagentStopped: true }, now)).toMatchObject({
      text: '已取消（子 Agent 停止）',
      title: expect.not.stringContaining('还没有人回答'),
    })
    expect(decisionLine(decision('expired'), now).text).toBe('已过期')
    expect(decisionLine({ outcome: 'rejected', at: 'not a time' }, now)).toMatchObject({ text: '已拒绝', title: '已拒绝' })
  })

  it('keeps the state and the changes an agent reports for a call that started or completed after a rejection', () => {
    const diffs = [{ path: 'src/app.ts', newText: 'x\n', previous: 'none' as const }]
    // The agent ran the call anyway (its ask was advisory), or it was allowed once and rejected on a later ask.
    for (const reported of [
      call({ state: 'completed', tool: { kind: 'edit', diffs, decision: decision('rejected') } }),
      call({ state: 'failed', startedAt: day(14, 31), tool: { kind: 'edit', diffs, decision: decision('rejected') } }),
      call({ state: 'completed', tool: { kind: 'edit', diffs, decision: decision('cancelled') } }),
    ]) {
      expect(unrunOutcome(reported)).toBeUndefined()
      expect(shownToolState(reported)).toBe(reported.state)
      expect(appliedDiffs(reported)).toEqual(diffs)
      expect(ranDespite(reported)).toEqual(reported.tool?.decision)
      const effects = sideEffects(firstTurn([user('u'), tool('t', reported)]))
      expect(effects.edits + effects.unknown).toBe(1)
    }
    // A call that settled without starting and was not allowed: its proposed diff is no change.
    const unrun = call({ state: 'failed', tool: { kind: 'edit', diffs, decision: decision('rejected') } })
    expect(appliedDiffs(unrun)).toEqual([])
    expect(ranDespite(unrun)).toBeUndefined()
    // While it waits, or queued, nothing is applied yet.
    expect(appliedDiffs(call({ state: 'awaiting-approval', tool: { diffs } }))).toEqual([])
    expect(appliedDiffs(call({ state: 'queued', tool: { diffs } }))).toEqual([])
  })

  it('reads a rejection recorded before decision records as 已拒绝 and drops its internal code', () => {
    const legacy = call({ state: 'failed', tool: { kind: 'edit', output: 'APPROVAL_REJECTED: 用户拒绝了本次工具调用，未执行该操作。' } })
    expect(shownToolState(legacy)).toBe('rejected')
    expect(shownToolOutput(legacy)).toBe('用户拒绝了本次工具调用，未执行该操作。')
    expect(resendWarning(sideEffects(firstTurn([user('u'), tool('t', legacy)])))).toBeUndefined()
    // Only a failure that starts with the code, and only without a record.
    expect(shownToolState(call({ state: 'failed', text: 'TOOL_ERROR: APPROVAL_REJECTED: x' }))).toBe('failed')
    expect(shownToolState({ ...legacy, tool: { ...legacy.tool, decision: decision('allowed') } })).toBe('failed')
  })
})

describe('resending a turn', () => {
  it('asks first only when a tool that may change something ran, failed, stopped or has an unknown outcome', () => {
    expect(resendWarning(effects('read', 'completed'))).toBeUndefined()
    expect(resendWarning(effects('edit', 'queued'))).toBeUndefined()
    expect(resendWarning(effects('execute', 'cancelled', 'TOOL_NOT_STARTED: …'))).toBeUndefined()
    // A call its approval kept from running (it settled without starting) changed nothing.
    const declined = (outcome: 'rejected' | 'expired' | 'cancelled') =>
      sideEffects(firstTurn([user('u'), tool('t', { state: 'failed', tool: { kind: 'edit', decision: { outcome, at: day(9) } } })]))
    for (const outcome of ['rejected', 'expired', 'cancelled'] as const) expect(resendWarning(declined(outcome))).toBeUndefined()
    expect(resendWarning(effects('edit', 'completed'))).toBe(
      '上一次已经执行了 1 个操作：修改 1 个文件。重新发送后，Harness 可能再次执行它们。',
    )
    expect(resendWarning(effects('execute', 'failed'))).toBe(
      '上一次已经执行了 1 个操作：运行 1 条命令。重新发送后，Harness 可能再次执行它们。',
    )
    expect(resendWarning(effects(undefined, 'completed'))).toContain('调用 1 次其他工具')
    expect(resendWarning(effects('execute', 'running'))).toBe(
      '上一次有 1 个操作结果未知，可能已经执行。重新发送后，Harness 可能再次执行它们。',
    )
    expect(resendWarning(effects('other', 'failed', 'TOOL_OUTCOME_UNKNOWN: …'))).toContain('结果未知')
  })

  it('offers 重试 on the latest turn only, and sends its prompt again', () => {
    const sent: string[] = []
    const render = (status: TaskStatus) =>
      renderToStaticMarkup(
        createElement(Transcript, {
          detail: detail([user('u1'), reply('a1', '好'), user('u2'), reply('a2', '部分', { state: 'failed' })], {}, status),
          approvals: [],
          harnessName: 'Latch',
          retry: { onResend: prompt => sent.push(prompt) },
        }),
      )
    expect(render('failed').match(/aria-label="重试"/g)).toHaveLength(1)
    expect(render('idle').match(/aria-label="重试"/g)).toHaveLength(1)
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
    expect(phase({}, { approvals: 1 })).toBe('等你处理')
    expect(
      phase({ messages: [user('u'), tool('t', { state: 'running', tool: { kind: 'execute', input: '{"command":"pnpm test"}' } })] }),
    ).toBe('运行 pnpm test')
    // A tool without a kind Latch reads says 正在执行 with its title; so does the driver's own phase.
    expect(phase({ messages: [user('u'), tool('t', { state: 'running', toolName: 'mcp_lookup' })] })).toBe('正在执行 mcp_lookup')
    expect(phase({ activity: { phase: 'tool', toolName: 'lookup' } })).toBe('正在执行 lookup')
    expect(phase({ liveText: '好' })).toBe('正在回复')
    expect(phase({ liveReasoning: '想' })).toBe('正在思考')
    expect(phase({ activity: { phase: 'starting', since: at(5000) } })).toBe('正在启动 Codex…')
    expect(phase({ activity: { phase: 'starting', since: at(0) } })).toBe('Codex 启动较慢…')
    expect(phase({ activity: { phase: 'model' } })).toBe('等待模型…')
  })

  it('names what really runs, with one clock, and stays silent while the person is the one awaited', () => {
    const live = (extra: Partial<RunLive>): RunLive => ({ runId: 'r', activity: 'model', since: at(0), lastEventAt: at(0), ...extra })
    const status = (
      extra: Partial<TaskDetail>,
      summary: Partial<TaskSummary> = {},
      opts: { approvals?: number; cancelling?: boolean } = {},
    ) => {
      const base = detail([user('u')], { runStartedAt: at(0), ...extra }, 'running')
      return runStatus(
        { ...base, summary: { ...base.summary, ...summary } },
        { cancelling: false, approvals: 0, hostNow: T0 + 72_000, harness: 'Codex', ...opts },
      )
    }
    // `inHeader`: the title row says running and stopping once, so the line under the turn draws neither.
    expect(status({}, { live: live({}) })).toEqual({ tone: 'plain', text: '运行中', clock: '1:12', inHeader: true })
    expect(status({}, { live: live({ activity: 'command', commandName: 'swift test' }) })).toEqual({
      tone: 'plain',
      text: '命令运行中 · swift test',
      clock: '1:12',
      inHeader: true,
    })
    expect(status({}, { live: live({ activity: 'approval' }) }, { approvals: 1 })).toEqual({ tone: 'quiet', text: '等你处理' })
    expect(status({ questions: [{}] as unknown as TaskDetail['questions'] }).tone).toBe('quiet')
    expect(status({}, {}, { cancelling: true })).toEqual({ tone: 'plain', text: '正在停止…', inHeader: true })
    expect(status({ activity: { phase: 'starting', since: at(71_000) } })).toEqual({ tone: 'plain', text: '正在启动 Codex…' })
  })

  it('asks when a run has gone quiet, in the words of what it waits on, and only then', () => {
    const base = detail([user('u')], { runStartedAt: at(0) }, 'running')
    const quiet = (live: RunLive, now: number) =>
      runStatus({ ...base, summary: { ...base.summary, live } }, { cancelling: false, approvals: 0, hostNow: T0 + now, harness: 'Codex' })
    const model = quiet(
      { runId: 'r', activity: 'model', since: at(0), lastEventAt: at(0), silent: true, silenceThresholdMs: 120_000 },
      180_000,
    )
    expect(model).toMatchObject({ tone: 'amber', text: '等模型回应 · 3 分钟没有新内容', actions: ['keep-waiting', 'stop'] })
    const command = quiet(
      {
        runId: 'r',
        activity: 'command',
        commandName: 'pnpm test',
        since: at(0),
        lastEventAt: at(0),
        silent: true,
        silenceThresholdMs: 600_000,
      },
      720_000,
    )
    expect(command).toMatchObject({ tone: 'amber', text: 'pnpm test · 12 分钟没有输出' })
    const unknown = quiet(
      {
        runId: 'r',
        activity: 'model',
        since: at(0),
        lastEventAt: at(1000),
        unrecognized: { count: 1, at: at(1000), method: 'terminal/create', messageId: 'n1' },
      },
      5000,
    )
    expect(unknown).toEqual({ tone: 'amber', text: 'Codex 发来不支持的请求 terminal/create', actions: ['stop'], viewMessageId: 'n1' })
    // The engine went on after the request it did not get an answer to: nothing is stuck on it.
    const wentOn = quiet(
      { runId: 'r', activity: 'model', since: at(0), lastEventAt: at(2000), unrecognized: { count: 1, at: at(1000) } },
      5000,
    )
    expect(wentOn.tone).toBe('plain')
    // An older Host has no such field: its last output is all there is to go on.
    const older = (now: number) =>
      runStatus(detail([user('u')], { lastOutputAt: at(0) }, 'running'), {
        cancelling: false,
        approvals: 0,
        hostNow: T0 + now,
        harness: 'Codex',
      })
    expect(older(119_000).tone).toBe('plain')
    expect(older(121_000)).toMatchObject({ tone: 'amber', text: '2 分钟没有新输出' })
  })

  it('keeps one clock format', () => {
    expect(runClock(47_000)).toBe('0:47')
    expect(runClock(72_000)).toBe('1:12')
    expect(runClock(3_723_000)).toBe('1:02:03')
  })

  it('says how a run ended when it took more than an answer, naming what nobody can vouch for', () => {
    const summary = (runEnd: TaskSummary['runEnd']): TaskSummary => ({
      harnessId: 'standard',
      id: 's',
      title: 't',
      status: 'failed',
      updatedAt: '',
      ...(runEnd ? { runEnd } : {}),
    })
    expect(runEndLine(summary(undefined), 'Codex')).toBeUndefined()
    expect(
      runEndLine(summary({ reason: 'process-exited', at: at(0), unknownResults: [{ messageId: 'm', name: 'pnpm test' }] }), 'Codex'),
    ).toEqual({
      tone: 'red',
      text: 'Codex 已退出 · 这一轮没有完成 · 这 1 条命令结果未知，请核对',
      unknown: ['pnpm test'],
      retry: true,
      check: false,
    })
    expect(runEndLine(summary({ reason: 'forced-stop', at: at(0), unknownResultCount: 2 }), 'Codex')).toEqual({
      tone: 'amber',
      text: '已强制停止 · 这 2 条命令结果未知，请核对',
      unknown: [],
      retry: false,
      check: false,
    })
    expect(runEndLine(summary({ reason: 'turn-ended', at: at(0) }), 'Codex')).toBeUndefined()
    // The Host's stop is nobody's cancel: it says so, offers 重试, and claims nothing about the calls it cut off.
    expect(runEndLine(summary({ reason: 'host-stopped', at: at(0), unknownResults: [{ messageId: 'm', name: 'make' }] }), 'Codex')).toEqual(
      {
        tone: 'amber',
        text: 'Latch 重启时中断 · 这 1 条命令结果未知，请核对',
        unknown: ['make'],
        retry: true,
        check: false,
      },
    )
    // Refused for want of a login: amber until the Harness itself says it is logged in, then 已登录 with 重试 alone. The
    // record of the run does not change, and no other ending is ever read as resolved.
    const refused = summary({ reason: 'login-required', at: at(0) })
    expect(runEndLine(refused, 'Codex')).toEqual({
      tone: 'amber',
      text: 'Codex 还没登录 · 登录后重试',
      unknown: [],
      retry: true,
      check: false,
    })
    expect(runEndLine(refused, 'Codex', undefined, true)).toEqual({ tone: 'plain', text: '已登录', unknown: [], retry: true, check: false })
    expect(runEndLine(summary({ reason: 'process-exited', at: at(0) }), 'Codex', undefined, true)).toMatchObject({ tone: 'red' })
    // A call whose own row is in the turn already says 结果未知 there: the note counts it and does not list it again.
    const stopped = summary({ reason: 'host-stopped', at: at(0), unknownResults: [{ messageId: 'm', name: '运行长任务' }] })
    expect(runEndLine(stopped, 'Codex', new Set(['m']))).toMatchObject({
      text: 'Latch 重启时中断 · 这 1 条命令结果未知，请核对',
      unknown: [],
    })
  })

  it('offers 已核对 only while the Host holds the session for unknown results, and says so once it no longer does', () => {
    const ended = (board: TaskSummary['board'], runEnd: TaskSummary['runEnd'], status: TaskSummary['status'] = 'failed'): TaskSummary => ({
      harnessId: 'standard',
      id: 's',
      title: 't',
      status,
      updatedAt: '',
      ...(runEnd ? { runEnd } : {}),
      ...(board ? { board } : {}),
    })
    const cut = { reason: 'host-stopped' as const, at: at(0), unknownResultCount: 2 }
    const waiting = ended({ group: 'attention', reason: 'unknown', settle: 'run-1', card: true }, cut)
    expect(runEndLine(waiting, 'Codex')).toMatchObject({ text: 'Latch 重启时中断 · 这 2 条命令结果未知，请核对', check: true })
    // Checked: the failure may still hold it, but no longer for these results.
    const checked = ended({ group: 'attention', reason: 'failed', settle: 'run-1', card: true }, cut)
    expect(runEndLine(checked, 'Codex')).toMatchObject({ text: 'Latch 重启时中断 · 这 2 条命令结果未知 · 已核对', check: false })
    expect(runEndLine(ended({ group: 'done', settle: 'run-1' }, cut, 'idle'), 'Codex')).toMatchObject({ check: false })
    // Nothing unknown, or a Host that groups nothing: no button, and the words of before.
    expect(
      runEndLine(ended({ group: 'attention', reason: 'failed', settle: 'run-1' }, { reason: 'process-exited', at: at(0) }), 'Codex'),
    ).toMatchObject({ check: false })
    expect(runEndLine(ended(undefined, cut), 'Codex')).toMatchObject({
      text: 'Latch 重启时中断 · 这 2 条命令结果未知，请核对',
      check: false,
    })
  })

  it("reads a call the Host's stop cut off as interrupted, and one with no reported result as unknown, never as failed", () => {
    const unknown = 'TOOL_OUTCOME_UNKNOWN: 结果未知，请先核对它做了什么。'
    expect(shownToolState(tool('a', { state: 'failed', text: unknown, interrupted: true }))).toBe('interrupted')
    expect(shownToolState(tool('b', { state: 'cancelled', text: 'TOOL_NOT_STARTED: x', interrupted: true }))).toBe('interrupted')
    expect(shownToolState(tool('c', { state: 'failed', text: unknown }))).toBe('unknown')
    expect(shownToolState(tool('d', { state: 'failed', text: 'TOOL_ERROR: boom' }))).toBe('failed')
    // An earlier turn the Host's stop cut off reads as interrupted, not as stopped by someone.
    const turn = firstTurn([user('u'), reply('r', '一半', { state: 'cancelled', interrupted: true })])
    expect(turnOutcome(turn, undefined)).toBe('interrupted')
    expect(sideEffects(turn)).toMatchObject({ unknown: 0 })
    const cut = firstTurn([user('u'), tool('t', { state: 'failed', text: unknown, interrupted: true, tool: { kind: 'execute' } })])
    expect(sideEffects(cut)).toMatchObject({ unknown: 1 })
    expect(resendWarning(sideEffects(cut))).toContain('结果未知')
  })

  it('follows the prompt until the agent answers', () => {
    const turn = firstTurn([user('u')])
    const running = (activity: RunLive['activity'] | undefined, extra: Partial<TaskDetail> = {}) => {
      const base = detail([user('u')], extra, 'running')
      return {
        ...base,
        summary: { ...base.summary, ...(activity ? { live: { runId: 'r', activity, since: at(0), lastEventAt: at(0) } } : {}) },
      }
    }
    expect(deliveryWords(running('starting'), turn)).toBe('Mac 已收到')
    expect(deliveryWords(running('model'), turn)).toBe('Harness 已开始')
    expect(deliveryWords(running('model', { liveText: '好' }), turn)).toBeUndefined()
    expect(deliveryWords(running(undefined), turn)).toBeUndefined()
    expect(deliveryWords(running('model'), firstTurn([user('u'), reply('a', '好')]))).toBeUndefined()
    // A turn that only runs tools says nothing more under the prompt once its first row shows.
    expect(
      deliveryWords(running('model'), firstTurn([user('u'), tool('t', { state: 'running', tool: { kind: 'execute' } })])),
    ).toBeUndefined()
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
      harnessName: 'Latch',
    }),
  )

/** A transcript whose latest turn streams its first words, in a session that uses fixture-large. */
const streamingTranscript = (status: TaskStatus) =>
  renderToStaticMarkup(
    createElement(Transcript, {
      detail: {
        ...detail([user('u')], { liveText: '正在写', liveMessageId: 'live' }, status),
        summary: { harnessId: 'standard', id: 's', title: 't', status, updatedAt: '', model: 'fixture-large', providerId: 'fixture' },
      },
      approvals: [],
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
        harnessName: 'Latch',
      }),
    )
    const footer = html.slice(html.indexOf('class="turn-footer'))
    expect(footer).toContain(`<time dateTime="${iso(14, 32, 37)}"`)
    expect(footer).not.toContain(`<time dateTime="${iso(14, 31, 5)}"`)
    expect(footer).toContain('14:32:37 完成 · 用时 1 分 12 秒（不含等待批准 20 秒）')
    expect(footer).not.toMatch(/class="turn-fact"[^>]*>用时/)
  })

  it('marks its working time for a phone to leave out when the fold above says it', () => {
    const at = { createdAt: iso(14, 31, 5), turn: { endedAt: iso(14, 32, 37), activeMs: 72_000 } }
    const worked = settledTranscript([user('u', at), tool('t'), reply('a', '好')], 'idle')
    expect(worked).toContain('已工作 1 分 12 秒')
    expect(worked).toContain('<span class="turn-fact turn-fact-worked">1 分 12 秒</span>')
    const plain = settledTranscript([user('u', at), reply('a', '好')], 'idle')
    expect(plain).toContain('<span class="turn-fact">1 分 12 秒</span>')
  })

  it('writes the outcome from what the turn kept', () => {
    const kept = settledTranscript([user('u'), reply('a', '部分', { state: 'cancelled' })], 'cancelled')
    expect(kept).toMatch(/class="turn-record outcome-stopped"><span>已停止 · .*保留了部分回复<\/span>/u)
    const nothing = settledTranscript([user('u'), tool('t', { state: 'cancelled' })], 'cancelled')
    expect(nothing).toContain('已停止')
    expect(nothing).not.toContain('保留了部分')
  })

  it('shows what a turn sent through Latch: the model that answered, its tokens, and the chosen model when another answered', () => {
    const routed = (routed: NonNullable<NonNullable<Message['turn']>['routed']>) => [
      user('u', { turn: { endedAt: iso(14, 32, 37), routed } }),
      reply('a', '好', { model: 'Fake Model' }),
    ]
    const same = renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail(
          routed({
            requests: 3,
            chosen: 'gpt-x',
            models: [
              {
                model: 'gpt-x',
                used: 'gpt-x-2026-01-01',
                requests: 2,
                measured: 2,
                usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800 },
              },
              { model: 'gpt-mini', requests: 1, failed: 1 },
            ],
          }),
        ),
        approvals: [],
        harnessName: 'Codex',
      }),
    )
    // A dated version of the chosen model is the same model: the author line keeps the Harness's own name for it.
    expect(same).toContain('<span class="assistant-meta-model">Fake Model</span>')
    expect(same).not.toContain('选的是')
    const footer = same.slice(same.indexOf('class="turn-footer'))
    expect(footer).toContain('输入 1.2k')
    expect(footer).toContain('输出 300')
    expect(footer).not.toContain('输入 1,200 tokens（缓存读取 800）')
    expect(footer).not.toContain('由模型服务在回复里报告，Latch 转发时读取')
    // Requests by model remain reachable on demand without repeating token totals on hover.
    expect(footer).toContain('aria-label="请求记录"')
    expect(footer).toContain('这一轮经 Latch 3 次请求')
    expect(footer).not.toMatch(/class="turn-fact"[^>]*>经 Latch/u)
    expect(footer).toContain('gpt-x：2 次 · 输入 1.2k tokens · 输出 300 tokens')
    expect(footer).toContain('gpt-mini：1 次，1 次没有完成')

    const other = renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail(
          routed({
            requests: 2,
            chosen: 'gpt-x',
            models: [{ model: 'gpt-x', used: 'gpt-y', requests: 2, measured: 1, usage: { inputTokens: 10, outputTokens: 5 } }],
          }),
        ),
        approvals: [],
        harnessName: 'Codex',
      }),
    )
    expect(other).toContain('<span class="assistant-meta-model">gpt-y</span>')
    expect(other).toContain('选的是 gpt-x')
    expect(other).toContain('选的是 gpt-x，模型服务说这一轮用的是 gpt-y')
    // A turn that never asked for the chosen model, from a service that named none: only what the Harness asked for.
    const asked = renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail(routed({ requests: 1, chosen: 'gpt-x', models: [{ model: 'gpt-mini', requests: 1 }] })),
        approvals: [],
        harnessName: 'Codex',
      }),
    )
    expect(asked).toContain('<span class="assistant-meta-model">gpt-mini</span>')
    expect(asked).toContain('选的是 gpt-x，这一轮 Harness 请求的是 gpt-mini，模型服务没有说用的是哪个')
    expect(asked).not.toContain('模型服务说这一轮用的是')
    expect(other).toContain('另有 1 次回复没有报告用量，没有计入')
    expect(other).toContain('gpt-x：2 次，服务说用的是 gpt-y')
    // A request still under way when the turn ended is not a reply that reported no tokens.
    const open = renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail(
          routed({
            requests: 2,
            chosen: 'gpt-x',
            models: [{ model: 'gpt-x', requests: 2, measured: 1, open: 1, usage: { inputTokens: 10, outputTokens: 5 } }],
          }),
        ),
        approvals: [],
        harnessName: 'Codex',
      }),
    )
    expect(open).toContain('另有 1 次请求在这一轮结束时还在进行，没有计入')
    expect(open).not.toContain('没有报告用量')
    expect(open).toContain('gpt-x：2 次，1 次在这一轮结束时还在进行')
    // With no tokens to show, the requests are a fact of their own.
    const failed = renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail(routed({ requests: 1, chosen: 'gpt-x', models: [{ model: 'gpt-x', requests: 1, failed: 1 }] })),
        approvals: [],
        harnessName: 'Codex',
      }),
    )
    expect(failed).toMatch(/class="turn-fact"[^>]*>经 Latch 1 次请求/u)
    expect(failed).toContain('gpt-x：1 次，1 次没有完成')
    expect(failed).not.toContain('输入')
    // A turn with no record from Latch shows none of it.
    expect(settledTranscript([user('u'), reply('a', '好', { model: 'Fake Model' })], 'idle')).not.toContain('经 Latch')
  })

  it('names the model of a running turn from the run before its first step records one', () => {
    expect(streamingTranscript('running')).toContain('<span class="assistant-meta-model">fixture-large</span>')
    // A settled turn names only the model its steps recorded: here, just the engine.
    expect(streamingTranscript('idle')).not.toContain('fixture-large')
  })
})

describe('stable turns', () => {
  const parse = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const turns: Turn[] = [
    {
      key: 'a',
      user: { id: 'a', role: 'user', text: '一' },
      replies: [{ id: 'b', role: 'assistant', text: '二', usage: { inputTokens: 1, outputTokens: 2 } }],
    },
    { key: 'c', user: { id: 'c', role: 'user', text: '三' }, replies: [] },
  ]

  it('keeps a turn parsed again as the same object, and takes one that changed in any field', () => {
    const again = stableTurns(turns, parse(turns))
    expect(again[0]).toBe(turns[0])
    expect(again[1]).toBe(turns[1])
    const changed = parse(turns)
    changed[0]!.replies[0]!.usage!.outputTokens = 3
    expect(stableTurns(turns, changed)[0]).toBe(changed[0])
    const added = parse(turns)
    added[1]!.user!.turn = { endedAt: '2026-10-31T00:00:00.000Z' }
    const next = stableTurns(turns, added)
    expect(next[0]).toBe(turns[0])
    expect(next[1]).toBe(added[1])
  })

  it('tells data apart by shape as well as by value', () => {
    expect(sameData({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(sameData([], {})).toBe(false)
    expect(sameData({ a: undefined }, { b: undefined })).toBe(false)
    expect(sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameData(null, {})).toBe(false)
  })

  it('reprojects same-ID history rewrites and future message fields, preserving only equal turns', () => {
    const messages = [user('u1'), reply('a1', 'before'), user('u2')]
    const first = projectTurns(messages)
    const rewritten = projectTurns([messages[0]!, reply('a1', 'after'), messages[2]!], first.turns)
    expect(rewritten.turns[0]).not.toBe(first.turns[0])
    expect(rewritten.turns[0]!.replies[0]!.text).toBe('after')
    expect(rewritten.turns[1]).toBe(first.turns[1])
    const futureMessage = { ...messages[1]!, future: { revision: 2 } }
    const future = projectTurns([messages[0]!, futureMessage, messages[2]!], first.turns)
    expect(future.turns[0]).not.toBe(first.turns[0])
    expect(future.turns[0]!.replies[0]).toHaveProperty('future.revision', 2)
    const inserted = projectTurns([reply('lead', 'earlier'), ...messages], first.turns)
    expect(inserted.turns.map(turn => turn.key)).toEqual(['lead:lead', 'u1', 'u2'])
    expect(inserted.turns[1]).toBe(first.turns[0])
  })

  it('adds only the live tail, preserves steering and never duplicates a committed live ID', () => {
    const messages = [user('u1'), reply('a1', 'past'), user('u2'), user('steer', { steered: true })]
    const projection = projectTurns(messages)
    const tail = liveTurn(projection, detail(messages, { liveMessageId: 'a2', liveText: 'new', liveReasoning: 'thinking' }, 'running'))!
    expect(projection.history.map(turn => turn.key)).toEqual(['u1'])
    expect(tail.replies.map(message => message.id)).toEqual(['steer', 'a2'])
    expect(tail.replies[1]).toMatchObject({ text: 'new', reasoning: 'thinking' })
    expect(projection.turns[1]!.replies).toHaveLength(1)
    expect(liveTurn(projection, detail(messages, { liveMessageId: 'a1', liveText: 'duplicate' }))).toBe(projection.turns[1])
    const empty = projectTurns([])
    expect(liveTurn(empty, detail([], { liveMessageId: 'only', liveText: 'lead' }))).toMatchObject({
      key: 'lead:only',
      replies: [{ id: 'only', text: 'lead' }],
    })
    expect(liveTurn(empty, detail([]))).toBeUndefined()
  })

  it('clears running facts on same-ID settlement and distinguishes an old running row from the current turn', () => {
    const command = tool('tool:old', { state: 'running', tool: { kind: 'execute', input: '{"command":"old-command"}' } })
    const messages = [user('u1'), command, user('u2')]
    const projection = projectTurns(messages)
    expect(projection.messageFacts).toEqual({ running: command, trailing: undefined })
    const current = detail(messages, { liveText: 'answer' }, 'running')
    const opts = { cancelling: false, approvals: 0, hostNow: T0, harness: 'Test', messageFacts: projection.messageFacts }
    expect(livePhase(current, opts)).toEqual({ kind: 'reply' })
    expect(runStatus(current, opts).text).toContain('old-command')
    const settled = projectTurns([messages[0]!, { ...command, state: 'completed' }, messages[2]!], projection.turns)
    expect(settled.messageFacts).toEqual({ running: undefined, trailing: undefined })
    expect(projectTurns([], projection.turns).messageFacts).toEqual({ running: undefined, trailing: undefined })
    const nextMessages = [user('u2'), { ...command, tool: { kind: 'execute' as const, input: '{"command":"new-command"}' } }]
    const regenerated = projectTurns(nextMessages, settled.turns)
    expect(regenerated.messageFacts.trailing).toBe(regenerated.messageFacts.running)
    expect(livePhase(detail(nextMessages), { ...opts, messageFacts: regenerated.messageFacts })).toEqual({
      kind: 'tool',
      text: '运行 new-command',
    })
  })

  it('keeps time, silence, cancellation and new reasoning live while message facts remain stable', () => {
    const messages = [user('u')]
    const messageFacts = projectTurns(messages).messageFacts
    const current = detail(messages, { runStartedAt: at(0) }, 'running')
    const opts = { cancelling: false, approvals: 0, hostNow: T0 + 1_000, harness: 'Test', messageFacts }
    expect(runStatus(current, opts).clock).toBe('0:01')
    expect(runStatus(current, { ...opts, hostNow: T0 + 9_000 }).clock).toBe('0:09')
    expect(livePhase({ ...current, liveReasoning: 'new thought' }, opts)).toEqual({ kind: 'thinking' })
    expect(livePhase({ ...current, liveText: 'answer' }, opts)).toEqual({ kind: 'reply' })
    expect(livePhase(current, { ...opts, approvals: 1 })).toEqual({ kind: 'approval' })
    expect(livePhase(current, { ...opts, cancelling: true })).toEqual({ kind: 'cancelling' })
    const silent = {
      ...current,
      summary: {
        ...current.summary,
        live: { runId: 'new-run', activity: 'model' as const, since: at(0), lastEventAt: at(0), silent: true as const },
      },
    }
    expect(runStatus(silent, { ...opts, hostNow: T0 + 121_000 })).toMatchObject({ tone: 'amber', text: '等模型回应 · 2 分钟没有新内容' })
  })
})

describe('lines between turns', () => {
  it('says where the model or thinking changed, only between values the Host recorded on both sides', () => {
    const turns = turnsOf([
      user('1'),
      reply('a1', 'x', { model: 'small', thinking: 'low' }),
      user('2'),
      reply('a2', 'x', { model: 'small', thinking: 'high' }),
      user('3'),
      user('4'),
      reply('a4', 'x', { model: 'large', thinking: 'high' }),
      user('5'),
      reply('a5', 'x', { model: 'small', thinking: 'Max' }),
      user('6'),
      reply('a6', 'x', { model: 'small' }),
      user('7'),
      reply('a7', 'x', { model: 'other' }),
      user('8'),
      reply('a8', 'x', { model: 'other', thinking: 'low' }),
    ])
    expect([...settingSwitches(turns)]).toEqual([
      ['2', '思考 低 → 高'],
      ['4', '模型 small → large'],
      ['5', 'large · 高 → small · Max'],
      ['7', '模型 small → other'],
    ])
  })

  it('draws a line above the turn that began a new context', () => {
    const html = settledTranscript(
      [user('1'), reply('a1', 'one'), user('2', { freshContext: true }), reply('a2', 'two', { model: 'm' })],
      'idle',
    )
    expect(html.match(/timeline-divider/g)).toHaveLength(1)
    expect(html).toContain('清空了上下文')
    expect(html.indexOf('清空了上下文')).toBeGreaterThan(html.indexOf('one'))
  })
})
