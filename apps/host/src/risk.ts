import { posix, win32 } from 'node:path'
import type { RiskLevel } from '@latch/protocol'
import { isProtectedWorkspacePath } from './paths.ts'

export interface StandardCallInput {
  /** Owner of the tool, from the registry capability `tool:<name>`. */
  pluginId: string | undefined
  toolName: string
  args: unknown
  demo: boolean
  /** `root`: the absolute, canonical workspace root of the call; its own components count for protected paths. */
  workspace: { codeRoot: boolean; root?: string }
}

export type RiskReason = 'protected-path' | 'outside-workspace' | 'code-root' | 'unlisted-tool'

/** Read-only built-in tools; they never ask. */
export const R0_TOOLS: readonly string[] = ['workspace-files:list_files', 'workspace-files:read_file']
/** Bounded demo tools, honoured only while the Host runs with the explicit demo model. */
export const DEMO_TOOLS: { R0: readonly string[]; R1: readonly string[] } = {
  R0: ['safe-tools:long_task'],
  R1: ['safe-tools:write_report'],
}

const WRITE_FILE = 'workspace-files:write_file'

function relativeTarget(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const path = (args as { path?: unknown }).path
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\u0000')) return undefined
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return undefined
  const normalized = posix.normalize(path.replace(/\\/gu, '/'))
  if (normalized === '..' || normalized.startsWith('../')) return undefined
  return path
}

/**
 * Host classification of a Standard tool call. Whatever a plugin declares (`requiresApproval`) is ignored:
 * only the listed built-in tools are below R2. Pure and synchronous; the tools themselves refuse symlinks.
 */
export function classifyStandardCall(input: StandardCallInput): { risk: RiskLevel; reason?: RiskReason } {
  const key = `${input.pluginId ?? ''}:${input.toolName}`
  if (input.pluginId !== undefined && key === WRITE_FILE) {
    const path = relativeTarget(input.args)
    if (path === undefined) return { risk: 'R2', reason: 'outside-workspace' }
    if (input.workspace.codeRoot) return { risk: 'R2', reason: 'code-root' }
    if (isProtectedWorkspacePath(path, input.workspace.root)) return { risk: 'R2', reason: 'protected-path' }
    return { risk: 'R1' }
  }
  if (input.pluginId !== undefined && R0_TOOLS.includes(key)) return { risk: 'R0' }
  if (input.demo && input.pluginId !== undefined) {
    if (DEMO_TOOLS.R0.includes(key)) return { risk: 'R0' }
    if (DEMO_TOOLS.R1.includes(key)) return { risk: 'R1' }
  }
  return { risk: 'R2', reason: 'unlisted-tool' }
}
