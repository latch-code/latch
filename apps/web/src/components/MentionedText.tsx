import { createContext, Fragment, useContext, type ReactNode } from 'react'
import { isFileMention, type FileMention } from '@latch/protocol'
import { Icon, TerminalGlyph } from '@latch/ui'
import { terminalExcerpts, type TerminalExcerpt } from '../composer/terminalExcerpt.ts'
import { QUOTE_COPY, ReplyQuoteSource } from '../conversation/ReplyQuoteControl.tsx'
import { replyQuotes } from '../conversation/replyQuote.ts'
import { mentionRange } from '../fileMentions.ts'
import { promptChips, type PromptCatalogue } from '../composer/prompt-tokens.ts'
import { PromptChipView } from '../composer/PromptChip.tsx'
import { FileChip } from './FileChip.tsx'
import { VisibleText } from './VisibleText.tsx'

/** The session's skills, commands and team members, so a sent message draws its tokens as the input drew them. */
export const SentCatalogue = createContext<PromptCatalogue>({})
export type TextPart = { kind: 'text' | 'code'; text: string }

/**
 * A person's text cut at its fenced code blocks: a line of three or more backticks opens one, and only a line of at least
 * as many backticks and nothing else closes it. A fence left open is text, as typed.
 */
export function fencedParts(text: string): TextPart[] {
  const lines = text.split('\n')
  const parts: TextPart[] = []
  let plain: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const open = /^(`{3,})[^`]*$/u.exec(lines[index]!)
    const fence = open?.[1]
    const closes = (line: string) => fence !== undefined && /^`+$/u.test(line.trimEnd()) && line.trimEnd().length >= fence.length
    const close = fence === undefined ? -1 : lines.findIndex((line, at) => at > index && closes(line))
    if (!open || close < 0) {
      plain.push(lines[index]!)
      continue
    }
    if (plain.length) parts.push({ kind: 'text', text: plain.join('\n') })
    plain = []
    parts.push({ kind: 'code', text: lines.slice(index + 1, close).join('\n') })
    index = close
  }
  if (plain.length) parts.push({ kind: 'text', text: plain.join('\n') })
  return parts
}

function TerminalExcerptView({ excerpt }: { excerpt: TerminalExcerpt }) {
  return (
    <figure className="sent-terminal-excerpt">
      <figcaption>
        <Icon icon={TerminalGlyph} size={14} />
        <VisibleText text={excerpt.label} />
        {excerpt.notes && (
          <small>
            <VisibleText text={excerpt.notes} />
          </small>
        )}
      </figcaption>
      <pre>
        <code>
          {excerpt.body.split('\n').map((line, index) => (
            <Fragment key={index}>
              {index > 0 && '\n'}
              {/^[ \t]+(?:at\s|File ")/u.test(line) ? (
                <span className="sent-terminal-stack">
                  <VisibleText text={line} />
                </span>
              ) : (
                <VisibleText text={line} />
              )}
            </Fragment>
          ))}
        </code>
      </pre>
    </figure>
  )
}

/** Terminal output is literal, even when the shell prints something that looks like an actionable reference. */
export function UserText({ text, refs }: { text: string; refs?: readonly FileMention[] }) {
  const excerpts = terminalExcerpts(text)
  if (!excerpts.length) return <TextWithQuotes text={text} refs={refs} />
  const parts: Array<string | TerminalExcerpt> = []
  let cursor = 0
  for (const excerpt of excerpts) {
    if (cursor < excerpt.from) parts.push(text.slice(cursor, excerpt.from))
    parts.push(excerpt)
    cursor = excerpt.to
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  const selected = refs?.slice(0, 32).filter(isFileMention) ?? []
  const unplaced = selected.filter(ref => !parts.some(part => typeof part === 'string' && mentionRange(part, ref)))
  return (
    <>
      {parts.map((part, index) => {
        if (typeof part !== 'string') return <TerminalExcerptView key={index} excerpt={part} />
        // The block already provides the line break at each of its edges.
        const before = index > 0 ? part.replace(/^\n/u, '') : part
        const words = index < parts.length - 1 ? before.replace(/\n$/u, '') : before
        return <TextWithQuotes key={index} text={words} refs={selected.filter(ref => mentionRange(part, ref))} />
      })}
      {unplaced.length > 0 && <MentionedText text="" refs={unplaced} />}
    </>
  )
}

function TextWithQuotes({ text, refs }: { text: string; refs?: readonly FileMention[] }) {
  const source = useContext(ReplyQuoteSource)
  const quotes = text.includes('[引用回复 ') ? replyQuotes(text) : []
  if (!quotes.length) return <UserTextParts text={text} refs={refs} />
  let previous = 0
  return (
    <>
      {quotes.map(({ from, to, quote }) => {
        const before = text.slice(previous, from)
        previous = to
        return (
          <Fragment key={from}>
            {before && <UserTextParts text={before} refs={refs} />}
            <span className="user-reply-quote">
              <VisibleText text={quote.text} />
              {source?.id === quote.sessionId && (
                <button type="button" onClick={() => source.open(quote)}>
                  {QUOTE_COPY.source}
                </button>
              )}
            </span>
          </Fragment>
        )
      })}
      <UserTextParts text={text.slice(previous)} refs={refs} />
    </>
  )
}

/** A person's message: its fenced blocks as code, the rest with its chips. */
function UserTextParts({ text, refs }: { text: string; refs?: readonly FileMention[] }) {
  const catalogue = useContext(SentCatalogue)
  const parts = fencedParts(text)
  if (!parts.some(part => part.kind === 'code')) return <MentionedText text={text} refs={refs} catalogue={catalogue} />
  // A command is only the message's first word: text after a block starts a part, not the message.
  const later = { ...catalogue, commands: undefined, actions: undefined }
  const selected = refs?.slice(0, 32).filter(isFileMention) ?? []
  const texts = parts.filter(part => part.kind === 'text').map(part => part.text)
  const unplaced = selected.filter(ref => !texts.some(part => mentionRange(part, ref)))
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'code' ? (
          <pre key={index} className="user-code">
            <code>
              <VisibleText text={part.text} />
            </code>
          </pre>
        ) : (
          // The newline before and after a block is the block's own edge, not an empty line.
          <MentionedText
            key={index}
            text={part.text.replace(/^\n|\n$/gu, '')}
            refs={selected}
            rest={false}
            catalogue={index === 0 ? catalogue : later}
          />
        ),
      )}
      {unplaced.length > 0 && <MentionedText text="" refs={unplaced} />}
    </>
  )
}

/**
 * Host-validated file choices as file chips, and the tokens the catalogue knows as the input's chips; edited or ordinary
 * @ text stays exactly as typed.
 */
export function MentionedText({
  text,
  refs,
  rest = true,
  catalogue = {},
}: {
  text: string
  refs?: readonly FileMention[]
  rest?: boolean
  catalogue?: PromptCatalogue
}) {
  const selected = refs?.slice(0, 32).filter(isFileMention) ?? []
  const fragments: ReactNode[] = []
  let at = 0
  for (const chip of promptChips(text, catalogue, selected)) {
    fragments.push(
      text.slice(at, chip.start),
      chip.kind === 'file' ? (
        <FileChip key={`${chip.start}:${chip.root}`} path={chip.path} rootId={chip.root} prompt />
      ) : (
        <PromptChipView key={chip.start} chip={chip} token={text.slice(chip.start, chip.end)} />
      ),
    )
    at = chip.end
  }
  fragments.push(text.slice(at))
  const other = rest ? selected.filter(ref => !mentionRange(text, ref)) : []
  return (
    <>
      {fragments}
      {other.length > 0 && (
        <span className="message-file-refs">
          {other.map(ref => (
            <FileChip key={`${ref.root}:${ref.path}`} path={ref.path} rootId={ref.root} />
          ))}
        </span>
      )}
    </>
  )
}
