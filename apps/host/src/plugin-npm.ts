import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { z } from 'zod'
import type { PluginNpmRelease } from '@latch/protocol'
import { isSecretPathName } from '@latch/protocol'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { EgressDenied, type FetchLike } from './egress.ts'
import { isPrerelease, NPM_MIRROR_CDN, NPM_MIRROR_REGISTRY, npmReleaseSchema } from './npm-source.ts'
import { tarEntries, tarPath } from './plugin-tar.ts'
import { PLUGIN_PACKAGE_BYTES, checkedPluginBundle, containsPluginSourceSecret } from './plugin-package-bundle.ts'

const ARCHIVE_BYTES = PLUGIN_PACKAGE_BYTES + 1024 * 1024
const METADATA_BYTES = 1024 * 1024
const MANIFEST_BYTES = 64 * 1024
const unzip = promisify(gunzip)
const versionDocument = z.object({ name: z.string(), version: z.string(), dist: z.object({ tarball: z.string(), integrity: z.string() }) })
const identityDocument = versionDocument.pick({ name: true, version: true })
const invalidRelease = () => new AppError(502, 'plugin-npm-release-invalid', 'npm 仓库没有返回有效的 Latch 插件版本。')
const invalidArchive = () => new AppError(502, 'plugin-npm-archive-invalid', 'npm 压缩包缺少有效的 Latch 插件资产或归档格式不受支持。')
const invalidSource = () => new AppError(502, 'plugin-npm-tarball-source', 'npm 压缩包地址超出了已确认仓库的下载范围。')

function jsonDocument(bytes: Uint8Array, error: () => AppError): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw error()
  }
}

async function get(fetch: FetchLike, url: string, accept: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { method: 'GET', headers: { accept }, redirect: 'manual', credentials: 'omit', signal })
  } catch (cause) {
    if (cause instanceof EgressDenied || (cause instanceof Error && cause.cause instanceof EgressDenied))
      throw new AppError(403, 'egress-denied', 'Host 出站策略拒绝了此仓库。私网地址需要先加入出站白名单。')
    throw new AppError(502, 'plugin-npm-unreachable', '暂时无法连接 npm 仓库，请检查地址和网络后重试。')
  }
}

async function readResponse(response: Response, limit: number, check: () => void, error: () => AppError): Promise<Buffer> {
  if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 404) throw new AppError(404, 'plugin-npm-package-not-found', '这个 npm 包或版本在当前仓库中找不到。')
    throw error()
  }
  const reader = response.body.getReader()
  const result = Buffer.allocUnsafe(limit)
  let size = 0
  try {
    for (;;) {
      check()
      const part = await reader.read().catch(() => {
        throw error()
      })
      if (part.done) return result.subarray(0, size)
      if (size + part.value.byteLength > limit) throw error()
      result.set(part.value, size)
      size += part.value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function tarballUrl(input: string): { url: URL; path: string } {
  const url = URL.parse(input)
  if (
    !url
    || !/^https:\/\/[A-Za-z0-9.[\]:-]+\/[A-Za-z0-9._~@/+%-]+$/iu.test(input)
    || input.length > 1024
    || /\/\.{1,2}(?:\/|$)|%(?!2f|40|2b)/iu.test(input)
    || redactKnownSecrets(input) !== input
  )
    throw invalidSource()
  const path = decodeURIComponent(url.pathname)
  if (
    !path.endsWith('.tgz')
    || path
      .slice(1)
      .split('/')
      .some(part => !part || part === '.' || part === '..')
  )
    throw invalidSource()
  return { url, path }
}

async function downloadArchive(
  fetch: FetchLike,
  release: PluginNpmRelease,
  address: string,
  check: () => void,
  signal: AbortSignal,
): Promise<Response> {
  const archive = tarballUrl(address)
  const source = new URL(release.registry)
  if (
    archive.url.origin !== source.origin
    || !archive.path.startsWith(source.pathname)
    || !archive.url.pathname.startsWith(source.pathname)
  )
    throw invalidSource()
  check()
  const response = await get(fetch, archive.url.href, 'application/octet-stream', signal)
  if (response.status < 300 || response.status >= 400) return response
  await response.body?.cancel().catch(() => {})
  const filename = `${release.name.split('/').at(-1)}-${release.version}.tgz`
  // This mirror publishes its own URL, then serves the same named release from its fixed distribution origin.
  if (release.registry !== NPM_MIRROR_REGISTRY || archive.path !== `/${release.name}/-/${filename}`) throw invalidSource()
  const cdn = tarballUrl(response.headers.get('location') ?? '')
  if (cdn.url.origin !== NPM_MIRROR_CDN || cdn.path !== `/packages/${release.name}/${release.version}/${filename}`) throw invalidSource()
  check()
  return get(fetch, cdn.url.href, 'application/octet-stream', signal)
}

function extractPackage(tar: Buffer): { identity: Buffer; bundle: Buffer } {
  const entries = new Map<string, boolean>()
  let identity: Buffer | undefined, bundle: Buffer | undefined
  for (const { name, type, bytes } of tarEntries(tar, 256, invalidArchive)) {
    const directory = type === '5'
    if ((!directory && type !== '\0' && type !== '0') || (directory && bytes.length !== 0)) throw invalidArchive()
    const path = tarPath(name, directory, invalidArchive)
    const key = path.normalize('NFC').toLowerCase()
    if (((path !== 'package' || !directory) && !path.startsWith('package/')) || entries.has(key)) throw invalidArchive()
    entries.set(key, directory)
    if (path === 'package/package.json' && !directory && bytes.length <= MANIFEST_BYTES) identity = bytes
    if (path === 'package/latch-plugin.json' && !directory && bytes.length <= PLUGIN_PACKAGE_BYTES) bundle = bytes
  }
  if (!identity || !bundle) throw invalidArchive()
  for (const path of entries.keys()) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1))
      if (entries.get(path.slice(0, slash)) === false) throw invalidArchive()
  }
  return { identity, bundle }
}

export async function readNpmPlugin(
  fetch: FetchLike,
  input: { registry: string; name: string; version?: string },
  check: () => void,
  expectedIntegrity?: string,
): Promise<ReturnType<typeof checkedPluginBundle> & { release: PluginNpmRelease }> {
  const { registry, name, version } = input
  const signal = AbortSignal.timeout(15_000)
  check()
  const metadata = await get(
    fetch,
    `${registry}${name.replace('/', '%2f')}/${encodeURIComponent(version ?? 'latest')}`,
    'application/json',
    signal,
  )
  const parsed = versionDocument.safeParse(
    jsonDocument(await readResponse(metadata, METADATA_BYTES, check, invalidRelease), invalidRelease),
  )
  if (!parsed.success) throw invalidRelease()
  const document = parsed.data
  const release = npmReleaseSchema.safeParse({
    registry,
    name: document.name,
    version: document.version,
    integrity: document.dist.integrity,
  })
  if (!release.success || document.name !== name || (version !== undefined && version !== document.version)) throw invalidRelease()
  if (version === undefined && isPrerelease(document.version))
    throw new AppError(409, 'plugin-npm-prerelease', `仓库将 ${document.version} 标记为 latest。要下载这个预发布版，请输入准确版本号。`)
  if (expectedIntegrity !== undefined && document.dist.integrity !== expectedIntegrity)
    throw new AppError(409, 'plugin-npm-integrity', '仓库版本内容已变化，请重新预览。')

  const response = await downloadArchive(fetch, release.data, document.dist.tarball, check, signal)
  const bytes = await readResponse(response, ARCHIVE_BYTES, check, invalidArchive)
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== release.data.integrity)
    throw new AppError(502, 'plugin-npm-integrity', 'npm 压缩包的 SHA-512 校验不匹配。')
  const archiveData = extractPackage(
    await unzip(bytes, { maxOutputLength: ARCHIVE_BYTES }).catch(() => {
      throw invalidArchive()
    }),
  )
  check()
  const identity = identityDocument.safeParse(jsonDocument(archiveData.identity, invalidArchive))
  if (!identity.success || identity.data.name !== name || identity.data.version !== document.version) throw invalidArchive()
  const checked = checkedPluginBundle(jsonDocument(archiveData.bundle, invalidArchive))
  if (checked.bundle.manifest.version !== document.version) throw invalidRelease()
  if (
    containsPluginSourceSecret(JSON.stringify(checked.bundle.manifest))
    || checked.bundle.files.some(
      ({ path, content }) =>
        isSecretPathName(path)
        || path.toLowerCase().endsWith('.key')
        || containsPluginSourceSecret(path)
        || containsPluginSourceSecret(content),
    )
  )
    throw new AppError(400, 'plugin-external-secret', '来源中有可能含密钥的文本或文件名。请移除后重试。')
  return { ...checked, release: release.data }
}
