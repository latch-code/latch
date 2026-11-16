import type { ReactNode } from 'react'
import { isFileMention, type FileMention } from '@latch/protocol'
import { mentionRange } from '../fileMentions.ts'
import { FileChip } from './FileChip.tsx'
import { VisibleText } from './VisibleText.tsx'
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

/** A person's message: its fenced blocks as code, the rest with its file chips. */
export function UserText({ text, refs }: { text: string; refs?: readonly FileMention[] }) {
  const parts = fencedParts(text)
  if (!parts.some(part => part.kind === 'code')) return <MentionedText text={text} refs={refs} />
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
          <MentionedText key={index} text={part.text.replace(/^\n|\n$/gu, '')} refs={selected} rest={false} />
        ),
      )}
      {unplaced.length > 0 && <MentionedText text="" refs={unplaced} />}
    </>
  )
}

/** Render only Host-validated choices as file chips; edited or ordinary @ text stays exactly as typed. */
export function MentionedText({ text, refs, rest = true }: { text: string; refs?: readonly FileMention[]; rest?: boolean }) {
  const selected = refs?.slice(0, 32).filter(isFileMention) ?? []
  const ranges = selected
    .flatMap(ref => {
      const range = mentionRange(text, ref)
      return range ? [{ ...range, ref }] : []
    })
    .sort((a, b) => a.start - b.start)
  const fragments: ReactNode[] = []
  let at = 0
  for (const range of ranges) {
    if (range.start < at) continue
    fragments.push(
      text.slice(at, range.start),
      <FileChip key={`${range.start}:${range.ref.root}`} path={range.ref.path} rootId={range.ref.root} />,
    )
    at = range.end
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
