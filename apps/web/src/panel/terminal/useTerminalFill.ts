import { useCallback, useEffect, useRef, useState } from 'react'
import { TERMINALS_PER_SESSION } from '@latch/protocol'
import { atPrompt, fillTab, pasteData } from './fill.ts'
import { terminalFills, useFillAsk, type FillAsk } from './fills.ts'
import type { TerminalTab } from './model.ts'
import type { TerminalMatch } from './find.ts'
import type { TerminalsRead } from './useTerminals.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    replaced: '已换成新的命令',
    terminalLimit: (limit: number) => `已有 ${formatNumber(limit)} 个终端`,
    notOpened: '终端没有打开',
    closed: '终端已关闭',
    ended: '终端已结束',
    cannotFill: '这条命令不能填入',
    unknown: '输入可能没有送达终端',
  },
  {
    replaced: 'Replaced with a new command',
    terminalLimit: (limit: number) => `There are already ${plural(limit, { one: '{n} terminal', other: '{n} terminals' })}`,
    notOpened: 'The terminal didn’t open',
    closed: 'Terminal closed',
    ended: 'Terminal ended',
    cannotFill: 'This command can’t be filled in',
    unknown: 'Input may not have reached the terminal',
  },
)

/** What a screen offers once its xterm is ready: input in order with the rest, and focus. */
export interface ScreenHandle {
  paste(data: string): Promise<void>
  focus(): void
  find(query: string, previous: number | undefined, direction: 1 | -1): TerminalMatch
}

type Step = { ask: FillAsk; phase: 'choose' } | { ask: FillAsk; phase: 'opening' } | { ask: FillAsk; phase: 'wait'; terminalId: string }

/**
 * Takes the commands asked for `place` and types each into a terminal of this surface: the active tab while its shell
 * waits at the prompt, else a new one once its shell gets there. The command goes in as one bracketed paste and is not
 * run; the screen takes focus, so Enter is the person's.
 */
export function useTerminalFill(input: {
  place: string | undefined
  tabs: readonly TerminalTab[]
  active: string | undefined
  read: TerminalsRead
  unavailable: string | undefined
  open(): Promise<string | undefined>
  /** Closes a terminal unless a program runs in it. */
  close(id: string): Promise<unknown>
  setActive(id: string): void
  /** The surface comes into view for the request. */
  onReveal?: (() => void) | undefined
}) {
  const { place, tabs, active, read, unavailable, open, close, setActive } = input
  const latest = useRef(tabs)
  latest.current = tabs
  /** The prompt each terminal last took a command at: one command per prompt, so two never join on one line. */
  const filled = useRef(new Map<string, number>())
  const reveal = useRef(input.onReveal)
  reveal.current = input.onReveal
  const handles = useRef(new Map<string, ScreenHandle>())
  const [handleCount, setHandleCount] = useState(0)
  const [step, setStep] = useState<Step>()
  const ask = useFillAsk(place)

  useEffect(() => {
    if (!ask) return
    terminalFills.take(ask)
    setStep(previous => {
      previous?.ask.settle(COPY.replaced)
      return { ask, phase: 'choose' }
    })
    reveal.current?.()
  }, [ask])

  useEffect(() => {
    if (!step) return
    const { ask: current } = step
    const fail = (reason: string) => {
      current.settle(reason)
      setStep(undefined)
    }
    if (current.settled) return setStep(undefined)
    if (step.phase === 'opening') return
    if (step.phase === 'choose') {
      if (unavailable) return fail(unavailable)
      if (read.kind === 'failed') return fail(read.text)
      if (read.kind !== 'ready') return
      const tab = fillTab(tabs, active, filled.current)
      if (tab) return setStep({ ask: current, phase: 'wait', terminalId: tab.id })
      if (tabs.length >= TERMINALS_PER_SESSION) return fail(COPY.terminalLimit(TERMINALS_PER_SESSION))
      setStep({ ask: current, phase: 'opening' })
      void open().then(id => {
        if (id === undefined) return fail(COPY.notOpened)
        // A shell that never reaches a prompt with bracketed paste on gets nothing, and the terminal opened for it goes.
        current.onFail(() => {
          const opened = latest.current.find(item => item.id === id)
          if (opened && !atPrompt(opened.summary)) void close(id)
        })
        setStep(previous => (previous?.ask === current ? { ask: current, phase: 'wait', terminalId: id } : previous))
      })
      return
    }
    const { terminalId } = step
    const tab = tabs.find(item => item.id === terminalId)
    if (!tab) return fail(COPY.closed)
    if (tab.summary.status !== 'running') return fail(COPY.ended)
    // Until the shell waits at its prompt with bracketed paste on (a new one is still starting, or a program runs):
    // the request's deadline ends the wait.
    const handle = handles.current.get(tab.id)
    const prompt = tab.summary.prompt
    if (!atPrompt(tab.summary, filled.current) || !handle || prompt === undefined) return
    const data = pasteData(current.command)
    if (data === undefined) return fail(COPY.cannotFill)
    setStep(undefined)
    setActive(tab.id)
    filled.current.set(tab.id, prompt)
    handle.paste(data).then(
      () => {
        handle.focus()
        current.settle()
      },
      (cause: unknown) => current.settle(cause instanceof Error ? cause.message : COPY.unknown),
    )
  }, [step, tabs, active, read, unavailable, open, close, setActive, handleCount])

  /** A screen's handle, or null once it is gone. */
  const screen = useCallback((id: string, handle: ScreenHandle | null) => {
    if (handle) handles.current.set(id, handle)
    else {
      handles.current.delete(id)
      filled.current.delete(id)
    }
    setHandleCount(count => count + 1)
  }, [])

  return { screen }
}
