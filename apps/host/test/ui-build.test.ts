import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import { readUiBuild } from '../src/ui-build.ts'
import { startTestHost } from './helpers/host.ts'

const clean: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close()
})

async function uiDir(content?: string) {
  const root = await mkdtemp(join(tmpdir(), 'latch-ui-build-'))
  clean.push(() => rm(root, { recursive: true, force: true }))
  if (content !== undefined) await writeFile(join(root, 'build.json'), content)
  return root
}

describe('the page build a Host reports', () => {
  it('stays the one beside the Host when it started, so a page rebuilt later sees an older Host', async () => {
    const root = await uiDir(JSON.stringify({ build: '20261107T080000Z-0a1b2c' }))
    const host = await startTestHost({ uiDir: root })
    clean.push(() => host.close())
    const device = await host.enroll({ listener: 'unix' })
    expect((await device.json<AppSnapshot>('snapshot')).build).toBe('20261107T080000Z-0a1b2c')
    await writeFile(join(root, 'build.json'), JSON.stringify({ build: '20261113T101500Z-abcdef' }))
    expect((await device.json<AppSnapshot>('snapshot')).build).toBe('20261107T080000Z-0a1b2c')
  })

  it('reports none without a well-formed build file', async () => {
    for (const content of [undefined, '{"build":"../../etc"}', 'not json']) {
      const host = await startTestHost({ uiDir: await uiDir(content) })
      clean.push(() => host.close())
      const device = await host.enroll({ listener: 'unix' })
      expect((await device.json<AppSnapshot>('snapshot')).build).toBeUndefined()
    }
  })

  it('reads only a small regular file, never a directory, a link or anything oversized', async () => {
    const good = JSON.stringify({ build: '20261107T080000Z-0a1b2c' })
    expect(await readUiBuild(await uiDir(good))).toBe('20261107T080000Z-0a1b2c')
    expect(await readUiBuild(await uiDir(JSON.stringify({ build: '20261107T080000Z-0a1b2c', pad: 'x'.repeat(2000) })))).toBeUndefined()
    const directory = await uiDir()
    await mkdir(join(directory, 'build.json'))
    expect(await readUiBuild(directory)).toBeUndefined()
    const target = await uiDir(good)
    const linked = await uiDir()
    await symlink(join(target, 'build.json'), join(linked, 'build.json'))
    expect(await readUiBuild(linked)).toBeUndefined()
  })
})
