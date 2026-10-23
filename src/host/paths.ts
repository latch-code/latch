import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '../core/errors.ts'

export interface LatchPaths {
  dataDir: string
  dataDirSource: 'flag' | 'env' | 'legacy-runtime' | 'default'
  workspaceRoot: string
  workspaceSource: 'flag' | 'env' | 'legacy-data' | 'default'
  agentsDir: string
  /** Chinese, printed by the start script; never contain secrets. */
  warnings: string[]
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

function platformData(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, leaf: 'Host' | 'Agents'): string {
  const path = pathApi(platform)
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Latch', leaf)
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Latch', leaf)
  // XDG requires an absolute base; a relative value is ignored.
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  return path.join(xdg, 'latch', leaf.toLowerCase())
}

/** Data, workspace and agent-install directories, from flags, environment, a legacy `./.runtime`, or platform defaults. */
export function resolveLatchPaths(input: {
  dataDir?: string
  workspace?: string
  env: NodeJS.ProcessEnv
  cwd: string
  home?: string
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}): LatchPaths {
  const platform = input.platform ?? process.platform
  const path = pathApi(platform)
  const home = input.home ?? homedir()
  const exists = input.exists ?? existsSync
  const warnings: string[] = []

  let dataDir: string
  let dataDirSource: LatchPaths['dataDirSource']
  const platformDefault = platformData(platform, home, input.env, 'Host')
  if (input.dataDir) {
    dataDir = path.resolve(input.cwd, input.dataDir)
    dataDirSource = 'flag'
  } else if (input.env.HARNESS_DATA_DIR) {
    dataDir = path.resolve(input.cwd, input.env.HARNESS_DATA_DIR)
    dataDirSource = 'env'
  } else if (exists(path.join(input.cwd, '.runtime'))) {
    dataDir = path.join(input.cwd, '.runtime')
    dataDirSource = 'legacy-runtime'
    warnings.push(
      `正在使用旧的数据目录 ${dataDir}。新安装默认使用 ${platformDefault}；如需迁移，请停止 Host 后移动目录并用 --data-dir 指定。`,
    )
  } else {
    dataDir = platformDefault
    dataDirSource = 'default'
  }

  let workspaceRoot: string
  let workspaceSource: LatchPaths['workspaceSource']
  if (input.workspace) {
    workspaceRoot = path.resolve(input.cwd, input.workspace)
    workspaceSource = 'flag'
  } else if (input.env.HARNESS_WORKSPACE) {
    workspaceRoot = path.resolve(input.cwd, input.env.HARNESS_WORKSPACE)
    workspaceSource = 'env'
  } else if (exists(path.join(dataDir, 'workspace'))) {
    workspaceRoot = path.join(dataDir, 'workspace')
    workspaceSource = 'legacy-data'
    warnings.push(`工作区位于数据目录内（${workspaceRoot}）。迁出之前只能使用内置 Harness。`)
  } else {
    workspaceRoot = path.join(home, 'Latch', 'workspace')
    workspaceSource = 'default'
  }

  const agentsDir = input.env.HARNESS_AGENTS_DIR
    ? path.resolve(input.cwd, input.env.HARNESS_AGENTS_DIR)
    : platformData(platform, home, input.env, 'Agents')
  return { dataDir, dataDirSource, workspaceRoot, workspaceSource, agentsDir, warnings }
}

function insecureRuntime(path: string): AppError {
  return new AppError(500, 'runtime-dir-insecure', `运行目录 ${path} 的属主或权限不安全，已拒绝启动。请删除该目录后重试。`)
}

/** A directory we own: real directory (not a symlink), owned by `uid`, and with no group/other bits in `mask`. */
async function requireOwnedDirectory(path: string, uid: number, mask: number): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch {
    throw insecureRuntime(path)
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & mask) !== 0) throw insecureRuntime(path)
}

async function makePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw insecureRuntime(path)
  }
}

function darwinUserTemp(): string {
  return execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Per-user runtime directory holding `host.sock` and per-session temporary directories.
 * The socket is protected only by this directory's ownership and mode; any process of the same user can connect.
 */
export async function prepareRuntimeDir(input: {
  hostId8: string
  parent?: string
  platform?: NodeJS.Platform
  uid?: number
  getconf?: () => string
}): Promise<{ runtimeDir: string; socketPath: string; tmpRoot: string }> {
  const platform = input.platform ?? process.platform
  if (platform === 'win32' || typeof process.getuid !== 'function') {
    throw new AppError(500, 'runtime-dir-unsupported', '此系统暂不支持 Latch 的本机运行目录（host.sock）。')
  }
  if (!/^[a-z2-7]{8}$/u.test(input.hostId8)) throw new TypeError('prepareRuntimeDir: invalid hostId8')
  const uid = input.uid ?? process.getuid()

  let parent = input.parent
  if (!parent && platform === 'darwin') {
    try {
      parent = (input.getconf ?? darwinUserTemp)().trim() || undefined
    } catch {
      parent = undefined
    }
    parent ||= process.env.TMPDIR || undefined
  }
  if (!parent && platform === 'linux' && process.env.XDG_RUNTIME_DIR && isAbsolute(process.env.XDG_RUNTIME_DIR))
    parent = process.env.XDG_RUNTIME_DIR
  if (!parent) {
    // /tmp itself is world-writable (sticky); the per-user directory below it must not be.
    parent = `/tmp/latch-${uid}`
    await makePrivateDirectory(parent)
  }
  if (!isAbsolute(parent)) throw insecureRuntime(parent)

  let realParent: string
  try {
    realParent = await realpath(parent)
  } catch {
    throw insecureRuntime(parent)
  }
  await requireOwnedDirectory(realParent, uid, 0o022)

  const runtimeDir = join(realParent, `latch-${input.hostId8}`)
  const socketPath = join(runtimeDir, 'host.sock')
  if (Buffer.byteLength(socketPath) > 103) {
    throw new AppError(500, 'runtime-dir-too-long', `运行目录路径过长（${runtimeDir}），无法创建 host.sock。请使用更短的临时目录。`)
  }
  await makePrivateDirectory(runtimeDir)
  await requireOwnedDirectory(runtimeDir, uid, 0o077)
  const tmpRoot = join(runtimeDir, 'tmp')
  await makePrivateDirectory(tmpRoot)
  await requireOwnedDirectory(tmpRoot, uid, 0o077)
  return { runtimeDir, socketPath, tmpRoot }
}

/**
 * macOS spellings that reach a directory through another prefix: the firmlinked Data volume, and the no-follow and
 * resolve prefixes. realpath() returns them unchanged, so string comparisons would treat them as unrelated paths.
 */
const ALIAS_PREFIXES: readonly RegExp[] = [/^\/System\/Volumes\/Data(?=\/|$)/u, /^\/\.nofollow(?=\/|$)/u, /^\/\.resolve\/\d+(?=\/|$)/u]
/** Roots of those spellings and of the by-id `/.vol` namespace. A project may not be, contain or sit inside one. */
const ALIAS_ROOTS: readonly string[] = ['/System/Volumes/Data', '/.nofollow', '/.resolve', '/.vol']
const DATA_VOLUME = '/System/Volumes/Data'

function stripAliasPrefix(path: string): string | undefined {
  for (const prefix of ALIAS_PREFIXES) if (prefix.test(path)) return path.replace(prefix, '') || '/'
  return undefined
}

/** `dev:ino` as bigints: some synthetic directories report inode numbers beyond 2^53. */
async function identity(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true })
    return `${info.dev}:${info.ino}`
  } catch {
    return undefined
  }
}

function identitySync(path: string): string | undefined {
  try {
    const info = statSync(path, { bigint: true })
    return `${info.dev}:${info.ino}`
  } catch {
    return undefined
  }
}

/** Drops alias prefixes, but only while the shorter spelling is the very same directory. */
async function withoutAliases(path: string): Promise<string> {
  let current = path
  for (let next = stripAliasPrefix(current); next !== undefined; next = stripAliasPrefix(current)) {
    const [from, to] = await Promise.all([identity(current), identity(next)])
    if (from === undefined || from !== to) break
    current = next
  }
  return current
}

function withoutAliasesSync(path: string): string {
  let current = path
  for (let next = stripAliasPrefix(current); next !== undefined; next = stripAliasPrefix(current)) {
    const from = identitySync(current)
    if (from === undefined || from !== identitySync(next)) break
    current = next
  }
  return current
}

let cachedCodeRoot: string | undefined

/** Realpath of the nearest ancestor of this module whose package.json is named "harness-link", in its on-disk spelling. */
export function latchCodeRoot(): string {
  if (cachedCodeRoot) return cachedCodeRoot
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
      // The native realpath reports the on-disk case; the JS one keeps whatever case the module URL was loaded with.
      if (manifest.name === 'harness-link') return (cachedCodeRoot = withoutAliasesSync(realpathSync.native(directory)))
    } catch {
      /* keep walking */
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Latch code root not found')
    directory = parent
  }
}

/** Relative to HOME. Workspaces may not contain, equal or sit inside these. */
export const DENY_READ_HOME_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.password-store',
  'Library/Keychains',
  '.codex',
  '.gemini',
  '.qwen',
  '.config/opencode',
  '.pi',
  '.config/goose',
]

/** Relative to HOME. Files placed here start at login, so these directories are never projects either. */
const AUTOSTART_HOME_PATHS: readonly string[] = ['Library/LaunchAgents', '.config/autostart', '.config/systemd']

/**
 * Relative to HOME, besides every hidden entry directly under it (~/.oh-my-zsh, ~/.zshrc.d, ...): shells, editors and
 * other tools load configuration and scripts from these without being asked, so a write there can run code later.
 * On macOS all of ~/Library is included.
 */
const CONFIG_HOME_PATHS: readonly string[] = ['.config', '.local', 'bin']

export interface WorkspaceGuardContext {
  dataDir: string
  agentsDir: string
  runtimeDir: string
  home: string
  codeRoot: string
  existing: Array<{ id: string; name: string; path: string }>
  tlsKeyPath?: string
}
export type WorkspaceVerdict = { ok: true; realPath: string } | { ok: false; error: AppError }

/** macOS and Windows volumes are usually case-insensitive; comparing case-folded can only add overlaps. */
function pathKey(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.normalize('NFC').toLowerCase() : path
}

/** True when `child` equals `parent` or lies below it. */
export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(pathKey(parent), pathKey(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * The comparison form of an existing path: its realpath without macOS alias prefixes (`/System/Volumes/Data`,
 * `/.nofollow`, `/.resolve/<n>`), case-folded where volumes usually ignore case. Two spellings of one directory give
 * the same string. Throws when the path does not exist.
 */
export async function canonicalPath(path: string): Promise<string> {
  return pathKey(await withoutAliases(await realpath(path)))
}

/** A path for overlap checks: its comparison key, plus filesystem identities that catch aliases strings cannot. */
interface Located {
  /** Realpath (aliases removed) of the longest existing prefix, with the missing remainder appended. */
  real: string
  key: string
  /** `dev:ino` of the path itself; undefined while it does not exist. */
  self?: string
  /** Identities of the nearest existing directory and all its ancestors, under every spelling that reaches it. */
  chain: ReadonlySet<string>
}

async function addAncestors(path: string, chain: Set<string>): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    const id = await identity(current)
    if (id) chain.add(id)
    if (dirname(current) === current) return
  }
}

async function locate(path: string): Promise<Located> {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute
  let found: string | undefined
  for (;;) {
    try {
      found = await withoutAliases(await realpath(current))
      break
    } catch {
      const parent = dirname(current)
      if (parent === current) break
      missing.push(current.slice(parent.length).replace(/^[\\/]+/u, ''))
      current = parent
    }
  }
  if (found === undefined) return { real: absolute, key: pathKey(absolute), chain: new Set() }
  const chain = new Set<string>()
  await addAncestors(found, chain)
  // Through the firmlinked Data volume the same directory has other ancestors (the volume root and above).
  const dataSpelling = found === '/' ? undefined : `${DATA_VOLUME}${found}`
  const self = await identity(found)
  if (dataSpelling && self !== undefined && (await identity(dataSpelling)) === self) await addAncestors(dataSpelling, chain)
  const real = missing.length ? join(found, ...missing.reverse()) : found
  return { real, key: pathKey(real), ...(missing.length === 0 && self !== undefined ? { self } : {}), chain }
}

/** `child` equals `parent` or lies below it, by spelling or by identity. */
function within(child: Located, parent: Located): boolean {
  return isInsidePath(child.key, parent.key) || (parent.self !== undefined && child.chain.has(parent.self))
}

function overlapping(a: Located, b: Located): boolean {
  return within(a, b) || within(b, a)
}

function samePath(a: Located, b: Located): boolean {
  return a.key === b.key || (a.self !== undefined && a.self === b.self)
}

function overlap(message: string): WorkspaceVerdict {
  return { ok: false, error: new AppError(409, 'workspace-overlap', message) }
}

const SENSITIVE_MESSAGE = '该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目'
const HOME_CONFIG_MESSAGE = '主目录下的隐藏目录、配置目录和系统目录不能作为项目'
const HOME_MESSAGE = '不能把主目录整体作为项目'
const reservedMessage = (label: string) => `该目录与 Latch 的${label}重叠，不能作为项目`

/** On macOS, whether the path is, contains or lies inside one of the alias roots. */
function touchesAliasRoot(candidate: Located): boolean {
  if (process.platform !== 'darwin') return false
  return ALIAS_ROOTS.some(root => isInsidePath(candidate.key, root) || isInsidePath(root, candidate.key))
}

/** Whether the path is, contains or lies inside $HOME's hidden entries, `CONFIG_HOME_PATHS` or (macOS) ~/Library. */
async function touchesHomeConfig(candidate: Located, home: Located): Promise<boolean> {
  if (within(home, candidate)) return true
  const entries = process.platform === 'darwin' ? [...CONFIG_HOME_PATHS, 'Library'] : CONFIG_HOME_PATHS
  for (const entry of entries) {
    if (overlapping(candidate, await locate(join(home.real, entry)))) return true
  }
  // By spelling and by identity: some ancestor is a hidden entry whose parent is $HOME.
  for (let current = candidate.real; dirname(current) !== current; current = dirname(current)) {
    if (!basename(current).startsWith('.')) continue
    const parent = dirname(current)
    if (pathKey(parent) === home.key || (home.self !== undefined && (await identity(parent)) === home.self)) return true
  }
  return false
}

/**
 * Rules for registering a project directory, evaluated on realpaths in a fixed order. Overlaps are judged by
 * spelling and by filesystem identity, so aliases of a reserved or sensitive directory are refused too.
 */
export async function checkWorkspaceCandidate(path: string, context: WorkspaceGuardContext): Promise<WorkspaceVerdict> {
  const invalid: WorkspaceVerdict = { ok: false, error: new AppError(400, 'workspace-invalid', '目录不存在或无法访问') }
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\u0000')) return invalid
  try {
    if (!(await stat(await realpath(path))).isDirectory()) return invalid
  } catch {
    return invalid
  }
  const candidate = await locate(path)
  if (candidate.self === undefined) return invalid

  const reserved: Array<[string, string]> = [
    [context.dataDir, '数据目录'],
    [context.agentsDir, 'Agent 安装目录'],
    [context.runtimeDir, '运行目录'],
  ]
  for (const [directory, label] of reserved) {
    if (overlapping(candidate, await locate(directory))) return overlap(reservedMessage(label))
  }

  const home = await locate(context.home)
  if (samePath(candidate, home)) return overlap(HOME_MESSAGE)

  for (const entry of [...DENY_READ_HOME_PATHS, ...AUTOSTART_HOME_PATHS]) {
    if (overlapping(candidate, await locate(join(home.real, entry)))) return overlap(SENSITIVE_MESSAGE)
  }
  if (context.tlsKeyPath && within(await locate(context.tlsKeyPath), candidate)) return overlap(SENSITIVE_MESSAGE)
  if (touchesAliasRoot(candidate)) return overlap(SENSITIVE_MESSAGE)
  if (await touchesHomeConfig(candidate, home)) return overlap(HOME_CONFIG_MESSAGE)

  if (overlapping(candidate, await locate(context.codeRoot))) {
    return { ok: false, error: new AppError(409, 'workspace-code-root', '该目录与 Latch 程序目录重叠，不能作为项目') }
  }
  if (hasProtectedComponent(candidate.real)) return overlap('该目录位于受保护目录（如 .git）内，不能作为项目')
  for (const item of context.existing) {
    if (samePath(await locate(item.path), candidate)) {
      return { ok: false, error: new AppError(409, 'workspace-exists', `该目录已添加为项目「${item.name}」`) }
    }
  }
  return { ok: true, realPath: candidate.real }
}

export interface DefaultWorkspaceFlags {
  insideData: boolean
  codeRoot: boolean
  /** Set when the startup workspace would expose secrets or Latch's own directories; the Host then refuses to start. */
  sensitive?: { reason: 'home' | 'deny-read' | 'tls-key' | 'runtime' | 'agents' | 'home-config'; message: string }
}

/**
 * The startup workspace. Inside the data directory (legacy layout) it is limited to the built-in harness; overlapping
 * the code root elsewhere makes every Standard write high risk. Overlaps with $HOME, the sensitive home paths, the
 * TLS key, the runtime directory or the agents directory are reported as `sensitive`, with the same wording as
 * project registration; so are $HOME's hidden and configuration directories, unless the workspace is the legacy one
 * inside the data directory (whose default location on Linux is ~/.local/share).
 */
export async function classifyDefaultWorkspace(realWorkspace: string, context: WorkspaceGuardContext): Promise<DefaultWorkspaceFlags> {
  const workspace = await locate(realWorkspace)
  const insideData = within(workspace, await locate(context.dataDir))
  const codeRoot = !insideData && overlapping(workspace, await locate(context.codeRoot))
  const sensitive = await sensitiveOverlap(workspace, context, insideData)
  return { insideData, codeRoot, ...(sensitive ? { sensitive } : {}) }
}

async function sensitiveOverlap(
  workspace: Located,
  context: WorkspaceGuardContext,
  insideData: boolean,
): Promise<DefaultWorkspaceFlags['sensitive']> {
  const home = await locate(context.home)
  if (samePath(workspace, home)) return { reason: 'home', message: HOME_MESSAGE }
  for (const entry of DENY_READ_HOME_PATHS) {
    if (overlapping(workspace, await locate(join(home.real, entry)))) return { reason: 'deny-read', message: SENSITIVE_MESSAGE }
  }
  if (context.tlsKeyPath && within(await locate(context.tlsKeyPath), workspace)) return { reason: 'tls-key', message: SENSITIVE_MESSAGE }
  if (overlapping(workspace, await locate(context.runtimeDir))) return { reason: 'runtime', message: reservedMessage('运行目录') }
  if (overlapping(workspace, await locate(context.agentsDir))) return { reason: 'agents', message: reservedMessage('Agent 安装目录') }
  if (!insideData && (await touchesHomeConfig(workspace, home))) return { reason: 'home-config', message: HOME_CONFIG_MESSAGE }
  return undefined
}

/**
 * Not exhaustive. Names whose content common developer tools run, or which configure what runs, during routine
 * commands (install, build, test, git operations, opening the folder in an editor or agent), so a write to them can
 * execute code later without anyone running it on purpose. Ordinary source files also run on build or test; they are
 * left to the per-call approval.
 */
const PROTECTED_COMPONENTS = new Set([
  // Version control and hook managers.
  '.git',
  '.gitconfig',
  '.githooks',
  '.husky',
  '.gitmodules',
  '.pre-commit-config.yaml',
  'lefthook.yml',
  '.lefthook.yml',
  // Agent, editor and environment configuration loaded when a folder is opened or entered.
  '.latch',
  '.codex',
  '.agents',
  '.opencode',
  '.gemini',
  '.qwen',
  '.pi',
  '.claude',
  '.cursor',
  '.vscode',
  '.idea',
  '.devcontainer',
  '.mcp.json',
  'opencode.json',
  'opencode.jsonc',
  'agents.md',
  'agents.override.md',
  'claude.md',
  'claude.local.md',
  'gemini.md',
  'qwen.md',
  '.goosehints',
  '.envrc',
  '.direnv',
  'mise.toml',
  '.mise.toml',
  // Package managers: manifests, lockfiles, resolution hooks and registry or toolchain settings used on install.
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  '.yarn',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'cargo.toml',
  'cargo.lock',
  '.cargo',
  'build.rs',
  'rust-toolchain',
  'rust-toolchain.toml',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'pipfile',
  'pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'uv.toml',
  'pip.conf',
  'gemfile',
  'gemfile.lock',
  '.bundle',
  'composer.json',
  'composer.lock',
  // Build entry points and wrappers.
  'makefile',
  'gnumakefile',
  'cmakelists.txt',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  'gradlew',
  'pom.xml',
  '.mvn',
  'mvnw',
  // Installed dependency trees: ignored by git status, loaded by the next command.
  'node_modules',
  '.venv',
  'venv',
  '__pypackages__',
])

/** Code points some file systems ignore in names (e.g. HFS+), so `.g‌it` would still open `.git`. */
const IGNORABLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu

function foldComponent(component: string): string {
  const folded = component.normalize('NFKC').replace(IGNORABLE, '').toLowerCase()
  // Windows strips trailing dots and spaces from names.
  const trimmed = folded.replace(/[. ]+$/u, '')
  return trimmed || folded
}

function protectedComponents(folded: readonly string[]): boolean {
  for (let index = 0; index < folded.length; index++) {
    const part = folded[index]!
    if (PROTECTED_COMPONENTS.has(part)) return true
    if (part === '.github' && folded[index + 1] === 'workflows') return true
  }
  return false
}

/** Environment files, and Python path files that the interpreter executes at startup from site-packages. */
function protectedBase(base: string): boolean {
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.pth')
}

/** Components of an absolute path, without the root or drive; undefined when it is not a plain absolute path. */
function absoluteComponents(path: string): string[] | undefined {
  if (typeof path !== 'string' || path.includes('\u0000') || !(posix.isAbsolute(path) || win32.isAbsolute(path))) return undefined
  const parts = path.split(/[\\/]+/u).filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) return undefined
  if (/^[A-Za-z]:$/u.test(parts[0] ?? '')) parts.shift()
  return parts
}

/** Whether an absolute directory has a protected component (e.g. a root at `<repo>/.git` or `.github/workflows`). */
export function hasProtectedComponent(absolutePath: string): boolean {
  const parts = absoluteComponents(absolutePath)
  return parts === undefined || protectedComponents(parts.map(foldComponent))
}

/**
 * Whether a workspace-relative path touches a protected name. Absolute, escaping and empty paths count as protected.
 * With `root` (the absolute, canonical workspace root), the root's own components count too, so a workspace rooted at
 * `<repo>/.git` protects `hooks/pre-commit`.
 */
export function isProtectedWorkspacePath(relativePath: string, root?: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.trim() === '' || relativePath.includes('\u0000')) return true
  if (posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) return true
  const components = relativePath.split(/[\\/]+/u).filter(part => part !== '' && part !== '.')
  if (components.length === 0) return true
  if (components.some(part => part === '..')) return true
  const rootParts = root === undefined ? [] : absoluteComponents(root)
  if (rootParts === undefined) return true
  const folded = [...rootParts, ...components].map(foldComponent)
  return protectedComponents(folded) || protectedBase(folded[folded.length - 1]!)
}

/** Regular 0600 file owned by `uid`, not a symlink, and not inside any of `notInside` (e.g. workspaces). */
export async function checkPrivateFile(path: string, rule: { uid: number; notInside: string[]; label: string }): Promise<void> {
  const failure = () => new AppError(500, 'private-file-insecure', `${rule.label} 必须是仅本用户可读的文件（0600），且不能位于工作区内`)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== rule.uid) throw failure()
    await realpath(path)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw failure()
  }
  const file = await locate(path)
  for (const directory of rule.notInside) {
    if (within(file, await locate(directory))) throw failure()
  }
}
