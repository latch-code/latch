import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  PluginExternalFind,
  PluginExternalPreview,
  PluginExternalRelease,
  PluginExternalStage,
  PluginPackageReview,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson } from '@latch/core/node-kit'
import { json, jsonBody } from './http-util.ts'
import {
  describePluginAsset,
  installIdOf,
  type PluginAssetActor,
  type PluginAssetMutation,
  type PluginAssetRecord,
  type PluginAssets,
} from './plugin-assets.ts'
import {
  externalFindSchema,
  externalOriginSchema,
  externalPreviewSchema,
  externalSourceIdentity,
  externalStagePayload,
  externalStageSchema,
  externalUpdate,
  externalUpdateError,
} from './plugin-external-source.ts'
import { findExternalPluginSource, listExternalPlugins, readExternalPlugin, refreshExternalPluginSource } from './plugin-external-reader.ts'

type ReadOptions = Omit<Parameters<typeof findExternalPluginSource>[1], 'check'>
type Checked = Awaited<ReturnType<typeof readExternalPlugin>>
type Issued =
  | { kind: 'find'; result: Omit<PluginExternalFind, 'token'>; forInstall?: { id: string; installId: string; baseRevision: string } }
  | { kind: 'preview'; release: PluginExternalRelease; id: string; revision: string; update: PluginExternalStage['update'] }

interface Options {
  assets: PluginAssets
  reader: ReadOptions
  serial: <T>(actor: PluginAssetActor, operation: () => Promise<T>) => Promise<T>
  namespace: (id: string) => void
  review: (
    checked: Checked,
    source: { kind: 'external' } & PluginExternalRelease,
    installed?: PluginAssetRecord,
  ) => Promise<PluginPackageReview>
}

const freshUntil = 15 * 60 * 1000
const maxChoices = 128
const changed = () => new AppError(409, 'plugin-package-changed', '插件来源的内容或安装记录已变化，请重新预览。')
const previewExpired = () => new AppError(409, 'plugin-external-preview-expired', '来源预览已过期，请重新选择插件。')

export function externalPluginRoutes({ assets, reader, serial, namespace, review }: Options) {
  const choices = new Map<string, { expires: number; device: string; issued: Issued }>()
  const staging = new Map<string, { payload: string; result: Promise<PluginAssetMutation> }>()
  function issue(actor: PluginAssetActor, issued: Issued): string {
    const now = performance.now()
    for (const [token, choice] of choices) {
      if (choice.expires > now && choices.size < maxChoices) break
      choices.delete(token)
    }
    const token = randomBytes(24).toString('base64url')
    choices.set(token, { expires: now + freshUntil, device: actor.actor.deviceId, issued })
    return token
  }
  function choiceFor(actor: PluginAssetActor, token: string): Issued | undefined {
    const choice = choices.get(token)
    if (!choice || choice.expires <= performance.now() || choice.device !== actor.actor.deviceId) return undefined
    return choice.issued
  }

  async function stageOnce(actor: PluginAssetActor, stage: PluginExternalStage): Promise<PluginAssetMutation> {
    const replay = () => assets.replayExternal(stage, actor)
    const previous = await serial(actor, replay)
    if (previous) return previous
    const target = choiceFor(actor, stage.token)
    if (target?.kind !== 'preview') throw previewExpired()
    if (
      stage.revision !== target.revision
      || stage.update?.installId !== target.update?.installId
      || stage.update?.baseRevision !== target.update?.baseRevision
    )
      throw changed()
    const candidate = await readExternalPlugin(target.release.source, target.release.path, { ...reader, check: () => actor.authorize() })
    if (candidate.revision !== target.revision || candidate.bundle.manifest.id !== target.id) throw changed()
    return serial(actor, async () => {
      const completed = await replay()
      if (completed) return completed
      actor.authorize()
      namespace(target.id)
      return assets.stageExternal(stage, target.release, candidate, actor)
    })
  }

  function stageOrJoin(actor: PluginAssetActor, stage: PluginExternalStage): Promise<PluginAssetMutation> {
    const key = JSON.stringify([actor.actor.deviceId, stage.requestId])
    const payload = canonicalJson(externalStagePayload(stage))
    const running = staging.get(key)
    if (running) {
      if (running.payload !== payload) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
      return running.result
    }
    const result = stageOnce(actor, stage).finally(() => staging.delete(key))
    staging.set(key, { payload, result })
    return result
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    actor: PluginAssetActor,
    routePath: string,
    method: string,
    reply: (result: PluginAssetMutation, status: number) => Promise<void>,
  ): Promise<boolean> {
    const route = /^\/link\/api\/plugin-packages\/external\/(find|preview|stage)$/u.exec(routePath)
    if (!route) return false
    if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
    const read = { ...reader, check: () => actor.authorize() }
    const input = await jsonBody(req)
    actor.authorize()
    if (route[1] === 'find') {
      const selector = externalFindSchema.parse(input)
      let result: Omit<PluginExternalFind, 'token'>
      let forInstall: Extract<Issued, { kind: 'find' }>['forInstall']
      if ('input' in selector) result = await findExternalPluginSource(selector.input, read)
      else {
        const record = assets.get(selector.pluginId)
        const origin = record.external
        if (!origin) throw externalUpdateError('different-source')
        const source = await refreshExternalPluginSource(origin.source, read)
        if (externalSourceIdentity({ source, pluginId: record.id }) !== externalSourceIdentity(origin))
          throw externalUpdateError('different-source')
        const packages = (await listExternalPlugins(source, read)).filter(entry => entry.id === record.id)
        if (!packages.length) throw externalUpdateError('different-source')
        forInstall = { id: record.id, installId: installIdOf(record), baseRevision: record.revision }
        result = { source, packages }
      }
      actor.authorize()
      const token = issue(actor, { kind: 'find', result, ...(forInstall ? { forInstall } : {}) })
      json(res, { ...result, token } satisfies PluginExternalFind)
      return true
    }
    if (route[1] === 'preview') {
      const { token, path } = externalPreviewSchema.parse(input)
      const choice = choiceFor(actor, token)
      if (choice?.kind !== 'find') throw previewExpired()
      const { source, packages } = choice.result
      const entry = packages.find(candidate => candidate.path === path)
      if (!entry) throw new AppError(404, 'plugin-external-entry-not-found', '这个来源中没有选中的插件。')
      const checked = await readExternalPlugin(source, path, read)
      const { bundle, revision } = checked
      const { id, version } = bundle.manifest
      if (id !== entry.id || version !== entry.version) throw changed()
      const origin = externalOriginSchema.parse({ source, pluginId: id, path, version, revision })
      const record = assets.has(id) ? assets.get(id) : undefined
      if (
        choice.forInstall
        && (!record
          || choice.forInstall.id !== id
          || choice.forInstall.installId !== installIdOf(record)
          || choice.forInstall.baseRevision !== record.revision
          || !record.external
          || externalSourceIdentity(record.external) !== externalSourceIdentity(origin))
      )
        throw changed()
      if (!record) namespace(id)
      const { revision: _, ...release } = origin
      const viewed = await review(checked, { kind: 'external', ...release }, record)
      const status = record ? externalUpdate(origin, describePluginAsset(record)) : undefined
      const update = record ? { installId: installIdOf(record), baseRevision: record.revision } : undefined
      actor.authorize()
      const stageToken = issue(actor, { kind: 'preview', release, id, revision, update })
      json(res, {
        token: stageToken,
        source,
        entry,
        revision,
        bundle,
        review: viewed,
        ...(record && update
          ? {
              installed: {
                id,
                installId: update.installId,
                revision: record.revision,
                ...(record.external ? { version: record.external.version } : {}),
                modified: record.external?.revision !== record.revision,
              },
              updateAvailable: status === 'available',
              updateStatus: status,
            }
          : {}),
      } satisfies PluginExternalPreview)
      return true
    }

    let result: PluginAssetMutation
    try {
      result = await stageOrJoin(actor, externalStageSchema.parse(input))
    } finally {
      actor.authorize()
    }
    await reply(result, 201)
    return true
  }
}
