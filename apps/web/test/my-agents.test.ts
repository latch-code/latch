import { testHarness } from '@latch/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustomAgentDetail, CustomAgentSummary, HostCatalog, TaskSummary } from '@latch/protocol'
import { ApiError, ApiTimeoutError, readPending, submissionRequest, writePending } from '../src/core/api.ts'
import {
  agentEntries,
  agentHarnesses,
  agentSessions,
  delegationMode,
  draftOf,
  draftProblem,
  dutyLine,
  emptyDraft,
  normalizedDraft,
  patchOf,
  runsWith,
  scheduleWords,
  sessionAgent,
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
  glyph: 'library',
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

  it('says the duty, how it runs and where it works in one line each', () => {
    expect(dutyLine({ description: '  一页摘要\n多余', instructions: 'x' })).toBe('一页摘要')
    expect(dutyLine({ description: '', instructions: '\n  查资料  \n写摘要' })).toBe('查资料')
    expect(dutyLine({})).toBe('')
    expect(runsWith(catalog(), { harnessId: 'standard', model: { providerId: 'deepseek', model: 'deepseek-chat' } })).toBe(
      'Latch 内置 · deepseek-chat',
    )
    expect(runsWith(catalog(), { harnessId: 'standard' })).toBe('Latch 内置 · 默认模型')
    expect(runsWith(catalog(), { harnessId: 'codex', model: { providerId: 'deepseek', model: 'x' } })).toBe('Codex')
    expect(runsWith(catalog(), { harnessId: 'gone' })).toBe('gone · 默认模型')
    expect(worksIn(catalog(), 'notes')).toBe('notes')
    expect(worksIn(catalog(), undefined)).toBe('启动目录')
    expect(worksIn(catalog({ sessionFolders: true }), 'default')).toBe('各自的文件夹')
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
    expect(sessionAgent({ customAgents: [summary()] }, tasks[0])).toEqual({ id: 'agt_1', name: '资料助手' })
    expect(sessionAgent({}, tasks[3])).toEqual({ id: 'agt_2', name: 'Agent' })
    expect(sessionAgent({ customAgents: [summary()] }, tasks[4])).toBeUndefined()
  })

  it('sends only what changed, clearing with null', () => {
    const base = draftOf(detail({ model: { providerId: 'deepseek', model: 'deepseek-chat' }, defaultProjectId: 'notes', tools: ['web'] }))
    expect(patchOf(base, base)).toEqual({})
    const { model: _model, defaultProjectId: _project, tools: _tools, ...cleared } = base
    expect(patchOf(base, { ...cleared, name: '新名字' })).toEqual({ name: '新名字', model: null, defaultProjectId: null, tools: null })
    expect(patchOf(base, { ...base, skills: ['p:s'] })).toEqual({ skills: ['p:s'] })
  })

  it('keeps a model only on a Harness that runs on Latch’s models, and checks the form', () => {
    const draft = {
      ...emptyDraft(catalog()),
      name: '  周报 ',
      harnessId: 'codex',
      model: { providerId: 'deepseek', model: 'deepseek-chat' },
    }
    expect(normalizedDraft(catalog(), draft)).not.toHaveProperty('model')
    expect(normalizedDraft(catalog(), draft).name).toBe('周报')
    expect(draftProblem(catalog(), { ...draft, name: ' ' })).toBe('先填名称')
    expect(draftProblem(catalog(), { ...draft, harnessId: 'plain' })).toBe('这个 Harness 现在不能运行 Agent')
    expect(draftProblem(catalog(), draft)).toBeUndefined()
    expect(emptyDraft(catalog())).toMatchObject({ harnessId: 'standard', mode: 'agent', skills: [] })
    expect(delegationMode({ modes: ['chat'] }, 'agent')).toBe('chat')
    expect(delegationMode({ modes: ['chat', 'agent'] }, 'agent')).toBe('agent')
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
