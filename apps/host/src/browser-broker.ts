// The broker between the built-in harness's browser tools and the desktop app's preview tabs. The desktop app's main
// process registers as the one provider over host.sock and keeps a stream open; each call goes down that stream and
// comes back as a result main posts. Nothing queues: with no provider a call fails at once, and the Host never starts the
// desktop app. A call is audited before it is sent, and a stop is confirmed only once main says the call settled. The
// tab table main reports lives in memory only: the phone reads it, the risk classifier reads where each tab is.
// See docs/PREVIEW-BROWSER.md.
import { randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { ServerResponse } from 'node:http'
import { sha256Hex } from '@latch/core/node-kit'

export const BROWSER_TOOLS = [
  'browser_tabs',
  'browser_open',
  'browser_navigate',
  'browser_read',
  'browser_find',
  'browser_screenshot',
  'browser_scroll',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_wait',
  'browser_click',
  'browser_key',
  'browser_select',
  'browser_type',
  'browser_close',
] as const
export type BrowserTool = (typeof BROWSER_TOOLS)[number]
/** What only looks: no approval on this Mac's own addresses. */
export const BROWSER_READS: ReadonlySet<BrowserTool> = new Set([
  'browser_tabs',
  'browser_read',
  'browser_find',
  'browser_screenshot',
  'browser_scroll',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_wait',
])
/** Tools that work on a tab anywhere: listing and closing. Every other tool needs the tab on this Mac's own addresses. */
const ANYWHERE: ReadonlySet<BrowserTool> = new Set(['browser_tabs', 'browser_close'])
export const isBrowserTool = (name: string): name is BrowserTool => (BROWSER_TOOLS as readonly string[]).includes(name)

/** Where an address is: this Mac (`loopback`), the local network (`private`), the internet, or nowhere yet (`none`). */
export type OriginClass = 'loopback' | 'private' | 'internet' | 'none'

function v4(host: string): number[] | undefined {
  if (isIP(host) !== 4) return undefined
  return host.split('.').map(Number)
}

/** The eight groups of an IPv6 address (no dotted tail: URL writes one as hex), or undefined. */
function v6(text: string): number[] | undefined {
  const address = text.toLowerCase()
  if (isIP(address) !== 6 || address.includes('.')) return undefined
  const [head = '', tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = address.includes('::') && tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  const groups = [...left, ...Array.from({ length: address.includes('::') ? missing : 0 }, () => '0'), ...right]
  return groups.length === 8 ? groups.map(group => Number.parseInt(group, 16)) : undefined
}

/**
 * This Mac as the Agent may use it, the same set main uses (`agentLocalHost` in browser.cjs): localhost, `*.localhost`,
 * 127/8, ::1 and IPv4-mapped 127/8. Not 0.0.0.0 or ::, which name no one address.
 */
export function isLoopbackName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const bytes = v4(host)
  if (bytes) return bytes[0] === 127
  const groups = host.startsWith('[') && host.endsWith(']') ? v6(host.slice(1, -1)) : undefined
  if (!groups) return false
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true
  return groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff && (groups[6] ?? 0) >> 8 === 127
}

function isPrivateName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  const bytes = v4(host)
  if (bytes) {
    const [a = 0, b = 0] = bytes
    return (
      a === 0
      || a === 10
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
    )
  }
  if (host.startsWith('[')) return /^\[f[cd]|^\[fe[89ab]/u.test(host)
  return /\.(?:local|lan|internal|home\.arpa)$/u.test(host) || !host.includes('.')
}

/** The class of an address; anything but an http(s) address is `none` (a blank tab). */
export function originClass(raw: string | undefined): OriginClass {
  if (!raw) return 'none'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'none'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'none'
  if (isLoopbackName(url.hostname)) return 'loopback'
  return isPrivateName(url.hostname) ? 'private' : 'internet'
}

const originOf = (raw: string | undefined): string | undefined => {
  try {
    const url = new URL(raw ?? '')
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** A tab as main reports it: never the query of its address. */
export interface BrowserTab {
  tabId: string
  sessionId: string
  title: string
  /** Origin and path. */
  url: string
  loading: boolean
  /** An Agent action runs in it (`agent`), or the person took it over (`person`). */
  control: 'agent' | 'person' | null
  opener: 'agent' | 'person'
}

/** What a call's result carries back from main. */
export interface ProviderResult {
  callId: string
  ok: boolean
  /** Whether the action reached the page: false for a refusal before anything happened. */
  dispatched: boolean
  text?: string
  error?: string
  /** The tab the call worked on, as it is after the call. */
  tab?: { tabId: string; url: string; title: string }
  /** Element references the call handed out, and whether each names a field whose value is never read. */
  refs?: Record<string, boolean>
  /** A picture follows (`PUT …/results/:callId/image`), which main sends before this result. */
  image?: boolean
}

export type BrokerOutcome =
  | { ok: true; text: string; image?: Buffer; dispatched: boolean }
  | { ok: false; error: string; dispatched: boolean; detail?: string }

export interface BrowserCallInput {
  sessionId: string
  projectId: string
  tool: BrowserTool
  args: Record<string, unknown>
  risk: 'R0' | 'R1' | 'R2'
  /** The runtime's ID of the tool call, as the session and `approval.decided` record it. */
  toolCallId?: string
  /** The approval the person gave this call, when it asked. */
  approvalId?: string
  signal: AbortSignal
  /** Marks time spent waiting for the person (a takeover) as waiting. */
  waitForUser?: () => () => void
}

export interface BrowserAuditInput {
  sessionId: string
  callId: string
  tool: BrowserTool
  tabId?: string
  origin: OriginClass
  originHash?: string
  risk: 'R0' | 'R1' | 'R2'
  toolCallId?: string
  approvalId?: string
}

export interface BrowserBrokerOptions {
  /** Appends `browser.call` before a call is sent; a rejection keeps the call from going out. */
  auditCall: (input: BrowserAuditInput) => Promise<void>
  /** `browser.provider.registered` and `browser.provider.ended`; best effort. */
  auditProvider?: (event: 'registered' | 'ended', deviceId: string) => void
  now?: () => number
  /** How long a takeover holds a call, how long main has to settle a cancel, and the deadlines; tests shorten them. */
  takeoverMs?: number
  settleMs?: number
  deadlineMs?: number
  longDeadlineMs?: number
  heartbeatMs?: number
}

const TAKEOVER_MS = 10 * 60_000
const SETTLE_MS = 5_000
const DEADLINE_MS = 15_000
const LONG_DEADLINE_MS = 30_000
const HEARTBEAT_MS = 15_000
const IMAGE_LIMIT = 5 * 1024 * 1024
const TAB_LIMIT = 64
const REF_LIMIT = 2_000
/** Calls that may take long: loading a page and waiting for something on it. */
const LONG: ReadonlySet<BrowserTool> = new Set(['browser_open', 'browser_navigate', 'browser_wait'])

interface Pending {
  callId: string
  sessionId: string
  tool: BrowserTool
  resolve: (result: ProviderResult | 'gone') => void
  image?: Buffer
}

interface Provider {
  id: string
  deviceId: string
  stream?: ServerResponse
  heartbeat?: ReturnType<typeof setInterval>
}

/** A failure the broker answers with, before or without main. */
const refused = (error: string, dispatched = false, detail?: string): BrokerOutcome => ({
  ok: false,
  error,
  dispatched,
  ...(detail ? { detail } : {}),
})

export class BrowserBroker {
  private provider: Provider | undefined
  private readonly tabs = new Map<string, BrowserTab>()
  /** Per tab: the element references main handed out, and whether each names a field whose value is never read. */
  private readonly refs = new Map<string, Map<string, boolean>>()
  private readonly pending = new Map<string, Pending>()
  /** Sessions with a call out: one at a time each. */
  private readonly busy = new Set<string>()
  /** Who waits for the tab table to change (a takeover ending). */
  private readonly watchers = new Set<() => void>()
  private readonly now: () => number
  private readonly takeoverMs: number
  private readonly settleMs: number
  private readonly deadlineMs: number
  private readonly longDeadlineMs: number
  private readonly heartbeatMs: number

  constructor(private readonly options: BrowserBrokerOptions) {
    this.now = options.now ?? Date.now
    this.takeoverMs = options.takeoverMs ?? TAKEOVER_MS
    this.settleMs = options.settleMs ?? SETTLE_MS
    this.deadlineMs = options.deadlineMs ?? DEADLINE_MS
    this.longDeadlineMs = options.longDeadlineMs ?? LONG_DEADLINE_MS
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  }

  /** Whether a provider is registered with an open stream. */
  available(): boolean {
    return this.provider?.stream !== undefined
  }

  /**
   * A new provider for `deviceId`; the one before it, if any, ends with its stream and its calls. Returns the provider's
   * ID, which main names on every later request.
   */
  register(deviceId: string): string {
    this.end('replaced')
    const id = `bpv_${randomBytes(16).toString('base64url')}`
    this.provider = { id, deviceId }
    this.options.auditProvider?.('registered', deviceId)
    return id
  }

  /** The provider `providerId` of `deviceId`, if it is the current one. */
  private current(deviceId: string, providerId: unknown): Provider | undefined {
    const provider = this.provider
    return provider && provider.id === providerId && provider.deviceId === deviceId ? provider : undefined
  }

  /** Opens the provider's stream; false when `providerId` is not the current provider of this device. */
  openStream(deviceId: string, providerId: unknown, res: ServerResponse): boolean {
    const provider = this.current(deviceId, providerId)
    if (!provider || provider.stream) return false
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': open\n\n')
    provider.stream = res
    provider.heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n')
    }, this.heartbeatMs)
    provider.heartbeat.unref?.()
    res.once('close', () => {
      if (this.provider === provider) this.end('closed')
    })
    return true
  }

  /** Ends the provider: its stream closes, its calls fail, its tabs are forgotten. */
  end(_why: 'replaced' | 'closed' | 'stopping'): void {
    const provider = this.provider
    if (!provider) return
    this.provider = undefined
    if (provider.heartbeat) clearInterval(provider.heartbeat)
    if (provider.stream && !provider.stream.writableEnded) provider.stream.end(frame('ended', {}))
    for (const pending of this.pending.values()) pending.resolve('gone')
    this.pending.clear()
    this.tabs.clear()
    this.refs.clear()
    this.wake()
    this.options.auditProvider?.('ended', provider.deviceId)
  }

  private send(event: string, data: unknown): boolean {
    const stream = this.provider?.stream
    if (!stream || stream.writableEnded) return false
    stream.write(frame(event, data))
    return true
  }

  /** The tab table main reported, whole. */
  reportTabs(deviceId: string, providerId: unknown, tabs: BrowserTab[]): boolean {
    if (!this.current(deviceId, providerId)) return false
    const known = new Set<string>()
    for (const tab of tabs.slice(0, TAB_LIMIT)) {
      known.add(tab.tabId)
      this.tabs.set(tab.tabId, tab)
    }
    for (const tabId of [...this.tabs.keys()])
      if (!known.has(tabId)) {
        this.tabs.delete(tabId)
        this.refs.delete(tabId)
      }
    this.wake()
    return true
  }

  /** A call's picture, which main sends before the call's result. */
  putImage(deviceId: string, callId: string, data: Buffer): boolean {
    const pending = this.pending.get(callId)
    if (!pending || !this.provider || this.provider.deviceId !== deviceId) return false
    if (data.length > IMAGE_LIMIT || !isPng(data)) return false
    pending.image = data
    return true
  }

  /** A call's result. False when nothing waits for it (late, or from another provider). */
  settle(deviceId: string, result: ProviderResult): boolean {
    const pending = this.pending.get(result.callId)
    if (!pending || !this.provider || this.provider.deviceId !== deviceId) return false
    this.pending.delete(result.callId)
    pending.resolve(result)
    return true
  }

  /** The session's tabs, for the phone's read-only list. */
  tabsOf(sessionId: string): BrowserTab[] {
    return [...this.tabs.values()].filter(tab => tab.sessionId === sessionId)
  }

  /** Where a tab of the session is, and who opened it; undefined when the session has no such tab. */
  tabFacts(sessionId: string, tabId: unknown): { origin: OriginClass; opener: 'agent' | 'person' } | undefined {
    const tab = typeof tabId === 'string' ? this.tabs.get(tabId) : undefined
    return tab && tab.sessionId === sessionId ? { origin: originClass(tab.url), opener: tab.opener } : undefined
  }

  /** Whether a reference of the tab names a field whose value is never read; undefined when it was never handed out. */
  refSensitive(sessionId: string, tabId: unknown, ref: unknown): boolean | undefined {
    if (typeof tabId !== 'string' || typeof ref !== 'string' || this.tabs.get(tabId)?.sessionId !== sessionId) return undefined
    return this.refs.get(tabId)?.get(ref)
  }

  /** The session ended (archived or deleted): main closes its tabs. */
  sessionEnded(sessionId: string): void {
    this.send('session-ended', { sessionId })
  }

  /** A turn of the session ended: main ends any takeover of its tabs. */
  turnEnded(sessionId: string): void {
    this.send('turn-ended', { sessionId })
  }

  private wake(): void {
    for (const watcher of [...this.watchers]) watcher()
  }

  /** Resolves when the tab table changes, the signal aborts or `ms` pass. */
  private changed(signal: AbortSignal, ms: number): Promise<void> {
    return new Promise(done => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        this.watchers.delete(finish)
        done()
      }
      const timer = setTimeout(finish, ms)
      signal.addEventListener('abort', finish, { once: true })
      this.watchers.add(finish)
    })
  }

  /**
   * Holds a call while the person has the tab, up to the takeover limit. False when the limit passed with the person
   * still holding it; the signal's abort ends the wait too (the caller sees the signal).
   */
  private async takenOver(input: BrowserCallInput, tabId: string | undefined, deadline: number): Promise<boolean> {
    if (!tabId || this.tabs.get(tabId)?.control !== 'person') return true
    const close = input.waitForUser?.()
    try {
      while (this.tabs.get(tabId)?.control === 'person') {
        if (input.signal.aborted) return true
        const left = deadline - this.now()
        if (left <= 0) return false
        await this.changed(input.signal, left)
      }
      return true
    } finally {
      close?.()
    }
  }

  /**
   * One call of the built-in harness's browser tools. Refused here, without main, when there is no provider, when the
   * tab is not the session's or not on this Mac. Otherwise audited, then sent;
   * a person's takeover holds it for up to ten minutes. A stop sends `cancel` and waits for main to report the call
   * settled; a call main does not settle in time, or a provider that goes away, leaves its result unknown when it may
   * have acted.
   */
  async call(input: BrowserCallInput): Promise<BrokerOutcome> {
    const { sessionId, tool, args } = input
    if (!this.available()) return refused('browser-unavailable')
    if (this.busy.has(sessionId)) return refused('busy')
    const tabId = typeof args.tabId === 'string' ? args.tabId : undefined
    if (tool !== 'browser_tabs' && tool !== 'browser_open') {
      if (!tabId || this.tabs.get(tabId)?.sessionId !== sessionId) return refused('not-found')
    }
    const tab = tabId ? this.tabs.get(tabId) : undefined
    const target = typeof args.url === 'string' ? args.url : undefined
    if (!ANYWHERE.has(tool)) {
      const here = tab ? originClass(tab.url) : 'none'
      if (here !== 'loopback' && here !== 'none') return refused('not-local')
      if (target !== undefined && originClass(target) !== 'loopback' && !/^\d{1,5}$/u.test(target.trim())) return refused('not-local')
    }
    this.busy.add(sessionId)
    try {
      const takeoverDeadline = this.now() + this.takeoverMs
      for (;;) {
        if (!(await this.takenOver(input, tabId, takeoverDeadline))) return refused('taken-over')
        input.signal.throwIfAborted()
        const outcome = await this.dispatch(input, tabId)
        // The person took the tab between the table and main: wait for them again, within the same ten minutes.
        if (!outcome.ok && outcome.error === 'taken-over' && !outcome.dispatched && this.now() < takeoverDeadline) {
          const current = tabId ? this.tabs.get(tabId) : undefined
          if (current && current.control !== 'person') this.tabs.set(tabId!, { ...current, control: 'person' })
          continue
        }
        return outcome
      }
    } finally {
      this.busy.delete(sessionId)
    }
  }

  private async dispatch(input: BrowserCallInput, tabId: string | undefined): Promise<BrokerOutcome> {
    const { sessionId, tool, signal } = input
    if (!this.available()) return refused('browser-unavailable')
    const tab = tabId ? this.tabs.get(tabId) : undefined
    const origin = originOf(tab?.url)
    const callId = randomUUID()
    try {
      await this.options.auditCall({
        sessionId,
        callId,
        tool,
        ...(tabId ? { tabId } : {}),
        origin: originClass(tab?.url),
        ...(origin ? { originHash: sha256Hex(origin) } : {}),
        risk: input.risk,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      })
    } catch {
      return refused('audit-failed')
    }
    signal.throwIfAborted()
    let settle!: (result: ProviderResult | 'gone') => void
    const answered = new Promise<ProviderResult | 'gone'>(resolve => {
      settle = resolve
    })
    const pending: Pending = { callId, sessionId, tool, resolve: settle }
    this.pending.set(callId, pending)
    const ms = LONG.has(tool) ? this.longDeadlineMs : this.deadlineMs
    const sent = this.send('call', {
      callId,
      sessionId,
      projectId: input.projectId,
      tool,
      args: input.args,
      // Where the tab was when the call was classified: main refuses it if the tab has gone elsewhere since.
      origin: origin ?? null,
      risk: input.risk,
      deadline: ms,
    })
    if (!sent) {
      this.pending.delete(callId)
      return refused('browser-unavailable')
    }
    const stop = new AbortController()
    const onAbort = () => stop.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop.abort(), ms)
    let result: ProviderResult | 'gone' | 'stopped'
    try {
      result = await Promise.race([
        answered,
        new Promise<'stopped'>(done => {
          if (stop.signal.aborted) done('stopped')
          else stop.signal.addEventListener('abort', () => done('stopped'), { once: true })
        }),
      ])
      if (result === 'stopped') {
        // Main stops waiting or loading and reports whether the action reached the page; until then nothing is settled.
        this.send('cancel', { callId })
        const late = await Promise.race([answered, delay(this.settleMs).then(() => 'late' as const)])
        this.pending.delete(callId)
        const reason = signal.aborted ? 'cancelled' : 'timeout'
        if (late === 'late' || late === 'gone')
          return refused(BROWSER_READS.has(tool) ? reason : 'result-unknown', !BROWSER_READS.has(tool))
        this.learn(late)
        return late.ok ? outcomeOf(late, pending) : refused(reason, late.dispatched)
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    if (result === 'gone') return BROWSER_READS.has(tool) ? refused('browser-unavailable') : refused('result-unknown', true)
    this.learn(result)
    return outcomeOf(result, pending)
  }

  /** What a result tells the table: where the tab is now, and the references it handed out. */
  private learn(result: ProviderResult): void {
    const tab = result.tab ? this.tabs.get(result.tab.tabId) : undefined
    if (tab && result.tab) this.tabs.set(tab.tabId, { ...tab, url: result.tab.url, title: result.tab.title })
    if (result.tab && result.refs) {
      const known = this.refs.get(result.tab.tabId) ?? new Map<string, boolean>()
      for (const [ref, sensitive] of Object.entries(result.refs)) {
        if (known.size >= REF_LIMIT) known.delete(known.keys().next().value!)
        known.set(ref, sensitive === true)
      }
      this.refs.set(result.tab.tabId, known)
    }
  }
}

function outcomeOf(result: ProviderResult, pending: Pending): BrokerOutcome {
  if (!result.ok) return refused(result.error ?? 'failed', result.dispatched)
  return {
    ok: true,
    text: result.text ?? '',
    dispatched: result.dispatched,
    ...(result.image && pending.image ? { image: pending.image } : {}),
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function delay(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}

function isPng(data: Buffer): boolean {
  return data.length > 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('latin1', 12, 16) === 'IHDR'
}
