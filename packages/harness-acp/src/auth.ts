/**
 * What a harness says about logging in, read from its own handshake and pushes: the logins it runs in a terminal, whether
 * it logs out on request, and which kind of credential it uses now. None of it is a credential, and an account's email
 * or organization is never read.
 */
import { escapeSecurityText, isReservedAgentEnvName, type AgentRecord } from '@latch/protocol'
import { redactSecrets, sha256Hex } from '@latch/core/node-kit'
import { authStatusUpdate, type initializeResult } from './protocol.ts'
import type { LoginStatus } from './profiles/index.ts'
import type { z } from 'zod'

export const CURSOR_SDK_SIGN_IN =
  '请在 Cursor 网页的 API Keys 创建密钥，然后在 Host 电脑的这个 Harness 定义中填写 CURSOR_API_KEY。更换密钥也在这里操作。'

/** A login the harness runs as its own program in a terminal: the definition's command and arguments, then these. */
export interface TerminalLogin {
  id: string
  name: string
  description?: string
  args: string[]
  env: Record<string, string>
}

/** What the harness last pushed about its login. `label`: its own words for the kind of credential, such as a plan. */
export interface ReportedLogin {
  status: LoginStatus
  label?: string
}

const MAX_METHODS = 8
const MAX_ARGS = 16
const MAX_TEXT = 512
const MAX_ENV = 16
const LABEL_MAX = 80
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
/** Kinds the agent reports when it holds a credential; `none` is a known logout, anything else says nothing. */
const SIGNED_IN = new Set(['account', 'api_key', 'gateway', 'external'])

type AuthMethods = NonNullable<z.infer<typeof initializeResult>['authMethods']>

const shown = (text: string, max: number) => escapeSecurityText(text.trim()).slice(0, max)

/**
 * The advertised `terminal` logins Latch can run. A method is left out whole when anything in it is out of bounds, or
 * when its variables name one Latch sets or clears for every agent: the login runs as the sessions do, never with a
 * loader, a PATH or a home of the agent's choosing.
 */
export function terminalLogins(methods: AuthMethods | null | undefined): TerminalLogin[] {
  const logins: TerminalLogin[] = []
  const ids = new Set<string>()
  for (const method of methods ?? []) {
    if (method.type !== 'terminal' || logins.length >= MAX_METHODS) continue
    const id = method.id
    const args = method.args ?? []
    const env = Object.entries(method.env ?? {})
    if (!id || id.length > 128 || ids.has(id) || !method.name.trim()) continue
    if (args.length > MAX_ARGS || args.some(arg => arg.length > MAX_TEXT || arg.includes('\0'))) continue
    if (
      env.length > MAX_ENV
      || env.some(
        ([name, value]) => !ENV_NAME.test(name) || isReservedAgentEnvName(name) || value.length > MAX_TEXT || value.includes('\0'),
      )
    )
      continue
    ids.add(id)
    logins.push({
      id,
      name: shown(method.name, 200),
      ...(method.description?.trim() ? { description: shown(method.description, 500) } : {}),
      args: [...args],
      env: Object.fromEntries(env),
    })
  }
  return logins
}

/** Reads one `_auth/status_update`. Undefined: not one Latch can read, which says nothing about the login. */
export function reportedLogin(params: unknown): ReportedLogin | undefined {
  const parsed = authStatusUpdate.safeParse(params)
  if (!parsed.success) return undefined
  const { kind, label } = parsed.data.authStatus
  const status: LoginStatus = kind === 'none' ? 'unauthenticated' : SIGNED_IN.has(kind) ? 'authenticated' : 'unknown'
  // A label is a kind or a plan; one that names an account, or holds what looks like a key, is not shown at all.
  const text = status === 'authenticated' && label?.trim() && !label.includes('@') ? shown(redactSecrets(label), LABEL_MAX) : ''
  return { status, ...(text ? { label: text } : {}) }
}

/**
 * One definition's login facts on this Host, in memory only. Logins are kept with the program path that advertised them,
 * so a different program is never run with them; a report holds only while the process that pushed it runs, since a
 * process that is gone says nothing more.
 */
export class AuthFacts {
  private advertised?: { path: string; logins: TerminalLogin[]; logout: boolean }
  private readonly reports = new Map<object, ReportedLogin & { at: number }>()
  private clock = 0

  /** From a handshake of the program at `path`. */
  learn(path: string, logins: TerminalLogin[], logout: boolean): void {
    this.advertised = { path, logins, logout }
  }

  /** What was last advertised, by whichever program. */
  advertisement(): { path: string; logins: TerminalLogin[]; logout: boolean } | undefined {
    return this.advertised
  }

  /** The logins and logout last advertised, when the program at `path` advertised them. */
  advertisedBy(path: string | undefined): { logins: TerminalLogin[]; logout: boolean } | undefined {
    return path !== undefined && this.advertised?.path === path ? this.advertised : undefined
  }

  /** `source`: the process that pushed it. */
  report(source: object, login: ReportedLogin): void {
    this.reports.set(source, { ...login, at: ++this.clock })
  }

  /** The process went away; returns whether it had reported. */
  forget(source: object): boolean {
    return this.reports.delete(source)
  }

  forgetReports(): void {
    this.reports.clear()
  }

  /** The newest report of a process still running. */
  reported(): ReportedLogin | undefined {
    let latest: (ReportedLogin & { at: number }) | undefined
    for (const report of this.reports.values()) if (!latest || report.at > latest.at) latest = report
    return latest && { status: latest.status, ...(latest.label ? { label: latest.label } : {}) }
  }
}

const FACTS_MAX = 128
const facts = new Map<string, AuthFacts>()

/** Same definition, same facts: its id, command, arguments, variables and preset. */
const factsKey = (record: AgentRecord) =>
  sha256Hex(
    JSON.stringify([
      record.id,
      record.command,
      record.args,
      Object.entries(record.env).sort(),
      record.presetId ?? null,
      record.accountDirectory ?? null,
    ]),
  )

/** The facts of a definition; `create` only from a driver that runs it, so a lookup never adds one. */
export function authFacts(record: AgentRecord, create: true): AuthFacts
export function authFacts(record: AgentRecord, create?: false): AuthFacts | undefined
export function authFacts(record: AgentRecord, create = false): AuthFacts | undefined {
  const key = factsKey(record)
  const found = facts.get(key)
  if (found || !create) return found
  if (facts.size >= FACTS_MAX) facts.delete(facts.keys().next().value!)
  const made = new AuthFacts()
  facts.set(key, made)
  return made
}
