import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, chmod, readFile, readdir, realpath, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  AGENT_PRESETS,
  PROVIDER_PRESETS,
  LISTENER_LABELS,
  SCOPE_LABELS,
  type AgentRecord,
  type AgentSettings,
  type AppSnapshot,
  type Approval,
  type ChangeEvent,
  type CurrentDevice,
  type DataScope,
  type Device,
  type DeviceScope,
  type HarnessSource,
  type HostCatalog,
  type HostView,
  type EnrollmentView,
  type ModelRef,
  type PermissionLevel,
  type PluginInfo,
  type PresenceAction,
  type PresencePreview,
  type ProviderSummary,
  type RiskLevel,
  type SessionDefaults,
  type TaskDetail,
  type TaskStateEvent,
  type TaskSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import { AppError, type HarnessDriver, type HarnessSecurityEvent, type ToolRiskInput, type HarnessPlugin } from '@latch/sdk'
import { PluginRegistry } from '@latch/core'
import { canonicalJson, sha256Hex, redactSecrets } from '@latch/core/node-kit'
import { createAcpAgentPlugin, resolveCommand, validateAgentDefinition } from '@latch/harness-acp'
import { AuditLog, type AuditActor, type StepupMethod } from './audit.ts'
import { DeviceStore, EnrollmentService, type ConnectionContext, type DeviceScopeBase } from './auth.ts'
import { hashDisplay } from './crypto.ts'
import { createEgressFetch, type LookupFunction } from './egress.ts'
import { loadOrCreateHostIdentity } from './identity.ts'
import {
  DENY_READ_HOME_PATHS,
  canonicalPath,
  checkPrivateFile,
  checkWorkspaceCandidate,
  classifyDefaultWorkspace,
  latchCodeRoot,
  prepareRuntimeDir,
  resolveLatchPaths,
  type WorkspaceGuardContext,
} from './paths.ts'
import { PolicyStore, ceilingFor, isLowering, policyDiff, type Policy } from './policy.ts'
import { PresenceService, createPresenceBackend, paramsHash, type PresenceBackend } from './presence.ts'
import { classifyStandardCall } from './risk.ts'
import {
  CLEARED_LEGACY_COOKIE,
  authFailure,
  ceilingExceeded,
  clearedCredentialCookie,
  createRateLimits,
  credentialCookie,
  hasAuthorization,
  hostDesktopRequired,
  levelAtMost,
  levelsUpTo,
  localOnly,
  presentedCredential,
  publicTicket,
  scopeRequired,
  stepupRequired,
  type AuthFailureCode,
  type Presented,
} from './access.ts'
import {
  startListeners,
  validateTls,
  type ListenerContext,
  type ListenerSet,
  type TlsListenerOptions,
  type ValidatedTls,
} from './listeners.ts'
import { MIME, UI_CSP, KIB, codeOf, errorText, isWithin, json, jsonBody, optionalJsonBody, overlaps, safeDecode } from './http-util.ts'
import { HostConfig, PROVIDER_ID, availableId, originOf, type HostSettings, type ProviderRecord } from './config.ts'
import { HarnessHub, type HubCreateInput } from './hub.ts'
import type { HostInfo } from './host-state.ts'
import {
  checkProvider,
  listProviderModels,
  providerPlugin,
  providerSettings,
  summarizeProvider,
  usableKey,
  type ModelListInput,
} from './providers.ts'
import { createDemoPlugin } from './plugins/providers/demo/index.ts'
import { createToolsPlugin } from './plugins/tools/safe-tools/index.ts'
import { standardHarnessDriver } from './plugins/standard/index.ts'
import { createWorkspacePlugin } from './plugins/tools/workspace-files/index.ts'

export type { TlsListenerOptions } from './listeners.ts'

export const LATCH_VERSION = '0.1.0'

const TASK_BODY_LIMIT = 256 * KIB
const CONFIG_BODY_LIMIT = 128 * KIB
const HARNESS_ID = /^[a-zA-Z0-9_-]{1,64}$/
const LEGACY_PROVIDER_ID = 'openai-compatible'
const STANDARD = 'standard'
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_DECISION_RECORDS = 1000
/** Attempts for a reduction whose base moved underneath it (a cascade or a helper pin landing first). */
const BASE_RETRIES = 3
const MAX_ISSUED_INVITATIONS = 256
/** Data-directory entries holding credentials, identity, audit, settings or session data. */
const PRIVATE_ENTRIES = [
  'auth',
  'identity',
  'audit',
  'policy.json',
  'agents',
  'backups',
  'latch.db',
  'latch.db-wal',
  'latch.db-shm',
  'sessions',
  'harnesses',
  'provider.json',
  'providers.json',
  'settings.json',
  'sessions-meta.json',
  'host.json',
  'host.log',
  'host.lock',
]
/**
 * Names the Host writes next to private entries for a moment: atomic-write temp files (the `prefix` their writers pass to
 * `writeFileAtomic`, or the default `.<file name>-`) and a stale lock moved aside.
 */
const TRANSIENT_PREFIXES = ['.host-', '.policy-', '.provider.json-', '.providers.json-', '.settings.json-', 'sessions-meta.json.']
const BLOCKED_REASON = '有完全访问会话正在运行，本机确认暂时只能用于拒绝。请等待其结束或取消后重试。'
const L3_WARNINGS = [
  '该会话可以读写 Latch 数据和 Host 身份私钥，并可以冒用本机 Electron 在其他电脑上的身份。',
  'Harness 自己发起的询问只是提示，不是安全边界。',
]
const UNIX_ADDRESS = '本机 host.sock'
const RISK_REASONS = {
  'protected-path': '受保护路径',
  'outside-workspace': '工作区外路径',
  'code-root': 'Latch 程序目录内',
  'unlisted-tool': '未登记的工具',
} as const
const PAIRING_LABELS = { lpc: '本机确认', offline: '离线登记码', invitation: '配对邀请', migration: '旧版本迁移' } as const
/** Unix connections without a credential may reach only these. */
const ANONYMOUS_UNIX = new Set(['GET /link/api/devices', 'DELETE /link/api/devices/:id', 'POST /link/api/pairings'])

const httpURL = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(value => ['http:', 'https:'].includes(new URL(value).protocol), '仅支持 HTTP 或 HTTPS')
const apiKeyText = z
  .string()
  .max(8192)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'API Key 不能包含换行或控制字符')
/** Provider errors caused by the request itself rather than by the upstream service. */
const PROVIDER_INPUT_ERRORS = new Set(['invalid-url', 'invalid-key'])
const legacyProviderSchema = z.object({ baseURL: httpURL, apiKey: apiKeyText, model: z.string().trim().min(1).max(200) })
const modelId = z.string().trim().min(1).max(200)
const modelRefSchema = z.object({ providerId: z.string().min(1).max(64), model: modelId })
const promptSchema = z.object({
  prompt: z.string().trim().min(1).max(16_000),
  requestId: z.string().uuid(),
  model: modelRefSchema.optional(),
})
const createTaskSchema = promptSchema.extend({
  mode: z.enum(['chat', 'agent']).optional(),
  harnessId: z.string().regex(HARNESS_ID).optional(),
  workspaceId: z.string().min(1).max(64).optional(),
})
const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine(value => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined, '没有要修改的内容')
const configSchema = z.object({ configId: z.string().min(1).max(128), value: z.string().max(1024) })
const decisionSchema = z.object({
  decision: z.enum(['allow', 'reject']),
  optionId: z.string().min(1).max(128).optional(),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u)
    .optional(),
})
const deviceNameSchema = z.object({ name: z.string().trim().min(1).max(80) })
const scopeSchema = z.enum(['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'])
const enrollmentSchema = z.object({
  publicKey: z.string().min(1).max(1024),
  /** Empty only when re-confirming a legacy browser, which keeps its old name. */
  name: z.string().trim().max(80).default(''),
  scopes: z.array(scopeSchema).max(6).optional(),
  dataScope: z.enum(['work', 'all']).optional(),
  invitation: z.string().min(1).max(64).optional(),
  offlineCode: z.string().min(1).max(64).optional(),
})
const signatureSchema = z.object({ signature: z.string().min(1).max(256) })
const renewSchema = z.object({ nonce: z.string().min(1).max(128), signature: z.string().min(1).max(256) })
const deviceScopesSchema = z
  .object({ scopes: z.array(scopeSchema).max(6).optional(), dataScope: z.enum(['work', 'all']).optional() })
  .refine(value => value.scopes !== undefined || value.dataScope !== undefined, '没有要修改的内容')
const invitationSchema = z.object({ scopes: z.array(scopeSchema).max(6).optional() })
const providerKind = z.enum(['openai-compatible', 'anthropic'])
const modelList = z.array(modelId).max(1000)
const providerCreateSchema = z.object({
  id: z.string().regex(PROVIDER_ID).optional(),
  name: z.string().trim().min(1).max(80),
  kind: providerKind,
  presetId: z.string().regex(PROVIDER_ID).optional(),
  baseURL: httpURL,
  apiKey: apiKeyText.optional(),
  models: modelList.default([]),
  defaultModel: modelId,
  enabled: z.boolean().optional(),
})
const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseURL: httpURL.optional(),
  apiKey: apiKeyText.nullable().optional(),
  models: modelList.optional(),
  defaultModel: modelId.optional(),
  enabled: z.boolean().optional(),
})
const providerCheckSchema = z.object({
  kind: providerKind,
  baseURL: httpURL,
  apiKey: apiKeyText.optional(),
  providerId: z.string().regex(PROVIDER_ID).optional(),
})
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine(name => name !== '__proto__', '环境变量名无效')
const argText = z
  .string()
  .max(4096)
  .refine(value => !value.includes('\0'), '参数不能包含空字符')
const envValue = z
  .string()
  .max(32_768)
  .refine(value => !value.includes('\0'), '环境变量值不能包含空字符')
const agentCreateSchema = z.object({
  id: z.string().regex(PROVIDER_ID).optional(),
  name: z.string().trim().min(1).max(80),
  presetId: z.string().regex(PROVIDER_ID).optional(),
  command: z.string().trim().min(1).max(1024),
  args: z.array(argText).max(64).default([]),
  env: z.record(envName, envValue).optional(),
  enabled: z.boolean().optional(),
})
const agentUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  command: z.string().trim().min(1).max(1024).optional(),
  args: z.array(argText).max(64).optional(),
  env: z.record(envName, envValue.nullable()).optional(),
  enabled: z.boolean().optional(),
})
const workspaceSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), path: z.string().min(1).max(4096) })
const preferencesSchema = z.object({
  defaults: z.object({
    harnessId: z.string().regex(HARNESS_ID).optional(),
    mode: z.enum(['chat', 'agent']).optional(),
    workspaceId: z.string().min(1).max(64).optional(),
    model: modelRefSchema.nullable().optional(),
  }),
})
const levelSchema = z.enum(['L0', 'L1', 'L2'])
const egressEntry = z
  .string()
  .trim()
  .min(3)
  .max(300)
  .transform(value => value.toLowerCase())
const policyPatchSchema = z
  .object({
    local: z.object({ maxLevel: levelSchema.optional(), allowL3: z.boolean().optional() }).strict().optional(),
    remote: z
      .object({
        maxLevel: levelSchema.optional(),
        allowRemoteStart: z.boolean().optional(),
        harnesses: z.array(z.string().regex(HARNESS_ID)).max(64).nullable().optional(),
        workspaces: z.array(z.string().min(1).max(64)).max(256).nullable().optional(),
      })
      .strict()
      .optional(),
    hostEgressAllow: z
      .object({ add: z.array(egressEntry).max(64).optional(), remove: z.array(egressEntry).max(64).optional() })
      .strict()
      .optional(),
  })
  .strict()

export interface ServerOptions {
  dataDir: string
  workspaceRoot: string
  uiDir: string
  /** Loopback port on 127.0.0.1 and ::1; 0 = ephemeral, same on both. */
  port: number
  /** Deprecated. Only '127.0.0.1' | 'localhost' | '::1' are accepted (and ignored); anything else is a startup error. */
  host?: string
  demo: boolean
  /** Provider from `HARNESS_MODEL`; it replaces the connection of `openai-compatible` for this process and is never persisted. */
  provider?: { baseURL: string; apiKey: string; model: string }
  plugins?: HarnessPlugin[]
  /** Process-level default provider (`--provider`); it overrides the saved default. */
  providerId?: string
  /** Process-level default harness (`--harness`); it must start, and its plugin cannot be disabled. */
  harnessId?: string
  /** Builds the plugin for an agent definition. Defaults to the ACP adapter. */
  agentPlugin?: (agent: AgentRecord) => HarnessPlugin
  tls?: TlsListenerOptions
  /** Tests; default per-user runtime dir. */
  runtimeParent?: string
  agentsDir?: string
  /** Dependency injection; default `createPresenceBackend(...)`. */
  presence?: PresenceBackend
  /** Process-local extra 'host:port' entries. */
  egressAllow?: readonly string[]
  /** Tests. */
  egressLookup?: LookupFunction
  /** Tests; default `latchCodeRoot()`. */
  codeRoot?: string
  /** Tests: credentials, confirmations, enrollments. */
  now?: () => number
  /** Tests: the computer's name in the snapshot; default the operating system's host name. */
  hostName?: string
  /** Tests: 'relaxed' multiplies every rate-limit bucket by 100. Production never sets it. */
  rateLimits?: 'default' | 'relaxed'
  /** Default `console.error('[Latch] ' + text)`; every line is redacted first. */
  log?: (text: string) => void
}

export interface StartedHost {
  hostId: string
  hostId8: string
  instanceId: string
  pid: number
  /** http://h-<hostId>.localhost:<port> */
  loopbackOrigin: string
  /** Same as `loopbackOrigin`. */
  origin: string
  loopbackPort: number
  tlsOrigin?: string
  socketPath: string
  runtimeDir: string
  startedAt: string
  bridge: HarnessHub
  registry: PluginRegistry
  config: HostConfig
  security: { devices: DeviceStore; enrollments: EnrollmentService; presence: PresenceService; audit: AuditLog; policy: PolicyStore }
  close(): Promise<void>
}

/** The authenticated party of one request. Anonymous only on host.sock, and only for a few routes. */
interface Caller {
  connection: ConnectionContext
  device?: Device
  renewAfter?: number
  presented?: Presented
  /** Hash of the credential this request was admitted with; event streams stay bound to it. */
  credentialHash?: string
}

interface EventStream {
  deviceId: string
  credentialHash: string
  sessionId?: string
  lastSentRevision: number
}
type DeviceCaller = Caller & { device: Device }

type PreviewLine = PresencePreview['lines'][number]
type AuditEvent = Parameters<AuditLog['append']>[0]

interface DecisionRecord {
  approvalId: string
  requestId?: string
  deviceId: string
  deviceName: string
  decision: 'allow' | 'reject'
  optionId?: string
  optionKind: string
  at: string
}

function withModel(models: string[], model: string): string[] {
  return models.includes(model) ? [...models] : [model, ...models]
}

/** The same address rules the provider plugins apply, checked before any upstream request. */
function assertBaseURL(value: string): void {
  const url = new URL(value)
  if (url.username || url.password) throw new AppError(400, 'invalid-url', '请将凭据填入 API Key，不要放在地址中')
  if (url.search || url.hash) throw new AppError(400, 'invalid-url', '服务地址不能包含查询参数或片段')
}

/** The `HARNESS_BASE_URL` overlay is never persisted or validated by the config schema, so its rules apply at startup. */
function assertEnvBaseURL(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError(400, 'invalid-url', 'HARNESS_BASE_URL 不是有效的 HTTP(S) 地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError(400, 'invalid-url', 'HARNESS_BASE_URL 仅支持 HTTP 或 HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'invalid-url', 'HARNESS_BASE_URL 不能包含凭据、查询参数或片段，请把密钥放在 HARNESS_API_KEY 中')
  }
}

/**
 * Whether a later `action.failed` record marks audit record `seq` as never committed. Read only when the settings file
 * still holds the state before the last Host write, which is when it matters; the chain was verified when it opened.
 */
async function markedFailed(auditFile: string, seq: number): Promise<boolean> {
  const lines = (await readFile(auditFile, 'utf8').catch(() => '')).split('\n').reverse()
  for (const line of lines) {
    if (!line) continue
    let record: { seq?: unknown; action?: unknown; detail?: { refSeq?: unknown } }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record.seq !== 'number' || record.seq <= seq) return false
    if (record.action === 'action.failed' && record.detail?.refSeq === seq) return true
  }
  return false
}

/** Audit reason for a saved workspace that fails the registration rules at startup. */
function disabledReason(error: AppError): 'overlap' | 'code-root' | 'protected' | 'invalid' {
  if (error.code === 'workspace-code-root') return 'code-root'
  if (error.code === 'workspace-overlap') return error.message.includes('受保护目录') ? 'protected' : 'overlap'
  return 'invalid'
}

/**
 * Paths workspace tools must never touch. When the default workspace lives inside the data directory
 * (the legacy `<data>/workspace` layout), protecting the whole directory would block that workspace,
 * so its private siblings are protected instead, and `guardDataDir` covers the spellings they miss.
 */
async function protectedDataPaths(dataDir: string, workspace: string): Promise<string[]> {
  if (!isWithin(workspace, dataDir)) return [dataDir]
  const exposed = relative(dataDir, workspace).split(sep)[0] ?? ''
  if (exposed && isPrivateEntry(exposed)) throw new AppError(400, 'workspace-protected', '工作区不能位于节点数据目录的私有位置')
  const names = new Set([...PRIVATE_ENTRIES, ...(await readdir(dataDir))])
  if (exposed) names.delete(exposed)
  return [...names].map(name => join(dataDir, name))
}

async function identityOf(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path, { bigint: true })
    return `${stats.dev}:${stats.ino}`
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return undefined
    throw error
  }
}

/** Folds case and Unicode compatibility forms (`Providers.json`, `providerſ.json`), as case-insensitive disks may. */
function foldName(name: string): string {
  return name.normalize('NFKC').toLowerCase()
}

const FOLDED_PRIVATE = new Set(PRIVATE_ENTRIES.map(foldName))
function isPrivateEntry(name: string): boolean {
  const folded = foldName(name)
  return FOLDED_PRIVATE.has(folded) || TRANSIENT_PREFIXES.some(prefix => folded.startsWith(prefix))
}

/**
 * With the workspace inside the data directory, a private entry that does not exist yet is protected
 * only by its exact spelling, yet on a case-insensitive disk `Providers.json` is `providers.json`.
 * This finds the data directory among a target's ancestors by identity and then allows only the
 * workspace's own entry, also by identity; a workspace that is the data directory itself allows
 * every name that does not fold to a private one.
 */
function guardDataDir(plugin: HarnessPlugin, dataDir: string, workspace: string): HarnessPlugin {
  const exposed = relative(dataDir, workspace).split(sep)[0] ?? ''
  async function assertAllowed(root: string, args: Record<string, unknown>): Promise<void> {
    // The tool itself rejects other input.
    if (typeof args.path !== 'string' || isAbsolute(args.path)) return
    const data = await identityOf(dataDir)
    const entry = exposed ? await identityOf(join(dataDir, exposed)) : undefined
    let child: string | undefined
    for (let current = resolve(await realpath(root), args.path); ; child = current, current = dirname(current)) {
      if (data !== undefined && (await identityOf(current)) === data) {
        const allowed = exposed
          ? child !== undefined && entry !== undefined && (await identityOf(child)) === entry
          : child === undefined || !isPrivateEntry(basename(child))
        if (allowed) return
        throw new Error('该路径属于 Latch 的私有数据目录，工作区工具不能访问')
      }
      if (dirname(current) === current) return
    }
  }
  return {
    ...plugin,
    activate: ctx =>
      plugin.activate({
        registerProvider: provider => ctx.registerProvider(provider),
        registerHarness: driver => ctx.registerHarness(driver),
        onDispose: dispose => ctx.onDispose(dispose),
        registerTool: tool =>
          ctx.registerTool({
            ...tool,
            ...(tool.preview
              ? {
                  preview: async (args, context) => {
                    await assertAllowed(context.workspaceRoot, args)
                    return tool.preview!(args, context)
                  },
                }
              : {}),
            execute: async (args, context) => {
              await assertAllowed(context.workspaceRoot, args)
              return tool.execute(args, context)
            },
          }),
      }),
  }
}

function agentSettings(agent: AgentRecord): AgentSettings {
  const path = resolveCommand(agent.command)
  const verdict = validateAgentDefinition(agent)
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.presetId ? { presetId: agent.presetId } : {}),
    command: agent.command,
    args: [...agent.args],
    envKeys: Object.keys(agent.env).sort(),
    enabled: agent.enabled,
    detected: path ? { found: true, path } : { found: false },
    verified: verdict.ok ? verdict.verified : false,
    ...(verdict.ok ? {} : { problem: verdict.error.message }),
  }
}

/** Hash of what an agent definition would run; values of env entries only as one digest. */
function definitionHash(agent: Pick<AgentRecord, 'command' | 'args' | 'env' | 'presetId'>): string {
  return sha256Hex(
    canonicalJson({
      command: agent.command,
      args: agent.args,
      envNames: Object.keys(agent.env).sort(),
      envValues: sha256Hex(canonicalJson(agent.env)),
      presetId: agent.presetId,
    }),
  )
}

function parseArguments(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The built-in file writer, as `<owner>:<tool>`; the risk classifier keys it the same way. */
const BUILTIN_WRITE = 'workspace-files:write_file'

/**
 * Arguments as the R2 confirmation shows them. Only the built-in writer's string `content` becomes its size and hash:
 * its diff shows that text, and `previewHash` still binds it in full. Any other tool's `content` may be the substance
 * of the call (a command, a script), so it appears whole; the preview limit fails closed instead of shortening it.
 */
function previewArguments(args: Record<string, unknown>, builtinWrite: boolean): Record<string, unknown> {
  if (!builtinWrite || typeof args.content !== 'string') return args
  return { ...args, content: `「${Buffer.byteLength(args.content, 'utf8')} 字节，哈希 ${hashDisplay(sha256Hex(args.content))}」` }
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return a === 'R2' || b === 'R2' ? 'R2' : a === 'R1' || b === 'R1' ? 'R1' : 'R0'
}

function assertLoopbackHost(host: string | undefined): void {
  if (host === undefined || host === '127.0.0.1' || host === 'localhost' || host === '::1') return
  throw new Error('明文局域网接入已移除：请提供 --tls-cert、--tls-key 和 --public-origin（例如用 tailscale cert 生成的证书）。')
}

async function prepareDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const stats = await lstat(dataDir)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!stats.isDirectory() || stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid)) {
    throw new AppError(500, 'data-dir-insecure', `数据目录 ${dataDir} 不属于当前用户或不是目录，已拒绝启动。`)
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) await chmod(dataDir, 0o700)
}

/** One Host holds tasks while any number of clients reconnect, over host.sock, loopback and optional TLS. */
export async function startServer(options: ServerOptions): Promise<StartedHost> {
  assertLoopbackHost(options.host)
  if (options.provider) assertEnvBaseURL(options.provider.baseURL)
  const now = options.now ?? Date.now
  const sink = options.log ?? (text => console.error(`[Latch] ${text}`))
  const log = (text: string) => sink(redactSecrets(text))
  const startedAt = new Date().toISOString()
  const dataDir = resolve(options.dataDir)
  const workspaceRoot = resolve(options.workspaceRoot)
  await prepareDataDir(dataDir)
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
  const realDataDir = await realpath(dataDir)
  const realWorkspace = await realpath(workspaceRoot)
  const codeRoot = options.codeRoot ?? latchCodeRoot()
  const home = homedir()
  const agentsDir = resolve(
    options.agentsDir ?? resolveLatchPaths({ dataDir, workspace: workspaceRoot, env: process.env, cwd: process.cwd() }).agentsDir,
  )
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const authDir = join(dataDir, 'auth')

  const audit = await AuditLog.open(join(dataDir, 'audit'), { now })
  const startupCleanup: Array<() => void | Promise<void>> = [() => audit.close()]
  try {
    const identity = await loadOrCreateHostIdentity(dataDir)
    const { hostId, hostId8 } = identity
    const policy = await PolicyStore.open({ dataDir, audit })
    const devices = await DeviceStore.open({ directory: authDir, hostId, audit, now })
    startupCleanup.push(() => devices.close())
    const runtime = await prepareRuntimeDir({ hostId8, ...(options.runtimeParent ? { parent: options.runtimeParent } : {}) })
    const config = await HostConfig.open(dataDir)

    let tls: ValidatedTls | undefined
    if (options.tls) {
      await checkPrivateFile(options.tls.keyPath, {
        uid,
        label: 'HTTPS 私钥',
        notInside: [
          realDataDir,
          realWorkspace,
          ...(await Promise.all(config.settings().workspaces.map(item => realpath(item.path).catch(() => item.path)))),
        ],
      })
      tls = await validateTls(options.tls, now(), log)
    }

    const instanceId = randomUUID()
    const registry = new PluginRegistry()
    startupCleanup.push(() => registry.close())
    const buildAgentPlugin = options.agentPlugin ?? ((agent: AgentRecord) => createAcpAgentPlugin(agent, { log }))
    const egressExtra = [...(options.egressAllow ?? [])]
    const egressFetch = createEgressFetch({
      allow: () => [...policy.get().hostEgressAllow, ...egressExtra],
      ...(options.egressLookup ? { lookup: options.egressLookup } : {}),
    })
    let hub: HarnessHub | undefined
    const presence = new PresenceService({
      backend: options.presence ?? createPresenceBackend({ codeRoot, policy }),
      hostId,
      audit,
      now,
      blockedReason: async () => (hub && (await hub.hasUnsandboxedActivity()) ? BLOCKED_REASON : undefined),
    })
    const enrollments = new EnrollmentService({ hostId, devices, presence, audit, directory: authDir, now })
    const limits = createRateLimits(options.rateLimits ?? 'default', now)
    /** Hashes of invitation codes this Host handed out, with their expiry; only these get their own enrollment budget. */
    const issuedInvitations = new Map<string, number>()
    function pruneInvitations(): void {
      const current = now()
      for (const [hash, expiresAt] of issuedInvitations) if (expiresAt < current) issuedInvitations.delete(hash)
    }
    function invitationIssued(hash: string): boolean {
      pruneInvitations()
      return issuedInvitations.has(hash)
    }
    const tlsKeyPath = options.tls ? resolve(options.tls.keyPath) : undefined

    const workspaceGuard: Omit<WorkspaceGuardContext, 'existing'> = {
      dataDir: realDataDir,
      agentsDir,
      runtimeDir: runtime.runtimeDir,
      home,
      codeRoot,
      ...(tlsKeyPath ? { tlsKeyPath } : {}),
    }
    const defaultFlags = await classifyDefaultWorkspace(realWorkspace, { ...workspaceGuard, existing: [] })
    if (defaultFlags.sensitive) throw new AppError(409, 'workspace-overlap', defaultFlags.sensitive.message)
    if (defaultFlags.insideData) log(`工作区位于数据目录内（${realWorkspace}）。迁出之前只能使用内置 Harness。`)
    if (defaultFlags.codeRoot)
      log(`工作区与 Latch 程序目录重叠（${realWorkspace}），内置 Harness 的每次写入都需要在本机确认，ACP Agent 不可用。`)
    // Path spellings (case, firmlinks) differ between APIs; code-root decisions compare canonical forms only.
    const canonicalCodeRoot = await canonicalPath(codeRoot)
    const canonicalWorkspace = await canonicalPath(realWorkspace)
    const denyRead = await Promise.all(DENY_READ_HOME_PATHS.map(entry => realpath(join(home, entry)).catch(() => join(home, entry))))
    const guardedPaths = [
      ...(await protectedDataPaths(realDataDir, realWorkspace)),
      runtime.runtimeDir,
      agentsDir,
      ...(tlsKeyPath ? [tlsKeyPath] : []),
      ...denyRead,
    ]

    const startupActor: AuditActor = { listener: 'host', via: 'startup' }
    // The last settings this Host knowingly started with or wrote; a write whose commit failed leaves its previous state.
    const settingsHash = sha256Hex(canonicalJson(config.settings()))
    const lastSettings = audit.latest(['host.started', 'settings.changed'])
    let expectedSettings = String(
      !lastSettings ? '' : lastSettings.action === 'host.started' ? lastSettings.detail.settingsHash : lastSettings.detail.after,
    )
    if (
      settingsHash !== expectedSettings
      && lastSettings?.action === 'settings.changed'
      && settingsHash === lastSettings.detail.before
      && (await markedFailed(join(dataDir, 'audit', 'audit.jsonl'), lastSettings.seq))
    )
      expectedSettings = settingsHash
    if (
      settingsHash !== expectedSettings
      && (lastSettings
        || (await lstat(join(dataDir, 'settings.json')).then(
          () => true,
          () => false,
        )))
    ) {
      await audit.append({
        action: 'settings.changed-outside',
        actor: startupActor,
        detail: { expected: expectedSettings, actual: settingsHash },
      })
      log('settings.json 在 Latch 之外被修改过，已记入审计；其中的项目已重新检查。')
    }
    /** Saved workspaces that fail the registration rules (minus the duplicate rule): kept in settings, unusable for this run. */
    const disabledWorkspaces = new Map<string, AppError>()
    for (const item of config.settings().workspaces) {
      const verdict = await checkWorkspaceCandidate(item.path, { ...workspaceGuard, existing: [] }).catch(() => undefined)
      if (verdict?.ok) continue
      const error = verdict?.error ?? new AppError(400, 'workspace-invalid', '目录不存在或无法访问')
      disabledWorkspaces.set(item.id, error)
      log(`项目「${item.name}」未通过安全检查，本次运行已停用：${error.message}`)
      // Disabling only removes access, so a failed record never keeps the workspace usable.
      await audit
        .append({
          action: 'workspace.disabled',
          actor: startupActor,
          target: item.id,
          detail: { workspaceId: item.id, reason: disabledReason(error) },
        })
        .catch(cause => log(`审计记录写入失败（workspace.disabled）：${errorText(cause)}`))
    }

    const savedLegacy = config.provider(LEGACY_PROVIDER_ID)
    /**
     * Live `openai-compatible` while `HARNESS_MODEL` is set: the environment's connection with the saved
     * name and switch. Owner edits apply to it in memory and to the saved record; the environment's key is never written.
     */
    let envProvider: ProviderRecord | undefined = options.provider && {
      id: LEGACY_PROVIDER_ID,
      name: savedLegacy?.name ?? 'OpenAI 兼容接口',
      kind: 'openai-compatible',
      baseURL: options.provider.baseURL,
      apiKey: options.provider.apiKey,
      ...(options.provider.apiKey ? { keyOrigin: originOf(options.provider.baseURL) } : {}),
      enabled: savedLegacy?.enabled ?? true,
      models: [options.provider.model.trim()],
      defaultModel: options.provider.model.trim(),
    }
    /** Agent plugin ID → agent ID, so plugin toggles find their definition. */
    const agentPlugins = new Map<string, string>()
    const disabled = new Set(config.settings().plugins.disabled)
    registry.register(
      {
        id: 'standard-harness',
        name: 'Standard Harness',
        version: '0.1.0',
        description: '内置对话与 Agent 执行机制；其他 Harness 可通过插件接入。',
        activate(ctx) {
          ctx.registerHarness(standardHarnessDriver)
        },
      },
      { managed: 'core' },
    )
    await registry.enable('standard-harness')
    const workspaceFiles = createWorkspacePlugin({ protectedPaths: guardedPaths })
    const optional = [
      isWithin(realWorkspace, realDataDir) ? guardDataDir(workspaceFiles, realDataDir, realWorkspace) : workspaceFiles,
      ...(options.demo ? [createToolsPlugin(), createDemoPlugin()] : []),
      ...(options.plugins ?? []),
    ]
    for (const plugin of optional) {
      registry.register(plugin)
      if (!disabled.has(plugin.id)) await registry.enable(plugin.id)
    }
    // Saved definitions must not prevent the Host from starting; a broken one is logged and left disabled.
    for (const record of effectiveProviders()) {
      try {
        registry.register(buildProviderPlugin(record), { managed: 'provider' })
      } catch (error) {
        log(`模型服务 ${record.id} 未加载：${errorText(error)}`)
        continue
      }
      if (record.enabled) await registry.enable(record.id).catch(error => log(`模型服务 ${record.id} 启用失败：${errorText(error)}`))
    }
    for (const agent of config.settings().agents)
      await installAgent(agent).catch(error => log(`Agent ${agent.id} 未加载：${errorText(error)}`))

    const harnessHub = await HarnessHub.open({ dataDir, defaultId: defaultHarnessId, log })
    hub = harnessHub
    startupCleanup.push(() => harnessHub.close())
    const requiredHarness = options.harnessId ?? STANDARD
    if (!registry.harnesses().some(driver => driver.id === requiredHarness)) {
      throw new AppError(409, 'harness-unavailable', `请先配置并启用 Harness ${requiredHarness}`)
    }
    for (const driver of registry.harnesses()) await mount(driver, driver.id === requiredHarness)

    let revision = 0
    const streams = new Map<ServerResponse, EventStream>()
    const pendingTasks = new Map<string, number>()
    const summaries = new Map<string, string>()
    const decisions = new Map<string, DecisionRecord>()
    // One decision per approval at a time, so a retried request sees the first one's outcome.
    const decisionLocks = new Map<string, Promise<void>>()
    let pendingGlobal = false
    let eventTimer: ReturnType<typeof setTimeout> | undefined
    let flushing = false
    let changes: Promise<void> = Promise.resolve()
    let closing = false
    let shutdown: Promise<void> | undefined
    let listeners: ListenerSet | undefined
    let loopbackOrigin = ''
    let tlsOrigin: string | undefined

    // ---- Callers, scopes and audit ---------------------------------------------------------------

    function actorOf(caller: Caller): AuditActor {
      return caller.device
        ? { deviceId: caller.device.id, listener: caller.connection.listener, via: 'http' }
        : { listener: caller.connection.listener, via: 'cli' }
    }

    function requireDevice(caller: Caller): asserts caller is DeviceCaller {
      if (!caller.device) throw authFailure('unauthorized')
    }

    function requireScope(caller: Caller, scope: DeviceScope): asserts caller is DeviceCaller {
      requireDevice(caller)
      if (!caller.device.scopes.includes(scope)) throw scopeRequired(scope)
    }

    function requireUnix(caller: Caller): void {
      if (caller.connection.listener !== 'unix') throw localOnly()
    }

    /** Re-checks a caller after an await: a queued or slow request may outlive a revocation or a scope change. */
    function recheck(caller: Caller, scope?: DeviceScope): void {
      if (!caller.device) return
      const current = devices.get(caller.device.id)
      if (!current || !devices.isActive(current.id)) throw authFailure('device-revoked')
      if (scope && !current.scopes.includes(scope)) throw scopeRequired(scope)
    }

    /** Serializes configuration changes; each re-checks the caller first. */
    function serial<T>(caller: Caller, scope: DeviceScope | undefined, operation: () => Promise<T>): Promise<T> {
      const change = changes.then(() => {
        recheck(caller, scope)
        return operation()
      })
      changes = change.then(
        () => {},
        () => {},
      )
      return change
    }

    /**
     * Appends before the action takes effect. Privilege-granting actions fail with the audit; reducing
     * ones (`tolerant`) still proceed and the response says the record is missing.
     */
    async function audited(event: AuditEvent, tolerant?: ServerResponse): Promise<number | undefined> {
      try {
        return (await audit.append(event)).seq
      } catch (error) {
        if (!tolerant) throw error
        log(`审计记录写入失败（${event.action}）：${errorText(error)}`)
        if (!tolerant.headersSent) tolerant.setHeader('x-latch-audit', 'failed')
        return undefined
      }
    }

    /** Best effort: marks an audited intent whose commit then failed. */
    function auditFailed(refSeq: number | undefined, caller: Caller): void {
      if (refSeq === undefined) return
      void audit
        .append({ action: 'action.failed', actor: actorOf(caller), detail: { refSeq } })
        .catch(error => log(`审计记录写入失败：${errorText(error)}`))
    }

    /**
     * Local presence confirmation for one exact request. Without `x-latch-confirmation` it starts a
     * confirmation and answers 403 stepup-required with the ticket; with it, it consumes the approved
     * confirmation for exactly these parameters.
     */
    async function confirm(
      req: IncomingMessage,
      caller: Caller,
      action: PresenceAction,
      params: Record<string, unknown>,
      lines: PreviewLine[],
      warnings: string[] = [],
    ): Promise<StepupMethod> {
      requireUnix(caller)
      requireDevice(caller)
      const hash = paramsHash(action, params)
      const header = req.headers['x-latch-confirmation']
      if (typeof header === 'string' && header) {
        presence.consume(header, { action, requesterDeviceId: caller.device.id, paramsHash: hash })
        return 'lpc-local'
      }
      const record = await presence.request({
        action,
        paramsHash: hash,
        lines,
        warnings,
        requester: { deviceId: caller.device.id, deviceName: caller.device.name, listener: 'unix', remoteAddress: UNIX_ADDRESS },
      })
      throw stepupRequired(publicTicket(record))
    }

    function currentDevice(caller: DeviceCaller): CurrentDevice {
      const device = devices.get(caller.device.id) ?? caller.device
      return { ...device, current: true, renewAfter: new Date(caller.renewAfter ?? now() + RENEW_INTERVAL_MS).toISOString() }
    }

    async function presenceStatus(): Promise<HostView['presence']> {
      const availability = await presence.availability()
      return availability.status === 'available' ? { status: 'available' } : { status: 'unavailable', message: availability.message }
    }

    async function hostView(): Promise<HostView> {
      const current = policy.get()
      return {
        hostId,
        devMode: true,
        presence: await presenceStatus(),
        tls: tlsOrigin ? { origin: tlsOrigin } : null,
        policy: { localMaxLevel: current.local.maxLevel, remoteMaxLevel: current.remote.maxLevel, allowL3: current.local.allowL3 },
      }
    }

    // ---- Providers -------------------------------------------------------------------------------

    function effectiveProviders(): ProviderRecord[] {
      const stored = config.providers()
      if (!envProvider) return stored
      const overlay = structuredClone(envProvider)
      return stored.some(record => record.id === overlay.id)
        ? stored.map(record => (record.id === overlay.id ? overlay : record))
        : [...stored, overlay]
    }

    function effectiveProvider(id: string): ProviderRecord | undefined {
      return effectiveProviders().find(record => record.id === id)
    }

    function buildProviderPlugin(record: ProviderRecord): HarnessPlugin {
      try {
        return providerPlugin(record, { fetch: egressFetch })
      } catch (error) {
        throw error instanceof AppError ? error : new AppError(400, 'invalid-provider', errorText(error))
      }
    }

    function pluginInfo(id: string): PluginInfo | undefined {
      return registry.list().find(plugin => plugin.id === id)
    }

    /** Provider and plugin IDs share one namespace: the provider's plugin uses the provider ID. */
    function usedIds(): Set<string> {
      const plugins = registry
        .list()
        .flatMap(plugin => [
          plugin.id,
          ...plugin.capabilities.filter(item => item.startsWith('provider:')).map(item => item.slice('provider:'.length)),
        ])
      return new Set([...plugins, ...effectiveProviders().map(record => record.id)])
    }

    /** `agent-` is reserved for agent plugins. */
    function idTaken(id: string): boolean {
      return id.startsWith('agent-') || usedIds().has(id)
    }

    function newProviderId(base: string): string {
      const used = usedIds()
      const id = availableId(base, used)
      return id.startsWith('agent-') ? availableId(`provider-${id}`, used) : id
    }

    function providerKindOf(id: string): ProviderSummary['kind'] {
      const record = effectiveProvider(id)
      if (record && pluginInfo(id)?.managed === 'provider') return record.kind
      return id === 'demo' && options.demo ? 'demo' : 'plugin'
    }

    /**
     * Applies an owner edit to a provider, as [live, saved]. Under `HARNESS_MODEL` the same edit applies
     * to the saved record, or to the overlay without its key, so the environment's key stays live and
     * never reaches the disk.
     */
    function editProvider(id: string, edit: (record: ProviderRecord) => ProviderRecord): [ProviderRecord, ProviderRecord] | undefined {
      const live = effectiveProvider(id)
      if (!live) return undefined
      if (envProvider?.id !== id) {
        const next = edit(live)
        return [next, next]
      }
      const { keyOrigin: _origin, ...withoutKey } = live
      return [edit(live), edit(config.provider(id) ?? { ...withoutKey, apiKey: '' })]
    }

    /** Persists `saved` and swaps the live plugin to `live` in one step; a failed write keeps the previous generation. */
    async function saveProvider(caller: Caller, live: ProviderRecord, saved = live): Promise<void> {
      const plugin = buildProviderPlugin(live)
      if (saved !== live) buildProviderPlugin(saved)
      const before = pluginInfo(live.id)
      const disabling = Boolean(before?.enabled && !live.enabled)
      if (disabling) await registry.disable(live.id)
      try {
        await config.updateProviders(
          draft => {
            const index = draft.findIndex(record => record.id === saved.id)
            if (index < 0) draft.push(structuredClone(saved))
            else draft[index] = structuredClone(saved)
          },
          async (_providers, commit) => {
            recheck(caller, 'admin')
            if (before) await registry.replace(plugin, commit, { managed: 'provider', preserveEnabled: true })
            else {
              await commit()
              registry.register(plugin, { managed: 'provider' })
            }
          },
        )
      } catch (error) {
        if (disabling) await registry.enable(live.id).catch(cause => log(`模型服务 ${live.id} 恢复失败：${errorText(cause)}`))
        throw error
      }
      if (envProvider?.id === live.id) envProvider = structuredClone(live)
      if (live.enabled && !pluginInfo(live.id)?.enabled) await registry.enable(live.id)
    }

    async function deleteProvider(caller: Caller, id: string): Promise<void> {
      const current = effectiveProvider(id)
      if (!current || (pluginInfo(id) && pluginInfo(id)?.managed !== 'provider'))
        throw new AppError(404, 'provider-not-found', '找不到该模型服务')
      if (pluginInfo(id)?.activeRuns) throw new AppError(409, 'provider-in-use', '有任务正在使用该模型服务，请结束后再删除')
      let unregistered = false
      try {
        await config.updateProviders(
          draft => {
            const index = draft.findIndex(record => record.id === id)
            if (index >= 0) draft.splice(index, 1)
          },
          async () => {
            recheck(caller, 'admin')
            if (pluginInfo(id)) {
              await registry.unregister(id)
              unregistered = true
            }
          },
        )
      } catch (error) {
        if (unregistered) {
          registry.register(buildProviderPlugin(current), { managed: 'provider' })
          if (current.enabled) await registry.enable(id).catch(cause => log(`模型服务 ${id} 恢复失败：${errorText(cause)}`))
        }
        throw error
      }
      if (envProvider?.id === id) envProvider = undefined
    }

    function egressDenied(target: string): AppError {
      return new AppError(
        403,
        'egress-denied',
        `Host 不会访问 ${target}（本机、私网或元数据地址）。如需访问本机模型服务，请在本机确认后加入出站白名单。`,
        { target },
      )
    }

    /** Lists remote models; the upstream call stops if the requesting client goes away first. */
    async function remoteModels(res: ServerResponse, input: ModelListInput, check = false) {
      const controller = new AbortController()
      const abort = () => {
        if (!res.writableFinished) controller.abort(new Error('Client disconnected'))
      }
      res.once('close', abort)
      try {
        return check
          ? await checkProvider(input, controller.signal, { fetch: egressFetch })
          : { models: await listProviderModels(input, controller.signal, { fetch: egressFetch }) }
      } catch (error) {
        if (error instanceof AppError) throw error
        const code = codeOf(error) ?? 'provider-error'
        if (code === 'egress-denied') {
          const target =
            error instanceof Error && 'target' in error && typeof error.target === 'string' ? error.target : new URL(input.baseURL).host
          throw egressDenied(target)
        }
        const reported = error instanceof Error && error.name === 'ProviderError'
        throw new AppError(
          reported && PROVIDER_INPUT_ERRORS.has(code) ? 400 : 502,
          code,
          reported ? error.message : '无法连接模型服务，请检查地址与网络',
        )
      } finally {
        res.off('close', abort)
      }
    }

    function keyLines(record: Pick<ProviderRecord, 'id' | 'name'>, origin: string): PreviewLine[] {
      return [
        { label: '模型服务', value: `${record.name}（${record.id}）` },
        { label: '地址', value: origin },
        { label: '密钥', value: '已提供（不显示）' },
      ]
    }

    /** Setting a key: admin + secrets on host.sock, confirmed locally, audited before it is saved. */
    async function confirmKey(
      req: IncomingMessage,
      caller: Caller,
      record: Pick<ProviderRecord, 'id' | 'name'>,
      baseURL: string,
      apiKey: string,
    ): Promise<{ origin: string; stepup: StepupMethod }> {
      requireScope(caller, 'secrets')
      requireUnix(caller)
      const origin = originOf(baseURL)
      const stepup = await confirm(
        req,
        caller,
        'provider.set-key',
        { providerId: record.id, origin, keyHash: sha256Hex(apiKey) },
        keyLines(record, origin),
      )
      return { origin, stepup }
    }

    // ---- Harnesses and agents --------------------------------------------------------------------

    function sourceOf(driver: HarnessDriver): HarnessSource {
      if (driver.id === STANDARD) return 'builtin'
      const owner = registry.list().find(plugin => plugin.capabilities.includes(`harness:${driver.id}`))
      return owner?.managed === 'agent' ? 'acp' : 'plugin'
    }

    function harnessPlugin(harnessId: string): PluginInfo | undefined {
      return registry.list().find(plugin => plugin.capabilities.includes(`harness:${harnessId}`))
    }

    function toolOwner(toolName: string): string | undefined {
      return registry.list().find(plugin => plugin.enabled && plugin.capabilities.includes(`tool:${toolName}`))?.id
    }

    /** Whether a Standard call goes to the built-in file writer, with the owner resolved as the risk classifier resolves it. */
    function isBuiltinWrite(toolName: string): boolean {
      const owner = toolOwner(toolName)
      return owner !== undefined && `${owner}:${toolName}` === BUILTIN_WRITE
    }

    /**
     * The session root in canonical form and whether it overlaps the code root. The per-call answer is never weaker than
     * the startup classification; a directory that cannot be resolved counts as overlapping, the stricter answer.
     */
    async function workspaceOf(cwd: string | undefined): Promise<{ codeRoot: boolean; root?: string }> {
      try {
        const root = await canonicalPath(cwd ?? workspaceRoot)
        return { codeRoot: (defaultFlags.codeRoot && root === canonicalWorkspace) || overlaps(root, canonicalCodeRoot), root }
      } catch {
        return { codeRoot: true }
      }
    }

    async function classifyCall(input: { toolName: string; arguments: Record<string, unknown>; cwd?: string }) {
      return classifyStandardCall({
        pluginId: toolOwner(input.toolName),
        toolName: input.toolName,
        args: input.arguments,
        demo: options.demo,
        workspace: await workspaceOf(input.cwd),
      })
    }

    async function classifyToolCall(input: ToolRiskInput): Promise<RiskLevel> {
      return (await classifyCall(input)).risk
    }

    function securityEvent(event: HarnessSecurityEvent): void {
      try {
        const actor: AuditActor = { listener: 'host' }
        if (event.type === 'permission-drift') {
          void audit
            .append({
              action: 'task.permission-drift',
              actor,
              target: event.sessionId,
              detail: { sessionId: event.sessionId, observedHash: event.observedHash },
            })
            .catch(error => log(`审计记录写入失败：${errorText(error)}`))
        } else if (event.type === 'approval-auto-rejected') {
          void audit
            .append({
              action: 'task.approval-auto-rejected',
              actor,
              target: event.sessionId,
              detail: { sessionId: event.sessionId, reason: event.reason },
            })
            .catch(error => log(`审计记录写入失败：${errorText(error)}`))
        } else {
          log(`会话 ${event.sessionId} 无法确认权限模式，未发送输入。`)
        }
        refresh(event.sessionId)
      } catch (error) {
        log(`安全事件处理失败：${errorText(error)}`)
      }
    }

    async function mount(driver: HarnessDriver, required = false): Promise<void> {
      const source = sourceOf(driver)
      const lease = registry.acquireHarness(driver.id)
      await hub!.attach(driver, {
        source,
        required,
        release: () => lease.release(),
        create: () =>
          driver.create({
            dataDir: driver.id === STANDARD ? join(dataDir, 'sessions') : join(dataDir, 'harnesses', driver.id),
            workspaceRoot,
            workspaces: () => workspaces().map(workspace => workspace.path),
            registry,
            providerId: defaultProviderId,
            defaultModel: savedDefaultModel,
            tmpRoot: runtime.tmpRoot,
            securityEvent,
            ...(source === 'builtin' ? { classifyToolCall } : {}),
          }),
      })
    }

    function pluginHarnesses(pluginId: string): string[] {
      const ids = (pluginInfo(pluginId)?.capabilities ?? [])
        .filter(item => item.startsWith('harness:'))
        .map(item => item.slice('harness:'.length))
      const agentId = agentPlugins.get(pluginId)
      return agentId && !ids.includes(agentId) ? [...ids, agentId] : ids
    }

    /** Detaches a plugin's drivers; refuses while their sessions run. */
    async function unmountPlugin(pluginId: string): Promise<void> {
      const ids = pluginHarnesses(pluginId)
      if (options.harnessId && ids.includes(options.harnessId))
        throw new AppError(409, 'harness-locked', '启动参数指定的默认 Harness 不能停用')
      for (const id of ids) await hub!.detach(id)
    }

    async function mountPlugin(pluginId: string): Promise<void> {
      const ids = new Set(pluginHarnesses(pluginId))
      for (const driver of registry.harnesses()) {
        if (ids.has(driver.id) && !hub!.has(driver.id))
          await mount(driver).catch(error => log(`Harness ${driver.id} 加载失败：${errorText(error)}`))
      }
    }

    async function installAgent(agent: AgentRecord): Promise<void> {
      const plugin = buildAgentPlugin(agent)
      registry.register(plugin, { managed: 'agent' })
      agentPlugins.set(plugin.id, agent.id)
      if (agent.enabled) await registry.enable(plugin.id)
    }

    function agentPluginId(agentId: string): string | undefined {
      for (const [pluginId, id] of agentPlugins) if (id === agentId) return pluginId
    }

    async function removeAgentPlugin(agentId: string): Promise<void> {
      const pluginId = agentPluginId(agentId)
      if (!pluginId) return
      agentPlugins.delete(pluginId)
      if (pluginInfo(pluginId)) await registry.unregister(pluginId)
    }

    function buildAgent(next: AgentRecord): HarnessPlugin {
      try {
        return buildAgentPlugin(next)
      } catch (error) {
        throw error instanceof AppError ? error : new AppError(400, 'invalid-agent', errorText(error))
      }
    }

    /** Replaces a definition: the old driver detaches first (409 while it runs), then the new one mounts. */
    async function saveAgent(caller: Caller, next: AgentRecord, created: boolean): Promise<void> {
      const plugin = buildAgent(next)
      const previous = agentPluginId(next.id)
      if (plugin.id !== previous && pluginInfo(plugin.id)) throw new AppError(409, 'agent-exists', `插件标识 ${plugin.id} 已被占用`)
      if (previous) await unmountPlugin(previous)
      try {
        await writeSettings(caller, draft => {
          const index = draft.agents.findIndex(agent => agent.id === next.id)
          if (index < 0) draft.agents.push(structuredClone(next))
          else draft.agents[index] = structuredClone(next)
        })
      } catch (error) {
        if (previous && !created) await mountPlugin(previous)
        throw error
      }
      await removeAgentPlugin(next.id).catch(error => log(`Agent ${next.id} 旧插件清理失败：${errorText(error)}`))
      registry.register(plugin, { managed: 'agent' })
      agentPlugins.set(plugin.id, next.id)
      if (!next.enabled) return
      await registry.enable(plugin.id)
      await mountPlugin(plugin.id)
    }

    async function deleteAgent(caller: Caller, id: string, res: ServerResponse): Promise<void> {
      if (!config.settings().agents.some(agent => agent.id === id)) throw new AppError(404, 'agent-not-found', '找不到该 Agent')
      const pluginId = agentPluginId(id)
      if (pluginId) await unmountPlugin(pluginId)
      await audited({ action: 'agent.deleted', actor: actorOf(caller), target: id, detail: { agentId: id } }, res)
      try {
        await writeSettings(caller, draft => {
          draft.agents = draft.agents.filter(agent => agent.id !== id)
        })
      } catch (error) {
        if (pluginId) await mountPlugin(pluginId)
        throw error
      }
      await removeAgentPlugin(id).catch(error => log(`Agent ${id} 插件清理失败：${errorText(error)}`))
    }

    async function setPluginEnabled(caller: Caller, id: string, enabled: boolean): Promise<void> {
      const info = pluginInfo(id)
      if (!info) throw new AppError(404, 'plugin-not-found', '找不到该插件')
      if (info.managed === 'core') throw new AppError(409, 'plugin-locked', '内置插件不能停用')
      if (info.managed === 'provider') {
        const record = effectiveProvider(id)
        if (!record) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
        if (record.enabled !== enabled) await saveProvider(caller, ...editProvider(id, current => ({ ...current, enabled }))!)
        return
      }
      if (info.managed === 'agent') {
        const agent = config.settings().agents.find(item => item.id === agentPlugins.get(id))
        if (!agent) throw new AppError(404, 'agent-not-found', '找不到该 Agent')
        if (agent.enabled !== enabled) await saveAgent(caller, { ...agent, enabled }, false)
        return
      }
      const persist = () =>
        writeSettings(caller, draft => {
          const rest = draft.plugins.disabled.filter(item => item !== id)
          draft.plugins.disabled = enabled ? rest : [...rest, id]
        })
      if (enabled) {
        await registry.enable(id)
        try {
          await persist()
        } catch (error) {
          await registry.disable(id).catch(cause => log(`插件 ${id} 回滚失败：${errorText(cause)}`))
          throw error
        }
        await mountPlugin(id)
        return
      }
      await unmountPlugin(id)
      try {
        await registry.disable(id)
      } catch (error) {
        await mountPlugin(id)
        throw error
      }
      try {
        await persist()
      } catch (error) {
        await registry.enable(id).then(
          () => mountPlugin(id),
          cause => log(`插件 ${id} 回滚失败：${errorText(cause)}`),
        )
        throw error
      }
    }

    // ---- Workspaces and defaults -----------------------------------------------------------------

    /**
     * Every settings write the Host makes is recorded with its before and after hashes, so the next start can tell it
     * from an edit made outside Latch. The record is a baseline, not the action's own audit, so a failed append only logs.
     */
    function writeSettings(caller: Caller, mutate: (draft: HostSettings) => void): Promise<void> {
      return config.updateSettings(mutate, async (next, commit) => {
        recheck(caller, 'admin')
        const before = sha256Hex(canonicalJson(config.settings()))
        const after = sha256Hex(canonicalJson(next))
        if (before === after) return
        let seq: number | undefined
        try {
          seq = (await audit.append({ action: 'settings.changed', actor: actorOf(caller), detail: { before, after } })).seq
        } catch (error) {
          log(`审计记录写入失败（settings.changed）：${errorText(error)}`)
        }
        try {
          await commit()
        } catch (error) {
          auditFailed(seq, caller)
          throw error
        }
      })
    }

    function guardContext(): WorkspaceGuardContext {
      return { ...workspaceGuard, existing: savedWorkspaces().map(item => ({ id: item.id, name: item.name, path: item.path })) }
    }

    /** Every workspace in settings. One disabled for this run carries the reason, so it can still be listed and removed. */
    function savedWorkspaces(): WorkspaceInfo[] {
      return [
        { id: 'default', name: '默认工作区', path: workspaceRoot },
        ...config.settings().workspaces.map(item => {
          const disabled = disabledWorkspaces.get(item.id)
          return {
            id: item.id,
            name: item.name,
            path: item.path,
            ...(disabled ? { unavailable: `未通过安全检查，本次运行已停用：${disabled.message}` } : {}),
          }
        }),
      ]
    }

    /** Workspaces sessions may use. */
    function workspaces(): WorkspaceInfo[] {
      return savedWorkspaces().filter(item => item.unavailable === undefined)
    }

    function workspaceDisabled(workspace: WorkspaceInfo, error: AppError): AppError {
      return new AppError(409, 'workspace-disabled', `项目「${workspace.name}」未通过安全检查，暂不可用：${error.message}`)
    }

    /** Refuses a saved workspace that is disabled for this run or no longer passes the registration rules. */
    async function assertWorkspaceUsable(workspace: WorkspaceInfo): Promise<void> {
      if (workspace.id === 'default') return
      const disabled = disabledWorkspaces.get(workspace.id)
      if (disabled) throw workspaceDisabled(workspace, disabled)
      // The directory layout may have changed since startup.
      const verdict = await checkWorkspaceCandidate(workspace.path, { ...workspaceGuard, existing: [] })
      if (!verdict.ok) throw workspaceDisabled(workspace, verdict.error)
    }

    /** New turns in a session whose directory belongs to a disabled workspace are refused. */
    async function assertSessionWorkspace(sessionId: string): Promise<void> {
      if (!disabledWorkspaces.size) return
      const cwd = (await hub!.listTasks()).find(task => task.id === sessionId)?.cwd
      // An unresolvable directory is refused by the driver itself.
      const root = await canonicalPath(cwd ?? workspaceRoot).catch(() => undefined)
      if (root === undefined || root === canonicalWorkspace) return
      for (const workspace of savedWorkspaces()) {
        const error = disabledWorkspaces.get(workspace.id)
        if (error && root === (await canonicalPath(workspace.path).catch(() => undefined))) throw workspaceDisabled(workspace, error)
      }
    }

    async function addWorkspace(caller: Caller, input: z.infer<typeof workspaceSchema>): Promise<WorkspaceInfo> {
      if (!isAbsolute(input.path) || input.path.includes('\0')) throw new AppError(400, 'workspace-invalid', '请填写项目目录的绝对路径')
      const verdict = await checkWorkspaceCandidate(input.path, guardContext())
      if (!verdict.ok) throw verdict.error
      const path = verdict.realPath
      // An ID the policy still names is never handed to another directory: re-adding under it would widen remote access without a confirmed policy change.
      const taken = [...savedWorkspaces().map(item => item.id), ...(policy.get().remote.workspaces ?? [])]
      const workspace = { id: availableId(input.name ?? basename(path), taken), name: input.name ?? (basename(path) || path), path }
      const seq = await audited({
        action: 'workspace.added',
        actor: actorOf(caller),
        target: workspace.id,
        detail: { workspaceId: workspace.id, pathHash: sha256Hex(path) },
      })
      try {
        await writeSettings(caller, draft => {
          draft.workspaces.push(workspace)
        })
      } catch (error) {
        auditFailed(seq, caller)
        throw error
      }
      return workspace
    }

    async function removeWorkspace(caller: Caller, id: string, res: ServerResponse): Promise<void> {
      if (id === 'default') throw new AppError(409, 'workspace-default', '默认工作区不能移除')
      const workspace = config.settings().workspaces.find(item => item.id === id)
      if (!workspace) throw new AppError(404, 'workspace-not-found', '找不到该项目')
      const real = await realpath(workspace.path).catch(() => workspace.path)
      for (const task of await hub!.listTasks()) {
        if (
          (task.status === 'running' || task.status === 'waiting-approval')
          && task.cwd
          && (task.cwd === workspace.path || (await realpath(task.cwd).catch(() => task.cwd)) === real)
        ) {
          throw new AppError(409, 'workspace-in-use', '有会话正在该项目中运行，请结束后再移除')
        }
      }
      await audited(
        { action: 'workspace.removed', actor: actorOf(caller), target: id, detail: { workspaceId: id, pathHash: sha256Hex(real) } },
        res,
      )
      await writeSettings(caller, draft => {
        draft.workspaces = draft.workspaces.filter(item => item.id !== id)
        if (draft.defaults.workspaceId === id) delete draft.defaults.workspaceId
      })
      // A later registration under this ID has passed the rules afresh.
      disabledWorkspaces.delete(id)
    }

    function modelAvailable(ref: ModelRef): boolean {
      const provider = registry.providers().find(item => item.id === ref.providerId)
      return Boolean(provider && (provider.models?.length ? provider.models : [provider.model]).includes(ref.model))
    }

    function assertModel(ref: ModelRef): void {
      if (!modelAvailable(ref)) throw new AppError(400, 'model-unavailable', `模型 ${ref.model} 当前不可用，请选择已启用的模型服务与模型`)
    }

    /** Saved default model, while its provider is enabled and still offers it. */
    function savedDefaultModel(): ModelRef | undefined {
      if (options.providerId) return undefined
      const saved = config.settings().defaults.model
      return saved && modelAvailable(saved) ? { ...saved } : undefined
    }

    /** Provider for sessions without a model choice: `--provider`, the saved default, demo, then the first usable provider. */
    function defaultProviderId(): string {
      if (options.providerId) return options.providerId
      const enabled = new Set(registry.providers().map(provider => provider.id))
      const saved = config.settings().defaults.model?.providerId
      if (saved && enabled.has(saved)) return saved
      if (options.demo) return 'demo'
      return effectiveProviders().find(record => enabled.has(record.id))?.id ?? LEGACY_PROVIDER_ID
    }

    function defaultModelRef(): ModelRef | undefined {
      const saved = savedDefaultModel()
      if (saved) return saved
      const provider = registry.providers().find(item => item.id === defaultProviderId())
      return provider && { providerId: provider.id, model: provider.model }
    }

    function defaultHarnessId(): string {
      if (options.harnessId) return options.harnessId
      const saved = config.settings().defaults.harnessId
      return saved && hub?.info(saved)?.status === 'ready' ? saved : STANDARD
    }

    function sessionDefaults(): SessionDefaults {
      const saved = config.settings().defaults
      const model = defaultModelRef()
      return {
        harnessId: defaultHarnessId(),
        mode: saved.mode ?? 'agent',
        workspaceId: saved.workspaceId && workspaces().some(item => item.id === saved.workspaceId) ? saved.workspaceId : 'default',
        ...(model ? { model } : {}),
      }
    }

    async function savePreferences(caller: Caller, input: z.infer<typeof preferencesSchema>['defaults']): Promise<void> {
      if (input.harnessId !== undefined && !hub!.has(input.harnessId))
        throw new AppError(400, 'harness-unavailable', `Harness ${input.harnessId} 未启用`)
      if (input.workspaceId !== undefined && !workspaces().some(item => item.id === input.workspaceId))
        throw new AppError(400, 'workspace-unavailable', '找不到该项目')
      if (input.model) assertModel(input.model)
      await writeSettings(caller, draft => {
        if (input.harnessId !== undefined) draft.defaults.harnessId = input.harnessId
        if (input.mode !== undefined) draft.defaults.mode = input.mode
        if (input.workspaceId !== undefined) draft.defaults.workspaceId = input.workspaceId
        if (input.model === null) delete draft.defaults.model
        else if (input.model) draft.defaults.model = { providerId: input.model.providerId, model: input.model.model }
      })
    }

    function catalog(): HostCatalog {
      return {
        harnesses: hub!.drivers(),
        providers: registry.providers().map(provider => summarizeProvider(provider, providerKindOf(provider.id))),
        // Disabled workspaces are listed with their reason for settings; session pickers skip any entry marked unavailable.
        workspaces: savedWorkspaces(),
        defaults: sessionDefaults(),
      }
    }

    // ---- Approvals -------------------------------------------------------------------------------

    /** Builtin: the Host classifier's risk, never lower than the runtime's. Others: advisory R2. */
    async function decorate(approval: Approval, source: HarnessSource | undefined, cwd: string | undefined): Promise<Approval> {
      const { risk: reported, advisory: _advisory, ...rest } = approval
      if (source !== 'builtin') return { ...rest, advisory: true, risk: 'R2' }
      const args = parseArguments(approval.arguments)
      const classified = args ? (await classifyCall({ toolName: approval.toolName, arguments: args, ...(cwd ? { cwd } : {}) })).risk : 'R2'
      const risk = maxRisk(maxRisk(classified, reported ?? 'R1'), 'R1')
      return { ...rest, risk: risk === 'R2' ? 'R2' : 'R1' }
    }

    async function decorateAll(approvals: Approval[], tasks: TaskSummary[]): Promise<Approval[]> {
      const byId = new Map(tasks.map(task => [task.id, task]))
      return Promise.all(
        approvals.map(async approval => {
          const task = byId.get(approval.sessionId)
          const harnessId = task?.harnessId ?? (await hub!.harnessOf(approval.sessionId).catch(() => undefined))
          return decorate(approval, harnessId ? hub!.sourceOf(harnessId) : undefined, task?.cwd)
        }),
      )
    }

    async function decoratedDetail(sessionId: string): Promise<TaskDetail> {
      const detail = await hub!.detail(sessionId)
      const source = hub!.sourceOf(detail.summary.harnessId ?? '')
      return { ...detail, approvals: await Promise.all(detail.approvals.map(approval => decorate(approval, source, detail.summary.cwd))) }
    }

    function settled(approvalId: string, caller: DeviceCaller): AppError {
      const record = decisions.get(approvalId)
      const decidedBy = record
        ? {
            kind: 'device',
            self: record.deviceId === caller.device.id,
            deviceName: record.deviceName,
            decision: record.decision,
            optionKind: record.optionKind,
            at: record.at,
          }
        : { kind: 'system' }
      return new AppError(409, 'approval-settled', '该审批已处理或已失效，请刷新任务', { decidedBy })
    }

    function remember(record: DecisionRecord): void {
      decisions.delete(record.approvalId)
      decisions.set(record.approvalId, record)
      while (decisions.size > MAX_DECISION_RECORDS) decisions.delete(decisions.keys().next().value!)
    }

    /**
     * Target realpath, content hashes and risk reason of a Standard call, for the R2 confirmation. Content hashes describe
     * the built-in writer's file only: another tool's `content` or diff is that tool's own, and its arguments show it whole.
     */
    async function approvalFacts(approval: Approval, args: Record<string, unknown> | undefined, cwd: string | undefined) {
      const realCwd = await realpath(cwd ?? workspaceRoot).catch(() => cwd ?? workspaceRoot)
      let target: string | undefined
      if (args && typeof args.path === 'string' && args.path && !isAbsolute(args.path)) {
        const joined = resolve(realCwd, args.path)
        target = await realpath(dirname(joined)).then(
          parent => join(parent, basename(joined)),
          () => joined,
        )
      }
      const builtinWrite = isBuiltinWrite(approval.toolName)
      const newTextHash = builtinWrite && args && typeof args.content === 'string' ? sha256Hex(args.content) : undefined
      const oldText = builtinWrite ? approval.tool?.diffs?.[0]?.oldText : undefined
      const oldTextHash = typeof oldText === 'string' ? sha256Hex(oldText) : undefined
      const reason = args
        ? (await classifyCall({ toolName: approval.toolName, arguments: args, ...(cwd ? { cwd } : {}) })).reason
        : undefined
      const previewHash = sha256Hex(
        canonicalJson({
          approvalId: approval.id,
          sessionId: approval.sessionId,
          toolName: approval.toolName,
          arguments: args ?? approval.arguments,
          cwd: realCwd,
          target,
          newTextHash,
          oldTextHash,
        }),
      )
      return { realCwd, target, newTextHash, oldTextHash, reason, previewHash, builtinWrite }
    }

    async function decideApproval(req: IncomingMessage, res: ServerResponse, caller: Caller, approvalId: string): Promise<void> {
      requireScope(caller, 'view')
      const input = decisionSchema.parse(await jsonBody(req))
      for (let held = decisionLocks.get(approvalId); held; held = decisionLocks.get(approvalId)) await held.catch(() => undefined)
      const run = decideLocked(req, res, caller, approvalId, input)
      decisionLocks.set(approvalId, run)
      try {
        await run
      } finally {
        if (decisionLocks.get(approvalId) === run) decisionLocks.delete(approvalId)
      }
    }

    async function decideLocked(
      req: IncomingMessage,
      res: ServerResponse,
      caller: DeviceCaller,
      approvalId: string,
      input: z.infer<typeof decisionSchema>,
    ): Promise<void> {
      recheck(caller)
      // An approval decided over HTTP never becomes pending again, even while its driver is still settling it.
      const record = decisions.get(approvalId)
      if (record) {
        if (input.requestId && record.requestId === input.requestId && record.deviceId === caller.device.id) {
          json(res, {
            accepted: true,
            receipt: {
              approvalId,
              decision: record.decision,
              ...(record.optionId ? { optionId: record.optionId } : {}),
              at: record.at,
              replay: true,
            },
          })
          return
        }
        throw settled(approvalId, caller)
      }
      const found = await hub!.findApproval(approvalId)
      if (!found) throw settled(approvalId, caller)
      const source = hub!.sourceOf(found.harnessId)
      const detailCwd = (await hub!.listTasks()).find(task => task.id === found.approval.sessionId)?.cwd
      const approval = await decorate(found.approval, source, detailCwd)
      const option = input.optionId ? approval.options?.find(item => item.id === input.optionId) : undefined
      if (input.optionId && !option) {
        throw approval.advisory
          ? new AppError(400, 'approval-option-hidden', '该选项会持久保存授权，Latch 不提供')
          : new AppError(400, 'invalid-option', '该审批不提供此选项')
      }
      if (option && option.kind.startsWith('allow') !== (input.decision === 'allow'))
        throw new AppError(400, 'invalid-option', '所选选项与决定不一致')
      const optionKind = option?.kind ?? (input.decision === 'allow' ? 'allow_once' : 'reject_once')
      const args = source === 'builtin' ? parseArguments(approval.arguments) : undefined
      const level = hub!.levelOf(found.harnessId)
      // Checked against the current device record: the request may have been opened before a scope change.
      const needed: DeviceScope =
        input.decision === 'reject' ? 'view' : approval.advisory ? 'run' : approval.risk === 'R2' ? 'approve:elevated' : 'approve:standard'
      let stepup: StepupMethod = 'none'
      let previewHash: string | undefined
      if (input.decision === 'reject') {
        limits.classC.take(caller.device.id)
      } else if (approval.advisory) {
        requireUnix(caller)
      } else if (approval.risk === 'R2') {
        if (caller.connection.listener !== 'unix') throw hostDesktopRequired()
      }
      recheck(caller, needed)
      // Rejections reduce what runs and are never limited by the ceiling.
      if (input.decision === 'allow') {
        assertSessionCeiling(caller, level)
        await assertRemoteSession(caller, approval.sessionId)
      }
      if (input.decision === 'allow' && optionKind === 'allow_always' && (approval.advisory || approval.risk === 'R2')) {
        throw new AppError(403, 'approval-always-unavailable', '高风险操作不提供“始终允许”')
      }
      if (input.decision === 'allow' && approval.risk === 'R2' && !approval.advisory) {
        const facts = await approvalFacts(approval, args, detailCwd)
        previewHash = facts.previewHash
        // Host-derived facts come first and the model-chosen arguments last. Only the built-in writer's file content appears
        // as its size and hash; other arguments, and unparsable argument text, appear whole and escaped.
        const lines: PreviewLine[] = [
          { label: '会话', value: approval.sessionId },
          { label: '工具', value: approval.toolName },
          { label: '工作目录', value: facts.realCwd },
          ...(facts.target ? [{ label: '目标路径', value: facts.target }] : []),
          ...(facts.newTextHash ? [{ label: '新内容哈希', value: hashDisplay(facts.newTextHash) }] : []),
          ...(facts.oldTextHash ? [{ label: '原内容哈希', value: hashDisplay(facts.oldTextHash) }] : []),
          { label: '风险原因', value: facts.reason ? RISK_REASONS[facts.reason] : '参数无法解析' },
          { label: '参数', value: args ? canonicalJson(previewArguments(args, facts.builtinWrite)) : (approval.arguments ?? '') },
        ]
        stepup = await confirm(
          req,
          caller,
          'approval.r2',
          { approvalId, optionId: input.optionId, decision: input.decision, previewHash: facts.previewHash },
          lines,
        )
      }
      recheck(caller, needed)
      if (input.decision === 'allow') assertSessionCeiling(caller, level)
      const at = new Date(now()).toISOString()
      await audited(
        {
          action: 'approval.decided',
          actor: actorOf(caller),
          target: approvalId,
          stepup,
          detail: {
            approvalId,
            sessionId: approval.sessionId,
            harnessId: found.harnessId,
            risk: approval.risk ?? 'R2',
            advisory: Boolean(approval.advisory),
            decision: input.decision,
            optionKind,
            ...(previewHash ? { previewHash } : {}),
          },
        },
        input.decision === 'reject' ? res : undefined,
      )
      const accepted = await hub!.decide(approvalId, input.decision, input.optionId ? { optionId: input.optionId } : undefined)
      if (!accepted) {
        await audited({ action: 'approval.stale', actor: actorOf(caller), target: approvalId, detail: { approvalId } }, res)
        throw settled(approvalId, caller)
      }
      remember({
        approvalId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        deviceId: caller.device.id,
        deviceName: caller.device.name,
        decision: input.decision,
        ...(input.optionId ? { optionId: input.optionId } : {}),
        optionKind,
        at,
      })
      json(res, {
        accepted: true,
        receipt: { approvalId, decision: input.decision, ...(input.optionId ? { optionId: input.optionId } : {}), at },
      })
    }

    // ---- Change stream ---------------------------------------------------------------------------

    /**
     * A stream stays open only while the credential that opened it would still be accepted: not past its renewal deadline,
     * not rotated out beyond the grace window, and the device not revoked. The client then reconnects with its current credential.
     */
    function streamAllowed(stream: EventStream): boolean {
      return devices.streamAllowed(stream.deviceId, stream.credentialHash)
    }

    function send(res: ServerResponse, event: ChangeEvent | TaskStateEvent): void {
      const stream = streams.get(res)
      if (!stream || !streamAllowed(stream)) {
        res.end()
        streams.delete(res)
        return
      }
      // A connection can join while an older batch awaits an external Bridge.
      // Equal revisions are valid for different events in the same batch.
      if (event.revision < stream.lastSentRevision) return
      // Disconnect lagging readers; this is not a hard per-frame or memory limit.
      if (res.writableLength > 262_144) {
        res.destroy()
        streams.delete(res)
        return
      }
      res.write(`id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      stream.lastSentRevision = event.revision
    }

    function scheduleEvents(): void {
      if (eventTimer || flushing || closing) return
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void flushEvents()
      }, 40)
      eventTimer.unref()
    }

    async function flushEvents(): Promise<void> {
      flushing = true
      const global = pendingGlobal
      const globalRevision = revision
      const tasks = [...pendingTasks]
      pendingGlobal = false
      pendingTasks.clear()
      try {
        if (global) for (const res of streams.keys()) send(res, { type: 'refresh', instanceId, revision: globalRevision })
        let fallback = false
        for (const [sessionId] of tasks) {
          let detail: TaskDetail
          try {
            detail = await decoratedDetail(sessionId)
          } catch {
            // Deleted or unreadable: one refresh per batch lets clients resync from the snapshot.
            summaries.delete(sessionId)
            fallback = true
            continue
          }
          const signature = JSON.stringify([detail.summary, detail.approvals])
          const summaryChanged = summaries.get(sessionId) !== signature
          summaries.set(sessionId, signature)
          const event: TaskStateEvent = {
            type: 'task-state',
            instanceId,
            revision: globalRevision,
            sessionId,
            detail: { ...detail, sync: { instanceId, revision: globalRevision } },
          }
          for (const [res, stream] of streams) {
            if (stream.sessionId === sessionId) send(res, event)
            else if (summaryChanged) send(res, { type: 'tasks-invalidated', instanceId, revision: globalRevision, sessionId })
          }
        }
        if (fallback && !global) for (const res of streams.keys()) send(res, { type: 'refresh', instanceId, revision: globalRevision })
      } finally {
        flushing = false
        if (pendingGlobal || pendingTasks.size) scheduleEvents()
      }
    }

    function refresh(sessionId?: string): void {
      const nextRevision = ++revision
      if (sessionId) pendingTasks.set(sessionId, nextRevision)
      else pendingGlobal = true
      scheduleEvents()
    }
    const unsubscribe = harnessHub.subscribe(refresh)
    const heartbeat = setInterval(() => {
      for (const [res, stream] of streams) {
        if (!streamAllowed(stream)) {
          res.end()
          streams.delete(res)
        } else res.write(': heartbeat\n\n')
      }
    }, 15_000)
    heartbeat.unref()
    startupCleanup.push(() => {
      clearInterval(heartbeat)
      clearTimeout(eventTimer)
      unsubscribe()
    })

    // ---- Authentication --------------------------------------------------------------------------

    function connectionOf(req: IncomingMessage, listener: ListenerContext): ConnectionContext {
      return {
        listener: listener.listener,
        origin: listener.origin,
        remoteAddress:
          listener.listener === 'unix' ? UNIX_ADDRESS : (req.socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, ''),
      }
    }

    /**
     * Returns the caller, or throws the device store's verdict. `renewal` admits devices whose credential
     * is due for renewal (only the renewal routes pass it); host.sock without a credential is anonymous.
     */
    async function authenticate(
      req: IncomingMessage,
      listener: ListenerContext,
      connection: ConnectionContext,
      renewal = false,
    ): Promise<Caller> {
      const presented = presentedCredential(req, listener, hostId8)
      if (listener.listener === 'unix' && !hasAuthorization(req)) return { connection }
      const outcome = await devices.authenticate(presented, connection)
      if (outcome.ok)
        return {
          connection,
          device: outcome.device,
          renewAfter: outcome.renewAfter,
          credentialHash: outcome.credentialHash,
          ...(presented ? { presented } : {}),
        }
      if (outcome.code === 'legacy-reconfirm') throw authFailure('legacy-reconfirm', { legacyName: outcome.legacyName })
      if (renewal && outcome.code === 'renewal-required' && outcome.deviceId && presented) {
        const device = devices.get(outcome.deviceId)
        // The device store decides with the presented credential itself whether this one may still renew.
        if (device) return { connection, device, presented, credentialHash: sha256Hex(presented.value) }
      }
      throw authFailure(outcome.code as AuthFailureCode)
    }

    function setCredentialCookie(
      res: ServerResponse,
      caller: Pick<Caller, 'connection'>,
      device: Device,
      credential: string,
      extra: string[] = [],
    ): void {
      res.setHeader('set-cookie', [
        credentialCookie(caller.connection.listener, hostId8, credential, Date.parse(device.credentialExpiresAt), now()),
        ...extra,
      ])
    }

    // ---- Security routes -------------------------------------------------------------------------

    async function handlePublic(
      req: IncomingMessage,
      res: ServerResponse,
      listener: ListenerContext,
      connection: ConnectionContext,
      path: string,
      method: string,
    ): Promise<boolean> {
      if (path === '/link/api/health' && method === 'GET') {
        json(res, { ok: true })
        return true
      }
      if (path === '/link/api/host-info' && method === 'GET') {
        if (listener.listener !== 'unix') throw new AppError(404, 'not-found', '接口不存在')
        const tasks = await hub!.listTasks()
        const info: HostInfo = {
          product: 'Latch',
          version: LATCH_VERSION,
          hostId,
          instanceId,
          pid: process.pid,
          startedAt,
          loopbackOrigin,
          tlsOrigin: tlsOrigin ?? null,
          devMode: true,
          presence: await presenceStatus(),
          activeSessions: tasks.filter(task => task.status === 'running' || task.status === 'waiting-approval').length,
        }
        json(res, info)
        return true
      }
      if ((path === '/link/api/login' || path === '/link/api/pair') && method === 'POST') {
        throw new AppError(410, 'login-removed', '启动令牌登录已移除，请在本机确认这台设备')
      }
      if (path === '/link/api/enrollment-info' && method === 'GET') {
        let legacyName: string | undefined
        const presented = presentedCredential(req, listener, hostId8)
        if (listener.listener === 'loopback-tcp' && presented?.kind === 'legacy-cookie') {
          const outcome = await devices.authenticate(presented, connection)
          if (!outcome.ok && outcome.code === 'legacy-reconfirm') legacyName = outcome.legacyName
        }
        json(res, await enrollments.info(connection, legacyName))
        return true
      }
      if (path === '/link/api/enrollments' && method === 'POST') {
        const tls = listener.listener === 'lan-tls' || listener.listener === 'tailnet-tls'
        if (!tls) limits.enrollmentCreate.take(listener.listener)
        const input = enrollmentSchema.parse(await jsonBody(req))
        // On TLS only an invitation can succeed. Each one this Host issued gets its own budget, so other requests cannot use
        // up a paired phone's; every other attempt, with or without a code, shares one budget per listener and adds no keys.
        const invitationHash = tls && input.invitation !== undefined ? sha256Hex(input.invitation) : undefined
        const issued = invitationHash !== undefined && invitationIssued(invitationHash)
        if (tls)
          limits.enrollmentCreate.take(issued ? `${listener.listener}:invitation:${invitationHash}` : `${listener.listener}:uninvited`)
        const request = {
          publicKey: input.publicKey,
          name: input.name,
          ...(input.scopes ? { scopes: input.scopes } : {}),
          ...(input.dataScope ? { dataScope: input.dataScope } : {}),
          ...(input.invitation ? { invitation: input.invitation } : {}),
          ...(input.offlineCode ? { offlineCode: input.offlineCode } : {}),
        }
        const presented = presentedCredential(req, listener, hostId8)
        const legacy = presented?.kind === 'legacy-cookie' ? presented : undefined
        let enrollment: EnrollmentView
        try {
          enrollment = await enrollments.create(request, connection, legacy)
        } catch (error) {
          if (issued && codeOf(error) === 'invitation-invalid') issuedInvitations.delete(invitationHash)
          throw error
        }
        // Single use: later attempts with this code share the per-listener budget.
        if (issued) issuedInvitations.delete(invitationHash)
        json(res, { enrollment }, 202)
        return true
      }
      const enrollment = path.match(/^\/link\/api\/enrollments\/([^/]+)(\/complete)?$/)
      if (!enrollment) return false
      const id = safeDecode(enrollment[1]!)
      if (id.length > 64) throw new AppError(404, 'enrollment-not-found', '找不到该登记请求')
      if (method === 'GET' && !enrollment[2]) {
        limits.enrollmentPoll.take(id)
        json(res, { enrollment: enrollments.status(id, connection) })
        return true
      }
      if (method === 'DELETE' && !enrollment[2]) {
        enrollments.cancel(id, connection)
        json(res, { cancelled: true })
        return true
      }
      if (method === 'POST' && enrollment[2]) {
        limits.enrollmentPoll.take(id)
        const input = signatureSchema.parse(await jsonBody(req))
        const presented = presentedCredential(req, listener, hostId8)
        const { device, credential } = await enrollments.complete(id, input.signature, connection)
        refresh()
        if (listener.listener === 'unix') {
          json(res, { device, credential })
          return true
        }
        setCredentialCookie(res, { connection }, device, credential, presented?.kind === 'legacy-cookie' ? [CLEARED_LEGACY_COOKIE] : [])
        json(res, { device })
        return true
      }
      return false
    }

    async function handleCredentials(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string): Promise<void> {
      requireDevice(caller)
      if (path === '/link/api/credentials/challenge') {
        const challenge = devices.challenge(caller.device.id, caller.credentialHash)
        json(res, { nonce: challenge.nonce, expiresAt: new Date(challenge.expiresAt).toISOString() })
        return
      }
      const input = renewSchema.parse(await jsonBody(req))
      const { device, credential } = await devices.renew({
        deviceId: caller.device.id,
        nonce: input.nonce,
        signature: input.signature,
        connection: caller.connection,
        ...(caller.credentialHash ? { credentialHash: caller.credentialHash } : {}),
      })
      const renewed: CurrentDevice = { ...device, current: true, renewAfter: new Date(now() + RENEW_INTERVAL_MS).toISOString() }
      refresh()
      if (caller.connection.listener === 'unix') {
        json(res, { device: renewed, credential })
        return
      }
      setCredentialCookie(res, caller, device, credential)
      json(res, { device: renewed })
    }

    /** Revokes and reports whether the device store's audit record was written (it never blocks a revocation). */
    async function revokeDevice(res: ServerResponse, caller: Caller, id: string, reason: 'manual' | 'self') {
      const result = await devices.revoke(id, reason, actorOf(caller))
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      for (const [stream, info] of streams)
        if (!streamAllowed(info)) {
          stream.end()
          streams.delete(stream)
        }
      refresh()
      return result
    }

    function grantBase(device: Device): DeviceScopeBase {
      return { scopes: [...device.scopes].sort(), dataScope: device.dataScope, status: device.status }
    }

    /** Host-derived facts come first: the name is chosen by the device itself and can imitate another. */
    function grantLines(target: Device, added: DeviceScope[], removed: DeviceScope[], dataScope: DataScope): PreviewLine[] {
      const label = (list: DeviceScope[]) => (list.length ? list.map(scope => SCOPE_LABELS[scope]).join('、') : '无')
      const origin = target.listener === 'unix' ? UNIX_ADDRESS : target.listener === 'loopback-tcp' ? loopbackOrigin : (tlsOrigin ?? '')
      const inviter = target.pairedBy.deviceId ? devices.get(target.pairedBy.deviceId) : undefined
      return [
        { label: '连接方式', value: `${LISTENER_LABELS[target.listener]} · ${origin}` },
        {
          label: '配对方式',
          value: inviter
            ? `${PAIRING_LABELS[target.pairedBy.method]}（邀请设备：${inviter.name}）`
            : PAIRING_LABELS[target.pairedBy.method],
        },
        { label: '当前状态', value: target.status === 'review' ? '待复核（邀请设备已被撤销）' : '正常' },
        { label: '设备名称', value: target.name },
        { label: '设备指纹', value: target.fingerprint },
        { label: '新增权限', value: label(added) },
        { label: '移除权限', value: label(removed) },
        { label: '数据范围', value: dataScope === 'all' ? '全部' : '工作' },
      ]
    }

    function grantWarnings(target: Device, added: DeviceScope[]): string[] {
      return [
        ...(target.listener === 'lan-tls' || target.listener === 'tailnet-tls' ? ['该设备通过网络连接，不在这台电脑上。'] : []),
        ...(target.status === 'review' ? ['该设备的邀请设备已被撤销；确认后它将恢复正常使用。'] : []),
        ...(added.includes('admin') ? ['确认后该设备可以管理此 Host：模型服务、插件、项目和其他设备。'] : []),
      ]
    }

    async function handleDevices(
      req: IncomingMessage,
      res: ServerResponse,
      caller: Caller,
      path: string,
      method: string,
    ): Promise<boolean> {
      if (path === '/link/api/devices/current') {
        requireScope(caller, 'view')
        if (method === 'PATCH') {
          const input = deviceNameSchema.parse(await jsonBody(req))
          recheck(caller)
          const device = await devices.rename(caller.device.id, input.name, actorOf(caller))
          refresh()
          json(res, { device })
          return true
        }
        if (method === 'DELETE') {
          limits.classC.take(caller.device.id)
          await revokeDevice(res, caller, caller.device.id, 'self')
          if (caller.connection.listener !== 'unix')
            res.setHeader('set-cookie', clearedCredentialCookie(caller.connection.listener, hostId8))
          json(res, { revoked: true })
          return true
        }
        return false
      }
      if (path === '/link/api/devices' && method === 'GET') {
        if (caller.device) requireScope(caller, 'admin')
        json(res, { devices: devices.list() })
        return true
      }
      const match = path.match(/^\/link\/api\/devices\/([^/]+)$/)
      if (match && method === 'DELETE') {
        if (caller.device) requireScope(caller, 'admin')
        else limits.anonymousRevoke.take()
        const id = safeDecode(match[1]!)
        if (caller.device && id === caller.device.id) throw new AppError(409, 'current-device', '请使用「撤销此设备」撤销当前设备')
        if (!devices.get(id)) throw new AppError(404, 'device-not-found', '找不到该设备')
        const result = await revokeDevice(res, caller, id, 'manual')
        json(res, { revoked: true, cascaded: result.cascaded.length })
        return true
      }
      if (match && method === 'PATCH') {
        requireScope(caller, 'admin')
        const id = safeDecode(match[1]!)
        const input = deviceScopesSchema.parse(await jsonBody(req))
        recheck(caller, 'admin')
        const target = devices.get(id)
        if (!target || target.status === 'revoked' || target.status === 'legacy-pending')
          throw new AppError(404, 'device-not-found', '找不到该设备')
        const scopes = [...new Set<DeviceScope>(['view', ...(input.scopes ?? target.scopes)])].sort()
        const dataScope: DataScope = input.dataScope ?? target.dataScope
        if (target.listener !== 'unix' && scopes.some(scope => scope === 'approve:elevated' || scope === 'secrets')) {
          throw new AppError(400, 'scope-not-grantable', '该权限在此连接方式下不可授予')
        }
        const added = scopes.filter(scope => !target.scopes.includes(scope))
        const removed = target.scopes.filter(scope => !scopes.includes(scope))
        const raising =
          added.length > 0
          || (dataScope === 'all' && target.dataScope !== 'all')
          || (target.status === 'review' && scopes.some(scope => scope !== 'view'))
        const base = grantBase(target)
        let stepup: StepupMethod = 'none'
        if (raising) {
          requireUnix(caller)
          // The preview shows a change against `base`, so the confirmation binds it too.
          stepup = await confirm(
            req,
            caller,
            'device.grant',
            { deviceId: id, scopes, dataScope, base },
            grantLines(target, added, removed, dataScope),
            grantWarnings(target, added),
          )
        }
        const { device, audited } = await serial(caller, 'admin', async () => {
          // The store compares the base inside its own queue, where revocation cascades also run (409 device-changed).
          if (raising) return devices.changeScopes(id, { scopes, dataScope }, actorOf(caller), stepup, grantBase(target))
          // A reduction applies to the current record, so a concurrent change is narrowed further, never undone.
          for (let attempt = 1; ; attempt++) {
            const current = devices.get(id)
            if (!current || current.status === 'revoked' || current.status === 'legacy-pending')
              throw new AppError(404, 'device-not-found', '找不到该设备')
            const kept = current.scopes.filter(scope => scopes.includes(scope))
            try {
              return await devices.changeScopes(
                id,
                { scopes: kept, dataScope: dataScope === 'work' ? 'work' : current.dataScope },
                actorOf(caller),
                'none',
                grantBase(current),
              )
            } catch (error) {
              if (attempt >= BASE_RETRIES || codeOf(error) !== 'device-changed') throw error
            }
          }
        })
        if (!audited) res.setHeader('x-latch-audit', 'failed')
        refresh()
        json(res, { device })
        return true
      }
      if (path === '/link/api/pairings' && method === 'POST') {
        requireUnix(caller)
        if (caller.device) requireScope(caller, 'admin')
        const input = invitationSchema.parse(await optionalJsonBody(req))
        recheck(caller, 'admin')
        if (!tlsOrigin) throw new AppError(409, 'tls-not-configured', '尚未配置 HTTPS 入口，无法生成手机配对码')
        const invitation = await enrollments.createInvitation(
          { ...(caller.device ? { inviter: caller.device } : {}), ...(input.scopes ? { scopes: input.scopes } : {}), tlsOrigin },
          actorOf(caller),
        )
        pruneInvitations()
        // The enrollment service caps live invitations; this bound only keeps the map small if that cap ever changes.
        if (issuedInvitations.size >= MAX_ISSUED_INVITATIONS) issuedInvitations.delete(issuedInvitations.keys().next().value!)
        issuedInvitations.set(sha256Hex(invitation.code), Date.parse(invitation.expiresAt))
        json(res, { invitation }, 201)
        return true
      }
      return false
    }

    async function handlePolicy(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, method: string): Promise<void> {
      requireScope(caller, 'admin')
      if (method === 'GET') {
        json(res, { policy: policy.get(), hash: policy.hash() })
        return
      }
      if (method !== 'PATCH') throw new AppError(404, 'not-found', '接口不存在')
      const input = policyPatchSchema.parse(await jsonBody(req))
      recheck(caller, 'admin')
      const patched = (base: Policy): Policy => {
        const next = structuredClone(base)
        if (input.local) Object.assign(next.local, input.local)
        if (input.remote) Object.assign(next.remote, input.remote)
        if (input.hostEgressAllow) {
          const remove = new Set(input.hostEgressAllow.remove ?? [])
          next.hostEgressAllow = [
            ...new Set([...next.hostEgressAllow.filter(entry => !remove.has(entry)), ...(input.hostEgressAllow.add ?? [])]),
          ]
        }
        return next
      }
      const previous = policy.get()
      const baseHash = policy.hash()
      const next = patched(previous)
      const diff = policyDiff(previous, next)
      if (!diff.length) {
        json(res, { policy: previous, hash: baseHash })
        return
      }
      const changed = () => new AppError(409, 'policy-changed', '安全策略已被修改，请刷新后重试')
      let written: { audited: boolean }
      if (isLowering(previous, next)) {
        // Applied to the policy current at commit time, so a concurrent change is narrowed further, never undone.
        written = await serial(caller, 'admin', async () => {
          for (let attempt = 1; ; attempt++) {
            const current = policy.get()
            const currentHash = policy.hash()
            const lowered = patched(current)
            if (!isLowering(current, lowered)) throw changed()
            try {
              return await policy.update(lowered, actorOf(caller), 'none', currentHash)
            } catch (error) {
              if (attempt >= BASE_RETRIES || codeOf(error) !== 'policy-changed') throw error
            }
          }
        })
      } else {
        // The preview is a diff against `baseHash`, so the confirmation binds it; the store writes only on that base (409 policy-changed).
        const stepup = await confirm(
          req,
          caller,
          'policy.change',
          { baseHash, nextHash: sha256Hex(canonicalJson(next)) },
          diff.map(line => ({ label: line.path, value: `${line.before} → ${line.after}` })),
        )
        written = await serial(caller, 'admin', () => policy.update(next, actorOf(caller), stepup, baseHash))
      }
      if (!written.audited) res.setHeader('x-latch-audit', 'failed')
      refresh()
      json(res, { policy: policy.get(), hash: policy.hash() })
    }

    // ---- Tasks -----------------------------------------------------------------------------------

    /** Remote starts and turns stay within the remote ceiling; local ones within the local ceiling. */
    function assertStandardCeiling(caller: Caller, start?: { harnessId: string; workspaceId: string }): void {
      const current = policy.get()
      const ceiling: PermissionLevel = ceilingFor(current, caller.connection.listener)
      const allowed = levelsUpTo(ceiling).filter(level => level !== 'L3')
      if (!levelAtMost('L1', ceiling)) throw ceilingExceeded(allowed)
      if (!start || caller.connection.listener === 'unix') return
      const remote = current.remote
      if (
        !remote.allowRemoteStart
        || (remote.harnesses !== null && !remote.harnesses.includes(start.harnessId))
        || (remote.workspaces !== null && !remote.workspaces.includes(start.workspaceId))
      )
        throw ceilingExceeded([])
    }

    /** The ceiling for running anything at `level`: Standard within the listener's ceiling, full access only on host.sock while allowed. */
    function assertSessionCeiling(caller: Caller, level: 'L1' | 'L3'): void {
      if (level === 'L1') {
        assertStandardCeiling(caller)
        return
      }
      requireUnix(caller)
      const local = policy.get().local
      if (!local.allowL3) throw ceilingExceeded(levelAtMost('L1', local.maxLevel) ? ['L1'] : [])
    }

    /**
     * The harness and project lists that limit remote starts also limit what a remote device may continue: new input,
     * option changes and allowing a call. A session whose directory no longer matches a listed project counts as outside.
     */
    async function assertRemoteSession(caller: Caller, sessionId: string): Promise<void> {
      if (caller.connection.listener === 'unix') return
      const remote = policy.get().remote
      if (remote.harnesses === null && remote.workspaces === null) return
      if (remote.harnesses !== null && !remote.harnesses.includes(await hub!.harnessOf(sessionId))) throw ceilingExceeded([])
      if (remote.workspaces === null) return
      const task = (await hub!.listTasks()).find(item => item.id === sessionId)
      const root = task && (await canonicalPath(task.cwd ?? workspaceRoot).catch(() => undefined))
      for (const workspace of savedWorkspaces()) {
        if (!remote.workspaces.includes(workspace.id)) continue
        const path = workspace.id === 'default' ? canonicalWorkspace : await canonicalPath(workspace.path).catch(() => undefined)
        if (root !== undefined && root === path) return
      }
      throw ceilingExceeded([])
    }

    async function assertSessionAccess(caller: DeviceCaller, sessionId: string): Promise<'L1' | 'L3'> {
      const level = hub!.levelOf(await hub!.harnessOf(sessionId))
      if (level === 'L3') requireUnix(caller)
      return level
    }

    async function createTask(req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> {
      requireScope(caller, 'run')
      const input = createTaskSchema.parse(await jsonBody(req, TASK_BODY_LIMIT))
      recheck(caller, 'run')
      const harnessId = input.harnessId ?? defaultHarnessId()
      const harness = hub!.info(harnessId)
      if (!harness || !hub!.has(harnessId)) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 未启用`)
      if (harness.status !== 'ready') throw new AppError(409, 'harness-unavailable', harness.statusMessage ?? `${harness.name} 当前不可用`)
      if (input.mode && !harness.modes.includes(input.mode)) throw new AppError(400, 'mode-unsupported', `${harness.name} 不支持该会话模式`)
      if (input.model && harness.models !== 'host')
        throw new AppError(400, 'model-unsupported', `${harness.name} 自行管理模型，不能指定模型服务`)
      if (input.model) assertModel(input.model)
      const workspaceId = input.workspaceId ?? 'default'
      const chosen = input.workspaceId === undefined ? undefined : savedWorkspaces().find(item => item.id === input.workspaceId)
      if (input.workspaceId !== undefined && !chosen) throw new AppError(400, 'workspace-unavailable', '找不到所选项目')
      if (chosen) await assertWorkspaceUsable(chosen)
      // Only what the client chose reaches the driver; defaults stay the driver's decision.
      const task: HubCreateInput = {
        prompt: input.prompt,
        requestId: input.requestId,
        harnessId,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(chosen ? { cwd: chosen.path } : {}),
      }
      if (hub!.levelOf(harnessId) === 'L1') {
        assertStandardCeiling(caller, { harnessId, workspaceId })
        json(res, await hub!.createTask(task), 201)
        return
      }
      assertSessionCeiling(caller, 'L3')
      if (workspaceId === 'default' && defaultFlags.insideData)
        throw new AppError(409, 'workspace-inside-data', '该工作区位于数据目录内，迁出之前只能使用内置 Harness')
      if (workspaceId === 'default' && defaultFlags.codeRoot)
        throw new AppError(409, 'workspace-code-root', '该目录与 Latch 程序目录重叠，不能作为项目')
      const cwd = await realpath(chosen?.path ?? workspaceRoot)
      const promptHash = sha256Hex(input.prompt)
      const preview = await hub!.launchPreviewOf(harnessId, cwd)
      let launchHash: string
      let lines: PreviewLine[]
      if (preview) {
        launchHash = preview.launchHash
        lines = [
          { label: 'Harness', value: `${harness.name}（${harnessId}）` },
          { label: '命令', value: preview.command },
          { label: '参数', value: JSON.stringify(preview.args) },
          { label: '环境变量名', value: preview.envNames.join('、') || '（无）' },
          { label: '工作目录', value: preview.cwd },
          { label: '定义状态', value: preview.verified ? '已验证的预设' : '未验证的定义' },
          { label: '模式读回', value: preview.readback === 'mode' ? '可读回' : '无法读回' },
          { label: '审批', value: preview.approvals === 'prompts' ? '会请求审批' : '不请求审批' },
          ...preview.notes.map(note => ({ label: '说明', value: note })),
          { label: '启动指纹', value: hashDisplay(launchHash) },
          { label: '首条输入', value: hashDisplay(promptHash) },
        ]
      } else {
        const plugin = harnessPlugin(harnessId)
        const pluginId = plugin?.id ?? harnessId
        const version = plugin?.version ?? ''
        launchHash = sha256Hex(canonicalJson({ harnessId, pluginId, version }))
        lines = [
          { label: 'Harness', value: `${harness.name}（${harnessId}）` },
          { label: '命令', value: `第三方 Harness 插件 ${pluginId}@${version}` },
          { label: '工作目录', value: cwd },
          { label: '定义状态', value: '未验证的定义' },
          { label: '模式读回', value: '无法读回' },
          { label: '审批', value: '由插件决定，Latch 无法核实' },
          { label: '启动指纹', value: hashDisplay(launchHash) },
          { label: '首条输入', value: hashDisplay(promptHash) },
        ]
      }
      const stepup = await confirm(
        req,
        caller,
        'task.start-l3',
        { harnessId, cwd, requestId: input.requestId, promptHash, launchHash },
        lines,
        L3_WARNINGS,
      )
      recheck(caller, 'run')
      // The policy may have been lowered while the confirmation was open.
      assertSessionCeiling(caller, 'L3')
      if (chosen) await assertWorkspaceUsable(chosen)
      // The intent is on record before the driver can spawn anything; the session id exists only once it has, so the
      // record naming it is a commit that may fail without stopping a session the intent already covers.
      const intent = await audited({ action: 'task.l3.start-requested', actor: actorOf(caller), stepup, detail: { harnessId, launchHash } })
      let created: { sessionId: string }
      try {
        created = await hub!.createTask({ ...task, expectedLaunchHash: launchHash })
      } catch (error) {
        auditFailed(intent, caller)
        throw error
      }
      await audited(
        {
          action: 'task.l3.started',
          actor: actorOf(caller),
          target: created.sessionId,
          stepup,
          detail: { sessionId: created.sessionId, harnessId, launchHash },
        },
        res,
      )
      json(res, created, 201)
    }

    async function handleTask(
      req: IncomingMessage,
      res: ServerResponse,
      caller: Caller,
      id: string,
      action: string | undefined,
      method: string,
    ): Promise<boolean> {
      if (id.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
      if (method === 'GET' && !action) {
        requireScope(caller, 'view')
        const detailRevision = revision
        json(res, { ...(await decoratedDetail(id)), sync: { instanceId, revision: detailRevision } })
        return true
      }
      if (method === 'PATCH' && !action) {
        requireScope(caller, 'run')
        const input = taskPatchSchema.parse(await jsonBody(req))
        recheck(caller, 'run')
        json(res, { summary: await hub!.updateMeta(id, input) })
        return true
      }
      if (method === 'DELETE' && !action) {
        requireScope(caller, 'run')
        await assertSessionAccess(caller, id)
        await hub!.remove(id)
        summaries.delete(id)
        refresh()
        json(res, { deleted: true })
        return true
      }
      if (method === 'POST' && action === 'prompt') {
        requireScope(caller, 'run')
        const input = promptSchema.parse(await jsonBody(req, TASK_BODY_LIMIT))
        recheck(caller, 'run')
        assertSessionCeiling(caller, await assertSessionAccess(caller, id))
        await assertRemoteSession(caller, id)
        await assertSessionWorkspace(id)
        if (input.model) {
          const harness = hub!.info(await hub!.harnessOf(id))
          if (harness?.models !== 'host') throw new AppError(400, 'model-unsupported', '该会话的 Harness 自行管理模型，不能切换模型服务')
          assertModel(input.model)
        }
        await hub!.prompt(id, input.prompt, input.requestId, input.model ? { model: input.model } : undefined)
        json(res, { accepted: true })
        return true
      }
      if (method === 'POST' && action === 'cancel') {
        requireScope(caller, 'view')
        limits.classC.take(caller.device.id)
        await hub!.harnessOf(id)
        await audited({ action: 'task.cancelled', actor: actorOf(caller), target: id, detail: { sessionId: id } }, res)
        await hub!.cancel(id)
        json(res, { accepted: true })
        return true
      }
      if (method === 'POST' && action === 'config') {
        requireScope(caller, 'run')
        const input = configSchema.parse(await jsonBody(req))
        recheck(caller, 'run')
        // Any change, stricter ones included, may start the agent process again, so the ceiling applies to all of them.
        assertSessionCeiling(caller, await assertSessionAccess(caller, id))
        await assertRemoteSession(caller, id)
        await assertSessionWorkspace(id)
        const change = await hub!.classifyConfigChange(id, input.configId, input.value)
        if (change === 'forbidden') throw new AppError(400, 'mode-forbidden', '该模式由模型代为批准，Latch 不提供')
        if (change !== 'wider') {
          await hub!.setConfig(id, input.configId, input.value)
          json(res, { accepted: true })
          return true
        }
        const detail = await hub!.detail(id)
        const harness = hub!.info(detail.summary.harnessId ?? '')
        const stepup = await confirm(req, caller, 'task.mode-widen', { sessionId: id, configId: input.configId, value: input.value }, [
          { label: '会话', value: detail.summary.title || id },
          { label: 'Harness', value: harness ? `${harness.name}（${harness.id}）` : (detail.summary.harnessId ?? '') },
          { label: '当前模式', value: detail.config?.find(option => option.id === input.configId)?.currentValue ?? '' },
          { label: '新模式', value: input.value },
        ])
        recheck(caller, 'run')
        assertSessionCeiling(caller, hub!.levelOf(await hub!.harnessOf(id)))
        const seq = await audited({
          action: 'task.mode.widened',
          actor: actorOf(caller),
          target: id,
          stepup,
          detail: { sessionId: id, toHash: sha256Hex(input.value) },
        })
        try {
          await hub!.setConfig(id, input.configId, input.value, { allowWiden: true })
        } catch (error) {
          auditFailed(seq, caller)
          throw error
        }
        json(res, { accepted: true })
        return true
      }
      return false
    }

    // ---- Admin routes ----------------------------------------------------------------------------

    async function handleAdmin(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (path === '/link/api/plugins' && method === 'GET') {
        requireScope(caller, 'admin')
        json(res, { plugins: registry.list() })
        return true
      }
      const pluginMatch = path.match(/^\/link\/api\/plugins\/([^/]+)$/)
      if (pluginMatch && method === 'POST') {
        requireScope(caller, 'admin')
        const input = z.object({ enabled: z.boolean() }).parse(await jsonBody(req))
        await serial(caller, 'admin', () => setPluginEnabled(caller, safeDecode(pluginMatch[1]!), input.enabled))
        refresh()
        json(res, { plugins: registry.list() })
        return true
      }
      if (path === '/link/api/provider' && method === 'GET') {
        requireScope(caller, 'admin')
        const record = effectiveProvider(LEGACY_PROVIDER_ID)
        json(res, {
          configured: Boolean(record),
          baseURL: record?.baseURL ?? '',
          model: record?.defaultModel ?? '',
          hasKey: Boolean(record && usableKey(record)),
          demo: options.demo,
        })
        return true
      }
      if (path === '/link/api/provider' && method === 'PUT') {
        requireScope(caller, 'admin')
        const input = legacyProviderSchema.parse(await jsonBody(req))
        assertBaseURL(input.baseURL)
        recheck(caller, 'admin')
        const current = effectiveProvider(LEGACY_PROVIDER_ID)
        const { origin, stepup } = await confirmKey(
          req,
          caller,
          { id: LEGACY_PROVIDER_ID, name: current?.name ?? 'OpenAI 兼容接口' },
          input.baseURL,
          input.apiKey,
        )
        await serial(caller, 'admin', async () => {
          const seq = input.apiKey
            ? await audited({
                action: 'provider.secret.set',
                actor: actorOf(caller),
                target: LEGACY_PROVIDER_ID,
                stepup,
                detail: { providerId: LEGACY_PROVIDER_ID, originHash: sha256Hex(origin) },
              })
            : undefined
          const keyed = (record: ProviderRecord): ProviderRecord => {
            const { keyOrigin: _origin, ...rest } = record
            return {
              ...rest,
              baseURL: input.baseURL,
              apiKey: input.apiKey,
              ...(input.apiKey ? { keyOrigin: origin } : {}),
              defaultModel: input.model,
              models: withModel(record.models, input.model),
            }
          }
          const edited = editProvider(LEGACY_PROVIDER_ID, keyed)
          try {
            await (edited
              ? saveProvider(caller, ...edited)
              : saveProvider(
                  caller,
                  keyed({
                    id: LEGACY_PROVIDER_ID,
                    name: 'OpenAI 兼容接口',
                    kind: 'openai-compatible',
                    baseURL: input.baseURL,
                    apiKey: '',
                    enabled: true,
                    models: [],
                    defaultModel: input.model,
                  }),
                ))
          } catch (error) {
            auditFailed(seq, caller)
            throw error
          }
        })
        refresh()
        json(res, { configured: true })
        return true
      }
      if (path === '/link/api/providers' && method === 'GET') {
        requireScope(caller, 'admin')
        json(res, { providers: effectiveProviders().map(providerSettings), presets: PROVIDER_PRESETS })
        return true
      }
      if (path === '/link/api/providers' && method === 'POST') {
        requireScope(caller, 'admin')
        const input = providerCreateSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        assertBaseURL(input.baseURL)
        recheck(caller, 'admin')
        const id = input.id ?? newProviderId(input.presetId ?? input.name)
        if (idTaken(id)) throw new AppError(409, 'provider-exists', `标识 ${id} 已被占用`)
        const apiKey = input.apiKey ?? ''
        const keyed = apiKey ? await confirmKey(req, caller, { id, name: input.name }, input.baseURL, apiKey) : undefined
        const record = await serial(caller, 'admin', async () => {
          if (idTaken(id)) throw new AppError(409, 'provider-exists', `标识 ${id} 已被占用`)
          const next: ProviderRecord = {
            id,
            name: input.name,
            kind: input.kind,
            ...(input.presetId ? { presetId: input.presetId } : {}),
            baseURL: input.baseURL,
            apiKey,
            ...(keyed ? { keyOrigin: keyed.origin } : {}),
            enabled: input.enabled ?? true,
            models: withModel(input.models, input.defaultModel),
            defaultModel: input.defaultModel,
          }
          const seq = keyed
            ? await audited({
                action: 'provider.secret.set',
                actor: actorOf(caller),
                target: id,
                stepup: keyed.stepup,
                detail: { providerId: id, originHash: sha256Hex(keyed.origin) },
              })
            : undefined
          try {
            await saveProvider(caller, next)
          } catch (error) {
            auditFailed(seq, caller)
            throw error
          }
          return next
        })
        refresh()
        json(res, { provider: providerSettings(record) }, 201)
        return true
      }
      const providerMatch = path.match(/^\/link\/api\/providers\/([^/]+)(?:\/(models))?$/)
      if (providerMatch) {
        const id = safeDecode(providerMatch[1]!)
        if (method === 'POST' && providerMatch[2] === 'models') {
          requireScope(caller, 'admin')
          const record = effectiveProvider(id)
          if (!record) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
          json(res, await remoteModels(res, { kind: record.kind, baseURL: record.baseURL, apiKey: usableKey(record) }))
          return true
        }
        if (method === 'PUT' && !providerMatch[2]) {
          requireScope(caller, 'admin')
          const input = providerUpdateSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          if (input.baseURL) assertBaseURL(input.baseURL)
          recheck(caller, 'admin')
          const current = effectiveProvider(id)
          // A saved provider that failed to load has no plugin yet; saving it again is how it gets fixed.
          if (!current || (pluginInfo(id) && pluginInfo(id)?.managed !== 'provider'))
            throw new AppError(404, 'provider-not-found', '找不到该模型服务')
          const baseURL = input.baseURL ?? current.baseURL
          const newKey = typeof input.apiKey === 'string' && input.apiKey ? input.apiKey : undefined
          const keyed = newKey ? await confirmKey(req, caller, current, baseURL, newKey) : undefined
          const record = await serial(caller, 'admin', async () => {
            const before = effectiveProvider(id)
            if (!before) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
            const origin = originOf(baseURL)
            const hadKey = Boolean(before.apiKey)
            const clearing = input.apiKey === null || input.apiKey === ''
            const originChanged = hadKey && !newKey && !clearing && origin !== (before.keyOrigin ?? originOf(before.baseURL))
            let seq: number | undefined
            if (keyed)
              seq = await audited({
                action: 'provider.secret.set',
                actor: actorOf(caller),
                target: id,
                stepup: keyed.stepup,
                detail: { providerId: id, originHash: sha256Hex(keyed.origin) },
              })
            else if (hadKey && (clearing || originChanged)) {
              await audited(
                {
                  action: 'provider.secret.cleared',
                  actor: actorOf(caller),
                  target: id,
                  detail: { providerId: id, reason: clearing ? 'manual' : 'origin-changed' },
                },
                res,
              )
            }
            const edited = editProvider(id, previous => {
              const defaultModel = input.defaultModel ?? previous.defaultModel
              const { keyOrigin: previousOrigin, ...rest } = previous
              const apiKey = newKey ?? (clearing || originChanged ? '' : previous.apiKey)
              const keyOrigin = newKey ? origin : apiKey ? previousOrigin : undefined
              return {
                ...rest,
                ...(input.name ? { name: input.name } : {}),
                baseURL,
                apiKey,
                ...(keyOrigin ? { keyOrigin } : {}),
                models: withModel(input.models ?? previous.models, defaultModel),
                defaultModel,
                enabled: input.enabled ?? previous.enabled,
              }
            })
            if (!edited) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
            try {
              await saveProvider(caller, ...edited)
            } catch (error) {
              auditFailed(seq, caller)
              throw error
            }
            return edited[0]
          })
          refresh()
          json(res, { provider: providerSettings(record) })
          return true
        }
        if (method === 'DELETE' && !providerMatch[2]) {
          requireScope(caller, 'admin')
          await serial(caller, 'admin', async () => {
            const current = effectiveProvider(id)
            if (current?.apiKey)
              await audited(
                { action: 'provider.secret.cleared', actor: actorOf(caller), target: id, detail: { providerId: id, reason: 'deleted' } },
                res,
              )
            await deleteProvider(caller, id)
          })
          refresh()
          json(res, { deleted: true })
          return true
        }
      }
      if (path === '/link/api/provider-checks' && method === 'POST') {
        requireScope(caller, 'admin')
        const input = providerCheckSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        assertBaseURL(input.baseURL)
        recheck(caller, 'admin')
        let apiKey = input.apiKey
        if (apiKey === undefined && input.providerId) {
          const record = effectiveProvider(input.providerId)
          if (!record) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
          if (record.apiKey) {
            if (!record.keyOrigin || originOf(input.baseURL) !== record.keyOrigin)
              throw new AppError(409, 'key-origin-mismatch', '已保存的密钥只能发往保存时的地址，请重新输入密钥')
            apiKey = usableKey(record)
          }
        }
        json(res, await remoteModels(res, { kind: input.kind, baseURL: input.baseURL, apiKey: apiKey ?? '' }, true))
        return true
      }
      if (path === '/link/api/agents' && method === 'GET') {
        requireScope(caller, 'admin')
        json(res, { agents: config.settings().agents.map(agentSettings), presets: AGENT_PRESETS })
        return true
      }
      if (path === '/link/api/agents' && method === 'POST') {
        requireScope(caller, 'admin')
        const input = agentCreateSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        recheck(caller, 'admin')
        requireUnix(caller)
        const agents = config.settings().agents
        const taken = [
          STANDARD,
          ...agents.map(agent => agent.id),
          ...registry
            .list()
            .flatMap(plugin => plugin.capabilities.filter(item => item.startsWith('harness:')).map(item => item.slice('harness:'.length))),
        ]
        const id = input.id ?? availableId(input.presetId ?? input.name, taken)
        if (taken.includes(id) || hub!.info(id) || pluginInfo(`agent-${id}`)) throw new AppError(409, 'agent-exists', `标识 ${id} 已被占用`)
        const next: AgentRecord = {
          id,
          name: input.name,
          ...(input.presetId ? { presetId: input.presetId } : {}),
          command: input.command,
          args: input.args,
          env: { ...input.env },
          enabled: input.enabled ?? true,
        }
        const hash = await confirmAgent(req, caller, next)
        const record = await serial(caller, 'admin', async () => {
          if (config.settings().agents.some(agent => agent.id === id)) throw new AppError(409, 'agent-exists', `标识 ${id} 已被占用`)
          const seq = await audited({
            action: 'agent.defined',
            actor: actorOf(caller),
            target: id,
            stepup: hash.stepup,
            detail: { agentId: id, definitionHash: hash.definitionHash, created: true },
          })
          try {
            await saveAgent(caller, next, true)
          } catch (error) {
            auditFailed(seq, caller)
            throw error
          }
          return next
        })
        refresh()
        json(res, { agent: agentSettings(record) }, 201)
        return true
      }
      const agentMatch = path.match(/^\/link\/api\/agents\/([^/]+)$/)
      if (agentMatch && method === 'PUT') {
        requireScope(caller, 'admin')
        const id = safeDecode(agentMatch[1]!)
        const input = agentUpdateSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        recheck(caller, 'admin')
        const current = config.settings().agents.find(agent => agent.id === id)
        if (!current) throw new AppError(404, 'agent-not-found', '找不到该 Agent')
        const env = { ...current.env }
        for (const [key, value] of Object.entries(input.env ?? {})) {
          if (value === null) delete env[key]
          else env[key] = value
        }
        const next: AgentRecord = {
          ...current,
          ...(input.name ? { name: input.name } : {}),
          ...(input.command ? { command: input.command } : {}),
          ...(input.args ? { args: input.args } : {}),
          env,
          enabled: input.enabled ?? current.enabled,
        }
        const changed = definitionHash(next) !== definitionHash(current)
        const hash = changed ? (requireUnix(caller), await confirmAgent(req, caller, next)) : undefined
        const record = await serial(caller, 'admin', async () => {
          const latest = config.settings().agents.find(agent => agent.id === id)
          if (!latest) throw new AppError(404, 'agent-not-found', '找不到该 Agent')
          if (definitionHash(latest) !== definitionHash(current))
            throw new AppError(409, 'agent-changed', 'Agent 定义已被修改，请刷新后重试')
          const seq = hash
            ? await audited({
                action: 'agent.defined',
                actor: actorOf(caller),
                target: id,
                stepup: hash.stepup,
                detail: { agentId: id, definitionHash: hash.definitionHash, created: false },
              })
            : undefined
          try {
            await saveAgent(caller, next, false)
          } catch (error) {
            auditFailed(seq, caller)
            throw error
          }
          return next
        })
        refresh()
        json(res, { agent: agentSettings(record) })
        return true
      }
      if (agentMatch && method === 'DELETE') {
        requireScope(caller, 'admin')
        const id = safeDecode(agentMatch[1]!)
        await serial(caller, 'admin', () => deleteAgent(caller, id, res))
        refresh()
        json(res, { deleted: true })
        return true
      }
      if (path === '/link/api/workspaces' && method === 'POST') {
        requireScope(caller, 'admin')
        const input = workspaceSchema.parse(await jsonBody(req))
        const workspace = await serial(caller, 'admin', () => addWorkspace(caller, input))
        refresh()
        json(res, { workspace }, 201)
        return true
      }
      const workspaceMatch = path.match(/^\/link\/api\/workspaces\/([^/]+)$/)
      if (workspaceMatch && method === 'DELETE') {
        requireScope(caller, 'admin')
        const id = safeDecode(workspaceMatch[1]!)
        await serial(caller, 'admin', () => removeWorkspace(caller, id, res))
        refresh()
        json(res, { deleted: true })
        return true
      }
      if (path === '/link/api/preferences' && method === 'PUT') {
        requireScope(caller, 'admin')
        const input = preferencesSchema.parse(await jsonBody(req))
        await serial(caller, 'admin', () => savePreferences(caller, input.defaults))
        refresh()
        json(res, { defaults: sessionDefaults() })
        return true
      }
      return false
    }

    /** Agent definitions run as L3 code: saving command, arguments or environment needs local confirmation. */
    async function confirmAgent(
      req: IncomingMessage,
      caller: Caller,
      next: AgentRecord,
    ): Promise<{ stepup: StepupMethod; definitionHash: string }> {
      const verdict = validateAgentDefinition(next)
      if (!verdict.ok) throw verdict.error
      buildAgent(next)
      const hash = definitionHash(next)
      const resolved = resolveCommand(next.command)
      const stepup = await confirm(req, caller, 'agent.define', { agentId: next.id, definitionHash: hash }, [
        { label: 'Agent 标识', value: next.id },
        { label: '命令', value: resolved && resolved !== next.command ? `${next.command}（${resolved}）` : next.command },
        { label: '参数', value: JSON.stringify(next.args) },
        { label: '环境变量名', value: Object.keys(next.env).sort().join('、') || '（无）' },
        { label: '预设', value: next.presetId ?? '（无）' },
        { label: '定义状态', value: verdict.verified ? '已验证的预设' : '未验证的定义' },
      ])
      return { stepup, definitionHash: hash }
    }

    // ---- HTTP ------------------------------------------------------------------------------------

    async function handleApi(
      req: IncomingMessage,
      res: ServerResponse,
      listener: ListenerContext,
      path: string,
      method: string,
    ): Promise<void> {
      const connection = connectionOf(req, listener)
      if (await handlePublic(req, res, listener, connection, path, method)) return
      if (path === '/link/api/credentials/challenge' || path === '/link/api/credentials/renew') {
        if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在')
        const caller = await authenticate(req, listener, connection, true)
        if (!caller.device) throw authFailure('unauthorized')
        await handleCredentials(req, res, caller, path)
        return
      }
      const caller = await authenticate(req, listener, connection)
      if (!caller.device) {
        const route = `${method} ${path.replace(/^\/link\/api\/devices\/[^/]+$/u, '/link/api/devices/:id')}`
        if (!ANONYMOUS_UNIX.has(route) || path === '/link/api/devices/current') throw authFailure('unauthorized')
      }
      if (path === '/link/api/snapshot' && method === 'GET') {
        requireScope(caller, 'view')
        const snapshotRevision = revision
        const defaultId = defaultHarnessId()
        const providerId = defaultProviderId()
        // Only Standard requires a provider from this app's registry; other drivers own their backend.
        const execution: NonNullable<AppSnapshot['execution']> =
          defaultId === STANDARD
            ? {
                ready: registry.providers().some(provider => provider.id === providerId),
                providerId,
                modelConfigurationRequired: providerId === LEGACY_PROVIDER_ID && !effectiveProvider(LEGACY_PROVIDER_ID),
              }
            : { ready: true }
        const tasks = await hub!.listTasks()
        const snapshot: AppSnapshot = {
          instanceId,
          revision: snapshotRevision,
          device: currentDevice(caller),
          host: await hostView(),
          tasks,
          approvals: await decorateAll(hub!.approvals(), tasks),
          demo: options.demo,
          hostName: options.hostName ?? hostname(),
          harness: { id: defaultId, name: hub!.info(defaultId)?.name ?? defaultId },
          execution,
          catalog: catalog(),
          version: LATCH_VERSION,
        }
        json(res, snapshot)
        return
      }
      if (path === '/link/api/events' && method === 'GET') {
        requireScope(caller, 'view')
        const sessionId = new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('sessionId') ?? undefined
        if (sessionId && sessionId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
        if (!caller.credentialHash) throw authFailure('unauthorized')
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        streams.set(res, {
          deviceId: caller.device.id,
          credentialHash: caller.credentialHash,
          ...(sessionId ? { sessionId } : {}),
          lastSentRevision: revision,
        })
        send(res, { type: 'refresh', instanceId, revision })
        req.on('close', () => streams.delete(res))
        return
      }
      if (path === '/link/api/tasks' && method === 'POST') {
        await createTask(req, res, caller)
        return
      }
      const task = path.match(/^\/link\/api\/tasks\/([^/]+)(?:\/(prompt|cancel|config))?$/)
      if (task && (await handleTask(req, res, caller, safeDecode(task[1]!), task[2], method))) return
      const approval = path.match(/^\/link\/api\/approvals\/([^/]+)$/)
      if (approval && method === 'POST') {
        await decideApproval(req, res, caller, safeDecode(approval[1]!))
        return
      }
      const confirmation = path.match(/^\/link\/api\/confirmations\/([^/]+)$/)
      if (confirmation && (method === 'GET' || method === 'DELETE')) {
        requireDevice(caller)
        const id = safeDecode(confirmation[1]!)
        if (method === 'GET') limits.confirmationPoll.take(id)
        const ticket = presence.get(id, caller.device.id)
        if (!ticket) throw new AppError(404, 'confirmation-not-found', '找不到该确认')
        if (method === 'DELETE') {
          presence.cancel(id, caller.device.id)
          json(res, { cancelled: true })
          return
        }
        json(res, { confirmation: publicTicket(ticket) })
        return
      }
      if (path === '/link/api/audit/head' && method === 'GET') {
        requireScope(caller, 'view')
        json(res, audit.head())
        return
      }
      if (path === '/link/api/audit/hash' && method === 'GET') {
        requireScope(caller, 'view')
        const seq = Number(new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('seq'))
        const hash = Number.isSafeInteger(seq) && seq > 0 ? await audit.hashAt(seq) : undefined
        if (!hash) throw new AppError(404, 'not-found', '找不到该审计记录')
        json(res, { seq, hash })
        return
      }
      if (path === '/link/api/workspaces' && method === 'GET') {
        requireScope(caller, 'view')
        json(res, { workspaces: savedWorkspaces() })
        return
      }
      if (await handleDevices(req, res, caller, path, method)) return
      if (path === '/link/api/policy') {
        requireDevice(caller)
        await handlePolicy(req, res, caller, method)
        return
      }
      if (await handleAdmin(req, res, caller, path, method)) return
      throw new AppError(404, 'not-found', '接口不存在')
    }

    /** Host header and Origin come from the client; they are only compared with the listener's own values. */
    function checkRequest(req: IncomingMessage, res: ServerResponse, listener: ListenerContext, path: string, method: string): boolean {
      if (listener.listener === 'unix') return true
      if (req.headers.host !== listener.host) {
        const loose =
          listener.port !== undefined && new Set([`localhost:${listener.port}`, `127.0.0.1:${listener.port}`, `[::1]:${listener.port}`])
        if (
          loose
          && loose.has(req.headers.host ?? '')
          && (method === 'GET' || method === 'HEAD')
          && ['/', '/link', '/link/'].includes(path)
        ) {
          res.writeHead(302, { location: `${listener.origin}/link/` })
          res.end()
          return false
        }
        throw new AppError(403, 'invalid-host', '访问地址与当前节点不匹配')
      }
      const origin = req.headers.origin
      if (origin !== undefined && origin !== listener.origin) throw new AppError(403, 'invalid-origin', '不接受跨站请求')
      const site = req.headers['sec-fetch-site']
      if (site !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(method) && site !== 'same-origin')
        throw new AppError(403, 'invalid-origin', '不接受跨站请求')
      return true
    }

    async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
      if (method !== 'GET' && method !== 'HEAD') throw new AppError(405, 'method-not-allowed', '不支持此操作')
      if (path === '/' || path === '/link') {
        res.writeHead(302, { location: '/link/' })
        res.end()
        return
      }
      if (!path.startsWith('/link/')) throw new AppError(404, 'not-found', '页面不存在')
      const relativePath = safeDecode(path.slice('/link/'.length)) || 'index.html'
      const root = resolve(options.uiDir)
      const file = resolve(root, relativePath)
      if (!file.startsWith(root + sep)) throw new AppError(403, 'invalid-path', '文件路径无效')
      let data: Buffer
      try {
        if (!(await stat(file)).isFile()) throw new AppError(404, 'not-found', '文件不存在')
        data = await readFile(file)
      } catch (error) {
        if (error instanceof AppError) throw error
        if (codeOf(error) === 'ENOENT' || codeOf(error) === 'EISDIR' || codeOf(error) === 'ENOTDIR')
          throw new AppError(404, 'not-found', '文件不存在')
        throw error
      }
      res.setHeader('content-security-policy', UI_CSP)
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': relativePath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      res.end(req.method === 'HEAD' ? undefined : data)
    }

    async function handle(req: IncomingMessage, res: ServerResponse, listener: ListenerContext): Promise<void> {
      if (closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
      const method = req.method ?? 'GET'
      const path = new URL(req.url ?? '/', 'http://latch.invalid').pathname
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('x-frame-options', 'DENY')
      if (listener.listener === 'lan-tls' || listener.listener === 'tailnet-tls')
        res.setHeader('strict-transport-security', 'max-age=31536000')
      if (!checkRequest(req, res, listener, path, method)) return
      if (path.startsWith('/link/api/')) {
        await handleApi(req, res, listener, path, method)
        return
      }
      await serveStatic(req, res, path, method)
    }

    function fail(res: ServerResponse, error: unknown, listener: ListenerContext): void {
      let failure = error
      // Only requests without a usable credential are throttled, per listener class: answers about a known device's
      // credential (renewal-required, revoked, expired) keep their code, so a flood elsewhere cannot hide them.
      if (failure instanceof AppError && failure.status === 401 && failure.code === 'unauthorized' && listener.listener !== 'unix') {
        try {
          limits.authFailure.take(listener.listener)
        } catch (limited) {
          failure = limited
        }
      }
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (failure instanceof AppError) {
        const retryAfter = failure.details?.retryAfter
        if (typeof retryAfter === 'number') res.setHeader('retry-after', String(retryAfter))
        json(res, { ...failure.details, error: failure.code, message: failure.message }, failure.status)
        return
      }
      if (failure instanceof z.ZodError) {
        json(res, { error: 'invalid-input', message: '输入格式不正确，请检查必填内容' }, 400)
        return
      }
      log(`Request failed: ${errorText(failure)}`)
      json(res, { error: 'internal-error', message: '操作未完成，请刷新确认状态后重试' }, 500)
    }

    listeners = await startListeners({
      hostId,
      socketPath: runtime.socketPath,
      port: options.port,
      ...(tls ? { tls } : {}),
      log,
      now,
      handler: (req, res, listener) => {
        void handle(req, res, listener).catch(error => fail(res, error, listener))
      },
    })
    const started = listeners
    startupCleanup.push(() => started.close())
    loopbackOrigin = started.loopbackOrigin
    tlsOrigin = started.tlsOrigin
    if (options.egressAllow?.length) log(`进程级出站白名单：${options.egressAllow.join('、')}`)

    await audit.append({
      action: 'host.started',
      actor: { listener: 'host', via: 'startup' },
      detail: {
        hostId,
        version: LATCH_VERSION,
        policyHash: policy.hash(),
        settingsHash: sha256Hex(canonicalJson(config.settings())),
        devMode: true,
      },
    })

    return {
      hostId,
      hostId8,
      instanceId,
      pid: process.pid,
      loopbackOrigin,
      origin: loopbackOrigin,
      loopbackPort: started.loopbackPort,
      ...(tlsOrigin ? { tlsOrigin } : {}),
      socketPath: runtime.socketPath,
      runtimeDir: runtime.runtimeDir,
      startedAt,
      bridge: harnessHub,
      registry,
      config,
      security: { devices, enrollments, presence, audit, policy },
      close() {
        return (shutdown ??= (async () => {
          closing = true
          clearInterval(heartbeat)
          clearTimeout(eventTimer)
          unsubscribe()
          for (const res of streams.keys()) res.end()
          streams.clear()
          const failures: unknown[] = []
          for (const dispose of [
            () => changes,
            () => harnessHub.close(),
            () => registry.close(),
            () => started.close(),
            // Agents are stopped by now; their per-session temp dirs go with the runtime dir.
            () => rm(runtime.tmpRoot, { recursive: true, force: true }),
            () =>
              unlink(runtime.socketPath).catch(error => {
                if (error?.code !== 'ENOENT') throw error
              }),
            () =>
              rmdir(runtime.runtimeDir).catch(error => {
                if (error?.code !== 'ENOENT') throw error
              }),
            // The listeners are closed, so requests have stopped arriving; this drains the device writes they queued.
            () => devices.close(),
            () => audit.close(),
          ]) {
            try {
              await dispose()
            } catch (error) {
              failures.push(error)
            }
          }
          if (failures.length) throw new AggregateError(failures, 'Host shutdown cleanup failed')
        })())
      },
    }
  } catch (error) {
    const failures: unknown[] = []
    for (const dispose of startupCleanup.reverse()) {
      try {
        await dispose()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Host startup and cleanup failed')
    throw error
  }
}
