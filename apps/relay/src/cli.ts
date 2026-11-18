import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { resolve, join, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { isRelayEndpoint } from '@latch/link-wire'
import { loadRelayConfig } from './config.ts'
import { startRelay } from './server.ts'
import { requestPrivateAdmin } from './admin.ts'
import { superviseRelay, verifyWorkerLease } from './supervisor.ts'
import { runDirectoryCommand } from './directory-commands.ts'

function assertPrivateRuntime(): void {
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
}

async function main(): Promise<void> {
  if (process.argv[2] === 'directory') {
    assertPrivateRuntime()
    process.stdout.write(`${JSON.stringify(await runDirectoryCommand(process.argv.slice(3)))}\n`)
    return
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      config: { type: 'string' },
      url: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
      worker: { type: 'boolean' },
    },
  })
  if (values.help) {
    process.stdout.write(
      'latch-relay init|check|start|status|health|drain|reload-tls|quota set-used <bytes> --data-dir <absolute-directory> [--config <absolute-file>]\n'
        + 'latch-relay profile --data-dir <absolute-directory> [--config <absolute-file>] --url <https-origin> --output <new-absolute-file>\n'
        + 'latch-relay directory --help\n',
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
    || !['init', 'check', 'profile', 'start', 'status', 'health', 'drain', 'reload-tls', 'quota'].includes(command ?? '')
    || (command !== 'profile' && (values.url !== undefined || values.output !== undefined))
  )
    throw new Error('Invalid relay command')
  assertPrivateRuntime()
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
  if (command === 'profile') {
    if (!values.url || !values.output || !isAbsolute(values.output) || values.url.length > 512) throw new Error('Invalid profile output')
    const url = new URL(values.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.href !== `${url.origin}/` || !isRelayEndpoint(url.href))
      throw new Error('Invalid relay origin')
    const certificate = new X509Certificate(config.cert)
    const hostname = url.hostname.replace(/^\[|\]$/gu, '')
    if (!(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname)))
      throw new Error('Certificate does not match relay origin')
    const spkiHash = createHash('sha256')
      .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
    const registrationKey =
      !config.openRegistration && config.registrationToken ? `lrt1.${config.registrationToken.toString('base64url')}` : undefined
    await writeFile(
      values.output,
      `${JSON.stringify({
        version: 1,
        profile: {
          url: url.href,
          relayId: Buffer.from(config.relayId).toString('hex'),
          spkiHash,
          ...(registrationKey ? { registrationKey } : {}),
        },
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    // The key's short hash, the one the Mac's confirmation sheet shows: an independent reference to compare it with.
    process.stdout.write(`${JSON.stringify({ written: true, keyHash: spkiHash.slice(0, 8) })}\n`)
    return
  }
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
  process.stderr.write(
    process.argv[2] === 'directory'
      ? '{"error":"Directory operation failed; use patched Node with --disable-sigusr1 and check private files, role, generations and a new versioned output path"}\n'
      : '{"error":"Relay operation failed; check command, file permissions and TLS configuration"}\n',
  )
  process.exitCode = 1
}
