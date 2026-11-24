import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { hasHiddenCharacters } from '../components/VisibleText.tsx'
import { SyntaxLine, useHighlightedTokens } from '../preview/HighlightedCode.tsx'

export function PluginSourceField({
  label,
  value,
  language,
  rows,
  hint,
  onValueChange,
}: {
  label: string
  value: string
  language?: string
  rows: number
  hint?: string
  onValueChange: (value: string) => void
}) {
  const id = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLPreElement>(null)
  const [composing, setComposing] = useState(false)
  const [hasSelection, setHasSelection] = useState(false)
  const code = value.replace(/\r\n?/g, '\n')
  const tokens = useHighlightedTokens(code, language, !composing)
  // A visible escape for hidden characters would no longer line up with the textarea's original text.
  const lines = useMemo(() => (tokens && !hasHiddenCharacters(code) ? code.split('\n') : undefined), [code, tokens])
  const highlighted = lines !== undefined && !composing && !hasSelection

  useLayoutEffect(() => {
    const textarea = input.current
    const overlay = mirror.current
    if (!highlighted || !textarea || !overlay) return undefined
    const scroll = () => {
      overlay.scrollTop = textarea.scrollTop
      overlay.scrollLeft = textarea.scrollLeft
    }
    const resize = () => {
      overlay.style.right = `${textarea.offsetWidth - textarea.clientWidth}px`
      overlay.style.bottom = `${textarea.offsetHeight - textarea.clientHeight}px`
      scroll()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(textarea)
    textarea.addEventListener('scroll', scroll)
    return () => {
      observer.disconnect()
      textarea.removeEventListener('scroll', scroll)
    }
  }, [highlighted])

  return (
    <div className="ui-field plugin-source">
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-field-control">
        <div className="plugin-source-editor" data-highlighted={highlighted || undefined}>
          <textarea
            ref={input}
            id={id}
            className="ui-input"
            aria-describedby={hint ? `${id}-hint` : undefined}
            rows={rows}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            dir="ltr"
            value={value}
            onSelect={event => {
              const { selectionStart, selectionEnd } = event.currentTarget
              setHasSelection(selectionStart !== selectionEnd)
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onBlur={() => {
              setComposing(false)
              setHasSelection(false)
            }}
            onChange={event => onValueChange(event.currentTarget.value)}
          />
          {highlighted && (
            <pre
              ref={mirror}
              className="plugin-source-highlight"
              aria-hidden="true"
              dir="ltr"
              data-trailing-line={code.endsWith('\n') || undefined}>
              {lines.map((line, index) => (
                <Fragment key={index}>
                  <SyntaxLine text={line} tokens={tokens?.[index]} />
                  {index < lines.length - 1 && '\n'}
                </Fragment>
              ))}
            </pre>
          )}
        </div>
        {hint && (
          <p className="ui-field-hint" id={`${id}-hint`}>
            {hint}
          </p>
        )}
      </div>
    </div>
  )
}
