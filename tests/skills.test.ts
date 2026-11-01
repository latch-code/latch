import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntime, createSnapshotStore, PluginRegistry } from '@latch/core'
import type { HarnessPlugin, ModelMessage, SkillDefinition } from '@latch/sdk'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const skill = (content: string): SkillDefinition => ({ id: 'review', name: 'Review', description: 'Review input', content })
const plugin = (definition: SkillDefinition, dispose = () => {}): HarnessPlugin => ({
  id: 'review-pack',
  name: 'Review package',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerSkill(definition)
    ctx.onDispose(dispose)
  },
})

describe('package skills in Standard runs', () => {
  it('persists a run snapshot, pins its package through replacement, then uses the next version on the next input', async () => {
    const path = await mkdtemp(join(tmpdir(), 'latch-skills-'))
    cleanups.push(() => rm(path, { recursive: true, force: true }))
    const registry = new PluginRegistry()
    cleanups.push(() => registry.close())
    let finish!: () => void
    const hold = new Promise<void>(done => {
      finish = done
    })
    const seen: ModelMessage[][] = []
    registry.register({
      id: 'provider',
      name: 'Fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'fixture',
          name: 'Fixture',
          model: 'fixture',
          async *stream({ messages }) {
            seen.push(structuredClone(messages))
            if (seen.length === 1) await hold
            yield { type: 'text', text: 'Done' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    })
    await registry.enable('provider')
    const disposed = vi.fn()
    const first = skill('First instructions')
    registry.register(plugin(first, disposed))
    await registry.enable('review-pack')
    first.content = 'Changed after registration'
    const runtime = createRuntime({ dataDir: path, workspaceRoot: path, registry, providerId: 'fixture' })
    cleanups.push(() => runtime.close())
    cleanups.push(async () => {
      finish()
    })
    const { sessionId } = await runtime.createTask({ prompt: 'Review', requestId: 'first', mode: 'chat' })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]?.[1]).toEqual({ role: 'system', content: '# Review (review-pack:review)\nFirst instructions' })
    await expect(registry.disable('review-pack')).rejects.toMatchObject({ code: 'plugin-in-use' })
    await registry.replace(plugin(skill('Second instructions')))
    expect(disposed).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    expect((await runtime.detail(sessionId)).summary.skills).toEqual(['review-pack:review'])
    await runtime.close()
    const store = createSnapshotStore(path)
    const state = await store.load()
    expect(state.tasks[sessionId]?.skillContext).toContain('First instructions')
    expect(state.tasks[sessionId]?.summary.skills).toEqual(['review-pack:review'])
    await store.close()
    const restored = createRuntime({ dataDir: path, workspaceRoot: path, registry, providerId: 'fixture' })
    cleanups.push(() => restored.close())
    await restored.prompt(sessionId, 'Again', 'second')
    await vi.waitFor(async () => expect((await restored.detail(sessionId)).summary.status).toBe('idle'))
    expect(seen[1]?.[1]?.content).toContain('Second instructions')
    expect(seen[1]?.some(message => message.content.includes('First instructions'))).toBe(false)
    await registry.disable('review-pack')
    await restored.prompt(sessionId, 'Without skills', 'third')
    await vi.waitFor(async () => expect((await restored.detail(sessionId)).summary.status).toBe('idle'))
    expect(seen[2]?.filter(message => message.role === 'system')).toHaveLength(1)
    expect((await restored.detail(sessionId)).summary.skills).toBeUndefined()
    expect(await readFile(join(path, 'runtime.json'), 'utf8')).not.toContain('Second instructions')
  })

  it('rejects duplicate skill IDs atomically', async () => {
    const registry = new PluginRegistry()
    registry.register({
      ...plugin(skill('One')),
      activate(ctx) {
        ctx.registerSkill(skill('One'))
        ctx.registerSkill(skill('Two'))
      },
    })
    await expect(registry.enable('review-pack')).rejects.toMatchObject({ code: 'skill-exists' })
    expect(registry.skills()).toEqual([])
    await registry.close()
  })
})
