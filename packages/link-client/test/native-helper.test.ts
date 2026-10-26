import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { acceptNativeTls, createTransportCertificate, validateNativeTlsBinary } from '../src/index.ts'

it('rejects a patched but outdated component that cannot enforce the binding-specific protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-native-old-api-')),
    binary = join(directory, 'old-component')
  try {
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"protocol":1,"go":"go1.26.10"}\'\n', { mode: 0o700 })
    await expect(validateNativeTlsBinary(binary)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const execute = promisify(execFile)
async function helpers(): Promise<number> {
  try {
    const { stdout } = await execute('/usr/bin/pgrep', ['-P', String(process.pid), '-f', '/latch-native-tls$'], {
      env: {},
      timeout: 1000,
      maxBuffer: 4096,
    })
    return stdout
      .trim()
      .split('\n')
      .filter(value => /^[0-9]+$/u.test(value)).length
  } catch (error) {
    if ((error as { code?: number }).code === 1) return 0
    throw error
  }
}
it('caps real helper processes and waits for their actual exit after partial-handshake cancellation', async () => {
  const certificate = createTransportCertificate(),
    input = {
      binary: resolve('dist/native/latch-native-tls'),
      certificate: certificate.cert,
      key: certificate.key,
      pairing: true,
      authorities: [],
      peerSpki: '',
    },
    raws = Array.from({ length: 16 }, () => new PassThrough()),
    pending = raws.map(raw =>
      acceptNativeTls(raw, input).then(
        () => false,
        () => true,
      ),
    )
  const excess = new PassThrough()
  try {
    await vi.waitFor(async () => expect(await helpers()).toBe(16), { timeout: 2500 })
    await expect(acceptNativeTls(excess, input)).rejects.toThrow('capacity')
  } finally {
    for (const raw of raws) raw.destroy()
    excess.destroy()
    expect((await Promise.all(pending)).every(Boolean)).toBe(true)
  }
  expect(await helpers()).toBe(0)
})
