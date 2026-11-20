import { expect } from 'vitest'
import type { TestDevice } from '@latch/testkit'

/** The device tools stay available while the desktop's browser-provider stream is open. */
export async function openSimulatorProvider(desktop: TestDevice) {
  const registered = await desktop.registerBrowserProvider()
  expect(registered.status).toBe(201)
  const { providerId } = (await registered.json()) as { providerId: string }
  const stream = await desktop.request('browser-provider/stream', { method: 'POST', body: { providerId } })
  expect(stream.status).toBe(200)
  // Undici closes an unread stream when its Response is collected.
  return () => stream.body?.cancel()
}
