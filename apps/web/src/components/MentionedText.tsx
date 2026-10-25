import type { ReactNode } from 'react'
import { isFileMention, type FileMention } from '@latch/protocol'
import { mentionRange } from '../fileMentions.ts'
import { FileChip } from './FileChip.tsx'
/** Render only Host-validated choices as file chips; edited or ordinary @ text stays exactly as typed. */
export function MentionedText({ text, refs }: { text: string; refs?: readonly FileMention[] }) {
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
  const other = selected.filter(ref => !mentionRange(text, ref))
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
