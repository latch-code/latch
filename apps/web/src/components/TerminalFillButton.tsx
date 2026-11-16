import { useContext, useEffect, useRef, useState } from 'react'
import { ICON_STROKE, IconButton, TerminalGlyph } from '@latch/ui'
import { fillRefusal } from '../panel/terminal/fill.ts'
import { DetachedPlace, terminalFills, useFillPlace } from '../panel/terminal/fills.ts'

const LABEL = '在终端里打开'
/** How long 已填入 stands before it fades; a failure, which has more words, stays longer. */
const FILLED_MS = 1600
const FAILED_MS = 3000

type FillState = { kind: 'idle' } | { kind: 'filling' } | { kind: 'filled' } | { kind: 'failed'; text: string }

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
  const tooltip = refusal ?? (state.kind === 'failed' ? state.text : LABEL)

  const fill = async () => {
    if (disabled) return
    clearTimeout(timer.current)
    setState({ kind: 'filling' })
    let next: FillState
    try {
      await terminalFills.request(place, command)
      next = { kind: 'filled' }
    } catch (cause) {
      next = { kind: 'failed', text: cause instanceof Error ? cause.message : '没有填入' }
    }
    if (!mounted.current) return
    setState(next)
    timer.current = setTimeout(() => setState({ kind: 'idle' }), next.kind === 'filled' ? FILLED_MS : FAILED_MS)
  }

  const word = state.kind === 'filled' ? '已填入' : state.kind === 'failed' ? '没有填入' : undefined
  return (
    <span className="terminal-fill" data-look={look}>
      {look === 'code' ? (
        <button
          type="button"
          className="message-code-copy message-code-fill"
          aria-label={LABEL}
          aria-disabled={disabled || undefined}
          aria-description={refusal}
          title={tooltip}
          onClick={() => void fill()}>
          <TerminalGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        </button>
      ) : (
        <IconButton size="xs" icon={TerminalGlyph} label={LABEL} tooltip={tooltip} disabled={disabled} onClick={() => void fill()} />
      )}
      <span className="terminal-fill-state" data-state={state.kind} role="status">
        {word}
      </span>
    </span>
  )
}
