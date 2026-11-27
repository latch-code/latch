import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
const execute = promisify(execFile)
interface GatewayCapacity {
  maxHandshakes: number
  handshakesPerSecond: number
  handshakeBurst: number
  prefixFraction: number
}
export interface GatewayOptions extends GatewayCapacity {
  binary: string
}
const event = z.discriminatedUnion('event', [
  z.object({ event: z.literal('tls-reloaded'), generation: z.number().int().min(1).max(0xffffffff), accepted: z.boolean() }).strict(),
  z.object({ event: z.literal('acme-tls-updated'), generation: z.number().int().min(1).max(0xffffffff), accepted: z.boolean() }).strict(),
  z.object({ event: z.literal('ready'), port: z.number().int().min(1).max(65535), protocol: z.literal(2) }).strict(),
  z
    .object({
      event: z.literal('heartbeat'),
      connections: z.number().int().min(0).max(20000),
      handshakes: z.number().int().min(0).max(4096),
      rejected: z.number().int().min(0),
      forwardedBytes: z.number().int().min(0),
    })
    .strict(),
])
/**
 * `timeoutMs`: the build waits longer, because macOS scans a freshly linked executable on its first run and a busy
 * machine can take several seconds before the binary prints anything.
 */
export async function checkGateway(binary: string, timeoutMs = 3000): Promise<void> {
  if (!isAbsolute(binary)) throw new Error('Gateway executable must be absolute')
  const info = await lstat(binary)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o022 || !(info.mode & 0o111)) throw new Error('Invalid gateway executable')
  const output = await execute(binary, ['version'], { timeout: timeoutMs, maxBuffer: 1024, env: {} })
  const version = z
    .object({ protocol: z.literal(2), go: z.string() })
    .strict()
    .parse(JSON.parse(output.stdout) as unknown)
  const match = /^go1\.(26|27)\.(\d+)$/u.exec(version.go)
  if (!match || Number(match[2]) < (match[1] === '26' ? 10 : 3)) throw new Error('Gateway requires a patched Go TLS runtime')
}
export async function startGateway(
  input: GatewayOptions & {
    backend: string
    host: string
    port: number
    cert: string | Buffer
    key: string | Buffer
    allowKeyRotation?: boolean
    maxConnections: number
  },
): Promise<{
  port: number
  healthy(): boolean
  drain(): void
  reloadTls(cert: string | Buffer, key: string | Buffer): Promise<void>
  setAcmeTls(cert: string | Buffer | null, key: string | Buffer | null): Promise<void>
  close(): Promise<void>
  stats(): { connections: number; handshakes: number; rejected: number; forwardedBytes: number }
}> {
  await checkGateway(input.binary)
  const config = JSON.stringify({
    host: input.host,
    port: input.port,
    backend: input.backend,
    certificate: input.cert.toString(),
    key: input.key.toString(),
    ...(input.allowKeyRotation ? { allowKeyRotation: true } : {}),
    maxConnections: input.maxConnections,
    maxHandshakes: input.maxHandshakes,
    handshakesPerSecond: input.handshakesPerSecond,
    handshakeBurst: input.handshakeBurst,
    prefixFraction: input.prefixFraction,
  })
  if (Buffer.byteLength(config) > 64 * 1024 - 1) throw new Error('Gateway configuration limit')
  const child: ChildProcessWithoutNullStreams = spawn(input.binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
  let exited = false,
    lastHeartbeat = Date.now(),
    tail = '',
    readyPort = 0
  let status = { connections: 0, handshakes: 0, rejected: 0, forwardedBytes: 0 }
  let generation = 0
  let reloading:
    | {
        kind: 'tls-reloaded' | 'acme-tls-updated'
        generation: number
        resolve(): void
        reject(error: Error): void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  const exit = new Promise<void>(resolve => {
    child.once('exit', () => {
      exited = true
      if (reloading) {
        clearTimeout(reloading.timer)
        reloading.reject(new Error('TLS reload result unknown'))
        reloading = undefined
      }
      resolve()
    })
    child.once('error', () => {
      exited = true
      resolve()
    })
  })
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Gateway startup timeout'))
      child.kill('SIGKILL')
    }, 5000)
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('Gateway startup failed'))
    })
    child.once('exit', () => {
      clearTimeout(timer)
      if (!readyPort) reject(new Error('Gateway startup failed'))
    })
    child.stdout.on('data', (bytes: Buffer) => {
      tail += bytes.toString('utf8')
      if (tail.length > 8192) {
        child.kill('SIGKILL')
        return
      }
      for (;;) {
        const end = tail.indexOf('\n')
        if (end < 0) break
        const line = tail.slice(0, end)
        tail = tail.slice(end + 1)
        try {
          const parsed = event.parse(JSON.parse(line) as unknown)
          if (parsed.event === 'ready') {
            if (readyPort) throw new Error('Duplicate ready')
            readyPort = parsed.port
            clearTimeout(timer)
            resolve(parsed.port)
          } else if (parsed.event === 'tls-reloaded' || parsed.event === 'acme-tls-updated') {
            if (!reloading || parsed.event !== reloading.kind || parsed.generation !== reloading.generation)
              throw new Error('Unexpected TLS receipt')
            const current = reloading
            reloading = undefined
            clearTimeout(current.timer)
            if (parsed.accepted) current.resolve()
            else current.reject(new Error('TLS reload refused; original certificate retained'))
          } else {
            const { event: _, ...stats } = parsed
            status = stats
            lastHeartbeat = Date.now()
          }
        } catch {
          child.kill('SIGKILL')
        }
      }
    })
  })
  // Stderr is deliberately discarded; malformed input, addresses and PEMs never enter logs.
  child.stderr.resume()
  child.stdin.on('error', () => {})
  child.stdin.write(`${config}\n`)
  const port = await ready
  const timer = setInterval(() => {
    if (!exited && Date.now() - lastHeartbeat > 10_000) child.kill('SIGKILL')
  }, 1000)
  timer.unref()
  return {
    port,
    healthy: () => !exited && Date.now() - lastHeartbeat <= 10_000,
    stats: () => ({ ...status }),
    drain: () => {
      if (!exited) child.stdin.write('{"command":"drain"}\n')
    },
    reloadTls(cert, key) {
      if (exited || reloading) return Promise.reject(new Error('TLS reload unavailable'))
      const request = JSON.stringify({ command: 'reload-tls', generation: ++generation, certificate: cert.toString(), key: key.toString() })
      if (Buffer.byteLength(request) >= 64 * 1024 || generation > 0xffffffff) return Promise.reject(new Error('TLS reload limit'))
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reloading = undefined
          reject(new Error('TLS reload result unknown'))
          child.kill('SIGKILL')
        }, 3000)
        reloading = { kind: 'tls-reloaded', generation, resolve, reject, timer }
        child.stdin.write(`${request}\n`)
      })
    },
    setAcmeTls(cert, key) {
      if (exited || reloading) return Promise.reject(new Error('ACME TLS update unavailable'))
      const request = JSON.stringify({
        command: 'acme-tls',
        generation: ++generation,
        certificate: cert ? cert.toString() : '',
        key: key ? key.toString() : '',
      })
      if (Buffer.byteLength(request) >= 64 * 1024 || generation > 0xffffffff) return Promise.reject(new Error('ACME TLS limit'))
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reloading = undefined
          reject(new Error('ACME TLS result unknown'))
          child.kill('SIGKILL')
        }, 3000)
        reloading = { kind: 'acme-tls-updated', generation, resolve, reject, timer }
        child.stdin.write(`${request}\n`)
      })
    },
    async close() {
      clearInterval(timer)
      if (!exited) child.stdin.end('{"command":"stop"}\n')
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exit
      clearTimeout(kill)
    },
  }
}
