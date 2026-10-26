import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { PersonalAssistant, PersonalAssistantSummary, PersonalOverview, TaskSummary } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { json, jsonBody } from './http-util.ts'
import { PersonalStore, type PersonalActor, type PersonalMutation } from './personal-store.ts'
import type { PersonalRoutines } from './personal-routines.ts'
import type { PersonalGroups } from './personal-groups.ts'

interface Options<Caller> {
  store: PersonalStore
  routines: PersonalRoutines
  groups: PersonalGroups
  turnActor(caller: Caller): PersonalActor
  cancelActor(caller: Caller): PersonalActor
  authorize(caller: Caller, write: boolean): PersonalActor
  summary(assistant: PersonalAssistant, tasks: TaskSummary[]): PersonalAssistantSummary
  sessions(): Promise<TaskSummary[]>
  plugins(): NonNullable<PersonalOverview['plugins']>
  changed(): void
}
const deletion = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u) })

/** All returned definitions and memories are private body, including overview metadata. */
export function createPersonalRoutes<Caller>(options: Options<Caller>) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (path !== '/link/api/personal' && !path.startsWith('/link/api/personal/')) return false
      const cancellation = /^\/link\/api\/personal\/groups\/(grp_[a-f0-9-]{36})\/cancel$/u.exec(path)
      if (cancellation && method === 'POST') {
        const actor = { ...options.cancelActor(caller), auditFailed: () => res.setHeader('x-latch-audit', 'failed') }
        json(res, await options.groups.cancel(cancellation[1]!, (await jsonBody(req)) as Parameters<PersonalGroups['cancel']>[1], actor))
        return true
      }
      const actor = { ...options.authorize(caller, method !== 'GET'), auditFailed: () => res.setHeader('x-latch-audit', 'failed') },
        store = options.store
      const reply = <T>(result: PersonalMutation<T>, code = 200) => {
        actor.authorize()
        if (!result.audited) res.setHeader('x-latch-audit', 'failed')
        options.changed()
        json(res, result.value, code)
      }
      if (path === '/link/api/personal' && method === 'GET') {
        const tasks = await options.sessions()
        actor.authorize()
        const overview: PersonalOverview = {
          plugins: options.plugins(),
          assistants: store.assistants().map(assistant => options.summary(assistant, tasks)),
          groups: options.groups.list(),
          routines: options.routines.list(),
        }
        json(res, overview)
        return true
      }
      if (path === '/link/api/personal/groups' && method === 'POST') {
        json(res, await options.groups.create((await jsonBody(req)) as Parameters<PersonalGroups['create']>[0], actor), 201)
        return true
      }
      const group = /^\/link\/api\/personal\/groups\/(grp_[a-f0-9-]{36})(\/messages)?$/u.exec(path)
      if (group) {
        const id = group[1]!,
          service = options.groups
        if (method === 'GET' && !group[2]) json(res, await service.detail(id, actor))
        else if (method === 'PATCH' && !group[2])
          json(res, await service.patch(id, (await jsonBody(req)) as Parameters<PersonalGroups['patch']>[1], actor))
        else if (method === 'DELETE' && !group[2]) json(res, await service.remove(id, deletion.parse(await jsonBody(req)).requestId, actor))
        else if (method === 'POST' && group[2])
          json(
            res,
            await service.submit(id, (await jsonBody(req)) as Parameters<PersonalGroups['submit']>[1], options.turnActor(caller)),
            202,
          )
        else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      if (path === '/link/api/personal/routines' && method === 'POST') {
        const result = await options.routines.create((await jsonBody(req)) as Parameters<PersonalRoutines['create']>[0], actor)
        actor.authorize()
        json(res, result, 201)
        return true
      }
      const routine = /^\/link\/api\/personal\/routines\/(routine_[a-f0-9-]{36})(\/enabled)?$/u.exec(path)
      if (routine) {
        const id = routine[1]!,
          service = options.routines
        if (method === 'GET' && !routine[2]) json(res, service.get(id))
        else if (method === 'PATCH' && !routine[2])
          json(res, await service.patch(id, (await jsonBody(req)) as Parameters<PersonalRoutines['patch']>[1], actor))
        else if (method === 'POST' && routine[2])
          json(res, await service.setEnabled(id, (await jsonBody(req)) as Parameters<PersonalRoutines['setEnabled']>[1], actor))
        else if (method === 'DELETE' && !routine[2])
          json(res, await service.remove(id, deletion.parse(await jsonBody(req)).requestId, actor))
        else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      if (path === '/link/api/personal/assistants' && method === 'POST') {
        reply(await store.createAssistant((await jsonBody(req)) as Parameters<PersonalStore['createAssistant']>[0], actor), 201)
        return true
      }
      const assistant = /^\/link\/api\/personal\/assistants\/(asst_[a-f0-9-]{36})(?:\/memories(?:\/(mem_[a-f0-9-]{36}))?)?$/u.exec(path)
      if (assistant) {
        const id = assistant[1]!,
          memoryId = assistant[2],
          memories = path.includes('/memories')
        if (method === 'GET' && !memories) {
          const tasks = await options.sessions()
          actor.authorize()
          json(res, {
            assistant: options.summary(store.assistant(id), tasks),
            memories: store.memories(id),
            sessions: tasks.filter(task => task.personal?.assistantId === id && !task.personal.groupId),
          })
        } else if (method === 'GET' && memories && !memoryId) json(res, { memories: store.memories(id) })
        else if (method === 'PATCH' && !memories)
          reply(await store.patchAssistant(id, (await jsonBody(req)) as Parameters<PersonalStore['patchAssistant']>[1], actor))
        else if (method === 'DELETE' && !memories)
          reply(await store.removeAssistant(id, deletion.parse(await jsonBody(req)).requestId, actor))
        else if (method === 'POST' && memories && !memoryId)
          reply(await store.createMemory(id, (await jsonBody(req)) as Parameters<PersonalStore['createMemory']>[1], actor), 201)
        else if (method === 'PATCH' && memoryId)
          reply(await store.patchMemory(id, memoryId, (await jsonBody(req)) as Parameters<PersonalStore['patchMemory']>[2], actor))
        else if (method === 'DELETE' && memoryId)
          reply(await store.removeMemory(id, memoryId, deletion.parse(await jsonBody(req)).requestId, actor))
        else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      throw new AppError(404, 'not-found', '接口不存在。')
    },
  }
}
