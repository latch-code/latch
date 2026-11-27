import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { build } from 'esbuild'
import { z } from 'zod'
import { makePrivateDirectory, ownedDirectory } from '@latch/link-client/private-directory'
import { relayGoEnvironment } from './go-environment.ts'

const execute = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

const runtimeLockSchema = z
  .object({
    version: z.literal(1),
    node: z
      .object({
        version: z.literal('24.22.1'),
        source: z.string(),
        amd64: z.string().regex(/^[a-f0-9]{64}$/u),
        arm64: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    runtimeImage: z
      .object({
        reference: z.string().regex(/^gcr\.io\/distroless\/cc-debian13@sha256:[a-f0-9]{64}$/u),
        uploadedAt: z.string().datetime(),
        source: z.string(),
      })
      .strict(),
  })
  .strict()

export type LinuxArch = 'amd64' | 'arm64'

async function cachedNodeArchive(
  version: string,
  arch: LinuxArch,
  expectedSha256: string,
  cacheRoot?: string,
  progress?: (line: string) => void,
): Promise<string> {
  const platform = arch === 'amd64' ? 'x64' : 'arm64'
  const filename = `node-v${version}-linux-${platform}.tar.xz`
  const baseDir = cacheRoot ?? join(homedir(), '.latch', 'relay-cache')
  const uid = process.getuid?.() ?? -1
  let dir: string | undefined
  const parent = dirname(baseDir)
  if (
    (await makePrivateDirectory(parent))
    && (await ownedDirectory(parent, uid, 0o077))
    && (await makePrivateDirectory(baseDir))
    && (await ownedDirectory(baseDir, uid, 0o077))
  ) {
    dir = baseDir
  }
  const target = dir ? join(dir, filename) : undefined
  if (target) {
    const existing = await lstat(target).catch(() => undefined)
    if (existing?.isFile() && !existing.isSymbolicLink() && (existing.mode & 0o077) === 0) {
      const digest = createHash('sha256')
        .update(await readFile(target))
        .digest('hex')
      if (digest === expectedSha256) return target
      await unlink(target).catch(() => {})
    }
  }

  progress?.(`下载并校验官方 Linux Node ${version}（${arch}）运行时`)
  const tempDir = await mkdtemp(join(tmpdir(), 'latch-node-dl-'))
  const archive = join(tempDir, filename)
  try {
    const response = await fetch(`https://nodejs.org/dist/v${version}/${filename}`, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > 128 * 1024 * 1024)
      throw new Error('无法下载官方 Linux Node 运行时压缩包')
    const file = await open(archive, 'wx', 0o600),
      hash = createHash('sha256')
    let count = 0
    try {
      for await (const chunk of response.body) {
        count += chunk.length
        if (count > 128 * 1024 * 1024) throw new Error('Node 运行时压缩包超出大小限制')
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.length) {
          const wrote = await file.write(chunk, offset, chunk.length - offset)
          if (!wrote.bytesWritten) throw new Error('写入 Node 运行时压缩包失败')
          offset += wrote.bytesWritten
        }
      }
    } finally {
      await file.close()
    }
    if (hash.digest('hex') !== expectedSha256) throw new Error('官方 Linux Node 运行时 SHA-256 校验失败')
    if (target) {
      await copyFile(archive, target)
      await rm(tempDir, { recursive: true, force: true })
      return target
    }
    return archive
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Produces a self-contained `latch-relay-linux-<arch>.tar.gz` containing:
 * - Official SHA-256-verified Linux `node` binary (`runtime.lock.json`)
 * - Bundled `latch-relay.mjs` (zero node_modules needed on the server)
 * - Static `latch-relay-tls` Go gateway/supervisor binary (`CGO_ENABLED=0`)
 * - Licenses and `build.json` SHA-256 manifest
 */
export async function buildLinuxRelayBundle(input: {
  arch: LinuxArch
  outTarball: string
  root?: string
  cacheDir?: string
  progress?(line: string): void
}): Promise<{ tarball: string; bundleSha256: string; hashes: Record<string, string> }> {
  const root = input.root ?? repoRoot
  if (!isAbsolute(input.outTarball)) throw new Error('输出包路径必须是绝对路径')
  const lock = runtimeLockSchema.parse(JSON.parse(await readFile(join(root, 'apps/relay/deploy/runtime.lock.json'), 'utf8')) as unknown)
  const stage = await mkdtemp(join(tmpdir(), `latch-relay-linux-${input.arch}-`))
  try {
    input.progress?.(`打包 Linux 中继脚本与 ${input.arch} TLS 网关`)
    const bundled = await build({
      absWorkingDir: root,
      entryPoints: ['apps/relay/src/cli.ts'],
      outfile: join(stage, 'latch-relay.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      metafile: true,
      write: false,
    })
    for (const file of Object.keys(bundled.metafile.inputs))
      if (/(?:^|\/)(?:tests?|e2e)\/|packages\/testkit|@latch\/testkit/u.test(file)) throw new Error('Relay bundle includes test code')
    for (const out of bundled.outputFiles) await writeFile(out.path, out.contents, { mode: 0o644 })

    const sdk = process.env.LATCH_RELAY_GO ?? 'go'
    const env = relayGoEnvironment(input.arch)
    await execute(
      sdk,
      [
        'build',
        '-trimpath',
        '-buildvcs=false',
        '-ldflags=-s -w -buildid=',
        '-o',
        join(stage, 'latch-relay-tls'),
        join(root, 'apps/relay/gateway/main.go'),
        join(root, 'apps/relay/gateway/supervisor.go'),
      ],
      { env, timeout: 120_000 },
    )
    await copyFile(join(root, 'apps/relay/gateway/GO-LICENSE'), join(stage, 'latch-relay-tls.LICENSE'))

    const platform = input.arch === 'amd64' ? 'x64' : 'arm64'
    const folder = `node-v${lock.node.version}-linux-${platform}`
    const archive = await cachedNodeArchive(lock.node.version, input.arch, lock.node[input.arch], input.cacheDir, input.progress)
    const baseEnv = relayGoEnvironment()
    await execute('tar', ['-xJf', archive, '--strip-components=2', '-C', stage, `${folder}/bin/node`], {
      env: baseEnv,
      timeout: 30_000,
    })
    const license = await execute('tar', ['-xJOf', archive, `${folder}/LICENSE`], {
      env: baseEnv,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    await writeFile(join(stage, 'NODE-LICENSE'), license.stdout, { flag: 'wx', mode: 0o644 })

    const elf = await open(join(stage, 'node'), 'r')
    try {
      const header = Buffer.alloc(20)
      await elf.read(header, 0, 20, 0)
      if (!header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || header.readUInt16LE(18) !== (input.arch === 'amd64' ? 62 : 183))
        throw new Error('Node 二进制架构不匹配')
    } finally {
      await elf.close()
    }

    const files = ['node', 'latch-relay.mjs', 'latch-relay-tls', 'latch-relay-tls.LICENSE', 'NODE-LICENSE'] as const
    const hashes: Record<string, string> = {}
    for (const file of files) {
      hashes[file] = createHash('sha256')
        .update(await readFile(join(stage, file)))
        .digest('hex')
    }
    await writeFile(
      join(stage, 'build.json'),
      `${JSON.stringify({ version: 1, platform: `linux/${input.arch}`, node: lock.node.version, hashes }, null, 2)}\n`,
      { flag: 'wx', mode: 0o644 },
    )
    await mkdir(dirname(input.outTarball), { recursive: true, mode: 0o700 })
    await execute('tar', ['-czf', input.outTarball, '-C', stage, ...files, 'build.json'], { env: baseEnv, timeout: 60_000 })
    const bundleSha256 = createHash('sha256')
      .update(await readFile(input.outTarball))
      .digest('hex')
    return { tarball: input.outTarball, bundleSha256, hashes }
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (isMain) {
  const { values } = parseArgs({
    strict: true,
    options: { arch: { type: 'string' }, out: { type: 'string' } },
  })
  if (!values.out || !isAbsolute(values.out) || (values.arch !== 'amd64' && values.arch !== 'arm64'))
    throw new Error('Usage: bundle-linux.ts --arch amd64|arm64 --out /absolute/path/latch-relay-linux.tar.gz')
  const built = await buildLinuxRelayBundle({
    arch: values.arch,
    outTarball: resolve(values.out),
    progress: line => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify({ built: true, arch: values.arch, out: built.tarball, sha256: built.bundleSha256 })}\n`)
}
