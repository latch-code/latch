import type { SessionCommand, SessionSkill } from '@latch/protocol'

/** A token of the draft that the current Harness's catalogue names; the draft itself stays plain text. */
export interface PromptMark {
  start: number
  end: number
  kind: 'skill' | 'command'
  name: string
  description?: string
}

export interface PromptCatalogue {
  commands?: readonly Pick<SessionCommand, 'name' | 'description'>[] | undefined
  skills?: readonly SessionSkill[] | undefined
  /** Latch's own slash actions, run by the page and never sent. */
  actions?: readonly { name: string; description?: string }[] | undefined
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
  return marks
}

/** Backspace with the caret right after a mark takes the whole token. */
export function markBeforeCaret(marks: readonly PromptMark[], start: number, end: number): PromptMark | undefined {
  if (start !== end) return undefined
  return marks.find(mark => mark.end === start)
}
