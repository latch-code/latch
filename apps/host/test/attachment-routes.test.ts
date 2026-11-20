import { createRuntime } from '@latch/core'
import { AppError, type CreateTaskInput } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentCapabilities, AttachmentRef, HarnessInfo, ReservedAttachments, TaskDetail } from '@latch/protocol'
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
  it('takes a sent attachment again as a draft (从这里编辑) only for a device that may read its session and write', async () => {
    const plugin: HarnessPlugin = {
      id: 'vision-reuse',
      name: 'fixture',
      version: '1',
      description: 'test',
      activate: ctx =>
        ctx.registerProvider({
          id: 'fixture-model',
          name: 'fixture',
          model: 'visual',
          modelCapabilities: { visual: { vision: true } },
          async *stream() {
            yield { type: 'text', text: 'seen' }
            yield { type: 'finish', reason: 'stop' }
          },
        }),
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const local = await host.enroll({ listener: 'unix' }),
      other = await host.enroll({ listener: 'unix' }),
      viewer = await host.enroll({ listener: 'unix', scopes: ['view'] })
    const selection = { harnessId: 'standard', model: { providerId: 'fixture-model', model: 'visual' } }
    const uploaded = await local.request('attachments', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-latch-attachment': Buffer.from(
          JSON.stringify({ requestId: randomUUID(), name: 'image.png', size: png.length, selection }),
        ).toString('base64url'),
      },
      rawBody: png,
    })
    const ref = ((await uploaded.json()) as { attachment: AttachmentRef }).attachment
    // A draft not yet sent is no other device's to take.
    expect((await other.request(`attachments/${ref.id}/reuse`, { body: { requestId: randomUUID(), selection } })).status).toBe(404)
    const created = await local.json<{ sessionId: string }>('tasks', {
      body: { prompt: 'look', requestId: randomUUID(), harnessId: 'standard', model: selection.model, attachmentIds: [ref.id] },
    })
    await vi.waitFor(async () => expect((await local.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle'))
    expect((await viewer.request(`attachments/${ref.id}/reuse`, { body: { requestId: randomUUID(), selection } })).status).toBe(403)
    const requestId = randomUUID()
    const copy = await other.json<{ attachment: AttachmentRef }>(`attachments/${ref.id}/reuse`, { body: { requestId, selection } })
    expect(copy.attachment).toMatchObject({ name: 'image.png', sha256: ref.sha256 })
    expect(copy.attachment.id).not.toBe(ref.id)
    // Sent as a draft of its own, with a new message.
    const again = await other.json<{ sessionId: string }>('tasks', {
      body: {
        prompt: 'again',
        requestId: randomUUID(),
        harnessId: 'standard',
        model: selection.model,
        attachmentIds: [copy.attachment.id],
      },
    })
    await vi.waitFor(async () =>
      expect((await other.json<TaskDetail>(`tasks/${again.sessionId}`)).messages[0]!.attachments).toEqual([copy.attachment]),
    )
    expect((await local.json<TaskDetail>(`tasks/${created.sessionId}`)).messages[0]!.attachments).toEqual([ref])
  })
  it('takes a picture for a model that never declared vision, to go by its path, and text-only attachment messages', async () => {
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
    const picture = await upload(png, 'image.png')
    expect(picture.status).toBe(201)
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
    await desktop.confirmedJson('agents', {
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
    const now = { prompt: 'now', requestId: randomUUID(), attachmentIds: [uploaded.attachment.id] }
    expect((await desktop.request(`tasks/${existing.sessionId}/prompt`, { body: now })).status).toBe(200)
    // Its retry from this device is answered as taken and binds the same upload again, a no-op once bound.
    expect((await desktop.request(`tasks/${existing.sessionId}/prompt`, { body: now })).status).toBe(200)
    const sent = (await desktop.json<TaskDetail>(`tasks/${existing.sessionId}`)).messages.filter(
      message => message.requestId === now.requestId,
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.attachments?.map(ref => ref.id)).toEqual([uploaded.attachment.id])
    const index = JSON.parse(await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8'))
    expect(index.entries[uploaded.attachment.id].taskId).toBe(existing.sessionId)
  })
  it('releases a prompt claim when the Harness could not start: a 503 that says nothing was accepted', async () => {
    let failing = false
    const plugin: HarnessPlugin = {
      id: 'flaky-start',
      name: 'flaky',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'flaky-model',
          name: 'flaky',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
        ctx.registerHarness({
          id: 'flaky-harness',
          name: 'flaky',
          version: '1',
          capabilities: { models: { owner: 'latch' }, modes: ['chat'], attachments: { images: true, text: true } },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'prompt' && failing)
                  return () => Promise.reject(new AppError(503, 'agent-start-failed', 'flaky 启动失败：进程退出（退出码 1）'))
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
      model = { providerId: 'flaky-model', model: 'fixture' }
    const existing = await desktop.json<{ sessionId: string }>('tasks', {
      body: { prompt: 'initial', mode: 'chat', harnessId: 'flaky-harness', model, requestId: randomUUID() },
    })
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${existing.sessionId}`)).summary.status).toBe('idle'))
    const bytes = Buffer.from('later'),
      uploaded = await desktop.json<{ attachment: AttachmentRef }>('attachments', {
        rawBody: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(
            JSON.stringify({
              requestId: randomUUID(),
              name: 'later.txt',
              size: bytes.length,
              selection: { harnessId: 'flaky-harness', model },
            }),
          ).toString('base64url'),
        },
        method: 'POST',
      })
    failing = true
    const refused = await desktop.request(`tasks/${existing.sessionId}/prompt`, {
      body: { prompt: 'not now', requestId: randomUUID(), attachmentIds: [uploaded.attachment.id] },
    })
    expect(refused.status).toBe(503)
    expect(((await refused.json()) as { error: string }).error).toBe('agent-start-failed')
    const index = JSON.parse(await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8'))
    expect(index.entries[uploaded.attachment.id].claim).toBeUndefined()
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
  it('learns what an agent takes natively from its first session, without 测试启动, and takes every file before that', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const desktop = await host.enroll({ listener: 'unix' })
    const define = (id: string, caps: string) =>
      desktop.confirmedJson('agents', {
        body: { id, name: id, command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CAPS: caps } },
      })
    await define('seeing-agent', 'images,embedded')
    await define('plain-agent', 'delete')
    const caps = async (harnessId: string) =>
      (await desktop.json<{ capabilities: AttachmentCapabilities }>('attachments/capabilities', { body: { selection: { harnessId } } }))
        .capabilities
    const reported = async (id: string) =>
      (await desktop.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses.find(item => item.id === id)
        ?.attachmentsReported
    const before = await caps('seeing-agent')
    // Not started yet: every file goes by its path until the agent says what it takes natively.
    expect(before).toMatchObject({ images: false, text: false, files: true, fileBytes: 50 * 1024 * 1024, imageBytes: 5 * 1024 * 1024 })
    expect(before.reason).toBeUndefined()
    expect(await reported('seeing-agent')).toBeUndefined()
    for (const harnessId of ['seeing-agent', 'plain-agent']) {
      const created = await desktop.confirmed('tasks', { body: { prompt: 'hello', requestId: randomUUID(), harnessId } })
      expect(created.status).toBe(201)
      const { sessionId } = (await created.json()) as { sessionId: string }
      await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), {
        timeout: 10000,
      })
    }
    expect(await caps('seeing-agent')).toMatchObject({ images: true, text: true })
    expect((await caps('seeing-agent')).reason).toBeUndefined()
    expect(await reported('seeing-agent')).toEqual({ images: true, text: true })
    expect(await caps('plain-agent')).toMatchObject({ images: false, text: false, files: true })
    expect((await caps('plain-agent')).reason).toBeUndefined()
    expect(await reported('plain-agent')).toEqual({ images: false, text: false })
  })
  it('lets a device release only its own reserved uploads that no saved message or request needs, and audits it', async () => {
    const failures = { create: false, createAfter: false, prompt: false }
    const plugin: HarnessPlugin = {
      id: 'reserving',
      name: 'reserving',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'reserving-model',
          name: 'reserving',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
        ctx.registerHarness({
          id: 'reserving-harness',
          name: 'reserving',
          version: '1',
          capabilities: { models: { owner: 'latch' }, modes: ['agent'], attachments: { text: true, textBytes: 256 * 1024 } },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'createTask')
                  return async (input: CreateTaskInput) => {
                    // Before anything is created: the request is given up with nothing saved.
                    if (failures.create) throw new AppError(503, 'fixture-unavailable', '测试暂时不可用')
                    const result = await target.createTask(input)
                    // After the session and its message exist: the message names the upload.
                    if (failures.createAfter) throw new AppError(503, 'fixture-create-unknown', '测试创建结果未知')
                    return result
                  }
                if (key === 'prompt')
                  return async (...args: Parameters<Bridge['prompt']>) => {
                    if (failures.prompt) throw new AppError(503, 'fixture-unavailable', '测试暂时不可用')
                    return target.prompt(...args)
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
      other = await host.enroll({ listener: 'unix' }),
      model = { providerId: 'reserving-model', model: 'fixture' }
    const upload = async (device: typeof desktop, text: string) =>
      (
        await device.json<{ attachment: AttachmentRef }>('attachments', {
          rawBody: Buffer.from(text),
          headers: {
            'content-type': 'application/octet-stream',
            'x-latch-attachment': Buffer.from(
              JSON.stringify({
                requestId: randomUUID(),
                name: 'note.txt',
                size: Buffer.byteLength(text),
                selection: { harnessId: 'reserving-harness', model },
              }),
            ).toString('base64url'),
          },
          method: 'POST',
        })
      ).attachment
    const start = (device: typeof desktop, ids: string[]) =>
      device.confirmed('tasks', {
        body: { prompt: 'start', requestId: randomUUID(), harnessId: 'reserving-harness', model, attachmentIds: ids },
      })
    const existing = (await (await start(desktop, [])).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${existing.sessionId}`)).summary.status).toBe('idle'))
    // Given up before the Host created anything: to a new session, and to the existing one.
    failures.create = true
    const newSession = await upload(desktop, 'for a new session')
    expect((await start(desktop, [newSession.id])).status).toBe(503)
    failures.create = false
    failures.prompt = true
    const toExisting = await upload(desktop, 'for the existing session')
    const promptBody = { prompt: 'more', requestId: randomUUID(), attachmentIds: [toExisting.id] }
    const prompted = await desktop.request(`tasks/${existing.sessionId}/prompt`, { body: promptBody })
    expect(prompted.status).toBe(503)
    failures.prompt = false
    // Created with its message, but the answer was lost: a retry still needs it.
    failures.createAfter = true
    const needed = await upload(desktop, 'a saved message names this')
    expect((await start(desktop, [needed.id])).status).toBe(503)
    failures.createAfter = false
    // Another device's reservation is never this device's to release.
    failures.create = true
    const others = await upload(other, 'another device')
    expect((await start(other, [others.id])).status).toBe(503)
    failures.create = false
    await vi.waitFor(async () => {
      const tasks = (await desktop.json<{ tasks: Array<{ status: string }> }>('snapshot')).tasks
      expect(tasks.every(task => task.status !== 'running')).toBe(true)
    })
    const reserved = await desktop.json<{ reserved: ReservedAttachments }>('attachments/reserved')
    expect(reserved.reserved).toMatchObject({ count: 3, releasable: 2 })
    expect((await desktop.request('attachments/reserved/release', { body: {} })).status).toBe(400)
    // Only what the person was shown: an ID of another device's, or one never shown, is not released.
    const shownIds = reserved.reserved.items.filter(item => item.releasable).map(item => item.id)
    expect(reserved.reserved.items.find(item => item.id === needed.id)?.releasable).toBe(false)
    const releaseId = randomUUID(),
      body = { requestId: releaseId, ids: [...shownIds, others.id] }
    const released = await desktop.json<{ released: { count: number; bytes: number } }>('attachments/reserved/release', { body })
    // A retry of the same request gets the first answer and releases nothing more; another list under it is refused.
    expect(await desktop.json('attachments/reserved/release', { body })).toEqual(released)
    expect((await desktop.request('attachments/reserved/release', { body: { requestId: releaseId, ids: [needed.id] } })).status).toBe(409)
    expect(released.released).toEqual({
      count: 2,
      bytes: Buffer.byteLength('for a new session') + Buffer.byteLength('for the existing session'),
    })
    const index = JSON.parse(await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8')) as {
      entries: Record<string, unknown>
    }
    // A retry of the given-up request now hears, for certain, that its upload was released.
    const late = await desktop.request(`tasks/${existing.sessionId}/prompt`, { body: promptBody })
    expect(late.status).toBe(409)
    expect(await late.json()).toMatchObject({ error: 'attachment-released', message: expect.stringContaining('note.txt') })
    expect(index.entries[newSession.id]).toBeUndefined()
    expect(index.entries[toExisting.id]).toBeUndefined()
    expect(index.entries[needed.id]).toBeDefined()
    expect(index.entries[others.id]).toBeDefined()
    expect((await desktop.json<{ reserved: ReservedAttachments }>('attachments/reserved')).reserved).toMatchObject({
      count: 1,
      releasable: 0,
    })
    const audit = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; detail?: unknown })
      .filter(record => record.action === 'attachment.released')
    expect(audit).toEqual([expect.objectContaining({ detail: { requestId: releaseId, count: 2, bytes: released.released.bytes } })])
  })
})
describe('releasing reserved uploads while a retry is on its way', () => {
  it('keeps the upload a retried request is using, even when the retry arrives while the release reads the sessions', async () => {
    let failCreate = false,
      detailHeld: Promise<void> | undefined,
      createHeld: Promise<void> | undefined,
      detailEntered = 0,
      createEntered = 0,
      held = ''
    let openDetail!: () => void, openCreate!: () => void
    const plugin: HarnessPlugin = {
      id: 'race',
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
        ctx.registerHarness({
          id: 'race-harness',
          name: 'race',
          version: '1',
          capabilities: { models: { owner: 'latch' }, modes: ['agent'], attachments: { text: true, textBytes: 256 * 1024 } },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'createTask')
                  return async (input: CreateTaskInput) => {
                    if (failCreate) throw new AppError(503, 'fixture-unavailable', '测试暂时不可用')
                    createEntered++
                    await createHeld
                    return target.createTask(input)
                  }
                if (key === 'detail')
                  return async (id: string) => {
                    if (id === held) {
                      detailEntered++
                      await detailHeld
                    }
                    return target.detail(id)
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
      model = { providerId: 'race-model', model: 'fixture' }
    const existing = (await (
      await desktop.confirmed('tasks', { body: { prompt: 'start', requestId: randomUUID(), harnessId: 'race-harness', model } })
    ).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${existing.sessionId}`)).summary.status).toBe('idle'))
    const text = 'kept by the retry'
    const upload = (
      await desktop.json<{ attachment: AttachmentRef }>('attachments', {
        rawBody: Buffer.from(text),
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(
            JSON.stringify({
              requestId: randomUUID(),
              name: 'note.txt',
              size: Buffer.byteLength(text),
              selection: { harnessId: 'race-harness', model },
            }),
          ).toString('base64url'),
        },
        method: 'POST',
      })
    ).attachment
    const start = { prompt: 'with a file', requestId: randomUUID(), harnessId: 'race-harness', model, attachmentIds: [upload.id] }
    failCreate = true
    expect((await desktop.confirmed('tasks', { body: start })).status).toBe(503)
    failCreate = false
    const reserved = await desktop.json<{ reserved: ReservedAttachments }>('attachments/reserved')
    expect(reserved.reserved.items).toEqual([expect.objectContaining({ id: upload.id, releasable: true })])
    // The release stops while it reads the existing session; the retry of the original start arrives meanwhile.
    held = existing.sessionId
    detailHeld = new Promise(resolve => {
      openDetail = resolve
    })
    createHeld = new Promise(resolve => {
      openCreate = resolve
    })
    const releaseBody = { requestId: randomUUID(), ids: [upload.id] }
    const release = desktop.json<{ released: { count: number } }>('attachments/reserved/release', { body: releaseBody })
    await vi.waitFor(() => expect(detailEntered).toBeGreaterThan(0))
    // The same request again while the first is on its way waits for its answer; another list under it is refused.
    const copy = desktop.json<{ released: { count: number } }>('attachments/reserved/release', { body: releaseBody })
    const conflicting = await desktop.request('attachments/reserved/release', {
      body: { requestId: releaseBody.requestId, ids: [upload.id, 'Z'.repeat(22)] },
    })
    expect(conflicting.status).toBe(409)
    const retry = desktop.confirmed('tasks', { body: start })
    await vi.waitFor(() => expect(createEntered).toBeGreaterThan(1))
    openDetail()
    expect((await release).released.count).toBe(0)
    expect(await copy).toEqual(await release)
    openCreate()
    const retried = await retry
    expect(retried.status).toBe(201)
    const { sessionId } = (await retried.json()) as { sessionId: string }
    held = ''
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages[0]?.attachments?.[0]?.id).toBe(upload.id)
    const index = JSON.parse(await readFile(join(host.dataDir, 'attachments', 'index.json'), 'utf8')) as {
      entries: Record<string, { taskId?: string }>
    }
    expect(index.entries[upload.id]?.taskId).toBe(sessionId)
  })
  it('holds a plugin Harness to what it reported when it started, over what it declared', async () => {
    let reported: { images: boolean; text: boolean } | undefined
    const plugin: HarnessPlugin = {
      id: 'reporting',
      name: 'reporting',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerHarness({
          id: 'reporting-harness',
          name: 'reporting',
          version: '1',
          capabilities: { models: { owner: 'harness' }, modes: ['agent'], attachments: { images: true, text: true } },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'promptCapabilities') return () => reported
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
    const desktop = await host.enroll({ listener: 'unix' })
    const caps = async () =>
      (
        await desktop.json<{ capabilities: AttachmentCapabilities }>('attachments/capabilities', {
          body: { selection: { harnessId: 'reporting-harness' } },
        })
      ).capabilities
    expect(await caps()).toMatchObject({ images: true, text: true })
    reported = { images: false, text: true }
    expect(await caps()).toMatchObject({ images: false, text: true })
  })
  it('holds a plugin Harness on Latch model services to what it reported too', async () => {
    let reported: { images: boolean; text: boolean } | undefined
    const plugin: HarnessPlugin = {
      id: 'reporting-latch',
      name: 'reporting',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'seeing',
          name: 'seeing',
          model: 'fixture',
          modelCapabilities: { fixture: { vision: true } },
          async *stream() {
            yield { type: 'finish', reason: 'stop' }
          },
        })
        ctx.registerHarness({
          id: 'reporting-latch',
          name: 'reporting',
          version: '1',
          capabilities: { models: { owner: 'latch' }, modes: ['agent'], attachments: { images: true, text: true } },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'promptCapabilities') return () => reported
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
    const desktop = await host.enroll({ listener: 'unix' })
    const caps = async () =>
      (
        await desktop.json<{ capabilities: AttachmentCapabilities }>('attachments/capabilities', {
          body: { selection: { harnessId: 'reporting-latch', model: { providerId: 'seeing', model: 'fixture' } } },
        })
      ).capabilities
    expect(await caps()).toMatchObject({ images: true, text: true })
    reported = { images: false, text: true }
    // What it does not take natively goes by its path: said by `images`, not as a refusal.
    expect(await caps()).toMatchObject({ images: false, text: true, files: true })
    expect((await caps()).reason).toBeUndefined()
  })
})
describe('whether the snapshot lists every session', () => {
  it('says so only when every Harness listed, so a page never drops a draft on a partial list', async () => {
    const whole = await startTestHost()
    hosts.push(whole)
    const device = await whole.enroll({ listener: 'unix' })
    expect((await device.json<{ tasksComplete?: true }>('snapshot')).tasksComplete).toBe(true)
    const broken: HarnessPlugin = {
      id: 'unlisting',
      name: 'Unlisting',
      version: '1',
      description: 'test',
      activate: ctx =>
        ctx.registerHarness({
          id: 'unlisting',
          name: 'Unlisting',
          version: '1',
          create: options => {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'listTasks')
                  return async () => {
                    throw new Error('cannot list')
                  }
                const value: unknown = Reflect.get(target, key, receiver)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          },
        }),
    }
    // A saved Agent turned off lists nothing: its sessions may exist.
    await device.confirmedJson('agents', {
      body: { id: 'resting', name: 'Resting', command: process.execPath, args: [FAKE_ACP_AGENT], enabled: false },
    })
    expect((await device.json<{ tasksComplete?: true }>('snapshot')).tasksComplete).toBeUndefined()
    // A Harness that never mounted (its start failed) is configured but not listed.
    const unmountable: HarnessPlugin = {
      id: 'unmountable',
      name: 'Unmountable',
      version: '1',
      description: 'test',
      activate: ctx =>
        ctx.registerHarness({
          id: 'unmountable',
          name: 'Unmountable',
          version: '1',
          create: () => {
            throw new Error('cannot start')
          },
        }),
    }
    const failed = await startTestHost({ plugins: [unmountable] })
    hosts.push(failed)
    const third = await failed.enroll({ listener: 'unix' })
    expect((await third.json<{ tasksComplete?: true }>('snapshot')).tasksComplete).toBeUndefined()
    const partial = await startTestHost({ plugins: [broken] })
    hosts.push(partial)
    const other = await partial.enroll({ listener: 'unix' })
    expect((await other.json<{ tasksComplete?: true }>('snapshot')).tasksComplete).toBeUndefined()
  })
})
