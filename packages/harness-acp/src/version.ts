/**
 * The oldest version of its own command a profile works with (`HarnessProfile.minimumVersion`): read by running the
 * command, kept per file, and turned into a status line and a refusal to start.
 */
import { realpathSync, statSync } from 'node:fs'
import { AppError } from '@latch/sdk'
import { locateProgram, readOwnVersion } from './login.ts'
import { routeCommand, selectProfile } from './permission.ts'
import type { HarnessProfile } from './profiles/index.ts'
import type { AgentRecord } from './types.ts'
import { compareVersions } from './semver.ts'
import { releaseLookup, updateCommand, type ReleaseLookup } from './update-command.ts'

export { compareVersions }

/** A minimum a command must reach: the profile's own, or another one for a use of it (the gateway's). */
type Gate = NonNullable<HarnessProfile['minimumVersion']>

const READ_MS = 10_000

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

/**
 * A profile's `releases` as a gate no version fails: its program is read, by the same rules and cache, only to tell a
 * person a newer release is out. `tooOld`, `versionRefusal` and `assertVersion` look at `minimumVersion` alone.
 */
export function releaseGate(profile: HarnessProfile | undefined): Gate | undefined {
  if (profile?.minimumVersion) return profile.minimumVersion
  const releases = profile?.releases
  return releases && { args: releases.args, read: releases.read, minimum: '0.0.0', upgrade: '', source: releases.source }
}

/** The command's gate, when this record's command is the preset's own and the Host may run it. */
function gateOf(record: AgentRecord, path: string, own?: Gate): Gate | undefined {
  const { preset, profile } = selectProfile(record)
  const gate = own ?? releaseGate(profile)
  if (!gate || !preset) return undefined
  // Only the preset's own program (its adapter's, for a definition on the adapter), the file a login check runs: its bare
  // name, or a path to that same file. Any other
  // command (`node …/cli.js`, a copy in a project folder) is never run for its version and blocks nothing.
  const program = routeCommand(record, preset)
  const located = locateProgram(program)
  if (!located) return undefined
  if (record.command !== program && !sameFile(record.command, located)) return undefined
  return sameFile(path, located) ? gate : undefined
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

const keyOf = (record: AgentRecord, path: string, minimum: string) => `${path}\0${minimum}\0${record.accountDirectory ?? ''}`

/** The cached read of this file, when it is still this file and no re-check came since. Starts nothing. */
function cached(record: AgentRecord, path: string, own?: Gate): Entry | undefined {
  const gate = gateOf(record, path, own)
  const known = gate ? cache.get(keyOf(record, path, gate.minimum)) : undefined
  return known && known.epoch === epoch && known.stamp === stampOf(path) ? known : undefined
}

/**
 * The read of this file, started when there is none still valid or `fresh` asks for one. Bounded as a whole: a command
 * that never answers is unreadable, which blocks nothing.
 */
function entryFor(record: AgentRecord, path: string, fresh = false, own?: Gate): Entry | undefined {
  const gate = gateOf(record, path, own)
  const stamp = stampOf(path)
  if (!gate || stamp === undefined) return undefined
  const key = keyOf(record, path, gate.minimum)
  const known = cache.get(key)
  if (!fresh && known && known.stamp === stamp && known.epoch === epoch) return known
  const before = known?.verdict
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>(resolve => {
    const wait = setTimeout(() => resolve(undefined), READ_MS + 1_000)
    wait.unref()
    timer = wait
  })
  const entry: Entry = {
    stamp,
    epoch,
    read: Promise.race([readOwnVersion(record, path, { timeoutMs: READ_MS }, gate), deadline]).then(
      version => {
        clearTimeout(timer)
        const order = version === undefined ? undefined : compareVersions(version, gate.minimum)
        const verdict: VersionVerdict = { ...(version ? { version: version.slice(0, 64) } : {}), tooOld: order !== undefined && order < 0 }
        entry.verdict = verdict
        if (before ? verdict.tooOld !== before.tooOld || verdict.version !== before.version : verdict.tooOld) learned?.()
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
  return gate !== undefined && cache.has(keyOf(record, path, gate.minimum))
}

/** What is known now, from reads already made; it starts none. */
export function knownVersion(record: AgentRecord, path: string): VersionVerdict | undefined {
  return cached(record, path)?.verdict
}

/**
 * The last read of this very file, re-checks aside: for a preset that has no confirmed definition, whose program is not
 * run again to read its version, so what the read under its confirmation said stays known.
 */
export function lastVersion(record: AgentRecord, path: string): VersionVerdict | undefined {
  const gate = gateOf(record, path)
  const known = gate ? cache.get(keyOf(record, path, gate.minimum)) : undefined
  return known && known.stamp === stampOf(path) ? known.verdict : undefined
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

/**
 * The command that updates the program at `path` the way it was installed (`update-command.ts`), else the gate's own:
 * the one command every line about this program names.
 */
export function upgradeCommand(gate: Gate, path: string | undefined): string {
  return installedUpdate(gate, path) ?? gate.upgrade
}

/** The update command the install's layout names, by its path alone; undefined when it names none. */
function installedUpdate(gate: Gate, path: string | undefined): string | undefined {
  if (!gate.source || path === undefined) return undefined
  let real: string | undefined
  try {
    real = realpathSync(path)
  } catch {
    real = undefined
  }
  return updateCommand(path, real, gate.source)
}

/**
 * Where a newer release of the program at `path` is asked, and the command that updates it the way it was installed,
 * both by its path alone (`update-command.ts`); undefined when the gate names no source or the layout no lookup.
 */
export function installedRelease(gate: Gate, path: string): { lookup: ReleaseLookup; command?: string } | undefined {
  if (!gate.source) return undefined
  let real: string | undefined
  try {
    real = realpathSync(path)
  } catch {
    real = undefined
  }
  const lookup = releaseLookup(path, real, gate.source)
  if (!lookup) return undefined
  const command = updateCommand(path, real, gate.source)
  return { lookup, ...(command ? { command } : {}) }
}

/** What a too-old command needs, and the command that upgrades it. */
export function tooOld(
  record: AgentRecord,
  verdict: VersionVerdict | undefined,
  own?: Gate,
  path?: string,
): { need: string; upgrade: string } | undefined {
  const gate = own ?? selectProfile(record).profile?.minimumVersion
  if (!gate || !verdict?.tooOld) return undefined
  return { need: `需要 ${gate.minimum} 或更高版本（当前 ${verdict.version ?? '未知'}）`, upgrade: upgradeCommand(gate, path) }
}

/** The line a too-old command gets, with the command that upgrades it. */
export function tooOldText(record: AgentRecord, verdict: VersionVerdict | undefined, own?: Gate, path?: string): string | undefined {
  const found = tooOld(record, verdict, own, path)
  return found && `${found.need}。升级：${found.upgrade}`
}

/** The refusal a too-old command gets, wherever a start is refused: the same code and words; `use` names what needs it. */
export function versionRefusal(
  record: AgentRecord,
  verdict: VersionVerdict | undefined,
  own?: Gate,
  use?: string,
  path?: string,
): AppError | undefined {
  const text = tooOldText(record, verdict, own, path)
  return text ? new AppError(409, 'harness-version-unsupported', `${record.name} ${use ? `${use}` : ''}${text}`) : undefined
}

/**
 * Before a process starts: refuses a command older than the profile's minimum. A cached "too old" is read once more,
 * since a shim (Volta, asdf, mise) stays the same file when the program behind it is upgraded. An unreadable version
 * blocks nothing unless a route requires fresh command evidence. An adapter's bundled binary may change without its
 * entry point changing, so those routes read again and refuse missing evidence before a credential is issued.
 */
export async function assertVersion(
  record: AgentRecord,
  path: string,
  own?: Gate,
  use?: string,
  requireFresh = false,
): Promise<VersionVerdict | undefined> {
  // Older agy versions ignore ADC. This account must not start on the person's keyring when a wrapper's version is unknown.
  const gate = own ?? selectProfile(record).profile?.minimumVersion
  if (!gate) return
  const fresh = requireFresh || gate.requireKnown === true || (record.presetId === 'antigravity' && record.accountDirectory !== undefined)
  const reused = fresh ? undefined : cached(record, path, own)
  const entry = reused ?? entryFor(record, path, fresh, own)
  if (!entry && !fresh) return
  let verdict = (await entry?.read) ?? { tooOld: false }
  if (fresh && verdict.version === undefined)
    throw new AppError(
      409,
      'harness-version-unsupported',
      `${record.name} ${use ?? ''}需要 ${gate.minimum} 或更高版本；当前版本无法确认。请使用受支持的官方命令后重试。`,
    )
  if (verdict.tooOld && reused) verdict = (await entryFor(record, path, true, own)?.read) ?? verdict
  const refused = versionRefusal(record, verdict, own, use, path)
  if (refused) throw refused
  return verdict
}
