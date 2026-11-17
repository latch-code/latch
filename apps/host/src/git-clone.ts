// 克隆 (docs/GIT-DELIVERY.md「克隆」): a repository cloned by your Git into a new folder that becomes a project. The
// address is checked here and is only an https or ssh one without credentials; the folder is made by the Host (so it
// knows exactly what it made) inside a folder the desktop's native picker chose; the clone runs with none of the
// repository's code (no hooks, templates, filters or submodules) and with only that one transport open. A failed or
// cancelled clone removes the folder it made, and nothing else.
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@latch/sdk'
import type { GitCloneState } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import { configHookArgs, findGit } from './changes/git.ts'
import { QUIET_CONFIG, remoteProblem, runAsYou, signal, type RepositoryHolds } from './git-delivery.ts'
import type { CLONE_CODES } from './audit-actions/git.ts'
import { loginShell, type ShellCommand } from './terminal/environment.ts'

/** An address of at most this many characters. */
const URL_LIMIT = 2048
/** A clone gets this long, its checkout included. */
const CLONE_MS = 60 * 60_000
/** After a cancel's SIGTERM, how long the process group has before SIGKILL. */
const KILL_GRACE_MS = 5_000
/** How long a finished clone's state stays readable. */
const KEEP_MS = 10 * 60_000

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u
const PORT = /^\d{1,5}$/u
const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
/** A repository path: plain characters only, no `..` segment, no option shape. */
const PATH_TEXT = /^[A-Za-z0-9._~%+@/-]+$/u
/** The new folder's name: what the address ends with, without `.git`. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u

export interface CloneAddress {
  url: string
  transport: 'https' | 'ssh'
  /** Lower-cased, for the audit's hash. */
  host: string
  /** The folder it goes into. */
  name: string
}

const invalid = () =>
  new AppError(400, 'clone-url-invalid', '地址必须是 https:// 或 ssh 形式（git@主机:路径）的仓库地址，不能是本地路径、选项或其他传输方式。')
const credentials = () =>
  new AppError(400, 'clone-url-credentials', '地址里带有凭据，没有克隆。用这台电脑上 Git 自己的登录（凭据助手或 SSH 密钥）。')

function checkedPath(path: string): string {
  if (!PATH_TEXT.test(path) || path.split('/').some(segment => segment === '..' || segment === '.')) throw invalid()
  return path
}

/**
 * The address a person typed, as one your Git may clone: `https://host[:port]/path`, `ssh://[user@]host[:port]/path`
 * or `[user@]host:path`. Never a local path, `file://`, `git://`, `http://`, `ext::` or any other helper, an option, a
 * query or a fragment; an address with credentials (a password, or any user name in an https address, where a token
 * goes) is refused as such. The errors never repeat the address.
 */
export function parseCloneUrl(text: string): CloneAddress {
  const url = text.trim()
  // eslint-disable-next-line no-control-regex
  if (!url || url.length > URL_LIMIT || /[\s\u0000-\u001f\u007f\\]/u.test(url) || url.startsWith('-')) throw invalid()
  let transport: CloneAddress['transport'], host: string, path: string
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?$/u.exec(url)
  if (scheme) {
    const name = scheme[1]!.toLowerCase()
    if (name !== 'https' && name !== 'ssh') throw invalid()
    transport = name
    let authority = scheme[2]!
    const at = authority.lastIndexOf('@')
    if (at >= 0) {
      const user = authority.slice(0, at)
      // https: any user name is where a token goes. ssh: a user name is normal, a password is not.
      if (transport === 'https' || user.includes(':') || !USER.test(user)) throw credentials()
      authority = authority.slice(at + 1)
    }
    const colon = authority.lastIndexOf(':')
    host = colon >= 0 ? authority.slice(0, colon) : authority
    if (colon >= 0 && (!PORT.test(authority.slice(colon + 1)) || Number(authority.slice(colon + 1)) > 65535)) throw invalid()
    if (!HOST.test(host) || !scheme[3] || scheme[3] === '/') throw invalid()
    path = checkedPath(scheme[3].slice(1))
  } else {
    if (url.includes('://') || url.includes('::') || /[?#]/u.test(url)) throw invalid()
    // `user:password@host:path`: a password where the user name goes.
    const at = url.indexOf('@')
    if (at > 0 && /^[^/]*:/u.test(url.slice(0, at))) throw credentials()
    // The scp-like form of ssh, as Git reads it: a colon before the first slash.
    const scp = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/u.exec(url)
    if (!scp) throw invalid()
    if (scp[1] !== undefined && !USER.test(scp[1])) throw scp[1].includes(':') ? credentials() : invalid()
    host = scp[2]!
    if (!HOST.test(host) || scp[3]!.startsWith('-')) throw invalid()
    transport = 'ssh'
    path = checkedPath(scp[3]!)
  }
  const last =
    path
      .replace(/\/+$/u, '')
      .split('/')
      .findLast(Boolean)
      ?.replace(/\.git$/u, '') ?? ''
  if (!NAME.test(last) || last === '.git') throw new AppError(400, 'clone-name-invalid', '从这个地址得不到一个可用的文件夹名。')
  return { url, transport, host: host.toLowerCase(), name: last }
}

export interface CloneHooks {
  /** The folder rules for the new, empty folder (R1–R10 and the project rules); throws when it may not be a project. */
  check: (folder: string) => Promise<void>
  /** Written before Git runs; when it throws, nothing runs and the folder is removed. */
  audit: (detail: { cloneHash: string; transport: 'https' | 'ssh'; urlHash: string; hostHash: string; pathHash: string }) => Promise<void>
  /** Written after; a failure is only logged. */
  result: (detail: {
    cloneHash: string
    outcome: 'done' | 'failed' | 'cancelled'
    code?: (typeof CLONE_CODES)[number]
    workspaceId?: string
    removed?: boolean
  }) => Promise<void>
  /** The cloned folder becomes a project: its ID, or a refusal (the folder stays, the clone is `done` and `notAdded`). */
  register: (folder: string) => Promise<string>
}

interface Job {
  state: GitCloneState
  deviceId: string
  folder: string
  /** The made folder's identity: only that folder is ever removed. */
  identity: { dev: number; ino: number }
  running: { pid?: number }
  cancelled: boolean
  ended: Promise<void>
}

export interface GitClonesOptions {
  holds: RepositoryHolds
  git?: string
  hostEnv?: NodeJS.ProcessEnv
  shell?: () => Promise<ShellCommand>
  now?: () => number
  timeoutMs?: number
  log: (text: string) => void
}

/** The clones under way and recently ended; one at a time on this computer. */
export class GitClones {
  private readonly jobs = new Map<string, Job>()
  private readonly binary: string | undefined
  private readonly now: () => number
  private closing = false

  constructor(private readonly options: GitClonesOptions) {
    this.binary = findGit(options.git ? [options.git] : undefined)
    this.now = options.now ?? Date.now
  }

  /**
   * Makes `<parent>/<name>`, checks it as a project folder, audits, then starts your Git in it and answers at once; the
   * clone goes on in the background (`get`, `cancel`). `parent` is taken by its real path, and the new folder's real
   * path is what the project rules check.
   */
  async start(input: { deviceId: string; address: CloneAddress; parent: string; hooks: CloneHooks }): Promise<GitCloneState> {
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    if (!this.binary) throw new AppError(409, 'git-no-git', '这台电脑上找不到 Git。安装 Git（或 Xcode 命令行工具）后再试。')
    this.forgetOld()
    if ([...this.jobs.values()].some(job => job.state.state === 'running'))
      throw new AppError(409, 'clone-busy', '另一个仓库正在克隆，等它结束后再试。')
    const leave = this.options.holds.enter()
    let made: { folder: string; identity: { dev: number; ino: number } } | undefined
    try {
      const parent = await realpath(input.parent).catch(() => undefined)
      const info = parent === undefined ? undefined : await lstat(parent).catch(() => undefined)
      if (!parent || !info?.isDirectory()) throw new AppError(400, 'workspace-invalid', '选择的位置不是一个文件夹。')
      const folder = join(parent, input.address.name)
      try {
        await mkdir(folder, { mode: 0o755 })
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          throw new AppError(409, 'clone-folder-exists', `这个位置已有「${input.address.name}」，没有克隆。换一个位置。`)
        throw new AppError(409, 'workspace-permission', '不能在这个位置新建文件夹。')
      }
      const stat = await lstat(folder)
      made = { folder, identity: { dev: stat.dev, ino: stat.ino } }
      await input.hooks.check(folder)
      const id = randomUUID()
      const cloneHash = sha256Hex(id)
      await input.hooks.audit({
        cloneHash,
        transport: input.address.transport,
        urlHash: sha256Hex(input.address.url),
        hostHash: sha256Hex(input.address.host),
        pathHash: sha256Hex(folder),
      })
      const state: GitCloneState = {
        id,
        state: 'running',
        name: input.address.name,
        startedAt: new Date(this.now()).toISOString(),
        progress: { phase: 'connecting' },
      }
      const job: Job = {
        state,
        deviceId: input.deviceId,
        folder,
        identity: made.identity,
        running: {},
        cancelled: false,
        ended: Promise.resolve(),
      }
      this.jobs.set(id, job)
      const leaveOnce = leave
      job.ended = this.run(job, input.address, cloneHash, input.hooks).finally(leaveOnce)
      made = undefined
      return { ...state }
    } catch (error) {
      if (made) await this.remove(made.folder, made.identity)
      leave()
      throw error
    }
  }

  /** The clone as its own device sees it. */
  get(deviceId: string, id: string): GitCloneState {
    const job = this.jobs.get(id)
    if (!job || job.deviceId !== deviceId) throw new AppError(404, 'clone-not-found', '找不到这次克隆。')
    return { ...job.state, ...(job.state.progress ? { progress: { ...job.state.progress } } : {}) }
  }

  /** Ends the clone's Git (SIGTERM, then SIGKILL) and answers once its folder is removed. */
  async cancel(deviceId: string, id: string): Promise<GitCloneState> {
    const job = this.jobs.get(id)
    if (!job || job.deviceId !== deviceId) throw new AppError(404, 'clone-not-found', '找不到这次克隆。')
    if (job.state.state === 'running') {
      job.cancelled = true
      this.stop(job)
      await job.ended
    }
    return this.get(deviceId, id)
  }

  /** Stops every clone and removes the folders they made. */
  async close(): Promise<void> {
    this.closing = true
    const running = [...this.jobs.values()].filter(job => job.state.state === 'running')
    for (const job of running) {
      job.cancelled = true
      this.stop(job)
    }
    await Promise.all(running.map(job => job.ended))
  }

  private stop(job: Job): void {
    const pid = job.running.pid
    if (!pid) return
    signal(pid, 'SIGTERM')
    setTimeout(() => signal(pid, 'SIGKILL'), KILL_GRACE_MS).unref()
  }

  private forgetOld(): void {
    for (const [id, job] of this.jobs)
      if (job.state.state !== 'running' && this.now() - Date.parse(job.state.startedAt) > KEEP_MS) this.jobs.delete(id)
  }

  private async run(job: Job, address: CloneAddress, cloneHash: string, hooks: CloneHooks): Promise<void> {
    const shell = this.options.shell ?? loginShell
    const hostEnv = this.options.hostEnv ?? process.env
    // Git looks for no repository above the new folder: whatever folder holds it, its configuration does not apply.
    const env = { GIT_CEILING_DIRECTORIES: join(job.folder, '..') }
    const end = async (outcome: 'failed' | 'cancelled', code: (typeof CLONE_CODES)[number]) => {
      const removed = await this.remove(job.folder, job.identity)
      job.state = { ...job.state, state: outcome, code }
      delete job.state.progress
      await this.report(hooks, { cloneHash, outcome, code, removed })
    }
    try {
      // Your configuration's hooks and filter drivers, listed in the environment the clone runs in, switched off by name.
      const listing = await runAsYou({
        program: 'git',
        binary: this.binary!,
        cwd: job.folder,
        args: ['config', '--null', '--name-only', '--list'],
        hostEnv,
        shell,
        running: job.running,
        timeoutMs: 60_000,
        env,
      })
      if (job.cancelled) return await end('cancelled', 'clone-cancelled')
      if (listing.timedOut || listing.code !== 0) return await end('failed', 'clone-failed')
      const keys = listing.stdout.toString('utf8')
      let off: string[]
      try {
        off = [...configHookArgs(keys), ...filtersOff(keys)]
      } catch {
        return await end('failed', 'clone-failed')
      }
      const outcome = await runAsYou({
        program: 'git',
        binary: this.binary!,
        cwd: job.folder,
        args: [
          ...QUIET_CONFIG,
          ...off,
          'clone',
          // No template: no hooks or anything else copied in from your template directory.
          '--template=',
          '--progress',
          '--no-recurse-submodules',
          '--',
          address.url,
          '.',
        ],
        hostEnv,
        shell,
        running: job.running,
        timeoutMs: this.options.timeoutMs ?? CLONE_MS,
        allowProtocol: address.transport,
        env,
        onStderr: chunk => {
          const progress = progressOf(chunk.toString('utf8'))
          if (progress && job.state.state === 'running') job.state.progress = progress
        },
      })
      if (job.cancelled) return await end('cancelled', 'clone-cancelled')
      if (outcome.timedOut) return await end('failed', 'clone-timeout')
      if (outcome.code !== 0) {
        const stderr = outcome.stderr.toString('utf8')
        const problem = remoteProblem(stderr)
        const code =
          problem === 'host-key'
            ? 'clone-host-key'
            : /Repository not found|repository '.*' not found|does not appear to be a git repository/iu.test(stderr)
              ? 'clone-not-found-remote'
              : problem === 'auth'
                ? 'clone-auth'
                : problem === 'unreachable'
                  ? 'clone-unreachable'
                  : 'clone-failed'
        return await end('failed', code)
      }
      let workspaceId: string
      try {
        workspaceId = await hooks.register(job.folder)
      } catch (error) {
        // Cloned, and kept: the person may add it by hand. Only the reason is told.
        job.state = { ...job.state, state: 'done', notAdded: true, code: error instanceof AppError ? error.code : 'clone-not-added' }
        delete job.state.progress
        await this.report(hooks, { cloneHash, outcome: 'done', code: 'clone-not-added' })
        return
      }
      job.state = { ...job.state, state: 'done', workspaceId }
      delete job.state.progress
      await this.report(hooks, { cloneHash, outcome: 'done', workspaceId })
    } catch (error) {
      this.options.log(`克隆没有完成：${error instanceof Error ? error.message : String(error)}`)
      if (job.state.state === 'running')
        await end(job.cancelled ? 'cancelled' : 'failed', job.cancelled ? 'clone-cancelled' : 'clone-failed')
    }
  }

  private async report(hooks: CloneHooks, detail: Parameters<CloneHooks['result']>[0]): Promise<void> {
    try {
      await hooks.result(detail)
    } catch (error) {
      this.options.log(`克隆结果没有写入审计：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Removes the folder only while it is still the one made here (same device and inode, not a link). */
  private async remove(folder: string, identity: { dev: number; ino: number }): Promise<boolean> {
    try {
      const info = await lstat(folder)
      if (!info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino) {
        this.options.log('克隆的文件夹已被替换，没有删除。')
        return false
      }
      await rm(folder, { recursive: true, force: true })
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
      this.options.log(`克隆的文件夹没有删除：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
}

/** Every filter driver a configuration listing names, emptied and made optional for the clone's checkout. */
function filtersOff(listing: string): string[] {
  const drivers = new Set<string>()
  for (const key of listing.split('\0')) {
    const match = /^filter\.([\s\S]+)\.(?:clean|smudge|process|required)$/iu.exec(key)
    if (!match) continue
    if (/[=\r\n\0]/u.test(match[1]!)) throw new Error('unsafe filter name')
    drivers.add(match[1]!)
  }
  return [...drivers].flatMap(driver => [
    '-c',
    `filter.${driver}.process=`,
    '-c',
    `filter.${driver}.clean=`,
    '-c',
    `filter.${driver}.smudge=`,
    '-c',
    `filter.${driver}.required=false`,
  ])
}

/** The last progress line in a chunk of Git's standard error. */
export function progressOf(text: string): GitCloneState['progress'] | undefined {
  const lines = text.split(/[\r\n]/u).filter(Boolean)
  for (const line of lines.reverse()) {
    const match = /(Receiving objects|Resolving deltas|Updating files|Counting objects|Compressing objects):\s+(\d{1,3})%/u.exec(line)
    if (match) {
      const phase = match[1] === 'Resolving deltas' ? 'resolving' : match[1] === 'Updating files' ? 'checkout' : 'receiving'
      return { phase, percent: Math.min(100, Number(match[2])) }
    }
  }
  return undefined
}
