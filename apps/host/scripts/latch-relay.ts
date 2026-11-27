import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { EDGE_RELAY_AVAILABLE, isRelayLocation, RELAY_LOCATIONS } from '@latch/link-wire'
import { chooseRelayFile, RELAY_NAME, RelayFilesError } from '@latch/link-client/relay-files'
import type { NativeRelayTest } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { AuditLog, type AuditActor } from '../src/audit.ts'
import {
  bookRelays,
  relayAddressValid,
  relayAvailable,
  relayKeyHash,
  relayNodeFields,
  RelayProfiles,
  type RelayProfileInput,
} from '../src/relay/profiles.ts'
import { loadRelayFile } from '../src/relay/relay-files.ts'

export const RELAY_USAGE = `  relay list [--json]                      列出自己的中继与状态（Host 已停止）
  relay add [--name <名称> | --file <中继文件>] [--expect-key <密钥短哈希>]
                                           添加自己的中继（Host 已停止）；不给文件时用 ~/.latch/relays 里唯一的中继文件，
                                           --name 选其中的 <名称>.json。先列出地址与密钥短哈希，再输入 y 确认；
                                           非交互环境用 --expect-key。Host 启动后核对密钥并登记成功，才签发含该中继的连接簿；
                                           文件里的注册令牌只交给 Host，不显示
  relay test <节点标识>                      测试中继的连接、密钥、登记，显示 Host 签发状态（Host 运行中）
  relay remove <节点标识>                    移除自己的中继（Host 已停止）
  relay setup cloudflare --name <名称> [--location <位置>] [--out <绝对路径>]
                                           在你自己的 Cloudflare 账户部署一个中继并验收（需要已登录的 wrangler）；
                                           写出 ~/.latch/relays/<名称>.json，不打印任何秘密。位置不给时由 Cloudflare 就近放置。
                                           安装版尚未附带 Workers 部署包：尚未实现，在 Latch 源码目录运行
  relay setup linux --server <user@host> [--domain <域名> | --ip <公网IP>] [--name <名称>] [--port <端口>]
                    [--behind-proxy [--public-port <端口>] | --cert <证书路径> --key <私钥路径> | --acme-email <邮箱>]
                    [--ssh-port <SSH端口>] [--bundle <本地Linux包>] [--out <绝对路径>] [--skip-accept] [--upgrade]
                                           从这台电脑经 SSH 一键把自包含中继部署到你的 Linux 服务器（无需域名，也无需服务器拉源码）：
                                           不传 --domain 时默认直接按服务器公网 IP（优先 443，占用时自动回退 8443）生成公钥绑定证书并自动续期；
                                           传入 --domain 时默认自动申请 443 证书（或加 --behind-proxy 复用已有 Caddy/Nginx）；
                                           运行端到端验收后写出 ~/.latch/relays/<名称>.json（加 --upgrade 可平滑升级不换密钥）
  relay status linux --server <user@host> [--ssh-port <SSH端口>]
                                           查看远端 Linux 中继服务的运行状态、活跃路由数、证书剩余天数与月度流量
  relay uninstall linux --server <user@host> [--ssh-port <SSH端口>] [--purge-data]
                                           停止并卸载远端 Linux 中继系统服务（默认保留 /srv/latch-relay 密钥数据）
`
type Out = (text: string) => void
interface RelayCliIO {
  cwd: string
  stdin: { isTTY?: boolean }
  stderr: { write(text: string): unknown }
  readLine(prompt: string): Promise<string>
  runEntry?(file: string, args: string[]): Promise<number>
}

/** The setup entry as a child with this process's hardening flags and terminal: wrangler's progress shows as it runs. */
function runEntry(file: string, args: string[], cwd: string): Promise<number> {
  return new Promise(done => {
    const child = spawn(process.execPath, ['--disable-sigusr1', '--import', 'tsx', file, ...args], { cwd, stdio: 'inherit' })
    child.once('error', () => done(1))
    child.once('exit', code => done(code ?? 1))
  })
}
export class RelayCliError extends Error {}

/** A relay file as the self-hosted relay CLI (version 1) or apps/relay-edge (version 2, edge) writes it. */
export async function readRelayFile(path: string): Promise<RelayProfileInput> {
  const read = await loadRelayFile(path)
  if ('profile' in read) return read.profile
  throw new RelayCliError(
    read.failure === 'unreadable'
      ? '读不到这个中继文件'
      : read.failure === 'version'
        ? '不认识这个中继文件的版本'
        : '这个文件不是中继导出的连接配置',
  )
}
/** What the person checks before adding: every address and the key the node must prove. Never the registration key. */
export function relayFacts(input: RelayProfileInput): string[] {
  const node = relayNodeFields(input)
  return [
    `类型：${'kind' in node ? 'Workers（edge，中继自己的密钥签名）' : '自建服务器（固定证书公钥）'}`,
    `节点标识：${node.relayId}`,
    ...[node.url, ...('extraUrls' in node ? (node.extraUrls ?? []) : [])].map(url => `地址：${url}`),
    'relayKey' in node ? `中继公钥：${node.relayKey}` : `证书公钥 SHA-256：${node.spkiHash}`,
    `密钥短哈希：${relayKeyHash(node)}`,
    `注册令牌：${input.registrationKey ? '有（只交给 Host）' : '无（开放登记的中继）'}`,
  ]
}

/**
 * `latch relay …` or `pnpm latch relay …`. Testing uses the running Host. Listing and editing use the data directory lock while the Host
 * is stopped. Changes are audited like the same change in settings and take effect when the Host starts. An added
 * relay is checked against the node then (its state shows in settings and in `relay list`).
 */
export async function runRelayCommand(input: {
  command: string | undefined
  rest: string[]
  flags: Map<string, string | true>
  dataDir: string
  io: RelayCliIO
  out: Out
  actor: AuditActor
  stopped(): Promise<{ release(): Promise<void> }>
  /** The running Host's API through host.sock. */
  running(method: string, path: string): Promise<unknown>
  /** Where ~/.latch/relays is looked up; `os.homedir()` when absent. */
  home?: string
  /** The Latch code root, where a source checkout keeps the Workers deploy entry. */
  codeRoot?: string
  program?: 'latch' | 'pnpm latch'
}): Promise<number | undefined> {
  const { command, rest, flags, dataDir, io, out } = input
  if (command === 'setup') {
    if (rest[0] === 'cloudflare') {
      if (!EDGE_RELAY_AVAILABLE) throw new RelayCliError('这个版本关闭了 Cloudflare Workers 中继。')
      const name = flags.get('--name'),
        location = flags.get('--location'),
        target = flags.get('--out')
      if (typeof name !== 'string' || !RELAY_NAME.test(name) || name.length > 40)
        throw new RelayCliError('用法：relay setup cloudflare --name <名称> [--location <位置>]；名称用小写字母、数字与连字符')
      if (location !== undefined && !isRelayLocation(location))
        throw new RelayCliError(`--location 是 ${RELAY_LOCATIONS.join('、')} 之一；不给时由 Cloudflare 放在离第一次请求最近的地方`)
      if (target !== undefined && (typeof target !== 'string' || !isAbsolute(target)))
        throw new RelayCliError('--out 应为一个新文件的绝对路径')
      // The deploy entry lives in the source checkout; the installed app carries no Worker bundles yet.
      const entry = join(input.codeRoot ?? '', 'apps/relay-edge/scripts/setup.ts')
      const present =
        input.codeRoot !== undefined
        && (await stat(entry).then(
          info => info.isFile(),
          () => false,
        ))
      if (!present)
        throw new RelayCliError(
          '尚未实现：安装版不带 Workers 部署包。请在 Latch 源码目录运行 pnpm latch relay setup cloudflare，再在设置里添加它写出的中继文件。',
        )
      const args = ['--name', name, ...(location ? ['--location', location] : []), ...(target ? ['--out', target] : []), '--check']
      return io.runEntry ? io.runEntry(entry, args) : runEntry(entry, args, input.codeRoot!)
    }
    if (rest[0] === 'linux') {
      const server = flags.get('--server'),
        domain = flags.get('--domain'),
        ip = flags.get('--ip'),
        name = flags.get('--name'),
        target = flags.get('--out'),
        port = flags.get('--port'),
        publicPort = flags.get('--public-port'),
        sshPort = flags.get('--ssh-port'),
        cert = flags.get('--cert'),
        key = flags.get('--key'),
        acmeEmail = flags.get('--acme-email'),
        bundle = flags.get('--bundle'),
        behindProxy = flags.has('--behind-proxy'),
        skipAccept = flags.has('--skip-accept'),
        upgrade = flags.has('--upgrade')
      if (typeof server !== 'string' || !server.trim())
        throw new RelayCliError(
          '用法：relay setup linux --server <user@host> [--domain <域名> | --ip <公网IP>] [--name <名称>] [--behind-proxy | --cert <证书路径> --key <私钥路径>] [--upgrade]',
        )
      if (name !== undefined && (typeof name !== 'string' || !RELAY_NAME.test(name) || name.length > 40))
        throw new RelayCliError('名称只能用小写字母、数字与连字符，至多 40 个字符')
      if (target !== undefined && (typeof target !== 'string' || !isAbsolute(target)))
        throw new RelayCliError('--out 应为一个新文件的绝对路径')
      const entry = join(input.codeRoot ?? '', 'apps/relay/scripts/setup-linux.ts')
      const present =
        input.codeRoot !== undefined
        && (await stat(entry).then(
          info => info.isFile(),
          () => false,
        ))
      if (!present)
        throw new RelayCliError(
          '尚未实现：安装版尚未内嵌 Linux 中继部署包。请在 Latch 源码目录运行 pnpm latch relay setup linux，或导入已导出的中继配置文件。',
        )
      const args: string[] = ['--server', server]
      if (typeof domain === 'string') args.push('--domain', domain)
      if (typeof ip === 'string') args.push('--ip', ip)
      if (typeof name === 'string') args.push('--name', name)
      if (typeof port === 'string') args.push('--port', port)
      if (typeof publicPort === 'string') args.push('--public-port', publicPort)
      if (typeof sshPort === 'string') args.push('--ssh-port', sshPort)
      if (behindProxy) args.push('--behind-proxy')
      if (typeof cert === 'string') args.push('--cert', cert)
      if (typeof key === 'string') args.push('--key', key)
      if (typeof acmeEmail === 'string') args.push('--acme-email', acmeEmail)
      if (typeof bundle === 'string') args.push('--bundle', resolve(io.cwd, bundle))
      if (typeof target === 'string') args.push('--out', target)
      if (skipAccept) args.push('--skip-accept')
      if (upgrade) args.push('--upgrade')
      return io.runEntry ? io.runEntry(entry, args) : runEntry(entry, args, input.codeRoot!)
    }
    throw new RelayCliError('用法：relay setup cloudflare|linux')
  }
  if (command === 'status' || command === 'uninstall') {
    if (rest[0] !== 'linux') throw new RelayCliError(`用法：relay ${command} linux --server <user@host>`)
    const server = flags.get('--server'),
      sshPort = flags.get('--ssh-port'),
      purgeData = flags.has('--purge-data')
    if (typeof server !== 'string' || !server.trim()) throw new RelayCliError(`用法：relay ${command} linux --server <user@host>`)
    const entry = join(input.codeRoot ?? '', 'apps/relay/scripts/setup-linux.ts')
    const present =
      input.codeRoot !== undefined
      && (await stat(entry).then(
        info => info.isFile(),
        () => false,
      ))
    if (!present) throw new RelayCliError('尚未实现：请在 Latch 源码目录运行该远端运维命令。')
    const args: string[] = ['--action', command, '--server', server]
    if (typeof sshPort === 'string') args.push('--ssh-port', sshPort)
    if (command === 'uninstall' && purgeData) args.push('--purge-data')
    return io.runEntry ? io.runEntry(entry, args) : runEntry(entry, args, input.codeRoot!)
  }
  if (command === 'test') {
    const relayId = rest[0]
    if (!relayId || !/^[a-f0-9]{32}$/u.test(relayId)) throw new RelayCliError('用法：relay test <节点标识>')
    const result = (await input.running('POST', `native/relays/${relayId}/test`)) as NativeRelayTest
    const order = ['none', 'identity', 'registered'] as const
    const reached = order.indexOf(result.reached)
    const mark = (done: boolean, failed: boolean) => (done ? '✓' : failed ? '✗' : '·')
    const failedAt = result.failure === undefined ? -1 : result.failure === 'refused' ? 2 : result.failure === 'mismatch' ? 1 : 0
    out(`${mark(reached >= 1, failedAt === 0)} 连上${result.latencyMs === undefined ? '' : `（${result.latencyMs} ms）`}`)
    out(`${mark(reached >= 1, failedAt === 1)} 密钥相符`)
    out(`${mark(reached >= 2, failedAt === 2)} 注册`)
    out(result.bookIssuedAt === undefined ? '· 连接簿签发' : '✓ Host 已签发')
    if (result.failure) {
      out(
        result.failure === 'mismatch'
          ? '中继给出的密钥与文件里的不一致。'
          : result.failure === 'refused'
            ? '中继拒绝了登记：注册令牌不对或中继已满。'
            : '连不上这个中继：检查地址与网络。',
      )
      return 1
    }
    return 0
  }
  if (command === 'list') {
    const lock = await input.stopped().catch(() => undefined)
    if (!lock) throw new RelayCliError('Host 运行中时请在桌面端「设置 › 连接转发」查看中继，或停止 Host 后再运行')
    try {
      const state = (await RelayProfiles.open(dataDir)).snapshot()
      const view = {
        relays: state.profiles
          .filter(item => !item.builtIn)
          .map(item => ({
            relayId: item.relayId,
            kind: item.kind ?? 'self',
            urls: [item.url, ...(item.extraUrls ?? [])],
            ...(item.unverified ? { unverified: true } : {}),
            ...(item.disabled ? { disabled: true } : {}),
            ...(!relayAvailable(item) ? { unsupported: true } : {}),
            ...(!relayAddressValid(item) ? { invalidAddress: true } : {}),
          })),
        inAddressBook: bookRelays(state).map(item => item.relayId),
      }
      if (flags.has('--json')) out(JSON.stringify(view, null, 2))
      else {
        for (const relay of view.relays) {
          const columns = [relay.relayId, relay.kind === 'edge' ? 'Workers' : '自建服务器', relay.urls.join(' ')]
          if (relay.disabled) columns.push('已停用')
          if (relay.unverified) columns.push('待核对')
          if (relay.unsupported) columns.push('尚未实现')
          if (relay.invalidAddress) columns.push('地址无效：不进连接簿，请移除后用新的中继文件添加')
          out(columns.join('  '))
        }
        if (!view.relays.length) out('没有自己的中继')
      }
    } finally {
      await lock.release()
    }
    return 0
  }
  if (command === 'add' || command === 'remove') {
    const lock = await input.stopped()
    let audit: AuditLog | undefined
    try {
      const lowering = command === 'remove'
      audit = await AuditLog.open(join(dataDir, 'audit')).catch(error => {
        if (!lowering) throw error
        return undefined
      })
      const profiles = await RelayProfiles.open(dataDir)
      const record = async (detail: { before: string; after: string; relayCount: number }, lowering: boolean) => {
        try {
          if (!audit) throw new RelayCliError('审计记录不可用')
          await audit.append({
            action: 'native.config.changed',
            actor: input.actor,
            ...(lowering ? {} : { stepup: 'offline' as const }),
            detail: { ...detail, lowering, direct: false },
          })
          return true
        } catch (error) {
          if (!lowering) throw error
          io.stderr.write('审计记录写入失败；移除或关闭中继照常进行。\n')
          return false
        }
      }
      if (command === 'add') {
        const path = flags.get('--file'),
          name = flags.get('--name')
        if (path !== undefined && name !== undefined) throw new RelayCliError('--file 与 --name 只用一个')
        const file =
          typeof path === 'string'
            ? resolve(io.cwd, path)
            : await chooseRelayFile({
                ...(typeof name === 'string' ? { name } : {}),
                ...(input.home === undefined ? {} : { home: input.home }),
              }).catch((error: unknown) => {
                throw new RelayCliError(error instanceof RelayFilesError ? error.message : '读不到 ~/.latch/relays')
              })
        const relay = await readRelayFile(file)
        profiles.assertNewRelay(relay)
        for (const line of relayFacts(relay)) out(line)
        const expected = flags.get('--expect-key')
        if (typeof expected === 'string') {
          if (expected !== relayKeyHash(relayNodeFields(relay)))
            throw new RelayCliError('--expect-key 与这个中继的密钥短哈希不一致，没有修改任何设置')
        } else {
          if (!io.stdin.isTTY)
            throw new RelayCliError('非交互环境中不能确认：核对上面的地址与密钥后加上 --expect-key <密钥短哈希>。没有修改任何设置')
          const answer = (await io.readLine('添加这个中继？输入 y 确认，其他任意内容取消：')).trim().toLowerCase()
          if (answer !== 'y' && answer !== 'yes') throw new RelayCliError('已取消，没有修改任何设置')
        }
        const base = profiles.configHash()
        await audit!.append({
          action: 'native.relay.add.requested',
          actor: input.actor,
          stepup: 'offline',
          detail: { base, profile: sha256Hex(canonicalJson(relay)) },
        })
        await profiles.addUnverified(relay, base, detail => record(detail, false))
        out('已保存。Host 启动后核对节点密钥并登记成功，才会签发含该中继的连接簿；结果在设置与 relay list 中可见。')
        return 0
      }
      const relayId = rest[0]
      if (!relayId || !profiles.snapshot().profiles.some(item => !item.builtIn && item.relayId === relayId))
        throw new RelayCliError('没有这个自己的中继')
      await profiles.removeObserver(
        { relayId },
        () => {},
        detail => record(detail, true),
      )
      out('已移除。已配对的手机下次取得连接簿时不再得到它。')
      return 0
    } finally {
      try {
        await audit?.close()
      } finally {
        await lock.release()
      }
    }
  }
  return undefined
}
