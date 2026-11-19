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
 * three are a remote address's: it asks for a login (登录 on this Mac, OAuth), it could not be reached or answered with an
 * HTTP error, or the Host refused to go there (an outbound rule, a redirect).
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
  /** Added as 「操控这台 Mac」 (Cua Driver) or 「Xcode」 (`xcrun mcpbridge`): never given to an unattended run. */
  preset?: 'computer' | 'xcode'
  /**
   * The tools Latch has listed for this server's switches: any other tool it names (after an upgrade) is new and off
   * until switched on. Absent: every tool not in `disabledTools` is on.
   */
  knownTools?: string[]
  /**
   * 「操控这台 Mac」: the switches the Host moved when it brought the server to new defaults (`run_steps`, `launch_app` on;
   * `get_desktop_state` off), until a device dismisses the note (`PATCH` with `defaultsSeen: true`).
   */
  defaultsMoved?: Array<'run_steps' | 'launch_app' | 'get_desktop_state'>
}

/**
 * The command that switches Cua Driver's own telemetry off, in its background service, which Latch's variables do not
 * reach. The person runs it; Latch only shows it.
 */
export const driverTelemetryOff = (command: string) => `${command} telemetry disable`

/** Whether a server's tool is offered to agents: not switched off, and not new to a server that keeps new tools off. */
export function isMcpToolOn(
  server: { disabledTools: readonly string[]; knownTools?: readonly string[] | undefined },
  tool: string,
): boolean {
  return !server.disabledTools.includes(tool) && (server.knownTools === undefined || server.knownTools.includes(tool))
}

/**
 * What a call to 「操控这台 Mac」 (Cua Driver) has the driver do, as the `latch-mcp` bridge reads it before the call is
 * sent (`COMPUTER_SHAPE_SOURCE` in `@latch/harness-acp`): enumerations only, never a value the agent typed. The Host
 * decides from it. Anything not read the way the driver reads it is `form: 'unknown'`, and refused.
 *
 * This guards against an agent's mistakes, not against the agent: an agent with a shell can run `cua-driver` itself,
 * past every switch. See docs/MCP.md (操控这台 Mac).
 */
export interface ComputerCallShape {
  form?: 'unknown'
  /** `run_steps`: every tool a step, a trailing read or `observe` can run, by the driver's own names. */
  steps?: string[]
  /** `run_steps`: how many steps it carries. */
  stepCount?: number
  /** `launch_app`: only `bundle_id`, or a `name` with no `/`, and nothing else. */
  launch?: 'ok' | 'refused'
  /** Some argument asks the driver to write a screenshot to a file (`screenshot_out_file`). */
  screenshotFile?: true
  /** Some `app`, `window` or `bundle_id`, or `launch_app`'s `name`, names Latch. */
  latchName?: true
  /** Every `pid` the arguments name, for the Host to compare with Latch's own processes. */
  pids?: number[]
}

/**
 * 「操控这台 Mac」's tools as settings group them, by what they let an agent do; a tool in none (a new one) is listed
 * apart. Display only: each tool keeps its own switch.
 */
export const COMPUTER_TOOL_GROUPS: ReadonlyArray<{ id: string; label: string; tools: readonly string[] }> = [
  {
    id: 'look',
    label: '看',
    tools: [
      'list_apps',
      'list_windows',
      'get_window_state',
      'get_accessibility_tree',
      'verify_state',
      'parse_visual_regions',
      'zoom',
      'get_screen_size',
      'get_cursor_position',
      'debug_window_info',
      'get_desktop_state',
    ],
  },
  {
    id: 'act',
    label: '操作',
    tools: [
      'click',
      'double_click',
      'right_click',
      'type_text',
      'press_key',
      'hotkey',
      'set_value',
      'scroll',
      'drag',
      'move_cursor',
      'mouse_button_down',
      'mouse_button_up',
      'mouse_drag',
      'parallel_mouse_drag',
      'invoke_menu',
      'bring_to_front',
      'set_window_frame',
    ],
  },
  { id: 'launch', label: '启动 App', tools: ['launch_app', 'kill_app'] },
  { id: 'batch', label: '批量', tools: ['run_steps'] },
  { id: 'script', label: '脚本', tools: ['run_script', 'replay_trajectory'] },
  {
    id: 'browser',
    label: '浏览器',
    tools: [
      'page',
      'get_browser_state',
      'browser_prepare',
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_pointer',
      'browser_dialog',
      'browser_set_input_files',
      'browser_download',
      'browser_motion_policy',
    ],
  },
  { id: 'clipboard', label: '剪贴板', tools: ['clipboard_read', 'clipboard_write'] },
  { id: 'record', label: '录屏', tools: ['start_recording', 'stop_recording', 'get_recording_state', 'install_ffmpeg'] },
  {
    id: 'manage',
    label: '管理',
    tools: [
      'start_session',
      'escalate_session',
      'get_session',
      'list_sessions',
      'get_session_state',
      'end_session',
      'set_agent_cursor_enabled',
      'set_agent_cursor_motion',
      'set_agent_cursor_theme',
      'get_agent_cursor_state',
      'get_config',
      'set_config',
      'check_permissions',
      'health_report',
      'check_for_update',
      'install_extension',
      'get_guide',
    ],
  },
]

/**
 * Why the Host refused a call to 「操控这台 Mac」 by its arguments (`mcp.tool.refused`): a form it does not read (`form`),
 * a batch step whose tool is off (`step-off`), `launch_app` with more than a bundle ID or a name (`launch-args`), a
 * screenshot written to a file (`screenshot-file`), or a call aimed at Latch's own window or processes (`latch`).
 */
export const COMPUTER_REFUSALS = ['form', 'step-off', 'launch-args', 'screenshot-file', 'latch'] as const
export type ComputerRefusal = (typeof COMPUTER_REFUSALS)[number]

/**
 * 「操控这台 Mac」 on this Mac's desktop app: whether Cua Driver is at its expected place, as Latch found it by its code
 * signature and its `--version`. `absent`: not installed. `old`: older than `minimum`. `refused`: something else is
 * there (`bundle`: not a regular app with that program; `signature`: not signed as Cua Driver; `version`: no version
 * read). `added`: the server already made from it.
 */
export interface McpComputerCheck {
  state: 'absent' | 'old' | 'ok' | 'refused'
  reason?: 'bundle' | 'signature' | 'version'
  version?: string
  minimum: string
  /** The release the install line names. */
  pinned: string
  /** The program the server runs. */
  command: string
  /** Installs or upgrades it, as the person runs it in their terminal; Latch never runs it. */
  install: string
  added?: string
}

/**
 * 「Xcode」 on this Mac's desktop app: whether Xcode's MCP bridge (`xcrun mcpbridge`) is here. `absent`: no Xcode or no
 * bridge. `old`: an Xcode older than `minimum`, whose bridge has no device tools. `added`: the server already made.
 */
export interface McpXcodeCheck {
  state: 'absent' | 'old' | 'ok'
  version?: string
  minimum: string
  /** What the server runs. */
  command: string
  added?: string
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
  /** Its login, when it asks for one or has one. */
  oauth?: McpOAuthView
  /**
   * The outbound allowance (`host:port`) that only this server uses, in the list for a device that manages this Host:
   * removing the server may remove it too. Absent when there is none, or another server or a model service uses it.
   */
  allowance?: string
}

/**
 * A remote server's login (OAuth), as any device may see it: `signed-out` (it asks for one, or one was ended),
 * `signing-in` (a login started on this Mac waits for the browser), `signed-in`, `relogin` (the token ran out or was
 * refused and could not be renewed) and `failed` (the last attempt, with why).
 */
export type McpOAuthState = 'signed-out' | 'signing-in' | 'signed-in' | 'relogin' | 'failed'

/** Why a login did not finish or no longer holds: the Host's own class, never the authorization server's words. */
export type McpOAuthFailure =
  | 'discovery'
  | 'resource'
  | 'metadata'
  | 'endpoint'
  | 'pkce'
  | 'client-required'
  | 'registration'
  | 'state'
  | 'issuer'
  | 'denied'
  | 'expired'
  | 'exchange'
  /** The authorization server's token is not shaped like one (token68, 20 characters or more). */
  | 'token'
  | 'scope'
  | 'refused'
  | 'unreachable'
  | 'cancelled'
  | 'audit'
  | 'refresh'
  | 'rejected'
  /** 退出登录 could not delete the tokens from this Mac; no request carries them, and it can be tried again. */
  | 'delete'

/** Never a token, a client secret, a code or a state: only where the login is and how it stands. */
export interface McpOAuthView {
  state: McpOAuthState
  /** The confirmed authorization server: its issuer, whole. Absent before the first login is confirmed. */
  issuer?: string
  /** The scopes that were confirmed; empty when the server names none. */
  scopes?: string[]
  /** When the access token runs out, if the authorization server said. */
  expiresAt?: string
  /** With `failed` and `relogin`. */
  reason?: McpOAuthFailure
  /** A client ID was typed on this Mac (the value stays there); otherwise Latch registers itself where offered. */
  clientId?: true
  /** A `signing-in` login ends by then. */
  until?: string
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

/**
 * A Harness's own MCP server as the Harness itself reports it over its protocol (Codex's app-server). Latch shows it
 * and never changes it: its definition, its login and its tokens stay the Harness's.
 */
export type HarnessMcpState = 'starting' | 'ready' | 'needs-login' | 'failed' | 'cancelled' | 'disabled' | 'not-started' | 'unknown'

export interface HarnessMcpServer {
  name: string
  state: HarnessMcpState
  /** How many tools it listed. Absent: not reported. */
  tools?: number
  /** A remote server's origin as the Harness reports it: no path, query or credentials. */
  origin?: string
  /** The Harness's own command that logs in to it, given only when the Harness reports that it needs a login. */
  login?: string
}

/** The latest report: from a session of the Harness (live, as its servers start) or from 读取 in settings. */
export interface HarnessMcpReport {
  servers: HarnessMcpServer[]
  at: string
  via: 'session' | 'read'
  /** More servers than Latch lists. */
  truncated?: true
  /** A 读取 with no session, of a Harness that then names its servers only: every state is `unknown`. */
  namesOnly?: true
  /**
   * The hooks the Harness runs in its sessions, Latch's among them, as the same read reported them (Codex's `hooks/list`).
   * Absent: it did not say. Never a hook's command, path or key.
   */
  hooks?: HarnessHook[]
  hooksTruncated?: true
}

/** One of a Harness's own hooks: when it runs and whose it is, with no command. */
export interface HarnessHook {
  /** The Harness's name for when it runs (Codex: `preToolUse`, `userPromptSubmit`, …). */
  event: string
  /** Where it is configured (Codex: `system`, `mdm`, `user`, `project`, `plugin`, `cloudRequirements`, …). */
  source: string
  /** A managed policy put it there: the person cannot turn it off. */
  managed: boolean
  enabled: boolean
  /** Codex's word: `managed`, `trusted`, `untrusted` (it does not run) or `modified` (changed since it was trusted). */
  trust?: string
}

/** On a Harness that reports its own MCP servers (`HarnessInfo.ownMcp`); absent on every other. */
export interface HarnessOwnMcp {
  running?: true
  last?: HarnessMcpReport
  /** The last 读取 failed, with the Host's own words. */
  failed?: { at: string; message: string }
}

/** A server in a project's `.mcp.json`, offered as a prefilled 添加 form; never run, never expanded. */
export interface McpImportCandidate {
  /** Its key in the file, clipped and with hidden characters shown. */
  key: string
  /** The key when it is a name a server may have here and no server has; otherwise empty, for the person to type. */
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  /** A plain variable keeps its value; a secret one (or one written `${…}`) only its name, for the person to fill. */
  env?: Array<{ name: string; secret: boolean; value?: string }>
  url?: string
  /** Request headers by name only: every value is secret and is typed again. */
  headers?: string[]
  /**
   * `expansion`: it writes `${…}`, which Latch shows as written and never expands. `repository-command`: its command is
   * inside a project or Latch's data, which Latch never saves. `repository-path`: its arguments or variables name a file
   * there, so 测试 refuses it. `secret`: an argument, or the address's account or query, looked like a credential and
   * was left blank, for the person to type as a secret.
   */
  flags: Array<'expansion' | 'repository-command' | 'repository-path' | 'secret'>
}

export type McpImportSkip = 'invalid' | 'unsupported' | 'legacy-sse'

/** One folder's `.mcp.json`. */
export interface McpImportFile {
  folderId: string
  /** `missing`: no file. `refused`: not a regular file, over 64 KiB, or not the shape of `.mcp.json`. */
  status: 'ok' | 'missing' | 'refused'
  reason?: 'not-file' | 'too-large' | 'not-json' | 'invalid'
  servers: McpImportCandidate[]
  skipped: Array<{ key: string; reason: McpImportSkip }>
  truncated?: true
}

export interface McpImportResponse {
  workspaceId: string
  files: McpImportFile[]
}
