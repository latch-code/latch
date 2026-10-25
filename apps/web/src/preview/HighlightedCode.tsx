import { Fragment, useEffect, useState } from 'react'
import workerUrl from './highlight.worker.ts?worker&url'
import { trustedScriptUrl } from './runtime.ts'
import { canHighlight, isSyntaxLines, type SyntaxLines } from './highlight-protocol.ts'
import { VisibleText } from '../components/VisibleText.tsx'
let worker: Worker | undefined,
  nextId = 0
const pending = new Map<number, { resolve: (value: SyntaxLines | undefined) => void; timer: ReturnType<typeof setTimeout> }>(),
  cache = new Map<string, SyntaxLines>()
function reset() {
  worker?.terminate()
  worker = undefined
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.resolve(undefined)
  }
  pending.clear()
}
function highlight(code: string, language: string): Promise<SyntaxLines | undefined> {
  if (pending.size >= 32) return Promise.resolve(undefined)
  const key = `${language}\0${code}`,
    known = cache.get(key)
  if (known) return Promise.resolve(known)
  try {
    if (!worker) {
      worker = new Worker(trustedScriptUrl(workerUrl), { type: 'module' })
      worker.onerror = reset
      worker.onmessage = event => {
        const value = event.data as { id?: number; lines?: unknown },
          item = pending.get(value?.id ?? -1)
        if (!item) return
        clearTimeout(item.timer)
        pending.delete(value.id!)
        item.resolve(value.lines as SyntaxLines | undefined)
      }
    }
    const activeWorker = worker,
      id = ++nextId
    return new Promise(resolve => {
      pending.set(id, {
        timer: setTimeout(reset, 5000),
        resolve: lines => {
          if (!isSyntaxLines(lines, code)) {
            resolve(undefined)
            return
          }
          cache.set(key, lines)
          if (cache.size > 30) cache.delete(cache.keys().next().value!)
          resolve(lines)
        },
      })
      activeWorker.postMessage({ id, code, language })
    })
  } catch {
    reset()
    return Promise.resolve(undefined)
  }
}
/** Finite role tokens, with the original text and newline boundaries preserved. */
export function useHighlightedTokens(code: string, language?: string, enabled = true): SyntaxLines | undefined {
  const [value, setValue] = useState<{ code: string; language: string; lines: SyntaxLines }>()
  useEffect(() => {
    if (!enabled || !language || !canHighlight(code)) return
    let cancelled = false
    const timer = setTimeout(
      () =>
        void highlight(code, language).then(lines => {
          if (!cancelled && lines) setValue({ code, language, lines })
        }),
      300,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, language, enabled])
  return enabled && value && value.code === code && value.language === language ? value.lines : undefined
}
export function HighlightedCode({ code, language, enabled = true }: { code: string; language?: string; enabled?: boolean }) {
  const lines = useHighlightedTokens(code, language, enabled)
  return lines ? (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          {line.map((token, j) => (
            <span key={j} className={`syn-${token.role}`}>
              <VisibleText text={token.text} />
            </span>
          ))}
        </Fragment>
      ))}
    </>
  ) : (
    <VisibleText text={code} />
  )
}
export function SyntaxLine({ text, tokens }: { text: string; tokens?: SyntaxLines[number] }) {
  return tokens && tokens.map(token => token.text).join('') === text ? (
    <>
      {tokens.map((token, i) => (
        <span className={`syn-${token.role}`} key={i}>
          <VisibleText text={token.text} />
        </span>
      ))}
    </>
  ) : (
    <VisibleText text={text} />
  )
}
