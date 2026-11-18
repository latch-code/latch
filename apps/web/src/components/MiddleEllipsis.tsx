import { escapeHiddenCharacters } from './VisibleText.tsx'

/** Where a path or command is cut: before its last two parts when they are short, else before the last one. */
function tailStart(text: string): number {
  const parts = text.split('/')
  const two = parts.slice(-2).join('/')
  const tail = two.length <= 24 && parts.length > 2 ? two : (parts.at(-1) ?? '')
  return Math.max(0, text.length - Math.min(tail.length + 1, 24))
}

/**
 * Where a branch name is cut: before its last word when that is short (`-history-scroll`), else before its last 12
 * characters, so a few of its first characters (`fix/stud…`) stay beside it.
 */
function branchTailStart(text: string): number {
  const room = 16
  // A short name is not cut in two: its end gives way, as any short text's does.
  if (text.length <= room + 4) return 0
  for (let at = text.length - room; at < text.length - 4; at++) if ('/-_.'.includes(text[at] ?? '')) return at
  return text.length - 12
}

/**
 * A path or command on one line that keeps its end in view: when the line is too narrow, the middle gives way to an
 * ellipsis. The whole text is what assistive technology reads, and the native tooltip unless `title` is false (inside
 * a `Tooltip` that already has it).
 */
export function MiddleEllipsis({
  text,
  className,
  title = true,
  tail = 'path',
}: {
  text: string
  className?: string
  title?: boolean
  /** What stays in view: a path's last parts, or a branch name's last word. */
  tail?: 'path' | 'branch'
}) {
  const cut = tail === 'branch' ? branchTailStart(text) : tailStart(text)
  return (
    <span className={className ? `middle-ellipsis ${className}` : 'middle-ellipsis'} {...(title ? { title: text } : {})}>
      <span className="middle-ellipsis-head">{text.slice(0, cut)}</span>
      <span className="middle-ellipsis-tail">{text.slice(cut)}</span>
    </span>
  )
}

/**
 * A branch name as the Host read it, on one line: a long one loses its middle, so the part that tells branches apart
 * (`…-history-scroll`) stays. Hidden characters show as `\u{…}`.
 */
export function BranchName({ branch, title = false, className }: { branch: string; title?: boolean; className?: string }) {
  return (
    <MiddleEllipsis
      text={escapeHiddenCharacters(branch)}
      title={title}
      tail="branch"
      className={className ? `branch-name ${className}` : 'branch-name'}
    />
  )
}
