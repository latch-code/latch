import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  FAMILY_OF as HOST_FAMILY_OF,
  OPEN_TYPES as HOST_OPEN,
  PREVIEW_UNVERIFIED as HOST_UNVERIFIED,
  QUICK_LOOK_TYPES as HOST_QUICK_LOOK,
} from '@latch/host/files/kinds'
import { matchesFamily as hostMatchesFamily } from '@latch/host/files/sniff'

const require = createRequire(import.meta.url)

type Result = { status: string; code?: string; name?: string; actions?: Record<string, boolean>; refused?: Record<string, string> }
interface FileActions {
  inspectFile(input: unknown): Promise<Result>
  knownFiles(input: unknown): Promise<{ status: string; code?: string; known?: string[] }>
  revealFile(input: unknown): Promise<Result>
  quickLookFile(input: unknown): Promise<Result>
  openFile(input: unknown): Promise<Result>
}
interface Dependencies {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>
  show(path: string): void
  quickLook(path: string, name: string): void
  open(path: string): Promise<string>
  inspect(path: string): Promise<{ real: string; file: boolean; symlink: boolean }>
  readHead(path: string, bytes: number): Promise<Uint8Array>
  platform: string
  now?(): number
  log?(message: string): void
}
interface FilesModule {
  ACTION_INTERVAL_MS: number
  INSPECTIONS_LIMIT: number
  QUICK_LOOK_TYPES: Set<string>
  PREVIEW_UNVERIFIED: Set<string>
  OPEN_TYPES: Set<string>
  FAMILY_OF: Record<string, string>
  parseFileInput(input: unknown): { sessionId: string; path?: string; handle?: string } | undefined
  parseKnownInput(input: unknown): { sessionId: string; paths: string[] } | undefined
  matchesFamily(family: string, bytes: Uint8Array): boolean
  offeredHere(action: string, platform: string, ext: string): boolean
  createFileActions(options: Dependencies): FileActions
}
const files: FilesModule = require('../src/files.cjs')

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])
const HANDLE = 'AbCdEfGhIjKlMnOpQrStUv'
const SESSION = 'task-1'
const DECK = '/Users/me/project/out/deck.pptx'

type HostFile = { name: string; actions: Record<string, boolean>; refused?: Record<string, string> }

/**
 * A Host that resolves every reference to `file` (or answers `resolveStatus`) and answers the action route with
 * `path`, recording the calls in order with the shell's own calls.
 */
function harness(options: {
  file?: HostFile
  resolveStatus?: { status: string; code: string }
  act?: { status: number; json: unknown }
  path?: string
  found?: { real: string; file: boolean; symlink: boolean }
  head?: Uint8Array
  platform?: string
  openError?: string
  log?: (message: string) => void
  now?: () => number
}) {
  const calls: string[] = []
  const file = options.file ?? { name: 'deck.pptx', actions: { reveal: true, quicklook: true, open: true } }
  const path = options.path ?? DECK
  const dependencies: Dependencies = {
    async request(method, url, body) {
      calls.push(`${method} ${url} ${JSON.stringify(body)}`)
      if (url.endsWith('/files/resolve')) {
        const entry = options.resolveStatus
          ? { input: 'x', ...options.resolveStatus }
          : { input: 'x', status: 'ok', file: { handle: HANDLE, ...file } }
        return { status: 200, json: { files: [entry] } }
      }
      return options.act ?? { status: 200, json: { file: { path, name: file.name, ext: 'pptx' } } }
    },
    show: shown => {
      calls.push(`show ${shown}`)
    },
    quickLook: (shown, name) => {
      calls.push(`quickLook ${shown} ${name}`)
    },
    async open(opened) {
      calls.push(`open ${opened}`)
      return options.openError ?? ''
    },
    inspect: async real => options.found ?? { real, file: true, symlink: false },
    readHead: async () => options.head ?? ZIP,
    ...(options.log ? { log: options.log } : {}),
    platform: options.platform ?? 'darwin',
    ...(options.now ? { now: options.now } : {}),
  }
  return { actions: files.createFileActions(dependencies), calls }
}

const shellCalls = (calls: string[]) => calls.filter(call => /^(show|quickLook|open) /u.test(call))

describe('desktop shell files', () => {
  it('does not log raw application failures that may contain private file paths', async () => {
    const logs: string[] = []
    const privateDetail = '/private/project/private-key-in-filename.pptx'
    const { actions } = harness({ openError: privateDetail, log: line => logs.push(line) })
    expect(await actions.openFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({ status: 'failed', code: 'open-failed' })
    expect(logs).toHaveLength(1)
    expect(logs.join('\n')).not.toContain(privateDetail)
  })

  it('takes only a session and a reference or a handle, with nothing else in the input', () => {
    expect(files.parseFileInput({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({ sessionId: SESSION, path: 'out/deck.pptx' })
    expect(files.parseFileInput({ sessionId: SESSION, handle: HANDLE })).toEqual({ sessionId: SESSION, handle: HANDLE })
    const inherited = { sessionId: SESSION, path: 'a.md' }
    Object.setPrototypeOf(inherited, { extra: true })
    for (const input of [
      null,
      'a.md',
      [],
      { path: 'a.md' },
      { sessionId: SESSION },
      { sessionId: SESSION, path: 'a.md', extra: 1 },
      { sessionId: SESSION, path: 'a.md', handle: HANDLE },
      { sessionId: '../x', path: 'a.md' },
      { sessionId: '', path: 'a.md' },
      { sessionId: SESSION, path: '' },
      { sessionId: SESSION, path: '   ' },
      { sessionId: SESSION, path: 'a\u0000b' },
      { sessionId: SESSION, path: 'a\nb' },
      { sessionId: SESSION, path: 'x'.repeat(4097) },
      { sessionId: SESSION, path: 42 },
      { sessionId: SESSION, handle: 'short' },
      { sessionId: SESSION, handle: `${HANDLE}/../x` },
      inherited,
    ])
      expect(files.parseFileInput(input), JSON.stringify(input)).toBeUndefined()
  })

  it('keeps the same type lists and header checks as the Host', () => {
    expect([...files.QUICK_LOOK_TYPES].sort()).toEqual([...HOST_QUICK_LOOK].sort())
    expect([...files.OPEN_TYPES].sort()).toEqual([...HOST_OPEN].sort())
    expect([...files.PREVIEW_UNVERIFIED].sort()).toEqual([...HOST_UNVERIFIED].sort())
    expect({ ...files.FAMILY_OF }).toEqual({ ...HOST_FAMILY_OF })
    const families = [...new Set(Object.values(HOST_FAMILY_OF))]
    const samples = [
      ZIP,
      new TextEncoder().encode('%PDF-1.7'),
      new TextEncoder().encode('# 标题'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      new Uint8Array([0xff, 0xfb, 0x90]),
      new Uint8Array([0xff, 0xf1, 0x50]),
      new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt '),
      new TextEncoder().encode('\u0000\u0000\u0000\u0018ftypheic'),
      new TextEncoder().encode('\u0000\u0000\u0000\u0014ftypqt  '),
      new Uint8Array(Buffer.from('文'.repeat(4000))),
    ]
    for (let index = 0; index < 500; index++) samples.push(new Uint8Array(randomBytes(index % 24)))
    for (const family of families)
      for (const bytes of samples) expect(files.matchesFamily(family, bytes), family).toBe(hostMatchesFamily(family, bytes))
  })

  it('offers Quick Look only on macOS and opening only on macOS and Linux, for allowed types', () => {
    expect(files.offeredHere('quicklook', 'darwin', 'pdf')).toBe(true)
    expect(files.offeredHere('quicklook', 'linux', 'pdf')).toBe(false)
    // Office documents and Markdown can point at the network: opened with their app, never previewed for now.
    for (const ext of ['docx', 'pptx', 'xlsx', 'md']) {
      expect(files.offeredHere('quicklook', 'darwin', ext), ext).toBe(false)
      expect(files.offeredHere('open', 'darwin', ext), ext).toBe(true)
    }
    expect(files.offeredHere('open', 'linux', 'pdf')).toBe(true)
    expect(files.offeredHere('open', 'win32', 'pdf')).toBe(false)
    for (const ext of [
      'app',
      'command',
      'sh',
      'terminal',
      'webloc',
      'url',
      'inetloc',
      'fileloc',
      'html',
      'svg',
      'ppt',
      'doc',
      'xls',
      'rtf',
      '',
    ])
      for (const action of ['quicklook', 'open']) expect(files.offeredHere(action, 'darwin', ext), `${action} ${ext}`).toBe(false)
    expect(files.offeredHere('reveal', 'win32', 'command')).toBe(true)
  })

  it('tells the page what it may offer, from the Host verdicts and this computer, without a path', async () => {
    const { actions, calls } = harness({
      file: { name: 'letter.docx', actions: { reveal: true, quicklook: false, open: true }, refused: { quicklook: 'file-type-refused' } },
    })
    const answer = await actions.inspectFile({ sessionId: SESSION, path: 'letter.docx' })
    expect(answer).toEqual({
      status: 'ok',
      name: 'letter.docx',
      actions: { reveal: true, quickLook: false, open: true },
      refused: { quickLook: 'file-type-refused' },
    })
    // The Host's reason reaches the page as it was given: a presentation is not previewed until that is verified.
    const deck = harness({
      file: {
        name: 'deck.pptx',
        actions: { reveal: true, quicklook: false, open: true },
        refused: { quicklook: 'file-preview-unverified' },
      },
    })
    expect(await deck.actions.inspectFile({ sessionId: SESSION, path: 'deck.pptx' })).toMatchObject({
      actions: { reveal: true, quickLook: false, open: true },
      refused: { quickLook: 'file-preview-unverified' },
    })
    expect(JSON.stringify(answer)).not.toContain('/Users/')
    expect(calls).toEqual([`POST /link/api/tasks/${SESSION}/files/resolve {"paths":["letter.docx"]}`])
    const linux = harness({ platform: 'linux' })
    expect(await linux.actions.inspectFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toMatchObject({
      actions: { reveal: true, quickLook: false, open: true },
      refused: { quickLook: 'unsupported' },
    })
    const outside = harness({ resolveStatus: { status: 'outside', code: 'file-outside-folders' } })
    expect(await outside.actions.inspectFile({ sessionId: SESSION, path: '../x.md' })).toEqual({
      status: 'refused',
      code: 'file-outside-folders',
    })
    expect(await outside.actions.inspectFile({ sessionId: SESSION, handle: HANDLE })).toEqual({ status: 'failed', code: 'invalid' })
  })

  it('opens only after the Host answered the action route, with the real path it gave, and never openExternal', async () => {
    const { actions, calls } = harness({})
    expect(await actions.openFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({ status: 'opened' })
    expect(calls).toEqual([
      `POST /link/api/tasks/${SESSION}/files/resolve {"paths":["out/deck.pptx"]}`,
      `POST /link/api/files/${HANDLE}/local {"sessionId":"${SESSION}","action":"open"}`,
      `open ${DECK}`,
    ])
    const source = await readFile(new URL('../src/files.cjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/openExternal\s*\(/u)
  })

  it('shows, previews and opens by a handle the Host gave, skipping the resolve', async () => {
    let time = 0
    const paper = '/Users/me/project/out/paper.pdf'
    const { actions, calls } = harness({ now: () => time, path: paper, head: new TextEncoder().encode('%PDF-1.7\n') })
    expect(await actions.revealFile({ sessionId: SESSION, handle: HANDLE })).toEqual({ status: 'shown' })
    time += files.ACTION_INTERVAL_MS
    expect(await actions.quickLookFile({ sessionId: SESSION, handle: HANDLE })).toEqual({ status: 'shown' })
    expect(calls).toEqual([
      `POST /link/api/files/${HANDLE}/local {"sessionId":"${SESSION}","action":"reveal"}`,
      `show ${paper}`,
      `POST /link/api/files/${HANDLE}/local {"sessionId":"${SESSION}","action":"quicklook"}`,
      `quickLook ${paper} paper.pdf`,
    ])
    // Main keeps its own list: a presentation the Host somehow allowed is still not previewed.
    time += files.ACTION_INTERVAL_MS
    const deck = harness({})
    expect(await deck.actions.quickLookFile({ sessionId: SESSION, handle: HANDLE })).toEqual({
      status: 'refused',
      code: 'file-type-refused',
    })
    expect(shellCalls(deck.calls)).toEqual([])
  })

  it('calls no shell function when the Host refuses, fails or is not reached', async () => {
    const outside = harness({ resolveStatus: { status: 'outside', code: 'file-outside-folders' } })
    expect(await outside.actions.openFile({ sessionId: SESSION, path: '../../etc/hosts' })).toEqual({
      status: 'refused',
      code: 'file-outside-folders',
    })
    const html = harness({
      file: { name: 'page.html', actions: { reveal: true, quicklook: false, open: false }, refused: { open: 'file-type-refused' } },
    })
    expect(await html.actions.openFile({ sessionId: SESSION, path: 'page.html' })).toEqual({ status: 'refused', code: 'file-type-refused' })
    expect(html.calls.some(call => call.includes('/local'))).toBe(false)
    const audit = harness({ act: { status: 503, json: { error: 'audit-unavailable', message: '审计记录写入失败，操作未执行' } } })
    expect(await audit.actions.openFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({
      status: 'failed',
      code: 'audit-unavailable',
    })
    const expired = harness({ act: { status: 410, json: { error: 'file-handle-expired', message: '文件已不可用，请重新打开' } } })
    expect(await expired.actions.revealFile({ sessionId: SESSION, handle: HANDLE })).toEqual({
      status: 'refused',
      code: 'file-handle-expired',
    })
    const down = files.createFileActions({
      request: async () => {
        throw new Error('ECONNREFUSED')
      },
      show: () => {
        throw new Error('called')
      },
      quickLook: () => {
        throw new Error('called')
      },
      open: async () => {
        throw new Error('called')
      },
      inspect: async real => ({ real, file: true, symlink: false }),
      readHead: async () => ZIP,
      platform: 'darwin',
    })
    expect(await down.openFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({ status: 'failed', code: 'shell-failed' })
    for (const { calls } of [outside, html, audit, expired]) expect(shellCalls(calls)).toEqual([])
  })

  it('checks again what the Host answered: a folder, a symlink, another real path, a type or content it would not open', async () => {
    const cases: Array<[Parameters<typeof harness>[0], string]> = [
      [{ found: { real: DECK, file: false, symlink: false } }, 'file-changed'],
      [{ found: { real: DECK, file: false, symlink: true } }, 'file-changed'],
      [{ found: { real: '/Users/me/elsewhere/deck.pptx', file: true, symlink: false } }, 'file-changed'],
      [{ path: '/Users/me/project/Run.command' }, 'file-type-refused'],
      [{ path: '/Users/me/project/Latch.app' }, 'file-type-refused'],
      [{ path: '/Users/me/project/page.html' }, 'file-type-refused'],
      [{ head: new TextEncoder().encode('#!/bin/sh\nrm -rf ~\n') }, 'file-content-mismatch'],
    ]
    for (const [options, code] of cases) {
      const { actions, calls } = harness(options)
      expect(await actions.openFile({ sessionId: SESSION, path: 'out/deck.pptx' }), JSON.stringify(options)).toEqual({
        status: 'refused',
        code,
      })
      expect(shellCalls(calls)).toEqual([])
    }
    for (const path of ['relative/deck.pptx', '/Users/me/a\u0000.pptx', '']) {
      const { actions, calls } = harness({ path })
      expect(await actions.revealFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({
        status: 'failed',
        code: 'host-unavailable',
      })
      expect(shellCalls(calls)).toEqual([])
    }
    const failed = harness({ openError: 'No application knows how to open this file' })
    expect(await failed.actions.openFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({ status: 'failed', code: 'open-failed' })
  })

  it('takes one native action at a time, at most twice a second', async () => {
    let time = 0
    let release: (() => void) | undefined
    const calls: string[] = []
    const actions = files.createFileActions({
      request: async (_method, url) => {
        if (url.endsWith('/local')) await new Promise<void>(done => (release = done))
        return url.endsWith('/local')
          ? { status: 200, json: { file: { path: DECK, name: 'deck.pptx', ext: 'pptx' } } }
          : {
              status: 200,
              json: {
                files: [
                  { status: 'ok', file: { handle: HANDLE, name: 'deck.pptx', actions: { reveal: true, quicklook: true, open: true } } },
                ],
              },
            }
      },
      show: path => {
        calls.push(path)
      },
      quickLook: () => {},
      open: async () => '',
      inspect: async real => ({ real, file: true, symlink: false }),
      readHead: async () => ZIP,
      platform: 'darwin',
      now: () => time,
    })
    const first = actions.revealFile({ sessionId: SESSION, path: 'out/deck.pptx' })
    expect(await actions.openFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({ status: 'busy' })
    await until(() => release !== undefined)
    release!()
    expect(await first).toEqual({ status: 'shown' })
    time += files.ACTION_INTERVAL_MS - 1
    expect(await actions.revealFile({ sessionId: SESSION, path: 'out/deck.pptx' })).toEqual({ status: 'busy' })
    expect(calls).toEqual([DECK])
    // Bad input never takes the turn.
    time += 1
    expect(await actions.revealFile({ sessionId: SESSION })).toEqual({ status: 'failed', code: 'invalid' })
    release = undefined
    const second = actions.revealFile({ sessionId: SESSION, handle: HANDLE })
    await until(() => release !== undefined)
    release!()
    expect(await second).toEqual({ status: 'shown' })
  })

  it('tells the page to restart a Host from before file actions, and passes other refusals on as refusals', async () => {
    const answers: Array<[{ status: number; json: unknown }, { status: string; code: string }]> = [
      [
        { status: 404, json: { error: 'not-found', message: '接口不存在' } },
        { status: 'failed', code: 'host-outdated' },
      ],
      [
        { status: 404, json: { error: 'task-not-found', message: '找不到该会话' } },
        { status: 'refused', code: 'task-not-found' },
      ],
      [
        { status: 409, json: { error: 'file-folder-removed', message: '…' } },
        { status: 'refused', code: 'file-folder-removed' },
      ],
      [
        { status: 429, json: { error: 'rate-limited', message: '…' } },
        { status: 'failed', code: 'rate-limited' },
      ],
      [
        { status: 502, json: undefined },
        { status: 'failed', code: 'host-unavailable' },
      ],
    ]
    for (const [answer, expected] of answers) {
      const calls: string[] = []
      const actions = files.createFileActions({
        request: async (_method, url) => {
          calls.push(url)
          return answer
        },
        show: () => calls.push('show'),
        quickLook: () => calls.push('quickLook'),
        open: async () => {
          calls.push('open')
          return ''
        },
        inspect: async real => ({ real, file: true, symlink: false }),
        readHead: async () => ZIP,
        platform: 'darwin',
      })
      expect(await actions.inspectFile({ sessionId: SESSION, path: 'report.md' }), JSON.stringify(answer)).toEqual(expected)
      expect(await actions.openFile({ sessionId: SESSION, path: 'report.md' }), JSON.stringify(answer)).toEqual(expected)
      expect(
        calls.every(call => call.endsWith('/files/resolve')),
        JSON.stringify(calls),
      ).toBe(true)
    }
  })

  it('checks several references side by side, a double click included, up to a limit', async () => {
    const pending: Array<() => void> = []
    const actions = files.createFileActions({
      request: async () => {
        await new Promise<void>(done => pending.push(done))
        return {
          status: 200,
          json: {
            files: [{ status: 'ok', file: { handle: HANDLE, name: 'deck.pptx', actions: { reveal: true, quicklook: false, open: true } } }],
          },
        }
      },
      show: () => {},
      quickLook: () => {},
      open: async () => '',
      inspect: async real => ({ real, file: true, symlink: false }),
      readHead: async () => ZIP,
      platform: 'darwin',
    })
    const checks = Array.from({ length: files.INSPECTIONS_LIMIT }, () => actions.inspectFile({ sessionId: SESSION, path: 'deck.pptx' }))
    expect(await actions.inspectFile({ sessionId: SESSION, path: 'deck.pptx' })).toEqual({ status: 'busy' })
    await until(() => pending.length === files.INSPECTIONS_LIMIT)
    for (const done of pending.splice(0)) done()
    for (const answer of await Promise.all(checks)) expect(answer).toMatchObject({ status: 'ok', name: 'deck.pptx' })
    const again = actions.inspectFile({ sessionId: SESSION, path: 'deck.pptx' })
    await until(() => pending.length === 1)
    pending.pop()!()
    expect(await again).toMatchObject({ status: 'ok' })
  })

  it('tells the page which of a batch of references are files, in one resolve, as the references it sent', async () => {
    const calls: string[] = []
    const actions = files.createFileActions({
      request: async (method, url, body) => {
        calls.push(`${method} ${url} ${JSON.stringify(body)}`)
        return {
          status: 200,
          json: {
            files: [
              { input: 'out/deck.pptx', status: 'ok', file: { handle: HANDLE, name: 'deck.pptx', actions: { reveal: true } } },
              { input: 'src/app.ts:12', status: 'ok', file: { handle: HANDLE, name: 'app.ts', actions: { reveal: true } } },
              { input: 'missing.ts', status: 'missing', code: 'file-missing' },
              { input: '../x.md', status: 'outside', code: 'file-outside-folders' },
            ],
          },
        }
      },
      show: () => {},
      quickLook: () => {},
      open: async () => '',
      inspect: async real => ({ real, file: true, symlink: false }),
      readHead: async () => ZIP,
      platform: 'darwin',
    })
    const paths = ['out/deck.pptx', 'missing.ts', 'src/app.ts:12', '../x.md', 'out/deck.pptx']
    const answer = await actions.knownFiles({ sessionId: SESSION, paths })
    expect(answer).toEqual({ status: 'ok', known: ['out/deck.pptx', 'src/app.ts:12'] })
    expect(JSON.stringify(answer)).not.toContain(HANDLE)
    expect(calls).toEqual([
      `POST /link/api/tasks/${SESSION}/files/resolve {"paths":["out/deck.pptx","missing.ts","src/app.ts:12","../x.md"]}`,
    ])
    for (const input of [
      { sessionId: SESSION, paths: [] },
      { sessionId: SESSION, paths: Array.from({ length: 65 }, (_, index) => `${index}.md`) },
      { sessionId: SESSION, paths: ['a.md', 42] },
      { sessionId: SESSION, paths: ['a\u0000b.md'] },
      { sessionId: SESSION, paths: 'a.md' },
      { sessionId: '../x', paths: ['a.md'] },
      { sessionId: SESSION, paths: ['a.md'], extra: true },
    ]) {
      expect(files.parseKnownInput(input), JSON.stringify(input)).toBeUndefined()
      expect(await actions.knownFiles(input)).toEqual({ status: 'failed', code: 'invalid' })
    }
    expect(calls).toHaveLength(1)
  })

  it('answers every file channel in main only for the main window’s own page', async () => {
    const source = await readFile(new URL('../src/main.cjs', import.meta.url), 'utf8')
    const channels = [...source.matchAll(/ipcMain\.handle\('(latch:files:[a-z]+)',([^\n]+)/gu)]
    expect(channels.map(match => match[1])).toEqual([
      'latch:files:inspect',
      'latch:files:known',
      'latch:files:reveal',
      'latch:files:quicklook',
      'latch:files:open',
    ])
    for (const match of channels) expect(match[2]).toMatch(/\(trusted\(event\) \? actions\.\w+\(input\) : refusedFolders\)/u)
  })
})

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise(done => setTimeout(done, 5))
  }
}
