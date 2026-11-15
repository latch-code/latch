import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentActivityItem, MemoryProposal, ScheduleResult } from '@latch/protocol'
import {
  activityTarget,
  activityWords,
  bucketed,
  inputRows,
  outcomeWord,
  proposalDraft,
  replyPreview,
  scheduleProposalLine,
} from '../src/agents/activity.ts'
import { ResultCard } from '../src/agents/ResultCard.tsx'
import { ScheduleProposalRow } from '../src/agents/ScheduleProposalRow.tsx'
import type { AgentWrite, AgentWrites, WriteState } from '../src/agents/useAgentWrites.ts'

const result = (extra: Partial<ScheduleResult> = {}): ScheduleResult => ({
  id: 'res_1',
  automationId: 'auto_1',
  owner: 'agt_1',
  name: '早间精选',
  outcome: 'completed',
  trigger: 'schedule',
  runAt: '2026-11-13T08:00:00.000Z',
  at: '2026-11-13T08:04:00.000Z',
  sessionId: 'run-1',
  topicId: 'topic-1',
  ...extra,
})
const card = (props: Parameters<typeof ResultCard>[0]) => renderToStaticMarkup(createElement(ResultCard, props))

describe('a schedule result card', () => {
  it('says the schedule, its outcome, a short reply with 展开, its files, and 打开运行', () => {
    const html = card({
      result: result({
        reply: '一\n二\n三\n四\n五',
        files: [
          { root: 'default', path: 'news.md', change: 'created' },
          { root: 'default', path: 'old.md', change: 'deleted' },
        ],
        filesMore: 3,
      }),
      onOpenRun: () => {},
      onOpenFile: () => {},
    })
    expect(html).toContain('定时')
    expect(html).toContain('早间精选')
    expect(html).toContain('已完成')
    expect(html).toContain('展开')
    expect(html).not.toContain('五')
    expect(html).toContain('news.md')
    // A deleted file is named, not opened.
    expect(html.match(/<button[^>]*schedule-result-file /gu)).toHaveLength(1)
    expect(html).toContain('另有 3 个文件')
    expect(html).toContain('打开运行')
  })

  it('a failed run says why with its next step; a removed run says so; nothing to open says nothing', () => {
    const failed = card({
      result: result({ outcome: 'failed', failure: { reason: '模型服务拒绝了密钥', code: 'http-401' } }),
      nextStep: { label: '打开设置 › 模型服务', run: () => {} },
    })
    expect(failed).toContain('失败')
    expect(failed).toContain('模型服务拒绝了密钥')
    expect(failed).toContain('打开设置 › 模型服务')
    expect(failed).toContain('data-outcome="failed"')
    const removed = card({ result: result({ contentRemoved: true }) })
    expect(removed).toContain('运行的会话已删除')
    expect(removed).not.toContain('打开运行')
  })

  it('words each outcome, with red only for a failure', () => {
    expect(outcomeWord('completed')).toEqual({ word: '已完成', tone: 'done' })
    expect(outcomeWord('failed').tone).toBe('failed')
    expect(outcomeWord('cancelled')).toEqual({ word: '已停止', tone: 'neutral' })
    expect(outcomeWord('interrupted').tone).toBe('warn')
    expect(outcomeWord('unknown')).toEqual({ word: '结果未知', tone: 'warn' })
    expect(replyPreview({ reply: '短' })).toEqual({ short: '短', more: false })
    expect(replyPreview({ reply: '短', replyTruncated: true }).more).toBe(false)
    expect(replyPreview({ reply: 'x'.repeat(400) }).more).toBe(true)
  })
})

const proposal = (extra: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: 'prp_1',
  kind: 'schedule',
  schedule: { name: '早间精选', plan: { kind: 'weekly', day: 1, time: '08:30' } },
  content: '整理 AI 新闻',
  origin: 'agent',
  external: false,
  source: { sessionId: 's1' },
  state: 'pending',
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  ...extra,
})
const writes = (state: WriteState | null): AgentWrites => ({
  state,
  run: async () => undefined,
  retry: async () => undefined,
  clear: () => {},
  held: state !== null && 'kind' in state && state.kind === 'unknown',
  saving: state !== null && 'phase' in state && state.phase === 'saving',
})
const row = (item: MemoryProposal, state: WriteState | null = null, open = true) =>
  renderToStaticMarkup(
    createElement(ScheduleProposalRow, {
      owner: 'agt',
      proposal: item,
      writes: writes(state),
      disabled: false,
      ...(open ? { onOpen: () => {} } : {}),
    }),
  )

describe('a schedule proposal row', () => {
  it('says 想定时 with its name and plan in words, 打开 and 不要, and every state the Host or the write has', () => {
    expect(scheduleProposalLine(proposal())).toBe('早间精选 · 每周一 08:30')
    const pending = row(proposal({ external: true }))
    expect(pending).toContain('想定时：')
    expect(pending).toContain('早间精选 · 每周一 08:30')
    expect(pending).toContain('打开')
    expect(pending).toContain('不要')
    expect(pending).toContain('来自外部内容')
    // What each run would be sent, its first line, in the row itself.
    expect(pending).toContain('整理 AI 新闻')
    expect(row(proposal({ state: 'saved', automationId: 'auto_1' }))).toContain('已保存')
    expect(row(proposal({ state: 'dismissed' }))).toContain('不要了')
    expect(row(proposal(), null, false)).not.toContain('>打开<')
    const write: AgentWrite = { key: 'proposal:prp_1:dismiss', path: 'x', method: 'POST', body: { requestId: 'request-1234' } }
    const unknown = row(proposal(), { write, kind: 'unknown', message: '连接中断' })
    expect(unknown).toContain('重试同一请求')
    expect(unknown).toContain('request-1234')
  })

  it('shows a proposed input whole, up to a screenful', () => {
    expect(inputRows('一行')).toBe(4)
    expect(inputRows('1\n2\n3\n4\n5\n6')).toBe(7)
    expect(inputRows('x\n'.repeat(40))).toBe(14)
  })

  it('fills the editor from the proposal with home as the initial location', () => {
    expect(proposalDraft(proposal())).toEqual({
      name: '早间精选',
      kind: 'weekly',
      day: 1,
      time: '08:30',
      location: 'default',
      prompt: '整理 AI 新闻',
      notify: false,
    })
    expect(proposalDraft(proposal({ schedule: { name: '每天', plan: { kind: 'daily', time: '07:00' } } })).location).toBe('default')
  })
})

describe('动态', () => {
  const now = Date.parse('2026-11-13T12:00:00')
  const items: AgentActivityItem[] = [
    {
      kind: 'result',
      id: 'r',
      at: new Date(now - 3_600_000).toISOString(),
      resultId: 'res_1',
      name: '早间精选',
      outcome: 'failed',
      topicId: 't',
    },
    { kind: 'memory', id: 'm', at: new Date(now - 2 * 86_400_000).toISOString(), change: 'added', memoryId: 'mem_1' },
    {
      kind: 'proposal',
      id: 'p',
      at: new Date(now - 20 * 86_400_000).toISOString(),
      proposalId: 'prp_1',
      proposal: 'schedule',
      state: 'pending',
      sessionId: 's',
    },
  ]
  it('puts rows in 今天, 本周 and 更早 and words them without any memory or proposal text', () => {
    expect(bucketed(items, now).map(bucket => [bucket.label, bucket.rows.length])).toEqual([
      ['今天', 1],
      ['本周', 1],
      ['更早', 1],
    ])
    expect(activityWords(items[0]!)).toEqual({ lead: '定时结果', subject: '早间精选', state: { word: '失败', tone: 'failed' } })
    expect(activityWords(items[1]!)).toEqual({ lead: '记忆 +1' })
    expect(activityWords(items[2]!)).toEqual({ lead: '提议定时', state: { word: '等你决定', tone: 'warn' } })
  })
  it('leads each row where it happened', () => {
    expect(activityTarget(items[0]!)).toEqual({ session: 't' })
    expect(activityTarget(items[1]!)).toEqual({ memory: true })
    const recall = { kind: 'recall' as const, id: 'recall:s:m', at: '2026-11-14T00:00:00.000Z', sessionId: 's', count: 3 }
    expect(activityWords(recall)).toEqual({ lead: '查记忆', subject: '3 次' })
    expect(activityTarget(recall)).toEqual({ session: 's' })
    expect(activityTarget({ kind: 'run', id: 'x', at: '', automationId: 'a', name: 'n', state: 'missed' })).toBeUndefined()
  })
})
