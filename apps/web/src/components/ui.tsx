import { useLayoutEffect, useRef, useState } from 'react'
import { middleFit } from '../format.ts'

/**
 * A path that keeps both ends in whatever width it gets: measured against its box, it shows the whole path or its
 * start, one ellipsis and its last segment whole (「/private/var/fol…/latch-app」); when not even the last segment fits it
 * is cut at the end. It takes the width of the line it is in. The whole path stays in the title and in what is read out.
 */
export function MiddleText({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState<string | undefined>(text)
  useLayoutEffect(() => {
    const element = ref.current
    const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    if (!element || !context || typeof ResizeObserver !== 'function') return undefined
    const fit = () => {
      const style = getComputedStyle(element)
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      setShown(middleFit(text, element.clientWidth, value => context.measureText(value).width))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [text])
  return (
    <span ref={ref} className={className ? `middle-text ${className}` : 'middle-text'} title={text}>
      <span aria-hidden="true">{shown ?? text}</span>
      <span className="sr-only">{text}</span>
    </span>
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
