import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import type { TestDevice } from '@latch/testkit'
import { FileHandles, HANDLE_IDLE_MS, HANDLE_LIMIT } from '../src/files/handles.ts'
import { OPEN_TYPES, PREVIEW_UNVERIFIED, QUICK_LOOK_TYPES } from '../src/files/kinds.ts'
import { ProtectedPaths, fileVerdicts, parseReference, resolveReference, type Resolution } from '../src/files/resolve.ts'
import { isSecretPath } from '../src/files/secrets.ts'
import { matchesFamily } from '../src/files/sniff.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const PDF = Buffer.from('%PDF-1.7\n%\u00e2\u00e3\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const PEM_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function temporary(prefix = 'latch-files-'): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function testHost(options: Parameters<typeof startTestHost>[0] = {}): Promise<TestHost> {
  const host = await startTestHost(options)
  cleanup.push(() => host.close())
  return host
}

/** A folder for a session, a folder beside it, and resolve options over the first. */
async function layout(protectedPaths: string[] = []) {
  const base = await temporary()
  const root = join(base, 'project')
  const other = join(base, 'other')
  await mkdir(root)
  await mkdir(other)
  const options = { roots: [{ id: 'primary', path: root }], protectedPaths: new ProtectedPaths(protectedPaths), home: base }
  return { base, root, other, options }
}

const statusOf = (result: Resolution) => result.status

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise(done => setTimeout(done, 50))
  }
}

describe('file references as messages write them', () => {
  it.each([
    ['report.md', { path: 'report.md' }],
    ['./out/deck.pptx', { path: './out/deck.pptx' }],
    ['../notes.md', { path: '../notes.md' }],
    ['/Users/me/project/a.pdf', { path: '/Users/me/project/a.pdf' }],
    ['file:///Users/me/My%20Deck.pptx', { path: '/Users/me/My Deck.pptx' }],
    ['file://localhost/tmp/a.txt', { path: '/tmp/a.txt' }],
    ['src/app.ts:12', { path: 'src/app.ts', line: 12 }],
    ['src/app.ts:12:4', { path: 'src/app.ts', line: 12, column: 4 }],
    ['src/app.ts#L7', { path: 'src/app.ts', line: 7 }],
    ['file:///tmp/a.ts#L3', { path: '/tmp/a.ts', line: 3 }],
    ['~/Desktop/a.md', { path: '/home/me/Desktop/a.md' }],
  ])('reads %s', (input, expected) => {
    expect(parseReference(input, '/home/me')).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    'a\u0000b.md',
    'a\nb.md',
    'dir\\file.md',
    'C:\\Users\\me\\a.md',
    'c:/Users/me/a.md',
    'file://example.com/etc/hosts',
    'file:///tmp/a%00b',
    'file:///tmp/a?x=1',
    '~',
    '~root/.ssh/id_rsa',
    'a'.repeat(4097),
  ])('refuses %j', input => {
    expect(parseReference(input, '/home/me')).toBeUndefined()
  })
})

describe('resolving inside the session folders', () => {
  it('finds regular files, by relative, absolute and file:// spellings', async () => {
    const { root, options } = await layout()
    await mkdir(join(root, 'out'))
    await writeFile(join(root, 'out', 'deck.pptx'), ZIP)
    for (const input of ['out/deck.pptx', './out/deck.pptx', join(root, 'out/deck.pptx'), `file://${join(root, 'out/deck.pptx')}`]) {
      const result = await resolveReference(input, options)
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') continue
      expect(result.file).toMatchObject({ rootId: 'primary', relativePath: 'out/deck.pptx', name: 'deck.pptx', ext: 'pptx', size: 8 })
      expect(result.file.realPath).toBe(join(root, 'out', 'deck.pptx'))
    }
    expect(await resolveReference('out/deck.pptx:4', options)).toMatchObject({ status: 'ok', line: 4 })
  })

  it('refuses paths that leave the folders, by ../, by absolute path and through symlinks', async () => {
    const { base, root, other, options } = await layout()
    await writeFile(join(base, 'secret.txt'), 'x')
    await writeFile(join(other, 'notes.md'), 'x')
    await writeFile(join(root, 'inside.md'), 'x')
    await symlink(join(base, 'secret.txt'), join(root, 'escape.txt'))
    await symlink(other, join(root, 'other-folder'))
    await symlink(join(root, 'inside.md'), join(root, 'alias.md'))
    expect(statusOf(await resolveReference('../secret.txt', options))).toBe('outside')
    expect(statusOf(await resolveReference('../../../../../../etc/hosts', options))).toBe('outside')
    expect(statusOf(await resolveReference(join(base, 'secret.txt'), options))).toBe('outside')
    expect(statusOf(await resolveReference('/etc/hosts', options))).toBe('outside')
    expect(statusOf(await resolveReference('escape.txt', options))).toBe('outside')
    expect(statusOf(await resolveReference('other-folder/notes.md', options))).toBe('outside')
    // A missing file outside is "outside", not "missing": nothing is said about what exists elsewhere.
    expect(statusOf(await resolveReference('../nothing-here.md', options))).toBe('outside')
    // A symlink that stays inside the folder is followed to its target.
    const alias = await resolveReference('alias.md', options)
    expect(alias).toMatchObject({ status: 'ok', file: { relativePath: 'inside.md' } })
  })

  it('keeps a symlink into another session folder outside this one', async () => {
    const { root, other, options } = await layout()
    await writeFile(join(other, 'theirs.md'), 'x')
    await symlink(join(other, 'theirs.md'), join(root, 'theirs.md'))
    expect(statusOf(await resolveReference('theirs.md', options))).toBe('outside')
    // With both folders in the session, it resolves to the other folder's file.
    const both = { ...options, roots: [...options.roots, { id: 'second', path: other }] }
    expect(await resolveReference('theirs.md', both)).toMatchObject({ status: 'ok', file: { rootId: 'second', relativePath: 'theirs.md' } })
  })

  it('answers missing, invalid, folders and other non-regular files', async () => {
    const { root, options } = await layout()
    await mkdir(join(root, 'dir'))
    execFileSync('mkfifo', [join(root, 'pipe')])
    expect(statusOf(await resolveReference('nothing.md', options))).toBe('missing')
    expect(statusOf(await resolveReference('dir', options))).toBe('folder')
    expect(statusOf(await resolveReference('dir/', options))).toBe('folder')
    expect(statusOf(await resolveReference('.', options))).toBe('folder')
    expect(statusOf(await resolveReference('pipe', options))).toBe('not-file')
    expect(statusOf(await resolveReference('a\\b', options))).toBe('invalid')
  })

  it.skipIf(process.getuid?.() === 0)('answers unreadable for a file it may not open', async () => {
    const { root, options } = await layout()
    await writeFile(join(root, 'locked.md'), 'x')
    await chmod(join(root, 'locked.md'), 0o000)
    cleanup.push(() => chmod(join(root, 'locked.md'), 0o600))
    expect(statusOf(await resolveReference('locked.md', options))).toBe('unreadable')
  })

  it("refuses Latch's private paths inside a folder, existing or not, under any spelling", async () => {
    const base = await temporary()
    const root = join(base, 'project')
    const data = join(root, '.runtime')
    await mkdir(join(data, 'auth'), { recursive: true })
    await writeFile(join(data, 'auth', 'devices.json'), '{}')
    await symlink(data, join(root, 'data-link'))
    const options = { roots: [{ id: 'primary', path: root }], protectedPaths: new ProtectedPaths([data]), home: base }
    expect(statusOf(await resolveReference('.runtime/auth/devices.json', options))).toBe('protected')
    expect(statusOf(await resolveReference('.runtime/auth/none.json', options))).toBe('protected')
    expect(statusOf(await resolveReference('data-link/auth/devices.json', options))).toBe('protected')
    expect(statusOf(await resolveReference(join(data, 'auth', 'devices.json'), options))).toBe('protected')
  })

  it('refuses a file swapped for a symlink, or a folder swapped, after the checks and before it is read', async () => {
    const { base, root, options } = await layout()
    await writeFile(join(base, 'outside.pdf'), PDF)
    await writeFile(join(root, 'report.pdf'), PDF)
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'a.pdf'), PDF)
    await mkdir(join(base, 'elsewhere'))
    await writeFile(join(base, 'elsewhere', 'a.pdf'), PDF)
    const swapFile = {
      ...options,
      hooks: {
        async afterResolve(path: string) {
          await rm(path)
          await symlink(join(base, 'outside.pdf'), path)
        },
      },
    }
    expect(statusOf(await resolveReference('report.pdf', swapFile))).toBe('missing')
    const swapFolder = {
      ...options,
      hooks: {
        async afterResolve() {
          await rename(join(root, 'sub'), join(root, 'sub-moved'))
          await symlink(join(base, 'elsewhere'), join(root, 'sub'))
        },
      },
    }
    expect(statusOf(await resolveReference('sub/a.pdf', swapFolder))).toBe('missing')
  })
})

describe('what the desktop app may do with a file', () => {
  async function verdictsFor(name: string, content: string | Buffer) {
    const { root, options } = await layout()
    await mkdir(join(root, ...name.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(root, name), content)
    const result = await resolveReference(name, options)
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`)
    const verdicts = fileVerdicts(result.file)
    return {
      secret: result.file.secret,
      quicklook: verdicts.quicklook.ok ? 'ok' : verdicts.quicklook.code,
      open: verdicts.open.ok ? 'ok' : verdicts.open.code,
      reveal: verdicts.reveal.ok,
    }
  }

  it.each([
    ['talk.key', ZIP, 'ok', 'ok'],
    ['paper.pdf', PDF, 'ok', 'ok'],
    ['chart.png', PNG, 'ok', 'ok'],
    ['data.csv', 'a,b\n1,2\n', 'ok', 'ok'],
    ['notes.txt', 'plain\n', 'ok', 'ok'],
    // Office documents and Markdown can point at the network (linked pictures, images by URL): opened with their app,
    // not previewed until a check shows the previewer fetches nothing they link to.
    ['deck.pptx', ZIP, 'file-preview-unverified', 'ok'],
    ['sheet.xlsx', ZIP, 'file-preview-unverified', 'ok'],
    ['letter.docx', ZIP, 'file-preview-unverified', 'ok'],
    ['report.md', '# 复盘\n', 'file-preview-unverified', 'ok'],
    ['config.yaml', 'a: 1\n', 'file-type-refused', 'ok'],
    ['page.html', '<p>x</p>', 'file-type-refused', 'file-type-refused'],
    ['logo.svg', '<svg/>', 'file-type-refused', 'file-type-refused'],
    ['run.command', '#!/bin/sh\n', 'file-type-refused', 'file-type-refused'],
    ['install.sh', '#!/bin/sh\n', 'file-type-refused', 'file-type-refused'],
    ['old.ppt', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'file-type-refused', 'file-type-refused'],
    ['macro.pptm', ZIP, 'file-type-refused', 'file-type-refused'],
    ['link.webloc', '<plist/>', 'file-type-refused', 'file-type-refused'],
    ['Makefile', 'all:\n', 'file-type-refused', 'file-type-refused'],
    // The content must agree with the extension.
    ['fake.pdf', '#!/bin/sh\necho hi\n', 'file-content-mismatch', 'file-content-mismatch'],
    ['fake.pptx', 'not a zip', 'file-preview-unverified', 'file-content-mismatch'],
    ['binary.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]), 'file-content-mismatch', 'file-content-mismatch'],
  ])('%s: quick look %s, open %s', async (name, content, quicklook, open) => {
    expect(await verdictsFor(name, content)).toEqual({ secret: false, quicklook, open, reveal: true })
  })

  it.each([
    ['.env', 'TOKEN=1'],
    ['.env.local', 'TOKEN=1'],
    ['id_ed25519', 'x'],
    ['certs/server.pem', 'x'],
    ['signing.key', `${PEM_HEADER}\n`],
    ['.npmrc', 'x'],
    ['credentials.json', '{}'],
    ['.aws/config', 'x'],
    ['.git/config', 'x'],
    ['infra/terraform.tfstate', '{}'],
    ['notes.txt', `keep this\n${PEM_HEADER}\nMIIB\n`],
    ['settings.json', `{"apiKey":"sk-proj-${'a1B2'.repeat(8)}"}`],
    ['log.md', `credential ldc1.dev_${'A'.repeat(22)}.${'b'.repeat(43)}`],
  ])('treats %s as a likely secret: shown in Finder, never previewed or opened', async (name, content) => {
    expect(await verdictsFor(name, content)).toMatchObject({ secret: true, reveal: true })
    const verdict = await verdictsFor(name, content)
    for (const action of ['quicklook', 'open'] as const) expect(verdict[action]).not.toBe('ok')
    if (/\.(txt|json|md)$/u.test(name)) expect(verdict).toMatchObject({ quicklook: 'file-secret', open: 'file-secret' })
  })

  it.each([
    ['.env.example', 'TOKEN='],
    ['id_ed25519.pub', 'ssh-ed25519 AAAA'],
    ['talk.key', ZIP],
  ])('does not treat %s as a secret', (name, content) => {
    expect(isSecretPath(name, new Uint8Array(Buffer.from(content)))).toBe(false)
  })

  it.each([
    ['api.md', '调用 `GET https://api.example.com/items?token=YOUR_TOKEN` 取列表。\n'],
    ['ARCHITECTURE.md', '桌面端经 `host.sock` 发送 Latch-Device 请求头。\n'],
    ['cookies.txt', 'Cookie 名是 latch_abcdefgh=<凭据>\n'],
  ])('does not treat %s, which only names where a credential goes, as a secret', async (name, content) => {
    expect(await verdictsFor(name, content)).toMatchObject({ secret: false, open: 'ok' })
  })

  it('keeps the allow-lists free of anything that runs, opens a location or reaches the network', () => {
    const never = ['app', 'command', 'tool', 'sh', 'terminal', 'scpt', 'applescript', 'workflow', 'pkg', 'dmg', 'jar']
    const alsoNever = ['webloc', 'inetloc', 'fileloc', 'url', 'desktop', 'shortcut', 'docm', 'xlsm', 'pptm', 'potm', 'ppsm']
    const web = ['doc', 'xls', 'ppt', 'rtf', 'html', 'htm', 'xhtml', 'svg', 'webarchive', '']
    for (const ext of [...never, ...alsoNever, ...web]) {
      expect(OPEN_TYPES.has(ext)).toBe(false)
      expect(QUICK_LOOK_TYPES.has(ext)).toBe(false)
    }
    expect([...QUICK_LOOK_TYPES].every(ext => OPEN_TYPES.has(ext))).toBe(true)
    expect([...PREVIEW_UNVERIFIED].every(ext => OPEN_TYPES.has(ext) && !QUICK_LOOK_TYPES.has(ext))).toBe(true)
  })

  it('reads headers without throwing or looping on any input', () => {
    const families = [
      'zip',
      'pdf',
      'png',
      'jpeg',
      'gif',
      'webp',
      'heic',
      'tiff',
      'bmp',
      'mp3',
      'aac',
      'flac',
      'wav',
      'isobmff',
      'text',
    ] as const
    for (let index = 0; index < 10_000; index++) {
      const bytes = new Uint8Array(randomBytes(index % 40))
      for (const family of families) expect(typeof matchesFamily(family, bytes)).toBe('boolean')
    }
    // A UTF-8 character cut at the 8 KiB window is still text; a lone continuation byte inside it is not.
    const long = Buffer.from('文'.repeat(4000))
    expect(matchesFamily('text', new Uint8Array(long))).toBe(true)
    expect(matchesFamily('text', new Uint8Array(Buffer.from([0x61, 0x80, 0x61])))).toBe(false)
  })
})

describe('file handles', () => {
  it('stand for one device, session and file, lapse after 15 idle minutes and live only in memory', () => {
    let time = 1_000
    const handles = new FileHandles(() => time)
    const entry = { deviceId: 'dev_a', sessionId: 'task-1', rootId: 'primary', relativePath: 'a.md' }
    const handle = handles.issue(entry)
    expect(handle).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(handles.issue(entry)).toBe(handle)
    expect(handles.issue({ ...entry, deviceId: 'dev_b' })).not.toBe(handle)
    expect(handles.use(handle, 'dev_b')).toEqual({ ok: false, reason: 'foreign' })
    time += HANDLE_IDLE_MS - 1
    expect(handles.use(handle, 'dev_a')).toEqual({ ok: true, entry })
    time += HANDLE_IDLE_MS - 1
    expect(handles.use(handle, 'dev_a').ok).toBe(true)
    time += HANDLE_IDLE_MS
    expect(handles.use(handle, 'dev_a')).toEqual({ ok: false, reason: 'expired' })
    // A restarted Host has a new, empty table.
    expect(new FileHandles(() => time).use(handle, 'dev_a')).toEqual({ ok: false, reason: 'expired' })
  })

  it('keeps at most 4096, dropping the least recently used, and forgets a deleted session', () => {
    const handles = new FileHandles(() => 0)
    const first = handles.issue({ deviceId: 'dev_a', sessionId: 's', rootId: 'primary', relativePath: 'first.md' })
    for (let index = 0; index < HANDLE_LIMIT; index++)
      handles.issue({ deviceId: 'dev_a', sessionId: 's', rootId: 'primary', relativePath: `${index}.md` })
    expect(handles.size).toBe(HANDLE_LIMIT)
    expect(handles.use(first, 'dev_a')).toEqual({ ok: false, reason: 'expired' })
    handles.forgetSession('s')
    expect(handles.size).toBe(0)
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('file routes', () => {
  interface Resolved {
    input: string
    status: string
    code?: string
    line?: number
    file?: {
      handle: string
      name: string
      path: string
      ext: string
      secret: boolean
      actions: Record<string, boolean>
      refused?: Record<string, string>
    }
  }

  async function desktopSession(options: Parameters<typeof startTestHost>[0] = {}) {
    const t = await testHost(options)
    const desktop = await t.enroll({ listener: 'unix', name: '桌面端' })
    const { sessionId } = await t.host.bridge.createTask({ prompt: 'hello', requestId: randomUUID(), mode: 'chat' })
    await mkdir(join(t.workspaceRoot, 'out'), { recursive: true })
    await writeFile(join(t.workspaceRoot, 'out', 'deck.pptx'), ZIP)
    await writeFile(join(t.workspaceRoot, 'out', 'paper.pdf'), PDF)
    await writeFile(join(t.workspaceRoot, 'report.md'), '# 复盘\n')
    await writeFile(join(t.workspaceRoot, 'page.html'), '<p>x</p>')
    return { t, desktop, sessionId }
  }

  const resolve = (device: TestDevice, sessionId: string, paths: string[]) =>
    device.request(`tasks/${sessionId}/files/resolve`, { method: 'POST', body: { paths } })
  const act = (device: TestDevice, handle: string, sessionId: string, action: string) =>
    device.request(`files/${handle}/local`, { method: 'POST', body: { sessionId, action } })
  async function handleOf(device: TestDevice, sessionId: string, path: string): Promise<string> {
    const { files } = (await (await resolve(device, sessionId, [path])).json()) as { files: Resolved[] }
    return files[0]!.file!.handle
  }

  it('offers only referenced files to browsers while native actions remain on host.sock', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const browser = await t.enroll({ name: '浏览器', scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const refused = await resolve(browser, sessionId, ['report.md'])
    expect(refused.status).toBe(200)
    expect(await refused.json()).toMatchObject({ files: [{ status: 'not-referenced', code: 'file-not-referenced' }] })
    const handle = await handleOf(desktop, sessionId, 'report.md')
    const viaTcp = await act(browser, handle, sessionId, 'reveal')
    expect(viaTcp.status).toBe(403)
    expect(await viaTcp.json()).toMatchObject({ error: 'local-only' })
    // Without a credential on host.sock (the anonymous CLI) there is nothing either.
    const anonymous = await t.raw('unix', `api/tasks/${sessionId}/files/resolve`, { method: 'POST', body: { paths: ['report.md'] } })
    expect(anonymous.status).toBe(401)
    expect(t.host.security.audit.lastOf('file.reveal')).toBeUndefined()
  })

  it('resolves references with handles and verdicts, and never puts the real path in that answer', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const response = await resolve(desktop, sessionId, [
      'out/deck.pptx:3',
      'report.md',
      'page.html',
      'missing.md',
      '../../etc/hosts',
      'report.md',
    ])
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain(t.workspaceRoot)
    const { files } = JSON.parse(text) as { files: Resolved[] }
    expect(files).toHaveLength(5)
    expect(files[0]).toMatchObject({
      input: 'out/deck.pptx:3',
      status: 'ok',
      line: 3,
      file: {
        name: 'deck.pptx',
        path: 'out/deck.pptx',
        ext: 'pptx',
        secret: false,
        actions: { reveal: true, quicklook: false, open: true },
        refused: { quicklook: 'file-preview-unverified' },
      },
    })
    expect(files[0]!.file!.handle).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(files[2]).toMatchObject({
      status: 'ok',
      file: {
        actions: { reveal: true, quicklook: false, open: false },
        refused: { quicklook: 'file-type-refused', open: 'file-type-refused' },
      },
    })
    expect(files[3]).toEqual({ input: 'missing.md', status: 'missing', code: 'file-missing' })
    expect(files[4]).toEqual({ input: '../../etc/hosts', status: 'outside', code: 'file-outside-folders' })
    // Resolving writes no audit record: nothing was shown, read for the page or started.
    expect(t.host.security.audit.lastOf('file.reveal')).toBeUndefined()
  })

  it('records the action before it answers with the real path, and refuses what the type does not allow', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const paper = await handleOf(desktop, sessionId, 'out/paper.pdf')
    const paperPath = join(await realpath(t.workspaceRoot), 'out', 'paper.pdf')
    for (const action of ['reveal', 'quicklook', 'open'] as const) {
      const response = await act(desktop, paper, sessionId, action)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ file: { path: paperPath, name: 'paper.pdf', ext: 'pdf' } })
      expect(t.host.security.audit.lastOf(`file.${action}`)).toMatchObject({
        actor: { deviceId: desktop.id, listener: 'unix' },
        target: sessionId,
        detail: { sessionId, pathHash: sha256Hex(paperPath), type: 'pdf' },
      })
    }
    const before = t.host.security.audit.head().seq
    // A presentation opens with its app but is not previewed yet: nothing is recorded or answered for that.
    const deck = await handleOf(desktop, sessionId, 'out/deck.pptx')
    const preview = await act(desktop, deck, sessionId, 'quicklook')
    expect(preview.status).toBe(403)
    expect(await preview.json()).toMatchObject({ error: 'file-preview-unverified' })
    expect(t.host.security.audit.head().seq).toBe(before)
    expect((await act(desktop, deck, sessionId, 'open')).status).toBe(200)
    expect(t.host.security.audit.lastOf('file.open')?.detail).toMatchObject({ type: 'pptx' })
    const page = await handleOf(desktop, sessionId, 'page.html')
    const opened = t.host.security.audit.head().seq
    const refused = await act(desktop, page, sessionId, 'open')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'file-type-refused' })
    expect(t.host.security.audit.head().seq).toBe(opened)
    // Showing it in Finder starts nothing, so any regular file may be shown.
    expect((await act(desktop, page, sessionId, 'reveal')).status).toBe(200)
    expect(t.host.security.audit.lastOf('file.reveal')?.detail).toMatchObject({ type: 'other' })
  })

  it('audits 在编辑器中打开 for a text file first, and refuses binary, secret and workspace files unrecorded', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    await writeFile(join(t.workspaceRoot, 'main.ts'), 'export const a = 1\n')
    await writeFile(join(t.workspaceRoot, 'team.code-workspace'), '{ "folders": [] }\n')
    await writeFile(join(t.workspaceRoot, '.env'), 'API_KEY=sk-test\n')
    const { files } = (await (await resolve(desktop, sessionId, ['main.ts:4', 'out/deck.pptx', 'team.code-workspace', '.env'])).json()) as {
      files: Resolved[]
    }
    expect(files.map(entry => entry.file?.actions.editor)).toEqual([true, false, false, false])
    expect(files.map(entry => entry.file?.refused?.editor)).toEqual([undefined, 'file-not-text', 'file-type-refused', 'file-secret'])
    const before = t.host.security.audit.head().seq
    for (const entry of files.slice(1)) {
      const refused = await act(desktop, entry.file!.handle, sessionId, 'editor')
      expect(refused.status).toBe(403)
    }
    expect(t.host.security.audit.head().seq).toBe(before)
    const mainPath = join(await realpath(t.workspaceRoot), 'main.ts')
    const opened = await act(desktop, files[0]!.file!.handle, sessionId, 'editor')
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ file: { path: mainPath, name: 'main.ts', ext: 'ts' } })
    expect(t.host.security.audit.lastOf('file.editor')).toMatchObject({
      actor: { deviceId: desktop.id, listener: 'unix' },
      target: sessionId,
      detail: { sessionId, pathHash: sha256Hex(mainPath), type: 'other' },
    })
    // Starting an editor is starting a program on this Mac: a device that may only look gets nothing.
    const viewer = await t.enroll({ listener: 'unix', name: '只看', scopes: ['view'] })
    const viewerHandle = await handleOf(viewer, sessionId, 'main.ts')
    expect((await act(viewer, viewerHandle, sessionId, 'editor')).status).toBe(403)
  })

  it('refuses the action and gives no path when the audit log cannot be written', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const deck = await handleOf(desktop, sessionId, 'out/deck.pptx')
    vi.spyOn(t.host.security.audit, 'append').mockRejectedValue(new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行'))
    const response = await act(desktop, deck, sessionId, 'open')
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ error: 'audit-unavailable' })
    expect(text).not.toContain('deck.pptx')
  })

  it('binds a handle to its device and session, and lets it lapse', async () => {
    let offset = 0
    const { t, desktop, sessionId } = await desktopSession({ now: () => Date.now() + offset })
    const second = await t.enroll({ listener: 'unix', name: '另一个桌面端' })
    const deck = await handleOf(desktop, sessionId, 'out/deck.pptx')
    const foreign = await act(second, deck, sessionId, 'reveal')
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: 'file-handle-foreign' })
    const { sessionId: otherSession } = await t.host.bridge.createTask({ prompt: 'hello', requestId: randomUUID(), mode: 'chat' })
    const wrongSession = await act(desktop, deck, otherSession, 'reveal')
    expect(wrongSession.status).toBe(403)
    expect(await wrongSession.json()).toMatchObject({ error: 'file-handle-foreign' })
    expect((await act(desktop, deck, sessionId, 'reveal')).status).toBe(200)
    offset = HANDLE_IDLE_MS + 1_000
    const expired = await act(desktop, deck, sessionId, 'reveal')
    expect(expired.status).toBe(410)
    expect(await expired.json()).toMatchObject({ error: 'file-handle-expired' })
    expect((await act(desktop, 'A'.repeat(22), sessionId, 'reveal')).status).toBe(410)
    expect((await act(desktop, 'not-a-handle', sessionId, 'reveal')).status).toBe(400)
    expect((await act(desktop, 'A%2F'.repeat(6), sessionId, 'reveal')).status).toBe(400)
  })

  it('resolves the file again on every action: a file moved out of the folder or deleted is gone', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const report = await handleOf(desktop, sessionId, 'report.md')
    await rename(join(t.workspaceRoot, 'report.md'), join(t.root, 'report.md'))
    await symlink(join(t.root, 'report.md'), join(t.workspaceRoot, 'report.md'))
    const outside = await act(desktop, report, sessionId, 'reveal')
    expect(outside.status).toBe(403)
    expect(await outside.json()).toMatchObject({ error: 'file-outside-folders' })
    await rm(join(t.workspaceRoot, 'report.md'))
    expect(await (await act(desktop, report, sessionId, 'reveal')).json()).toMatchObject({ error: 'file-missing' })
  })

  it('needs all-scope for native actions, view to reveal and run to open, while work resolves only references', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const limited = await t.enroll({ listener: 'unix', name: '受限桌面端' })
    const deck = await handleOf(limited, sessionId, 'out/deck.pptx')
    const lowered = await desktop.request(`devices/${limited.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
    expect(lowered.status).toBe(200)
    expect((await act(limited, deck, sessionId, 'reveal')).status).toBe(200)
    const open = await act(limited, deck, sessionId, 'open')
    expect(open.status).toBe(403)
    expect(await open.json()).toMatchObject({ error: 'scope-required', required: 'run' })
    const work = await desktop.request(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    expect(work.status).toBe(200)
    const scoped = await resolve(limited, sessionId, ['report.md'])
    expect(scoped.status).toBe(200)
    expect(await scoped.json()).toMatchObject({ files: [{ code: 'file-not-referenced' }] })
    expect((await act(limited, deck, sessionId, 'reveal')).status).toBe(403)
  })

  it.each(['resolve', 'action'] as const)('rechecks a narrowed data scope while a file %s waits', async operation => {
    const waiting = deferred()
    const proceed = deferred()
    let hold = false
    const { t, desktop, sessionId } = await desktopSession({
      fileHooks: {
        afterResolve: async () => {
          if (!hold) return
          waiting.resolve()
          await proceed.promise
        },
      },
    })
    const limited = await t.enroll({ listener: 'unix', name: '临时桌面端' })
    const handle = await handleOf(limited, sessionId, 'report.md')
    hold = true
    const pending = operation === 'resolve' ? resolve(limited, sessionId, ['report.md']) : act(limited, handle, sessionId, 'reveal')
    try {
      await waiting.promise
      expect((await desktop.request(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    } finally {
      proceed.resolve()
    }
    const response = await pending
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'file-scope' })
    expect(t.host.security.audit.lastOf('file.reveal')).toBeUndefined()
  })

  it('rechecks revocation after writing the file action audit and before giving the path', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const limited = await t.enroll({ listener: 'unix', name: '临时桌面端' })
    const handle = await handleOf(limited, sessionId, 'report.md')
    const waiting = deferred()
    const proceed = deferred()
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    vi.spyOn(t.host.security.audit, 'append').mockImplementation(async event => {
      const result = await append(event)
      if (event.action === 'file.reveal') {
        waiting.resolve()
        await proceed.promise
      }
      return result
    })
    const pending = act(limited, handle, sessionId, 'reveal')
    try {
      await waiting.promise
      expect((await desktop.request(`devices/${limited.id}`, { method: 'DELETE' })).status).toBe(200)
    } finally {
      proceed.resolve()
    }
    const response = await pending
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'device-revoked' })
  })

  it('refuses the files of a session whose project was removed, and forgets its handles', async () => {
    const { t, desktop } = await desktopSession()
    const project = await temporary('latch-files-project-')
    await writeFile(join(project, 'notes.md'), '# 笔记\n')
    const added = await desktop.addFolders({ name: '笔记', paths: [project] })
    const { workspace } = (await added.json()) as { workspace: { id: string } }
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat', workspaceId: workspace.id },
    })
    const notes = await handleOf(desktop, sessionId, 'notes.md')
    expect((await act(desktop, notes, sessionId, 'reveal')).status).toBe(200)
    await waitUntil(async () => (await t.host.bridge.detail(sessionId)).summary.status !== 'running')
    expect((await desktop.request(`workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(200)
    const before = t.host.security.audit.head().seq
    for (const response of [await act(desktop, notes, sessionId, 'reveal'), await resolve(desktop, sessionId, ['notes.md'])]) {
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'file-folder-removed' })
    }
    expect(t.host.security.audit.head().seq).toBe(before)
    // Registered again with the same identity and folder, the file resolves afresh; the old handle stays forgotten.
    await desktop.addFolders({ name: '笔记', paths: [project] })
    expect(await (await act(desktop, notes, sessionId, 'reveal')).json()).toMatchObject({ error: 'file-handle-expired' })
    expect((await resolve(desktop, sessionId, ['notes.md'])).status).toBe(200)
  })

  it('answers 404 for an unknown or deleted session and 400 for too many references', async () => {
    const { t, desktop, sessionId } = await desktopSession()
    const deck = await handleOf(desktop, sessionId, 'out/deck.pptx')
    const unknown = await resolve(desktop, 'task-nothing', ['report.md'])
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: 'task-not-found' })
    const tooMany = await resolve(
      desktop,
      sessionId,
      Array.from({ length: 65 }, (_, index) => `${index}.md`),
    )
    expect(tooMany.status).toBe(400)
    await waitUntil(async () => (await t.host.bridge.detail(sessionId)).summary.status !== 'running')
    const removed = await desktop.request(`tasks/${sessionId}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    const gone = await act(desktop, deck, sessionId, 'reveal')
    expect(gone.status).toBe(404)
    expect(await gone.json()).toMatchObject({ error: 'task-not-found' })
  })
})
