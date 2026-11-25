import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '@latch/protocol'
import type { ToolDefinition } from '@latch/sdk'
import { createWorkspacePlugin } from '../src/plugins/tools/workspace-files/index.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-files-'))
  dirs.push(root)
  return root
}

async function mount(options?: Parameters<typeof createWorkspacePlugin>[0]): Promise<Map<string, ToolDefinition>> {
  const tools = new Map<string, ToolDefinition>()
  await createWorkspacePlugin(options).activate({
    registerTool: t => {
      tools.set(t.name, t)
    },
    registerProvider: () => {},
    registerHarness: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {},
    onDispose: () => {},
  })
  return tools
}

function contextFor(root: string) {
  return { sessionId: 'test', callId: 'test', workspaceRoot: root, signal: new AbortController().signal }
}

it('writes and reads real files and rejects paths escaping the workspace', async () => {
  const root = await directory()
  const tools = await mount()
  const context = contextFor(root)
  expect(tools.get('write_file')!.requiresApproval).toBe(true)
  await tools.get('write_file')!.execute({ path: 'notes/result.txt', content: 'hello' }, context)
  expect(await readFile(join(root, 'notes/result.txt'), 'utf8')).toBe('hello')
  expect(await tools.get('read_file')!.execute({ path: 'notes/result.txt' }, context)).toEqual({ text: 'hello' })
  expect(await readdir(join(root, 'notes'))).toEqual(['result.txt'])
  if (process.platform !== 'win32') expect((await stat(join(root, 'notes/result.txt'))).mode & 0o777).toBe(0o600)
  await tools.get('write_file')!.execute({ path: 'notes/result.txt', content: 'replaced' }, context)
  expect(await tools.get('read_file')!.execute({ path: 'notes/result.txt' }, context)).toEqual({ text: 'replaced' })
  await expect(tools.get('read_file')!.execute({ path: '../outside.txt' }, context)).rejects.toThrow('超出')
  await symlink(tmpdir(), join(root, 'outside'))
  await expect(tools.get('write_file')!.execute({ path: 'outside/evil.txt', content: 'bad' }, context)).rejects.toThrow('符号链接')
})

it('labels tool kinds and previews a write as a diff against the current file', async () => {
  const root = await directory()
  const tools = await mount()
  expect([...tools.values()].map(tool => [tool.name, tool.kind])).toEqual([
    ['list_folders', 'search'],
    ['list_files', 'search'],
    ['read_file', 'read'],
    ['write_file', 'edit'],
  ])
  const write = tools.get('write_file')!
  const preview = (path: string, content: string) =>
    write.preview!({ path, content }, { workspaceRoot: root, signal: new AbortController().signal })
  await writeFile(join(root, 'existing.txt'), 'before')
  expect(await preview('existing.txt', 'after')).toEqual({
    title: '写入 existing.txt',
    diffs: [{ path: 'existing.txt', oldText: 'before', newText: 'after', previous: 'text' }],
  })
  expect(await preview('new/file.txt', 'fresh')).toEqual({
    title: '写入 new/file.txt',
    diffs: [{ path: 'new/file.txt', newText: 'fresh', previous: 'none' }],
  })
  await writeFile(join(root, 'large.txt'), 'x'.repeat(131073))
  expect((await preview('large.txt', 'small')).diffs).toEqual([{ path: 'large.txt', newText: 'small', previous: 'unavailable' }])
  await expect(access(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(preview('../escape.txt', 'x')).rejects.toThrow('超出')
  await expect(write.preview!({ path: 'a.txt' }, { workspaceRoot: root, signal: new AbortController().signal })).rejects.toThrow()
})

it('denies every tool access to protected paths, including when the workspace contains them', async () => {
  const root = await directory()
  const dataDir = join(root, '.runtime')
  await mkdir(join(dataDir, 'auth'), { recursive: true })
  await writeFile(join(dataDir, 'auth', 'owner-token'), 'secret')
  await writeFile(join(root, 'visible.txt'), 'ok')
  const tools = await mount({ protectedPaths: [dataDir] })
  const context = contextFor(root)
  const denied = '私有数据目录'
  await expect(tools.get('read_file')!.execute({ path: '.runtime/auth/owner-token' }, context)).rejects.toThrow(denied)
  await expect(tools.get('read_file')!.execute({ path: 'sub/../.runtime/auth/owner-token' }, context)).rejects.toThrow(denied)
  await expect(tools.get('list_files')!.execute({ path: '.runtime' }, context)).rejects.toThrow(denied)
  await expect(tools.get('write_file')!.execute({ path: '.runtime/auth/owner-token', content: 'replaced' }, context)).rejects.toThrow(
    denied,
  )
  await expect(tools.get('write_file')!.execute({ path: '.runtime/new/file.txt', content: 'planted' }, context)).rejects.toThrow(denied)
  await expect(tools.get('write_file')!.preview!({ path: '.runtime/auth/owner-token', content: 'x' }, context)).rejects.toThrow(denied)
  expect(await readFile(join(dataDir, 'auth', 'owner-token'), 'utf8')).toBe('secret')
  await expect(access(join(dataDir, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
  const listing = (await tools.get('list_files')!.execute({ path: '.' }, context)).text.split('\n').sort()
  expect(listing).toEqual(['file\tvisible.txt', 'protected (not accessible)\t.runtime'])
  expect(await tools.get('read_file')!.execute({ path: 'visible.txt' }, context)).toEqual({ text: 'ok' })

  // On a case-insensitive file system another spelling names the same directory.
  const caseInsensitive = await access(join(root, '.RUNTIME')).then(
    () => true,
    () => false,
  )
  if (caseInsensitive) await expect(tools.get('read_file')!.execute({ path: '.RUNTIME/auth/owner-token' }, context)).rejects.toThrow(denied)

  const nested = contextFor(join(dataDir, 'auth'))
  await expect(tools.get('list_files')!.execute({ path: '.' }, nested)).rejects.toThrow(denied)
  expect(() => createWorkspacePlugin({ protectedPaths: ['relative/data'] })).toThrow('absolute')
})

it('allows only the verified session to work in its managed home under a protected ancestor', async () => {
  const latch = join(await realpath(await directory()), '.latch')
  const general = join(latch, 'agent-homes', 'general')
  const host = join(latch, 'host')
  await mkdir(general, { recursive: true })
  await mkdir(host)
  await writeFile(join(general, 'draft.txt'), 'old')
  await writeFile(join(host, 'secret.txt'), 'private')
  await symlink(host, join(general, 'other'))
  const tools = await mount({
    protectedPaths: [latch, host],
    managedHome: { protectedAncestor: latch, permits: async (sessionId, root) => sessionId === 'test' && root === general },
  })
  const read = tools.get('read_file')!
  const write = tools.get('write_file')!
  const context = contextFor(general)
  const input = { path: 'draft.txt', content: 'new' }
  expect((await write.preview!(input, context)).diffs).toEqual([{ path: 'draft.txt', oldText: 'old', newText: 'new', previous: 'text' }])
  await write.execute(input, context)
  expect(await read.execute({ path: 'draft.txt' }, context)).toEqual({ text: 'new' })
  await expect(read.execute({ path: 'draft.txt' }, { ...context, sessionId: 'other' })).rejects.toThrow('私有数据目录')
  await expect(read.execute({ path: 'secret.txt' }, contextFor(host))).rejects.toThrow('私有数据目录')
  await expect(read.execute({ path: 'other/secret.txt' }, context)).rejects.toThrow('符号链接')
  await expect(read.execute({ path: '../../host/secret.txt' }, context)).rejects.toThrow('超出')
})

describe('a session of several folders', () => {
  async function project() {
    const parent = await directory()
    const app = join(parent, 'app')
    const web = join(parent, 'web')
    await mkdir(app)
    await mkdir(web)
    const folders = [
      { id: 'app', path: app, primary: true },
      { id: 'web', path: web, primary: false },
    ]
    const context = {
      sessionId: 'test',
      callId: 'test',
      workspaceRoot: app,
      workspaceFolders: folders,
      signal: new AbortController().signal,
    }
    return { parent, app, web, folders, context }
  }

  it('lists the folders by ID and directory name, never by absolute path', async () => {
    const { parent, context } = await project()
    const tools = await mount()
    const { text } = await tools.get('list_folders')!.execute({}, context)
    expect(JSON.parse(text)).toEqual([
      { folder: 'app', name: 'app', primary: true },
      { folder: 'web', name: 'web', primary: false },
    ])
    expect(text).not.toContain(parent)
    expect(text).not.toContain('/')
    await expect(tools.get('list_folders')!.execute({ folder: 'web' }, context)).rejects.toThrow()
    // A driver that passes no folders has one: the working directory.
    expect(JSON.parse((await tools.get('list_folders')!.execute({}, contextFor(context.workspaceRoot))).text)).toEqual([
      { folder: 'default', name: 'app', primary: true },
    ])
    for (const tool of ['list_files', 'read_file', 'write_file']) expect(tools.get(tool)!.description).toContain('list_folders')
  })

  it('works in the folder the folder argument names, and in the primary folder without one', async () => {
    const { app, web, context } = await project()
    const tools = await mount()
    expect(await tools.get('write_file')!.execute({ path: 'index.html', content: 'web page', folder: 'web' }, context)).toEqual({
      text: '已写入「web」中的 index.html（8 字节）',
      textWithoutFiles: '已写入「web」中的 index.html（8 字节）',
    })
    expect(await readFile(join(web, 'index.html'), 'utf8')).toBe('web page')
    await tools.get('write_file')!.execute({ path: 'main.ts', content: 'app code' }, context)
    expect(await readFile(join(app, 'main.ts'), 'utf8')).toBe('app code')
    await expect(access(join(web, 'main.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await tools.get('read_file')!.execute({ path: 'index.html', folder: 'web' }, context)).toEqual({ text: 'web page' })
    expect(await tools.get('read_file')!.execute({ path: 'main.ts', folder: 'app' }, context)).toEqual({ text: 'app code' })
    expect((await tools.get('list_files')!.execute({ path: '.', folder: 'web' }, context)).text).toBe('file	index.html')
    const preview = await tools.get('write_file')!.preview!(
      { path: 'index.html', content: 'new page', folder: 'web' },
      { workspaceRoot: app, workspaceFolders: context.workspaceFolders, signal: context.signal },
    )
    expect(preview).toEqual({
      title: '写入「web」中的 index.html',
      diffs: [{ path: 'index.html', oldText: 'web page', newText: 'new page', previous: 'text' }],
    })
  })

  it('refuses a folder outside the session and paths escaping the targeted folder', async () => {
    const { app, web, context } = await project()
    await writeFile(join(app, 'secret.txt'), 'app only')
    const tools = await mount()
    for (const folder of ['unknown', 'APP', 'default'])
      await expect(tools.get('read_file')!.execute({ path: 'secret.txt', folder }, context)).rejects.toThrow('list_folders')
    await expect(tools.get('read_file')!.execute({ path: '../app/secret.txt', folder: 'web' }, context)).rejects.toThrow('超出')
    await expect(tools.get('read_file')!.execute({ path: join(app, 'secret.txt'), folder: 'web' }, context)).rejects.toThrow('相对路径')
    await expect(tools.get('write_file')!.execute({ path: '../app/planted.txt', content: 'x', folder: 'web' }, context)).rejects.toThrow(
      '超出',
    )
    await expect(tools.get('read_file')!.execute({ path: 'secret.txt', folder: 7 }, context)).rejects.toThrow()
    await symlink(app, join(web, 'to-app'))
    await expect(tools.get('read_file')!.execute({ path: 'to-app/secret.txt', folder: 'web' }, context)).rejects.toThrow('符号链接')
    await expect(tools.get('write_file')!.execute({ path: 'to-app/planted.txt', content: 'x', folder: 'web' }, context)).rejects.toThrow(
      '符号链接',
    )
    await expect(access(join(app, 'planted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('denies protected paths inside any folder', async () => {
    const { web, context } = await project()
    const dataDir = join(web, '.runtime')
    await mkdir(dataDir)
    await writeFile(join(dataDir, 'providers.json'), 'secret')
    const tools = await mount({ protectedPaths: [dataDir] })
    const denied = '私有数据目录'
    await expect(tools.get('read_file')!.execute({ path: '.runtime/providers.json', folder: 'web' }, context)).rejects.toThrow(denied)
    await expect(tools.get('list_files')!.execute({ path: '.runtime', folder: 'web' }, context)).rejects.toThrow(denied)
    await expect(tools.get('write_file')!.execute({ path: '.runtime/new.txt', content: 'x', folder: 'web' }, context)).rejects.toThrow(
      denied,
    )
    expect((await tools.get('list_files')!.execute({ path: '.', folder: 'web' }, context)).text).toBe(
      'protected (not accessible)\t.runtime',
    )
  })
})

it.skipIf(process.platform === 'win32')('refuses non-regular files without blocking on a FIFO', async () => {
  const root = await directory()
  execFileSync('mkfifo', [join(root, 'pipe')])
  const tools = await mount()
  await expect(tools.get('read_file')!.execute({ path: 'pipe' }, contextFor(root))).rejects.toThrow('普通文件')
  expect(
    await tools.get('write_file')!.preview!({ path: 'pipe', content: 'x' }, { workspaceRoot: root, signal: new AbortController().signal }),
  ).toEqual({ title: '写入 pipe', diffs: [{ path: 'pipe', newText: 'x', previous: 'unavailable' }] })
})

it('marks a write preview as a new file only when nothing exists at the path', async () => {
  const root = await directory()
  const write = (await mount()).get('write_file')!
  const previous = async (path: string) =>
    (
      (await write.preview!({ path, content: 'x' }, { workspaceRoot: root, signal: new AbortController().signal })).diffs?.[0] as
        | FileDiff
        | undefined
    )?.previous
  await writeFile(join(root, 'empty.txt'), '')
  expect(await previous('empty.txt')).toBe('text')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01]))
  expect(await previous('binary.bin')).toBe('unavailable')
  await mkdir(join(root, 'folder'))
  expect(await previous('folder')).toBe('unavailable')
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await writeFile(join(root, 'locked.txt'), 'secret', { mode: 0o000 })
    expect(await previous('locked.txt')).toBe('unavailable')
  }
  expect(await previous('missing/deeper/new.txt')).toBe('none')
})

describe.skipIf(process.platform === 'win32')('swaps between the path walk and the file operation', () => {
  /** Runs `swap` once, at the seam after the walk: before a read's open, or before a write's rename. */
  async function racing(swap: (path: string) => Promise<void>) {
    const seen: string[] = []
    const tools = await mount({
      hooks: {
        async afterResolve(path) {
          seen.push(path)
          if (seen.length === 1) await swap(path)
        },
      },
    })
    return { tools, seen }
  }

  it('refuses to read a final component swapped to a symlink', async () => {
    const root = await directory()
    const outside = await directory()
    await writeFile(join(outside, 'secret.txt'), 'outside secret')
    await writeFile(join(root, 'note.txt'), 'inside')
    const { tools, seen } = await racing(async path => {
      await rm(path)
      await symlink(join(outside, 'secret.txt'), path)
    })
    await expect(tools.get('read_file')!.execute({ path: 'note.txt' }, contextFor(root))).rejects.toThrow('工作区工具不访问符号链接')
    expect(seen.map(path => basename(path))).toEqual(['note.txt'])
  })

  it('refuses to read through a parent directory swapped to a symlink', async () => {
    const root = await directory()
    const outside = await directory()
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'file.txt'), 'inside')
    await writeFile(join(outside, 'file.txt'), 'outside secret')
    const { tools } = await racing(async () => {
      await rename(join(root, 'sub'), join(root, 'moved'))
      await symlink(outside, join(root, 'sub'))
    })
    await expect(tools.get('read_file')!.execute({ path: 'sub/file.txt' }, contextFor(root))).rejects.toThrow('工作区工具不访问符号链接')
  })

  it('refuses to rename into a parent directory moved outside and replaced by a symlink, removing the temporary file', async () => {
    const root = await directory()
    const outside = await directory()
    await mkdir(join(root, 'sub'))
    const { tools, seen } = await racing(async () => {
      await rename(join(root, 'sub'), join(outside, 'sub'))
      await symlink(join(outside, 'sub'), join(root, 'sub'))
    })
    await expect(tools.get('write_file')!.execute({ path: 'sub/planted.txt', content: 'planted' }, contextFor(root))).rejects.toThrow(
      '工作区工具不访问符号链接',
    )
    expect(seen.map(path => basename(path))).toEqual(['planted.txt'])
    expect(await readdir(join(outside, 'sub'))).toEqual([])
  })

  it('refuses to rename over a final component that became a symlink, removing the temporary file', async () => {
    const root = await directory()
    const outside = await directory()
    await writeFile(join(outside, 'target.txt'), 'keep')
    const { tools } = await racing(async path => {
      await symlink(join(outside, 'target.txt'), path)
    })
    await expect(tools.get('write_file')!.execute({ path: 'new.txt', content: 'replaced' }, contextFor(root))).rejects.toThrow(
      '工作区工具不访问符号链接',
    )
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('keep')
    expect(await readdir(root)).toEqual(['new.txt'])
    expect(await readdir(outside)).toEqual(['target.txt'])
  })

  it('reads and writes normally when nothing is swapped', async () => {
    const root = await directory()
    const { tools, seen } = await racing(async () => {})
    await tools.get('write_file')!.execute({ path: 'a/b.txt', content: '内容' }, contextFor(root))
    expect(await tools.get('read_file')!.execute({ path: 'a/b.txt' }, contextFor(root))).toEqual({ text: '内容' })
    expect(seen.map(path => basename(path))).toEqual(['b.txt', 'b.txt'])
    expect(await readdir(join(root, 'a'))).toEqual(['b.txt'])
  })
})
