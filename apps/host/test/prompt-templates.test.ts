import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PromptTemplate } from '@latch/protocol'
import { PromptTemplateStore } from '../src/prompt-templates.ts'
const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'latch-prompts-'))
  directories.push(dir)
  return { dir, value: await PromptTemplateStore.open(dir) }
}
const template: PromptTemplate = { id: 'review', name: '检查改动', content: '检查这次改动\n并解释结果', scope: { kind: 'all' } }
describe('prompt template persistence', () => {
  it('replaces by stable ID, survives restart, and serializes concurrent writes without dropping another template', async () => {
    const { dir, value } = await store()
    await value.put(template)
    await value.put(template)
    expect(value.list()).toEqual([template])
    await Promise.all([
      value.put({ ...template, id: 'one' }),
      value.put({ ...template, id: 'two', scope: { kind: 'project', id: 'project' } }),
    ])
    expect((await PromptTemplateStore.open(dir)).list()).toHaveLength(3)
    await value.remove('review')
    await value.remove('review')
    expect(value.list()).toHaveLength(2)
  })
  it('keeps old memory on failed writes, recovers its queue, rechecks authorization at execution time and bounds input', async () => {
    const { dir, value } = await store()
    await value.put(template)
    await rm(dir, { recursive: true })
    await expect(value.put({ ...template, name: 'changed' })).rejects.toThrow()
    expect(value.list()[0]!.name).toBe(template.name)
    await mkdir(dir)
    await value.put({ ...template, name: 'recovered' })
    expect(value.list()[0]!.name).toBe('recovered')
    await expect(
      value.put(template, () => {
        throw new Error('revoked')
      }),
    ).rejects.toThrow('revoked')
    expect(value.list()[0]!.name).toBe('recovered')
    expect(() => value.put({ ...template, content: 'x'.repeat(20_001) })).toThrow()
  })
})
