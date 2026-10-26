import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { loadRelayConfig } from './config.ts'
import { startRelay } from './server.ts'
import { requestPrivateAdmin } from './admin.ts'
import { superviseRelay, verifyWorkerLease } from './supervisor.ts'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { 'data-dir': { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean' }, worker: { type: 'boolean' } },
  })
  if (values.help) {
    process.stdout.write(
      'latch-relay init|check|start|status|health|drain|reload-tls|quota set-used <bytes> --data-dir <absolute-directory> [--config <absolute-file>]\n',
    )
    return
  }
  if (!values['data-dir'] || !isAbsolute(values['data-dir'])) throw new Error('An explicit absolute data directory is required')
  const directory = resolve(values['data-dir']),
    command = positionals[0]
  const quotaCommand =
    command === 'quota' && positionals.length === 3 && positionals[1] === 'set-used' && /^\d{1,16}$/u.test(positionals[2] ?? '')
  if (
    (!quotaCommand && positionals.length !== 1)
    || !['init', 'check', 'start', 'status', 'health', 'drain', 'reload-tls', 'quota'].includes(command ?? '')
  )
    throw new Error('Invalid relay command')
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  if (
    !(
      (major === 22 && (minor! > 23 || (minor === 23 && patch! >= 4)))
      || (major === 24 && (minor! > 22 || (minor === 22 && patch! >= 1)))
      || (major! >= 26 && (major! > 26 || minor! > 12 || (minor === 12 && patch! >= 1)))
    )
  )
    throw new Error('Patched Node runtime required')
  if (!process.execArgv.includes('--disable-sigusr1')) throw new Error('Start the relay with --disable-sigusr1')
  if (command === 'init') {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const root = await lstat(directory)
    if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077) throw new Error('Private data directory required')
    const tokenFile = join(directory, 'registration-token'),
      configFile = join(directory, 'relay.json')
    await writeFile(tokenFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
    await writeFile(
      configFile,
      `${JSON.stringify({ version: 1, host: '127.0.0.1', port: 8443, adminPort: 8444, relayId: randomBytes(16).toString('hex'), certificateFile: join(directory, 'certificate.pem'), keyFile: join(directory, 'key.pem'), registrationTokenFile: tokenFile, openRegistration: false }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    process.stdout.write('{"initialized":true}\n')
    return
  }
  if (command === 'status' || command === 'health' || command === 'drain' || command === 'reload-tls' || quotaCommand) {
    const body = quotaCommand ? JSON.stringify({ usedBytes: Number(positionals[2]) }) : undefined
    const text = await requestPrivateAdmin(
      directory,
      command === 'quota' ? '/quota' : command === 'health' ? '/healthz' : command === 'reload-tls' ? '/reload' : `/${command}`,
      body,
    )
    process.stdout.write(`${text}\n`)
    return
  }
  if (command === 'quota') throw new Error('Invalid calibration command')
  const configPath = values.config ?? join(directory, 'relay.json')
  const config = await loadRelayConfig(configPath)
  if (command === 'check') {
    process.stdout.write('{"valid":true}\n')
    return
  }
  if (!values.worker) {
    await superviseRelay({
      dataDir: directory,
      configPath,
      adminPort: config.adminPort,
      ...(config.gateway ? { binary: config.gateway.binary } : {}),
    })
    return
  }
  verifyWorkerLease(directory)
  process.once('uncaughtException', error => {
    const frames = (error.stack ?? '')
      .split('\n')
      .slice(1)
      .filter(line => /^\s+at [a-zA-Z0-9_.$<> /():-]+$/u.test(line))
      .slice(0, 16)
      .join('\n')
    const signature = createHash('sha256').update('latch-relay-fatal-v1\0').update(frames).digest('hex')
    process.stdout.write(`${JSON.stringify({ type: 'fatal', signature })}\n`, () => process.exit(1))
    setTimeout(() => process.exit(1), 100).unref()
  })
  const adminDirectory = await mkdtemp('/tmp/latch-worker-admin-')
  const adminSocket = join(adminDirectory, 'admin.sock')
  const relay = await startRelay({
    ...config,
    adminSocket,
    adminPort: 0,
    dataDir: directory,
    tlsFiles: { certificateFile: config.certificateFile, keyFile: config.keyFile },
  })
  const emit = (type: 'ready' | 'heartbeat') =>
    process.stdout.write(
      `${JSON.stringify({ type, ...(type === 'ready' ? { port: relay.port, adminPort: relay.adminPort, adminSocket } : {}), status: relay.status() })}\n`,
    )
  emit('ready')
  const timer = setInterval(() => {
    emit('heartbeat')
    if (drainTimer && relay.status().connections === 0) stop()
  }, 1000)
  let stopping = false,
    drainTimer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    clearTimeout(drainTimer)
    void relay
      .close()
      .then(() => {
        process.exitCode = 0
        void rm(adminDirectory, { recursive: true, force: true }).finally(() => process.stdin.destroy())
      })
      .catch(() => {
        process.exitCode = 1
        process.stdin.destroy()
      })
  }
  const drain = () => {
    if (drainTimer || stopping) return
    relay.drain()
    if (relay.status().connections === 0) {
      stop()
      return
    }
    drainTimer = setTimeout(stop, 60_000)
  }
  process.once('SIGINT', drain)
  process.once('SIGTERM', drain)
  let input = ''
  process.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    if (input.length > 1024) {
      stop()
      return
    }
    for (;;) {
      const end = input.indexOf('\n')
      if (end < 0) break
      const line = input.slice(0, end)
      input = input.slice(end + 1)
      if (line === '{"command":"drain"}') drain()
      else stop()
    }
  })
  process.stdin.once('end', stop)
  process.stdin.resume()
}
try {
  await main()
} catch {
  process.stderr.write('{"error":"Relay operation failed; check command, file permissions and TLS configuration"}\n')
  process.exitCode = 1
}
