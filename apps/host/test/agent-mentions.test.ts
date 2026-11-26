import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { Approval, Message, TaskSummary } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { AgentMentions } from '../src/agent-mentions.ts'
import type { DeviceCaller } from '../src/routes/registry.ts'

const source = 'general'
const target = `agt_${randomUUID()}`
const caller = { device: { id: 'dev_owner' } } as DeviceCaller
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(emptyChats = false) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-mentions-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const delivered = new Set<string>()
  const messages: Message[] = []
  const labels: Array<string | undefined> = []
  const summary: TaskSummary = { id: 'target', harnessId: 'standard', title: '', status: 'idle', updatedAt: '', runOutcome: 'completed' }
  const approvals: Approval[] = []
  let loseAnswer = false
  let audited = 0
  const open = async () => {
    const service = await AgentMentions.open(directory, {
      access() {},
      owner() {},
      owners: () => new Set([source, target]),
      slot: async () => (emptyChats ? { state: 'empty' } : { state: 'ready', sessionId: 'target' }),
      detail: async () => ({
        summary,
        cursor: 0,
        liveText: '',
        approvals,
        messages,
      }),
      async audit() {
        audited++
      },
      async deliver(_, mention, authorize) {
        authorize()
        labels.push(mention.sourceLabel)
        if (!delivered.has(mention.dispatchId)) {
          delivered.add(mention.dispatchId)
          messages.push(
            { role: 'user', id: randomUUID(), requestId: mention.dispatchId, text: mention.text },
            { role: 'assistant', id: randomUUID(), text: 'only this reply' },
          )
        }
        if (loseAnswer) {
          loseAnswer = false
          throw new AppError(503, 'result-unknown', 'No response')
        }
        return 'target'
      },
      changed() {},
    })
    cleanup.push(() => service.close())
    return service
  }
  return {
    open,
    directory,
    delivered,
    messages,
    labels,
    summary,
    approvals,
    lost: () => {
      loseAnswer = true
    },
    audits: () => audited,
  }
}

const body = (requestId = randomUUID()) => ({ requestId, target: { kind: 'agent', customAgentId: target }, text: 'review this' })

test('a lost delivery is read without re-sending and a restart reuses the exact target request', async () => {
  const f = await fixture()
  const service = await f.open()
  const input = body()
  f.lost()
  await expect(service.send(caller, source, input)).rejects.toMatchObject({ code: 'agent-mention-unknown' })
  await service.close()
  const reopened = await f.open()
  expect(await reopened.list(caller, source)).toMatchObject([{ status: 'completed', reply: { text: 'only this reply' } }])
  await expect(reopened.send(caller, source, input)).resolves.toMatchObject({ status: 'completed' })
  await expect(reopened.send({ device: { id: 'another' } } as DeviceCaller, source, input)).rejects.toMatchObject({
    code: 'request-conflict',
  })
  expect(f.audits()).toBe(1)
  expect(f.delivered.size).toBe(1)
})

test('links a pending decision only to the delivered turn, including before it has a reply', async () => {
  const f = await fixture()
  f.summary.status = 'running'
  delete f.summary.runOutcome
  const service = await f.open()
  const sent = await service.send(caller, source, body())
  const question = f.messages[0]!
  question.turnId = 'peer-run'
  f.messages.splice(1)
  f.summary.runId = question.turnId
  f.summary.status = 'waiting-approval'
  const approval = { id: 'decision', sessionId: 'target', toolName: 'edit', toolCallId: 'edit-1', reason: 'Review', requestedAt: '' }
  f.approvals.push(approval)
  expect((await service.get(caller, source, sent.id)).approval).toBeUndefined()
  f.messages.push({ role: 'tool', id: 'tool:edit-1', text: 'edit' })
  const waiting = await service.get(caller, source, sent.id)
  expect(waiting).toMatchObject({
    targetMessageId: question.id,
    status: 'waiting-approval',
    approval: { id: 'decision', runId: 'peer-run' },
  })
  expect(waiting.reply).toBeUndefined()
  f.messages.push({ id: 'later', role: 'user', text: 'A new question', turnId: 'later-run' })
  f.summary.runId = 'later-run'
  const old = await service.get(caller, source, sent.id)
  expect(old.targetMessageId).toBe(question.id)
  expect(old.approval).toBeUndefined()
})

test('an autonomous consultation keeps its safe original attribution when the source is renamed before retry', async () => {
  const f = await fixture()
  const service = await f.open()
  const input = body()
  const origin = { mode: 'text-only' as const, sessionId: 'source-chat', name: 'Editor」 ' + 'lmg1.' + 'a'.repeat(43), authorize() {} }
  f.lost()
  await expect(service.send(caller, source, input, origin)).rejects.toMatchObject({ code: 'agent-mention-unknown' })
  await expect(service.send(caller, source, input, { ...origin, mode: 'own-permissions' })).rejects.toMatchObject({
    code: 'request-conflict',
  })
  await service.send(caller, source, input, { ...origin, name: 'Renamed' })
  expect(f.labels).toHaveLength(2)
  expect(f.labels[0]).toContain('Editor')
  expect(f.labels[0]).not.toMatch(/lmg1|」/u)
  expect(f.labels[1]).toBe(f.labels[0])
})

test('a mention carries no reference grant or credential, and redacts a reply before clipping it', async () => {
  const fixtureState = await fixture()
  const service = await fixtureState.open()
  const secret = 'lmg1.' + 'a'.repeat(43)
  await expect(service.send(caller, source, { ...body(), text: secret })).rejects.toMatchObject({ code: 'agent-mention-secret' })
  await expect(service.send(caller, source, { ...body(), text: `[conversation-ref:${randomUUID()}]` })).rejects.toMatchObject({
    code: 'agent-mention-reference',
  })
  expect(fixtureState.audits()).toBe(0)
  const sent = await service.send(caller, source, body())
  const answer = fixtureState.messages.at(-1)!
  answer.text = 'z'.repeat(15_990) + secret + ' later text'
  const shown = await service.get(caller, source, sent.id)
  expect(shown.reply?.text).not.toContain('lmg1.')
  expect(shown.reply?.more).toBe(true)
})

test('a full mention history preserves unknown submissions, retires a refusal and recognizes its receipt', async () => {
  const f = await fixture()
  const rows = Array.from({ length: 2048 }, (_, index) => ({
    id: randomUUID(),
    requestId: randomUUID(),
    sourceAgentId: source,
    targetAgentId: target,
    initiator: 'person',
    text: 'previous question',
    createdAt: new Date(0).toISOString(),
    deviceId: caller.device.id,
    dispatchId: randomUUID(),
    ...(index === 100 ? { refusal: { status: 409, code: 'busy', message: 'busy' } } : {}),
  }))
  await mkdir(join(f.directory, 'agents'), { mode: 0o700 })
  await writeFile(join(f.directory, 'agents', 'mentions.json'), JSON.stringify({ records: rows, retired: {} }), { mode: 0o600 })
  const service = await f.open()
  await expect(service.send(caller, source, body())).resolves.toMatchObject({ status: 'completed' })
  await expect(service.send(caller, source, body(rows[100]!.requestId))).rejects.toMatchObject({ code: 'agent-mention-expired' })
  expect(service.wasDispatched(target, rows[0]!.dispatchId)).toBe(true)
  expect(service.wasDispatched(target, rows[100]!.dispatchId)).toBe(false)
  expect(f.audits()).toBe(1)
})

test.each([false, true])(
  'deleting the addressed chat erases the exchange and bars replay of its lost response (first chat: %s)',
  async empty => {
    const f = await fixture(empty)
    const service = await f.open()
    const input = body()
    f.lost()
    await expect(service.send(caller, source, input)).rejects.toMatchObject({ code: 'agent-mention-unknown' })
    const first = await service.firstMentionIn(target, 'target')
    if (empty) {
      expect(first).toBe((await service.byRequest(caller, source, input.requestId)).id)
      await service.forget('session', 'unrelated', await service.firstMentionIn(source, 'unrelated'))
      await expect(service.byRequest(caller, source, input.requestId)).resolves.toMatchObject({ requestId: input.requestId })
    }
    await service.forget('session', 'target', empty ? first : undefined)
    await service.close()
    const reopened = await f.open()
    expect(await reopened.list(caller, source)).toEqual([])
    await expect(reopened.send(caller, source, input)).rejects.toMatchObject({ code: 'agent-mention-expired' })
    expect(f.delivered.size).toBe(1)
  },
)

test('reserves space for deleting a live exchange when the seven-day receipt budget is full', async () => {
  const f = await fixture()
  const input = body()
  const now = Date.now()
  const retired = Object.fromEntries(Array.from({ length: 32_767 }, (_, index) => [index.toString(16).padStart(64, '0'), now + 60_000]))
  await mkdir(join(f.directory, 'agents'), { mode: 0o700 })
  await writeFile(join(f.directory, 'agents', 'mentions.json'), JSON.stringify({ records: [], retired }), { mode: 0o600 })
  const service = await f.open()
  await service.send(caller, source, input)
  await expect(service.send(caller, source, body())).rejects.toMatchObject({ code: 'agent-mention-receipts-full' })
  await service.forget('session', 'target')
  expect(await service.list(caller, source)).toEqual([])
  await expect(service.send(caller, source, input)).rejects.toMatchObject({ code: 'agent-mention-expired' })
  await expect(service.send(caller, source, body())).rejects.toMatchObject({ code: 'agent-mention-receipts-full' })
  expect(f.delivered.size).toBe(1)
})
