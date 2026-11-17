import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { SetupError, type SetupDeps } from './setup-core.ts'

const VERSION = '4.164.0'
const FAILED = { code: -1, stdout: '' }
const MAX_OUTPUT_BYTES = 64 * 1024

/** The source entry and a packaged entry use this runner for all Wrangler calls, including secret put. */
export function wranglerRunner(program: string): SetupDeps['wrangler'] {
  const path = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  const candidates = program.includes('/') ? [resolve(program)] : path.map(directory => join(directory, program))
  const findExecutable = async () => {
    for (const candidate of candidates) {
      const executable = await realpath(candidate).catch(() => undefined)
      if (
        executable
        && (await access(executable, constants.X_OK).then(
          () => true,
          () => false,
        ))
      )
        return executable
    }
    return undefined
  }
  let selected: ReturnType<typeof findExecutable> | undefined
  let verified = false
  return async (args, { cwd, input }) => {
    const versionCheck = args.length === 1 && args[0] === '--version'
    if (!versionCheck && !verified) throw new SetupError('请先核对 wrangler 版本')
    selected ??= findExecutable()
    const executable = await selected
    if (!executable) return FAILED

    const scratch = await mkdtemp(join(tmpdir(), 'latch-wrangler-'))
    try {
      // Wrangler still writes debug entries at WRANGLER_LOG=none. Its .log override needs a file path.
      const debugSink = join(scratch, 'wrangler.log')
      await symlink('/dev/null', debugSink)
      const env = {
        PATH: path.join(delimiter),
        HOME: homedir(),
        ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
        ...(process.env.XDG_DATA_HOME ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {}),
        NO_COLOR: '1',
        NODE_OPTIONS: '--disable-sigusr1',
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_SANITIZE: 'true',
        WRANGLER_LOG: input === undefined ? 'log' : 'none',
        WRANGLER_LOG_PATH: debugSink,
        WRANGLER_OUTPUT_FILE_PATH: '/dev/null',
      }
      const result = await new Promise<{ code: number; stdout: string }>(done => {
        const child = spawn(executable, [...args, '--env-file', '/dev/null'], {
          cwd,
          env,
          stdio: ['pipe', input === undefined ? 'pipe' : 'ignore', 'ignore'],
        })
        const chunks: Buffer[] = []
        let size = 0
        child.stdout?.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk)
        })
        child.once('error', () => done(FAILED))
        child.once('close', code =>
          done(size > MAX_OUTPUT_BYTES ? FAILED : { code: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8') }),
        )
        child.stdin!.on('error', () => {})
        child.stdin!.end(input)
      })
      if (versionCheck && result.code === 0) {
        verified = result.stdout.split(/\r?\n/u).some(line => line.trim() === VERSION)
        if (!verified) throw new SetupError(`请使用已审阅诊断行为的 wrangler ${VERSION}，并先运行 wrangler login`)
      }
      return result
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
