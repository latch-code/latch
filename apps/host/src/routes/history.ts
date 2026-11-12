import type { HostFeatures } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { HistoryImports } from '../history-import.ts'
import { json, jsonBody, KIB } from '../http-util.ts'
import type { RouteContext, RouteModule } from './registry.ts'

export interface HistoryRouteDeps {
  history: () => HistoryImports
}

const BODY_LIMIT = 32 * KIB
const ROOT = '/link/api/history'
const PREVIEW = /^\/link\/api\/history\/previews\/(hp_[a-f0-9]{32})$/u
const IMPORT = /^\/link\/api\/history\/imports\/([A-Za-z0-9_-]{8,128})$/u

/** 接入已有会话 (docs/HARNESSES.md#接入已有会话): list, preview and import a harness's own earlier sessions. */
export function createHistoryRoutes(context: RouteContext, deps: HistoryRouteDeps): RouteModule {
  return {
    features(caller) {
      // Only a device that may see private sessions is offered what makes one.
      const device = caller.device && context.devices.get(caller.device.id)
      return (device?.dataScope === 'all' && device.scopes.includes('run') ? { historyImport: 1 } : {}) satisfies HostFeatures
    },
    async route({ req, res, caller, path, method }) {
      if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return false
      const history = deps.history()
      context.requireScope(caller, 'run')
      if (path === `${ROOT}/sources` && method === 'GET') {
        const projectId = new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('projectId')
        json(res, history.listSources(caller, projectId))
      } else if (path === `${ROOT}/list` && method === 'POST') {
        const body = await jsonBody(req, BODY_LIMIT)
        json(res, await history.list(caller, body))
      } else if (path === `${ROOT}/previews` && method === 'POST') {
        const body = await jsonBody(req, BODY_LIMIT)
        json(res, await history.preview(caller, body), 201)
      } else if (PREVIEW.test(path) && method === 'DELETE') {
        await history.closePreviewOf(caller, PREVIEW.exec(path)![1]!)
        res.writeHead(204).end()
      } else if (path === `${ROOT}/imports` && method === 'POST') {
        const body = await jsonBody(req, BODY_LIMIT)
        json(res, await history.import(caller, body, res), 201)
      } else if (IMPORT.test(path) && method === 'GET') {
        const answer = await history.receipt(caller, IMPORT.exec(path)![1]!)
        json(res, answer, 'state' in answer ? 202 : 200)
      } else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
}
