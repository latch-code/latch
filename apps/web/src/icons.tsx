import { ArrowLeftRight, FilePen, FileSearch, Wrench } from 'lucide-react'
import { ReasonGlyph, GlobeGlyph, SearchGlyph, TerminalGlyph, TrashGlyph, CloseGlyph } from '@latch/ui'
import type { Message, ToolKind } from '@latch/protocol'
import type { IconComponent } from '@latch/ui'

export const toolKindIcons: Record<ToolKind, IconComponent> = {
  read: FileSearch,
  edit: FilePen,
  delete: TrashGlyph,
  move: ArrowLeftRight,
  search: SearchGlyph,
  execute: TerminalGlyph,
  think: ReasonGlyph,
  fetch: GlobeGlyph,
  other: Wrench,
}

/** Guess a kind for tools that do not declare one, from conventional names. */
export function toolKind(message: Pick<Message, 'tool' | 'toolName'>): ToolKind {
  if (message.tool?.kind) return message.tool.kind
  const name = message.toolName?.toLowerCase() ?? ''
  if (/write|edit|patch|update|create/.test(name)) return 'edit'
  if (/read|cat|open|view/.test(name)) return 'read'
  if (/list|search|find|grep|glob/.test(name)) return 'search'
  if (/shell|exec|run|command|bash|task/.test(name)) return 'execute'
  if (/fetch|http|web|url/.test(name)) return 'fetch'
  if (/delete|remove/.test(name)) return 'delete'
  return 'other'
}

export { CloseGlyph as CloseIcon }
