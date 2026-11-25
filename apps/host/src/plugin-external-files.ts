import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { isSecretPathName } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { EgressDenied, type FetchLike } from './egress.ts'
import { ProtectedPaths } from './files/resolve.ts'
import { isInsidePath } from './paths.ts'

const API = 'https://api.github.com/repos/'
const RAW = 'https://raw.githubusercontent.com/'
const SHA = z.string().regex(/^[a-f0-9]{40}$/u)
const commitDocument = z.object({ sha: SHA, commit: z.object({ tree: z.object({ sha: SHA }) }) })
const treeDocument = z.object({
  sha: SHA,
  truncated: z.literal(false),
  tree: z
    .array(z.object({ path: z.string(), type: z.string(), mode: z.string(), sha: SHA, size: z.int().nonnegative().optional() }))
    .max(20_000),
})
const githubInput = /^https:\/\/github\.com\/([a-z\d-]{1,39})\/([a-z\d_.-]{1,100})(?:\/tree\/([a-z\d_/.-]{1,180}))?\/?$/iu
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build'])
const PAGE_FILE = /\.(?:tsx?|js|css|png|webp)$/u
const PAGE_DIR = 'src'

export interface ExternalReaderOptions {
  fetch: FetchLike
  dataDir: string
  home?: string
  protectedPaths?: readonly string[]
  check?: () => void
  signal?: AbortSignal
}

export interface ExternalPluginFiles {
  read(path: string, limit: number): Promise<Buffer | undefined>
  pageFiles(): Promise<string[]>
}

const invalidSource = () =>
  new AppError(400, 'plugin-external-source-invalid', '请输入 GitHub 仓库的 HTTPS 地址，或在这台 Mac 上选择插件文件夹或插件文件。')
export const invalidContent = () => new AppError(400, 'plugin-external-content-invalid', '来源里的 Latch 目录清单、插件声明或文件无效。')
export const externalLimit = () => new AppError(413, 'plugin-external-limit', '来源里的目录或插件超过了可读取的大小或数量。')
const prohibitedPath = () => new AppError(403, 'plugin-external-path', '来源中有受保护的路径或链接。请选择正常的插件目录和文件。')
const sourceChanged = () => new AppError(409, 'plugin-external-changed', '来源文件在读取时变化了，请重新预览。')
const githubUnreachable = () => new AppError(502, 'plugin-external-github-unreachable', '暂时无法连接 GitHub，请稍后重试。')
export const githubInvalid = () => new AppError(502, 'plugin-external-github-invalid', 'GitHub 返回的提交、文件树或文件内容无法核对。')

export function safeSourcePath(path: string): boolean {
  const parts = path.split('/')
  return (
    Buffer.byteLength(path) <= 256
    && parts.length <= 16
    && parts.every(part => /^[\p{L}\p{N}_-][\p{L}\p{N}\p{M} ._+-]*$/u.test(part) && !part.endsWith('.') && !part.endsWith(' '))
    && !parts.some(part => SKIP_DIRS.has(part.toLowerCase()))
    && !isSecretPathName(path)
    && !path.toLowerCase().endsWith('.key')
    && redactKnownSecrets(path) === path
  )
}

export function parseGithubSource(input: string): { repository: string; ref: string } | undefined {
  if (!/^https?:/iu.test(input)) return undefined
  const match = githubInput.exec(input)
  if (!match || redactKnownSecrets(input) !== input) throw invalidSource()
  const [, owner, name, ref = 'HEAD'] = match
  const repo = name.replace(/\.git$/iu, '')
  if (
    !repo
    || /^\.{1,2}$/u.test(repo)
    || ref.includes('..')
    || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    throw invalidSource()
  return { repository: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`, ref }
}

export function sourceJson(bytes: Buffer, invalid: () => AppError = invalidContent): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw invalid()
  }
}

export function githubRequest(options: ExternalReaderOptions) {
  const signal = options.signal ?? AbortSignal.timeout(25_000)
  return async (url: string, limit: number, accept = 'application/vnd.github+json'): Promise<Buffer> => {
    options.check?.()
    let response: Response
    try {
      response = await options.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal,
        headers: { accept, 'user-agent': 'Latch' },
      })
    } catch (error) {
      if (error instanceof EgressDenied || (error instanceof Error && error.cause instanceof EgressDenied))
        throw new AppError(403, 'egress-denied', 'Host 的出站策略拒绝访问 GitHub。')
      throw githubUnreachable()
    }
    if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => {})
      const { status, headers } = response
      if (status >= 500 && status < 600) throw githubUnreachable()
      if (status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after'))))
        throw new AppError(429, 'plugin-external-github-rate-limit', 'GitHub 暂时限制了匿名读取。请稍后重试，或选用本机目录。')
      if (status === 404 || status === 401 || status === 403)
        throw new AppError(
          404,
          'plugin-external-github-unavailable',
          'GitHub 仓库或版本不存在，或无法公开读取。私有仓库可以从本机已检出的目录导入。',
        )
      if (status === 200) throw externalLimit()
      throw githubInvalid()
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        options.check?.()
        const part = await reader.read().catch(() => {
          throw signal.aborted ? githubUnreachable() : githubInvalid()
        })
        if (part.done) break
        size += part.value.length
        if (size > limit) throw externalLimit()
        chunks.push(part.value)
      }
      options.check?.()
      return Buffer.concat(chunks, size)
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
}

type GithubRequest = ReturnType<typeof githubRequest>
function githubRepository(repository: string): string {
  const parsed = parseGithubSource(repository)
  if (parsed?.repository !== repository) throw invalidSource()
  return repository.slice('https://github.com/'.length)
}

export async function resolveGithubCommit(source: { repository: string; ref: string }, options: ExternalReaderOptions): Promise<string> {
  const repo = githubRepository(source.repository)
  const fixed = SHA.safeParse(source.ref)
  if (fixed.success) return fixed.data
  const get = githubRequest(options)
  // The commits collection omits sha to use the repository's current default branch.
  const url = `${API}${repo}/commits${source.ref === 'HEAD' ? '' : `/${encodeURIComponent(source.ref)}`}?per_page=1`
  const result = sourceJson(await get(url, 512 * 1024), githubInvalid)
  const document = commitDocument.safeParse(source.ref === 'HEAD' && Array.isArray(result) ? result[0] : result)
  if (!document.success) throw githubInvalid()
  return document.data.sha
}

async function githubTree(repo: string, commit: string, get: GithubRequest) {
  if (!SHA.safeParse(commit).success) throw invalidSource()
  const data = sourceJson(await get(`${API}${repo}/git/commits/${commit}`, 128 * 1024), githubInvalid)
  const pinned = z.object({ sha: SHA, tree: z.object({ sha: SHA }) }).safeParse(data)
  if (!pinned.success || pinned.data.sha !== commit) throw githubInvalid()
  const tree = pinned.data.tree.sha
  const result = treeDocument.safeParse(
    sourceJson(await get(`${API}${repo}/git/trees/${tree}?recursive=1`, 5 * 1024 * 1024), githubInvalid),
  )
  if (!result.success || result.data.sha !== tree) throw githubInvalid()
  const entries = new Map(result.data.tree.map(entry => [entry.path, entry]))
  if (entries.size !== result.data.tree.length) throw githubInvalid()
  return entries
}

export function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

export async function githubPluginFiles(
  source: { repository: string; commit: string },
  options: ExternalReaderOptions,
): Promise<ExternalPluginFiles> {
  const repo = githubRepository(source.repository)
  const get = githubRequest(options)
  const entries = await githubTree(repo, source.commit, get)
  return {
    async read(path, limit) {
      if (!safeSourcePath(path)) throw prohibitedPath()
      const pathParts = path.split('/')
      for (let count = 1; count < pathParts.length; count++) {
        const parent = entries.get(pathParts.slice(0, count).join('/'))
        if (!parent) return undefined
        if (parent.type !== 'tree' || parent.mode !== '040000') throw prohibitedPath()
      }
      const file = entries.get(path)
      if (!file) return undefined
      if (file.type !== 'blob' || (file.mode !== '100644' && file.mode !== '100755') || file.size === undefined) throw prohibitedPath()
      if (file.size > limit) throw externalLimit()
      const bytes = await get(
        `${RAW}${repo}/${source.commit}/${pathParts.map(encodeURIComponent).join('/')}`,
        file.size,
        'application/octet-stream',
      )
      const hash = gitBlobId(bytes)
      if (bytes.length !== file.size || hash !== file.sha) throw githubInvalid()
      return bytes
    },
    async pageFiles() {
      const paths: string[] = []
      for (const entry of entries.values()) {
        if (entry.path !== PAGE_DIR && !entry.path.startsWith(`${PAGE_DIR}/`)) continue
        if (entry.mode === '120000' || entry.mode === '160000') throw prohibitedPath()
        if (safeSourcePath(entry.path) && PAGE_FILE.test(entry.path) && entry.type === 'blob') paths.push(entry.path)
      }
      return paths
    },
  }
}

type LocalStat = Awaited<ReturnType<typeof regularStat>>
const regularStat = (path: string) => lstat(path, { bigint: true })
const sameFile = (a: LocalStat, b: LocalStat) => a.dev === b.dev && a.ino === b.ino
const sameRevision = (a: LocalStat, b: LocalStat) =>
  sameFile(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.nlink === b.nlink

async function localStat(path: string): Promise<LocalStat | undefined> {
  try {
    return await regularStat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw prohibitedPath()
  }
}

/** MacOS uses /tmp and /var/folders for temporary directories. Only these system aliases have a permitted spelling. */
function temporaryAlias(path: string): string {
  return process.platform === 'darwin' && /^\/(?:tmp|var\/folders)(?=\/|$)/u.test(path) ? `/private${path}` : path
}

async function localPath(input: string, options: ExternalReaderOptions): Promise<string> {
  const home = options.home ?? homedir()
  const expanded = input.startsWith('~/') || (sep === '\\' && input.startsWith('~\\')) ? `${home}${sep}${input.slice(2)}` : input
  const parts = expanded.slice(parse(expanded).root.length).split(sep === '\\' ? /[\\/]/u : '/')
  if (
    !isAbsolute(expanded)
    || expanded.startsWith('\\\\')
    || expanded.startsWith('//')
    || Buffer.byteLength(expanded) > 4096
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(expanded)
    || redactKnownSecrets(expanded) !== expanded
    || parts.some(part => part.startsWith('.') || part.includes(':'))
  )
    throw invalidSource()
  const path = temporaryAlias(resolve(expanded))
  const normalizedHome = await realpath(home).catch(() => resolve(home))
  if (
    isInsidePath(normalizedHome, path)
    || [
      '/System',
      '/Library',
      '/dev',
      '/proc',
      '/sys',
      '/etc',
      '/private/etc',
      '/private/var/db',
      '/private/var/root',
      join(home, 'Library'),
    ].some(root => isInsidePath(path, root))
    || (await new ProtectedPaths([options.dataDir, ...(options.protectedPaths ?? [])]).contains(path))
  )
    throw prohibitedPath()
  return path
}

/** Checks every existing component before opening a pathname, including the chosen root's ancestors. */
async function localEntry(path: string, packageRoot?: string): Promise<LocalStat | undefined> {
  let current = parse(path).root
  const parts = relative(current, path).split(sep)
  for (const [index, name] of parts.entries()) {
    current = join(current, name)
    const info = await localStat(current)
    if (!info) return undefined
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw prohibitedPath()
    // A checked-out submodule looks like a regular directory. Do not follow embedded repositories from a catalog.
    if (
      info.isDirectory()
      && packageRoot
      && current !== packageRoot
      && isInsidePath(current, packageRoot)
      && (await localStat(join(current, '.git')))
    )
      throw prohibitedPath()
    if (index === parts.length - 1) {
      const canonical = await realpath(current).catch(() => undefined)
      if (!canonical || canonical.normalize('NFC') !== path.normalize('NFC')) throw prohibitedPath()
      return info
    }
  }
  return undefined
}

export async function resolveLocalSource(input: string, options: ExternalReaderOptions) {
  options.check?.()
  const path = await localPath(input, options)
  const info = await localEntry(path)
  options.check?.()
  if (!info) throw new AppError(404, 'plugin-external-local-missing', '这台 Mac 上找不到所选的插件文件或文件夹。')
  if (info.isDirectory()) return { kind: 'local-folder' as const, directory: path }
  if (info.isFile() && info.nlink === 1n && !isSecretPathName(basename(path)) && /(?:^|\.)latch-plugin\.json$/iu.test(basename(path)))
    return { kind: 'local-bundle' as const, file: path }
  throw invalidSource()
}

async function readLocalFile(path: string, limit: number, check?: () => void, packageRoot?: string): Promise<Buffer | undefined> {
  check?.()
  const before = await localEntry(path, packageRoot)
  if (!before) return undefined
  if (!before.isFile() || before.nlink !== 1n) throw prohibitedPath()
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK).catch(() => {
    throw sourceChanged()
  })
  try {
    const info = await fd.stat({ bigint: true })
    const named = await localEntry(path, packageRoot)
    if (!info.isFile() || !sameRevision(before, info) || !named || !sameRevision(info, named)) throw sourceChanged()
    if (info.size > BigInt(limit)) throw externalLimit()
    const bytes = Buffer.alloc(Number(info.size) + 1)
    let length = 0
    while (length < bytes.length) {
      check?.()
      const part = await fd.read(bytes, length, bytes.length - length, length)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    check?.()
    const after = await localEntry(path, packageRoot)
    if (length !== Number(info.size) || !after || !sameRevision(info, after) || !sameRevision(info, await fd.stat({ bigint: true })))
      throw sourceChanged()
    return bytes.subarray(0, length)
  } finally {
    await fd.close()
  }
}

export async function localBundleBytes(file: string, limit: number, options: ExternalReaderOptions): Promise<Buffer> {
  const source = await resolveLocalSource(file, options)
  if (source.kind !== 'local-bundle' || source.file !== file) throw invalidSource()
  const bytes = await readLocalFile(file, limit, options.check)
  if (!bytes) throw sourceChanged()
  return bytes
}

export async function localPluginFiles(directory: string, options: ExternalReaderOptions): Promise<ExternalPluginFiles> {
  const source = await resolveLocalSource(directory, options)
  if (source.kind !== 'local-folder' || source.directory !== directory) throw invalidSource()
  const root = await localEntry(directory)
  if (!root?.isDirectory()) throw sourceChanged()
  const checkRoot = async () => {
    options.check?.()
    const current = await localEntry(directory)
    if (!current?.isDirectory() || !sameFile(root, current)) throw sourceChanged()
  }
  return {
    async read(path, limit) {
      if (!safeSourcePath(path)) throw prohibitedPath()
      await checkRoot()
      const target = await localPath(join(directory, ...path.split('/')), options)
      const bytes = await readLocalFile(target, limit, options.check, directory)
      await checkRoot()
      return bytes
    },
    async pageFiles() {
      const paths: string[] = []
      let visited = 0
      const walk = async (prefix: string) => {
        await checkRoot()
        const path = await localPath(join(directory, ...prefix.split('/')), options)
        const before = await localEntry(path, directory)
        if (!before) return
        if (!before.isDirectory()) throw prohibitedPath()
        const handle = await opendir(path).catch(() => {
          throw sourceChanged()
        })
        for await (const entry of handle) {
          options.check?.()
          if (++visited > 1024) throw externalLimit()
          const file = `${prefix}/${entry.name}`
          if (!safeSourcePath(file)) continue
          if (entry.isSymbolicLink()) throw prohibitedPath()
          if (entry.isDirectory()) await walk(file)
          else if (entry.isFile() && PAGE_FILE.test(entry.name)) paths.push(file)
        }
        const after = await localEntry(path, directory)
        if (!after || !sameRevision(before, after)) throw sourceChanged()
      }
      await walk(PAGE_DIR)
      return paths
    },
  }
}
