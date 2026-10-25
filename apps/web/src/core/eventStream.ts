/**
 * Reads `/link/api/events` with fetch instead of EventSource: the same
 * text/event-stream protocol, but the response status is visible (401 means
 * renew or re-enroll, not "retry forever") and the request goes through the
 * Electron shell's proxy like every other API call.
 */

export interface StreamEvent {
  event: string
  data: string
  id?: string
}

/** Incremental text/event-stream parser: CR, LF and CRLF line ends (also split across chunks), multi-line data, comments. */
export class EventStreamParser {
  private line = ''
  private skipLineFeed = false
  private started = false
  private data: string[] = []
  private event = ''
  private id: string | undefined

  feed(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = []
    let text = chunk
    if (!this.started && text.length > 0) {
      this.started = true
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    let start = 0
    for (let index = 0; index < text.length; index++) {
      const character = text[index]
      if (this.skipLineFeed) {
        this.skipLineFeed = false
        if (character === '\n') {
          start = index + 1
          continue
        }
      }
      if (character !== '\r' && character !== '\n') continue
      this.line += text.slice(start, index)
      const event = this.processLine(this.line)
      if (event) events.push(event)
      this.line = ''
      start = index + 1
      if (character === '\r') this.skipLineFeed = true
    }
    this.line += text.slice(start)
    return events
  }

  private processLine(line: string): StreamEvent | undefined {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
    else if (field === 'id' && !value.includes('\0')) this.id = value
    return
  }

  private dispatch(): StreamEvent | undefined {
    const data = this.data
    const event = this.event || 'message'
    this.data = []
    this.event = ''
    if (data.length === 0) return
    return { event, data: data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}) }
  }
}

export interface EventStreamHandlers {
  /** The response arrived with a 2xx status and a body; frames follow. */
  onOpen: () => void
  onEvent: (event: StreamEvent) => void
  /** A connection attempt failed or an open stream ended; another attempt follows after a backoff. */
  onError: () => void
  /**
   * HTTP 401 with the Host's error code. 'renewed' (a renewal just succeeded) reconnects at once, 'retry' after the
   * usual backoff, and 'stop' ends the stream.
   */
  onUnauthorized: (code: string) => Promise<UnauthorizedDecision> | UnauthorizedDecision
}

export type UnauthorizedDecision = 'renewed' | 'retry' | 'stop'

export interface EventStreamOptions {
  fetch?: typeof fetch
  /** Reconnect delays grow from `initialDelayMs` to `maxDelayMs`. */
  initialDelayMs?: number
  maxDelayMs?: number
  /** No bytes for this long (the Host sends a heartbeat every 15 s) counts as a disconnect. */
  stallMs?: number
}

export interface EventStreamConnection {
  /** True between onOpen and the next disconnect. */
  readonly open: boolean
  /** Skip the remaining backoff, e.g. when the browser comes back online; also ends a suspension. */
  reconnect: () => void
  /** Drop the connection and stay disconnected until reconnect(), e.g. while the browser is offline. */
  suspend: () => void
  /**
   * The Host announced it stops answering for now: drop the connection and wait at least `delayMs` before each attempt
   * until a stream opens again, instead of the usual backoff.
   */
  deferReconnect: (delayMs: number) => void
  close: () => void
}

export function backoffDelay(attempt: number, initialMs = 1000, maxMs = 15_000): number {
  return Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt))
}

export function connectEventStream(url: string, handlers: EventStreamHandlers, options: EventStreamOptions = {}): EventStreamConnection {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const stallMs = options.stallMs ?? 45_000
  let closed = false
  let suspended = false
  let open = false
  let request: AbortController | null = null
  let wake: (() => void) | null = null
  let attempt = 0
  /** One immediate reconnect per renewal: a Host that keeps answering renewal-required falls back to the backoff. */
  let immediateUsed = false
  /** The shortest wait between attempts the Host asked for; cleared once a stream opens. */
  let floorMs = 0

  const wait = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })

  async function connectOnce(): Promise<'retry-now' | 'backoff' | 'stop'> {
    const controller = new AbortController()
    request = controller
    let stall: ReturnType<typeof setTimeout> | undefined
    const armStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => {
        controller.abort()
      }, stallMs)
    }
    try {
      armStall()
      const response = await fetchImpl(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (response.status === 401) {
        clearTimeout(stall)
        let code = 'unauthorized'
        try {
          code = ((await response.json()) as { error?: string }).error ?? code
        } catch {
          /* A non-JSON 401 is still an authentication failure. */
        }
        if (closed) return 'stop'
        const decision = await handlers.onUnauthorized(code)
        if (decision === 'stop') return 'stop'
        if (decision === 'renewed' && code === 'renewal-required' && !immediateUsed) {
          immediateUsed = true
          return 'retry-now'
        }
        return 'backoff'
      }
      if (!response.ok || response.body === null) {
        void response.body?.cancel().catch(() => {})
        return 'backoff'
      }
      if (closed) {
        void response.body.cancel().catch(() => {})
        return 'stop'
      }
      open = true
      attempt = 0
      immediateUsed = false
      floorMs = 0
      handlers.onOpen()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new EventStreamParser()
      armStall()
      while (!closed && !suspended) {
        const { value, done } = await reader.read()
        if (done) break
        armStall()
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          if (closed || suspended) break
          handlers.onEvent(event)
        }
      }
      return 'backoff'
    } catch {
      return 'backoff'
    } finally {
      clearTimeout(stall)
      controller.abort()
      if (request === controller) request = null
    }
  }

  // Resolved by reconnect() or close(); used while suspended.
  const resumed = () =>
    new Promise<void>(resolve => {
      wake = () => {
        wake = null
        resolve()
      }
    })

  void (async () => {
    while (!closed) {
      if (suspended) {
        await resumed()
        continue
      }
      const result = await connectOnce()
      if (closed || result === 'stop') break
      open = false
      handlers.onError()
      if (suspended) continue
      if (result === 'retry-now') continue
      await wait(Math.max(floorMs, backoffDelay(attempt++, options.initialDelayMs, options.maxDelayMs)))
    }
    open = false
  })()

  return {
    get open() {
      return open
    },
    reconnect: () => {
      if (closed) return
      suspended = false
      attempt = 0
      if (wake) wake()
    },
    suspend: () => {
      if (closed || suspended) return
      suspended = true
      open = false
      request?.abort()
    },
    deferReconnect: delayMs => {
      if (closed) return
      floorMs = Math.max(0, delayMs)
      attempt = 0
      open = false
      request?.abort()
    },
    close: () => {
      closed = true
      open = false
      request?.abort()
      wake?.()
    },
  }
}
