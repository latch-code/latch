import { describe, expect, it } from 'vitest'
import { promptTitle, type Automation, type AutomationRun } from '@latch/protocol'
import { ApiError } from '../src/core/api.ts'
import { writeOutcome } from '../src/agents/model.ts'
import {
  automationsVersion,
  carriedText,
  CARRY_REPLY_CHARS,
  finalReply,
  inputLine,
  missedRuns,
  NEW_SCHEDULE,
  newScheduleDraft,
  runReason,
  scheduleBlock,
  scheduleCreate,
  scheduleDraftOf,
  schedulePatch,
  scheduleProblem,
  scheduleStatus,
  scheduleWhere,
  whenWords,
} from '../src/agents/scheduleModel.ts'

const automation = (extra: Partial<Automation> = {}): Automation => ({
  id: 'auto_00000000-0000-4000-8000-000000000000',
  name: '汇率周报',
  customAgentId: 'agt_1',
  projectId: 'notes',
  prompt: '整理本周汇率\n写成一页',
  schedule: { kind: 'weekly', day: 1, time: '09:00' },
  notify: false,
  revision: 2,
  enabled: true,
  state: 'ready',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
})

const run = (state: AutomationRun['state'], at = '2026-11-10T01:00:00.000Z'): AutomationRun => ({ at, state, trigger: 'schedule' })

describe('the 定时 form', () => {
  it('needs a name, a time, a work location chosen by hand and an input', () => {
    expect(scheduleProblem(NEW_SCHEDULE)).toBe('先填名称')
    expect(scheduleProblem({ ...NEW_SCHEDULE, name: '周报', time: '9' })).toBe('先填时间')
    expect(scheduleProblem({ ...NEW_SCHEDULE, name: '周报' })).toBe('先选工作位置')
    expect(scheduleProblem({ ...NEW_SCHEDULE, name: '周报', location: 'default' })).toBe('先写每次的输入')
    expect(scheduleProblem({ ...NEW_SCHEDULE, name: '周报', location: 'default', prompt: '写周报' })).toBeUndefined()
  })

  it('starts in the Agent’s default project, and empty without one', () => {
    expect(newScheduleDraft('notes').location).toBe('notes')
    expect(newScheduleDraft(undefined).location).toBeUndefined()
  })

  it('creates for the Agent, in a project or in each run’s own folder', () => {
    const draft = { ...NEW_SCHEDULE, name: ' 周报 ', location: 'notes', prompt: ' 写周报 ', kind: 'weekly' as const, day: 5 }
    expect(scheduleCreate(draft, 'agt_1')).toEqual({
      name: '周报',
      customAgentId: 'agt_1',
      projectId: 'notes',
      prompt: '写周报',
      schedule: { kind: 'weekly', day: 5, time: '09:00' },
      notify: false,
    })
    const own = scheduleCreate({ ...draft, location: 'default', kind: 'weekdays' }, undefined)
    expect(own).not.toHaveProperty('projectId')
    expect(own).not.toHaveProperty('customAgentId')
    expect(own.schedule).toEqual({ kind: 'weekdays', time: '09:00' })
  })

  it('edits from the saved automation and sends only what changed, clearing the project with null', () => {
    const base = scheduleDraftOf(automation())
    expect(base).toMatchObject({ kind: 'weekly', day: 1, location: 'notes', prompt: '整理本周汇率\n写成一页' })
    expect(schedulePatch(base, base)).toEqual({})
    expect(schedulePatch(base, { ...base, location: 'default', time: '10:30' })).toEqual({
      projectId: null,
      schedule: { kind: 'weekly', day: 1, time: '10:30' },
    })
    expect(schedulePatch(base, { ...base, kind: 'daily', notify: true })).toEqual({
      schedule: { kind: 'daily', time: '09:00' },
      notify: true,
    })
    expect(scheduleDraftOf(automation({ projectId: undefined })).location).toBe('default')
  })
})

describe('a schedule on the page', () => {
  it('says its state, with the Host’s reason for a pause', () => {
    expect(scheduleStatus({ state: 'ready' })).toEqual({ label: '已开启', tone: 'neutral' })
    expect(scheduleStatus({ state: 'off' }).label).toBe('已关闭')
    expect(scheduleStatus({ state: 'running' }).tone).toBe('running')
    expect(scheduleStatus({ state: 'paused', pause: { reason: 'owner-unavailable', message: '开启它的设备已不能运行任务' } })).toEqual({
      label: '已暂停',
      tone: 'warn',
      reason: '开启它的设备已不能运行任务',
    })
  })

  it('counts the times missed since the last run that happened, with why', () => {
    expect(missedRuns([run('missed'), run('skipped'), run('completed'), run('missed')])).toHaveLength(2)
    expect(missedRuns([run('completed'), run('missed')])).toEqual([])
    expect(runReason(run('missed'))).toMatch(/关机、睡眠/u)
    expect(runReason(run('skipped'))).toMatch(/上一次运行还没结束/u)
    expect(runReason(run('completed'))).toBeUndefined()
  })

  it('says times in this device’s clock', () => {
    const now = new Date(2026, 10, 12, 15, 0).getTime()
    expect(whenWords(new Date(2026, 10, 12, 9, 5).toISOString(), now)).toBe('今天 09:05')
    expect(whenWords(new Date(2026, 10, 13, 9, 0).toISOString(), now)).toBe('明天 09:00')
    expect(whenWords(new Date(2026, 10, 11, 9, 0).toISOString(), now)).toBe('昨天 09:00')
    expect(whenWords(new Date(2026, 10, 17, 9, 0).toISOString(), now)).toBe('11月17日 09:00')
    expect(whenWords(new Date(2025, 0, 2, 9, 0).toISOString(), now)).toBe('2025年1月2日 09:00')
  })

  it('names where it works and its input in a line', () => {
    const catalog = { workspaces: [{ id: 'notes', name: 'notes', path: '/w/notes' }] } as never
    expect(scheduleWhere(catalog, { projectId: 'notes' })).toBe('notes')
    expect(scheduleWhere(catalog, {})).toBe('每次新的文件夹')
    expect(inputLine('\n  整理本周汇率\n写成一页')).toBe('整理本周汇率')
    expect(inputLine('长'.repeat(80), 10)).toBe(`${'长'.repeat(9)}…`)
  })

  it('reads details again when a revision, state or run changes', () => {
    const a = automationsVersion([automation()])
    expect(automationsVersion([automation({ revision: 3 })])).not.toBe(a)
    expect(automationsVersion([automation({ lastRun: { ...run('running'), sessionId: 's1' } })])).not.toBe(a)
    expect(automationsVersion([automation()])).toBe(a)
  })

  it('says why this device cannot add or run one, and offers it when it can', () => {
    expect(scheduleBlock({ offline: true, canRun: true })).toMatch(/不在线/u)
    expect(scheduleBlock({ offline: false, canRun: false })).toMatch(/只能查看/u)
    expect(scheduleBlock({ offline: false, canRun: true, agent: { canAutomate: false, unavailableReason: '默认项目已移除' } })).toBe(
      '默认项目已移除',
    )
    expect(scheduleBlock({ offline: false, canRun: true, agent: { canAutomate: true } })).toBeUndefined()
    expect(scheduleBlock({ offline: false, canRun: true })).toBeUndefined()
  })

  it('treats an automation changed elsewhere as a conflict to reload', () => {
    expect(writeOutcome(new ApiError(409, 'automation-changed', '这项记录已更新'))).toEqual({ kind: 'conflict', message: '这项记录已更新' })
    expect(writeOutcome(new ApiError(403, 'automation-owner', '这台设备不能开启这个定时任务。')).kind).toBe('refused')
  })
})

describe('带入上次成果', () => {
  it('takes the last reply of a session', () => {
    expect(
      finalReply([
        { role: 'user', text: '比较' },
        { role: 'assistant', text: '第一版' },
        { role: 'assistant', text: ' 最终结论 ' },
        { role: 'assistant', text: '  ' },
      ]),
    ).toBe('最终结论')
    expect(finalReply([{ role: 'user', text: '比较' }])).toBe('')
  })

  it('quotes each chosen result after the draft, naming where it came from', () => {
    const text = carriedText('接着比较价格', [
      { title: '汇率接口', reply: '选 A\n\n理由：免费', files: [{ root: 'notes', path: 'out/rates.md' }] },
      { title: '空的', files: [] },
      { title: '只有文件', files: [{ root: 'notes', path: 'csv.md' }] },
    ])
    expect(text).toBe(
      '接着比较价格\n\n> 上次成果「汇率接口」：\n> 选 A\n>\n> 理由：免费\n>\n> 文件：out/rates.md\n\n> 上次成果「只有文件」：\n> 文件：csv.md\n\n',
    )
    expect(carriedText('', [{ title: 'x', reply: '好', files: [] }])).toBe('> 上次成果「x」：\n> 好\n\n')
    expect(carriedText('原样', [{ title: 'x', files: [] }])).toBe('原样')
  })

  it('clips a long reply', () => {
    const text = carriedText('', [{ title: 'x', reply: 'a'.repeat(CARRY_REPLY_CHARS + 10), files: [] }])
    expect(text).toContain('…（已截断）')
    expect(text.length).toBeLessThan(CARRY_REPLY_CHARS + 40)
  })

  it('never names the new session after the carried block', () => {
    const carried = carriedText('', [
      { title: '汇率接口', reply: '选 A', files: [] },
      { title: '其他', reply: '好', files: [] },
    ])
    expect(promptTitle(`${carried}按这个结论写摘要\n第二行`)).toBe('按这个结论写摘要 第二行')
    expect(promptTitle(carriedText('先比较价格', [{ title: '汇率接口', reply: '选 A', files: [] }]))).toMatch(/^先比较价格 > 上次成果/u)
    expect(promptTitle(carried)).toBe('汇率接口')
    expect(promptTitle('> 只是引用\n> 第二行')).toBe('只是引用 第二行')
    expect(promptTitle('  比较  三家\n接口 ')).toBe('比较 三家 接口')
  })
})
