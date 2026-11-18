import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { isRelayEndpoint } from '@latch/link-wire'
import { runAcceptance, type AcceptanceItem } from './accept-core.ts'

/**
 * `pnpm relay-edge:accept --file <relay file>`: the acceptance run against a freshly deployed edge relay, before any
 * Mac uses it. Reads the relay file `pnpm relay-edge:setup` wrote and, beside it, `<file>.admin-header`. Prints one line
 * per item and nothing secret; exits 0 only when no item failed.
 */
const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    'admin-header': { type: 'string' },
    sockets: { type: 'string' },
    'slow-seconds': { type: 'string' },
    json: { type: 'boolean' },
  },
  strict: true,
})
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
async function readSmall(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined)
  if (!handle) return undefined
  try {
    if (!(await handle.stat()).isFile()) return undefined
    const buffer = Buffer.alloc(4097)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > 4096 ? undefined : buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
const path = values.file ?? ''
if (!isAbsolute(path)) fail('--file 应为 pnpm relay-edge:setup 写出的中继文件的绝对路径')
const text = await readSmall(path)
let profile: Record<string, unknown> | undefined
try {
  const file = JSON.parse(text ?? '') as { version?: unknown; profile?: Record<string, unknown> }
  if (file.version === 2 && file.profile?.kind === 'edge') profile = file.profile
} catch {
  profile = undefined
}
const hex = (value: unknown, size: number) =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`, 'u').test(value) ? Buffer.from(value, 'hex') : undefined
const url = typeof profile?.url === 'string' && isRelayEndpoint(profile.url) ? new URL(profile.url) : undefined
const relayId = hex(profile?.relayId, 32),
  relayKey = hex(profile?.relayKey, 64)
const shard = profile?.shard === undefined ? 0 : Number(profile.shard)
const token =
  typeof profile?.registrationKey === 'string' && /^lrt1\.[A-Za-z0-9_-]{43}$/u.test(profile.registrationKey)
    ? Buffer.from(profile.registrationKey.slice(5), 'base64url')
    : undefined
if (!profile || !url || !relayId || !relayKey || !Number.isInteger(shard) || shard < 0 || shard > 15)
  fail('这个文件不是 Workers 中继的中继文件')
const header = await readSmall(values['admin-header'] ?? `${path}.admin-header`)
const adminToken = header ? /^Authorization: Bearer ([\x21-\x7e]{32,256})\r?\n?$/u.exec(header)?.[1] : undefined
const count = (value: string | undefined, fallback: number, max: number) => {
  const parsed = value === undefined ? fallback : Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fail('--sockets 为 1–64，--slow-seconds 为 1–120')
}

const LABEL: Record<string, string> = {
  healthz: '健康检查',
  admin: '管理接口只认令牌',
  'wrong-key': '错误密钥与令牌被拒绝',
  register: '用中继文件登记',
  cover: '前三秒填充',
  unauthenticated: '未认证连接的内存',
  'slow-reader': '不读的手机',
}
const items: AcceptanceItem[] = await runAcceptance(
  {
    url: url!,
    relayId: relayId!,
    relayKey: relayKey!,
    shard,
    ...(token ? { registrationToken: token } : {}),
    ...(adminToken ? { adminToken } : {}),
    sockets: count(values.sockets, 24, 64),
    slowSeconds: count(values['slow-seconds'], 30, 120),
    slowRate: 256 * 1024,
  },
  { progress: name => process.stderr.write(`… ${LABEL[name] ?? name}\n`) },
)
token?.fill(0)
if (values.json) process.stdout.write(`${JSON.stringify(items, null, 2)}\n`)
else
  for (const item of items)
    process.stdout.write(
      `${item.result === 'pass' ? '✓' : item.result === 'fail' ? '✗' : '·'} ${LABEL[item.name] ?? item.name}：${item.detail}\n`,
    )
process.exit(items.some(item => item.result === 'fail') ? 1 : 0)
