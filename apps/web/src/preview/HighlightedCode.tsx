import { memo, useEffect, useRef, useState } from 'react'
import workerUrl from './highlight.worker.ts?worker&url'
import { trustedScriptUrl } from './runtime.ts'
import { canHighlight, type SyntaxLines, type SyntaxToken } from './highlight-protocol.ts'
import { HighlightScheduler, type HighlightWorker } from './highlightScheduler.ts'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
const scheduler = new HighlightScheduler({
  createWorker: () => new Worker(trustedScriptUrl(workerUrl), { type: 'module' }) as HighlightWorker,
})
/** A block's text that has not changed is asked for at once; only text still changing waits to settle. */
const CHANGING_MS = 300

/** Finite role tokens, with the original text and newline boundaries preserved. */
export function useHighlightedTokens(source: string, language?: string, enabled = true): SyntaxLines | undefined {
  // A grammar splits lines on either ending and keeps neither, and each line must read back as this text.
  const code = source.replaceAll('\r\n', '\n')
  const [value, setValue] = useState<{ code: string; language: string; lines: SyntaxLines }>()
  const asked = useRef(code)
  const current = value && value.code === code && value.language === language ? value.lines : undefined
  const known = enabled && language && !current ? scheduler.peek(code, language) : undefined
  useEffect(() => {
    const changed = asked.current !== code
    asked.current = code
    if (!enabled || !language || !canHighlight(code)) return
    let cancel: (() => void) | undefined
    const ask = () => {
      cancel = scheduler.request(code, language, lines => {
        if (lines) setValue({ code, language, lines })
      })
    }
    if (!changed) {
      ask()
      return () => cancel?.()
    }
    const timer = setTimeout(ask, CHANGING_MS)
    return () => {
      clearTimeout(timer)
      cancel?.()
    }
  }, [code, language, enabled])
  return enabled ? (current ?? known) : undefined
}

let nextStream = 0
/** The complete lines of a block still arriving: its last line can still change, and Markdown ends the text with a newline. */
function completeLines(code: string): string {
  const body = code.endsWith('\n') ? code.slice(0, -1) : code
  return body.slice(0, body.lastIndexOf('\n') + 1)
}
/**
 * Tokens for the complete lines of a block still arriving. The worker holds the grammar state, so each line is tokenized
 * once; one request is in flight per block, and the next takes every line completed meanwhile. Text that stops being an
 * extension of what was tokenized starts over. The result stays after `enabled` ends, for the render until the closed
 * block's own tokens arrive.
 */
function useStreamingTokens(code: string, language: string | undefined, enabled: boolean): SyntaxLines | undefined {
  const [lines, setLines] = useState<SyntaxLines>()
  const latest = useRef(code)
  latest.current = code
  const pumps = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    if (!enabled || !language) return
    let stream = ++nextStream,
      done = '',
      tokens: SyntaxLines = [],
      restarts = 0,
      cancel: (() => void) | undefined,
      busy = false,
      stopped = false
    const start = () => {
      scheduler.release(stream)
      stream = ++nextStream
      done = ''
      tokens = []
    }
    const pump = () => {
      if (busy || stopped) return
      const complete = completeLines(latest.current)
      if (!complete.startsWith(done)) {
        start()
        setLines(undefined)
      }
      const next = complete.slice(done.length, -1)
      if (complete.length === done.length) return
      if (!canHighlight(complete)) {
        stopped = true
        return
      }
      busy = true
      cancel = scheduler.requestLines(stream, language, tokens.length, next, result => {
        busy = false
        if (!result) stopped = true
        else if ('restart' in result) {
          if (++restarts > 2) stopped = true
          else start()
          pump()
        } else {
          tokens = [...tokens, ...result.lines]
          done += `${next}\n`
          setLines(tokens)
          pump()
        }
      })
    }
    pumps.current = pump
    pump()
    return () => {
      pumps.current = undefined
      stopped = true
      cancel?.()
      scheduler.release(stream)
    }
  }, [language, enabled])
  useEffect(() => {
    pumps.current?.()
  }, [code])
  return lines
}

const sameTokens = (a: SyntaxToken[] | undefined, b: SyntaxToken[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((token, i) => token.text === b[i]!.text && token.role === b[i]!.role))
/** One line. A finished line keeps its DOM nodes as more arrive, and when the closed block's tokens repeat the stream's. */
const CodeLine = memo(
  function CodeLine({ text, tokens, last }: { text: string; tokens?: SyntaxToken[]; last: boolean }) {
    return (
      <>
        <SyntaxLine text={text} tokens={tokens} />
        {!last && '\n'}
      </>
    )
  },
  (a, b) => a.text === b.text && a.last === b.last && sameTokens(a.tokens, b.tokens),
)
/**
 * A block's text as role tokens where they are known. `streaming` asks line by line instead of for the whole block, and
 * `tail` then draws only its last lines. `colourLines` draws only the first lines as tokens, for a block collapsed to
 * about that many: the rest stays in the DOM as text, to be found and selected.
 */
export function HighlightedCode({
  code: source,
  language,
  enabled = true,
  streaming = false,
  tail,
  colourLines,
}: {
  code: string
  language?: string
  enabled?: boolean
  streaming?: boolean
  tail?: number
  colourLines?: number
}) {
  const code = source.replaceAll('\r\n', '\n')
  const whole = useHighlightedTokens(code, language, enabled && !streaming)
  const partial = useStreamingTokens(code, language, enabled && streaming)
  const tokens = whole ?? partial
  // The newline Markdown adds to the text would put the caret of a block still arriving on a line of its own.
  const shown = streaming && code.endsWith('\n') ? code.slice(0, -1) : code
  const lines = tail === undefined && !tokens ? [] : shown.split('\n')
  const first = tail === undefined ? 0 : Math.max(0, lines.length - tail)
  if (!tokens) return <VisibleText text={first ? lines.slice(first).join('\n') : shown} />
  const end = colourLines === undefined ? lines.length : Math.min(lines.length, first + colourLines)
  return (
    <>
      {lines.slice(first, end).map((text, index) => (
        <CodeLine key={first + index} text={text} tokens={tokens[first + index]} last={first + index === lines.length - 1} />
      ))}
      {end < lines.length && <VisibleText text={lines.slice(end).join('\n')} />}
    </>
  )
}
/**
 * A token boundary can cut a run of marks or an emoji sequence, which `VisibleText` must see whole to decide what to
 * mark. A line whose tokens would show anything else than the whole line stays whole.
 */
const readsAsLine = (text: string, tokens: SyntaxLines[number]) =>
  tokens.map(token => token.text).join('') === text
  && tokens.map(token => escapeHiddenCharacters(token.text)).join('') === escapeHiddenCharacters(text)

export function SyntaxLine({ text, tokens }: { text: string; tokens?: SyntaxLines[number] }) {
  return tokens && readsAsLine(text, tokens) ? (
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
