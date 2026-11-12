/**
 * Latch's own MCP servers (`GET /mcp/servers`): local commands an agent reaches through Latch's `latch-mcp` bridge. A
 * definition never carries a secret's value: only the names of its variables and whether each is set. See docs/MCP.md.
 */

/** Where a server is used: every session, or the sessions of the chosen Agents and projects (their union). */
export interface McpScope {
  all: boolean
  /** IDs of 我的 Agent (`agt_…`). */
  agents: string[]
  /** Project IDs. */
  projects: string[]
}

/** Why a server did not come up, as the bridge or 测试 saw it; never the server's own words. */
export type McpFailure = 'spawn-failed' | 'exited' | 'timeout' | 'protocol' | 'list-failed' | 'output-too-large'

/** The latest word on a server: from 测试 on this Mac, or from a session's bridge. */
export interface McpReport {
  status: 'ok' | 'failed'
  /** The tools it listed, by name, before any is switched off. */
  tools: string[]
  reason?: McpFailure
  at: string
  via: 'test' | 'session'
}

export interface McpServerView {
  /** `mcp_` and 22 base64url characters. */
  id: string
  name: string
  transport: 'stdio'
  /** The absolute path the Host found when it was saved; this is what runs. */
  command: string
  args: string[]
  /**
   * Its variables. A plain one is part of what was confirmed and shows its value; a secret one only whether it is set.
   */
  env: Array<{ name: string; set: boolean; secret: boolean; value?: string }>
  /** Starts in the session's main folder instead of an empty private one. */
  projectCwd: boolean
  scope: McpScope
  enabled: boolean
  disabledTools: string[]
  revision: number
  /** `npx`, `uvx` and the like with a package that names no version: each start may fetch a new one. */
  unpinned?: boolean
  report?: McpReport
  createdAt: string
  updatedAt: string
}

export interface McpServersResponse {
  /** The list's revision: an add names it as `baseRevision`. */
  revision: number
  servers: McpServerView[]
}

/** What a server's name may be: what agents show it as, never one of Latch's own (`latch-…`). */
export const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u

export function isMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME.test(name) && !name.toLowerCase().startsWith('latch')
}

const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx'])

/**
 * Whether a command fetches its package anew at each start: a package runner whose first package argument names no
 * version (`@scope/pkg@1.2.3`, `pkg==1.0` and `pkg@latest` aside, the last of which still moves).
 */
export function isUnpinnedRunner(command: string, args: readonly string[]): boolean {
  const base = command.split('/').pop() ?? command
  if (!RUNNERS.has(base)) return false
  const pkg = args.find(arg => !arg.startsWith('-'))
  if (!pkg) return false
  if (base === 'uvx') return !/==|@/u.test(pkg)
  const at = pkg.startsWith('@') ? pkg.indexOf('@', 1) : pkg.indexOf('@')
  return at < 0 || pkg.slice(at + 1) === 'latest'
}
