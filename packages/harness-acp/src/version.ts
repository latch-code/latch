/**
 * The oldest version of its own command a profile works with (`HarnessProfile.minimumVersion`): read by running the
 * command, kept per file, and turned into a status line and a refusal to start.
 */
import { realpathSync, statSync } from 'node:fs'
import { AppError } from '@latch/sdk'
import { locateProgram, readOwnVersion } from './login.ts'
import { selectProfile } from './permission.ts'
import type { AgentRecord } from './types.ts'

const READ_MS = 10_000

/** `1.2.3`, `0.2.1-rc.1`: numeric core, then an optional pre-release. Undefined for anything else. */
function parse(version: string): { core: number[]; pre: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version.trim())
  if (!match) return undefined
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

/** Semantic-version order, pre-releases before their release; undefined when either is not a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return undefined
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/u.test(x) ? Number(x) : undefined
    const ny = /^\d+$/u.test(y) ? Number(y) : undefined
    if (nx !== undefined && ny !== undefined) return nx < ny ? -1 : 1
    if (nx !== undefined) return -1
    if (ny !== undefined) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** What a read found: the version, and whether it is older than the profile's minimum. No version: unknown, not old. */
export interface VersionVerdict {
  version?: string
  tooOld: boolean
}

interface Entry {
  stamp: string
  epoch: number
  read: Promise<VersionVerdict>
  verdict?: VersionVerdict
}

const cache = new Map<string, Entry>()
let epoch = 0
let learned: (() => void) | undefined

/**
 * Called when a read finds a command too old, or no longer too old, so that clients holding a catalog read before it
 * learn that the harness changed. One listener: the Host's.
 */
export function onVersionChange(listener: (() => void) | undefined): void {
  learned = listener
}

/** The next lookup reads every version again, as a person pressing 重新检测 expects after upgrading. */
export function forgetVersions(): void {
  epoch++
}

/** The file's identity: an upgrade replaces it. */
function stampOf(path: string): string | undefined {
  try {
    const stats = statSync(path)
    return `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.size}`
  } catch {
    return undefined
  }
}

/** The command's gate, when this record's command is the preset's own and the Host may run it. */
function gateOf(record: AgentRecord, path: string) {
  const { preset, profile } = selectProfile(record)
  const gate = profile?.minimumVersion
  if (!gate || !preset) return undefined
  // Only the preset's own program, the file a login check runs: its bare name, or a path to that same file. Any other
  // command (`node …/cli.js`, a copy in a project folder) is never run for its version and blocks nothing.
  const located = locateProgram(preset.command)
  if (!located) return undefined
  if (record.command !== preset.command && !sameFile(record.command, located)) return undefined
  return sameFile(path, located) ? gate : undefined
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

const keyOf = (path: string, minimum: string) => `${path}\0${minimum}`

/** The cached read of this file, when it is still this file and no re-check came since. Starts nothing. */
function cached(record: AgentRecord, path: string): Entry | undefined {
  const gate = gateOf(record, path)
  const known = gate ? cache.get(keyOf(path, gate.minimum)) : undefined
  return known && known.epoch === epoch && known.stamp === stampOf(path) ? known : undefined
}

/**
 * The read of this file, started when there is none still valid or `fresh` asks for one. Bounded as a whole: a command
 * that never answers is unreadable, which blocks nothing.
 */
function entryFor(record: AgentRecord, path: string, fresh = false): Entry | undefined {
  const gate = gateOf(record, path)
  const stamp = stampOf(path)
  if (!gate || stamp === undefined) return undefined
  const key = keyOf(path, gate.minimum)
  const known = cache.get(key)
  if (!fresh && known && known.stamp === stamp && known.epoch === epoch) return known
  const before = known?.verdict?.tooOld ?? false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>(resolve => {
    const wait = setTimeout(() => resolve(undefined), READ_MS + 1_000)
    wait.unref()
    timer = wait
  })
  const entry: Entry = {
    stamp,
    epoch,
    read: Promise.race([readOwnVersion(record, path, { timeoutMs: READ_MS }), deadline]).then(
      version => {
        clearTimeout(timer)
        const order = version === undefined ? undefined : compareVersions(version, gate.minimum)
        const verdict: VersionVerdict = { ...(version ? { version: version.slice(0, 64) } : {}), tooOld: order !== undefined && order < 0 }
        entry.verdict = verdict
        if (verdict.tooOld !== before) learned?.()
        return verdict
      },
      () => {
        clearTimeout(timer)
        return (entry.verdict = { tooOld: false })
      },
    ),
  }
  cache.set(key, entry)
  return entry
}

/** Whether this command was ever read, whatever has happened since: a preset chosen once is read again on a re-check. */
export function wasRead(record: AgentRecord, path: string): boolean {
  const gate = gateOf(record, path)
  return gate !== undefined && cache.has(keyOf(path, gate.minimum))
}

/** What is known now, from reads already made; it starts none. */
export function knownVersion(record: AgentRecord, path: string): VersionVerdict | undefined {
  return cached(record, path)?.verdict
}

/** Waits for the version of each, at most `timeoutMs`, so that a re-check answers with what it found. */
export async function settleVersions(
  items: ReadonlyArray<{ record: AgentRecord; path: string | undefined }>,
  timeoutMs: number,
): Promise<void> {
  const reads = items.flatMap(({ record, path }) => (path ? [entryFor(record, path)?.read] : [])).filter(Boolean)
  if (!reads.length) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.allSettled(reads), new Promise<void>(resolve => (timer = setTimeout(resolve, timeoutMs)))])
  clearTimeout(timer)
}

/** What a too-old command needs, and the command that upgrades it. */
export function tooOld(record: AgentRecord, verdict: VersionVerdict | undefined): { need: string; upgrade: string } | undefined {
  const gate = selectProfile(record).profile?.minimumVersion
  if (!gate || !verdict?.tooOld) return undefined
  return { need: `需要 ${gate.minimum} 或更高版本（当前 ${verdict.version ?? '未知'}）`, upgrade: gate.upgrade }
}

/** The line a too-old command gets, with the command that upgrades it. */
export function tooOldText(record: AgentRecord, verdict: VersionVerdict | undefined): string | undefined {
  const found = tooOld(record, verdict)
  return found && `${found.need}。升级：${found.upgrade}`
}

/** The refusal a too-old command gets, wherever a start is refused: the same code and words. */
export function versionRefusal(record: AgentRecord, verdict: VersionVerdict | undefined): AppError | undefined {
  const text = tooOldText(record, verdict)
  return text ? new AppError(409, 'harness-version-unsupported', `${record.name} ${text}`) : undefined
}

/**
 * Before a process starts: refuses a command older than the profile's minimum. A cached "too old" is read once more,
 * since a shim (Volta, asdf, mise) stays the same file when the program behind it is upgraded. An unreadable version
 * blocks nothing.
 */
export async function assertVersion(record: AgentRecord, path: string): Promise<void> {
  const reused = cached(record, path)
  const entry = reused ?? entryFor(record, path)
  if (!entry) return
  let verdict = await entry.read
  if (verdict.tooOld && reused) verdict = (await entryFor(record, path, true)?.read) ?? verdict
  const refused = versionRefusal(record, verdict)
  if (refused) throw refused
}
