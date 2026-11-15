import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createTransportCertificate } from '@latch/link-client'

const run = promisify(execFile),
  directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const args = ['--disable-sigusr1', '--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url))]

it('creates a private registration token without printing it and validates operator TLS files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-relay-cli-'))
  directories.push(directory)
  const initialized = await run(process.execPath, [...args, 'init', '--data-dir', directory])
  const token = await readFile(join(directory, 'registration-token'))
  expect(token).toHaveLength(32)
  expect((await stat(join(directory, 'registration-token'))).mode & 0o777).toBe(0o600)
  expect(initialized.stdout).not.toContain(token.toString('hex'))
  expect(initialized.stderr).toBe('')
  const cert = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
  await writeFile(join(directory, 'certificate.pem'), cert.cert, { mode: 0o600 })
  await writeFile(join(directory, 'key.pem'), cert.key, { mode: 0o600 })
  expect((await run(process.execPath, [...args, 'check', '--data-dir', directory])).stdout).toBe('{"valid":true}\n')
  const output = join(directory, 'connection.json')
  const exportArgs = [...args, 'profile', '--data-dir', directory, '--output', output]
  await expect(run(process.execPath, [...exportArgs, '--url', 'https://other.example/'])).rejects.toMatchObject({ code: 1 })
  await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  const exported = await run(process.execPath, [...exportArgs, '--url', 'https://localhost:8443'])
  expect(exported.stdout).toBe('{"written":true}\n')
  expect(exported.stderr).toBe('')
  expect((await stat(output)).mode & 0o777).toBe(0o600)
  const connection = JSON.parse(await readFile(output, 'utf8'))
  const configuration = JSON.parse(await readFile(join(directory, 'relay.json'), 'utf8'))
  expect(connection.version).toBe(1)
  expect(connection.profile.relayId).toBe(configuration.relayId)
  expect(connection.profile.url).toBe('https://localhost:8443/')
  expect(connection.profile.spkiHash).toBe(createHash('sha256').update(cert.spki).digest('hex'))
  expect(connection.profile.registrationKey === `lrt1.${token.toString('base64url')}`).toBe(true)
  await expect(run(process.execPath, [...exportArgs, '--url', 'https://localhost:8443'])).rejects.toMatchObject({ code: 1 })
  await chmod(join(directory, 'key.pem'), 0o644)
  await expect(run(process.execPath, [...args, 'check', '--data-dir', directory])).rejects.toMatchObject({ code: 1 })
})
it('requires an explicit data directory before any operation', async () => {
  await expect(run(process.execPath, [...args, 'init'])).rejects.toMatchObject({ code: 1 })
})

it('refuses an existing public state directory before creating a registration secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-relay-cli-mode-'))
  directories.push(directory)
  await chmod(directory, 0o755)
  await expect(run(process.execPath, [...args, 'init', '--data-dir', directory])).rejects.toMatchObject({ code: 1 })
  await expect(stat(join(directory, 'registration-token'))).rejects.toMatchObject({ code: 'ENOENT' })
})
