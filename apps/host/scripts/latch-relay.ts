import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { NativeRelayTest } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { AuditLog, type AuditActor } from '../src/audit.ts'
import {
  bookRelays,
  relayKeyHash,
  relayNodeFields,
  relayProfileInput,
  RelayProfiles,
  type RelayProfileInput,
} from '../src/relay/profiles.ts'

export const RELAY_USAGE = `  relay list [--json]                      列出官方中继与自己的中继、顺序与开关（Host 已停止）
  relay add --file <中继文件> [--expect-key <密钥短哈希>]
                                           添加自己的中继（Host 已停止）：先列出地址与密钥短哈希，再输入 y 确认；
                                           非交互环境用 --expect-key。Host 启动后核对节点密钥并登记成功，才把它发给手机；
                                           文件里的注册令牌只交给 Host，不显示
  relay test <节点标识>                      现在测试一个中继：连上、密钥相符、注册、手机已拿到（Host 运行中）
  relay remove <节点标识>                    移除自己的中继（Host 已停止）
  relay official on|off                    打开或关闭官方中继（Host 已停止）
  relay order official|own                 优先使用官方中继或自己的中继（Host 已停止）
`
type Out = (text: string) => void
interface RelayCliIO {
  cwd: string
  stdin: { isTTY?: boolean }
  stderr: { write(text: string): unknown }
  readLine(prompt: string): Promise<string>
}
export class RelayCliError extends Error {}

/** A relay file as the self-hosted relay CLI (version 1) or apps/relay-edge (version 2, edge) writes it. */
export async function readRelayFile(path: string): Promise<RelayProfileInput> {
  // At most 4 KiB plus one byte is read, whatever the path names (a device, a pipe, a huge file).
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new RelayCliError('读不到这个中继文件')
  })
  let text: string
  try {
    if (!(await handle.stat()).isFile()) throw new RelayCliError('这个文件不是中继导出的连接配置')
    const buffer = Buffer.alloc(4097)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 4096) throw new RelayCliError('这个文件不是中继导出的连接配置')
    text = buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
  let file: { version?: unknown; profile?: Record<string, unknown> }
  try {
    file = JSON.parse(text) as typeof file
  } catch {
    throw new RelayCliError('这个文件不是中继导出的连接配置')
  }
  const profile = file.profile ?? {}
  if (file.version === 1 && 'kind' in profile) throw new RelayCliError('这个文件不是中继导出的连接配置')
  if (file.version === 2 && profile.kind !== 'edge') throw new RelayCliError('这个文件不是中继导出的连接配置')
  if (file.version !== 1 && file.version !== 2) throw new RelayCliError('不认识这个中继文件的版本')
  const parsed = relayProfileInput.safeParse(profile)
  if (!parsed.success) throw new RelayCliError('这个文件不是中继导出的连接配置')
  return parsed.data
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
 * `pnpm latch relay …`. Testing uses the running Host. Listing and editing use the data directory lock while the Host
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
}): Promise<number | undefined> {
  const { command, rest, flags, dataDir, io, out } = input
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
    out(`${mark(result.deliveredAt !== undefined, false)} 手机已拿到`)
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
    if (!lock) throw new RelayCliError('Host 运行中时请在桌面端「设置 › 中继」查看中继，或停止 Host 后再运行')
    try {
      const state = (await RelayProfiles.open(dataDir)).snapshot()
      const view = {
        official: { deployed: state.profiles.some(item => item.builtIn), enabled: !state.officialOff, ownFirst: Boolean(state.ownFirst) },
        relays: state.profiles
          .filter(item => !item.builtIn)
          .map(item => ({
            relayId: item.relayId,
            kind: item.kind ?? 'self',
            urls: [item.url, ...(item.extraUrls ?? [])],
            ...(item.unverified ? { unverified: true } : {}),
          })),
        inAddressBook: bookRelays(state).map(item => item.relayId),
      }
      if (flags.has('--json')) out(JSON.stringify(view, null, 2))
      else {
        out(`官方中继：${!view.official.deployed ? '尚未部署' : view.official.enabled ? '已开启' : '已关闭'}`)
        out(`优先使用：${view.official.ownFirst ? '自己的中继' : '官方中继'}`)
        for (const relay of view.relays)
          out(`${relay.relayId}  ${relay.kind === 'edge' ? 'Workers' : '自建服务器'}  ${relay.urls.join(' ')}`)
        if (!view.relays.length) out('没有自己的中继')
      }
    } finally {
      await lock.release()
    }
    return 0
  }
  if (command === 'add' || command === 'remove' || command === 'official' || command === 'order') {
    const lock = await input.stopped()
    let audit: AuditLog | undefined
    try {
      const lowering = command === 'remove' || (command === 'official' && rest[0] === 'off')
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
        const path = flags.get('--file')
        if (typeof path !== 'string') throw new RelayCliError('请用 --file <中继文件> 指定要添加的中继')
        const relay = await readRelayFile(resolve(io.cwd, path))
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
        out('已保存。Host 启动后核对节点的密钥并登记成功，才会把它发给手机；结果在设置与 relay list 中可见。')
        return 0
      }
      if (command === 'remove') {
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
      }
      const value = rest[0]
      if (command === 'official') {
        if (value !== 'on' && value !== 'off') throw new RelayCliError('用法：relay official on|off')
        await profiles.setOfficial(
          { enabled: value === 'on' },
          () => {},
          detail => record(detail, value === 'off'),
        )
        out(value === 'on' ? '官方中继已开启。' : '官方中继已关闭；自己的中继照常使用。')
        return 0
      }
      if (value !== 'own' && value !== 'official') throw new RelayCliError('用法：relay order official|own')
      await profiles.setOfficial(
        { ownFirst: value === 'own' },
        () => {},
        detail => record(detail, false),
      )
      out(value === 'own' ? '优先使用自己的中继。' : '优先使用官方中继。')
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
