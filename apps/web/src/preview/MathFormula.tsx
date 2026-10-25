import { useEffect, useRef, useState } from 'react'
import { VisibleText } from '../components/VisibleText.tsx'
import { validMathDom } from './math.ts'
export function MathFormula({ tex, block = false }: { tex: string; block?: boolean }) {
  const container = useRef<HTMLSpanElement>(null),
    [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    if (tex.length > 20_000) {
      setFailed(true)
      return
    }
    void Promise.all([import('katex'), import('katex/dist/katex.min.css')])
      .then(([katex]) => {
        if (cancelled || !container.current) return
        const detached = document.createElement('span')
        katex.render(tex, detached, {
          displayMode: block,
          trust: false,
          strict: 'ignore',
          maxExpand: 1000,
          maxSize: 10,
          throwOnError: false,
          output: 'htmlAndMathml',
        })
        if (!validMathDom(detached)) {
          setFailed(true)
          return
        }
        container.current.replaceChildren(...detached.childNodes)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      container.current?.replaceChildren()
    }
  }, [tex, block])
  return (
    <span className={block ? 'message-math is-display' : 'message-math'}>
      {failed ? (
        <code>
          <VisibleText text={tex} />
        </code>
      ) : (
        <span ref={container} aria-label={tex} />
      )}
    </span>
  )
}
