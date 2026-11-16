import { existsSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessPlugin } from '@latch/sdk'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { loadLoginShell, personCommandDirectories, personPathDirectories, resolveCommand } from '@latch/harness-acp'
import { detectPresetCommands, LATCH_VERSION, startServer, type TlsListenerOptions } from '../src/server.ts'
import {
  acquireDataDirLock,
  processAlive,
  readHostState,
  readRecordedPid,
  removeHostState,
  verifyHostState,
  writeHostState,
} from '../src/host-state.ts'
import { latchEnv } from '../src/env.ts'
import { COMPUTER_APP } from '../src/mcp-computer.ts'
import { openInDeviceHub, xcrunSimctl } from '../src/simulators.ts'
import { latchCodeRoot, resolveLatchPaths } from '../src/paths.ts'
import { presenceHelperPath } from '../src/presence.ts'
import { buildPresenceHelper } from './presence-helper.ts'
import { loadPluginPackage } from '../src/plugin-packages.ts'
import { createShutdown } from './shutdown.ts'
import { cleanupPluginGenerations } from './cleanup-plugin-generations.ts'
import { readCodeBuild } from '../src/ui-build.ts'

const PLAINTEXT_REMOVED = '明文局域网接入已移除：请提供 --tls-cert、--tls-key 和 --public-origin（例如用 tailscale cert 生成的证书）。'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

class StartupError extends Error {}

// Taken as the process starts, from the files it loaded: a rebuild later changes what is on disk, not this.
const codeBuild = readCodeBuild(fileURLToPath(import.meta.url), resolve(latchCodeRoot(), 'dist/web'))
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
  return Object.values(networkInterfaces())
    .flat()
    .flatMap(entry => (entry && !entry.internal ? [entry.address] : []))
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

/** `host:port` with an explicit port, for the process-local egress allowlist. */
function egressEntry(baseURL: string): string | undefined {
  try {
    const url = new URL(baseURL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return undefined
  }
}

/** The helper is pointless when the policy turned local confirmation off. */
function presenceDisabled(dataDir: string): boolean {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'policy.json'), 'utf8'))?.presence?.backend === 'none'
  } catch {
    return false
  }
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
  try {
    canonical = family === 0 ? undefined : new URL(`http://${family === 6 ? `[${literal}]` : literal}/`).hostname
  } catch {
    canonical = undefined
  }
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
  const certPath = option('--tls-cert') ?? latchEnv(env, 'TLS_CERT')
  const keyPath = option('--tls-key') ?? latchEnv(env, 'TLS_KEY')
  const publicOrigin = option('--public-origin') ?? latchEnv(env, 'PUBLIC_ORIGIN')
  const legacyHost = option('--host')
  const lan = argv.includes('--lan')
  const tailnet = argv.includes('--tailnet')
  let host = option('--tls-host') ?? latchEnv(env, 'TLS_HOST')
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
  const port = Number(option('--tls-port') ?? latchEnv(env, 'TLS_PORT') ?? '4318')
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
    if (await verifyHostState(state))
      throw new StartupError(`这个数据目录已有 Host 在运行（进程 ${state.pid}）。请先停止它（pnpm stop），或使用其他 --data-dir。`)
    return
  }
  const recorded = await readRecordedPid(dataDir)
  if (!recorded.present) return
  if (recorded.pid === undefined)
    throw new StartupError(`无法识别 ${path}，不能确认没有其他 Host 在运行。确认没有 Host 在运行后删除该文件再重试。`)
  if (processAlive(recorded.pid)) {
    throw new StartupError(
      `${path} 记录的进程 ${recorded.pid} 仍在运行，可能是旧版本的 Host。请先在它的终端中停止它（Ctrl+C），或使用其他 --data-dir；如果确认没有 Host 在运行，删除该文件后重试。`,
    )
  }
}

async function main(): Promise<void> {
  const paths = resolveLatchPaths({ dataDir: option('--data-dir'), workspace: option('--workspace'), env, cwd: process.cwd() })
  const tls = tlsOptions()
  const nativeHost = option('--native-host'),
    nativePortText = option('--native-port')
  if (nativePortText !== undefined && nativeHost === undefined) throw new StartupError('--native-port 需要 --native-host')
  const nativePort = Number(nativePortText ?? '4319')
  if (!Number.isInteger(nativePort) || nativePort < 0 || nativePort > 65535) throw new StartupError('原生连接端口无效')
  const native = nativeHost === undefined ? undefined : { host: bindAddress(nativeHost), port: nativePort }
  const port = Number(option('--port') ?? latchEnv(env, 'PORT') ?? '4317')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StartupError('端口无效')
  // Held from before the first read of the data dir until exit, so offline CLI commands and a second start see this
  // Host even while startServer runs and host.json does not exist yet.
  const lock = await acquireDataDirLock(paths.dataDir, 'host')
  process.on('exit', () => lock.releaseSync())
  await refuseHostWithoutLock(paths.dataDir)
  await cleanupPluginGenerations(paths.dataDir)
  const plugins: HarnessPlugin[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--plugin') continue
    const path = argv[++index]
    if (!path || path.startsWith('--')) throw new StartupError('--plugin 需要本地插件包目录或模块路径')
    plugins.push(await loadPluginPackage(path))
  }
  const codeRoot = latchCodeRoot()
  if (process.platform === 'darwin' && !existsSync(presenceHelperPath(codeRoot)) && !presenceDisabled(paths.dataDir)) {
    const built = await buildPresenceHelper({ codeRoot, log: (text: string) => console.error(redactKnownSecrets(text)) })
    if (!built.built) console.error(redactKnownSecrets(built.message))
  }
  const egressAllow: string[] = []
  const baseURL = latchEnv(env, 'BASE_URL')
  const baseEntry = baseURL ? egressEntry(baseURL) : undefined
  if (baseEntry) {
    egressAllow.push(baseEntry)
    console.error(`[Latch] 已允许 Host 访问 LATCH_BASE_URL 指定的 ${baseEntry}`)
  }
  // A start directory the Host chose gets a folder per Agent session; one the owner named is used as it is.
  const sessionFolders = paths.workspaceSource === 'default' || paths.workspaceSource === 'legacy-data'
  const demo = argv.includes('--demo')
  const providerId = option('--provider')
  const harnessId = option('--harness')
  const model = latchEnv(env, 'MODEL')
  // Before the Host listens, because a launch fingerprint holds the path found through it.
  await loadLoginShell()
  const build = await codeBuild
  const server = await startServer({
    dataDir: paths.dataDir,
    workspaceRoot: paths.workspaceRoot,
    sessionFolders,
    detectPreset: detectPresetCommands,
    loginPrograms: resolveCommand,
    // DeepSeek Harness's DeepSeek balance, read with its own key from this home (cli-quota.ts).
    cliQuota: { home: homedir() },
    cliUsage: { home: homedir() },
    // 「操控这台 Mac」 looks for Cua Driver at its one place, on macOS only.
    ...(process.platform === 'darwin'
      ? { computerDriver: { app: COMPUTER_APP }, simulators: { run: xcrunSimctl, openHub: openInDeviceHub }, xcodeBridge: {} }
      : {}),
    commandDirectories: personCommandDirectories,
    pathDirectories: personPathDirectories,
    agentsDir: paths.agentsDir,
    uiDir: resolve(codeRoot, 'dist/web'),
    ...(build ? { codeBuild: build } : {}),
    port,
    demo,
    plugins,
    egressAllow,
    ...(tls ? { tls } : {}),
    ...(native ? { native } : {}),
    ...(providerId ? { providerId } : {}),
    ...(harnessId ? { harnessId } : {}),
    // The key from the environment is used in memory only; it never reaches the disk.
    ...(model
      ? {
          provider: {
            baseURL: baseURL ?? 'https://api.openai.com/v1',
            apiKey: latchEnv(env, 'API_KEY') ?? '',
            model,
          },
        }
      : {}),
  })
  const stop = createShutdown(async () => {
    try {
      await server.close()
    } finally {
      await removeHostState(paths.dataDir, server.instanceId)
      await lock.release()
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stop().then(
        () => process.exit(0),
        error => {
          console.error(redactKnownSecrets(String(error)))
          process.exit(1)
        },
      )
    })
  }
  await writeHostState(paths.dataDir, {
    version: 2,
    pid: process.pid,
    hostId: server.hostId,
    instanceId: server.instanceId,
    socketPath: server.socketPath,
    loopbackOrigin: server.loopbackOrigin,
    tlsOrigin: server.tlsOrigin ?? null,
    startedAt: server.startedAt,
    dataDir: paths.dataDir,
  })
  console.log(`Latch ${LATCH_VERSION} · ${demo ? '演示模型 / 真实工具' : '模型服务'}`)
  // Loopback enrollment takes an invitation: the desktop app opens one, or the CLI prints one to a terminal.
  console.log(
    `浏览器：${server.loopbackOrigin}/link/（新浏览器从 Latch 桌面端「在这台电脑的浏览器中打开」，或运行 pnpm latch device invite --loopback）`,
  )
  console.log(`默认文件夹：${paths.workspaceRoot}`)
  if (sessionFolders) console.log('不在项目中的 Agent 会话各自使用默认文件夹中新建的一个文件夹。')
  console.log(
    server.tlsOrigin
      ? `手机接入：${server.tlsOrigin}/link/（在电脑上的 Latch 桌面端生成配对二维码）`
      : '手机接入需要 HTTPS：用 --tls-cert、--tls-key 和 --public-origin 启动。',
  )
  for (const warning of paths.warnings) console.log(warning)
}

try {
  await main()
} catch (error) {
  console.error(redactKnownSecrets(error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
