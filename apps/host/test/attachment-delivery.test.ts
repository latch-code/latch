import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentCapabilities, AttachmentRef, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
)
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(64, 1)])
/** The common files a person attaches, as their bytes begin. */
const FILES: Array<[string, Buffer]> = [
  ['截图.png', png],
  ['IMG_0001.HEIC', ftyp('heic')],
  ['clip.mp4', ftyp('isom')],
  ['clip.mov', ftyp('qt  ')],
  ['voice.mp3', Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000'), Buffer.alloc(64, 2)])],
  ['报告-2026 年第三季度经营分析（最终版）.pdf', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n')],
  ['main.ts', Buffer.from('export const answer = 42\n')],
  ['data.csv', Buffer.from('a,b\n1,2\n')],
  ['bundle.zip', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 3)])],
  ['blob.bin', Buffer.from([0, 1, 2, 3, 0, 255, 254])],
]
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function upload(device: TestDevice, bytes: Buffer, name: string, harnessId: string, model?: { providerId: string; model: string }) {
  const response = await device.request('attachments', {
    method: 'POST',
    rawBody: bytes,
    headers: {
      'content-type': 'application/octet-stream',
      'x-latch-attachment': Buffer.from(
        JSON.stringify({ requestId: randomUUID(), name, size: bytes.length, selection: { harnessId, ...(model ? { model } : {}) } }),
      ).toString('base64url'),
    },
  })
  expect(response.status, name).toBe(201)
  return ((await response.json()) as { attachment: AttachmentRef }).attachment
}
const idle = (device: TestDevice, sessionId: string) =>
  vi.waitFor(
    async () => {
      const detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
      expect(detail.summary.status, detail.messages.at(-1)?.text).toBe('idle')
    },
    { timeout: 15000 },
  )
const logOf = async (file: string) =>
  (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { event: string; blocks?: Array<{ type: string; text?: string; mimeType?: string; uri?: string }> })

describe('attachments reach every agent', () => {
  it('gives an agent that takes only pictures each file natively or by a path it can open, and keeps them over a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-delivery-'))
    roots.push(root)
    const log = join(root, 'agent.log'),
      dataDir = join(root, 'data')
    let host = await startTestHost({ dataDir, workspaceRoot: join(root, 'workspace') })
    hosts.push(host)
    let desktop = await host.enroll({ listener: 'unix' })
    // As Codex and pi report: pictures, no embedded text.
    await desktop.confirmedJson('agents', {
      body: {
        id: 'codex-like',
        name: 'codex-like',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CAPS: 'images', FAKE_ACP_LOG: log },
      },
    })
    const caps = await desktop.json<{ capabilities: AttachmentCapabilities }>('attachments/capabilities', {
      body: { selection: { harnessId: 'codex-like' } },
    })
    expect(caps.capabilities).toMatchObject({ files: true })
    expect(caps.capabilities.reason).toBeUndefined()
    const refs = []
    for (const [name, bytes] of FILES) refs.push(await upload(desktop, bytes, name, 'codex-like'))
    expect(refs.map(ref => [ref.kind, ref.mime])).toEqual([
      ['image', 'image/png'],
      ['file', 'image/heic'],
      ['file', 'video/mp4'],
      ['file', 'video/quicktime'],
      ['file', 'audio/mpeg'],
      ['file', 'application/pdf'],
      ['text', 'text/plain'],
      ['text', 'text/plain'],
      ['file', 'application/zip'],
      ['file', 'application/octet-stream'],
    ])
    // Eight per message: two messages carry all ten.
    const first = await desktop.confirmed('tasks', {
      body: {
        prompt: 'read-attachments',
        requestId: randomUUID(),
        harnessId: 'codex-like',
        attachmentIds: refs.slice(0, 8).map(ref => ref.id),
      },
    })
    expect(first.status).toBe(201)
    const { sessionId } = (await first.json()) as { sessionId: string }
    await idle(desktop, sessionId)
    const second = await desktop.request(`tasks/${sessionId}/prompt`, {
      body: { prompt: 'read-attachments', requestId: randomUUID(), attachmentIds: refs.slice(8).map(ref => ref.id) },
    })
    expect(second.ok).toBe(true)
    await idle(desktop, sessionId)
    const prompts = (await logOf(log)).filter(entry => entry.event === 'prompt-blocks')
    expect(prompts).toHaveLength(2)
    // The picture as a picture; everything else, text included, by its path, in one text block after the prompt.
    expect(prompts[0]!.blocks!.map(block => block.type)).toEqual(['text', 'image', 'text'])
    expect(prompts[0]!.blocks![1]).toMatchObject({ mimeType: 'image/png' })
    const listing = prompts[0]!.blocks![2]!.text!
    expect(listing.split('\n')[0]).toBe('用户附上了这些文件，已保存在本机，可用你的工具按路径读取：')
    const paths = prompts.flatMap(prompt => [...prompt.blocks!.at(-1)!.text!.matchAll(/：(\/[^\n]+)/gu)].map(match => match[1]!))
    expect(paths).toHaveLength(9)
    expect(listing).toContain('- 报告-2026 年第三季度经营分析（最终版）.pdf（application/pdf，39 B）：')
    for (const [index, path] of paths.entries()) {
      const [name, bytes] = FILES[index + 1]!
      expect(path.endsWith(`/${name}`), path).toBe(true)
      expect(path.startsWith(join(dataDir, 'attachments', sessionId, 'files'))).toBe(true)
      expect(await readFile(path)).toEqual(bytes)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    // The agent itself opened each by its path.
    const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
    const replies = detail.messages.filter(message => message.role === 'assistant').map(message => message.text)
    expect(replies.join('')).toBe(
      FILES.slice(1)
        .map(([, bytes]) => `read ${bytes.length} ${sha(bytes)}\n`)
        .join(''),
    )
    // The message keeps the references only; no path reaches the session record.
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.attachments?.length)).toEqual([8, 2])
    expect(JSON.stringify(detail)).not.toContain(join(dataDir, 'attachments'))
    // After a restart the same session still names the same attachments.
    await host.close()
    hosts.splice(hosts.indexOf(host), 1)
    host = await startTestHost({ dataDir, workspaceRoot: join(root, 'workspace') })
    hosts.push(host)
    desktop = await host.enroll({ listener: 'unix' })
    const reopened = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
    expect(reopened.messages.flatMap(message => message.attachments ?? []).map(ref => ref.id)).toEqual(refs.map(ref => ref.id))
    for (const ref of refs.slice(0, 2)) {
      const { file } = await desktop.json<{ file: { kind: string; mime: string } }>(`attachments/${ref.id}/resolve`, { method: 'POST' })
      expect(file).toMatchObject(
        ref.kind === 'image' ? { kind: 'image', mime: 'image/png' } : { kind: 'binary', mime: 'application/octet-stream' },
      )
    }
  }, 60_000)
  it('embeds text and pictures for an agent that takes both and names only the other files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-delivery-'))
    roots.push(root)
    const log = join(root, 'agent.log')
    const host = await startTestHost()
    hosts.push(host)
    const desktop = await host.enroll({ listener: 'unix' })
    await desktop.confirmedJson('agents', {
      body: {
        id: 'claude-like',
        name: 'claude-like',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CAPS: 'images,embedded', FAKE_ACP_LOG: log },
      },
    })
    const refs = [
      await upload(desktop, png, 'a.png', 'claude-like'),
      await upload(desktop, Buffer.from('print(1)\n'), 'a.py', 'claude-like'),
      await upload(desktop, FILES[5]![1], 'a.pdf', 'claude-like'),
    ]
    const created = await desktop.confirmed('tasks', {
      body: { prompt: 'hello', requestId: randomUUID(), harnessId: 'claude-like', attachmentIds: refs.map(ref => ref.id) },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    await idle(desktop, sessionId)
    const [prompt] = (await logOf(log)).filter(entry => entry.event === 'prompt-blocks')
    expect(prompt!.blocks!.map(block => block.type)).toEqual(['text', 'image', 'resource', 'text'])
    expect(prompt!.blocks![2]).toMatchObject({ uri: `latch-attachment:${refs[1]!.id}` })
    expect(prompt!.blocks![3]!.text).toMatch(/- a\.pdf（application\/pdf，39 B）：\/.+\/a\.pdf$/u)
  }, 60_000)
  it('shows the built-in Harness a picture only on a model that sees, and names every other file by its path', async () => {
    const seen: ModelMessage[][] = []
    const plugin: HarnessPlugin = {
      id: 'recording',
      name: 'recording',
      version: '1',
      description: '',
      activate(ctx) {
        for (const [id, vision] of [
          ['blind', false],
          ['seeing', true],
        ] as const)
          ctx.registerProvider({
            id,
            name: id,
            model: 'fixture',
            modelCapabilities: { fixture: { vision } },
            async *stream({ messages }: { messages: ModelMessage[] }) {
              seen.push(structuredClone(messages))
              yield { type: 'text', text: 'done' }
              yield { type: 'finish', reason: 'stop' }
            },
          })
      },
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const desktop = await host.enroll({ listener: 'unix' })
    for (const providerId of ['blind', 'seeing']) {
      const model = { providerId, model: 'fixture' }
      const caps = await desktop.json<{ capabilities: AttachmentCapabilities }>('attachments/capabilities', {
        body: { selection: { harnessId: 'standard', model } },
      })
      expect(caps.capabilities).toMatchObject({ images: providerId === 'seeing', text: true, files: true })
      const refs = [
        await upload(desktop, png, 'look.png', 'standard', model),
        await upload(desktop, FILES[5]![1], 'r.pdf', 'standard', model),
        await upload(desktop, Buffer.from('# notes\n'), 'n.md', 'standard', model),
      ]
      const created = await desktop.json<{ sessionId: string }>('tasks', {
        body: { prompt: 'look', requestId: randomUUID(), model, mode: 'agent', attachmentIds: refs.map(ref => ref.id) },
      })
      await idle(desktop, created.sessionId)
      const user = seen.at(-1)!.find(message => message.role === 'user')!
      const { contextSteps } = await desktop.json<TaskDetail>(`tasks/${created.sessionId}`)
      expect(contextSteps).toMatchObject([
        { images: providerId === 'seeing' ? 1 : 0, bytes: { user: Buffer.byteLength(user.content) + Buffer.byteLength('# notes\n') } },
      ])
      expect(JSON.stringify(contextSteps)).not.toContain('r.pdf')
      expect(user.attachments?.map(item => item.type)).toEqual(providerId === 'seeing' ? ['image', 'text'] : ['text'])
      expect(user.content).toContain('- r.pdf（application/pdf，39 B）：')
      expect(user.content.includes('- look.png（image/png')).toBe(providerId === 'blind')
    }
  }, 60_000)
})
