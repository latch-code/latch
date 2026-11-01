import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  PROJECT_GLYPHS,
  PROVIDER_PRESETS,
  type AgentRecord,
  type ModelRef,
  type ProjectGlyph,
  type ProviderKind,
  type TaskMode,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { syncDirectory } from '@latch/core/node-kit'
import { excludeFromBackup } from './backup.ts'

export interface ProviderRecord {
  id: string
  name: string
  kind: ProviderKind
  presetId?: string
  baseURL: string
  apiKey: string
  /** `scheme://host:port` (port always explicit) the key was saved for; the key is never sent anywhere else. */
  keyOrigin?: string
  /**
   * The base URL's path the key was saved for, without trailing slashes ('' at the root). Requests go to paths under
   * it, and the key is sent only while the base URL still has this origin and this path: gateways that separate
   * tenants by path never receive another tenant's key.
   */
  keyPath?: string
  enabled: boolean
  models: string[]
  modelCapabilities?: Record<string, { vision?: boolean }>
  defaultModel: string
}

export interface WorkspaceFolderRecord {
  id: string
  /** Realpath without macOS alias prefixes. */
  path: string
}

/**
 * A saved project. `path` mirrors `folders[0].path` (the primary folder) for older Hosts, which read only `path`; a file
 * where the two differ was edited by hand, and the Host disables that project for the run.
 */
export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  /** 1–8, ordered; `[0]` is the primary folder. Entries saved before projects had several folders get one on load. */
  folders: WorkspaceFolderRecord[]
  glyph?: ProjectGlyph
  /** A hand-edited path/folder mismatch stays disabled until the primary folder is explicitly selected again. */
  invalid?: true
}

export interface HostSettings {
  version: 1
  defaults: { harnessId?: string; mode?: TaskMode; workspaceId?: string; model?: ModelRef; pinned?: boolean }
  plugins: { disabled: string[] }
  /** Owner-added projects. The startup workspace is the implicit `default` and is not stored. */
  workspaces: WorkspaceRecord[]
  agents: AgentRecord[]
}

/** Provider, agent and stored-workspace IDs. Provider IDs double as plugin IDs. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/

/** Folder IDs inside one project; the Standard tools and the desktop address folders by them. */
export const FOLDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * A folder ID from its basename: folded to ASCII (NFKD without combining marks, lower case, anything else a hyphen,
 * runs collapsed and trimmed), `folder` when nothing is left, then `-2`, `-3`… until it is not in `taken`.
 */
export function folderIdFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const slug =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 32)
      .replace(/-+$/u, '') || 'folder'
  if (!used.has(slug)) return slug
  for (let suffix = 2; ; suffix++) {
    const tail = `-${suffix}`
    const candidate = `${slug.slice(0, 32 - tail.length).replace(/-+$/u, '')}${tail}`
    if (!used.has(candidate)) return candidate
  }
}

/** Slug of `base` that matches `PROVIDER_ID` and is not in `taken`. */
export function availableId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^[-_]+|-+$/gu, '')
      .slice(0, 40) || 'item'
  if (!used.has(slug)) return slug
  for (let suffix = 2; ; suffix++) if (!used.has(`${slug}-${suffix}`)) return `${slug}-${suffix}`
}

const PROVIDERS_FILE = 'providers.json'
const SETTINGS_FILE = 'settings.json'
const LEGACY_PROVIDER_FILE = 'provider.json'
/**
 * Kept out of Time Machine backups (see backup.ts): the model keys, and the Agent definitions, whose environment values
 * are often API keys. Splitting those values into a file of their own would give each Agent definition two commit
 * points, and the launch fingerprint covers them; so all of settings.json stays out, projects and defaults included.
 */
export const BACKUP_EXCLUDED_CONFIG_FILES: readonly string[] = [PROVIDERS_FILE, SETTINGS_FILE, LEGACY_PROVIDER_FILE]

const noControl = (value: string) => !/[\u0000-\u001f\u007f]/u.test(value)
const id = (label: string) => z.string().regex(PROVIDER_ID, `${label}只能包含小写字母、数字、- 和 _，且以字母或数字开头，最长 48 个字符`)
const modelId = z.string().trim().min(1, '模型 ID 不能为空').max(200, '模型 ID 过长').refine(noControl, '模型 ID 不能包含控制字符')
const name = z.string().trim().min(1, '名称不能为空').max(80, '名称过长')
const baseURL = z
  .string()
  .max(2048, '服务地址过长')
  .refine(value => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }, '服务地址必须是不含凭据、查询参数或片段的 HTTP(S) 地址')

/**
 * `scheme://host:port` of an HTTP(S) URL with the port always explicit, so `https://h` and
 * `https://h:443` compare equal. The host is in WHATWG form: lowercase, punycode, IPv6 in brackets.
 */
export function originOf(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError(400, 'invalid-url', '服务地址必须是 HTTP(S) 地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError(400, 'invalid-url', '服务地址必须是 HTTP(S) 地址')
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
}

/**
 * The path of an HTTP(S) URL as a key is bound to it: WHATWG-normalized (dot segments resolved, percent-encoded) and
 * without trailing slashes, so `/v1` and `/v1/` are the same binding and the root is ''.
 */
export function keyPathOf(value: string): string {
  originOf(value)
  return new URL(value).pathname.replace(/\/+$/u, '')
}

/** Where a key saved for `baseURL` may be sent: its origin and path. */
export function keyScopeOf(baseURL: string): { keyOrigin: string; keyPath: string } {
  return { keyOrigin: originOf(baseURL), keyPath: keyPathOf(baseURL) }
}

/** `https://h:443/v1`: the origin and path a key is bound to, as the owner reads it. */
export function keyScopeText(scope: { keyOrigin: string; keyPath?: string }): string {
  return `${scope.keyOrigin}${scope.keyPath ?? ''}`
}

/**
 * `https://h:443/v1`: the address a model service at `baseURL` is confirmed at. The same origin and path a key is bound
 * to, since a gateway tells its tenants apart by the path.
 */
export function addressOf(baseURL: string): string {
  return keyScopeText(keyScopeOf(baseURL))
}

function originOrUndefined(value: string): string | undefined {
  try {
    return originOf(value)
  } catch {
    return undefined
  }
}

const keyOrigin = z
  .string()
  .max(2100)
  .refine(value => originOrUndefined(value) === value, '密钥绑定的服务地址无效')
const keyPath = z
  .string()
  .max(2048)
  .refine(value => value === '' || (value.startsWith('/') && !value.endsWith('/') && noControl(value)), '密钥绑定的路径无效')

const providerSchema = z
  .object({
    id: id('服务标识'),
    name,
    kind: z.enum(['openai-compatible', 'anthropic']),
    presetId: id('预设标识').optional(),
    baseURL,
    apiKey: z.string().max(8192, 'API Key 过长').refine(noControl, 'API Key 不能包含换行或控制字符'),
    keyOrigin: keyOrigin.optional(),
    keyPath: keyPath.optional(),
    enabled: z.boolean(),
    modelCapabilities: z.record(modelId, z.strictObject({ vision: z.boolean().optional() })).optional(),
    models: z.array(modelId).min(1, '至少需要一个模型').max(1000, '模型数量过多'),
    defaultModel: modelId,
  })
  .superRefine((value, context) => {
    if (new Set(value.models).size !== value.models.length)
      context.addIssue({ code: 'custom', path: ['models'], message: '模型 ID 不能重复' })
    if (!value.models.includes(value.defaultModel))
      context.addIssue({ code: 'custom', path: ['defaultModel'], message: '默认模型必须在模型列表中' })
  })
/** As stored before key origins and paths existed; `open` back-fills them. */
const storedProvidersSchema = z
  .array(providerSchema)
  .max(64, '模型服务数量过多')
  .superRefine((providers, context) => {
    const ids = providers.map(provider => provider.id)
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: '服务标识不能重复' })
  })
/** Every write: a saved key always names the one origin and path it may be sent to. */
const providersSchema = storedProvidersSchema.superRefine((providers, context) => {
  providers.forEach((provider, index) => {
    if (provider.apiKey && !provider.keyOrigin)
      context.addIssue({ code: 'custom', path: [index, 'keyOrigin'], message: 'API Key 必须绑定保存时的服务地址' })
    if (provider.apiKey && provider.keyPath === undefined)
      context.addIssue({ code: 'custom', path: [index, 'keyPath'], message: 'API Key 必须绑定保存时的服务路径' })
  })
})
const providersFileSchema = z.object({ version: z.literal(1), providers: storedProvidersSchema })
const legacyProviderSchema = z.object({ baseURL: z.string(), apiKey: z.string(), model: z.string() })

const folderPath = z
  .string()
  .max(4096, '项目路径过长')
  .refine(value => isAbsolute(value) && noControl(value), '项目路径必须是绝对路径')
const folderSchema = z.object({ id: z.string().regex(FOLDER_ID, '文件夹标识无效'), path: folderPath })
const workspaceSchema = z
  .object({
    id: id('项目标识').refine(value => value !== 'default', '项目标识 default 保留给默认文件夹'),
    name,
    path: folderPath,
    folders: z.array(folderSchema).min(1, '项目至少要有一个文件夹').max(8, '一个项目最多 8 个文件夹').optional(),
    // An unknown glyph (a newer Host's, or a hand edit) is dropped rather than making the whole file unreadable.
    glyph: z.enum(PROJECT_GLYPHS).optional().catch(undefined),
    invalid: z.literal(true).optional(),
  })
  .superRefine((value, context) => {
    if (!value.folders) return
    if (new Set(value.folders.map(folder => folder.id)).size !== value.folders.length)
      context.addIssue({ code: 'custom', path: ['folders'], message: '文件夹标识不能重复' })
    if (new Set(value.folders.map(folder => folder.path)).size !== value.folders.length)
      context.addIssue({ code: 'custom', path: ['folders'], message: '同一项目中的文件夹不能重复' })
  })
  .transform(({ glyph, folders, ...rest }): WorkspaceRecord => ({
    ...rest,
    // Saved before projects had several folders: the one directory becomes the primary folder.
    folders: folders ?? [{ id: folderIdFor(basename(rest.path), []), path: rest.path }],
    ...(rest.invalid || (folders && folders[0]?.path !== rest.path) ? { invalid: true as const } : {}),
    ...(glyph ? { glyph } : {}),
  }))
const agentProbeSchema = z.object({
  status: z.enum(['ready', 'authentication-required', 'failed']),
  login: z.enum(['authenticated', 'unauthenticated', 'unknown']).optional(),
  agent: z.object({ name: z.string().max(200).optional(), version: z.string().max(100).optional() }).optional(),
  capabilities: z.object({
    embeddedContext: z.boolean().optional(),
    images: z.boolean(),
    resume: z.boolean(),
    load: z.boolean(),
    additionalDirectories: z.boolean(),
  }),
  authMethods: z.array(z.object({ name: z.string().max(200), description: z.string().max(500).optional() })).max(16),
  diagnostic: z.string().max(4096).optional(),
  checkedAt: z.string().datetime(),
  launchHash: z.string().regex(/^[a-f0-9]{64}$/u),
})
const agentSchema = z.object({
  lastProbe: agentProbeSchema.optional(),
  probedDefinitionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  // The built-in harness owns `standard`; agent IDs become harness IDs.
  id: id('Agent 标识').refine(value => value !== 'standard', 'Agent 标识 standard 已被内置 Harness 使用'),
  name,
  presetId: id('预设标识').optional(),
  command: z.string().trim().min(1, '命令不能为空').max(1024, '命令过长').refine(noControl, '命令不能包含控制字符'),
  args: z
    .array(
      z
        .string()
        .max(4096, '参数过长')
        .refine(value => !value.includes('\u0000'), '参数不能包含空字符'),
    )
    .max(64, '参数数量过多'),
  env: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, '环境变量名无效'),
      z
        .string()
        .max(32_768, '环境变量值过长')
        .refine(value => !value.includes('\u0000'), '环境变量值不能包含空字符'),
    )
    .refine(env => Object.keys(env).length <= 64, '环境变量数量过多'),
  enabled: z.boolean(),
  startedHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable()
    .optional(),
})
const settingsSchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        harnessId: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/u, 'Harness 标识无效')
          .optional(),
        mode: z.enum(['chat', 'agent']).optional(),
        workspaceId: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u, '项目标识无效')
          .optional(),
        model: z.object({ providerId: z.string().min(1).max(128), model: modelId }).optional(),
        pinned: z.boolean().optional(),
      })
      .default({}),
    plugins: z.object({ disabled: z.array(z.string().min(1).max(128)).max(256) }).default({ disabled: [] }),
    workspaces: z.array(workspaceSchema).max(100, '项目数量过多').default([]),
    agents: z.array(agentSchema).max(64, 'Agent 数量过多').default([]),
  })
  .superRefine((settings, context) => {
    const duplicate = (values: string[]) => new Set(values).size !== values.length
    if (duplicate(settings.workspaces.map(item => item.id)))
      context.addIssue({ code: 'custom', path: ['workspaces'], message: '项目标识不能重复' })
    if (duplicate(settings.workspaces.map(item => item.path)))
      context.addIssue({ code: 'custom', path: ['workspaces'], message: '同一目录不能重复添加' })
    if (duplicate(settings.agents.map(item => item.id)))
      context.addIssue({ code: 'custom', path: ['agents'], message: 'Agent 标识不能重复' })
  })

function emptySettings(): HostSettings {
  return { version: 1, defaults: {}, plugins: { disabled: [] }, workspaces: [], agents: [] }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Paths and zod messages only; parser messages may quote file content, including keys. */
function issueText(error: z.ZodError, withPath: boolean): string {
  const issue = error.issues[0]
  if (!issue) return '格式无效'
  const path = issue.path.map(String).join('.')
  return withPath && path ? `${path}：${issue.message}` : issue.message
}

function corrupt(file: string, detail: string): AppError {
  return new AppError(500, 'config-corrupt', `配置文件 ${file} 无法读取，原文件已保留：${detail}`)
}

async function readConfig<T>(file: string, schema: z.ZodType<T>, tighten: boolean): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    throw corrupt(file, codeOf(error) ?? '读取失败')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw corrupt(file, 'JSON 格式无效')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw corrupt(file, issueText(parsed.error, true))
  // Secrets live here; a hand-created file may have been world-readable.
  if (tighten && process.platform !== 'win32' && ((await stat(file)).mode & 0o077) !== 0) await chmod(file, 0o600)
  return parsed.data
}

type BeforePublish<T> = (next: T, commit: () => Promise<void>) => Promise<void>

/**
 * Owner configuration in the Host data directory: `providers.json` (with API keys) and `settings.json` (with the Agents'
 * environment values), both 0600 and kept out of Time Machine backups.
 * Each file has one serialized writer; readers always see the last published state.
 */
export class HostConfig {
  private providerList: ProviderRecord[] = []
  private hostSettings: HostSettings = emptySettings()
  private readonly queues = { providers: Promise.resolve(), settings: Promise.resolve() }

  private constructor(private readonly dataDir: string) {}

  /**
   * Loads both files; migrates a legacy `provider.json` once and never modifies it. A corrupt file is reported, never overwritten.
   * Keys saved before origin or path binding are bound to their current base URL's origin and path, written back once.
   */
  static async open(dataDir: string): Promise<HostConfig> {
    const config = new HostConfig(resolve(dataDir))
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 })
    const stored = await readConfig(join(config.dataDir, PROVIDERS_FILE), providersFileSchema, true)
    const settings = await readConfig(join(config.dataDir, SETTINGS_FILE), settingsSchema, true)
    if (settings) config.hostSettings = settings
    if (stored) {
      config.providerList = stored.providers
      if (stored.providers.some(record => record.apiKey && (!record.keyOrigin || record.keyPath === undefined))) {
        await config.updateProviders(draft => {
          for (const record of draft) {
            if (!record.apiKey) continue
            record.keyOrigin ??= originOf(record.baseURL)
            record.keyPath ??= keyPathOf(record.baseURL)
          }
        })
      }
    } else {
      const legacyFile = join(config.dataDir, LEGACY_PROVIDER_FILE)
      const legacy = await readConfig(legacyFile, legacyProviderSchema, false)
      if (legacy) {
        const migrated = providerSchema.safeParse(migrateLegacy(legacy))
        if (!migrated.success) throw corrupt(legacyFile, issueText(migrated.error, true))
        await config.updateProviders(draft => {
          draft.push(migrated.data)
        })
      }
    }
    return config
  }

  providers(): ProviderRecord[] {
    return structuredClone(this.providerList)
  }

  provider(id: string): ProviderRecord | undefined {
    const record = this.providerList.find(provider => provider.id === id)
    return record && structuredClone(record)
  }

  settings(): HostSettings {
    return structuredClone(this.hostSettings)
  }

  /**
   * Serialized: mutate a draft, validate it, call `beforePublish` (may throw to abort), atomically write, then publish in memory.
   * `beforePublish` may call `commit` itself to place the durable write inside its own transaction, e.g. a registry replace.
   */
  updateProviders(mutate: (draft: ProviderRecord[]) => void, beforePublish?: BeforePublish<ProviderRecord[]>): Promise<void> {
    return this.serialize('providers', async () => {
      const draft = structuredClone(this.providerList)
      mutate(draft)
      const checked = providersSchema.safeParse(draft)
      if (!checked.success) throw new AppError(400, 'invalid-provider', `模型服务配置无效：${issueText(checked.error, false)}`)
      const next = checked.data
      await this.persist(PROVIDERS_FILE, { version: 1, providers: next }, next, beforePublish, () => {
        this.providerList = next
      })
    })
  }

  updateSettings(mutate: (draft: HostSettings) => void, beforePublish?: BeforePublish<HostSettings>): Promise<void> {
    return this.serialize('settings', async () => {
      const draft = structuredClone(this.hostSettings)
      mutate(draft)
      const checked = settingsSchema.safeParse(draft)
      if (!checked.success) throw new AppError(400, 'invalid-settings', `设置无效：${issueText(checked.error, false)}`)
      const next = checked.data
      await this.persist(SETTINGS_FILE, next, next, beforePublish, () => {
        this.hostSettings = next
      })
    })
  }

  private serialize(queue: keyof HostConfig['queues'], task: () => Promise<void>): Promise<void> {
    const run = this.queues[queue].then(task)
    this.queues[queue] = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** The rename is the commit point: once it happens, memory follows the disk even if a later step fails. */
  private async persist<T>(
    fileName: string,
    content: unknown,
    next: T,
    beforePublish: BeforePublish<T> | undefined,
    publish: () => void,
  ): Promise<void> {
    const target = join(this.dataDir, fileName)
    const temporary = join(this.dataDir, `.${fileName}-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(content, null, 2)}\n`)
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
    await handle.close()
    // A rename replaces the file, and with it the old file's backup exclusion, so the new one carries its own.
    if (BACKUP_EXCLUDED_CONFIG_FILES.includes(fileName)) await excludeFromBackup([temporary])
    let renamed = false
    let committing: Promise<void> | undefined
    const commit = () =>
      (committing ??= (async () => {
        await rename(temporary, target)
        renamed = true
        await syncDirectory(this.dataDir)
      })())
    try {
      await beforePublish?.(structuredClone(next), commit)
      await commit()
    } finally {
      if (renamed) publish()
      else await unlink(temporary).catch(() => {})
    }
  }
}

function migrateLegacy(legacy: z.infer<typeof legacyProviderSchema>): ProviderRecord {
  const trimmed = (value: string) => value.replace(/\/+$/u, '')
  const preset = PROVIDER_PRESETS.find(
    item => item.kind === 'openai-compatible' && item.baseURL && trimmed(item.baseURL) === trimmed(legacy.baseURL),
  )
  // An invalid legacy URL has no origin; the schema then reports the file as corrupt.
  const origin = legacy.apiKey ? originOrUndefined(legacy.baseURL) : undefined
  const scope = origin ? { keyOrigin: origin, keyPath: keyPathOf(legacy.baseURL) } : {}
  return {
    id: 'openai-compatible',
    name: preset?.name ?? 'OpenAI 兼容接口',
    kind: 'openai-compatible',
    ...(preset ? { presetId: preset.id } : {}),
    baseURL: legacy.baseURL,
    apiKey: legacy.apiKey,
    ...scope,
    enabled: true,
    models: [legacy.model.trim()],
    defaultModel: legacy.model.trim(),
  }
}
