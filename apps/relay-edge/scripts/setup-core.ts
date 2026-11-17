import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/**
 * One relay node on the person's own Cloudflare account, end to end: deploy the work Worker and the node, generate the
 * relay key and a registration token, put the secrets through wrangler's standard input (never its arguments), fill
 * NODE_HOSTS and RELAY_ID, deploy again, check /healthz and write the relay file (0600, a new file).
 *
 * A plain module: everything it runs and reads comes in as inputs (the two bundles, the wrangler program, a work
 * directory), so a source checkout's pnpm script and a shipped command can both drive it. It never logs in to the
 * provider, never reads wrangler's own files and prints only non-secret progress.
 */
export interface SetupInput {
  region: 'ne' | 'se'
  /** Absolute path of the relay file to create; it must not exist. */
  out: string
  /** The Worker bundles (worker.js and work.js). */
  workerBundle: string
  workBundle: string
  /** Where the generated wrangler configs and bundle copies live (outside any repository); created if missing. */
  workDir: string
}
export interface SetupDeps {
  /** Runs wrangler with these arguments in `cwd`, writing `input` to its standard input. Resolves its exit code and stdout. */
  wrangler(args: string[], options: { cwd: string; input?: string }): Promise<{ code: number; stdout: string }>
  /** The HTTP status of a GET, or 0 when it failed. */
  status(url: string): Promise<number>
  publicKey(seed: Uint8Array): Promise<Uint8Array>
  progress(line: string): void
  wait(ms: number): Promise<void>
}
export class SetupError extends Error {}

const HINT = { ne: 'apac-ne', se: 'apac-se' } as const
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

function nodeConfig(name: string, region: 'ne' | 'se', relayId: string, hosts: string): string {
  return `${JSON.stringify(
    {
      name,
      main: 'worker.js',
      no_bundle: true,
      compatibility_date: '2026-11-01',
      workers_dev: true,
      preview_urls: false,
      observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } },
      logpush: false,
      migrations: [{ tag: 'v1', new_sqlite_classes: ['RelayNode'] }],
      durable_objects: { bindings: [{ name: 'NODE', class_name: 'RelayNode' }] },
      services: [{ binding: 'WORK', service: 'latch-relay-work' }],
      vars: {
        NODE_HOSTS: hosts,
        LOCATION_HINT: HINT[region],
        RELAY_ID: relayId,
        SHARDS: '1',
        OBJECT_EPOCH: '1',
        OPEN_REGISTRATION: 'false',
      },
    },
    null,
    2,
  )}\n`
}
const WORK_CONFIG = `${JSON.stringify(
  {
    name: 'latch-relay-work',
    main: 'work.js',
    no_bundle: true,
    compatibility_date: '2026-11-01',
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } },
    logpush: false,
  },
  null,
  2,
)}\n`

/** A new file, 0600, refused when anything is already at the path. */
async function writeNew(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600).catch(() => {
    throw new SetupError(`无法写入 ${path}：文件已存在或目录不可写`)
  })
  try {
    await handle.writeFile(text)
  } finally {
    await handle.close()
  }
}

export async function runSetup(input: SetupInput, deps: SetupDeps): Promise<{ url: string; relayId: string }> {
  if (!isAbsolute(input.out)) throw new SetupError('--out 应为一个新文件的绝对路径')
  // Refuse an existing relay file before anything is deployed.
  const probe = await open(input.out, constants.O_RDONLY).then(
    async handle => {
      await handle.close()
      return true
    },
    () => false,
  )
  if (probe) throw new SetupError(`${input.out} 已存在，换一个路径`)
  await mkdir(input.workDir, { recursive: true, mode: 0o700 })
  const version = await deps.wrangler(['--version'], { cwd: input.workDir }).catch(() => ({ code: -1, stdout: '' }))
  if (version.code !== 0) throw new SetupError('没有找到 wrangler。请先安装 Cloudflare 的 wrangler 并运行 wrangler login，再重试。')

  const name = `latch-relay-${input.region}`
  const dir = join(input.workDir, name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await copyFile(input.workerBundle, join(dir, 'worker.js'))
  await copyFile(input.workBundle, join(dir, 'work.js'))
  await writeFile(join(dir, 'work.wrangler.jsonc'), WORK_CONFIG, { mode: 0o600 })

  const run = async (label: string, args: string[], stdin?: string) => {
    deps.progress(label)
    const result = await deps.wrangler(args, { cwd: dir, ...(stdin === undefined ? {} : { input: stdin }) })
    if (result.code !== 0) throw new SetupError(`${label}失败（wrangler 退出码 ${result.code}）`)
    return result.stdout
  }
  await run('部署校验 Worker', ['deploy', '-c', 'work.wrangler.jsonc'])

  const relayId = hex(randomBytes(16))
  await writeFile(join(dir, 'wrangler.jsonc'), nodeConfig(name, input.region, relayId, ''), { mode: 0o600 })
  const first = await run('第一次部署节点', ['deploy', '-c', 'wrangler.jsonc'])
  const url = new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`, 'u').exec(first)?.[0]
  if (!url) throw new SetupError('没有从 wrangler 的输出里找到这个节点的 workers.dev 地址')

  const seed = randomBytes(32),
    token = randomBytes(32),
    admin = randomBytes(32)
  try {
    const relayKey = hex(await deps.publicKey(seed))
    await run('写入中继密钥', ['secret', 'put', 'RELAY_SIGNING_SEED', '-c', 'wrangler.jsonc'], hex(seed))
    await run('写入注册令牌', ['secret', 'put', 'REGISTRATION_TOKEN', '-c', 'wrangler.jsonc'], hex(token))
    await run('写入管理令牌', ['secret', 'put', 'ADMIN_TOKEN', '-c', 'wrangler.jsonc'], hex(admin))
    await writeFile(join(dir, 'wrangler.jsonc'), nodeConfig(name, input.region, relayId, new URL(url).hostname), { mode: 0o600 })
    await run('再次部署节点', ['deploy', '-c', 'wrangler.jsonc'])

    deps.progress('检查 /healthz')
    let healthy = false
    for (let attempt = 0; attempt < 10 && !healthy; attempt++) {
      if (attempt) await deps.wait(3000)
      healthy = (await deps.status(`${url}/healthz`)) === 200
    }
    if (!healthy) throw new SetupError(`${url}/healthz 没有返回 200；可稍后再试 wrangler deploy -c ${join(dir, 'wrangler.jsonc')}`)

    await writeNew(
      input.out,
      `${JSON.stringify({
        version: 2,
        profile: {
          relayId,
          url: `${url}/`,
          kind: 'edge',
          relayKey,
          registrationKey: `lrt1.${token.toString('base64url')}`,
        },
      })}\n`,
    )
    // The admin token goes into a 0600 header file for `curl -H @file`, never onto a command line.
    await writeNew(`${input.out}.admin-header`, `Authorization: Bearer ${hex(admin)}\n`)
    deps.progress(`已写入中继文件 ${input.out}（含注册令牌，只交给你的 Mac）`)
    return { url: `${url}/`, relayId }
  } finally {
    seed.fill(0)
    token.fill(0)
    admin.fill(0)
  }
}
