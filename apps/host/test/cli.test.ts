import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir, uptime } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@latch/protocol'
import { verifyAuditFile } from '../src/audit.ts'
import { HostConfig } from '../src/config.ts'
import { writeProjectContext } from '../src/project-context.ts'
import { latchCodeRoot } from '../src/paths.ts'
import { acquireDataDirLock, bootTime, readDataDirLock, writeHostState } from '../src/host-state.ts'
import { defaultPolicy } from '../src/policy.ts'
import { runLatch, type CliIO } from '../scripts/latch.ts'
import { pnpmFromEnvironment } from '../../../scripts/supply-canaries.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const run = promisify(execFile)
const TSX = resolve('node_modules/.bin/tsx')
const TSX_LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href
const LATCH = resolve('apps/host/scripts/latch.ts')

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'lt-cli-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * `tty`: stdout is a terminal. `typed`: stdin is a terminal, and `answer` is what is typed at a question (`asked` records
 * each question with what stdout showed by then); `secret` is the key read from stdin either way.
 */
function cli(
  options: { tty?: boolean; typed?: boolean; answer?: string | boolean; secret?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const output = { stdout: '', stderr: '', asked: [] as Array<{ prompt: string; shown: string }>, secrets: 0 }
  const io: CliIO = {
    stdout: {
      write: (text: string) => {
        output.stdout += text
      },
      isTTY: options.tty ?? false,
    },
    stderr: {
      write: (text: string) => {
        output.stderr += text
      },
    },
    stdin: { isTTY: options.typed ?? false },
    readSecret: async () => {
      output.secrets++
      return options.secret ?? ''
    },
    readLine: async prompt => {
      output.asked.push({ prompt, shown: output.stdout })
      return typeof options.answer === 'string' ? options.answer : ''
    },
    ...(options.answer !== undefined ? { confirm: async () => options.answer === true } : {}),
    env: options.env ?? {},
    cwd: options.cwd ?? tmpdir(),
  }
  return { io, output, latch: (...argv: string[]) => runLatch(argv, io) }
}

/** An in-process Host recorded in host.json, as start.ts would write it. */
async function runningHost(options: Parameters<typeof startTestHost>[0] = {}): Promise<TestHost> {
  const t = await startTestHost(options)
  cleanups.push(() => t.close())
  await writeHostState(t.dataDir, {
    version: 2,
    pid: process.pid,
    hostId: t.host.hostId,
    instanceId: t.host.instanceId,
    socketPath: t.host.socketPath,
    loopbackOrigin: t.host.loopbackOrigin,
    tlsOrigin: t.host.tlsOrigin ?? null,
    startedAt: t.host.startedAt,
    dataDir: t.dataDir,
  })
  return t
}

async function auditActions(
  dataDir: string,
): Promise<Array<{ action: string; actor: { listener: string; via?: string }; stepup: string }>> {
  return (await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

/**
 * A data dir with one provider, ready for offline commands. Its policy turns local confirmation off, so no path through
 * `presence test` can ever reach the real helper.
 */
async function stoppedDataDir(): Promise<string> {
  const dataDir = join(await temporaryDirectory(), 'data')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(dataDir, 'policy.json'),
    JSON.stringify({ ...defaultPolicy(process.platform), presence: { backend: 'none', helperCdhash: null } }),
    { mode: 0o600 },
  )
  const config = await HostConfig.open(dataDir)
  await config.updateProviders(draft => {
    draft.push({
      id: 'lab',
      name: 'Lab',
      kind: 'openai-compatible',
      baseURL: 'https://lab.example/v1',
      apiKey: '',
      enabled: true,
      models: ['m'],
      defaultModel: 'm',
    })
  })
  return dataDir
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  return child.pid!
}

/**
 * Processes that each take the data-dir lock when told `go` and give it back when told `release`, so a test can start
 * them all at the same moment.
 */
async function lockContenders(directory: string, dataDir: string, count: number) {
  const script = join(directory, 'contender.mts')
  await writeFile(
    script,
    `import { createInterface } from 'node:readline'
import { acquireDataDirLock } from ${JSON.stringify(pathToFileURL(resolve('apps/host/src/host-state.ts')).href)}
let lock
createInterface({ input: process.stdin }).on('line', async line => {
  if (line === 'go') {
    try { lock = await acquireDataDirLock(${JSON.stringify(dataDir)}, 'cli'); console.log('held ' + lock.instanceId) }
    catch (error) { console.log('refused ' + error.code) }
  } else if (line === 'release') { await lock.release(); console.log('released') }
})
console.log('ready')
`,
  )
  return Promise.all(
    Array.from({ length: count }, async () => {
      const child: ChildProcess = spawn(process.execPath, ['--import', TSX_LOADER, script], {
        cwd: directory,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin!.end()
          await once(child, 'exit')
        }
      })
      let stderr = ''
      child.stderr!.on('data', chunk => {
        stderr += String(chunk)
      })
      const lines: string[] = []
      let waiting: ((line: string) => void) | undefined
      const deliver = (line: string) => {
        if (waiting) {
          const done = waiting
          waiting = undefined
          done(line)
        } else lines.push(line)
      }
      createInterface({ input: child.stdout! }).on('line', deliver)
      child.once('exit', code => deliver(`exited ${code} ${stderr}`))
      const next = () =>
        lines.length > 0
          ? Promise.resolve(lines.shift()!)
          : new Promise<string>(done => {
              waiting = done
            })
      expect(await next()).toBe('ready')
      return { send: (line: string) => child.stdin!.write(`${line}\n`), next }
    }),
  )
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')] as const)))
}

describe('latch CLI', () => {
  it('uses the last Host startup context for offline folder checks and requires an explicit start directory before the first boot', async () => {
    const root = await realpath(await temporaryDirectory())
    const start = join(root, 'actual-start')
    const agents = join(root, 'actual-agents')
    const code = join(root, 'actual-code')
    const tls = join(root, 'tls')
    await Promise.all([start, agents, code, tls].map(path => mkdir(path)))
    const dataDir = join(root, 'data')
    const t = await startTestHost({ dataDir, workspaceRoot: start, agentsDir: agents, codeRoot: code })
    cleanups.push(() => t.close())
    await t.close()
    const attempts = [start, agents, code]
    for (const path of attempts) {
      const attempt = cli({ cwd: root })
      expect(await attempt.latch('project', 'add', path, '--yes', '--data-dir', dataDir)).toBe(1)
      expect(attempt.output.stderr).toContain('没有加入')
    }
    const keyPath = join(tls, 'key.pem')
    await writeFile(keyPath, 'fixture path only')
    await writeProjectContext(dataDir, { workspaceRoot: start, agentsDir: agents, codeRoot: code, tlsKeyPath: keyPath })
    const blocked = cli({ cwd: root })
    expect(await blocked.latch('project', 'add', tls, '--yes', '--data-dir', dataDir)).toBe(1)
    expect(blocked.output.stderr).toContain('没有加入')
    const mismatched = cli({ cwd: root })
    expect(await mismatched.latch('project', 'add', start, '--yes', '--workspace', tls, '--data-dir', dataDir)).toBe(1)
    expect(mismatched.output.stderr).toContain('--workspace 与上次 Host 的启动目录不同')
    expect((await HostConfig.open(dataDir)).settings().workspaces).toEqual([])
    const fresh = await stoppedDataDir()
    const missing = cli({ cwd: root })
    expect(await missing.latch('project', 'add', tls, '--yes', '--data-dir', fresh)).toBe(1)
    expect(missing.output.stderr).toContain('--workspace <启动目录>')
    expect(await cli({ cwd: root }).latch('project', 'add', tls, '--yes', '--workspace', start, '--data-dir', fresh)).toBe(0)
  })

  it('lists and revokes devices over host.sock while the Host runs', async () => {
    const t = await runningHost()
    const phone = await t.enroll({ name: '测试手机' })
    const { output, latch } = cli()
    expect(await latch('device', 'list', '--data-dir', t.dataDir)).toBe(0)
    expect(output.stdout).toMatch(/ID\s+名称\s+连接方式\s+权限\s+状态\s+最近使用/u)
    expect(output.stdout).toContain(phone.id)
    expect(output.stdout).toMatch(/测试手机\s+回环端口\s/u)
    const json = cli()
    expect(await json.latch('device', 'list', '--json', '--data-dir', t.dataDir)).toBe(0)
    expect((JSON.parse(json.output.stdout) as Device[]).map(device => device.id)).toEqual([phone.id])
    const revoke = cli()
    expect(await revoke.latch('device', 'revoke', phone.id, '--data-dir', t.dataDir)).toBe(0)
    expect(t.host.security.devices.get(phone.id)?.status).toBe('revoked')
    expect((await auditActions(t.dataDir)).find(record => record.action === 'device.revoked')).toMatchObject({
      actor: { listener: 'unix', via: 'cli' },
    })
    const missing = cli()
    expect(await missing.latch('device', 'list', '--data-dir', await temporaryDirectory())).toBe(1)
    expect(missing.output.stderr).toContain('没有可确认的运行中 Host')
  })

  it('prints the traffic counters of the running Host as a table, or as JSON', async () => {
    const t = await runningHost()
    const browser = await t.enroll({ name: '测试浏览器' })
    await browser.json('snapshot')
    const { output, latch } = cli()
    expect(await latch('traffic', '--data-dir', t.dataDir)).toBe(0)
    expect(output.stdout).toMatch(/^统计自 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC/u)
    expect(output.stdout).toMatch(/类别\s+次数\s+字节\s+平均\s+≤256B\s+≤1KiB\s+≤4KiB\s+≤16KiB\s+≤64KiB\s+≤256KiB\s+≤1MiB\s+≤4MiB\s+更大/u)
    expect(output.stdout).toMatch(/快照响应\s+1\s+[\d.]+ (?:B|KiB)/u)
    expect(output.stdout).not.toContain('测试浏览器')
    const json = cli()
    expect(await json.latch('traffic', '--json', '--data-dir', t.dataDir)).toBe(0)
    expect(JSON.parse(json.output.stdout)).toMatchObject({ kinds: { snapshot: { count: 1 } }, sessions: [], connections: [] })
    const missing = cli()
    expect(await missing.latch('traffic', '--data-dir', await temporaryDirectory())).toBe(1)
    expect(missing.output.stderr).toContain('没有可确认的运行中 Host')
  })

  it('prints an invitation only to a terminal or a 0600 file', async () => {
    const t = await runningHost({ tls: true })
    const refused = cli()
    expect(await refused.latch('device', 'invite', '--data-dir', t.dataDir)).toBe(1)
    expect(refused.output.stderr).toContain('--code-file')
    const directory = await temporaryDirectory()
    const file = cli({ cwd: directory })
    expect(await file.latch('device', 'invite', '--scopes', 'view,run', '--code-file', 'invite.txt', '--data-dir', t.dataDir)).toBe(0)
    expect(file.output.stdout).not.toMatch(/lpi1-/)
    expect(await readFile(join(directory, 'invite.txt'), 'utf8')).toMatch(
      new RegExp(`^${t.host.tlsOrigin}/link/#pair=lpi1-[A-Z2-7]{26}\\n$`),
    )
    expect((await stat(join(directory, 'invite.txt'))).mode & 0o777).toBe(0o600)
    const tty = cli({ tty: true })
    expect(await tty.latch('device', 'invite', '--data-dir', t.dataDir)).toBe(0)
    expect(tty.output.stdout).toContain('#pair=lpi1-')
    expect(
      await cli().latch('device', 'invite', '--scopes', 'view,secrets', '--code-file', join(directory, 'x'), '--data-dir', t.dataDir),
    ).toBe(1)
    // A browser on this computer gets a loopback link, also only on a terminal or in a 0600 file.
    const loopback = cli({ cwd: directory })
    expect(await loopback.latch('device', 'invite', '--loopback', '--code-file', 'browser.txt', '--data-dir', t.dataDir)).toBe(0)
    expect(loopback.output.stdout).not.toMatch(/lpi1-/)
    const link = await readFile(join(directory, 'browser.txt'), 'utf8')
    expect(link).toMatch(new RegExp(`^${t.host.loopbackOrigin}/link/#pair=lpi1-[A-Z2-7]{26}\\n$`))
    // Without --scopes it offers what the desktop app's link offers, 管理此 Host included.
    const admin = ['view', 'run', 'approve:standard', 'admin'] as const
    const browser = await t.enroll({ invitation: new URL(link.trim()).hash.slice('#pair='.length), scopes: [...admin] })
    expect(browser.device).toMatchObject({ listener: 'loopback-tcp', scopes: admin, pairedBy: { method: 'invitation' } })
    const browserTty = cli({ tty: true })
    expect(await browserTty.latch('device', 'invite', '--loopback', '--data-dir', t.dataDir)).toBe(0)
    expect(browserTty.output.stdout).toContain(`在这台电脑的浏览器中打开：${t.host.loopbackOrigin}/link/#pair=lpi1-`)
  })

  it('creates an offline enrollment code only while the Host is stopped, and the Host accepts it once', async () => {
    const t = await runningHost({ dataDir: join(await temporaryDirectory(), 'data') })
    const busy = cli({ tty: true })
    expect(await busy.latch('device', 'enroll', '--offline', '--data-dir', t.dataDir)).toBe(1)
    expect(busy.output.stderr).toContain('Host 正在运行，请先停止（pnpm stop）')
    const { dataDir } = t
    await t.close()
    await rm(join(dataDir, 'host.json'), { force: true })
    const directory = await temporaryDirectory()
    const stopped = cli({ cwd: directory })
    expect(await stopped.latch('device', 'enroll', '--offline', '--code-file', 'code.txt', '--data-dir', dataDir)).toBe(0)
    expect(stopped.output.stderr).toContain('离线登记依赖本机此刻没有恶意的同用户进程')
    expect(stopped.output.stdout).toContain(
      '启动 Latch 桌面端（pnpm desktop）后，在它的登记页面填写离线登记码。浏览器与手机不接受离线登记码。',
    )
    const code = (await readFile(join(directory, 'code.txt'), 'utf8')).trim()
    expect(code).toMatch(/^lpo1-[A-Z2-7]{26}$/)
    expect((await stat(join(directory, 'code.txt'))).mode & 0o777).toBe(0o600)
    expect((await auditActions(dataDir)).at(-1)).toMatchObject({ action: 'offline.ticket.created', actor: { listener: 'cli', via: 'cli' } })

    const again = await startTestHost({ dataDir, presenceMode: 'unavailable' })
    cleanups.push(() => again.close())
    // Only the desktop app's socket takes the code; a browser's loopback port is refused without using it up.
    await expect(again.enroll({ offlineCode: code })).rejects.toMatchObject({ status: 403, body: { error: 'offline-code-invalid' } })
    const device = await again.enroll({ listener: 'unix', offlineCode: code })
    expect(device.device).toMatchObject({ listener: 'unix', pairedBy: { method: 'offline' } })
    await expect(again.enroll({ listener: 'unix', offlineCode: code })).rejects.toMatchObject({
      status: 403,
      body: { error: 'offline-code-invalid' },
    })
  })

  it('sets a provider key offline, bound to the provider origin and path, confirming its address, audited', async () => {
    const dataDir = join(await temporaryDirectory(), 'data')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const config = await HostConfig.open(dataDir)
    await config.updateProviders(draft => {
      draft.push({
        id: 'lab',
        name: 'Lab',
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: '',
        enabled: true,
        models: ['m'],
        defaultModel: 'm',
      })
    })
    // Piped input confirms an address only when --expect-url names it; the facts are printed before the key is read.
    const refused = cli({ secret: 'sk-offline-secret\n' })
    expect(await refused.latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(1)
    expect(refused.output.stderr).toContain('非交互环境中不能确认地址')
    expect(refused.output.secrets).toBe(0)
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('')
    const { output, latch } = cli({ secret: 'sk-offline-secret\n' })
    expect(await latch('provider', 'set-key', 'lab', '--data-dir', dataDir, '--expect-url', 'http://127.0.0.1:9/v1/')).toBe(0)
    expect(output.stdout).toContain('  地址：http://127.0.0.1:9/v1\n')
    expect(output.stdout).toContain('  出站许可：允许 Host 访问 127.0.0.1:9（这台电脑上的地址）\n')
    expect(output.stdout).toContain('只发往 http://127.0.0.1:9/v1')
    expect(output.stdout).toContain('已确认模型服务地址 http://127.0.0.1:9/v1。')
    expect(output.stdout).toContain('已允许 Host 访问 127.0.0.1:9。')
    expect(output.stdout + output.stderr).not.toContain('sk-offline-secret')
    expect((await HostConfig.open(dataDir)).provider('lab')).toMatchObject({
      apiKey: 'sk-offline-secret',
      keyOrigin: 'http://127.0.0.1:9',
      keyPath: '/v1',
    })
    const policy = JSON.parse(await readFile(join(dataDir, 'policy.json'), 'utf8')) as {
      confirmedAddresses: string[]
      hostEgressAllow: string[]
    }
    expect(policy).toMatchObject({ confirmedAddresses: ['http://127.0.0.1:9/v1'], hostEgressAllow: ['127.0.0.1:9'] })
    // The key's record, then the policy change that confirms its address; both offline.
    expect((await auditActions(dataDir)).slice(-2)).toMatchObject([
      { action: 'provider.secret.set', stepup: 'offline', actor: { listener: 'cli' } },
      {
        action: 'policy.changed',
        stepup: 'offline',
        actor: { listener: 'cli' },
        detail: { fields: ['confirmedAddresses', 'hostEgressAllow'] },
      },
    ])
    expect(await cli({ secret: 'x' }).latch('provider', 'set-key', 'missing', '--data-dir', dataDir)).toBe(1)
    expect(await cli({ secret: '' }).latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(1)
  })

  it('confirms a model-service address offline once, and says when there is nothing to confirm', async () => {
    const dataDir = join(await temporaryDirectory(), 'data')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const service = (id: string, baseURL: string) => ({
      id,
      name: id,
      kind: 'openai-compatible' as const,
      baseURL,
      apiKey: '',
      enabled: true,
      models: ['m'],
      defaultModel: 'm',
    })
    await (
      await HostConfig.open(dataDir)
    ).updateProviders(draft => {
      draft.push(service('ollama', 'http://127.0.0.1:11434/v1'), service('openai', 'https://api.openai.com/v1'))
    })
    const first = cli({ typed: true, answer: 'y' })
    expect(await first.latch('provider', 'confirm', 'ollama', '--data-dir', dataDir)).toBe(0)
    expect(first.output.asked).toHaveLength(1)
    expect(first.output.asked[0]!.shown).toContain('  地址：http://127.0.0.1:11434/v1\n')
    expect(first.output.asked[0]!.shown).toContain('  出站许可：允许 Host 访问 127.0.0.1:11434（这台电脑上的地址）\n')
    expect(first.output.stdout).toContain('已确认 ollama 的地址 http://127.0.0.1:11434/v1，启动 Host 后可以使用。')
    expect(first.output.stdout).toContain('已允许 Host 访问 127.0.0.1:11434。')
    const again = cli({ typed: true, answer: 'y' })
    expect(await again.latch('provider', 'confirm', 'ollama', '--data-dir', dataDir)).toBe(0)
    expect(again.output.stdout).toContain('ollama 的地址 http://127.0.0.1:11434/v1 已经确认过。')
    expect(again.output.asked).toEqual([])
    const preset = cli()
    expect(await preset.latch('provider', 'confirm', 'openai', '--data-dir', dataDir)).toBe(0)
    expect(preset.output.stdout).toContain('https://api.openai.com:443 是预置服务商的地址，不需要确认。')
    expect(await cli().latch('provider', 'confirm', 'missing', '--data-dir', dataDir)).toBe(1)
    const policy = JSON.parse(await readFile(join(dataDir, 'policy.json'), 'utf8')) as { confirmedAddresses: string[] }
    expect(policy.confirmedAddresses).toEqual(['http://127.0.0.1:11434/v1'])
    expect((await auditActions(dataDir)).filter(record => record.action === 'policy.changed')).toHaveLength(1)
  })

  it('shows what an offline confirmation adds and writes nothing unless it is approved', async () => {
    const dataDir = await stoppedDataDir()
    await (
      await HostConfig.open(dataDir)
    ).updateProviders(draft => {
      draft.push({
        id: 'ollama',
        name: 'Ollama\u202e',
        kind: 'openai-compatible',
        baseURL: 'http://192.168.1.1/cgi-bin',
        apiKey: '',
        enabled: true,
        models: ['m'],
        defaultModel: 'm',
      })
    })
    const policyFile = join(dataDir, 'policy.json')
    const before = await readFile(policyFile, 'utf8')
    const preview = [
      '将确认模型服务「Ollama\\u{202E}」（ollama）的地址：',
      '  地址：http://192.168.1.1/cgi-bin',
      '  确认的范围：http://192.168.1.1:80/cgi-bin（只有这个源与路径；同一源下的其他路径要另行确认）',
      '  出站许可：允许 Host 访问 192.168.1.1:80（局域网或私网地址）',
      '  注意：这个地址不使用 HTTPS，发给它的内容会以明文经过网络。',
    ]
    const refusals: Array<[ReturnType<typeof cli>, string[], string]> = [
      // Piped input never answers; the facts are still printed, so a log shows what was not confirmed.
      [cli(), [], '非交互环境中不能确认地址'],
      [cli({ typed: true, answer: 'n' }), [], '已取消，没有修改任何设置'],
      [cli({ typed: true, answer: '' }), [], '已取消，没有修改任何设置'],
      [
        cli(),
        ['--expect-url', 'http://192.168.1.1/other'],
        '--expect-url 与模型服务的地址不一致（服务的地址是 http://192.168.1.1:80/cgi-bin）',
      ],
      [cli(), ['--expect-url', 'http://192.168.1.1:80/'], '--expect-url 与模型服务的地址不一致'],
    ]
    for (const [run, extra, reason] of refusals) {
      expect(await run.latch('provider', 'confirm', 'ollama', '--data-dir', dataDir, ...extra)).toBe(1)
      for (const line of preview) expect(run.output.stdout).toContain(`${line}\n`)
      expect(run.output.stderr).toContain(reason)
      expect(await readFile(policyFile, 'utf8')).toBe(before)
    }
    expect(refusals[0]![0].output.asked).toEqual([])
    expect(await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8').catch(() => '')).not.toContain('policy.changed')

    const approved = cli({ typed: true, answer: ' Y ' })
    expect(await approved.latch('provider', 'confirm', 'ollama', '--data-dir', dataDir)).toBe(0)
    expect(approved.output.asked.map(item => item.prompt)).toEqual(['确认以上地址？输入 y 确认，其他任意内容取消：'])
    for (const line of preview) expect(approved.output.asked[0]!.shown).toContain(`${line}\n`)
    const policy = JSON.parse(await readFile(policyFile, 'utf8')) as { confirmedAddresses: string[]; hostEgressAllow: string[] }
    expect(policy).toMatchObject({ confirmedAddresses: ['http://192.168.1.1:80/cgi-bin'], hostEgressAllow: ['192.168.1.1:80'] })
    expect((await auditActions(dataDir)).filter(record => record.action === 'policy.changed')).toMatchObject([
      { stepup: 'offline', actor: { listener: 'cli' } },
    ])
  })

  it('names the address a key confirms in the key prompt, and confirms nothing piped without --expect-url', async () => {
    const dataDir = await stoppedDataDir()
    const typed = cli({ typed: true, secret: 'sk-typed\n' })
    const prompts: string[] = []
    typed.io.readSecret = async prompt => {
      prompts.push(prompt)
      return 'sk-typed\n'
    }
    expect(await typed.latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(0)
    expect(prompts).toEqual(['Lab 的 API Key（只发往 https://lab.example:443/v1；保存即确认上面的地址）：'])
    expect(typed.output.stdout).toContain('  确认的范围：https://lab.example:443/v1（只有这个源与路径；同一源下的其他路径要另行确认）\n')
    expect(typed.output.stdout).toContain('已确认模型服务地址 https://lab.example:443/v1。')
    // Confirmed now: a new key asks nothing more and names no address to confirm.
    const replaced = cli({ secret: 'sk-replaced\n' })
    expect(await replaced.latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(0)
    expect(replaced.output.stdout).not.toContain('将确认模型服务')
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('sk-replaced')
  })

  it('refuses every offline command while a starting Host holds the data-dir lock, before host.json exists', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const host = await acquireDataDirLock(dataDir, 'host')
    cleanups.push(() => host.release())
    const before = await snapshot(dataDir)
    const commands = [
      ['device', 'enroll', '--offline', '--code-file', 'code.txt'],
      ['provider', 'set-key', 'lab'],
      ['presence', 'status'],
      ['presence', 'test'],
      ...(process.platform === 'darwin' ? [['presence', 'repin']] : []),
    ]
    for (const command of commands) {
      const { output, latch } = cli({ cwd: directory, secret: 'sk-during-startup\n' })
      expect(await latch(...command, '--data-dir', dataDir)).toBe(1)
      expect(output.stderr).toContain('这个数据目录已有 Host 在运行或正在启动')
      expect(output.stderr).toContain(
        `请先停止它（pnpm stop），或使用其他 --data-dir；如果确认没有 Host 在运行，删除锁文件 ${join(dataDir, 'host.lock')} 后重试。`,
      )
    }
    expect(await snapshot(dataDir)).toEqual(before)
    await expect(lstat(join(directory, 'code.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    await host.release()
    expect(await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'code.txt', '--data-dir', dataDir)).toBe(0)
    await expect(lstat(join(dataDir, 'host.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('takes over a lock whose process is gone, and never one it cannot read or that a live command holds', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const lockPath = join(dataDir, 'host.lock')
    await writeFile(lockPath, JSON.stringify({ pid: await deadPid(), instanceId: randomUUID(), role: 'host' }), { mode: 0o600 })
    expect(await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'one.txt', '--data-dir', dataDir)).toBe(0)
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'cli' }), { mode: 0o600 })
    const busy = cli({ cwd: directory })
    expect(await busy.latch('device', 'enroll', '--offline', '--code-file', 'two.txt', '--data-dir', dataDir)).toBe(1)
    expect(busy.output.stderr).toContain('另一个 latch 命令正在使用这个数据目录')
    expect(busy.output.stderr).toContain(`删除锁文件 ${lockPath} 后重试`)
    await rm(lockPath)

    for (const plant of [() => writeFile(lockPath, '{"pid":', { mode: 0o600 }), () => symlink(join(directory, 'elsewhere'), lockPath)]) {
      await plant()
      const invalid = cli({ cwd: directory, secret: 'sk-x\n' })
      expect(await invalid.latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(1)
      expect(invalid.output.stderr).toContain(
        `数据目录锁 ${lockPath} 无法读取。请先停止 Host（pnpm stop）；如果确认没有 Host 或 latch 命令在使用这个目录，删除该文件后重试。`,
      )
      expect((await lstat(lockPath)).isFile() || (await lstat(lockPath)).isSymbolicLink()).toBe(true)
      await rm(lockPath)
    }
    await expect(lstat(join(directory, 'elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('')

    const held = await acquireDataDirLock(dataDir, 'host')
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: process.pid,
      instanceId: held.instanceId,
      role: 'host',
      bootTime: await bootTime(),
    })
    await expect(acquireDataDirLock(dataDir, 'host')).rejects.toMatchObject({
      status: 409,
      code: 'data-dir-locked',
      details: { role: 'host' },
    })
    await held.release()
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads the boot time from the kernel', async () => {
    const boot = await bootTime()
    if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])
      expect(boot).toBe(Number(/\bsec = (\d+)/u.exec(stdout)![1]))
    } else if (process.platform === 'linux') {
      expect(boot).toBe(Number(/^btime (\d+)$/mu.exec(await readFile('/proc/stat', 'utf8'))![1]))
    }
    expect(Math.abs(boot - (Date.now() / 1000 - uptime()))).toBeLessThan(5)
  })

  it('takes over a lock written before this boot even when its pid is alive again, and holds one from this boot', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const lockPath = join(dataDir, 'host.lock')
    const boot = await bootTime()
    // This test process stands in for whatever process reused the recorded pid.
    const plant = (record: Record<string, unknown>) =>
      writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'host', ...record }), { mode: 0o600 })

    await plant({ bootTime: boot - 3_600 })
    expect(
      await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'after-reboot.txt', '--data-dir', dataDir),
    ).toBe(0)
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    for (const record of [{ bootTime: boot }, { bootTime: boot - 2 }, {}]) {
      await plant(record)
      const held = cli({ cwd: directory })
      expect(await held.latch('device', 'enroll', '--offline', '--code-file', 'held.txt', '--data-dir', dataDir)).toBe(1)
      expect(held.output.stderr).toContain(`这个数据目录已有 Host 在运行或正在启动（进程 ${process.pid}）`)
      expect(held.output.stderr).toContain(`删除锁文件 ${lockPath} 后重试`)
      expect((await lstat(lockPath)).isFile()).toBe(true)
      await rm(lockPath)
    }
    await expect(lstat(join(directory, 'held.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets exactly one of several processes take over a stale lock at the same moment', async () => {
    const directory = await temporaryDirectory()
    const dataDir = join(directory, 'data')
    await mkdir(dataDir, { mode: 0o700 })
    const lockPath = join(dataDir, 'host.lock')
    const contenders = await lockContenders(directory, dataDir, 8)
    const boot = await bootTime()
    const gone = await deadPid()
    // A process that has exited, and a live pid (this test process) recorded before the last reboot.
    const stale = [{ pid: gone }, { pid: process.pid, bootTime: boot - 3_600 }]
    for (let trial = 0; trial < 6; trial++) {
      await writeFile(lockPath, JSON.stringify({ instanceId: randomUUID(), role: 'host', ...stale[trial % 2] }), { mode: 0o600 })
      for (const contender of contenders) contender.send('go')
      const outcomes = await Promise.all(contenders.map(contender => contender.next()))
      const holders = outcomes.flatMap((outcome, index) => (outcome.startsWith('held ') ? [{ index, instanceId: outcome.slice(5) }] : []))
      expect({ trial, holders: holders.length, refused: outcomes.filter(outcome => outcome === 'refused data-dir-locked').length }).toEqual(
        { trial, holders: 1, refused: 7 },
      )
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ instanceId: holders[0]!.instanceId, role: 'cli' })
      contenders[holders[0]!.index]!.send('release')
      expect(await contenders[holders[0]!.index]!.next()).toBe('released')
      expect(await readdir(dataDir)).toEqual([])
    }
  }, 60_000)

  it('clears a takeover left by a process that died or hung, and waits for one in progress', async () => {
    const dataDir = join(await temporaryDirectory(), 'data')
    await mkdir(dataDir, { mode: 0o700 })
    const lockPath = join(dataDir, 'host.lock')
    const guard = join(dataDir, '.host-lock-takeover')
    const plantStale = () =>
      writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'host', bootTime: 1 }), { mode: 0o600 })
    const plantGuard = async (pid: number) => {
      await mkdir(guard, { mode: 0o700 })
      const marker = join(guard, randomUUID())
      await writeFile(marker, JSON.stringify({ pid }), { mode: 0o600 })
      return marker
    }

    // A takeover in progress (its process is alive and it is recent) is waited for, and the stale lock stays.
    await plantStale()
    const marker = await plantGuard(process.pid)
    const before = await readFile(lockPath, 'utf8')
    await expect(acquireDataDirLock(dataDir, 'cli')).rejects.toMatchObject({
      status: 409,
      code: 'data-dir-locked',
      message: expect.stringContaining(`无法取得数据目录锁 ${lockPath}，请稍后重试`),
    })
    expect(await readFile(lockPath, 'utf8')).toBe(before)
    expect(await readdir(guard)).toHaveLength(1)

    // The same marker once it is older than any takeover takes, as when the pid was reused.
    const old = new Date(Date.now() - 31_000)
    await utimes(marker, old, old)
    const afterHang = await acquireDataDirLock(dataDir, 'cli')
    await afterHang.release()
    expect(await readdir(dataDir)).toEqual([])

    // A takeover whose process has exited, and one that stopped after emptying its directory.
    for (const leftover of [
      async () => {
        await plantGuard(await deadPid())
      },
      () => mkdir(guard, { mode: 0o700 }),
    ]) {
      await plantStale()
      await leftover()
      const lock = await acquireDataDirLock(dataDir, 'cli')
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ instanceId: lock.instanceId, role: 'cli' })
      await lock.release()
      expect(await readdir(dataDir)).toEqual([])
    }

    // What a process killed part-way leaves next to the lock is removed by the next holder once it is old enough, even
    // when no takeover follows.
    const left = (suffix: string) => `.host-lock-${randomUUID()}.${suffix}`
    const [created, claimed, movedAside, recent] = [left('new'), left('claim'), left('stale'), left('new')]
    await writeFile(join(dataDir, created), '{}', { mode: 0o600 })
    await mkdir(join(dataDir, claimed, randomUUID()), { recursive: true, mode: 0o700 })
    await writeFile(join(dataDir, movedAside), '{}', { mode: 0o600 })
    await writeFile(join(dataDir, recent), '{}', { mode: 0o600 })
    for (const name of [created, claimed, movedAside]) await utimes(join(dataDir, name), old, old)
    await plantGuard(await deadPid())
    const sweeping = await acquireDataDirLock(dataDir, 'cli')
    await sweeping.release()
    expect(await readdir(dataDir)).toEqual([recent])
  })

  it('counts a host.json it cannot read as a running Host unless the pid it records is gone', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const older = (pid: number) =>
      JSON.stringify({ pid, origin: 'http://127.0.0.1:1', instanceId: randomUUID(), startedAt: new Date().toISOString() })
    await writeFile(join(dataDir, 'host.json'), older(process.pid), { mode: 0o600 })
    const running = cli({ cwd: directory })
    expect(await running.latch('device', 'enroll', '--offline', '--code-file', 'a.txt', '--data-dir', dataDir)).toBe(1)
    expect(running.output.stderr).toContain('Host 正在运行，请先停止（pnpm stop）')
    await writeFile(join(dataDir, 'host.json'), '{"version":', { mode: 0o600 })
    const damaged = cli({ cwd: directory, secret: 'sk-x\n' })
    expect(await damaged.latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(1)
    expect(damaged.output.stderr).toContain('不能确认 Host 已停止')
    expect(await snapshot(join(dataDir, 'audit'))).toEqual({})
    await writeFile(join(dataDir, 'host.json'), older(await deadPid()), { mode: 0o600 })
    expect(await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'b.txt', '--data-dir', dataDir)).toBe(0)
  })

  it('keeps the data dir locked while a key is typed, and saves nothing if a Host without the lock started meanwhile', async () => {
    const dataDir = await stoppedDataDir()
    const output = { stdout: '', stderr: '' }
    let lockDuringPrompt: unknown
    let host: TestHost | undefined
    const io: CliIO = {
      stdout: {
        write: (text: string) => {
          output.stdout += text
        },
      },
      stderr: {
        write: (text: string) => {
          output.stderr += text
        },
      },
      stdin: {},
      readLine: async () => '',
      env: {},
      cwd: dataDir,
      async readSecret() {
        lockDuringPrompt = await acquireDataDirLock(dataDir, 'host').then(
          async lock => {
            await lock.release()
            return 'acquired'
          },
          (error: unknown) => error,
        )
        // An in-process Host takes no lock, like a Host from an older build.
        host = await runningHost({ dataDir })
        return 'sk-typed-while-starting\n'
      },
    }
    expect(await runLatch(['provider', 'set-key', 'lab', '--data-dir', dataDir, '--expect-url', 'https://lab.example/v1'], io)).toBe(1)
    expect(lockDuringPrompt).toMatchObject({ code: 'data-dir-locked', details: { role: 'cli' } })
    expect(output.stderr).toContain('Host 正在运行，请先停止（pnpm stop）')
    expect(output.stdout + output.stderr).not.toContain('sk-typed-while-starting')
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('')
    expect((await auditActions(dataDir)).map(record => record.action)).not.toContain('provider.secret.set')
    await host!.enroll()
    expect(await verifyAuditFile(join(dataDir, 'audit', 'audit.jsonl'))).toMatchObject({ ok: true })
  })

  it('starts pnpm latch deaf to SIGUSR1, so no debugger opens in the process holding a key that is being typed', async () => {
    const pnpm = pnpmFromEnvironment()
    if (!pnpm) throw new Error('run this test through pnpm (pnpm test) so npm_execpath names the pinned pnpm')
    const dataDir = await stoppedDataDir()
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^LATCH_/u.test(name)))
    const args = ['--silent', 'latch', 'provider', 'set-key', 'lab', '--data-dir', dataDir, '--expect-url', 'https://lab.example/v1']
    const child = spawn(pnpm.file, [...pnpm.args, ...args], {
      cwd: resolve(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      await exited
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.stdout.resume()
    child.stdin.write('sk-typed-')
    // The command holds the data-dir lock while it reads the key; the lock names the process, below pnpm and its shell.
    const holder = await vi.waitFor(
      async () => {
        const lock = await readDataDirLock(dataDir)
        expect(lock).toMatchObject({ held: true, holder: { role: 'cli' } })
        return lock!.holder!
      },
      { timeout: 20_000, interval: 50 },
    )
    // SIGUSR1 is what process._debugProcess sends: without --disable-sigusr1 it opens an inspector in that process.
    process.kill(holder.pid, 'SIGUSR1')
    await delay(300)
    child.stdin.end('slowly\n')
    expect(await exited).toEqual([0, null])
    expect(stderr).not.toMatch(/debugger|inspector/iu)
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('sk-typed-slowly')
  }, 30_000)

  it('runs presence test against a running Host without writing its audit log or policy', async () => {
    const t = await runningHost()
    const policyPath = join(t.dataDir, 'policy.json')
    // An edit made outside Latch: a second policy store on this data dir would audit it and fork the Host's chain.
    const policy = JSON.parse(await readFile(policyPath, 'utf8'))
    await writeFile(policyPath, JSON.stringify({ ...policy, presence: { ...policy.presence, backend: 'none' } }, null, 2), { mode: 0o600 })
    const files = () => Promise.all([readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'), readFile(policyPath, 'utf8')])
    const before = await files()
    const { output, latch } = cli()
    expect(await latch('presence', 'test', '--data-dir', t.dataDir)).toBe(1)
    expect(output.stderr).toContain('本机确认不可用')
    expect(await files()).toEqual(before)
    await t.enroll()
    expect(await verifyAuditFile(join(t.dataDir, 'audit', 'audit.jsonl'))).toMatchObject({ ok: true })
  })

  it('writes a code only to a file it creates: never through a symlink, over an existing file or in a shared directory', async () => {
    const directory = await temporaryDirectory()
    const victim = join(directory, 'victim-rc')
    await writeFile(victim, 'export PATH=/usr/bin\n', { mode: 0o644 })
    await symlink(victim, join(directory, 'linked.txt'))
    await symlink(join(directory, 'created-elsewhere'), join(directory, 'dangling.txt'))
    await writeFile(join(directory, 'existing.txt'), 'keep\n', { mode: 0o600 })
    const dataDir = await stoppedDataDir()
    for (const name of ['linked.txt', 'dangling.txt', 'existing.txt']) {
      const { output, latch } = cli({ cwd: directory })
      expect(await latch('device', 'enroll', '--offline', '--code-file', name, '--data-dir', dataDir)).toBe(1)
      expect(output.stderr).toContain('已存在')
      expect(output.stdout + output.stderr).not.toMatch(/lpo1-/u)
    }
    expect(await readFile(victim, 'utf8')).toBe('export PATH=/usr/bin\n')
    expect((await stat(victim)).mode & 0o777).toBe(0o644)
    await expect(lstat(join(directory, 'created-elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('keep\n')
    // A refused path mints no code.
    await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const shared = join(directory, 'shared')
    await mkdir(shared)
    await chmod(shared, 0o777)
    const open = cli({ cwd: directory })
    expect(await open.latch('device', 'enroll', '--offline', '--code-file', join(shared, 'code.txt'), '--data-dir', dataDir)).toBe(1)
    expect(open.output.stderr).toContain('其他用户也能写入')
    await expect(lstat(join(shared, 'code.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    const missing = cli({ cwd: directory })
    expect(
      await missing.latch('device', 'enroll', '--offline', '--code-file', join(directory, 'absent', 'code.txt'), '--data-dir', dataDir),
    ).toBe(1)
    expect(missing.output.stderr).toContain('无法访问目录')
    await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)(
    'writes a code file only into a directory this user owns, or a sticky one root owns',
    async () => {
      const dataDir = await stoppedDataDir()
      // The root directory belongs to root and has no sticky bit: another owner could swap the file.
      const foreign = cli()
      expect(
        await foreign.latch('device', 'enroll', '--offline', '--code-file', `/lt-cli-${randomUUID()}.txt`, '--data-dir', dataDir),
      ).toBe(1)
      expect(foreign.output.stderr).toContain('/ 不属于当前用户')
      await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })

      const shared = await realpath('/tmp').catch(() => undefined)
      const info = shared ? await stat(shared) : undefined
      const listing = shared && process.platform === 'darwin' ? (await run('/bin/ls', ['-led', shared])).stdout.trim().split('\n') : []
      if (!shared || info?.uid !== 0 || (info.mode & 0o1000) === 0 || listing.length > 1) return
      const file = join(shared, `lt-cli-${randomUUID()}.txt`)
      cleanups.push(() => rm(file, { force: true }))
      expect(await cli().latch('device', 'enroll', '--offline', '--code-file', file, '--data-dir', dataDir)).toBe(0)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await readFile(file, 'utf8')).toMatch(/^lpo1-[A-Z2-7]{26}\n$/u)
    },
  )

  it.runIf(process.platform === 'darwin')('refuses a code-file directory with access-control entries, whatever they grant', async () => {
    const directory = await temporaryDirectory()
    const dataDir = await stoppedDataDir()
    // Entries that let others swap the file, that a new file would inherit, and a deny entry like the one on home folders.
    for (const [name, entry] of [
      ['writable', 'everyone allow add_file,delete_child'],
      ['inherited', 'everyone allow read,file_inherit'],
      ['denying', 'everyone deny delete'],
    ] as const) {
      const target = join(directory, name)
      await mkdir(target, { mode: 0o700 })
      await run('/bin/chmod', ['+a', entry, target])
      cleanups.push(async () => {
        await run('/bin/chmod', ['-N', target]).catch(() => {})
      })
      const { output, latch } = cli({ cwd: directory })
      expect(await latch('device', 'enroll', '--offline', '--code-file', join(target, 'code.txt'), '--data-dir', dataDir)).toBe(1)
      expect(output.stderr).toContain(`${target} 带有访问控制列表（ACL）`)
      await expect(lstat(join(target, 'code.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adds projects and folders only while the Host is stopped, with the same rules and audit, and the Host takes them up', async () => {
    const dataDir = await stoppedDataDir()
    const root = await realpath(await temporaryDirectory())
    for (const name of ['api', 'api/lib', 'web', 'docs']) await mkdir(join(root, name), { recursive: true })
    await writeProjectContext(dataDir, { workspaceRoot: join(root, 'start'), agentsDir: join(root, 'agents'), codeRoot: latchCodeRoot() })
    const { output, latch } = cli({ cwd: root })
    expect(await latch('project', 'add', 'api', 'api/lib', 'web', '--name', 'Shop', '--data-dir', dataDir)).toBe(1)
    expect(output.stderr).toBe('添加文件夹需要确认：在终端中运行，或加上 --yes\n')

    const declined = cli({ cwd: root, tty: true, answer: false })
    expect(await declined.latch('project', 'add', 'api', '--data-dir', dataDir)).toBe(1)
    expect(declined.output.stdout).toContain('已取消，没有改动。')
    expect((await HostConfig.open(dataDir)).settings().workspaces).toEqual([])

    const added = cli({ cwd: root, tty: true, answer: true })
    expect(await added.latch('project', 'add', 'api', 'api/lib', 'web', '--name', 'Shop', '--data-dir', dataDir)).toBe(0)
    expect(added.output.stderr).toBe(`没有加入 ${join(root, 'api', 'lib')}：同一项目中的文件夹不能相同，也不能相互包含\n`)
    expect(added.output.stdout).toContain(`将用这些文件夹新建项目「Shop」：\n  ${join(root, 'api')}（主文件夹）\n  ${join(root, 'web')}\n`)
    expect(added.output.stdout).toContain('已新建项目「Shop」（shop）。')
    const more = cli({ cwd: root })
    expect(await more.latch('project', 'add-folder', 'shop', 'docs', join(root, 'missing'), '--yes', '--data-dir', dataDir)).toBe(0)
    expect(more.output.stderr).toBe(`没有加入 ${join(root, 'missing')}：找不到这个文件夹\n`)
    expect(await cli({ cwd: root }).latch('project', 'add-folder', 'default', 'docs', '--yes', '--data-dir', dataDir)).toBe(1)
    expect(await cli({ cwd: root }).latch('project', 'add-folder', 'nope', 'docs', '--yes', '--data-dir', dataDir)).toBe(1)
    const listed = cli({ cwd: root })
    expect(await listed.latch('project', 'list', '--json', '--data-dir', dataDir)).toBe(0)
    expect(JSON.parse(listed.output.stdout)).toEqual([
      {
        id: 'shop',
        name: 'Shop',
        path: join(root, 'api'),
        folders: [
          { id: 'api', path: join(root, 'api') },
          { id: 'web', path: join(root, 'web') },
          { id: 'docs', path: join(root, 'docs') },
        ],
      },
    ])
    const records = await auditActions(dataDir)
    const projects = records.filter(record => record.action.startsWith('workspace.'))
    expect(projects.map(record => [record.action, record.actor, record.stepup])).toEqual([
      ['workspace.added', { listener: 'cli', via: 'cli' }, 'offline'],
      ['workspace.folder-added', { listener: 'cli', via: 'cli' }, 'offline'],
    ])
    expect((projects[0] as unknown as { detail: Record<string, unknown> }).detail).toMatchObject({ folderCount: 2, via: 'cli' })
    expect(records.filter(record => record.action === 'settings.changed')).toHaveLength(2)

    // Removing lowers access: the same command family, the same audit, files untouched.
    expect(await cli({ cwd: root }).latch('project', 'remove-folder', 'shop', 'docs', '--data-dir', dataDir)).toBe(1)
    expect(await cli({ cwd: root }).latch('project', 'remove-folder', 'shop', 'docs', '--yes', '--data-dir', dataDir)).toBe(0)
    expect(await cli({ cwd: root }).latch('project', 'remove-folder', 'shop', 'nope', '--yes', '--data-dir', dataDir)).toBe(1)
    expect(await cli({ cwd: root }).latch('project', 'remove', 'default', '--yes', '--data-dir', dataDir)).toBe(1)
    expect((await HostConfig.open(dataDir)).settings().workspaces[0]!.folders.map(folder => folder.id)).toEqual(['api', 'web'])
    await mkdir(join(root, 'docs'), { recursive: true })
    expect(await cli({ cwd: root }).latch('project', 'add-folder', 'shop', 'docs', '--yes', '--data-dir', dataDir)).toBe(0)
    expect((await auditActions(dataDir)).filter(record => record.action === 'workspace.folder-removed')).toHaveLength(1)

    // A Host that holds the lock while it starts, and one that runs, are both refused.
    const starting = await acquireDataDirLock(dataDir, 'host')
    const early = cli({ cwd: root })
    expect(await early.latch('project', 'add-folder', 'shop', 'docs', '--yes', '--data-dir', dataDir)).toBe(1)
    expect(early.output.stderr).toBe('Host 正在运行。请在 Latch 桌面端添加，或先停止 Host。\n')
    await starting.release()

    // The Host starts with them and sees no change made outside Latch.
    const t = await runningHost({ dataDir })
    expect((await auditActions(dataDir)).some(record => record.action === 'settings.changed-outside')).toBe(false)
    expect(t.host.config.settings().workspaces[0]!.folders).toHaveLength(3)
    const refused = cli({ cwd: root })
    expect(await refused.latch('project', 'add', 'web', '--yes', '--data-dir', dataDir)).toBe(1)
    expect(refused.output.stderr).toBe('Host 正在运行。请在 Latch 桌面端添加，或先停止 Host。\n')
    expect(await refused.latch('project', 'list', '--data-dir', dataDir)).toBe(1)
    expect(await refused.latch('project', 'remove', 'shop', '--yes', '--data-dir', dataDir)).toBe(1)
    expect(refused.output.stderr).toContain('Host 正在运行。请在 Latch 的「设置 → 项目」中移除，或先停止 Host。')
    await t.close()
    // runningHost recorded this test process in host.json; once the Host is closed the record goes too.
    await rm(join(dataDir, 'host.json'))
    const gone = cli({ cwd: root, tty: true, answer: true })
    expect(await gone.latch('project', 'remove', 'shop', '--data-dir', dataDir)).toBe(0)
    expect((await HostConfig.open(dataDir)).settings().workspaces).toEqual([])
    expect((await auditActions(dataDir)).some(record => record.action === 'workspace.removed')).toBe(true)
  })

  it('verifies the audit chain and reports a tampered line', async () => {
    const t = await startTestHost()
    const dataDir = t.dataDir
    await t.enroll()
    const copy = join(await temporaryDirectory(), 'data')
    await mkdir(join(copy, 'audit'), { recursive: true, mode: 0o700 })
    const text = await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8')
    await t.close()
    await writeFile(join(copy, 'audit', 'audit.jsonl'), text, { mode: 0o600 })
    const ok = cli()
    expect(await ok.latch('audit', 'verify', '--data-dir', copy)).toBe(0)
    expect(ok.output.stdout).toMatch(/审计记录完整：共 \d+ 条/u)
    const lines = text.trim().split('\n')
    lines[1] = JSON.stringify({ ...JSON.parse(lines[1]!), at: '2000-01-01T00:00:00.000Z' })
    await writeFile(join(copy, 'audit', 'audit.jsonl'), lines.join('\n') + '\n', { mode: 0o600 })
    const broken = cli()
    expect(await broken.latch('audit', 'verify', '--data-dir', copy)).toBe(1)
    expect(broken.output.stderr).toContain('第 2 行')
  })

  it('finds the data directory by LATCH_DATA_DIR', async () => {
    const dataDir = join(await temporaryDirectory(), 'current')
    const run = cli({ env: { LATCH_DATA_DIR: dataDir } })
    expect(await run.latch('audit', 'verify')).toBe(1)
    expect(run.output.stderr).toBe(`找不到审计记录 ${join(dataDir, 'audit', 'audit.jsonl')}\n`)
  })

  it('runs as a script with the documented usage and exit codes', async () => {
    const directory = await temporaryDirectory()
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^LATCH_/u.test(name)))
    const usage = await run(TSX, [LATCH], { cwd: directory, env }).catch((error: { code: number; stdout: string }) => error)
    expect(usage).toMatchObject({ code: 1 })
    expect((usage as { stdout: string }).stdout).toContain('用法：pnpm latch')
    const missing = await run(TSX, [LATCH, 'audit', 'verify', '--data-dir', join(directory, 'data')], { cwd: directory, env }).catch(
      (error: { code: number; stderr: string }) => error,
    )
    expect(missing).toMatchObject({ code: 1, stderr: expect.stringContaining('找不到审计记录') })
    const t = await startTestHost()
    cleanups.push(() => t.close())
    const verified = await run(TSX, [LATCH, 'audit', 'verify', '--data-dir', t.dataDir], { cwd: directory, env })
    expect(verified.stdout).toMatch(/审计记录完整：共 \d+ 条/u)
  })
})
