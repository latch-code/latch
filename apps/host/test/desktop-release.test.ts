import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { BONJOUR_SERVICES, LOCAL_NETWORK_USAGE, releaseSigning, signingOrder, writeInfoPlist } from '../scripts/desktop-release.ts'

const run = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})
const identity = 'Developer ID Application: Example Person (ABCDE12345)'

it('builds the local package without --release and refuses a release without the owner’s identity or notary profile', () => {
  expect(releaseSigning(['--out', '/tmp/Latch.app'], { LATCH_SIGN_IDENTITY: identity })).toBeUndefined()
  const argv = ['--release', '--presence-team', 'ABCDE12345']
  expect(() => releaseSigning(argv, {})).toThrow('LATCH_SIGN_IDENTITY')
  expect(() => releaseSigning(argv, { LATCH_SIGN_IDENTITY: '  ' })).toThrow('LATCH_SIGN_IDENTITY')
  expect(() => releaseSigning(argv, { LATCH_SIGN_IDENTITY: '-' })).toThrow('Developer ID Application')
  expect(() => releaseSigning(argv, { LATCH_SIGN_IDENTITY: 'Apple Development: Example (ABCDE12345)' })).toThrow('Developer ID')
  expect(() => releaseSigning(argv, { LATCH_SIGN_IDENTITY: identity })).toThrow('LATCH_NOTARY_PROFILE')
  expect(() => releaseSigning(argv, { LATCH_SIGN_IDENTITY: identity, LATCH_NOTARY_PROFILE: 'a b' })).toThrow('LATCH_NOTARY_PROFILE')
  expect(() => releaseSigning(['--release'], { LATCH_SIGN_IDENTITY: identity, LATCH_NOTARY_PROFILE: 'latch' })).toThrow('--presence-team')
  expect(() =>
    releaseSigning(['--release', '--presence-team', 'ZZZZZ99999'], { LATCH_SIGN_IDENTITY: identity, LATCH_NOTARY_PROFILE: 'latch' }),
  ).toThrow('Team ID 不一致')
  expect(() => releaseSigning(['--release=yes'], { LATCH_SIGN_IDENTITY: identity, LATCH_NOTARY_PROFILE: 'latch' })).toThrow('不带值')
  expect(() => releaseSigning(['--release', '--release'], { LATCH_SIGN_IDENTITY: identity, LATCH_NOTARY_PROFILE: 'latch' })).toThrow(
    '只能出现一次',
  )
  expect(releaseSigning(argv, { LATCH_SIGN_IDENTITY: identity, LATCH_NOTARY_PROFILE: 'latch-notary' })).toEqual({
    identity,
    notaryProfile: 'latch-notary',
  })
  const sha = 'A'.repeat(40)
  expect(releaseSigning(argv, { LATCH_SIGN_IDENTITY: sha, LATCH_NOTARY_PROFILE: 'latch' })).toEqual({
    identity: sha,
    notaryProfile: 'latch',
  })
})

it.skipIf(process.platform !== 'darwin')('writes the Local Network description and the Bonjour type into Info.plist', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'latch-plist-'))
  cleanup.push(folder)
  const plist = join(folder, 'Info.plist')
  await writeFile(
    plist,
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>Electron</string></dict></plist>\n',
  )
  await writeInfoPlist(plist, { CFBundleName: 'Latch' })
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { env: {} })
  expect(JSON.parse(stdout)).toEqual({
    CFBundleName: 'Latch',
    NSLocalNetworkUsageDescription: LOCAL_NETWORK_USAGE,
    NSBonjourServices: BONJOUR_SERVICES,
  })
  expect(BONJOUR_SERVICES).toEqual(['_latch._tcp'])
})

it('signs every Mach-O piece inside out and skips links and other files', async () => {
  const app = join(await mkdtemp(join(tmpdir(), 'latch-sign-')), 'Latch.app')
  cleanup.push(join(app, '..'))
  const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
  const version = join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A')
  const helper = join(app, 'Contents/Frameworks/Latch Helper.app')
  for (const folder of [
    version,
    join(helper, 'Contents/MacOS'),
    join(app, 'Contents/MacOS'),
    join(app, 'Contents/Resources/app/dist/native'),
  ])
    await mkdir(folder, { recursive: true })
  await writeFile(join(version, 'Electron Framework'), machO)
  await mkdir(join(version, 'Helpers'), { recursive: true })
  await writeFile(join(version, 'Helpers/chrome_crashpad_handler'), machO)
  await mkdir(join(version, 'Libraries'), { recursive: true })
  await writeFile(join(version, 'Libraries/libffmpeg.dylib'), machO)
  await symlink('A', join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/Current'))
  await writeFile(join(helper, 'Contents/MacOS/Latch Helper'), machO)
  await writeFile(join(app, 'Contents/MacOS/Latch'), machO)
  await writeFile(join(app, 'Contents/Resources/app/dist/native/latch-network'), machO)
  await writeFile(join(app, 'Contents/Resources/app/dist/native/README'), 'text')
  const order = await signingOrder(app)
  const local = (path: string) => path.slice(app.length + 1)
  // A bundle's own executable is signed with its bundle, never as a loose file.
  expect(order.files.map(local).toSorted()).toEqual(
    [
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
      'Contents/Resources/app/dist/native/latch-network',
    ].toSorted(),
  )
  // Deeper files before shallower ones, and a framework version and helper app after their own contents.
  expect(local(order.files.at(-1)!)).toBe('Contents/Resources/app/dist/native/latch-network')
  expect(order.bundles.map(local)).toEqual([
    'Contents/Frameworks/Electron Framework.framework/Versions/A',
    'Contents/Frameworks/Latch Helper.app',
  ])
})
