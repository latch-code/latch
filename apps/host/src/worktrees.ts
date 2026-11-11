import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AppError } from '@latch/sdk'
import { escapeSecurityText, type WorktreeBase } from '@latch/protocol'
import { redactSecrets, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { z } from 'zod'
import { readGitLayout, type GitLayout } from './branch-reader.ts'
import { GitError, GitReader, findGit } from './changes/git.ts'
import { codeOf } from './http-util.ts'
import { canonicalPath, isInsidePath } from './paths.ts'
import { sessionFolderName } from './session-folders.ts'

/**
 * Git worktrees the Host makes for sessions: `<root>/<repository>-<8 hex>/<yyyymmdd>-<4 hex>` on a new branch
 * `latch/<yyyymmdd>-<4 hex>` from the source folder's HEAD. Making one runs nothing the repository names: every Git
 * process gets a rebuilt environment with hooks, fsmonitor, attribute files and transports off and LFS smudging
 * skipped; the worktree is added without a checkout, every filter driver its configuration then names is emptied, and
 * only then does `reset --hard` write the files. Configuration Latch cannot reason about is refused instead. A marker
 * in the worktree's own Git metadata says which start request, then which session, it belongs to; only a marked
 * worktree under the root is ever treated as Latch's. A worktree shares ports, processes and local permissions with
 * the rest of the machine: it separates files only.
 */

export const WORKTREE_NAME = /^\d{8}-[0-9a-f]{4}$/u
export const WORKTREE_BRANCH = /^latch\/\d{8}-[0-9a-f]{4}$/u
const BUCKET_NAME = /^[A-Za-z0-9._-]{1,64}-[0-9a-f]{8}$/u
const MARKER_FILE = 'latch-session.json'
const INCLUDE_FILE = '.worktreeinclude'
const INCLUDE_FILE_LIMIT = 64 * 1024
const INCLUDE_LIMIT = 10_000
const ATTEMPTS = 16
const REQUEST_LIMIT = 512
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
/** Long enough for a large checkout; a stopped one is rolled back. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000

/** Added to every Git process here, after the runner's own (`changes/git.ts`). */
const WRITE_CONFIG = [
  '-c',
  'core.attributesFile=',
  '-c',
  'attr.tree=',
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'submodule.recurse=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
]
const WRITE_ENV = { GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_REPLACE_OBJECTS: '1' }

const markerSchema = z.strictObject({
  version: z.literal(1),
  request: z.string().regex(/^[a-f0-9]{64}$/u),
  sessionId: z.string().min(1).max(256).optional(),
})

export interface Worktree {
  /** The new work tree's root: a session's `cwd`. */
  path: string
  branch: string
  /** The commit it starts from: the source folder's HEAD when it was made; empty when found again after a restart. */
  base: string
  /** Files `.worktreeinclude` brought over from the source folder. */
  copied: number
  /** Tracked files left as Git stores them because their filter (Git LFS, for one) was not run; absent when uncounted. */
  unfiltered?: number
}

export interface WorktreeOptions {
  /** Where worktrees go; tests and temporary Hosts pass a directory of their own. */
  root: string
  /** The Host data directory: a worktree is never made inside it. */
  dataDir: string
  /** Latch's own directories (its code, runtime and agent installs): a worktree is never made in or around them. */
  avoid?: readonly string[]
  /** The Git binary; found the way the 改动 reader finds it by default. */
  git?: string
  /** Whose global Git configuration applies; the Host user's home by default. */
  home?: string
  clock?: () => number
  /** Tests: the four hex characters; default random. */
  suffix?: () => string
  log: (text: string) => void
}

const refuse = (code: string, message: string) => new AppError(409, code, message)
/** A hook in the configuration whose name the restricted Git cannot switch off (`changes/git.ts`). */
const hookRefusal = (error: unknown) =>
  error instanceof GitError && error.reason === 'unsafe-config'
    ? refuse(
        'worktree-hook-name',
        'Git 配置里有一个钩子（hook.*）的名字含「=」或换行，Latch 无法确保它不运行，没有新建工作树。请在 Git 配置里给它改名或删除它。',
      )
    : undefined
const failed = (step: string) => new AppError(500, 'worktree-failed', `新建工作树失败（${step}），已撤销，项目文件夹没有改变。`)

/** Each component of an absolute path: a symlink or a non-directory anywhere along it is refused. */
async function realDirectories(path: string): Promise<void> {
  let current: string = sep
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return
      throw failed('检查位置')
    }
    if (info.isSymbolicLink())
      throw refuse('worktree-symlink', `工作树的位置 ${current} 是符号链接，没有新建工作树。请把它换成普通文件夹，或换一个工作树位置。`)
    if (!info.isDirectory()) throw refuse('worktree-location', `工作树的位置 ${current} 不是文件夹，没有新建工作树。请换一个工作树位置。`)
  }
}

/** What a configuration listing says the Host must refuse, or the filter drivers it must empty. */
function readConfig(listing: Buffer): string[] {
  const drivers = new Set<string>()
  const fields = listing.toString('utf8').split('\0')
  // `--show-scope --name-only --null`: scope and name alternate.
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const scope = fields[at]!,
      name = fields[at + 1]!
    const repository = scope === 'local' || scope === 'worktree'
    if (repository && name.startsWith('includeif.'))
      throw refuse(
        'worktree-include-if',
        '仓库配置（.git/config）里有 includeIf，Latch 无法确定建工作树时 Git 会读到哪些设置，没有新建工作树。请把 includeIf 移到全局配置（~/.gitconfig）或删除后再试。',
      )
    if (/^lfs\.customtransfer\..+\.path$/u.test(name) || /^lfs\.extension\..+\.(?:clean|smudge)$/u.test(name))
      throw refuse(
        'worktree-lfs-program',
        'Git 配置里有指向程序的 LFS 设置（lfs.customtransfer.*.path 或 lfs.extension.*），没有新建工作树。请删除这项设置后再试。',
      )
    const filter = /^filter\.([\s\S]*)\.(?:clean|smudge|process|required)$/u.exec(name)
    if (!filter) continue
    const driver = filter[1]!
    if (!driver || /[=\r\n]/u.test(driver))
      throw refuse(
        'worktree-filter-name',
        'Git 配置里有一个 filter 驱动的名字含「=」或换行，Latch 无法确保它不运行，没有新建工作树。请在 Git 配置里给它改名或删除它。',
      )
    drivers.add(driver)
  }
  return [...drivers]
}

/** Every filter driver emptied and made optional for one Git process, through the command-line configuration. */
function filterOverrides(drivers: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  let index = 0
  for (const driver of drivers)
    for (const [key, value] of [
      ['process', ''],
      ['clean', ''],
      ['smudge', ''],
      ['required', 'false'],
    ] as const) {
      env[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${key}`
      env[`GIT_CONFIG_VALUE_${index}`] = value
      index++
    }
  env.GIT_CONFIG_COUNT = String(index)
  return env
}

/** The repository's shared metadata: `<root>/.git`, or the common directory of a conventional linked worktree. */
function commonDirOf(layout: GitLayout): string | undefined {
  if (layout.gitdir === join(layout.root, '.git')) return layout.gitdir
  const worktrees = dirname(layout.gitdir)
  if (basename(worktrees) === 'worktrees' && basename(dirname(worktrees)) === '.git') return dirname(worktrees)
  return undefined
}

function bucketName(root: string): string {
  const name = basename(root)
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 48)
  return `${name || 'repo'}-${sha256Hex(root).slice(0, 8)}`
}

export class Worktrees {
  private readonly git: GitReader | undefined
  /** By request ID: a retried start gets the same worktree. */
  private readonly requests = new Map<string, Promise<Worktree>>()
  /** Made by this process for a start whose session does not own it yet. */
  private readonly unbound = new Set<string>()

  constructor(private readonly options: WorktreeOptions) {
    const binary = findGit(options.git ? [options.git] : undefined)
    this.git = binary ? new GitReader({ binary, timeoutMs: 30_000, ...(options.home ? { home: options.home } : {}) }) : undefined
  }

  /** A new worktree and branch from `source`'s HEAD for one start request; the same request gets the same one. */
  create(input: { source: string; requestId: string }): Promise<Worktree> {
    const known = this.requests.get(input.requestId)
    if (known) return known
    const made = this.make(input.source, input.requestId).then(worktree => {
      this.unbound.add(worktree.path)
      return worktree
    })
    this.requests.set(input.requestId, made)
    while (this.requests.size > REQUEST_LIMIT) this.requests.delete(this.requests.keys().next().value!)
    made.catch(() => {
      if (this.requests.get(input.requestId) === made) this.requests.delete(input.requestId)
    })
    return made
  }

  /** The session created in a worktree made for `requestId` now owns it. */
  async bind(path: string, requestId: string, sessionId: string): Promise<void> {
    const found = await this.marked(path)
    if (!found || (found.marker.request !== sha256Hex(requestId) && found.marker.sessionId !== sessionId))
      throw refuse('worktree-unmarked', '这个工作树不是 Latch 为这次开始新建的，没有记录到会话。')
    if (found.marker.sessionId !== sessionId) {
      if (found.marker.sessionId) throw refuse('worktree-owned', '这个工作树已属于另一个会话。')
      await writeFileAtomic(join(found.layout.gitdir, MARKER_FILE), `${JSON.stringify({ ...found.marker, sessionId })}\n`)
    }
    this.unbound.delete(path)
  }

  /** Worktrees this process made for starts still under way: a session may be created in them before it owns one. */
  starting(): string[] {
    return [...this.unbound]
  }

  /** The session a worktree belongs to: only one under the root, at Latch's layout, whose Git metadata carries the marker. */
  async sessionOf(path: string): Promise<string | undefined> {
    return (await this.marked(path))?.marker.sessionId
  }

  private async marked(path: string): Promise<{ layout: GitLayout; marker: z.infer<typeof markerSchema> } | undefined> {
    if (!isAbsolute(path) || resolve(path) !== path) return
    const tail = relative(this.options.root, path).split(sep)
    if (tail.length !== 2 || !BUCKET_NAME.test(tail[0]!) || !WORKTREE_NAME.test(tail[1]!)) return
    try {
      await realDirectories(path)
      if ((await realpath(path)) !== path) return
    } catch {
      return
    }
    const layout = await readGitLayout(path)
    // HEAD may name any branch or none: the agent can switch branches or be in the middle of a rebase.
    if (!layout || layout.root !== path || !commonDirOf(layout) || layout.gitdir === join(path, '.git')) return
    const file = join(layout.gitdir, MARKER_FILE)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > 1024 || (process.getuid && info.uid !== process.getuid())) return
      const marker = markerSchema.parse(
        JSON.parse(await readFile(file, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW })),
      )
      return { layout, marker }
    } catch {
      return
    }
  }

  /**
   * What a worktree from `source` would start from, after the same checks a start makes before it writes anything; the
   * refusal a start would give otherwise. Runs Git only to read HEAD's commit and the configuration's key names.
   */
  async base(sourcePath: string): Promise<WorktreeBase> {
    const { source, base } = await this.prepare(sourcePath)
    const branch = 'branch' in source.head ? source.head.branch : undefined
    // Shown as the branch reader shows it: never a secret's shape, hidden characters made visible.
    const shown = branch && branch.length <= 256 && redactSecrets(branch) === branch ? escapeSecurityText(branch) : undefined
    return { ...(shown ? { branch: shown } : {}), commit: base }
  }

  private config(git: GitReader, layout: GitLayout): Promise<Buffer> {
    return git
      .run(layout, [...WRITE_CONFIG, 'config', '--null', '--name-only', '--show-scope', '--list'], {
        maxBytes: 4 * 1024 * 1024,
        env: WRITE_ENV,
      })
      .catch((error: unknown) => {
        throw hookRefusal(error) ?? failed('读取 Git 配置')
      })
  }

  /** The source repository, its HEAD and filter drivers, and where the worktree may go; refusals before any write. */
  private async prepare(sourcePath: string) {
    const git = this.git
    if (!git) throw new AppError(409, 'worktree-no-git', '这台电脑上找不到 Git，没有新建工作树。安装 Git（或 Xcode 命令行工具）后再试。')
    const source = await readGitLayout(sourcePath)
    const common = source && commonDirOf(source)
    if (!source || !common)
      throw refuse('worktree-not-repository', '这个文件夹不是 Git 仓库的顶层文件夹，没有新建工作树。请选仓库的顶层文件夹再试。')
    const base = await git.commit(source, 'HEAD').catch((error: unknown) => {
      throw hookRefusal(error) ?? error
    })
    if (!base || !OID.test(base)) throw refuse('worktree-no-commit', '这个仓库还没有提交，没有新建工作树。先提交一次再试。')
    const drivers = readConfig(await this.config(git, source))

    const root = this.options.root
    if (!isAbsolute(root) || resolve(root) !== root) throw refuse('worktree-location', '工作树的位置不是一个完整的路径，没有新建工作树。')
    const repositories = [await canonicalPath(source.root), await canonicalPath(dirname(common))]
    const dataDir = await canonicalPath(this.options.dataDir).catch(() => resolve(this.options.dataDir))
    const avoid = await Promise.all((this.options.avoid ?? []).map(path => canonicalPath(path).catch(() => resolve(path))))
    // Checked on the path as given before anything is made, then on the real folder once it exists.
    const placed = (at: string) => {
      if (repositories.some(repository => isInsidePath(at, repository)))
        throw refuse('worktree-location', '工作树的位置在这个仓库里面，没有新建工作树。请换一个仓库之外的工作树位置。')
      if (isInsidePath(at, dataDir) || isInsidePath(dataDir, at))
        throw refuse('worktree-location', '工作树的位置与 Host 数据目录重叠，没有新建工作树。请换一个工作树位置。')
      if (avoid.some(path => isInsidePath(at, path) || isInsidePath(path, at)))
        throw refuse('worktree-location', '工作树的位置与 Latch 自己的目录重叠，没有新建工作树。请换一个工作树位置。')
    }
    await realDirectories(root)
    placed(root)
    return { git, source, common, base, drivers, root, placed }
  }

  /** The worktree an earlier Host process made for this request, found by its marker. */
  private async earlier(bucket: string, requestId: string): Promise<Worktree | undefined> {
    let names: string[]
    try {
      names = await readdir(bucket)
    } catch {
      return undefined
    }
    const request = sha256Hex(requestId)
    for (const name of names) {
      if (!WORKTREE_NAME.test(name)) continue
      const found = await this.marked(join(bucket, name))
      if (found?.marker.request === request) return { path: join(bucket, name), branch: `latch/${name}`, base: '', copied: 0 }
    }
    return undefined
  }

  /**
   * After a start that definitively failed: the worktree made for it goes again while nothing was done in it, as Git
   * itself judges (no change to a tracked file, no untracked file). Its branch goes only while it names the commit it was
   * made at. A worktree a session owns, or one this request did not make, is never touched.
   */
  async discard(made: Worktree, requestId: string): Promise<boolean> {
    const found = await this.marked(made.path)
    if (!found || found.marker.sessionId || found.marker.request !== sha256Hex(requestId) || !this.git) return false
    const common = commonDirOf(found.layout)
    const source = common && (await readGitLayout(dirname(common)))
    if (!source || commonDirOf(source) !== common) return false
    const git = this.git
    try {
      const drivers = readConfig(await this.config(git, found.layout))
      await git.run(source, [...WRITE_CONFIG, 'worktree', 'remove', made.path], {
        maxBytes: 64 * 1024,
        env: { ...WRITE_ENV, ...filterOverrides(drivers) },
      })
    } catch {
      this.options.log(`会话没有开始，它的工作树里已有改动或无法检查，保留：${made.path}`)
      return false
    }
    this.requests.delete(requestId)
    this.unbound.delete(made.path)
    if (made.base && OID.test(made.base))
      await git
        .run(source, [...WRITE_CONFIG, 'update-ref', '-d', `refs/heads/${made.branch}`, made.base], { maxBytes: 64 * 1024, env: WRITE_ENV })
        .catch(() => this.options.log(`会话没有开始，工作树已移除，分支 ${made.branch} 保留。`))
    await rmdir(dirname(made.path)).catch(() => {})
    return true
  }

  private async make(sourcePath: string, requestId: string): Promise<Worktree> {
    const { git, source, common, base, drivers: sourceDrivers, root, placed } = await this.prepare(sourcePath)
    const config = (layout: GitLayout) => this.config(git, layout)
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
    } catch {
      throw failed('新建工作树文件夹')
    }
    await realDirectories(root)
    placed(await canonicalPath(root))
    if (process.platform === 'darwin') {
      // Spotlight skips everything below a folder holding this file.
      try {
        await writeFile(join(root, '.metadata_never_index'), '', { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW })
      } catch {
        throw failed('新建工作树文件夹')
      }
    }

    const bucket = join(root, bucketName(source.root))
    try {
      await mkdir(bucket, { mode: 0o700 })
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw failed('新建工作树文件夹')
    }
    await realDirectories(bucket)
    // A start retried after the Host restarted gets the worktree it already has.
    const known = await this.earlier(bucket, requestId)
    if (known) return known

    let path: string | undefined, branch: string | undefined
    for (let attempt = 0; attempt < ATTEMPTS && !path; attempt++) {
      const name = sessionFolderName(
        new Date((this.options.clock ?? Date.now)()),
        this.options.suffix?.() ?? randomBytes(2).toString('hex'),
      )
      if (!WORKTREE_NAME.test(name)) throw failed('命名')
      if (await git.commit(source, `refs/heads/latch/${name}`)) continue
      try {
        // Without `recursive`: an entry of that name, whatever it is, is never reused.
        await mkdir(join(bucket, name), { mode: 0o755 })
      } catch (error) {
        if (codeOf(error) === 'EEXIST') continue
        throw failed('新建工作树文件夹')
      }
      path = join(bucket, name)
      branch = `latch/${name}`
    }
    if (!path || !branch) {
      await rmdir(bucket).catch(() => {})
      throw failed('工作树名称连续重复')
    }

    let added = false
    const rollback = async () => {
      const problems: string[] = []
      // A `worktree add` that failed or was stopped can still have registered the worktree or made the branch.
      const registered = added || (await readGitLayout(path)) !== undefined
      let removed = false
      if (registered)
        removed = await git
          .run(source, [...WRITE_CONFIG, 'worktree', 'remove', '--force', '--force', path], {
            maxBytes: 64 * 1024,
            env: { ...WRITE_ENV, ...filterOverrides(sourceDrivers) },
          })
          .then(
            () => true,
            () => (problems.push('worktree remove'), false),
          )
      if (!removed) await rm(path, { recursive: true, force: true }).catch(() => problems.push('folder'))
      const tip = await git.commit(source, `refs/heads/${branch}`).catch(() => base)
      // Only while it still names the commit it was made at: nothing else has used it.
      if (tip)
        await git
          .run(source, [...WRITE_CONFIG, 'update-ref', '-d', `refs/heads/${branch}`, base], { maxBytes: 64 * 1024, env: WRITE_ENV })
          .catch(() => problems.push('branch'))
      await rmdir(bucket).catch(() => {})
      if (problems.length) {
        this.options.log(`新建工作树失败后没能完全撤销（${problems.join('、')}）：${path}，分支 ${branch}。`)
        return new AppError(500, 'worktree-rollback-failed', `新建工作树失败，也没能完全撤销：请检查 ${path} 与分支 ${branch}。`)
      }
      return undefined
    }

    try {
      try {
        await git.run(source, [...WRITE_CONFIG, 'worktree', 'add', '--no-checkout', '-b', branch, path, base], {
          maxBytes: 64 * 1024,
          env: { ...WRITE_ENV, ...filterOverrides(sourceDrivers) },
        })
      } catch {
        throw failed('git worktree add')
      }
      added = true
      const layout = await readGitLayout(path)
      if (
        !layout
        || layout.root !== path
        || dirname(dirname(layout.gitdir)) !== common
        || !('branch' in layout.head)
        || layout.head.branch !== branch
      )
        throw failed('检查新工作树')
      try {
        await writeFile(join(layout.gitdir, MARKER_FILE), `${JSON.stringify({ version: 1, request: sha256Hex(requestId) })}\n`, {
          flag: 'wx',
          mode: 0o600,
        })
      } catch {
        throw failed('写入标记')
      }
      // Read again where the files will be written: configuration can depend on the worktree and its branch.
      const drivers = readConfig(await config(layout))
      try {
        await git.run(layout, [...WRITE_CONFIG, 'reset', '--quiet', '--hard', '--no-recurse-submodules', base], {
          maxBytes: 1024 * 1024,
          env: { ...WRITE_ENV, ...filterOverrides(drivers) },
          timeoutMs: CHECKOUT_TIMEOUT_MS,
        })
      } catch {
        throw failed('检出文件')
      }
      await realDirectories(path)
      const copied = await this.include(git, source, path)
      const unfiltered = drivers.length ? await this.unfiltered(git, layout, drivers) : 0
      return { path, branch, base, copied, ...(unfiltered === undefined ? {} : { unfiltered }) }
    } catch (error) {
      const incomplete = await rollback()
      throw incomplete ?? error
    }
  }

  /**
   * `.worktreeinclude` at the source's top level, in gitignore syntax: the source's files it matches that Git also
   * ignores (`.env` and the like) are copied to the same paths. An existing file is kept; links are never followed.
   */
  private async include(git: GitReader, source: GitLayout, path: string): Promise<number> {
    const file = join(source.root, INCLUDE_FILE)
    try {
      const info = await lstat(file)
      if (!info.isFile()) throw refuse('worktree-include', '.worktreeinclude 不是普通文件，没有新建工作树。请把它换成普通文件或删除它。')
      if (info.size > INCLUDE_FILE_LIMIT) throw refuse('worktree-include', '.worktreeinclude 超过 64 KB，没有新建工作树。')
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return 0
      throw error
    }
    let listed: string[]
    try {
      const matched = await git.run(source, [...WRITE_CONFIG, 'ls-files', '-z', '--others', '--ignored', `--exclude-from=${file}`], {
        maxBytes: 16 * 1024 * 1024,
        env: WRITE_ENV,
        timeoutMs: CHECKOUT_TIMEOUT_MS,
      })
      const candidates = matched.toString('utf8').split('\0').filter(Boolean)
      if (candidates.length > INCLUDE_LIMIT) throw new GitError('output-limit')
      if (!candidates.length) return 0
      const ignored = await git.run(source, [...WRITE_CONFIG, 'check-ignore', '-z', '--stdin'], {
        input: `${candidates.join('\0')}\0`,
        maxBytes: 16 * 1024 * 1024,
        env: WRITE_ENV,
        exitCodes: [0, 1],
      })
      listed = ignored.toString('utf8').split('\0').filter(Boolean)
    } catch (error) {
      if (error instanceof GitError && error.reason === 'output-limit')
        throw refuse('worktree-include', `.worktreeinclude 匹配的文件超过 ${INCLUDE_LIMIT} 个，没有新建工作树。请缩小它的范围。`)
      throw failed('读取 .worktreeinclude')
    }
    let copied = 0
    for (const name of listed) {
      const parts = name.split('/')
      if (isAbsolute(name) || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) continue
      if (await this.copy(source.root, path, parts)) copied++
    }
    return copied
  }

  /** One file, without following a link on either side; false when it is not a plain file or already exists there. */
  private async copy(from: string, to: string, parts: readonly string[]): Promise<boolean> {
    for (let depth = 1; depth < parts.length; depth++) {
      const info = await lstat(join(from, ...parts.slice(0, depth))).catch(() => undefined)
      if (!info?.isDirectory()) return false
      const target = join(to, ...parts.slice(0, depth))
      const existing = await lstat(target).catch(() => undefined)
      if (existing && !existing.isDirectory()) return false
      if (!existing)
        await mkdir(target, { mode: 0o755 }).catch(error => {
          if (codeOf(error) !== 'EEXIST') throw failed(`复制 .worktreeinclude 列出的 ${parts.join('/')}`)
        })
      if ((await lstat(target)).isSymbolicLink()) return false
    }
    let input
    try {
      input = await open(join(from, ...parts), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (codeOf(error) === 'ELOOP' || codeOf(error) === 'ENOENT') return false
      throw failed(`复制 .worktreeinclude 列出的 ${parts.join('/')}`)
    }
    try {
      const info = await input.stat()
      if (!info.isFile()) return false
      let output
      try {
        output = await open(
          join(to, ...parts),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          info.mode & 0o777,
        )
      } catch (error) {
        if (codeOf(error) === 'EEXIST') return false
        throw failed(`复制 .worktreeinclude 列出的 ${parts.join('/')}`)
      }
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024)
        for (let read; (read = (await input.read(buffer, 0, buffer.length, null)).bytesRead);) await output.write(buffer, 0, read)
      } catch {
        throw failed(`复制 .worktreeinclude 列出的 ${parts.join('/')}`)
      } finally {
        await output.close()
      }
      return true
    } finally {
      await input.close()
    }
  }

  /** How many tracked files name one of the emptied filter drivers: those stay as stored (LFS pointers, for one). */
  private async unfiltered(git: GitReader, layout: GitLayout, drivers: readonly string[]): Promise<number | undefined> {
    try {
      const files = await git.run(layout, [...WRITE_CONFIG, 'ls-files', '-z', '--cached'], { maxBytes: 32 * 1024 * 1024, env: WRITE_ENV })
      if (!files.length) return 0
      const attributes = await git.run(layout, [...WRITE_CONFIG, 'check-attr', '-z', '--stdin', 'filter'], {
        input: files.toString('utf8'),
        maxBytes: 64 * 1024 * 1024,
        env: WRITE_ENV,
      })
      // `<path> NUL filter NUL <value> NUL` per file.
      const fields = attributes.toString('utf8').split('\0')
      const named = new Set(drivers)
      let count = 0
      for (let at = 2; at < fields.length; at += 3) if (named.has(fields[at]!)) count++
      return count
    } catch {
      return undefined
    }
  }
}
