import { z } from 'zod'
import type { CustomizationReceipt, CustomizationState, HostFeatures } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { CustomizationChange, CustomizationStore } from '../customization.ts'
import { json, jsonBody } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type Caller, type CallerRequest, type RouteContext, type RouteModule } from './registry.ts'

export interface CustomizationRouteDeps {
  store: () => CustomizationStore
  auditFailed: (seq: number | undefined, caller: Caller) => void
}
export interface CustomizationRoutes extends RouteModule {
  /** What the snapshot carries. */
  state(): CustomizationState
}

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const revision = z.number().int().min(0)
/** The document is checked by the store (`checkedDocument`), which names the field and the numbers of a refusal. */
const applyBody = z.strictObject({ requestId, baseRevision: revision, doc: z.unknown() })
const restoreBody = z.strictObject({ requestId, baseRevision: revision, revision: z.number().int().min(1) })
const resetBody = z.strictObject({ requestId, baseRevision: revision })

/**
 * 自定义. Any device that may read the snapshot reads the document; a device with 管理此 Host applies, restores and
 * resets it. Applying is validated data, so it asks for no local confirmation: it is recorded (`customization.applied`)
 * and every device is told to read the snapshot again. There is no route for a session or a plugin page to apply one.
 */
export function createCustomizationRoutes(context: RouteContext, deps: CustomizationRouteDeps): CustomizationRoutes {
  async function write(
    { res, caller }: CallerRequest,
    input: { requestId: string; baseRevision: number },
    change: CustomizationChange,
  ): Promise<void> {
    const scope = caller.device ? 'admin' : undefined
    const authorize = () => {
      if (scope) context.recheck(caller, scope)
      else context.requireLocal(caller)
    }
    authorize()
    const reducing = change.kind === 'reset'
    // Changes are counted per device like other settings; a reset is the way out and is never turned away for its rate.
    if (caller.device && !reducing) context.limits.classC.take(caller.device.id)
    const receipt: CustomizationReceipt = await context.serial(caller, scope, async () => {
      const store = deps.store()
      const previous = store.state().revision
      let auditSeq: number | undefined
      try {
        return await store.write(
          { actor: caller.device?.id ?? 'cli', by: caller.device ? 'device' : 'cli', ...input, change },
          async pending => {
            auditSeq = await context.audited(
              {
                action: 'customization.applied',
                actor: context.actorOf(caller),
                target: String(pending.revision),
                detail: {
                  revision: pending.revision,
                  previous: pending.previous,
                  hash: pending.hash,
                  source: pending.source,
                  fields: pending.fields,
                },
              },
              reducing ? res : undefined,
            )
          },
          authorize,
        )
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'customization-write-unknown')) deps.auditFailed(auditSeq, caller)
        throw error
      } finally {
        if (store.state().revision !== previous) context.refresh()
      }
    })
    json(res, receipt)
  }

  return {
    state: () => deps.store().state(),
    features: () => ({ customization: true }) satisfies HostFeatures,
    async route(request) {
      const { req, res, caller, path, method } = request
      if (path !== '/link/api/customization' && !path.startsWith('/link/api/customization/')) return false
      if (path === '/link/api/customization' && method === 'GET') {
        if (caller.device) context.requireScope(caller, 'view')
        else context.requireLocal(caller)
        json(res, deps.store().view())
        return true
      }
      if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
      const body = await jsonBody(req, CONFIG_BODY_LIMIT)
      if (path === '/link/api/customization') {
        const input = applyBody.parse(body)
        await write(request, { requestId: input.requestId, baseRevision: input.baseRevision }, { kind: 'apply', doc: input.doc as never })
      } else if (path === '/link/api/customization/restore') {
        const input = restoreBody.parse(body)
        await write(
          request,
          { requestId: input.requestId, baseRevision: input.baseRevision },
          { kind: 'restore', revision: input.revision },
        )
      } else if (path === '/link/api/customization/reset') {
        const input = resetBody.parse(body)
        await write(request, input, { kind: 'reset' })
      } else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
}
