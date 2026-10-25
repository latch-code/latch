import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, UiPanelDocument } from '@latch/protocol'
import type { UiPanelDefinition } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(panel: UiPanelDefinition) {
  const t = await startTestHost({
    plugins: [
      {
        id: 'panel-fixture',
        name: 'Panel fixture',
        version: '1',
        description: 'Only test data',
        activate(ctx) {
          ctx.registerUiPanel(panel)
        },
      },
    ],
  })
  cleanups.push(() => t.close())
  const admin = await t.enroll({ listener: 'unix' })
  const { sessionId } = await admin.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat' },
  })
  return { t, admin, sessionId, path: `tasks/${sessionId}/ui-panels/${encodeURIComponent('panel-fixture:summary')}` }
}

describe('session UI panel API', () => {
  it('serves trusted client modules only to viewing devices at their exact current digest', async () => {
    const source = 'export default function Review() { return null }'
    const t = await startTestHost({
      plugins: [
        {
          id: 'client-package',
          name: 'Review',
          version: '1',
          description: '',
          activate(ctx) {
            ctx.registerClientPanel({ id: 'review', title: 'Review', source })
            ctx.registerSkill({ id: 'skill', name: 'Review', description: 'A skill', content: 'Private model instructions' })
          },
        },
      ],
    })
    cleanups.push(() => t.close())
    const admin = await t.enroll({ listener: 'unix' })
    const snapshot = await admin.json<AppSnapshot>('snapshot')
    const info = snapshot.catalog!.uiPanels![0]!
    expect(info.moduleHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(snapshot.catalog)).not.toContain(source)
    expect(JSON.stringify(snapshot.catalog)).not.toContain('Private model instructions')
    const path = `ui-modules/${encodeURIComponent(info.id)}/${info.moduleHash}.mjs`
    expect((await t.raw('loopback-tcp', `api/${path}`)).status).toBe(401)
    const reader = await t.enroll({ scopes: ['view'] })
    const response = await reader.request(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe(source)
    expect((await reader.request(path.replace(info.moduleHash!, '0'.repeat(64)))).status).toBe(404)
    await admin.json(`devices/${reader.id}`, { method: 'DELETE' })
    expect((await reader.request(path)).status).toBe(401)
    await admin.json('plugins/client-package', { method: 'POST', body: { enabled: false } })
    expect((await admin.request(path)).status).toBe(404)
  })

  it('requires a viewing device, binds a panel to the actual harness, and offers no action endpoint', async () => {
    const render = vi.fn<UiPanelDefinition['render']>(({ session }) => ({
      blocks: [{ type: 'facts', items: [{ label: 'Session', value: session.id }] }],
    }))
    const { t, admin, sessionId, path } = await fixture({ id: 'summary', title: 'Summary', harnessIds: ['standard'], render })
    const snapshot = await admin.json<AppSnapshot>('snapshot')
    expect(snapshot.catalog?.uiPanels).toEqual([
      { id: 'panel-fixture:summary', title: 'Summary', pluginId: 'panel-fixture', pluginName: 'Panel fixture', harnessIds: ['standard'] },
    ])
    expect(render).not.toHaveBeenCalled()
    expect((await t.raw('loopback-tcp', `api/${path}`)).status).toBe(401)
    expect(render).not.toHaveBeenCalled()
    const reader = await t.enroll({ scopes: ['view'] })
    expect(await reader.json(path)).toEqual({ panel: { blocks: [{ type: 'facts', items: [{ label: 'Session', value: sessionId }] }] } })
    expect((await admin.request(path, { method: 'POST', body: {} })).status).toBe(404)
    expect(render).toHaveBeenCalledOnce()
    await admin.json('plugins/panel-fixture', { method: 'POST', body: { enabled: false } })
    expect((await admin.json<AppSnapshot>('snapshot')).catalog?.uiPanels).toEqual([])
    expect((await reader.request(path)).status).toBe(404)
    expect(render).toHaveBeenCalledOnce()
  })

  it('does not invoke a panel declared for another harness or for a missing session', async () => {
    const render = vi.fn(() => ({ blocks: [] }))
    const { admin, path } = await fixture({ id: 'summary', title: 'Summary', harnessIds: ['other-driver'], render })
    expect((await admin.request(path)).status).toBe(404)
    expect((await admin.request(path.replace(/tasks\/[^/]+/u, 'tasks/missing'))).status).toBe(404)
    expect(render).not.toHaveBeenCalled()
  })

  it('rechecks a revocation after an asynchronous panel read before releasing its data', async () => {
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(done => {
      entered = done
    })
    const waiting = new Promise<void>(done => {
      finish = done
    })
    const { t, admin, path } = await fixture({
      id: 'summary',
      title: 'Summary',
      async render() {
        entered()
        await waiting
        return { blocks: [{ type: 'text', text: 'Private session data' }] }
      },
    })
    const reader = await t.enroll({ scopes: ['view'] })
    const pending = reader.request(path)
    await started
    await admin.json(`devices/${reader.id}`, { method: 'DELETE' })
    finish()
    const response = await pending
    expect(response.status).toBe(401)
    const body = await response.text()
    expect(body).toContain('device-revoked')
    expect(body).not.toContain('Private session data')
  })

  it('rejects unsupported content without echoing private plugin errors', async () => {
    const { admin, path } = await fixture({
      id: 'summary',
      title: 'Summary',
      render() {
        return { blocks: [{ type: 'html', text: '<img src="https://outside.test/p">' }] } as unknown as UiPanelDocument
      },
    })
    const response = await admin.request(path)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'ui-panel-invalid' })
  })
})
