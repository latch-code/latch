import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalSize, TerminalSummary, TerminalTarget, TerminalText } from '@latch/protocol'
import { api, ApiError, errorMessage, isUncertain } from '../../core/api.ts'
import { ATTACH_LAST_LINES, keepActive, nameTabs, opensFirstTerminal, terminalPath, type TerminalTab } from './model.ts'

export type TerminalsRead = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; text: string }

/** What closing asked: done, or a program still runs and the person must confirm. */
export type CloseResult = { kind: 'closed' } | { kind: 'busy'; program?: string } | { kind: 'failed'; text: string }

/**
 * The target's terminals as the Host lists them. While the surface is shown and wants one (`autoOpen`), an empty list
 * opens the first terminal, once per showing: hiding the surface lets the next showing open one again.
 */
export function useTerminals(input: { target: TerminalTarget; shown: boolean; autoOpen: boolean; size: () => TerminalSize }) {
  const { target, shown, autoOpen } = input
  const sizeRef = useRef(input.size)
  sizeRef.current = input.size
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [active, setActive] = useState<string>()
  const [read, setRead] = useState<TerminalsRead>({ kind: 'loading' })
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string>()
  const started = useRef(false)
  const autoOpened = useRef(false)
  const inFlight = useRef<Promise<string | undefined> | undefined>(undefined)
  const base = terminalPath(target)

  const apply = useCallback((next: (previous: TerminalTab[]) => TerminalTab[]) => {
    setTabs(previous => {
      const updated = next(previous)
      setActive(current => keepActive(updated, current, previous))
      return updated
    })
  }, [])

  const list = useCallback(async () => {
    try {
      const { terminals } = await api<{ terminals: TerminalSummary[] }>(base)
      apply(previous => nameTabs(previous, terminals))
      setRead({ kind: 'ready' })
      return terminals
    } catch (cause) {
      setRead({ kind: 'failed', text: errorMessage(cause) })
      return undefined
    }
  }, [apply, base])

  const open = useCallback(
    /** Resolves with the new terminal's ID, or undefined when none was opened (the failure says why). */
    (number?: number): Promise<string | undefined> => {
      // A second caller while one opens (the first-terminal start and a command waiting to be filled in) shares it.
      if (inFlight.current) return inFlight.current
      autoOpened.current = true
      setOpening(true)
      setFailure(undefined)
      const run = async () => {
        try {
          const { terminal } = await api<{ terminal: TerminalSummary }>(base, {
            method: 'POST',
            body: sizeRef.current(),
            timeoutMs: 20_000,
          })
          apply(previous =>
            nameTabs(previous, [...previous.map(tab => tab.summary), terminal], new Map(number ? [[terminal.id, number]] : [])),
          )
          setActive(terminal.id)
          return terminal.id
        } catch (cause) {
          // A call that may have opened one leaves the list to say so: opening again could start a second shell.
          if (!isUncertain(cause)) setFailure(errorMessage(cause))
          else if ((await list())?.length === 0) setFailure(errorMessage(cause))
          return undefined
        } finally {
          inFlight.current = undefined
          setOpening(false)
        }
      }
      inFlight.current = run()
      return inFlight.current
    },
    [apply, base, list],
  )

  useEffect(() => {
    if (!shown || started.current) return
    started.current = true
    void list()
  }, [shown, list])
  useEffect(() => {
    if (!shown) autoOpened.current = false
    else if (opensFirstTerminal({ shown, wanted: autoOpen, read: read.kind, tabs: tabs.length, tried: autoOpened.current })) void open()
  }, [shown, autoOpen, read.kind, tabs.length, open])

  const updated = useCallback(
    (summary: TerminalSummary) => {
      apply(previous => previous.map(tab => (tab.id === summary.id ? { ...tab, summary } : tab)))
    },
    [apply],
  )

  const gone = useCallback(
    (id: string) => {
      apply(previous => previous.filter(tab => tab.id !== id))
    },
    [apply],
  )

  const close = useCallback(
    async (id: string, force = false): Promise<CloseResult> => {
      try {
        await api(`${base}/${encodeURIComponent(id)}/close`, { method: 'POST', body: force ? { force: true } : {} })
        gone(id)
        return { kind: 'closed' }
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 'terminal-busy') {
          const program = Reflect.get(cause.details, 'foreground')
          return { kind: 'busy', ...(typeof program === 'string' ? { program } : {}) }
        }
        if (cause instanceof ApiError && cause.status === 404) {
          gone(id)
          return { kind: 'closed' }
        }
        if (isUncertain(cause)) void list()
        return { kind: 'failed', text: errorMessage(cause) }
      }
    },
    [base, gone, list],
  )

  /** An ended terminal makes way for a new one under the same name. */
  const reopen = useCallback(
    async (tab: TerminalTab) => {
      const result = await close(tab.id, true)
      if (result.kind === 'closed') await open(tab.number)
      else if (result.kind === 'failed') setFailure(result.text)
    },
    [close, open],
  )

  /** The Host's redacted text of the selection, or of the last lines; nothing is attached by this. */
  const extract = useCallback(
    (id: string, selection: string) =>
      api<TerminalText>(`${base}/${encodeURIComponent(id)}/attach`, {
        method: 'POST',
        body: selection ? { selection } : { lines: ATTACH_LAST_LINES },
      }),
    [base],
  )

  return { tabs, active, setActive, read, opening, failure, setFailure, list, open, close, reopen, updated, gone, extract }
}
