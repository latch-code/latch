import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { z } from 'zod'

const execute = promisify(execFile),
  versions = new Map<string, string>(),
  validating = new Map<string, { fingerprint: string; promise: Promise<void> }>()
const versionSchema = z.strictObject({ protocol: z.literal(1), go: z.string() })
let running = 0
export async function validateNativeTlsBinary(binary: string): Promise<void> {
  if (!isAbsolute(binary)) throw new Error('Native TLS component unavailable')
  const stat = await lstat(binary),
    fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o6022 || !(stat.mode & 0o111))
    throw new Error('Native TLS component unavailable')
  if (versions.get(binary) === fingerprint) return
  const pending = validating.get(binary)
  if (pending?.fingerprint === fingerprint) return pending.promise
  if (validating.size >= 16) throw new Error('Native TLS component validation limit')
  const promise = (async () => {
    const output = await execute(binary, ['version'], { env: {}, timeout: 3000, maxBuffer: 1024 })
    const { go } = versionSchema.parse(JSON.parse(output.stdout) as unknown),
      match = /^go1\.(26|27)\.(\d+)$/u.exec(go)
    if (!match || Number(match[2]) < (match[1] === '26' ? 10 : 3)) throw new Error('Native TLS component requires a patched runtime')
    if (versions.size >= 16) versions.delete(versions.keys().next().value!)
    versions.set(binary, fingerprint)
  })()
  validating.set(binary, { fingerprint, promise })
  try {
    await promise
  } finally {
    if (validating.get(binary)?.promise === promise) validating.delete(binary)
  }
}
export interface NativeTlsConnection {
  socket: Duplex
  closed: Promise<void>
  close(): void
}
/** Only private inherited streams carry configuration or plaintext; no loopback listener or command-line key. */
export async function acceptNativeTls(
  raw: Duplex,
  input: { binary: string; certificate: string; key: string; pairing: boolean; authorities: string[]; peerSpki: string },
): Promise<NativeTlsConnection> {
  try {
    await validateNativeTlsBinary(input.binary)
  } catch {
    raw.destroy()
    throw new Error('Native TLS component unavailable')
  }
  if (raw.destroyed) throw new Error('Native TLS connection cancelled')
  const payload = Buffer.from(
    JSON.stringify({
      certificate: input.certificate,
      key: input.key,
      pairing: input.pairing,
      authorities: input.authorities,
      peerSpki: input.peerSpki,
    }),
  )
  if (payload.length > 16384) {
    raw.destroy()
    throw new Error('Native TLS configuration limit')
  }
  if (running >= 16) {
    raw.destroy()
    throw new Error('Native TLS connection capacity reached')
  }
  running++
  let child: ChildProcess
  try {
    child = spawn(input.binary, [], {
      env: { GOMAXPROCS: '1', GOMEMLIMIT: '16MiB' },
      stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
    })
  } catch {
    running--
    raw.destroy()
    throw new Error('Native TLS component unavailable')
  }
  const cipher = child.stdio[3] as Duplex | undefined,
    application = child.stdio[4] as Duplex | undefined
  let exited = false,
    ready = false,
    tail = '',
    closeRequested = false
  const closed = new Promise<void>(resolve => {
    const finished = () => {
      if (exited) return
      exited = true
      running--
      resolve()
      raw.destroy()
      cipher?.destroy()
      application?.destroy()
    }
    child.once('exit', finished)
    child.once('error', () => {
      if (!child.pid) finished()
      else close()
    })
  })
  const close = () => {
    if (closeRequested) return
    closeRequested = true
    raw.destroy()
    cipher?.destroy()
    application?.destroy()
    child.stdin?.destroy()
    child.stdout?.destroy()
    if (!exited) child.kill('SIGKILL')
  }
  if (!cipher || !application || !child.stdin || !child.stdout) {
    close()
    await closed
    throw new Error('Native TLS component unavailable')
  }
  raw.once('close', close)
  raw.once('error', close)
  cipher.once('error', close)
  cipher.once('close', close)
  application.once('error', close)
  application.once('close', close)
  child.stdin.once('error', close)
  child.stdout.once('error', close)
  try {
    const established = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        close()
        reject(new Error('Native TLS handshake timed out'))
      }, 3500)
      timer.unref()
      void closed.then(() => {
        clearTimeout(timer)
        if (!ready) reject(new Error('Native TLS authentication failed'))
      })
      child.stdout!.on('data', (bytes: Buffer) => {
        tail += bytes.toString('utf8')
        if (Buffer.byteLength(tail) > 1024 || ready) {
          close()
          return
        }
        const end = tail.indexOf('\n')
        if (end < 0) return
        try {
          if (
            tail.slice(end + 1)
            || !z.strictObject({ protocol: z.literal(1), ready: z.literal(true) }).safeParse(JSON.parse(tail.slice(0, end))).success
          )
            throw new Error('Native TLS state')
          ready = true
          clearTimeout(timer)
          resolve()
        } catch {
          close()
        }
      })
    })
    child.stdin.end(payload)
    raw.pipe(cipher).pipe(raw)
    await established
    if (raw.destroyed || application.destroyed || exited) throw new Error('Native TLS authentication failed')
    return { socket: application, closed, close }
  } catch {
    close()
    await closed
    throw new Error('Native TLS authentication failed')
  }
}
