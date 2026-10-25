import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { loadRelayConfig } from './config.ts'
import { startRelay } from './server.ts'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { 'data-dir': { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    process.stdout.write('latch-relay init|check|start --data-dir <absolute-directory> [--config <absolute-file>]\n')
    return
  }
  if (!values['data-dir'] || !isAbsolute(values['data-dir'])) throw new Error('An explicit absolute data directory is required')
  const directory = resolve(values['data-dir']),
    command = positionals[0]
  if (positionals.length !== 1 || !['init', 'check', 'start'].includes(command ?? '')) throw new Error('Invalid relay command')
  if (command === 'init') {
    await mkdir(directory, { recursive: true, mode: 0o700 })
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
  const config = await loadRelayConfig(values.config ?? join(directory, 'relay.json'))
  if (command === 'check') {
    process.stdout.write('{"valid":true}\n')
    return
  }
  if (!process.execArgv.includes('--disable-sigusr1')) throw new Error('Start the relay with --disable-sigusr1')
  const relay = await startRelay(config)
  process.stdout.write('{"started":true}\n')
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void relay.close().then(() => {
      process.exitCode = 0
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
try {
  await main()
} catch {
  process.stderr.write('{"error":"Relay operation failed; check command, file permissions and TLS configuration"}\n')
  process.exitCode = 1
}
