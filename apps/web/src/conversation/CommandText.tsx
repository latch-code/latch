import { Fragment, memo, useMemo } from 'react'
import { hasHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { hasAnsi, parseAnsi, stripAnsi } from './ansi.ts'
import { shellTokens } from './shellTokens.ts'

/** Output this long keeps one text node per run: a break chance after every separator would cost too many nodes. */
const BREAKABLE_CHARS = 20_000

/**
 * Text with a break chance after each path separator, so a long path wraps at a folder rather than inside a name; the
 * characters, what is copied and what is found stay the same.
 */
function Breakable({ text }: { text: string }) {
  if (!text.includes('/') || text.length > BREAKABLE_CHARS) return <VisibleText text={text} />
  const parts = text.split(/(?<=\/)/u)
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          <VisibleText text={part} />
          {index < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  )
}

/**
 * A command line coloured as shell: the program, flags, strings, paths, variables and operators. Display only. A line
 * with hidden characters stays one run, so each is marked as it would be anywhere else and none is split by a colour.
 */
export const ShellLine = memo(function ShellLine({ command, wraps = false }: { command: string; wraps?: boolean }) {
  // A row keeps its command on one line and cuts it at the end; only a block that wraps it gets break chances.
  const Text = wraps ? Breakable : VisibleText
  const tokens = useMemo(() => (hasHiddenCharacters(command) ? undefined : shellTokens(command)), [command])
  if (!tokens) return <VisibleText text={command} />
  return (
    <>
      {tokens.map((token, index) =>
        token.role === 'plain' ? (
          <Text key={index} text={token.text} />
        ) : (
          <span key={index} className={`sh-${token.role}`}>
            <Text text={token.text} />
          </span>
        ),
      )}
    </>
  )
})

/**
 * A command's output with the colours its terminal codes asked for, from the content palette; every other escape is
 * dropped and every character stays, hidden ones marked. Output without codes, or with hidden characters (which a
 * colour must not split), is drawn as one run.
 */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => (hasAnsi(text) && !hasHiddenCharacters(stripAnsi(text)) ? parseAnsi(text) : undefined), [text])
  if (!segments) return <Breakable text={hasAnsi(text) || text.includes('\r') ? stripAnsi(text) : text} />
  return (
    <>
      {segments.map((segment, index) =>
        segment.colour || segment.bold || segment.dim ? (
          <span
            key={index}
            className={segment.colour ? `ansi-${segment.colour}` : undefined}
            data-bold={segment.bold ? '' : undefined}
            data-dim={segment.dim ? '' : undefined}>
            <Breakable text={segment.text} />
          </span>
        ) : (
          <Breakable key={index} text={segment.text} />
        ),
      )}
    </>
  )
})
