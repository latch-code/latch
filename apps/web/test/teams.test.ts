import { describe, expect, it } from 'vitest'
import {
  TEAM_LIMITS,
  TEAM_RETURN_HEADING,
  type HarnessInfo,
  type HostCatalog,
  type Message,
  type ModelWire,
  type TaskSummary,
  type TeamMember,
  type TeamSummary,
} from '@latch/protocol'
import { testHarness } from '@latch/testkit'
import { withServicePick } from '../src/composerChoice.ts'
import { groupSessions, listedSessions, nestMembers } from '../src/sessions.ts'
import { memberModel } from '../src/teams/memberModel.ts'
import {
  canStartTeam,
  endMark,
  memberPlace,
  nextHarness,
  proposalStart,
  returnOf,
  taskOf,
  tasksOf,
  teamTurnKey,
  type TeamRow,
} from '../src/teams/model.ts'

const member = (itemId: string, state: TeamMember['state'], sessionId?: string): TeamMember => ({
  itemId,
  title: itemId,
  harnessId: 'alpha',
  state,
  ...(sessionId ? { sessionId } : {}),
})
const team = (extra: Partial<TeamSummary> = {}): TeamSummary => ({
  id: 'tem_1',
  leadSessionId: 'lead',
  state: 'running',
  members: [member('a', 'running', 'm1'), member('b', 'running', 'm2')],
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...extra,
})
const session = (id: string, minutes: number, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'alpha',
  id,
  title: id,
  status: 'idle',
  updatedAt: new Date(Date.UTC(2026, 10, 19, 0, minutes)).toISOString(),
  ...extra,
})
const row = (text: string, harnessId = 'alpha'): TeamRow => ({ id: text, text, harnessId })

describe('the list a person writes', () => {
  const ready = [{ id: 'builtin' }, { id: 'alpha' }, { id: 'beta' }]

  it("starts the first row on this session's Harness, then on ones no row uses yet, then on the least used", () => {
    const rows: Array<{ harnessId: string }> = []
    for (let index = 0; index < 5; index++) rows.push({ harnessId: nextHarness(rows, ready, 'alpha')! })
    expect(rows.map(item => item.harnessId)).toEqual(['alpha', 'builtin', 'beta', 'alpha', 'builtin'])
    // This session's Harness cannot start now: the first that can. None ready: none.
    expect(nextHarness([], ready, 'gone')).toBe('builtin')
    expect(nextHarness([], [], 'alpha')).toBeUndefined()
    expect(nextHarness([{ harnessId: 'alpha' }], [{ id: 'alpha' }], 'alpha')).toBe('alpha')
  })

  it('takes the first line as the title and the whole text as what is asked', () => {
    expect(taskOf(row('  查前端\n看登录表单。 \n'))).toEqual({ title: '查前端', prompt: '查前端\n看登录表单。', harnessId: 'alpha' })
    expect(taskOf(row(' \n '))).toBeUndefined()
    expect(Array.from(taskOf(row('长'.repeat(300)))!.title)).toHaveLength(TEAM_LIMITS.titleChars)
  })

  it('starts only with a task written, none too long, each with a Harness, and no more than a team holds', () => {
    expect(tasksOf([row(''), row('  ')])).toBeUndefined()
    expect(tasksOf([row('一'), row('')])?.map(task => task.title)).toEqual(['一'])
    expect(tasksOf([row('一'), row('x'.repeat(TEAM_LIMITS.promptChars + 1))])).toBeUndefined()
    expect(tasksOf([row('一', '')])).toBeUndefined()
    expect(tasksOf(Array.from({ length: TEAM_LIMITS.members + 1 }, (_, index) => row(`第 ${index} 项`)))).toBeUndefined()
    expect(tasksOf(Array.from({ length: TEAM_LIMITS.members }, (_, index) => row(`第 ${index} 项`)))).toHaveLength(TEAM_LIMITS.members)
  })

  it('offers a team to a Code session that is no member, is not archived and has none open', () => {
    const lead = session('lead', 0)
    expect(canStartTeam(lead, undefined)).toBe(true)
    expect(canStartTeam(lead, [team()])).toBe(false)
    expect(canStartTeam(lead, [team({ state: 'returning' })])).toBe(false)
    expect(canStartTeam(lead, [team({ state: 'returned' }), team({ id: 'tem_2', state: 'kept' })])).toBe(true)
    expect(canStartTeam(lead, [team({ leadSessionId: 'other' })])).toBe(true)
    expect(canStartTeam({ ...lead, teamOf: { teamId: 'tem_9', leadSessionId: 'x' } }, undefined)).toBe(false)
    expect(canStartTeam({ ...lead, archived: true }, undefined)).toBe(false)
    expect(canStartTeam({ ...lead, generalChat: true }, undefined)).toBe(false)
  })

  it('sends of a proposal only what the person changed, with the Harness chosen for each entry', () => {
    const read = { title: '读日志', prompt: 'echo logs' }
    expect(
      proposalStart({ id: 'wpp_1', revision: 3 }, [
        { index: 0, ...read, harnessId: 'beta', read },
        { index: 2, title: ' 读配置（改） ', prompt: 'echo config', harnessId: 'alpha', model: { providerId: 'p', model: 'm' }, read },
      ]),
    ).toEqual({
      id: 'wpp_1',
      baseRevision: 3,
      entries: [
        { index: 0, harnessId: 'beta' },
        { index: 2, title: '读配置（改）', prompt: 'echo config', harnessId: 'alpha', model: { providerId: 'p', model: 'm' } },
      ],
    })
  })
})

describe('where a team stands', () => {
  it('says at the end where the results are', () => {
    expect(endMark(team())).toEqual({ mark: 'members', tone: 'running' })
    expect(endMark(team({ members: [member('a', 'waiting'), member('b', 'done')] }))).toEqual({ mark: 'you', tone: 'waiting' })
    expect(endMark(team({ state: 'stopping', members: [member('a', 'waiting')] }))).toEqual({ mark: 'stopping', tone: 'neutral' })
    expect(endMark(team({ state: 'returning' }))).toEqual({ mark: 'pending', tone: 'neutral' })
    expect(endMark(team({ state: 'returned' }))).toEqual({ mark: 'returned', tone: 'done' })
    expect(endMark(team({ state: 'kept', kept: 'stopped' }))).toEqual({ mark: 'kept', tone: 'neutral' })
  })

  it('stands after the turn its split came from, whichever message of that turn it names', () => {
    const messages = [
      { id: 'u1', role: 'user', text: '' },
      { id: 'a1', role: 'assistant', text: '' },
      { id: 's1', role: 'user', text: '', steered: true },
      { id: 't1', role: 'tool', text: '' },
      { id: 'u2', role: 'user', text: '' },
    ] as Message[]
    expect(teamTurnKey({ messageId: 'u1' }, messages)).toBe('u1')
    expect(teamTurnKey({ messageId: 't1' }, messages)).toBe('u1')
    expect(teamTurnKey({ messageId: 'u2' }, messages)).toBe('u2')
    expect(teamTurnKey({ messageId: 'gone' }, messages)).toBeUndefined()
    expect(teamTurnKey({}, messages)).toBeUndefined()
    expect(teamTurnKey({ messageId: 'a0' }, [{ id: 'a0', role: 'assistant', text: '' }] as Message[])).toBe('lead:a0')
  })

  it("knows the message that is a team's results, by the team's record or else by the Host's heading", () => {
    const returned = team({ state: 'returned', returnedMessageId: 'u2' })
    expect(returnOf({ id: 'u2', role: 'user', text: 'x' }, [returned])).toBe(returned)
    expect(returnOf({ id: 'u3', role: 'user', text: `${TEAM_RETURN_HEADING}\n\n…` }, [returned])).toBe(true)
    expect(returnOf({ id: 'u3', role: 'user', text: '你好' }, [returned])).toBe(false)
    expect(returnOf({ id: 'a1', role: 'assistant', text: TEAM_RETURN_HEADING }, undefined)).toBe(false)
  })

  it("says a member's place among the members", () => {
    expect(memberPlace(team(), 'm2')).toEqual({ place: 2, of: 2 })
    expect(memberPlace(team(), 'other')).toBeUndefined()
  })
})

describe('members in the session list', () => {
  const of = (teamId = 'tem_1') => ({ teamOf: { teamId, leadSessionId: 'lead' } })
  const tasks = [session('m2', 5, of()), session('other', 4), session('m1', 3, of()), session('lead', 2), session('older', 1)]

  it("puts a team's members under the session that started it, in the team's order", () => {
    const nested = nestMembers(tasks, [team()])
    expect(nested.tasks.map(task => task.id)).toEqual(['other', 'lead', 'm1', 'm2', 'older'])
    expect([...nested.members]).toEqual(['m2', 'm1'])
    // Without the team's record: in the order the list had them.
    expect(nestMembers(tasks, undefined).tasks.map(task => task.id)).toEqual(['other', 'lead', 'm2', 'm1', 'older'])
  })

  it('leaves a member alone where its session is not in the same list', () => {
    const alone = tasks.filter(task => task.id !== 'lead')
    const nested = nestMembers(alone, [team()])
    expect(nested.tasks.map(task => task.id)).toEqual(alone.map(task => task.id))
    expect(nested.members.size).toBe(0)
  })

  it('nests on a shelf, keeps 等你处理 flat, and steps through the rows in the order drawn', () => {
    const waiting = session('m1', 3, { ...of(), board: { group: 'attention' } as TaskSummary['board'] })
    const all = tasks.map(task => (task.id === 'm1' ? waiting : task))
    const groups = groupSessions(all, undefined, { waitingFrom: all, teams: [team()] })
    expect(groups.map(group => [group.id, group.tasks.map(task => task.id), [...(group.members ?? [])]])).toEqual([
      ['waiting', ['m1'], []],
      ['other', ['other', 'lead', 'm2', 'older'], ['m2']],
    ])
    expect(
      listedSessions(tasks, undefined, { filter: 'all', search: '', folded: new Set(), teams: [team()] }).map(task => task.id),
    ).toEqual(['other', 'lead', 'm1', 'm2', 'older'])
    // A search that finds only a member shows it as any session.
    const found = groupSessions(
      tasks.filter(task => task.id === 'm2'),
      undefined,
      { teams: [team()] },
    )
    expect(found[0]?.members).toBeUndefined()
  })
})

describe("the model a member's Harness starts on", () => {
  const speaking = (harness: HarnessInfo, wires: ModelWire[]): HarnessInfo => ({
    ...harness,
    capabilities: { ...harness.capabilities, models: { ...harness.capabilities.models, wires, experimental: true } },
  })
  const catalog: HostCatalog = {
    harnesses: [
      testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
      speaking(testHarness('codex', { label: 'Codex' }), ['responses']),
    ],
    providers: [
      { id: 'openai', name: 'OpenAI', kind: 'openai-responses', models: ['gpt-5.5', 'gpt-5.5-mini'], defaultModel: 'gpt-5.5' },
      { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
    ],
    workspaces: [{ id: 'default', name: 'app', path: '/work/app' }],
    defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default', model: { providerId: 'deepseek', model: 'deepseek-chat' } },
  }
  const service = { providerId: 'openai', model: 'gpt-5.5-mini' }

  it("is the service model the person picked for that Harness, wherever the input box is now; none for the Harness's own", () => {
    const picks = withServicePick({}, service, 'model')!
    // Picked while Codex was the input's Harness, and remembered after another was chosen.
    expect(memberModel(catalog, { harnessId: 'codex', config: picks }, 'codex')).toEqual(service)
    expect(memberModel(catalog, { harnessId: 'standard', otherPicks: { codex: picks } }, 'codex')).toEqual(service)
    // Nothing picked: the Harness's own model, so nothing is sent.
    expect(memberModel(catalog, { harnessId: 'standard' }, 'codex')).toBeUndefined()
    expect(memberModel(catalog, null, 'codex')).toBeUndefined()
    expect(memberModel(catalog, null, 'gone')).toBeUndefined()
    expect(memberModel(undefined, null, 'codex')).toBeUndefined()
  })

  it('is the model a new session of Latch 内置 would use, which is always a service’s', () => {
    expect(memberModel(catalog, null, 'standard')).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
    expect(memberModel(catalog, { harnessId: 'codex', model: { providerId: 'openai', model: 'gpt-5.5' } }, 'standard')).toEqual({
      providerId: 'openai',
      model: 'gpt-5.5',
    })
  })
})
