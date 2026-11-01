import { z } from 'zod'
import type { AutomationList, HostFeatures } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { Automations } from '../automations.ts'
import type { AgentActor } from '../custom-agents.ts'
import { json, jsonBody } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type Caller, type RouteContext, type RouteModule } from './registry.ts'

export interface AutomationRouteDeps {
  automations: () => Automations
  access: (caller: Caller, write?: boolean) => AgentActor
}

const deletion = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u) })
const AUTOMATION = /^\/link\/api\/automations\/(auto_[a-f0-9-]{36})(?:\/(enabled|run))?$/u

/** 自动化. Any device that may read agents may read these, and may change them as far as its own start limits reach. */
export function createAutomationRoutes(_context: RouteContext, deps: AutomationRouteDeps): RouteModule {
  return {
    features: () => ({ automations: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (path !== '/link/api/automations' && !path.startsWith('/link/api/automations/')) return false
      const actor = deps.access(caller, method !== 'GET'),
        service = deps.automations()
      const reply = <T>(result: { value: T; audited: boolean }, code = 200) => {
        actor.authorize()
        if (!result.audited) res.setHeader('x-latch-audit', 'failed')
        json(res, result.value, code)
      }
      if (method === 'GET') await service.recover().catch(() => {})
      if (path === '/link/api/automations') {
        if (method === 'GET') {
          const list: AutomationList = { automations: service.list() }
          json(res, list)
        } else if (method === 'POST')
          reply(await service.create((await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<Automations['create']>[0], actor), 201)
        else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      const match = AUTOMATION.exec(path)
      if (!match) throw new AppError(404, 'not-found', '接口不存在。')
      const id = match[1]!,
        action = match[2]
      if (method === 'GET' && !action) json(res, service.detail(id))
      else if (method === 'PATCH' && !action)
        reply(await service.patch(id, (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<Automations['patch']>[1], actor))
      else if (method === 'DELETE' && !action) {
        const result = await service.remove(id, deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT)).requestId, actor)
        reply({ value: { id }, audited: result.audited })
      } else if (method === 'POST' && action === 'enabled')
        reply(await service.setEnabled(id, (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<Automations['setEnabled']>[1], actor))
      else if (method === 'POST' && action === 'run')
        reply(await service.runNow(id, (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<Automations['runNow']>[1], actor), 202)
      else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
}
