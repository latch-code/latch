import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestHost } from './helpers/host.ts'

const require = createRequire(import.meta.url)

type Result = {
  status: string
  code?: string
  workspaceId?: string
  added?: Array<{ id: string; path: string; workspaceId: string }>
  refused?: Array<{ path: string; status: number; code: string; message?: string }>
}
interface FolderActions {
  pickFolders(input: unknown): Promise<Result>
  dropFolders(input: unknown): Promise<Result>
  revealFolder(input: unknown): Promise<Result>
  saveSessionFolder(input: unknown): Promise<Result>
}
interface DialogOptions {
  title?: string
  message?: string
  detail?: string
  buttonLabel?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  properties?: string[]
  defaultPath?: string
}
interface Gate {
  enter(): boolean
  leave(): void
}
type HostRequest = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>
interface ActionOptions {
  request: HostRequest
  sign(body: Record<string, unknown>): string
  pick(options: DialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>
  confirm(options: DialogOptions): Promise<{ response: number }>
  show(path: string): void
  inspect(path: string): Promise<{ real: string; directory: boolean }>
  home(): string
  focused(): boolean
  gate: Gate
  now?(): number
}

interface FoldersModule {
  FOLDER_LIMIT: number
  REVEAL_INTERVAL_MS: number
  isTrustedSender(event: unknown, mainContents: unknown): boolean
  parsePickInput(input: unknown): { projectId: string | null; replaceFolderId: string | null } | undefined
  parseDropInput(input: unknown): { projectId: string | null; paths: string[] } | { error: string }
  parseRevealInput(input: unknown): { projectId: string; folderId: string | null } | undefined
  parseSaveSessionInput(input: unknown): { sessionId: string } | undefined
  pickDialog(input: { defaultPath: string; project?: { name?: string }; replacing?: { name?: string } }): DialogOptions
  dropDialog(input: { paths: string[]; project?: { name?: string } }): DialogOptions
  saveSessionDialog(input: { path: string; title?: string }): DialogOptions
  createFolderActions(options: ActionOptions): FolderActions
}
const folders = require('../src/folders.cjs') as FoldersModule
const { createDialogGate, createExternalOpener, createShellProxy } = require('../src/proxy.cjs') as {
  createDialogGate(): Gate
  createExternalOpener(options: {
    confirm(options: DialogOptions): Promise<{ response: number }>
    open(url: string): Promise<unknown>
    gate?: Gate
  }): (url: string) => Promise<boolean>
  createShellProxy(options: { hostId: string; store: unknown; resolveSocket(): Promise<string>; log?(text: string): void }): {
    handle(request: Request): Promise<Response>
    shellRequest: HostRequest
  }
}
const credentials = require('../src/credentials.cjs') as {
  openCredentialStore(options: {
    directory: string
    hostId: string
    safeStorage: { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string }
  }): Promise<{ current(): { deviceId: string; credential: string } | undefined; signFolders(body: Record<string, unknown>): string }>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface FakeProject {
  id: string
  name: string
  path: string
  folders: Array<{ id: string; path: string }>
}

/**
 * A Host stand-in: lists `projects`, hands out nonces and adds any path except `refused` ones, recording what main
 * sent and signed. `answer` overrides the reply to a route.
 */
function fakeHost(projects: FakeProject[] = [], refused: string[] = []) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const answer = new Map<string, { status: number; json: unknown }>()
  let nonces = 0
  const request: HostRequest = async (method, path, body) => {
    requests.push({ method, path, ...(body === undefined ? {} : { body }) })
    const fixed = answer.get(`${method} ${path}`)
    if (fixed) return fixed
    if (method === 'GET' && path === '/link/api/workspaces') return { status: 200, json: { workspaces: projects } }
    if (method === 'POST' && path === '/link/api/folder-grants') return { status: 200, json: { nonce: `nonce-${++nonces}` } }
    const input = body as { paths: string[]; replace?: string }
    const accepted = input.paths.filter(item => !refused.includes(item))
    const refusals = input.paths
      .filter(item => refused.includes(item))
      .map(item => ({ path: item, code: 'workspace-code-root', message: '该目录与 Latch 程序目录重叠，不能作为项目' }))
    if (accepted.length === 0)
      return { status: 409, json: { error: 'workspace-folders-refused', message: '选择的文件夹都没有加入', refused: refusals } }
    const target = /^\/link\/api\/workspaces\/([^/]+)\/folders$/.exec(path)
    const project = target ? projects.find(item => item.id === decodeURIComponent(target[1]!)) : undefined
    const id = (item: string) => item.split('/').at(-1)!
    const next: Array<{ id: string; path: string }> = project
      ? input.replace
        ? project.folders.map(folder => (folder.id === input.replace ? { id: folder.id, path: accepted[0]! } : folder))
        : [...project.folders, ...accepted.map(item => ({ id: id(item), path: item }))]
      : accepted.map(item => ({ id: id(item), path: item }))
    const workspace = { id: project?.id ?? id(accepted[0]!), name: project?.name ?? id(accepted[0]!), path: next[0]!.path, folders: next }
    return { status: project ? 200 : 201, json: { workspace, refused: refusals } }
  }
  return { requests, answer, request }
}

function actions(overrides: Partial<ActionOptions> = {}, host = fakeHost()) {
  const shown: string[] = []
  const asked: DialogOptions[] = []
  const signed: Array<Record<string, unknown>> = []
  const gate = overrides.gate ?? createDialogGate()
  const created = folders.createFolderActions({
    request: host.request,
    sign: body => {
      signed.push(body)
      return `signature-of-${String(body.nonce)}`
    },
    pick: async options => {
      asked.push(options)
      return { canceled: false, filePaths: ['/Users/me/projects/app'] }
    },
    confirm: async options => {
      asked.push(options)
      return { response: 0 }
    },
    show: path => {
      shown.push(path)
    },
    inspect: async path => ({ real: path, directory: true }),
    home: () => '/Users/me',
    focused: () => true,
    gate,
    ...overrides,
  })
  return { created, host, shown, asked, signed, gate }
}

const NEW = { projectId: null, replaceFolderId: null }
const shop: FakeProject = {
  id: 'shop',
  name: 'Shop',
  path: '/Users/me/code/shop-api',
  folders: [{ id: 'shop-api', path: '/Users/me/code/shop-api' }],
}

describe('desktop shell folders: what main accepts', () => {
  it('answers only the main window’s own top-level page under latch://app/link/', () => {
    const contents = { id: 1 }
    const frame = { url: 'latch://app/link/', detached: false, parent: null }
    expect(folders.isTrustedSender({ sender: contents, senderFrame: frame }, contents)).toBe(true)
    expect(folders.isTrustedSender({ sender: contents, senderFrame: { ...frame, parent: {} } }, contents)).toBe(false)
    expect(folders.isTrustedSender({ sender: contents, senderFrame: { ...frame, detached: true } }, contents)).toBe(false)
    expect(folders.isTrustedSender({ sender: { id: 2 }, senderFrame: frame }, contents)).toBe(false)
    expect(folders.isTrustedSender({ sender: contents, senderFrame: { ...frame, url: 'https://example.com/link/' } }, contents)).toBe(false)
    expect(folders.isTrustedSender({ sender: contents, senderFrame: { ...frame, url: 'latch://app/other/' } }, contents)).toBe(false)
    expect(folders.isTrustedSender({ sender: contents, senderFrame: null }, contents)).toBe(false)
    expect(folders.isTrustedSender({ sender: contents, senderFrame: frame }, undefined)).toBe(false)
  })

  it('takes exactly the listed keys with IDs of the preload’s shape, nothing inherited and nothing more', () => {
    const inherited = Object.create({ projectId: null, replaceFolderId: null }) as object
    const polluted = JSON.parse('{"projectId":null,"replaceFolderId":null,"__proto__":{"x":1}}') as unknown
    expect(folders.parsePickInput(NEW)).toEqual(NEW)
    expect(folders.parsePickInput({ projectId: 'shop', replaceFolderId: 'shop-api' })).toEqual({
      projectId: 'shop',
      replaceFolderId: 'shop-api',
    })
    for (const input of [
      null,
      [],
      'shop',
      {},
      { projectId: null },
      { ...NEW, extra: true },
      { projectId: '../x', replaceFolderId: null },
      { projectId: 'shop', replaceFolderId: 'Shop_API' },
      { projectId: null, replaceFolderId: 'shop-api' },
      { projectId: 1, replaceFolderId: null },
      inherited,
      polluted,
      new (class Pick {
        projectId = null
        replaceFolderId = null
      })(),
    ])
      expect(folders.parsePickInput(input), JSON.stringify(input)).toBeUndefined()
    expect(folders.parseRevealInput({ projectId: 'website-2', folderId: null })).toEqual({ projectId: 'website-2', folderId: null })
    expect(folders.parseRevealInput({ projectId: 'default', folderId: 'default' })).toEqual({ projectId: 'default', folderId: 'default' })
    for (const input of [
      { projectId: '../x', folderId: null },
      { projectId: null, folderId: null },
      { projectId: 'a', folderId: '-x' },
      { projectId: 'a', folderId: null, more: 1 },
      { workspaceId: 'a' },
    ])
      expect(folders.parseRevealInput(input), JSON.stringify(input)).toBeUndefined()
  })

  it('takes 1–8 absolute dropped paths without repeats, and refuses unprintable ones before any dialog', () => {
    expect(folders.parseDropInput({ projectId: null, paths: ['/a', '/b', '/a'] })).toEqual({ projectId: null, paths: ['/a', '/b'] })
    expect(folders.parseDropInput({ projectId: 'shop', paths: ['/Users/me/文档/设计稿'] })).toEqual({
      projectId: 'shop',
      paths: ['/Users/me/文档/设计稿'],
    })
    for (const input of [
      null,
      { paths: ['/a'] },
      { projectId: null, paths: [] },
      { projectId: null, paths: '/a' },
      { projectId: null, paths: ['/a'], extra: true },
      { projectId: '../x', paths: ['/a'] },
      { projectId: null, paths: ['relative/path'] },
      { projectId: null, paths: ['/a\u0000b'] },
      { projectId: null, paths: [`/${'x'.repeat(4096)}`] },
      { projectId: null, paths: [42] },
      { projectId: null, paths: Array.from({ length: folders.FOLDER_LIMIT + 1 }, (_, index) => `/p${index}`) },
    ])
      expect(folders.parseDropInput(input), JSON.stringify(input)).toEqual({ error: 'invalid' })
    for (const path of ['/a\nb', '/a\u202egpj.app', '/a\u200bb', '/a\u2028b', '/a\u0085b', '/a\ufeffb'])
      expect(folders.parseDropInput({ projectId: null, paths: ['/ok', path] }), JSON.stringify(path)).toEqual({
        error: 'workspace-folder-unprintable',
      })
  })

  it('opens the panel for folders only, never into packages, hidden files or unresolved aliases, always at a set place', () => {
    const fresh = folders.pickDialog({ defaultPath: '/Users/me' })
    expect(fresh).toEqual({
      title: '添加项目',
      buttonLabel: '创建项目',
      message: '可以选择多个文件夹。之后可以在设置中更改主文件夹。',
      defaultPath: '/Users/me',
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    })
    expect(folders.pickDialog({ defaultPath: '/Users/me', project: { name: 'Shop' } })).toMatchObject({
      title: '添加文件夹到「Shop」',
      buttonLabel: '添加',
      message: '可以选择多个文件夹。Latch 内置可以读取其中的所有文件。连接的设备也可以在这个项目中发起会话。',
    })
    // A name the Host sent that a dialog could not show as it is stays out of the dialog.
    expect(folders.pickDialog({ defaultPath: '/', project: { name: 'Shop\u202e' } }).title).toBe('添加文件夹')
    const again = folders.pickDialog({ defaultPath: '/Users/me/code', replacing: { name: 'api' } })
    expect(again).toEqual({
      title: '重新选择「api」',
      buttonLabel: '选择',
      defaultPath: '/Users/me/code',
      properties: ['openDirectory', 'createDirectory'],
    })
    for (const options of [fresh, again])
      for (const property of ['treatPackageAsDirectory', 'showHiddenFiles', 'noResolveAliases', 'openFile'])
        expect(options.properties).not.toContain(property)
  })

  it('lists every dropped path in a confirmation whose default and Escape answer is 取消', () => {
    expect(folders.dropDialog({ paths: ['/Users/me/site', '/Users/me/docs'] })).toEqual({
      type: 'question',
      title: 'Latch',
      message: '用这些文件夹添加项目？',
      detail: '/Users/me/site\n/Users/me/docs\n\nLatch 内置可以读取其中的所有文件。连接的设备也可以在这个项目中发起会话。',
      buttons: ['添加项目', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    expect(folders.dropDialog({ paths: ['/x'], project: { name: 'Shop' } })).toMatchObject({
      message: '把这些文件夹加入「Shop」？',
      detail: '/x\n\nLatch 内置可以读取其中的所有文件。连接的设备也可以在这个项目中发起会话。',
      buttons: ['添加', '取消'],
      defaultId: 1,
      cancelId: 1,
    })
    expect(folders.dropDialog({ paths: ['/x'], project: { name: '\u200b' } }).message).toBe('把这些文件夹加入这个项目？')
  })

  it('takes one session ID for 存为项目 and shows its folder in a confirmation whose default answer is 取消', () => {
    const sessionId = 'task-0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(folders.parseSaveSessionInput({ sessionId })).toEqual({ sessionId })
    for (const input of [
      null,
      sessionId,
      {},
      { sessionId, path: '/Users/me' },
      Object.create({ sessionId }) as object,
      JSON.parse(`{"sessionId":"${sessionId}","__proto__":{"x":1}}`) as unknown,
      { sessionId: '' },
      { sessionId: '../task' },
      { sessionId: 'task/../x' },
      { sessionId: 'task x' },
      { sessionId: `t${'x'.repeat(256)}` },
      { sessionId: 42 },
    ])
      expect(folders.parseSaveSessionInput(input), JSON.stringify(input)).toBeUndefined()
    expect(folders.saveSessionDialog({ path: '/Users/me/Latch/workspace/20261025-ab12', title: '改版落地页' })).toEqual({
      type: 'question',
      title: 'Latch',
      message: '把「改版落地页」的文件夹存为项目？',
      detail:
        '/Users/me/Latch/workspace/20261025-ab12\n\n之后可以在这个项目中新建会话；这个会话本身不变。Latch 内置可以读取其中的所有文件。',
      buttons: ['存为项目', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    expect(folders.saveSessionDialog({ path: '/x', title: 'a\u202eb' }).message).toBe('把这个会话的文件夹存为项目？')
  })
})

describe('desktop shell folders: adding', () => {
  it('makes a new project of the folders chosen in the panel, with a fresh nonce and the signed body, and remembers where', async () => {
    const { created, host, asked, signed } = actions({
      pick: async options => {
        asked.push(options)
        return { canceled: false, filePaths: ['/Users/me/projects/app', '/Users/me/projects/web', '/Users/me/projects/app'] }
      },
    })
    expect(await created.pickFolders(NEW)).toEqual({
      status: 'added',
      workspaceId: 'app',
      added: [
        { id: 'app', path: '/Users/me/projects/app', workspaceId: 'app' },
        { id: 'web', path: '/Users/me/projects/web', workspaceId: 'app' },
      ],
      refused: [],
    })
    const body = { nonce: 'nonce-1', via: 'picker', paths: ['/Users/me/projects/app', '/Users/me/projects/web'] }
    expect(host.requests).toEqual([
      { method: 'POST', path: '/link/api/folder-grants', body: {} },
      { method: 'POST', path: '/link/api/workspaces', body: { ...body, signature: 'signature-of-nonce-1' } },
    ])
    expect(signed).toEqual([body])
    expect(asked[0]).toMatchObject({ title: '添加项目', defaultPath: '/Users/me' })
    await created.pickFolders(NEW)
    expect(asked[1]).toMatchObject({ defaultPath: '/Users/me/projects' })
  })

  it('adds to a project with the Host’s name and reach in the panel, reporting only the folders that joined', async () => {
    const host = fakeHost([shop], ['/Users/me/latch'])
    const { created, asked } = actions(
      {
        pick: async options => {
          asked.push(options)
          return { canceled: false, filePaths: ['/Users/me/docs/design', '/Users/me/latch'] }
        },
      },
      host,
    )
    expect(await created.pickFolders({ projectId: 'shop', replaceFolderId: null })).toEqual({
      status: 'added',
      workspaceId: 'shop',
      added: [{ id: 'design', path: '/Users/me/docs/design', workspaceId: 'shop' }],
      refused: [
        { path: '/Users/me/latch', status: 409, code: 'workspace-code-root', message: '该目录与 Latch 程序目录重叠，不能作为项目' },
      ],
    })
    expect(asked[0]).toMatchObject({
      title: '添加文件夹到「Shop」',
      message: '可以选择多个文件夹。Latch 内置可以读取其中的所有文件。连接的设备也可以在这个项目中发起会话。',
    })
    expect(host.requests.at(-1)).toMatchObject({ method: 'POST', path: '/link/api/workspaces/shop/folders', body: { via: 'picker' } })
  })

  it('re-selects one folder in place, opening the panel at the nearest folder that still exists', async () => {
    const project: FakeProject = {
      ...shop,
      folders: [...shop.folders, { id: 'api', path: '/Users/me/old/code/api' }],
    }
    const host = fakeHost([project])
    const { created, asked } = actions(
      {
        inspect: async path => {
          if (path.startsWith('/Users/me/old')) throw new Error('ENOENT')
          return { real: path, directory: true }
        },
        pick: async options => {
          asked.push(options)
          return { canceled: false, filePaths: ['/Users/me/new/api'] }
        },
      },
      host,
    )
    expect(await created.pickFolders({ projectId: 'shop', replaceFolderId: 'api' })).toEqual({
      status: 'added',
      workspaceId: 'shop',
      added: [{ id: 'api', path: '/Users/me/new/api', workspaceId: 'shop' }],
      refused: [],
    })
    expect(asked[0]).toEqual({
      title: '重新选择「api」',
      buttonLabel: '选择',
      defaultPath: '/Users/me',
      properties: ['openDirectory', 'createDirectory'],
    })
    expect(host.requests.at(-1)?.body).toMatchObject({ via: 'picker', paths: ['/Users/me/new/api'], replace: 'api' })
    expect(await created.pickFolders({ projectId: 'shop', replaceFolderId: 'gone' })).toEqual({ status: 'failed', code: 'not-found' })
  })

  it('opens nothing for the start directory, an unknown project or a window without focus', async () => {
    const host = fakeHost([shop])
    let focused = false
    const { created, asked } = actions({ focused: () => focused }, host)
    expect(await created.pickFolders(NEW)).toEqual({ status: 'failed', code: 'not-focused' })
    expect(await created.dropFolders({ projectId: null, paths: ['/a'] })).toEqual({ status: 'failed', code: 'not-focused' })
    focused = true
    expect(await created.pickFolders({ projectId: 'default', replaceFolderId: null })).toEqual({
      status: 'failed',
      code: 'workspace-default',
    })
    expect(await created.dropFolders({ projectId: 'default', paths: ['/a'] })).toEqual({ status: 'failed', code: 'workspace-default' })
    expect(await created.pickFolders({ projectId: 'other', replaceFolderId: null })).toEqual({ status: 'failed', code: 'not-found' })
    expect(await created.pickFolders({ projectId: 'x', extra: 1 })).toEqual({ status: 'failed', code: 'invalid' })
    expect(asked).toEqual([])
    expect(host.requests.filter(item => item.method === 'POST')).toEqual([])
  })

  it('keeps one native dialog at a time, shared with the external-link confirmation', async () => {
    let close: ((value: { canceled: boolean; filePaths: string[] }) => void) | undefined
    let hold = true
    const { created, host, gate } = actions({
      pick: () => (hold ? new Promise(done => (close = done)) : Promise.resolve({ canceled: true, filePaths: [] })),
    })
    const linkAsked: DialogOptions[] = []
    const openExternal = createExternalOpener({
      confirm: async options => {
        linkAsked.push(options)
        return { response: 1 }
      },
      open: async () => {},
      gate,
    })
    const first = created.pickFolders(NEW)
    await vi.waitFor(() => expect(close).toBeDefined())
    expect(await created.pickFolders(NEW)).toEqual({ status: 'busy' })
    expect(await created.dropFolders({ projectId: null, paths: ['/a'] })).toEqual({ status: 'busy' })
    expect(await openExternal('https://example.com/')).toBe(false)
    expect(linkAsked).toEqual([])
    hold = false
    close?.({ canceled: true, filePaths: [] })
    expect(await first).toEqual({ status: 'canceled' })
    expect(host.requests).toEqual([])
    // A link confirmation holds the same gate.
    let answer: ((value: { response: number }) => void) | undefined
    const linkOpener = createExternalOpener({ confirm: () => new Promise(done => (answer = done)), open: async () => {}, gate })
    const link = linkOpener('https://example.com/')
    expect(await created.pickFolders(NEW)).toEqual({ status: 'busy' })
    answer?.({ response: 1 })
    expect(await link).toBe(false)
    expect((await created.pickFolders(NEW)).status).toBe('canceled')
  })

  it('refuses more than eight chosen folders, and unprintable ones itself while sending the rest', async () => {
    const many = Array.from({ length: folders.FOLDER_LIMIT + 1 }, (_, index) => `/Users/me/p${index}`)
    let chosen = many
    const { created, host } = actions({ pick: async () => ({ canceled: false, filePaths: chosen }) })
    expect(await created.pickFolders(NEW)).toEqual({ status: 'failed', code: 'workspace-folder-limit' })
    chosen = ['/Users/me/a\u202eb', '/Users/me/site']
    expect(await created.pickFolders(NEW)).toMatchObject({
      status: 'added',
      added: [{ path: '/Users/me/site' }],
      refused: [{ path: '/Users/me/a\u202eb', status: 400, code: 'workspace-folder-unprintable' }],
    })
    expect(host.requests.at(-1)?.body).toMatchObject({ paths: ['/Users/me/site'] })
    chosen = ['/Users/me/x\u0007']
    const before = host.requests.length
    expect(await created.pickFolders(NEW)).toMatchObject({
      status: 'added',
      added: [],
      refused: [{ code: 'workspace-folder-unprintable' }],
    })
    expect(host.requests).toHaveLength(before)
  })

  it('adds dropped folders only after the confirmation, and reports the folders the Host refused', async () => {
    const host = fakeHost([shop], ['/Users/me/latch'])
    let answer = 1
    const { created, asked } = actions(
      {
        confirm: async options => {
          asked.push(options)
          return { response: answer }
        },
      },
      host,
    )
    expect(await created.dropFolders({ projectId: null, paths: ['/Users/me/site', '/Users/me/latch'] })).toEqual({ status: 'canceled' })
    expect(host.requests).toEqual([])
    expect(asked[0]).toMatchObject({ message: '用这些文件夹添加项目？', buttons: ['添加项目', '取消'], defaultId: 1, cancelId: 1 })
    expect(asked[0]?.detail).toContain('/Users/me/site\n/Users/me/latch\n\n')
    answer = 0
    expect(await created.dropFolders({ projectId: null, paths: ['/Users/me/site', '/Users/me/latch'] })).toEqual({
      status: 'added',
      workspaceId: 'site',
      added: [{ id: 'site', path: '/Users/me/site', workspaceId: 'site' }],
      refused: [
        { path: '/Users/me/latch', status: 409, code: 'workspace-code-root', message: '该目录与 Latch 程序目录重叠，不能作为项目' },
      ],
    })
    expect(host.requests.at(-1)).toMatchObject({
      path: '/link/api/workspaces',
      body: { via: 'drop', paths: ['/Users/me/site', '/Users/me/latch'] },
    })
    // Every path refused: the Host's per-path reasons, nothing added.
    expect(await created.dropFolders({ projectId: 'shop', paths: ['/Users/me/latch'] })).toEqual({
      status: 'added',
      workspaceId: 'shop',
      added: [],
      refused: [
        { path: '/Users/me/latch', status: 409, code: 'workspace-code-root', message: '该目录与 Latch 程序目录重叠，不能作为项目' },
      ],
    })
    expect(asked.at(-1)).toMatchObject({ message: '把这些文件夹加入「Shop」？', buttons: ['添加', '取消'] })
    const count = asked.length
    expect(await created.dropFolders({ projectId: null, paths: ['/Users/me/a\nb'] })).toEqual({
      status: 'failed',
      code: 'workspace-folder-unprintable',
    })
    expect(await created.dropFolders({ projectId: null, paths: ['relative'] })).toEqual({ status: 'failed', code: 'invalid' })
    expect(asked).toHaveLength(count)
  })

  it('says the Host is outdated when it has no folder grants, and passes other Host refusals on as codes', async () => {
    const host = fakeHost()
    const { created } = actions({}, host)
    host.answer.set('POST /link/api/folder-grants', { status: 404, json: { error: 'not-found', message: '接口不存在' } })
    expect(await created.pickFolders(NEW)).toEqual({ status: 'failed', code: 'host-outdated' })
    host.answer.set('POST /link/api/folder-grants', { status: 403, json: { error: 'local-only', message: '此操作只能在执行端电脑上进行' } })
    expect(await created.pickFolders(NEW)).toEqual({ status: 'failed', code: 'local-only' })
    host.answer.delete('POST /link/api/folder-grants')
    host.answer.set('POST /link/api/workspaces', { status: 403, json: { error: 'folder-grant-invalid', message: 'x' } })
    expect(await created.pickFolders(NEW)).toEqual({ status: 'failed', code: 'folder-grant-invalid' })
    const { created: broken } = actions({
      pick: async () => {
        throw new Error('/private/secret/path')
      },
    })
    expect(await broken.pickFolders(NEW)).toEqual({ status: 'failed', code: 'shell-failed' })
  })

  it('saves a session’s own folder as a project only after the confirmation, with the folder the Host reports', async () => {
    const sessionId = 'task-1'
    const cwd = '/Users/me/Latch/workspace/20261025-ab12'
    const host = fakeHost()
    host.answer.set(`GET /link/api/tasks/${sessionId}`, {
      status: 200,
      json: { summary: { id: sessionId, title: '改版落地页', cwd, workspaceId: 'default', sessionFolder: true }, messages: [] },
    })
    const workspace = { id: '20261025-ab12', name: '改版落地页', path: cwd, folders: [{ id: '20261025-ab12', path: cwd }] }
    host.answer.set('POST /link/api/workspaces', { status: 201, json: { workspace, refused: [] } })
    let response = 1
    const { created, asked, signed } = actions(
      {
        confirm: async options => {
          asked.push(options)
          return { response }
        },
      },
      host,
    )
    expect(await created.saveSessionFolder({ sessionId })).toEqual({ status: 'canceled' })
    expect(asked.map(options => options.detail?.split('\n')[0])).toEqual([cwd])
    expect(host.requests.filter(item => item.method === 'POST')).toEqual([])
    response = 0
    expect(await created.saveSessionFolder({ sessionId })).toEqual({
      status: 'added',
      workspaceId: '20261025-ab12',
      added: [{ id: '20261025-ab12', path: cwd, workspaceId: '20261025-ab12' }],
      refused: [],
    })
    // The page names the session; main signs exactly that, with a nonce of its own, and sends no path.
    expect(signed).toEqual([{ nonce: 'nonce-1', via: 'session', sessionId }])
    expect(host.requests.filter(item => item.method === 'POST').map(item => [item.path, item.body])).toEqual([
      ['/link/api/folder-grants', {}],
      ['/link/api/workspaces', { nonce: 'nonce-1', via: 'session', sessionId, signature: 'signature-of-nonce-1' }],
    ])

    host.answer.set('POST /link/api/workspaces', {
      status: 409,
      json: { error: 'workspace-folders-refused', refused: [{ path: cwd, code: 'workspace-exists', message: '已是项目' }] },
    })
    expect(await created.saveSessionFolder({ sessionId })).toEqual({
      status: 'added',
      added: [],
      refused: [{ path: cwd, status: 409, code: 'workspace-exists', message: '已是项目' }],
    })
  })

  it('opens no confirmation for a session without its own folder, an unknown one or a window without focus', async () => {
    const host = fakeHost()
    let focused = true
    const { created, asked } = actions({ focused: () => focused }, host)
    const summary = { id: 'task-1', title: 'x', cwd: '/Users/me/Latch/workspace/20261025-ab12', workspaceId: 'default' }
    for (const [reported, code] of [
      [{ ...summary }, 'session-folder-none'],
      [{ ...summary, sessionFolder: true, workspaceId: 'shop' }, 'session-folder-none'],
      [{ ...summary, sessionFolder: true, cwd: 'relative' }, 'invalid'],
      [{ ...summary, sessionFolder: true, cwd: '/Users/me/a\u202eb' }, 'invalid'],
    ] as const) {
      host.answer.set('GET /link/api/tasks/task-1', { status: 200, json: { summary: reported } })
      expect(await created.saveSessionFolder({ sessionId: 'task-1' }), JSON.stringify(reported)).toEqual({ status: 'failed', code })
    }
    host.answer.set('GET /link/api/tasks/task-2', { status: 404, json: { error: 'task-not-found', message: '找不到该任务' } })
    expect(await created.saveSessionFolder({ sessionId: 'task-2' })).toEqual({ status: 'failed', code: 'task-not-found' })
    expect(await created.saveSessionFolder({ sessionId: '../x' })).toEqual({ status: 'failed', code: 'invalid' })
    focused = false
    expect(await created.saveSessionFolder({ sessionId: 'task-1' })).toEqual({ status: 'failed', code: 'not-focused' })
    expect(asked).toEqual([])
    expect(host.requests.filter(item => item.method === 'POST')).toEqual([])
  })
})

describe('desktop shell folders: showing in Finder', () => {
  it('shows only a folder the Host registered, by its real path, one at a time and at most twice a second', async () => {
    let now = 0
    const project: FakeProject = {
      ...shop,
      folders: [
        { id: 'shop-api', path: '/Users/me/code/shop-api' },
        { id: 'gone', path: '/Users/me/gone' },
        { id: 'file', path: '/Users/me/notes.txt' },
        { id: 'odd', path: 'relative/path' },
      ],
    }
    const host = fakeHost([
      project,
      {
        id: 'default',
        name: '默认文件夹',
        path: '/Users/me/Latch/workspace',
        folders: [{ id: 'default', path: '/Users/me/Latch/workspace' }],
      },
    ])
    const { created, shown } = actions(
      {
        inspect: async path => {
          if (path === '/Users/me/gone') throw new Error('ENOENT')
          return { real: `/private${path}`, directory: path !== '/Users/me/notes.txt' }
        },
        now: () => now,
      },
      host,
    )
    const reveal = async (input: unknown) => {
      now += folders.REVEAL_INTERVAL_MS
      return created.revealFolder(input)
    }
    expect(await reveal({ projectId: 'shop', folderId: null })).toEqual({ status: 'shown' })
    expect(await created.revealFolder({ projectId: 'shop', folderId: null })).toEqual({ status: 'busy' })
    expect(await reveal({ projectId: 'default', folderId: 'default' })).toEqual({ status: 'shown' })
    expect(await reveal({ projectId: 'shop', folderId: 'gone' })).toEqual({ status: 'failed', code: 'missing' })
    expect(await reveal({ projectId: 'shop', folderId: 'file' })).toEqual({ status: 'failed', code: 'missing' })
    expect(await reveal({ projectId: 'shop', folderId: 'odd' })).toEqual({ status: 'failed', code: 'invalid' })
    expect(await reveal({ projectId: 'shop', folderId: 'other' })).toEqual({ status: 'failed', code: 'not-found' })
    expect(await reveal({ projectId: 'other', folderId: null })).toEqual({ status: 'failed', code: 'not-found' })
    expect(await reveal({ projectId: '../shop', folderId: null })).toEqual({ status: 'failed', code: 'invalid' })
    expect(shown).toEqual(['/private/Users/me/code/shop-api', '/private/Users/me/Latch/workspace'])
    expect(host.requests.every(item => item.method === 'GET')).toBe(true)
  })

  it('shows the primary folder of a project from a Host that lists only its path', async () => {
    const host = fakeHost()
    host.answer.set('GET /link/api/workspaces', {
      status: 200,
      json: { workspaces: [{ id: 'site', name: 'site', path: '/Users/me/site' }] },
    })
    const { created, shown } = actions({}, host)
    expect(await created.revealFolder({ projectId: 'site', folderId: null })).toEqual({ status: 'shown' })
    expect(shown).toEqual(['/Users/me/site'])
  })
})

/** Reversible stand-in for Electron's safeStorage. */
function fakeSafeStorage() {
  const mask = (data: Buffer) => Buffer.from(data.map(byte => byte ^ 0x5a))
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.concat([Buffer.from('fake1'), mask(Buffer.from(text, 'utf8'))]),
    decryptString: (data: Buffer) => mask(data.subarray(5)).toString('utf8'),
  }
}

async function directory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

describe('desktop shell folders against the Host', () => {
  it('adds folders the Host accepts only with main’s nonce and signature, and never from the renderer', async () => {
    const testHost = await startTestHost()
    cleanups.push(() => testHost.close())
    const { host } = testHost
    const store = await credentials.openCredentialStore({
      directory: join(await directory('latch-shell-'), 'latch-devices'),
      hostId: host.hostId,
      safeStorage: fakeSafeStorage(),
    })
    const proxy = createShellProxy({ hostId: host.hostId, store, log: () => {}, resolveSocket: async () => host.socketPath })
    const renderer = (path: string, init: RequestInit = {}) => proxy.handle(new Request(`latch://app${path}`, init))

    // The shell enrolls over host.sock; the test presence approves it.
    const created = await renderer('/link/api/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '桌面端' }),
    })
    const { enrollment } = (await created.json()) as { enrollment: { id: string } }
    await vi.waitFor(async () => {
      const status = await renderer(`/link/api/enrollments/${enrollment.id}`)
      expect(((await status.json()) as { enrollment: { status: string } }).enrollment.status).toBe('approved')
    })
    expect((await renderer(`/link/api/enrollments/${enrollment.id}/complete`, { method: 'POST', body: '{}' })).status).toBe(200)
    const deviceId = store.current()!.deviceId

    const root = await realpath(await directory('latch-projects-'))
    const [api, docs, more] = [join(root, 'api'), join(root, 'docs'), join(root, 'more')]
    for (const path of [api, docs, more]) await mkdir(path)
    let chosen = [api, docs]
    const shown: string[] = []
    const actionsOf = folders.createFolderActions({
      request: (method, path, body) => proxy.shellRequest(method, path, body),
      sign: body => store.signFolders(body),
      pick: async () => ({ canceled: false, filePaths: chosen }),
      confirm: async () => ({ response: 0 }),
      show: path => {
        shown.push(path)
      },
      async inspect(path) {
        const real = await realpath(path)
        return { real, directory: (await stat(real)).isDirectory() }
      },
      home: () => root,
      focused: () => true,
      gate: createDialogGate(),
    })

    const result = await actionsOf.pickFolders(NEW)
    expect(result).toMatchObject({ status: 'added', workspaceId: 'api', refused: [] })
    expect(result.added?.map(folder => folder.path)).toEqual([api, docs])
    expect(host.security.audit.lastOf('workspace.added')).toMatchObject({
      target: 'api',
      actor: { deviceId, listener: 'unix' },
      detail: { via: 'picker', folderCount: 2 },
    })

    chosen = [more]
    expect(await actionsOf.dropFolders({ projectId: 'api', paths: [more, join(root, 'missing')] })).toMatchObject({
      status: 'added',
      workspaceId: 'api',
      added: [{ id: 'more', path: more }],
      refused: [{ path: join(root, 'missing'), code: 'workspace-invalid' }],
    })
    expect(host.security.audit.lastOf('workspace.folder-added')).toMatchObject({
      detail: { workspaceId: 'api', folderId: 'more', via: 'drop' },
    })

    expect(await actionsOf.revealFolder({ projectId: 'api', folderId: 'docs' })).toEqual({ status: 'shown' })
    expect(shown).toEqual([docs])

    // The page cannot reach the add routes, however it spells them; the Host never sees those requests.
    const before = host.security.audit.lastOf('workspace.added')
    for (const path of ['/link/api/workspaces', '/link/api/Workspaces/', '/link//api/workspaces', '/link/api/%77orkspaces'])
      expect((await renderer(path, { method: 'POST', body: JSON.stringify({ path: more }) })).status, path).toBe(403)
    for (const path of ['/link/api/folder-grants', '/link/api/workspaces/api/folders', '/link/api/workspaces/api%2Ffolders'])
      expect(await (await renderer(path, { method: 'POST', body: '{}' })).json(), path).toEqual({
        error: 'shell-managed',
        message: '添加文件夹由 Latch 桌面端处理',
      })
    expect(host.security.audit.lastOf('workspace.added')).toEqual(before)
    // A signature from another key is refused by the Host, and the nonce is spent.
    const grant = await proxy.shellRequest('POST', '/link/api/folder-grants', {})
    const nonce = (grant.json as { nonce: string }).nonce
    const forged = await proxy.shellRequest('POST', '/link/api/workspaces', {
      nonce,
      via: 'picker',
      paths: [more],
      signature: 'A'.repeat(86),
    })
    expect(forged).toMatchObject({ status: 403, json: { error: 'folder-grant-invalid' } })
    const listed = await renderer('/link/api/workspaces')
    expect(listed.status).toBe(200)
  })

  it('saves the folder the Host made for a session as a project, and never from the renderer', async () => {
    const testHost = await startTestHost({ sessionFolders: true })
    cleanups.push(() => testHost.close())
    const { host } = testHost
    const store = await credentials.openCredentialStore({
      directory: join(await directory('latch-shell-'), 'latch-devices'),
      hostId: host.hostId,
      safeStorage: fakeSafeStorage(),
    })
    const proxy = createShellProxy({ hostId: host.hostId, store, log: () => {}, resolveSocket: async () => host.socketPath })
    const renderer = (path: string, init: RequestInit = {}) => proxy.handle(new Request(`latch://app${path}`, init))
    const created = await renderer('/link/api/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '桌面端' }),
    })
    const { enrollment } = (await created.json()) as { enrollment: { id: string } }
    await vi.waitFor(async () => {
      const status = await renderer(`/link/api/enrollments/${enrollment.id}`)
      expect(((await status.json()) as { enrollment: { status: string } }).enrollment.status).toBe('approved')
    })
    expect((await renderer(`/link/api/enrollments/${enrollment.id}/complete`, { method: 'POST', body: '{}' })).status).toBe(200)

    const started = await proxy.shellRequest('POST', '/link/api/tasks', {
      prompt: '改版落地页',
      requestId: crypto.randomUUID(),
      mode: 'agent',
    })
    expect(started.status).toBe(201)
    const { sessionId } = started.json as { sessionId: string }
    await vi.waitFor(async () => expect((await host.bridge.detail(sessionId)).summary.status).toBe('idle'), { timeout: 10_000 })
    const cwd = (await host.bridge.detail(sessionId)).summary.cwd!
    const asked: DialogOptions[] = []
    const actionsOf = folders.createFolderActions({
      request: (method, path, body) => proxy.shellRequest(method, path, body),
      sign: body => store.signFolders(body),
      pick: async () => ({ canceled: true, filePaths: [] }),
      confirm: async options => {
        asked.push(options)
        return { response: 0 }
      },
      show: () => {},
      inspect: async path => ({ real: path, directory: true }),
      home: () => tmpdir(),
      focused: () => true,
      gate: createDialogGate(),
    })
    // The page cannot ask the Host itself: the route is main's, however it is spelled.
    for (const path of ['/link/api/workspaces', '/link/api/WORKSPACES'])
      expect(
        await (await renderer(path, { method: 'POST', body: JSON.stringify({ nonce: 'x', via: 'session', sessionId }) })).json(),
      ).toMatchObject({ error: 'shell-managed' })
    const real = await realpath(cwd)
    const id = cwd.split('/').at(-1)!
    expect(await actionsOf.saveSessionFolder({ sessionId })).toEqual({
      status: 'added',
      workspaceId: id,
      added: [{ id, path: real, workspaceId: id }],
      refused: [],
    })
    expect(asked.map(options => options.message)).toEqual(['把「改版落地页」的文件夹存为项目？'])
    expect(host.security.audit.lastOf('workspace.added')).toMatchObject({
      target: id,
      actor: { deviceId: store.current()!.deviceId, listener: 'unix' },
      detail: { via: 'session', folderCount: 1 },
    })
    expect(host.config.settings().workspaces.map(record => [record.id, record.name, record.path])).toEqual([[id, '改版落地页', real]])
  })
})
