import { Braces } from 'lucide-react'
import { defineGlyph, Icon, TerminalGlyph, type IconComponent } from '@latch/ui'
import { referenceIcon } from '../fileReference.ts'

const go = defineGlyph(
  'file-go',
  <g transform="translate(1.3 0) skewX(-9)">
    <path d="M7.4 5.6 C6.9 4.7 6 4.2 4.8 4.2 C2.8 4.2 1.5 5.8 1.5 8 S2.8 11.8 4.8 11.8 C6 11.8 6.9 11.4 7.5 10.8 V8.3 H4.8" />
    <ellipse cx="12.2" cy="8" rx="2.8" ry="3.8" />
  </g>,
)
const letterS =
  'M14.3 5.3 C13.7 4.5 12.8 4.1 11.7 4.1 C10.2 4.1 9.2 4.9 9.2 6.1 C9.2 8.8 14.4 7.3 14.4 10 C14.4 11.2 13.3 12 11.8 12 C10.5 12 9.5 11.5 8.8 10.6'
const ts = defineGlyph('file-ts', <path d={`M0.7 4.6 H7.9 M4.3 4.6 V12 ${letterS}`} />)
const js = defineGlyph('file-js', <path d={`M6.4 4 V9.1 C6.4 11 5.4 12 3.8 12 C2.5 12 1.5 11.3 1.2 10 ${letterS}`} />)
const py = defineGlyph('file-py', <path d="M2 12.2 V4.1 H4.7 A2.3 2.3 0 0 1 4.7 8.7 H2 M8.6 4.1 L11.5 8.3 L14.4 4.1 M11.5 8.3 V12.2" />)
const md = defineGlyph('file-md', <path d="M1.2 11.7 V4.7 L4.4 8.2 L7.6 4.7 V11.7 M12.4 4.3 V10.8 M9.7 8.4 L12.4 11.4 L15.1 8.4" />)

const FORMATS = new Map<string, IconComponent>([
  ['go', go],
  ['ts', ts],
  ['tsx', ts],
  ['mts', ts],
  ['cts', ts],
  ['js', js],
  ['jsx', js],
  ['mjs', js],
  ['cjs', js],
  ['py', py],
  ['pyi', py],
  ['md', md],
  ['markdown', md],
  ['mdx', md],
  ['json', Braces],
  ['jsonc', Braces],
  ['jsonl', Braces],
  ['sh', TerminalGlyph],
  ['bash', TerminalGlyph],
  ['zsh', TerminalGlyph],
])

/** A decorative file-type mark in prose; the path or the author's link text supplies the name. */
export function ReplyFileIcon({ path }: { path: string }) {
  return <Icon icon={referenceIcon(path, FORMATS)} size={14} />
}
