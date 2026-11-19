/**
 * The Host's side of Claude's store reader (`claude-store-runner.ts`): one short-lived Node process per read, with only
 * the variables that say where `claude` keeps its store, taken from the session's own environment, so it reads the same
 * store the session's `claude` writes. Its output is bounded, and a read that takes too long is killed with its group.
 * Nothing it answers holds a secret: the runner reports settings as facts.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Where the runner is: next to this file in the package's sources, or `dist/harness/` beside a Host bundle. */
function locateRunner(): string {
  const here = import.meta.url
  if (here.endsWith('.ts')) return fileURLToPath(new URL('./claude-store-runner.ts', here))
  const folder = dirname(fileURLToPath(here))
  const candidates = [join(folder, '../harness/claude-store-runner.js'), join(folder, 'harness/claude-store-runner.js')]
  return candidates.find(path => existsSync(path)) ?? candidates[0]!
}

let available: boolean | undefined

/**
 * Whether this Host can read Claude's store: the runner is where a build or the sources put it and the Agent SDK is in a
 * `node_modules` above it (a packaged Host has none). Only files are looked at; nothing is loaded.
 */
export function claudeStoreAvailable(): boolean {
  if (available !== undefined) return available
  const runner = locateRunner()
  let found = false
  for (let folder = dirname(runner); !found; folder = dirname(folder)) {
    found = existsSync(join(folder, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))
    if (dirname(folder) === folder) break
  }
  available = existsSync(runner) && found
  return available
}

/** The variables the runner gets, and nothing else: where the store is, and what `resolveSettings` may run (`plutil`). */
const STORE_ENV = ['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME'] as const

const MAX_OUTPUT = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

/** The store could not be read: the runner failed, ran out of time or answered nothing Latch reads. */
class ClaudeStoreError extends Error {
  constructor(
    message: string,
    /** The runner refused the request itself (an ID that is not one). */
    readonly refused = false,
  ) {
    super(message)
  }
}

const text = z.string()
const listResult = z.object({
  sessions: z.array(z.object({ sessionId: text, cwd: text, title: text.optional(), updatedAt: text.optional() })),
  more: z.boolean(),
})
const infoResult = z.object({ exists: z.boolean(), lastModified: z.number().optional() })
const block = z.object({ type: text }).passthrough()
const storedMessage = z.object({
  type: text,
  uuid: text.optional(),
  parentToolUseId: text.optional(),
  meta: z.boolean().optional(),
  compactSummary: z.boolean().optional(),
  subtype: text.optional(),
  id: text.optional(),
  model: text.optional(),
  timestamp: text.optional(),
  content: z.array(block),
})
export type StoredMessage = z.infer<typeof storedMessage>
const messagesResult = z.object({ messages: z.array(storedMessage), dropped: z.number(), compacted: z.boolean().optional() })
const forkResult = z.union([z.object({ sessionId: text }), z.object({ refused: z.enum(['missing', 'end']) })])
const deleteResult = z.object({ deleted: z.boolean() })
const settingsResult = z.object({
  disableBypass: z.boolean(),
  disableAuto: z.boolean(),
  startMode: text.optional(),
  allow: z.array(z.object({ rule: text, source: text })).max(100),
  hooks: z.boolean(),
  managed: z.boolean(),
  cleanupPeriodDays: z.number().optional(),
  maxEffortLevel: text.optional(),
  managedKeyHelper: z.boolean().optional(),
  managedModels: z.array(text).optional(),
  model: text.optional(),
  modelSource: text.optional(),
  ownEndpoint: z.boolean().optional(),
  configDirInSettings: z.boolean().optional(),
})
export type ClaudeSettings = z.infer<typeof settingsResult>
const busyResult = z.object({ busy: z.boolean() })

/** Reads of one store: the one the environment `env` names, as the session's `claude` would find it. */
export class ClaudeStore {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** The store this environment points at, as a name for Latch's record of which sessions came from it. */
  static place(env: Readonly<Record<string, string | undefined>>): string {
    return env.CLAUDE_CONFIG_DIR || join(env.HOME ?? '', '.claude')
  }

  list(offset: number, limit: number, signal?: AbortSignal) {
    return this.run({ op: 'list', offset, limit }, listResult, signal)
  }
  info(sessionId: string, dir: string | undefined, signal?: AbortSignal) {
    return this.run({ op: 'info', sessionId, ...(dir ? { dir } : {}) }, infoResult, signal)
  }
  messages(sessionId: string, dir: string | undefined, maxBytes: number, signal?: AbortSignal) {
    return this.run({ op: 'messages', sessionId, maxBytes, ...(dir ? { dir } : {}) }, messagesResult, signal)
  }
  fork(sessionId: string, through: string, dir: string | undefined, signal?: AbortSignal) {
    return this.run({ op: 'fork', sessionId, through, ...(dir ? { dir } : {}) }, forkResult, signal)
  }
  delete(sessionId: string, dir: string | undefined, signal?: AbortSignal) {
    return this.run({ op: 'delete', sessionId, ...(dir ? { dir } : {}) }, deleteResult, signal)
  }
  settings(cwd: string, signal?: AbortSignal) {
    return this.run({ op: 'settings', cwd }, settingsResult, signal)
  }
  busy(sessionId: string, signal?: AbortSignal) {
    return this.run({ op: 'busy', sessionId }, busyResult, signal)
  }

  private run<T extends z.ZodType>(request: Record<string, unknown>, shape: T, signal?: AbortSignal): Promise<z.infer<T>> {
    const env: Record<string, string> = {}
    for (const name of STORE_ENV) {
      const value = this.env[name]
      if (value) env[name] = value
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new ClaudeStoreError('cancelled'))
      const child = spawn(process.execPath, ['--disable-sigusr1', locateRunner()], {
        env,
        cwd: env.HOME && existsSync(env.HOME) ? env.HOME : '/',
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      })
      let output = ''
      let done = false
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Already gone. */
        }
      }
      const finish = (error?: Error, value?: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          kill()
          reject(error)
        } else resolve(value as z.infer<T>)
      }
      const onAbort = () => finish(new ClaudeStoreError('cancelled'))
      const timer = setTimeout(() => finish(new ClaudeStoreError('读取 Claude 的记录超时')), this.timeoutMs)
      timer.unref()
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', error => finish(new ClaudeStoreError(`无法启动读取进程：${error.message}`)))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (output.length > MAX_OUTPUT) finish(new ClaudeStoreError('Claude 的记录读取结果过大'))
      })
      child.on('close', () => {
        let answer: unknown
        try {
          answer = JSON.parse(output)
        } catch {
          return finish(new ClaudeStoreError('读取进程没有给出结果'))
        }
        const read = z
          .union([
            z.object({ ok: z.literal(true), result: z.unknown() }),
            z.object({ ok: z.literal(false), error: text, refused: z.boolean().optional() }),
          ])
          .safeParse(answer)
        if (!read.success) return finish(new ClaudeStoreError('读取进程的结果无效'))
        if (!read.data.ok) return finish(new ClaudeStoreError(read.data.error, read.data.refused === true))
        const result = shape.safeParse(read.data.result)
        if (!result.success) return finish(new ClaudeStoreError('读取进程的结果无效'))
        finish(undefined, result.data)
      })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(request))
    })
  }
}
