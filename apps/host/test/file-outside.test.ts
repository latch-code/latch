import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { isFileMetadata, type Device, type TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { AuditLog } from '../src/audit.ts'
import { createFileRoutes } from '../src/files/index.ts'
import { outsideKey } from '../src/files/outside.ts'
import { FileReferenceStore } from '../src/files/reference-store.ts'
import { sessionReferences } from '../src/files/references.ts'

const cleanup: Array<() => Promise<void>> = []
/** The shape Codex gives a generated picture: a thread folder and a long hex image ID. */
const THREAD = '019a7c3e-5b1f-7d22-9c1e-4f3a2b1c0d9e'
const IMAGE = 'ig_0f3c9a7b2e1d4c5a6b7e8f9001a2b3c4d5e6f708192a3b4c.png'
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const type = Buffer.from('IHDR', 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([type, header])))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(13)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, type, header, crc, Buffer.alloc(64, 1)])
}

const device = (id: string, listener: Device['listener'], dataScope: Device['dataScope']): Device => ({
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

/** A temporary HOME with an agent CLI's generated picture, Latch's data and program folders and a project, all fake. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-outside-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const workspace = join(home, 'project')
  const images = join(home, '.codex', 'generated_images', THREAD)
  const elsewhere = join(root, 'elsewhere')
  const dataDir = join(home, '.latch-data')
  const codeRoot = join(root, 'latch-code')
  for (const dir of [workspace, images, elsewhere, join(dataDir, 'auth'), codeRoot, join(home, '.ssh'), join(home, '.claude')])
    await mkdir(dir, { recursive: true })
  const picture = join(images, IMAGE)
  await writeFile(picture, png(1536, 1024))
  await writeFile(join(images, 'sibling.png'), png(10, 10))
  await writeFile(join(home, '.codex', 'auth.json'), '{"tokens":{"access_token":"fixture"}}')
  await writeFile(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fixture"}}')
  await mkdir(join(home, '.claude', 'plans'), { recursive: true })
  await writeFile(join(home, '.claude', 'plans', 'plan.md'), '# Plan')
  await writeFile(join(home, '.codex', 'state_5.sqlite'), 'SQLite format 3')
  await writeFile(join(home, '.ssh', 'notes.png'), png(4, 4))
  await writeFile(join(dataDir, 'auth', 'devices.png'), png(4, 4))
  await writeFile(join(codeRoot, 'logo.png'), png(4, 4))
  await writeFile(join(elsewhere, 'notes.txt'), 'outside notes')
  await writeFile(join(elsewhere, 'private.pem'), 'not a real key')
  await writeFile(join(elsewhere, 'target.txt'), 'where the link leads')
  await symlink(join(elsewhere, 'target.txt'), join(elsewhere, 'link.txt'))
  await mkdir(join(elsewhere, 'folder.png'))
  // Folder links into places that stay refused, and into an agent CLI's folder (all but its logins).
  await symlink(join(dataDir, 'auth'), join(elsewhere, 'data-link'))
  await symlink(join(home, '.ssh'), join(elsewhere, 'ssh-link'))
  await symlink(join(home, '.codex'), join(elsewhere, 'codex-link'))
  await writeFile(join(workspace, 'report.md'), '# Report')
  const named = [
    `![粒子](${picture})`,
    `[原图](~/.codex/generated_images/${THREAD}/${IMAGE})`,
    join(elsewhere, 'notes.txt'),
    join(elsewhere, 'private.pem'),
    join(elsewhere, 'link.txt'),
    join(elsewhere, 'folder.png'),
    join(elsewhere, 'data-link', 'devices.png'),
    join(elsewhere, 'ssh-link', 'notes.png'),
    join(elsewhere, 'codex-link', 'auth.json'),
    join(elsewhere, 'codex-link', 'generated_images', THREAD, IMAGE),
    join(home, '.codex', 'auth.json'),
    join(home, '.claude', '.credentials.json'),
    join(home, '.claude', 'plans', 'plan.md'),
    join(home, '.codex', 'state_5.sqlite'),
    join(home, '.ssh', 'notes.png'),
    join(dataDir, 'auth', 'devices.png'),
    join(codeRoot, 'logo.png'),
    '../escape.txt',
  ].join('\n')
  const detail: TaskDetail = {
    summary: { harnessId: 'standard', id: 'session', title: 'Outside', status: 'idle', updatedAt: new Date().toISOString() },
    messages: [{ id: 'reply', role: 'assistant', text: named }],
    approvals: [],
    liveText: '',
    cursor: 0,
  }
  const audit = await AuditLog.open(join(root, 'audit'))
  cleanup.push(() => audit.close())
  const devices = new Map<string, Device>([
    ['desktop', device('desktop', 'unix', 'all')],
    ['work', device('work', 'loopback-tcp', 'work')],
    ['files', device('files', 'loopback-tcp', 'files')],
    ['all', device('all', 'loopback-tcp', 'all')],
  ])
  const store = await FileReferenceStore.open(join(root, 'references'))
  let privateSession = false
  const routes = createFileRoutes({
    protectedPaths: [dataDir],
    outsidePaths: { excluded: [dataDir, codeRoot, join(home, '.ssh')], cliHomes: [join(home, '.codex'), join(home, '.claude')] },
    home,
    now: () => Date.now(),
    audit,
    limiter: { take: () => {} },
    sessionAccess: caller => {
      if (privateSession && caller.device?.dataScope !== 'all') throw new AppError(403, 'agent-scope-required', '私有会话只供 all 范围查看')
    },
    sessionRoots: async id => (id === 'session' ? [{ id: 'primary', path: workspace }] : undefined),
    sessionDetail: async () => detail,
    referencePaths: (id, roots) => store.references(id, detail, roots, home),
    recheck: caller => {
      if (!caller.device) throw new AppError(403, 'device-revoked', '已撤销')
    },
    actorOf: caller => ({ deviceId: caller.device!.id, listener: caller.connection.listener }),
    edits: {
      assertInput: async () => {},
      turnRunning: async () => false,
      writable: () => true,
      record: async (_id, _file, write) => {
        await write()
        return { noteNextTurn: false }
      },
    },
  })
  cleanup.push(async () => routes.close())
  const server = createServer((req, res) => {
    const caller = devices.get(String(req.headers['x-test-device']))
    void routes
      .handle(
        req,
        res,
        { device: caller, connection: { listener: caller?.listener ?? 'loopback-tcp' } },
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
        if (res.headersSent) return void res.destroy()
        res.writeHead(cause instanceof AppError ? cause.status : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: cause instanceof AppError ? cause.code : String(cause) }))
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
  const request = (who: string, path: string, init: { body?: unknown; method?: string; headers?: Record<string, string> } = {}) =>
    fetch(`http://127.0.0.1:${address.port}/link/api/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'x-test-device': who, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  type Answer = { status: string; code?: string; file?: Record<string, unknown> & { handle: string; actions: Record<string, boolean> } }
  const resolve = async (who: string, paths: string[], extra: Record<string, unknown> = {}) => {
    const response = await request(who, 'tasks/session/files/resolve', { body: { paths, ...extra } })
    expect(response.status).toBe(200)
    return ((await response.json()) as { files: Answer[] }).files
  }
  return {
    home,
    workspace,
    images,
    picture,
    elsewhere,
    dataDir,
    codeRoot,
    detail,
    audit,
    request,
    resolve,
    makePrivate: () => {
      privateSession = true
    },
  }
}

describe('files a conversation names outside its folders', () => {
  it('records absolute and ~/ paths outside every folder, not relative escapes', () => {
    const detail: TaskDetail = {
      summary: { harnessId: 'standard', id: 's', title: '', status: 'idle', updatedAt: new Date().toISOString() },
      messages: [
        { id: 'a', role: 'assistant', text: '[图](/tmp/x/a.png) `~/.codex/b.png` ../c.txt /work/in.md' },
        { id: 'u', role: 'user', text: 'see file:///var/d.png' },
      ],
      approvals: [],
      liveText: '',
      cursor: 0,
    }
    const found = sessionReferences(detail, [{ id: 'primary', path: '/work' }], '/home/me')
    expect(found).toContain(outsideKey('/tmp/x/a.png'))
    expect(found).toContain(outsideKey('/home/me/.codex/b.png'))
    expect(found).toContain(outsideKey('/var/d.png'))
    expect(found).toContain('primary\nin.md')
    expect([...found].some(key => key.includes('c.txt'))).toBe(false)
  })

  it('previews and serves a named picture in an agent CLI folder, with its handle, ETag and ranges', async () => {
    const f = await fixture()
    for (const reference of [f.picture, `~/.codex/generated_images/${THREAD}/${IMAGE}`, `file://${f.picture}`]) {
      const [answer] = await f.resolve('work', [reference], { rootId: 'primary' })
      expect(answer).toMatchObject({
        status: 'ok',
        file: {
          kind: 'image',
          mime: 'image/png',
          width: 1536,
          height: 1024,
          name: IMAGE,
          path: IMAGE,
          folder: f.images,
          secret: false,
        },
      })
      expect(isFileMetadata(answer!.file)).toBe(true)
      expect(answer!.file!.root).toMatch(/^outside-[a-f0-9]{24}$/u)
      expect(answer!.file!.actions).toMatchObject({ preview: true, download: true, reveal: false })
      expect(answer!.file!.actions.edit).toBeUndefined()
    }
    const file = (await f.resolve('work', [f.picture]))[0]!.file!
    const content = await f.request('work', `files/${file.handle}`)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('image/png')
    expect(content.headers.get('etag')).toBe(file.etag)
    expect(
      Buffer.from(await content.arrayBuffer())
        .subarray(1, 4)
        .toString('latin1'),
    ).toBe('PNG')
    const ranged = await f.request('work', `files/${file.handle}`, { headers: { range: 'bytes=0-3' } })
    expect(ranged.status).toBe(206)
    const meta = (await (await f.request('work', `files/${file.handle}/meta`)).json()) as { file: Record<string, unknown> }
    expect(meta.file).toMatchObject({ path: IMAGE, folder: f.images, root: file.root })
    expect(f.audit.lastOf('file.view')?.detail).toMatchObject({ sessionId: 'session', type: 'png' })
    // Another device cannot borrow the handle.
    expect((await f.request('all', `files/${file.handle}`)).status).toBe(403)
  })

  it('opens it for every data scope, the desktop shell included, and never for editing', async () => {
    const f = await fixture()
    for (const who of ['files', 'all', 'desktop']) {
      const [answer] = await f.resolve(who, [f.picture])
      expect(answer).toMatchObject({ status: 'ok', file: { folder: f.images } })
      expect(answer!.file!.actions.edit).toBeUndefined()
    }
    const [text] = await f.resolve('desktop', [join(f.elsewhere, 'notes.txt')])
    expect(text).toMatchObject({ status: 'ok', file: { kind: 'text', actions: { reveal: true } } })
    expect(text!.file!.actions.edit).toBeUndefined()
    const handle = text!.file!.handle
    const local = await f.request('desktop', `files/${handle}/local`, { body: { sessionId: 'session', action: 'reveal' } })
    expect(local.status).toBe(200)
    expect(((await local.json()) as { file: { path: string } }).file.path).toBe(join(f.elsewhere, 'notes.txt'))
    const save = await f.request('desktop', `tasks/session/files/${handle}`, {
      method: 'PUT',
      body: { requestId: 'request-1', baseHash: '0'.repeat(64), content: 'changed' },
    })
    expect(save.status).toBe(403)
    expect(await save.json()).toEqual({ error: 'file-outside-folders' })
  })

  it('opens what an agent CLI wrote in its folder beside its logins, such as a plan', async () => {
    const f = await fixture()
    const [plan] = await f.resolve('all', [join(f.home, '.claude', 'plans', 'plan.md')])
    expect(plan!.status).toBe('ok')
  })

  it('refuses what the conversation never named, beside a named file too', async () => {
    const f = await fixture()
    for (const who of ['work', 'all', 'desktop']) {
      const answers = await f.resolve(who, [join(f.images, 'sibling.png'), '/etc/hosts', join(f.home, 'escape.txt')])
      for (const answer of answers) expect(['not-referenced', 'outside']).toContain(answer.status)
    }
  })

  it('returns tree locations only for folders the device can browse', async () => {
    const f = await fixture()
    const child = join(f.workspace, 'docs', 'examples')
    await mkdir(child, { recursive: true })
    await symlink(child, join(f.workspace, 'alias'))
    f.detail.messages.push({ id: 'folder', role: 'assistant', text: `[示例](${child})` })
    const outside = join(f.elsewhere, 'folder.png')
    expect(await f.resolve('files', [f.workspace, 'alias', outside])).toEqual([
      { input: f.workspace, status: 'folder', code: 'file-folder', directory: { root: 'primary', path: '' } },
      { input: 'alias', status: 'folder', code: 'file-folder', directory: { root: 'primary', path: 'docs/examples' } },
      { input: outside, status: 'folder', code: 'file-folder' },
    ])
    expect(await f.resolve('work', [child])).toEqual([{ input: child, status: 'folder', code: 'file-folder' }])
  })

  it('refuses Latch data, the program folder, credential stores, secrets, CLI logins, links and folders', async () => {
    const f = await fixture()
    const answers = await f.resolve('all', [
      join(f.dataDir, 'auth', 'devices.png'),
      join(f.codeRoot, 'logo.png'),
      join(f.home, '.ssh', 'notes.png'),
      join(f.elsewhere, 'private.pem'),
      join(f.home, '.codex', 'auth.json'),
      join(f.home, '.claude', '.credentials.json'),
      join(f.home, '.codex', 'state_5.sqlite'),
      join(f.elsewhere, 'link.txt'),
      join(f.elsewhere, 'folder.png'),
    ])
    expect(answers.map(answer => answer.status)).toEqual([
      'protected',
      'protected',
      'protected',
      'protected',
      'protected',
      'protected',
      'protected',
      'not-file',
      'folder',
    ])
    // A folder link is followed only to check where it leads: refused places stay refused, a CLI folder keeps its logins.
    const linked = await f.resolve('all', [
      join(f.elsewhere, 'data-link', 'devices.png'),
      join(f.elsewhere, 'ssh-link', 'notes.png'),
      join(f.elsewhere, 'codex-link', 'auth.json'),
      join(f.elsewhere, 'codex-link', 'generated_images', THREAD, IMAGE),
    ])
    expect(linked.map(answer => answer.status)).toEqual(['protected', 'protected', 'protected', 'ok'])
    // A local reader's explicit "show the secret" does not reach outside the folders.
    expect((await f.resolve('desktop', [join(f.elsewhere, 'private.pem')], { showSecret: true }))[0]!.status).toBe('protected')
  })

  it('drops a handle when its file is replaced or a link takes its place', async () => {
    const f = await fixture()
    const handle = (await f.resolve('work', [f.picture]))[0]!.file!.handle
    await rename(f.picture, join(f.images, 'old.png'))
    await writeFile(f.picture, png(20, 20))
    expect((await f.request('work', `files/${handle}`)).status).toBe(404)
    const next = (await f.resolve('work', [f.picture]))[0]!.file!
    expect(next.handle).not.toBe(handle)
    await rm(f.picture)
    await symlink(join(f.images, 'old.png'), f.picture)
    expect((await f.request('work', `files/${next.handle}`)).status).toBeGreaterThanOrEqual(400)
    expect((await f.resolve('work', [f.picture]))[0]!.status).toBe('not-file')
  })

  it('keeps the session privacy gate for outside files and their handles', async () => {
    const f = await fixture()
    const handle = (await f.resolve('work', [f.picture]))[0]!.file!.handle
    f.makePrivate()
    expect((await f.request('work', `files/${handle}`)).status).toBe(403)
    expect((await f.request('work', 'tasks/session/files/resolve', { body: { paths: [f.picture] } })).status).toBe(403)
  })

  it('keeps a named file openable after its message changes, as folder files are', async () => {
    const f = await fixture()
    const handle = (await f.resolve('all', [join(f.elsewhere, 'notes.txt')]))[0]!.file!.handle
    f.detail.messages = [{ id: 'other', role: 'assistant', text: 'nothing here' }]
    // The durable record keeps paths ever mentioned (like folder files); a new store for a fresh session does not.
    expect((await f.request('all', `files/${handle}`)).status).toBe(200)
    const fresh = await f.request('all', 'tasks/other/files/resolve', { body: { paths: [join(f.elsewhere, 'notes.txt')] } })
    expect(fresh.status).toBe(404)
  })
})

describe('the record of named outside paths', () => {
  const session = (text: string): TaskDetail => ({
    summary: { harnessId: 'standard', id: 's', title: '', status: 'idle', updatedAt: new Date().toISOString() },
    messages: [{ id: 'm', role: 'assistant', text }],
    approvals: [],
    liveText: '',
    cursor: 0,
  })

  it('bounds outside paths apart, so a flood of them never crowds out a folder file; URLs are not paths', () => {
    const flood = Array.from({ length: 2500 }, (_, index) => `/var/log/x${index}.txt`).join('\n')
    const found = sessionReferences(
      session(`${flood}\nsee src/app.ts and https://cdn.test/a.png`),
      [{ id: 'primary', path: '/work' }],
      '/home/me',
    )
    expect([...found].filter(key => key.startsWith('@\n')).length).toBe(2000)
    expect(found).toContain('primary\nsrc/app.ts')
    expect(found).not.toContain(outsideKey('/cdn.test/a.png'))
  })

  it('reads old messages once more when a record was written before outside paths were kept', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-outside-store-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const roots = [{ id: 'primary', path: join(root, 'work') }]
    const detail = session('[图](/tmp/old/picture.png)')
    const store = await FileReferenceStore.open(root)
    expect(await store.references('s', detail, roots, root)).toContain(outsideKey('/tmp/old/picture.png'))
    // The record as an older Host left it: the message marked read in full under the old hash, no outside key.
    const { readdir, readFile } = await import('node:fs/promises')
    const dir = join(root, 'file-references')
    const [name] = await readdir(dir)
    const record = JSON.parse(await readFile(join(dir, name!), 'utf8')) as { references: string[]; seen: Array<{ hash: string }> }
    record.references = []
    // The hash an older Host gave this message (before the scan version), with its offset at the end.
    const { createHash } = await import('node:crypto')
    record.seen[0]!.hash = createHash('sha256')
      .update(JSON.stringify([detail.messages[0]!.text, undefined, undefined, undefined, undefined]))
      .digest('hex')
    await writeFile(join(dir, name!), JSON.stringify(record))
    const reopened = await FileReferenceStore.open(root)
    expect(await reopened.references('s', detail, roots, root)).toContain(outsideKey('/tmp/old/picture.png'))
  })
})
