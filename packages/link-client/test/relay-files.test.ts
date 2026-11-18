import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { chooseRelayFile, legacyDeployDir, prepareRelayDeployDir, prepareRelaysDir, relayFilePath, relayNames } from '../src/relay-files.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'latch-relay-files-'))
  homes.push(home)
  return home
}
const mode = async (path: string) => (await stat(path)).mode & 0o777
/** Runs a printed command the way a person's shell would, with this HOME and a typical umask. */
const shell = (home: string, command: string) =>
  promisify(execFile)('/bin/sh', ['-c', `umask 022; ${command}`], { env: { PATH: '/usr/bin:/bin', HOME: home } })

it('makes ~/.latch and ~/.latch/relays 0700 one level at a time, and the deploy directory below them', async () => {
  const home = await temporaryHome()
  const relays = await prepareRelaysDir(home)
  expect(relays).toBe(join(home, '.latch', 'relays'))
  expect(await mode(join(home, '.latch'))).toBe(0o700)
  expect(await mode(relays)).toBe(0o700)
  const deploy = await prepareRelayDeployDir('ne', home)
  expect(deploy).toBe(join(relays, 'ne', 'deploy'))
  expect(await mode(join(relays, 'ne'))).toBe(0o700)
  expect(await mode(deploy)).toBe(0o700)
  // Idempotent on its own directories.
  expect(await prepareRelaysDir(home)).toBe(relays)
  await expect(prepareRelayDeployDir('../x', home)).rejects.toThrow(/名称/u)
  // Never creates HOME itself.
  await expect(prepareRelaysDir(join(home, 'missing'))).rejects.toThrow()
  await expect(prepareRelaysDir('relative')).rejects.toThrow(/HOME/u)
})

it('refuses a ~/.latch or relays directory that is a link or that others can open', async () => {
  const wide = await temporaryHome()
  await mkdir(join(wide, '.latch'), { mode: 0o700 })
  await chmod(join(wide, '.latch'), 0o755)
  await expect(prepareRelaysDir(wide)).rejects.toThrow('~/.latch 必须是你自己的目录，权限 0700，不能是链接')
  await expect(relayNames(wide)).rejects.toThrow(/~\/\.latch /u)

  const group = await temporaryHome()
  await prepareRelaysDir(group)
  await chmod(join(group, '.latch', 'relays'), 0o750)
  await expect(chooseRelayFile({ home: group })).rejects.toThrow('~/.latch/relays 必须是你自己的目录')

  const linked = await temporaryHome()
  const elsewhere = join(linked, 'elsewhere')
  await mkdir(elsewhere, { mode: 0o700 })
  await symlink(elsewhere, join(linked, '.latch'))
  await expect(prepareRelaysDir(linked)).rejects.toThrow(/不能是链接/u)
  // Nothing was created through the link.
  expect(await readdir(elsewhere)).toEqual([])

  const linkedRelays = await temporaryHome()
  await mkdir(join(linkedRelays, '.latch'), { mode: 0o700 })
  await mkdir(join(linkedRelays, 'other'), { mode: 0o700 })
  await symlink(join(linkedRelays, 'other'), join(linkedRelays, '.latch', 'relays'))
  await expect(relayNames(linkedRelays)).rejects.toThrow(/~\/\.latch\/relays/u)
})

it('lists regular <name>.json files only and picks the file a command reads when none is named', async () => {
  const home = await temporaryHome()
  await expect(chooseRelayFile({ home })).rejects.toThrow('~/.latch/relays 里没有中继文件；用 --file <中继文件> 指定')
  const relays = await prepareRelaysDir(home)
  await writeFile(join(relays, 'ne.json'), '{"secret":"never-shown"}', { mode: 0o600 })
  await writeFile(join(relays, 'ne.json.admin-header'), 'Authorization: Bearer x\n', { mode: 0o600 })
  await writeFile(join(relays, 'Bad_Name.json'), '{}', { mode: 0o600 })
  await mkdir(join(relays, 'ne'), { mode: 0o700 })
  await mkdir(join(relays, 'dir.json'), { mode: 0o700 })
  await writeFile(join(home, 'outside.json'), '{}')
  await symlink(join(home, 'outside.json'), join(relays, 'link.json'))
  expect(await relayNames(home)).toEqual(['ne'])
  expect(await chooseRelayFile({ home })).toBe(relayFilePath('ne', home))
  expect(await chooseRelayFile({ home, name: 'ne' })).toBe(join(relays, 'ne.json'))
  await expect(chooseRelayFile({ home, name: 'se' })).rejects.toThrow('~/.latch/relays 里没有 se.json')
  await expect(chooseRelayFile({ home, name: '../ne' })).rejects.toThrow(/名称/u)
  await expect(chooseRelayFile({ home, name: 'link' })).rejects.toThrow(/没有 link\.json/u)

  await writeFile(join(relays, 'se.json'), '{"secret":"never-shown"}', { mode: 0o600 })
  const several = chooseRelayFile({ home })
  await expect(several).rejects.toThrow('~/.latch/relays 里有 ne、se；用 --name <名称> 选一个，或用 --file <中继文件>')
  await expect(several).rejects.not.toThrow(/never-shown/u)
})

it('finds an earlier deploy directory without touching it', async () => {
  const home = await temporaryHome()
  expect(await legacyDeployDir('ne', home)).toBeUndefined()
  await mkdir(join(home, '.latch-relay', 'latch-relay-ne'), { recursive: true, mode: 0o700 })
  expect(await legacyDeployDir('ne', home)).toBe(join(home, '.latch-relay', 'latch-relay-ne'))
  expect(await legacyDeployDir('se', home)).toBeUndefined()
  expect((await lstat(join(home, '.latch-relay'))).isDirectory()).toBe(true)
})

it('accepts what the printed move and fetch commands create, under a 022 umask', async () => {
  // The two commands that move an earlier run's files (relay file beside HOME, deploy directory in ~/.latch-relay).
  const home = await temporaryHome()
  await mkdir(join(home, '.latch-relay', 'latch-relay-ne'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, '.latch-relay', 'latch-relay-ne', 'wrangler.jsonc'), '{}', { mode: 0o600 })
  await writeFile(join(home, 'latch-relay-ne.json'), '{}', { mode: 0o600 })
  await writeFile(join(home, 'latch-relay-ne.json.admin-header'), 'Authorization: Bearer x\n', { mode: 0o600 })
  await shell(
    home,
    '(umask 077 && mkdir -p ~/.latch/relays/ne) && mv -n ~/latch-relay-ne.json ~/.latch/relays/ne.json && mv -n ~/latch-relay-ne.json.admin-header ~/.latch/relays/ne.json.admin-header',
  )
  await shell(home, 'mv -n ~/.latch-relay/latch-relay-ne ~/.latch/relays/ne/deploy && rmdir ~/.latch-relay')
  expect(await relayNames(home)).toEqual(['ne'])
  expect(await prepareRelayDeployDir('ne', home)).toBe(join(home, '.latch', 'relays', 'ne', 'deploy'))
  expect(await readdir(join(home, '.latch', 'relays', 'ne', 'deploy'))).toEqual(['wrangler.jsonc'])
  expect(await mode(join(home, '.latch'))).toBe(0o700)
  expect(await legacyDeployDir('ne', home)).toBeUndefined()

  // The Linux relay's fetch step, with the scp replaced by a copy.
  const fresh = await temporaryHome()
  await writeFile(join(fresh, 'remote.json'), '{}', { mode: 0o600 })
  await shell(fresh, '(umask 077 && mkdir -p ~/.latch/relays) && cp ~/remote.json ~/.latch/relays/relay-example-com.json')
  expect(await chooseRelayFile({ home: fresh })).toBe(relayFilePath('relay-example-com', fresh))
})
