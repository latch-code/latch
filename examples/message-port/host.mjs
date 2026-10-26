import { MessageChannel } from 'node:worker_threads'
import { randomBytes } from 'node:crypto'
import { createMessageTransportDriver } from '@latch/host/transports'

export const descriptor = Object.freeze({
  version: 1,
  driverId: 'local-message-port',
  channelId: 'local-example',
  endpoint: 'messageport://local/',
})

function carrier(port) {
  const closed = new Promise(resolve => port.once('close', resolve))
  return {
    maximumMessageBytes: 1024,
    closed,
    async send(bytes, signal) {
      signal.throwIfAborted()
      port.postMessage(Uint8Array.from(bytes))
    },
    subscribe(message, ended) {
      port.on('message', message)
      port.on('close', ended)
      return () => {
        port.off('message', message)
        port.off('close', ended)
      }
    },
    async close() {
      port.close()
      await closed
    },
  }
}

let accept
const connections = new Set()
const driver = createMessageTransportDriver({
  descriptor,
  async open(signal) {
    signal.throwIfAborted()
    if (!accept) throw new Error('Configure native connections before using this local example')
    const { port1, port2 } = new MessageChannel(),
      host = carrier(port1),
      client = carrier(port2),
      connectionId = randomBytes(16),
      item = { host, client }
    connections.add(item)
    void Promise.all([host.closed, client.closed]).then(() => connections.delete(item))
    void accept({ carrier: host, connectionId }).catch(async () => {
      await Promise.all([host.close(), client.close()])
    })
    return { carrier: client, connectionId }
  },
  async listen(signal, onConnection) {
    accept = onConnection
    let finish
    const closed = new Promise(resolve => {
      finish = resolve
    })
    const close = async () => {
      accept = undefined
      await Promise.all([...connections].map(item => Promise.all([item.host.close(), item.client.close()])))
      signal.removeEventListener('abort', abort)
      finish()
    }
    const abort = () => {
      void close()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) await close()
    return { closed, close }
  },
})

export default {
  id: 'local-message-example',
  name: 'MessagePort 本机示例',
  version: '1.0.0',
  description: '只演示本进程双向消息载体，不连接网络或消息平台。',
  activate(context) {
    context.registerTransport(driver)
  },
}
