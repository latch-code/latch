import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { buildLinuxRelayBundle } from './bundle-linux.ts'
import { runLinuxAcceptance } from './accept-linux.ts'
import {
  buildSshRemoteCommand,
  extractSshHost,
  LinuxSetupError,
  runLinuxRemoteStatus,
  runLinuxSetup,
  runLinuxUninstall,
} from './setup-linux-core.ts'

const execFileAsync = promisify(execFile)

function sshEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function runSsh(
  target: { server: string; sshPort?: number },
  remoteScript: string,
  stdin?: Buffer,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolvePromise => {
    const args = [
      '-T',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ConnectTimeout=15',
      ...(target.sshPort ? ['-p', String(target.sshPort)] : []),
      '--',
      target.server,
      buildSshRemoteCommand(remoteScript),
    ]
    const child = spawn('ssh', args, {
      env: sshEnvironment(),
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outLen = 0,
      errLen = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outLen < 262_144) {
        outChunks.push(chunk)
        outLen += chunk.length
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errLen < 65_536) {
        errChunks.push(chunk)
        errLen += chunk.length
      }
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 180_000)
    timer.unref()
    child.once('error', () => {
      clearTimeout(timer)
      resolvePromise({ code: 255, stdout: '', stderr: 'ssh spawn failed' })
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks, outLen).toString('utf8'),
        stderr: Buffer.concat(errChunks, errLen).toString('utf8'),
      })
    })
    if (stdin && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
  })
}

async function resolveServerIp(target: { server: string; sshPort?: number }): Promise<string | undefined> {
  let candidate = extractSshHost(target.server)
  try {
    const { stdout } = await execFileAsync('ssh', ['-G', ...(target.sshPort ? ['-p', String(target.sshPort)] : []), '--', target.server], {
      env: sshEnvironment(),
      timeout: 5_000,
    })
    const hostLine = stdout
      .split('\n')
      .find(line => line.startsWith('hostname '))
      ?.slice('hostname '.length)
      .trim()
    if (hostLine) candidate = hostLine.replace(/^\[|\]$/gu, '')
  } catch {
    // Fall back to resolving the host extracted from `target.server`.
  }
  if (isIP(candidate) !== 0) return candidate
  try {
    const resolved = await lookup(candidate)
    return resolved.address
  } catch {
    return undefined
  }
}

const { values } = parseArgs({
  strict: true,
  options: {
    action: { type: 'string' },
    server: { type: 'string' },
    'ssh-port': { type: 'string' },
    domain: { type: 'string' },
    ip: { type: 'string' },
    name: { type: 'string' },
    port: { type: 'string' },
    'public-port': { type: 'string' },
    'behind-proxy': { type: 'boolean' },
    cert: { type: 'string' },
    key: { type: 'string' },
    'acme-email': { type: 'string' },
    bundle: { type: 'string' },
    out: { type: 'string' },
    'skip-accept': { type: 'boolean' },
    upgrade: { type: 'boolean' },
    'purge-data': { type: 'boolean' },
  },
})

try {
  const parsePort = (raw: string | undefined, flag: string): number | undefined => {
    if (raw === undefined) return undefined
    if (!/^\d{1,5}$/u.test(raw)) throw new LinuxSetupError(`${flag} 必须是 1–65535 的整数`)
    return Number(raw)
  }
  const action = values.action ?? 'setup'
  const sshPort = parsePort(values['ssh-port'], '--ssh-port')

  if (!values.server) {
    throw new LinuxSetupError(
      '用法：latch relay setup linux --server <user@host> [--domain <域名> | --ip <公网IP>] [--port <端口>] [--behind-proxy | --cert <路径> --key <路径>] [--upgrade]',
    )
  }

  if (action === 'status') {
    for (const line of await runLinuxRemoteStatus({ server: values.server, sshPort }, runSsh)) {
      process.stdout.write(`${line}\n`)
    }
  } else if (action === 'uninstall') {
    const summary = await runLinuxUninstall(
      { server: values.server, sshPort, ...(values['purge-data'] ? { purgeData: true } : {}) },
      runSsh,
    )
    process.stdout.write(`${summary}\n`)
  } else {
    await runLinuxSetup(
      {
        server: values.server,
        sshPort,
        ...(values.domain ? { domain: values.domain } : {}),
        ...(values.ip ? { ip: values.ip } : {}),
        ...(values.name ? { name: values.name } : {}),
        port: parsePort(values.port, '--port'),
        publicPort: parsePort(values['public-port'], '--public-port'),
        ...(values['behind-proxy'] ? { behindProxy: true } : {}),
        ...(values.cert ? { cert: values.cert } : {}),
        ...(values.key ? { key: values.key } : {}),
        ...(values['acme-email'] ? { acmeEmail: values['acme-email'] } : {}),
        ...(values.bundle ? { bundlePath: resolve(values.bundle) } : {}),
        ...(values.out ? { out: values.out } : {}),
        ...(values['skip-accept'] ? { skipAccept: true } : {}),
        ...(values.upgrade ? { upgrade: true } : {}),
      },
      {
        ssh: runSsh,
        resolveServerIp,
        async buildBundle(arch) {
          const dir = await mkdtemp(join(tmpdir(), 'latch-linux-pkg-'))
          try {
            const outPath = join(dir, `latch-relay-linux-${arch}.tar.gz`)
            const built = await buildLinuxRelayBundle({
              arch,
              outTarball: outPath,
              progress: line => process.stdout.write(`· ${line}\n`),
            })
            return { tarball: await readFile(built.tarball), sha256: built.bundleSha256 }
          } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {})
          }
        },
        async readBundle(path) {
          const tarball = await readFile(path)
          return { tarball, sha256: createHash('sha256').update(tarball).digest('hex') }
        },
        accept: profile =>
          runLinuxAcceptance(profile, {
            progress: item => process.stdout.write(`${item.result === 'pass' ? '✓' : '✗'} ${item.name}：${item.detail}\n`),
          }),
        progress: line => process.stdout.write(`${line}\n`),
      },
    )
    process.stdout.write('下一步：打开这台电脑的 Latch「设置 › 连接转发」，找到刚生成的配置并点「核对并连接」。\n')
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
