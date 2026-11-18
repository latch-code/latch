import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, open, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { makePrivateDirectory, ownedDirectory } from '@latch/link-client/private-directory'
import {
  legacyDeployDir,
  prepareRelayDeployDir,
  prepareRelaysDir,
  RELAY_NAME,
  RELAYS_DISPLAY,
  RelayFilesError,
} from '@latch/link-client/relay-files'
import { isRelayLocation, type RelayLocation } from '@latch/link-wire'

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
  /** The person's own name for the node: its relay file, its deploy directory and its Worker (`latch-relay-<name>`). */
  name: string
  /** Where the node is asked to run; absent lets the platform place it near its first request. */
  location?: RelayLocation
  /** Absolute path of the relay file to create; neither it nor `<out>.admin-header` may exist. */
  out: string
  /** The Worker bundles (worker.js and work.js). */
  workerBundle: string
  workBundle: string
  /**
   * Where the generated wrangler configs and bundle copies live (outside any repository): created 0700 if missing (its
   * parent must exist), and refused unless it is this user's private directory.
   */
  workDir: string
  /** The acceptance command printed as the next step; by default the one naming `out`. */
  next?: string
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

/**
 * Where a setup run writes, by default all under `~/.latch/relays`: the relay file `<name>.json` beside its
 * `.admin-header`, and the deploy configs in `<name>/deploy/`. The deploy directory is keyed by name because the
 * Worker is (`latch-relay-<name>`): a second run for a name redeploys the same Worker. `out` writes the relay file
 * elsewhere. A work directory from an earlier version (`~/.latch-relay/latch-relay-<name>`) is used while the new one
 * does not exist, and never moved or deleted; `notes` then holds the one line with the commands to move it.
 */
export async function setupPaths(input: {
  name: string
  out?: string
  home?: string
  /** The acceptance command the next step names; the source checkout's by default. */
  accept?: string
}): Promise<{ out: string; workDir: string; next: string; notes: string[] }> {
  try {
    if (!RELAY_NAME.test(input.name) || input.name.length > 40) throw new SetupError('名称只能用小写字母、数字与连字符，至多 40 个字符')
    if (input.out !== undefined && !isAbsolute(input.out)) throw new SetupError('--out 应为一个新文件的绝对路径')
    const relays = await prepareRelaysDir(input.home)
    const out = input.out ?? join(relays, `${input.name}.json`)
    await refuseExisting(out, input.out === undefined ? `${RELAYS_DISPLAY}/${input.name}.json` : out)
    const deploy = join(relays, input.name, 'deploy')
    const present = await lstat(deploy).then(
      () => true,
      () => false,
    )
    const legacy = present ? undefined : await legacyDeployDir(input.name, input.home)
    const accept = input.accept ?? 'pnpm relay-edge:accept'
    const next = input.out === undefined ? `${accept} --name ${input.name}` : `${accept} --file ${out}`
    if (legacy)
      return {
        out,
        workDir: legacy,
        next,
        notes: [
          `部署配置仍在早先的 ~/.latch-relay，照常使用。移到 ${RELAYS_DISPLAY}：(umask 077 && mkdir -p ${RELAYS_DISPLAY}/${input.name}) && mv -n ~/.latch-relay/latch-relay-${input.name} ${RELAYS_DISPLAY}/${input.name}/deploy，再 rmdir ~/.latch-relay`,
        ],
      }
    const workDir = await prepareRelayDeployDir(input.name, input.home)
    return { out, workDir, next, notes: [] }
  } catch (error) {
    if (error instanceof RelayFilesError) throw new SetupError(error.message)
    throw error
  }
}

/** Refuses before anything is deployed: a new run would rotate the node's secrets and leave an existing file dead. */
async function refuseExisting(out: string, shown: string): Promise<void> {
  for (const path of [out, `${out}.admin-header`]) {
    const exists = await lstat(path).then(
      () => true,
      () => false,
    )
    if (exists)
      throw new SetupError(
        `${shown}${path === out ? '' : '.admin-header'} 已存在，不覆盖。再次部署会换新的中继密钥与令牌，旧文件随之失效：先在 Mac 上移除这个中继，删除 ${shown} 与 ${shown}.admin-header 后重试；或用 --out <新文件的绝对路径> 写到别处`,
      )
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

function nodeConfig(name: string, location: RelayLocation | undefined, relayId: string, hosts: string): string {
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
        ...(location ? { LOCATION_HINT: location } : {}),
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
  if (!RELAY_NAME.test(input.name) || input.name.length > 40) throw new SetupError('名称只能用小写字母、数字与连字符，至多 40 个字符')
  if (input.location !== undefined && !isRelayLocation(input.location)) throw new SetupError('不认识这个位置')
  // Refuse an existing relay file or admin header before anything is deployed.
  await refuseExisting(input.out, input.out)
  const dir = input.workDir
  if (!isAbsolute(dir) || !(await makePrivateDirectory(dir)) || !(await ownedDirectory(dir, process.getuid?.() ?? -1, 0o077)))
    throw new SetupError(`部署目录 ${dir} 必须是你自己的目录，权限 0700，不能是链接`)
  const version = await deps.wrangler(['--version'], { cwd: dir }).catch(error => {
    if (error instanceof SetupError) throw error
    return { code: -1 }
  })
  if (version.code !== 0) throw new SetupError('没有找到 wrangler。请先安装 Cloudflare 的 wrangler 并运行 wrangler login，再重试。')

  const name = `latch-relay-${input.name}`
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
  await writeFile(join(dir, 'wrangler.jsonc'), nodeConfig(name, input.location, relayId, ''), { mode: 0o600 })
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
    await writeFile(join(dir, 'wrangler.jsonc'), nodeConfig(name, input.location, relayId, new URL(url).hostname), { mode: 0o600 })
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
    // Public: the short hash the Mac's confirmation sheet shows for this relay key.
    deps.progress(`中继密钥短哈希 ${createHash('sha256').update(Buffer.from(relayKey, 'hex')).digest('hex').slice(0, 8)}`)
    deps.progress(`下一步：${input.next ?? `pnpm relay-edge:accept --file ${input.out}`}`)
    return { url: `${url}/`, relayId }
  } finally {
    seed.fill(0)
    token.fill(0)
    admin.fill(0)
  }
}
