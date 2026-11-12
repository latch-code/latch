import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AutomationConfig, ChangedFile, Message, TaskDetail, TaskSummary } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { Automations, type AutomationPlan, type ResultContent, type SettledRun } from '../src/automations.ts'
import { activityPage, currentTopic, libraryPage, parseCursor, resultContent } from '../src/agent-activity.ts'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { AgentActor } from '../src/custom-agents.ts'

const roots: string[] = []
const services: Automations[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const actor: AgentActor = { actor: { deviceId: 'dev_owner', listener: 'unix' }, authorize: () => {} }
const AGENT = 'agt_00000000-0000-4000-8000-000000000001'
const definition = (overrides: Partial<AutomationConfig> = {}) => ({
  requestId: randomUUID(),
  name: '早间精选',
  customAgentId: AGENT,
  prompt: '整理昨天的新闻',
  schedule: { kind: 'daily' as const, time: '09:00' },
  notify: false,
  ...overrides,
})
const detailOf = (id: string, patch: Partial<TaskSummary> = {}, messages: Partial<Message>[] = []) =>
  ({
    summary: { id, title: '', status: 'idle', updatedAt: '', runOutcome: 'completed', ...patch },
    messages: messages.map((message, index) => ({ id: `m${index}`, role: 'assistant', text: '', ...message })),
    approvals: [],
  }) as unknown as TaskDetail

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-results-'))
  roots.push(dataDir)
  const f = {
    dataDir,
    clock: Date.parse('2026-11-02T08:00:00Z'),
    outcome: 'completed' as TaskSummary['runOutcome'],
    startFailure: undefined as Error | undefined,
    /** Sessions that no longer exist, for the check after a start; `null`: the sessions cannot be read yet. */
    missing: new Set<string>() as Set<string> | null,
    /** The next write of the file fails. */
    failWrite: false,
    content: vi.fn(async (_run: SettledRun): Promise<ResultContent> => ({ topicId: 'topic-1', reply: '三条新闻' })),
    changedTopics: vi.fn((_topics: string[]) => {}),
    start: vi.fn(async (): Promise<{ sessionId: string }> => {
      if (f.startFailure) throw f.startFailure
      return { sessionId: `run-${randomUUID()}` }
    }),
    open: () =>
      Automations.open({
        dataDir,
        audit: { append: vi.fn(async () => undefined as never) },
        now: () => f.clock,
        timeZone: () => 'UTC',
        plan: (): AutomationPlan => ({ basis: '1'.repeat(64), persistent: true, harnessId: 'standard', mode: 'agent' }),
        authorize: () => {},
        start: f.start,
        detail: async id => detailOf(id, { runOutcome: f.outcome }),
        cancel: async () => {},
        approvalTtlMs: () => 3_600_000,
        changed: () => {},
        resultContent: f.content,
        resultsChanged: f.changedTopics,
        exists: async id => {
          if (f.missing === null) throw new Error('not ready')
          return !f.missing.has(id)
        },
        atomicFs: {
          open: (path, flags, mode) => open(path, flags, mode),
          rename: async (from, to) => {
            if (f.failWrite) {
              f.failWrite = false
              throw new Error('disk full')
            }
            await rename(from, to)
          },
        },
      }),
  }
  const service = await f.open()
  services.push(service)
  return { f, service }
}

describe('result cards', () => {
  test('a run that settles is delivered once into the current topic, also across a restart', async () => {
    const { f, service } = await fixture()
    const { value } = await service.create(definition(), actor)
    f.clock = Date.parse('2026-11-02T09:00:05Z')
    await service.tick()
    await service.tick()
    const [card, ...rest] = service.results()
    expect(rest).toEqual([])
    expect(card).toMatchObject({
      automationId: value.id,
      owner: AGENT,
      name: '早间精选',
      outcome: 'completed',
      trigger: 'schedule',
      runAt: '2026-11-02T09:00:00.000Z',
      topicId: 'topic-1',
      reply: '三条新闻',
    })
    // The ID is the run's own: the schedule and the attempt of that slot, never a random one.
    const attempt = sha256Hex(canonicalJson(['automation', value.id, '2026-11-02T09:00:00.000Z']))
    expect(card!.id).toBe(`res_${sha256Hex(canonicalJson(['result', value.id, attempt])).slice(0, 40)}`)
    expect(card!.sessionId).toBe(service.get(value.id).lastRun?.sessionId)
    expect(f.content.mock.calls[0]![0]).toMatchObject({ owner: AGENT, automationId: value.id, outcome: 'completed' })
    expect(f.changedTopics).toHaveBeenCalledWith(['topic-1'])
    expect(service.resultsIn('topic-1')).toEqual([card])
    expect(service.resultStates()).toEqual({ [AGENT]: { unbound: 0, at: card!.at } })
    // The same card after a restart, never a second.
    await service.close()
    services.splice(0)
    const again = await f.open()
    services.push(again)
    await again.tick()
    expect(again.results()).toEqual([card])
    const file = JSON.parse(await readFile(join(f.dataDir, 'automations.json'), 'utf8'))
    expect(file.results).toHaveLength(1)
    // The same run settling again (its attempt still open on disk, as after a stop mid-way) keeps the one card.
    await again.close()
    services.splice(0)
    const row = file.rows[0]
    row.attempt = { requestId: attempt, sessionId: card!.sessionId }
    row.automation.state = 'running'
    await writeFile(join(f.dataDir, 'automations.json'), JSON.stringify(file), { mode: 0o600 })
    const third = await f.open()
    services.push(third)
    await third.tick()
    expect(third.get(value.id).state).toBe('ready')
    expect(third.results().map(item => item.id)).toEqual([card!.id])
  })

  test.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted'],
    [undefined, 'unknown'],
  ] as const)('a run that ended %s gets a %s card with its reason', async (runOutcome, outcome) => {
    const { f, service } = await fixture()
    f.outcome = runOutcome
    f.content.mockResolvedValue({ failure: { reason: '模型服务拒绝了密钥', code: 'http-401' } })
    const { value } = await service.create(definition(), actor)
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    await service.tick()
    expect(service.results()).toEqual([
      expect.objectContaining({ outcome, trigger: 'manual', failure: { reason: '模型服务拒绝了密钥', code: 'http-401' } }),
    ])
    // Without a topic it waits for the owner's next one.
    expect(service.resultsOf(AGENT, null)).toHaveLength(1)
    expect(service.resultStates()[AGENT]?.unbound).toBe(1)
  })

  test('a start that is refused is a failed card with the Host reason, and a missed time is none', async () => {
    const { f, service } = await fixture()
    f.content.mockImplementation(async run => resultContent('failed', undefined, undefined, run.refused))
    const { value } = await service.create(definition(), actor)
    f.startFailure = new AppError(409, 'agent-unavailable', '默认项目已移除')
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    expect(service.results()).toEqual([
      expect.objectContaining({ outcome: 'failed', failure: { reason: '默认项目已移除', code: 'agent-unavailable' } }),
    ])
    expect(service.results()[0]).not.toHaveProperty('sessionId')
    const other = (await service.create(definition({ name: '晚间' }), actor)).value
    f.startFailure = new AppError(409, 'host-updating', '正在更新')
    await service.runNow(other.id, { requestId: randomUUID() }, actor)
    expect(service.results()).toHaveLength(1)
  })

  test('a reading that fails still records how the run ended', async () => {
    const { f, service } = await fixture()
    f.content.mockRejectedValue(new Error('boom'))
    const { value } = await service.create(definition(), actor)
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    await service.tick()
    expect(service.results()).toEqual([expect.objectContaining({ outcome: 'completed', automationId: value.id })])
    expect(service.results()[0]).not.toHaveProperty('topicId')
  })

  test('a new topic keeps the waiting cards, and a deleted session takes its content or its cards along', async () => {
    const { f, service } = await fixture()
    f.content.mockResolvedValue({ reply: '结果', files: [{ root: 'default', path: 'a.md', change: 'created' }] })
    const general = (await service.create(definition({ customAgentId: undefined, name: '通用的' }), actor)).value
    await service.runNow(general.id, { requestId: randomUUID() }, actor)
    await service.tick()
    const [card] = service.results()
    expect(card).toMatchObject({ owner: 'general' })
    await service.adoptResults(AGENT, 'topic-x')
    expect(service.resultsOf('general', null)).toHaveLength(1)
    await service.adoptResults('general', 'topic-g')
    expect(service.resultsIn('topic-g').map(item => item.id)).toEqual([card!.id])
    expect(f.changedTopics).toHaveBeenCalledWith(['topic-g'])
    await service.sessionDeleted('topic-g')
    expect(service.resultsOf('general', null)).toHaveLength(1)
    await service.sessionDeleted(card!.sessionId!)
    expect(service.results()[0]).toMatchObject({ contentRemoved: true, sessionId: card!.sessionId })
    expect(service.results()[0]).not.toHaveProperty('reply')
    expect(service.results()[0]).not.toHaveProperty('files')
  })
})

describe('deleted sessions and many cards', () => {
  test('a run whose session is deleted while its card is read gets no content', async () => {
    const { f, service } = await fixture()
    const { value } = await service.create(definition(), actor)
    f.content.mockImplementation(async run => {
      await service.sessionDeleted(run.sessionId!)
      return { topicId: 'topic-1', reply: '不该留下' }
    })
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    await service.tick()
    expect(service.results()[0]).toMatchObject({ contentRemoved: true, topicId: 'topic-1' })
    expect(service.results()[0]).not.toHaveProperty('reply')
  })

  test('a deletion whose write failed is written on the next check', async () => {
    const { f, service } = await fixture()
    const { value } = await service.create(definition(), actor)
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    await service.tick()
    const run = service.results()[0]!.sessionId!
    f.failWrite = true
    await expect(service.sessionDeleted(run)).rejects.toThrow()
    await service.tick()
    expect(service.results()[0]).toMatchObject({ contentRemoved: true })
    expect(service.results()[0]).not.toHaveProperty('reply')
  })

  test('after a start, cards of sessions that are gone lose their content, and of a gone topic wait again', async () => {
    const { f, service } = await fixture()
    const { value } = await service.create(definition(), actor)
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    f.missing = null
    await service.tick()
    const run = service.results()[0]!.sessionId!
    await service.close()
    services.splice(0)
    f.missing = new Set([run, 'topic-1'])
    const again = await f.open()
    services.push(again)
    await again.tick()
    expect(again.results()[0]).toMatchObject({ contentRemoved: true })
    expect(again.results()[0]).not.toHaveProperty('topicId')
  })

  test('each owner keeps its newest 64 cards', async () => {
    const { f, service } = await fixture()
    f.content.mockResolvedValue({})
    // Late in the day, so no scheduled time comes while the clock moves on.
    const late = { schedule: { kind: 'daily' as const, time: '23:00' } }
    const mine = (await service.create(definition(late), actor)).value
    const other = (await service.create(definition({ ...late, customAgentId: undefined, name: '通用的' }), actor)).value
    await service.runNow(other.id, { requestId: randomUUID() }, actor)
    await service.tick()
    for (let index = 0; index < 66; index++) {
      f.clock += 60_000
      await service.runNow(mine.id, { requestId: randomUUID() }, actor)
      await service.tick()
    }
    expect(service.results().filter(item => item.owner === AGENT)).toHaveLength(64)
    expect(service.results().filter(item => item.owner === 'general')).toHaveLength(1)
  })

  test('a schedule moved to another Agent leaves its earlier runs with the Agent they ran for', async () => {
    const { f, service } = await fixture()
    const { value } = await service.create(definition(), actor)
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    await service.tick()
    f.clock += 60_000
    const moved = (
      await service.patch(value.id, { requestId: randomUUID(), baseRevision: service.get(value.id).revision, customAgentId: null }, actor)
    ).value
    expect(moved.customAgentId).toBeUndefined()
    expect(service.runsOf('general')).toEqual([{ automation: expect.objectContaining({ id: value.id }), runs: [] }])
    expect(service.runsOf(AGENT)).toEqual([])
  })
})

describe('reading a run', () => {
  const changed = (path: string, status: ChangedFile['status'] = 'A'): ChangedFile => ({ root: 'default', path, status })
  test('takes the start of the last reply, the files from changes and outputs once each, and a failure note with its code', () => {
    const detail = detailOf('run', {}, [
      { role: 'assistant', text: '早先的回答' },
      { role: 'assistant', text: 'x'.repeat(2500), outputs: [{ root: 'default', path: 'out.md', change: 'created' }] },
      { role: 'system', text: '模型服务拒绝了密钥', state: 'failed', errorCode: 'http-401' },
    ])
    const read = resultContent('failed', detail, [changed('out.md', 'M'), changed('gone.txt', 'D')])
    expect(read.reply).toHaveLength(2000)
    expect(read.replyTruncated).toBe(true)
    expect(read.files).toEqual([
      { root: 'default', path: 'out.md', change: 'modified' },
      { root: 'default', path: 'gone.txt', change: 'deleted' },
    ])
    expect(read.failure).toEqual({ reason: '模型服务拒绝了密钥', code: 'http-401' })
    expect(resultContent('completed', detail, undefined).failure).toBeUndefined()
    const many = resultContent(
      'completed',
      undefined,
      Array.from({ length: 25 }, (_, index) => changed(`f${index}.txt`)),
    )
    expect(many.files).toHaveLength(20)
    expect(many.filesMore).toBe(5)
  })

  test('the current topic is the newest open one that is not a run', () => {
    const task = (id: string, patch: Partial<TaskSummary>) =>
      ({ id, title: id, status: 'idle', updatedAt: '2026-11-01T00:00:00Z', ...patch }) as TaskSummary
    const tasks = [
      task('run', { agent: { customAgentId: AGENT }, automationId: 'auto_1', updatedAt: '2026-11-05T00:00:00Z' }),
      task('archived', { agent: { customAgentId: AGENT }, archived: true, updatedAt: '2026-11-04T00:00:00Z' }),
      task('older', { agent: { customAgentId: AGENT }, updatedAt: '2026-11-02T00:00:00Z' }),
      task('newer', { agent: { customAgentId: AGENT }, updatedAt: '2026-11-03T00:00:00Z' }),
      task('chat', { generalChat: true }),
      task('code', {}),
    ]
    expect(currentTopic(tasks, AGENT)?.id).toBe('newer')
    expect(currentTopic(tasks, 'general')?.id).toBe('chat')
    expect(currentTopic([], AGENT)).toBeUndefined()
  })
})

describe('动态', () => {
  const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T08:00:00.000Z`
  const input = () => ({
    sessions: [
      { id: 'topic', title: '周报', status: 'idle', createdAt: at(1), updatedAt: at(9), agent: { customAgentId: AGENT } },
      { id: 'run-1', title: '早间精选', status: 'idle', updatedAt: at(3), automationId: 'auto_1' },
    ] as TaskSummary[],
    automations: [
      {
        automation: { id: 'auto_1', name: '早间精选' },
        runs: [
          { at: at(4), state: 'missed' as const, trigger: 'schedule' as const },
          { at: at(3), state: 'completed' as const, trigger: 'schedule' as const, sessionId: 'run-1' },
        ],
      },
    ],
    results: [
      {
        id: 'res_1',
        automationId: 'auto_1',
        owner: AGENT,
        name: '早间精选',
        outcome: 'completed' as const,
        trigger: 'schedule' as const,
        runAt: at(3),
        at: at(3).replace('08:00', '08:04'),
        topicId: 'topic',
        reply: '不进动态',
      },
    ],
    memories: [{ id: 'mem_1', content: '秘密的文字', revision: 1, createdAt: at(5), updatedAt: at(5) }],
    changes: [
      {
        memoryId: 'mem_2',
        operation: 'delete' as const,
        at: at(6),
        previous: { id: 'mem_2', content: '删掉的文字', revision: 1, createdAt: at(2), updatedAt: at(2) },
      },
    ],
    proposals: [
      {
        id: 'prp_1',
        kind: 'schedule' as const,
        schedule: { name: '晚间', plan: { kind: 'daily' as const, time: '20:00' } },
        content: '每晚整理',
        origin: 'agent' as const,
        external: false,
        source: { sessionId: 'topic' },
        state: 'pending' as const,
        createdAt: at(7),
        updatedAt: at(7),
      },
    ],
  })
  test('lists real events newest first, a run with a card once, and no text of memories or proposals', () => {
    const page = activityPage(input())
    expect(page.items.map(item => [item.kind, item.at.slice(8, 10)])).toEqual([
      ['proposal', '07'],
      ['memory', '06'],
      ['memory', '05'],
      ['run', '04'],
      ['result', '03'],
      ['topic', '01'],
    ])
    expect(page.items.find(item => item.kind === 'memory' && item.change === 'deleted')).toBeTruthy()
    expect(JSON.stringify(page)).not.toMatch(/秘密|删掉|每晚|不进动态/u)
    expect(page.next).toBeUndefined()
  })
  test('pages by time and ID, and refuses a cursor it did not give', () => {
    const first = activityPage({ ...input(), limit: 2 })
    expect(first.items).toHaveLength(2)
    const second = activityPage({ ...input(), limit: 2, before: first.next! })
    const third = activityPage({ ...input(), limit: 2, before: second.next! })
    expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual(activityPage(input()).items.map(item => item.id))
    expect(third.next).toBeUndefined()
    expect(() => parseCursor('nope')).toThrow(AppError)
  })
})

describe('资料库', () => {
  const session = (id: string, day: number, patch: Partial<TaskSummary> = {}) =>
    ({ id, title: id, status: 'idle', updatedAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`, ...patch }) as TaskSummary
  test('groups each session’s files and attachments, newest first, leaves out sessions with none, and pages', async () => {
    const attachment = {
      id: 'att_1',
      name: 'brief.txt',
      mime: 'text/plain' as const,
      kind: 'text' as const,
      size: 4,
      sha256: 'a'.repeat(64),
    }
    const details: Record<string, TaskDetail> = {
      a: detailOf('a', {}, [{ role: 'user', text: '看看', attachments: [attachment] }]),
      b: detailOf('b', {}, [{ role: 'assistant', text: '', outputs: [{ root: 'default', path: 'report.md', change: 'created' }] }]),
      c: detailOf('c'),
    }
    const files: Record<string, ChangedFile[]> = { b: [{ root: 'default', path: 'report.md', status: 'M' }] }
    const read = (before?: string) =>
      libraryPage({
        sessions: [session('a', 1), session('b', 3, { automationId: 'auto_1' }), session('c', 2)],
        detail: async id => details[id],
        files: async id => files[id],
        ...(before ? { before } : {}),
      })
    const page = await read()
    expect(
      page.groups.map(group => [
        group.sessionId,
        group.items.map(item => (item.kind === 'file' ? `${item.change}:${item.path}` : item.attachment.name)),
      ]),
    ).toEqual([
      ['b', ['modified:report.md']],
      ['a', ['brief.txt']],
    ])
    expect(page.groups[0]).toMatchObject({ automationId: 'auto_1' })
    expect(page.next).toBeUndefined()
    const partial = await libraryPage({
      sessions: Array.from({ length: 30 }, (_, index) => session(`s${index}`, 1 + (index % 28))),
      detail: async id => detailOf(id),
      files: async () => [{ root: 'default', path: 'x.txt', status: 'A' }],
    })
    expect(partial.groups).toHaveLength(8)
    expect(partial.next).toBeTruthy()
  })
})
