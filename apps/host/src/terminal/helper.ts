// Runs latch-pty for one terminal and turns its frames into events. The shell's environment travels in the start
// frame and the helper itself runs with an empty one, so the Host decides every variable the shell sees.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { Writable } from 'node:stream'
import { z } from 'zod'
import { FRAME_PAYLOAD_LIMIT, FROM_HELPER, FrameReader, TO_HELPER, encodeFrame, encodeSize, type Frame } from './frames.ts'

/** Signals a terminal's foreground program may be sent. */
export type TerminalSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM' | 'SIGKILL'

export interface TerminalLaunch {
  /** An absolute path, and `argv[0]` first. */
  file: string
  argv: string[]
  /** The shell's whole environment. */
  env: Record<string, string>
  /** Where the shell starts; the helper opens it before the shell runs. */
  cwd: string
  cols: number
  rows: number
}

/** The helper's own start errors, a frame it should never have sent, or a helper that ended without saying why. */
export type TerminalFailure = 'invalid-input' | 'cwd' | 'pty' | 'exec' | 'protocol' | 'helper'

export type HelperEvent =
  | { type: 'started'; pid: number }
  | { type: 'output'; data: Buffer }
  | { type: 'foreground'; busy: boolean; name: string }
  | { type: 'exit'; code?: number; signal?: number }
  | { type: 'failed'; reason: TerminalFailure }
  /** The helper has exited: always the last event, after `exit` or `failed`. */
  | { type: 'gone' }

export interface TerminalProcess {
  input(data: Uint8Array): void
  /** Input bytes written to the helper that it has not read yet. */
  readonly pendingInput: number
  resize(cols: number, rows: number): void
  signal(signal: TerminalSignal): void
  /** Stops reading the helper's output; the helper then stops reading the pty and the programs in it wait. */
  pauseOutput(): void
  resumeOutput(): void
  /**
   * Ends the terminal: SIGHUP and SIGCONT to every process group on it, SIGKILL to what is left after a second. Settles
   * once the helper has exited; a helper that does not within five seconds is killed itself.
   */
  close(): Promise<void>
}

export type LaunchTerminal = (launch: TerminalLaunch, onEvent: (event: HelperEvent) => void) => TerminalProcess

const CLOSE_DEADLINE_MS = 5000
const startedSchema = z.strictObject({ pid: z.number().int().positive() })
const foregroundSchema = z.strictObject({ busy: z.boolean(), name: z.string().max(256) })
const exitSchema = z.union([
  z.strictObject({ code: z.number().int().min(0).max(255) }),
  z.strictObject({ signal: z.number().int().min(1).max(64) }),
])
const errorSchema = z.strictObject({ error: z.enum(['invalid-input', 'cwd', 'pty', 'exec']) })

function parse<T>(schema: z.ZodType<T>, payload: Buffer): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(payload.toString('utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Starts terminals with the latch-pty binary at `binary`. */
export function helperLauncher(binary: string): LaunchTerminal {
  return (launch, onEvent) => {
    // Encoded first: a start that does not fit a frame throws before any process exists.
    const start = encodeFrame(
      TO_HELPER.start,
      Buffer.from(
        JSON.stringify({ file: launch.file, argv: launch.argv, env: launch.env, cwd: launch.cwd, cols: launch.cols, rows: launch.rows }),
      ),
    )
    // Fd 3 carries resize and signal frames, so input a program does not read cannot hold them back.
    const child = spawn(binary, [], { env: {}, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] })
    const { stdin, stdout } = child
    const control = child.stdio[3]
    if (!stdin || !stdout || !(control instanceof Writable)) throw new TypeError('No pipes for the terminal helper')
    const reader = new FrameReader()
    let started = false
    /** `exit` or `failed` was reported. */
    let ended = false
    let gone = false
    let closing: Promise<void> | undefined
    let deadline: NodeJS.Timeout | undefined
    const waiters: Array<() => void> = []

    const finish = (event: Extract<HelperEvent, { type: 'exit' | 'failed' }>) => {
      if (ended) return
      ended = true
      onEvent(event)
    }
    const write = (frame: Buffer) => {
      if (!gone && !closing) stdin.write(frame)
    }
    const writeControl = (frame: Buffer) => {
      if (!gone && !closing) control.write(frame)
    }
    const close = (): Promise<void> => {
      if (gone) return Promise.resolve()
      closing ??= new Promise<void>(resolve => {
        waiters.push(resolve)
        // The helper writes its exit frame before it exits: keep reading.
        stdout.resume()
        stdin.end()
        control.end()
        child.kill('SIGTERM')
        deadline = setTimeout(() => child.kill('SIGKILL'), CLOSE_DEADLINE_MS)
      })
      return closing
    }
    const broken = () => {
      finish({ type: 'failed', reason: 'protocol' })
      void close()
    }
    const handle = (frame: Frame) => {
      if (frame.type === FROM_HELPER.started) {
        const value = started ? undefined : parse(startedSchema, frame.payload)
        if (!value) return broken()
        started = true
        onEvent({ type: 'started', pid: value.pid })
      } else if (frame.type === FROM_HELPER.output) {
        if (!started || ended) return broken()
        onEvent({ type: 'output', data: frame.payload })
      } else if (frame.type === FROM_HELPER.foreground) {
        const value = started && !ended ? parse(foregroundSchema, frame.payload) : undefined
        if (!value) return broken()
        onEvent({ type: 'foreground', busy: value.busy, name: value.name })
      } else if (frame.type === FROM_HELPER.exit) {
        const value = parse(exitSchema, frame.payload)
        if (!value) return broken()
        finish({ type: 'exit', ...value })
      } else if (frame.type === FROM_HELPER.error) {
        const value = parse(errorSchema, frame.payload)
        if (!value) return broken()
        finish({ type: 'failed', reason: value.error })
      } else broken()
    }
    const markGone = () => {
      if (gone) return
      gone = true
      clearTimeout(deadline)
      finish({ type: 'failed', reason: 'helper' })
      onEvent({ type: 'gone' })
      for (const waiter of waiters.splice(0)) waiter()
    }

    // EPIPE once the helper has exited; `close` reports that.
    stdin.on('error', () => {})
    control.on('error', () => {})
    stdout.on('data', (chunk: Buffer) => {
      if (ended) return
      let frames: Frame[]
      try {
        frames = reader.push(chunk)
      } catch {
        return broken()
      }
      for (const frame of frames) {
        handle(frame)
        if (ended) break
      }
    })
    child.once('error', () => {
      finish({ type: 'failed', reason: 'helper' })
      // A helper that never started has nothing left to close.
      if (child.pid === undefined) markGone()
    })
    child.once('close', markGone)
    stdin.write(start)

    return {
      input(data) {
        for (let offset = 0; offset < data.length; offset += FRAME_PAYLOAD_LIMIT)
          write(encodeFrame(TO_HELPER.input, data.subarray(offset, offset + FRAME_PAYLOAD_LIMIT)))
      },
      get pendingInput() {
        return stdin.writableLength
      },
      resize(cols, rows) {
        writeControl(encodeFrame(TO_HELPER.resize, encodeSize(cols, rows)))
      },
      signal(signal) {
        writeControl(encodeFrame(TO_HELPER.signal, Uint8Array.of(constants.signals[signal])))
      },
      pauseOutput() {
        if (!closing) stdout.pause()
      },
      resumeOutput() {
        stdout.resume()
      },
      close,
    }
  }
}
