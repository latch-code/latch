import { describe, expect, it } from 'vitest'
import { DEMO_TOOLS, R0_TOOLS, classifyStandardCall, type CallFolder, type StandardCallInput } from '../src/risk.ts'

const PRIMARY: CallFolder = { id: 'app', root: '/Users/me/projects/app', codeRoot: false }

function call(
  pluginId: string | undefined,
  toolName: string,
  args: unknown = {},
  options: Partial<StandardCallInput> = {},
): StandardCallInput {
  return { pluginId, toolName, args, demo: false, folders: [PRIMARY], ...options }
}

/** A session with one folder at `root`. */
function single(root: string | undefined, codeRoot = false): Partial<StandardCallInput> {
  return { folders: [{ id: 'default', ...(root !== undefined ? { root } : {}), codeRoot }] }
}

describe('classifyStandardCall', () => {
  it('keeps the read-only built-in tools at R0', () => {
    expect(R0_TOOLS).toEqual([
      'workspace-files:list_folders',
      'workspace-files:list_files',
      'workspace-files:read_file',
      'user-questions:ask_user',
    ])
    expect(classifyStandardCall(call('workspace-files', 'list_folders'))).toEqual({ risk: 'R0' })
    expect(classifyStandardCall(call('workspace-files', 'list_files', { path: '.' }))).toEqual({ risk: 'R0' })
    expect(classifyStandardCall(call('workspace-files', 'read_file', { path: '.git/config' }))).toEqual({ risk: 'R0' })
    expect(classifyStandardCall(call('user-questions', 'ask_user'))).toEqual({ risk: 'R0' })
    expect(classifyStandardCall(call('third-party', 'ask_user'))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
  })

  it.each([
    [{ path: 'src/app.ts' }, { risk: 'R1' }],
    [{ path: 'notes/today.md' }, { risk: 'R1' }],
    [{ path: '.git/config' }, { risk: 'R2', reason: 'protected-path' }],
    [{ path: 'sub/package.json' }, { risk: 'R2', reason: 'protected-path' }],
    [{ path: '.github/workflows/ci.yml' }, { risk: 'R2', reason: 'protected-path' }],
    [{ path: '.env.local' }, { risk: 'R2', reason: 'protected-path' }],
    [{ path: '../outside.txt' }, { risk: 'R2', reason: 'outside-workspace' }],
    [{ path: 'a/../../outside.txt' }, { risk: 'R2', reason: 'outside-workspace' }],
    // Not a relative path the classifier can place: an absolute path (even one inside the folder), empty, not text.
    [{ path: '/etc/hosts' }, { risk: 'R2', reason: 'unresolved-path' }],
    [{ path: 'C:\\x.txt' }, { risk: 'R2', reason: 'unresolved-path' }],
    [{ path: '' }, { risk: 'R2', reason: 'unresolved-path' }],
    [{ path: 'a\u0000b' }, { risk: 'R2', reason: 'unresolved-path' }],
    [{ path: 42 }, { risk: 'R2', reason: 'unresolved-path' }],
    [{}, { risk: 'R2', reason: 'unresolved-path' }],
    [null, { risk: 'R2', reason: 'unresolved-path' }],
  ])('write_file %j → %j', (args, expected) => {
    expect(classifyStandardCall(call('workspace-files', 'write_file', args))).toEqual(expected)
  })

  it('makes every write R2 when the workspace overlaps the code root or cannot be resolved', () => {
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'src/app.ts' }, single('/repo', true)))).toEqual({
      risk: 'R2',
      reason: 'code-root',
    })
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'src/app.ts' }, single(undefined, true)))).toEqual({
      risk: 'R2',
      reason: 'code-root',
    })
    // A folder without a root was not resolved, whatever its flag says.
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'src/app.ts' }, single(undefined)))).toEqual({
      risk: 'R2',
      reason: 'code-root',
    })
    expect(classifyStandardCall(call('workspace-files', 'read_file', { path: 'src/app.ts' }, single(undefined, true)))).toEqual({
      risk: 'R0',
    })
  })

  it.each([
    ['/repo/.git', 'hooks/pre-commit'],
    ['/repo/.github', 'workflows/ci.yml'],
    ['/repo/.github/workflows', 'ci.yml'],
    ['/repo/.husky', 'pre-commit'],
    ['/repo/.vscode', 'tasks.json'],
    ['/repo/node_modules/pkg', 'index.js'],
    ['/Users/me/.cargo', 'config.toml'],
  ])('makes writes R2 when the workspace root %s is itself protected (%s)', (root, path) => {
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path }, single(root)))).toEqual({
      risk: 'R2',
      reason: 'protected-path',
    })
  })

  it('keeps ordinary writes R1 under an ordinary root, and reads R0 under any root', () => {
    const workspace = single('/Users/me/projects/app')
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'src/app.ts' }, workspace))).toEqual({ risk: 'R1' })
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: '.pnpmfile.cjs' }, workspace))).toEqual({
      risk: 'R2',
      reason: 'protected-path',
    })
    expect(classifyStandardCall(call('workspace-files', 'read_file', { path: 'HEAD' }, single('/repo/.git')))).toEqual({ risk: 'R0' })
    // A root that is not absolute cannot be judged, so it counts as protected.
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'a.txt' }, single('repo')))).toEqual({
      risk: 'R2',
      reason: 'protected-path',
    })
  })

  describe('in a session of several folders', () => {
    const folders: CallFolder[] = [
      PRIMARY,
      { id: 'web', root: '/Users/me/projects/web', codeRoot: false },
      { id: 'hooks', root: '/Users/me/projects/app-git/.git', codeRoot: false },
      { id: 'latch', root: '/Users/me/latch/apps', codeRoot: true },
      { id: 'gone', codeRoot: true },
    ]
    const classify = (toolName: string, args: unknown) => classifyStandardCall(call('workspace-files', toolName, args, { folders }))

    it('reads any folder at R0 and lists the folders at R0', () => {
      expect(classify('list_folders', {})).toEqual({ risk: 'R0' })
      for (const folder of folders) {
        expect(classify('read_file', { path: '.env', folder: folder.id })).toEqual({ risk: 'R0' })
        expect(classify('list_files', { path: '.', folder: folder.id })).toEqual({ risk: 'R0' })
      }
      expect(classify('read_file', { path: 'README.md' })).toEqual({ risk: 'R0' })
    })

    it('asks R1 for an ordinary write in any folder, the primary one without a folder argument', () => {
      expect(classify('write_file', { path: 'src/app.ts' })).toEqual({ risk: 'R1' })
      expect(classify('write_file', { path: 'src/app.ts', folder: 'app' })).toEqual({ risk: 'R1' })
      expect(classify('write_file', { path: 'src/index.html', folder: 'web' })).toEqual({ risk: 'R1' })
    })

    it.each([
      [{ path: 'a.txt', folder: 'unknown' }, 'outside-workspace'],
      [{ path: 'a.txt', folder: 'APP' }, 'outside-workspace'],
      [{ path: 'a.txt', folder: 7 }, 'outside-workspace'],
      [{ path: 'a.txt', folder: null }, 'outside-workspace'],
      [{ path: '../app/a.txt', folder: 'web' }, 'outside-workspace'],
      [{ path: '/Users/me/projects/web/a.txt', folder: 'web' }, 'unresolved-path'],
      [{ path: '', folder: 'web' }, 'unresolved-path'],
      [{ path: 'package.json', folder: 'web' }, 'protected-path'],
      [{ path: '.github/workflows/ci.yml', folder: 'web' }, 'protected-path'],
      [{ path: 'config', folder: 'hooks' }, 'protected-path'],
      [{ path: 'notes.md', folder: 'latch' }, 'code-root'],
      [{ path: 'notes.md', folder: 'gone' }, 'code-root'],
    ])('makes write_file %j R2 (%s)', (args, reason) => {
      expect(classify('write_file', args)).toEqual({ risk: 'R2', reason })
    })

    it('makes a read or listing of a folder outside the session R2', () => {
      expect(classify('read_file', { path: 'a.txt', folder: 'unknown' })).toEqual({ risk: 'R2', reason: 'outside-workspace' })
      expect(classify('list_files', { path: '.', folder: 3 })).toEqual({ risk: 'R2', reason: 'outside-workspace' })
    })

    it('protects paths by the targeted folder only', () => {
      // `.git` above the hooks folder makes everything in it protected, but not the other folders.
      expect(classify('write_file', { path: 'notes.md', folder: 'hooks' })).toEqual({ risk: 'R2', reason: 'protected-path' })
      expect(classify('write_file', { path: 'notes.md', folder: 'web' })).toEqual({ risk: 'R1' })
    })

    it('fails closed for a session without folders', () => {
      for (const toolName of ['list_files', 'read_file', 'write_file'])
        expect(classifyStandardCall(call('workspace-files', toolName, { path: 'a.txt' }, { folders: [] }))).toEqual({
          risk: 'R2',
          reason: 'outside-workspace',
        })
    })
  })

  it('honours demo tools only in demo mode', () => {
    expect(DEMO_TOOLS).toEqual({ R0: ['safe-tools:long_task'], R1: ['safe-tools:write_report'] })
    expect(classifyStandardCall(call('safe-tools', 'long_task', {}, { demo: true }))).toEqual({ risk: 'R0' })
    expect(classifyStandardCall(call('safe-tools', 'write_report', {}, { demo: true }))).toEqual({ risk: 'R1' })
    expect(classifyStandardCall(call('safe-tools', 'long_task'))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
    expect(classifyStandardCall(call('safe-tools', 'write_report'))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
  })

  it('makes unlisted and third-party tools R2 regardless of what they declare', () => {
    expect(classifyStandardCall(call('my-plugin', 'read_file'))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
    expect(classifyStandardCall(call('my-plugin', 'list_files', {}, { demo: true }))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
    expect(classifyStandardCall(call(undefined, 'list_files'))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
    expect(classifyStandardCall(call(undefined, 'write_file', { path: 'a.txt' }))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
    expect(classifyStandardCall(call('workspace-files', 'delete_file', { path: 'a.txt' }))).toEqual({ risk: 'R2', reason: 'unlisted-tool' })
  })
})
