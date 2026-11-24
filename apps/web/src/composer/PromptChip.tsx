import type { ReactNode } from 'react'
import { BookOpen, MessageSquare, Quote, Users } from 'lucide-react'
import { CodeGlyph, Icon } from '@latch/ui'
import { escapeSecurityText } from '@latch/protocol'
import { referenceIcon } from '../fileReference.ts'
import { defineCopy } from '../core/i18n.ts'
import type { PromptChip } from './prompt-tokens.ts'

const COPY = defineCopy(
  { quote: '引用原句', conversation: '引用会话', skill: '技能 · ', command: '命令 · ', member: '成员 · ' },
  { quote: 'Quoted passage', conversation: 'Conversation reference', skill: 'Skill · ', command: 'Command · ', member: 'Member · ' },
)

/** What a chip says: a file by its name, the rest by the catalogue's name, never with its `$`, `/` or `@`. */
export const chipLabel = (chip: PromptChip): string => (chip.kind === 'quote' ? COPY.quote : escapeSecurityText(chip.name))

/** The chip's hover: a file's root and whole path; a member's task; a skill's or command's name and description. */
export function chipTip(chip: PromptChip): string {
  if (chip.kind === 'file') return escapeSecurityText(`${chip.root}:${chip.path}`)
  if (chip.kind === 'quote') return COPY.quote + '\n' + escapeSecurityText(chip.description ?? '')
  if (chip.kind === 'conversation') return COPY.conversation + ' · ' + escapeSecurityText(chip.name)
  const head = (chip.kind === 'skill' ? COPY.skill : chip.kind === 'member' ? COPY.member : COPY.command) + chip.name
  return chip.description ? `${escapeSecurityText(head)}\n${escapeSecurityText(chip.description)}` : escapeSecurityText(head)
}

/** The 14px glyph before the label: the file's type, a book, a code glyph, or the member's Harness mark. */
export function chipIcon(chip: PromptChip): ReactNode {
  if (chip.kind === 'file') return <Icon icon={referenceIcon(chip.path)} size={14} />
  if (chip.kind === 'quote') return <Icon icon={Quote} size={14} />
  if (chip.kind === 'conversation') return <Icon icon={MessageSquare} size={14} />
  if (chip.kind === 'skill') return <Icon icon={BookOpen} size={14} />
  if (chip.kind === 'command') return <Icon icon={CodeGlyph} size={14} />
  return chip.media ?? <Icon icon={Users} size={14} />
}

/**
 * A token as a chip, the same in the input (built by `PromptEditor`'s widget) and in a sent message: the glyph, the
 * label, and the token itself for assistive technology, which reads the text as it was written.
 */
export function PromptChipView({ chip, token }: { chip: PromptChip; token: string }) {
  return (
    <span className="prompt-chip" data-kind={chip.kind} title={chipTip(chip)}>
      <span className="prompt-chip-icon" aria-hidden="true">
        {chipIcon(chip)}
      </span>
      <span className="prompt-chip-label" aria-hidden="true">
        {chipLabel(chip)}
      </span>
      <span className="prompt-chip-token">
        {chip.kind === 'conversation' || chip.kind === 'quote' ? chipLabel(chip) : escapeSecurityText(token)}
      </span>
    </span>
  )
}
