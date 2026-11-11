import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import {
  locateNote,
  noteLinesLabel,
  reviewNotesMessage,
  type AppSnapshot,
  type ReviewNote,
  type ReviewNoteList,
  type ReviewNoteSendResult,
  type TaskDetail,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { ReviewNotes } from '../src/review-notes.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const SLOW = { timeout: 15_000 }
const temporary: string[] = []
const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

const lines = (...texts: string[]) => texts
const note = (start: number, snippet: string[]) => ({ range: { start, end: start + snippet.length - 1 }, anchor: { lines: snippet } })

describe('locating a note', () => {
  const file = lines('import a', 'function total(rows) {', '  const sum = rows.reduce(add, 0)', '  return sum', '}', '', 'export { total }')

  it('stays where its lines still are', () => {
    expect(locateNote(note(3, ['  const sum = rows.reduce(add, 0)', '  return sum']), file)).toEqual({ state: 'exact', start: 3, end: 4 })
  })

  it('follows its exact lines to the nearest place they moved to', () => {
    const moved = ['// header', '// more', ...file]
    expect(locateNote(note(3, ['  const sum = rows.reduce(add, 0)', '  return sum']), moved)).toEqual({ state: 'moved', start: 5, end: 6 })
  })

  it('goes stale rather than onto other code: changed lines, two equally near copies, or lines too thin to tell apart', () => {
    const changed = file.map(text => text.replace('reduce(add, 0)', 'reduce(add, 1)'))
    expect(locateNote(note(3, ['  const sum = rows.reduce(add, 0)']), changed)).toEqual({ state: 'stale' })
    const twice = ['  return value', 'x', '  return value']
    expect(locateNote(note(2, ['  return value']), twice)).toEqual({ state: 'stale' })
    expect(locateNote(note(4, ['}']), ['}', 'a', 'b', 'c', 'd'])).toEqual({ state: 'stale' })
    expect(locateNote(note(1, ['  return sum']), file, 1)).toEqual({ state: 'stale' })
    // One short line could be anywhere: it does not move, though an exact copy is right below.
    expect(locateNote(note(1, ['  return sum']), ['x', ...file])).toEqual({ state: 'stale' })
    expect(locateNote(note(1, ['  const sum = rows.reduce(add, 0)']), ['x', ...file])).toEqual({ state: 'moved', start: 4, end: 4 })
  })

  it('compares long lines as they were kept', () => {
    const long = 'x'.repeat(1500)
    expect(locateNote(note(1, ['x'.repeat(1000)]), [long])).toEqual({ state: 'exact', start: 1, end: 1 })
  })
})

describe('the message a send makes', () => {
  it('names each place, quotes its lines in a fence the code cannot close, and keeps the order', () => {
    const text = reviewNotesMessage([
      {
        path: 'src/a.ts',
        range: { start: 42, end: 43 },
        side: 'new',
        anchor: { scope: 'turn', linesHash: '', lines: ['const a = `x`', 'b'] },
        text: '改这里',
      },
      {
        path: 'b.md',
        folder: 'docs',
        range: { start: 3, end: 3 },
        side: 'old',
        anchor: { scope: 'turn', linesHash: '', lines: ['```js'] },
        text: '别删',
      },
    ])
    expect(text).toBe(
      [
        '请处理这 2 条代码反馈：',
        '1. src/a.ts 第 42–43 行\n```\nconst a = `x`\nb\n```\n改这里',
        '2. docs/b.md 第 3 行（修改前）\n````\n```js\n````\n别删',
      ].join('\n\n'),
    )
    expect(noteLinesLabel({ start: 18, end: 18 })).toBe('第 18 行')
  })
})

describe('the store', () => {
  const writer = { deviceId: 'dev_a', name: 'Mac' }
  const input = (requestId: string, text = '币种应来自账户设置') => ({
    requestId,
    root: 'default',
    path: 'src/a.ts',
    range: { start: 2, end: 3 },
    side: 'new' as const,
    scope: 'turn' as const,
    lines: ['b', 'c'],
    text,
  })

  async function store() {
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-notes-'))
    temporary.push(dataDir)
    return { dataDir, notes: await ReviewNotes.open({ dataDir }) }
  }

  it('answers a retry with its receipt, refuses the same request ID with other content, and keeps it all on disk', async () => {
    const { dataDir, notes } = await store()
    const requestId = randomUUID()
    const first = await notes.create('s1', writer, input(requestId))
    expect(await notes.create('s1', writer, input(requestId))).toEqual(first)
    await expect(notes.create('s1', writer, input(requestId, '别的'))).rejects.toMatchObject({ code: 'request-reused' })
    // The same request ID from another device is that device's own request.
    expect((await notes.create('s1', { deviceId: 'dev_b', name: '手机' }, input(requestId))).id).not.toBe(first.id)
    expect(first).toMatchObject({ status: 'pending', anchor: { linesHash: expect.stringMatching(/^[a-f0-9]{64}$/u), lines: ['b', 'c'] } })
    const again = await ReviewNotes.open({ dataDir })
    expect(again.list('s1').notes.map(item => item.id)).toEqual(notes.list('s1').notes.map(item => item.id))
    expect(again.counts(new Set(['s1', 's2']))).toEqual([{ sessionId: 's1', pending: 2, sent: 0, claimed: 0, reviewed: 0, revision: 2 }])
  })

  it('refuses a snippet that does not match its range, and a status before the note went out', async () => {
    const { notes } = await store()
    await expect(notes.create('s1', writer, { ...input(randomUUID()), lines: ['b'] })).rejects.toMatchObject({ code: 'review-note-lines' })
    const created = await notes.create('s1', writer, input(randomUUID()))
    await expect(notes.setStatus('s1', writer, created.id, { requestId: randomUUID(), status: 'reviewed' })).rejects.toMatchObject({
      code: 'review-note-not-sent',
    })
  })

  it('keeps notes pending while a send is open, and pending again when it is refused', async () => {
    const { notes } = await store()
    const created = await notes.create('s1', writer, input(randomUUID()))
    const requestId = randomUUID()
    const begun = await notes.beginSend('s1', writer, { requestId, noteIds: [created.id] }, () => 'message')
    expect('open' in begun && begun.open.prompt).toBe('message')
    expect(notes.list('s1').notes[0]).toMatchObject({ status: 'pending', sending: true })
    // Open: no edit, no delete, no second send.
    await expect(notes.edit('s1', writer, created.id, { requestId: randomUUID(), text: 'x' })).rejects.toMatchObject({
      code: 'review-note-sent',
    })
    await expect(notes.remove('s1', writer, created.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'review-note-sending' })
    await expect(notes.beginSend('s1', writer, { requestId: randomUUID(), noteIds: [created.id] }, () => 'm')).rejects.toMatchObject({
      code: 'review-note-sent',
    })
    // The retry gets the same message and the same Host request ID back, never new ones.
    const retry = await notes.beginSend('s1', writer, { requestId, noteIds: [created.id] }, () => 'other')
    expect('open' in retry && retry.open).toMatchObject({
      prompt: 'message',
      promptRequestId: 'open' in begun && begun.open.promptRequestId,
    })
    // The message goes with the Host's own request ID, not the device's.
    expect('open' in begun && begun.open.promptRequestId).not.toBe(requestId)
    await notes.dropSend('s1', 'open' in begun ? begun.open.id : '')
    expect(notes.list('s1').notes[0]!.sending).toBeUndefined()
  })

  it('refuses a message longer than the prompt path takes, and keeps nothing of it', async () => {
    const { dataDir, notes } = await store()
    const created = await notes.create('s1', writer, input(randomUUID()))
    const revision = notes.list('s1').revision
    await expect(
      notes.beginSend('s1', writer, { requestId: randomUUID(), noteIds: [created.id] }, () => 'x'.repeat(16_001)),
    ).rejects.toMatchObject({
      status: 413,
      code: 'review-note-too-long',
    })
    expect(notes.list('s1')).toMatchObject({ revision, notes: [{ status: 'pending' }] })
    expect(notes.list('s1').notes[0]!.sending).toBeUndefined()
    expect(notes.openSends('s1')).toEqual([])
    expect((await ReviewNotes.open({ dataDir })).openSends('s1')).toEqual([])
  })

  it('skips a file that does not match its strict schema', async () => {
    const { dataDir, notes } = await store()
    await notes.create('s1', writer, input(randomUUID()))
    const [name] = (await readdir(join(dataDir, 'review-notes'))).filter(file => file.endsWith('.json'))
    const path = join(dataDir, 'review-notes', name!)
    const stored = JSON.parse(await readFile(path, 'utf8')) as { notes: Array<Record<string, unknown>> }
    stored.notes[0]!.extra = true
    await writeFile(path, JSON.stringify(stored))
    const logged: string[] = []
    const again = await ReviewNotes.open({ dataDir, log: text => logged.push(text) })
    expect(again.list('s1').notes).toEqual([])
    expect(logged).toHaveLength(1)
  })
})

describe('review note routes', { timeout: 30_000 }, () => {
  async function fixture() {
    const t = await startTestHost()
    hosts.push(t)
    await writeFile(join(t.workspaceRoot, 'a.ts'), 'one\ntwo\nthree\n')
    const owner = await t.enroll({ listener: 'unix' })
    const saved = await owner.request('agents', {
      method: 'POST',
      body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    expect(saved.status).toBe(201)
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
    const path = `tasks/${sessionId}/review-notes`
    const add = (device: TestDevice, text: string, requestId = randomUUID()) =>
      device.request(path, {
        method: 'POST',
        body: {
          requestId,
          root: 'default',
          path: 'a.ts',
          range: { start: 2, end: 3 },
          side: 'new',
          scope: 'turn',
          lines: ['two', 'three'],
          text,
        },
      })
    return { t, owner, sessionId, path, add }
  }
  const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })

  it('gives counts to every device that reads the session, and the notes only to one that may read its files', async () => {
    const { t, owner, sessionId, path, add } = await fixture()
    expect((await owner.json<AppSnapshot>('snapshot')).catalog?.features?.reviewNotes).toBe(true)
    expect((await add(owner, '这里不对')).status).toBe(201)
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    expect(await errorOf(await viewer.request(path))).toEqual({ status: 403, error: 'file-scope' })
    const counts = (await viewer.json<AppSnapshot>('snapshot')).reviewNotes
    expect(counts).toEqual([{ sessionId, pending: 1, sent: 0, claimed: 0, reviewed: 0, revision: 1 }])
    expect(JSON.stringify(counts)).not.toContain('这里不对')
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    expect((await viewer.json<ReviewNoteList>(path)).notes.map(item => item.text)).toEqual(['这里不对'])
    // Reading is not writing.
    expect((await add(viewer, '不行')).status).toBe(403)
    // A device with run but not the files' data scope writes nothing either.
    const runner = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    expect(await errorOf(await add(runner, '不行'))).toEqual({ status: 403, error: 'file-scope' })
    expect(await errorOf(await owner.request('tasks/nope/review-notes'))).toEqual({ status: 404, error: 'task-not-found' })
  })

  it('refuses a file outside the session folders', async () => {
    const { owner, path } = await fixture()
    const body = {
      requestId: randomUUID(),
      root: 'elsewhere',
      path: 'a.ts',
      range: { start: 1, end: 1 },
      side: 'new',
      scope: 'turn',
      lines: ['one'],
      text: 'x',
    }
    expect(await errorOf(await owner.request(path, { method: 'POST', body }))).toEqual({ status: 400, error: 'review-note-file' })
    expect(await errorOf(await owner.request(path, { method: 'POST', body: { ...body, root: 'default', path: '../x' } }))).toEqual({
      status: 400,
      error: 'review-note-file',
    })
  })

  it('sends notes as one message, marks them sent with its ID, and answers a retry without sending again', async () => {
    const { owner, sessionId, path, add } = await fixture()
    const first = (await (await add(owner, '这里不对')).json()) as ReviewNote
    const second = (await (await add(owner, '还有这里')).json()) as ReviewNote
    const edited = await owner.json<ReviewNote>(`${path}/${second.id}/edit`, {
      method: 'POST',
      body: { requestId: randomUUID(), text: '还有这里，改名' },
    })
    expect(edited.text).toBe('还有这里，改名')
    const requestId = randomUUID()
    const send = { method: 'POST', body: { requestId, noteIds: [first.id, second.id] } }
    const result = await owner.json<ReviewNoteSendResult>(`${path}/send`, send)
    expect(result.messageId).toEqual(expect.any(String))
    const userMessages = async () =>
      (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.role === 'user')
    const sent = (await userMessages()).find(message => message.id === result.messageId)!
    expect(sent.text).toContain('请处理这 2 条代码反馈：')
    expect(sent.text).toContain('1. a.ts 第 2–3 行\n```\ntwo\nthree\n```\n这里不对')
    expect(sent.text).toContain('还有这里，改名')
    expect(await owner.json<ReviewNoteSendResult>(`${path}/send`, send)).toEqual(result)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
    expect((await userMessages()).filter(message => message.text.startsWith('请处理这 2 条代码反馈'))).toHaveLength(1)
    expect(sent.requestId).not.toBe(requestId)

    const list = await owner.json<ReviewNoteList>(path)
    expect(list.notes.map(item => [item.status, item.messageId])).toEqual([
      ['sent', result.messageId],
      ['sent', result.messageId],
    ])
    // Sent notes no longer change their words, and a second send of them is refused.
    expect((await owner.request(`${path}/${first.id}/edit`, { method: 'POST', body: { requestId: randomUUID(), text: 'x' } })).status).toBe(
      409,
    )
    expect((await owner.request(`${path}/send`, { method: 'POST', body: { requestId: randomUUID(), noteIds: [first.id] } })).status).toBe(
      409,
    )

    // The three states the person sets stay separate.
    const status = (id: string, value: string) =>
      owner.json<ReviewNote>(`${path}/${id}/status`, { method: 'POST', body: { requestId: randomUUID(), status: value } })
    expect((await status(first.id, 'agent-claimed')).status).toBe('agent-claimed')
    expect((await status(second.id, 'reviewed')).status).toBe('reviewed')
    expect((await owner.json<AppSnapshot>('snapshot')).reviewNotes).toEqual([
      { sessionId, pending: 0, sent: 0, claimed: 1, reviewed: 1, revision: expect.any(Number) },
    ])
    expect(await owner.json(`${path}/${first.id}/delete`, { method: 'POST', body: { requestId: randomUUID() } })).toEqual({
      deleted: first.id,
    })
    expect((await owner.json<ReviewNoteList>(path)).notes.map(item => item.id)).toEqual([second.id])
  })

  it('keeps notes pending when the Host refuses the message', async () => {
    const { owner, sessionId, path, add } = await fixture()
    const created = (await (await add(owner, '这里不对')).json()) as ReviewNote
    // A plain message is refused while a turn runs.
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'count 800', requestId: randomUUID() } })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('running')
    const refused = await owner.request(`${path}/send`, { method: 'POST', body: { requestId: randomUUID(), noteIds: [created.id] } })
    expect(refused.status).toBe(409)
    const after = await owner.json<ReviewNoteList>(path)
    expect(after.notes[0]).toMatchObject({ status: 'pending' })
    expect(after.notes[0]!.sending).toBeUndefined()
  })

  it('queues notes for the next turn while one runs, keeps them pending until the message goes out, and follows an edit', async () => {
    const { owner, sessionId, path, add } = await fixture()
    const created = (await (await add(owner, '这里不对')).json()) as ReviewNote
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'count 400', requestId: randomUUID() } })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('running')
    const requestId = randomUUID()
    const send = { method: 'POST', body: { requestId, noteIds: [created.id], queue: true } }
    const result = await owner.json<ReviewNoteSendResult>(`${path}/send`, send)
    expect(result).toEqual({ noteIds: [created.id], queueId: expect.any(String) })
    expect(await owner.json<ReviewNoteSendResult>(`${path}/send`, send)).toEqual(result)
    // The same request ID sent another way is another request.
    expect((await owner.request(`${path}/send`, { method: 'POST', body: { requestId, noteIds: [created.id] } })).status).toBe(409)
    // Nothing went out yet: pending and locked, and the person's marks wait for a real message.
    expect((await owner.json<ReviewNoteList>(path)).notes[0]).toMatchObject({ status: 'pending', sending: true, queueId: result.queueId })
    const mark = await owner.request(`${path}/${created.id}/status`, {
      method: 'POST',
      body: { requestId: randomUUID(), status: 'reviewed' },
    })
    expect(await errorOf(mark)).toEqual({ status: 409, error: 'review-note-not-sent' })
    // An edit of the queued item gives its message a new request ID; the note follows the item.
    await owner.json(`tasks/${sessionId}/queue/${result.queueId}`, { method: 'PATCH', body: { text: '改过的反馈消息' } })
    const sent = async () =>
      (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.find(
        message => message.role === 'user' && message.text === '改过的反馈消息',
      )?.id
    await expect.poll(sent, SLOW).toEqual(expect.any(String))
    await expect
      .poll(async () => (await owner.json<ReviewNoteList>(path)).notes[0], SLOW)
      .toMatchObject({ status: 'sent', messageId: await sent() })
  })

  it('returns queued notes to pending when their item is removed from the queue', async () => {
    const { owner, sessionId, path, add } = await fixture()
    const created = (await (await add(owner, '这里不对')).json()) as ReviewNote
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'count 800', requestId: randomUUID() } })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('running')
    const { queueId } = await owner.json<ReviewNoteSendResult>(`${path}/send`, {
      method: 'POST',
      body: { requestId: randomUUID(), noteIds: [created.id], queue: true },
    })
    expect((await owner.request(`tasks/${sessionId}/queue/${queueId}`, { method: 'DELETE' })).status).toBe(200)
    const note = (await owner.json<ReviewNoteList>(path)).notes[0]!
    expect(note.status).toBe('pending')
    expect(note.sending).toBeUndefined()
    expect(note.queueId).toBeUndefined()
  })

  it('never settles notes with a message another request made', async () => {
    const { owner, sessionId, path, add } = await fixture()
    const created = (await (await add(owner, '这里不对')).json()) as ReviewNote
    const requestId = randomUUID()
    // A message whose request ID the device then reuses for the notes: it is not theirs.
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'unrelated', requestId } })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
    const other = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.find(message => message.requestId === requestId)!.id
    const result = await owner.json<ReviewNoteSendResult>(`${path}/send`, { method: 'POST', body: { requestId, noteIds: [created.id] } })
    expect(result.messageId).toEqual(expect.any(String))
    expect(result.messageId).not.toBe(other)
    const message = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.find(item => item.id === result.messageId)!
    expect(message.text).toContain('这里不对')
    expect(message.requestId).not.toBe(requestId)
  })

  it('lets any device retry or abandon a send whose answer never came, and drops a removed device’s', async () => {
    const { t, owner, sessionId, path, add } = await fixture()
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    await t.host.security.devices.setScopes(phone.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const busy = () => vi.spyOn(t.host.bridge, 'prompt').mockRejectedValueOnce(new AppError(503, 'agent-busy', 'Agent 正忙'))
    const open = async () => (await owner.json<ReviewNoteList>(path)).openSends ?? []

    const first = (await (await add(owner, '第一条')).json()) as ReviewNote
    busy()
    const failed = await owner.request(`${path}/send`, { method: 'POST', body: { requestId: randomUUID(), noteIds: [first.id] } })
    expect(failed.status).toBe(503)
    const [held] = await open()
    expect(held).toEqual({ id: expect.stringMatching(/^snd_/u), noteIds: [first.id] })
    expect((await owner.json<ReviewNoteList>(path)).notes[0]).toMatchObject({ status: 'pending', sending: true })
    // Another device retries with the Host's own request ID.
    const retried = await phone.json<ReviewNoteSendResult>(`${path}/sends/${held!.id}/retry`, {
      method: 'POST',
      body: { requestId: randomUUID() },
    })
    expect(retried.messageId).toEqual(expect.any(String))
    expect((await owner.json<ReviewNoteList>(path)).notes[0]).toMatchObject({ status: 'sent', messageId: retried.messageId })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')

    const second = (await (await add(owner, '第二条')).json()) as ReviewNote
    busy()
    expect((await owner.request(`${path}/send`, { method: 'POST', body: { requestId: randomUUID(), noteIds: [second.id] } })).status).toBe(
      503,
    )
    const [stuck] = await open()
    expect(await phone.json(`${path}/sends/${stuck!.id}/abandon`, { method: 'POST', body: { requestId: randomUUID() } })).toEqual({
      dropped: stuck!.id,
    })
    expect((await owner.json<ReviewNoteList>(path)).notes.find(note => note.id === second.id)).toMatchObject({ status: 'pending' })
    expect(await open()).toEqual([])

    // The phone's own send, then the phone is removed: nothing of it is on its way, so its notes are pending again.
    busy()
    expect((await phone.request(`${path}/send`, { method: 'POST', body: { requestId: randomUUID(), noteIds: [second.id] } })).status).toBe(
      503,
    )
    expect(await open()).toHaveLength(1)
    await t.host.security.devices.revoke(phone.id, 'manual', { listener: 'unix', via: 'http' })
    expect(await open()).toEqual([])
    expect((await owner.json<ReviewNoteList>(path)).notes.find(note => note.id === second.id)!.sending).toBeUndefined()
  })

  it('never leaves notes pending after their message went out when a retry and an abandon race', async () => {
    const { t, owner, sessionId, path, add } = await fixture()
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    await t.host.security.devices.setScopes(phone.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const idle = () => expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
    for (let round = 0; round < 12; round++) {
      const text = `第 ${round} 次`
      const created = (await (await add(owner, text)).json()) as ReviewNote
      vi.spyOn(t.host.bridge, 'prompt').mockRejectedValueOnce(new AppError(503, 'agent-busy', 'Agent 正忙'))
      expect(
        (await owner.request(`${path}/send`, { method: 'POST', body: { requestId: randomUUID(), noteIds: [created.id] } })).status,
      ).toBe(503)
      const [held] = (await owner.json<ReviewNoteList>(path)).openSends!
      const body = { method: 'POST', body: { requestId: randomUUID() } }
      await Promise.all([phone.request(`${path}/sends/${held!.id}/retry`, body), owner.request(`${path}/sends/${held!.id}/abandon`, body)])
      await idle()
      const delivered = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.some(
        message => message.role === 'user' && message.text.includes(`\n${text}`),
      )
      const note = (await owner.json<ReviewNoteList>(path)).notes.find(item => item.id === created.id)!
      if (delivered) expect(note, `round ${round}`).toMatchObject({ status: 'sent', messageId: expect.any(String) })
      else expect(note.status, `round ${round}`).toBe('pending')
      expect(note.sending, `round ${round}`).toBeUndefined()
    }
  }, 120_000)

  it('keeps a send open when the session cannot be read, instead of freeing its notes', async () => {
    const { t, owner, path, add } = await fixture()
    const created = (await (await add(owner, '这里不对')).json()) as ReviewNote
    vi.spyOn(t.host.bridge, 'prompt').mockRejectedValueOnce(new AppError(503, 'agent-busy', 'Agent 正忙'))
    expect((await owner.request(`${path}/send`, { method: 'POST', body: { requestId: randomUUID(), noteIds: [created.id] } })).status).toBe(
      503,
    )
    const [held] = (await owner.json<ReviewNoteList>(path)).openSends!
    const reading = vi.spyOn(t.host.bridge, 'detail').mockRejectedValue(new AppError(503, 'agent-busy', 'Agent 正忙'))
    const abandon = await owner.request(`${path}/sends/${held!.id}/abandon`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(abandon.status).toBeGreaterThanOrEqual(500)
    reading.mockRestore()
    expect((await owner.json<ReviewNoteList>(path)).notes[0]).toMatchObject({ status: 'pending', sending: true })
  })

  it('removes a session’s notes with the session', async () => {
    const { t, owner, sessionId, add } = await fixture()
    expect((await add(owner, '这里不对')).status).toBe(201)
    expect((await owner.request(`tasks/${sessionId}`, { method: 'DELETE' })).status).toBeLessThan(300)
    await expect.poll(async () => (await readdir(join(t.dataDir, 'review-notes'))).filter(name => name.endsWith('.json'))).toEqual([])
  })
})
