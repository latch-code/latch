import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, PersonalAssistantSummary, PersonalGroup, PersonalRoutine } from '@latch/protocol'
import { GroupPage, type GroupPageProps } from '../src/personal/GroupPage.tsx'
import { RoutinePage, type RoutinePageProps } from '../src/personal/RoutinePage.tsx'
import { PersonalPage } from '../src/personal/PersonalPage.tsx'
import {
  activeGroupTurn,
  emptyGroupDraft,
  groupConfig,
  groupConfigProblem,
  groupInput,
  routineConfig,
  routineConfigProblem,
} from '../src/personal/model.ts'
import type { DeviceAccess } from '../src/core/permissions.ts'

const assistants: PersonalAssistantSummary[] = ['a', 'b', 'c', 'd', 'e'].map(id => ({
  id,
  name: `成员 ${id}`,
  role: 'PRIVATE MEMBER ROLE',
  harnessId: 'standard',
  mode: 'chat',
  pluginIds: [],
  revision: 1,
  createdAt: '',
  updatedAt: '',
  memoryCount: 1,
  sessionCount: 0,
  available: true,
  canSchedule: true,
}))
const group: PersonalGroup = {
  id: 'group',
  name: 'Shared group',
  memberIds: assistants.map(item => item.id),
  defaultAssistantId: 'a',
  instructions: 'Explicit shared instructions',
  maxRelays: 3,
  revision: 1,
  createdAt: '',
  updatedAt: '',
}
const routine: PersonalRoutine = {
  id: 'routine',
  name: 'Daily work',
  assistantId: 'a',
  prompt: 'Explicit daily task',
  schedule: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
  revision: 1,
  enabled: false,
  state: 'disabled',
  createdAt: '',
  updatedAt: '',
}
const noop = () => {}
const groupProps = (): GroupPageProps => ({
  groupId: null,
  groups: [group],
  assistants,
  draft: emptyGroupDraft(),
  onDraft: noop,
  onSelect: noop,
  writable: true,
  locked: false,
  canStart: true,
  cancelLocked: false,
  feedback: null,
  refreshHint: 0,
  onMutate: noop,
  onCancel: noop,
  onSession: noop,
  onDenied: noop,
})
const routineProps = (): RoutinePageProps => ({
  routineId: routine.id,
  routines: [routine],
  assistants,
  draft: {},
  onDraft: noop,
  onSelect: noop,
  local: false,
  writable: true,
  locked: false,
  feedback: null,
  onMutate: noop,
  onSession: noop,
})

describe('personal group and routine presentation', () => {
  it('snapshots only the explicit responder order and original prompt, without roles, memories or a guessed member', () => {
    const draft = { prompt: '  Shared task\nsecond line  ', assistantIds: ['c', 'a'] }
    const body = groupInput(group, draft, 'original-request')!
    expect(body).toEqual({ requestId: 'original-request', prompt: draft.prompt, assistantIds: ['c', 'a'] })
    draft.assistantIds.reverse()
    expect(body.assistantIds).toEqual(['c', 'a'])
    expect(groupInput(group, { ...draft, assistantIds: [] }, 'same')).toEqual({ requestId: 'same', prompt: draft.prompt })
  })
  it('rejects unknown, duplicate, removed or over-budget responders instead of silently changing the intended turn', () => {
    for (const ids of [['a', 'a'], ['removed'], ['a', 'b', 'c', 'd', 'e']])
      expect(groupInput(group, { prompt: 'task', assistantIds: ids }, 'same')).toBeUndefined()
    expect(groupInput({ ...group, maxRelays: 0 }, { prompt: 'task', assistantIds: ['a', 'b'] }, 'same')).toBeUndefined()
    expect(groupInput(group, { prompt: ' ', assistantIds: [] }, 'same')).toBeUndefined()
    expect(groupInput(group, { prompt: 'x'.repeat(16001), assistantIds: [] }, 'same')).toBeUndefined()
  })
  it('keeps configuration independent and requires a real default and an ended turn', () => {
    const config = groupConfig(group)
    expect(Object.keys(config).sort()).toEqual(['defaultAssistantId', 'instructions', 'maxRelays', 'memberIds', 'name'])
    config.memberIds.pop()
    expect(group.memberIds).toHaveLength(5)
    expect(groupConfigProblem({ ...config, defaultAssistantId: 'removed' })).toContain('默认')
    expect(groupConfigProblem({ ...config, maxRelays: 4 })).toContain('1–4')
    const turn = { id: 'turn', assistantIds: [], sessionIds: [], createdAt: '' }
    expect(activeGroupTurn({ ...turn, state: 'waiting-approval' })).toBe(true)
    expect(activeGroupTurn({ ...turn, state: 'interrupted' })).toBe(false)
  })
  it('shows member names in group setup without rendering private roles or a memory pane', () => {
    const html = renderToStaticMarkup(
      createElement(GroupPage, { ...groupProps(), draft: { ...emptyGroupDraft(), editor: { config: groupConfig(group) } } }),
    )
    expect(html).toContain('Shared group')
    expect(html).toContain('Explicit shared instructions')
    expect(html).not.toContain('PRIVATE MEMBER ROLE')
    expect(html).not.toContain('保存记忆')
  })
  it('uses actual local capability for enabling, allows remote pause and reports unknown results honestly', () => {
    const html = renderToStaticMarkup(createElement(RoutinePage, routineProps()))
    expect(html).toContain('未开启')
    expect(html).not.toContain('>开启每日执行<')
    expect(renderToStaticMarkup(createElement(RoutinePage, { ...routineProps(), local: true }))).toContain('>开启每日执行<')
    const unavailable = renderToStaticMarkup(
      createElement(RoutinePage, {
        ...routineProps(),
        local: true,
        assistants: assistants.map(item => ({ ...item, canSchedule: false })),
      }),
    )
    expect(unavailable).toMatch(/<button[^>]*aria-disabled="true"[^>]*>开启每日执行<\/button>/u)
    const running: PersonalRoutine = {
      ...routine,
      enabled: true,
      state: 'running',
      lastRun: { at: '2026-10-26T00:00:00Z', state: 'unknown', sessionId: 'actual-session' },
    }
    const remote = renderToStaticMarkup(createElement(RoutinePage, { ...routineProps(), routines: [running] }))
    expect(remote).toContain('暂停以后执行')
    expect(remote).toContain('结果未知')
    expect(remote).toContain('打开实际会话')
    expect(remote).not.toContain('>已完成<')
  })
  it('validates a real daily clock and IANA zone and creates a config without enabling it', () => {
    expect(routineConfigProblem(routineConfig(routine))).toBeUndefined()
    const config = routineConfig(routine)
    config.schedule.time = '25:00'
    expect(routine.schedule.time).toBe('09:30')
    expect(routineConfigProblem(config)).toContain('时间')
    expect(routineConfigProblem({ ...config, schedule: { kind: 'daily', time: '09:30', timeZone: 'invented/time-zone' } })).toContain(
      '时区',
    )
    expect(Object.keys(routineConfig()).sort()).toEqual(['assistantId', 'name', 'prompt', 'schedule'])
  })
  it('renders nothing when closed and no private controls after actual data scope removal', () => {
    const snapshot = {
      device: { dataScope: 'work' },
      catalog: { features: { personalGroups: true, personalRoutines: true } },
    } as unknown as AppSnapshot
    const access: DeviceAccess = { local: false, legacy: false, admin: false, scopes: new Set(['view', 'run']), device: null }
    const props = { snapshot, access, refreshHint: 0, canStart: true, onClose: noop, onChanged: noop, onSession: noop, onStart: noop }
    expect(renderToStaticMarkup(createElement(PersonalPage, { ...props, open: false }))).toBe('')
    const denied = renderToStaticMarkup(createElement(PersonalPage, props))
    expect(denied).toContain('在电脑上允许个人助手访问')
    expect(denied).not.toContain('创建群聊')
    expect(denied).not.toContain('创建例行任务')
  })
})
