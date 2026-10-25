import { connect } from 'node:net'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { createNetworkSink } = require('../src/network.cjs') as {
  createNetworkSink(): Promise<{ proxy: { mode: string; proxyRules: string; proxyBypassRules: string }; close(): Promise<void> }>
}
it('closes proxy connections without forwarding bytes and closes the owned listener idempotently', async () => {
  const sink = await createNetworkSink()
  const url = new URL(sink.proxy.proxyRules)
  expect(sink.proxy).toMatchObject({ mode: 'fixed_servers', proxyBypassRules: '<-loopback>' })
  expect(url.hostname).toBe('127.0.0.1')
  try {
    for (const request of ['CONNECT example.invalid:443 HTTP/1.1\r\n\r\n', 'GET http://example.invalid/ HTTP/1.1\r\n\r\n']) {
      const received = await new Promise<number>((resolve, reject) => {
        const socket = connect(Number(url.port), url.hostname)
        let bytes = 0
        socket.once('connect', () => socket.write(request))
        socket.on('data', chunk => {
          bytes += chunk.length
        })
        socket.on('error', error => {
          if (!('code' in error && error.code === 'ECONNRESET')) reject(error)
        })
        socket.once('close', () => resolve(bytes))
      })
      expect(received).toBe(0)
    }
  } finally {
    const closing = sink.close()
    expect(sink.close()).toBe(closing)
    await closing
  }
})
