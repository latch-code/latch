import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { buildNetworkHelper } from '../scripts/build-network.ts'

const execute = promisify(execFile)
it.skipIf(process.platform !== 'darwin')(
  'compiles the real DNS-SD helper and validates pure parsing without starting network discovery',
  async () => {
    const binary = await buildNetworkHelper()
    expect(binary).toBeTypeOf('string')
    const result = await execute(binary!, ['--self-test'], { env: {}, timeout: 3000, maxBuffer: 4096 })
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      valid: true,
      invalid: true,
      mac: true,
      neighbors: true,
      selection: true,
      emptyTXT: true,
      target: 'l-75253tsynaig.local',
    })
    expect(result.stderr).toBe('')
  },
  120000,
)
