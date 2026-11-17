import { z } from 'zod'
import type { HostFeatures } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { ShortcutsChange, ShortcutsStore } from '../shortcuts.ts'
import { json, jsonBody } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type RouteContext, type RouteModule } from './registry.ts'

export interface ShortcutRouteDeps {
  store: () => ShortcutsStore
}

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const revision = z.number().int().min(0)
/** The document is checked by the store (`checkedShortcuts`), which names the action and the reason of a refusal. */
const applyBody = z.strictObject({ requestId, baseRevision: revision, doc: z.unknown() })
const resetBody = z.strictObject({ requestId, baseRevision: revision })

/**
 * 快捷键. Every device reads and writes its own bindings and no other device's: the device comes from the credential,
 * never from the request. Bindings change only which keys this device's own page answers to, so a write asks for no
 * confirmation and is not audited; every write, the reset included, is rate-limited like other settings.
 */
export function createShortcutRoutes(context: RouteContext, deps: ShortcutRouteDeps): RouteModule {
  return {
    features: () => ({ shortcuts: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (path !== '/link/api/shortcuts' && path !== '/link/api/shortcuts/reset') return false
      context.requireScope(caller, 'view')
      const deviceId = caller.device.id
      if (path === '/link/api/shortcuts' && method === 'GET') {
        json(res, deps.store().state(deviceId))
        return true
      }
      if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
      const body = await jsonBody(req, CONFIG_BODY_LIMIT)
      const authorize = () => context.recheck(caller, 'view')
      authorize()
      let input: { requestId: string; baseRevision: number }
      let change: ShortcutsChange
      if (path === '/link/api/shortcuts') {
        const parsed = applyBody.parse(body)
        input = parsed
        change = { kind: 'apply', doc: parsed.doc }
        context.limits.classC.take(deviceId)
      } else {
        input = resetBody.parse(body)
        change = { kind: 'reset' }
        // The way out is counted too, so a device cannot rewrite the file without end.
        context.limits.classC.take(deviceId)
      }
      const receipt = await deps
        .store()
        .write({ deviceId, requestId: input.requestId, baseRevision: input.baseRevision, change }, authorize)
      json(res, receipt)
      return true
    },
  }
}
