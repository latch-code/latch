import { spawn } from 'node:child_process'
import { fstatSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { checkGateway } from './gateway.ts'
export async function superviseRelay(input: { dataDir: string; configPath: string; binary?: string; adminPort: number }): Promise<void> {
  const entry = process.argv[1]!
  const binary =
    input.binary
    ?? (entry.endsWith('.ts')
      ? fileURLToPath(new URL('../../../dist/relay/latch-relay-tls', import.meta.url))
      : fileURLToPath(new URL('./latch-relay-tls', import.meta.url)))
  await checkGateway(binary)
  const args = ['--disable-sigusr1', resolve(entry), 'start', '--worker', '--data-dir', input.dataDir, '--config', input.configPath]
  const child = spawn(binary, ['supervise'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
  let tail = '',
    stopping = false
  const stop = () => {
    if (!stopping) {
      stopping = true
      child.stdin.write('{"command":"shutdown"}\n')
    }
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  child.stdin.on('error', () => {})
  child.stderr.resume()
  child.stdout.on('data', (data: Buffer) => {
    tail += data.toString('utf8')
    if (tail.length > 8192) {
      child.kill('SIGKILL')
      return
    }
    for (;;) {
      const end = tail.indexOf('\n')
      if (end < 0) break
      const line = tail.slice(0, end)
      tail = tail.slice(end + 1)
      // The standard-library supervisor only emits fixed aggregate event objects.
      try {
        const event: unknown = JSON.parse(line)
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid supervisor event')
        if (process.stdout.writableLength < 32768) process.stdout.write(`${line}\n`)
      } catch {
        child.kill('SIGKILL')
      }
    }
  })
  child.stdin.write(`${JSON.stringify({ dataDir: input.dataDir, node: process.execPath, args, adminPort: input.adminPort })}\n`)
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', () => reject(new Error('Supervisor startup failed')))
    child.once('exit', code => resolve(code ?? 1))
  })
  process.removeListener('SIGTERM', stop)
  process.removeListener('SIGINT', stop)
  child.stdin.end()
  if (code !== 0) throw new Error('Supervisor exited')
}
/** A worker inherits the same locked open file description, so owner loss cannot unlock a live writer. */
export function verifyWorkerLease(dataDir: string): void {
  const descriptor = fstatSync(3),
    path = statSync(resolve(dataDir, 'relay.lock'))
  if (!descriptor.isFile() || descriptor.mode & 0o077 || descriptor.dev !== path.dev || descriptor.ino !== path.ino)
    throw new Error('Invalid worker lease')
}
