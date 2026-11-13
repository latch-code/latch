import { testHarness } from '@latch/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustomAgentDetail, CustomAgentSummary, HostCatalog, TaskSummary } from '@latch/protocol'
import { ApiError, ApiTimeoutError, readPending, submissionRequest, writePending } from '../src/core/api.ts'
import {
  agentEntries,
  agentHarnesses,
  agentSessions,
  delegationMode,
  delegationChoice,
  delegationSubmission,
  draftOf,
  generalChoice,
  dutyLine,
  normalizedDraft,
  patchOf,
  rebaseDraft,
  saveWaits,
  scheduleWords,
  sessionAgent,
  agentActivity,
  agentDefaultChoice,
  withAgentDefaultChoice,
  worksIn,
  writeOutcome,
} from '../src/agents/model.ts'
import { paletteGroups } from '../src/palette/model.ts'
import { visibleEntries } from '../src/shell/routes.ts'

const catalog = (overrides: Partial<HostCatalog> = {}): HostCatalog => ({
  harnesses: [
    { ...testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }), agentContext: 'private', skills: 'native' },
    { ...testHarness('codex', { kind: 'agent', label: 'Codex' }), agentContext: 'first-turn' },
    testHarness('plain', { kind: 'agent', label: 'Plain' }),
    { ...testHarness('pi', { kind: 'agent', label: 'pi', status: 'unavailable' }), agentContext: 'first-turn' },
  ],
  providers: [{ id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' }],
  workspaces: [
    { id: 'default', name: 'start', path: '/work' },
    { id: 'notes', name: 'notes', path: '/work/notes' },
  ],
  defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default' },
  ...overrides,
})

const summary = (extra: Partial<CustomAgentSummary> = {}): CustomAgentSummary => ({
  id: 'agt_1',
  name: '资料助手',
  description: '',
  harnessId: 'standard',
  mode: 'agent',
  avatar: { kind: 'face', bracket: 'curly', eyes: 'dot', hue: 'pine' },
  revision: 3,
  skillCount: 0,
  memoryCount: 0,
  sessionCount: 0,
  available: true,
  canAutomate: true,
  ...extra,
})

const detail = (extra: Partial<CustomAgentDetail['agent']> = {}): CustomAgentDetail['agent'] => ({
  ...summary(),
  instructions: '查资料\n写摘要',
  skills: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
})

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary =>
  ({ id, title: id, status: 'idle', updatedAt: '2026-11-10T00:00:00.000Z', harnessId: 'standard', ...extra }) as TaskSummary

describe('我的 Agent model', () => {
  it('lists 通用 first, then the Host’s order', () => {
    const entries = agentEntries({
      general: { memoryCount: 2 },
      agents: [summary({ id: 'agt_b', name: 'B' }), summary({ id: 'agt_a', name: 'A' })],
    })
    expect(entries.map(entry => entry.name)).toEqual(['通用', 'B', 'A'])
    expect(entries[0]).toMatchObject({ kind: 'general', memoryCount: 2 })
    expect(agentEntries(undefined)).toEqual([])
  })

  it('offers only ready Harnesses that can receive an Agent', () => {
    expect(agentHarnesses(catalog()).map(harness => harness.id)).toEqual(['standard', 'codex'])
    const offered = catalog({
      harnesses: [{ ...testHarness('claude', { kind: 'agent' }), agentContext: 'first-turn', offer: { presetId: 'claude' } }],
    })
    expect(agentHarnesses(offered)).toEqual([])
  })

  it('keeps 通用 on Standard Agent even when another Harness is the Code default', () => {
    expect(generalChoice(catalog({ defaults: { harnessId: 'codex', mode: 'chat', workspaceId: 'notes' } }))).toMatchObject({
      harnessId: 'standard',
      mode: 'agent',
      workspaceId: 'default',
    })
    expect(generalChoice(catalog({ harnesses: [testHarness('codex', { kind: 'agent' })] }))).toMatchObject({ harnessId: 'standard' })
  })

  it('says the duty and where it works in one line each', () => {
    expect(dutyLine({ description: '  一页摘要\n多余', instructions: 'x' })).toBe('一页摘要')
    expect(dutyLine({ description: '', instructions: '\n  查资料  \n写摘要' })).toBe('查资料')
    expect(dutyLine({})).toBe('')
    expect(worksIn(catalog(), 'notes')).toBe('notes')
    expect(worksIn(catalog(), undefined)).toBe('家')
    expect(worksIn(catalog({ sessionFolders: true }), 'default')).toBe('家')
    expect(worksIn(catalog(), 'removed')).toBe('项目已移除')
  })

  it('finds an Agent’s sessions, newest first, and the Agent of a session', () => {
    const tasks = [
      task('old', { agent: { customAgentId: 'agt_1' }, updatedAt: '2026-11-01T00:00:00.000Z' }),
      task('new', { agent: { customAgentId: 'agt_1' }, updatedAt: '2026-11-11T00:00:00.000Z' }),
      task('archived', { agent: { customAgentId: 'agt_1' }, archived: true }),
      task('other', { agent: { customAgentId: 'agt_2' } }),
      task('plain'),
    ]
    expect(agentSessions(tasks, 'agt_1').map(item => item.id)).toEqual(['new', 'old'])
    expect(agentSessions(tasks, 'general')).toEqual([])
    expect(sessionAgent({ customAgents: [summary()] }, tasks[0])).toEqual({ id: 'agt_1', name: '资料助手', avatar: summary().avatar })
    expect(sessionAgent({}, tasks[3])).toEqual({ id: 'agt_2', name: 'Agent' })
    expect(sessionAgent({ customAgents: [summary()] }, tasks[4])).toBeUndefined()
  })

  it('shows on the face what the Agent’s own sessions say: 等你处理, then 运行中, then 休息, then a failure of its latest', () => {
    const mine = (id: string, extra: Partial<TaskSummary> = {}) => task(id, { agent: { customAgentId: 'agt_1' }, ...extra })
    const state = (tasks: TaskSummary[], extra: Partial<CustomAgentSummary> = {}, approvals: Array<{ sessionId: string }> = []) =>
      agentActivity({ tasks, approvals: approvals as never }, summary(extra))
    expect(state([])).toBe('idle')
    expect(state([mine('a', { status: 'running' })])).toBe('running')
    expect(state([mine('a', { status: 'running' }), mine('b', { status: 'waiting-approval' })])).toBe('waiting')
    expect(state([mine('a', { status: 'running', pendingQuestions: 1 } as Partial<TaskSummary>)])).toBe('waiting')
    // Another Agent's sessions say nothing about this one.
    expect(state([task('x', { status: 'running', agent: { customAgentId: 'agt_2' } })])).toBe('idle')
    expect(state([], { available: false })).toBe('resting')
    expect(state([mine('a', { status: 'running' })], { available: false })).toBe('running')
    expect(state([mine('a', { status: 'failed' })])).toBe('failed')
    // Only the latest counts: a later success clears an earlier failure, and an archived failure is left out.
    expect(state([mine('a', { status: 'failed' }), mine('b', { updatedAt: '2026-11-11T00:00:00.000Z' })])).toBe('idle')
    expect(state([mine('a', { status: 'failed', archived: true })])).toBe('idle')
  })

  it('keeps edits in progress over a new revision, takes the rest, and says when the same field changed elsewhere', () => {
    const before = draftOf(detail())
    // A new avatar or name elsewhere: nothing the form shows changed, so the edits stay as they are.
    const edited = { ...before, instructions: '只查资料' }
    expect(rebaseDraft(before, { ...before }, edited)).toEqual({ draft: edited, conflicts: [] })
    // Another field changed elsewhere: it comes in, and the person's edit stays.
    expect(rebaseDraft(before, { ...before, description: '新的职责' }, edited)).toEqual({
      draft: { ...edited, description: '新的职责' },
      conflicts: [],
    })
    // An untouched form takes the new definition whole, cleared fields included.
    const next = { ...before, defaultProjectId: 'notes', skills: ['p:s'] }
    expect(rebaseDraft(before, next, before)).toEqual({ draft: next, conflicts: [] })
    // Its own save: the edit matches what came back.
    expect(rebaseDraft(before, edited, edited)).toEqual({ draft: edited, conflicts: [] })
    // The same field changed there to something else: the person's text stays, and it is a conflict.
    // The same field changed there to something else: the person's text stays to copy, and 保存 waits for 载入最新.
    const clash = rebaseDraft(before, { ...before, instructions: '别的', description: '新的职责' }, edited)
    expect(clash).toEqual({ draft: { ...edited, description: '新的职责' }, conflicts: ['instructions'] })
    expect(saveWaits(clash.conflicts)).toBe(true)
    expect(saveWaits(rebaseDraft(before, { ...before, description: '新的职责' }, edited).conflicts)).toBe(false)
  })

  it('sends only what changed, clearing with null', () => {
    const base = draftOf(detail({ model: { providerId: 'deepseek', model: 'deepseek-chat' }, defaultProjectId: 'notes', tools: ['web'] }))
    expect(patchOf(base, base)).toEqual({})
    const { model: _model, defaultProjectId: _project, tools: _tools, ...cleared } = base
    expect(patchOf(base, { ...cleared, name: '新名字' })).toEqual({ name: '新名字', model: null, defaultProjectId: null, tools: null })
    expect(patchOf(base, { ...base, skills: ['p:s'] })).toEqual({ skills: ['p:s'] })
  })

  it('keeps an explicit service model for Host validation, including a native Harness route', () => {
    const draft = {
      ...draftOf(detail()),
      name: '  周报 ',
      harnessId: 'codex',
      model: { providerId: 'deepseek', model: 'deepseek-chat' },
    }
    expect(normalizedDraft(catalog(), draft).model).toEqual(draft.model)
    expect(normalizedDraft(catalog(), draft).name).toBe('周报')
    expect(delegationMode({ modes: ['chat'] }, 'agent')).toBe('chat')
    expect(delegationMode({ modes: ['chat', 'agent'] }, 'agent')).toBe('agent')
  })

  it('keeps native defaults through editing and rebasing, and stores no synthetic service option', () => {
    const current = catalog()
    const base = draftOf(detail({ harnessId: 'codex', engineOptions: { model: 'native', effort: 'high', '~mode': 'read-only' } }))
    expect(base.engineOptions).toEqual({ model: 'native', effort: 'high', '~mode': 'read-only' })
    const choice = agentDefaultChoice(current, base)
    expect(choice.config).toEqual(base.engineOptions)
    const next = withAgentDefaultChoice(current, base, { config: { ...choice.config, effort: 'low' } })
    expect(patchOf(base, next)).toEqual({ engineOptions: { model: 'native', effort: 'low', '~mode': 'read-only' } })
    expect(rebaseDraft(base, { ...base, engineOptions: { model: 'native', effort: 'max' } }, next).conflicts).toContain('engineOptions')
    const service = { providerId: 'removed-service', model: 'still-intended' }
    const routed = { ...base, model: service }
    const shown = agentDefaultChoice(current, routed)
    const permission = withAgentDefaultChoice(current, routed, { config: { ...shown.config, '~mode': 'workspace-write' } })
    expect(permission.model).toEqual(service)
    expect(Object.keys(permission.engineOptions ?? {})).not.toContain('~service')
    const native = withAgentDefaultChoice(current, routed, { config: { model: 'other-native' } })
    expect(native.model).toBeUndefined()
    expect(native.engineOptions).toEqual({ model: 'other-native' })
  })

  it('tells a conflict, an unknown result and a refusal apart', () => {
    expect(writeOutcome(new ApiError(409, 'agent-changed', '已更新'))).toMatchObject({ kind: 'conflict' })
    expect(writeOutcome(new ApiError(503, 'agent-write-unknown', '尚未确认'))).toMatchObject({ kind: 'unknown' })
    expect(writeOutcome(new ApiTimeoutError())).toMatchObject({ kind: 'unknown' })
    expect(writeOutcome(new TypeError('network'))).toMatchObject({ kind: 'unknown' })
    expect(writeOutcome(new ApiError(409, 'agent-unavailable', '不可用'))).toEqual({
      kind: 'refused',
      message: '不可用',
      code: 'agent-unavailable',
    })
  })

  it('says a schedule in words', () => {
    expect(scheduleWords({ kind: 'daily', time: '09:00' })).toBe('每天 09:00')
    expect(scheduleWords({ kind: 'weekdays', time: '18:30' })).toBe('工作日 18:30')
    expect(scheduleWords({ kind: 'weekly', day: 1, time: '09:00' })).toBe('每周一 09:00')
  })
})

describe('a delegation request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the Agent in the new session’s request and keeps it through storage', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    const submission = {
      requestId: 'req-12345678',
      prompt: '比较三家',
      mode: 'agent' as const,
      harnessId: 'standard',
      workspaceId: 'notes',
      customAgentId: 'agt_1',
    }
    expect(submissionRequest(submission)).toEqual({
      path: 'tasks',
      body: {
        prompt: '比较三家',
        requestId: 'req-12345678',
        mode: 'agent',
        harnessId: 'standard',
        workspaceId: 'notes',
        customAgentId: 'agt_1',
      },
    })
    writePending('delegation', submission)
    expect(readPending('delegation')).toEqual(submission)
    // A prompt to an existing session never carries an Agent.
    writePending('delegation', { ...submission, sessionId: 's1' })
    expect(readPending('delegation')).not.toHaveProperty('customAgentId')
  })
})

describe('a delegation start', () => {
  it('names the folder the Host starts in: the start folder without a default project, else that project', () => {
    const harness = catalog().harnesses[0]!
    const request = (agent: CustomAgentSummary, choice = delegationChoice(agent)) =>
      delegationSubmission({ agent, harness, choice, prompt: '整理', worktree: undefined, inProject: false })
    const model = { providerId: 'deepseek', model: 'deepseek-chat' }
    expect(request(summary({ model }))).toEqual({
      customAgentId: 'agt_1',
      prompt: '整理',
      mode: 'agent',
      harnessId: 'standard',
      workspaceId: 'default',
      model,
    })
    const placed = summary({ defaultProjectId: 'notes' })
    expect(request(placed).workspaceId).toBe('notes')
    // 起始文件夹 picked for one session is still sent, or the Host would start in the Agent's project.
    expect(request(placed, { ...delegationChoice(placed), workspaceId: 'default' }).workspaceId).toBe('default')
  })

  it('sends the worktree start point as picked, and none outside a project', () => {
    const harness = catalog().harnesses[0]!
    const base = { agent: summary(), harness, choice: { mode: 'agent' as const, workspaceId: 'notes' }, prompt: '比较三家' }
    const branch = { from: 'branch' as const, branch: 'release' }
    expect(delegationSubmission({ ...base, worktree: branch, inProject: true })).toEqual({
      customAgentId: 'agt_1',
      prompt: '比较三家',
      mode: 'agent',
      harnessId: 'standard',
      workspaceId: 'notes',
      worktree: branch,
    })
    expect(delegationSubmission({ ...base, worktree: { from: 'commit', ref: 'abc1234' }, inProject: true }).worktree).toEqual({
      from: 'commit',
      ref: 'abc1234',
    })
    expect(delegationSubmission({ ...base, worktree: branch, inProject: false })).not.toHaveProperty('worktree')
    expect(delegationSubmission({ ...base, worktree: undefined, inProject: true })).not.toHaveProperty('worktree')
  })
})

describe('entries and search', () => {
  it('draws 我的 Agent only where the Host has it', () => {
    expect(visibleEntries(['general'], false, true)).toEqual(['sessions', 'agents', 'settings'])
    expect(visibleEntries(['shortcuts'], true, true)).toEqual(['sessions', 'agents'])
    expect(visibleEntries(['general'], false)).toEqual(['sessions', 'settings'])
  })

  it('finds an Agent in the palette by name', () => {
    const entry = { id: 'my-agent:agt_1', label: '资料助手', icon: null, run: () => {} }
    const groups = paletteGroups({
      level: 'root',
      query: '资料',
      recent: [],
      sessions: [],
      agents: [],
      myAgents: [entry],
      settings: [],
      commands: [],
    })
    expect(groups.map(group => group.label)).toEqual(['我的 Agent'])
  })
})
