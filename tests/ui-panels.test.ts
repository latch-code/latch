import { describe, expect, it, vi } from 'vitest'
import { isUiPanelDocument } from '@latch/protocol'
import { PluginRegistry } from '@latch/core'
import type { HarnessPlugin, UiPanelDefinition } from '@latch/sdk'

const session = {
  id: 'task-panel',
  title: 'Read the changes',
  status: 'idle' as const,
  updatedAt: '2026-10-25T00:00:00.000Z',
  harnessId: 'standard',
}
const context = () => ({ session: structuredClone(session), signal: new AbortController().signal })
const panel = (text = 'Ready'): UiPanelDefinition => ({
  id: 'summary',
  title: 'Summary',
  harnessIds: ['standard'],
  render: () => ({ blocks: [{ type: 'text', text }] }),
})
const plugin = (definition = panel(), dispose = () => {}): HarnessPlugin => ({
  id: 'work-notes',
  name: 'Work notes',
  version: '1',
  description: 'Session panel fixture',
  activate(ctx) {
    ctx.registerUiPanel(definition)
    ctx.onDispose(dispose)
  },
})

describe('Cordis UI panels', () => {
  it('publishes only enabled contributions and never exposes the render callback to clients', async () => {
    const registry = new PluginRegistry()
    registry.register(plugin())
    expect(registry.uiPanels()).toEqual([])
    await registry.enable('work-notes')
    expect(registry.uiPanels()).toEqual([
      { id: 'work-notes:summary', pluginId: 'work-notes', pluginName: 'Work notes', title: 'Summary', harnessIds: ['standard'] },
    ])
    const lease = registry.acquireUiPanel('work-notes:summary')
    expect(await lease.render(context())).toEqual({ blocks: [{ type: 'text', text: 'Ready' }] })
    lease.release()
    await registry.disable('work-notes')
    expect(registry.uiPanels()).toEqual([])
    expect(() => registry.acquireUiPanel('work-notes:summary')).toThrow()
    await registry.close()
  })

  it('pins a generation while a panel renders, then disposes it after replacement and release', async () => {
    const registry = new PluginRegistry()
    const disposed = vi.fn()
    let finish!: () => void
    const waiting = new Promise<void>(done => {
      finish = done
    })
    registry.register(
      plugin(
        {
          ...panel(),
          async render() {
            await waiting
            return { blocks: [{ type: 'text', text: 'Old' }] }
          },
        },
        disposed,
      ),
    )
    await registry.enable('work-notes')
    const lease = registry.acquireUiPanel('work-notes:summary')
    const rendering = lease.render(context())
    await expect(registry.disable('work-notes')).rejects.toMatchObject({ code: 'plugin-in-use' })
    await registry.replace({ ...plugin(panel('New')), version: '2' })
    expect(disposed).not.toHaveBeenCalled()
    const next = registry.acquireUiPanel('work-notes:summary')
    expect(await next.render(context())).toEqual({ blocks: [{ type: 'text', text: 'New' }] })
    next.release()
    finish()
    expect(await rendering).toEqual({ blocks: [{ type: 'text', text: 'Old' }] })
    lease.release()
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    await registry.close()
  })

  it('copies metadata and session state, and rejects duplicate local panel IDs', async () => {
    const registry = new PluginRegistry()
    const definition = panel()
    definition.render = ctx => {
      ctx.session.title = 'Plugin copy'
      return { blocks: [{ type: 'text', text: ctx.session.title }] }
    }
    registry.register(plugin(definition))
    await registry.enable('work-notes')
    definition.harnessIds!.push('other')
    const list = registry.uiPanels()
    list[0]!.harnessIds!.push('mutated')
    expect(registry.uiPanels()[0]!.harnessIds).toEqual(['standard'])
    const lease = registry.acquireUiPanel('work-notes:summary')
    const input = context()
    await lease.render(input)
    expect(input.session.title).toBe(session.title)
    lease.release()
    registry.register({
      ...plugin(),
      id: 'duplicates',
      activate(ctx) {
        ctx.registerUiPanel(panel())
        ctx.registerUiPanel(panel())
      },
    })
    await expect(registry.enable('duplicates')).rejects.toMatchObject({ code: 'ui-panel-exists' })
    expect(registry.uiPanels()).toHaveLength(1)
    await registry.close()
  })

  it('returns a plain failure when a plugin throws and rejects executable or oversized content', async () => {
    const registry = new PluginRegistry(undefined, () => {})
    registry.register(
      plugin({
        ...panel(),
        render() {
          throw new Error('private /Users/me/key-file')
        },
      }),
    )
    await registry.enable('work-notes')
    const lease = registry.acquireUiPanel('work-notes:summary')
    await expect(lease.render(context())).rejects.toMatchObject({ code: 'ui-panel-failed', message: '扩展面板暂时无法读取，请稍后重试。' })
    lease.release()
    await registry.close()
    expect(isUiPanelDocument({ blocks: [{ type: 'html', html: '<script>alert(1)</script>' }] })).toBe(false)
    expect(isUiPanelDocument({ blocks: [{ type: 'text', text: 'Hello', onClick: 'run' }] })).toBe(false)
    expect(isUiPanelDocument({ blocks: [{ type: 'table', columns: ['A'], rows: [['one', 'two']] }] })).toBe(false)
    expect(isUiPanelDocument({ blocks: Array.from({ length: 32 }, () => ({ type: 'code', text: 'x'.repeat(32_000) })) })).toBe(false)
  })
})
