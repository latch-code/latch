import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AGENT_AVATAR_IMAGE,
  AGENT_BRACKETS,
  AGENT_EYES,
  AGENT_HUES,
  type AppSnapshot,
  type CustomAgent,
  type CustomAgentDetail,
  type CustomAgentList,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { reencodeAvatar, sniffImage } from '../src/avatar-image.ts'
import { CustomAgents } from '../src/custom-agents.ts'
import { createAgentRoutes } from '../src/routes/agents.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
})

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function chunk(type: string, body: Buffer, badCrc = false): Buffer {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE((crc32(out.subarray(4, 8 + body.length)) ^ (badCrc ? 1 : 0)) >>> 0, 8 + body.length)
  return out
}
interface PngOptions {
  width?: number
  height?: number
  colour?: 0 | 2 | 3 | 6
  depth?: number
  interlace?: number
  /** Chunks between IHDR and IDAT. */
  extra?: Buffer[]
  /** In place of the real scanlines. */
  data?: Buffer
  /** What the header says, when it lies about the size. */
  declared?: { width: number; height: number }
  pixel?: (x: number, y: number) => [number, number, number, number]
  after?: Buffer
  badCrc?: boolean
}
function png(options: PngOptions = {}): Buffer {
  const { width = 32, height = 32, colour = 6, depth = 8, interlace = 0 } = options
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : 1
  const raw = Buffer.alloc(height * (1 + width * channels))
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = options.pixel?.(x, y) ?? [x % 256, y % 256, 128, 255]
      for (let channel = 0; channel < channels; channel++) raw[y * (1 + width * channels) + 1 + x * channels + channel] = value[channel]!
    }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(options.declared?.width ?? width, 0)
  head.writeUInt32BE(options.declared?.height ?? height, 4)
  head[8] = depth
  head[9] = colour
  head[12] = interlace
  return Buffer.concat([
    MAGIC,
    chunk('IHDR', head),
    ...(options.extra ?? []),
    chunk('IDAT', options.data ?? deflateSync(raw), options.badCrc),
    chunk('IEND', Buffer.alloc(0)),
    options.after ?? Buffer.alloc(0),
  ])
}
/** The chunk types of a PNG, in order, and what follows its end. */
function chunksOf(file: Buffer): { types: string[]; trailing: number; header: Buffer; pixels: Buffer } {
  const types: string[] = []
  const data: Buffer[] = []
  let header: Buffer = Buffer.alloc(0)
  let offset = 8
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('latin1', offset + 4, offset + 8)
    types.push(type)
    if (type === 'IHDR') header = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IDAT') data.push(file.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
    if (type === 'IEND') break
  }
  return { types, trailing: file.length - offset, header, pixels: inflateSync(Buffer.concat(data)) }
}
const refusal = async (bytes: Buffer) =>
  reencodeAvatar(bytes).then(
    () => undefined,
    (error: unknown) => (error instanceof AppError ? { status: error.status, code: error.code } : { status: 0, code: String(error) }),
  )

describe('a picture, decoded and written again by the decoder process', () => {
  test('keeps only pixels: a fixed square PNG of IHDR, IDAT and IEND, without the metadata, the extra chunks or anything after the end', async () => {
    const hidden = 'secret-metadata GPS 31.2304N 121.4737E'
    const source = png({
      width: 300,
      height: 200,
      colour: 2,
      pixel: x => (x < 150 ? [255, 0, 0, 255] : [0, 0, 255, 255]),
      extra: [chunk('tEXt', Buffer.from(`Comment\0${hidden}`, 'latin1')), chunk('eXIf', Buffer.from(hidden, 'latin1'))],
      // A polyglot: a ZIP and a script after the picture's end.
      after: Buffer.from('PK\u0003\u0004<script>alert(1)</script>', 'latin1'),
    })
    const made = await reencodeAvatar(source)
    const read = chunksOf(made)
    expect(read.types).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(read.trailing).toBe(0)
    expect([read.header.readUInt32BE(0), read.header.readUInt32BE(4), read.header[8], read.header[9], read.header[12]]).toEqual([
      AGENT_AVATAR_IMAGE.size,
      AGENT_AVATAR_IMAGE.size,
      8,
      6,
      0,
    ])
    for (const text of ['secret-metadata', 'GPS', 'tEXt', 'eXIf', 'PK', 'script'])
      expect(made.includes(Buffer.from(text, 'latin1'))).toBe(false)
    // The centre square of 300×200 is its middle 200 columns: red on the left half, blue on the right.
    const stride = AGENT_AVATAR_IMAGE.size * 4 + 1
    const at = (x: number, y: number) => [...read.pixels.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)]
    expect(at(10, 128)).toEqual([255, 0, 0, 255])
    expect(at(245, 128)).toEqual([0, 0, 255, 255])
    // The same pixels give the same bytes, and the Host's own picture goes through unchanged.
    expect(await reencodeAvatar(source)).toEqual(made)
    expect(await reencodeAvatar(made)).toEqual(made)
    // A small picture is brought up to the same size; transparency is kept.
    const small = chunksOf(await reencodeAvatar(png({ width: 16, height: 16, pixel: () => [10, 20, 30, 0] })))
    expect(small.header.readUInt32BE(0)).toBe(AGENT_AVATAR_IMAGE.size)
    expect([...small.pixels.subarray(1, 5)]).toEqual([0, 0, 0, 0])
  }, 60_000)

  test('tells the kind from the first bytes alone and takes PNG, JPEG and WebP only', async () => {
    expect(sniffImage(png())).toBe('png')
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('jpeg')
    expect(sniffImage(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'))).toBe('webp')
    for (const [name, bytes] of [
      // A program renamed avatar.png is still a program.
      ['a Windows program', Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000', 'latin1')],
      ['a Mach-O program', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])],
      ['a shell script', Buffer.from('#!/bin/sh\nrm -rf ~\n')],
      ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['a GIF', Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1')],
      ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
      ['a RIFF that is not WebP', Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ', 'latin1')],
      ['nothing', Buffer.alloc(0)],
    ] as const) {
      expect(sniffImage(bytes), name).toBeUndefined()
      expect(await refusal(bytes), name).toEqual({ status: 415, code: 'agent-avatar-type' })
    }
    // This computer decodes PNG only: the other two are named, for the page to convert first.
    expect(await refusal(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))).toEqual({ status: 415, code: 'agent-avatar-convert' })
    expect(await refusal(Buffer.from('RIFF\u0010\u0000\u0000\u0000WEBPVP8 ', 'latin1'))).toEqual({
      status: 415,
      code: 'agent-avatar-convert',
    })
  })

  test('refuses by what a picture declares before inflating it, and by what it inflates to', async () => {
    // A tiny file that says it is 60000 × 60000.
    const huge = png({ declared: { width: 60_000, height: 60_000 } })
    expect(huge.length).toBeLessThan(4096)
    expect(await refusal(huge)).toEqual({ status: 413, code: 'agent-avatar-too-large' })
    expect(await refusal(png({ declared: { width: AGENT_AVATAR_IMAGE.maxSide + 1, height: 32 } }))).toEqual({
      status: 413,
      code: 'agent-avatar-too-large',
    })
    expect(await refusal(png({ declared: { width: 0xffffffff, height: 0xffffffff } }))).toEqual({
      status: 413,
      code: 'agent-avatar-too-large',
    })
    // It declares 32 × 32 and inflates to 64 MB: stopped at what 32 × 32 needs.
    const bomb = png({ data: deflateSync(Buffer.alloc(64 * 1024 * 1024)) })
    expect(bomb.length).toBeLessThan(AGENT_AVATAR_IMAGE.bytes)
    expect(await refusal(bomb)).toEqual({ status: 422, code: 'agent-avatar-unreadable' })
    expect(await refusal(png({ data: deflateSync(Buffer.alloc(10)) }))).toEqual({ status: 422, code: 'agent-avatar-unreadable' })
    expect(await refusal(Buffer.concat([png(), Buffer.alloc(AGENT_AVATAR_IMAGE.bytes)]))).toEqual({
      status: 413,
      code: 'agent-avatar-too-large',
    })
    expect(await refusal(png({ width: 8, height: 8 }))).toEqual({ status: 422, code: 'agent-avatar-unreadable' })
  }, 60_000)

  test('refuses what it does not fully understand: a damaged, cut, interlaced, palette or 16-bit PNG, an unknown critical chunk, a polyglot', async () => {
    const good = png()
    for (const [name, bytes, code] of [
      ['a wrong CRC', png({ badCrc: true }), 'agent-avatar-unreadable'],
      ['cut short', good.subarray(0, good.length - 20), 'agent-avatar-unreadable'],
      ['only the signature', MAGIC, 'agent-avatar-unreadable'],
      [
        'HTML after the signature',
        Buffer.concat([MAGIC, Buffer.from('<html><script>alert(1)</script></html>')]),
        'agent-avatar-unreadable',
      ],
      ['a filter byte that does not exist', png({ data: deflateSync(Buffer.alloc(32 * (1 + 32 * 4), 9)) }), 'agent-avatar-unreadable'],
      [
        'a chunk longer than the file',
        Buffer.concat([MAGIC, Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('IHDR')]),
        'agent-avatar-unreadable',
      ],
      ['two headers', Buffer.concat([good.subarray(0, 33), good.subarray(8)]), 'agent-avatar-unreadable'],
      ['interlaced', png({ interlace: 1 }), 'agent-avatar-type'],
      ['a palette', png({ colour: 3 }), 'agent-avatar-type'],
      ['grey', png({ colour: 0 }), 'agent-avatar-type'],
      ['16 bits a channel', png({ depth: 16 }), 'agent-avatar-type'],
      ['an animation chunk a decoder must understand', png({ extra: [chunk('ZZzz', Buffer.from('x'))] }), 'agent-avatar-type'],
    ] as const)
      expect((await refusal(bytes))?.code, name).toBe(code)
  }, 60_000)
})

type Device = Awaited<ReturnType<TestHost['enroll']>>
async function fixture() {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: { requestId: randomUUID(), name: '资料', description: '', harnessId: 'standard', mode: 'agent', instructions: '', skills: [] },
  })
  return { host, owner, agent }
}
const upload = (
  device: Device,
  id: string,
  bytes: Buffer,
  request: { requestId: string; baseRevision: number },
  type = 'application/octet-stream',
) =>
  device.request(`custom-agents/${id}/avatar-image?requestId=${request.requestId}&baseRevision=${request.baseRevision}`, {
    method: 'PUT',
    rawBody: bytes,
    headers: { 'content-type': type },
  })
const stored = async (host: TestHost) =>
  (await readdir(join(host.dataDir, 'agents', 'avatars')).catch(() => [])).filter(name => name.endsWith('.png'))

test('an uploaded picture is stored by its hash, private, and read only through the authorised route with fixed headers', async () => {
  const { host, owner, agent } = await fixture()
  const source = png({ width: 64, height: 64, extra: [chunk('tEXt', Buffer.from('Comment\0hidden-note', 'latin1'))] })
  const first = { requestId: randomUUID(), baseRevision: agent.revision }
  const response = await upload(owner, agent.id, source, first)
  expect(response.status).toBe(200)
  const saved = (await response.json()) as CustomAgent
  expect(saved.avatar).toEqual({
    kind: 'image',
    image: expect.stringMatching(/^[a-f0-9]{64}$/u),
    bracket: agent.avatar.bracket,
    eyes: agent.avatar.eyes,
    hue: agent.avatar.hue,
  })
  expect(saved.revision).toBe(agent.revision + 1)
  const hash = saved.avatar.kind === 'image' ? saved.avatar.image : ''

  // On disk: the Host's own bytes, named by their hash, 0600 in a 0700 directory.
  const directory = join(host.dataDir, 'agents', 'avatars')
  expect(await stored(host)).toEqual([`${hash}.png`])
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(directory, `${hash}.png`))).mode & 0o777).toBe(0o600)
  const onDisk = await readFile(join(directory, `${hash}.png`))
  expect(createHash('sha256').update(onDisk).digest('hex')).toBe(hash)
  expect(onDisk.equals(source)).toBe(false)
  expect(onDisk.includes(Buffer.from('hidden-note'))).toBe(false)
  expect(chunksOf(onDisk).types).toEqual(['IHDR', 'IDAT', 'IEND'])

  // Served as exactly that, as a picture and nothing else.
  const served = await owner.request(`custom-agents/avatar-images/${hash}`)
  expect(served.status).toBe(200)
  expect(served.headers.get('content-type')).toBe('image/png')
  expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  expect(served.headers.get('content-disposition')).toBe('inline; filename="avatar.png"')
  expect(served.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
  expect(served.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  expect(served.headers.get('cache-control')).toBe('private, no-store')
  expect(Buffer.from(await served.arrayBuffer()).equals(onDisk)).toBe(true)

  // Snapshots and reads carry the hash only: no bytes, no data URL.
  const snapshot = JSON.stringify(await owner.json<AppSnapshot>('snapshot'))
  expect(snapshot).toContain(hash)
  expect(snapshot).not.toContain('data:')
  expect(snapshot).not.toContain(onDisk.toString('base64').slice(0, 64))
  expect(JSON.stringify(await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`))).not.toContain('data:')
  // The audit record of the change has hashes and enums, nothing of the picture.
  const audit = await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  expect(audit).not.toContain(hash)
  expect(audit).not.toContain('iVBOR')

  // The same request again answers the same Agent without another revision; with another picture it is a conflict.
  const again = await upload(owner, agent.id, source, first)
  expect(again.status).toBe(200)
  expect(((await again.json()) as CustomAgent).revision).toBe(saved.revision)
  const conflict = await upload(owner, agent.id, png({ pixel: () => [1, 2, 3, 255] }), first)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: 'request-conflict' })
  // A revision the person did not see is refused, and the picture it brought is not kept.
  const stale = await upload(owner, agent.id, png({ pixel: () => [9, 9, 9, 255] }), {
    requestId: randomUUID(),
    baseRevision: agent.revision,
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ error: 'agent-changed' })
  expect(await stored(host)).toEqual([`${hash}.png`])

  // Other devices: a work-scope device neither reads nor writes it; one that may only view reads it and cannot change it.
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await limited.request(`custom-agents/avatar-images/${hash}`)).status).toBe(403)
  expect((await upload(limited, agent.id, source, { requestId: randomUUID(), baseRevision: saved.revision })).status).toBe(403)
  const reader = await host.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
  await owner.confirmedJson(`devices/${reader.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
  expect((await reader.request(`custom-agents/avatar-images/${hash}`)).status).toBe(200)
  expect((await upload(reader, agent.id, source, { requestId: randomUUID(), baseRevision: saved.revision })).status).toBe(403)
  expect(
    (
      await reader.request(`custom-agents/${agent.id}/avatar-image`, {
        method: 'DELETE',
        body: { requestId: randomUUID(), baseRevision: saved.revision },
      })
    ).status,
  ).toBe(403)
  expect((await host.raw('loopback-tcp', `api/custom-agents/avatar-images/${hash}`)).status).toBe(401)
  // A hash no Agent shows is not a handle, whatever is on disk.
  expect((await owner.request(`custom-agents/avatar-images/${'0'.repeat(64)}`)).status).toBe(404)
  expect((await owner.request(`custom-agents/avatar-images/${hash}`, { method: 'POST', body: {} })).status).toBe(404)
}, 180_000)

test('replace and clear both work, a face chosen puts the face back, and a picture nobody shows is removed', async () => {
  const { host, owner, agent } = await fixture()
  const one = (await (
    await upload(owner, agent.id, png({ pixel: () => [200, 0, 0, 255] }), { requestId: randomUUID(), baseRevision: 1 })
  ).json()) as CustomAgent
  const two = (await (
    await upload(owner, agent.id, png({ pixel: () => [0, 200, 0, 255] }), { requestId: randomUUID(), baseRevision: 2 })
  ).json()) as CustomAgent
  const hashOf = (value: CustomAgent) => (value.avatar.kind === 'image' ? value.avatar.image : '')
  expect(hashOf(two)).not.toBe(hashOf(one))
  // Replaced: only the new picture is kept, and the old handle is gone.
  expect(await stored(host)).toEqual([`${hashOf(two)}.png`])
  expect((await owner.request(`custom-agents/avatar-images/${hashOf(one)}`)).status).toBe(404)

  // 清除: the face again, as it was; a retry answers the same; the file goes.
  const clear = { requestId: randomUUID(), baseRevision: two.revision }
  const cleared = await owner.json<CustomAgent>(`custom-agents/${agent.id}/avatar-image`, { method: 'DELETE', body: clear })
  expect(cleared.avatar).toEqual(agent.avatar)
  expect((await owner.json<CustomAgent>(`custom-agents/${agent.id}/avatar-image`, { method: 'DELETE', body: clear })).revision).toBe(
    cleared.revision,
  )
  await expect.poll(() => stored(host)).toEqual([])
  expect((await owner.request(`custom-agents/avatar-images/${hashOf(two)}`)).status).toBe(404)

  // A face chosen while a picture shows puts the face back.
  const three = (await (
    await upload(owner, agent.id, png(), { requestId: randomUUID(), baseRevision: cleared.revision })
  ).json()) as CustomAgent
  expect(three.avatar.kind).toBe('image')
  const faced = await owner.json<CustomAgent>(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: three.revision, avatar: { kind: 'face', bracket: 'square', eyes: 'oval', hue: 'plum' } },
  })
  expect(faced.avatar).toEqual({ kind: 'face', bracket: 'square', eyes: 'oval', hue: 'plum' })
  await expect.poll(() => stored(host)).toEqual([])

  // Two Agents with the same picture share one file; it stays until neither shows it, and goes with the last Agent.
  const other = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: { requestId: randomUUID(), name: '另一位', description: '', harnessId: 'standard', mode: 'agent', instructions: '', skills: [] },
  })
  const same = png({ pixel: () => [5, 5, 5, 255] })
  const mine = (await (
    await upload(owner, agent.id, same, { requestId: randomUUID(), baseRevision: faced.revision })
  ).json()) as CustomAgent
  await upload(owner, other.id, same, { requestId: randomUUID(), baseRevision: other.revision })
  expect(await stored(host)).toEqual([`${hashOf(mine)}.png`])
  await owner.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await stored(host)).toEqual([`${hashOf(mine)}.png`])
  expect((await owner.request(`custom-agents/avatar-images/${hashOf(mine)}`)).status).toBe(200)
  await owner.json(`custom-agents/${other.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  await expect.poll(() => stored(host)).toEqual([])
}, 180_000)

test('nothing but the upload names a picture, and the upload takes bytes for what they are', async () => {
  const { host, owner, agent } = await fixture()
  const named = { kind: 'image', image: 'a'.repeat(64), bracket: 'round', eyes: 'dot', hue: 'pine' }
  // A client cannot point an Agent at a picture: not when changing it, not when creating one.
  const patched = await owner.request(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, avatar: named },
  })
  expect(patched.status).toBe(400)
  const created = await owner.request('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '带图',
      description: '',
      harnessId: 'standard',
      mode: 'agent',
      instructions: '',
      skills: [],
      avatar: named,
    },
  })
  expect(created.status).toBe(400)

  const request = () => ({ requestId: randomUUID(), baseRevision: agent.revision })
  for (const [name, bytes, status, error] of [
    ['a program sent as a picture', Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000\u0004\u0000', 'latin1'), 415, 'agent-avatar-type'],
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 415, 'agent-avatar-type'],
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), 415, 'agent-avatar-convert'],
    ['a PNG that declares 60000 × 60000', png({ declared: { width: 60_000, height: 60_000 } }), 413, 'agent-avatar-too-large'],
    ['a damaged PNG', png({ badCrc: true }), 422, 'agent-avatar-unreadable'],
    ['more bytes than a picture may have', Buffer.alloc(AGENT_AVATAR_IMAGE.bytes + 1, 1), 413, 'agent-avatar-too-large'],
  ] as const) {
    const response = await upload(owner, agent.id, bytes, request())
    expect(response.status, name).toBe(status)
    expect(await response.json(), name).toMatchObject({ error })
  }
  // The declared type and the name decide nothing: a real PNG said to be a program is a PNG, one said to be an image
  // is still only taken as bytes.
  expect((await upload(owner, agent.id, png(), request(), 'image/png')).status).toBe(415)
  expect((await upload(owner, agent.id, png(), { requestId: 'short', baseRevision: 1 })).status).toBe(400)
  expect((await upload(owner, `agt_${randomUUID()}`, png(), request())).status).toBe(404)
  expect(
    (
      await owner.request('custom-agents/general/avatar-image', {
        method: 'PUT',
        rawBody: png(),
        headers: { 'content-type': 'application/octet-stream' },
      })
    ).status,
  ).toBe(404)
  // Nothing was kept, and the Agent is as it was.
  expect(await stored(host)).toEqual([])
  expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent).toMatchObject({
    revision: agent.revision,
    avatar: agent.avatar,
  })
  expect((await upload(owner, agent.id, png(), request())).status).toBe(200)
}, 180_000)

test('an Agent with a picture always carries a usable face, wherever a client that shows no pictures reads it', async () => {
  const { host, owner, agent } = await fixture()
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: 1, avatar: { kind: 'face', bracket: 'square', eyes: 'oval', hue: 'moss' } },
  })
  // Through a first picture and its replacement the face stays as the person chose it.
  let revision = 2
  for (const shade of [10, 200]) {
    const response = await upload(owner, agent.id, png({ pixel: () => [shade, shade, shade, 255] }), {
      requestId: randomUUID(),
      baseRevision: revision++,
    })
    expect(response.status).toBe(200)
  }
  const usable = (avatar: CustomAgent['avatar'] | undefined) => {
    expect(avatar).toMatchObject({ kind: 'image', bracket: 'square', eyes: 'oval', hue: 'moss' })
    expect(AGENT_BRACKETS).toContain(avatar!.bracket)
    expect(AGENT_EYES).toContain(avatar!.eyes)
    expect(AGENT_HUES).toContain(avatar!.hue)
  }
  // What the phone's list is built from (the snapshot), and the list and detail reads.
  usable((await owner.json<AppSnapshot>('snapshot')).customAgents?.find(item => item.id === agent.id)?.avatar)
  usable((await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)?.avatar)
  usable((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent.avatar)

  // The record itself cannot hold a picture without its face: such a file is refused whole, not read as a faceless Agent.
  // Checked on a copy of the Host's own record, in another directory.
  const copy = await mkdtemp(join(tmpdir(), 'latch-avatar-record-'))
  try {
    await mkdir(join(copy, 'agents'), { mode: 0o700 })
    const path = join(copy, 'agents', 'custom.json')
    const text = await readFile(join(host.dataDir, 'agents', 'custom.json'), 'utf8')
    const held = JSON.parse(text) as { agents: Array<{ avatar: Record<string, unknown> }> }
    const audit = { append: async () => {} } as never
    await writeFile(path, text, { mode: 0o600 })
    const opened = await CustomAgents.open({ dataDir: copy, audit })
    expect(opened.get(agent.id).avatar).toMatchObject({ kind: 'image', bracket: 'square', eyes: 'oval', hue: 'moss' })
    await opened.close()
    for (const missing of ['bracket', 'eyes', 'hue']) {
      const broken = structuredClone(held)
      delete broken.agents[0]!.avatar[missing]
      await writeFile(path, JSON.stringify(broken), { mode: 0o600 })
      await expect(CustomAgents.open({ dataDir: copy, audit })).rejects.toMatchObject({ code: 'agent-journal-invalid' })
    }
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
}, 180_000)

test('only a few uploads wait at once, from one device and in all; past that the Host says it is busy and keeps nothing', async () => {
  const { host, owner, agent } = await fixture()
  // Twelve at once from one device: two are taken in, the rest are refused before their bytes are read.
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      upload(owner, agent.id, png({ pixel: () => [index, index, index, 255] }), { requestId: randomUUID(), baseRevision: agent.revision }),
    ),
  )
  const statuses = responses.map(response => response.status)
  const busy = responses.filter(response => response.status === 429)
  expect(busy.length).toBeGreaterThanOrEqual(10)
  for (const response of busy)
    expect(await response.json()).toMatchObject({ error: 'agent-avatar-busy', message: '正在处理别的图片，请稍后再试。' })
  // Of those taken in, one changed the Agent and the other found its revision already used.
  expect(statuses.filter(status => status === 200)).toHaveLength(1)
  expect(statuses.filter(status => status !== 200 && status !== 429).every(status => status === 409)).toBe(true)
  expect(await stored(host)).toHaveLength(1)
  // Once they are answered there is room again.
  const detail = await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)
  expect((await upload(owner, agent.id, png(), { requestId: randomUUID(), baseRevision: detail.agent.revision })).status).toBe(200)
}, 180_000)

test('at start, pictures no Agent names are removed and the ones in use stay', async () => {
  const { host, owner, agent } = await fixture()
  const saved = (await (
    await upload(owner, agent.id, png(), { requestId: randomUUID(), baseRevision: agent.revision })
  ).json()) as CustomAgent
  const hash = saved.avatar.kind === 'image' ? saved.avatar.image : ''
  const directory = join(host.dataDir, 'agents', 'avatars')
  // Left by an upload cut short: a whole picture nobody names, and a file still being written.
  await writeFile(join(directory, `${'f'.repeat(64)}.png`), await readFile(join(directory, `${hash}.png`)), { mode: 0o600 })
  await writeFile(join(directory, `.${'e'.repeat(64)}-partial.tmp`), 'x', { mode: 0o600 })
  const routes = createAgentRoutes(
    { refresh: () => {}, log: () => {}, dataDir: host.dataDir } as never,
    {
      agents: { avatarImages: () => new Set([hash]) } as never,
    } as never,
  )
  expect(routes.route).toBeTypeOf('function')
  await expect.poll(() => readdir(directory)).toEqual([`${hash}.png`])
  expect((await owner.request(`custom-agents/avatar-images/${hash}`)).status).toBe(200)
}, 120_000)
