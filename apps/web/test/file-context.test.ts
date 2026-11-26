import { expect, it } from 'vitest'
import { contextOf, fileContextBody, fileContextKey, fileRoute, sessionFileTarget, targetIn } from '../src/preview/fileContext.ts'

it('keeps workspace previews distinct from real sessions and from other harness roots', () => {
  const project = { kind: 'workspace' as const, workspaceId: 'saved-project', harnessId: 'standard' }
  const target = targetIn(project, 'src/start.ts', 'source')
  expect(target).toEqual({ workspaceId: 'saved-project', harnessId: 'standard', reference: 'src/start.ts', rootId: 'source' })
  expect(contextOf(target)).toEqual(project)
  expect(fileRoute(project, 'resolve')).toBe('workspaces/saved-project/files/resolve')
  expect(fileContextBody(project)).toEqual({ harnessId: 'standard' })
  expect(fileContextKey(project)).not.toBe(fileContextKey({ ...project, harnessId: 'codex' }))
  expect(fileContextKey(project)).not.toBe(fileContextKey({ kind: 'session', sessionId: 'saved-project' }))
  const session = { kind: 'session' as const, sessionId: 'task:one' }
  expect(targetIn(session, 'note.md')).toEqual({ sessionId: 'task:one', reference: 'note.md' })
  expect(fileRoute(session, 'list')).toBe('tasks/task%3Aone/files/list')
  expect(fileContextBody(session)).toEqual({})
})

it('keeps a folder root openable with a trailing slash and preserves tab identity for its files', () => {
  const roots = [
    { id: 'primary', path: '/project/app' },
    { id: 'assets', path: '/project/assets' },
  ]
  const target = (reference: string, rootId?: string) => ({ sessionId: 's', reference, ...(rootId ? { rootId } : {}) })
  for (const path of ['/project/assets', '/project/assets/', '/project/assets//'])
    expect(sessionFileTarget(target(path), roots)).toEqual(target('/project/assets', 'assets'))
  const asset = target('docs/README', 'assets')
  expect(sessionFileTarget(target('/project/assets/docs/README'), roots)).toEqual(asset)
  expect(sessionFileTarget(asset, roots)).toEqual(asset)
  expect(sessionFileTarget(target('README'), roots)).toEqual(target('README', 'primary'))
  for (const path of ['~/project/assets/', '/alias/assets/', 'file:///project/assets/', '../assets', '/project/app/../assets'])
    expect(sessionFileTarget(target(path), roots)).toEqual(target(path))
  expect(sessionFileTarget(target('../assets', 'primary'), roots)).toEqual(target('../assets', 'primary'))
})
