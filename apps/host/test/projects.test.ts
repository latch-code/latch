import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { foldersHash, newProject, planFolders, reorderFolders } from '../src/projects.ts'

const cleanups: string[] = []
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lt-projects-')))
  cleanups.push(root)
  for (const path of ['home/code/api/lib', 'home/code/web', 'home/docs/web', 'home/code/c,d', 'data', 'runtime', 'code'])
    mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, 'home', 'code', 'notes.txt'), 'x')
  const home = join(root, 'home')
  return {
    root,
    code: join(home, 'code'),
    guard: {
      home,
      dataDir: join(root, 'data'),
      agentsDir: join(root, 'agents'),
      runtimeDir: join(root, 'runtime'),
      codeRoot: join(root, 'code'),
    },
  }
}

describe('planFolders', () => {
  it('accepts paths in order, refuses each one that fails with its reason, and makes the first accepted one primary', async () => {
    const { root, code, guard } = setup()
    const plan = await planFolders({
      current: [],
      paths: [join(code, 'missing'), join(code, 'api'), join(code, 'api', 'lib'), join(code, 'web'), join(root, 'home', 'docs', 'web')],
      primaries: [],
      guard,
    })
    expect(plan.folders).toEqual([
      { id: 'api', path: join(code, 'api') },
      { id: 'web', path: join(code, 'web') },
      { id: 'web-2', path: join(root, 'home', 'docs', 'web') },
    ])
    expect(plan.added).toEqual(plan.folders)
    expect(plan.refused).toEqual([
      { path: join(code, 'missing'), code: 'workspace-invalid', message: '找不到这个文件夹' },
      { path: join(code, 'api', 'lib'), code: 'workspace-folder-overlap', message: '同一项目中的文件夹不能相同，也不能相互包含' },
    ])
  })

  it("never makes another project's primary folder or the start directory primary, but lets them join as other folders", async () => {
    const { root, code, guard } = setup()
    const docs = join(root, 'home', 'docs', 'web')
    const primaries = [
      { id: 'default', name: '启动目录', path: docs },
      { id: 'api', name: 'API', path: join(code, 'api') },
    ]
    const plan = await planFolders({
      current: [],
      paths: [join(code, 'api'), docs, join(code, 'c,d'), join(code, 'web')],
      primaries,
      guard,
    })
    expect(plan.refused.map(item => item.code)).toEqual(['workspace-exists', 'workspace-exists', 'workspace-folder-chars'])
    expect(plan.folders).toEqual([{ id: 'web', path: join(code, 'web') }])
    const more = await planFolders({ current: plan.folders, paths: [join(code, 'api'), docs], primaries, guard })
    expect(more.folders.map(folder => folder.id)).toEqual(['web', 'api', 'web-2'])
    expect(more.refused).toEqual([])
  })

  it('stops at 8 folders and refuses the rest', async () => {
    const { root, guard } = setup()
    const paths = Array.from({ length: 9 }, (_, index) => {
      mkdirSync(join(root, 'home', 'many', `p${index}`), { recursive: true })
      return join(root, 'home', 'many', `p${index}`)
    })
    const plan = await planFolders({ current: [], paths, primaries: [], guard })
    expect(plan.folders).toHaveLength(8)
    expect(plan.refused).toEqual([{ path: paths[8], code: 'workspace-folder-limit', message: '一个项目最多 8 个文件夹' }])
  })

  it('replaces one folder in place, keeping its ID and position, and checks a new primary folder', async () => {
    const { root, code, guard } = setup()
    const current = [
      { id: 'api', path: join(code, 'api') },
      { id: 'web', path: join(code, 'web') },
    ]
    const replaced = await planFolders({ current, paths: [join(root, 'home', 'docs', 'web')], replace: 'web', primaries: [], guard })
    expect(replaced.folders).toEqual([current[0], { id: 'web', path: join(root, 'home', 'docs', 'web') }])
    expect(replaced.added).toEqual([{ id: 'web', path: join(root, 'home', 'docs', 'web') }])
    const taken = [{ id: 'docs', name: 'Docs', path: join(root, 'home', 'docs', 'web') }]
    const primary = await planFolders({ current, paths: [join(root, 'home', 'docs', 'web')], replace: 'api', primaries: taken, guard })
    expect(primary.refused.map(item => item.code)).toEqual(['workspace-exists'])
    expect(primary.folders).toEqual(current)
    await expect(planFolders({ current, paths: [join(code, 'web')], replace: 'gone', primaries: [], guard })).rejects.toMatchObject({
      code: 'workspace-folder-not-found',
    })
    await expect(
      planFolders({ current, paths: [join(code, 'web'), join(code, 'api')], replace: 'web', primaries: [], guard }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })
})

describe('project records', () => {
  it('bounds a default name before auditing it and keeps Unicode characters intact', () => {
    const name = '项'.repeat(81)
    const project = newProject({ folders: [{ id: 'long', path: `/work/${name}` }], taken: [] })
    expect(project.name).toBe('项'.repeat(80))
    const emoji = newProject({ folders: [{ id: 'emoji', path: `/work/${'x'.repeat(79)}😀` }], taken: [] })
    expect(emoji.name).toBe('x'.repeat(79))
  })
  it('names a new project after its primary folder and never reuses a taken ID', () => {
    const folders = [{ id: 'shop-api', path: '/Users/me/code/Shop API' }]
    expect(newProject({ folders, taken: [] })).toEqual({ id: 'shop-api', name: 'Shop API', path: '/Users/me/code/Shop API', folders })
    expect(newProject({ folders, taken: ['shop'], name: 'Shop' })).toMatchObject({ id: 'shop-2', name: 'Shop' })
    expect(foldersHash(folders)).toMatch(/^[0-9a-f]{64}$/u)
    expect(foldersHash(folders)).not.toBe(foldersHash([...folders, { id: 'web', path: '/Users/me/code/web' }]))
  })

  it('reorders by a permutation of the folder IDs, and keeps paths with , * or ? out of the other positions', () => {
    const current = [
      { id: 'a', path: '/w/a,b' },
      { id: 'c', path: '/w/c' },
      { id: 'd', path: '/w/d' },
    ]
    expect(reorderFolders(current, ['a', 'd', 'c']).map(folder => folder.id)).toEqual(['a', 'd', 'c'])
    for (const order of [
      ['a', 'c'],
      ['a', 'c', 'c'],
      ['a', 'c', 'x'],
      ['a', 'c', 'd', 'd'],
    ])
      expect(() => reorderFolders(current, order)).toThrow(expect.objectContaining({ code: 'workspace-order-invalid' }))
    expect(() => reorderFolders(current, ['c', 'a', 'd'])).toThrow(expect.objectContaining({ code: 'workspace-folder-chars' }))
  })
})
