import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileContext, FileMetadata } from '@latch/protocol'
import { api } from '../src/core/api.ts'
import { readTreeFile, treeChanges, treeFullPath, treeKey, treeLocation, viewOfFolder } from '../src/preview/treeFiles.ts'

vi.mock('../src/core/api.ts', async importOriginal => ({ ...(await importOriginal<typeof import('../src/core/api.ts')>()), api: vi.fn() }))

it('locates root and nested folders while preserving other expanded branches', () => {
  const root = viewOfFolder('project', '')
  expect(root.expanded).toEqual([treeKey('project', '')])
  expect(root.selected).toBe(treeKey('project', ''))
  const nested = viewOfFolder('docs', 'design/web', { ...root, showHidden: true })
  expect(nested.expanded).toEqual([treeKey('docs', ''), treeKey('docs', 'design'), treeKey('docs', 'design/web'), ...root.expanded])
  expect(nested.selected).toBe(treeKey('docs', 'design/web'))
  expect(nested.showHidden).toBe(true)
})
const file: FileMetadata = {
  handle: 'A'.repeat(22),
  name: 'readme.md',
  root: 'notes',
  path: 'docs/readme.md',
  ext: 'md',
  kind: 'markdown',
  mime: 'text/markdown',
  size: 20,
  mtime: 1,
  etag: '"' + 'a'.repeat(32) + '"',
  limit: 1000,
  secret: false,
  actions: { reveal: true, quicklook: false, open: true, download: true, preview: true },
}
afterEach(() => vi.resetAllMocks())

describe('authorized tree file actions', () => {
  it.each<FileContext>([
    { kind: 'session', sessionId: 'session-one' },
    { kind: 'workspace', workspaceId: 'project-one', harnessId: 'only-primary' },
  ])('keeps the exact context and explicit root in a fresh action-time resolve: $kind', async context => {
    vi.mocked(api).mockResolvedValue({ files: [{ status: 'ok', file }] })
    const signal = new AbortController().signal
    expect(await readTreeFile(context, { root: file.root, path: file.path }, signal)).toEqual(file)
    expect(api).toHaveBeenCalledWith(
      context.kind === 'session' ? 'tasks/session-one/files/resolve' : 'workspaces/project-one/files/resolve',
      {
        method: 'POST',
        body: { paths: [file.path], rootId: file.root, ...(context.kind === 'workspace' ? { harnessId: context.harnessId } : {}) },
        signal,
      },
    )
  })
  it.each([
    { ...file, root: 'another-root' },
    { ...file, path: 'another-file.md' },
    { ...file, source: 'attachment', attachmentId: 'B'.repeat(22) },
    { ...file, handle: 'invalid' },
  ])('does not promote a mismatched or attachment response into native authority', async response => {
    vi.mocked(api).mockResolvedValue({ files: [{ status: 'ok', file: response }] })
    await expect(
      readTreeFile({ kind: 'session', sessionId: 'one' }, { root: file.root, path: file.path }, new AbortController().signal),
    ).rejects.toThrow('文件已变化')
  })
  it('rejects traversal before the request and discards a late response after cancellation', async () => {
    const controller = new AbortController()
    await expect(
      readTreeFile({ kind: 'session', sessionId: 'one' }, { root: 'notes', path: '../private' }, controller.signal),
    ).rejects.toThrow('文件引用无效')
    expect(api).not.toHaveBeenCalled()
    let finish!: (value: unknown) => void
    vi.mocked(api).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const reading = readTreeFile({ kind: 'session', sessionId: 'one' }, { root: file.root, path: file.path }, controller.signal)
    controller.abort()
    finish({ files: [{ status: 'ok', file }] })
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  })
})
describe('frozen paths and observed changes', () => {
  it('never substitutes the primary path for an unknown root or guesses an absolute path', () => {
    const folders = [
      { id: 'main', path: '/projects/app' },
      { id: 'notes', path: '/projects/notes/' },
    ]
    expect(treeFullPath(file, folders, '/fallback')).toBe('/projects/notes/docs/readme.md')
    expect(treeFullPath({ ...file, root: 'gone' }, folders, '/fallback')).toBeUndefined()
    expect(treeFullPath(file, undefined, '/session/')).toBe('/session/docs/readme.md')
    expect(treeFullPath(file, undefined, 'relative')).toBeUndefined()
    expect(treeFullPath({ ...file, path: '../outside.md' }, folders)).toBeUndefined()
    expect(treeFullPath(file, [{ id: 'notes', path: 'C:\\project\\notes\\' }])).toBe('C:\\project\\notes\\docs\\readme.md')
  })
  it('keeps identical file names in different roots distinct and uses bounded Host observations', () => {
    const changes = treeChanges([
      { root: 'a', path: 'report.md', change: 'modified' },
      { root: 'b', path: 'report.md', change: 'created' },
    ])
    expect([...changes]).toEqual([treeKey('a', 'report.md'), treeKey('b', 'report.md')])
    expect(treeLocation(treeKey('a', ''))).toEqual({ root: 'a', path: '' })
    expect(treeLocation(treeKey('a', '../private'))).toBeUndefined()
    expect(treeLocation('bad')).toBeUndefined()
    expect(treeChanges(Array.from({ length: 2000 }, (_, i) => ({ root: 'a', path: `${i}.txt`, change: 'modified' as const }))).size).toBe(
      1000,
    )
  })
})
