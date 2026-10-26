import { describe, expect, it, vi } from 'vitest'
import type { LatchPlugin, TransportDriver } from '@latch/sdk'
import { PluginRegistry } from '@latch/core'

const driver: TransportDriver = {
  id: 'test-message',
  profile: 'native-stream-v1',
  async open() {
    throw new Error('Not connected')
  },
}
function plugin(dispose = vi.fn()): LatchPlugin {
  return {
    id: 'transport-plugin',
    name: 'Transport fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerTransport(driver)
      context.onDispose(dispose)
    },
  }
}
describe('transport plugin leases', () => {
  it('keeps the old generation until its connection really releases and refuses new leases after retire', async () => {
    const registry = new PluginRegistry(),
      first = vi.fn(),
      second = vi.fn()
    registry.register(plugin(first))
    await registry.enable('transport-plugin')
    expect(registry.list()[0]?.capabilities).toEqual(['transport:test-message'])
    const old = registry.acquireTransport('test-message')
    await registry.replace(plugin(second))
    await old.invalidated
    expect(first).not.toHaveBeenCalled()
    const next = registry.acquireTransport('test-message')
    await registry.retire('transport-plugin')
    expect(() => registry.acquireTransport('test-message')).toThrow('请先安装')
    next.release()
    old.release()
    old.release()
    await registry.close()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
  it('stops acquisitions immediately but waits for real transport settlement before disabling code', async () => {
    const registry = new PluginRegistry(),
      dispose = vi.fn(),
      settled = vi.fn()
    registry.register(plugin(dispose))
    await registry.enable('transport-plugin')
    const lease = registry.acquireTransport('test-message'),
      pending = registry.disable('transport-plugin').then(settled)
    await lease.invalidated
    expect(lease.isCurrent()).toBe(false)
    expect(() => registry.acquireTransport('test-message')).toThrow('请先安装')
    expect(dispose).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    lease.release()
    await pending
    expect(dispose).toHaveBeenCalledTimes(1)
    await registry.close()
  })
  it('rolls back an activation with duplicate or invalid transport declarations', async () => {
    const registry = new PluginRegistry(),
      dispose = vi.fn()
    registry.register(plugin())
    await registry.enable('transport-plugin')
    registry.register({ ...plugin(dispose), id: 'duplicate' })
    await expect(registry.enable('duplicate')).rejects.toMatchObject({ code: 'transport-exists' })
    // Release a real lease before closing; the failed candidate never owns it.
    const live = registry.acquireTransport('test-message')
    expect(live.driver.profile).toBe('native-stream-v1')
    live.release()
    await registry.retire('transport-plugin')
    registry.register({
      ...plugin(),
      id: 'invalid',
      activate(context) {
        context.registerTransport({ ...driver, id: '../bad' })
      },
    })
    await expect(registry.enable('invalid')).rejects.toMatchObject({ code: 'transport-invalid' })
    await registry.close()
  })
})
