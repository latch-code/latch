import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TEAM_LIMITS,
  TEAM_RETURN_ASK,
  TEAM_RETURN_HEADING,
  type AppSnapshot,
  type TaskDetail,
  type TeamAnswer,
  type TeamSummary,
  type WorkProposalSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import type { HarnessPlugin } from '@latch/sdk'
import { TEAM_CUT_MARK, teamReturnText, type TeamRecord } from '../src/teams.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SLOW = { timeout: 60_000 }
const WAIT = { timeout: 20_000, interval: 50 }

/** A Host with two Harnesses, `alpha` and `beta`: the fake ACP agent twice, each with its own record of sessions. */
async function fixture(directories?: { dataDir: string; workspaceRoot: string }, state?: string, demo = false) {
  const root = state ?? (await mkdtemp(join(tmpdir(), 'latch-teams-')))
  if (!state) cleanups.push(() => rm(root, { recursive: true, force: true }))
  const t = await startTestHost({ demo, ...directories })
  cleanups.push(() => t.close().catch(() => undefined))
  const owner = await t.enroll({ listener: 'unix' })
  const defined = (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.map(harness => harness.id) ?? []
  for (const id of ['alpha', 'beta'])
    if (!defined.includes(id))
      await owner.confirmedJson('agents', {
        body: {
          id,
          name: id === 'alpha' ? 'Alpha' : 'Beta',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, `${id}.json`), FAKE_ACP_CAPS: 'load,resume' },
        },
      })
  return { t, owner, root }
}

const detailOf = (device: TestDevice, sessionId: string) => device.json<TaskDetail>(`tasks/${sessionId}`)
const snapshotOf = (device: TestDevice) => device.json<AppSnapshot>('snapshot')
const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })

async function settled(device: TestDevice, sessionId: string): Promise<TaskDetail> {
  let detail: TaskDetail | undefined
  await vi.waitFor(async () => {
    detail = await detailOf(device, sessionId)
    expect(['idle', 'failed', 'cancelled']).toContain(detail.summary.status)
  }, WAIT)
  return detail!
}

/** A Code session on `alpha` whose first turn runs `prompt`, settled unless told otherwise. */
async function leadSession(owner: TestDevice, prompt = 'echo lead', body: Record<string, unknown> = {}, wait = true): Promise<string> {
  const response = await owner.confirmed('tasks', {
    method: 'POST',
    body: { requestId: randomUUID(), prompt, harnessId: 'alpha', mode: 'agent', ...body },
  })
  expect(response.status).toBe(201)
  const { sessionId } = (await response.json()) as { sessionId: string }
  if (wait) await settled(owner, sessionId)
  return sessionId
}

const task = (title: string, prompt: string, harnessId: string) => ({ title, prompt, harnessId })
const startTeam = (device: TestDevice, lead: string, body: Record<string, unknown>) =>
  device.request(`tasks/${lead}/team`, { method: 'POST', body: { requestId: randomUUID(), ...body } })
async function started(device: TestDevice, lead: string, body: Record<string, unknown>): Promise<TeamSummary> {
  const response = await startTeam(device, lead, body)
  const answer = (await response.json()) as TeamAnswer & { error?: string; message?: string }
  expect([response.status, answer.error, answer.message]).toEqual([201, undefined, undefined])
  return answer.team
}
const teamOf = async (device: TestDevice, id: string) => (await device.json<TeamAnswer>(`teams/${id}`)).team
async function teamIn(device: TestDevice, id: string, state: TeamSummary['state']): Promise<TeamSummary> {
  let team: TeamSummary | undefined
  await vi.waitFor(async () => {
    team = await teamOf(device, id)
    expect(team.state).toBe(state)
  }, WAIT)
  return team!
}
const userTexts = async (device: TestDevice, sessionId: string) =>
  (await detailOf(device, sessionId)).messages.flatMap(message => (message.role === 'user' ? [message.text] : []))
const returnsIn = async (device: TestDevice, sessionId: string) =>
  (await userTexts(device, sessionId)).filter(text => text.startsWith(TEAM_RETURN_HEADING))

async function allowAll(device: TestDevice, sessionIds: readonly string[]): Promise<void> {
  await vi.waitFor(async () => {
    const waiting = (await snapshotOf(device)).approvals.filter(approval => sessionIds.includes(approval.sessionId))
    expect(waiting.length).toBe(sessionIds.length)
    for (const approval of waiting)
      await device.confirmed(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
  }, WAIT)
}

async function audited(t: TestHost, action: string): Promise<Array<{ detail: Record<string, unknown> }>> {
  const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  return log
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
    .filter(entry => entry.action === action)
}

describe('a team started by a person', () => {
  it(
    'starts each task on its Harness at the same time, waits while they wait, and returns both results to the lead once',
    SLOW,
    async () => {
      const { t, owner } = await fixture()
      const lead = await leadSession(owner)
      expect((await snapshotOf(owner)).catalog?.features?.teams).toBe(true)
      const team = await started(owner, lead, {
        goal: '两头一起查',
        tasks: [task('查前端', 'permission', 'alpha'), task('查后端', 'permission', 'beta')],
      })
      expect(team).toMatchObject({ leadSessionId: lead, goal: '两头一起查', state: 'running' })
      expect(team.members.map(member => [member.title, member.harnessId])).toEqual([
        ['查前端', 'alpha'],
        ['查后端', 'beta'],
      ])
      const members = team.members.map(member => member.sessionId!)
      expect(members.every(Boolean)).toBe(true)

      // Both ask for approval at the same time: the team runs on, each member shown as waiting, nothing sent yet.
      await vi.waitFor(async () => {
        expect((await teamOf(owner, team.id)).members.map(member => member.state)).toEqual(['waiting', 'waiting'])
      }, WAIT)
      expect((await teamOf(owner, team.id)).state).toBe('running')
      expect(await returnsIn(owner, lead)).toEqual([])
      const snapshot = await snapshotOf(owner)
      expect(snapshot.teams?.map(row => row.id)).toEqual([team.id])
      for (const [index, id] of members.entries()) {
        const summary = snapshot.tasks.find(row => row.id === id)!
        expect(summary).toMatchObject({ teamOf: { teamId: team.id, leadSessionId: lead }, harnessId: index ? 'beta' : 'alpha' })
        // An ordinary 待办 holds each member.
        expect(snapshot.items?.find(item => item.id === team.members[index]!.itemId)?.sessionIds).toEqual([id])
      }

      // One open team per lead; a member cannot lead; the same request answers the same team.
      expect(await errorOf(await startTeam(owner, lead, { tasks: [task('再来', 'echo x', 'alpha')] }))).toEqual({
        status: 409,
        error: 'team-open',
      })
      expect(await errorOf(await startTeam(owner, members[0]!, { tasks: [task('套娃', 'echo x', 'alpha')] }))).toEqual({
        status: 409,
        error: 'team-lead',
      })

      await allowAll(owner, members)
      const done = await teamIn(owner, team.id, 'returned')
      expect(done.members.map(member => [member.state, member.said])).toEqual([
        ['done', 'allowed'],
        ['done', 'allowed'],
      ])
      const returns = await returnsIn(owner, lead)
      expect(returns).toHaveLength(1)
      expect(returns[0]).toContain('【查前端】（Alpha）：已完成\nallowed')
      expect(returns[0]).toContain('【查后端】（Beta）：已完成\nallowed')
      expect(returns[0]!.endsWith(TEAM_RETURN_ASK)).toBe(true)
      const detail = await settled(owner, lead)
      expect(detail.messages.find(message => message.id === done.returnedMessageId)?.text).toBe(returns[0])
      // Sent once: later looks send nothing more, and the lead's agent answered it.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      expect(await returnsIn(owner, lead)).toHaveLength(1)
      expect(detail.messages.at(-1)).toMatchObject({ role: 'assistant' })

      // The results are other agents' words: what the lead proposes from now on is marked as from outside content.
      await owner.json(`tasks/${lead}/prompt`, {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: `board ${JSON.stringify({ tool: 'propose_todo', args: { title: '后续', prompt: '把两边的结论合起来写进文档。' } })}`,
        },
      })
      await vi.waitFor(async () => {
        expect((await snapshotOf(owner)).workProposals?.find(row => row.from.sessionId === lead)).toMatchObject({ external: true })
      }, WAIT)

      expect((await audited(t, 'team.started')).map(entry => entry.detail)).toEqual([
        { teamId: team.id, leadSessionId: lead, members: 2, harnessIds: ['alpha', 'beta'] },
      ])
      expect((await audited(t, 'team.returned')).map(entry => entry.detail)).toMatchObject([
        { teamId: team.id, leadSessionId: lead, members: 2 },
      ])
      expect(await audited(t, 'work.item.started')).toHaveLength(2)
      // With that team ended, the lead may start the next.
      const next = await started(owner, lead, { tasks: [task('第二轮', 'echo again', 'beta')] })
      await teamIn(owner, next.id, 'returned')
      expect((await returnsIn(owner, lead)).at(-1)).toContain('echo: echo again')
    },
  )

  it("starts a group the lead's agent proposed, with an entry the person edited, on the Harness each names", SLOW, async () => {
    const { owner } = await fixture()
    const items = [
      { title: '读日志', prompt: 'echo logs', harness: 'beta' },
      { title: '读配置', prompt: 'echo config' },
      { title: '以后再说', prompt: 'echo later' },
    ]
    const lead = await leadSession(owner, `board ${JSON.stringify({ tool: 'propose_todos', args: { goal: '排查超时', items } })}`)
    let proposal: WorkProposalSummary | undefined
    await vi.waitFor(async () => {
      proposal = (await snapshotOf(owner)).workProposals?.find(row => row.from.sessionId === lead)
      expect(proposal?.entries).toHaveLength(3)
    }, WAIT)
    // Another session's proposal is not this lead's plan.
    const other = await leadSession(owner)
    expect(await errorOf(await startTeam(owner, other, { proposal: { id: proposal!.id, baseRevision: proposal!.revision } }))).toEqual({
      status: 409,
      error: 'team-proposal',
    })

    const team = await started(owner, lead, {
      proposal: {
        id: proposal!.id,
        baseRevision: proposal!.revision,
        entries: [{ index: 0 }, { index: 1, title: '读配置（改）', prompt: 'echo edited' }],
      },
    })
    expect(team).toMatchObject({ proposalId: proposal!.id, goal: '排查超时', messageId: proposal!.from.messageId })
    expect(team.members.map(member => [member.title, member.harnessId])).toEqual([
      ['读日志', 'beta'],
      ['读配置（改）', 'alpha'],
    ])
    const done = await teamIn(owner, team.id, 'returned')
    const [text] = await returnsIn(owner, lead)
    expect(text).toContain('【读日志】（Beta）：已完成\necho: echo logs')
    // Named by the start of its edited title, as nobody gave it a name.
    expect(text).toContain('【读配置】（Alpha）：已完成\necho: echo edited')
    // The entry not named still waits for the person; the two started are ordinary 待办 that record the proposal.
    const snapshot = await snapshotOf(owner)
    expect(snapshot.workProposals?.find(row => row.id === proposal!.id)?.entries?.map(entry => entry.state)).toEqual([
      'accepted',
      'accepted',
      'pending',
    ])
    for (const member of done.members)
      expect(snapshot.items?.find(item => item.id === member.itemId)).toMatchObject({
        from: { proposalId: proposal!.id, sessionId: lead },
        sessionIds: [member.sessionId],
      })
  })

  it('says in the return which member failed and which never started, and keeps no team when none starts', SLOW, async () => {
    const { owner } = await fixture()
    const lead = await leadSession(owner)
    const none = await startTeam(owner, lead, { tasks: [task('没有这个', 'echo x', 'nope')] })
    expect(await errorOf(none)).toEqual({ status: 409, error: 'harness-unavailable' })
    expect((await snapshotOf(owner)).teams).toBeUndefined()

    const team = await started(owner, lead, {
      tasks: [task('会崩的', 'crash', 'beta'), task('好的', 'echo fine', 'alpha'), task('没有这个', 'echo x', 'nope')],
    })
    expect(team.members[2]).toMatchObject({ state: 'unstarted', refusal: expect.stringContaining('nope') })
    expect(team.members[2]).not.toHaveProperty('sessionId')
    const done = await teamIn(owner, team.id, 'returned')
    expect(done.members.map(member => member.state)).toEqual(['failed', 'done', 'unstarted'])
    const [text] = await returnsIn(owner, lead)
    expect(text).toContain('【会崩的】（Beta）：失败了\n这个成员没有正常结束')
    expect(text).toContain('【好的】（Alpha）：已完成\necho: echo fine')
    expect(text).toContain('【没有这个】（nope）：没有开始')
  })

  it('waits with the results while the lead is busy, and sends them once it is idle', SLOW, async () => {
    const { owner } = await fixture()
    const lead = await leadSession(owner, 'endturn', {}, false)
    await vi.waitFor(async () => expect((await detailOf(owner, lead)).summary.status).toBe('running'), WAIT)
    const team = await started(owner, lead, { tasks: [task('快的', 'echo quick', 'beta')] })
    await teamIn(owner, team.id, 'returning')
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect((await teamOf(owner, team.id)).state).toBe('returning')
    expect(await returnsIn(owner, lead)).toEqual([])
    await owner.json(`tasks/${lead}/cancel`, { method: 'POST', body: {} })
    await teamIn(owner, team.id, 'returned')
    expect(await returnsIn(owner, lead)).toHaveLength(1)
  })

  it('stops: members still at work are cancelled, the results are kept and never sent', SLOW, async () => {
    const { t, owner } = await fixture()
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    const lead = await leadSession(owner)
    const team = await started(owner, lead, { tasks: [task('长活一', 'endturn', 'alpha'), task('长活二', 'endturn', 'beta')] })
    await vi.waitFor(async () => {
      expect((await teamOf(owner, team.id)).members.map(member => member.state)).toEqual(['running', 'running'])
    }, WAIT)
    expect((await viewer.request(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } })).status).toBe(403)
    const stopped = await owner.request(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(stopped.status).toBe(200)
    const kept = await teamIn(owner, team.id, 'kept')
    expect(kept).toMatchObject({ kept: 'stopped' })
    expect(kept.members.map(member => member.state)).toEqual(['cancelled', 'cancelled'])
    for (const member of kept.members) expect((await detailOf(owner, member.sessionId!)).summary.status).toBe('cancelled')
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(await returnsIn(owner, lead)).toEqual([])
    expect(await errorOf(await owner.request(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } }))).toEqual({
      status: 200,
      error: undefined,
    })
    expect((await audited(t, 'team.stopped')).map(entry => entry.detail)).toEqual([{ teamId: team.id }])
    expect((await audited(t, 'team.kept')).map(entry => entry.detail)).toEqual([{ teamId: team.id, reason: 'stopped' }])
  })

  it('refuses a list that is too long, empty words, both forms at once, and a device without run', SLOW, async () => {
    const { t, owner } = await fixture()
    const lead = await leadSession(owner)
    const many = Array.from({ length: TEAM_LIMITS.members + 1 }, (_, index) => task(`第 ${index} 个`, 'echo x', 'alpha'))
    for (const body of [
      { tasks: many },
      { tasks: [task('空的', '   ', 'alpha')] },
      { tasks: [task('太长', 'x'.repeat(TEAM_LIMITS.promptChars + 1), 'alpha')] },
      { tasks: [task('一', 'echo x', 'alpha')], proposal: { id: `wpp_${'A'.repeat(22)}`, baseRevision: 1 } },
      {},
    ])
      expect((await errorOf(await startTeam(owner, lead, body))).status).toBe(400)
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    expect((await startTeam(viewer, lead, { tasks: [task('一', 'echo x', 'alpha')] })).status).toBe(403)
    expect(await errorOf(await owner.request(`teams/tem_${'Z'.repeat(22)}`))).toEqual({ status: 404, error: 'team-not-found' })
    expect((await snapshotOf(owner)).teams).toBeUndefined()
    expect(await audited(t, 'team.started')).toEqual([])
  })
})

describe('what a member is called', () => {
  it('is the name it was given, or the start of its task; the results and the agent call it so', SLOW, async () => {
    const { owner } = await fixture()
    const lead = await leadSession(owner)
    const team = await started(owner, lead, {
      tasks: [
        { ...task('读一遍登录接口，记下超时的地方', 'echo login', 'alpha'), name: '登录排查' },
        task('核对回执：签名与顺序', 'echo receipt', 'beta'),
      ],
    })
    expect(team.members.map(member => [member.name, member.title])).toEqual([
      ['登录排查', '读一遍登录接口，记下超时的地方'],
      ['核对回执', '核对回执：签名与顺序'],
    ])
    await teamIn(owner, team.id, 'returned')
    const [text] = await returnsIn(owner, lead)
    expect(text).toContain('【登录排查】（Alpha）：已完成')
    expect(text).toContain('【核对回执】（Beta）：已完成')
  })
})

describe('the model a member runs on', () => {
  it("is the one the person chose for that member, checked as any session's is, and never the lead's", SLOW, async () => {
    const { owner } = await fixture()
    const lead = await leadSession(owner)
    // A service that does not exist: the member's own start refuses it, and the other member runs.
    const team = await started(owner, lead, {
      tasks: [
        { ...task('有模型', 'echo a', 'alpha'), model: { providerId: 'no-such-service', model: 'm' } },
        task('没写模型', 'echo b', 'beta'),
      ],
    })
    expect(team.members.map(member => member.state === 'unstarted')).toEqual([true, false])
    expect(team.members[0]!.refusal).toBeTruthy()
    const done = await teamIn(owner, team.id, 'returned')
    expect(done.members.map(member => member.state)).toEqual(['unstarted', 'done'])
  })

  it(
    "starts a member on its Harness's own choices, refuses one it does not offer or a permission pick, and runs the rest",
    SLOW,
    async () => {
      const { owner, root } = await fixture()
      // A Harness that reports its own model and thinking options.
      await owner.confirmedJson('agents', {
        body: {
          id: 'gamma',
          name: 'Gamma',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_EFFORT_BY_MODEL: '1', FAKE_ACP_STATE: join(root, 'gamma.json') },
        },
      })
      const lead = await leadSession(owner)
      const chosen = [
        { configId: 'model', value: 'large' },
        { configId: 'effort', value: 'max' },
      ]
      const team = await started(owner, lead, {
        tasks: [task('照常', 'echo a', 'alpha'), { ...task('大模型', 'echo b', 'gamma'), config: chosen }],
      })
      expect(team.members.map(member => member.state)).toEqual(['running', 'running'])
      const member = await settled(owner, team.members[1]!.sessionId!)
      expect(member.config?.map(option => [option.id, option.currentValue])).toEqual(
        expect.arrayContaining([
          ['model', 'large'],
          ['effort', 'max'],
        ]),
      )
      await teamIn(owner, team.id, 'returned')
      // The lead answers the results it was sent: nothing is left running for the next test.
      await vi.waitFor(async () => expect((await returnsIn(owner, lead)).length).toBe(1), WAIT)
      await settled(owner, lead)

      const lead2 = await leadSession(owner)
      const refused = await started(owner, lead2, {
        tasks: [
          // Latch 内置 takes no Harness options: its own start refuses them.
          { ...task('内置的选项', 'echo c', 'standard'), config: [{ configId: 'model', value: 'large' }] },
          { ...task('另选权限', 'echo d', 'gamma'), config: [{ configId: '~mode', value: 'plan' }] },
          { ...task('自己的默认', 'echo e', 'gamma'), ownModel: true },
          // A value the agent does not offer is known only once its session is up: that session fails before any turn.
          { ...task('没有的模型', 'echo f', 'gamma'), config: [{ configId: 'model', value: 'huge' }] },
        ],
      })
      expect(refused.members.map(one => one.state === 'unstarted')).toEqual([true, true, false, false])
      expect(refused.members[0]!.refusal).toContain('不能在开始前')
      expect(refused.members[1]!.refusal).toContain('权限')
      const after = await teamIn(owner, refused.id, 'returned')
      expect(after.members.map(one => one.state)).toEqual(['unstarted', 'unstarted', 'done', 'failed'])
      const unoffered = await detailOf(owner, after.members[3]!.sessionId!)
      expect(unoffered.config?.find(option => option.id === 'model')?.currentValue).toBe('small')
      expect(unoffered.messages.some(message => message.role === 'assistant')).toBe(false)
      await vi.waitFor(async () => expect((await returnsIn(owner, lead2)).length).toBe(1), WAIT)
      await settled(owner, lead2)
    },
  )

  it('refuses start choices out of bounds before anything starts', SLOW, async () => {
    const { owner } = await fixture()
    const lead = await leadSession(owner)
    const twice = {
      ...task('两次', 'echo a', 'alpha'),
      config: [
        { configId: 'model', value: 'a' },
        { configId: 'model', value: 'b' },
      ],
    }
    const many = {
      ...task('太多', 'echo a', 'alpha'),
      config: Array.from({ length: 17 }, (_, index) => ({ configId: `o${index}`, value: 'v' })),
    }
    for (const body of [{ tasks: [twice] }, { tasks: [many] }, { tasks: [{ ...task('不对', 'echo a', 'alpha'), ownModel: false }] }])
      expect(await errorOf(await startTeam(owner, lead, body))).toEqual({ status: 400, error: 'invalid-input' })
    expect((await snapshotOf(owner)).teams ?? []).toEqual([])
  })
})

describe('who reads a team, and as whom its results go back', () => {
  it("makes a private lead's members private and shows the team only to the full data scope", SLOW, async () => {
    const { t, owner } = await fixture()
    // Enrolled before anything runs: once the results go back the lead works on them in full access, which holds every
    // confirmation (a new device's too) until it settles.
    const devices = {
      work: await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' }),
      files: await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'files' }),
    }
    const lead = await leadSession(owner)
    const original = t.host.bridge.agentPrivate.bind(t.host.bridge)
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === lead || original(id))
    const team = await started(owner, lead, { tasks: [task('私下查', 'echo secret', 'beta')] })
    const done = await teamIn(owner, team.id, 'returned')
    const member = done.members[0]!.sessionId!
    expect(original(member)).toBe(true)
    expect((await returnsIn(owner, lead))[0]).toContain('echo: echo secret')
    expect((await snapshotOf(owner)).teams?.map(row => row.id)).toEqual([team.id])
    for (const dataScope of ['work', 'files'] as const) {
      const device = devices[dataScope]
      const snapshot = await snapshotOf(device)
      expect(snapshot.teams, dataScope).toBeUndefined()
      expect(JSON.stringify(snapshot), dataScope).not.toContain(team.id)
      expect(await errorOf(await device.request(`teams/${team.id}`)), dataScope).toEqual({ status: 404, error: 'team-not-found' })
      expect(
        await errorOf(await device.request(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } })),
        dataScope,
      ).toEqual({ status: 404, error: 'team-not-found' })
      expect((await startTeam(device, lead, { tasks: [task('一', 'echo x', 'alpha')] })).status, dataScope).toBe(403)
    }
  })

  it("keeps a member's reply out of a lead that is not private once the member is, and hides that member's session", SLOW, async () => {
    const { t, owner } = await fixture()
    // Before anything runs, as above: the lead's turn on the results would hold the new device's confirmation.
    const device = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
    const lead = await leadSession(owner)
    const team = await started(owner, lead, { tasks: [task('会变私有', 'permission', 'beta'), task('公开的', 'echo open', 'alpha')] })
    const secret = team.members[0]!.sessionId!
    // A member of a lead that is not private starts without private context, so its reply can go back.
    expect(t.host.bridge.agentPrivate(secret)).toBe(false)
    const original = t.host.bridge.agentPrivate.bind(t.host.bridge)
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === secret || original(id))
    await allowAll(owner, [secret])
    await teamIn(owner, team.id, 'returned')
    const [text] = await returnsIn(owner, lead)
    expect(text).toContain('【会变私有】（Beta）：已完成\n它的会话是私有的，结果没有带回')
    expect(text).not.toContain('allowed')
    expect(text).toContain('echo: echo open')
    const seen = (await snapshotOf(device)).teams?.find(row => row.id === team.id)
    expect(seen?.members[0]).toEqual(expect.not.objectContaining({ sessionId: expect.anything(), said: expect.anything() }))
    expect(seen?.members[1]).toMatchObject({ sessionId: team.members[1]!.sessionId, said: 'echo: echo open' })
  })

  it('keeps the results when the device that started the team is removed, or the lead is archived', SLOW, async () => {
    const { t, owner } = await fixture()
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    const lead = await leadSession(owner)
    const team = await started(phone, lead, { tasks: [task('等批准', 'permission', 'beta')] })
    const member = team.members[0]!.sessionId!
    await vi.waitFor(async () => expect((await teamOf(owner, team.id)).members[0]!.state).toBe('waiting'), WAIT)
    expect((await owner.request(`devices/${phone.id}`, { method: 'DELETE', body: {} })).status).toBe(200)
    await allowAll(owner, [member])
    expect(await teamIn(owner, team.id, 'kept')).toMatchObject({ kept: 'device-removed', members: [{ state: 'done', said: 'allowed' }] })
    expect(await returnsIn(owner, lead)).toEqual([])

    const other = await leadSession(owner)
    const second = await started(owner, other, { tasks: [task('等批准', 'permission', 'alpha')] })
    await vi.waitFor(async () => expect((await teamOf(owner, second.id)).members[0]!.state).toBe('waiting'), WAIT)
    await owner.json(`tasks/${other}`, { method: 'PATCH', body: { archived: true } })
    await allowAll(owner, [second.members[0]!.sessionId!])
    expect(await teamIn(owner, second.id, 'kept')).toMatchObject({ kept: 'lead-gone' })
    expect(await returnsIn(owner, other)).toEqual([])
    expect((await audited(t, 'team.kept')).map(entry => entry.detail.reason)).toEqual(['device-removed', 'lead-gone'])
    expect(await audited(t, 'team.returned')).toEqual([])
  })

  it('takes an open team up again after a restart and returns its results once', SLOW, async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-teams-restart-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const directories = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    await mkdir(directories.workspaceRoot, { recursive: true })
    const { t, owner } = await fixture(directories, root)
    const lead = await leadSession(owner)
    const team = await started(owner, lead, { tasks: [task('做完的', 'echo before', 'beta'), task('没做完的', 'permission', 'alpha')] })
    await vi.waitFor(async () => {
      expect((await teamOf(owner, team.id)).members.map(member => member.state)).toEqual(['done', 'waiting'])
    }, WAIT)
    await t.host.close()
    const stored = JSON.parse(await readFile(join(directories.dataDir, 'work', 'teams.json'), 'utf8')) as { teams: TeamRecord[] }
    expect(stored.teams).toMatchObject([{ id: team.id, state: 'running', actor: { deviceId: owner.id } }])
    expect((await stat(join(directories.dataDir, 'work', 'teams.json'))).mode & 0o777).toBe(0o600)

    const again = await fixture(directories, root)
    const done = await teamIn(again.owner, team.id, 'returned')
    // The run the Host's stop cut short ended nobody knows how; the one that had finished kept its result.
    expect(done.members.map(member => member.state)).toEqual(['done', 'unknown'])
    const returns = await returnsIn(again.owner, lead)
    expect(returns).toHaveLength(1)
    expect(returns[0]).toContain('【做完的】（Beta）：已完成\necho: echo before')
    expect(returns[0]).toContain('【没做完的】（Alpha）：结束方式未知')
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(await returnsIn(again.owner, lead)).toHaveLength(1)
    expect((await snapshotOf(again.owner)).tasks.find(row => row.id === done.members[0]!.sessionId)?.teamOf).toEqual({
      teamId: team.id,
      leadSessionId: lead,
    })
  })

  it('gives each member a new worktree of its own when the project takes them', SLOW, async () => {
    const { t, owner } = await fixture()
    const project = join(t.root, 'studio')
    await mkdir(project)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: project, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    await writeFile(join(project, 'README.md'), '# studio\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    expect((await owner.addFolders({ paths: [project] })).ok).toBe(true)
    const workspaceId = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item =>
      item.path.endsWith('/studio'),
    )!.id
    const lead = await leadSession(owner, 'echo lead', { workspaceId })
    const team = await started(owner, lead, { tasks: [task('一', 'echo one', 'alpha'), task('二', 'echo two', 'beta')] })
    await teamIn(owner, team.id, 'returned')
    const tasks = (await snapshotOf(owner)).tasks
    const members = team.members.map(member => tasks.find(row => row.id === member.sessionId)!)
    for (const member of members) expect(member).toMatchObject({ workspaceId, worktree: { branch: expect.stringMatching(/^latch\//u) } })
    expect(new Set(members.map(member => member.cwd)).size).toBe(2)
    expect(tasks.find(row => row.id === lead)).not.toHaveProperty('worktree')
    // The lead is told where each member's changes are.
    const [sent] = await returnsIn(owner, lead)
    for (const member of members) expect(sent).toContain(`它的改动在分支 ${member.worktree!.branch} 上`)
  })
})

describe('a project whose worktree cannot be made now', () => {
  it('refuses each member with the reason, never the shared folder; the same request goes through once it can', SLOW, async () => {
    const { t, owner } = await fixture()
    const project = join(t.root, 'fresh')
    await mkdir(project)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: project, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    expect((await owner.addFolders({ paths: [project] })).ok).toBe(true)
    const workspaceId = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item =>
      item.path.endsWith('/fresh'),
    )!.id
    const items = [
      { title: '一', prompt: 'echo one' },
      { title: '二', prompt: 'echo two', harness: 'beta' },
    ]
    const lead = await leadSession(owner, `board ${JSON.stringify({ tool: 'propose_todos', args: { goal: '两件事', items } })}`, {
      workspaceId,
    })
    let proposal: WorkProposalSummary | undefined
    await vi.waitFor(async () => {
      proposal = (await snapshotOf(owner)).workProposals?.find(row => row.from.sessionId === lead)
      expect(proposal?.entries).toHaveLength(2)
    }, WAIT)
    const body = { requestId: randomUUID(), proposal: { id: proposal!.id, baseRevision: proposal!.revision } }
    const send = () => owner.request(`tasks/${lead}/team`, { method: 'POST', body })
    // A repository with no commit yet: no member starts, so no team is kept; the 待办 stay, unstarted.
    expect(await errorOf(await send())).toEqual({ status: 409, error: 'worktree-no-commit' })
    const refused = await snapshotOf(owner)
    expect(refused.teams).toBeUndefined()
    expect(refused.items?.map(item => [item.title, item.sessionIds])).toEqual([
      ['一', []],
      ['二', []],
    ])
    await writeFile(join(project, 'README.md'), '# fresh\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    const again = await send()
    expect(again.status).toBe(201)
    const { team } = (await again.json()) as TeamAnswer
    expect(team.members.map(member => [member.title, member.harnessId, member.state])).toEqual([
      ['一', 'alpha', 'running'],
      ['二', 'beta', 'running'],
    ])
    await teamIn(owner, team.id, 'returned')
    const after = await snapshotOf(owner)
    expect(after.items).toHaveLength(2)
    for (const member of team.members)
      expect(after.tasks.find(row => row.id === member.sessionId)).toMatchObject({
        worktree: { branch: expect.stringMatching(/^latch\//u) },
      })
    // The same request once more answers the same team.
    expect(((await (await send()).json()) as TeamAnswer).team.id).toBe(team.id)
  })
})

describe('the words sent to the lead', () => {
  const member = (title: string, reply: string, extra: Partial<TeamRecord['members'][number]> = {}) => ({
    itemId: `itm_${'A'.repeat(22)}`,
    sessionId: title,
    title,
    harnessId: 'alpha',
    state: 'done' as const,
    result: reply,
    ...extra,
  })

  it('keeps the end of a long reply and says it was cut, and always fits one message', () => {
    const cut = teamReturnText(
      { members: [member('长的', 'x'.repeat(TEAM_LIMITS.resultChars - 3) + 'END', { resultCut: true })] },
      id => id,
    )
    expect(cut).toContain(`【长的】（alpha）：已完成\n${TEAM_CUT_MARK}\nx`)
    expect(cut).toContain('END\n\n' + TEAM_RETURN_ASK)
    const full = Array.from({ length: TEAM_LIMITS.members }, (_, index) =>
      member(`成员 ${index}`.padEnd(120, '题'), 'y'.repeat(TEAM_LIMITS.resultChars - 1) + 'Z'),
    )
    const text = teamReturnText({ members: full }, () => 'H'.repeat(64))
    expect(text.length).toBeLessThan(16_000)
    expect(text.startsWith(TEAM_RETURN_HEADING)).toBe(true)
    expect(text.match(/Z\n/gu)).toHaveLength(TEAM_LIMITS.members)
  })
})

/**
 * The same Host with the demo model, so a member can be on Latch 内置 (`standard`, L1) beside the ACP Harnesses (L3). An
 * agent round runs on either: the person who turned the switch on trusts the members, whatever their level.
 */
const unattendedFixture = () => fixture(undefined, undefined, true)
const DEMO_SAID = '当前为演示模式。'

const round = (device: TestDevice, teamId: string, sends: Array<{ itemId: string; prompt: string }>, requestId = randomUUID()) =>
  device.request(`teams/${teamId}/rounds`, { method: 'POST', body: { requestId, sends } })
const dispatchSwitch = (device: TestDevice, teamId: string, agentDispatch: boolean) =>
  device.request(`teams/${teamId}`, { method: 'PATCH', body: { agentDispatch } })
const say = async (device: TestDevice, sessionId: string, prompt: string): Promise<string> => {
  await device.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt } })
  const detail = await settled(device, sessionId)
  return detail.messages.findLast(message => message.role === 'assistant')?.text ?? ''
}

describe('later rounds on an existing team', () => {
  it("sends a person's round to two members, refuses a busy member and a second open round, and returns once per round", SLOW, async () => {
    const { t, owner } = await fixture()
    const lead = await leadSession(owner)
    const team = await started(owner, lead, { tasks: [task('一', 'echo one', 'alpha'), task('二', 'echo two', 'beta')] })
    const first = await teamIn(owner, team.id, 'returned')
    expect(first).not.toHaveProperty('round')
    const [m1, m2] = team.members.map(member => member.itemId) as [string, string]
    const [s1, s2] = team.members.map(member => member.sessionId!) as [string, string]

    // A member the person is talking to right now takes no round: refused, never queued.
    await owner.json(`tasks/${s1}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: 'endturn' } })
    await vi.waitFor(async () => expect((await detailOf(owner, s1)).summary.status).toBe('running'), WAIT)
    expect(await errorOf(await round(owner, team.id, [{ itemId: m1, prompt: 'echo again' }]))).toEqual({
      status: 409,
      error: 'team-member-busy',
    })
    await owner.json(`tasks/${s1}/cancel`, { method: 'POST', body: {} })
    await settled(owner, s1)

    const requestId = randomUUID()
    const sends = [
      { itemId: m1, prompt: 'echo second one' },
      { itemId: m2, prompt: 'permission' },
    ]
    const made = await round(owner, team.id, sends, requestId)
    expect(made.status).toBe(201)
    const open = ((await made.json()) as TeamAnswer).team
    expect(open).toMatchObject({ state: 'running', round: 2 })
    expect(open.rounds?.map(row => [row.round, row.by, row.state])).toEqual([
      [1, 'person', 'returned'],
      [2, 'person', 'running'],
    ])
    // The same request again answers the same round; another while it is open is refused.
    const again = await round(owner, team.id, sends, requestId)
    expect([again.status, ((await again.json()) as TeamAnswer).team.round]).toEqual([200, 2])
    expect(await errorOf(await round(owner, team.id, [{ itemId: m1, prompt: 'echo three' }]))).toEqual({
      status: 409,
      error: 'team-round-open',
    })
    expect(await errorOf(await round(owner, team.id, sends, requestId).then(() => round(owner, team.id, [sends[0]!], requestId)))).toEqual({
      status: 409,
      error: 'request-conflict',
    })
    await vi.waitFor(
      async () => expect((await teamOf(owner, team.id)).members.map(member => member.state)).toEqual(['done', 'waiting']),
      WAIT,
    )
    expect(await returnsIn(owner, lead)).toHaveLength(1)
    await allowAll(owner, [s2])
    const second = await teamIn(owner, team.id, 'returned')
    const returns = await returnsIn(owner, lead)
    expect(returns).toHaveLength(2)
    expect(returns[1]).toContain('【一】（Alpha）：已完成\necho: echo second one')
    expect(returns[1]).toContain('【二】（Beta）：已完成\nallowed')
    expect(returns[1]).not.toContain('echo: echo one')
    expect(second.rounds?.map(row => row.returnedMessageId)).toEqual([first.returnedMessageId, second.returnedMessageId])
    expect(second.returnedMessageId).not.toBe(first.returnedMessageId)
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(await returnsIn(owner, lead)).toHaveLength(2)

    // A round to one member: only it is in the round, and only it is in what goes back.
    await settled(owner, lead)
    const third = ((await (await round(owner, team.id, [{ itemId: m2, prompt: 'echo third two' }])).json()) as TeamAnswer).team
    expect(third.round).toBe(3)
    expect(third.rounds?.at(-1)?.members.map(member => member.itemId)).toEqual([m2])
    await teamIn(owner, team.id, 'returned')
    const last = (await returnsIn(owner, lead)).at(-1)!
    expect(last).toContain('【二】（Beta）：已完成\necho: echo third two')
    expect(last).not.toContain('【一】')
    expect((await audited(t, 'team.round.started')).map(entry => entry.detail)).toEqual([
      { teamId: team.id, round: 2, by: 'person', members: 2 },
      { teamId: team.id, round: 3, by: 'person', members: 1 },
    ])
    // The person's own words are not outside content to the member.
    expect((await detailOf(owner, s1)).messages.find(message => message.text === 'echo second one')).not.toHaveProperty('origin')
  })

  it('reopens a stopped team, refuses a member outside the team, a device without run, and empty prompts', SLOW, async () => {
    const { t, owner } = await fixture()
    const lead = await leadSession(owner)
    const team = await started(owner, lead, { tasks: [task('长活', 'endturn', 'alpha')] })
    await vi.waitFor(async () => expect((await teamOf(owner, team.id)).members[0]!.state).toBe('running'), WAIT)
    await owner.json(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } })
    await teamIn(owner, team.id, 'kept')
    const member = team.members[0]!.itemId
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    expect((await round(viewer, team.id, [{ itemId: member, prompt: 'echo x' }])).status).toBe(403)
    expect(await errorOf(await round(owner, team.id, [{ itemId: `itm_${'B'.repeat(22)}`, prompt: 'echo x' }]))).toEqual({
      status: 404,
      error: 'team-member-not-found',
    })
    expect((await round(owner, team.id, [{ itemId: member, prompt: '   ' }])).status).toBe(400)
    expect((await round(owner, team.id, [])).status).toBe(400)
    const reopened = ((await (await round(owner, team.id, [{ itemId: member, prompt: 'echo back' }])).json()) as TeamAnswer).team
    expect(reopened).toMatchObject({ round: 2, state: 'running' })
    expect(reopened).not.toHaveProperty('kept')
    await teamIn(owner, team.id, 'returned')
    expect((await returnsIn(owner, lead)).at(-1)).toContain('echo: echo back')
  })

  it('keeps the switch off by default; on is audited first, and it goes off when the device that allowed it is removed', SLOW, async () => {
    const { t, owner } = await unattendedFixture()
    // Every device before the team: once a return is back the lead runs in full access and enrolling waits.
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    const lead = await leadSession(owner)
    const team = await started(owner, lead, { tasks: [task('一', '写一句问候', 'standard')] })
    await teamIn(owner, team.id, 'returned')
    expect(await teamOf(owner, team.id)).not.toHaveProperty('agentDispatch')
    expect((await dispatchSwitch(viewer, team.id, true)).status).toBe(403)
    expect(await audited(t, 'team.dispatch.allowed')).toEqual([])

    const on = await dispatchSwitch(phone, team.id, true)
    expect([on.status, ((await on.json()) as TeamAnswer).team.agentDispatch]).toEqual([200, true])
    expect((await audited(t, 'team.dispatch.allowed')).map(entry => entry.detail)).toEqual([{ teamId: team.id, leadSessionId: lead }])
    expect((await owner.request(`devices/${phone.id}`, { method: 'DELETE', body: {} })).status).toBe(200)
    await vi.waitFor(async () => expect(await teamOf(owner, team.id)).not.toHaveProperty('agentDispatch'), WAIT)
    expect((await audited(t, 'team.dispatch.ended')).map(entry => entry.detail)).toEqual([{ teamId: team.id, reason: 'device-removed' }])

    // Off by the person, and by stopping the team.
    expect((await dispatchSwitch(owner, team.id, true)).status).toBe(200)
    expect(((await (await dispatchSwitch(owner, team.id, false)).json()) as TeamAnswer).team).not.toHaveProperty('agentDispatch')
    expect((await audited(t, 'team.dispatch.ended')).map(entry => entry.detail.reason)).toEqual(['device-removed', 'person'])

    // Stopping a round takes the switch back with it.
    expect((await dispatchSwitch(owner, team.id, true)).status).toBe(200)
    expect((await round(owner, team.id, [{ itemId: team.members[0]!.itemId, prompt: '运行 30 秒长任务' }])).status).toBe(201)
    expect((await owner.request(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } })).status).toBe(200)
    await teamIn(owner, team.id, 'kept')
    expect(await teamOf(owner, team.id)).not.toHaveProperty('agentDispatch')
    await vi.waitFor(async () => {
      expect((await audited(t, 'team.dispatch.ended')).map(entry => entry.detail.reason)).toEqual(['device-removed', 'person', 'stopped'])
    }, WAIT)
  })

  it(
    "lets the lead's agent send a round through its channel only while the switch is on, as outside content, and returns it",
    SLOW,
    async () => {
      const { t, owner } = await unattendedFixture()
      const lead = await leadSession(owner)
      const team = await started(owner, lead, { tasks: [task('一', '写一句问候', 'standard'), task('二', 'echo two', 'alpha')] })
      await teamIn(owner, team.id, 'returned')
      await settled(owner, lead)
      const call = (args: unknown) => say(owner, lead, `mcp latch-skills send_to_members ${JSON.stringify(args)}`)

      // Off: the tools are not listed and a call is refused, with nothing sent.
      expect(await say(owner, lead, 'mcp-list latch-skills')).not.toContain('send_to_members')
      expect(await call({ sends: [{ member: 'm1', prompt: '再写一句' }] })).toContain('error: The user has not let you')
      expect((await teamOf(owner, team.id)).round).toBeUndefined()

      expect((await dispatchSwitch(owner, team.id, true)).status).toBe(200)
      // The live server lists them once the roster is beside it: no new session needed.
      await vi.waitFor(async () => expect(await say(owner, lead, 'mcp-list latch-skills')).toContain('list_members,send_to_members'), WAIT)
      const roster = await say(owner, lead, 'mcp latch-skills list_members')
      expect(roster).toContain('"id":"m1","name":"一","title":"一","harness":"Latch 内置","state":"done"')
      expect(roster).toContain('"id":"m2","name":"二","title":"二","harness":"Alpha","state":"done"')

      // Refused by the Host: a member not in the team. Nothing is sent.
      expect(await call({ sends: [{ member: 'm3', prompt: 'echo nobody' }] })).toContain('m3 is not a member of this team')
      expect((await teamOf(owner, team.id)).round).toBeUndefined()

      const answer = await call({ sends: [{ member: 'm1', prompt: '请再写一句问候' }] })
      expect(answer).toContain('ok: Sent as round 2.')
      const done = await teamIn(owner, team.id, 'returned')
      expect(done.rounds?.at(-1)).toMatchObject({ round: 2, by: 'agent', members: [{ itemId: team.members[0]!.itemId, state: 'done' }] })
      const back = (await returnsIn(owner, lead)).at(-1)!
      expect(back).toContain(`【一】（Latch 内置）：已完成\n${DEMO_SAID}`)
      expect(back).not.toContain('【二】')
      // The member got it as outside content: what it proposes from now on is external.
      const member = done.members[0]!.sessionId!
      expect((await detailOf(owner, member)).messages.some(message => message.role === 'user' && message.text === '请再写一句问候')).toBe(
        true,
      )
      expect((await audited(t, 'team.round.started')).map(entry => entry.detail)).toEqual([
        { teamId: team.id, round: 2, by: 'agent', members: 1 },
      ])
      // Stopping the team takes the switch back.
      await settled(owner, lead)
      expect(
        (
          (await (await owner.request(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } })).json()) as {
            error?: string
          }
        ).error,
      ).toBe('team-ended')
    },
  )

  it('lets the agent send to members on any Harness once allowed, and refuses a round past the cap', SLOW, async () => {
    const { owner } = await unattendedFixture()
    const lead = await leadSession(owner)
    const team = await started(owner, lead, { tasks: [task('一', 'echo one', 'alpha')] })
    await teamIn(owner, team.id, 'returned')
    // Only an L3 member, past the unattended ceiling: the switch goes on all the same, and the agent's round runs.
    expect((await teamOf(owner, team.id)).dispatchRefusal).toBeUndefined()
    expect((await dispatchSwitch(owner, team.id, true)).status).toBe(200)
    await settled(owner, lead)
    expect(
      await say(owner, lead, `mcp latch-skills send_to_members ${JSON.stringify({ sends: [{ member: 'm1', prompt: 'echo agent one' }] })}`),
    ).toContain('Sent as round 2.')
    expect((await teamIn(owner, team.id, 'returned')).rounds?.at(-1)).toMatchObject({ round: 2, by: 'agent' })
    await settled(owner, lead)

    const other = await leadSession(owner)
    const capped = await started(owner, other, { tasks: [task('一', '写一句问候', 'standard')] })
    await teamIn(owner, capped.id, 'returned')
    expect((await dispatchSwitch(owner, capped.id, true)).status).toBe(200)
    const send = (prompt: string) =>
      say(owner, other, `mcp latch-skills send_to_members ${JSON.stringify({ sends: [{ member: 'm1', prompt }] })}`)
    // No cap on the agent's rounds: past the old six, it keeps sending.
    for (let index = 0; index < 7; index++) {
      await settled(owner, other)
      expect(await send(`第 ${index} 句问候`)).toContain(`Sent as round ${index + 2}.`)
      await teamIn(owner, capped.id, 'returned')
    }
  })

  it('gives the built-in Harness the same tools while the switch is on, and its call makes a round', SLOW, async () => {
    const seen: string[][] = []
    const answers: string[] = []
    const plugin: HarnessPlugin = {
      id: 'team-provider',
      name: 'fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'team-provider',
          name: 'fixture',
          model: 'fixture',
          async *stream({ messages, tools }) {
            seen.push(tools.map(tool => tool.name))
            const last = messages.at(-1)
            if (last?.role === 'tool') answers.push(JSON.stringify(last))
            // A member asked to propose: whether it is marked external says how its turn was sent.
            if (last?.role === 'user' && JSON.stringify(last).includes('propose now') && tools.some(tool => tool.name === 'propose_todo')) {
              yield {
                type: 'tool-call',
                call: { id: `call-${randomUUID()}`, name: 'propose_todo', arguments: { title: '后续', prompt: '把结论写进文档。' } },
              }
              yield { type: 'finish', reason: 'tool-calls' }
              return
            }
            if (last?.role === 'user' && JSON.stringify(last).includes('dispatch it')) {
              yield {
                type: 'tool-call',
                call: {
                  id: `call-${randomUUID()}`,
                  name: 'send_to_members',
                  arguments: { sends: [{ member: 'm1', prompt: 'propose now' }] },
                },
              }
              yield { type: 'finish', reason: 'tool-calls' }
              return
            }
            yield { type: 'text', text: 'ok' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const t = await startTestHost({ plugins: [plugin] })
    cleanups.push(() => t.close())
    const owner = await t.enroll({ listener: 'unix' })
    const model = { providerId: 'team-provider', model: 'fixture' }
    const lead = await leadSession(owner, 'hello', { harnessId: 'standard', model })
    const team = await started(owner, lead, { tasks: [{ ...task('一', '写一句问候', 'standard'), model }] })
    await teamIn(owner, team.id, 'returned')
    await settled(owner, lead)
    const member = team.members[0]!.sessionId!
    const proposals = async () => ((await snapshotOf(owner)).workProposals ?? []).filter(row => row.from.sessionId === member)
    // A person's round is the person's words: what the member proposes from it is not outside content.
    expect((await round(owner, team.id, [{ itemId: team.members[0]!.itemId, prompt: 'propose now' }])).status).toBe(201)
    await teamIn(owner, team.id, 'returned')
    await vi.waitFor(async () => expect(await proposals()).toHaveLength(1), WAIT)
    expect((await proposals())[0]!.external).toBeUndefined()
    await settled(owner, lead)
    expect(seen.flat()).not.toContain('send_to_members')
    expect((await dispatchSwitch(owner, team.id, true)).status).toBe(200)
    // The tools of the run that 'dispatch it' started: the run the returned results start may already have come after it.
    const from = seen.length
    await say(owner, lead, 'dispatch it')
    expect(seen[from]).toEqual(expect.arrayContaining(['list_members', 'send_to_members']))
    expect(answers.at(-1)).toContain('Sent as round 3.')
    const done = await teamIn(owner, team.id, 'returned')
    expect(done.rounds?.at(-1)).toMatchObject({ round: 3, by: 'agent' })
    // The agent's words reach the member as outside content: what it proposes from them is external.
    await vi.waitFor(async () => expect(await proposals()).toHaveLength(2), WAIT)
    expect((await proposals()).filter(row => row.external)).toHaveLength(1)
    expect((await returnsIn(owner, lead)).at(-1)).toContain('【一】（Latch 内置）：已完成\nok')
  })
})
