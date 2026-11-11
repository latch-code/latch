import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open as openFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CustomAgentList, Handoff, HandoffList, TaskDetail, TaskSummary, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import { handoffPrompt, handoffTitle, Handoffs, type HandoffOptions } from '../src/handoffs.ts'
import type { DeviceCaller } from '../src/routes/registry.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const res = { headersSent: false, setHeader() {} } as unknown as ServerResponse

// ---- The service on its own, with the Host's paths faked -------------------------------------------------------

const callerOf = (id: string, dataScope: 'work' | 'all' = 'all') =>
  ({ connection: { listener: 'unix' }, device: { id, scopes: ['view', 'run'], dataScope } }) as unknown as DeviceCaller

interface Fake {
  dataDir: string
  sessions: Map<string, TaskDetail>
  events: Array<{ action: string; onDisk: string; started: number; detail: unknown }>
  starts: Array<{ requestId: string; prompt: string }>
  /** Driver receipts: a start with a request ID it has seen answers with the session it made. */
  receipts: Map<string, string>
  failAudit: boolean
  privateIds: Set<string>
  /** `lost`: the session is made but the answer never arrives. `dropped`: neither arrives, nothing is made. */
  startMode: 'ok' | 'lost' | 'dropped' | 'refused'
  /** The next file write fails, once. */
  failNextWrite: boolean
  /** The write of the start's answer fails, once. */
  failAnswerWrite: boolean
  /** Held until released: a start on its way. */
  gate?: Promise<void>
  /** The Host's undo note, put ahead of an input to an existing session. */
  note?: string
  logs: string[]
  open(): Promise<Handoffs>
}

async function fake(): Promise<Fake> {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-handoffs-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const sessions = new Map<string, TaskDetail>()
  sessions.set('source', {
    liveText: '',
    cursor: 0,
    approvals: [],
    summary: { id: 'source', harnessId: 'standard', title: 'Source', status: 'idle', updatedAt: '' },
    messages: [
      { id: 'q', role: 'user', text: 'What should we build?' },
      { id: 'a', role: 'assistant', text: 'A small parser, in TypeScript.' },
    ],
  })
  const state: Fake = {
    dataDir,
    sessions,
    events: [],
    starts: [],
    receipts: new Map(),
    failAudit: false,
    privateIds: new Set(['private-source']),
    startMode: 'ok',
    failNextWrite: false,
    failAnswerWrite: false,
    logs: [],
    async open() {
      const options: HandoffOptions = {
        dataDir,
        guardedPaths: [],
        home: tmpdir(),
        log: text => state.logs.push(text),
        defaultHarnessId: () => 'standard',
        atomicFs: {
          open: (path, flags, mode) => openFile(path, flags, mode),
          async rename(from, to) {
            if (state.failNextWrite) {
              state.failNextWrite = false
              throw new Error('disk full')
            }
            await rename(from, to)
          },
        },
        audit: {
          async append(event) {
            const onDisk = await readFile(join(dataDir, 'handoffs', 'handoffs.json'), 'utf8')
            state.events.push({ action: event.action, onDisk, started: state.starts.length, detail: event.detail })
            if (state.failAudit) throw new AppError(503, 'audit-unavailable', '审计不可用')
            return { seq: state.events.length } as never
          },
        },
        actor: caller => ({ deviceId: caller.device.id, listener: 'unix', via: 'http' }),
        recheck() {},
        dataScope: caller => caller.device.dataScope,
        isPrivate: id => state.privateIds.has(id),
        async readSession(caller, id) {
          const detail = sessions.get(id)
          if (!detail) throw new AppError(404, 'task-not-found', '找不到该任务')
          if (state.privateIds.has(id) && caller.device.dataScope !== 'all') throw new AppError(403, 'agent-scope-required', '私有')
          return structuredClone(detail)
        },
        async assertSessionInput() {},
        sessionRoots: async () => [],
        checkNewTarget() {},
        newTargetRoots: () => [],
        async start(_caller, input) {
          state.starts.push({ requestId: input.requestId, prompt: input.prompt })
          if (state.gate) await state.gate
          if (state.startMode === 'refused') throw new AppError(409, 'harness-unavailable', 'Harness 当前不可用')
          if (state.startMode === 'dropped') throw new Error('socket closed before sending')
          let id = state.receipts.get(input.requestId)
          if (!id) {
            id = `target-${state.receipts.size + 1}`
            state.receipts.set(input.requestId, id)
            sessions.set(id, {
              liveText: '',
              cursor: 0,
              approvals: [],
              summary: { id, harnessId: 'standard', title: 'T', status: 'idle', updatedAt: '', createdAt: new Date().toISOString() },
              messages: [{ id: `${id}-u`, role: 'user', text: input.prompt, requestId: input.requestId }],
            })
          }
          if (state.failAnswerWrite) {
            state.failAnswerWrite = false
            state.failNextWrite = true
          }
          if (state.startMode === 'lost') throw new Error('socket closed')
          return { sessionId: id }
        },
        async send(_caller, id, input) {
          state.starts.push({ requestId: input.requestId, prompt: input.prompt })
          const session = sessions.get(id)!
          if (state.startMode !== 'dropped')
            session.messages.push({
              id: `${id}-${session.messages.length}`,
              role: 'user',
              text: state.note ? `${state.note}\n\n${input.prompt}` : input.prompt,
              requestId: input.requestId,
            })
          if (state.startMode === 'lost' || state.startMode === 'dropped') throw new Error('socket closed')
        },
        listTasks: async () => [...sessions.values()].map(detail => detail.summary as TaskSummary),
        detail: async id => {
          const found = sessions.get(id)
          if (!found) throw new AppError(404, 'task-not-found', '找不到该任务')
          return structuredClone(found)
        },
        changed() {},
      }
      const service = await Handoffs.open(options)
      cleanups.push(() => service.close())
      return service
    },
  }
  return state
}

const body = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'handoff-request-0001',
  sourceSessionId: 'source',
  target: { kind: 'new-session', mode: 'chat' },
  materials: [
    { kind: 'text', text: 'Only the tokenizer, not the evaluator.' },
    { kind: 'message', messageId: 'a', hash: sha('A small parser, in TypeScript.') },
  ],
  requirements: 'Write the tokenizer with tests.',
  decisions: ['TypeScript', 'No dependencies'],
  returnScope: 'summary-and-evidence',
  ...overrides,
})

describe('handoff store', () => {
  it('keeps records in a private file under handoffs/ that the schema reads back, also after a restart', async () => {
    const state = await fake()
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    expect(created.created).toBe(true)
    expect(created.value).toMatchObject({ status: 'started', targetSessionId: 'target-1', locale: 'zh-CN' })
    const path = join(state.dataDir, 'handoffs', 'handoffs.json')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(state.dataDir, 'handoffs'))).mode & 0o777).toBe(0o700)
    const saved = JSON.parse(await readFile(path, 'utf8')) as { handoffs: Array<Record<string, unknown>> }
    expect(saved.handoffs[0]).not.toHaveProperty('pending')
    await service.close()
    const reopened = await state.open()
    expect(await reopened.get(callerOf('dev_owner'), created.value.id)).toEqual(created.value)
    expect((await reopened.list(callerOf('dev_owner'), 'target-1')).map(item => item.id)).toEqual([created.value.id])
  })

  it('writes the first message from the template, in the language asked for, with materials verbatim', async () => {
    const state = await fake()
    const service = await state.open()
    await service.create(callerOf('dev_owner'), body({ locale: 'en' }), res)
    const prompt = state.starts[0]!.prompt
    expect(prompt).toContain('This task was handed over from another session.')
    expect(prompt).toContain('## Requirements\nWrite the tokenizer with tests.')
    expect(prompt).toContain('1. TypeScript\n2. No dependencies')
    expect(prompt).toContain('```\nOnly the tokenizer, not the evaluator.\n```')
    expect(prompt).toContain('a message from the agent in the source session\n```\nA small parser, in TypeScript.\n```')
    const zh = handoffPrompt('zh-CN', {
      requirements: '',
      decisions: [],
      materials: [
        { kind: 'text', text: 'has ``` inside' },
        { kind: 'file', file: { root: 'default', path: 'src/a.ts' } },
      ],
    })
    expect(zh).toContain('## 要求\n（没有写）')
    // A fence the material cannot close.
    expect(zh).toContain('````\nhas ``` inside\n````')
    expect(zh).toContain('`default:src/a.ts` — 已作为文件引用附上。')
  })

  it('titles a new target after the first line of the requirements, else the first material, in at most 60 characters', () => {
    expect(handoffTitle('## 接入每日汇率\n细节', [])).toBe('接入每日汇率')
    expect(handoffTitle('  ', [{ kind: 'file', file: { root: 'default', path: 'docs/rates.md' } }])).toBe('rates.md')
    expect(handoffTitle('', [{ kind: 'message', role: 'assistant', text: '\n建议：用 ECB' }])).toBe('建议：用 ECB')
    expect([...handoffTitle('长'.repeat(80), [])!]).toHaveLength(60)
    expect(handoffTitle('', [])).toBeUndefined()
    // Emoji count as one code point or more and are never split: a family sequence (7 code points) stays whole or goes.
    const family = '👨‍👩‍👧‍👦'
    for (const line of ['🎉'.repeat(80), `${'汇'.repeat(55)}${family}${'率'.repeat(10)}`]) {
      const title = handoffTitle(line, [])!
      expect([...title].length).toBeLessThanOrEqual(60)
      expect(title.endsWith('…')).toBe(true)
      expect(title).not.toContain('\u200d…')
      expect(title.includes('👨') ? title.includes(family) : true).toBe(true)
    }
    expect(handoffTitle(`${'汇'.repeat(55)}${family}${'率'.repeat(10)}`, [])).toBe(`${'汇'.repeat(55)}…`)
  })

  it('starts a target whose requirements begin with emoji, with the title stored whole', async () => {
    const handoffs = await (await fake()).open()
    const created = await handoffs.create(callerOf('phone'), body({ requirements: `${'🎉'.repeat(70)}\n细节` }), res)
    expect(created.value.status).toBe('started')
  })

  it('answers a retry of the same request with the same handoff and starts one target', async () => {
    const state = await fake()
    const service = await state.open()
    const first = await service.create(callerOf('dev_owner'), body(), res)
    const again = await service.create(callerOf('dev_owner'), body(), res)
    expect(again).toEqual({ value: first.value, created: false })
    expect(state.starts).toHaveLength(1)
    await expect(service.create(callerOf('dev_owner'), body({ requirements: 'Something else' }), res)).rejects.toMatchObject({
      code: 'request-conflict',
    })
    // Another device's request ID is its own.
    const other = await service.create(callerOf('dev_other'), body(), res)
    expect(other.value.id).not.toBe(first.value.id)
  })

  it('refuses a material whose version changed, naming which one, and records nothing', async () => {
    const state = await fake()
    const service = await state.open()
    const stale = body({
      materials: [
        { kind: 'text', text: 'fine' },
        { kind: 'message', messageId: 'a', hash: sha('An older answer') },
      ],
    })
    await expect(service.create(callerOf('dev_owner'), stale, res)).rejects.toMatchObject({
      status: 409,
      code: 'handoff-material-changed',
      details: { materials: [1] },
    })
    expect(state.events).toHaveLength(0)
    expect(state.starts).toHaveLength(0)
    expect(await service.list(callerOf('dev_owner'), 'source')).toEqual([])
  })

  it('refuses a thinking level that is not a model effort', async () => {
    const service = await (await fake()).open()
    await expect(
      service.create(
        callerOf('dev_owner'),
        body({ target: { kind: 'new-session', model: { providerId: 'p', model: 'm', effort: 'HIGH NOW' } } }),
        res,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('refuses a private source to a device with data scope work', async () => {
    const state = await fake()
    state.sessions.set('private-source', {
      ...state.sessions.get('source')!,
      summary: { ...state.sessions.get('source')!.summary, id: 'private-source' },
    })
    const service = await state.open()
    await expect(service.create(callerOf('dev_work', 'work'), body({ sourceSessionId: 'private-source' }), res)).rejects.toMatchObject({
      status: 403,
      code: 'agent-scope-required',
    })
    expect(state.events).toHaveLength(0)
  })

  it('audits before anything is written or started, and an audit failure creates nothing', async () => {
    const state = await fake()
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    expect(state.events[0]).toMatchObject({ action: 'handoff.created', started: 0 })
    expect(state.events[0]!.onDisk).not.toContain(created.value.id)
    expect(state.events[0]!.detail).toEqual({
      handoffId: created.value.id,
      sourceSessionId: 'source',
      target: 'new-session',
      materials: 2,
      files: 0,
      decisions: 2,
      returnScope: 'summary-and-evidence',
      promptHash: sha(state.starts[0]!.prompt),
    })
    state.failAudit = true
    await expect(service.create(callerOf('dev_owner'), body({ requestId: 'handoff-request-0002' }), res)).rejects.toMatchObject({
      code: 'audit-unavailable',
    })
    expect(state.starts).toHaveLength(1)
    expect(await service.list(callerOf('dev_owner'), 'source')).toHaveLength(1)
  })

  it('keeps a lost start unknown, finds the session by its request ID across a restart, and never starts a second', async () => {
    const state = await fake()
    state.startMode = 'lost'
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    expect(created.value.status).toBe('start-unknown')
    expect(created.value).not.toHaveProperty('targetSessionId')
    await service.close()
    state.startMode = 'ok'
    const reopened = await state.open()
    // A read only looks: nothing is sent again.
    expect(await reopened.get(callerOf('dev_owner'), created.value.id)).toMatchObject({ status: 'started', targetSessionId: 'target-1' })
    expect(state.starts).toHaveLength(1)
  })

  it('settles an unknown start on retry: it looks first, and starts again only when nothing was made', async () => {
    const state = await fake()
    state.startMode = 'lost'
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    expect(created.value.status).toBe('start-unknown')
    state.startMode = 'refused'
    // The session exists, so the retry finds it and sends nothing, even with the Harness now refusing.
    const retried = await service.create(callerOf('dev_owner'), body(), res)
    expect(retried.value).toMatchObject({ id: created.value.id, status: 'started', targetSessionId: 'target-1' })
    expect(state.starts).toHaveLength(1)

    state.startMode = 'dropped'
    const lost = await service.create(callerOf('dev_owner'), body({ requestId: 'handoff-request-0010' }), res)
    expect(lost.value.status).toBe('start-unknown')
    state.startMode = 'ok'
    const restarted = await service.create(callerOf('dev_owner'), body({ requestId: 'handoff-request-0010' }), res)
    expect(restarted.value).toMatchObject({ status: 'started', targetSessionId: 'target-2' })
    expect(state.starts.slice(1).map(start => start.requestId)).toEqual([state.starts[1]!.requestId, state.starts[1]!.requestId])
  })

  it('never turns an unknown start into start-failed: a refused retry leaves it unknown, with the reason', async () => {
    const state = await fake()
    state.startMode = 'dropped'
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    expect(created.value.status).toBe('start-unknown')
    state.startMode = 'refused'
    const retried = await service.create(callerOf('dev_owner'), body(), res)
    expect(retried.value).toMatchObject({ status: 'start-unknown', failure: { code: 'harness-unavailable' } })
    expect(state.starts).toHaveLength(2)
  })

  it('keeps the start request ID secret and binds only a session with the same Harness, project and first message', async () => {
    const state = await fake()
    state.startMode = 'lost'
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    const startId = state.starts[0]!.requestId
    expect(JSON.stringify(created.value)).not.toContain(startId)
    const real = state.sessions.get('target-1')!
    state.sessions.delete('target-1')
    const forged = (id: string, harnessId: string, text: string, workspaceId?: string) =>
      state.sessions.set(id, {
        ...real,
        summary: { ...real.summary, id, harnessId, ...(workspaceId ? { workspaceId } : {}) },
        messages: [{ id: `${id}-u`, role: 'user', text, requestId: startId }],
      })
    forged('other-text', 'standard', 'something else')
    forged('other-harness', 'acp-agent', real.messages[0]!.text)
    forged('other-project', 'standard', real.messages[0]!.text, 'elsewhere')
    expect((await service.get(callerOf('dev_owner'), created.value.id)).status).toBe('start-unknown')
    state.sessions.set('target-1', real)
    expect(await service.get(callerOf('dev_owner'), created.value.id)).toMatchObject({ status: 'started', targetSessionId: 'target-1' })
  })

  it('logs a start answer it could not write, and the next read recovers it without starting again', async () => {
    const state = await fake()
    state.failAnswerWrite = true
    const service = await state.open()
    await expect(service.create(callerOf('dev_owner'), body(), res)).rejects.toMatchObject({ code: 'agent-write-unknown' })
    expect(state.logs.join('\n')).toContain('开始结果未能写入')
    const [listed] = await service.list(callerOf('dev_owner'), 'source')
    expect(listed).toMatchObject({ status: 'started', targetSessionId: 'target-1' })
    expect(state.starts).toHaveLength(1)
  })

  it('records a refused start with its reason, and only such a handoff can be withdrawn', async () => {
    const state = await fake()
    state.startMode = 'refused'
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    expect(created.value).toMatchObject({ status: 'start-failed', failure: { code: 'harness-unavailable' } })
    const withdrawn = await service.withdraw(callerOf('dev_owner'), created.value.id, { requestId: 'withdraw-request-01' })
    expect(withdrawn).toMatchObject({ audited: true, value: { status: 'withdrawn' } })
    expect(state.events.at(-1)).toMatchObject({ action: 'handoff.withdrawn', detail: { handoffId: created.value.id } })
    state.startMode = 'ok'
    const started = await service.create(callerOf('dev_owner'), body({ requestId: 'handoff-request-0003' }), res)
    // Closing a started one leaves its target alone and takes no result any more.
    expect((await service.withdraw(callerOf('dev_owner'), started.value.id, { requestId: 'withdraw-request-02' })).value).toMatchObject({
      status: 'closed',
      targetSessionId: 'target-1',
    })
    expect(state.events.at(-1)).toMatchObject({ action: 'handoff.withdrawn', detail: { from: 'started' } })
    await expect(
      service.returnResult(callerOf('dev_owner'), started.value.id, { requestId: 'return-request-09', summary: 'x', evidence: [] }),
    ).rejects.toMatchObject({ code: 'handoff-closed' })
  })

  it('closes an unknown start: a session found is bound and said so; none found voids the start for good', async () => {
    const state = await fake()
    state.startMode = 'lost'
    const service = await state.open()
    const found = await service.create(callerOf('dev_owner'), body(), res)
    await expect(service.withdraw(callerOf('dev_owner'), found.value.id, { requestId: 'withdraw-request-11' })).rejects.toMatchObject({
      code: 'handoff-start-found',
      details: { targetSessionId: 'target-1' },
    })
    expect((await service.get(callerOf('dev_owner'), found.value.id)).status).toBe('started')

    state.startMode = 'dropped'
    const lost = await service.create(callerOf('dev_owner'), body({ requestId: 'handoff-request-0012' }), res)
    const startId = state.starts.at(-1)!.requestId
    expect((await service.withdraw(callerOf('dev_owner'), lost.value.id, { requestId: 'withdraw-request-12' })).value.status).toBe(
      'withdrawn',
    )
    // The start arrives after all: it is never bound, and a retry of the request does not start it again.
    state.startMode = 'ok'
    state.sessions.set('late', {
      ...state.sessions.get('target-1')!,
      summary: { ...state.sessions.get('target-1')!.summary, id: 'late' },
      messages: [{ id: 'late-u', role: 'user', text: state.starts.at(-1)!.prompt, requestId: startId }],
    })
    expect(await service.get(callerOf('dev_owner'), lost.value.id)).not.toHaveProperty('targetSessionId')
    expect((await service.create(callerOf('dev_owner'), body({ requestId: 'handoff-request-0012' }), res)).value.status).toBe('withdrawn')
    expect(state.starts).toHaveLength(2)
  })

  it('refuses to withdraw while a retry is starting the target, and records the target that start made', async () => {
    const state = await fake()
    state.startMode = 'dropped'
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body(), res)
    expect(created.value.status).toBe('start-unknown')
    state.startMode = 'ok'
    let release!: () => void
    state.gate = new Promise(resolve => (release = resolve))
    const retry = service.create(callerOf('dev_owner'), body(), res)
    await expect.poll(() => state.starts.length).toBe(2)
    await expect(service.withdraw(callerOf('dev_owner'), created.value.id, { requestId: 'withdraw-request-31' })).rejects.toMatchObject({
      code: 'handoff-starting',
    })
    release()
    expect((await retry).value).toMatchObject({ status: 'started', targetSessionId: 'target-1' })
  })

  it('finds an input to an existing session behind the undo note, so closing binds it instead of voiding it', async () => {
    const state = await fake()
    state.sessions.set('existing', {
      ...state.sessions.get('source')!,
      summary: { ...state.sessions.get('source')!.summary, id: 'existing' },
      messages: [],
    })
    state.startMode = 'lost'
    state.note = '[撤销说明] 上一轮的改动已撤销。'
    const service = await state.open()
    const created = await service.create(callerOf('dev_owner'), body({ target: { kind: 'session', sessionId: 'existing' } }), res)
    expect(created.value.status).toBe('start-unknown')
    expect(state.sessions.get('existing')!.messages[0]!.text.startsWith('[撤销说明]')).toBe(true)
    await expect(service.withdraw(callerOf('dev_owner'), created.value.id, { requestId: 'withdraw-request-32' })).rejects.toMatchObject({
      code: 'handoff-start-found',
      details: { targetSessionId: 'existing' },
    })
    expect(state.starts).toHaveLength(1)
  })

  it('retries a deletion cleanup that could not be written, on the next operation', async () => {
    const state = await fake()
    const service = await state.open()
    const owner = callerOf('dev_owner')
    const made = await service.create(owner, body(), res)
    // Leave a write whose result is unknown, so the cleanup cannot be written now.
    state.failNextWrite = true
    await expect(
      service.returnResult(owner, made.value.id, { requestId: 'return-request-41', summary: 'Done', evidence: [] }),
    ).rejects.toMatchObject({ code: 'agent-write-unknown' })
    await service.sessionDeleted('target-1')
    expect(state.logs.join('\n')).toContain('稍后重试')
    const after = await service.get(owner, made.value.id)
    expect(after).toMatchObject({ status: 'returned', contentRemoved: true })
    expect(after).not.toHaveProperty('result')
    expect(await readFile(join(state.dataDir, 'handoffs', 'handoffs.json'), 'utf8')).not.toContain('Only the tokenizer')
  })

  it('prunes when a handoff settles, not only when one is created, so a full file still shrinks', async () => {
    const state = await fake()
    const service = await state.open()
    const owner = callerOf('dev_owner')
    const text = 'x'.repeat(60 * 1024)
    const ids: string[] = []
    // All open: nothing can be pruned, and the file grows past the budget.
    for (let index = 0; index < 140; index++)
      ids.push(
        (
          await service.create(
            owner,
            body({ requestId: `open-request-${String(index).padStart(4, '0')}`, materials: [{ kind: 'text', text }] }),
            res,
          )
        ).value.id,
      )
    const path = join(state.dataDir, 'handoffs', 'handoffs.json')
    const full = (await stat(path)).size
    expect(full).toBeGreaterThan(8 * 1024 * 1024)
    await service.withdraw(owner, ids[0]!, { requestId: 'withdraw-request-51' })
    // Closing the next one drops the first, already closed, without a new handoff asking for room.
    await service.withdraw(owner, ids[1]!, { requestId: 'withdraw-request-52' })
    const left = (await service.list(owner, 'source')).map(item => item.id)
    expect(left).not.toContain(ids[0])
    expect(left).toContain(ids[1])
    expect((await stat(path)).size).toBeLessThan(full)
  }, 120_000)

  it('never fills up for good: settled handoffs, those agreed with no return, and large ones make room', async () => {
    const state = await fake()
    const service = await state.open()
    const owner = callerOf('dev_owner')
    for (let index = 0; index < 256; index++)
      await service.create(owner, body({ requestId: `fill-request-${String(index).padStart(4, '0')}`, returnScope: 'none' }), res)
    const next = await service.create(owner, body({ requestId: 'fill-request-final' }), res)
    expect(next.created).toBe(true)
    expect(await service.list(owner, 'source')).toHaveLength(256)

    const large = await fake()
    const big = await large.open()
    const text = 'x'.repeat(60 * 1024)
    for (let index = 0; index < 160; index++)
      await big.create(
        owner,
        body({ requestId: `large-request-${String(index).padStart(4, '0')}`, returnScope: 'none', materials: [{ kind: 'text', text }] }),
        res,
      )
    const size = (await stat(join(large.dataDir, 'handoffs', 'handoffs.json'))).size
    expect(size).toBeLessThan(9 * 1024 * 1024)
    expect((await big.list(owner, 'source')).length).toBeLessThan(160)
  }, 120_000)

  it('keeps privacy once seen: a dropped mark, a deleted session or a restart without its driver opens nothing', async () => {
    const state = await fake()
    const service = await state.open()
    const owner = callerOf('dev_owner'),
      work = callerOf('dev_work', 'work')
    const made = await service.create(owner, body({ returnScope: 'summary' }), res)
    state.privateIds.add('target-1')
    await service.returnResult(owner, made.value.id, { requestId: 'return-request-21', summary: 'private memory says X', evidence: [] })
    // The live mark goes (a restart without its driver, or an automation's mark), the record's stays.
    state.privateIds.delete('target-1')
    expect((await service.get(work, made.value.id)).result).toMatchObject({ summaryWithheld: true })
    // A session that is not there cannot be read, by anyone.
    const gone = state.sessions.get('target-1')!
    state.sessions.delete('target-1')
    expect((await service.get(owner, made.value.id)).result).toMatchObject({ summaryWithheld: true })
    state.sessions.set('target-1', gone)
    // Once deleted, its handoffs keep IDs and state only.
    await service.sessionDeleted('target-1')
    const removed = await service.get(owner, made.value.id)
    expect(removed).toMatchObject({ status: 'returned', contentRemoved: true, targetSessionId: 'target-1' })
    expect(removed).not.toHaveProperty('materials')
    expect(removed).not.toHaveProperty('result')
    const file = await readFile(join(state.dataDir, 'handoffs', 'handoffs.json'), 'utf8')
    expect(file).not.toContain('private memory says X')
    expect(file).not.toContain('Only the tokenizer')
  })

  it('cuts a return to its scope, refuses one when none was agreed, and withholds what the reader cannot read', async () => {
    const state = await fake()
    const service = await state.open()
    const owner = callerOf('dev_owner')
    const firstMessage = () => state.sessions.get('target-1')!.messages[0]!
    const full = await service.create(owner, body(), res)
    const evidence = [{ kind: 'message', messageId: firstMessage().id, hash: sha(firstMessage().text) }]
    await expect(
      service.returnResult(owner, full.value.id, {
        requestId: 'return-request-01',
        summary: 'Done',
        evidence: [{ ...evidence[0], hash: sha('x') }],
      }),
    ).rejects.toMatchObject({ code: 'handoff-evidence-changed', details: { evidence: [0] } })
    const returned = await service.returnResult(owner, full.value.id, { requestId: 'return-request-01', summary: 'Done', evidence })
    expect(returned).toMatchObject({ status: 'returned', result: { summary: 'Done', evidence } })
    expect(state.events.at(-1)).toMatchObject({ action: 'handoff.returned', detail: { evidence: 1, summaryHash: sha('Done') } })
    // The same request again is the same answer; another is refused.
    expect(await service.returnResult(owner, full.value.id, { requestId: 'return-request-01', summary: 'Done', evidence })).toEqual(
      returned,
    )
    await expect(
      service.returnResult(owner, full.value.id, { requestId: 'return-request-02', summary: 'Again', evidence: [] }),
    ).rejects.toMatchObject({ code: 'handoff-returned' })

    const summaryOnly = await service.create(owner, body({ requestId: 'handoff-request-0004', returnScope: 'summary' }), res)
    const trimmed = await service.returnResult(owner, summaryOnly.value.id, {
      requestId: 'return-request-03',
      summary: 'Short',
      evidence: [{ kind: 'message', messageId: 'target-2-u', hash: sha(state.sessions.get('target-2')!.messages[0]!.text) }],
    })
    expect(trimmed.result).toMatchObject({ summary: 'Short', evidence: [] })

    const none = await service.create(owner, body({ requestId: 'handoff-request-0005', returnScope: 'none' }), res)
    await expect(
      service.returnResult(owner, none.value.id, { requestId: 'return-request-04', summary: 'No', evidence: [] }),
    ).rejects.toMatchObject({ code: 'handoff-no-return' })

    // A reader of the source who may not read the target sees that there is a result, and nothing of it.
    const restricted = callerOf('dev_work', 'work')
    expect((await service.get(restricted, full.value.id)).result).toMatchObject({ summary: 'Done', evidence })
    state.privateIds.add('target-1')
    expect((await service.get(restricted, full.value.id)).result).toEqual({
      summaryWithheld: true,
      evidence: [{ kind: 'withheld' }],
      at: returned.result!.at,
      requestId: 'return-request-01',
    })
    expect((await service.get(owner, full.value.id)).result).toMatchObject({ summary: 'Done', evidence })
  })
})

// ---- Through the Host's routes ----------------------------------------------------------------------------------

const plugin: HarnessPlugin = {
  id: 'handoff-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'handoff-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: 'Source answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
const model = { providerId: 'handoff-provider', model: 'fixture' }

async function hostFixture() {
  const host = await startTestHost({ plugins: [plugin] })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const start = async (prompt: string) => {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt, requestId: randomUUID(), mode: 'chat', model },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    return owner.json<TaskDetail>(`tasks/${sessionId}`)
  }
  return { host, owner, start }
}

const routeBody = (source: TaskDetail, overrides: Record<string, unknown> = {}) => {
  const answer = source.messages.find(message => message.role === 'assistant')!
  return {
    requestId: randomUUID(),
    sourceSessionId: source.summary.id,
    target: { kind: 'new-session', mode: 'chat', model },
    materials: [{ kind: 'message', messageId: answer.id, hash: sha(answer.text) }],
    requirements: '把它写成代码',
    decisions: ['只用标准库'],
    returnScope: 'summary-and-evidence',
    ...overrides,
  }
}

describe('handoff routes', () => {
  it('starts one target through the session start path, whose first message the Host wrote', async () => {
    const { owner, start } = await hostFixture()
    const source = await start('Plan it')
    const request = routeBody(source)
    const before = (await owner.json<{ tasks: TaskSummary[] }>('snapshot')).tasks.length
    const created = await owner.request('handoffs', { method: 'POST', body: request })
    expect(created.status).toBe(201)
    const handoff = (await created.json()) as Handoff
    expect(handoff).toMatchObject({ status: 'started', sourceSessionId: source.summary.id })
    const retried = await owner.request('handoffs', { method: 'POST', body: request })
    expect(retried.status).toBe(200)
    expect(((await retried.json()) as Handoff).targetSessionId).toBe(handoff.targetSessionId)
    const snapshot = await owner.json<{ tasks: TaskSummary[]; handoffs?: unknown[]; catalog: { features: { handoffs?: true } } }>(
      'snapshot',
    )
    expect(snapshot.tasks.length).toBe(before + 1)
    expect(snapshot.catalog.features.handoffs).toBe(true)
    expect(snapshot.handoffs).toEqual([expect.objectContaining({ id: handoff.id, targetSessionId: handoff.targetSessionId })])
    const target = await owner.json<TaskDetail>(`tasks/${handoff.targetSessionId}`)
    const first = target.messages.find(message => message.role === 'user')!
    expect(first.text).toContain('## 要求\n把它写成代码')
    expect(first.text).toContain('1. 只用标准库')
    expect(first.text).toContain('```\nSource answer\n```')
    const list = await owner.json<HandoffList>(`handoffs?sessionId=${encodeURIComponent(source.summary.id)}`)
    expect(list.handoffs.map(item => item.id)).toEqual([handoff.id])
    expect(await owner.json(`handoffs/${handoff.id}`)).toEqual(list.handoffs[0])
  })

  it('refuses a stale message version and a private source for a work-scope device', async () => {
    const { host, owner, start } = await hostFixture()
    const source = await start('Plan it')
    const stale = await owner.request('handoffs', {
      method: 'POST',
      body: routeBody(source, { materials: [{ kind: 'message', messageId: source.messages.at(-1)!.id, hash: sha('old') }] }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'handoff-material-changed', materials: [0] })

    const list = await owner.json<CustomAgentList>('custom-agents')
    await owner.json('custom-agents/general', {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'PRIVATE RULES' },
    })
    const secret = await start('Private plan')
    expect(secret.summary).toMatchObject({ agentPrivate: true })
    const work = await host.enroll({ listener: 'loopback-tcp' })
    await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    const refused = await work.request('handoffs', { method: 'POST', body: routeBody(secret) })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'agent-scope-required' })
  })

  it('hands a file between the built-in Harness and an ACP Agent under each one’s own name for the folder', async () => {
    const { host, owner } = await hostFixture()
    await owner.json('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_LOG: join(host.root, 'acp.log') },
      },
    })
    const folder = join(host.root, 'ledger'),
      elsewhere = join(host.root, 'other')
    await mkdir(join(folder, 'notes'), { recursive: true })
    await mkdir(elsewhere)
    const text = '# rates\n'
    await writeFile(join(folder, 'notes', 'rates.md'), text)
    expect((await owner.addFolders({ paths: [folder], name: 'ledger' })).status).toBeLessThan(300)
    expect((await owner.addFolders({ paths: [elsewhere], name: 'other' })).status).toBeLessThan(300)
    const projects = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces
    const ledger = projects.find(item => item.name === 'ledger')!,
      other = projects.find(item => item.name === 'other')!
    const folderRoot = ledger.folders![0]!.id
    expect(folderRoot).not.toBe('default')
    const session = async (harnessId: string, root: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt: 'Plan it',
          requestId: randomUUID(),
          mode: 'agent',
          harnessId,
          workspaceId: ledger.id,
          fileRefs: [{ root, path: 'notes/rates.md' }],
          ...(harnessId === 'standard' ? { model } : {}),
        },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      return sessionId
    }
    const handOff = (sourceSessionId: string, root: string, target: Record<string, unknown>) =>
      owner.request('handoffs', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          sourceSessionId,
          target: { kind: 'new-session', mode: 'agent', ...target },
          materials: [{ kind: 'file', file: { root, path: 'notes/rates.md' }, hash: sha(text) }],
          requirements: 'Use it',
          decisions: [],
          returnScope: 'summary',
        },
      })
    const firstOf = async (handoff: Handoff) =>
      (await owner.json<TaskDetail>(`tasks/${handoff.targetSessionId}`)).messages.find(message => message.role === 'user')!

    // Built-in source (the folder's own ID) to an ACP target (`default`).
    const builtIn = await session('standard', folderRoot)
    const toAcp = await handOff(builtIn, folderRoot, { projectId: ledger.id, harnessId: 'fake-agent' })
    expect(toAcp.status).toBe(201)
    const acpHandoff = (await toAcp.json()) as Handoff
    const acpFirst = await firstOf(acpHandoff)
    expect(acpFirst.fileRefs).toEqual([{ root: 'default', path: 'notes/rates.md' }])
    expect(acpFirst.text).toContain('`default:notes/rates.md`')
    // The target is titled after the requirements, not the template's opening.
    expect((await owner.json<{ tasks: TaskSummary[] }>('snapshot')).tasks.find(task => task.id === acpHandoff.targetSessionId)?.title).toBe(
      'Use it',
    )

    // And the reverse: an ACP source to a built-in target.
    const acp = await session('fake-agent', 'default')
    const toBuiltIn = await handOff(acp, 'default', { projectId: ledger.id, harnessId: 'standard', model })
    expect(toBuiltIn.status).toBe(201)
    expect((await firstOf((await toBuiltIn.json()) as Handoff)).fileRefs).toEqual([{ root: folderRoot, path: 'notes/rates.md' }])

    // A target whose folders do not hold the file is still refused, naming the material.
    const outside = await handOff(builtIn, folderRoot, { projectId: other.id, harnessId: 'fake-agent' })
    expect(outside.status).toBe(409)
    expect(await outside.json()).toMatchObject({ error: 'handoff-file-elsewhere', materials: [0] })
  })

  it('withholds a returned summary and evidence from a reader of the source who may not read the target', async () => {
    const { host, owner, start } = await hostFixture()
    const source = await start('Plan it')
    // From here on the owner's new sessions carry 通用's private context.
    const agents = await owner.json<CustomAgentList>('custom-agents')
    await owner.json('custom-agents/general', {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: agents.general.revision, instructions: 'PRIVATE RULES' },
    })
    const handoff = await owner.json<Handoff>('handoffs', { method: 'POST', body: routeBody(source) })
    expect(handoff.status).toBe('started')
    const target = await owner.json<TaskDetail>(`tasks/${handoff.targetSessionId}`)
    expect(target.summary).toMatchObject({ agentPrivate: true })
    const first = target.messages.find(message => message.role === 'user')!
    const returned = await owner.json<Handoff>(`handoffs/${handoff.id}/return`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        summary: 'Tokenizer done',
        evidence: [{ kind: 'message', messageId: first.id, hash: sha(first.text) }],
      },
    })
    expect(returned.result).toMatchObject({ summary: 'Tokenizer done', evidence: [{ kind: 'message', messageId: first.id }] })

    const work = await host.enroll({ listener: 'loopback-tcp' })
    await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    const seen = await work.json<HandoffList>(`handoffs?sessionId=${encodeURIComponent(source.summary.id)}`)
    expect(seen.handoffs[0]!.result).toEqual({
      summaryWithheld: true,
      evidence: [{ kind: 'withheld' }],
      at: returned.result!.at,
      requestId: returned.result!.requestId,
    })
    expect(JSON.stringify(seen)).not.toContain('Tokenizer done')
    const asTarget = await work.request(`handoffs?sessionId=${encodeURIComponent(handoff.targetSessionId!)}`)
    expect(asTarget.status).toBe(403)
  })
})
