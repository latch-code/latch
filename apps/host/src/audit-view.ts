// 审计记录 (docs/ARCHITECTURE.md#审计记录): the audit log as people read it. Read-only, newest first, filtered before it is
// paged, from the file's acknowledged lines. A record shows only what its strict schema holds, projected: who (a device
// by its name, the Host or the command line), when, the action's human name, what it was about (sessions, devices,
// Agents, projects and Harnesses by the names the Host knows now), enums, booleans and counts as written, other ids and
// hashes as short ids, and only the fields `audit-fields.ts` marks for showing: one derived from secret material, or not
// marked at all, is never shown. The route lets only a device
// that may read everything (`admin` and data scope `all`) ask, so no record tells a narrower device about a private
// session or another device.
import { AUDIT_KINDS, type AuditEntry, type AuditKind, type AuditPage, type AuditRef } from '@latch/protocol'
import type { AuditLog, AuditRecord } from './audit.ts'
import { AUDIT_FIELDS, type AuditFieldView } from './audit-fields.ts'
import { AUDIT_LABELS } from './audit-labels.ts'

/** One page's bounds: what it answers, and how many records it may read looking for them. */
const AUDIT_PAGE = { limit: 50, maxLimit: 100, scan: 5000, chunk: 256 } as const
const SHORT = 8

export interface AuditQuery {
  before?: number
  limit?: number
  kind?: AuditKind
  /** A device's ID, `host` or `cli`. */
  actor?: string
  since?: string
  until?: string
}

/** The names the Host knows now; each answers undefined for what it does not know. */
export interface AuditNames {
  session: (id: string) => string | undefined
  device: (id: string) => string | undefined
  agent: (id: string) => string | undefined
  project: (id: string) => string | undefined
  harness: (id: string) => string | undefined
  devices: () => Array<{ id: string; name: string }>
}

/** A value that reads as a word of an enum rather than an id. */
const WORD = /^[a-z][a-z0-9-]{0,31}$/u

const short = (value: string): string => (value.length > SHORT ? value.slice(0, SHORT) : value)

/** What a field or target names, by the field's name first and then by what the Host can find. */
function refOf(value: string, names: AuditNames, field?: string): AuditRef {
  const by = (kind: AuditRef['kind'], name: string | undefined): AuditRef => ({ kind, short: short(value), ...(name ? { name } : {}) })
  if (field === 'sessionId') return by('session', names.session(value))
  if (field === 'deviceId' || field === 'targetDeviceId') return by('device', names.device(value))
  if (field === 'customAgentId') return by('agent', names.agent(value))
  if (field === 'workspaceId' || field === 'projectId') return by('project', names.project(value))
  if (field === 'agentId' || field === 'harnessId') return by('harness', names.harness(value))
  const found = (
    [
      ['session', names.session(value)],
      ['device', names.device(value)],
      ['agent', names.agent(value)],
      ['project', names.project(value)],
      ['harness', names.harness(value)],
    ] as const
  ).find(([, name]) => name !== undefined)
  return found ? by(found[0], found[1]) : by('other', undefined)
}

const NAMED_FIELDS = new Set([
  'sessionId',
  'deviceId',
  'targetDeviceId',
  'customAgentId',
  'workspaceId',
  'projectId',
  'agentId',
  'harnessId',
])

/** A record as 审计记录 shows it. */
function auditEntry(record: AuditRecord, names: AuditNames): AuditEntry {
  const [kind, label] = AUDIT_LABELS[record.action]
  const fields: AuditEntry['fields'] = []
  // Only what the action's field table marks; a field it does not name is not shown (`audit-fields.ts`).
  const views = AUDIT_FIELDS[record.action] as Readonly<Record<string, AuditFieldView>>
  for (const [name, value] of Object.entries(record.detail)) {
    const view = Object.hasOwn(views, name) ? views[name] : 'hidden'
    if (view === 'hidden') continue
    if (typeof value === 'boolean' || typeof value === 'number') fields.push({ name, value })
    else if (typeof value === 'string') {
      if (view === 'short' && NAMED_FIELDS.has(name)) {
        const ref = refOf(value, names, name)
        fields.push({ name, value: ref.name ?? ref.short, ref })
      } else fields.push({ name, value: view === 'show' && WORD.test(value) ? value : short(value) })
    } else if (Array.isArray(value)) {
      const words = value.filter((item): item is string => typeof item === 'string' && WORD.test(item))
      fields.push({ name, value: words.length === value.length ? words.join('、') : value.length })
    }
  }
  const actor: AuditEntry['actor'] = record.actor.deviceId
    ? { kind: 'device', short: short(record.actor.deviceId), ...withName(names.device(record.actor.deviceId)) }
    : { kind: record.actor.listener === 'cli' || record.actor.via === 'cli' ? 'cli' : 'host' }
  return {
    seq: record.seq,
    at: record.at,
    actor,
    action: record.action,
    label,
    kind,
    ...(record.target ? { target: refOf(record.target, names) } : {}),
    stepup: record.stepup,
    fields,
  }
}
const withName = (name: string | undefined) => (name ? { name } : {})

function matches(record: AuditRecord, query: AuditQuery): boolean {
  if (query.kind && AUDIT_LABELS[record.action][0] !== query.kind) return false
  if (query.actor) {
    const who = record.actor.deviceId ?? (record.actor.listener === 'cli' || record.actor.via === 'cli' ? 'cli' : 'host')
    if (who !== query.actor) return false
  }
  if (query.until && record.at > query.until) return false
  return true
}

/**
 * Newest first, from `before` back: the records that pass the filters, up to `limit`. It reads at most `AUDIT_PAGE.scan`
 * records per page; `next` continues where it stopped. Records are in time order, so it stops at the first one older
 * than `since`.
 */
export async function auditPage(log: AuditLog, query: AuditQuery, names: AuditNames): Promise<AuditPage> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? AUDIT_PAGE.limit)), AUDIT_PAGE.maxLimit)
  let cursor = Math.min(query.before ?? Number.MAX_SAFE_INTEGER, log.head().seq + 1)
  const entries: AuditEntry[] = []
  let scanned = 0
  let ended = false
  while (entries.length < limit && scanned < AUDIT_PAGE.scan && cursor > 1 && !ended) {
    const chunk = await log.readBefore(cursor, Math.min(AUDIT_PAGE.chunk, AUDIT_PAGE.scan - scanned))
    if (!chunk.length) break
    for (const record of chunk.toReversed()) {
      cursor = record.seq
      scanned++
      if (query.since && record.at < query.since) {
        ended = true
        break
      }
      if (matches(record, query)) entries.push(auditEntry(record, names))
      if (entries.length >= limit) break
    }
  }
  return { entries, ...(!ended && cursor > 1 ? { next: cursor } : {}), actors: names.devices() }
}

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const number = (name: string) => {
    const raw = params.get(name)
    if (raw === null || !/^\d{1,15}$/u.test(raw)) return undefined
    return Number(raw)
  }
  const time = (name: string) => {
    const raw = params.get(name)
    return raw !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(raw) && !Number.isNaN(Date.parse(raw))
      ? new Date(raw).toISOString()
      : undefined
  }
  const kind = params.get('kind')
  const actor = params.get('actor')
  const before = number('before'),
    limit = number('limit'),
    since = time('since'),
    until = time('until')
  return {
    ...(before !== undefined ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(kind !== null && (AUDIT_KINDS as readonly string[]).includes(kind) ? { kind: kind as AuditKind } : {}),
    ...(actor !== null && /^(?:host|cli|dev_[A-Za-z0-9_-]{22})$/u.test(actor) ? { actor } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  }
}
