import { chmod, lstat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { once } from 'node:events'
const signature = Buffer.from('\r\n\r\n\0\r\nQUIT\n')
/** The trusted gateway emits exactly TCP4/TCP6 PROXYv2, without TLVs or LOCAL mode. */
export function decodeProxyHeader(bytes: Buffer): { address: string; consumed: number } | undefined {
  if (bytes.length < 16) return
  if (!bytes.subarray(0, 12).equals(signature) || bytes[12] !== 0x21) throw new Error('Invalid gateway header')
  const family = bytes[13],
    length = bytes.readUInt16BE(14)
  if ((family !== 0x11 || length !== 12) && (family !== 0x21 || length !== 36)) throw new Error('Invalid gateway address')
  if (bytes.length < 16 + length) return
  const address =
    family === 0x11
      ? [...bytes.subarray(16, 20)].join('.')
      : Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(16 + i * 2).toString(16)).join(':')
  return { address, consumed: 16 + length }
}
export async function listenPrivateBackend(
  path: string,
  receive: (socket: Socket, address: string) => void,
): Promise<{ server: Server; close(): Promise<void> }> {
  if (!isAbsolute(path) || path.length > 100) throw new Error('Invalid backend path')
  const parent = await lstat(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Error('Invalid backend directory')
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0)
    const timer = setTimeout(() => socket.destroy(), 5000)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', data)
    }
    const data = (chunk: Buffer) => {
      socket.pause()
      try {
        // Preserve the first HTTP bytes without accumulating an attacker-selected length.
        const needed = Math.min(52 - bytes.length, chunk.length)
        bytes = Buffer.concat([bytes, chunk.subarray(0, needed)])
        const header = decodeProxyHeader(bytes)
        if (!header) {
          if (needed < chunk.length) throw new Error('Gateway header overflow')
          socket.resume()
          return
        }
        cleanup()
        const tail = Buffer.concat([bytes.subarray(header.consumed), chunk.subarray(needed)])
        if (tail.length) socket.unshift(tail)
        receive(socket, header.address)
        socket.resume()
      } catch {
        cleanup()
        socket.destroy()
      }
    }
    socket.once('close', cleanup)
    socket.on('error', () => {})
    socket.on('data', data)
  })
  server.listen(path)
  await once(server, 'listening')
  await chmod(path, 0o600)
  const identity = await lstat(path)
  return {
    server,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
      const actual = await lstat(path).catch(() => undefined)
      if (actual && actual.ino === identity.ino && actual.dev === identity.dev) await unlink(path)
    },
  }
}
