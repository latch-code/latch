import { z } from 'zod'
import type { HostFeatures } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { auditPage, parseAuditQuery, type AuditNames } from '../audit-view.ts'
import type { DataExports } from '../data-export.ts'
import type { DataInventoryService } from '../data-inventory.ts'
import { json } from '../http-util.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

export interface DataRouteDeps {
  inventory: DataInventoryService
  exports: DataExports
  names: () => Promise<AuditNames>
  /** The desktop app on this computer: a device enrolled on host.sock, calling over host.sock. */
  requireDesktop: (caller: DeviceCaller) => void
  /** A body only the desktop's main process can sign, after its native picker (`signedFolderBody` in server.ts). */
  signedBody: (req: Parameters<NonNullable<RouteModule['route']>>[0]['req'], caller: DeviceCaller) => Promise<Record<string, unknown>>
  /** The device's data scope as the Host holds it now. */
  dataScope: (deviceId: string) => string | undefined
}

const exportSchema = z.strictObject({ nonce: z.string(), via: z.literal('export'), parent: z.string().min(1).max(4096) })
const EXPORT_PATH = /^\/link\/api\/data\/export\/([0-9a-f-]{36})(\/cancel)?$/u

/**
 * 设置 › 数据 and 审计记录 (docs/ARCHITECTURE.md#数据保留与导出). All of it is administrative and spans every session,
 * Agent and device, private ones included, so only a device with `admin` and data scope `all` reads it; a narrower
 * device learns nothing from it, not even how much there is. 导出全部 is the desktop app's only: its folder comes from
 * main's native picker, signed like a folder add, so a page can never name where files are written.
 */
export function createDataRoutes(context: RouteContext, deps: DataRouteDeps): RouteModule {
  const allowed = (caller: Caller): DeviceCaller => {
    context.requireScope(caller, 'admin')
    if (deps.dataScope(caller.device.id) !== 'all')
      throw new AppError(403, 'agent-scope-required', '数据与审计记录含有私有会话的信息，请先在电脑上允许这台设备读取全部数据。')
    return caller
  }
  const recheck = (caller: Caller) => {
    context.recheck(caller, 'admin')
    if (caller.device && deps.dataScope(caller.device.id) !== 'all')
      throw new AppError(403, 'agent-scope-required', '设备的数据范围已改变，请重新同步。')
  }
  return {
    features: () => ({ data: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (path === '/link/api/data' && method === 'GET') {
        allowed(caller)
        json(res, deps.inventory.view())
        return true
      }
      if (path === '/link/api/data/sizes' && method === 'POST') {
        const device = allowed(caller)
        context.limits.classC.take(device.device.id)
        const view = await deps.inventory.count()
        recheck(caller)
        json(res, view)
        return true
      }
      if (path === '/link/api/audit/records' && method === 'GET') {
        const device = allowed(caller)
        // Each page reads up to a few thousand records from the file: counted like a settings write.
        context.limits.classC.take(device.device.id)
        const query = parseAuditQuery(new URL(req.url ?? '/', 'http://latch.invalid').searchParams)
        const page = await auditPage(context.audit, query, await deps.names())
        recheck(caller)
        json(res, page)
        return true
      }
      if (path === '/link/api/data/export' && method === 'POST') {
        const device = allowed(caller)
        deps.requireDesktop(device)
        const input = exportSchema.parse(await deps.signedBody(req, device))
        recheck(caller)
        const state = await deps.exports.start({
          deviceId: device.device.id,
          parent: input.parent,
          hooks: {
            audit: async detail => {
              recheck(caller)
              await context.audited({ action: 'data.exported', actor: context.actorOf(caller), detail })
            },
            result: async detail => {
              await context.audited({ action: 'data.export.result', actor: context.actorOf(caller), detail })
            },
            recheck: () => recheck(caller),
          },
        })
        json(res, { export: state }, 202)
        return true
      }
      const match = EXPORT_PATH.exec(path)
      if (match && ((method === 'GET' && !match[2]) || (method === 'POST' && match[2]))) {
        const device = allowed(caller)
        deps.requireDesktop(device)
        const id = match[1]!
        json(res, { export: match[2] ? await deps.exports.cancel(device.device.id, id) : deps.exports.get(device.device.id, id) })
        return true
      }
      return false
    },
  }
}
