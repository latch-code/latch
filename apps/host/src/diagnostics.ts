// 诊断导出: a file the person hands to whoever helps them, made on request (设置 › 关于 in the desktop app, or
// `pnpm latch diagnostics`). It holds versions, the Harnesses' and plugins' states, the shape of the policy, connection
// counts and the Host's recent events. The events are not log lines: the Host notes them at a fixed list of its own log
// sites as a category, an ID and an error code, so agent stderr, agent text, prompts and policy hosts never reach them.
// Every free string left (IDs, the first line of a Harness's status) passes through `redactSecrets` again, with the home
// folder written as `~` and any other absolute path as a placeholder. Never prompts, transcripts, file contents,
// memories, device names or anything from auth/ or providers.json: the bundle is built from an explicit list of fields.
import { arch, platform, release } from 'node:os'
import { redactSecrets } from '@latch/core/node-kit'
import type { HarnessInfo, ListenerClass, PluginInfo } from '@latch/protocol'
import type { Policy } from './policy.ts'

/** Events kept for the bundle, and failures kept apart so a busy run does not push them out. */
export const DIAGNOSTIC_EVENTS = 400
export const DIAGNOSTIC_ERRORS = 100
/** A Harness status is kept to its first line, at most this long. */
export const DIAGNOSTIC_STATUS_CHARS = 200

/** The Host's own log sites that note an event, and whether each is a failure. */
export const DIAGNOSTIC_CATEGORIES = {
  'audit-write-failed': 'error',
  'confirmed-addresses-failed': 'error',
  'discovery-rotation-failed': 'error',
  'workspace-in-data-dir': 'warn',
  'workspace-overlaps-code': 'warn',
  'settings-changed-outside': 'warn',
  'project-unavailable': 'warn',
  'provider-load-failed': 'error',
  'provider-restore-failed': 'error',
  'agent-load-failed': 'error',
  'harness-load-failed': 'error',
  'plugin-load-failed': 'error',
  'plugin-cleanup-failed': 'error',
  'plugin-rollback-failed': 'error',
  'cleanup-failed': 'error',
  'security-event-failed': 'error',
  'permission-unconfirmed': 'warn',
  'queue-update-failed': 'error',
  'receipt-save-failed': 'error',
  'worktree-mark-failed': 'error',
  'request-failed': 'error',
} as const
export type DiagnosticCategory = keyof typeof DIAGNOSTIC_CATEGORIES

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,63}$/u
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/u

export interface DiagnosticEvent {
  at: string
  category: DiagnosticCategory
  /** A Harness, provider, plugin or session ID the event is about; IDs only, checked by shape. */
  id?: string
  /** An error's code (`ENOENT`, `audit-unavailable`), never its message. */
  code?: string
}

/** The code of an error: an `AppError`'s or a system error's, when it has the shape of one. */
export function errorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined
}

/** The Host's recent events, in memory only. */
export class DiagnosticLog {
  private readonly events: DiagnosticEvent[] = []
  private readonly failures: DiagnosticEvent[] = []
  constructor(private readonly now: () => number = Date.now) {}

  /** Notes an event; an ID or code that is not shaped like one is dropped, never kept as text. */
  note(category: DiagnosticCategory, detail: { id?: string; error?: unknown } = {}): void {
    if (!Object.hasOwn(DIAGNOSTIC_CATEGORIES, category)) return
    const code = errorCode(detail.error)
    const event: DiagnosticEvent = {
      at: new Date(this.now()).toISOString(),
      category,
      ...(detail.id !== undefined && EVENT_ID.test(detail.id) && redactSecrets(detail.id) === detail.id ? { id: detail.id } : {}),
      ...(code && redactSecrets(code) === code ? { code } : {}),
    }
    this.events.push(event)
    if (this.events.length > DIAGNOSTIC_EVENTS) this.events.shift()
    if (DIAGNOSTIC_CATEGORIES[category] === 'error') {
      this.failures.push(event)
      if (this.failures.length > DIAGNOSTIC_ERRORS) this.failures.shift()
    }
  }

  recent(): { events: DiagnosticEvent[]; errors: DiagnosticEvent[] } {
    return { events: [...this.events], errors: [...this.failures] }
  }
}

export interface DiagnosticsInput {
  version: string
  startedAt: string
  now: () => number
  home: string
  harnesses: readonly HarnessInfo[]
  plugins: readonly PluginInfo[]
  policy: Policy
  /** Paired devices and how many are revoked; names never leave. */
  devices: { active: number; revoked: number }
  /** Open event streams by listener class. */
  streams: Partial<Record<ListenerClass, number>>
  log: DiagnosticLog
  /**
   * Words that must not appear in the bundle even inside a log line (device names, project and session titles): each is
   * replaced with `‹已隐去›`.
   */
  private?: readonly string[]
}

export interface DiagnosticsBundle {
  format: 'latch-diagnostics'
  version: 1
  createdAt: string
  host: { version: string; node: string; os: string; arch: string; startedAt: string }
  harnesses: Array<{ id: string; status: string; level: string; modes: string[]; version?: string; message?: string }>
  plugins: Array<{ id: string; version: string; enabled: boolean; activeRuns: number }>
  policy: {
    presenceBackend: string
    presenceHelperPinned: boolean
    egressAllowCount: number
    confirmedAddressCount: number
    operatorCount: number
    keyBackend: string
    unattended: Policy['unattended']
  }
  connections: { devices: { active: number; revoked: number }; streams: Partial<Record<ListenerClass, number>> }
  events: DiagnosticEvent[]
  errors: DiagnosticEvent[]
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * One string made safe for the bundle: redacted again, every private word hidden, the home folder as `~`, and any
 * other user's home folder hidden too.
 */
export function diagnosticText(text: string, home: string, hidden: readonly string[] = []): string {
  let out = redactSecrets(text)
  for (const word of [...new Set(hidden)].filter(word => word.trim().length >= 2).toSorted((a, b) => b.length - a.length))
    out = out.replaceAll(word, '‹已隐去›')
  if (home && home !== '/') out = out.replace(new RegExp(`${escapeRegExp(home.replace(/\/+$/u, ''))}(?=/|\\b|$)`, 'gu'), '~')
  out = out.replace(/\/(?:Users|home)\/[^/\s'"`)]+/gu, '~other')
  // Any other absolute path (a temporary folder, a mounted volume): only that there was one.
  out = out.replace(/(?<![\w~:/.-])\/[^\s'"`)，。；]+/gu, '‹路径›')
  return redactSecrets(out)
}

/** The first line of a status message, at most `DIAGNOSTIC_STATUS_CHARS` code points. */
const firstLine = (text: string) => [...(text.split(/\r?\n/u)[0] ?? '')].slice(0, DIAGNOSTIC_STATUS_CHARS).join('')

/** The bundle; every free-text field goes through `diagnosticText`. */
export function diagnosticsBundle(input: DiagnosticsInput): DiagnosticsBundle {
  const versions = new Map(input.plugins.map(plugin => [plugin.id, plugin.version]))
  const { events, errors } = input.log.recent()
  const clean = (text: string) => diagnosticText(text, input.home, input.private)
  const ids = (event: DiagnosticEvent): DiagnosticEvent => ({ ...event, ...(event.id ? { id: clean(event.id) } : {}) })
  const policy = input.policy
  return {
    format: 'latch-diagnostics',
    version: 1,
    createdAt: new Date(input.now()).toISOString(),
    host: { version: input.version, node: process.version, os: `${platform()} ${release()}`, arch: arch(), startedAt: input.startedAt },
    harnesses: input.harnesses.map(harness => ({
      id: clean(harness.id),
      status: harness.status,
      level: harness.level,
      modes: [...harness.modes],
      ...(versions.has(harness.id) ? { version: clean(versions.get(harness.id)!) } : {}),
      ...(harness.statusMessage ? { message: clean(firstLine(harness.statusMessage)) } : {}),
    })),
    plugins: input.plugins.map(plugin => ({
      id: clean(plugin.id),
      version: clean(plugin.version),
      enabled: plugin.enabled,
      activeRuns: plugin.activeRuns,
    })),
    policy: {
      presenceBackend: policy.presence.backend,
      presenceHelperPinned: policy.presence.helperCdhash !== null,
      egressAllowCount: policy.hostEgressAllow.length,
      confirmedAddressCount: policy.confirmedAddresses?.length ?? 0,
      operatorCount: policy.operators.length,
      keyBackend: policy.keyBackend,
      unattended: structuredClone(policy.unattended),
    },
    connections: { devices: { ...input.devices }, streams: { ...input.streams } },
    events: events.map(ids),
    errors: errors.map(ids),
  }
}
