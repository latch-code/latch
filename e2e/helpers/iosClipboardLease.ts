import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const publicClipboardMarker = () => `latch-public-clipboard-${randomUUID()}`
export const PAIR_CLIPBOARD_MS = 10_000

type Reason =
  | 'external-change'
  | 'unexpected-test-transfer'
  | 'expired'
  | 'interrupted'
  | 'invalid-command'
  | 'input-limit'
  | 'capture-refused'
  | 'invalid-marker'
  | 'write-failed'
  | 'write-refused'
  | 'unknown-operation'
  | 'invalid-mode'
type Reply = {
  id: number
  ok: boolean
  reason?: Reason
  remoteSeen?: boolean
  restored?: boolean
  originalMatches?: boolean
  externalMatches?: boolean
  promiseIntact?: boolean
  empty?: boolean
  waitingForGui?: boolean
}
const reasons = new Set<string>([
  'external-change',
  'unexpected-test-transfer',
  'expired',
  'interrupted',
  'invalid-command',
  'input-limit',
  'capture-refused',
  'invalid-marker',
  'write-failed',
  'write-refused',
  'unknown-operation',
  'invalid-mode',
])
const boolFields = ['remoteSeen', 'restored', 'originalMatches', 'externalMatches', 'promiseIntact', 'empty', 'waitingForGui']
function isReply(value: unknown): value is Reply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const id: unknown = Reflect.get(value, 'id'),
    reason: unknown = Reflect.get(value, 'reason')
  return (
    typeof id === 'number'
    && Number.isSafeInteger(id)
    && id >= 0
    && typeof Reflect.get(value, 'ok') === 'boolean'
    && (reason === undefined || (typeof reason === 'string' && reasons.has(reason)))
    && Object.keys(value).every(key => key === 'id' || key === 'ok' || key === 'reason' || boolFields.includes(key))
    && boolFields.every(key => Reflect.get(value, key) === undefined || typeof Reflect.get(value, key) === 'boolean')
  )
}
type Command = {
  op:
    | 'capture'
    | 'write'
    | 'expect-remote'
    | 'track'
    | 'check'
    | 'restore'
    | 'fixture-seed'
    | 'fixture-external'
    | 'fixture-promise'
    | 'fixture-empty'
    | 'fixture-fail-write'
    | 'fixture-marker-present'
    | 'fixture-remote'
    | 'fixture-inspect'
    | 'fixture-destroy'
  marker?: string
  milliseconds?: number
}

/** Compiles only a test driver. It is not linked into either native App target. */
export async function compileClipboardLease(directory: string): Promise<string> {
  const binary = join(directory, 'clipboard-lease')
  await exec(
    '/usr/bin/xcrun',
    ['swiftc', '-parse-as-library', '-swift-version', '5', fileURLToPath(new URL('./ClipboardLease.swift', import.meta.url)), '-o', binary],
    { timeout: 120_000, maxBuffer: 1_048_576 },
  )
  return binary
}

/** The helper owns the original clipboard bytes. Node receives only fixed status fields. */
export function clipboardLease(binary: string, testBoard?: string, testGuiProbe?: string) {
  if (testBoard !== undefined && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(testBoard))
    throw new Error('Invalid test pasteboard identity')
  if (testGuiProbe !== undefined && testBoard === undefined) throw new Error('The general clipboard cannot use a test GUI probe')
  const child = spawn(
    binary,
    testBoard ? ['--test-board', testBoard, ...(testGuiProbe ? ['--gui-probe', testGuiProbe] : [])] : ['--general'],
    {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
    },
  )
  let sequence = 0,
    output = '',
    failure: Error | undefined,
    final: Reply | undefined
  const pending = new Map<number, { resolve(value: Reply): void; reject(cause: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const fail = (reason: string) => {
    failure ??= new Error(`Clipboard validation stopped: ${reason}`)
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(failure)
    }
    pending.clear()
  }
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    if (output.length > 8192) {
      fail('helper output limit')
      child.kill('SIGTERM')
      return
    }
    for (;;) {
      const newline = output.indexOf('\n')
      if (newline < 0) break
      const line = output.slice(0, newline)
      output = output.slice(newline + 1)
      let reply: Reply
      try {
        const value: unknown = JSON.parse(line)
        if (!isReply(value)) throw new Error('Invalid helper status')
        reply = value
      } catch {
        fail('invalid helper status')
        child.kill('SIGTERM')
        return
      }
      if (reply.id === 0) {
        final = reply
        if (!reply.ok) fail(reply.reason ?? 'helper stopped')
        continue
      }
      const item = pending.get(reply.id)
      if (!item) continue
      pending.delete(reply.id)
      clearTimeout(item.timer)
      if (reply.ok) item.resolve(reply)
      else item.reject(new Error(`Clipboard validation stopped: ${reply.reason ?? 'refused'}`))
    }
  })
  child.stdin.on('error', () => fail('helper input closed'))
  const exited = new Promise<void>(resolve => {
    child.once('error', () => {
      fail('helper launch failed')
      resolve()
    })
    child.once('close', () => {
      if (pending.size) fail('helper exited')
      resolve()
    })
  })
  const request = (command: Command): Promise<Reply> => {
    if (failure || child.exitCode !== null || child.signalCode !== null)
      return Promise.reject(failure ?? new Error('Clipboard helper closed'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail('helper did not answer')
        child.kill('SIGTERM')
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, ...command }) + '\n')
    })
  }
  return {
    request,
    get failure() {
      return failure
    },
    get waitingForGui() {
      return final?.waitingForGui === true
    },
    async close() {
      child.stdin.end()
      // It may outlive a disconnected controller until both GUIs close. Never kill the only saved copy.
      await exited
      if (!final) throw new Error('Clipboard helper exited without a restoration receipt')
      return final
    },
    async interrupt() {
      child.kill('SIGTERM')
      await exited
      return final
    },
    async malformed() {
      child.stdin.write('not-json\n')
      await exited
      return final
    },
    async ended() {
      await exited
      return final
    },
    async disconnect() {
      child.stdin.destroy()
      child.stdout.destroy()
      await exited
    },
  }
}

/** A positive control is mandatory. A broken synchronizer cannot qualify as a verified OFF setting. */
export class ClipboardProof {
  private state: 'new' | 'on' | 'off' | 'held' | 'used' | 'invalid' = 'new'
  private deadline = 0
  private observedAt = 0
  constructor(
    readonly pid: number,
    readonly device: string,
  ) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(device))
      throw new Error('Invalid clipboard validation identity')
  }
  on(hostToDevice: boolean, deviceToHost: boolean) {
    if (this.state !== 'new' || !hostToDevice || !deviceToHost) this.invalidate()
    this.state = 'on'
  }
  off(hostToDevice: boolean, deviceToHost: boolean, now: number) {
    if (this.state !== 'on' || hostToDevice || deviceToHost || !Number.isFinite(now)) this.invalidate()
    this.state = 'off'
    this.observedAt = now
    this.deadline = now + PAIR_CLIPBOARD_MS
  }
  take(pid: number, device: string, now: number) {
    if (this.state !== 'off' || !this.matches(pid, device, now)) this.invalidate()
    this.state = 'held'
  }
  check(pid: number, device: string, now: number, clipboardStable: boolean) {
    if (this.state !== 'held' || !clipboardStable || !this.matches(pid, device, now)) this.invalidate()
  }
  consumed() {
    if (this.state !== 'held') this.invalidate()
    this.state = 'used'
  }
  private matches(pid: number, device: string, now: number) {
    return pid === this.pid && device === this.device && Number.isFinite(now) && now >= this.observedAt && now < this.deadline
  }
  private invalidate(): never {
    this.state = 'invalid'
    throw new Error('Clipboard proof is no longer valid')
  }
}
