import { afterEach, expect, it } from 'vitest'
import type { NativeLinkInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('reports phone access and no settings form: the listener is the Host start option here, and config and pause are gone', async () => {
  const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  const info = await desktop.json<NativeLinkInfo>('native/info')
  expect(info).toEqual({
    version: 1,
    enabled: true,
    directManaged: true,
    listening: { host: '127.0.0.1', port: host.host.nativePort },
    directory: false,
    relays: [],
  })
  for (const [method, path] of [
    ['PUT', 'native/config'],
    ['POST', 'native/input/pause'],
    ['POST', 'native/input/resume'],
  ] as const)
    expect((await desktop.request(path, { method, body: {} })).status).toBe(404)
})
