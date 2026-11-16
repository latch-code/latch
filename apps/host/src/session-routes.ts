import { USAGE_PERIODS, type DeviceScope, type SessionBatchResult, type TaskDetail, type TaskSummary } from '@latch/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { json, jsonBody } from './http-util.ts'
import { templateSchema, type PromptTemplateStore } from './prompt-templates.ts'
import { reportedUsage } from './usage.ts'
import { SessionSearch } from './search.ts'

const searchSchema = z.strictObject({ q: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(30).default(30) })
const batchSchema = z.strictObject({
  action: z.enum(['archive', 'unarchive', 'delete']),
  ids: z.array(z.string().min(1).max(256)).min(1).max(100),
})
interface Options<Caller> {
  visible?(caller: Caller, summary: TaskSummary): boolean
  checkRead?(caller: Caller, id: string, write?: boolean): Promise<unknown>
  now?: () => number
  templates: PromptTemplateStore
  changed(): void
  list(): Promise<TaskSummary[]>
  detail(id: string): Promise<TaskDetail>
  patch(id: string, patch: { archived: boolean }): Promise<unknown>
  remove(id: string): Promise<void>
  authorize(caller: Caller, scope: DeviceScope): void
  recheck(caller: Caller, scope: DeviceScope): void
  checkRemove(caller: Caller, id: string): Promise<unknown>
  /** Right before a session is archived or deleted; a rejection leaves it as it is. */
  checkEnd(caller: Caller, id: string): void
}

export function createSessionRoutes<Caller>(options: Options<Caller>) {
  const search = new SessionSearch({ list: options.list, detail: options.detail })
  let usageBusy = false
  let searchBusy = false
  return {
    async handle(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (path === '/link/api/usage' && method === 'POST') {
        options.authorize(caller, 'view')
        const input = z.strictObject({ period: z.enum(USAGE_PERIODS) }).parse(await jsonBody(req))
        options.recheck(caller, 'view')
        if (usageBusy) throw new AppError(429, 'rate-limited', '正在读取用量，请稍后再试。', { retryAfter: 1 })
        usageBusy = true
        try {
          const result = await reportedUsage(
            { ...options, list: async () => (await options.list()).filter(summary => options.visible?.(caller, summary) !== false) },
            input.period,
          )
          options.recheck(caller, 'view')
          json(res, result)
        } finally {
          usageBusy = false
        }
        return true
      }
      if (path === '/link/api/prompts' && method === 'GET') {
        options.authorize(caller, 'view')
        json(res, { templates: options.templates.list() })
        return true
      }
      const templateId = /^\/link\/api\/prompts\/([A-Za-z0-9_-]{1,64})$/u.exec(path)?.[1]
      if (templateId && (method === 'PUT' || method === 'DELETE')) {
        options.authorize(caller, 'admin')
        if (method === 'PUT') {
          const input = templateSchema.parse(await jsonBody(req))
          if (input.id !== templateId) throw new AppError(400, 'prompt-template-id', '模板标识与请求路径不一致。')
          await options.templates.put(input, () => options.recheck(caller, 'admin'))
        } else await options.templates.remove(templateId, () => options.recheck(caller, 'admin'))
        options.changed()
        json(res, { ok: true })
        return true
      }
      if (path === '/link/api/search' && method === 'POST') {
        options.authorize(caller, 'view')
        const input = searchSchema.parse(await jsonBody(req))
        options.recheck(caller, 'view')
        if (searchBusy) throw new AppError(429, 'rate-limited', '正在完成一次正文搜索，请稍后再试。', { retryAfter: 1 })
        searchBusy = true
        try {
          const result = await search.search(input.q, input.limit, summary => options.visible?.(caller, summary) !== false)
          options.recheck(caller, 'view')
          json(res, result)
        } finally {
          searchBusy = false
        }
        return true
      }
      if (path !== '/link/api/tasks/batch' || method !== 'POST') return false
      options.authorize(caller, 'run')
      const input = batchSchema.parse(await jsonBody(req))
      const results: SessionBatchResult['results'] = []
      for (const id of new Set(input.ids)) {
        try {
          options.recheck(caller, 'run')
          await options.checkRead?.(caller, id, true)
          options.recheck(caller, 'run')
          if (input.action === 'delete') {
            await options.checkRemove(caller, id)
            options.recheck(caller, 'run')
            options.checkEnd(caller, id)
            await options.remove(id)
          } else {
            if (input.action === 'archive') options.checkEnd(caller, id)
            await options.patch(id, { archived: input.action === 'archive' })
          }
          results.push({ id, ok: true })
        } catch (error) {
          results.push({
            id,
            ok: false,
            code: error instanceof AppError ? error.code : 'session-operation-failed',
            message: error instanceof AppError ? error.message : '这个会话暂时无法处理，请同步后重试。',
          })
        }
      }
      json(res, { results })
      return true
    },
  }
}
