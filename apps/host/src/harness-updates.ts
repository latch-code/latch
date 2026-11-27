/**
 * Whether a newer release of a preset's own program exists, asked where it was installed from: the dist-tags of its npm
 * package at the npm registry, or its formula or cask at the Homebrew API (casks trail npm, so a Homebrew install is
 * never held against npm). Both are fixed origins, asked through the Host's outbound fetch with no identifier of this
 * computer or person. Only the
 * agent settings ask, when they are read; nothing is asked on a timer, and the update command is never run.
 *
 * Claude Code follows the dist-tag its own settings name (`autoUpdatesChannel`: `latest` or `stable`); of Claude's
 * configuration directory only `settings.json` is opened, and only that key is kept.
 */
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { compareVersions, type ReleaseLookup } from '@latch/harness-acp'
import type { CommandDetection } from '@latch/protocol'
import type { FetchLike } from './egress.ts'

const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const HOMEBREW_API_ORIGIN = 'https://formulae.brew.sh'
const FOUND_TTL_MS = 6 * 60 * 60_000
/** A failed lookup is not asked again for this long, so a page read on every focus does not keep asking. */
const FAILED_TTL_MS = 10 * 60_000
const LOOKUP_MS = 5_000
const MAX_TAGS_BYTES = 16 * 1024
/** A formula or cask document carries its bottles and artifacts too: a few KiB today. */
const MAX_HOMEBREW_BYTES = 64 * 1024
const MAX_SETTINGS_BYTES = 1024 * 1024

/** An npm package name as the profiles name them; anything else is never put in a URL. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/u
/** A Homebrew formula or cask name as the profiles name them. */
const BREW_NAME = /^[a-z0-9][a-z0-9@+._-]{0,99}$/u
const VERSION = z
  .string()
  .max(64)
  .regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/u)
const DIST_TAGS = z.record(z.string().max(64), z.unknown())

export type UpdateChannel = 'latest' | 'stable'

/** What the Host knows of a found program (`updateSource` of `@latch/harness-acp`). */
export interface UpdateSource {
  lookup: ReleaseLookup
  current: string
  channel?: 'claude'
  claudeDirectory?: string
  command?: string
}

/** The dist-tags endpoint of one package, its scope's slash escaped as the registry expects. */
export function distTagsUrl(pkg: string): string | undefined {
  return PACKAGE.test(pkg) ? `${NPM_REGISTRY_ORIGIN}/-/package/${pkg.replace('/', '%2F')}/dist-tags` : undefined
}

/** The Homebrew API document of one formula or cask. */
export function homebrewUrl(kind: 'formula' | 'cask', name: string): string | undefined {
  return BREW_NAME.test(name) ? `${HOMEBREW_API_ORIGIN}/api/${kind}/${name}.json` : undefined
}

/**
 * A formula's stable version, or a cask's version without the build it may carry after a comma (`1.2.3,456`); undefined
 * for any other shape.
 */
export function readHomebrew(kind: 'formula' | 'cask', value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const raw =
    kind === 'formula'
      ? record.versions && typeof record.versions === 'object'
        ? (record.versions as Record<string, unknown>).stable
        : undefined
      : record.version
  if (typeof raw !== 'string') return undefined
  const version = VERSION.safeParse(kind === 'cask' ? raw.split(',')[0] : raw)
  return version.success ? version.data : undefined
}

/** The registry's answer as the tags that hold a release version; undefined for any other shape. */
export function readDistTags(value: unknown): Record<string, string> | undefined {
  const parsed = DIST_TAGS.safeParse(value)
  if (!parsed.success) return undefined
  const tags: Record<string, string> = {}
  for (const tag of ['latest', 'stable'] as const) {
    const version = VERSION.safeParse(parsed.data[tag])
    if (version.success) tags[tag] = version.data
  }
  return tags.latest || tags.stable ? tags : undefined
}

/** The hint for a program at `current` when the tag names `latest`: only a release strictly newer than it. */
export function updateHint(source: UpdateSource, latest: string | undefined): CommandDetection['update'] | undefined {
  if (!latest) return undefined
  return compareVersions(source.current, latest) === -1
    ? { current: source.current, latest, ...(source.command ? { command: source.command } : {}) }
    : undefined
}

/**
 * The dist-tag Claude Code follows, from `settings.json` in its configuration directory: opened without following a
 * link, a regular file of at most 1 MiB; anything missing, unreadable or unknown is `latest`.
 */
export async function readClaudeChannel(dir: string, bound = false): Promise<UpdateChannel> {
  let handle
  try {
    if (bound && (await realpath(dir)) !== dir) return 'latest'
    handle = await open(join(dir, 'settings.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return 'latest'
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return 'latest'
    const value: unknown = JSON.parse(await handle.readFile('utf8'))
    const channel = value && typeof value === 'object' ? (value as Record<string, unknown>).autoUpdatesChannel : undefined
    return channel === 'stable' ? 'stable' : 'latest'
  } catch {
    return 'latest'
  } finally {
    await handle.close().catch(() => {})
  }
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) return undefined
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  } catch {
    return undefined
  }
}

/** The key a lookup is kept under: one per package, formula or cask. */
const keyOf = (lookup: ReleaseLookup) => (lookup.registry === 'npm' ? `npm:${lookup.name}` : `homebrew:${lookup.kind}:${lookup.name}`)

/**
 * The tags one lookup found (`latest`, and `stable` where npm has it), or undefined when it failed or answered in
 * another shape.
 */
async function fetchRelease(lookup: ReleaseLookup, fetch: FetchLike): Promise<Record<string, string> | undefined> {
  if (lookup.registry === 'npm') {
    const url = distTagsUrl(lookup.name)
    return url ? fetchJson(url, fetch, MAX_TAGS_BYTES, readDistTags) : undefined
  }
  const url = homebrewUrl(lookup.kind, lookup.name)
  if (!url) return undefined
  return fetchJson(url, fetch, MAX_HOMEBREW_BYTES, value => {
    const latest = readHomebrew(lookup.kind, value)
    return latest ? { latest } : undefined
  })
}

async function fetchJson<T>(
  url: string,
  fetch: FetchLike,
  limit: number,
  read: (value: unknown) => T | undefined,
  timeoutMs = LOOKUP_MS,
): Promise<T | undefined> {
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal })
  } catch {
    return undefined
  }
  try {
    return response.status === 200 ? read(await boundedJson(response, limit)) : undefined
  } catch {
    return undefined
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}

interface Entry {
  at: number
  tags?: Record<string, string>
  pending?: Promise<void>
  /** Nobody waits for it any more: what it finds reaches clients only through `onChange`. */
  late?: true
}

/** The Host's lookups: kept in memory per package, formula or cask, never written anywhere. */
export class HarnessUpdates {
  private readonly entries = new Map<string, Entry>()
  private readonly channels = new Map<string, UpdateChannel>()
  private notifying = false

  constructor(
    private readonly options: {
      fetch: FetchLike
      /** Claude's configuration directory, read when a Claude program is among the sources. */
      claudeDir: () => string
      now?: () => number
      /**
       * Called once for the late lookups landing together, when one lands after `settle` stopped waiting with tags other
       * than those kept before; a lookup that lands in time is in the answer already.
       */
      onChange?: () => void
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** What is known now for this program; asks nothing. */
  hint(source: UpdateSource): CommandDetection['update'] | undefined {
    const tags = this.entries.get(keyOf(source.lookup))?.tags
    const npmChannel = source.lookup.registry === 'npm' && source.channel === 'claude'
    const channel = npmChannel ? (this.channels.get(source.claudeDirectory ?? '') ?? 'latest') : 'latest'
    return updateHint(source, tags?.[channel])
  }

  /** Starts the lookups that are missing or old for these programs, and waits for them at most `timeoutMs`. */
  async settle(sources: readonly UpdateSource[], timeoutMs: number): Promise<void> {
    const waits: Promise<unknown>[] = []
    const directories = new Set(
      sources.filter(source => source.channel === 'claude' && source.lookup.registry === 'npm').map(source => source.claudeDirectory ?? ''),
    )
    for (const directory of directories)
      waits.push(
        readClaudeChannel(directory || this.options.claudeDir(), !!directory).then(channel => this.channels.set(directory, channel)),
      )
    const lookups = new Map(sources.map(source => [keyOf(source.lookup), source.lookup]))
    for (const [key, lookup] of lookups) {
      const pending = this.lookup(key, lookup)
      if (pending) waits.push(pending)
    }
    if (!waits.length) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([Promise.allSettled(waits), new Promise<void>(resolve => (timer = setTimeout(resolve, timeoutMs)))])
    clearTimeout(timer)
    for (const entry of this.entries.values()) if (entry.pending) entry.late = true
  }

  /** One `onChange` for the late lookups that land in the same turn of the event loop. */
  private changed(): void {
    if (this.notifying) return
    this.notifying = true
    setImmediate(() => {
      this.notifying = false
      this.options.onChange?.()
    })
  }

  private lookup(key: string, lookup: ReleaseLookup): Promise<void> | undefined {
    const known = this.entries.get(key)
    if (known?.pending) return known.pending
    if (known && this.now() - known.at < (known.tags ? FOUND_TTL_MS : FAILED_TTL_MS)) return undefined
    const entry: Entry = { at: this.now(), ...(known?.tags ? { tags: known.tags } : {}) }
    entry.pending = fetchRelease(lookup, this.options.fetch).then(tags => {
      const before = JSON.stringify(known?.tags ?? null)
      delete entry.pending
      entry.at = this.now()
      // A failure keeps nothing: no hint until a lookup answers again.
      if (tags) entry.tags = tags
      else delete entry.tags
      if (entry.late && JSON.stringify(entry.tags ?? null) !== before) this.changed()
      delete entry.late
    })
    this.entries.set(key, entry)
    return entry.pending
  }
}
