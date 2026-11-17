import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * Writes the relay file of one edge node (version 2) for `添加自己的中继` on the Mac: node ID, every origin, the relay's
 * public key and, unless `--open`, a fresh registration key. The file is new, 0600, at an absolute path.
 *
 * Without `--open` the same registration token goes to standard output, which must be a pipe into
 * `wrangler secret put REGISTRATION_TOKEN`: a personal relay only registers Hosts that hold the file. `--open` writes no
 * token; the node then needs `OPEN_REGISTRATION` set to `true` and admits any Host, as the official relay does.
 */
const { values } = parseArgs({
  options: {
    'relay-id': { type: 'string' },
    'relay-key': { type: 'string' },
    url: { type: 'string', multiple: true },
    shard: { type: 'string' },
    output: { type: 'string' },
    open: { type: 'boolean' },
  },
  strict: true,
})
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
const relayId = values['relay-id'] ?? '',
  relayKey = values['relay-key'] ?? '',
  urls = values.url ?? []
if (!/^[a-f0-9]{32}$/u.test(relayId)) fail('--relay-id 应为 32 位十六进制（keygen 打印的 relayId）')
if (!/^[a-f0-9]{64}$/u.test(relayKey)) fail('--relay-key 应为 64 位十六进制（keygen 打印的 relayKey）')
if (urls.length < 1 || urls.length > 4 || new Set(urls).size !== urls.length) fail('用 1 到 4 个 --url 给出这个节点的地址')
for (const value of urls) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== `${url.origin}/` || value.length > 512)
    fail(`地址只能是 https 的 origin，例如 https://latch-relay-ne.<子域>.workers.dev/：${value}`)
}
const shard = values.shard === undefined ? undefined : Number(values.shard)
if (shard !== undefined && (!Number.isInteger(shard) || shard < 0 || shard > 15)) fail('--shard 应为 0 到 15')
if (!values.output || !isAbsolute(values.output)) fail('--output 应为一个新文件的绝对路径')
if (!values.open && process.stdout.isTTY)
  fail(
    '注册令牌只能经管道交给 wrangler secret put，例如：\n  pnpm --silent relay-edge:profile … | npx wrangler secret put REGISTRATION_TOKEN --env ne\n或加 --open 让任何 Host 都能登记',
  )
const token = values.open ? undefined : randomBytes(32)
await writeFile(
  values.output!,
  `${JSON.stringify({
    version: 2,
    profile: {
      relayId,
      url: urls[0],
      kind: 'edge',
      relayKey,
      ...(urls.length > 1 ? { extraUrls: urls.slice(1) } : {}),
      ...(shard === undefined ? {} : { shard }),
      ...(token ? { registrationKey: `lrt1.${token.toString('base64url')}` } : {}),
    },
  })}\n`,
  { flag: 'wx', mode: 0o600 },
).catch(() => fail('无法写入：文件已存在或目录不可写'))
if (token) process.stdout.write(token.toString('hex'))
token?.fill(0)
process.stderr.write(`已写入中继文件 ${values.output}${token ? '（含注册令牌，私下带到 Mac）' : '（开放登记）'}\n`)
