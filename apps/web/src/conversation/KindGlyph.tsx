import { ArrowRightLeft, FilePlus2, FileText, Globe, ListTree, PencilLine, Search, SquareTerminal, Trash2, Wrench } from 'lucide-react'
import type { ToolKind } from '@latch/protocol'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { Icon, ReasonGlyph, type IconComponent } from '@latch/ui'

/** What a work row did, as its glyph and tint say it: one per kind, a sub-agent, a thought, a group of steps. */
export type RowKind = ToolKind | 'new' | 'agent' | 'steps'

const GLYPHS: Record<Exclude<RowKind, 'agent'>, IconComponent> = {
  read: FileText,
  search: Search,
  edit: PencilLine,
  new: FilePlus2,
  delete: Trash2,
  move: ArrowRightLeft,
  execute: SquareTerminal,
  fetch: Globe,
  think: ReasonGlyph,
  steps: ListTree,
  other: Wrench,
}

/** The tint a kind takes from the content palette (tool-card.css); the rest stay in the muted ink. */
const TINT: Partial<Record<RowKind, string>> = {
  read: 'read',
  search: 'search',
  edit: 'edit',
  new: 'edit',
  delete: 'edit',
  move: 'edit',
  execute: 'run',
  fetch: 'web',
  agent: 'agent',
}

/** The 16px slot at the start of a work row: everything a row opens to lines up with the words after it. */
export function KindGlyph({ kind }: { kind: RowKind }) {
  const tint = TINT[kind]
  return (
    <span className="kind-glyph" data-tint={tint} aria-hidden="true">
      <Icon icon={kind === 'agent' ? AgentsGlyph : GLYPHS[kind]} size={14} />
    </span>
  )
}
