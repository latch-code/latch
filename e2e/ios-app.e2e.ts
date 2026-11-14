import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
/** What only a software key imports (the same lists as `ios-live.e2e.ts`): SecKey from bytes and a private-key class constant. */
const SOFTWARE_KEY_SYMBOLS = ['_SecKeyCreateWithData', '_kSecAttrKeyClassPrivate']
/** Any use of a CryptoKit P-256 signing private key: its type, methods and metadata all carry this mangled name. */
const P256_PRIVATE_KEY = 'CryptoKit4P256O7SigningO10PrivateKeyV'
it.skipIf(process.platform !== 'darwin')(
  'builds the real iOS App for the simulator without signing, test identities or Keychain access',
  async context => {
    let sdks: string
    try {
      sdks = (await run('/usr/bin/xcodebuild', ['-showsdks'], { timeout: 15_000 })).stdout
    } catch {
      context.skip()
      return
    }
    if (!sdks.includes('iphonesimulator')) {
      context.skip()
      return
    }
    const directory = await mkdtemp(join(tmpdir(), 'latch-ios-app-build-'))
    try {
      await run(
        '/usr/bin/xcodebuild',
        [
          '-project',
          'native/ios/Latch.xcodeproj',
          '-scheme',
          'Latch',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          directory,
          '-clonedSourcePackagesDirPath',
          'native/ios/.build/xcode-packages',
          '-disableAutomaticPackageResolution',
          '-onlyUsePackageVersionsFromResolvedFile',
          'CODE_SIGNING_ALLOWED=NO',
          'ARCHS=arm64',
          'ONLY_ACTIVE_ARCH=YES',
          'build',
        ],
        { timeout: 110_000, maxBuffer: 16_777_216 },
      )
      const application = join(directory, 'Build/Products/Debug-iphonesimulator/Latch.app')
      const binary = await readFile(join(application, 'Latch'))
      expect(binary.readUInt32LE(0)).toBe(0xfeedfacf)
      // The notices and licences of the marks the App carries, shown under 设置 › 关于 › 开源许可.
      const bundled = await readdir(application)
      for (const name of ['NOTICE-brands.txt', 'SOURCES.txt', 'LICENSE-Apache-2.0.txt', 'LICENSE-lobe-icons.txt'])
        expect(bundled).toContain(name)
      const libraries = (await readdir(application)).filter(name => name.endsWith('.dylib'))
      const product = Buffer.concat([binary, ...(await Promise.all(libraries.map(name => readFile(join(application, name)))))])
      // The screenshot scenes and live mode's software keys live only in the LatchScreens target (`ios-screens.e2e.ts`,
      // `ios-live.e2e.ts`).
      for (const marker of [
        'Native fixture rejected the input',
        'FixtureKeys',
        'fixture plaintext',
        'LatchScreens fixture state',
        'ScreensStage',
        'LatchLive software keys',
        'LatchLive pairing-stage',
        'LatchLive connection-stage',
        'LiveSoftwareKeys',
        'LiveIdentityProvider',
        '-LatchLive',
      ])
        expect(product.includes(Buffer.from(marker))).toBe(false)
      // Structurally too: the product's keys are Secure Enclave keys, so it never imports what building a key from bytes
      // or making a CryptoKit P-256 private key needs (live mode's software keys do; `ios-live.e2e.ts` checks that).
      const imported = (
        await Promise.all(
          [join(application, 'Latch'), ...libraries.map(name => join(application, name))].map(
            async file => (await run('/usr/bin/nm', ['-u', file], { maxBuffer: 67_108_864 })).stdout,
          ),
        )
      ).join('\n')
      for (const symbol of SOFTWARE_KEY_SYMBOLS) expect(imported.split('\n')).not.toContain(symbol)
      expect(imported.split('\n').filter(symbol => symbol.includes(P256_PRIVATE_KEY))).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
