// 从项目导入 (docs/MCP.md): a project's `.mcp.json`, read as data only. Nothing in it runs, nothing is expanded, and no
// secret value is taken: each server becomes a prefilled 添加 form that still takes this Mac's confirmation. Only this
// one file is read: `.cursor/mcp.json` and `.codex/config.toml` are those tools' own configuration.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  containsSecret,
  escapeSecurityText,
  isMcpHeaderName,
  isMcpServerName,
  type McpImportCandidate,
  type McpImportFile,
  type McpImportSkip,
} from '@latch/protocol'

export const MCP_IMPORT_FILE = '.mcp.json'
/** The largest `.mcp.json` read; a larger one is refused whole. */
export const MCP_IMPORT_MAX_BYTES = 64 * 1024
/** Servers offered from one file; the rest are counted as left out. */
const MAX_SERVERS = 32

/**
 * Nothing a security surface would have to escape (`escapeSecurityText`: controls, C1, bidi, line and paragraph
 * separators, invisible characters): an argument with a line break could not be edited as the form keeps it, and one
 * that turns text around would read differently in the list than it runs.
 */
const field = (max: number) =>
  z
    .string()
    .max(max)
    .refine(value => escapeSecurityText(value) === value)
/** Keys a parsed object would treat as its own machinery rather than as data. */
const OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
  .refine(name => !OBJECT_KEYS.has(name))
const stdioEntry = z.strictObject({
  type: z.literal('stdio').optional(),
  command: field(4096).pipe(z.string().min(1)),
  args: z.array(field(4096)).max(64).optional(),
  env: z
    .record(envName, field(16_384))
    .refine(env => Object.keys(env).length <= 32)
    .optional(),
})
const httpEntry = z.strictObject({
  type: z.enum(['http', 'streamable-http']).optional(),
  url: field(2048).pipe(z.string().min(1)),
  headers: z
    .record(
      z.string().refine(name => isMcpHeaderName(name) && !OBJECT_KEYS.has(name)),
      field(8192),
    )
    .refine(headers => Object.keys(headers).length <= 32)
    .optional(),
})
// The servers are read from the parsed JSON's own entries, never copied into a new object by key.
const file = z.strictObject({
  mcpServers: z.custom<Record<string, unknown>>(value => value !== null && typeof value === 'object' && !Array.isArray(value)),
})

/** A variable's name that says it holds a credential: its value is not taken even when it looks plain. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|PWD|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|CERT/iu
/**
 * A plain-looking value that is likely a credential all the same: one long run of letters and digits with both, and no
 * path or address separator.
 */
const OPAQUE = /^(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{20,}$/u
/** An argument that names a credential (`--token`, `--api-key`): the one after it is its value. */
const SECRET_FLAG = /^--?[A-Za-z0-9_-]*(?:key|token|secret|pass|pwd|auth|credential|cookie|session|private)[A-Za-z0-9_-]*$/iu

/** A value that looks like a credential by its shape (a known key's prefix, a long opaque run). */
const secretShaped = (text: string) => containsSecret(text) || OPAQUE.test(text)

/**
 * The arguments with every credential-looking value blanked: a whole argument, the part after `=` of `--x=value`, or the
 * argument after one that names a credential. `${…}` is an expansion, not a value, and stays as written.
 */
function blankedArgs(args: readonly string[]): { args: string[]; blanked: boolean } {
  let blanked = false
  const out = args.map((arg, index) => {
    if (EXPANSION.test(arg)) return arg
    const eq = arg.indexOf('=')
    if (eq > 0) {
      const [name, value] = [arg.slice(0, eq), arg.slice(eq + 1)]
      if (value && !EXPANSION.test(value) && (secretShaped(value) || SECRET_FLAG.test(name))) {
        blanked = true
        return `${name}=`
      }
    }
    const before = args[index - 1]
    if (secretShaped(arg) || (before !== undefined && SECRET_FLAG.test(before) && eq < 0 && !arg.startsWith('-'))) {
      blanked = true
      return ''
    }
    return arg
  })
  return { args: out, blanked }
}

/**
 * The address without an account (`user:pass@`) and, when any of its query looks like a credential by name or value,
 * without its query; Latch keeps no query anyway. Text that is not an address stays as written.
 */
function blankedUrl(text: string): { url: string; blanked: boolean } {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { url: text, blanked: false }
  }
  const account = url.username !== '' || url.password !== ''
  const query = [...url.searchParams].some(([name, value]) => SECRET_NAME.test(name) || (value !== '' && secretShaped(value)))
  if (!account && !query) return { url: text, blanked: false }
  return { url: `${url.origin}${url.pathname}${query ? '' : url.search}`, blanked: true }
}

/** `${…}`, Claude Code's and Cursor's expansion; `${workspaceFolder}` is Latch's own in arguments. */
const EXPANSION = /\$\{/u
const OWN_EXPANSION = /\$\{workspaceFolder\}/gu

/** Whether an entry or any object in it has a key such as `__proto__` as its own, which a schema may pass over. */
function machineryKey(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object' || depth > 3) return false
  return Object.keys(value).some(key => OBJECT_KEYS.has(key) || machineryKey((value as Record<string, unknown>)[key], depth + 1))
}

/** Its key as shown: clipped, hidden and direction-changing characters written out. */
const shownKey = (key: string) => escapeSecurityText(key.length > 64 ? `${key.slice(0, 63)}…` : key)

/**
 * One entry as a candidate, or why it cannot be: `legacy-sse` for the old HTTP+SSE transport, `unsupported` for any
 * other kind, `invalid` for a shape `.mcp.json` does not have (an unknown field included).
 */
function candidate(key: string, value: unknown, taken: (name: string) => boolean): McpImportCandidate | McpImportSkip {
  const kind = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { type?: unknown }).type : undefined
  if (kind === 'sse') return 'legacy-sse'
  if (kind !== undefined && kind !== 'stdio' && kind !== 'http' && kind !== 'streamable-http') return 'unsupported'
  if (machineryKey(value)) return 'invalid'
  const name = isMcpServerName(key) && !taken(key) ? key : ''
  const flags = new Set<McpImportCandidate['flags'][number]>()
  const stdio = stdioEntry.safeParse(value)
  if (stdio.success) {
    const { command, env = {} } = stdio.data
    const blanked = blankedArgs(stdio.data.args ?? [])
    const args = blanked.args
    if (blanked.blanked) flags.add('secret')
    if (EXPANSION.test(command) || args.some(arg => EXPANSION.test(arg.replace(OWN_EXPANSION, '')))) flags.add('expansion')
    const variables = Object.entries(env).map(([variable, text]) => {
      if (EXPANSION.test(text)) {
        flags.add('expansion')
        return { name: variable, secret: true }
      }
      if (SECRET_NAME.test(variable) || secretShaped(text)) return { name: variable, secret: true }
      return { name: variable, secret: false, value: text }
    })
    return { key: shownKey(key), name, transport: 'stdio', command, args, env: variables, flags: [...flags] }
  }
  const http = httpEntry.safeParse(value)
  if (http.success) {
    const address = blankedUrl(http.data.url)
    if (address.blanked) flags.add('secret')
    if (EXPANSION.test(address.url)) flags.add('expansion')
    if (Object.values(http.data.headers ?? {}).some(text => EXPANSION.test(text))) flags.add('expansion')
    return {
      key: shownKey(key),
      name,
      transport: 'http',
      url: address.url,
      headers: Object.keys(http.data.headers ?? {}),
      flags: [...flags],
    }
  }
  return 'invalid'
}

/**
 * The servers of a `.mcp.json`'s text. `taken` names a server Latch already has, whose name is then left for the person
 * to type. The whole file is refused (`not-json`, `invalid`) when it is not JSON or not `{ "mcpServers": { … } }`.
 */
export function parseProjectMcp(
  text: string,
  taken: (name: string) => boolean = () => false,
): Pick<McpImportFile, 'status' | 'reason' | 'servers' | 'skipped' | 'truncated'> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { status: 'refused', reason: 'not-json', servers: [], skipped: [] }
  }
  // Every own key, `__proto__` among them, which a schema may pass over: the file has `mcpServers` and nothing else.
  const own = json !== null && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json) : []
  const parsed = file.safeParse(json)
  if (!parsed.success || own.length !== 1) return { status: 'refused', reason: 'invalid', servers: [], skipped: [] }
  const servers: McpImportCandidate[] = []
  const skipped: McpImportFile['skipped'] = []
  const entries = Object.entries(parsed.data.mcpServers).filter(([key]) => key.length <= 4096)
  for (const [key, value] of entries.slice(0, MAX_SERVERS)) {
    const result = candidate(key, value, taken)
    if (typeof result === 'string') skipped.push({ key: shownKey(key), reason: result })
    else servers.push(result)
  }
  return { status: 'ok', servers, skipped, ...(entries.length > MAX_SERVERS ? { truncated: true as const } : {}) }
}

/**
 * Reads `<folder>/.mcp.json` as data: a regular file reached without following a link (a link could name any file of
 * the person's, `~/.codex/config.toml` among them), at most 64 KiB, read through the one descriptor that was checked.
 */
export async function readProjectMcpText(
  folder: string,
): Promise<{ status: 'ok'; text: string } | { status: 'missing' } | { status: 'refused'; reason: 'not-file' | 'too-large' }> {
  let handle
  try {
    handle = await open(join(folder, MCP_IMPORT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' }
    return { status: 'refused', reason: 'not-file' }
  }
  try {
    const stat = await handle.stat()
    // A hard link is the same file under another name: it could be any file of the person's, as a symbolic link could.
    if (!stat.isFile() || stat.nlink !== 1) return { status: 'refused', reason: 'not-file' }
    if (stat.size > MCP_IMPORT_MAX_BYTES) return { status: 'refused', reason: 'too-large' }
    const buffer = Buffer.alloc(MCP_IMPORT_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    // It grew after the check.
    if (length > MCP_IMPORT_MAX_BYTES) return { status: 'refused', reason: 'too-large' }
    return { status: 'ok', text: buffer.subarray(0, length).toString('utf8') }
  } finally {
    await handle.close()
  }
}
