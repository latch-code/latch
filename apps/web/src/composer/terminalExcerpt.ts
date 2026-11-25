/** Ranges use UTF-16 offsets in the original draft, as CodeMirror does. */
export interface TerminalExcerpt {
  from: number
  to: number
  label: string
  notes: string
  body: string
}

const heading = /^(终端 [\d,]+(?: · 最近报错)?|Terminal [\d,]+(?: · Latest error)?)(（较早的输出未包含）| \(earlier output omitted\))?$/u
const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u

/** Recognize the terminal's complete excerpts, leaving ordinary code examples and incomplete edits as typed. */
export function terminalExcerpts(text: string): TerminalExcerpt[] {
  if (!text.includes('终端 ') && !text.includes('Terminal ')) return []
  const result: TerminalExcerpt[] = []
  const lines = text.split('\n')
  let fence = ''
  let candidate: { from: number; bodyFrom: number; label: string; notes: string } | undefined
  let offset = 0
  for (const [index, line] of lines.entries()) {
    if (fence) {
      if (closing.exec(line)?.[1]?.startsWith(fence)) {
        if (candidate && line === fence && offset > candidate.bodyFrom) {
          const { from, label, notes, bodyFrom } = candidate
          const body = text.slice(bodyFrom, offset - 1)
          // draftText chooses a fence longer than any run in the output. An unfinished edit may otherwise
          // borrow the closing fence of a later code example and turn the whole example into terminal output.
          if (body.trim() && !body.includes(fence)) result.push({ from, to: offset + line.length, label, notes, body })
        }
        candidate = undefined
        fence = ''
      }
    } else {
      const match = opening.exec(line)
      if (match && !(match[1]![0] === '`' && match[2]!.includes('`'))) {
        fence = match[1]!
        const previous = lines[index - 1] ?? ''
        const title = line === fence + 'text' && fence[0] === '`' && heading.exec(previous)
        if (title)
          candidate = { from: offset - previous.length - 1, bodyFrom: offset + line.length + 1, label: title[1]!, notes: title[2] ?? '' }
      }
    }
    offset += line.length + 1
  }
  return result
}
