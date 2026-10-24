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
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react'
import type { Message, ToolKind } from '@latch/protocol'
import type { LucideIcon } from '@latch/ui'

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

export const toolStateIcons: Record<NonNullable<Message['state']>, LucideIcon> = {
  queued: Clock,
  'awaiting-approval': ShieldAlert,
  running: LoaderCircle,
  completed: Check,
  failed: TriangleAlert,
  cancelled: CircleSlash,
}

export { X as CloseIcon }
