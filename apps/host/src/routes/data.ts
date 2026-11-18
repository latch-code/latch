import { z } from 'zod'
import type { HostFeatures, LeftoverAgentFolder } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { auditPage, parseAuditQuery, type AuditNames } from '../audit-view.ts'
import type { DataExports } from '../data-export.ts'
import type { AgentFolders, FolderAudit } from '../agent-folders.ts'
import type { DataInventoryService } from '../data-inventory.ts'
import { json, jsonBody } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type Caller, type DeviceCaller, type RouteContext, type RouteModule } from './registry.ts'

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
  /** Homes of Agents already deleted: listed, exported or removed only when the person presses. */
  agentFolders: AgentFolders
  /** The Agents there are now; throws while a write to them is unconfirmed, so nothing is taken for gone. */
  agentIds: () => ReadonlySet<string>
}

const exportSchema = z.strictObject({ nonce: z.string(), via: z.literal('export'), parent: z.string().min(1).max(4096) })
const EXPORT_PATH = /^\/link\/api\/data\/export\/([0-9a-f-]{36})(\/cancel)?$/u
const LEFTOVER = /^\/link\/api\/data\/agent-folders\/([0-9a-f]{32})(\/export)?$/u
/** What the row showed: removed only if the folder still holds exactly that. */
const leftoverRemoval = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  entries: z.number().int().nonnegative().max(1_000_000_000),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const leftoverExport = z.strictObject({
  nonce: z.string(),
  via: z.literal('agent-folder'),
  folder: z.string().regex(/^[0-9a-f]{32}$/u),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  parent: z.string().min(1).max(4096),
})

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
      if (path === '/link/api/data/agent-folders' && method === 'GET') {
        const device = allowed(caller)
        // Each home is located and counted by the helper: counted like a settings write.
        context.limits.classC.take(device.device.id)
        const folders: LeftoverAgentFolder[] = (await deps.agentFolders.leftovers(deps.agentIds)).map(
          ({ key, path: where, contents, entries, bytes }) => ({
            key,
            path: where,
            contents,
            ...(entries === undefined ? {} : { entries, bytes }),
          }),
        )
        recheck(caller)
        json(res, { folders })
        return true
      }
      const leftover = LEFTOVER.exec(path)
      if (leftover && ((method === 'DELETE' && !leftover[2]) || (method === 'POST' && leftover[2]))) {
        const device = allowed(caller)
        context.limits.classC.take(device.device.id)
        const key = leftover[1]!
        const audit: FolderAudit = event =>
          context.audited({ ...event, actor: context.actorOf(caller), target: event.detail.customAgentId }).then(() => {})
        if (method === 'DELETE') {
          const { entries, bytes } = leftoverRemoval.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          const result = await deps.agentFolders.removeLeftover(key, { entries, bytes }, deps.agentIds, audit)
          recheck(caller)
          json(res, { folder: result })
          return true
        }
        deps.requireDesktop(device)
        const input = leftoverExport.parse(await deps.signedBody(req, device))
        if (input.folder !== key) throw new AppError(400, 'invalid-request', '请求与文件夹不一致。')
        recheck(caller)
        const state = await deps.agentFolders.startExport({
          deviceId: device.device.id,
          requestId: input.requestId,
          target: { key, agents: deps.agentIds },
          label: 'Agent',
          parent: input.parent,
          audit,
          recheck: () => recheck(caller),
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
