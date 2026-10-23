import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface TestTls {
  certPath: string
  keyPath: string
  ca: string
  hostname: 'latch-test.localhost'
}

/** A self-signed P-256 certificate for `latch-test.localhost`; it is its own CA. The key is 0600. */
export async function makeTestTls(dir: string): Promise<TestTls> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  const hostname = 'latch-test.localhost'
  await run(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-pkeyopt',
      'ec_param_enc:named_curve',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '30',
      '-subj',
      `/CN=${hostname}`,
      '-addext',
      `subjectAltName=DNS:${hostname}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { env: { PATH: '/usr/bin:/bin' } },
  )
  await chmod(keyPath, 0o600)
  return { certPath, keyPath, ca: await readFile(certPath, 'utf8'), hostname }
}
