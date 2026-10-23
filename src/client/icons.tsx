import {
  ArrowLeftRight,
  Brain,
  Check,
  CircleSlash,
  Clock,
  FilePen,
  FileSearch,
  Globe,
  LoaderCircle,
  Search,
  ShieldAlert,
  Terminal,
  Trash,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { Message, TaskStatus, ToolKind } from '../shared/types.ts'

export type { LucideIcon }

/** Lucide (ISC) glyphs at the design-system stroke; sizes are 14/16/18/20. */
export const ICON_STROKE = 1.75

export const toolKindIcons: Record<ToolKind, LucideIcon> = {
  read: FileSearch,
  edit: FilePen,
  delete: Trash,
  move: ArrowLeftRight,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
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

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <LoaderCircle
      className="spin"
      size={size}
      strokeWidth={ICON_STROKE}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

export const toolStateIcons: Record<NonNullable<Message['state']>, LucideIcon> = {
  queued: Clock,
  'awaiting-approval': ShieldAlert,
  running: LoaderCircle,
  completed: Check,
  failed: X,
  cancelled: CircleSlash,
}

/** Sidebar/state glyph: nothing for a settled session, so only exceptions draw attention. */
export function SessionGlyph({ status }: { status: TaskStatus }) {
  if (status === 'running') return <Spinner size={12} />
  if (status === 'waiting-approval') return <i className="state-dot is-waiting" aria-hidden="true" />
  if (status === 'failed') return <i className="state-dot is-failed" aria-hidden="true" />
  if (status === 'cancelled' || status === 'interrupted') return <CircleSlash size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
  return null
}

export { X as CloseIcon }
