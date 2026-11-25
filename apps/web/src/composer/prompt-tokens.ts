import { Text } from '@codemirror/state'
import { readReferenceExcerpts } from './referenceExcerpts.ts'
import type { ReactNode } from 'react'
import type { FileMention, SessionCommand, SessionSkill } from '@latch/protocol'
import { replyQuotes } from '../conversation/replyQuote.ts'
import { mentionRanges } from '../fileMentions.ts'

/** A token of the draft that the current Harness's catalogue names; the draft itself stays plain text. */
export interface PromptMark {
  start: number
  end: number
  kind: 'skill' | 'command' | 'member' | 'conversation' | 'quote'
  name: string
  description?: string
  /** A member's mark: its Harness's mark, drawn where the `@` is. */
  media?: ReactNode
}

export interface PromptCatalogue {
  commands?: readonly Pick<SessionCommand, 'name' | 'description'>[] | undefined
  skills?: readonly SessionSkill[] | undefined
  /** Latch's own slash actions, run by the page and never sent. */
  actions?: readonly { name: string; description?: string }[] | undefined
  /** Members of the team this session leads: `@token` standing on its own is a member's chip. */
  members?: readonly { token: string; name: string; title: string; media?: ReactNode }[] | undefined
}

/**
 * Marks only what will be read as a token. `$name` skills follow the Codex wire (`(?:^|\s)(\$\S+)`, an exact catalogue
 * hit), so `请$skill` or `$skill。` stay text there and here. A Harness command or a `/skill:name` is the draft's first
 * word (the Host's `^\/(\S+)`, the menu's `initial`); a Latch action may follow leading space and use `／`, as
 * `latchActionOf` reads it. Anything else, including unknown names, paths and URLs, stays plain.
 */
export function promptMarks(text: string, catalogue: PromptCatalogue): PromptMark[] {
  const marks: PromptMark[] = []
  const skills = new Map((catalogue.skills ?? []).map(skill => [skill.invocation, skill]))
  const skill = (start: number, invocation: string): PromptMark | undefined => {
    const found = skills.get(invocation)
    return found
      ? {
          start,
          end: start + invocation.length,
          kind: 'skill',
          name: found.name,
          ...(found.description ? { description: found.description } : {}),
        }
      : undefined
  }
  const head = /^\S+/u.exec(text)?.[0]
  if (head && !head.startsWith('$')) {
    const name = head.slice(1)
    const command = head.startsWith('/') ? catalogue.commands?.find(item => item.name === name) : undefined
    const mark = skill(0, head) ?? (command && { start: 0, end: head.length, kind: 'command' as const, name: command.name })
    if (mark) marks.push(command?.description && mark.kind === 'command' ? { ...mark, description: command.description } : mark)
  }
  if (!marks.length) {
    const action = /^(\s*)[/／]([^\s/／]+)(?=\s|$)/u.exec(text)
    const found = action && catalogue.actions?.find(item => item.name === action[2])
    if (action && found) {
      const start = action[1]!.length
      marks.push({
        start,
        end: start + 1 + found.name.length,
        kind: 'command',
        name: found.name,
        ...(found.description ? { description: found.description } : {}),
      })
    }
  }
  for (const match of text.matchAll(/(^|\s)(\$\S+)/gu)) {
    const mark = skill(match.index + match[1]!.length, match[2]!)
    if (mark) marks.push(mark)
  }
  for (const member of catalogue.members ?? [])
    for (let start = text.indexOf(member.token); start >= 0; start = text.indexOf(member.token, start + 1)) {
      const end = start + member.token.length
      if ((start === 0 || /\s/u.test(text[start - 1]!)) && (end === text.length || /\s/u.test(text[end]!)))
        marks.push({
          start,
          end,
          kind: 'member',
          name: member.name,
          ...(member.title !== member.name ? { description: member.title } : {}),
          ...(member.media ? { media: member.media } : {}),
        })
    }
  return marks
}

/** A token of the draft drawn as a chip: a catalogue mark, or a file chosen with `@` whose marker is still in the text. */
export type PromptChip = PromptMark | { start: number; end: number; kind: 'file'; name: string; root: string; path: string }

/**
 * Every chip of the draft, in order and never overlapping: the catalogue's marks and the `@root:path` markers of the
 * files currently referenced, each standing on its own between whitespace. Where two would overlap the earlier one wins.
 */
export function promptChips(
  text: string,
  catalogue: PromptCatalogue,
  refs: readonly FileMention[] = [],
  literalRanges?: readonly { from: number; to: number }[],
): PromptChip[] {
  const files: PromptChip[] = refs.flatMap(ref =>
    mentionRanges(text, ref).map(range => ({
      ...range,
      kind: 'file' as const,
      name: ref.path.slice(ref.path.lastIndexOf('/') + 1) || ref.path,
      root: ref.root,
      path: ref.path,
    })),
  )
  const references: PromptMark[] = []
  if (text.includes('[conversation-ref:')) {
    for (const match of text.matchAll(/\[conversation-ref:[a-f0-9-]{36}\] ([^\n]{1,500}?) · read_conversation_reference/gu))
      references.push({ start: match.index, end: match.index + match[0].length, kind: 'conversation', name: match[1]!, description: '' })
  }
  for (const { from, to, quote } of replyQuotes(text)) {
    // The composer appends a blank separator so typing beside the chip stays outside the quoted passage.
    const end = text.startsWith('\n\n', to) ? to + 2 : to
    references.push({ start: from, end, kind: 'quote', name: quote.text })
  }
  const all = [...promptMarks(text, catalogue), ...files, ...references].sort((a, b) => a.start - b.start || b.end - a.end)
  const chips: PromptChip[] = []
  for (const chip of all) {
    if (chip.end <= chip.start || chip.start < (chips.at(-1)?.end ?? 0)) continue
    if (chip.kind === 'member') {
      literalRanges ??= readReferenceExcerpts(Text.of(text.split('\n'))).literal
      if (literalRanges.some(range => chip.start < range.to && chip.end > range.from)) continue
    }
    chips.push(chip)
  }
  return chips
}
