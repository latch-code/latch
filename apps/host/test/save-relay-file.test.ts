import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareRelaysDir, relayFilePath } from '@latch/link-client/relay-files'
import { listRelayFiles } from '../src/relay/relay-files.ts'
import { saveRelayFile } from '../src/relay/save-relay-file.ts'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'latch-relay-archive-'))
  homes.push(home)
  return home
}

const edge = {
  relayId: 'a'.repeat(32),
  url: 'https://relay.example/',
  kind: 'edge' as const,
  relayKey: 'c'.repeat(64),
  registrationKey: `lrt1.${'x'.repeat(43)}`,
  extraUrls: ['https://second.example/'],
  shard: 0,
}
const self = { relayId: 'b'.repeat(32), url: 'https://self.example/', spkiHash: 'd'.repeat(64), registrationKey: null }

const hasTemporaryArchive = (directory: string, written: boolean) =>
  readdirSync(directory).some(entry => entry.startsWith('.relay-archive-') && lstatSync(join(directory, entry)).size > 0 === written)

it('archives only portable fields with the version and private mode, preserving an explicit null', async () => {
  const home = await temporaryHome()
  const withHostFields = { ...edge, disabled: true, activeSlot: 0, adminToken: 'not a profile field' }
  await saveRelayFile(withHostFields, 'ne', home)
  await saveRelayFile(self, '../other', home)
  expect((await lstat(join(home, '.latch'))).mode & 0o777).toBe(0o700)
  const directory = join(home, '.latch', 'relays')
  expect((await lstat(directory)).mode & 0o777).toBe(0o700)
  for (const [name, version, profile] of [
    ['ne', 2, edge],
    [self.relayId, 1, self],
  ] as const) {
    const path = relayFilePath(name, home)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version, profile })
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
  }
  expect((await readdir(directory)).toSorted()).toEqual([`${self.relayId}.json`, 'ne.json'])
})

it('reuses an equivalent archive under another name, including concurrent saves', async () => {
  const home = await temporaryHome()
  const directory = await prepareRelaysDir(home)
  const original = relayFilePath('from-setup', home)
  const existing = `${JSON.stringify({ profile: { ...edge, relayId: edge.relayId }, version: 2 }, null, 2)}\n`
  await writeFile(original, existing, { mode: 0o600 })
  const admin = `${original}.admin-header`
  await writeFile(admin, 'operator file', { mode: 0o600 })
  await Promise.all([
    saveRelayFile(edge, 'ne', home),
    saveRelayFile(edge, undefined, home),
    saveRelayFile(self, 'one', home),
    saveRelayFile(self, 'two', home),
  ])
  const files = await readdir(directory)
  expect(files).toContain('from-setup.json')
  expect(files).toContain('from-setup.json.admin-header')
  expect(files.filter(file => /^(?:one|two)\.json$/u.test(file))).toHaveLength(1)
  expect(files).toHaveLength(3)
  expect(await readFile(original, 'utf8')).toBe(existing)
  expect(await readFile(admin, 'utf8')).toBe('operator file')
})

it('reuses v1 and v2 files that omit registrationKey when the new profile also has no token', async () => {
  const home = await temporaryHome()
  const directory = await prepareRelaysDir(home)
  const profiles = [
    { relayId: self.relayId, url: self.url, spkiHash: self.spkiHash },
    { relayId: edge.relayId, url: edge.url, kind: edge.kind, relayKey: edge.relayKey },
  ] as const
  for (const [index, profile] of profiles.entries()) {
    const path = relayFilePath(`existing-${index}`, home)
    const content = JSON.stringify({ version: index + 1, profile })
    await writeFile(path, content, { mode: 0o600 })
    await saveRelayFile(profile, undefined, home)
    await saveRelayFile({ ...profile, registrationKey: undefined }, 'other', home)
    await saveRelayFile({ ...profile, registrationKey: null }, 'other', home)
    expect(await readFile(path, 'utf8')).toBe(content)
  }
  expect((await readdir(directory)).toSorted()).toEqual(['existing-0.json', 'existing-1.json'])
})

it('uses the node ID when another writer takes a name just before publication', async () => {
  const home = await temporaryHome()
  const directory = await prepareRelaysDir(home)
  const chosen = relayFilePath('ne', home)
  let claimed = false
  await saveRelayFile(edge, 'ne', home, () => {
    if (claimed || !hasTemporaryArchive(directory, true)) return
    writeFileSync(chosen, 'another file', { flag: 'wx', mode: 0o600 })
    claimed = true
  })
  expect(claimed).toBe(true)
  expect(await readFile(chosen, 'utf8')).toBe('another file')
  const fallback = relayFilePath(edge.relayId, home)
  expect(JSON.parse(await readFile(fallback, 'utf8'))).toEqual({ version: 2, profile: edge })
  await expect(saveRelayFile({ ...edge, registrationKey: `lrt1.${'z'.repeat(43)}` }, 'ne', home)).rejects.toThrow(/占用/u)
  expect(JSON.parse(await readFile(fallback, 'utf8'))).toEqual({ version: 2, profile: edge })
  expect((await readdir(directory)).toSorted()).toEqual([`${edge.relayId}.json`, 'ne.json'])
})

it('leaves links and non-private files untouched and refuses unsafe archive directories', async () => {
  const home = await temporaryHome()
  const directory = await prepareRelaysDir(home)
  const external = join(home, 'elsewhere.json')
  await writeFile(external, JSON.stringify({ version: 2, profile: edge }), { mode: 0o600 })
  const alias = relayFilePath('ne', home)
  await symlink(external, alias)
  await writeFile(relayFilePath('shared', home), JSON.stringify({ version: 2, profile: edge }), { mode: 0o644 })
  await saveRelayFile(edge, 'ne', home)
  expect(await readlink(alias)).toBe(external)
  expect((await lstat(relayFilePath('shared', home))).mode & 0o777).toBe(0o644)
  expect(JSON.parse(await readFile(relayFilePath(edge.relayId, home), 'utf8'))).toEqual({ version: 2, profile: edge })

  await chmod(directory, 0o750)
  await expect(saveRelayFile(self, undefined, home)).rejects.toThrow(/权限 0700/u)
  const linked = await temporaryHome()
  const outside = join(linked, 'outside')
  await mkdir(outside, { mode: 0o700 })
  await mkdir(join(linked, '.latch'), { mode: 0o700 })
  await symlink(outside, join(linked, '.latch', 'relays'))
  await expect(saveRelayFile(self, undefined, linked)).rejects.toThrow(/不能是链接/u)
  expect(await readdir(outside)).toEqual([])
})

it.runIf(process.platform === 'darwin')(
  'accepts the usual home deny ACL and refuses extra read access to a relay file or archive',
  async () => {
    const home = await temporaryHome()
    const directory = await prepareRelaysDir(home)
    const legacy = join(home, 'latch-relay-ne.json')
    await writeFile(legacy, JSON.stringify({ version: 2, profile: edge }), { mode: 0o600 })
    try {
      execFileSync('/bin/chmod', ['+a', 'everyone deny delete', home])
      expect((await listRelayFiles(new Set(), home)).map(file => file.name)).toEqual(['ne'])
      execFileSync('/bin/chmod', ['+a', 'everyone allow read', legacy])
      expect((await lstat(legacy)).mode & 0o777).toBe(0o600)
      expect(await listRelayFiles(new Set(), home)).toEqual([])
      execFileSync('/bin/chmod', ['+a', 'everyone allow read,file_inherit,directory_inherit', directory])
      await expect(saveRelayFile(edge, 'ne', home)).rejects.toThrow(/访问权限/u)
      expect(await readdir(directory)).toEqual([])
    } finally {
      for (const path of [legacy, directory, home]) execFileSync('/bin/chmod', ['-N', path])
    }
  },
)

it('does not create an archive for invalid data or a caller that loses authorization', async () => {
  const home = await temporaryHome()
  await expect(saveRelayFile({ ...self, relayId: '../invalid' }, undefined, home)).rejects.toThrow(/无法归档/u)
  const denied = new Error('revoked')
  await expect(
    saveRelayFile(self, 'ne', home, () => {
      throw denied
    }),
  ).rejects.toBe(denied)
  expect(await readdir(home)).toEqual([])

  const directory = await prepareRelaysDir(home)
  for (const written of [false, true]) {
    await expect(
      saveRelayFile(self, 'ne', home, () => {
        if (hasTemporaryArchive(directory, written)) throw denied
      }),
    ).rejects.toBe(denied)
    expect(await readdir(directory)).toEqual([])
  }
  await saveRelayFile(self, 'ne', home)
  expect(await readdir(directory)).toEqual(['ne.json'])
})
