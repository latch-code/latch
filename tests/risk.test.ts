import { describe, expect, it } from 'vitest'
import { DEMO_TOOLS, R0_TOOLS, classifyStandardCall, type StandardCallInput } from '../src/host/risk.ts'

function call(pluginId: string | undefined, toolName: string, args: unknown = {}, options: Partial<StandardCallInput> = {}): StandardCallInput {
  return { pluginId, toolName, args, demo: false, workspace: { codeRoot: false }, ...options }
}

describe('classifyStandardCall', () => {
  it('keeps the read-only built-in tools at R0', () => {
    expect(R0_TOOLS).toEqual(['workspace-files:list_files', 'workspace-files:read_file'])
    expect(classifyStandardCall(call('workspace-files', 'list_files', { path: '.' }))).toEqual({ risk: 'R0' })
    expect(classifyStandardCall(call('workspace-files', 'read_file', { path: '.git/config' }))).toEqual({ risk: 'R0' })
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
    [{ path: '/etc/hosts' }, { risk: 'R2', reason: 'outside-workspace' }],
    [{ path: 'C:\\x.txt' }, { risk: 'R2', reason: 'outside-workspace' }],
    [{ path: '' }, { risk: 'R2', reason: 'outside-workspace' }],
    [{ path: 42 }, { risk: 'R2', reason: 'outside-workspace' }],
    [{}, { risk: 'R2', reason: 'outside-workspace' }],
    [null, { risk: 'R2', reason: 'outside-workspace' }],
  ])('write_file %j → %j', (args, expected) => {
    expect(classifyStandardCall(call('workspace-files', 'write_file', args))).toEqual(expected)
  })

  it('makes every write R2 when the workspace overlaps the code root', () => {
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'src/app.ts' }, { workspace: { codeRoot: true } })))
      .toEqual({ risk: 'R2', reason: 'code-root' })
  })

  it.each([
    ['/repo/.git', 'hooks/pre-commit'], ['/repo/.github', 'workflows/ci.yml'], ['/repo/.github/workflows', 'ci.yml'],
    ['/repo/.husky', 'pre-commit'], ['/repo/.vscode', 'tasks.json'], ['/repo/node_modules/pkg', 'index.js'], ['/Users/me/.cargo', 'config.toml'],
  ])('makes writes R2 when the workspace root %s is itself protected (%s)', (root, path) => {
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path }, { workspace: { codeRoot: false, root } })))
      .toEqual({ risk: 'R2', reason: 'protected-path' })
  })

  it('keeps ordinary writes R1 under an ordinary root, and reads R0 under any root', () => {
    const workspace = { codeRoot: false, root: '/Users/me/projects/app' }
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'src/app.ts' }, { workspace }))).toEqual({ risk: 'R1' })
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: '.pnpmfile.cjs' }, { workspace }))).toEqual({ risk: 'R2', reason: 'protected-path' })
    expect(classifyStandardCall(call('workspace-files', 'read_file', { path: 'HEAD' }, { workspace: { codeRoot: false, root: '/repo/.git' } }))).toEqual({ risk: 'R0' })
    // A root that is not absolute cannot be judged, so it counts as protected.
    expect(classifyStandardCall(call('workspace-files', 'write_file', { path: 'a.txt' }, { workspace: { codeRoot: false, root: 'repo' } })))
      .toEqual({ risk: 'R2', reason: 'protected-path' })
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
