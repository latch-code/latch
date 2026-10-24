import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { IconButton } from '@latch/ui'

/** Clipboard can be unavailable on LAN HTTP; failure is reported instead of a false success. */
export function useCopy(timeout = 1800) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (text: string) => {
    clearTimeout(timer.current)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), timeout)
  }
  return { state, copy }
}

/** Copies `text`; the tooltip and a polite status say whether it worked. */
export function CopyButton({ text, label = '复制', className = '' }: { text: string; label?: string; className?: string }) {
  const { state, copy } = useCopy()
  const result = state === 'copied' ? '已复制' : state === 'failed' ? '复制不可用，请手动选择' : undefined
  return (
    <>
      <IconButton
        label={label}
        icon={state === 'copied' ? Check : Copy}
        tooltip={result}
        className={className ? `copy-button ${className}` : 'copy-button'}
        onClick={() => {
          void copy(text)
        }}
      />
      <span className="sr-only" role="status">
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : ''}
      </span>
    </>
  )
}

/**
 * Brand artwork, unaltered. In the dark theme CSS draws a hairline on the edge of the charcoal tile, which sits inside
 * the image's transparent margin, so the tile stays visible on dark paper.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }}>
      <img src="/link/icon.png" alt="" width={size} height={size} />
    </span>
  )
}
