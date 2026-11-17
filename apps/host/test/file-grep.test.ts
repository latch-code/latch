import { getEventListeners } from 'node:events'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as connectHttp2, constants as http2Constants, createServer as createHttp2Server } from 'node:http2'
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@latch/protocol'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { AuditLog } from '../src/audit.ts'
import { createFileRoutes } from '../src/files/index.ts'
import { GREP_LIMITS, grepFiles, literalPattern, windowed, type GrepLimits, type GrepResult } from '../src/files/grep.ts'
import { ProtectedPaths } from '../src/files/resolve.ts'
import { hungFileOperations } from '../src/files/search.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function folders() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'latch-grep-')))
  cleanup.push(() => rm(parent, { recursive: true, force: true }))
  const workspace = join(parent, 'project'),
    second = join(parent, 'second'),
    outside = join(parent, 'outside'),
    privateDir = join(workspace, 'private')
  for (const path of [
    workspace,
    second,
    outside,
    privateDir,
    join(workspace, '.git'),
    join(workspace, 'src'),
    join(workspace, 'node_modules', 'dep'),
  ])
    await mkdir(path, { recursive: true })
  await writeFile(join(workspace, '.gitignore'), 'build.log\n')
  await writeFile(join(workspace, 'src', 'main.ts'), 'const needle = 1\nconst Needle = 2\nconst needles = 3\n// no match here\n')
  await writeFile(join(workspace, 'README.md'), '# needle\r\nwindows line\r\n')
  await writeFile(join(workspace, 'build.log'), 'needle in an ignored file\n')
  await writeFile(join(workspace, 'node_modules', 'dep', 'index.js'), 'needle in a dependency\n')
  await writeFile(join(workspace, '.env'), 'TOKEN=needle\n')
  await writeFile(join(privateDir, 'host.json'), 'needle in private Host state\n')
  await writeFile(join(outside, 'secret.txt'), 'needle outside the project\n')
  await mkdir(join(outside, 'dir'))
  await writeFile(join(outside, 'dir', 'a.txt'), 'needle through a linked folder\n')
  await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
  await symlink(join(outside, 'dir'), join(workspace, 'linked'))
  await writeFile(join(second, 'notes.txt'), 'needle in the second folder\n')
  return { parent, workspace, second, outside, privateDir }
}

const roots = (f: Awaited<ReturnType<typeof folders>>) => [
  { id: 'primary', path: f.workspace },
  { id: 'second', path: f.second },
]
const found = (result: GrepResult) => result.files.flatMap(file => file.lines.map(line => `${file.root}:${file.path}:${line.line}`))
const search = (
  f: Awaited<ReturnType<typeof folders>>,
  q: string,
  extra: Partial<{ caseSensitive: boolean; wholeWord: boolean }> = {},
  limits?: GrepLimits,
) =>
  grepFiles(
    roots(f),
    new ProtectedPaths([f.privateDir]),
    { q, caseSensitive: false, wholeWord: false, ...extra },
    () => false,
    () => {},
    limits,
  )

describe('content search', () => {
  it('finds literal text in the folders, with line numbers and match ranges, honouring case and whole words', async () => {
    const f = await folders()
    const all = await search(f, 'needle')
    expect(found(all).sort()).toEqual([
      'primary:README.md:1',
      'primary:src/main.ts:1',
      'primary:src/main.ts:2',
      'primary:src/main.ts:3',
      'second:notes.txt:1',
    ])
    const main = all.files.find(file => file.path === 'src/main.ts')!
    expect(main.lines[0]).toEqual({ line: 1, text: 'const needle = 1', ranges: [[6, 12]] })
    // A Windows line ending is not part of the line.
    expect(all.files.find(file => file.path === 'README.md')!.lines[0]!.text).toBe('# needle')
    expect(found(await search(f, 'Needle', { caseSensitive: true }))).toEqual(['primary:src/main.ts:2'])
    expect(found(await search(f, 'needle', { wholeWord: true })).sort()).toEqual([
      'primary:README.md:1',
      'primary:src/main.ts:1',
      'primary:src/main.ts:2',
      'second:notes.txt:1',
    ])
    expect(all.stopped).toBeUndefined()
  })

  it('never follows a link out of the project, nor reads ignored, protected or secret files', async () => {
    const f = await folders()
    const paths = (await search(f, 'needle')).files.map(file => file.path)
    for (const left of ['link.txt', 'linked/a.txt', 'build.log', 'node_modules/dep/index.js', '.env', 'private/host.json'])
      expect(paths).not.toContain(left)
    // A credential anywhere in a file keeps the whole file out, not only one in its first bytes.
    await writeFile(
      join(f.workspace, 'src', 'late.ts'),
      `${'// filler\n'.repeat(8000)}const needle = '${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}'\n`,
    )
    expect((await search(f, 'needle')).files.map(file => file.path)).not.toContain('src/late.ts')
  })

  it('skips binary and oversized files and counts them', async () => {
    const f = await folders()
    await writeFile(join(f.workspace, 'image.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]))
    await writeFile(join(f.workspace, 'big.txt'), `needle\n${'x'.repeat(4096)}`)
    const result = await search(f, 'needle', {}, { ...GREP_LIMITS, fileBytes: 1024 })
    expect(result.files.map(file => file.path)).not.toContain('image.bin')
    expect(result.files.map(file => file.path)).not.toContain('big.txt')
    expect(result.skipped).toEqual({ large: 1, binary: 1, unchecked: 0, uncheckedFolders: 0 })
  })

  it('matches what looks like an option or a pattern as the literal text it is', async () => {
    const f = await folders()
    await writeFile(join(f.workspace, 'src', 'flags.txt'), 'run with -e needle\n--include=*.ts\n(a+)+$ literally\nnothing\n')
    expect(found(await search(f, '-e needle'))).toEqual(['primary:src/flags.txt:1'])
    expect(found(await search(f, '--include=*.ts'))).toEqual(['primary:src/flags.txt:2'])
    expect(found(await search(f, '(a+)+$'))).toEqual(['primary:src/flags.txt:3'])
    expect(found(await search(f, '*.ts'))).toEqual(['primary:src/flags.txt:2'])
    expect(found(await search(f, '.*'))).toEqual([])
    expect(literalPattern({ q: '[a-z]{2}\\d', caseSensitive: true, wholeWord: true }).test('[a-z]{2}\\d')).toBe(true)
  })

  it('stays quick on a pattern that would backtrack catastrophically as a regular expression', async () => {
    const f = await folders()
    await writeFile(join(f.workspace, 'src', 'long.txt'), `${'a'.repeat(50_000)}!\n`.repeat(8))
    const started = performance.now()
    const result = await search(f, '(a+)+$', { wholeWord: true })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(found(result).filter(item => item.includes('long.txt'))).toEqual([])
  })

  it('stops at each bound and says which', async () => {
    const f = await folders()
    for (let index = 0; index < 6; index++) await writeFile(join(f.workspace, `many-${index}.txt`), 'needle\n'.repeat(5))
    const results = await search(f, 'needle', {}, { ...GREP_LIMITS, results: 7 })
    expect(results.count).toBe(7)
    expect(results.stopped).toBe('results')
    const perFile = await search(f, 'needle', {}, { ...GREP_LIMITS, perFile: 2 })
    expect(perFile.files.find(file => file.path === 'many-0.txt')).toMatchObject({ lines: [{ line: 1 }, { line: 2 }], more: true })
    expect((await search(f, 'needle', {}, { ...GREP_LIMITS, files: 2 })).stopped).toBe('files')
    expect((await search(f, 'needle', {}, { ...GREP_LIMITS, bytes: 20 })).stopped).toBe('bytes')
    expect((await search(f, 'needle', {}, { ...GREP_LIMITS, ms: 0 })).stopped).toBe('time')
    const entries = await search(f, 'needle', {}, { ...GREP_LIMITS, entries: 3 })
    expect(entries.stopped).toBe('entries')
  })

  it('returns a window of a long line around its first match, without splitting a character', async () => {
    const line = `${'😀'.repeat(300)}needle${'b'.repeat(500)}`
    const shown = windowed(line, [[600, 606]], 240)!
    expect(shown.text.length).toBeLessThanOrEqual(240)
    expect(shown.before).toBe(true)
    expect(shown.after).toBe(true)
    const [start, end] = shown.ranges[0]!
    expect(shown.text.slice(start, end)).toBe('needle')
    expect(shown.text).toBe(shown.text.normalize())
    expect(/^[\uDC00-\uDFFF]/u.test(shown.text) || /[\uD800-\uDBFF]$/u.test(shown.text)).toBe(false)
  })

  it('ends as soon as it is cancelled', async () => {
    const f = await folders()
    for (let index = 0; index < 50; index++) await writeFile(join(f.workspace, `file-${index}.txt`), 'needle\n')
    let looks = 0
    const result = await grepFiles(
      roots(f),
      new ProtectedPaths([]),
      { q: 'needle', caseSensitive: false, wholeWord: false },
      () => ++looks > 40,
      () => {},
    )
    expect(result.scanned).toBeLessThan(10)
  })

  it('refuses an empty or multi-line query', async () => {
    const f = await folders()
    await expect(search(f, '')).rejects.toMatchObject({ code: 'file-grep-invalid' })
    await expect(search(f, 'a\nb')).rejects.toMatchObject({ code: 'file-grep-invalid' })
  })
})

async function routes() {
  const f = await folders()
  const audit = await AuditLog.open(join(f.parent, 'audit'))
  cleanup.push(() => audit.close())
  const devices = new Map<string, Device>()
  for (const [id, listener, dataScope] of [
    ['desktop', 'unix', 'all'],
    ['work', 'loopback-tcp', 'work'],
    ['files', 'loopback-tcp', 'files'],
    ['all', 'loopback-tcp', 'all'],
    ['other', 'loopback-tcp', 'all'],
    ['third', 'loopback-tcp', 'all'],
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
  const state = {
    privateSession: false,
    removed: false,
    revoked: new Set<string>(),
    /** Each file the search resolves waits this long first (a slow disk). */
    delay: 0,
    resolved: 0,
    afterResolve: undefined as ((realPath: string) => Promise<void>) | undefined,
  }
  const nativeSignal = new AbortController()
  const fileRoutes = createFileRoutes({
    grepSlotMs: 1500,
    requestSignal: caller => (caller.device?.name === 'all' ? nativeSignal.signal : undefined),
    hooks: {
      async afterResolve(realPath) {
        state.resolved++
        if (state.delay) await new Promise(done => setTimeout(done, state.delay))
        await state.afterResolve?.(realPath)
      },
    },
    protectedPaths: [f.privateDir],
    home: f.parent,
    now: () => Date.now(),
    audit,
    limiter: { take: () => {} },
    sessionAccess: caller => {
      if (state.privateSession && caller.device?.dataScope !== 'all')
        throw new AppError(403, 'agent-scope-required', '私有会话只供 all 范围查看')
    },
    sessionRoots: async id => (id !== 'session' ? undefined : state.removed ? 'removed' : roots(f)),
    sessionDetail: async () => ({
      summary: { harnessId: 'standard', id: 'session', title: 'Grep', status: 'idle', updatedAt: new Date().toISOString() },
      messages: [],
      approvals: [],
      liveText: '',
      cursor: 0,
    }),
    workspaceRoots: async (id, harnessId) => (id === 'project' && harnessId === 'standard' ? roots(f) : undefined),
    recheck: caller => {
      if (!caller.device || state.revoked.has(caller.device.name)) throw new AppError(403, 'device-revoked', '已撤销')
    },
    actorOf: caller => ({ deviceId: caller.device!.id, listener: caller.connection.listener }),
  })
  cleanup.push(() => fileRoutes.close())
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const device = devices.get(String(req.headers['x-test-device']))
    void fileRoutes
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
        if (res.headersSent) return void res.destroy()
        // As the Host answers a body that does not parse.
        const status = cause instanceof AppError ? cause.status : cause instanceof z.ZodError ? 400 : 500
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: cause instanceof AppError ? cause.code : 'test-error' }))
      })
  }
  const server = createServer(handler)
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
  const request = (device: string, path: string, body: unknown, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${address.port}/link/api/${path}`, {
      method: 'POST',
      headers: { 'x-test-device': device, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  const slowBody = (device: string) =>
    new Promise<void>(resolve => {
      const pending = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/link/api/tasks/session/files/grep',
          method: 'POST',
          headers: { 'x-test-device': device, 'content-type': 'application/json', 'content-length': '100' },
        },
        () => {},
      )
      pending.on('error', () => {})
      pending.write('{"q":')
      cleanup.push(async () => {
        pending.destroy()
      })
      resolve()
    })
  return { f, audit, state, request, handler, nativeSignal, slowBody }
}

describe('content search, never stalling the Host', () => {
  /** Runs a search while a timer ticks: a Host whose event loop is held would not tick. */
  async function responsive(run: () => Promise<unknown>) {
    // Something else waiting on the event loop: it runs on every turn the search gives back.
    let ticks = 0,
      running = true
    const tick = () => {
      ticks++
      if (running) setImmediate(tick)
    }
    setImmediate(tick)
    const started = performance.now()
    try {
      await run()
    } finally {
      running = false
    }
    return { ms: performance.now() - started, ticks }
  }

  it('stays linear on a 1 MiB line of whitespace with a character after it, and on a 1 MiB line with no newline', async () => {
    const f = await folders()
    await writeFile(join(f.workspace, 'spaces.txt'), `needle${' '.repeat(1024 * 1024 - 20)}x`)
    await writeFile(join(f.workspace, 'oneline.txt'), `needle ${'a b '.repeat(260_000)}`)
    await writeFile(join(f.workspace, 'tabs.txt'), `${'needle\t'.repeat(10)}${'\t'.repeat(1_000_000)}y`)
    for (const q of ['needle', 'needle ', 'x', ' ']) {
      const { ms, ticks } = await responsive(() => search(f, q))
      expect(ms, q).toBeLessThan(3000)
      expect(ticks, q).toBeGreaterThan(0)
    }
    const found = await search(f, 'needle')
    expect(found.files.map(file => file.path)).toEqual(expect.arrayContaining(['spaces.txt', 'oneline.txt', 'tabs.txt']))
    for (const file of found.files) for (const line of file.lines) expect(line.text.length).toBeLessThanOrEqual(240)
  })

  it('keeps the secret check linear on text shaped against its patterns', async () => {
    const f = await folders()
    await writeFile(join(f.workspace, 'armour.txt'), `needle\n-----BEGIN ${'AB '.repeat(340_000)}\n`)
    await writeFile(join(f.workspace, 'prefixes.txt'), `needle\n${'sk-short '.repeat(110_000)}\n`)
    const { ms, ticks } = await responsive(() => search(f, 'needle'))
    expect(ms).toBeLessThan(3000)
    expect(ticks).toBeGreaterThan(0)
  })

  it('never answers a range past the shown text, even for a match in trailing whitespace', async () => {
    const f = await folders()
    await writeFile(join(f.workspace, 'trail.txt'), 'word   \nword\n')
    const result = await search(f, 'word ')
    for (const file of result.files)
      for (const line of file.lines) for (const [, end] of line.ranges) expect(end).toBeLessThanOrEqual(line.text.length)
    expect(windowed('abc   ', [[3, 5]], 240)).toBeUndefined()
    expect(windowed('abc d  ', [[3, 6]], 240)).toEqual({ text: 'abc d', ranges: [[3, 5]] })
  })

  it('stops at the read budget instead of reading on', async () => {
    const f = await folders()
    let charged = 0
    const result = await grepFiles(
      roots(f),
      new ProtectedPaths([f.privateDir]),
      { q: 'needle', caseSensitive: false, wholeWord: false },
      () => false,
      () => {},
      GREP_LIMITS,
      {
        consume: bytes => {
          if (charged + bytes > 40) throw new AppError(429, 'rate-limited', '超出')
          charged += bytes
        },
      },
    )
    expect(result.stopped).toBe('bytes')
    expect(charged).toBeLessThanOrEqual(40)
  })

  it('charges the first bytes of a file it skips, as well as what it reads', async () => {
    const f = await folders()
    await writeFile(join(f.workspace, 'big.txt'), 'x'.repeat(200 * 1024))
    let charged = 0
    const result = await grepFiles(
      roots(f),
      new ProtectedPaths([f.privateDir]),
      { q: 'needle', caseSensitive: false, wholeWord: false },
      () => false,
      () => {},
      { ...GREP_LIMITS, fileBytes: 1024 },
      { consume: bytes => void (charged += bytes) },
    )
    expect(result.skipped.large).toBe(1)
    expect(charged).toBeGreaterThanOrEqual(64 * 1024)
  })

  it('leaves out a file swapped for a link out of the project between finding and opening it', async () => {
    const f = await folders()
    const swapped = join(f.workspace, 'src', 'main.ts')
    const result = await grepFiles(
      roots(f),
      new ProtectedPaths([f.privateDir]),
      { q: 'needle', caseSensitive: false, wholeWord: false },
      () => false,
      () => {},
      GREP_LIMITS,
      {
        resolve: {
          async afterResolve(realPath) {
            if (realPath !== swapped) return
            await rename(swapped, `${swapped}.old`)
            await symlink(join(f.outside, 'secret.txt'), swapped)
          },
        },
      },
    )
    expect(result.files.map(file => file.path)).not.toContain('src/main.ts')
    expect(JSON.stringify(result)).not.toContain('outside the project')
  })

  it('treats a hard link inside the project as the project file it is, as a preview does', async () => {
    const f = await folders()
    await link(join(f.outside, 'secret.txt'), join(f.workspace, 'hardlinked.txt'))
    const result = await search(f, 'needle outside')
    // A hard link is one file with two names; Latch cannot tell which folder it "belongs" to, and reads it as the preview would.
    expect(result.files.map(file => file.path)).toEqual(['hardlinked.txt'])
  })
})

describe('content search route', () => {
  it('answers only devices whose data scope covers the folders, and private sessions only as file reads do', async () => {
    const { request, state } = await routes()
    expect((await request('work', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(403)
    expect((await request('work', 'workspaces/project/files/grep', { q: 'needle', harnessId: 'standard' })).status).toBe(403)
    const answer = (await (await request('files', 'tasks/session/files/grep', { q: 'needle' })).json()) as GrepResult
    expect(answer.count).toBe(5)
    const project = await request('all', 'workspaces/project/files/grep', { q: 'needle', harnessId: 'standard' })
    expect(((await project.json()) as GrepResult).count).toBe(5)
    state.privateSession = true
    expect((await request('files', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(403)
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(200)
    state.revoked.add('all')
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(403)
    state.removed = true
    expect((await request('desktop', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(409)
  })

  it('records each file whose lines a remote device received as read, deduplicated, never the query', async () => {
    const { request, f } = await routes()
    const auditText = async () => {
      const files = await readdir(join(f.parent, 'audit'))
      return (await Promise.all(files.map(name => readFile(join(f.parent, 'audit', name), 'utf8').catch(() => '')))).join('\n')
    }
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(200)
    const first = await auditText()
    const views = first.split('\n').filter(line => line.includes('"file.view"'))
    expect(views).toHaveLength(3)
    for (const line of views) {
      expect(line).toContain('"via":"grep"')
      expect(line).toMatch(/"lines":\d+/u)
      expect(line).toMatch(/"pathHash":"[0-9a-f]{64}"/u)
    }
    expect(first.includes('needle')).toBe(false)
    // The same files again within 15 minutes add no record, as reads do.
    expect((await request('all', 'tasks/session/files/grep', { q: 'Needle' })).status).toBe(200)
    expect((await auditText()).split('\n').filter(line => line.includes('"file.view"'))).toHaveLength(3)
    // This Mac's own window is not recorded, as its reads are not.
    expect((await request('desktop', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(200)
    expect((await auditText()).split('\n').filter(line => line.includes('"file.view"'))).toHaveLength(3)
  })

  it("gives searches slots of their own: one per device, two remote at a time, and never the local window's", async () => {
    const { request, state } = await routes()
    state.delay = 40
    const slow = [
      request('all', 'tasks/session/files/grep', { q: 'needle' }),
      request('other', 'tasks/session/files/grep', { q: 'needle' }),
    ]
    await vi.waitFor(() => expect(state.resolved).toBeGreaterThan(1))
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(429)
    expect((await request('third', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(429)
    // Neither the local window's search nor the tree's name search waits on them.
    const name = await request('desktop', 'tasks/session/files/search', { q: 'main' })
    expect(name.status).toBe(200)
    const local = request('desktop', 'tasks/session/files/grep', { q: 'needle' })
    expect((await Promise.all([...slow, local])).map(response => response.status)).toEqual([200, 200, 200])
  })

  it('ends a search when its request goes away, and frees its slot', async () => {
    const { request, state, f } = await routes()
    for (let index = 0; index < 60; index++) await writeFile(join(f.workspace, `x-${index}.txt`), 'needle\n')
    state.delay = 30
    const controller = new AbortController()
    const pending = request('all', 'tasks/session/files/grep', { q: 'needle' }, controller.signal).catch(() => undefined)
    await vi.waitFor(() => expect(state.resolved).toBeGreaterThan(0))
    controller.abort()
    await pending
    const at = state.resolved
    await new Promise(done => setTimeout(done, 200))
    expect(state.resolved - at).toBeLessThanOrEqual(1)
    state.delay = 0
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(200)
  })

  it('ends a search when its HTTP/2 stream is reset, as on the relay and native connections', async () => {
    const { handler, state, f } = await routes()
    for (let index = 0; index < 60; index++) await writeFile(join(f.workspace, `y-${index}.txt`), 'needle\n')
    state.delay = 30
    const server = createHttp2Server((req, res) => handler(req as unknown as IncomingMessage, res as unknown as ServerResponse))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    const client = connectHttp2(`http://127.0.0.1:${port}`)
    cleanup.push(async () => {
      client.close()
      await new Promise<void>(done => server.close(() => done()))
    })
    const stream = client.request({
      ':method': 'POST',
      ':path': '/link/api/tasks/session/files/grep',
      'x-test-device': 'all',
      'content-type': 'application/json',
    })
    stream.on('error', () => {})
    stream.end(JSON.stringify({ q: 'needle' }))
    await vi.waitFor(() => expect(state.resolved).toBeGreaterThan(0))
    stream.close(http2Constants.NGHTTP2_CANCEL)
    await new Promise(done => setTimeout(done, 100))
    const at = state.resolved
    await new Promise(done => setTimeout(done, 300))
    expect(state.resolved - at).toBeLessThanOrEqual(1)
  })

  it('frees a slot a hung read holds, after its hard time-out, and refuses new searches while two still hang', async () => {
    const { request, state, nativeSignal } = await routes()
    const hung: Array<() => void> = []
    state.afterResolve = () => new Promise<void>(resolve => hung.push(resolve))
    try {
      const started = performance.now()
      const answer = await request('all', 'tasks/session/files/grep', { q: 'needle' })
      expect(answer.status).toBe(503)
      expect(((await answer.json()) as { error: string }).error).toBe('file-grep-timeout')
      expect(performance.now() - started).toBeLessThan(4000)
      // The read still hangs, yet the listener on the long-lived connection signal (and the lease with it) is gone.
      expect(getEventListeners(nativeSignal.signal, 'abort')).toHaveLength(0)
      expect((await request('other', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(503)
      // Two time-outs still hang: nothing new is started to join them, from any device.
      expect(hungFileOperations.count).toBe(2)
      const refused = await request('files', 'tasks/session/files/grep', { q: 'needle' })
      expect(refused.status).toBe(429)
      expect(((await refused.json()) as { error: string }).error).toBe('file-grep-busy')
    } finally {
      state.afterResolve = undefined
      for (const resolve of hung.splice(0)) resolve()
    }
    await vi.waitFor(() => expect(hungFileOperations.count).toBe(0))
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(200)
  })

  it('reads the body before taking a slot, so slow bodies hold none', async () => {
    const { request, slowBody } = await routes()
    await slowBody('other')
    await slowBody('third')
    await new Promise(done => setTimeout(done, 100))
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(200)
    expect((await request('files', 'workspaces/project/files/grep', { q: 'needle', harnessId: 'standard' })).status).toBe(200)
  })

  it('leaves no listener on the connection’s signal once a search ends', async () => {
    const { request, nativeSignal } = await routes()
    expect((await request('all', 'tasks/session/files/grep', { q: 'needle' })).status).toBe(200)
    expect((await request('all', 'tasks/session/files/grep', { q: '' })).status).toBe(400)
    expect(getEventListeners(nativeSignal.signal, 'abort')).toHaveLength(0)
  })

  it('refuses a query that is not one line of text, and unknown fields', async () => {
    const { request } = await routes()
    expect((await request('all', 'tasks/session/files/grep', { q: '' })).status).toBe(400)
    expect((await request('all', 'tasks/session/files/grep', { q: 'x'.repeat(257) })).status).toBe(400)
    expect((await request('all', 'tasks/session/files/grep', { q: 'a\nb' })).status).toBe(400)
    expect((await request('all', 'tasks/session/files/grep', { q: 'a', regex: true })).status).toBe(400)
  })

  it('audits per-folder counts as well, never the text searched for or found', async () => {
    const { request, f } = await routes()
    const query = 'needle in the second'
    expect((await request('all', 'tasks/session/files/grep', { q: query })).status).toBe(200)
    const files = await readdir(join(f.parent, 'audit'))
    const text = (await Promise.all(files.map(name => readFile(join(f.parent, 'audit', name), 'utf8').catch(() => '')))).join('\n')
    expect(text).toContain('file.list')
    expect(text.includes('needle')).toBe(false)
    expect(text.includes('notes.txt')).toBe(false)
  })
})
