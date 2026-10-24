import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { HarnessPlugin } from '@latch/sdk'
import { PluginRegistry } from '@latch/core'
import { standardHarnessDriver } from '@latch/host/plugins/standard'

function plugin(dispose = vi.fn()): HarnessPlugin {
  return {
    id: 'example',
    name: 'Example',
    version: '1',
    description: 'fixture',
    activate(ctx) {
      ctx.registerProvider({
        id: 'test',
        name: 'Test',
        model: 'test',
        async *stream() {
          yield { type: 'text', text: 'ok' }
        },
      })
      ctx.registerTool({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        requiresApproval: false,
        async execute() {
          return { text: 'ok' }
        },
      })
      ctx.onDispose(dispose)
    },
  }
}

describe('plugin lifecycle', () => {
  it('continues cleanup in awaited reverse order after synchronous and asynchronous failures', async () => {
    const registry = new PluginRegistry()
    const order: string[] = []
    registry.register({
      ...plugin(),
      activate(ctx) {
        ctx.onDispose(() => {
          order.push('first')
        })
        ctx.onDispose(async () => {
          order.push('second:start')
          await Promise.resolve()
          order.push('second:end')
          throw new Error('async cleanup')
        })
        ctx.onDispose(() => {
          order.push('third')
          throw new Error('sync cleanup')
        })
      },
    })
    await registry.enable('example')
    await expect(registry.disable('example')).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'sync cleanup' }),
        expect.objectContaining({ message: 'async cleanup' }),
      ]),
    })
    expect(order).toEqual(['third', 'second:start', 'second:end', 'first'])
    await registry.disable('example')
    expect(order).toHaveLength(4)
  })

  it('pins capabilities for an active run and releases all registrations on disable', async () => {
    const context = new Context()
    const registry = new PluginRegistry(context)
    const dispose = vi.fn()
    registry.register(plugin(dispose))
    await registry.enable('example')
    expect(context.registry.size).toBe(1)
    const lease = registry.acquire('test')
    expect(lease.tools.map(t => t.name)).toEqual(['echo'])
    await expect(registry.disable('example')).rejects.toMatchObject({ code: 'plugin-in-use' })
    lease.release()
    lease.release()
    await registry.disable('example')
    expect(context.registry.size).toBe(0)
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => registry.acquire('test')).toThrow()
    await registry.enable('example')
    const next = registry.acquire('test')
    expect(next.provider.id).toBe('test')
    next.release()
    await registry.close()
    expect(context.registry.size).toBe(0)
  })

  it('rolls back partial activation when a plugin fails', async () => {
    const registry = new PluginRegistry()
    const dispose = vi.fn()
    const fixture = plugin(dispose)
    registry.register({
      ...fixture,
      async activate(ctx) {
        await fixture.activate(ctx)
        throw new Error('bad version')
      },
    })
    await expect(registry.enable('example')).rejects.toThrow('bad version')
    expect(registry.list()[0]).toMatchObject({ enabled: false, capabilities: [] })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the existing provider when replacement activation fails', async () => {
    const registry = new PluginRegistry()
    const previousDispose = vi.fn()
    registry.register(plugin(previousDispose))
    await registry.enable('example')
    const failedDispose = vi.fn()
    await expect(
      registry.replace({
        ...plugin(failedDispose),
        version: '2',
        async activate(ctx) {
          await plugin(failedDispose).activate(ctx)
          throw new Error('new activation failed')
        },
      }),
    ).rejects.toThrow('new activation failed')
    expect(registry.list()[0]).toMatchObject({ version: '1', enabled: true })
    const lease = registry.acquire('test')
    expect(lease.provider.model).toBe('test')
    lease.release()
    expect(previousDispose).not.toHaveBeenCalled()
    expect(failedDispose).toHaveBeenCalledOnce()
    await registry.close()
  })

  it('stages a Cordis generation without admitting leases until its persistence callback commits', async () => {
    const context = new Context()
    const registry = new PluginRegistry(context)
    const previousDispose = vi.fn()
    registry.register(plugin(previousDispose))
    await registry.enable('example')
    let releaseCommit!: () => void
    let enteredCommit!: () => void
    const gate = new Promise<void>(resolve => {
      releaseCommit = resolve
    })
    const entered = new Promise<void>(resolve => {
      enteredCommit = resolve
    })
    const replacement = registry.replace({ ...plugin(), version: '2' }, async () => {
      enteredCommit()
      await gate
    })
    await entered
    expect(context.registry.size).toBe(2)
    expect(registry.list()[0]).toMatchObject({ version: '1', enabled: true })
    expect(() => registry.acquire('test')).toThrow('正在变更')
    expect(previousDispose).not.toHaveBeenCalled()
    releaseCommit()
    await replacement
    expect(registry.list()[0]).toMatchObject({ version: '2', enabled: true })
    expect(context.registry.size).toBe(1)
    expect(previousDispose).toHaveBeenCalledOnce()
    const lease = registry.acquire('test')
    lease.release()
    await registry.close()
  })

  it('disposes the staged fiber and keeps the old generation when persistence fails', async () => {
    const context = new Context()
    const registry = new PluginRegistry(context)
    const oldDispose = vi.fn()
    const newDispose = vi.fn()
    registry.register(plugin(oldDispose))
    await registry.enable('example')
    await expect(
      registry.replace({ ...plugin(newDispose), version: '2' }, async () => {
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    expect(context.registry.size).toBe(1)
    expect(registry.list()[0]).toMatchObject({ version: '1', enabled: true })
    expect(newDispose).toHaveBeenCalledOnce()
    expect(oldDispose).not.toHaveBeenCalled()
    const lease = registry.acquire('test')
    lease.release()
    await registry.close()
  })

  it('keeps a Harness plugin leased for the full host lifetime, independently of provider runs', async () => {
    const context = new Context()
    const registry = new PluginRegistry(context)
    const dispose = vi.fn()
    const harnessPlugin: HarnessPlugin = {
      id: 'standard-harness',
      name: 'Standard',
      description: 'Fixture',
      version: '1',
      activate(ctx) {
        ctx.registerHarness(standardHarnessDriver)
        ctx.onDispose(dispose)
      },
    }
    registry.register(harnessPlugin)
    await registry.enable('standard-harness')
    expect(registry.list()[0]?.capabilities).toEqual(['harness:standard'])
    const lease = registry.acquireHarness('standard')
    expect(lease.driver).toBe(standardHarnessDriver)
    expect(registry.list()[0]?.activeRuns).toBe(1)
    await expect(registry.disable('standard-harness')).rejects.toMatchObject({ code: 'plugin-in-use' })
    expect(dispose).not.toHaveBeenCalled()
    lease.release()
    lease.release()
    await registry.disable('standard-harness')
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => registry.acquireHarness('standard')).toThrow()
    expect(context.registry.size).toBe(0)
    await registry.close()
  })

  it('publishes a replacement while the old generation is leased and disposes it after the last release', async () => {
    const context = new Context()
    const log = vi.fn()
    const registry = new PluginRegistry(context, log)
    const oldDispose = vi.fn(() => {
      throw new Error('late cleanup failed')
    })
    const newDispose = vi.fn()
    registry.register(plugin(oldDispose), { managed: 'provider' })
    await registry.enable('example')
    const running = registry.acquire('test')
    const runningProvider = running.provider
    await registry.replace({ ...plugin(newDispose), version: '2' })
    expect(registry.list()).toEqual([expect.objectContaining({ version: '2', enabled: true, managed: 'provider', activeRuns: 1 })])
    expect(context.registry.size).toBe(2)
    const next = registry.acquire('test')
    expect(next.provider).not.toBe(runningProvider)
    next.release()
    // Any generation in use keeps the plugin id busy for disable, unregister and close.
    await expect(registry.disable('example')).rejects.toMatchObject({ code: 'plugin-in-use' })
    await expect(registry.unregister('example')).rejects.toMatchObject({ code: 'plugin-in-use' })
    await expect(registry.close()).rejects.toMatchObject({ code: 'plugin-in-use' })
    expect(oldDispose).not.toHaveBeenCalled()
    running.release()
    running.release()
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Retired plugin example cleanup failed', expect.anything()))
    expect(oldDispose).toHaveBeenCalledOnce()
    expect(newDispose).not.toHaveBeenCalled()
    expect(registry.list()[0]?.activeRuns).toBe(0)
    await registry.close()
    expect(newDispose).toHaveBeenCalledOnce()
    expect(context.registry.size).toBe(0)
  })

  it('reports a committed replacement as successful when the old generation fails to clean up', async () => {
    const log = vi.fn()
    const registry = new PluginRegistry(new Context(), log)
    registry.register(
      plugin(
        vi.fn(() => {
          throw new Error('old cleanup failed')
        }),
      ),
    )
    await registry.enable('example')
    await expect(registry.replace({ ...plugin(), version: '2' })).resolves.toBeUndefined()
    expect(registry.list()[0]).toMatchObject({ version: '2', enabled: true })
    expect(log).toHaveBeenCalledWith('Replaced plugin example cleanup failed', expect.anything())
    await registry.close()
  })

  it('keeps a disabled plugin disabled across a preserving replace, without activating it', async () => {
    const registry = new PluginRegistry()
    registry.register(plugin(), { managed: 'provider' })
    const activate = vi.fn()
    await registry.replace({ ...plugin(), version: '2', activate }, undefined, { preserveEnabled: true })
    expect(activate).not.toHaveBeenCalled()
    expect(registry.list()[0]).toMatchObject({ version: '2', enabled: false, managed: 'provider', capabilities: [] })
    expect(() => registry.acquire('test')).toThrow()
    await registry.replace({ ...plugin(), version: '3' }, undefined, { preserveEnabled: true })
    expect(registry.list()[0]).toMatchObject({ version: '3', enabled: false })
    await registry.enable('example')
    await registry.replace({ ...plugin(), version: '4' }, undefined, { preserveEnabled: true })
    expect(registry.list()[0]).toMatchObject({ version: '4', enabled: true })
    await registry.close()
  })

  it('leases only the provider plugin for tool-free runs, so tool plugins stay free to change', async () => {
    const registry = new PluginRegistry()
    registry.register({
      id: 'provider',
      name: 'Provider',
      version: '1',
      description: 'fixture',
      activate(ctx) {
        ctx.registerProvider({
          id: 'test',
          name: 'Test',
          model: 'test',
          async *stream() {
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    })
    registry.register({
      id: 'tools',
      name: 'Tools',
      version: '1',
      description: 'fixture',
      activate(ctx) {
        ctx.registerTool({
          name: 'echo',
          description: 'Echo',
          parameters: {},
          requiresApproval: false,
          async execute() {
            return { text: 'ok' }
          },
        })
      },
    })
    await registry.enable('provider')
    await registry.enable('tools')
    const chat = registry.acquire('test', { tools: false })
    expect(chat.tools).toEqual([])
    expect(registry.list().map(item => [item.id, item.activeRuns])).toEqual([
      ['provider', 1],
      ['tools', 0],
    ])
    await registry.disable('tools')
    await registry.enable('tools')
    const agent = registry.acquire('test')
    expect(agent.tools.map(tool => tool.name)).toEqual(['echo'])
    await expect(registry.disable('tools')).rejects.toMatchObject({ code: 'plugin-in-use' })
    chat.release()
    agent.release()
    await registry.close()
  })

  it('lists enabled providers and harnesses and forgets an unregistered plugin', async () => {
    const context = new Context()
    const registry = new PluginRegistry(context)
    const dispose = vi.fn()
    registry.register(plugin(dispose), { managed: 'provider' })
    registry.register(
      {
        id: 'standard-harness',
        name: 'Standard',
        description: 'Fixture',
        version: '1',
        activate(ctx) {
          ctx.registerHarness(standardHarnessDriver)
        },
      },
      { managed: 'core' },
    )
    expect(registry.providers()).toEqual([])
    await registry.enable('example')
    await registry.enable('standard-harness')
    expect(registry.providers().map(provider => provider.id)).toEqual(['test'])
    expect(registry.harnesses()).toEqual([standardHarnessDriver])
    expect(registry.list().map(item => item.managed)).toEqual(['provider', 'core'])
    const lease = registry.acquire('test')
    await expect(registry.unregister('example')).rejects.toMatchObject({ code: 'plugin-in-use' })
    lease.release()
    await registry.unregister('example')
    expect(dispose).toHaveBeenCalledOnce()
    expect(registry.list().map(item => item.id)).toEqual(['standard-harness'])
    expect(registry.providers()).toEqual([])
    await expect(registry.unregister('example')).rejects.toMatchObject({ code: 'plugin-not-found' })
    registry.register(plugin())
    expect(registry.list().find(item => item.id === 'example')).not.toHaveProperty('managed')
    await registry.close()
    expect(context.registry.size).toBe(0)
  })
})
