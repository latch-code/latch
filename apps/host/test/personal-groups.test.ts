import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, open, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type {
  PersonalAssistant,
  PersonalGroup,
  PersonalGroupDetail,
  TaskDetail,
  PersonalGroupMessage,
  PersonalGroupInput,
  TaskSummary,
} from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { AppError } from '@latch/sdk'
import { PersonalGroups } from '../src/personal-groups.ts'
import type { AuditLog } from '../src/audit.ts'
import { PersonalStore } from '../src/personal-store.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = [],
  roots: string[] = [],
  groups: PersonalGroups[] = [],
  gates: Array<() => void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const release of gates.splice(0)) release()
  for (const group of groups.splice(0)) await group.close()
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const actor = { actor: { deviceId: 'owner', listener: 'unix' as const }, authorize: () => {} },
  memberA = `asst_${randomUUID()}`,
  memberB = `asst_${randomUUID()}`,
  groupInput = () => ({
    requestId: randomUUID(),
    name: 'Shared work',
    instructions: 'ONLY COMMON GROUP INSTRUCTIONS',
    memberIds: [memberA, memberB],
    defaultAssistantId: memberA,
    maxRelays: 1,
  })
async function fixture(overrides: Partial<Parameters<typeof PersonalGroups.open>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'latch-groups-'))
  roots.push(root)
  let allowed = true,
    basis = '1'.repeat(64),
    outcome: TaskDetail['summary']['runOutcome'] = 'completed'
  const starts: Array<{
      requestId: string
      prompt: string
      plan: Parameters<Parameters<typeof PersonalGroups.open>[0]['start']>[0]['plan']
    }> = [],
    options = {
      dataDir: root,
      audit: { append: vi.fn(async () => ({ seq: 1, hash: '0'.repeat(64) })) },
      changed: vi.fn(),
      plan: (group: PersonalGroup, id: string, history: PersonalGroupMessage[]) => ({
        basis,
        persistent: false,
        mode: 'chat' as const,
        model: { providerId: 'fixture', model: 'model' },
        personal: {
          personal: { assistantId: id, groupId: group.id },
          instructions: group.instructions,
          pluginIds: [],
          revision: '1'.repeat(64),
          sharedMessages: history
            .filter(message => message.role !== 'system')
            .map(message => ({ role: message.role as 'user' | 'assistant', text: message.text })),
        },
      }),
      start: vi.fn(async (input: Parameters<Parameters<typeof PersonalGroups.open>[0]['start']>[0]) => {
        input.authorize()
        starts.push(input)
        return { sessionId: `session-${starts.length}` }
      }),
      detail: vi.fn(
        async (id: string) =>
          ({
            summary: { id, status: 'idle', runOutcome: outcome },
            messages: [{ id: 'result', role: 'assistant', text: 'Actual result', state: 'completed' }],
          }) as TaskDetail,
      ),
      sessions: async () => [],
      cancel: vi.fn(async () => {}),
      ...overrides,
    },
    service = await PersonalGroups.open(options)
  groups.push(service)
  return {
    root,
    service,
    options,
    starts,
    actor: {
      ...actor,
      authorize: () => {
        if (!allowed) throw new AppError(403, 'revoked', 'revoked')
      },
    },
    revoke: () => {
      allowed = false
    },
    basis: (value: string) => {
      basis = value
    },
    outcome: (value: typeof outcome) => {
      outcome = value
    },
  }
}

test('executes only explicit bounded members, projects original request identity and never duplicates a recovered turn', async () => {
  const f = await fixture(),
    group = await f.service.create(groupInput(), f.actor),
    input = { requestId: randomUUID(), prompt: 'Shared task', assistantIds: [memberA, memberB] },
    accepted = await f.service.submit(group.id, input, f.actor)
  await vi.waitFor(async () => expect((await f.service.detail(group.id, f.actor)).turn?.state).toBe('completed'))
  expect(f.starts).toHaveLength(2)
  expect(f.starts.map(start => start.plan.personal.personal.assistantId)).toEqual([memberA, memberB])
  expect((await f.service.detail(group.id, f.actor)).messages[0]?.requestId).toBe(input.requestId)
  expect(f.starts[1]!.plan.personal.sharedMessages).toEqual([
    { role: 'user', text: 'Shared task' },
    { role: 'assistant', text: 'Actual result' },
  ])
  expect(await f.service.submit(group.id, input, f.actor)).toEqual(accepted)
  expect(f.starts).toHaveLength(2)
  await expect(f.service.submit(group.id, { ...input, prompt: 'Conflict' }, f.actor)).rejects.toMatchObject({ code: 'request-conflict' })
  await expect(
    f.service.submit(group.id, { requestId: randomUUID(), prompt: 'too many', assistantIds: [memberA, memberB, memberA] }, f.actor),
  ).rejects.toMatchObject({ code: 'personal-group-members' })
  await expect(
    f.service.submit(group.id, { requestId: randomUUID(), prompt: 'outside', assistantIds: [`asst_${randomUUID()}`] }, f.actor),
  ).rejects.toMatchObject({ code: 'personal-group-members' })
})

test('failed or unknown driver settlement stops the next member', async () => {
  for (const outcome of ['failed', 'cancelled', 'interrupted', undefined] as const) {
    const f = await fixture()
    f.outcome(outcome)
    const group = await f.service.create(groupInput(), f.actor)
    await f.service.submit(group.id, { requestId: randomUUID(), prompt: 'work', assistantIds: [memberA, memberB] }, f.actor)
    await vi.waitFor(async () =>
      expect(['failed', 'cancelled', 'interrupted']).toContain((await f.service.detail(group.id, f.actor)).turn?.state),
    )
    expect(f.starts).toHaveLength(1)
  }
})

test('a recovered create returns its saved group even when the member has become unavailable', async () => {
  const f = await fixture(),
    input = groupInput(),
    created = await f.service.create(input, f.actor),
    planning = vi.spyOn(f.options, 'plan').mockImplementation(() => {
      throw new AppError(409, 'unavailable', 'unavailable')
    })
  expect(await f.service.create(input, f.actor)).toEqual(created)
  expect(planning).not.toHaveBeenCalled()
})

test('the bounded session list always includes the current turn before older pinned or future-dated metadata', async () => {
  const f = await fixture(),
    group = await f.service.create(groupInput(), f.actor)
  await f.service.submit(group.id, { requestId: randomUUID(), prompt: 'work' }, f.actor)
  await vi.waitFor(async () => expect((await f.service.detail(group.id, f.actor)).turn?.state).toBe('completed'))
  const task = (id: string, updatedAt: string): TaskSummary => ({
    harnessId: 'standard',
    id,
    title: id,
    status: 'idle',
    updatedAt,
    personal: { assistantId: memberA, groupId: group.id },
  })
  vi.spyOn(f.options, 'sessions').mockResolvedValue([
    ...Array.from({ length: 80 }, (_, index) => ({ ...task(`old-${index}`, '2999-01-01T00:00:00Z'), pinned: true })),
    { ...task('session-1', '1970-01-01T00:00:00Z'), pendingQuestions: 1 },
  ])
  const detail = await f.service.detail(group.id, f.actor)
  expect(detail.sessions).toHaveLength(64)
  expect(detail.sessions[0]).toMatchObject({ id: 'session-1', pendingQuestions: 1 })
})

test('revocation, original opening expiry and changed execution revisions block later hops', async () => {
  for (const mode of ['revoke', 'revision'] as const) {
    let entered!: () => void, release!: () => void
    const blocked = new Promise<void>(resolve => {
        release = resolve
        gates.push(resolve)
      }),
      started = new Promise<void>(resolve => {
        entered = resolve
      }),
      f = await fixture({
        detail: async id => {
          entered()
          await blocked
          return { summary: { id, status: 'idle', runOutcome: 'completed' }, messages: [] } as unknown as TaskDetail
        },
      }),
      group = await f.service.create(groupInput(), f.actor)
    await f.service.submit(group.id, { requestId: randomUUID(), prompt: 'work', assistantIds: [memberA, memberB] }, f.actor)
    await started
    if (mode === 'revoke') f.revoke()
    else f.basis('2'.repeat(64))
    release()
    await vi.waitFor(async () => expect((await f.service.detail(group.id, actor)).turn?.state).toBe('interrupted'))
    expect(f.starts).toHaveLength(1)
  }
})

test('cancel waits for actual settlement, stores an idempotent receipt and cannot stop a newer turn', async () => {
  let running = true,
    release!: () => void,
    cancelled = false
  const settlement = new Promise<void>(resolve => {
      release = resolve
      gates.push(resolve)
    }),
    f = await fixture({
      detail: async id =>
        ({
          summary: { id, status: running ? 'running' : 'idle', runOutcome: running ? undefined : 'cancelled' },
          messages: [],
        }) as unknown as TaskDetail,
      cancel: async () => {
        cancelled = true
        await settlement
        running = false
      },
    }),
    group = await f.service.create(groupInput(), f.actor),
    first = await f.service.submit(group.id, { requestId: randomUUID(), prompt: 'work', assistantIds: [memberA, memberB] }, f.actor)
  await vi.waitFor(() => expect(f.starts).toHaveLength(1))
  const input = { requestId: randomUUID(), turnId: first.turnId },
    stopping = f.service.cancel(group.id, input, f.actor)
  await vi.waitFor(() => expect(cancelled).toBe(true))
  expect((await f.service.detail(group.id, f.actor)).turn?.state).toBe('running')
  release()
  expect(await stopping).toMatchObject({ state: 'cancelled' })
  expect(f.starts).toHaveLength(1)
  const second = await f.service.submit(group.id, { requestId: randomUUID(), prompt: 'new work' }, f.actor)
  await vi.waitFor(async () => expect((await f.service.detail(group.id, f.actor)).turn?.id).toBe(second.turnId))
  expect(await f.service.cancel(group.id, input, f.actor)).toMatchObject({ turnId: first.turnId, state: 'cancelled' })
  await expect(f.service.cancel(group.id, { ...input, requestId: randomUUID() }, f.actor)).rejects.toMatchObject({
    code: 'personal-group-turn-changed',
  })
})

test('an unknown durable incoming turn never starts on retry or restart', async () => {
  let fault = true
  const f = await fixture({
      atomicFs: {
        open,
        async rename(from, to) {
          await rename(from, to)
          const state = JSON.parse(await readFile(to, 'utf8')) as { groups: Array<{ turn?: { state: string } }> }
          if (fault && state.groups.some(row => row.turn?.state === 'running')) throw new Error('after rename failed')
        },
      },
    }),
    group = await f.service.create(groupInput(), f.actor),
    request = { requestId: randomUUID(), prompt: 'unknown' }
  await expect(f.service.submit(group.id, request, f.actor)).rejects.toMatchObject({ code: 'agent-write-unknown' })
  expect(f.starts).toEqual([])
  fault = false
  await f.service.submit(group.id, request, f.actor)
  expect((await f.service.detail(group.id, f.actor)).turn?.state).toBe('interrupted')
  expect(f.starts).toEqual([])
  await f.service.close()
  const reopened = await PersonalGroups.open(f.options)
  groups.push(reopened)
  await reopened.submit(group.id, request, f.actor)
  expect(f.starts).toEqual([])
})

test('full retained history rejects a new turn without deleting existing messages or executing it', async () => {
  const f = await fixture(),
    group = await f.service.create(groupInput(), f.actor)
  await f.service.close()
  const path = join(f.root, 'personal/groups.json'),
    state = JSON.parse(await readFile(path, 'utf8')) as { groups: Array<{ messages: PersonalGroupMessage[] }> }
  state.groups[0]!.messages = Array.from({ length: 510 }, (_, index) => ({
    id: randomUUID(),
    role: 'user' as const,
    text: `Retained ${index}`,
    createdAt: new Date().toISOString(),
    state: 'completed' as const,
  }))
  await writeFile(path, JSON.stringify(state), { mode: 0o600 })
  const reopened = await PersonalGroups.open(f.options)
  groups.push(reopened)
  await expect(
    reopened.submit(group.id, { requestId: randomUUID(), prompt: 'must not replace history', assistantIds: [memberA, memberB] }, f.actor),
  ).rejects.toMatchObject({ code: 'personal-group-history-full' })
  const retained = await reopened.detail(group.id, f.actor)
  expect(retained.messages).toHaveLength(510)
  expect(retained.messages[0]?.text).toBe('Retained 0')
  expect(f.starts).toEqual([])
})

test('an existing request identity cannot be reused to cancel a different operation', async () => {
  let release!: () => void
  const block = new Promise<void>(resolve => {
      release = resolve
      gates.push(resolve)
    }),
    f = await fixture({
      detail: async id => {
        await block
        return {
          summary: { id, status: 'idle', runOutcome: 'completed' },
          messages: [],
        } as unknown as TaskDetail
      },
    }),
    create = groupInput(),
    group = await f.service.create(create, f.actor),
    accepted = await f.service.submit(group.id, { requestId: randomUUID(), prompt: 'work', assistantIds: [memberA, memberB] }, f.actor)
  await vi.waitFor(() => expect(f.starts).toHaveLength(1))
  await expect(f.service.cancel(group.id, { requestId: create.requestId, turnId: accepted.turnId }, f.actor)).rejects.toMatchObject({
    code: 'request-conflict',
  })
  release()
  await vi.waitFor(async () => expect((await f.service.detail(group.id, f.actor)).turn?.state).toBe('completed'))
  expect(f.starts).toHaveLength(2)
})

test.each(['queued', 'audit'] as const)('pins a %s mutation identity before a conflicting cancel can stop execution', async phase => {
  let releaseAudit!: () => void,
    releaseModel!: () => void,
    entered!: () => void,
    hold = false,
    updates = 0
  const auditGate = new Promise<void>(resolve => {
      releaseAudit = resolve
    }),
    modelGate = new Promise<void>(resolve => {
      releaseModel = resolve
    }),
    auditing = new Promise<void>(resolve => {
      entered = resolve
    }),
    audit = {
      append: vi.fn(async (event: Parameters<AuditLog['append']>[0]) => {
        if (
          hold
          && event.action === 'personal.changed'
          && 'operation' in event.detail
          && event.detail.operation === 'update'
          && updates++ === 0
        ) {
          entered()
          await auditGate
        }
        return { seq: 1, hash: '0'.repeat(64) }
      }),
    },
    f = await fixture({
      audit,
      detail: async id => {
        await modelGate
        return { summary: { id, status: 'idle', runOutcome: 'completed' }, messages: [] } as unknown as TaskDetail
      },
    }),
    group = await f.service.create(groupInput(), f.actor),
    turn = await f.service.submit(group.id, { requestId: randomUUID(), prompt: 'work', assistantIds: [memberA, memberB] }, f.actor)
  gates.push(releaseAudit, releaseModel)
  await vi.waitFor(() => expect(f.starts).toHaveLength(1))
  hold = true
  const prior =
      phase === 'queued'
        ? f.service.patch(group.id, { requestId: randomUUID(), baseRevision: 1, name: 'Blocking prior write' }, f.actor)
        : undefined,
    requestId = randomUUID(),
    update = f.service.patch(group.id, { requestId, baseRevision: phase === 'queued' ? 2 : 1, name: 'Requested update' }, f.actor)
  await auditing
  let settled = false
  const conflict = f.service.cancel(group.id, { requestId, turnId: turn.turnId }, f.actor).catch(error => {
    settled = true
    return error
  })
  await vi.waitFor(() => expect(settled).toBe(true))
  expect(await conflict).toMatchObject({ code: 'request-conflict' })
  expect(f.options.cancel).not.toHaveBeenCalled()
  releaseAudit()
  await prior
  await update
  releaseModel()
  await vi.waitFor(async () => expect((await f.service.detail(group.id, f.actor)).turn?.state).toBe('completed'))
  expect(f.starts).toHaveLength(2)
})

test('shutdown drains an audited admission before closing storage and never starts its member afterwards', async () => {
  let hold = false,
    release!: () => void,
    entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    auditing = new Promise<void>(resolve => {
      entered = resolve
    }),
    f = await fixture({
      audit: {
        append: async event => {
          if (hold && event.action === 'personal.changed' && 'operation' in event.detail && event.detail.operation === 'start') {
            entered()
            await gate
          }
          return { seq: 1, hash: '0'.repeat(64) }
        },
      },
    }),
    group = await f.service.create(groupInput(), f.actor)
  gates.push(release)
  hold = true
  const incoming = f.service.submit(group.id, { requestId: randomUUID(), prompt: 'shutdown admission' }, f.actor)
  await auditing
  const stopped = f.service.close()
  release()
  await incoming
  await stopped
  expect(f.starts).toEqual([])
  expect((await f.service.detail(group.id, f.actor)).turn).toMatchObject({ state: 'interrupted', reason: 'host-restarted' })
  await expect(f.service.submit(group.id, { requestId: randomUUID(), prompt: 'late' }, f.actor)).rejects.toMatchObject({
    code: 'host-closing',
  })
})

test('a real waiting approval exposes its actual child and cancellation settles it without executing the tool', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    assistant = await owner.json<PersonalAssistant>('personal/assistants', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: 'Reports',
        role: 'Write the requested report',
        harnessId: 'standard',
        mode: 'agent',
        pluginIds: ['safe-tools'],
      },
    }),
    group = await owner.json<PersonalGroup>('personal/groups', {
      method: 'POST',
      body: { ...groupInput(), memberIds: [assistant.id], defaultAssistantId: assistant.id, maxRelays: 0 },
    }),
    path = `personal/groups/${group.id}`,
    accepted = await owner.json<{ turnId: string }>(`${path}/messages`, {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '生成需要审批的报告' },
    })
  await vi.waitFor(async () => expect((await owner.json<PersonalGroupDetail>(path)).turn?.state).toBe('waiting-approval'))
  const waiting = await owner.json<PersonalGroupDetail>(path),
    sessionId = waiting.turn!.sessionIds[0]!,
    child = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  expect(child.approvals).toHaveLength(1)
  expect(waiting.sessions[0]?.id).toBe(sessionId)
  expect(
    (
      await owner.request(path, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: 1, instructions: 'changed during execution' },
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await owner.json<PersonalGroup>(path, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: 1, name: 'Renamed report group' },
      })
    ).name,
  ).toBe('Renamed report group')
  expect(await owner.json(`${path}/cancel`, { method: 'POST', body: { requestId: randomUUID(), turnId: accepted.turnId } })).toMatchObject({
    state: 'cancelled',
  })
  const stopped = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  expect(stopped.summary.runOutcome).toBe('cancelled')
  expect(stopped.approvals).toEqual([])
})

test('memory and display-name edits preserve a turn while a selected role change pauses the next member', async () => {
  let release!: () => void
  const seen: string[] = [],
    plugin: HarnessPlugin = {
      id: 'role-bound-model',
      name: 'fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'role-bound-model',
          name: 'fixture',
          model: 'a',
          models: ['a', 'b'],
          async *stream({ model, signal }) {
            seen.push(model!)
            if (model === 'a')
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(new Error('cancelled'))
                signal.addEventListener('abort', abort, { once: true })
                release = () => {
                  signal.removeEventListener('abort', abort)
                  resolve()
                }
                if (signal.aborted) abort()
              })
            yield { type: 'text', text: 'A real visible response' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    },
    host = await startTestHost({ plugins: [plugin] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    members: PersonalAssistant[] = []
  for (const model of ['a', 'b'])
    members.push(
      await owner.json<PersonalAssistant>('personal/assistants', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: model,
          role: `Duties ${model}`,
          harnessId: 'standard',
          mode: 'chat',
          model: { providerId: 'role-bound-model', model },
          pluginIds: [],
        },
      }),
    )
  const memory = await owner.json<{ id: string }>(`personal/assistants/${members[0]!.id}/memories`, {
      method: 'POST',
      body: { requestId: randomUUID(), content: 'Never used in group' },
    }),
    group = await owner.json<PersonalGroup>('personal/groups', {
      method: 'POST',
      body: { ...groupInput(), memberIds: members.map(member => member.id), defaultAssistantId: members[0]!.id },
    }),
    path = `personal/groups/${group.id}`,
    request = () => ({ requestId: randomUUID(), prompt: '  Preserve this input\n', assistantIds: members.map(member => member.id) })
  await owner.json(`${path}/messages`, { method: 'POST', body: request() })
  await vi.waitFor(() => expect(seen).toEqual(['a']))
  await owner.json(`personal/assistants/${members[0]!.id}/memories/${memory.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: 1, content: 'A private edit' },
  })
  await owner.json(`personal/assistants/${members[0]!.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: 1, name: 'Renamed' },
  })
  release()
  await vi.waitFor(async () => expect((await owner.json<PersonalGroupDetail>(path)).turn?.state).toBe('completed'))
  expect(seen).toEqual(['a', 'b'])
  const first = await owner.json<PersonalGroupDetail>(path)
  expect(first.messages[0]?.text).toBe('  Preserve this input\n')
  await owner.json(`${path}/messages`, { method: 'POST', body: request() })
  await vi.waitFor(() => expect(seen).toEqual(['a', 'b', 'a']))
  await owner.json(`personal/assistants/${members[0]!.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: 2, role: 'New duties' },
  })
  release()
  await vi.waitFor(async () =>
    expect((await owner.json<PersonalGroupDetail>(path)).turn).toMatchObject({ state: 'interrupted', reason: 'definition-changed' }),
  )
  expect(seen).toEqual(['a', 'b', 'a'])
})

test('runs real group sessions with shared roles and selected capabilities while excluding every member private memory', async () => {
  const seen: Array<{ model: string; messages: ModelMessage[] }> = [],
    plugin: HarnessPlugin = {
      id: 'group-provider',
      name: 'fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'group-provider',
          name: 'fixture',
          model: 'a',
          models: ['a', 'b'],
          async *stream({ messages, model }) {
            seen.push({ model: model!, messages: structuredClone(messages) })
            yield { type: 'text', text: `Actual reply ${model}` }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    },
    host = await startTestHost({ plugins: [plugin] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    work = await host.enroll({ scopes: ['view', 'run'] }),
    members: PersonalAssistant[] = []
  for (const model of ['a', 'b']) {
    const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: `Member ${model}`,
        role: `PRIVATE ROLE ${model}`,
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: 'group-provider', model },
        pluginIds: [],
      },
    })
    members.push(assistant)
    await owner.json(`personal/assistants/${assistant.id}/memories`, {
      method: 'POST',
      body: { requestId: randomUUID(), content: `PRIVATE MEMORY ${model}` },
    })
  }
  const privateReads = vi.spyOn(PersonalStore.prototype, 'memories').mockImplementation(() => {
    throw new Error('Group must not read private memory')
  })
  const group = await owner.json<PersonalGroup>('personal/groups', {
      method: 'POST',
      body: { ...groupInput(), memberIds: members.map(member => member.id), defaultAssistantId: members[0]!.id },
    }),
    request: PersonalGroupInput = {
      requestId: randomUUID(),
      prompt: 'A shared user request',
      assistantIds: members.map(member => member.id),
    },
    accepted = await owner.json<{ turnId: string }>(`personal/groups/${group.id}/messages`, { method: 'POST', body: request })
  await expect.poll(async () => (await owner.json<PersonalGroupDetail>(`personal/groups/${group.id}`)).turn?.state).toBe('completed')
  const detail = await owner.json<PersonalGroupDetail>(`personal/groups/${group.id}`)
  expect(detail.messages[0]).toMatchObject({ requestId: request.requestId, text: request.prompt, role: 'user' })
  expect(detail.sessions).toHaveLength(2)
  expect(seen.map(value => value.model)).toEqual(['a', 'b'])
  expect(seen[0]?.messages.some(message => message.content.includes('ONLY COMMON GROUP INSTRUCTIONS') && message.role === 'system')).toBe(
    true,
  )
  expect(seen[1]?.messages.some(message => message.content === 'Actual reply a' && message.role === 'assistant')).toBe(true)
  expect(seen[1]?.messages.filter(message => message.content === request.prompt && message.role === 'user')).toHaveLength(1)
  expect(seen[0]?.messages.some(message => message.content.includes('PRIVATE ROLE a'))).toBe(true)
  expect(seen[0]?.messages.some(message => message.content.includes('PRIVATE ROLE b'))).toBe(false)
  expect(seen[1]?.messages.some(message => message.content.includes('PRIVATE ROLE b'))).toBe(true)
  expect(seen[1]?.messages.some(message => message.content.includes('PRIVATE ROLE a'))).toBe(false)
  expect(JSON.stringify(seen)).not.toContain('PRIVATE MEMORY')
  expect(await owner.json(`personal/groups/${group.id}/messages`, { method: 'POST', body: request })).toEqual({
    accepted: true,
    ...accepted,
  })
  expect(seen).toHaveLength(2)
  const child = detail.turn!.sessionIds[0]!,
    childDetail = await owner.json<TaskDetail>(`tasks/${child}`)
  expect(childDetail.summary.personal).toEqual({ assistantId: members[0]!.id, groupId: group.id })
  expect(
    (await owner.request(`tasks/${child}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: 'bypass group' } })).status,
  ).toBe(409)
  expect((await work.request(`personal/groups/${group.id}`)).status).toBe(403)
  expect((await work.request(`tasks/${child}`)).status).toBe(403)
  const serialized = await readFile(join(host.dataDir, 'personal/groups.json'), 'utf8'),
    audit = await readFile(join(host.dataDir, 'audit/audit.jsonl'), 'utf8')
  expect(serialized).not.toContain('PRIVATE ROLE')
  expect(serialized).not.toContain('PRIVATE MEMORY')
  expect(privateReads).not.toHaveBeenCalled()
  expect(audit).not.toContain(request.prompt)
  for (const extra of [{ attachmentIds: [] }, { fileRefs: [] }, { model: { providerId: 'group-provider', model: 'b' } }])
    expect(
      (
        await owner.request(`personal/groups/${group.id}/messages`, {
          method: 'POST',
          body: { ...request, ...extra, requestId: randomUUID() },
        })
      ).status,
    ).toBe(400)
})
