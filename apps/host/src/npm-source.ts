import { z } from 'zod'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'

export const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com/'
export const NPM_MIRROR_CDN = 'https://cdn.npmmirror.com'
export const npmRegistryChanged = () => new AppError(409, 'plugin-npm-registry-changed', '已确认的 npm 仓库已变化，请刷新后再试。')

export function npmRegistryUrl(input: string): string {
  const parsed = URL.parse(input)
  if (
    !parsed
    || !/^https:\/\/[A-Za-z0-9.[\]:-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/iu.test(input)
    || /\/\.{1,2}(?:\/|$)/u.test(input)
    || parsed.hostname.endsWith('.')
    || input.length > 512
    || redactKnownSecrets(input) !== input
  )
    throw new AppError(400, 'plugin-npm-registry-invalid', '请输入不带凭据、查询参数和片段的 HTTPS npm 仓库地址。')
  return `${parsed.origin}${parsed.pathname.replace(/\/$/u, '')}/`
}

const registry = z.string().refine(input => {
  try {
    return npmRegistryUrl(input) === input
  } catch {
    return false
  }
}, 'npm 仓库地址必须是规范化的 HTTPS 地址')
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const revision = z.string().regex(/^[0-9a-f]{64}$/u)
const name = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u)
  .refine(input => redactKnownSecrets(input) === input)
const semver =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const digits = /^[0-9]+$/u
export const releaseVersionSchema = z
  .string()
  .max(64)
  .refine(input => {
    const parts = semver.exec(input)
    return (
      parts !== null
      && redactKnownSecrets(input) === input
      && !parts[4]?.split('.').some(part => digits.test(part) && part.length > 1 && part.startsWith('0'))
    )
  })
const integrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/u)
const requestId = z.string().min(8).max(128)

export const npmReleaseSchema = z.strictObject({ registry, name, version: releaseVersionSchema, integrity })
export const npmPreviewSchema = z.strictObject({ name, version: releaseVersionSchema.optional(), pluginId: id.optional() })
export const npmStageSchema = z.strictObject({
  requestId,
  release: npmReleaseSchema,
  revision,
  update: z
    .strictObject({
      pluginId: id,
      installId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
      baseRevision: revision,
      replaceLocalDraft: z.literal(true).optional(),
    })
    .optional(),
})
export const npmOriginSchema = npmReleaseSchema.extend({ revision })
export const npmRegistrySchema = z.strictObject({ registry: registry.nullable(), revision })
export const npmRegistryUpdateSchema = z.strictObject({
  registry: z.string().nullable(),
  baseRegistry: z.string().nullable(),
  baseRevision: revision,
  requestId,
})

export function isPrerelease(version: string): boolean {
  return semver.exec(version)?.[4] !== undefined
}

/** The caller has already checked both versions. Build metadata has no effect on precedence. */
export function newerNpmVersion(candidate: string, installed: string): boolean {
  return compareReleaseVersions(candidate, installed) === 1
}

export function compareReleaseVersions(candidate: string, installed: string): -1 | 0 | 1 | undefined {
  if (!releaseVersionSchema.safeParse(candidate).success || !releaseVersionSchema.safeParse(installed).success) return undefined
  const left = semver.exec(candidate)!,
    right = semver.exec(installed)!
  for (const part of [1, 2, 3]) {
    if (left[part] !== right[part]) return BigInt(left[part]) > BigInt(right[part]) ? 1 : -1
  }
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0
  const a = left[4].split('.'),
    b = right[4].split('.')
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index],
      y = b[index]
    if (x === y) continue
    const xNumeric = digits.test(x),
      yNumeric = digits.test(y)
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xNumeric !== yNumeric) return yNumeric ? 1 : -1
    return x > y ? 1 : -1
  }
  return a.length === b.length ? 0 : a.length > b.length ? 1 : -1
}
