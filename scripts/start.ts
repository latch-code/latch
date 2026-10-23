import { existsSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LATCH_VERSION, startServer, type TlsListenerOptions } from '../src/host/server.ts'
import { acquireDataDirLock, processAlive, readHostState, readRecordedPid, removeHostState, verifyHostState, writeHostState } from '../src/host/host-state.ts'
import { latchCodeRoot, resolveLatchPaths } from '../src/host/paths.ts'
import { presenceHelperPath } from '../src/host/presence.ts'
import { redactSecrets } from '../src/host/redact.ts'
import type { HarnessPlugin } from '../src/core/plugins.ts'
import { buildPresenceHelper } from './build-presence.ts'
import { createShutdown } from './shutdown.ts'

const PLAINTEXT_REMOVED = '明文局域网接入已移除：请提供 --tls-cert、--tls-key 和 --public-origin（例如用 tailscale cert 生成的证书）。'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

class StartupError extends Error {}

const argv = process.argv.slice(2)
const env = process.env

/** `--name value` or `--name=value`; a flag given twice is refused rather than guessed. */
function option(name: string): string | undefined {
  let found: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    let value: string | undefined
    if (arg === name) {
      value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new StartupError(`${name} 需要一个值`)
      index++
    } else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1)
    else continue
    if (found !== undefined) throw new StartupError(`${name} 只能指定一次`)
    found = value
  }
  return found
}

function addresses(): string[] {
  return Object.values(networkInterfaces()).flat().flatMap(entry => entry && !entry.internal ? [entry.address] : [])
}

function firstPrivateIPv4(): string {
  const found = addresses().find(address => isIP(address) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(address))
  if (!found) throw new StartupError('未发现局域网 IPv4 地址，请用 --tls-host 指定 HTTPS 监听地址')
  return found
}

function firstTailnetAddress(): string {
  const found = addresses().find(address => {
    const [a, b] = address.split('.').map(Number)
    return isIP(address) === 4 && a === 100 && b !== undefined && b >= 64 && b <= 127
  })
  if (!found) throw new StartupError('未发现 Tailscale 地址（100.64.0.0/10），请确认 Tailscale 已连接，或用 --tls-host 指定')
  return found
}

function isPlugin(value: unknown): value is HarnessPlugin {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string' && 'version' in value && typeof value.version === 'string'
    && 'description' in value && typeof value.description === 'string' && 'activate' in value && typeof value.activate === 'function'
}

/** `host:port` with an explicit port, for the process-local egress allowlist. */
function egressEntry(baseURL: string): string | undefined {
  try {
    const url = new URL(baseURL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch { return undefined }
}

/** The helper is pointless when the policy turned local confirmation off. */
function presenceDisabled(dataDir: string): boolean {
  try { return JSON.parse(readFileSync(join(dataDir, 'policy.json'), 'utf8'))?.presence?.backend === 'none' }
  catch { return false }
}

const ALL_INTERFACES = new Set(['0.0.0.0', '[::]'])

/**
 * The exact address handed to listen(): an IP literal without brackets, IPv6 in canonical form and an IPv4-mapped
 * address as plain IPv4, so the listener class sees the address it is ('::ffff:100.64.0.1' is a Tailscale address).
 * Host names and every spelling of "all interfaces" ('[::]', '::0', '0', '::ffff:0.0.0.0', …) are refused.
 */
function bindAddress(value: string): string {
  const literal = value.replace(/^\[|\]$/gu, '')
  const family = isIP(literal)
  let canonical: string | undefined
  try { canonical = family === 0 ? undefined : new URL(`http://${family === 6 ? `[${literal}]` : literal}/`).hostname }
  catch { canonical = undefined }
  if (canonical === undefined) {
    if (literal === '0' || /^[0.]+$/u.test(literal)) throw new StartupError('请使用具体网卡地址，不要绑定所有接口')
    throw new StartupError('HTTPS 监听地址必须是本机网卡的 IP 地址，不能是主机名')
  }
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/u.exec(canonical)
  if (mapped) {
    const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)]
    canonical = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  }
  if (ALL_INTERFACES.has(canonical)) throw new StartupError('请使用具体网卡地址，不要绑定所有接口')
  return canonical.replace(/^\[|\]$/gu, '')
}

function tlsOptions(): TlsListenerOptions | undefined {
  const certPath = option('--tls-cert') ?? env.HARNESS_TLS_CERT
  const keyPath = option('--tls-key') ?? env.HARNESS_TLS_KEY
  const publicOrigin = option('--public-origin') ?? env.HARNESS_PUBLIC_ORIGIN
  const legacyHost = option('--host')
  const lan = argv.includes('--lan')
  const tailnet = argv.includes('--tailnet')
  let host = option('--tls-host') ?? env.HARNESS_TLS_HOST
  const remote = lan || tailnet || host !== undefined || (legacyHost !== undefined && !LOOPBACK.has(legacyHost))
  const material = [certPath, keyPath, publicOrigin].filter(Boolean).length
  if (!remote && material === 0) return undefined
  if (material !== 3) throw new StartupError(PLAINTEXT_REMOVED)
  if (lan) host = firstPrivateIPv4()
  if (tailnet) host = firstTailnetAddress()
  if (legacyHost !== undefined && !LOOPBACK.has(legacyHost)) host ??= legacyHost
  if (host === undefined) {
    const originHost = new URL(publicOrigin!).hostname.replace(/^\[|\]$/gu, '')
    if (!isIP(originHost)) throw new StartupError('请用 --tls-host、--lan 或 --tailnet 指定 HTTPS 监听地址')
    host = originHost
  }
  const port = Number(option('--tls-port') ?? env.HARNESS_TLS_PORT ?? '4318')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StartupError('HTTPS 端口无效')
  return { host: bindAddress(host), port, certPath: resolve(certPath!), keyPath: resolve(keyPath!), publicOrigin: publicOrigin! }
}

/**
 * A Host can run here without holding the lock: one from the previous build, which takes none and writes a host.json
 * this build cannot parse, so the pid it records decides (as for latch and stop); or one whose lock was removed by
 * hand, found through host.json and host.sock.
 */
async function refuseHostWithoutLock(dataDir: string): Promise<void> {
  const path = join(dataDir, 'host.json')
  const state = await readHostState(dataDir)
  if (state) {
    if (await verifyHostState(state)) throw new StartupError(`这个数据目录已有 Host 在运行（进程 ${state.pid}）。请先停止它（pnpm stop），或使用其他 --data-dir。`)
    return
  }
  const recorded = await readRecordedPid(dataDir)
  if (!recorded.present) return
  if (recorded.pid === undefined) throw new StartupError(`无法识别 ${path}，不能确认没有其他 Host 在运行。确认没有 Host 在运行后删除该文件再重试。`)
  if (processAlive(recorded.pid)) {
    throw new StartupError(`${path} 记录的进程 ${recorded.pid} 仍在运行，可能是旧版本的 Host。请先在它的终端中停止它（Ctrl+C），或使用其他 --data-dir；如果确认没有 Host 在运行，删除该文件后重试。`)
  }
}

async function main(): Promise<void> {
  const paths = resolveLatchPaths({ dataDir: option('--data-dir'), workspace: option('--workspace'), env, cwd: process.cwd() })
  const tls = tlsOptions()
  const port = Number(option('--port') ?? env.HARNESS_PORT ?? '4317')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StartupError('端口无效')
  // Held from before the first read of the data dir until exit, so offline CLI commands and a second start see this
  // Host even while startServer runs and host.json does not exist yet.
  const lock = await acquireDataDirLock(paths.dataDir, 'host')
  process.on('exit', () => lock.releaseSync())
  await refuseHostWithoutLock(paths.dataDir)
  const plugins: HarnessPlugin[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--plugin') continue
    const path = argv[++index]
    if (!path || path.startsWith('--')) throw new StartupError('--plugin 需要本地模块路径')
    const module: { default?: unknown } = await import(pathToFileURL(resolve(path)).href)
    if (!isPlugin(module.default)) throw new StartupError(`插件模块无效：${path}`)
    plugins.push(module.default)
  }
  const codeRoot = latchCodeRoot()
  if (process.platform === 'darwin' && !existsSync(presenceHelperPath(codeRoot)) && !presenceDisabled(paths.dataDir)) {
    const built = await buildPresenceHelper({ codeRoot, log: (text: string) => console.error(redactSecrets(text)) })
    if (!built.built) console.error(redactSecrets(built.message))
  }
  const egressAllow: string[] = []
  const baseEntry = env.HARNESS_BASE_URL ? egressEntry(env.HARNESS_BASE_URL) : undefined
  if (baseEntry) {
    egressAllow.push(baseEntry)
    console.error(`[Latch] 已允许 Host 访问 HARNESS_BASE_URL 指定的 ${baseEntry}`)
  }
  const demo = argv.includes('--demo')
  const providerId = option('--provider')
  const harnessId = option('--harness')
  const server = await startServer({
    dataDir: paths.dataDir, workspaceRoot: paths.workspaceRoot, agentsDir: paths.agentsDir, uiDir: resolve(codeRoot, 'dist/web'),
    port, demo, plugins, egressAllow, ...(tls ? { tls } : {}),
    ...(providerId ? { providerId } : {}), ...(harnessId ? { harnessId } : {}),
    // The key from the environment is used in memory only; it never reaches the disk.
    ...(env.HARNESS_MODEL ? { provider: {
      baseURL: env.HARNESS_BASE_URL ?? 'https://api.openai.com/v1', apiKey: env.HARNESS_API_KEY ?? '', model: env.HARNESS_MODEL,
    } } : {}),
  })
  const stop = createShutdown(async () => {
    try { await server.close() }
    finally {
      await removeHostState(paths.dataDir, server.instanceId)
      await lock.release()
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void stop().then(() => process.exit(0), error => { console.error(redactSecrets(String(error))); process.exit(1) }) })
  }
  await writeHostState(paths.dataDir, {
    version: 2, pid: process.pid, hostId: server.hostId, instanceId: server.instanceId, socketPath: server.socketPath,
    loopbackOrigin: server.loopbackOrigin, tlsOrigin: server.tlsOrigin ?? null, startedAt: server.startedAt, dataDir: paths.dataDir,
  })
  console.log(`Latch ${LATCH_VERSION} · ${demo ? '演示模型 / 真实工具' : '通用模型接口'}`)
  console.log(`打开 ${server.loopbackOrigin}/link/ ，请在本机确认。`)
  console.log(`工作区：${paths.workspaceRoot}`)
  console.log(server.tlsOrigin
    ? `手机接入：${server.tlsOrigin}/link/（在电脑上的 Latch 桌面端生成配对二维码）`
    : '手机接入需要 HTTPS：用 --tls-cert、--tls-key 和 --public-origin 启动。')
  for (const warning of paths.warnings) console.log(warning)
}

try { await main() }
catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
