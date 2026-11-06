import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import QRCode from 'qrcode'
import { escapeSecurityText, LISTENER_LABELS, SCOPE_LABELS, type Device, type DeviceScope, type InvitationView } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, redactSecrets } from '@latch/core/node-kit'
import { AuditLog, verifyAuditFile, type AuditActor } from '../src/audit.ts'
import { createOfflineTicket } from '../src/auth.ts'
import { addressOf, HostConfig, keyScopeOf, keyScopeText, originOf, type ProviderRecord, type WorkspaceRecord } from '../src/config.ts'
import { createEgressInspector } from '../src/egress.ts'
import { isPresetKeyOrigin, addressesConfirmedBefore } from '../src/providers.ts'
import {
  acquireDataDirLock,
  processAlive,
  readHostState,
  readRecordedPid,
  unixRequest,
  verifyHostState,
  type DataDirLock,
  type HostInfo,
  type HostState,
} from '../src/host-state.ts'
import { latchEnv } from '../src/env.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import {
  PROJECT_FOLDER_LIMIT,
  canonicalPath,
  checkProjectFolders,
  isPrintableText,
  latchCodeRoot,
  resolveLatchPaths,
  runtimeDirPath,
} from '../src/paths.ts'
import { parsePolicyFile, PolicyStore, type Policy } from '../src/policy.ts'
import { foldersHash, newProject, planFolders } from '../src/projects.ts'
import { readProjectContext } from '../src/project-context.ts'
import {
  buildPreview,
  CONFIRMATION_LIFETIME_MS,
  createPresenceBackend,
  presenceHelperPath,
  PRESENCE_ACTIONS,
  type PresenceBackend,
} from '../src/presence.ts'
import { isLatchTerminal } from '../src/terminal/environment.ts'
import { TRAFFIC_KINDS, type TrafficKind, type TrafficSummary } from '../src/traffic.ts'

export interface CliIO {
  stdout: { write(text: string): unknown; isTTY?: boolean }
  stderr: { write(text: string): unknown }
  /** Whether stdin is a terminal someone types into: only then can a question be answered. */
  stdin: { isTTY?: boolean }
  /** Reads one secret line: without echo on a terminal, else the whole of stdin. */
  readSecret(prompt: string): Promise<string>
  /** Asks a yes/no question on an interactive terminal; absent elsewhere. */
  confirm?(prompt: string): Promise<boolean>
  /** Reads one visible line typed on the terminal; asked only when `stdin.isTTY`. */
  readLine(prompt: string): Promise<string>
  env: NodeJS.ProcessEnv
  cwd: string
}

class CliError extends Error {}

/**
 * Why a pairing link or an offline code may not be shown here. A Latch terminal keeps its output in memory, and
 * 「加入对话」 can pass it to a model; a code rendered as a QR would pass the redaction.
 */
function codeRefusal(io: CliIO, what: '配对链接' | '离线连接码'): string | undefined {
  if (isLatchTerminal(io.env)) return `Latch 终端的输出可能被加入对话，${what}不在这里显示；请使用 --code-file <路径>`
  // A pane keeps the environment of the terminal that started the multiplexer, so it may be attached from a Latch terminal unmarked.
  if (io.env.TMUX !== undefined || io.env.STY !== undefined || io.env.ZELLIJ !== undefined)
    return `终端复用器的窗格可能显示在 Latch 终端里，${what}不在这里显示；请使用 --code-file <路径>`
  if (!io.stdout.isTTY) return `${what}只输出到终端；非交互环境请使用 --code-file <路径>`
  return undefined
}

const run = promisify(execFile)
const CLI_ACTOR: AuditActor = { listener: 'cli', via: 'cli' }
const STATUS_LABELS: Record<Device['status'], string> = {
  active: '正常',
  review: '待复核（仅查看）',
  revoked: '已撤销',
  'legacy-pending': '需重新确认',
}
const SCOPES = new Set<string>(Object.keys(SCOPE_LABELS))
const RUNNING = 'Host 正在运行，请先停止（pnpm stop）'
const PROJECT_RUNNING = 'Host 正在运行。请在 Latch 桌面端添加，或先停止 Host。'
const PROJECT_REMOVE_RUNNING = 'Host 正在运行。请在 Latch 的「设置 → 项目」中移除，或先停止 Host。'
const OFFLINE_WARNING = '离线连接依赖本机此刻没有恶意的同用户进程。只在无法使用本机确认时使用。'
const UNPINNED = '本机确认组件尚未记录。请先在这台电脑上打开一次 Latch，或停止 Host 后重试。'
/**
 * What a loopback link offers unless --scopes says otherwise: what the desktop app's own link offers (apps/desktop/src/proxy.cjs),
 * and, with no desktop app to raise it later, 「管理此 Host」 too. The confirmation warns when that is asked for.
 */
const BROWSER_SCOPES: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin']

const USAGE = `用法：pnpm latch <命令> [--data-dir <目录>]

  device list [--json]                     列出已连接的设备（Host 运行中）
  device revoke <设备 ID>                   撤销设备（Host 运行中）
  device invite [--loopback] [--scopes view,run,...] [--code-file <路径>]
                                           生成手机配对二维码（Host 运行中，需要 HTTPS 入口）；
                                           --loopback 生成这台电脑上浏览器用的一次性链接，
                                           未给 --scopes 时可申请到「管理此 Host」
  device enroll --offline [--code-file <路径>]
                                           生成桌面端用的一次性离线连接码（Host 已停止）
  provider set-key <服务 ID> [--expect-url <服务地址>]
                                           从标准输入读取并保存模型服务密钥；地址未确认时先列出它，一并确认（Host 已停止）
  provider confirm <服务 ID> [--expect-url <服务地址>]
                                           列出并确认模型服务的地址，本机或局域网地址同时允许 Host 访问（Host 已停止）。
                                           在终端上输入 y 确认；非交互环境用 --expect-url 写出要确认的地址
  project list [--json]                    列出项目与其中的文件夹（Host 已停止）
  project add <路径…> [--name <名称>] [--yes]
                                           用这些文件夹新建项目，第一个是主文件夹（Host 已停止）
  project add-folder <项目 ID> <路径…> [--yes]
                                           把文件夹加入项目（Host 已停止）
  project remove <项目 ID> [--yes]          移除项目，文件夹中的文件不删除（Host 已停止）
  project remove-folder <项目 ID> <文件夹 ID> [--yes]
                                           从项目中移除一个文件夹（Host 已停止）
  项目命令沿用上次 Host 的默认文件夹；首次启动前需加 --workspace <默认文件夹>。
  presence status                          查看本机确认是否可用
  presence repin                           重新记录本机确认组件的签名（Host 已停止）
  presence test                            显示一次示例本机确认（人工检查）
  audit verify                             校验审计记录
  traffic [--json]                         Host 本次启动以来发出的字节数与帧大小分布（Host 运行中）
`

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const valued = new Set(['--data-dir', '--scopes', '--code-file', '--port', '--name', '--workspace', '--expect-url'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    if (flags.has(name)) throw new CliError(`${name} 只能指定一次`)
    if (!valued.has(name)) {
      if (eq >= 0) throw new CliError(`${name} 不接受值`)
      flags.set(name, true)
      continue
    }
    const value = eq < 0 ? argv[++index] : arg.slice(eq + 1)
    if (!value || value.startsWith('--')) throw new CliError(`${name} 需要一个值`)
    flags.set(name, value)
  }
  return { positional, flags }
}

function connectable(socketPath: string): Promise<boolean> {
  return new Promise(done => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      done(false)
    }, 1_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      done(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}

async function runningHost(dataDir: string): Promise<{ state: HostState; info: HostInfo }> {
  const state = await readHostState(dataDir)
  const info = state && (await verifyHostState(state))
  if (!state || !info) throw new CliError(`没有可确认的运行中 Host（${dataDir}）。请先启动 Host。`)
  return { state, info }
}

/**
 * A live process recorded in host.json, or anything answering on its socket, counts as a running Host. A host.json this
 * build cannot read proves nothing, so only a recorded pid that is gone lets the command go ahead.
 */
async function refuseRunningHost(dataDir: string, running = RUNNING): Promise<void> {
  const state = await readHostState(dataDir)
  if (state) {
    if (processAlive(state.pid) || (await connectable(state.socketPath))) throw new CliError(running)
    return
  }
  const recorded = await readRecordedPid(dataDir)
  if (!recorded.present) return
  if (recorded.pid === undefined)
    throw new CliError(`无法识别 ${join(dataDir, 'host.json')}，不能确认 Host 已停止。确认没有 Host 在运行后删除该文件再重试。`)
  if (processAlive(recorded.pid)) throw new CliError(running)
}

/**
 * Offline commands hold the data-dir lock for their whole run, so no Host can start underneath them, and refuse while a
 * Host holds it (including before it has written host.json). A Host that runs without the lock is still found through
 * host.json: by its pid and socket, or, in the previous build's format, by the pid it records.
 */
async function lockStopped(dataDir: string, running = RUNNING): Promise<DataDirLock> {
  let lock: DataDirLock
  try {
    lock = await acquireDataDirLock(dataDir, 'cli')
  } catch (error) {
    // A Host holding the lock is running or starting; the command says what to do instead.
    if (running !== RUNNING && error instanceof AppError && error.code === 'data-dir-locked' && error.details?.role === 'host')
      throw new CliError(running)
    throw error
  }
  try {
    await refuseRunningHost(dataDir, running)
  } catch (error) {
    await lock.release()
    throw error
  }
  return lock
}

const PLAIN_HTTP = '这个地址不使用 HTTPS，发给它的内容会以明文经过网络。'

/** A policy.json from before confirmed addresses gets the addresses already confirmed first, exactly as the Host would. */
async function openPolicy(dataDir: string, audit: AuditLog, config: HostConfig): Promise<PolicyStore> {
  const policy = await PolicyStore.open({ dataDir, audit })
  if (policy.needsAddressMigration)
    await policy.migrateConfirmedAddresses(addressesConfirmedBefore(config.providers(), policy.get().hostEgressAllow), CLI_ACTOR)
  return policy
}

/**
 * What confirming a model-service address offline adds, worked out before anything is written so the terminal can show
 * it first: the address (origin and path), and for a local or private address its allow-list entry.
 */
interface OfflinePlan {
  /** The service's base URL, normalized (ASCII: punycode host, percent-encoded path). */
  baseURL: string
  origin: string
  /** The origin and path that is confirmed (`addressOf`). */
  address: string
  preset: boolean
  /** What confirming adds; empty when the address is confirmed and has the allowance it needs. */
  added: { address?: string; egress?: string }
  /** Why the address needs an allowance: it is on this computer, or elsewhere on a local or private network. */
  where?: 'this-computer' | 'network'
  /** Plain HTTP to somewhere other than this computer. */
  plain: boolean
}

/** Reads only: the policy is not touched until the plan was shown and approved (`applyOffline`). */
async function planOffline(policy: PolicyStore, baseURL: string): Promise<OfflinePlan> {
  const origin = originOf(baseURL)
  const shown = { baseURL: new URL(baseURL).href, origin, address: addressOf(baseURL) }
  if (isPresetKeyOrigin(origin)) return { ...shown, preset: true, added: {}, plain: false }
  const need = await createEgressInspector()(baseURL)
  if (need.allowance === 'never') throw new CliError(`Host 从不访问 ${need.target}（云元数据地址），不能确认这个地址`)
  const where =
    need.allowance !== 'needed' ? undefined : need.reason === 'loopback' || need.reason === 'local-interface' ? 'this-computer' : 'network'
  const current = policy.get()
  const added = {
    ...((current.confirmedAddresses ?? []).includes(shown.address) ? {} : { address: shown.address }),
    ...(need.allowance === 'needed' && !current.hostEgressAllow.includes(need.target) ? { egress: need.target } : {}),
  }
  return { ...shown, preset: false, added, ...(where ? { where } : {}), plain: origin.startsWith('http://') && where !== 'this-computer' }
}

const adds = (plan: OfflinePlan) => Boolean(plan.added.address || plan.added.egress)

/**
 * The facts being confirmed, as the confirmation window on macOS lists them: the terminal is the trusted display for an
 * offline confirmation. The service's name was typed on some admin device, so it is escaped like any security text.
 */
function offlinePreview(record: Pick<ProviderRecord, 'id' | 'name'>, plan: OfflinePlan): string[] {
  return [
    `将确认模型服务「${escapeSecurityText(record.name)}」（${record.id}）的地址：`,
    `  地址：${plan.baseURL}`,
    `  确认的范围：${plan.address}（只有这个源与路径；同一源下的其他路径要另行确认）`,
    ...(plan.added.egress
      ? [`  出站许可：允许 Host 访问 ${plan.added.egress}（${plan.where === 'this-computer' ? '这台电脑上的地址' : '局域网或私网地址'}）`]
      : []),
    ...(plan.plain ? [`  注意：${PLAIN_HTTP}`] : []),
    '确认后，Latch 内置会把对话内容发往这个地址。只在你自己添加了这个服务、并认得这个地址时确认。',
  ]
}

/**
 * The approval an offline confirmation needs: `--expect-url` naming exactly this address (origin and path), or, on a
 * terminal, an explicit y (`ask`; typing a key at a prompt that names the address counts for set-key). Without either
 * nothing is written: piped input is not someone who read the address.
 */
async function approveOffline(io: CliIO, expected: string | true | undefined, plan: OfflinePlan, ask: boolean): Promise<void> {
  if (typeof expected === 'string') {
    let given: string
    try {
      given = addressOf(expected)
    } catch {
      throw new CliError('--expect-url 不是有效的 HTTP(S) 地址，没有修改任何设置')
    }
    if (given !== plan.address) throw new CliError(`--expect-url 与模型服务的地址不一致（服务的地址是 ${plan.address}），没有修改任何设置`)
    return
  }
  if (!io.stdin.isTTY)
    throw new CliError('非交互环境中不能确认地址：核对上面的地址后，加上 --expect-url <服务地址> 重新运行。没有修改任何设置')
  if (!ask) return
  const answer = (await io.readLine('确认以上地址？输入 y 确认，其他任意内容取消：')).trim().toLowerCase()
  if (answer !== 'y' && answer !== 'yes') throw new CliError('已取消，没有修改任何设置')
}

/** Writes exactly what was shown (never inspecting the address again) and returns what it added, for an undo. */
async function applyOffline(policy: PolicyStore, plan: OfflinePlan): Promise<OfflinePlan['added']> {
  const current = policy.get()
  const addresses = current.confirmedAddresses ?? []
  const added = {
    ...(plan.added.address && !addresses.includes(plan.added.address) ? { address: plan.added.address } : {}),
    ...(plan.added.egress && !current.hostEgressAllow.includes(plan.added.egress) ? { egress: plan.added.egress } : {}),
  }
  if (added.address || added.egress) {
    const next = structuredClone(current)
    if (added.address) next.confirmedAddresses = [...addresses, added.address]
    if (added.egress) next.hostEgressAllow = [...current.hostEgressAllow, added.egress]
    await policy.update(next, CLI_ACTOR, 'offline')
  }
  return added
}

/** Takes back what `applyOffline` added, after the save it was for failed. Removing never waits for the audit log. */
async function undoOffline(policy: PolicyStore, added: OfflinePlan['added']): Promise<void> {
  if (!added.address && !added.egress) return
  const latest = policy.get()
  const lowered = structuredClone(latest)
  if (added.address) lowered.confirmedAddresses = (latest.confirmedAddresses ?? []).filter(item => item !== added.address)
  if (added.egress) lowered.hostEgressAllow = latest.hostEgressAllow.filter(item => item !== added.egress)
  await policy.update(lowered, CLI_ACTOR, 'none').catch(() => {})
}

/** Plans the address of `baseURL`, with the policy open only to read it (and for the one-time upgrade). */
async function planFor(dataDir: string, config: HostConfig, baseURL: string): Promise<OfflinePlan> {
  const audit = await AuditLog.open(join(dataDir, 'audit'))
  try {
    return await planOffline(await openPolicy(dataDir, audit, config), baseURL)
  } finally {
    await audit.close()
  }
}

async function api(state: HostState, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await unixRequest(state.socketPath, `/link/api/${path}`, {
    method,
    ...(body === undefined ? {} : { body }),
    timeoutMs: 10_000,
  })
  if (response.status >= 200 && response.status < 300) return response.body
  const message =
    typeof response.body === 'object' && response.body !== null && 'message' in response.body
      ? String(response.body.message)
      : `HTTP ${response.status}`
  throw new CliError(message)
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

async function samePath(path: string, handle: FileHandle): Promise<boolean> {
  const [opened, current] = await Promise.all([handle.stat(), lstat(path).catch(() => undefined)])
  return current !== undefined && current.isFile() && current.dev === opened.dev && current.ino === opened.ino
}

interface SecretFile {
  write(text: string): Promise<void>
  /** Removes the file if nothing was written; a no-op after write. */
  discard(): Promise<void>
}

/**
 * The directory a secret file goes into: owned by this user (or by root with the sticky bit, like /tmp), not writable by
 * others without the sticky bit, and on macOS without access-control entries, which could let another user add, swap or
 * read the file whatever its mode (entries inherited from the directory are applied the moment the file is created).
 */
async function privateDirectory(shown: string): Promise<{ path: string; dev: number; ino: number }> {
  let path: string
  try {
    path = await realpath(shown)
  } catch {
    throw new CliError(`无法访问目录 ${shown}`)
  }
  const info = await lstat(path)
  if (!info.isDirectory()) throw new CliError(`${shown} 不是目录`)
  const sticky = (info.mode & 0o1000) !== 0
  const uid = process.getuid?.()
  if (uid !== undefined && info.uid !== uid && !(info.uid === 0 && sticky))
    throw new CliError(`${shown} 不属于当前用户，请把文件写到你自己的目录`)
  if ((info.mode & 0o022) !== 0 && !sticky) throw new CliError(`${shown} 其他用户也能写入，请把文件写到只有你能写入的目录`)
  if (process.platform === 'darwin') {
    // Listed as '.', so the directory name cannot add lines of its own; every line after the first is an entry.
    const listing = await run('/bin/ls', ['-led', '.'], { cwd: path, env: {} }).catch(() => {
      throw new CliError(`无法读取 ${shown} 的访问控制列表`)
    })
    if (
      listing.stdout
        .split('\n')
        .slice(1)
        .some(line => line.trim())
    ) {
      throw new CliError(
        `${shown} 带有访问控制列表（ACL），其他用户可能借此读取或替换文件。macOS 的个人文件夹默认带有这类设置；请把文件写到没有 ACL 的目录，例如用 mktemp -d 新建的目录`,
      )
    }
  }
  return { path, dev: info.dev, ino: info.ino }
}

/**
 * Creates the file a secret goes to, before the secret exists, so a refused path wastes no code. The file is new (no
 * existing file, symlink or hard link is reused or followed), 0600, and lives in a directory that privateDirectory
 * accepted and that was not swapped while the file was created.
 */
async function createSecretFile(path: string): Promise<SecretFile> {
  const directory = await privateDirectory(dirname(path))
  const target = join(directory.path, basename(path))
  let handle: FileHandle
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (codeOf(error) === 'EEXIST' || codeOf(error) === 'ELOOP')
      throw new CliError(`${path} 已存在。为避免覆盖其他文件，请先删除它或换一个新路径`)
    throw error
  }
  let pending = true
  const discard = async () => {
    if (!pending) return
    pending = false
    const ours = await samePath(target, handle)
    await handle.close()
    if (ours) await unlink(target).catch(() => {})
  }
  try {
    const after = await lstat(directory.path).catch(() => undefined)
    if (!after || after.dev !== directory.dev || after.ino !== directory.ino || !(await samePath(target, handle)))
      throw new CliError(`${path} 在写入前被替换，已停止`)
    await handle.chmod(0o600)
  } catch (error) {
    await discard()
    throw error
  }
  return {
    discard,
    async write(text) {
      try {
        if (!(await samePath(target, handle))) throw new CliError(`${path} 在写入前被替换，已停止`)
        await handle.writeFile(text + '\n')
        await handle.sync()
      } catch (error) {
        await discard()
        throw error
      }
      pending = false
      await handle.close()
    },
  }
}

/**
 * The policy exactly as the running Host last wrote it, for reading only. Pinning the helper from here would append to
 * the audit log and rewrite policy.json behind the Host's back and fork the audit chain, so it is refused.
 */
async function readOnlyPolicy(dataDir: string): Promise<PolicyStore> {
  let policy: Policy
  try {
    const parsed = parsePolicyFile(JSON.parse(await readFile(join(dataDir, 'policy.json'), 'utf8')))
    if (!parsed.success) throw parsed.error
    policy = parsed.data
  } catch {
    throw new CliError('无法读取安全策略文件 policy.json')
  }
  const view: Pick<PolicyStore, 'get' | 'pinHelperCdhash'> = {
    get: () => structuredClone(policy),
    pinHelperCdhash: () => Promise.reject(new CliError(UNPINNED)),
  }
  // createPresenceBackend only reads through get() and pins through pinHelperCdhash().
  return view as unknown as PolicyStore
}

async function presenceTest(backend: PresenceBackend, hostId: () => Promise<string>, out: (text: string) => void): Promise<void> {
  const availability = await backend.availability()
  if (availability.status !== 'available') throw new CliError(`本机确认不可用：${availability.message}`)
  const { preview, previewHash, hashDisplay } = buildPreview({
    hostId: await hostId(),
    action: 'device.enroll',
    now: Date.now(),
    requester: { deviceName: '示例设备', listener: 'cli', remoteAddress: '命令行' },
    // Nothing is enrolled either way.
    subject: { form: 'device.enroll-named', slots: { device: '示例设备（只是检查）' } },
    lines: [{ label: '设备名称', value: '示例设备（只是检查）' }],
    warnings: ['这是一次人工检查，确认或拒绝都不会改变任何设置。'],
  })
  out(`系统提示应显示：${preview.reason}`)
  const outcome = await backend.confirm({
    preview,
    previewHash,
    hashDisplay,
    requireBiometric: true,
    signal: AbortSignal.timeout(CONFIRMATION_LIFETIME_MS),
  })
  out(`结果：${outcome.result}${'method' in outcome ? `（${outcome.method}）` : ''}`)
}

function scopesFlag(value: string | true | undefined): DeviceScope[] | undefined {
  if (value === undefined) return undefined
  if (value === true) throw new CliError('--scopes 需要一个值')
  const scopes = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  for (const scope of scopes) if (!SCOPES.has(scope)) throw new CliError(`未知的权限：${scope}`)
  return scopes as DeviceScope[]
}

const TRAFFIC_LABELS: Record<TrafficKind, string> = {
  'task-state': '会话状态帧',
  'tasks-invalidated': '列表失效帧',
  refresh: '刷新帧',
  'host-state': 'Host 状态帧',
  heartbeat: '心跳',
  snapshot: '快照响应',
  detail: '会话详情响应',
}
const SHOWN_SESSIONS = 10

function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** A bucket bound, which is always a power of two: 256B, 1KiB, 4MiB. */
function boundText(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}MiB`
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}KiB`
  return `${bytes}B`
}

function timeText(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}

/** Numbers only: the summary holds counts, enums and opaque session IDs, never content or names. */
function trafficReport(summary: TrafficSummary): string {
  const bounds = summary.buckets.map(bound => `≤${boundText(bound)}`)
  const kinds = table([
    ['类别', '次数', '字节', '平均', ...bounds, '更大'],
    ...TRAFFIC_KINDS.map(kind => {
      const count = summary.kinds[kind]
      return [
        TRAFFIC_LABELS[kind],
        String(count.count),
        bytesText(count.bytes),
        count.count ? bytesText(Math.round(count.bytes / count.count)) : '—',
        ...count.histogram.map(String),
      ]
    }),
  ])
  const sessions = summary.sessions.slice(0, SHOWN_SESSIONS)
  const sessionTable = sessions.length
    ? table([
        ['会话 ID', '帧', '帧字节', '详情', '详情字节'],
        ...sessions.map(session => [
          session.sessionId,
          String(session.frames),
          bytesText(session.frameBytes),
          String(session.details),
          bytesText(session.detailBytes),
        ]),
      ])
    : '（没有）\n'
  const connectionTable = summary.connections.length
    ? table([
        ['连接', '入口', '状态', '打开时间', '帧', '字节', '心跳'],
        ...summary.connections.map(connection => [
          `#${connection.id}`,
          LISTENER_LABELS[connection.listener],
          connection.closedAt ? '已关闭' : '打开',
          timeText(connection.openedAt),
          String(connection.frames),
          bytesText(connection.bytes),
          String(connection.heartbeats),
        ]),
      ])
    : '（没有）\n'
  const more =
    summary.sessions.length > SHOWN_SESSIONS
      ? `（另有 ${summary.sessions.length - SHOWN_SESSIONS} 个会话未列出，用 --json 查看全部）\n`
      : ''
  return [
    `统计自 ${timeText(summary.since)}（UTC，Host 本次启动以来）到 ${timeText(summary.at)}。`,
    '计入事件流每帧的文本与快照、会话详情的响应体；不含 HTTP 头、分块编码与 TLS。',
    '',
    kinds,
    `会话（按字节，最多 ${SHOWN_SESSIONS} 个）`,
    sessionTable + more,
    '事件流连接（打开的在前，之后是最近关闭的）',
    connectionTable,
  ].join('\n')
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map(row => [...row[column]!].reduce((width, char) => width + (char.charCodeAt(0) > 0x2e7f ? 2 : 1), 0))),
  )
  return (
    rows
      .map(row =>
        row
          .map((cell, column) => {
            const width = [...cell].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e7f ? 2 : 1), 0)
            return cell + ' '.repeat(Math.max(0, widths[column]! - width))
          })
          .join('  ')
          .trimEnd(),
      )
      .join('\n') + '\n'
  )
}

async function cdhashOf(path: string): Promise<string> {
  try {
    await run('/usr/bin/codesign', ['--verify', '--strict', path], { env: {} })
  } catch {
    throw new CliError('latch-presence 签名无效，请重新运行 pnpm build:presence')
  }
  const { stderr } = await run('/usr/bin/codesign', ['-dvvv', path], { env: {} }).catch((error: { stderr?: string }) => ({
    stderr: error.stderr ?? '',
  }))
  const match = /^CDHash=([0-9a-f]{40})$/mu.exec(stderr)
  if (!match) throw new CliError('无法读取 latch-presence 的 CDHash')
  return match[1]!
}

export async function runLatch(argv: string[], io: CliIO): Promise<number> {
  const out = (text: string) => {
    io.stdout.write(text.endsWith('\n') ? text : text + '\n')
  }
  try {
    const { positional, flags } = parseArgs(argv)
    const [group, command, ...rest] = positional
    if (!group || flags.has('--help')) {
      out(USAGE)
      return group ? 0 : 1
    }
    const dataDirFlag = flags.get('--data-dir')
    const { dataDir } = resolveLatchPaths({ dataDir: typeof dataDirFlag === 'string' ? dataDirFlag : undefined, env: io.env, cwd: io.cwd })
    const key = `${group} ${command ?? ''}`

    if (key === 'device list') {
      const { state } = await runningHost(dataDir)
      const { devices } = (await api(state, 'GET', 'devices')) as { devices: Device[] }
      if (flags.has('--json')) {
        out(JSON.stringify(devices, null, 2))
        return 0
      }
      out(
        table([
          ['ID', '名称', '连接方式', '权限', '状态', '最近使用'],
          ...devices.map(device => [
            device.id,
            device.name,
            LISTENER_LABELS[device.listener],
            device.scopes.map(scope => SCOPE_LABELS[scope]).join('、') || '—',
            STATUS_LABELS[device.status],
            device.lastSeenAt.replace('T', ' ').slice(0, 16),
          ]),
        ]),
      )
      return 0
    }
    if (key === 'device revoke') {
      const id = rest[0]
      if (!id) throw new CliError('请提供设备 ID')
      const { state } = await runningHost(dataDir)
      const result = (await api(state, 'DELETE', `devices/${encodeURIComponent(id)}`)) as { cascaded?: number }
      out(`已撤销 ${id}。${result.cascaded ? `${result.cascaded} 台由它邀请配对的设备已降为仅查看，等待复核。` : ''}`)
      return 0
    }
    if (key === 'device invite') {
      const codeFile = flags.get('--code-file')
      const refusal = typeof codeFile === 'string' ? undefined : codeRefusal(io, '配对链接')
      if (refusal) throw new CliError(refusal)
      // A browser on this computer enrolls over loopback, which takes an invitation like any listener but host.sock.
      const loopback = flags.has('--loopback')
      const scopes = scopesFlag(flags.get('--scopes')) ?? (loopback ? [...BROWSER_SCOPES] : undefined)
      const { state } = await runningHost(dataDir)
      const codePath = typeof codeFile === 'string' ? resolve(io.cwd, codeFile) : undefined
      const file = codePath ? await createSecretFile(codePath) : undefined
      let invitation: InvitationView
      try {
        const body = { ...(scopes ? { scopes } : {}), ...(loopback ? { target: 'loopback' } : {}) }
        ;({ invitation } = (await api(state, 'POST', 'pairings', body)) as { invitation: InvitationView })
      } catch (error) {
        await file?.discard()
        throw error
      }
      const expires = new Date(invitation.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })
      if (file) {
        await file.write(invitation.url)
        out(`${loopback ? '浏览器链接' : '配对链接'}已写入 ${codePath}（0600），${expires} 前有效，只能使用一次。`)
        return 0
      }
      if (loopback) {
        out(`在这台电脑的浏览器中打开：${invitation.url}`)
        out(`${expires} 前有效，只能使用一次。浏览器提交后，请在这台电脑上核对指纹并确认。`)
        return 0
      }
      out(await QRCode.toString(invitation.url, { type: 'terminal', small: true }))
      out(`用手机扫描二维码，或打开：${invitation.url}`)
      out(`${expires} 前有效，只能使用一次。手机提交后，请在这台电脑上核对指纹并确认。`)
      return 0
    }
    if (key === 'device enroll') {
      if (!flags.has('--offline')) throw new CliError('device enroll 目前只支持 --offline')
      const codeFile = flags.get('--code-file')
      const refusal = typeof codeFile === 'string' ? undefined : codeRefusal(io, '离线连接码')
      if (refusal) throw new CliError(refusal)
      const codePath = typeof codeFile === 'string' ? resolve(io.cwd, codeFile) : undefined
      const lock = await lockStopped(dataDir)
      let file: SecretFile | undefined
      try {
        file = codePath ? await createSecretFile(codePath) : undefined
        io.stderr.write(`${OFFLINE_WARNING}\n`)
        const audit = await AuditLog.open(join(dataDir, 'audit'))
        try {
          const ticket = await createOfflineTicket(join(dataDir, 'auth'))
          await audit.append({
            action: 'offline.ticket.created',
            actor: CLI_ACTOR,
            target: ticket.ticketId,
            stepup: 'offline',
            detail: { ticketId: ticket.ticketId },
          })
          const expires = new Date(ticket.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })
          if (file) {
            await file.write(ticket.code)
            out(`离线连接码已写入 ${codePath}（0600），${expires} 前有效，只能使用一次。`)
          } else {
            out(`离线连接码：${ticket.code}`)
            out(`${expires} 前有效，只能使用一次。`)
          }
          // Only host.sock takes offline codes: a browser's loopback port may be forwarded from elsewhere.
          out('启动 Latch 桌面端（pnpm desktop）后，在它的连接页面填写离线连接码。浏览器与手机不接受离线连接码。')
        } finally {
          await audit.close()
        }
      } finally {
        await file?.discard()
        await lock.release()
      }
      return 0
    }
    if (key === 'provider set-key') {
      const providerId = rest[0]
      if (!providerId) throw new CliError('请提供模型服务 ID')
      // Held across the prompt too, so no Host can start and load providers.json while the key is being typed.
      const lock = await lockStopped(dataDir)
      try {
        const opened = await HostConfig.open(dataDir)
        const record = opened.provider(providerId)
        if (!record) throw new CliError(`找不到模型服务 ${providerId}`)
        const scope = keyScopeOf(record.baseURL)
        const target = keyScopeText(scope)
        // An address not confirmed yet is confirmed with the key: shown first, and approved before the key is read.
        const plan = await planFor(dataDir, opened, record.baseURL)
        if (adds(plan)) {
          for (const line of offlinePreview(record, plan)) out(line)
          await approveOffline(io, flags.get('--expect-url'), plan, false)
        }
        const confirming = adds(plan) ? `；保存即确认上面的地址${plan.added.egress ? `，并允许 Host 访问 ${plan.added.egress}` : ''}` : ''
        const prompt = `${escapeSecurityText(record.name)} 的 API Key（只发往 ${target}${confirming}）：`
        const apiKey = (await io.readSecret(prompt)).replace(/\r?\n$/u, '')
        if (!apiKey) throw new CliError('没有读取到密钥')
        if (/[\u0000-\u001f\u007f]/u.test(apiKey) || apiKey.length > 8192)
          throw new CliError('API Key 不能包含换行或控制字符，且不超过 8192 个字符')
        // A Host that runs without the lock may have started during the prompt; the key stays bound to the address shown.
        await refuseRunningHost(dataDir)
        const config = await HostConfig.open(dataDir)
        const current = config.provider(providerId)
        if (!current || keyScopeText(keyScopeOf(current.baseURL)) !== target)
          throw new CliError(`模型服务 ${providerId} 在输入密钥期间被修改，未保存密钥，请重新运行`)
        const audit = await AuditLog.open(join(dataDir, 'audit'))
        let added: OfflinePlan['added'] = {}
        try {
          const policy = await openPolicy(dataDir, audit, config)
          // The same order as the Host: the key's record, then the address it is confirmed for, then the key.
          const { seq } = await audit.append({
            action: 'provider.secret.set',
            actor: CLI_ACTOR,
            target: providerId,
            stepup: 'offline',
            detail: { providerId, originHash: sha256Hex(scope.keyOrigin) },
          })
          try {
            added = await applyOffline(policy, plan)
          } catch (error) {
            await audit.append({ action: 'action.failed', actor: CLI_ACTOR, detail: { refSeq: seq } }).catch(() => {})
            throw error
          }
          try {
            await config.updateProviders(draft => {
              const saved = draft.find(item => item.id === providerId)
              if (!saved) throw new CliError(`找不到模型服务 ${providerId}`)
              saved.apiKey = apiKey
              saved.keyOrigin = scope.keyOrigin
              saved.keyPath = scope.keyPath
            })
          } catch (error) {
            await undoOffline(policy, added)
            await audit.append({ action: 'action.failed', actor: CLI_ACTOR, detail: { refSeq: seq } }).catch(() => {})
            throw error
          }
        } finally {
          await audit.close()
        }
        out(`已为 ${providerId} 保存密钥，只发往 ${target}。`)
        if (added.address) out(`已确认模型服务地址 ${added.address}。`)
        if (added.egress) out(`已允许 Host 访问 ${added.egress}。`)
        if (plan.plain) out(PLAIN_HTTP)
      } finally {
        await lock.release()
      }
      return 0
    }
    if (key === 'provider confirm') {
      const providerId = rest[0]
      if (!providerId) throw new CliError('请提供模型服务 ID')
      const lock = await lockStopped(dataDir)
      try {
        const opened = await HostConfig.open(dataDir)
        const record = opened.provider(providerId)
        if (!record) throw new CliError(`找不到模型服务 ${providerId}`)
        const plan = await planFor(dataDir, opened, record.baseURL)
        if (plan.preset) {
          out(`${plan.origin} 是预置服务商的地址，不需要确认。`)
          return 0
        }
        if (!adds(plan)) {
          out(`${providerId} 的地址 ${plan.address} 已经确认过。`)
          return 0
        }
        // The facts first, then an explicit yes: nothing is written before both.
        for (const line of offlinePreview(record, plan)) out(line)
        await approveOffline(io, flags.get('--expect-url'), plan, true)
        await refuseRunningHost(dataDir)
        const config = await HostConfig.open(dataDir)
        const current = config.provider(providerId)
        if (!current || addressOf(current.baseURL) !== plan.address)
          throw new CliError(`模型服务 ${providerId} 在确认期间被修改，没有修改任何设置，请重新运行`)
        const audit = await AuditLog.open(join(dataDir, 'audit'))
        let added: OfflinePlan['added']
        try {
          added = await applyOffline(await openPolicy(dataDir, audit, config), plan)
        } finally {
          await audit.close()
        }
        if (added.address) out(`已确认 ${providerId} 的地址 ${added.address}，启动 Host 后可以使用。`)
        if (added.egress) out(`已允许 Host 访问 ${added.egress}。`)
        if (plan.plain) out(PLAIN_HTTP)
      } finally {
        await lock.release()
      }
      return 0
    }
    if (key === 'project list') {
      const lock = await lockStopped(dataDir, PROJECT_RUNNING)
      try {
        const { workspaces } = (await HostConfig.open(dataDir)).settings()
        if (flags.has('--json')) out(JSON.stringify(workspaces, null, 2))
        else if (workspaces.length === 0) out('还没有项目。用 pnpm latch project add <路径…> 新建，或在 Latch 桌面端新建。')
        else
          out(
            table([
              ['ID', '名称', '文件夹'],
              ...workspaces.flatMap(record =>
                record.folders.map((folder, index) => [
                  index === 0 ? record.id : '',
                  index === 0 ? record.name : '',
                  `${folder.path}${index === 0 ? '（主文件夹）' : ''}`,
                ]),
              ),
            ]),
          )
      } finally {
        await lock.release()
      }
      return 0
    }
    if (key === 'project add' || key === 'project add-folder')
      return (await addProjectFolders(key === 'project add-folder', rest, flags, dataDir, io, out)) ? 0 : 1
    if (key === 'project remove' || key === 'project remove-folder')
      return (await removeProjectFolder(key === 'project remove-folder', rest, flags, dataDir, io, out)) ? 0 : 1
    if (key === 'presence status') {
      const state = await readHostState(dataDir)
      const info = state && (await verifyHostState(state))
      let presence: HostInfo['presence']
      if (info) presence = info.presence
      else {
        // The check may pin the helper (an audited policy change), so it runs only with the data dir locked.
        const lock = await lockStopped(dataDir)
        try {
          const audit = await AuditLog.open(join(dataDir, 'audit'))
          try {
            const policy = await PolicyStore.open({ dataDir, audit })
            const availability = await createPresenceBackend({ codeRoot: latchCodeRoot(), policy }).availability()
            presence =
              availability.status === 'available' ? { status: 'available' } : { status: 'unavailable', message: availability.message }
          } finally {
            await audit.close()
          }
        } finally {
          await lock.release()
        }
      }
      out(presence.status === 'available' ? '本机确认：可用' : `本机确认不可用：${presence.message ?? ''}`)
      return 0
    }
    if (key === 'presence repin') {
      if (process.platform !== 'darwin') throw new CliError('此系统暂不支持本机确认（Touch ID 或登录密码）')
      const lock = await lockStopped(dataDir)
      try {
        const cdhash = await cdhashOf(presenceHelperPath(latchCodeRoot()))
        const audit = await AuditLog.open(join(dataDir, 'audit'))
        try {
          const policy = await PolicyStore.open({ dataDir, audit })
          const current = policy.get()
          await policy.update({ ...current, presence: { ...current.presence, helperCdhash: cdhash } }, CLI_ACTOR, 'offline')
        } finally {
          await audit.close()
        }
        out(`已记录 latch-presence cdhash ${cdhash}`)
      } finally {
        await lock.release()
      }
      return 0
    }
    if (key === 'presence test') {
      const state = await readHostState(dataDir)
      const info = state && (await verifyHostState(state))
      if (info) {
        // The running Host owns the audit log and policy.json: read them only, and never pin from here.
        const backend = createPresenceBackend({ codeRoot: latchCodeRoot(), policy: await readOnlyPolicy(dataDir) })
        await presenceTest(backend, async () => info.hostId, out)
        return 0
      }
      const lock = await lockStopped(dataDir)
      try {
        const audit = await AuditLog.open(join(dataDir, 'audit'))
        try {
          const backend = createPresenceBackend({ codeRoot: latchCodeRoot(), policy: await PolicyStore.open({ dataDir, audit }) })
          await presenceTest(backend, async () => (await loadOrCreateHostIdentity(dataDir)).hostId, out)
        } finally {
          await audit.close()
        }
      } finally {
        await lock.release()
      }
      return 0
    }
    if (group === 'traffic' && command === undefined) {
      const { state } = await runningHost(dataDir)
      const summary = (await api(state, 'GET', 'traffic')) as TrafficSummary
      out(flags.has('--json') ? JSON.stringify(summary, null, 2) : trafficReport(summary))
      return 0
    }
    if (key === 'audit verify') {
      const path = join(dataDir, 'audit', 'audit.jsonl')
      const result = await verifyAuditFile(path).catch(error => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new CliError(`找不到审计记录 ${path}`)
        throw error
      })
      if (result.ok) {
        out(`审计记录完整：共 ${result.records} 条，最新 #${result.head.seq} ${result.head.hash}`)
        return 0
      }
      io.stderr.write(`审计记录在第 ${result.line} 行校验失败（${result.reason}）。\n`)
      return 1
    }
    out(USAGE)
    return 1
  } catch (error) {
    const message =
      error instanceof CliError || error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error)
    io.stderr.write(`${redactSecrets(message)}\n`)
    return 1
  }
}

async function offlineProjectContext(dataDir: string, flags: Map<string, string | true>, io: CliIO) {
  const recorded = await readProjectContext(dataDir)
  const explicit = flags.get('--workspace') ?? latchEnv(io.env, 'WORKSPACE')
  if (!recorded && typeof explicit !== 'string') {
    throw new CliError('没有已记录的 Host 默认文件夹。请先用原参数启动并停止 Host，或提供 --workspace <默认文件夹>。')
  }
  if (
    recorded
    && typeof explicit === 'string'
    && (await canonicalPath(resolve(io.cwd, explicit))) !== (await canonicalPath(recorded.workspaceRoot))
  ) {
    throw new CliError('--workspace 与上次 Host 的默认文件夹不同，请先用新的启动参数成功启动并停止 Host。')
  }
  const located = resolveLatchPaths({
    dataDir,
    env: io.env,
    cwd: io.cwd,
    workspace: recorded?.workspaceRoot ?? (explicit as string),
  })
  return {
    workspaceRoot: located.workspaceRoot,
    agentsDir: recorded?.agentsDir ?? resolve(located.agentsDir),
    codeRoot: recorded?.codeRoot ?? latchCodeRoot(),
    ...(recorded?.tlsKeyPath ? { tlsKeyPath: recorded.tlsKeyPath } : {}),
  }
}

/**
 * `project add` and `project add-folder`, while the Host is stopped: the same folder rules (R1–R10 and the project rules)
 * and the same audit as the desktop app's native picker, with `via: 'cli'`. The owner sees the realpaths and confirms
 * on a terminal, or passes `--yes`.
 */
async function addProjectFolders(
  adding: boolean,
  rest: string[],
  flags: Map<string, string | true>,
  dataDir: string,
  io: CliIO,
  out: (text: string) => void,
): Promise<boolean> {
  const projectId = adding ? rest[0] : undefined
  const inputs = adding ? rest.slice(1) : rest
  if (adding && !projectId) throw new CliError('请提供项目 ID')
  if (projectId === 'default') throw new CliError('默认文件夹只能包含一个文件夹。要组合多个文件夹，请新建项目。')
  if (inputs.length === 0) throw new CliError('请提供至少一个文件夹路径')
  if (inputs.length > PROJECT_FOLDER_LIMIT) throw new CliError(`一次最多添加 ${PROJECT_FOLDER_LIMIT} 个文件夹`)
  const nameFlag = flags.get('--name')
  if (adding && nameFlag !== undefined) throw new CliError('add-folder 不接受 --name；重命名请在设置中进行')
  const name = typeof nameFlag === 'string' ? nameFlag.trim() : undefined
  if (name !== undefined && (name.length === 0 || name.length > 80 || !isPrintableText(name)))
    throw new CliError('名称需为 1–80 个字，且不能包含不可显示的字符')
  const ask = io.stdout.isTTY ? io.confirm : undefined
  if (!ask && !flags.has('--yes')) throw new CliError('添加文件夹需要确认：在终端中运行，或加上 --yes')

  const lock = await lockStopped(dataDir, PROJECT_RUNNING)
  try {
    const config = await HostConfig.open(dataDir)
    const settings = config.settings()
    const record = adding ? settings.workspaces.find(item => item.id === projectId) : undefined
    if (adding && !record) throw new CliError(`找不到项目 ${projectId}`)
    const context = await offlineProjectContext(dataDir, flags, io)
    const identity = await loadOrCreateHostIdentity(dataDir)
    const guard = {
      dataDir: await realpath(dataDir),
      agentsDir: context.agentsDir,
      runtimeDir: await runtimeDirPath(identity.hostId8),
      home: homedir(),
      codeRoot: context.codeRoot,
      ...(context.tlsKeyPath ? { tlsKeyPath: context.tlsKeyPath } : {}),
    }
    const primaries = [
      { id: 'default', name: '默认文件夹', path: context.workspaceRoot },
      ...settings.workspaces
        .filter(item => item.id !== projectId)
        .map(item => ({ id: item.id, name: item.name, path: item.folders[0].path })),
    ]
    const plan = await planFolders({
      current: record?.folders ?? [],
      paths: inputs.map(path => resolve(io.cwd, path)),
      primaries,
      guard,
    })
    for (const refusal of plan.refused) io.stderr.write(`没有加入 ${refusal.path}：${refusal.message}\n`)
    if (plan.added.length === 0) throw new CliError('选择的文件夹都没有加入')
    const created = record
      ? undefined
      : newProject({
          ...(name !== undefined ? { name } : {}),
          folders: plan.folders,
          taken: ['default', ...settings.workspaces.map(item => item.id)],
        })
    out(record ? `将把这些文件夹加入项目「${record.name}」（${record.id}）：` : `将用这些文件夹新建项目「${created!.name}」：`)
    for (const folder of plan.added) out(`  ${folder.path}${folder === plan.folders[0] ? '（主文件夹）' : ''}`)
    out('Latch 内置不经询问就能读取其中的文件，读到的内容会发给模型服务。')
    if (!flags.has('--yes') && !(await ask!('确认添加？[y/N] '))) {
      out('已取消，没有改动。')
      return false
    }
    // A Host that runs without the lock may have started while the owner was reading.
    await refuseRunningHost(dataDir, PROJECT_RUNNING)
    const audit = await AuditLog.open(join(dataDir, 'audit'))
    try {
      const seqs: number[] = []
      const failed = async () => {
        for (const refSeq of seqs) await audit.append({ action: 'action.failed', actor: CLI_ACTOR, detail: { refSeq } }).catch(() => {})
      }
      try {
        if (created) {
          seqs.push(
            (
              await audit.append({
                action: 'workspace.added',
                actor: CLI_ACTOR,
                target: created.id,
                stepup: 'offline',
                detail: {
                  workspaceId: created.id,
                  pathHash: sha256Hex(created.path),
                  folderCount: created.folders.length,
                  foldersHash: foldersHash(created.folders),
                  via: 'cli',
                },
              })
            ).seq,
          )
        } else {
          for (const folder of plan.added) {
            seqs.push(
              (
                await audit.append({
                  action: 'workspace.folder-added',
                  actor: CLI_ACTOR,
                  target: record!.id,
                  stepup: 'offline',
                  detail: {
                    workspaceId: record!.id,
                    folderId: folder.id,
                    pathHash: sha256Hex(folder.path),
                    via: 'cli',
                    replacesFolder: false,
                  },
                })
              ).seq,
            )
          }
        }
        await config.updateSettings(
          draft => {
            if (created) {
              draft.workspaces.push(created)
              return
            }
            const target: WorkspaceRecord | undefined = draft.workspaces.find(item => item.id === record!.id)
            if (!target) throw new CliError(`找不到项目 ${record!.id}`)
            target.folders = plan.folders
            target.path = plan.folders[0].path
          },
          // The baseline the next Host start compares settings.json with, as the Host records its own writes.
          async (next, commit) => {
            const before = sha256Hex(canonicalJson(config.settings()))
            const after = sha256Hex(canonicalJson(next))
            if (before !== after)
              await audit.append({ action: 'settings.changed', actor: CLI_ACTOR, detail: { before, after } }).catch(() => {})
            await commit()
          },
        )
      } catch (error) {
        await failed()
        throw error
      }
    } finally {
      await audit.close()
    }
    out(created ? `已新建项目「${created.name}」（${created.id}）。` : `已把 ${plan.added.length} 个文件夹加入「${record!.name}」。`)
    return true
  } finally {
    await lock.release()
  }
}

/**
 * `project remove` and `project remove-folder`, while the Host is stopped. Removing only lowers access, so a failed
 * audit record is reported and the removal still happens, as on the Host. The files stay where they are.
 */
async function removeProjectFolder(
  folder: boolean,
  rest: string[],
  flags: Map<string, string | true>,
  dataDir: string,
  io: CliIO,
  out: (text: string) => void,
): Promise<boolean> {
  const [projectId, folderId] = rest
  if (!projectId) throw new CliError('请提供项目 ID')
  if (folder && !folderId) throw new CliError('请提供文件夹 ID（pnpm latch project list --json 中的 folders[].id）')
  if (projectId === 'default') throw new CliError('默认文件夹由 Host 的启动参数决定，不能移除')
  const ask = io.stdout.isTTY ? io.confirm : undefined
  if (!ask && !flags.has('--yes')) throw new CliError('移除需要确认：在终端中运行，或加上 --yes')
  const lock = await lockStopped(dataDir, PROJECT_REMOVE_RUNNING)
  try {
    const config = await HostConfig.open(dataDir)
    const settings = config.settings()
    const record = settings.workspaces.find(item => item.id === projectId)
    if (!record) throw new CliError(`找不到项目 ${projectId}`)
    const index = folder ? record.folders.findIndex(item => item.id === folderId) : -1
    if (folder && index < 0) throw new CliError(`项目「${record.name}」中没有文件夹 ${folderId}`)
    if (folder && record.folders.length === 1) throw new CliError('项目至少要有一个文件夹；要移除整个项目，请用 project remove')
    const folders = record.folders.filter((_, position) => position !== index)
    if (index === 0) {
      // The next folder becomes primary; it may not be another project's primary folder or the start directory.
      const others = [
        { id: 'default', name: '默认文件夹', path: (await offlineProjectContext(dataDir, flags, io)).workspaceRoot },
        ...settings.workspaces
          .filter(item => item.id !== record.id)
          .map(item => ({ id: item.id, name: item.name, path: item.folders[0].path })),
      ]
      const verdict = await checkProjectFolders([folders[0].path], { existing: others })
      if (!verdict.ok) throw new CliError(verdict.error.message)
    }
    out(folder ? `将从项目「${record.name}」中移除 ${record.folders[index].path}。` : `将移除项目「${record.name}」（${record.id}）。`)
    out('文件夹中的文件不会被删除；用到它的已有会话不能继续。')
    if (!flags.has('--yes') && !(await ask!('确认移除？[y/N] '))) {
      out('已取消，没有改动。')
      return false
    }
    await refuseRunningHost(dataDir, PROJECT_REMOVE_RUNNING)
    const audit = await AuditLog.open(join(dataDir, 'audit'))
    try {
      const removed = folder ? record.folders[index] : undefined
      const pathHash = sha256Hex(removed ? removed.path : await realpath(record.path).catch(() => record.path))
      await audit
        .append(
          removed
            ? {
                action: 'workspace.folder-removed',
                actor: CLI_ACTOR,
                target: record.id,
                stepup: 'offline',
                detail: { workspaceId: record.id, folderId: removed.id, pathHash },
              }
            : {
                action: 'workspace.removed',
                actor: CLI_ACTOR,
                target: record.id,
                stepup: 'offline',
                detail: { workspaceId: record.id, pathHash },
              },
        )
        .catch(() => io.stderr.write('审计记录写入失败；移除只收回权限，照常进行。\n'))
      await config.updateSettings(
        draft => {
          if (!removed) {
            draft.workspaces = draft.workspaces.filter(item => item.id !== record.id)
            if (draft.defaults.workspaceId === record.id) delete draft.defaults.workspaceId
            return
          }
          const target = draft.workspaces.find(item => item.id === record.id)
          if (!target) throw new CliError(`找不到项目 ${record.id}`)
          target.folders = folders
          target.path = folders[0].path
        },
        async (next, commit) => {
          const before = sha256Hex(canonicalJson(config.settings()))
          const after = sha256Hex(canonicalJson(next))
          if (before !== after)
            await audit.append({ action: 'settings.changed', actor: CLI_ACTOR, detail: { before, after } }).catch(() => {})
          await commit()
        },
      )
    } finally {
      await audit.close()
    }
    out(folder ? '已移除这个文件夹。' : '已移除项目。')
    return true
  } finally {
    await lock.release()
  }
}

/** One line from a terminal without echo, or all of piped stdin. */
function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    return new Promise((done, fail) => {
      const chunks: Buffer[] = []
      stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stdin.once('end', () => done(Buffer.concat(chunks).toString('utf8')))
      stdin.once('error', fail)
    })
  }
  process.stderr.write(prompt)
  return new Promise((done, fail) => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = (error?: Error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stderr.write('\n')
      if (error) fail(error)
      else done(value)
    }
    const onData = (text: string) => {
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          finish()
          return
        }
        if (char === '\u0003') {
          finish(new CliError('已取消'))
          return
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

/** One visible line from the terminal; Ctrl+C cancels it. */
async function readLine(prompt: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  const controller = new AbortController()
  lines.once('SIGINT', () => {
    controller.abort()
  })
  try {
    return await lines.question(prompt, { signal: controller.signal })
  } catch {
    throw new CliError('已取消，没有修改任何设置')
  } finally {
    lines.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLatch(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    readSecret,
    confirm: async prompt => /^(y|yes)$/iu.test((await readLine(prompt)).trim()),
    readLine,
    env: process.env,
    cwd: process.cwd(),
  })
}
