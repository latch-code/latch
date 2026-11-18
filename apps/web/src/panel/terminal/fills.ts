import { createContext, useContext, useSyncExternalStore } from 'react'
import { MessageError } from '../../core/api.ts'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    replaced: '已换成新的命令',
    notReady: '终端没有准备好',
  },
  {
    replaced: 'Replaced with a new command',
    notReady: 'The terminal isn’t ready',
  },
)

/** Where a command goes when no session is in view (设置, first setup): the terminal dialog. */
export const DETACHED = ''

/** How long a request waits for a terminal to take it and for its shell to reach the prompt. */
const FILL_DEADLINE_MS = 15_000

export interface FillAsk {
  id: number
  /** The session whose terminal takes it, or `DETACHED`. */
  place: string
  command: string
  /** Over: typed in, or failed with the reason. Only the first call counts. */
  settle(error?: string): void
  readonly settled: boolean
  /** Runs once if the request fails, the deadline included. */
  onFail(listener: () => void): void
}

/**
 * Requests to type a command into a Latch terminal, from the block that shows it to the terminal surface of its place.
 * One at a time: a newer request replaces one no terminal has taken yet.
 */
export class TerminalFills {
  private asked: FillAsk | undefined
  private next = 1
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deadlineMs = FILL_DEADLINE_MS) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The request a surface for `place` should take, if one waits. */
  waiting(place: string | undefined): FillAsk | undefined {
    return place !== undefined && this.asked?.place === place ? this.asked : undefined
  }

  /** Resolves once the command is at the prompt; rejects with the few words the block shows. */
  request(place: string, command: string): Promise<void> {
    this.asked?.settle(COPY.replaced)
    return new Promise((resolve, reject) => {
      let settled = false
      const failed: Array<() => void> = []
      const ask: FillAsk = {
        id: this.next++,
        place,
        command,
        get settled() {
          return settled
        },
        onFail: listener => {
          failed.push(listener)
        },
        settle: error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (this.asked === ask) {
            this.asked = undefined
            this.changed()
          }
          if (error === undefined) return resolve()
          for (const listener of failed) listener()
          reject(new MessageError(error))
        },
      }
      const timer = setTimeout(() => ask.settle(COPY.notReady), this.deadlineMs)
      this.asked = ask
      this.changed()
    })
  }

  /** A surface took the request: no other one does. */
  take(ask: FillAsk): void {
    if (this.asked !== ask) return
    this.asked = undefined
    this.changed()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

export const terminalFills = new TerminalFills()

export function useFillAsk(place: string | undefined): FillAsk | undefined {
  const read = () => terminalFills.waiting(place)
  return useSyncExternalStore(terminalFills.subscribe, read, read)
}

/**
 * Where a block's command can go: the visible session's terminal on this Mac's desktop, or the dialog where no session
 * is in view. Absent on any other device and outside the transcript, where only copy remains.
 */
export const FillPlace = createContext<string | undefined>(undefined)

export const useFillPlace = () => useContext(FillPlace)

/** `DETACHED` where this Mac's desktop has terminals: an install or upgrade command, which belongs to no session. */
export const DetachedPlace = createContext<string | undefined>(undefined)
