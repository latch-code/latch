import type { TerminalStreamEvents, TerminalSummary } from '@latch/protocol'
import { ApiError, api } from '../../core/api.ts'
import { backoffDelay, EventStreamParser } from '../../core/eventStream.ts'
import { fromBase64, inputChunks, PARSE_HIGH_WATER, streamPath, toBase64 } from './model.ts'

/** Where a terminal's output and changes go: the screen, and the tab's state. */
export interface TerminalSink {
  /** Output in order; resolves once the screen has parsed it, which is what holds the stream back. */
  write(bytes: Uint8Array): Promise<void> | void
  /** What the screen showed is no longer kept: clear it, the output continues from there. */
  reset(): void
  summary(summary: TerminalSummary): void
  /** The Host closed the terminal, or no longer knows it. */
  closed(): void
  /** Whether the stream is live or being reconnected. */
  connection(state: 'live' | 'reconnecting'): void
  /** Typed input whose fate is unknown (the call failed on the way) or that the Host turned down. */
  inputFailed(message: string): void
}

export interface TerminalLinkOptions {
  fetch?: typeof fetch
  initialDelayMs?: number
  maxDelayMs?: number
  /** No bytes for this long counts as cut; the Host sends a heartbeat every 15 s. */
  stallMs?: number
  /** Waits between input calls the Host refused for now (429 `terminal-input-busy`). */
  busyDelayMs?: number
}

const pause = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

/**
 * One terminal's stream and input. The stream starts with the Host's replay and continues from the last offset after a
 * cut; it reads only as fast as the screen parses, so a slow screen holds back the Host (which then holds back the
 * program) instead of growing memory here. Input goes one call at a time, in order, as the Host requires.
 */
export class TerminalLink {
  /** The end of the output this page has, in everything the terminal printed; undefined before the first frame. */
  offset: number | undefined
  private closedByPage = false
  private request: AbortController | null = null
  private wake: (() => void) | null = null
  private readonly queue: Uint8Array[] = []
  private sending = false
  private readonly fetchImpl: typeof fetch

  constructor(
    readonly sessionId: string,
    readonly terminalId: string,
    private readonly sink: TerminalSink,
    private readonly options: TerminalLinkOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private get base() {
    return `tasks/${encodeURIComponent(this.sessionId)}/terminals/${encodeURIComponent(this.terminalId)}`
  }

  start(): void {
    void this.run()
  }

  /** Stops reading and sending; the terminal itself keeps running on the Host. */
  close(): void {
    this.closedByPage = true
    this.queue.length = 0
    this.request?.abort()
    this.wake?.()
  }

  /** Skips the wait before the next attempt, as when the page comes back online. */
  reconnect(): void {
    this.wake?.()
  }

  private async run(): Promise<void> {
    let attempt = 0
    while (!this.closedByPage) {
      const result = await this.connectOnce(() => {
        attempt = 0
      })
      if (this.closedByPage || result === 'end') return
      this.sink.connection('reconnecting')
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, backoffDelay(attempt++, this.options.initialDelayMs ?? 500, this.options.maxDelayMs ?? 8000))
        const wake = () => {
          clearTimeout(timer)
          done()
        }
        function done() {
          resolve()
        }
        this.wake = wake
      })
      this.wake = null
    }
  }

  private async connectOnce(opened: () => void): Promise<'retry' | 'end'> {
    const controller = new AbortController()
    this.request = controller
    let stall: ReturnType<typeof setTimeout> | undefined
    const armStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => controller.abort(), this.options.stallMs ?? 45_000)
    }
    try {
      armStall()
      const response = await this.fetchImpl(`/link/api/${streamPath(this.sessionId, this.terminalId, this.offset)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      // The terminal is gone, or this device may no longer watch it: nothing to reconnect to.
      if (response.status === 404 || response.status === 403) {
        void response.body?.cancel().catch(() => {})
        this.sink.closed()
        return 'end'
      }
      if (!response.ok || response.body === null) {
        void response.body?.cancel().catch(() => {})
        return 'retry'
      }
      opened()
      this.sink.connection('live')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new EventStreamParser()
      /** Output handed to the screen and not yet parsed. */
      let parsing = 0
      let drained: Promise<void> = Promise.resolve()
      for (;;) {
        armStall()
        const { value, done } = await reader.read()
        if (done || this.closedByPage) return 'retry'
        armStall()
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          if (this.closedByPage) return 'end'
          if (event.event === 'output') {
            const frame = JSON.parse(event.data) as TerminalStreamEvents['output']
            const bytes = fromBase64(frame.data)
            this.offset = frame.offset + bytes.length
            parsing += bytes.length
            drained = Promise.resolve(this.sink.write(bytes)).then(() => {
              parsing -= bytes.length
            })
            // Waiting here leaves the response unread, so the Host's writes return false and it stops until we drain.
            if (parsing > PARSE_HIGH_WATER) {
              clearTimeout(stall)
              await drained
            }
          } else if (event.event === 'reset') {
            const frame = JSON.parse(event.data) as TerminalStreamEvents['reset']
            this.offset = frame.offset
            this.sink.reset()
          } else if (event.event === 'terminal') {
            this.sink.summary(JSON.parse(event.data) as TerminalSummary)
          } else if (event.event === 'closed') {
            this.sink.closed()
            return 'end'
          }
        }
      }
    } catch {
      return 'retry'
    } finally {
      clearTimeout(stall)
      controller.abort()
      if (this.request === controller) this.request = null
    }
  }

  /** Queues what xterm handed over: a keystroke, or a whole paste with its brackets, split into calls the Host accepts. */
  send(data: string): void {
    if (this.closedByPage || data === '') return
    this.queue.push(...inputChunks(data))
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      while (this.queue.length && !this.closedByPage) {
        const chunk = this.queue[0]!
        try {
          await api(`${this.base}/input`, { method: 'POST', body: { data: toBase64(chunk) } })
          this.queue.shift()
        } catch (error) {
          if (error instanceof ApiError && error.status === 429 && error.code === 'terminal-input-busy') {
            // Refused, so not written: the same bytes go again once the program has read some.
            await pause(this.options.busyDelayMs ?? 150)
            continue
          }
          // Ended, refused, or unknown: what follows would arrive out of order, so it is dropped with this one.
          this.queue.length = 0
          if (!(error instanceof ApiError && error.code === 'terminal-ended'))
            this.sink.inputFailed(error instanceof ApiError ? error.message : '输入可能没有送达终端')
        }
      }
    } finally {
      this.sending = false
    }
  }

  /** Only the device that opened it sizes it; the Host answers with the terminal as it now is. */
  async resize(cols: number, rows: number): Promise<TerminalSummary | undefined> {
    if (this.closedByPage) return undefined
    try {
      const { terminal } = await api<{ terminal: TerminalSummary }>(`${this.base}/resize`, { method: 'POST', body: { cols, rows } })
      return terminal
    } catch {
      return undefined
    }
  }
}
