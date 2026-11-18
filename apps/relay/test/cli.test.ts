import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises'
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
  // Outside the address-book grammar: the Host and every phone would refuse it.
  for (const url of ['https://localhost:8443/?', 'https://localhost:8443/#', 'https://a_b.localhost:8443/'])
    await expect(run(process.execPath, [...exportArgs, '--url', url])).rejects.toMatchObject({ code: 1 })
  await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  const exported = await run(process.execPath, [...exportArgs, '--url', 'https://localhost:8443'])
  expect(exported.stdout).toBe(`{"written":true,"keyHash":"${createHash('sha256').update(cert.spki).digest('hex').slice(0, 8)}"}\n`)
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
it('writes a public configuration from the form answers that check accepts unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-relay-cli-'))
  directories.push(directory)
  const data = join(directory, 'data'),
    cert = createTransportCertificate(Date.now(), 3_600_000, 'relay.example.com')
  await writeFile(join(directory, 'chain.pem'), cert.cert, { mode: 0o600 })
  await writeFile(join(directory, 'key.pem'), cert.key, { mode: 0o600 })
  // Stands in for the Go gateway, answering the one question `check` asks of it.
  const gateway = join(directory, 'gateway')
  await writeFile(gateway, '#!/bin/sh\necho \'{"protocol":2,"go":"go1.26.10"}\'\n', { mode: 0o755 })
  const answers = ['--cert', join(directory, 'chain.pem'), '--key', join(directory, 'key.pem'), '--iface', 'eth0', '--gateway', gateway]
  // Nothing is created for an address no phone could dial, or for options without a domain.
  for (const bad of [
    ['--domain', 'Relay.example.com'],
    ['--domain', 'a_b.example.com'],
    ['--domain', 'relay.example.com', '--port', '0'],
    [],
  ])
    await expect(run(process.execPath, [...args, 'init', '--data-dir', data, ...bad, ...answers])).rejects.toMatchObject({ code: 1 })
  await expect(stat(join(data, 'registration-token'))).rejects.toMatchObject({ code: 'ENOENT' })
  const initialized = await run(process.execPath, [...args, 'init', '--data-dir', data, '--domain', 'relay.example.com', ...answers])
  expect(JSON.parse(initialized.stdout)).toMatchObject({
    initialized: true,
    origin: 'https://relay.example.com:8443/',
    assumed: { iface: 'eth0' },
  })
  const configuration = JSON.parse(await readFile(join(data, 'relay.json'), 'utf8'))
  expect(configuration).toMatchObject({ host: '0.0.0.0', port: 8443, openRegistration: false, quota: { iface: 'eth0' } })
  expect((await run(process.execPath, [...args, 'check', '--data-dir', data])).stdout).toBe('{"valid":true}\n')
  const output = join(directory, 'connection.json')
  await run(process.execPath, [...args, 'profile', '--data-dir', data, '--url', 'https://relay.example.com:8443', '--output', output])
  expect(JSON.parse(await readFile(output, 'utf8')).profile.url).toBe('https://relay.example.com:8443/')
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
it.each(['install', 'upgrade'])('takes a directory lock without truncating a target behind a planted symlink during %s', async command => {
  const root = await mkdtemp(join(tmpdir(), 'latch-relay-maintenance-'))
  directories.push(root)
  const data = join(root, 'data'),
    bin = join(root, 'bin'),
    victim = join(root, 'operator-file'),
    compose = join(root, 'compose.yaml')
  await mkdir(data)
  await mkdir(bin)
  await writeFile(victim, 'keep the complete operator file')
  await symlink(victim, join(data, '.maintenance.lock'))
  await writeFile(compose, 'services: {}\n')
  await writeFile(join(bin, 'flock'), '#!/bin/bash\ntest -d /dev/fd/9\n', { mode: 0o700 })
  await writeFile(join(bin, 'docker'), '#!/bin/bash\nexit 7\n', { mode: 0o700 })
  const image = `relay.example/latch@sha256:${'a'.repeat(64)}`
  const script = fileURLToPath(new URL(`../deploy/${command}.sh`, import.meta.url))
  const inputs = command === 'install' ? ['--used-bytes', '0'] : [image, 'https://relay.example/healthz']
  await expect(
    run('/bin/bash', [script, compose, ...inputs], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LATCH_RELAY_IMAGE: image,
        LATCH_RELAY_DATA_DIR: data,
      },
    }),
  ).rejects.toMatchObject({ code: 7 })
  expect(await readFile(victim, 'utf8')).toBe('keep the complete operator file')
})
