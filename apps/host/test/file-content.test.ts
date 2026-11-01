import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFileMetadata, type Device, type TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { AuditLog } from '../src/audit.ts'
import { createFileRoutes } from '../src/files/index.ts'
import { FileReadQuota } from '../src/files/quota.ts'
import { byteRange, sendContent } from '../src/files/read.ts'
import { fileFormat, contentLimit } from '../src/files/metadata.ts'
import { FileReferenceStore } from '../src/files/reference-store.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-content-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project')
  const second = join(root, 'second')
  const privateDir = join(workspace, 'private')
  await mkdir(workspace)
  await mkdir(second)
  await mkdir(privateDir)
  await writeFile(join(workspace, 'report.md'), '# Report\n0123456789')
  await writeFile(join(workspace, '.env'), 'PRIVATE_VALUE=fixture')
  await writeFile(join(workspace, 'unmentioned.txt'), 'private working file')
  await writeFile(join(second, 'report.md'), 'second folder')
  await writeFile(join(privateDir, 'host.json'), 'private Host state')
  const audit = await AuditLog.open(join(root, 'audit'))
  cleanup.push(() => audit.close())
  const devices = new Map<string, Device>()
  for (const [id, listener, dataScope] of [
    ['desktop', 'unix', 'all'],
    ['work', 'loopback-tcp', 'work'],
    ['all', 'loopback-tcp', 'all'],
  ] as const)
    devices.set(id, {
      id: `dev_${id.padEnd(22, 'x')}`,
      name: id,
      listener,
      dataScope,
      scopes: ['view', 'run'],
      status: 'active',
      fingerprint: '',
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      credentialExpiresAt: new Date(Date.now() + 60000).toISOString(),
      pairedBy: { method: 'lpc' },
    })
  const detail: TaskDetail = {
    summary: { harnessId: 'standard', id: 'session', title: 'Preview', status: 'idle', updatedAt: new Date().toISOString() },
    messages: [{ id: 'reply', role: 'assistant', text: 'Read `report.md` and `.env`.' }],
    approvals: [],
    liveText: '',
    cursor: 0,
  }
  const revoked = new Set<string>()
  let removed = false
  let privateSession = false
  let now = Date.now()
  const routes = createFileRoutes({
    protectedPaths: [privateDir],
    home: root,
    now: () => now,
    audit,
    limiter: { take: () => {} },
    sessionAccess: caller => {
      if (privateSession && caller.device?.dataScope !== 'all')
        throw new AppError(403, 'personal-scope-required', '私有会话只供 all 范围查看')
    },
    sessionRoots: async id =>
      id !== 'session'
        ? undefined
        : removed
          ? 'removed'
          : [
              { id: 'primary', path: workspace },
              { id: 'second', path: second },
            ],
    sessionDetail: async () => detail,
    recheck: caller => {
      if (!caller.device || revoked.has(caller.device.name)) throw new AppError(403, 'device-revoked', '已撤销')
    },
    actorOf: caller => ({ deviceId: caller.device!.id, listener: caller.connection.listener }),
  })
  cleanup.push(() => routes.close())
  const server = createServer((req, res) => {
    const device = devices.get(String(req.headers['x-test-device']))
    void routes
      .handle(
        req,
        res,
        { device, connection: { listener: device?.listener ?? 'loopback-tcp' } },
        new URL(req.url!, 'http://test').pathname,
        req.method!,
      )
      .then(handled => {
        if (!handled) {
          res.writeHead(404)
          res.end()
        }
      })
      .catch((cause: unknown) => {
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(cause instanceof AppError ? cause.status : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: cause instanceof AppError ? cause.code : 'test-error' }))
      })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(
    () =>
      new Promise<void>((done, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : done()))
      }),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  const request = (device: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${address.port}/link/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-test-device': device, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const resolve = async (device: string, paths: string[], extra: Record<string, unknown> = {}) => {
    const response = await request(device, 'tasks/session/files/resolve', { paths, ...extra })
    expect(response.status).toBe(200)
    return (await response.json()) as {
      files: Array<{
        status: string
        code?: string
        file?: { handle: string; name: string; path: string; secret: boolean; actions: Record<string, boolean> }
      }>
    }
  }
  return {
    routes,
    workspace,
    second,
    privateDir,
    audit,
    detail,
    devices,
    request,
    resolve,
    revoked,
    makePrivate: () => {
      privateSession = true
    },
    remove: () => {
      removed = true
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('opaque bulk file authorization', () => {
  it('authorizes an existing large handle and rejects stale versions, foreign devices and small files', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, 'large.txt'), Buffer.alloc(256 * 1024, 120))
    const large = (await f.resolve('all', ['large.txt'])).files[0]!.file!
    const meta = (await (await f.request('all', `files/${large.handle}/meta`)).json()) as { file: { etag: string } }
    const caller = { device: f.devices.get('all')!, connection: { listener: 'loopback-tcp' as const } }
    await expect(f.routes.authorizeBulk(caller, large.handle, meta.file.etag)).resolves.toEqual({ size: 256 * 1024 })
    await expect(f.routes.authorizeBulk(caller, large.handle, `"${'0'.repeat(32)}"`)).rejects.toMatchObject({ status: 412 })
    await expect(f.routes.authorizeBulk({ ...caller, device: f.devices.get('work')! }, large.handle, meta.file.etag)).rejects.toMatchObject(
      { status: 403, code: 'file-handle-foreign' },
    )
    const small = (await f.resolve('all', ['report.md'])).files[0]!.file!
    await expect(f.routes.authorizeBulk(caller, small.handle, meta.file.etag)).rejects.toMatchObject({
      status: 409,
      code: 'file-bulk-small',
    })
  })
  it('rechecks revocation while the existing handle context waits', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, 'large.txt'), Buffer.alloc(256 * 1024, 120))
    const large = (await f.resolve('all', ['large.txt'])).files[0]!.file!
    const meta = (await (await f.request('all', `files/${large.handle}/meta`)).json()) as { file: { etag: string } }
    const pending = f.routes.authorizeBulk(
      { device: f.devices.get('all')!, connection: { listener: 'loopback-tcp' } },
      large.handle,
      meta.file.etag,
    )
    f.revoked.add('all')
    await expect(pending).rejects.toMatchObject({ status: 403, code: 'device-revoked' })
  })
  it('refuses oversized text on bulk even when the ordinary preview may truncate it', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, 'too-large.txt'), Buffer.alloc(contentLimit('text', false) + 1, 120))
    const large = (await f.resolve('all', ['too-large.txt'])).files[0]!.file!
    await expect(
      f.routes.authorizeBulk({ device: f.devices.get('all')!, connection: { listener: 'loopback-tcp' } }, large.handle, 'unused'),
    ).rejects.toMatchObject({ status: 413, code: 'file-too-large' })
  })
  it('preserves private-session scope checks and never promotes a confirmed local secret handle to bulk', async () => {
    const f = await fixture(),
      secret = (await f.resolve('desktop', ['.env'], { showSecret: true })).files[0]!.file!
    await expect(
      f.routes.authorizeBulk({ device: f.devices.get('desktop')!, connection: { listener: 'unix' } }, secret.handle, 'unused'),
    ).rejects.toMatchObject({ status: 403, code: 'file-secret' })
    await writeFile(join(f.workspace, 'large.txt'), Buffer.alloc(256 * 1024, 120))
    const large = (await f.resolve('all', ['large.txt'])).files[0]!.file!
    const caller = { device: f.devices.get('all')!, connection: { listener: 'loopback-tcp' as const } }
    caller.device.dataScope = 'work'
    f.makePrivate()
    await expect(f.routes.authorizeBulk(caller, large.handle, 'unused')).rejects.toMatchObject({
      status: 403,
      code: 'personal-scope-required',
    })
  })
})

describe('adjudicated file content', () => {
  it.each(['window', 'context', 'version'])('rechecks a one-MiB stream before any second 64KiB block after %s changes', async mode => {
    const f = await fixture(),
      path = join(f.workspace, 'bulk.bin'),
      source = Buffer.alloc(1_048_576, 120)
    await writeFile(path, source)
    const descriptor = await open(path, 'r'),
      stat = await descriptor.stat({ bigint: true })
    await descriptor.close()
    let changed = false,
      mutation: Promise<void> | undefined
    const chunks: Buffer[] = []
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
      write(chunk: Buffer) {
        chunks.push(Buffer.from(chunk))
        changed = true
        if (mode === 'version') mutation = writeFile(path, Buffer.alloc(source.length, 121))
        return true
      },
    })
    await expect(
      sendContent(
        { method: 'GET', headers: { range: 'bytes=0-1048575' }, url: '/' } as IncomingMessage,
        res as unknown as ServerResponse,
        {
          rootId: 'default',
          relativePath: 'bulk.bin',
          realPath: path,
          name: 'bulk.bin',
          ext: 'bin',
          size: source.length,
          mtimeMs: 0,
          head: source.subarray(0, 64),
          secret: false,
          identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        },
        {
          mime: 'application/octet-stream',
          limit: source.length,
          chunkBytes: 65_536,
          allowSecret: false,
          consume() {},
          async recheck() {
            await mutation
            if (changed && mode !== 'version')
              throw new AppError(
                mode === 'window' ? 403 : 409,
                mode === 'window' ? 'native-verification-required' : 'file-roots-changed',
                'Fixture access changed',
              )
          },
        },
      ),
    ).rejects.toMatchObject({ status: mode === 'window' ? 403 : 409 })
    expect(chunks.map(chunk => chunk.length)).toEqual([65_536])
    expect(res.end).not.toHaveBeenCalled()
  })
  it('settles when a response closes during an awaited block check, before a drain listener can be installed', async () => {
    const f = await fixture(),
      source = Buffer.from('# Report\n0123456789')
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
      write: vi.fn(() => false),
    })
    let checks = 0
    await sendContent(
      { method: 'GET', headers: {}, url: '/' } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        rootId: 'default',
        relativePath: 'report.md',
        realPath: join(f.workspace, 'report.md'),
        name: 'report.md',
        ext: 'md',
        size: source.length,
        mtimeMs: 0,
        head: source,
        secret: false,
      },
      {
        mime: 'text/plain',
        limit: 65536,
        allowSecret: false,
        consume() {},
        async recheck() {
          if (++checks === 3) {
            res.destroyed = true
            res.emit('close')
          }
        },
      },
    )
    expect(checks).toBe(3)
    expect(res.write).not.toHaveBeenCalled()
    expect(res.listenerCount('close')).toBe(0)
    expect(res.listenerCount('drain')).toBe(0)
  }, 2000)
  it('settles a transport abort raised inside a backpressured write without relying on an HTTP close event', async () => {
    const f = await fixture(),
      source = Buffer.from('# Report\n0123456789'),
      abort = new AbortController()
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
      write: vi.fn(() => {
        abort.abort()
        return false
      }),
    })
    await sendContent(
      { method: 'GET', headers: {}, url: '/' } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        rootId: 'default',
        relativePath: 'report.md',
        realPath: join(f.workspace, 'report.md'),
        name: 'report.md',
        ext: 'md',
        size: source.length,
        mtimeMs: 0,
        head: source,
        secret: false,
      },
      { mime: 'text/plain', limit: 65536, allowSecret: false, signal: abort.signal, consume() {}, recheck() {} },
    )
    expect(res.write).toHaveBeenCalledOnce()
    expect(res.listenerCount('close')).toBe(0)
    expect(res.listenerCount('drain')).toBe(0)
  }, 2000)
  it('retains ordinary If-Range semantics outside the fixed bulk role', async () => {
    const f = await fixture(),
      handle = (await f.resolve('all', ['report.md'])).files[0]!.file!.handle
    const metadata = (await (await f.request('all', `files/${handle}/meta`)).json()) as { file: { etag: string } }
    const matching = await f.request('all', `files/${handle}`, undefined, {
      range: 'bytes=0-3',
      'if-match': metadata.file.etag,
      'if-range': metadata.file.etag,
    })
    expect(matching.status).toBe(206)
    expect(await matching.text()).toBe('# Re')
    const mismatched = await f.request('all', `files/${handle}`, undefined, {
      range: 'bytes=0-3',
      'if-match': metadata.file.etag,
      'if-range': '"obsolete-version"',
    })
    expect(mismatched.status).toBe(200)
    expect(mismatched.headers.get('content-range')).toBeNull()
    expect(await mismatched.text()).toBe('# Report\n0123456789')
  })

  it('applies a session privacy gate to references and handles issued before that gate changed', async () => {
    const f = await fixture()
    const handle = (await f.resolve('work', ['report.md'])).files[0]!.file!.handle
    expect(await (await f.request('work', `files/${handle}`)).text()).toContain('# Report')
    f.makePrivate()
    for (const path of [`files/${handle}`, `files/${handle}/meta`]) {
      const response = await f.request('work', path)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'personal-scope-required' })
    }
    expect((await f.request('work', 'tasks/session/files/resolve', { paths: ['report.md'] })).status).toBe(403)
    const allowed = (await f.resolve('all', ['report.md'])).files[0]!.file!.handle
    expect(await (await f.request('all', `files/${allowed}`)).text()).toContain('# Report')
  })
  it('refuses pixel-heavy previews in metadata before loading and keeps unknown image headers as download-only', async () => {
    const f = await fixture()
    const image = Buffer.alloc(24)
    image.set([137, 80, 78, 71, 13, 10, 26, 10])
    image.writeUInt32BE(10_000, 16)
    image.writeUInt32BE(6_000, 20)
    await writeFile(join(f.workspace, 'large.png'), image)
    await writeFile(join(f.workspace, 'unknown.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0]))
    const remote = await f.resolve('all', ['large.png', 'unknown.jpg'])
    expect(remote.files[0]!.file).toMatchObject({
      width: 10_000,
      height: 6_000,
      actions: { preview: false, download: false },
      refused: { preview: 'file-too-large' },
    })
    expect(remote.files[1]!.file).toMatchObject({
      actions: { preview: false, download: true },
      refused: { preview: 'file-image-dimensions' },
    })
    const local = await f.resolve('desktop', ['large.png'])
    expect(local.files[0]!.file).toMatchObject({ actions: { preview: true, download: true } })
    expect((await f.request('all', `files/${remote.files[0]!.file!.handle}`)).status).toBe(413)
  })
  it('limits work-scope readers to persisted message references and keeps local actions local', async () => {
    const f = await fixture()
    const answer = await f.resolve('work', ['report.md', 'unmentioned.txt', '.env'])
    expect(isFileMetadata(answer.files[0]!.file)).toBe(true)
    expect(isFileMetadata({ ...answer.files[0]!.file, handle: '../outside' })).toBe(false)
    expect(answer.files[0]).toMatchObject({
      status: 'ok',
      file: { name: 'report.md', actions: { preview: true, reveal: false, open: false } },
    })
    expect(answer.files[1]).toMatchObject({ status: 'not-referenced', code: 'file-not-referenced' })
    expect(answer.files[2]).toMatchObject({ status: 'ok', file: { secret: true, actions: { preview: false, download: false } } })
    const handle = answer.files[0]!.file!.handle
    expect(await (await f.request('work', `files/${handle}`)).text()).toBe('# Report\n0123456789')
    expect((await f.request('all', `files/${handle}`)).status).toBe(403)
    expect((await f.request('work', `files/${handle}/local`, { sessionId: 'session', action: 'reveal' })).status).toBe(403)
    expect(f.audit.lastOf('file.view')?.detail).toMatchObject({ sessionId: 'session', type: 'md', bytes: 19 })
  })

  it('requires an explicit desktop reveal of secret content and rechecks after the file changes', async () => {
    const f = await fixture()
    const first = (await f.resolve('desktop', ['.env'])).files[0]!.file!
    expect((await f.request('desktop', `files/${first.handle}`)).status).toBe(403)
    const allowed = (await f.resolve('desktop', ['.env'], { showSecret: true })).files[0]!.file!
    expect(await (await f.request('desktop', `files/${allowed.handle}`)).text()).toBe('PRIVATE_VALUE=fixture')
    const remote = (await f.resolve('all', ['.env'], { showSecret: true })).files[0]!.file!
    expect((await f.request('all', `files/${remote.handle}`)).status).toBe(403)
    const report = (await f.resolve('all', ['report.md'])).files[0]!.file!
    await writeFile(join(f.workspace, 'report.md'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))
    expect((await f.request('all', `files/${report.handle}`)).status).toBe(403)
    await writeFile(
      join(f.workspace, 'utf16.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'utf16le')]),
    )
    expect((await f.resolve('all', ['utf16.txt'])).files[0]!.file).toMatchObject({ secret: true, actions: { preview: false } })
  })

  it('supports bounded ranges and ETags while making every content response a non-navigable attachment', async () => {
    const f = await fixture()
    const file = (await f.resolve('desktop', ['report.md'])).files[0]!.file!
    const response = await f.request('desktop', `files/${file.handle}`, undefined, { range: 'bytes=9-12' })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('0123')
    expect(response.headers.get('content-range')).toBe('bytes 9-12/19')
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/u)
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    const tag = response.headers.get('etag')!
    expect((await f.request('desktop', `files/${file.handle}?v=${tag.slice(1, -1)}`)).status).toBe(200)
    expect((await f.request('desktop', `files/${file.handle}`, undefined, { 'if-none-match': tag })).status).toBe(304)
    const invalid = await f.request('desktop', `files/${file.handle}`, undefined, { range: 'bytes=1000-' })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */19')
    await writeFile(join(f.workspace, 'replacement.md'), 'replacement')
    await rename(join(f.workspace, 'replacement.md'), join(f.workspace, 'report.md'))
    const stale = await f.request('desktop', `files/${file.handle}`, undefined, { range: 'bytes=0-3', 'if-match': tag })
    expect(stale.status).toBe(412)
    expect((await f.request('desktop', `files/${file.handle}?v=${tag.slice(1, -1)}`)).status).toBe(412)
    expect(await stale.json()).toMatchObject({ error: 'file-changed' })
    const changed = await f.request('desktop', `files/${file.handle}`)
    expect(await changed.text()).toBe('replacement')
    expect(changed.headers.get('etag')).not.toBe(tag)
  })

  it('stops a live response when the same inode changes without changing its size', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'large.bin')
    await writeFile(path, Buffer.alloc(20 * 1024 * 1024))
    const file = (await f.resolve('desktop', ['large.bin'])).files[0]!.file!
    const response = await f.request('desktop', `files/${file.handle}`)
    expect(response.status).toBe(200)
    const writer = await open(path, 'r+')
    try {
      await writer.write(Buffer.from('changed'), 0, 7, 18 * 1024 * 1024)
    } finally {
      await writer.close()
    }
    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  it('invalidates readers after revocation or folder removal and rejects outward symlinks', async () => {
    const f = await fixture()
    const handle = (await f.resolve('all', ['report.md'])).files[0]!.file!.handle
    f.revoked.add('all')
    expect((await f.request('all', `files/${handle}`)).status).toBe(403)
    f.revoked.clear()
    await rename(join(f.workspace, 'report.md'), join(f.workspace, 'old.md'))
    await symlink(join(f.second, 'report.md'), join(f.workspace, 'report.md'))
    expect((await f.request('all', `files/${handle}`)).status).toBe(403)
    const another = (await f.resolve('desktop', ['old.md'])).files[0]!.file!.handle
    f.remove()
    expect((await f.request('desktop', `files/${another}/meta`)).status).toBe(409)
  })

  it('audits before issuing a remote readable handle and searches only all-scope files with stable root IDs', async () => {
    const f = await fixture()
    expect((await f.request('work', 'tasks/session/files/search', { q: 'report' })).status).toBe(403)
    const search = await f.request('all', 'tasks/session/files/search', { q: 'report' })
    expect(await search.json()).toEqual({
      files: [
        { name: 'report.md', path: 'report.md', root: 'primary' },
        { name: 'report.md', path: 'report.md', root: 'second' },
      ],
      truncated: false,
    })
    const second = (await f.resolve('desktop', ['report.md'], { rootId: 'second' })).files[0]!.file!
    expect(await (await f.request('desktop', `files/${second.handle}`)).text()).toBe('second folder')
    vi.spyOn(f.audit, 'append').mockRejectedValue(new AppError(503, 'audit-unavailable', '无法记录'))
    expect((await f.request('all', 'tasks/session/files/resolve', { paths: ['unmentioned.txt'] })).status).toBe(503)
  })

  it('does not turn a warm filename index into scope, device or folder authority', async () => {
    const f = await fixture()
    const body = { q: 'report' }
    expect((await f.request('all', 'tasks/session/files/search', body)).status).toBe(200)
    expect((await f.request('work', 'tasks/session/files/search', body)).status).toBe(403)
    f.revoked.add('all')
    expect((await f.request('all', 'tasks/session/files/search', body)).status).toBe(403)
    f.revoked.clear()
    f.remove()
    expect((await f.request('all', 'tasks/session/files/search', body)).status).toBe(409)
  })

  it('audits the first content read when a metadata-only secret handle later becomes readable', async () => {
    const f = await fixture()
    const handle = (await f.resolve('all', ['.env'])).files[0]!.file!.handle
    // A secret name stays secret; a content-classified ordinary path may become readable after replacement.
    await writeFile(join(f.workspace, 'secret-report.txt'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))
    const report = (await f.resolve('all', ['secret-report.txt'])).files[0]!.file!.handle
    await writeFile(join(f.workspace, 'secret-report.txt'), 'ordinary report')
    vi.spyOn(f.audit, 'append').mockRejectedValue(new AppError(503, 'audit-unavailable', '无法记录'))
    expect((await f.request('all', `files/${report}`)).status).toBe(503)
    expect((await f.request('all', `files/${handle}`)).status).toBe(403)
  })

  it('binds tool path references to their selected folder instead of granting a same-named primary file', async () => {
    const f = await fixture()
    f.detail.messages = [
      {
        id: 'tool',
        role: 'tool',
        text: '',
        tool: { input: JSON.stringify({ folder: 'second', path: 'report.md' }), locations: ['report.md'] },
      },
    ]
    expect((await f.resolve('work', ['report.md'])).files[0]).toMatchObject({ code: 'file-not-referenced' })
    const second = (await f.resolve('work', ['report.md'], { rootId: 'second' })).files[0]!.file!
    expect(await (await f.request('work', `files/${second.handle}`)).text()).toBe('second folder')
    const store = await FileReferenceStore.open(f.privateDir)
    expect(
      await store.references(
        'session',
        f.detail,
        [
          { id: 'primary', path: f.workspace },
          { id: 'second', path: f.second },
        ],
        f.workspace,
      ),
    ).toEqual(new Set(['second\nreport.md']))
  })
})

describe('bounded byte ranges, formats and quotas', () => {
  it('keeps previously mentioned paths across restarts and advances through a large historical message', async () => {
    const f = await fixture()
    const roots = [{ id: 'primary', path: f.workspace }]
    const store = await FileReferenceStore.open(f.privateDir)
    expect(await store.references('session', f.detail, roots, f.workspace)).toContain('primary\nreport.md')
    f.detail.messages = [{ id: 'long', role: 'assistant', text: `${'x '.repeat(2 * 1024 * 1024)}\n\`late.md\`` }]
    const reopened = await FileReferenceStore.open(f.privateDir)
    expect(await reopened.references('session', f.detail, roots, f.workspace)).toContain('primary\nreport.md')
    expect(await reopened.references('session', f.detail, roots, f.workspace)).toContain('primary\nlate.md')
    const movedRoots = [{ id: 'primary', path: f.second }]
    f.detail.messages = []
    expect((await reopened.references('session', f.detail, movedRoots, f.workspace)).size).toBe(0)
  })
  it.each([
    ['bytes=2-5', { start: 2, end: 5 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=8-', { start: 8, end: 9 }],
    ['bytes=0-999', { start: 0, end: 9 }],
  ])('reads %s', (header, expected) => {
    expect(byteRange(header, 10)).toEqual(expected)
  })
  it.each(['bytes=0-1,4-5', 'bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=3-2', 'bytes=99999999999999999999-'])('refuses %s', header => {
    expect(() => byteRange(header, 10)).toThrow(AppError)
  })
  it('trusts media magic over the extension and preserves safe document attachment MIME', () => {
    expect(fileFormat({ head: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ext: 'html' })).toEqual({
      kind: 'image',
      mime: 'image/png',
    })
    expect(fileFormat({ head: new TextEncoder().encode('<script>x()</script>'), ext: 'html' })).toEqual({
      kind: 'html',
      mime: 'application/octet-stream',
    })
  })
  it('bounds parallel reads and remote bytes, with idempotent release and a new minute budget', () => {
    let now = 0
    const quota = new FileReadQuota(() => now)
    const leases = Array.from({ length: 8 }, () => quota.begin('device', false))
    expect(() => quota.begin('device', false)).toThrow(AppError)
    leases[0]!.consume(200 * 1024 * 1024)
    expect(() => leases[1]!.consume(1)).toThrow(AppError)
    leases[0]!.release()
    leases[0]!.release()
    quota.begin('device', false).release()
    now = 60_000
    leases[1]!.consume(1)
    for (const lease of leases) lease.release()
    quota.begin('device', false).release()
  })
})
