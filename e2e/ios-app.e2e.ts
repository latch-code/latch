import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
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
      const libraries = (await readdir(application)).filter(name => name.endsWith('.dylib'))
      const product = Buffer.concat([binary, ...(await Promise.all(libraries.map(name => readFile(join(application, name)))))])
      for (const marker of ['Native fixture rejected the input', 'FixtureKeys', 'fixture plaintext'])
        expect(product.includes(Buffer.from(marker))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
