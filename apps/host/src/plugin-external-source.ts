import { isAbsolute, normalize } from 'node:path'
import type { PluginCatalogUpdateStatus, PluginExternalRelease, PluginExternalStage } from '@latch/protocol'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { z } from 'zod'
import { compareReleaseVersions, releaseVersionSchema } from './npm-source.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const safeText = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value) && redactKnownSecrets(value) === value
const localPath = z
  .string()
  .max(4096)
  .refine(value => safeText(value) && isAbsolute(value) && normalize(value) === value)
const pathSchema = z
  .string()
  .max(256)
  .refine(
    value =>
      safeText(value) && !value.includes('\\') && (value === '' || value.split('/').every(part => part && part !== '.' && part !== '..')),
  )
const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('github'),
    repository: z
      .string()
      .max(256)
      .regex(/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/u)
      .refine(safeText),
    ref: z.string().min(1).max(256).refine(safeText),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
  z.strictObject({ kind: z.literal('local-folder'), directory: localPath }),
  z.strictObject({ kind: z.literal('local-bundle'), file: localPath }),
])
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const release = z.strictObject({ source: sourceSchema, pluginId: id, path: pathSchema, version: releaseVersionSchema })
export const externalOriginSchema = release.extend({ revision: hash })
export const externalReviewSourceSchema = release.extend({ kind: z.literal('external'), modified: z.literal(true).optional() })

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/u)
export const externalFindSchema = z.union([z.strictObject({ input: z.string().trim().min(1).max(4096) }), z.strictObject({ pluginId: id })])
export const externalPreviewSchema = z.strictObject({ token: tokenSchema, path: pathSchema })
export const externalStageSchema = z.strictObject({
  requestId: z.string().min(8).max(128),
  token: tokenSchema,
  revision: hash,
  update: z.strictObject({ installId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u), baseRevision: hash }).optional(),
})

export const externalStagePayload = ({ token, revision, update }: PluginExternalStage) => ({ token, revision, update: update ?? null })

export function externalSourceIdentity({ source, pluginId }: Pick<PluginExternalRelease, 'source' | 'pluginId'>): string {
  switch (source.kind) {
    case 'github':
      return JSON.stringify([source.kind, source.repository, source.ref, pluginId])
    case 'local-folder':
      return JSON.stringify([source.kind, source.directory, pluginId])
    default:
      return JSON.stringify([source.kind, source.file, pluginId])
  }
}

type Origin = z.infer<typeof externalOriginSchema>

export function externalUpdate(
  candidate: Origin,
  record: { external?: Origin; revision: string; appliedVersion?: string },
): PluginCatalogUpdateStatus {
  if (!record.external || externalSourceIdentity(candidate) !== externalSourceIdentity(record.external)) return 'different-source'
  if (record.revision !== record.external.revision) return 'local-changes'
  if (record.revision === candidate.revision) return 'current'
  for (const version of [record.external.version, record.appliedVersion]) {
    if (version === undefined) continue
    const precedence = compareReleaseVersions(candidate.version, version)
    if (precedence !== 1) return precedence === 0 ? 'same-version-changed' : 'older'
  }
  return 'available'
}

export function externalUpdateError(status: Exclude<PluginCatalogUpdateStatus, 'available'>): AppError {
  switch (status) {
    case 'current':
      return new AppError(409, 'plugin-external-current', '这个版本已暂存。')
    case 'older':
      return new AppError(409, 'plugin-external-not-newer', '这个版本没有比草稿和已应用版本更新。')
    case 'local-changes':
      return new AppError(409, 'plugin-external-local-changes', '草稿有本机改动，已保留。')
    case 'different-source':
      return new AppError(409, 'plugin-external-source-mismatch', '请使用原来的来源和插件标识更新。')
    default:
      return new AppError(409, 'plugin-external-version-conflict', '同一版本号的内容不同，请使用带有新版本号的发行。')
  }
}
