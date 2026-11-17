import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { z } from 'zod'
import { presenceIdentity } from '../src/presence-identity.ts'
import { hostBundleOptions, REPOSITORY_ROOT } from './host-bundle.ts'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const Manifest = z.object({ name: z.string(), version: z.string(), license: z.string(), engines: z.object({ node: z.string() }) })

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`)
  return value
}

async function compile(source: string, output: string, extras: string[] = []) {
  await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-O', '-parse-as-library', '-o', output, source, ...extras], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
}

async function signAdHoc(path: string, flags: string[] = []): Promise<void> {
  await run('/usr/bin/codesign', ['--force', '--sign', '-', ...flags, path], {
    env: {},
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
}

async function signLocalElectronApp(app: string, temporary: string): Promise<void> {
  // V8 uses JIT. An ad-hoc Electron process also needs to load the bundled frameworks, which have no Team ID.
  const entitlements = join(temporary, 'AdHocElectron.plist')
  await writeFile(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
`,
  )
  const electronFlags = ['--options', 'runtime', '--entitlements', entitlements]
  const frameworks = join(app, 'Contents/Frameworks')
  // Electron's installed archive lacks resource seals on its bundles. Seal each framework version and helper
  // before the outer application records their signatures. The standalone binaries inside them are already signed.
  for (const entry of await readdir(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(frameworks, entry.name)
    if (entry.name.endsWith('.framework')) {
      const versions = join(path, 'Versions')
      for (const version of await readdir(versions, { withFileTypes: true })) {
        if (version.isDirectory()) await signAdHoc(join(versions, version.name))
      }
    } else if (entry.name.endsWith('.app')) {
      await signAdHoc(path, electronFlags)
    }
  }
  await signAdHoc(app, electronFlags)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { env: {}, timeout: 30_000, maxBuffer: 1024 * 1024 })
}

/** Copies only the installed runtime tools, retaining their exact versions and licenses. No registry access. */
async function copyTool(name: string, root: string, from = import.meta.url): Promise<string> {
  const folder = dirname(await realpath(createRequire(from).resolve(`${name}/package.json`)))
  await cp(folder, join(root, 'node_modules', name), {
    recursive: true,
    dereference: true,
    filter: path => !path.includes('/node_modules/', folder.length),
  })
  return join(folder, 'package.json')
}

async function copyBundledLicenses(inputs: string[], root: string): Promise<void> {
  const packages = new Set<string>()
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue
    let folder = dirname(resolve(REPOSITORY_ROOT, input))
    while (folder.includes('/node_modules/')) {
      const metadata = await readFile(join(folder, 'package.json'), 'utf8').then(
        text => JSON.parse(text) as { name?: unknown; version?: unknown },
        () => undefined,
      )
      if (metadata && typeof metadata.name === 'string' && typeof metadata.version === 'string') {
        packages.add(folder)
        break
      }
      folder = dirname(folder)
    }
  }
  for (const folder of packages) {
    const value = z
      .object({ name: z.string(), version: z.string() })
      .parse(JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')))
    const destination = join(root, 'licenses/bundled', `${value.name.replaceAll('/', '__')}@${value.version}`)
    await mkdir(destination, { recursive: true })
    for (const name of await readdir(folder))
      if (/^(?:licen[sc]e|copying|notice)(?:\.|$)/iu.test(name)) await cp(join(folder, name), join(destination, name), { recursive: true })
  }
}

async function packageDesktop(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Latch.app 的打包只支持 macOS')
  const team = option('--presence-team')
  if (process.argv.includes('--release') && !team) throw new Error('发布构建缺少 --presence-team <Apple Team ID>；不会使用开发信任模式代替')
  if (team) presenceIdentity(team)
  const output = resolve(option('--out') ?? join(REPOSITORY_ROOT, 'out', 'Latch.app'))
  if (
    await access(output).then(
      () => true,
      () => false,
    )
  )
    throw new Error('输出路径已存在；请使用新的 --out <Latch.app> 路径')
  const manifest = Manifest.parse(JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8')))
  const nativeFiles = ['latch-presence', 'latch-network', 'latch-files', 'latch-pty', 'latch-simulator', 'latch-native-tls']
  for (const file of nativeFiles) await access(join(REPOSITORY_ROOT, 'dist/native', file), constants.X_OK)
  await access(join(REPOSITORY_ROOT, 'dist/web/index.html'))
  await mkdir(dirname(output), { recursive: true })
  const temporary = await mkdtemp(join(dirname(output), '.latch-package-'))
  try {
    const app = join(temporary, 'Latch.app')
    const electron = require('electron') as string
    await cp(resolve(dirname(electron), '../..'), app, { recursive: true, dereference: false, verbatimSymlinks: true })
    const contents = join(app, 'Contents')
    const resources = join(contents, 'Resources')
    const root = join(resources, 'app')
    await rm(join(resources, 'default_app.asar'), { force: true })
    await mkdir(join(root, 'dist'), { recursive: true })
    await mkdir(join(resources, 'bin'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          ...manifest,
          type: 'module',
          main: 'apps/desktop/src/main.cjs',
          exports: {
            '.': './dist/host/index.js',
            './plugin-sdk': './dist/core/plugins.js',
            './harness-sdk': './dist/core/harness.js',
            './package.json': './package.json',
          },
        },
        null,
        2,
      )}\n`,
    )
    const bundle = await hostBundleOptions({ packaged: true, ...(team ? { presenceTeam: team } : {}) })
    const built = await build({
      ...bundle,
      absWorkingDir: REPOSITORY_ROOT,
      entryPoints: {
        start: 'apps/host/scripts/start.ts',
        latch: 'apps/host/scripts/latch.ts',
        'desktop-launch': 'apps/host/scripts/desktop-launch.ts',
        'host/index': 'apps/host/src/server.ts',
        'core/plugins': 'src/plugin-sdk.ts',
        'core/harness': 'src/harness-sdk.ts',
      },
      outdir: join(root, 'dist'),
      sourcemap: false,
      metafile: true,
    })
    await copyBundledLicenses(Object.keys(built.metafile!.inputs), root)
    await cp(join(REPOSITORY_ROOT, 'dist/web'), join(root, 'dist/web'), { recursive: true })
    await mkdir(join(root, 'dist/native'), { recursive: true })
    for (const file of nativeFiles) await copyFile(join(REPOSITORY_ROOT, 'dist/native', file), join(root, 'dist/native', file))
    // The desktop modules use only Node, Electron, and one another. No source workspace or development dependencies ship.
    const desktop = join(root, 'apps/desktop/src')
    await mkdir(desktop, { recursive: true })
    for (const file of await readdir(join(REPOSITORY_ROOT, 'apps/desktop/src'))) {
      if (file.endsWith('.cjs')) await copyFile(join(REPOSITORY_ROOT, 'apps/desktop/src', file), join(desktop, file))
    }
    await mkdir(join(root, 'apps/web/public'), { recursive: true })
    await copyFile(join(REPOSITORY_ROOT, 'apps/web/public/icon.png'), join(root, 'apps/web/public/icon.png'))
    const iconset = join(temporary, 'Latch.iconset')
    await mkdir(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2])
        await run(
          '/usr/bin/sips',
          [
            '-z',
            String(size * scale),
            String(size * scale),
            join(REPOSITORY_ROOT, 'apps/web/public/icon.png'),
            '--out',
            join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
          ],
          { env: {}, maxBuffer: 16 * 1024 },
        )
    }
    await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'Latch.icns')], { env: {} })
    await copyFile(join(REPOSITORY_ROOT, 'LICENSE'), join(root, 'LICENSE'))
    const esbuild = await copyTool('esbuild', root)
    await copyTool(`@esbuild/${process.platform}-${process.arch}`, root, esbuild)
    const typescript = await copyTool('typescript', root)
    await copyTool(`@typescript/typescript-${process.platform}-${process.arch}`, root, typescript)
    const react = await copyTool('@types/react', root)
    await copyTool('csstype', root, react)
    const cli = join(resources, 'bin/latch')
    await compile(join(REPOSITORY_ROOT, 'native/macos/LatchCLI.swift'), cli)
    await chmod(cli, 0o755)
    await signAdHoc(cli, ['--options', 'runtime', '--identifier', 'dev.latch.cli'])
    if (team) {
      const identity = join(temporary, 'ReleaseTeam.swift')
      await writeFile(identity, `enum ReleaseTeam { static let id = "${team}" }\n`)
      await compile(join(REPOSITORY_ROOT, 'native/macos/LatchPresenceLaunch.swift'), join(root, 'dist/native/latch-presence-launch'), [
        identity,
        '-framework',
        'Security',
      ])
    }
    await rename(join(contents, 'MacOS/Electron'), join(contents, 'MacOS/Latch'))
    const plist = join(contents, 'Info.plist')
    for (const [key, value] of Object.entries({
      CFBundleName: 'Latch',
      CFBundleDisplayName: 'Latch',
      CFBundleIdentifier: 'dev.latch.desktop',
      CFBundleExecutable: 'Latch',
      CFBundleIconFile: 'Latch.icns',
      CFBundleVersion: manifest.version,
      CFBundleShortVersionString: manifest.version,
    }))
      await run('/usr/bin/plutil', ['-replace', key, '-string', value, plist], { env: {} })
    await signLocalElectronApp(app, temporary)
    // The local package uses ad-hoc signing. Release identity mode deliberately fails closed until its native components
    // are signed by the owner; no signing identity, keychain, account, updater, or notarization is accessed here.
    await rename(app, output)
    console.log(`已生成 ad-hoc 签名的本机应用：${output}${team ? '（发布身份组件尚需所有者签名）' : ''}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await packageDesktop()
