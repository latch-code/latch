import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseLookup, updateCommand } from '../src/update-command.ts'
import { releaseGate, upgradeCommand } from '../src/version.ts'
import { HARNESS_PROFILES } from '../src/profiles/index.ts'

const claude = {
  npm: '@anthropic-ai/claude-code',
  native: {
    matches: (file: string) => file.includes('/.local/share/claude/') || file.includes('/claude/versions/'),
    command: 'claude update',
  },
  channel: 'claude' as const,
}
const codex = { npm: '@openai/codex', brew: ['codex'] }

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('the update command a found program gets, by its install layout', () => {
  it('names npm only for the package’s own global folder, under any prefix', () => {
    expect(updateCommand('/usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', codex)).toBe(
      'npm i -g @openai/codex@latest',
    )
    expect(updateCommand('/Users/a/.npm-global/bin/codex', '/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js', codex)).toBe(
      'npm i -g @openai/codex@latest',
    )
    // Another package's folder, or a project's own node_modules, says nothing about this one.
    expect(updateCommand('/usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex-other/bin/x.js', codex)).toBeUndefined()
    expect(updateCommand('/p/node_modules/.bin/codex', '/p/node_modules/@openai/codex/bin/codex.js', codex)).toBeUndefined()
  })

  it('names Homebrew for a formula or cask, before npm for a formula built from an npm package', () => {
    expect(
      updateCommand(
        '/opt/homebrew/bin/codex',
        '/opt/homebrew/Cellar/codex/0.170.0/libexec/lib/node_modules/@openai/codex/bin/codex.js',
        codex,
      ),
    ).toBe('brew upgrade codex')
    expect(updateCommand('/opt/homebrew/bin/claude', '/opt/homebrew/Caskroom/claude-code/2.1.330/claude', claude)).toBe(
      'brew upgrade claude-code',
    )
    // A name that is not one Homebrew writes is never put in a command.
    expect(updateCommand('/x/claude', '/opt/homebrew/Cellar/a;rm -rf ~/1.0/bin/claude', claude)).toBeUndefined()
  })

  it('names Claude’s own updater only for its installer’s layout', () => {
    expect(updateCommand('/Users/a/.local/bin/claude', '/Users/a/.local/share/claude/versions/2.1.330', claude)).toBe('claude update')
    expect(updateCommand('/Users/a/.local/bin/codex', '/Users/a/.local/share/claude/versions/2.1.330', codex)).toBeUndefined()
  })

  it('updates managed Pi with its own updater, and distinguishes a global npm install', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-pi-update-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const agentDir = join(root, 'custom pi')
    const launcher = join(agentDir, 'bin', 'pi')
    const entrypoint = join(root, 'bin', 'pi')
    await mkdir(join(agentDir, 'bin'), { recursive: true })
    await mkdir(join(agentDir, 'install'))
    await mkdir(join(root, 'bin'))
    await writeFile(launcher, '')
    await symlink(launcher, entrypoint)
    const profile = HARNESS_PROFILES.get('pi')!
    const gate = profile.minimumVersion!
    expect(updateCommand(entrypoint, launcher, gate.source!)).toBeUndefined()
    await writeFile(
      join(agentDir, 'install', 'managed-install.json'),
      JSON.stringify({
        kind: 'pi-managed-install',
        schemaVersion: 1,
        layout: 'releases-v1',
      }),
    )
    expect(upgradeCommand(gate, entrypoint)).toBe('pi update --self')
    expect(upgradeCommand(profile.gateway!.minimumVersion!, entrypoint)).toBe('pi update --self')
    expect(updateCommand(entrypoint, join(root, 'lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), gate.source!)).toBe(
      'npm i -g @earendil-works/pi-coding-agent@latest',
    )
  })

  it('asks where managed pi updates itself from, and npm for any other pi', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-pi-release-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const launcher = join(root, 'agent', 'bin', 'pi')
    const marker = join(root, 'agent', 'install', 'managed-install.json')
    await mkdir(join(root, 'agent', 'bin'), { recursive: true })
    await mkdir(join(root, 'agent', 'install'))
    await writeFile(launcher, '')
    await writeFile(marker, '{"kind":"pi-managed-install","schemaVersion":1,"layout":"releases-v1"}')
    const npm = { registry: 'npm', name: '@earendil-works/pi-coding-agent' }
    const profile = HARNESS_PROFILES.get('pi')!
    for (const gate of [profile.minimumVersion!, profile.gateway!.minimumVersion!])
      expect(releaseLookup(join(root, 'pi'), launcher, gate.source!)).toEqual({ registry: 'pi' })
    const source = profile.minimumVersion!.source!
    expect(
      releaseLookup('/usr/local/bin/pi', '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', source),
    ).toEqual(npm)
    await rm(marker)
    expect(releaseLookup(launcher, launcher, source)).toEqual(npm)
  })

  it('names nothing for any other layout', () => {
    expect(updateCommand('/Users/a/.volta/bin/claude', '/Users/a/.volta/tools/image/packages/x/bin/claude', claude)).toBeUndefined()
    expect(updateCommand('/usr/local/bin/codex', undefined, codex)).toBeUndefined()
  })

  it('reads the real file behind a link, and falls back to the gate’s command where the layout names none', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-update-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const real = join(root, 'lib', 'node_modules', '@openai', 'codex', 'bin')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'codex.js'), '')
    await mkdir(join(root, 'bin'))
    await symlink(join(real, 'codex.js'), join(root, 'bin', 'codex'))
    await writeFile(join(root, 'bin', 'other'), '')
    const gate = HARNESS_PROFILES.get('codex')!.minimumVersion!
    expect(upgradeCommand(gate, join(root, 'bin', 'codex'))).toBe('npm i -g @openai/codex@latest')
    expect(upgradeCommand(gate, join(root, 'bin', 'other'))).toBe(gate.upgrade)
  })
})

describe('where a newer release is asked, by the install’s path alone', () => {
  const goose = { brew: ['block-goose-cli'] }

  it('asks Homebrew for a formula or cask the profile names, and nothing for another', () => {
    expect(releaseLookup('/opt/homebrew/bin/goose', '/opt/homebrew/Cellar/block-goose-cli/1.57.0/bin/goose', goose)).toEqual({
      registry: 'homebrew',
      kind: 'formula',
      name: 'block-goose-cli',
    })
    // A cask is asked of Homebrew even though npm names the same program: its builds trail npm.
    expect(releaseLookup('/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/0.170.0/codex', codex)).toEqual({
      registry: 'homebrew',
      kind: 'cask',
      name: 'codex',
    })
    expect(releaseLookup('/opt/homebrew/bin/codex', '/opt/homebrew/Cellar/someone-else/1.0/bin/codex', codex)).toBeUndefined()
  })

  it('asks npm for any other layout when the profile names a package, else nothing', () => {
    expect(releaseLookup('/Users/a/.local/bin/claude', '/Users/a/.local/share/claude/versions/2.1.330', claude)).toEqual({
      registry: 'npm',
      name: '@anthropic-ai/claude-code',
    })
    expect(releaseLookup('/Users/a/.local/bin/goose', '/Users/a/.local/bin/goose', goose)).toBeUndefined()
  })

  it('reads goose only for its releases: a gate no version fails', () => {
    const profile = HARNESS_PROFILES.get('goose')!
    expect(profile.minimumVersion).toBeUndefined()
    const gate = releaseGate(profile)!
    expect(gate).toMatchObject({ args: ['--version'], minimum: '0.0.0', source: goose })
    expect(gate.read('goose 1.57.0\n')).toBe('1.57.0')
    // A profile with a gate of its own keeps it.
    expect(releaseGate(HARNESS_PROFILES.get('codex'))).toBe(HARNESS_PROFILES.get('codex')!.minimumVersion)
  })
})
