/**
 * Whether a harness is logged in, a way to log in, and a way to log out. The Host only runs the program's own commands
 * and asks the harness itself: it never logs in for a person, and it reads nothing of the program's credentials. A status
 * check and a logout are what any device with `run` may ask for; the terminal opens on this computer alone, since that is
 * where the person is who would type into it.
 */
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  isLocalListener,
  settleLogin,
  type AgentRecord,
  type HarnessLogin,
  type HarnessLoginCheck,
  type HarnessLoginStatus,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { checkLogin, loginCheckAddsDate, loginTerminalScript } from '@latch/harness-acp'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type Caller, type RouteContext, type RouteModule } from './registry.ts'

export interface AgentLoginDeps {
  /** A saved definition, or a preset this device may save one from. */
  record: (id: string, caller: Caller) => AgentRecord | undefined
  /** What a running harness says about logging in; see `HarnessLogin.reported`. */
  login: (id: string) => HarnessLogin | undefined
  /** Asks a running harness to log out. */
  logout: (id: string) => Promise<void>
  /** Tests: hands over the script instead of opening a terminal. Production never sets it. */
  openTerminal?: (script: string) => Promise<void>
}

const STATUS_TTL_MS = 30_000
/** Each check runs a program and adds audit lines, so even `fresh` does not run back to back. */
const FRESH_FLOOR_MS = 2_000
const PATH = /^\/link\/api\/harnesses\/([^/]+)\/(login-status|login-terminal|logout)$/u
const statusBody = z.strictObject({ fresh: z.boolean().optional() })
const terminalBody = z.strictObject({ method: z.string().min(1).max(128).optional() })
const run = promisify(execFile)

/** The person's default handler for `.command` files, Terminal unless they chose another. The script removes itself. */
async function openInSystemTerminal(script: string): Promise<void> {
  const file = join(tmpdir(), `latch-login-${randomBytes(8).toString('hex')}.command`)
  await writeFile(file, script, { mode: 0o700, flag: 'wx' })
  try {
    await run('/usr/bin/open', [file], { timeout: 10_000 })
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
}

export interface AgentLoginRoutes extends RouteModule {
  /** A test start ran the program and read its login; a remembered answer that differs, or one still being read, is older. */
  probed(id: string, status: HarnessLoginStatus): void
}

export function createAgentLoginRoutes(context: RouteContext, deps: AgentLoginDeps): AgentLoginRoutes {
  /** `pushed`: what a running process had pushed when the program ran, so a later push is told from an older one. */
  type Known = { at: number; check: HarnessLoginCheck; pushed: HarnessLogin['reported'] }
  const known = new Map<string, Known>()
  const running = new Map<string, Promise<Known>>()
  /** A check already running when this is called finishes for whoever waits on it, but is not remembered. */
  const forget = (id: string) => {
    known.delete(id)
    running.delete(id)
  }
  const stopping = new AbortController()
  context.lifecycle.on('hostStopping', () => {
    stopping.abort()
  })
  const opensHere = deps.openTerminal !== undefined || process.platform === 'darwin'
  return {
    probed(id, status) {
      if (status === 'unknown') return
      if (running.has(id) || (known.get(id)?.check.status ?? status) !== status) forget(id)
    },
    features: (caller: Caller) =>
      opensHere && isLocalListener(caller.connection.listener) && caller.device?.scopes.includes('run') ? { loginTerminal: true } : {},
    async route({ req, res, caller, path, method }) {
      const match = PATH.exec(path)
      if (!match) return false
      if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
      const id = safeDecode(match[1]!)
      if (match[2] === 'logout') {
        context.requireScope(caller, 'run')
        await jsonBody(req, CONFIG_BODY_LIMIT).then(body => z.strictObject({}).parse(body))
        if (!deps.login(id)?.logout) throw new AppError(409, 'logout-unsupported', '这个 Harness 不能从 Latch 退出登录。')
        // Recorded before the harness is asked: when the audit cannot be written, it is not.
        await context.audit.append({
          action: 'agent.logout',
          actor: context.actorOf(caller),
          target: id,
          stepup: 'none',
          detail: { agentId: id },
        })
        context.recheck(caller, 'run')
        try {
          await deps.logout(id)
        } finally {
          forget(id)
        }
        json(res, { loggedOut: true })
        return true
      }
      if (match[2] === 'login-terminal') {
        context.requireLocal(caller)
        context.requireScope(caller, 'run')
        const { method } = terminalBody.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        const record = deps.record(id, caller)
        const script = record && loginTerminalScript(record, method)
        if (!script) throw new AppError(404, 'harness-no-login', 'Latch 不知道这个 Harness 的登录命令。')
        await context.audit.append({
          action: 'agent.login.opened',
          actor: context.actorOf(caller),
          target: id,
          stepup: 'none',
          detail: { agentId: id, ...(method !== undefined ? { source: 'harness' as const } : {}) },
        })
        context.recheck(caller, 'run')
        await (deps.openTerminal ?? openInSystemTerminal)(script).catch((error: unknown) => {
          context.log(`打开终端失败：${error instanceof Error ? error.message : String(error)}`)
          throw new AppError(502, 'terminal-open-failed', '没有打开终端。请自己在终端里运行这条命令。')
        })
        // What was known before is what the person is now changing.
        forget(id)
        json(res, { opened: true })
        return true
      }
      context.requireScope(caller, 'run')
      const { fresh } = statusBody.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
      const record = deps.record(id, caller)
      if (!record) throw new AppError(404, 'harness-not-found', '找不到这个 Harness。')
      // A running harness's own report is current, and nothing runs for it, unless the program says what the report does
      // not; then the newer of the two decides.
      const reported = deps.login(id)?.reported
      if (reported && !loginCheckAddsDate(record)) {
        json(res, reported)
        return true
      }
      const answer = ({ check, pushed }: Known) => settleLogin(check, pushed, deps.login(id)?.reported)
      const cached = known.get(id)
      if (cached && context.now() - cached.at < (fresh ? FRESH_FLOOR_MS : STATUS_TTL_MS)) {
        json(res, answer(cached))
        return true
      }
      let flight = running.get(id)
      if (!flight) {
        const actor = context.actorOf(caller)
        // Recorded before the program runs: when the audit cannot be written, it does not run.
        flight = context.audit
          .append({ action: 'agent.login.requested', actor, target: id, stepup: 'none', detail: { agentId: id } })
          .then(() => checkLogin(record, { signal: stopping.signal }))
          .then(async check => {
            await context.audit.append({
              action: 'agent.login.checked',
              actor,
              target: id,
              stepup: 'none',
              detail: { agentId: id, status: check.status },
            })
            const entry = { at: context.now(), check, pushed: reported }
            if (running.get(id) === flight) known.set(id, entry)
            return entry
          })
          .finally(() => {
            if (running.get(id) === flight) running.delete(id)
          })
        running.set(id, flight)
      }
      const entry = await flight
      context.recheck(caller, 'run')
      json(res, answer(entry))
      return true
    },
  }
}
