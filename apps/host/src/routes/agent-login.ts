/**
 * Whether a harness is logged in and a way to log in. The Host only runs the program's own commands: it never logs in for
 * a person, and it reads nothing of the program's credentials. A status check is an answer any device with `run` may
 * ask for; the terminal opens on this computer alone, since that is where the person is who would type into it.
 */
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { isLocalListener, type AgentRecord, type HarnessLoginStatus } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { checkLogin, loginTerminalScript } from '@latch/harness-acp'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type Caller, type RouteContext, type RouteModule } from './registry.ts'

export interface AgentLoginDeps {
  /** A saved definition, or a preset this device may save one from. */
  record: (id: string, caller: Caller) => AgentRecord | undefined
  /** Tests: hands over the script instead of opening a terminal. Production never sets it. */
  openTerminal?: (script: string) => Promise<void>
}

const STATUS_TTL_MS = 30_000
/** Each check runs a program and adds an audit line, so even `fresh` does not run back to back. */
const FRESH_FLOOR_MS = 2_000
const PATH = /^\/link\/api\/harnesses\/([^/]+)\/login-(status|terminal)$/u
const statusBody = z.strictObject({ fresh: z.boolean().optional() })
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

export function createAgentLoginRoutes(context: RouteContext, deps: AgentLoginDeps): RouteModule {
  const known = new Map<string, { at: number; status: HarnessLoginStatus }>()
  const running = new Map<string, Promise<HarnessLoginStatus>>()
  const stopping = new AbortController()
  context.lifecycle.on('hostStopping', () => {
    stopping.abort()
  })
  const opensHere = deps.openTerminal !== undefined || process.platform === 'darwin'
  return {
    features: (caller: Caller) =>
      opensHere && isLocalListener(caller.connection.listener) && caller.device?.scopes.includes('run') ? { loginTerminal: true } : {},
    async route({ req, res, caller, path, method }) {
      const match = PATH.exec(path)
      if (!match) return false
      if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
      const id = safeDecode(match[1]!)
      if (match[2] === 'terminal') {
        context.requireLocal(caller)
        context.requireScope(caller, 'run')
        const record = deps.record(id, caller)
        const script = record && loginTerminalScript(record)
        if (!script) throw new AppError(404, 'harness-no-login', 'Latch 不知道这个 Harness 的登录命令。')
        await context.audit.append({
          action: 'agent.login.opened',
          actor: context.actorOf(caller),
          target: id,
          stepup: 'none',
          detail: { agentId: id },
        })
        context.recheck(caller, 'run')
        await (deps.openTerminal ?? openInSystemTerminal)(script).catch((error: unknown) => {
          context.log(`打开终端失败：${error instanceof Error ? error.message : String(error)}`)
          throw new AppError(502, 'terminal-open-failed', '没有打开终端。请自己在终端里运行这条命令。')
        })
        // What was known before is what the person is now changing.
        known.delete(id)
        json(res, { opened: true })
        return true
      }
      context.requireScope(caller, 'run')
      const { fresh } = statusBody.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
      const record = deps.record(id, caller)
      if (!record) throw new AppError(404, 'harness-not-found', '找不到这个 Harness。')
      const cached = known.get(id)
      if (cached && context.now() - cached.at < (fresh ? FRESH_FLOOR_MS : STATUS_TTL_MS)) {
        json(res, { status: cached.status })
        return true
      }
      let flight = running.get(id)
      if (!flight) {
        flight = checkLogin(record, { signal: stopping.signal })
          .then(async status => {
            known.set(id, { at: context.now(), status })
            await context.audit.append({
              action: 'agent.login.checked',
              actor: context.actorOf(caller),
              target: id,
              stepup: 'none',
              detail: { agentId: id, status },
            })
            return status
          })
          .finally(() => running.delete(id))
        running.set(id, flight)
      }
      const status = await flight
      context.recheck(caller, 'run')
      json(res, { status })
      return true
    },
  }
}
