import { useContext, useEffect, useRef, useState } from 'react'
import { ICON_STROKE, IconButton, TerminalGlyph, Tooltip } from '@latch/ui'
import { fillRefusal } from '../panel/terminal/fill.ts'
import { DetachedPlace, terminalFills, useFillPlace } from '../panel/terminal/fills.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    open: '在终端里打开',
    filled: '已填入',
    failed: '没有填入',
  },
  {
    open: 'Open in Terminal',
    filled: 'Filled in',
    failed: 'Couldn’t fill in',
  },
)

/** How long 已填入 stands before it fades; a failure, which has more words, stays longer. */
const FILLED_MS = 1600
const FAILED_MS = 3000

type FillState = { kind: 'idle' } | { kind: 'filling' } | { kind: 'filled' } | { kind: 'failed'; error: unknown }

/**
 * 「在终端里打开」 beside a command's copy button: types the command in at the prompt of a Latch terminal, where the person
 * presses Enter. Shown only where this Mac's desktop has a terminal for the place (`FillPlace`, `DetachedPlace`); a command
 * that may not be typed in keeps the button, turned down with the reason on hover.
 */
export function TerminalFillButton({
  command,
  streaming = false,
  detached = false,
  look = 'icon',
}: {
  command: string
  streaming?: boolean
  /** A command of no session (install, upgrade): it goes to the terminal dialog, not the transcript's session. */
  detached?: boolean
  /** `code`: a code block's toolbar, drawn as its copy button is. */
  look?: 'icon' | 'code'
}) {
  const session = useFillPlace()
  const outside = useContext(DetachedPlace)
  const place = detached ? outside : session
  const [state, setState] = useState<FillState>({ kind: 'idle' })
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  if (place === undefined) return null
  const refusal = fillRefusal(command, streaming)
  const disabled = refusal !== undefined || state.kind === 'filling'
  const tooltip =
    refusal
    ?? (state.kind === 'failed' && state.error instanceof Error ? state.error.message : state.kind === 'failed' ? COPY.failed : COPY.open)

  const fill = async () => {
    if (disabled) return
    clearTimeout(timer.current)
    setState({ kind: 'filling' })
    let next: FillState
    try {
      await terminalFills.request(place, command)
      next = { kind: 'filled' }
    } catch (cause) {
      next = { kind: 'failed', error: cause }
    }
    if (!mounted.current) return
    setState(next)
    timer.current = setTimeout(() => setState({ kind: 'idle' }), next.kind === 'filled' ? FILLED_MS : FAILED_MS)
  }

  const word = state.kind === 'filled' ? COPY.filled : state.kind === 'failed' ? COPY.failed : undefined
  return (
    <span className="terminal-fill" data-look={look}>
      {look === 'code' ? (
        <Tooltip content={tooltip} describe={false}>
          <button
            type="button"
            className="message-code-copy message-code-fill"
            aria-label={COPY.open}
            aria-disabled={disabled || undefined}
            aria-description={refusal}
            onClick={() => void fill()}>
            <TerminalGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : (
        <IconButton size="xs" icon={TerminalGlyph} label={COPY.open} tooltip={tooltip} disabled={disabled} onClick={() => void fill()} />
      )}
      <span className="terminal-fill-state" data-state={state.kind} role="status">
        {word}
      </span>
    </span>
  )
}
