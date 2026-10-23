import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CANARIES, canaryHeld, CONTROL, pnpmFromEnvironment, pnpmVersion, runCanaries, withSettings, type PnpmCommand } from '../scripts/supply-canaries.ts'
import { parsePackageManagerPin } from '../scripts/supply-chain.ts'

// Canaries install from a registry on 127.0.0.1 into temporary projects; the repository is only read.
const workspaceYaml = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { packageManager?: unknown }
const TIMEOUT = 120_000

function pinnedPnpm(): PnpmCommand {
  const pnpm = pnpmFromEnvironment()
  if (!pnpm) throw new Error('run these tests through pnpm (pnpm test) so npm_execpath names the pinned pnpm')
  return pnpm
}

describe('supply-chain canaries', () => {
  it('run on the pnpm version that packageManager pins', async () => {
    expect(await pnpmVersion(pinnedPnpm())).toBe(parsePackageManagerPin(manifest.packageManager)?.version)
  }, TIMEOUT)

  it('each fails with its own error code under pnpm-workspace.yaml, while the control installs', async () => {
    const results = await runCanaries({ pnpm: pinnedPnpm(), workspaceYaml })
    expect(results.find(result => result.id === CONTROL.id)).toMatchObject({ installed: true, codes: [] })
    for (const canary of CANARIES) {
      const result = results.find(item => item.id === canary.id)!
      expect({ id: canary.id, installed: result.installed, scriptRan: result.scriptRan, code: result.codes.includes(canary.expectedCode) ? canary.expectedCode : result.codes })
        .toEqual({ id: canary.id, installed: false, scriptRan: false, code: canary.expectedCode })
      expect(canaryHeld(canary, result)).toBe(true)
    }
  }, TIMEOUT)

  it('each installs once the setting it guards is weakened, so a removed protection is caught', async () => {
    const results = await runCanaries({ pnpm: pinnedPnpm(), workspaceYaml: canary => withSettings(workspaceYaml, canary.weakenedBy) })
    expect(results.map(result => [result.id, result.installed])).toEqual([CONTROL, ...CANARIES].map(canary => [canary.id, true]))
    for (const canary of CANARIES) expect(canaryHeld(canary, results.find(result => result.id === canary.id)!)).toBe(false)
  }, TIMEOUT)

  it('notices a dependency install script that ran', async () => {
    const buildScript = CANARIES.find(canary => canary.id === 'build-script')!
    const approved = withSettings(workspaceYaml, { allowBuilds: { 'canary-build-script': true } })
    const [, result] = await runCanaries({ pnpm: pinnedPnpm(), workspaceYaml: approved, canaries: [buildScript] })
    expect(result).toMatchObject({ id: 'build-script', installed: true, scriptRan: true })
    expect(canaryHeld(buildScript, result!)).toBe(false)
  }, TIMEOUT)
})
