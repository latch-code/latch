import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginRegistry } from '@latch/core'
import { loadPluginPackage } from '../src/plugin-packages.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-package-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}
const manifest = { formatVersion: 1, id: 'test-package', name: 'Test package', version: '1', description: 'Fixture' }

describe('local feature packages', () => {
  it('loads the composed example with skills, interactive UI, a data service and a tool as one lifecycle', async () => {
    const plugin = await loadPluginPackage(fileURLToPath(new URL('../../../examples/release-review/', import.meta.url)))
    const registry = new PluginRegistry()
    cleanups.push(() => registry.close())
    registry.register(plugin)
    await registry.enable(plugin.id)
    expect(registry.list()[0]).toMatchObject({
      package: { formatVersion: 1 },
      capabilities: ['tool:summarize_release_checklist', 'data:criteria', 'ui:checklist', 'skill:release-review'],
    })
    expect(registry.skills()).toMatchObject([{ id: 'release-review:release-review', name: '发布检查' }])
    expect(JSON.stringify(registry.skills())).not.toContain('When the user')
    const info = registry.uiPanels().find(panel => panel.id === 'release-review:checklist')!
    const lease = registry.acquireClientPanel(info.id, info.moduleHash!)
    expect(lease.source).toContain('export default function ReleaseChecklist')
    await expect(registry.disable(plugin.id)).rejects.toMatchObject({ code: 'plugin-in-use' })
    lease.release()
    const data = registry.acquireUiPanel('release-review:criteria')
    expect(
      await data.render({
        session: { harnessId: 'standard', id: 'task', title: 'Review', status: 'idle', updatedAt: '' },
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ blocks: [{ type: 'list', items: ['测试通过并附上结果', '兼容性与迁移已核对', '已准备回退步骤'] }] })
    data.release()
    await registry.disable(plugin.id)
    expect(registry.uiPanels()).toEqual([])
    expect(registry.skills()).toEqual([])
    expect(() => registry.acquireClientPanel(info.id, info.moduleHash!)).toThrow()
    await registry.enable(plugin.id)
    expect(registry.uiPanels().find(panel => panel.id === info.id)?.moduleHash).toBe(info.moduleHash)
  })

  it('rolls back every contribution when a later composed module fails', async () => {
    const path = await directory()
    await writeFile(
      join(path, 'latch-plugin.json'),
      JSON.stringify({
        ...manifest,
        host: ['./host.mjs'],
        skills: [{ id: 's', name: 'Skill', description: '', file: './skill.md' }],
        panels: [{ id: 'ui', title: 'UI', entry: './panel.mjs' }],
      }),
    )
    await writeFile(join(path, 'skill.md'), 'Instructions')
    await writeFile(join(path, 'panel.mjs'), 'export default function View() { return null }')
    await writeFile(
      join(path, 'host.mjs'),
      `import { writeFile } from 'node:fs/promises'; export default { activate(ctx) {
      ctx.onDispose(() => writeFile(${JSON.stringify(join(path, 'disposed'))}, 'cleaned', { flag: 'wx' })); throw new Error('activation failed')
    } }`,
    )
    const registry = new PluginRegistry()
    cleanups.push(() => registry.close())
    const plugin = await loadPluginPackage(path)
    registry.register(plugin)
    await expect(registry.enable(plugin.id)).rejects.toThrow('activation failed')
    expect(registry.uiPanels()).toEqual([])
    expect(registry.skills()).toEqual([])
    expect(await readFile(join(path, 'disposed'), 'utf8')).toBe('cleaned')
  })

  it('rejects files and symlinks outside the package before importing Host modules', async () => {
    const path = await directory()
    const outside = await directory()
    await writeFile(join(outside, 'private.md'), 'Never expose this content')
    await symlink(join(outside, 'private.md'), join(path, 'skill.md'))
    await writeFile(
      join(path, 'latch-plugin.json'),
      JSON.stringify({ ...manifest, skills: [{ id: 's', name: 'Skill', description: '', file: './skill.md' }] }),
    )
    await expect(loadPluginPackage(path)).rejects.toMatchObject({ code: 'plugin-package-invalid' })
    await writeFile(join(path, 'latch-plugin.json'), JSON.stringify({ ...manifest, host: [join(outside, 'private.md')] }))
    await expect(loadPluginPackage(path)).rejects.toMatchObject({ code: 'plugin-package-invalid' })
  })

  it('keeps legacy module plugins compatible', async () => {
    const source = fileURLToPath(new URL('../../../examples/text-statistics.mjs', import.meta.url))
    expect(await readFile(source, 'utf8')).toContain('export default')
    expect(await loadPluginPackage(source)).toMatchObject({ activate: expect.any(Function) })
  })
})
