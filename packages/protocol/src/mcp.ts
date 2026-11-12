/**
 * Latch's own MCP servers (`GET /mcp/servers`): local commands an agent reaches through Latch's `latch-mcp` bridge, and
 * remote addresses (Streamable HTTP) the Host itself is the client of. A definition never carries a secret's value: only
 * the names of its variables or request headers and whether each is set. See docs/MCP.md.
 */

/** Where a server is used: every session, or the sessions of the chosen Agents and projects (their union). */
export interface McpScope {
  all: boolean
  /** IDs of 我的 Agent (`agt_…`). */
  agents: string[]
  /** Project IDs. */
  projects: string[]
}

/**
 * Why a server did not come up, as the bridge, the Host's client or 测试 saw it; never the server's own words. The last
 * three are a remote address's: it asks for a login (OAuth, 尚未实现), it could not be reached or answered with an HTTP
 * error, or the Host refused to go there (an outbound rule, a redirect).
 */
export type McpFailure =
  | 'spawn-failed'
  | 'exited'
  | 'timeout'
  | 'protocol'
  | 'list-failed'
  | 'output-too-large'
  | 'auth-required'
  | 'unreachable'
  | 'refused'

/** The latest word on a server: from 测试 on this Mac, or from a session's bridge. */
export interface McpReport {
  status: 'ok' | 'failed'
  /** The tools it listed, by name, before any is switched off. */
  tools: string[]
  reason?: McpFailure
  at: string
  via: 'test' | 'session'
}

interface McpServerCommon {
  /** `mcp_` and 22 base64url characters. */
  id: string
  name: string
  scope: McpScope
  enabled: boolean
  disabledTools: string[]
  revision: number
  report?: McpReport
  createdAt: string
  updatedAt: string
}

/** A local command, started by the agent's `latch-mcp` bridge. */
export interface McpStdioServerView extends McpServerCommon {
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
  /** `npx`, `uvx` and the like with a package that names no version: each start may fetch a new one. */
  unpinned?: boolean
}

/**
 * A remote address (Streamable HTTP): the Host is its client, through its outbound rules; its request headers go only
 * to the origin and path that were confirmed, and never leave the Host.
 */
export interface McpHttpServerView extends McpServerCommon {
  transport: 'http'
  /** The confirmed address: origin and path, never a query. */
  url: string
  /** Its request headers by name; every value is secret. */
  headers: Array<{ name: string; set: boolean }>
  /**
   * The outbound allowance (`host:port`) that only this server uses, in the list for a device that manages this Host:
   * removing the server may remove it too. Absent when there is none, or another server or a model service uses it.
   */
  allowance?: string
}

export type McpServerView = McpStdioServerView | McpHttpServerView

export interface McpServersResponse {
  /** The list's revision: an add names it as `baseRevision`. */
  revision: number
  servers: McpServerView[]
}

/** What a server's name may be: what agents show it as, never one of Latch's own (`latch-…`). */
export const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u

/**
 * A name a server may be given now: no `__` either, which separates server and tool in `mcp__<server>__<tool>`.
 * `isSavedMcpServerName` still reads one saved before that rule.
 */
export function isMcpServerName(name: string): boolean {
  return isSavedMcpServerName(name) && !name.includes('__')
}

export function isSavedMcpServerName(name: string): boolean {
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

/** Request headers a remote server may not be given: the client's own, and those that change how HTTP is spoken. */
const RESERVED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'host',
  'keep-alive',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'origin',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** A request header's name a remote server may be given (an RFC 9110 token, not one of the client's own). */
export function isMcpHeaderName(name: string): boolean {
  return (
    /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u.test(name) && !RESERVED_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('sec-')
  )
}

/** The hosts `http://` may name: this Mac's own loopback, written literally. Anything else is `https://`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host)
}
