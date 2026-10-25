import { posix, win32 } from 'node:path'
import type { ApprovalRiskReason, RiskLevel } from '@latch/protocol'
import { isProtectedWorkspacePath } from './paths.ts'

/** One folder of the session, as the Host resolved it for this call. */
export interface CallFolder {
  /** The folder's ID inside the project; tools take it as their `folder` argument. */
  id: string
  /** The absolute, canonical folder root; its own components count for protected paths. Absent: it cannot be resolved. */
  root?: string
  /** The folder overlaps Latch's code root, or its root cannot be resolved (the stricter answer). */
  codeRoot: boolean
}

export interface StandardCallInput {
  /** Owner of the tool, from the registry capability `tool:<name>`. */
  pluginId: string | undefined
  toolName: string
  args: unknown
  demo: boolean
  /** The session's folders in order; `[0]` is the primary folder, used when a call names none. */
  folders: readonly CallFolder[]
}

export type RiskReason = ApprovalRiskReason

/** Read-only built-in tools; they never ask. */
export const R0_TOOLS: readonly string[] = [
  'workspace-files:list_folders',
  'workspace-files:list_files',
  'workspace-files:read_file',
  'user-questions:ask_user',
]
/** Bounded demo tools, honoured only while the Host runs with the explicit demo model. */
export const DEMO_TOOLS: { R0: readonly string[]; R1: readonly string[] } = {
  R0: ['safe-tools:long_task'],
  R1: ['safe-tools:write_report'],
}

const WRITE_FILE = 'workspace-files:write_file'
/** The built-in tools that take a `folder` argument. */
const FOLDER_TOOLS: readonly string[] = ['workspace-files:list_files', 'workspace-files:read_file', WRITE_FILE]

function record(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined
}

/** The relative path a write targets, or why it is not one the classifier can place inside the session's folder. */
function relativeTarget(args: unknown): string | { reason: 'outside-workspace' | 'unresolved-path' } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { reason: 'unresolved-path' }
  const path = (args as { path?: unknown }).path
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\u0000')) return { reason: 'unresolved-path' }
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return { reason: 'unresolved-path' }
  const normalized = posix.normalize(path.replace(/\\/gu, '/'))
  if (normalized === '..' || normalized.startsWith('../')) return { reason: 'outside-workspace' }
  return path
}

/**
 * The session folder a call targets: the one its `folder` argument names, or the primary folder without one. Undefined
 * when the argument names no folder of the session, or is not a string.
 */
export function targetFolder<T extends { id: string }>(args: unknown, folders: readonly T[]): T | undefined {
  const values = record(args)
  if (values === undefined || values.folder === undefined) return folders[0]
  return typeof values.folder === 'string' ? folders.find(folder => folder.id === values.folder) : undefined
}

/**
 * Host classification of a Standard tool call. Whatever a plugin declares (`requiresApproval`) is ignored:
 * only the listed built-in tools are below R2. Reads in any folder of the session are R0 and ordinary writes R1; a call
 * that names a folder outside the session is R2. Pure and synchronous; the tools themselves refuse symlinks.
 */
export function classifyStandardCall(input: StandardCallInput): { risk: RiskLevel; reason?: RiskReason } {
  const key = `${input.pluginId ?? ''}:${input.toolName}`
  const builtin = input.pluginId !== undefined
  if (builtin && FOLDER_TOOLS.includes(key)) {
    const folder = targetFolder(input.args, input.folders)
    if (folder === undefined) return { risk: 'R2', reason: 'outside-workspace' }
    if (key !== WRITE_FILE) return { risk: 'R0' }
    const path = relativeTarget(input.args)
    if (typeof path !== 'string') return { risk: 'R2', reason: path.reason }
    if (folder.codeRoot || folder.root === undefined) return { risk: 'R2', reason: 'code-root' }
    if (isProtectedWorkspacePath(path, folder.root)) return { risk: 'R2', reason: 'protected-path' }
    return { risk: 'R1' }
  }
  if (builtin && R0_TOOLS.includes(key)) return { risk: 'R0' }
  if (input.demo && builtin) {
    if (DEMO_TOOLS.R0.includes(key)) return { risk: 'R0' }
    if (DEMO_TOOLS.R1.includes(key)) return { risk: 'R1' }
  }
  return { risk: 'R2', reason: 'unlisted-tool' }
}
