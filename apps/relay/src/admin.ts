import { request } from 'node:http'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
export async function requestPrivateAdmin(dataDir: string, path: string, body?: string): Promise<string> {
  const root = await lstat(dataDir),
    socketPath = join(dataDir, 'admin.sock'),
    socket = await lstat(socketPath)
  if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077 || !socket.isSocket() || socket.mode & 0o077)
    throw new Error('Private relay management unavailable')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: path === '/status' || path === '/healthz' ? 'GET' : 'POST',
        headers: {
          Host: 'latch-relay-admin',
          'x-latch-relay-admin': '1',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : { 'Content-Length': '0' }),
        },
        signal: AbortSignal.timeout(3000),
      },
      response => {
        let text = ''
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString()
          if (text.length > 32768) req.destroy(new Error('Administrative response limit'))
        })
        response.on('end', () => {
          if (response.statusCode !== 200) reject(new Error('Administrative operation failed or result unknown'))
          else resolve(text)
        })
        response.on('error', () => reject(new Error('Administrative result unknown')))
      },
    )
    req.on('error', () => reject(new Error('Administrative result unknown')))
    req.end(body)
  })
}
