import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { relayGoEnvironment } from '../scripts/go-environment.ts'

export async function buildTestGateway(directory: string): Promise<string> {
  const binary = join(directory, 'gateway')
  await promisify(execFile)(
    process.env.LATCH_RELAY_GO ?? 'go',
    [
      'build',
      '-trimpath',
      '-o',
      binary,
      fileURLToPath(new URL('../gateway/main.go', import.meta.url)),
      fileURLToPath(new URL('../gateway/supervisor.go', import.meta.url)),
    ],
    { env: relayGoEnvironment(), timeout: 60_000 },
  )
  return binary
}
