import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CheckGlyph, CopyGlyph } from './glyphs/index.tsx'
import { IconButton } from './button.tsx'
import { pinLayer, setPopover } from './internal.ts'

/** How long a copy says 「已复制」; a failure, which has more words, stays longer. */
const COPIED_MS = 1000
const FAILED_MS = 1500

/** Clipboard can be unavailable on LAN HTTP; failure is reported instead of a false success. */
export function useCopy(copiedMs: number = COPIED_MS): { state: 'idle' | 'copied' | 'failed'; copy: (text: string) => Promise<void> } {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    [],
  )
  const copy = async (text: string) => {
    clearTimeout(timer.current)
    let result: 'copied' | 'failed'
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      result = 'copied'
    } catch {
      result = 'failed'
    }
    setState(result)
    timer.current = setTimeout(
      () => {
        setState('idle')
      },
      result === 'copied' ? copiedMs : FAILED_MS,
    )
  }
  return { state, copy }
}

/**
 * Copies `text`. The icon morphs to a check over --m-micro and 「已复制」 stands anchored to the button for a second; a
 * failure says so there instead, so it never looks like a success. A polite status says the same to screen readers.
 */
export function CopyButton({
  text,
  label = '复制',
  className,
  size,
}: {
  text: string
  label?: string
  className?: string
  /** xs (24) in dense rows: a turn's footer, a message's meta row, a section header. */
  size?: 'xs' | 'sm'
}) {
  const { state, copy } = useCopy()
  const button = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const result = state === 'copied' ? '已复制' : state === 'failed' ? '复制不可用，请手动选择' : undefined
  useLayoutEffect(() => {
    const layer = bubble.current
    setPopover(layer, result !== undefined)
    if (result === undefined || !layer || !button.current) return undefined
    return pinLayer(button.current, layer, { align: 'center', side: 'top', gap: 4 })
  }, [result])
  return (
    <>
      <IconButton
        ref={button}
        label={label}
        icon={state === 'copied' ? CheckGlyph : CopyGlyph}
        swap
        size={size}
        className={className ? `ui-copy-button ${className}` : 'ui-copy-button'}
        onClick={() => {
          void copy(text)
        }}
      />
      <span ref={bubble} popover="manual" className="ui-copied" aria-hidden="true">
        {result}
      </span>
      <span className="sr-only" role="status">
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : ''}
      </span>
    </>
  )
}
