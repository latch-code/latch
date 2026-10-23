import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { parseDocument } from 'yaml'

const DAY = 86_400_000
const INSTALL_TIMEOUT = 120_000
/** Written by the build-script canary's postinstall; its presence means a dependency script ran. */
const SCRIPT_MARKER = 'supply-canary-script-ran'

/** How to start the pnpm under test: a native executable, or node with pnpm's entry script. */
export interface PnpmCommand {
  file: string
  args: string[]
}

/** The pnpm running this process (`pnpm check:supply`, `pnpm test`), which pnpm records in npm_execpath. */
export function pnpmFromEnvironment(env: NodeJS.ProcessEnv = process.env): PnpmCommand | undefined {
  const path = env.npm_execpath
  if (!path || !/pnpm/i.test(path)) return undefined
  return /\.[cm]?js$/.test(path) ? { file: process.execPath, args: [path] } : { file: path, args: [] }
}

/** The version the given pnpm reports when run outside any project, where it cannot switch versions. */
export async function pnpmVersion(pnpm: PnpmCommand): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'latch-pnpm-'))
  try {
    const { code, output } = await runPnpm(pnpm, ['--version'], directory, directory)
    if (code !== 0) throw new Error(`pnpm --version 以状态 ${code} 退出：${output.trim()}`)
    return output.trim().split('\n').at(-1)!.trim()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export interface Canary {
  id: string
  title: string
  dependencies: Record<string, string>
  /** The pnpm error code that shows the policy, and not some other failure, stopped the install. */
  expectedCode: string
  /** Workspace settings under which the canary installs: the protection it stands for. */
  weakenedBy: Record<string, unknown>
  /** Resolve a lockfile with the age check off, then run a frozen install under the real settings. */
  frozen?: boolean
}

export const CANARIES: readonly Canary[] = [
  {
    id: 'build-script',
    title: '带 postinstall 的依赖',
    dependencies: { 'canary-build-script': '1.0.0' },
    expectedCode: 'ERR_PNPM_IGNORED_BUILDS',
    weakenedBy: { strictDepBuilds: false },
  },
  {
    id: 'immature',
    title: '发布不足 7 天的版本',
    dependencies: { 'canary-immature': '1.0.0' },
    expectedCode: 'ERR_PNPM_NO_MATURE_MATCHING_VERSION',
    weakenedBy: { minimumReleaseAge: 1440 },
  },
  {
    id: 'git-subdependency',
    title: '来自 git 的传递依赖',
    dependencies: { 'canary-git-parent': '1.0.0' },
    expectedCode: 'ERR_PNPM_EXOTIC_SUBDEP',
    weakenedBy: { blockExoticSubdeps: false },
  },
  {
    id: 'missing-time',
    title: '没有发布时间的元数据',
    dependencies: { 'canary-no-time': '1.0.0' },
    expectedCode: 'ERR_PNPM_MISSING_TIME',
    weakenedBy: { minimumReleaseAgeIgnoreMissingTime: true },
  },
  {
    id: 'trust-downgrade',
    title: '信任证据下降的版本',
    dependencies: { 'canary-trust': '1.0.1' },
    expectedCode: 'ERR_PNPM_TRUST_DOWNGRADE',
    weakenedBy: { trustPolicy: 'off' },
  },
  {
    id: 'unverified-lockfile',
    title: '锁文件里发布不足 7 天的版本（冻结安装）',
    dependencies: { 'canary-immature': '1.0.0' },
    expectedCode: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
    weakenedBy: { trustLockfile: true },
    frozen: true,
  },
]

/** A mature, script-free package that must install; otherwise a failing canary proves nothing. */
export const CONTROL: Canary = {
  id: 'control',
  title: '对照：满 7 天、无脚本的依赖',
  dependencies: { 'canary-mature': '1.0.0' },
  expectedCode: '',
  weakenedBy: {},
}

export interface CanaryResult {
  id: string
  title: string
  installed: boolean
  codes: string[]
  scriptRan: boolean
  output: string
}

/** A canary holds when the install failed with its own error code and no dependency script ran. */
export function canaryHeld(canary: Canary, result: CanaryResult): boolean {
  return !result.installed && result.codes.includes(canary.expectedCode) && !result.scriptRan
}

/** Returns pnpm-workspace.yaml with the given top-level settings replaced, keeping everything else. */
export function withSettings(workspaceYaml: string, settings: Record<string, unknown>): string {
  const document = parseDocument(workspaceYaml)
  for (const [key, value] of Object.entries(settings)) document.set(key, value)
  return String(document)
}

export interface CanaryRunOptions {
  pnpm: PnpmCommand
  /** The workspace file each canary installs under: the repository's own, or one adjusted per canary. */
  workspaceYaml: string | ((canary: Canary) => string)
  canaries?: readonly Canary[]
}

/**
 * Installs each canary, and the control, in its own temporary project against a registry on 127.0.0.1.
 * Nothing touches the repository, the user's pnpm store, cache or configuration.
 */
export async function runCanaries(options: CanaryRunOptions): Promise<CanaryResult[]> {
  const root = await mkdtemp(join(tmpdir(), 'latch-supply-'))
  try {
    const home = join(root, 'home')
    await mkdir(home)
    const gitUrl = await createGitPackage(join(root, 'git-child'), home)
    const registry = await startCanaryRegistry(canaryPackages(gitUrl))
    try {
      const canaries = [CONTROL, ...(options.canaries ?? CANARIES)]
      return await Promise.all(
        canaries.map(canary => {
          const workspaceYaml = typeof options.workspaceYaml === 'string' ? options.workspaceYaml : options.workspaceYaml(canary)
          return runCanary(canary, { pnpm: options.pnpm, registry: registry.url, workspaceYaml, directory: join(root, canary.id), home })
        }),
      )
    } finally {
      await registry.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

interface CanaryContext {
  pnpm: PnpmCommand
  registry: string
  workspaceYaml: string
  directory: string
  home: string
}

async function runCanary(canary: Canary, context: CanaryContext): Promise<CanaryResult> {
  const project = join(context.directory, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'supply-canary', version: '0.0.0', private: true, dependencies: canary.dependencies }, null, 2)}\n`,
  )
  const install = (args: string[]) =>
    runPnpm(
      context.pnpm,
      [
        'install',
        ...args,
        '--registry',
        `${context.registry}/`,
        '--reporter',
        'append-only',
        '--store-dir',
        join(context.directory, 'store'),
        '--cache-dir',
        join(context.directory, 'cache'),
      ],
      project,
      context.home,
    )
  let outcome: { code: number | null; output: string }
  if (canary.frozen) {
    await writeFile(join(project, 'pnpm-workspace.yaml'), withSettings(context.workspaceYaml, { minimumReleaseAge: 0 }))
    const locked = await install(['--lockfile-only', '--no-frozen-lockfile'])
    // A failed setup must never count as the policy stopping the install.
    if (locked.code !== 0) return { ...result(canary, project, locked), codes: [], output: `生成锁文件失败：\n${locked.output}` }
    await writeFile(join(project, 'pnpm-workspace.yaml'), context.workspaceYaml)
    outcome = await install(['--frozen-lockfile'])
  } else {
    await writeFile(join(project, 'pnpm-workspace.yaml'), context.workspaceYaml)
    outcome = await install(['--no-frozen-lockfile'])
  }
  return result(canary, project, outcome)
}

function result(canary: Canary, project: string, outcome: { code: number | null; output: string }): CanaryResult {
  return {
    id: canary.id,
    title: canary.title,
    installed: outcome.code === 0,
    codes: [...new Set(outcome.output.match(/ERR_PNPM_[A-Z_]+/g) ?? [])],
    scriptRan: existsSync(join(project, SCRIPT_MARKER)),
    output: outcome.output,
  }
}

/** Runs pnpm with only PATH and a throwaway HOME, so user, system and CI configuration cannot change the outcome. */
function runPnpm(pnpm: PnpmCommand, args: string[], cwd: string, home: string): Promise<{ code: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', pnpm_config_update_notifier: 'false' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm.file, [...pnpm.args, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

async function createGitPackage(directory: string, home: string): Promise<string> {
  await mkdir(directory)
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'canary-git-child', version: '1.0.0' })}\n`)
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_AUTHOR_NAME: 'canary',
    GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'canary',
    GIT_COMMITTER_EMAIL: 'canary@example.invalid',
  }
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: directory, env })
  await git('init', '-q', '-b', 'main')
  await git('add', 'package.json')
  await git('commit', '-q', '-m', 'canary')
  return `git+file://${directory}`
}

interface PublishedVersion {
  version: string
  ageDays: number
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
  files?: Record<string, string>
  /** Published by a trusted publisher with a provenance attestation. */
  trusted?: boolean
}

interface RegistryPackage {
  name: string
  versions: PublishedVersion[]
  /** Leave out the `time` field, as some mirrors do. */
  omitTime?: boolean
}

function canaryPackages(gitUrl: string): RegistryPackage[] {
  const postinstall = `require('node:fs').writeFileSync(require('node:path').join(process.env.INIT_CWD || process.cwd(), ${JSON.stringify(SCRIPT_MARKER)}), '')\n`
  return [
    { name: 'canary-mature', versions: [{ version: '1.0.0', ageDays: 30 }] },
    {
      name: 'canary-build-script',
      versions: [
        { version: '1.0.0', ageDays: 30, scripts: { postinstall: 'node postinstall.js' }, files: { 'postinstall.js': postinstall } },
      ],
    },
    // Three days: past pnpm's built-in one-day default, so only the seven-day setting stops it.
    { name: 'canary-immature', versions: [{ version: '1.0.0', ageDays: 3 }] },
    { name: 'canary-git-parent', versions: [{ version: '1.0.0', ageDays: 30, dependencies: { 'canary-git-child': gitUrl } }] },
    { name: 'canary-no-time', versions: [{ version: '1.0.0', ageDays: 30 }], omitTime: true },
    {
      name: 'canary-trust',
      versions: [
        { version: '1.0.0', ageDays: 60, trusted: true },
        { version: '1.0.1', ageDays: 30 },
      ],
    },
  ]
}

interface CanaryRegistry {
  url: string
  close(): Promise<void>
}

/** A minimal npm registry: full packuments (with `time` unless omitted) and gzipped tarballs. */
async function startCanaryRegistry(packages: RegistryPackage[], now = Date.now()): Promise<CanaryRegistry> {
  const routes = new Map<string, { type: string; body: Buffer }>()
  const server = createServer((request, response) => {
    const route = routes.get(decodeURIComponent((request.url ?? '').split('?')[0]!))
    response.writeHead(route ? 200 : 404, { 'content-type': route?.type ?? 'application/json' })
    response.end(route?.body ?? '{"error":"Not found"}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const pkg of packages) {
    const versions: Record<string, unknown> = {}
    const time: Record<string, string> = {}
    for (const published of pkg.versions) {
      const manifest = {
        name: pkg.name,
        version: published.version,
        dependencies: published.dependencies ?? {},
        scripts: published.scripts ?? {},
      }
      const tarball = gzipSync(tar({ 'package/package.json': JSON.stringify(manifest), ...prefixed(published.files ?? {}) }))
      const path = `/${pkg.name}/-/${pkg.name}-${published.version}.tgz`
      routes.set(path, { type: 'application/octet-stream', body: tarball })
      versions[published.version] = {
        ...manifest,
        dist: {
          tarball: `${url}${path}`,
          shasum: createHash('sha1').update(tarball).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
          ...(published.trusted
            ? {
                attestations: {
                  url: `${url}/-/attestations/${pkg.name}@${published.version}`,
                  provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
                },
              }
            : {}),
        },
        ...(published.trusted
          ? { _npmUser: { name: 'canary', email: 'canary@example.invalid', trustedPublisher: { id: 'github', oidcConfigId: 'canary' } } }
          : {}),
      }
      time[published.version] = new Date(now - published.ageDays * DAY).toISOString()
    }
    const dates = Object.values(time).sort()
    const packument = {
      name: pkg.name,
      'dist-tags': { latest: pkg.versions.at(-1)!.version },
      versions,
      ...(pkg.omitTime ? {} : { time: { created: dates[0], modified: dates.at(-1), ...time } }),
    }
    routes.set(`/${pkg.name}`, { type: 'application/json', body: Buffer.from(JSON.stringify(packument)) })
  }
  return { url, close: () => new Promise(resolve => server.close(() => resolve())) }
}

function prefixed(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [`package/${name}`, content]))
}

/** A ustar archive of regular files, enough for package tarballs. */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    // npm's fixed tarball mtime (1985-10-26), so archives do not depend on the clock.
    header.write(`${(499_162_500).toString(8).padStart(11, '0')}\0`, 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
