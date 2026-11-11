import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Handoff, HandoffSummary, Message, TaskSummary } from '@latch/protocol'
import { ApiError, ApiTimeoutError } from '../src/core/api.ts'
import {
  awaitsReturn,
  createBody,
  defaultSummary,
  evidenceChoices,
  formProblem,
  initialChips,
  materialsOf,
  namedChips,
  placeByTime,
  quotedSummary,
  retryBody,
  returnBody,
  sessionFiles,
  sessionTargets,
  sessionsAwaitingReturn,
  sha256Hex,
  sourceCrumb,
  statusWords,
  turnAround,
  writeFailure,
  type HandoffForm,
  type MaterialChip,
} from '../src/handoffs/model.ts'

const messages: Message[] = [
  { id: 'u1', role: 'user', text: '比较三家汇率接口', fileRefs: [{ root: 'default', path: 'notes/brief.md' }] },
  { id: 'a1', role: 'assistant', text: '建议：用 ECB。\n每天缓存一次。' },
  {
    id: 't1',
    role: 'tool',
    text: '',
    outputs: [
      { root: 'default', path: 'rates.md', change: 'created' },
      { root: 'default', path: 'old.md', change: 'deleted' },
    ],
  },
  { id: 'u2', role: 'user', text: '再看看费用' },
  { id: 'a2', role: 'assistant', text: '免费。' },
]

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  harnessId: 'standard',
  title: id,
  status: 'idle',
  updatedAt: '2026-11-12T10:00:00.000Z',
  ...extra,
})

const form = (patch: Partial<HandoffForm> = {}): HandoffForm => ({
  target: { kind: 'new-session', projectId: 'notes', harnessId: 'fake', mode: 'agent', worktree: false },
  requirements: '接入每日汇率',
  decisions: [],
  returnScope: 'summary-and-evidence',
  ...patch,
})

describe('handoff materials', () => {
  it('lists the files a session names once, without deleted ones', () => {
    expect(sessionFiles(messages)).toEqual([
      { root: 'default', path: 'notes/brief.md' },
      { root: 'default', path: 'rates.md' },
    ])
  })

  it('finds the turn of a message, from its prompt to the next one', () => {
    expect(turnAround(messages, 'a1').map(message => message.id)).toEqual(['u1', 'a1', 't1'])
    expect(turnAround(messages, 'a2').map(message => message.id)).toEqual(['u2', 'a2'])
    expect(turnAround(messages, 'nope')).toEqual([])
  })

  it('starts with the selected text, the chosen messages and their turns’ files', () => {
    const chips = initialChips(messages, ['a1'], '  用 ECB  ', true)
    expect(chips.map(chip => chip.key)).toEqual(['text:0', 'message:a1', 'file:default\u0000notes/brief.md', 'file:default\u0000rates.md'])
    // Without the full data scope no file is offered; a tool row is not a message to hand over.
    expect(initialChips(messages, ['a1', 't1'], undefined, false).map(chip => chip.kind)).toEqual(['message'])
  })

  it('holds the request back until every message and file is pinned by its hash', () => {
    const chips: MaterialChip[] = [
      { key: 'message:a1', kind: 'message', messageId: 'a1', role: 'assistant', line: '建议' },
      { key: 'text:0', kind: 'text', text: '用 ECB' },
    ]
    expect(materialsOf(chips)).toEqual({ problem: '正在固定材料的版本' })
    chips[0] = { ...chips[0]!, hash: 'a'.repeat(64) } as MaterialChip
    expect(materialsOf(chips)).toEqual({
      materials: [
        { kind: 'message', messageId: 'a1', hash: 'a'.repeat(64) },
        { kind: 'text', text: '用 ECB' },
      ],
    })
    const unreadable: MaterialChip = { key: 'f', kind: 'file', file: { root: 'default', path: 'big.bin' }, problem: '超过 4 MB' }
    expect(materialsOf([unreadable])).toEqual({ problem: '「big.bin」超过 4 MB' })
  })

  it('hashes text as the Host names a version: SHA-256 of its UTF-8, in hex', async () => {
    const text = '建议：用 ECB。\n每天缓存一次。'
    expect(await sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'))
    await expect(sha256Hex('x', undefined as unknown as SubtleCrypto)).resolves.toMatch(/^[a-f0-9]{64}$/u)
  })

  it('says why the form cannot go yet', () => {
    const file: MaterialChip = { key: 'f', kind: 'file', file: { root: 'default', path: 'rates.md' }, hash: 'b'.repeat(64) }
    expect(formProblem(form({ requirements: '' }), [])).toBe('选一项材料或写下要求')
    expect(formProblem(form({ target: { kind: 'session' } }), [file])).toBe('选一个已有会话')
    expect(formProblem(form({ target: { kind: 'new-session', mode: 'agent', worktree: false } }), [file])).toBe('先选 Harness')
    expect(formProblem(form({ target: { kind: 'new-session', harnessId: 'fake', mode: 'agent', worktree: true } }), [file])).toMatch(
      /新工作树/u,
    )
    expect(formProblem(form(), [file])).toBeUndefined()
  })
})

describe('handoff requests', () => {
  it('builds the create request with the locale named and blank decisions left out', () => {
    const body = createBody('req-1', 'source', form({ decisions: [' 用 ECB ', ''] }), [{ kind: 'text', text: 'x' }])
    expect(body).toEqual({
      requestId: 'req-1',
      sourceSessionId: 'source',
      target: { kind: 'new-session', projectId: 'notes', harnessId: 'fake', mode: 'agent' },
      materials: [{ kind: 'text', text: 'x' }],
      requirements: '接入每日汇率',
      decisions: ['用 ECB'],
      returnScope: 'summary-and-evidence',
      locale: 'zh-CN',
    })
    expect(createBody('r', 's', form({ target: { kind: 'session', sessionId: 'other' } }), []).target).toEqual({
      kind: 'session',
      sessionId: 'other',
    })
  })

  it('rebuilds the same request from the record, or none when the source is not readable', () => {
    const body = createBody('req-1', 'source', form(), [{ kind: 'text', text: 'x' }])
    const record: Handoff = {
      id: 'hof_1',
      ...body,
      locale: 'zh-CN',
      status: 'start-unknown',
      createdAt: '',
      updatedAt: '',
    }
    expect(retryBody(record)).toEqual(body)
    expect(retryBody(record, 'req-2')?.requestId).toBe('req-2')
    const { materials: _m, ...hidden } = record
    expect(retryBody(hidden)).toBeUndefined()
  })

  it('keeps a lost answer unknown, a 403 as denied, and names what changed', () => {
    expect(writeFailure(new ApiTimeoutError()).kind).toBe('unknown')
    expect(writeFailure(new TypeError('Failed to fetch')).kind).toBe('unknown')
    expect(writeFailure(new ApiError(503, 'agent-write-unknown', '未知')).kind).toBe('unknown')
    expect(writeFailure(new ApiError(403, 'file-scope', '不能浏览'))).toEqual({ kind: 'denied', message: '不能浏览', code: 'file-scope' })
    const changed = writeFailure(new ApiError(409, 'handoff-material-changed', '变了', { materials: [1] } as never))
    expect(changed).toEqual({ kind: 'refused', message: '变了', code: 'handoff-material-changed', items: [1] })
    const chips: MaterialChip[] = [
      { key: 'a', kind: 'text', text: 'x' },
      { key: 'b', kind: 'file', file: { root: 'default', path: 'rates.md' } },
    ]
    expect(namedChips(chips, changed.kind === 'refused' ? changed.items : undefined).map(chip => chip.key)).toEqual(['b'])
  })

  it('cuts evidence to the agreed scope', () => {
    const choices = evidenceChoices(messages, 'all')
    const file = choices.find(choice => choice.kind === 'file')!
    const evidence = [{ choice: file, hash: 'c'.repeat(64) }]
    expect(returnBody('r', ' 已接入 ', 'summary', evidence)).toEqual({ requestId: 'r', summary: '已接入', evidence: [] })
    expect(returnBody('r', '已接入', 'summary-and-evidence', evidence).evidence).toEqual([
      { kind: 'file', file: { root: 'default', path: 'notes/brief.md' }, hash: 'c'.repeat(64) },
    ])
    // A device without the full data scope is offered messages only.
    expect(evidenceChoices(messages, 'work').every(choice => choice.kind === 'message')).toBe(true)
  })
})

describe('handoff states', () => {
  const summary = (patch: Partial<HandoffSummary>): HandoffSummary => ({
    id: 'hof_1',
    sourceSessionId: 'source',
    targetSessionId: 'target',
    status: 'started',
    returnScope: 'summary',
    updatedAt: '2026-11-12T10:00:00.000Z',
    ...patch,
  })

  it('waits for a return only when one was agreed and the target’s turn has ended', () => {
    expect(awaitsReturn(summary({}), task('target'))).toBe(true)
    expect(awaitsReturn(summary({}), task('target', { status: 'running' }))).toBe(false)
    expect(awaitsReturn(summary({ returnScope: 'none' }), task('target'))).toBe(false)
    expect(awaitsReturn(summary({ status: 'returned' }), task('target'))).toBe(false)
    const snapshot = { handoffs: [summary({})], tasks: [task('source'), task('target')] }
    expect([...sessionsAwaitingReturn(snapshot)]).toEqual(['target'])
  })

  it('names the source in the target’s header, or nothing to link to', () => {
    const handoffs = [summary({})]
    expect(sourceCrumb({ handoffs, tasks: [task('source', { title: '汇率 API 选型' })] }, 'target')).toEqual({
      sourceId: 'source',
      title: '汇率 API 选型',
    })
    expect(sourceCrumb({ handoffs, tasks: [] }, 'target')).toEqual({ sourceId: 'source' })
    expect(sourceCrumb({ handoffs, tasks: [] }, 'source')).toBeUndefined()
  })

  it('uses amber only for what waits for the person', () => {
    expect(statusWords({ status: 'start-unknown', returnScope: 'summary' }).tone).toBe('warn')
    expect(statusWords({ status: 'start-failed', returnScope: 'summary' }).tone).toBe('failed')
    expect(statusWords({ status: 'started', returnScope: 'none' }).words).toBe('已开始')
    expect(statusWords({ status: 'returned', returnScope: 'summary' }).tone).toBe('done')
  })

  it('starts the summary from the last reply and quotes it into the draft', () => {
    expect(defaultSummary(messages)).toBe('免费。')
    expect(quotedSummary('', '已接入\n\n缓存 24 小时')).toBe('> 已接入\n>\n> 缓存 24 小时\n\n')
    expect(quotedSummary('先看这个', '已接入')).toBe('先看这个\n\n> 已接入\n\n')
  })

  it('places each returned result after the last turn that began before it', () => {
    const turns = [
      { key: 'u1', at: Date.parse('2026-11-12T10:00:00Z') },
      { key: 'u2', at: Date.parse('2026-11-12T11:00:00Z') },
    ]
    const placed = placeByTime(turns, [
      { at: '2026-11-12T10:30:00Z', id: 'x' },
      { at: '2026-11-12T09:00:00Z', id: 'early' },
      { at: '2026-11-12T12:00:00Z', id: 'late' },
    ])
    expect(placed.get('u1')?.map(item => item.id)).toEqual(['x'])
    expect(placed.get('u2')?.map(item => item.id)).toEqual(['late'])
    expect(placed.get('')?.map(item => item.id)).toEqual(['early'])
  })

  it('offers existing sessions to hand to: not the source, not archived, and private only from private', () => {
    const source = task('source')
    const list = [task('source'), task('a'), task('b', { archived: true }), task('c', { agentPrivate: true })]
    expect(sessionTargets(list, source).map(item => item.id)).toEqual(['a', 'c'])
    expect(sessionTargets(list, task('p', { agentPrivate: true })).map(item => item.id)).toEqual(['c'])
  })
})
