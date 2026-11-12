import { createRuntime } from '@latch/core'
import { AppError, type CreateTaskInput } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentRef, TaskDetail } from '@latch/protocol'
import type { Bridge, ModelMessage, HarnessPlugin } from '@latch/sdk'
import { AttachmentStore, ATTACHMENT_CLAIM_TTL } from '../src/attachments.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
describe('authenticated attachment routes', () => {
  it('uploads raw bytes on the desktop socket, hands only embedded content to a declared visual model and keeps blobs out of public snapshots', async () => {
    const seen: ModelMessage[][] = []
    const plugin: HarnessPlugin = {
      id: 'vision-fixture',
      name: 'fixture',
      version: '1',
      description: 'test',
      activate: ctx =>
        ctx.registerProvider({
          id: 'fixture-model',
          name: 'fixture',
          model: 'visual',
          modelCapabilities: { visual: { vision: true } },
          async *stream({ messages }) {
            seen.push(structuredClone(messages))
            yield { type: 'text', text: 'seen' }
            yield { type: 'finish', reason: 'stop' }
          },
        }),
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const local = await host.enroll({ listener: 'unix' }),
      other = await host.enroll({ listener: 'unix' })
    const selection = { harnessId: 'standard', model: { providerId: 'fixture-model', model: 'visual' } },
      requestId = randomUUID(),
      metadata = { requestId, name: 'image.png', size: png.length, selection }
    const upload = () =>
      local.request('attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(JSON.stringify(metadata)).toString('base64url'),
        },
        rawBody: png,
      })
    const response = await upload()
    expect(response.status).toBe(201)
    const ref = ((await response.json()) as { attachment: AttachmentRef }).attachment
    expect((await upload()).status).toBe(201)
    expect((await other.request(`attachments/${ref.id}/resolve`, { body: {} })).status).toBe(404)
    const creationRequestId = randomUUID()
    const created = await local.json<{ sessionId: string }>('tasks', {
      body: { prompt: 'look', requestId: creationRequestId, harnessId: 'standard', model: selection.model, attachmentIds: [ref.id] },
    })
    await vi.waitFor(async () => expect((await local.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle'))
    const replay = await local.json<{ sessionId: string }>('tasks', {
      body: { prompt: 'look', requestId: creationRequestId, harnessId: 'standard', model: selection.model, attachmentIds: [ref.id] },
    })
    expect(replay).toEqual(created)
    expect(seen).toHaveLength(1)
    expect(seen[0]![1]!.attachments).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }])
    const detail = await local.json<TaskDetail>(`tasks/${created.sessionId}`)
    expect(detail.messages[0]!.attachments).toEqual([ref])
    expect(JSON.stringify(detail)).not.toContain(png.toString('base64'))
    expect(await readFile(join(host.dataDir, 'sessions', 'runtime.json'), 'utf8')).not.toContain(png.toString('base64'))
    expect((await stat(join(host.dataDir, 'attachments', created.sessionId, ref.id))).mode & 0o777).toBe(0o600)
    const resolved = await other.json<{ file: { handle: string; source: string } }>(`attachments/${ref.id}/resolve`, { body: {} })
    expect(resolved.file.source).toBe('attachment')
    expect((await local.request(`attachments/${resolved.file.handle}/content`)).status).toBe(404)
    const bytes = await other.request(`attachments/${resolved.file.handle}/content`, { headers: { range: 'bytes=1-3' } })
    expect(bytes.status).toBe(206)
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(png.subarray(1, 4))
    expect(bytes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    await local.request(`tasks/${created.sessionId}`, { method: 'DELETE' })
    expect((await other.request(`attachments/${resolved.file.handle}/content`)).status).toBe(404)
    await expect(readFile(join(host.dataDir, 'attachments', created.sessionId, ref.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses image uploads for a model that never declared vision and supports text-only attachment messages', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const local = await host.enroll({ listener: 'unix' })
    const upload = async (bytes: Buffer, name: string) =>
      local.request('attachments', {
        method: 'POST',
        rawBody: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(
            JSON.stringify({ requestId: randomUUID(), name, size: bytes.length, selection: { harnessId: 'standard' } }),
          ).toString('base64url'),
        },
      })
    const denied = await upload(png, 'image.png')
    expect(denied.status).toBe(415)
    const uploaded = await upload(Buffer.from('logs'), 'note.txt')
    expect(uploaded.status).toBe(201)
    const ref = ((await uploaded.json()) as { attachment: AttachmentRef }).attachment
    const result = await local.request('tasks', { body: { requestId: randomUUID(), prompt: '', attachmentIds: [ref.id] } })
    expect(result.status).toBe(201)
  })
  it('carries real negotiated image blocks through the fake ACP process and publishes its image as a private ref', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const desktop = await host.enroll({ listener: 'unix' })
    await desktop.json('agents', {
      body: {
        id: 'attachment-agent',
        name: 'Attachment Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CAPS: 'images,embedded' },
      },
    })
    const probe = await desktop.confirmed('agents/attachment-agent/probe', { body: { requestId: randomUUID() } })
    expect(probe.status).toBe(200)
    expect(await probe.json()).toMatchObject({ capabilities: { images: true, embeddedContext: true } })
    const uploaded = await desktop.json<{ attachment: AttachmentRef }>('attachments', {
      method: 'POST',
      rawBody: png,
      headers: {
        'content-type': 'application/octet-stream',
        'x-latch-attachment': Buffer.from(
          JSON.stringify({ requestId: randomUUID(), name: 'look.png', size: png.length, selection: { harnessId: 'attachment-agent' } }),
        ).toString('base64url'),
      },
    })
    const created = await desktop.confirmed('tasks', {
      body: { prompt: 'image-output', requestId: randomUUID(), harnessId: 'attachment-agent', attachmentIds: [uploaded.attachment.id] },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), {
      timeout: 10000,
    })
    const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages[0]!.attachments?.[0]?.id).toBe(uploaded.attachment.id)
    const output = detail.messages.find(message => message.role === 'assistant' && message.attachments)?.attachments?.[0]
    expect(output).toMatchObject({ kind: 'image', name: 'Agent-image.png' })
    const resolved = await desktop.json<{ file: { handle: string } }>(`attachments/${output!.id}/resolve`, { body: {} })
    expect((await desktop.request(`attachments/${resolved.file.handle}/content`)).status).toBe(200)
    const metadata = await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8')
    expect(metadata).not.toContain(png.toString('base64'))
    expect(JSON.stringify(detail)).not.toContain('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')
  })
  it('allows only one concurrent create or existing prompt to consume a draft and replays the winning request', async () => {
    const plugin: HarnessPlugin = {
      id: 'race-provider',
      name: 'race',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'race-model',
          name: 'race',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const desktop = await host.enroll({ listener: 'unix' }),
      model = { providerId: 'race-model', model: 'fixture' }
    const existing = await desktop.json<{ sessionId: string }>('tasks', {
      body: { prompt: 'initial', mode: 'chat', model, requestId: randomUUID() },
    })
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${existing.sessionId}`)).summary.status).toBe('idle'))
    const bytes = Buffer.from('race content'),
      uploaded = await desktop.json<{ attachment: AttachmentRef }>('attachments', {
        rawBody: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(
            JSON.stringify({ requestId: randomUUID(), name: 'race.txt', size: bytes.length, selection: { harnessId: 'standard', model } }),
          ).toString('base64url'),
        },
        method: 'POST',
      })
    const a = { prompt: 'new', mode: 'chat', model, requestId: randomUUID(), attachmentIds: [uploaded.attachment.id] },
      b = { prompt: 'existing', requestId: randomUUID(), attachmentIds: [uploaded.attachment.id] }
    const [created, prompted] = await Promise.all([
      desktop.request('tasks', { body: a }),
      desktop.request(`tasks/${existing.sessionId}/prompt`, { body: b }),
    ])
    expect([created, prompted].filter(response => response.ok)).toHaveLength(1)
    const loser = created.ok ? prompted : created
    expect([404, 409]).toContain(loser.status)
    const original = created.ok ? ((await created.json()) as { sessionId: string }) : existing
    const replay = created.ok
      ? await desktop.json<{ sessionId: string }>('tasks', { body: a })
      : await desktop.json<{ accepted: boolean }>(`tasks/${existing.sessionId}/prompt`, { body: b })
    expect(replay).toEqual(created.ok ? original : { accepted: true })
    const index = JSON.parse(await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8'))
    expect(index.entries[uploaded.attachment.id].taskId).toBe(original.sessionId)
    expect(index.entries[uploaded.attachment.id].creationRequestId).toBe(created.ok ? a.requestId : undefined)
    expect(index.entries[uploaded.attachment.id].claim).toBeUndefined()
    const detail = await desktop.json<TaskDetail>(`tasks/${original.sessionId}`)
    expect(
      detail.messages.filter(message => message.role === 'user' && message.attachments?.some(ref => ref.id === uploaded.attachment.id)),
    ).toHaveLength(1)
  })
  it('releases a prompt claim after a definitive running-session refusal, so the draft can be sent later', async () => {
    let release: (() => void) | undefined,
      calls = 0
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    const plugin: HarnessPlugin = {
      id: 'waiting-provider',
      name: 'wait',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'waiting-model',
          name: 'wait',
          model: 'fixture',
          async *stream() {
            if (++calls === 1) await waiting
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const desktop = await host.enroll({ listener: 'unix' }),
      model = { providerId: 'waiting-model', model: 'fixture' }
    const existing = await desktop.json<{ sessionId: string }>('tasks', {
      body: { prompt: 'initial', mode: 'chat', model, requestId: randomUUID() },
    })
    const bytes = Buffer.from('later'),
      uploaded = await desktop.json<{ attachment: AttachmentRef }>('attachments', {
        rawBody: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(
            JSON.stringify({ requestId: randomUUID(), name: 'later.txt', size: bytes.length, selection: { harnessId: 'standard', model } }),
          ).toString('base64url'),
        },
        method: 'POST',
      })
    try {
      const refused = await desktop.request(`tasks/${existing.sessionId}/prompt`, {
        body: { prompt: 'not yet', requestId: randomUUID(), attachmentIds: [uploaded.attachment.id] },
      })
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as { error: string }).error).toBe('task-running')
      const index = JSON.parse(await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8'))
      expect(index.entries[uploaded.attachment.id].claim).toBeUndefined()
    } finally {
      release!()
    }
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${existing.sessionId}`)).summary.status).toBe('idle'))
    expect(
      (
        await desktop.request(`tasks/${existing.sessionId}/prompt`, {
          body: { prompt: 'now', requestId: randomUUID(), attachmentIds: [uploaded.attachment.id] },
        })
      ).status,
    ).toBe(200)
  })
  it('keeps the original claim after an accepted-but-unacknowledged creation and does not create a duplicate on retry', async () => {
    let loseResponse = true,
      starts = 0
    const plugin: HarnessPlugin = {
      id: 'unknown-create',
      name: 'unknown',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'unknown-model',
          name: 'unknown',
          model: 'fixture',
          async *stream() {
            starts++
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
        ctx.registerHarness({
          id: 'unknown-harness',
          name: 'unknown',
          version: '1',
          capabilities: { models: { owner: 'latch' }, modes: ['agent'], attachments: { text: true, textBytes: 256 * 1024 } },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'createTask')
                  return async (input: CreateTaskInput) => {
                    const result = await target.createTask(input)
                    if (loseResponse) {
                      loseResponse = false
                      throw new AppError(503, 'fixture-create-unknown', '测试创建结果未知')
                    }
                    return result
                  }
                const value: unknown = Reflect.get(target, key, receiver)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          },
        })
      },
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const desktop = await host.enroll({ listener: 'unix' }),
      model = { providerId: 'unknown-model', model: 'fixture' },
      bytes = Buffer.from('unknown content')
    const uploaded = await desktop.json<{ attachment: AttachmentRef }>('attachments', {
      rawBody: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'x-latch-attachment': Buffer.from(
          JSON.stringify({
            requestId: randomUUID(),
            name: 'unknown.txt',
            size: bytes.length,
            selection: { harnessId: 'unknown-harness', model },
          }),
        ).toString('base64url'),
      },
      method: 'POST',
    })
    const input = {
      prompt: 'unknown',
      requestId: randomUUID(),
      harnessId: 'unknown-harness',
      model,
      attachmentIds: [uploaded.attachment.id],
    }
    const unknown = await desktop.confirmed('tasks', { body: input })
    expect(unknown.status).toBe(503)
    const index = JSON.parse(await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8'))
    expect(index.entries[uploaded.attachment.id].claim).toEqual({ requestId: input.requestId })
    const different = await desktop.request('tasks', { body: { ...input, requestId: randomUUID() } })
    expect(different.status).toBe(409)
    expect(await different.json()).toMatchObject({ error: 'attachment-claimed' })
    const retried = await desktop.confirmed('tasks', { body: input })
    expect(retried.status).toBe(201)
    const { sessionId } = (await retried.json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    expect(starts).toBe(1)
    expect((await host.host.bridge.listTasks()).filter(task => task.harnessId === 'unknown-harness')).toHaveLength(1)
  })

  it('keeps at startup every reserved draft whose session it could not read, and lets go only of one a listed session does not name', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-claims-'))
    try {
      const first = await startTestHost({ dataDir })
      const owner = await first.enroll({ listener: 'unix' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { body: { prompt: '会话', requestId: randomUUID() } })
      await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
      await first.close()
      // Drafts reserved by given-up prompts: to the listed session, to a session of a Harness that cannot list, and to
      // a session no Harness knows.
      const store = await AttachmentStore.open(dataDir, { deferPrune: true })
      const reserve = async (text: string, session: string) => {
        const requestId = randomUUID()
        const ref = await store.add({
          owner: 'device-a',
          requestId,
          name: 'note.txt',
          size: Buffer.byteLength(text),
          remote: false,
          stream: (async function* () {
            yield Buffer.from(text)
          })(),
          recheck: () => {},
          accept: () => {},
        })
        await store.claim('device-a', [ref.id], randomUUID(), session)
        return ref
      }
      const unused = await reserve('given up', sessionId),
        failing = await reserve('Harness cannot list', 'task-of-broken-harness'),
        unknown = await reserve('no Harness knows it', 'task-unknown')
      const broken: Bridge = {
        start: async () => {},
        close: async () => {},
        listTasks: async () => {
          throw new Error('cannot list')
        },
        detail: async () => {
          throw new Error('cannot read')
        },
        createTask: async () => ({ sessionId: 'task-of-broken-harness' }),
        prompt: async () => {},
        cancel: async () => {},
        approvals: () => [],
        decide: async () => false,
        subscribe: () => () => {},
      }
      const plugin: HarnessPlugin = {
        id: 'broken-harness',
        name: 'Broken',
        version: '1',
        description: 'test',
        activate: ctx => ctx.registerHarness({ id: 'broken', name: 'Broken', version: '1', create: () => broken }),
      }
      const later = await startTestHost({ dataDir, plugins: [plugin], now: () => Date.now() + ATTACHMENT_CLAIM_TTL + 60_000 })
      await later.close()
      const after = await AttachmentStore.open(dataDir, { deferPrune: true })
      expect(after.get(unused.id)).toBeUndefined()
      expect(after.get(failing.id)).toBeDefined()
      expect(after.get(unknown.id)).toBeDefined()
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
