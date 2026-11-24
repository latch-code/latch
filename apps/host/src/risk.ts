import { posix, win32 } from 'node:path'
import type { ApprovalRiskReason, RiskLevel } from '@latch/protocol'
import { BROWSER_READS, isBrowserTool, type OriginClass } from './browser-broker.ts'
import { isProtectedWorkspacePath } from './paths.ts'
import { DEVICE_READS, isDeviceTool } from './plugins/tools/device/index.ts'

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
  /** For a browser tool: what the broker's tab table says about the tab the call names. */
  browser?: BrowserCallFacts
  /** The Host itself put its conversation-reference read among this run's tools; no plugin's tool has that name in it. */
  hostReference?: boolean
}

/** What the Host knows of the tab a browser call names, from the desktop app's reports. */
export interface BrowserCallFacts {
  /** Where the tab is and who opened it; absent when the session has no such tab. */
  tab?: { origin: OriginClass; opener: 'agent' | 'person' }
  /** `browser_type`: whether its reference names a password, one-time-code, card or hidden field; absent if never read. */
  sensitive?: boolean
}

/** How the built-in harness names a remote MCP server's tool: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** The plugin of the built-in browser tools. */
export const BROWSER_PLUGIN = 'browser'
/** The plugin of the built-in simulator tools. */
export const DEVICE_PLUGIN = 'device'

export type RiskReason = ApprovalRiskReason

/** Read-only built-in tools; they never ask. */
export const R0_TOOLS: readonly string[] = [
  'workspace-files:list_folders',
  'workspace-files:list_files',
  'workspace-files:read_file',
  'user-questions:ask_user',
]
/**
 * The Host's own tool that reads a conversation the person referenced in this turn's message. No plugin owns it; the
 * Host offers it only on that turn, and before and after each read checks the reference, the granting device's rights
 * and the private boundary, records the read, and marks the context as holding outside content.
 */
export const REFERENCE_READ_TOOL = 'read_conversation_reference'
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
 * only the listed built-in tools and the Host's own conversation-reference read are below R2; a remote MCP server's tool is R2 (`mcp-tool`). Reads in any folder of the session are R0 and ordinary writes R1; a call
 * that names a folder outside the session is R2. Pure and synchronous; the tools themselves refuse symlinks.
 */
export function classifyStandardCall(input: StandardCallInput): { risk: RiskLevel; reason?: RiskReason } {
  // A remote MCP server's tool (`mcp__<server>__<tool>`, no plugin's): asked every time, whatever the server says of it.
  if (input.pluginId === undefined && input.toolName.startsWith(MCP_TOOL_PREFIX)) return { risk: 'R2', reason: 'mcp-tool' }
  // A read, like the file reads. Only the tool the Host offered this run: a plugin's tool of this name is not it,
  // with an owner or (its plugin switched off mid-run) without one.
  if (input.hostReference === true && input.pluginId === undefined && input.toolName === REFERENCE_READ_TOOL) return { risk: 'R0' }
  const key = `${input.pluginId ?? ''}:${input.toolName}`
  const builtin = input.pluginId !== undefined
  if (input.pluginId === BROWSER_PLUGIN && isBrowserTool(input.toolName))
    return classifyBrowserCall(input.toolName, input.args, input.browser ?? {})
  if (input.pluginId === DEVICE_PLUGIN && isDeviceTool(input.toolName)) return classifyDeviceCall(input.toolName)
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

/**
 * The built-in browser tools. Looking is R0 and acting R1; typing into a password, one-time-code, card or hidden field,
 * or into a field never read, is R2. The broker refuses every tool but listing and closing on a tab that is not on this
 * Mac's own addresses (localhost, `*.localhost`, 127/8, ::1) or blank, whatever was approved, so an allowance for this
 * session never reaches another address. The class does not depend on where the tab is, which can change between the
 * classification and the call. Closing a tab the Agent opened is R0, one the person opened R1.
 */
export function classifyBrowserCall(tool: string, _args: unknown, facts: BrowserCallFacts): { risk: RiskLevel; reason?: RiskReason } {
  if (!isBrowserTool(tool)) return { risk: 'R2', reason: 'unlisted-tool' }
  if (tool === 'browser_close') return { risk: facts.tab && facts.tab.opener !== 'agent' ? 'R1' : 'R0' }
  if (BROWSER_READS.has(tool)) return { risk: 'R0' }
  if (tool === 'browser_type' && facts.sensitive !== false) return { risk: 'R2', reason: 'sensitive-field' }
  return { risk: 'R1' }
}

/**
 * The simulator tools: listing, a picture and the apps are R0; opening an address, the appearance, rotating, launching a
 * listed app, and tapping, swiping, typing and pressing are R1. The Host refuses an address that is not this Mac's own,
 * and any deep link, whatever was approved; a launch takes no arguments; input runs only for a full-access (L3) session a
 * person started. There is no tool that boots, shuts down, erases, installs or records.
 */
export function classifyDeviceCall(tool: string): { risk: RiskLevel; reason?: RiskReason } {
  if (!isDeviceTool(tool)) return { risk: 'R2', reason: 'unlisted-tool' }
  return { risk: DEVICE_READS.has(tool) ? 'R0' : 'R1' }
}
