import { createContext, useContext, type ReactNode } from 'react'
import { isFileMention, type FileMention } from '@latch/protocol'
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

/** A person's message: its fenced blocks as code, the rest with its chips. */
export function UserText({ text, refs }: { text: string; refs?: readonly FileMention[] }) {
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
