import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import QRCode from 'qrcode'
import { AppError } from '../src/core/errors.ts'
import { AuditLog, verifyAuditFile, type AuditActor } from '../src/host/audit.ts'
import { createOfflineTicket } from '../src/host/auth.ts'
import { HostConfig, originOf } from '../src/host/config.ts'
import { sha256Hex } from '../src/host/crypto.ts'
import { acquireDataDirLock, processAlive, readHostState, readRecordedPid, unixRequest, verifyHostState, type DataDirLock, type HostInfo, type HostState } from '../src/host/host-state.ts'
import { loadOrCreateHostIdentity } from '../src/host/identity.ts'
import { latchCodeRoot, resolveLatchPaths } from '../src/host/paths.ts'
import { policySchema, PolicyStore, type Policy } from '../src/host/policy.ts'
import { buildPreview, createPresenceBackend, presenceHelperPath, PRESENCE_ACTIONS, type PresenceBackend } from '../src/host/presence.ts'
import { redactSecrets } from '../src/host/redact.ts'
import { LISTENER_LABELS, SCOPE_LABELS, type Device, type DeviceScope, type InvitationView } from '../src/shared/types.ts'

export interface CliIO {
  stdout: { write(text: string): unknown; isTTY?: boolean }
  stderr: { write(text: string): unknown }
  /** Reads one secret line: without echo on a terminal, else the whole of stdin. */
  readSecret(prompt: string): Promise<string>
  env: NodeJS.ProcessEnv
  cwd: string
}

class CliError extends Error {}

const run = promisify(execFile)
const CLI_ACTOR: AuditActor = { listener: 'cli', via: 'cli' }
const STATUS_LABELS: Record<Device['status'], string> = { active: '正常', review: '待复核（仅查看）', revoked: '已撤销', 'legacy-pending': '需重新确认' }
const SCOPES = new Set<string>(Object.keys(SCOPE_LABELS))
const RUNNING = 'Host 正在运行，请先停止（pnpm stop）'
const OFFLINE_WARNING = '离线登记依赖本机此刻没有恶意的同用户进程。只在无法使用本机确认时使用。'
const UNPINNED = '本机确认组件尚未登记。请先在这台电脑上打开一次 Latch，或停止 Host 后重试。'

const USAGE = `用法：pnpm latch <命令> [--data-dir <目录>]

  device list [--json]                     列出已登记的设备（Host 运行中）
  device revoke <设备 ID>                   撤销设备（Host 运行中）
  device invite [--scopes view,run,...] [--code-file <路径>]
                                           生成手机配对二维码（Host 运行中，需要 HTTPS 入口）
  device enroll --offline [--code-file <路径>] [--port <端口>]
                                           生成一次性离线登记码（Host 已停止）
  provider set-key <服务 ID>                从标准输入读取并保存模型服务密钥（Host 已停止）
  presence status                          查看本机确认是否可用
  presence repin                           重新登记本机确认组件的签名（Host 已停止）
  presence test                            显示一次示例本机确认（人工检查）
  audit verify                             校验审计记录
`

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const valued = new Set(['--data-dir', '--scopes', '--code-file', '--port'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    if (flags.has(name)) throw new CliError(`${name} 只能指定一次`)
    if (!valued.has(name)) { if (eq >= 0) throw new CliError(`${name} 不接受值`); flags.set(name, true); continue }
    const value = eq < 0 ? argv[++index] : arg.slice(eq + 1)
    if (!value || value.startsWith('--')) throw new CliError(`${name} 需要一个值`)
    flags.set(name, value)
  }
  return { positional, flags }
}

function connectable(socketPath: string): Promise<boolean> {
  return new Promise(done => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => { socket.destroy(); done(false) }, 1_000)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); done(true) })
    socket.once('error', () => { clearTimeout(timer); done(false) })
  })
}

async function runningHost(dataDir: string): Promise<{ state: HostState; info: HostInfo }> {
  const state = await readHostState(dataDir)
  const info = state && await verifyHostState(state)
  if (!state || !info) throw new CliError(`没有可确认的运行中 Host（${dataDir}）。请先启动 Host。`)
  return { state, info }
}

/**
 * A live process recorded in host.json, or anything answering on its socket, counts as a running Host. A host.json this
 * build cannot read proves nothing, so only a recorded pid that is gone lets the command go ahead.
 */
async function refuseRunningHost(dataDir: string): Promise<void> {
  const state = await readHostState(dataDir)
  if (state) {
    if (processAlive(state.pid) || await connectable(state.socketPath)) throw new CliError(RUNNING)
    return
  }
  const recorded = await readRecordedPid(dataDir)
  if (!recorded.present) return
  if (recorded.pid === undefined) throw new CliError(`无法识别 ${join(dataDir, 'host.json')}，不能确认 Host 已停止。确认没有 Host 在运行后删除该文件再重试。`)
  if (processAlive(recorded.pid)) throw new CliError(RUNNING)
}

/**
 * Offline commands hold the data-dir lock for their whole run, so no Host can start underneath them, and refuse while a
 * Host holds it (including before it has written host.json). A Host that runs without the lock is still found through
 * host.json: by its pid and socket, or, in the previous build's format, by the pid it records.
 */
async function lockStopped(dataDir: string): Promise<DataDirLock> {
  const lock = await acquireDataDirLock(dataDir, 'cli')
  try { await refuseRunningHost(dataDir) }
  catch (error) { await lock.release(); throw error }
  return lock
}

async function api(state: HostState, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await unixRequest(state.socketPath, `/link/api/${path}`, { method, ...(body === undefined ? {} : { body }), timeoutMs: 10_000 })
  if (response.status >= 200 && response.status < 300) return response.body
  const message = typeof response.body === 'object' && response.body !== null && 'message' in response.body ? String(response.body.message) : `HTTP ${response.status}`
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
  try { path = await realpath(shown) }
  catch { throw new CliError(`无法访问目录 ${shown}`) }
  const info = await lstat(path)
  if (!info.isDirectory()) throw new CliError(`${shown} 不是目录`)
  const sticky = (info.mode & 0o1000) !== 0
  const uid = process.getuid?.()
  if (uid !== undefined && info.uid !== uid && !(info.uid === 0 && sticky)) throw new CliError(`${shown} 不属于当前用户，请把文件写到你自己的目录`)
  if ((info.mode & 0o022) !== 0 && !sticky) throw new CliError(`${shown} 其他用户也能写入，请把文件写到只有你能写入的目录`)
  if (process.platform === 'darwin') {
    // Listed as '.', so the directory name cannot add lines of its own; every line after the first is an entry.
    const listing = await run('/bin/ls', ['-led', '.'], { cwd: path, env: {} }).catch(() => { throw new CliError(`无法读取 ${shown} 的访问控制列表`) })
    if (listing.stdout.split('\n').slice(1).some(line => line.trim())) {
      throw new CliError(`${shown} 带有访问控制列表（ACL），其他用户可能借此读取或替换文件。macOS 的个人文件夹默认带有这类设置；请把文件写到没有 ACL 的目录，例如用 mktemp -d 新建的目录`)
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
  try { handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if (codeOf(error) === 'EEXIST' || codeOf(error) === 'ELOOP') throw new CliError(`${path} 已存在。为避免覆盖其他文件，请先删除它或换一个新路径`)
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
    if (!after || after.dev !== directory.dev || after.ino !== directory.ino || !await samePath(target, handle)) throw new CliError(`${path} 在写入前被替换，已停止`)
    await handle.chmod(0o600)
  } catch (error) { await discard(); throw error }
  return {
    discard,
    async write(text) {
      try {
        if (!await samePath(target, handle)) throw new CliError(`${path} 在写入前被替换，已停止`)
        await handle.writeFile(text + '\n')
        await handle.sync()
      } catch (error) { await discard(); throw error }
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
  try { policy = policySchema.parse(JSON.parse(await readFile(join(dataDir, 'policy.json'), 'utf8'))) }
  catch { throw new CliError('无法读取安全策略文件 policy.json') }
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
    hostId: await hostId(), action: 'device.enroll', now: Date.now(),
    requester: { deviceName: '示例设备', listener: 'cli', remoteAddress: '命令行' },
    lines: [{ label: '设备名称', value: '示例设备（presence test，不会登记）' }], warnings: ['这是一次人工检查，确认或拒绝都不会改变任何设置。'],
  })
  const outcome = await backend.confirm({ preview, previewHash, hashDisplay, requireBiometric: PRESENCE_ACTIONS['device.enroll'].requireBiometric, signal: AbortSignal.timeout(60_000) })
  out(`结果：${outcome.result}${'method' in outcome ? `（${outcome.method}）` : ''}`)
}

function scopesFlag(value: string | true | undefined): DeviceScope[] | undefined {
  if (value === undefined) return undefined
  if (value === true) throw new CliError('--scopes 需要一个值')
  const scopes = value.split(',').map(item => item.trim()).filter(Boolean)
  for (const scope of scopes) if (!SCOPES.has(scope)) throw new CliError(`未知的权限：${scope}`)
  return scopes as DeviceScope[]
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => [...row[column]!].reduce((width, char) => width + (char.charCodeAt(0) > 0x2e7f ? 2 : 1), 0))))
  return rows.map(row => row.map((cell, column) => {
    const width = [...cell].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e7f ? 2 : 1), 0)
    return cell + ' '.repeat(Math.max(0, widths[column]! - width))
  }).join('  ').trimEnd()).join('\n') + '\n'
}

async function cdhashOf(path: string): Promise<string> {
  try { await run('/usr/bin/codesign', ['--verify', '--strict', path], { env: {} }) }
  catch { throw new CliError('latch-presence 签名无效，请重新运行 pnpm build:presence') }
  const { stderr } = await run('/usr/bin/codesign', ['-dvvv', path], { env: {} }).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? '' }))
  const match = /^CDHash=([0-9a-f]{40})$/mu.exec(stderr)
  if (!match) throw new CliError('无法读取 latch-presence 的 CDHash')
  return match[1]!
}

export async function runLatch(argv: string[], io: CliIO): Promise<number> {
  const out = (text: string) => { io.stdout.write(text.endsWith('\n') ? text : text + '\n') }
  try {
    const { positional, flags } = parseArgs(argv)
    const [group, command, ...rest] = positional
    if (!group || flags.has('--help')) { out(USAGE); return group ? 0 : 1 }
    const dataDirFlag = flags.get('--data-dir')
    const { dataDir } = resolveLatchPaths({ dataDir: typeof dataDirFlag === 'string' ? dataDirFlag : undefined, env: io.env, cwd: io.cwd })
    const key = `${group} ${command ?? ''}`

    if (key === 'device list') {
      const { state } = await runningHost(dataDir)
      const { devices } = await api(state, 'GET', 'devices') as { devices: Device[] }
      if (flags.has('--json')) { out(JSON.stringify(devices, null, 2)); return 0 }
      out(table([
        ['ID', '名称', '连接方式', '权限', '状态', '最近使用'],
        ...devices.map(device => [device.id, device.name, LISTENER_LABELS[device.listener], device.scopes.map(scope => SCOPE_LABELS[scope]).join('、') || '—', STATUS_LABELS[device.status], device.lastSeenAt.replace('T', ' ').slice(0, 16)]),
      ]))
      return 0
    }
    if (key === 'device revoke') {
      const id = rest[0]
      if (!id) throw new CliError('请提供设备 ID')
      const { state } = await runningHost(dataDir)
      const result = await api(state, 'DELETE', `devices/${encodeURIComponent(id)}`) as { cascaded?: number }
      out(`已撤销 ${id}。${result.cascaded ? `${result.cascaded} 台由它邀请配对的设备已降为仅查看，等待复核。` : ''}`)
      return 0
    }
    if (key === 'device invite') {
      const codeFile = flags.get('--code-file')
      if (!io.stdout.isTTY && typeof codeFile !== 'string') throw new CliError('配对链接只输出到终端；非交互环境请使用 --code-file <路径>')
      const scopes = scopesFlag(flags.get('--scopes'))
      const { state } = await runningHost(dataDir)
      const codePath = typeof codeFile === 'string' ? resolve(io.cwd, codeFile) : undefined
      const file = codePath ? await createSecretFile(codePath) : undefined
      let invitation: InvitationView
      try { ({ invitation } = await api(state, 'POST', 'pairings', scopes ? { scopes } : {}) as { invitation: InvitationView }) }
      catch (error) { await file?.discard(); throw error }
      const expires = new Date(invitation.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })
      if (file) {
        await file.write(invitation.url)
        out(`配对链接已写入 ${codePath}（0600），${expires} 前有效，只能使用一次。`)
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
      if (!io.stdout.isTTY && typeof codeFile !== 'string') throw new CliError('离线登记码只输出到终端；非交互环境请使用 --code-file <路径>')
      const port = Number(flags.get('--port') ?? io.env.HARNESS_PORT ?? '4317')
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError('端口无效')
      const codePath = typeof codeFile === 'string' ? resolve(io.cwd, codeFile) : undefined
      const lock = await lockStopped(dataDir)
      let file: SecretFile | undefined
      try {
        file = codePath ? await createSecretFile(codePath) : undefined
        io.stderr.write(`${OFFLINE_WARNING}\n`)
        const audit = await AuditLog.open(join(dataDir, 'audit'))
        try {
          const identity = await loadOrCreateHostIdentity(dataDir)
          const ticket = await createOfflineTicket(join(dataDir, 'auth'))
          await audit.append({ action: 'offline.ticket.created', actor: CLI_ACTOR, target: ticket.ticketId, stepup: 'offline', detail: { ticketId: ticket.ticketId } })
          const expires = new Date(ticket.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })
          if (file) {
            await file.write(ticket.code)
            out(`离线登记码已写入 ${codePath}（0600），${expires} 前有效，只能使用一次。`)
          } else {
            out(`离线登记码：${ticket.code}`)
            out(`${expires} 前有效，只能使用一次。`)
          }
          out(`启动 Host 后打开 http://h-${identity.hostId}.localhost:${port}/link/ ，在登记页面填写离线登记码。`)
        } finally { await audit.close() }
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
        const record = (await HostConfig.open(dataDir)).provider(providerId)
        if (!record) throw new CliError(`找不到模型服务 ${providerId}`)
        const origin = originOf(record.baseURL)
        const apiKey = (await io.readSecret(`${record.name} 的 API Key（只发往 ${origin}）：`)).replace(/\r?\n$/u, '')
        if (!apiKey) throw new CliError('没有读取到密钥')
        if (/[\u0000-\u001f\u007f]/u.test(apiKey) || apiKey.length > 8192) throw new CliError('API Key 不能包含换行或控制字符，且不超过 8192 个字符')
        // A Host that runs without the lock may have started during the prompt; the key stays bound to the origin shown.
        await refuseRunningHost(dataDir)
        const config = await HostConfig.open(dataDir)
        const current = config.provider(providerId)
        if (!current || originOf(current.baseURL) !== origin) throw new CliError(`模型服务 ${providerId} 在输入密钥期间被修改，未保存密钥，请重新运行`)
        const audit = await AuditLog.open(join(dataDir, 'audit'))
        try {
          const { seq } = await audit.append({ action: 'provider.secret.set', actor: CLI_ACTOR, target: providerId, stepup: 'offline', detail: { providerId, originHash: sha256Hex(origin) } })
          try {
            await config.updateProviders(draft => {
              const target = draft.find(item => item.id === providerId)
              if (!target) throw new CliError(`找不到模型服务 ${providerId}`)
              target.apiKey = apiKey
              target.keyOrigin = origin
            })
          } catch (error) {
            await audit.append({ action: 'action.failed', actor: CLI_ACTOR, detail: { refSeq: seq } }).catch(() => {})
            throw error
          }
        } finally { await audit.close() }
        out(`已为 ${providerId} 保存密钥，只发往 ${origin}。`)
      } finally { await lock.release() }
      return 0
    }
    if (key === 'presence status') {
      const state = await readHostState(dataDir)
      const info = state && await verifyHostState(state)
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
            presence = availability.status === 'available' ? { status: 'available' } : { status: 'unavailable', message: availability.message }
          } finally { await audit.close() }
        } finally { await lock.release() }
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
        } finally { await audit.close() }
        out(`已登记 latch-presence cdhash ${cdhash}`)
      } finally { await lock.release() }
      return 0
    }
    if (key === 'presence test') {
      const state = await readHostState(dataDir)
      const info = state && await verifyHostState(state)
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
        } finally { await audit.close() }
      } finally { await lock.release() }
      return 0
    }
    if (key === 'audit verify') {
      const path = join(dataDir, 'audit', 'audit.jsonl')
      const result = await verifyAuditFile(path).catch(error => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new CliError(`找不到审计记录 ${path}`)
        throw error
      })
      if (result.ok) { out(`审计记录完整：共 ${result.records} 条，最新 #${result.head.seq} ${result.head.hash}`); return 0 }
      io.stderr.write(`审计记录在第 ${result.line} 行校验失败（${result.reason}）。\n`)
      return 1
    }
    out(USAGE)
    return 1
  } catch (error) {
    const message = error instanceof CliError || error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error)
    io.stderr.write(`${redactSecrets(message)}\n`)
    return 1
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
      if (error) fail(error); else done(value)
    }
    const onData = (text: string) => {
      for (const char of text) {
        if (char === '\r' || char === '\n') { finish(); return }
        if (char === '\u0003') { finish(new CliError('已取消')); return }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLatch(process.argv.slice(2), {
    stdout: process.stdout, stderr: process.stderr, readSecret, env: process.env, cwd: process.cwd(),
  })
}

