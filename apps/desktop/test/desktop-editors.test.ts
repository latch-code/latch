import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { EDITOR_REFUSED_TYPES as HOST_REFUSED } from '@latch/host/files/kinds'

const require = createRequire(import.meta.url)

interface Editor {
  id: string
  name: string
  bundleIds: readonly string[]
  scheme?: string
}
interface Editors {
  list(): Promise<{ status: string; editors?: Array<{ id: string; name: string }>; chosen?: string | null; code?: string }>
  choose(id: unknown): Promise<{ status: string; chosen?: string | null; code?: string }>
  openPath(path: string, line?: number): Promise<{ status: string; code?: string }>
}
const editors = require('../src/editors.cjs') as {
  EDITORS: readonly Editor[]
  EDITOR_REFUSED_TYPES: ReadonlySet<string>
  isEditorPath(path: unknown): boolean
  launchArgs(editor: Editor | undefined, app: { bundleId: string; path: string }, path: string, line?: unknown): string[] | undefined
  launchPlan(
    editor: Editor | undefined,
    app: { bundleId: string; path: string },
    path: string,
    line?: unknown,
  ): { args?: string[]; code?: string }
  editorById(id: unknown): Editor | undefined
  readEditorChoice(directory: string): Promise<string | null>
  writeEditorChoice(directory: string, id: string): Promise<void>
  createEditors(options: {
    listApps(): Promise<string[]>
    bundleIdOf(appPath: string): Promise<string | undefined>
    launch(args: string[]): Promise<void>
    readChoice(): Promise<string | null>
    writeChoice(id: string): Promise<void>
    platform: string
    now?: () => number
  }): Editors
}
const files = require('../src/files.cjs') as {
  createFileActions(options: Record<string, unknown>): {
    inspectFile(input: unknown): Promise<{ status: string; actions?: Record<string, boolean>; refused?: Record<string, string> }>
    editorFile(input: unknown): Promise<{ status: string; code?: string }>
  }
}

const vscode = editors.editorById('vscode')!
const xcode = editors.editorById('xcode')!

/** A fake Mac: these app bundles with these bundle IDs; launches are recorded, never run. */
function fakeMac(apps: Record<string, string>, chosen: string | null = null) {
  const launches: string[][] = []
  let saved = chosen
  const shell = editors.createEditors({
    listApps: async () => Object.keys(apps),
    bundleIdOf: async path => apps[path],
    launch: async args => {
      launches.push(args)
    },
    readChoice: async () => saved,
    writeChoice: async id => {
      saved = id
    },
    platform: 'darwin',
  })
  return { shell, launches, saved: () => saved }
}

describe('在编辑器中打开: the allow-list', () => {
  it('names only fixed bundle IDs, each editor once', () => {
    const ids = editors.EDITORS.flatMap(editor => editor.bundleIds)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('com.microsoft.VSCode')
    expect(ids).toContain('com.apple.dt.Xcode')
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9.-]+$/u)
  })

  it('refuses the same project and workspace files as the Host', () => {
    expect([...editors.EDITOR_REFUSED_TYPES].sort()).toEqual([...HOST_REFUSED].sort())
  })

  it('lists only editors whose bundle carries an allowed bundle ID', async () => {
    const { shell } = fakeMac({
      '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode',
      // Named like Cursor, but another program: not listed.
      '/Applications/Cursor.app': 'com.example.cursor-clone',
      '/Users/me/Applications/Zed.app': 'dev.zed.Zed',
      '/Applications/Calculator.app': 'com.apple.calculator',
    })
    expect(await shell.list()).toEqual({
      status: 'ok',
      editors: [
        { id: 'vscode', name: 'VS Code' },
        { id: 'zed', name: 'Zed' },
      ],
      chosen: null,
    })
  })

  it('remembers a choice only from the list found here', async () => {
    const mac = fakeMac({ '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode' })
    expect(await mac.shell.choose('cursor')).toEqual({ status: 'refused', code: 'no-editor' })
    expect(await mac.shell.choose('/usr/bin/vim')).toEqual({ status: 'failed', code: 'invalid' })
    expect(await mac.shell.choose({ id: 'vscode' })).toEqual({ status: 'failed', code: 'invalid' })
    expect(mac.saved()).toBeNull()
    expect((await mac.shell.choose('vscode')).chosen).toBe('vscode')
    expect(mac.saved()).toBe('vscode')
  })

  it('finds nothing and launches nothing off macOS', async () => {
    const shell = editors.createEditors({
      listApps: async () => ['/Applications/Visual Studio Code.app'],
      bundleIdOf: async () => 'com.microsoft.VSCode',
      launch: async () => {
        throw new Error('launched')
      },
      readChoice: async () => 'vscode',
      writeChoice: async () => {},
      platform: 'linux',
    })
    expect(await shell.list()).toEqual({ status: 'ok', editors: [], chosen: null })
    expect(await shell.openPath('/p/a.ts')).toEqual({ status: 'refused', code: 'no-editor' })
  })
})

describe('在编辑器中打开: the launch', () => {
  const VS = { bundleId: 'com.microsoft.VSCode', path: '/Applications/Visual Studio Code.app' }
  const XC = { bundleId: 'com.apple.dt.Xcode', path: '/Applications/Xcode.app' }
  const ZED = { bundleId: 'dev.zed.Zed', path: '/Applications/Zed.app' }
  const IJ = { bundleId: 'com.jetbrains.intellij', path: '/Users/me/Applications/IntelliJ IDEA.app' }
  const zed = editors.editorById('zed')!
  const intellij = editors.editorById('intellij')!

  it('starts the checked bundle with a URL from the fixed template, encoding every segment', () => {
    expect(editors.launchArgs(vscode, VS, '/p/src/a.ts', 12)).toEqual(['-a', VS.path, 'vscode://file/p/src/a.ts:12'])
    expect(editors.launchArgs(vscode, VS, '/p/my dir/#1 100%?.ts')?.[2]).toBe('vscode://file/p/my%20dir/%231%20100%25%3F.ts')
    expect(editors.launchArgs(vscode, VS, '/p/文档/ä.md', 3)?.[2]).toBe('vscode://file/p/%E6%96%87%E6%A1%A3/%C3%A4.md:3')
  })

  it('hands a VS Code-family editor a name with a colon as a plain argument, without a line', () => {
    // Its URL handler reads every `:<number>` segment (an empty one as 0) as a position and normalises the rest.
    for (const path of ['/p/..:', '/p/a::b', '/p/a:5:b.ts', '/p/x:', '/p/notes:12', '/p/a:9.ts'])
      expect(editors.launchArgs(vscode, VS, path, 7), path).toEqual(['-a', VS.path, path])
    // `(n,m)` means nothing to it.
    expect(editors.launchArgs(vscode, VS, '/p/a(3,4)', 2)?.[2]).toBe('vscode://file/p/a(3%2C4):2')
  })

  it('refuses for Zed any name it would read as a position', () => {
    for (const path of ['/p/..:', '/p/a::b', '/p/a:5:b.ts', '/p/x:', '/p/a(3)', '/p/a(3,4)'])
      expect(editors.launchPlan(zed, ZED, path), path).toEqual({ code: 'file-name-refused' })
    expect(editors.launchArgs(zed, ZED, '/p/a (copy).ts', 2)).toEqual(['-a', ZED.path, 'zed://file/p/a%20(copy).ts:2'])
  })

  it('hands the path as the only argument to an editor without a URL scheme, and drops the line', () => {
    expect(editors.launchArgs(xcode, XC, '/p/my app/main.swift', 4)).toEqual(['-a', XC.path, '/p/my app/main.swift'])
    expect(editors.launchArgs(xcode, XC, '/p/notes:12')?.[2]).toBe('/p/notes:12')
  })

  it('never gives Xcode or a JetBrains IDE a project file it evaluates or imports on open', () => {
    expect(editors.launchPlan(xcode, XC, '/p/Package.swift')).toEqual({ code: 'file-type-refused' })
    for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle.kts'])
      expect(editors.launchPlan(intellij, IJ, `/p/${name}`), name).toEqual({ code: 'file-type-refused' })
    // Other editors only show them.
    expect(editors.launchArgs(vscode, VS, '/p/pom.xml')).toBeDefined()
  })

  it('refuses paths that are not one plain absolute line', () => {
    for (const path of [
      'relative/a.ts',
      '/p/a\n.ts',
      '/p/a\r.ts',
      '/p/\u0000a.ts',
      '/p/a\u2028.ts',
      '/p/a\u0085.ts',
      '/p/../etc/passwd',
      '/p/./a.ts',
      '/p//a.ts',
      '/p/dir/',
      '',
      `/${'a'.repeat(4096)}`,
    ]) {
      expect(editors.isEditorPath(path), JSON.stringify(path)).toBe(false)
      expect(editors.launchArgs(vscode, VS, path), JSON.stringify(path)).toBeUndefined()
    }
  })

  it('takes only a checked bundle of that editor, and only a whole line from 1', () => {
    expect(
      editors.launchArgs(vscode, { bundleId: 'com.apple.Terminal', path: '/Applications/Utilities/Terminal.app' }, '/p/a.ts'),
    ).toBeUndefined()
    expect(editors.launchArgs(vscode, { bundleId: VS.bundleId, path: '/usr/bin/vim' }, '/p/a.ts')).toBeUndefined()
    expect(editors.launchArgs(undefined, VS, '/p/a.ts')).toBeUndefined()
    for (const line of [0, -1, 1.5, '3', Number.NaN, 10_000_001])
      expect(editors.launchArgs(vscode, VS, '/p/a.ts', line)?.[2]).toBe('vscode://file/p/a.ts')
  })

  it('launches the chosen editor at the bundle it checked, never without a choice', async () => {
    const none = fakeMac({ '/Applications/Zed Preview.app': 'dev.zed.Zed-Preview' })
    expect(await none.shell.openPath('/p/a.ts', 2)).toEqual({ status: 'refused', code: 'no-editor' })
    expect(none.launches).toEqual([])
    const chosen = fakeMac({ '/Applications/Zed Preview.app': 'dev.zed.Zed-Preview' }, 'zed')
    expect(await chosen.shell.openPath('/p/a b.ts', 2)).toEqual({ status: 'opened' })
    expect(chosen.launches).toEqual([['-a', '/Applications/Zed Preview.app', 'zed://file/p/a%20b.ts:2']])
    expect(await chosen.shell.openPath('/p/a\nb.ts')).toEqual({ status: 'refused', code: 'file-invalid' })
    expect(await chosen.shell.openPath('/p/x:')).toEqual({ status: 'refused', code: 'file-name-refused' })
    expect(chosen.launches).toHaveLength(1)
  })

  it('keeps the choice in a private file and ignores anything else there', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-editors-'))
    try {
      expect(await editors.readEditorChoice(directory)).toBeNull()
      await editors.writeEditorChoice(directory, 'cursor')
      expect(await editors.readEditorChoice(directory)).toBe('cursor')
      expect((await stat(join(directory, 'editor.json'))).mode & 0o777).toBe(0o600)
      await expect(editors.writeEditorChoice(directory, 'vim')).rejects.toThrow()
      await writeFile(join(directory, 'editor.json'), JSON.stringify({ version: 1, editor: '/bin/sh' }))
      expect(await editors.readEditorChoice(directory)).toBeNull()
      expect(JSON.parse(await readFile(join(directory, 'editor.json'), 'utf8')).editor).toBe('/bin/sh')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('在编辑器中打开: main checks the Host answer again', () => {
  const SESSION = 'session-1'
  const HANDLE = 'A'.repeat(22)
  const PATH = '/work/src/a.ts'
  const TEXT = new TextEncoder().encode('export const a = 1\n')
  function actions(head: Uint8Array, real = PATH) {
    const calls: string[] = []
    const opened: Array<[string, number | undefined]> = []
    const result = files.createFileActions({
      request: async (_method: string, url: string, body: unknown) => {
        calls.push(`${url} ${JSON.stringify(body)}`)
        return url.endsWith('/local')
          ? { status: 200, json: { file: { path: real, name: 'a.ts', ext: 'ts' } } }
          : {
              status: 200,
              json: {
                files: [
                  {
                    status: 'ok',
                    file: { handle: HANDLE, name: 'a.ts', actions: { reveal: true, quicklook: false, open: false, editor: true } },
                  },
                ],
              },
            }
      },
      show: () => {},
      quickLook: () => {},
      open: async () => '',
      editor: async (path: string, line?: number) => {
        opened.push([path, line])
        return { status: 'opened' }
      },
      inspect: async (path: string) => ({ real: path, file: true, symlink: false }),
      readHead: async () => head,
      platform: 'darwin',
    })
    return { actions: result, calls, opened }
  }

  it('offers it for a text file the Host allows, and passes the line', async () => {
    const { actions: shell, calls, opened } = actions(TEXT)
    expect((await shell.inspectFile({ sessionId: SESSION, path: 'src/a.ts' })).actions?.editor).toBe(true)
    expect(await shell.editorFile({ sessionId: SESSION, path: 'src/a.ts', line: 7 })).toEqual({ status: 'opened' })
    expect(opened).toEqual([[PATH, 7]])
    expect(calls.at(-1)).toContain('"action":"editor"')
  })

  it('refuses binary content, a refused type and a bad line before any editor starts', async () => {
    const binary = actions(new Uint8Array([0, 1, 2, 3]))
    expect(await binary.actions.editorFile({ sessionId: SESSION, path: 'src/a.ts' })).toEqual({ status: 'refused', code: 'file-not-text' })
    expect(binary.opened).toEqual([])
    const workspace = actions(TEXT, '/work/team.code-workspace')
    expect(await workspace.actions.editorFile({ sessionId: SESSION, path: 'team.code-workspace' })).toEqual({
      status: 'refused',
      code: 'file-type-refused',
    })
    expect(workspace.opened).toEqual([])
    const bad = actions(TEXT)
    expect(await bad.actions.editorFile({ sessionId: SESSION, path: 'src/a.ts', line: '7' })).toEqual({ status: 'failed', code: 'invalid' })
    expect(await bad.actions.editorFile({ sessionId: SESSION, path: 'src/a.ts', line: 7, extra: 1 })).toEqual({
      status: 'failed',
      code: 'invalid',
    })
    expect(bad.calls).toEqual([])
  })
})
