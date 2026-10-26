import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import type { MessageCarrier } from '@latch/link-client'
import { createMessageTransportDriver } from '../../src/message-transport-driver.ts'

/** In-process carrier only; the native TLS/HTTP/body-window consumers remain real. */
export function messageCarrierFixture() {
  const descriptor = { version: 1 as const, driverId: 'interactive-fixture', channelId: 'public-room', endpoint: 'message://fixture/' }
  type Routed = Parameters<NonNullable<Parameters<typeof createMessageTransportDriver>[0]['listen']>>[1]
  let accept: Routed | undefined,
    finish: () => void = () => {}
  const active = new Set<Promise<void>>(),
    closers = new Set<() => Promise<void>>(),
    listen = vi.fn(async (signal: AbortSignal, onConnection: Routed) => {
      accept = onConnection
      const closed = new Promise<void>(resolve => {
        finish = resolve
      })
      const close = async () => {
        accept = undefined
        for (const end of closers) await end()
        await Promise.allSettled([...active])
        finish()
      }
      signal.addEventListener('abort', () => void close(), { once: true })
      return { closed, close }
    })
  let lost = false,
    duplicates = 0
  const driver = createMessageTransportDriver({
    descriptor,
    listen,
    async open(signal) {
      signal.throwIfAborted()
      if (!accept) throw new Error('Fixture has no listener')
      type Side = { message?: (bytes: Uint8Array) => void; closed?: () => void }
      const sides: Side[] = [{}, {}]
      let finish = () => {}
      const closed = new Promise<void>(resolve => {
        finish = resolve
      })
      let ended = false
      const close = async () => {
        if (ended) return
        ended = true
        for (const side of sides) side.closed?.()
        closers.delete(close)
        finish()
      }
      closers.add(close)
      const carriers: MessageCarrier[] = sides.map((side, index) => ({
        maximumMessageBytes: 1024,
        closed,
        async send(bytes, stop) {
          stop.throwIfAborted()
          if (ended) throw new Error('Fixture closed')
          if (index === 0 && bytes[1] === 1 && !lost) {
            lost = true
            return
          }
          queueMicrotask(() => sides[1 - index]!.message?.(Uint8Array.from(bytes)))
          if (bytes[1] === 1 && duplicates < 2) {
            duplicates++
            queueMicrotask(() => sides[1 - index]!.message?.(Uint8Array.from(bytes)))
          }
        },
        subscribe(message, closed) {
          side.message = message
          side.closed = closed
          return () => {
            delete side.message
            delete side.closed
          }
        },
        close,
      }))
      const connectionId = randomBytes(16),
        pending = accept({ carrier: carriers[1]!, connectionId })
      active.add(pending)
      void pending.finally(() => active.delete(pending)).catch(() => {})
      return { carrier: carriers[0]!, connectionId }
    },
  })
  return {
    descriptor,
    driver,
    listen,
    lost: () => lost,
    async close() {
      for (const end of closers) await end()
      finish()
    },
  }
}
