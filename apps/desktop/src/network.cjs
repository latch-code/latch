'use strict'
const { createServer } = require('node:net')

/** A live loopback sink avoids depending on an assumed-unused proxy port. */
async function createNetworkSink() {
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.destroy()
  })
  await new Promise(
    /** @param {(value?: void) => void} resolve */ (resolve, reject) => {
      const fail = error => {
        server.close(() => {})
        reject(error)
      }
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', fail)
        resolve()
      })
    },
  )
  server.unref()
  // A listener failure must not replace the configured sink with a direct route.
  server.on('error', () => {
    for (const socket of sockets) socket.destroy()
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Renderer proxy unavailable')
  let closing
  return {
    proxy: { mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${address.port}`, proxyBypassRules: '<-loopback>' },
    close() {
      closing ??= new Promise(resolve => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      })
      return closing
    },
  }
}
module.exports = { createNetworkSink }
