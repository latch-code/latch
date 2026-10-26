import { execFile } from 'node:child_process'
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
  const cert = createTransportCertificate()
  await writeFile(join(directory, 'certificate.pem'), cert.cert, { mode: 0o600 })
  await writeFile(join(directory, 'key.pem'), cert.key, { mode: 0o600 })
  expect((await run(process.execPath, [...args, 'check', '--data-dir', directory])).stdout).toBe('{"valid":true}\n')
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
