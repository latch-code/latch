import { execFile } from 'node:child_process'
import { open, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * What Latch.app's Info.plist says beyond its name and version. macOS asks for Local Network access on behalf of the app
 * that started the Host, with this text, and Bonjour registrations of a type outside `NSBonjourServices` may be refused.
 */
export const LOCAL_NETWORK_USAGE = '让附近已配对的手机找到并直接连接这台 Mac。'
export const BONJOUR_SERVICES = ['_latch._tcp']

export async function writeInfoPlist(plist: string, strings: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries({ ...strings, NSLocalNetworkUsageDescription: LOCAL_NETWORK_USAGE }))
    await run('/usr/bin/plutil', ['-replace', key, '-string', value, plist], { env: {} })
  // An array needs -json; -array only inserts an empty one.
  await run('/usr/bin/plutil', ['-replace', 'NSBonjourServices', '-json', JSON.stringify(BONJOUR_SERVICES), plist], { env: {} })
}

export interface ReleaseSigning {
  /** A Developer ID Application identity in the owner's keychain, by name or SHA-1. */
  identity: string
  /** The `xcrun notarytool store-credentials` profile name. */
  notaryProfile: string
}

const IDENTITY = /^(?:Developer ID Application: [^\0\n]{1,200} \([A-Z0-9]{10}\)|[A-F0-9]{40})$/u
const PROFILE = /^[A-Za-z0-9._-]{1,64}$/u

/**
 * `--release`: undefined without it. With it, the identity and notary profile come from the environment and nothing is
 * built without both, so a missing variable fails before any copy. The values are names, never secrets: the certificate
 * and the notary password stay in the owner's keychain.
 */
export function releaseSigning(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ReleaseSigning | undefined {
  const flags = argv.filter(argument => argument === '--release' || argument.startsWith('--release='))
  if (flags.length === 0) return undefined
  if (flags.length > 1 || flags[0] !== '--release') throw new Error('--release 不带值，且只能出现一次。')
  const identity = env.LATCH_SIGN_IDENTITY?.trim(),
    notaryProfile = env.LATCH_NOTARY_PROFILE?.trim()
  if (!identity)
    throw new Error(
      '正式发布需要 Developer ID 签名：请把钥匙串中的「Developer ID Application: 名称 (Team ID)」写入 LATCH_SIGN_IDENTITY 后重试。',
    )
  if (!IDENTITY.test(identity))
    throw new Error('LATCH_SIGN_IDENTITY 必须是「Developer ID Application: 名称 (Team ID)」或该证书的 SHA-1 指纹。')
  if (!notaryProfile)
    throw new Error('正式发布需要公证：请先运行 xcrun notarytool store-credentials 保存凭据，再把配置名写入 LATCH_NOTARY_PROFILE 后重试。')
  if (!PROFILE.test(notaryProfile)) throw new Error('LATCH_NOTARY_PROFILE 只能包含字母、数字、点、下划线与连字符。')
  if (!argv.includes('--presence-team')) throw new Error('正式发布需要 --presence-team <Team ID>，与签名证书的 Team ID 相同。')
  const team = /\(([A-Z0-9]{10})\)$/u.exec(identity)?.[1],
    presence = argv[argv.indexOf('--presence-team') + 1]
  if (team && presence !== team) throw new Error('--presence-team 与 LATCH_SIGN_IDENTITY 的 Team ID 不一致。')
  return { identity, notaryProfile }
}

/** The owner's keychain and notary profile live under their home; nothing else of the environment is passed on. */
function ownerEnv(): Record<string, string> {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) }
}

const MACH_O = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
function bundleExecutable(folder: string): boolean {
  return (
    (folder.endsWith(`${sep}Contents${sep}MacOS`) && folder.slice(0, -'/Contents/MacOS'.length).endsWith('.app'))
    || /\.framework\/Versions\/[^/]+$/u.test(folder)
  )
}
async function machO(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const { bytesRead, buffer } = await file.read(Buffer.alloc(4), 0, 4, 0)
    return bytesRead === 4 && MACH_O.has(buffer.readUInt32BE(0))
  } finally {
    await file.close()
  }
}

/**
 * Every signable piece under `app`, deepest first: loose Mach-O files, then framework versions and nested apps. A
 * bundle's own executable is left to its bundle, since codesign given that path signs the enclosing bundle.
 */
export async function signingOrder(app: string): Promise<{ files: string[]; bundles: string[] }> {
  const files: string[] = [],
    bundles: string[] = []
  async function walk(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(path)
        if (entry.name.endsWith('.app') || (folder.endsWith('.framework/Versions') && entry.name !== 'Current')) bundles.push(path)
      } else if (entry.isFile() && !bundleExecutable(folder) && (await machO(path))) files.push(path)
    }
  }
  await walk(join(app, 'Contents'))
  const depth = (path: string) => relative(app, path).split(sep).length
  return { files: files.toSorted((a, b) => depth(b) - depth(a)), bundles: bundles.toSorted((a, b) => depth(b) - depth(a)) }
}

/**
 * Signs Latch.app for distribution with the owner's Developer ID: hardened runtime and a secure timestamp on every
 * piece, inside out. Loose binaries keep their identifiers and entitlements (`dev.latch.network`, `dev.latch.cli`, …);
 * the app and Electron's helpers get JIT only. Library validation stays on: every framework now carries the same Team ID.
 */
export async function signForRelease(app: string, signing: ReleaseSigning, temporary: string): Promise<void> {
  const entitlements = join(temporary, 'ReleaseElectron.plist')
  await writeFile(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
  </dict>
</plist>
`,
  )
  const sign = (path: string, flags: string[]) =>
    run('/usr/bin/codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', signing.identity, ...flags, path], {
      env: ownerEnv(),
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    })
  const { files, bundles } = await signingOrder(app)
  for (const file of files) await sign(file, ['--preserve-metadata=identifier,entitlements'])
  for (const bundle of bundles) await sign(bundle, bundle.endsWith('.app') ? ['--entitlements', entitlements] : [])
  await sign(app, ['--entitlements', entitlements])
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { env: {}, timeout: 120_000, maxBuffer: 1024 * 1024 })
}

/** notarytool takes an archive, not an app: zip it with ditto, wait for Apple's answer, then staple the ticket to the app. */
export async function notarize(app: string, signing: ReleaseSigning, temporary: string): Promise<void> {
  const archive = join(temporary, 'Latch-notarize.zip')
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive], { env: {}, timeout: 600_000, maxBuffer: 1024 * 1024 })
  await run('/usr/bin/xcrun', ['notarytool', 'submit', archive, '--keychain-profile', signing.notaryProfile, '--wait'], {
    env: ownerEnv(),
    timeout: 3_600_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  await run('/usr/bin/xcrun', ['stapler', 'staple', app], { env: ownerEnv(), timeout: 300_000, maxBuffer: 1024 * 1024 })
  await run('/usr/bin/xcrun', ['stapler', 'validate', app], { env: ownerEnv(), timeout: 120_000, maxBuffer: 1024 * 1024 })
}
