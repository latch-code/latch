import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, resolve, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isRelayEndpoint } from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import { createAcmeBootstrapCertificate, type AcmeConfig } from './acme.ts'
import { createSelfSignedRelayCertificate } from './self-tls.ts'
import { loadRelayConfig } from './config.ts'
import { PUBLIC_DEFAULTS, publicOrigin, publicRelayFields, type PublicInit } from './init-config.ts'
import { writePrivate } from './private-store.ts'
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

const INIT_STRING_FLAGS = [
  'domain',
  'ip',
  'port',
  'public-port',
  'cert',
  'key',
  'iface',
  'gateway',
  'acme-directory',
  'acme-email',
] as const

async function findGatewayBinary(explicit?: string): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = explicit ? [explicit] : [join(here, 'latch-relay-tls'), resolve(here, '../../../dist/relay/latch-relay-tls')]
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue
    const info = await lstat(candidate).catch(() => undefined)
    if (info?.isFile()) return candidate
  }
  return undefined
}

/**
 * Resolves a public relay setup from CLI flags:
 * 1. `--ip <ip>` (or `--domain <ip>`): binds 0.0.0.0/[::]:<port> (8443 by default) with a self-signed IP SAN certificate
 *    and automatic key-preserving renewal (`spkiHash` never changes).
 * 2. `--behind-proxy`: binds 127.0.0.1:<port> (18443 by default) behind an existing Caddy/Nginx on :443.
 * 3. `--cert` + `--key`: binds 0.0.0.0:<port> (8443 by default) with operator-managed PEM files.
 * 4. `--domain <dns>` alone: binds 0.0.0.0:<port> (443 by default) with built-in ACME TLS-ALPN-01 automatic certificates.
 */
async function publicInit(
  directory: string,
  values: Partial<Record<(typeof INIT_STRING_FLAGS)[number], string>> & { 'behind-proxy'?: boolean },
): Promise<{ init: PublicInit; bootstrap?: { cert: string; key: string; certificateFile: string; keyFile: string } }> {
  if (values.ip && values.domain && values.ip !== values.domain) throw new Error('Specify either --ip or --domain, not both')
  const rawTarget = values.ip ?? values.domain
  if (!rawTarget) throw new Error('Public relay options require --domain or --ip')
  const strippedTarget = rawTarget.replace(/^\[|\]$/gu, '').toLowerCase()
  const targetIsIp = isIP(strippedTarget) !== 0
  if (values.ip !== undefined && !targetIsIp) throw new Error('Invalid --ip address')
  const domain = targetIsIp ? (isIP(strippedTarget) === 6 ? `[${strippedTarget}]` : strippedTarget) : rawTarget
  if (values.port !== undefined && !/^\d{1,5}$/u.test(values.port)) throw new Error('Invalid relay port')
  if (values['public-port'] !== undefined && !/^\d{1,5}$/u.test(values['public-port'])) throw new Error('Invalid public port')
  const iface = values.iface
  if (iface !== undefined && (!/^[a-zA-Z0-9_.:-]{1,15}$/u.test(iface) || ['lo', '.', '..', 'relay'].includes(iface)))
    throw new Error('Invalid metered network interface')

  if (values['behind-proxy']) {
    if (values.ip || targetIsIp || values.cert || values.key || values.gateway || values['acme-directory'] || values['acme-email'])
      throw new Error('Behind-proxy mode requires a DNS --domain and cannot be combined with --ip, TLS or gateway flags')
    const port = values.port === undefined ? 18443 : Number(values.port)
    const publicPort = values['public-port'] === undefined ? 443 : Number(values['public-port'])
    publicOrigin(domain, publicPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port')
    return { init: { mode: 'proxy', domain, port, publicPort, ...(iface ? { iface } : {}) } }
  }

  if (values['public-port'] !== undefined) throw new Error('--public-port requires --behind-proxy')
  const hasCert = values.cert !== undefined || values.key !== undefined
  if (hasCert && (!values.cert || !values.key || !isAbsolute(values.cert) || !isAbsolute(values.key)))
    throw new Error('Custom TLS requires absolute --cert and --key')
  if ((hasCert || targetIsIp) && (values['acme-directory'] || values['acme-email']))
    throw new Error('ACME flags cannot be combined with --ip or --cert/--key')

  const port = values.port === undefined ? (hasCert || targetIsIp ? 8443 : 443) : Number(values.port)
  publicOrigin(domain, port)
  const gateway = await findGatewayBinary(values.gateway)
  if (!gateway) throw new Error('Gateway executable not found')

  if (hasCert) {
    return {
      init: {
        mode: 'tls',
        domain,
        port,
        certificateFile: values.cert!,
        keyFile: values.key!,
        gateway,
        ...(iface ? { iface } : {}),
      },
    }
  }

  const tlsDir = join(directory, 'tls'),
    certificateFile = join(tlsDir, 'certificate.pem'),
    keyFile = join(tlsDir, 'key.pem')

  if (targetIsIp) {
    const generated = createSelfSignedRelayCertificate(strippedTarget)
    return {
      init: {
        mode: 'tls',
        domain,
        port,
        certificateFile,
        keyFile,
        gateway,
        ...(iface ? { iface } : {}),
        selfSignedTls: { target: strippedTarget },
      },
      bootstrap: { cert: generated.cert, key: generated.key, certificateFile, keyFile },
    }
  }

  const bootstrap = createAcmeBootstrapCertificate(domain)
  const acme: AcmeConfig = {
    domain,
    ...(values['acme-directory'] ? { directoryUrl: values['acme-directory'] } : {}),
    ...(values['acme-email'] ? { email: values['acme-email'] } : {}),
  }
  return {
    init: { mode: 'tls', domain, port, certificateFile, keyFile, gateway, ...(iface ? { iface } : {}), acme },
    bootstrap: { ...bootstrap, certificateFile, keyFile },
  }
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
      'legacy-spki': { type: 'boolean' },
      domain: { type: 'string' },
      ip: { type: 'string' },
      port: { type: 'string' },
      'public-port': { type: 'string' },
      'behind-proxy': { type: 'boolean' },
      cert: { type: 'string' },
      key: { type: 'string' },
      'acme-directory': { type: 'string' },
      'acme-email': { type: 'string' },
      iface: { type: 'string' },
      gateway: { type: 'string' },
      help: { type: 'boolean' },
      worker: { type: 'boolean' },
    },
  })
  if (values.help) {
    process.stdout.write(
      'latch-relay init --data-dir <absolute-directory> [--domain <name> [--behind-proxy [--port <loopback-port>] [--public-port <port>] | --cert <absolute-file> --key <absolute-file> | [--acme-email <email>]] [--port <port>] [--iface <interface>] [--gateway <absolute-file>]]\n'
        + 'latch-relay check|start|status|health|drain|reload-tls|quota set-used <bytes> --data-dir <absolute-directory> [--config <absolute-file>]\n'
        + 'latch-relay profile --data-dir <absolute-directory> [--config <absolute-file>] --url <https-origin> --output <new-absolute-file> [--legacy-spki]\n'
        + 'latch-relay directory --help\n',
    )
    return
  }
  if (!values['data-dir'] || !isAbsolute(values['data-dir'])) throw new Error('An explicit absolute data directory is required')
  const directory = resolve(values['data-dir']),
    command = positionals[0]
  const quotaCommand =
    command === 'quota' && positionals.length === 3 && positionals[1] === 'set-used' && /^\d{1,16}$/u.test(positionals[2] ?? '')
  const hasInitFlags = INIT_STRING_FLAGS.some(flag => values[flag] !== undefined) || Boolean(values['behind-proxy'])
  if (
    (!quotaCommand && positionals.length !== 1)
    || !['init', 'check', 'profile', 'start', 'status', 'health', 'drain', 'reload-tls', 'quota'].includes(command ?? '')
    || (command !== 'profile' && (values.url !== undefined || values.output !== undefined || values['legacy-spki']))
    || (command !== 'init' && hasInitFlags)
  )
    throw new Error('Invalid relay command')
  assertPrivateRuntime()
  if (command === 'init') {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const root = await lstat(directory)
    if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077) throw new Error('Private data directory required')
    const tokenFile = join(directory, 'registration-token'),
      seedFile = join(directory, 'relay-signing-seed'),
      configFile = join(directory, 'relay.json')
    if (values.domain === undefined && values.ip === undefined && hasInitFlags)
      throw new Error('Public relay options require --domain or --ip')
    const resolved = values.domain === undefined && values.ip === undefined ? undefined : await publicInit(directory, values)
    const useEdgeSeed = Boolean(resolved && !(resolved.init.mode === 'tls' && resolved.init.selfSignedTls))
    await writeFile(tokenFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
    if (useEdgeSeed) await writeFile(seedFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
    if (resolved?.bootstrap) {
      await writePrivate(resolved.bootstrap.certificateFile, resolved.bootstrap.cert)
      await writePrivate(resolved.bootstrap.keyFile, resolved.bootstrap.key)
    }
    const base = {
      version: 1,
      adminPort: 8444,
      relayId: randomBytes(16).toString('hex'),
      registrationTokenFile: tokenFile,
      ...(useEdgeSeed ? { relaySigningSeedFile: seedFile } : {}),
    }
    const fields = resolved ? publicRelayFields(resolved.init) : undefined
    const config = fields
      ? { ...base, ...fields, openRegistration: false }
      : {
          ...base,
          host: '127.0.0.1',
          port: 8443,
          certificateFile: join(directory, 'certificate.pem'),
          keyFile: join(directory, 'key.pem'),
          openRegistration: false,
        }
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const dialedPort = resolved ? (resolved.init.mode === 'proxy' ? resolved.init.publicPort : resolved.init.port) : 8443
    process.stdout.write(
      resolved && fields
        ? `${JSON.stringify({
            initialized: true,
            origin: publicOrigin(resolved.init.domain, dialedPort),
            mode:
              resolved.init.mode === 'proxy'
                ? 'behind-proxy'
                : resolved.init.selfSignedTls
                  ? 'self-ip'
                  : resolved.init.acme
                    ? 'acme'
                    : 'custom-tls',
            assumed: {
              ...(resolved.init.iface ? { iface: resolved.init.iface } : { quotaSource: 'relay' }),
              monthlyBytes: fields.quota.monthlyBytes,
              resetDay: PUBLIC_DEFAULTS.quota.resetDay,
              timezone: PUBLIC_DEFAULTS.quota.timezone,
              maxConnections: PUBLIC_DEFAULTS.maxConnections,
              maxRoutes: PUBLIC_DEFAULTS.maxRoutes,
            },
          })}\n`
        : '{"initialized":true}\n',
    )
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
    const registrationKey =
      !config.openRegistration && config.registrationToken ? `lrt1.${config.registrationToken.toString('base64url')}` : undefined
    if (config.relaySigningSeed && !values['legacy-spki']) {
      const relayKey = Buffer.from(await nodeCrypto.publicKey(config.relaySigningSeed)).toString('hex')
      const keyHash = createHash('sha256').update(Buffer.from(relayKey, 'hex')).digest('hex').slice(0, 8)
      await writeFile(
        values.output,
        `${JSON.stringify({
          version: 2,
          profile: {
            url: url.href,
            relayId: Buffer.from(config.relayId).toString('hex'),
            kind: 'edge',
            relayKey,
            ...(registrationKey ? { registrationKey } : {}),
          },
        })}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      process.stdout.write(`${JSON.stringify({ written: true, keyHash })}\n`)
      return
    }
    if (!config.cert) throw new Error('SPKI profile export requires TLS certificate files')
    const certificate = new X509Certificate(config.cert)
    const hostname = url.hostname.replace(/^\[|\]$/gu, '')
    if (!(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname)))
      throw new Error('Certificate does not match relay origin')
    const spkiHash = createHash('sha256')
      .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
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
    ...(config.relaySigningSeed ? { edgeIdentity: { seed: config.relaySigningSeed } } : {}),
    adminSocket,
    adminPort: 0,
    dataDir: directory,
    ...(config.certificateFile && config.keyFile ? { tlsFiles: { certificateFile: config.certificateFile, keyFile: config.keyFile } } : {}),
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
