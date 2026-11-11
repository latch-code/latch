import type { HandoffList, HostFeatures } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { Handoffs } from '../handoffs.ts'
import { json, jsonBody, KIB } from '../http-util.ts'
import type { RouteContext, RouteModule } from './registry.ts'

export interface HandoffRouteDeps {
  handoffs: () => Handoffs
}

/** 64 KB of material and 8 KB of requirements, with room for JSON escapes. */
const HANDOFF_BODY_LIMIT = 256 * KIB
const WITHDRAW_BODY_LIMIT = 32 * KIB
const ROOT = '/link/api/handoffs'
const ONE = /^\/link\/api\/handoffs\/(hof_[a-f0-9-]{36})(?:\/(return|withdraw))?$/u

/** 交接: hand chosen material from one session to a code session, and its result back. */
export function createHandoffRoutes(context: RouteContext, deps: HandoffRouteDeps): RouteModule {
  return {
    features: () => ({ handoffs: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return false
      const service = deps.handoffs()
      if (path === ROOT) {
        if (method === 'GET') {
          context.requireScope(caller, 'view')
          const sessionId = new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('sessionId')
          if (!sessionId) throw new AppError(400, 'invalid-input', '请指定会话。')
          const list: HandoffList = { handoffs: await service.list(caller, sessionId) }
          json(res, list)
        } else if (method === 'POST') {
          context.requireScope(caller, 'run')
          const body = await jsonBody(req, HANDOFF_BODY_LIMIT)
          context.recheck(caller, 'run')
          const result = await service.create(caller, body, res)
          json(res, result.value, result.created ? 201 : 200)
        } else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      const match = ONE.exec(path)
      if (!match) throw new AppError(404, 'not-found', '接口不存在。')
      const id = match[1]!,
        action = match[2]
      if (method === 'GET' && !action) {
        context.requireScope(caller, 'view')
        json(res, await service.get(caller, id))
      } else if (method === 'POST' && action === 'return') {
        context.requireScope(caller, 'run')
        const body = await jsonBody(req, HANDOFF_BODY_LIMIT)
        context.recheck(caller, 'run')
        json(res, await service.returnResult(caller, id, body))
      } else if (method === 'POST' && action === 'withdraw') {
        context.requireScope(caller, 'run')
        const body = await jsonBody(req, WITHDRAW_BODY_LIMIT)
        context.recheck(caller, 'run')
        const result = await service.withdraw(caller, id, body)
        if (!result.audited) res.setHeader('x-latch-audit', 'failed')
        json(res, result.value)
      } else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
}
