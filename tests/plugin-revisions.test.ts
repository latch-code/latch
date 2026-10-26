import { afterEach, expect, test, vi } from 'vitest'
import { PluginRegistry } from '@latch/core'
import type { HarnessPlugin } from '@latch/sdk'
const registries: PluginRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close()
})
function plugin(id: string, text: string, dispose = () => {}): HarnessPlugin {
  return {
    id,
    name: id,
    version: 'same-version',
    description: '',
    activate(ctx) {
      if (id === 'provider')
        ctx.registerProvider({
          id: 'fixture',
          name: 'fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: 'answer' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      else {
        ctx.registerTool({
          name: 'selected_tool',
          description: '',
          parameters: {},
          requiresApproval: false,
          async execute() {
            return { text }
          },
        })
        ctx.registerSkill({ id: 'skill', name: 'skill', description: '', content: text })
      }
      ctx.onDispose(dispose)
    },
  }
}
async function fixture(stable = false) {
  const registry = new PluginRegistry()
  registries.push(registry)
  registry.register(plugin('provider', ''), stable ? { revision: '1'.repeat(64) } : {})
  registry.register(plugin('selected', 'first'), stable ? { revision: '2'.repeat(64) } : {})
  await registry.enable('provider')
  await registry.enable('selected')
  return registry
}
const options = (registry: PluginRegistry) => ({
  pluginIds: ['selected'],
  expectedRevisions: registry.revisionSnapshot(['provider', 'selected']).revisions,
})

test('uses supplied full applied revisions across a restart, without treating semver as authority', async () => {
  const first = await fixture(true),
    second = await fixture(true)
  expect(first.providerOwner('fixture')).toBe('provider')
  expect(first.revisionSnapshot(['selected', 'provider', 'selected'])).toEqual(second.revisionSnapshot(['provider', 'selected']))
  expect(first.revisionSnapshot(['provider', 'selected']).persistent).toBe(true)
  const grant = options(first)
  const lease = second.acquire('fixture', grant)
  expect(lease.tools.map(tool => tool.name)).toEqual(['selected_tool'])
  lease.release()
  await second.replace(plugin('selected', 'changed'), undefined, { revision: '3'.repeat(64) })
  expect(() => second.acquire('fixture', grant)).toThrow('插件已更新')
  expect(second.list().every(item => item.activeRuns === 0)).toBe(true)
})

test('bounds a legacy closure to its actual activation, including disable/enable and replacement without a supplied digest', async () => {
  const registry = await fixture(),
    other = await fixture()
  expect(registry.revisionSnapshot(['provider', 'selected']).persistent).toBe(false)
  expect(options(registry).expectedRevisions).not.toEqual(options(other).expectedRevisions)
  const first = options(registry)
  await registry.disable('selected')
  await registry.enable('selected')
  expect(() => registry.acquire('fixture', first)).toThrow('插件已更新')
  const stable = await fixture(true),
    grant = options(stable)
  await stable.replace(plugin('selected', 'changed-with-same-semver'))
  expect(stable.revisionSnapshot(['selected']).persistent).toBe(false)
  expect(() => stable.acquire('fixture', grant)).toThrow('插件已更新')
})

test('keeps a leased generation alive but refuses a stale saved grant after replacement', async () => {
  const registry = await fixture(true),
    dispose = vi.fn()
  await registry.replace(plugin('selected', 'leased old code', dispose), undefined, { revision: '4'.repeat(64) })
  const grant = options(registry),
    lease = registry.acquire('fixture', grant)
  await registry.replace(plugin('selected', 'new code'), undefined, { revision: '5'.repeat(64) })
  expect(dispose).not.toHaveBeenCalled()
  const context = { sessionId: 'test', callId: 'test', workspaceRoot: '/unused', signal: new AbortController().signal }
  expect(await lease.tools[0]!.execute({}, context)).toEqual({ text: 'leased old code' })
  expect(() => registry.acquire('fixture', grant)).toThrow('插件已更新')
  lease.release()
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
})

test('requires the actual provider and every selected owner in a saved grant and fails during staged mutation', async () => {
  const registry = await fixture(true),
    full = options(registry)
  expect(() => registry.acquire('fixture', { ...full, expectedRevisions: { selected: full.expectedRevisions.selected! } })).toThrow(
    '缺少实际插件修订',
  )
  let release!: () => void, staged!: () => void
  const waiting = new Promise<void>(done => {
    staged = done
  })
  const hold = new Promise<void>(done => {
    release = done
  })
  const replacement = registry.replace(
    plugin('selected', 'staged'),
    async () => {
      staged()
      await hold
    },
    { revision: '6'.repeat(64) },
  )
  await waiting
  expect(() => registry.acquire('fixture', full)).toThrow('正在变更')
  release()
  await replacement
  expect(() => registry.acquire('fixture', full)).toThrow('插件已更新')
})

test('keeps prototype-shaped package identities as ordinary, checked revision keys', async () => {
  const registry = await fixture(true)
  registry.register(
    {
      id: '__proto__',
      name: 'special',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerSkill({ id: 's', name: 's', description: '', content: 'checked' })
      },
    },
    { revision: '7'.repeat(64) },
  )
  await registry.enable('__proto__')
  const snapshot = registry.revisionSnapshot(['provider', '__proto__'])
  expect(Object.hasOwn(snapshot.revisions, '__proto__')).toBe(true)
  const lease = registry.acquire('fixture', { pluginIds: ['__proto__'], expectedRevisions: snapshot.revisions })
  expect(lease.skills?.map(skill => skill.content)).toEqual(['checked'])
  lease.release()
})
