import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { packagedHostDataDir, packagedNode, startPackagedHost } = require('../src/packaged.cjs') as {
  packagedHostDataDir(input?: { platform?: string; home?: string; appData?: string }): string
  packagedNode(launcher: string, run: (path: string, args: string[]) => Promise<string>): Promise<string>
  startPackagedHost(input: { launcher: string; dataDir: string; run: (path: string, args: string[]) => Promise<string> }): Promise<string>
}

describe('packaged bootstrap', () => {
  it('names the Host’s default data directory exactly as the Host does', () => {
    // apps/host/test/paths.test.ts expects the same path from `defaultDataDir('darwin', '/Users/me', {})`.
    expect(packagedHostDataDir({ platform: 'darwin', home: '/Users/me', appData: '/Users/me/Library/Application Support' })).toBe(
      '/Users/me/.latch/host',
    )
  })

  it('uses the native launcher and a fixed Host entry with an explicit directory and ephemeral port', async () => {
    const run = vi.fn().mockResolvedValue('{"hostStatePath":"/temporary/data/host.json"}')
    await expect(
      startPackagedHost({ launcher: '/Applications/Latch.app/Contents/Resources/bin/latch', dataDir: '/temporary/data', run }),
    ).resolves.toBe('/temporary/data/host.json')
    expect(run).toHaveBeenCalledWith('/Applications/Latch.app/Contents/Resources/bin/latch', [
      '--internal-desktop-bootstrap',
      '--data-dir',
      '/temporary/data',
      '--port',
      '0',
    ])
  })

  it('refuses a different returned data directory and a malformed runtime path', async () => {
    await expect(
      startPackagedHost({
        launcher: '/app/latch',
        dataDir: '/temporary/data',
        run: async () => '{"hostStatePath":"/different/host.json"}',
      }),
    ).rejects.toThrow('无法核对')
    await expect(packagedNode('/app/latch', async () => '{"path":"node","version":"24.22.1"}')).rejects.toThrow('无法核对')
    await expect(packagedNode('/app/latch', async () => '{"path":"/opt/homebrew/bin/node","version":"24.22.1"}')).resolves.toBe(
      '/opt/homebrew/bin/node',
    )
  })
})
