import { ConfigRequests } from './config-requests.ts'
import {
  HeldPlugins,
  HOST_PROTOCOL,
  PLUGIN_PACKAGE_FORMATS,
  RequestRecords,
  UPDATE_COMMIT_TTL_MS,
  UpdateWindow,
  updateWindowInputSchema,
} from './update-window.ts'
import { CustomAgents, type AgentActor } from './custom-agents.ts'
import { Automations, automationSummary } from './automations.ts'
import { Handoffs } from './handoffs.ts'
import { AgentPlans } from './agent-plans.ts'
import { agentPluginRevision } from './agent-revisions.ts'
import { executionBuildRevision } from './execution-build.ts'
import type { AgentExecutionContext, AutomationConfig } from '@latch/protocol'
import { readPreviewFrame, WORKER_CSP } from './preview-frames.ts'
import { PromptQueues, type QueueActor } from './prompt-queues.ts'
import { Questions } from './questions.ts'
import { createQuestionsPlugin } from './plugins/tools/questions/index.ts'
import { forkSeed } from './forks.ts'
import { createFileTrackingService } from './files/output-tracker.ts'
import { checkedFileMentions, fileMentionsSchema } from './file-mentions.ts'
import { AttachmentStore } from './attachments.ts'
import { createAttachmentRoutes, assertAttachmentCapability } from './attachment-routes.ts'
import type { AttachmentSelection, AttachmentCapabilities, AttachmentRef } from '@latch/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
export { loadPluginPackage } from './plugin-packages.ts'
import { lstat, mkdir, chmod, readFile, readdir, realpath, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  AGENT_PRESETS,
  type AgentPreset,
  pairRoute,
  PROJECT_GLYPHS,
  WIRE_NAMES,
  escapeSecurityText,
  PROVIDER_KINDS,
  PROVIDER_PRESETS,
  isLocalListener,
  isNativeListener,
  rejectionNote,
  RISK_REASON_TEXT,
  type AgentPresetSettings,
  type AgentRecord,
  type AgentSettings,
  type AppDataEvent,
  type AppSnapshot,
  type CommandDetection,
  type Approval,
  type ApprovalReceipt,
  type CancelOutcome,
  type CancelReceipt,
  type ChangeEvent,
  type CurrentDevice,
  type DeviceScope,
  type FolderVia,
  type HarnessInfo,
  type HostCatalog,
  type HostStateEvent,
  type HostView,
  type ModelCapabilities,
  type ModelRef,
  type PermissionLevel,
  type PluginInfo,
  type PresenceAction,
  type ProviderDestination,
  type ProviderSettings,
  type PresenceSubject,
  type ProviderSummary,
  type RiskLevel,
  type SessionDefaults,
  type TaskDetail,
  type TaskStateEvent,
  type RunEnd,
  type TaskStatus,
  type TaskSummary,
  type UnusableProvider,
  type WorkspaceInfo,
} from '@latch/protocol'
import {
  AppError,
  type FileTrackingInput,
  type HarnessDriver,
  type HarnessSecurityEvent,
  type HostProject,
  type ModelRoute,
  type ProjectFolder,
  type ToolRiskInput,
  type HarnessPlugin,
  type SessionFolder,
} from '@latch/sdk'
import { PluginRegistry } from '@latch/core'
import { canonicalJson, sha256Hex, redactSecrets } from '@latch/core/node-kit'
import {
  createAcpAgentPlugin,
  forgetCommandLookups,
  presetOffer,
  presetRecord,
  resolveCommand,
  setCommandSearch,
  setLoginPrograms,
  validateAgentDefinition,
} from '@latch/harness-acp'
import { AuditLog, type AuditActor, type StepupMethod } from './audit.ts'
import { excludeFromBackup } from './backup.ts'
import { PRIVATE_ENTRIES, isPrivateEntry } from './data-entries.ts'
import { DeviceStore, EnrollmentService, type ConnectionContext } from './auth.ts'
import { hashDisplay } from './crypto.ts'
import { discoveryEpochInput } from '@latch/link-wire'
import type { NativeOpening } from './native.ts'
import type { OfficialRelay } from './relay/official.ts'
import type { NativeNetworkBackend } from './native-network-backend.ts'
import { NativeReplay } from './native-replay.ts'
import { RelayProfiles, secretBytes } from './relay/profiles.ts'
import { HostAddressBooks } from './relay/address-book.ts'
import { HostRelayDirectory } from './relay/directory.ts'
import { createEgressFetch, createEgressInspector, type EgressReason, type FetchLike, type LookupFunction } from './egress.ts'
import { loadOrCreateHostIdentity } from './identity.ts'
import { ModelGatewayServer, type GatewayService } from './model-gateway.ts'
import {
  DENY_READ_HOME_PATHS,
  PROJECT_FOLDER_LIMIT,
  canonicalPath,
  checkFolderCandidate,
  checkPrivateFile,
  checkProjectFolders,
  classifyDefaultWorkspace,
  isPrintableText,
  latchCodeRoot,
  prepareRuntimeDir,
  resolveLatchPaths,
  type FolderGuardContext,
  type FolderProblem,
} from './paths.ts'
import { foldersHash, newProject, planFolders, reorderFolders, type FolderRefusal, type ProjectPrimary } from './projects.ts'
import { PolicyStore, isLowering, policyDiff, type Policy } from './policy.ts'
import { PresenceService, createPresenceBackend, paramsHash, policySubject, type PresenceBackend } from './presence.ts'
import { classifyStandardCall, targetFolder, type CallFolder } from './risk.ts'
import {
  authFailure,
  createRateLimits,
  hasAuthorization,
  isSocketTransport,
  levelAtMost,
  localOnly,
  presentedCredential,
  publicTicket,
  scopeRequired,
  stepupRequired,
  type AuthFailureCode,
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
import {
  FOLDER_ID,
  HostConfig,
  PROVIDER_ID,
  BACKUP_EXCLUDED_CONFIG_FILES,
  availableId,
  addressOf,
  keyScopeOf,
  keyScopeText,
  modelCapabilitiesSchema,
  modelEffort,
  originOf,
  type HostSettings,
  type ProviderRecord,
  type WorkspaceRecord,
} from './config.ts'
import type { HarnessKind } from './harness-trust.ts'
import { HarnessHub, listSignature, runEndOutline, type HubCreateInput } from './hub.ts'
import { SessionLifecycle, projectIdOf, type LifecycleBounds, type LifecycleListeners } from './session-lifecycle.ts'
import { RUN_ID, type ApprovalRecord, type CancelRecord } from './session-meta.ts'
import { sendNotFoundPage } from './not-found.ts'
import { SessionFolders } from './session-folders.ts'
import { Worktrees, type Worktree } from './worktrees.ts'
import { writeProjectContext } from './project-context.ts'
import { AgentProbes } from './agent-probes.ts'
import type { HostInfo } from './host-state.ts'
import { HostLifecycle, hostStateInputSchema } from './lifecycle.ts'
import { TrafficMeter, type FrameKind, type StreamMeter } from './traffic.ts'
import {
  checkProvider,
  isPresetKeyOrigin,
  keyBoundTo,
  listProviderModels,
  OriginUnconfirmed,
  addressesConfirmedBefore,
  providerPlugin,
  providerSettings,
  summarizeProvider,
  underBase,
  usableKey,
  type ModelListInput,
} from './providers.ts'
import { createDemoPlugin } from './plugins/providers/demo/index.ts'
import { createToolsPlugin } from './plugins/tools/safe-tools/index.ts'
import { standardHarnessDriver } from './plugins/standard/index.ts'
import { createWorkspacePlugin } from './plugins/tools/workspace-files/index.ts'
import { PromptTemplateStore } from './prompt-templates.ts'
import { createSessionRoutes } from './session-routes.ts'
import { createFileRoutes } from './files/index.ts'
import { FileDirectoryReader } from './files/directory.ts'
import { FileReferenceStore } from './files/reference-store.ts'
import { PluginAssets } from './plugin-assets.ts'
import { AppDataStore } from './app-data.ts'
import { AppDiagnostics } from './app-diagnostics.ts'
import { capabilityLines, capabilitySummary } from './app-capabilities.ts'
import { createPluginPackageRoutes, installedAssetPlugin } from './plugin-package-routes.ts'
import { createRoutes } from './routes/index.ts'
import type { GitRouteOptions } from './routes/git.ts'
import { TerminalService, type TerminalServiceOptions } from './terminal/service.ts'
import { RENEW_INTERVAL_MS, UNIX_ADDRESS } from './routes/devices.ts'
import { opaqueId } from './audit-actions/fields.ts'
import {
  BASE_RETRIES,
  CONFIG_BODY_LIMIT,
  type AuditEvent,
  type Caller,
  type CallerRequest,
  type DeviceCaller,
  type PreviewLine,
  type RouteContext,
  type RouteRequest,
} from './routes/registry.ts'

export type { TlsListenerOptions } from './listeners.ts'

export const LATCH_VERSION = '0.1.0'

const TASK_BODY_LIMIT = 256 * KIB
const HARNESS_ID = /^[a-zA-Z0-9_-]{1,64}$/
const LEGACY_PROVIDER_ID = 'openai-compatible'
const STANDARD = 'standard'
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(['running', 'waiting-approval'])
const L3_WARNINGS = [
  '它可以读写 Latch 的数据和这台 Mac 的身份密钥，也可以在其他电脑上冒充这台 Mac 上的 Latch。',
  '它发起的询问只是提示，Latch 不隔离它。',
]
/** Unix connections without a credential may reach only these. */
const ANONYMOUS_UNIX = new Set([
  'GET /link/api/devices',
  'DELETE /link/api/devices/:id',
  'POST /link/api/pairings',
  'GET /link/api/native/info',
  'GET /link/api/traffic',
])

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
const modelRefSchema = z.object({ providerId: z.string().min(1).max(64), model: modelId, effort: modelEffort.optional() })
const promptSchema = z.object({
  fileRefs: fileMentionsSchema,
  prompt: z.string().trim().max(16_000),
  attachmentIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{22}$/u))
    .max(8)
    .optional(),
  requestId: z.string().uuid(),
  model: modelRefSchema.optional(),
})
/** `steer`: add it to the running turn when the harness takes that, and queue it otherwise. */
const queuedPromptSchema = promptSchema.extend({
  queue: z.boolean().optional(),
  steer: z.boolean().optional(),
  /** This turn starts a new context: the agent sees none of the earlier messages, which stay in the history. */
  freshContext: z.literal(true).optional(),
})
const createTaskSchema = promptSchema.extend({
  prompt: z.string().trim().max(16_000).default(''),
  forkOf: z
    .object({ taskId: z.string().min(1).max(256), upToMessageId: z.string().min(1).max(256) })
    .strict()
    .optional(),
  mode: z.enum(['chat', 'agent']).optional(),
  harnessId: z.string().regex(HARNESS_ID).optional(),
  workspaceId: z.string().min(1).max(64).optional(),
  /** Start in a new Git worktree of the project's folder, on a branch of its own. */
  worktree: z.literal(true).optional(),
  customAgentId: z
    .string()
    .regex(/^agt_[a-f0-9-]{36}$/u)
    .optional(),
  /** Choices from the harness's catalogue, set before the first prompt. */
  config: z
    .array(z.strictObject({ configId: z.string().min(1).max(128), value: z.string().max(1024) }))
    .max(16)
    .refine(entries => new Set(entries.map(entry => entry.configId)).size === entries.length, '每个设置只能选一次')
    .optional(),
})
const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine(value => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined, '没有要修改的内容')
const configSchema = z.strictObject({
  configId: z.string().min(1).max(128),
  value: z.string().max(1024),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u)
    .optional(),
})
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const decisionSchema = z.strictObject({
  decision: z.enum(['allow', 'reject']),
  optionId: z.string().min(1).max(128).optional(),
  /** With a rejection: what to do instead, for a harness that hands it on (`rejectionNote` decides what is accepted). */
  note: z.string().max(4096).optional(),
  requestId: requestIdSchema.optional(),
})
/** Both optional so a page loaded before them can still stop a run; such a cancel stops whatever is running. */
const cancelSchema = z.strictObject({
  requestId: requestIdSchema.optional(),
  runId: z.string().regex(RUN_ID).optional(),
})
/** A subagent row's message ID. */
const stopSubagentSchema = z.strictObject({ subagentId: opaqueId })
/** Names the threshold the person saw, so a retry or a second device cannot double it again. */
const keepWaitingSchema = z.strictObject({
  runId: z.string().regex(RUN_ID),
  thresholdMs: z.number().int().positive(),
})
const providerKind = z.enum(PROVIDER_KINDS)
const modelList = z.array(modelId).max(1000)
const modelCapabilitiesRecord = z.record(modelId, modelCapabilitiesSchema).refine(value => Object.keys(value).length <= 1000)
/**
 * `confirmOrigin`: confirm the address on this computer in the same request when it is not confirmed yet, or when it
 * needs an outbound allowance it lacks (desktop only). Without it, a keyless service at an unconfirmed address is saved
 * but not used until someone confirms the address.
 */
const providerCreateSchema = z.object({
  id: z.string().regex(PROVIDER_ID).optional(),
  name: z.string().trim().min(1).max(80),
  kind: providerKind,
  presetId: z.string().regex(PROVIDER_ID).optional(),
  baseURL: httpURL,
  apiKey: apiKeyText.optional(),
  models: modelList.default([]),
  modelCapabilities: modelCapabilitiesRecord.optional(),
  defaultModel: modelId,
  enabled: z.boolean().optional(),
  confirmOrigin: z.boolean().optional(),
})
const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  kind: providerKind.optional(),
  baseURL: httpURL.optional(),
  apiKey: apiKeyText.nullable().optional(),
  models: modelList.optional(),
  modelCapabilities: modelCapabilitiesRecord.optional(),
  defaultModel: modelId.optional(),
  enabled: z.boolean().optional(),
  confirmOrigin: z.boolean().optional(),
})
const providerOriginSchema = z.object({ baseURL: httpURL })
/** Thinking levels are each protocol's own words, so a service that changes protocol keeps none it declared. */
function withoutThinking(all: Record<string, ModelCapabilities> | undefined): Record<string, ModelCapabilities> | undefined {
  if (!all) return undefined
  const kept = Object.entries(all).flatMap(([model, { thinking: _thinking, ...rest }]) =>
    Object.keys(rest).length ? [[model, rest] as const] : [],
  )
  return kept.length ? Object.fromEntries(kept) : undefined
}
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
const folderPathsSchema = z.array(z.string().min(1).max(4096)).min(1).max(PROJECT_FOLDER_LIMIT)
const projectNameSchema = z.string().trim().min(1).max(80)
/** Signed by the desktop app's main process; `signature` is checked and removed before this schema applies. */
const projectCreateSchema = z
  .object({
    nonce: z.string().min(1).max(128),
    via: z.enum(['picker', 'drop']),
    paths: folderPathsSchema,
    name: projectNameSchema.optional(),
  })
  .strict()
/** 存为项目: the desktop saves a session's own folder as a new project's primary folder; the page sends no path. */
const sessionProjectSchema = z
  .object({
    nonce: z.string().min(1).max(128),
    via: z.literal('session'),
    sessionId: z.string().min(1).max(256),
  })
  .strict()
const folderAddSchema = z
  .object({
    nonce: z.string().min(1).max(128),
    via: z.enum(['picker', 'drop']),
    paths: folderPathsSchema,
    replace: z.string().regex(FOLDER_ID).optional(),
  })
  .strict()
const projectPatchSchema = z
  .object({
    name: projectNameSchema.optional(),
    glyph: z.enum(PROJECT_GLYPHS).nullable().optional(),
    order: z.array(z.string().regex(FOLDER_ID)).min(1).max(PROJECT_FOLDER_LIMIT).optional(),
  })
  .strict()
  .refine(value => value.name !== undefined || value.glyph !== undefined || value.order !== undefined, '没有要修改的内容')
const preferencesSchema = z.object({
  defaults: z.object({
    harnessId: z.string().regex(HARNESS_ID).optional(),
    mode: z.enum(['chat', 'agent']).optional(),
    workspaceId: z.string().min(1).max(64).optional(),
    model: modelRefSchema.nullable().optional(),
    pinned: z.boolean().optional(),
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
    hostEgressAllow: z
      .object({ add: z.array(egressEntry).max(64).optional(), remove: z.array(egressEntry).max(64).optional() })
      .strict()
      .optional(),
    // Only removal: an origin is confirmed by saving a model service, never by editing the policy.
    confirmedAddresses: z
      .object({ remove: z.array(z.string().trim().min(1).max(2400)).max(256) })
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
  /** Provider from `LATCH_MODEL`; it replaces the connection of `openai-compatible` for this process and is never persisted. */
  provider?: { baseURL: string; apiKey: string; model: string }
  plugins?: HarnessPlugin[]
  /** Process-level default provider (`--provider`); it overrides the saved default. */
  providerId?: string
  /** Process-level default harness (`--harness`); it must start, and its plugin cannot be disabled. */
  harnessId?: string
  /** Builds the plugin for an agent definition. Defaults to the ACP adapter. */
  agentPlugin?: (agent: AgentRecord) => HarnessPlugin
  tls?: TlsListenerOptions
  native?: { host: string; port: number }
  /** Private platform discovery backend; tests disable it explicitly. */
  nativeNetwork?: false | (() => Promise<NativeNetworkBackend>)
  /** Extra platform trust anchors for privately operated relay TLS, supplied only by the Host operator. */
  nativeRelayCa?: string | Buffer
  /** Composition-root injection; production uses a public-only, DNS-checked fetch without the model allowlist. */
  nativeDirectoryFetch?: FetchLike
  /** Tests; default per-user runtime dir. */
  runtimeParent?: string
  agentsDir?: string
  /** Where sessions' Git worktrees go; default beside the start directory (`LATCH_WORKTREES_DIR` replaces it). */
  worktreesDir?: string
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
  /** Tests: the times recorded on messages and runs and sent to clients as the Host's time. Default `Date.now`. */
  clock?: () => number
  /** Tests: the computer's name in the snapshot; default the operating system's host name. */
  hostName?: string
  /**
   * Tests only: decides the pairing proximity gate, because a loopback socket can never prove it. Production never sets
   * it and asks the network component, refusing when that cannot answer. Only the native-direct listener consults it.
   */
  nativeNearby?: (opening: NativeOpening, gatewayHash: Uint8Array) => boolean | Promise<boolean>
  /** Tests; default the compiled list (`relay/official.ts`). */
  officialRelays?: readonly OfficialRelay[]
  /** Tests: 'relaxed' multiplies every rate-limit bucket by 100. Production never sets it. */
  rateLimits?: 'default' | 'relaxed'
  /** Tests: runs after a file reference was resolved and checked, before the file is opened. Production never sets it. */
  fileHooks?: { afterResolve?(realPath: string): Promise<void> }
  /** Tests: runs after a file edit's temporary file is written, before the final check and the rename. Production never sets it. */
  fileEditHooks?: { beforeRename?(): Promise<void> }
  /** Tests: the terminal component (`binary`, default `dist/native/latch-pty`) or a stand-in for it. Production never sets it. */
  terminal?: Pick<TerminalServiceOptions, 'launch' | 'shell' | 'hostEnv'> & { binary?: string }
  /** Tests: the Git, home, environment, shell and time limits of 交付 (`routes/git.ts`). Production never sets it. */
  gitDelivery?: GitRouteOptions
  /**
   * Finds the programs whose login commands the Host may run. The start script passes `resolveCommand`; left out, as in
   * tests, no real program on this computer can be run to check or start a login.
   */
  loginPrograms?: (command: string) => string | undefined
  /**
   * Where a bare command name is looked for: an agent's command, its adapter, the programs a preset points it at. The
   * start script passes `personCommandDirectories`; left out, as in tests, only absolute commands are found, so no real
   * agent on this computer can be described, offered or started. Tests name their own directories.
   */
  commandDirectories?: () => readonly string[]
  /** Tests: receives a harness's login script instead of a terminal opening. Production never sets it. */
  loginTerminal?: (script: string) => Promise<void>
  /** Tests: how long a run's first prompt and a stop wait for lifecycle listeners. Production never sets it. */
  lifecycleBounds?: Partial<LifecycleBounds>
  /** Default `console.error('[Latch] ' + text)`; every line is redacted first. */
  log?: (text: string) => void
  /**
   * Each new Agent session outside a saved project works in a new folder of its own inside the start directory
   * (`<yyyymmdd>-<4 hex>`, 0700). The start script sets it when the start directory is the Host's default, that is
   * without `--workspace` or `LATCH_WORKSPACE`; a start directory the owner chose is used as it is.
   */
  sessionFolders?: boolean
  /** Tests: the four hex characters of a session folder's name; default random. */
  sessionFolderSuffix?: () => string
  /**
   * Offers what it finds as Harnesses on the desktop app, with no step to add them. The start script passes
   * `detectPresetCommands`; left out, as in tests, no real command on this computer can end up chosen for a session.
   */
  detectPreset?: (preset: AgentPreset) => CommandDetection
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
  nativePort?: number
  socketPath: string
  runtimeDir: string
  startedAt: string
  bridge: HarnessHub
  registry: PluginRegistry
  config: HostConfig
  security: { devices: DeviceStore; enrollments: EnrollmentService; presence: PresenceService; audit: AuditLog; policy: PolicyStore }
  /** The session lifecycle events route modules listen to, for tests. */
  lifecycle: LifecycleListeners
  close(): Promise<void>
}

interface EventStream {
  nativeOpening?: NativeOpening
  paddingObserved?: boolean
  deviceId: string
  credentialHash: string
  sessionId?: string
  lastSentRevision: number
  meter: StreamMeter
}

/** Where a saved key may be sent: an origin and the path under it. */
type KeyScope = { keyOrigin: string; keyPath: string }

/**
 * What saving a model service at an address adds to the policy: its address (origin and path) to `confirmedAddresses`
 * and, for a local or private address, its `host:port` to the outbound allow list. `reason` says why the address needs
 * the allowance.
 */
interface DestinationPlan {
  origin: string
  /** The origin and path that is confirmed (`addressOf`). */
  address: string
  /** `host:port` of the origin, for the confirmation's title. */
  hostPort: string
  addAddress: boolean
  /** The allow-list entry to add; absent when none is needed or it is already there. */
  egress?: string
  reason?: EgressReason
}

function approvalReceipt(record: ApprovalRecord): ApprovalReceipt {
  return {
    approvalId: record.approvalId,
    decision: record.decision,
    ...(record.optionId ? { optionId: record.optionId } : {}),
    at: record.at,
  }
}

function cancelReceipt(sessionId: string, record: Omit<CancelReceipt, 'sessionId' | 'replay'>): CancelReceipt {
  return {
    sessionId,
    ...(record.requestId ? { requestId: record.requestId } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    outcome: record.outcome,
    ...(record.status ? { status: record.status } : {}),
    at: record.at,
    ...(record.runEnd ? { runEnd: record.runEnd } : {}),
  }
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

/** The `LATCH_BASE_URL` overlay is never persisted or validated by the config schema, so its rules apply at startup. */
function assertEnvBaseURL(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError(400, 'invalid-url', 'LATCH_BASE_URL 不是有效的 HTTP(S) 地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError(400, 'invalid-url', 'LATCH_BASE_URL 仅支持 HTTP 或 HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'invalid-url', 'LATCH_BASE_URL 不能包含凭据、查询参数或片段，请把密钥放在 LATCH_API_KEY 中')
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

type DisabledReason = 'overlap' | 'code-root' | 'protected' | 'invalid' | 'missing' | 'permission'

/** Audit reason for a saved project that has become unusable. */
function disabledReason(problem: FolderProblem): DisabledReason {
  if (problem === 'overlap' || problem === 'code-root' || problem === 'protected' || problem === 'permission') return problem
  if (problem === 'missing' || problem === 'not-directory') return 'missing'
  return 'invalid'
}

/** How long a project's folder states are reused for listings; session starts always check afresh. */
const PROJECT_STATE_TTL = 5_000
const START_DIRECTORY = '默认文件夹'

interface FolderState {
  id: string
  path: string
  problem?: FolderProblem
  message?: string
}

interface ProjectState {
  at: number
  /** The folder list the state was computed for; an edited project is checked again. */
  key: string
  folders: FolderState[]
  /** The first failure: its folder (absent for a settings entry that is itself invalid), audit reason and text. */
  failure?: { index?: number; reason: DisabledReason; message: string }
}

function stateKey(record: WorkspaceRecord): string {
  return canonicalJson({ path: record.path, folders: record.folders })
}

/** The folders a session was created with, as its driver recorded them; a session without them uses its `cwd` alone. */
function sessionFolders(task: TaskSummary, workspaceRoot: string): string[] {
  return task.folders?.length ? task.folders.map(folder => folder.path) : [task.cwd ?? workspaceRoot]
}

/** What a Standard call is classified against: the session's working directory and the folders it recorded. */
type SessionScope = { cwd?: string; folders?: ReadonlyArray<ProjectFolder> }

/** The session's folders with their IDs; one that recorded none has one, `default`, at its working directory (as the runtime). */
function scopeFolders(session: SessionScope, workspaceRoot: string): ProjectFolder[] {
  return session.folders?.length
    ? session.folders.map(folder => ({ id: folder.id, path: folder.path }))
    : [{ id: 'default', path: session.cwd ?? workspaceRoot }]
}

function workspaceChanged(): AppError {
  return new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了，不能继续。请新建会话。')
}

function foldersRefused(refused: FolderRefusal[]): AppError {
  return new AppError(409, 'workspace-folders-refused', '选择的文件夹都没有加入', { refused })
}

function unprintableName(): AppError {
  return new AppError(400, 'workspace-folder-unprintable', '项目名称包含不可显示的字符')
}

function folderInUse(): AppError {
  return new AppError(409, 'workspace-in-use', '有正在运行或等待批准的会话在使用这个文件夹，请先停止这些会话')
}

function folderGrantInvalid(): AppError {
  return new AppError(403, 'folder-grant-invalid', '添加文件夹的请求没有通过桌面端校验，没有加入任何文件夹')
}

/** The same folders in the same order. */
function sameFolders(a: ReadonlyArray<ProjectFolder>, b: ReadonlyArray<ProjectFolder>): boolean {
  return a.length === b.length && a.every((folder, index) => folder.id === b[index]!.id && folder.path === b[index]!.path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Canonical forms of the paths that still resolve. */
async function canonicalSet(paths: readonly string[]): Promise<Set<string>> {
  const resolved = await Promise.all(paths.map(path => canonicalPath(path).catch(() => undefined)))
  return new Set(resolved.filter((path): path is string => path !== undefined))
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

/**
 * With the workspace inside the data directory, a private entry that does not exist yet is protected
 * only by its exact spelling, yet on a case-insensitive disk `Providers.json` is `providers.json`.
 * This finds the data directory among a target's ancestors by identity and then allows only the
 * workspace's own entry, also by identity; a workspace that is the data directory itself allows
 * every name that does not fold to a private one.
 */
function guardDataDir(plugin: HarnessPlugin, dataDir: string, workspace: string): HarnessPlugin {
  const exposed = relative(dataDir, workspace).split(sep)[0] ?? ''
  async function assertAllowed(
    context: { workspaceRoot: string; workspaceFolders?: ReadonlyArray<SessionFolder> },
    args: Record<string, unknown>,
  ): Promise<void> {
    // The tool itself rejects other input, a `folder` that names no session folder included.
    if (typeof args.path !== 'string' || isAbsolute(args.path)) return
    const folders = context.workspaceFolders?.length
      ? context.workspaceFolders
      : [{ id: 'default', path: context.workspaceRoot, primary: true }]
    const root = (
      args.folder === undefined ? (folders.find(folder => folder.primary) ?? folders[0]) : folders.find(folder => folder.id === args.folder)
    )?.path
    if (root === undefined) return
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
        registerTransport: driver => ctx.registerTransport(driver),
        registerUiPanel: panel => ctx.registerUiPanel(panel),
        registerClientPanel: panel => ctx.registerClientPanel(panel),
        registerSkill: skill => ctx.registerSkill(skill),
        onDispose: dispose => ctx.onDispose(dispose),
        registerTool: tool =>
          ctx.registerTool({
            ...tool,
            ...(tool.preview
              ? {
                  preview: async (args, context) => {
                    await assertAllowed(context, args)
                    return tool.preview!(args, context)
                  },
                }
              : {}),
            execute: async (args, context) => {
              await assertAllowed(context, args)
              return tool.execute(args, context)
            },
          }),
      }),
  }
}

/** What this computer has of a command and, for an adapter, of the program it drives. */
function detectCommand(command: string, agent?: string): CommandDetection {
  const path = resolveCommand(command)
  return {
    ...(path ? { found: true, path } : { found: false }),
    ...(agent ? { agent: { command: agent, found: resolveCommand(agent) !== undefined } } : {}),
  }
}

/** What this computer has of a preset's commands. */
export const detectPresetCommands = (preset: AgentPreset): CommandDetection => detectCommand(preset.command, preset.agentCommand)

/** PATH lookups touch the file system and the catalog is read often; as long as a driver's own status keeps one. */
const PRESET_LOOKUP_TTL_MS = 5_000

function agentSettings(agent: AgentRecord): AgentSettings {
  const verdict = validateAgentDefinition(agent)
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.presetId ? { presetId: agent.presetId } : {}),
    command: agent.command,
    args: [...agent.args],
    envKeys: Object.keys(agent.env).sort(),
    enabled: agent.enabled,
    detected: detectCommand(agent.command, AGENT_PRESETS.find(preset => preset.id === agent.presetId)?.agentCommand),
    verified: verdict.ok ? verdict.verified : false,
    ...(verdict.ok ? {} : { problem: verdict.error.message }),
    ...(agent.startedHash === undefined ? {} : { started: agent.startedHash === definitionHash(agent) }),
    ...(agent.probedDefinitionHash === definitionHash(agent) && agent.lastProbe ? { lastProbe: structuredClone(agent.lastProbe) } : {}),
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

/**
 * The confirmation sentence's slot for one of 我的 Agent. The slot cuts at its end, and what the sentence must name is the
 * program that gets access, so a long agent name is shortened first and the engine always survives.
 */
function agentSlot(name: string, engine: string): string {
  const room = 16 - [...engine].length - 2
  if (room < 2) return engine
  const letters = [...name]
  return `${letters.length > room ? `${letters.slice(0, room - 1).join('')}…` : name}（${engine}）`
}

/** The built-in file writer, as `<owner>:<tool>`; the risk classifier keys it the same way. */
const BUILTIN_FILES = 'workspace-files'
const BUILTIN_WRITE = `${BUILTIN_FILES}:write_file`

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
  // Before any harness is loaded: a launch fingerprint holds the path a lookup finds.
  setCommandSearch(options.commandDirectories)
  forgetCommandLookups()
  const now = options.now ?? Date.now
  const clock = options.clock ?? Date.now
  const hostTime = () => new Date(clock()).toISOString()
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
  // Beside the real start directory by default: a worktree's location may not pass through a symlink.
  const worktreesDir = resolve(
    options.worktreesDir ?? resolveLatchPaths({ dataDir, workspace: realWorkspace, env: process.env, cwd: process.cwd() }).worktreesDir,
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
    // Key material, Agent definitions and the Host identity stay out of Time Machine backups; sessions, the audit log
    // and the policy are backed up as usual.
    await excludeFromBackup([authDir, join(dataDir, 'identity'), ...BACKUP_EXCLUDED_CONFIG_FILES.map(file => join(dataDir, file))], { log })
    // A policy.json from before confirmed origins: record the origins the owner had already confirmed, once.
    if (policy.needsAddressMigration) {
      await policy
        .migrateConfirmedAddresses(addressesConfirmedBefore(config.providers(), policy.get().hostEgressAllow))
        .catch(error => log(`无法记录已确认的模型服务地址，自定义地址的服务在本次运行中不可用：${errorText(error)}`))
    }

    /** The TLS files checked as at startup; the HTTPS entry calls it again when they change on disk. */
    const loadTls = async (material: TlsListenerOptions): Promise<ValidatedTls> => {
      await checkPrivateFile(material.keyPath, {
        uid,
        label: 'HTTPS 私钥',
        notInside: [
          realDataDir,
          realWorkspace,
          ...(await Promise.all(
            config
              .settings()
              .workspaces.flatMap(item => item.folders)
              .map(folder => realpath(folder.path).catch(() => folder.path)),
          )),
        ],
      })
      return validateTls(material, now(), log)
    }
    const tls = options.tls ? await loadTls(options.tls) : undefined

    const instanceId = randomUUID()
    const lifecycle = new HostLifecycle(instanceId, now)
    const registry = new PluginRegistry()
    startupCleanup.push(() => registry.close())
    const buildAgentPlugin = options.agentPlugin ?? ((agent: AgentRecord) => createAcpAgentPlugin(agent, { log }))
    const egressExtra = [...(options.egressAllow ?? [])]
    const egressFetch = createEgressFetch({
      allow: () => [...policy.get().hostEgressAllow, ...egressExtra],
      ...(options.egressLookup ? { lookup: options.egressLookup } : {}),
    })
    const inspectEgress = createEgressInspector(options.egressLookup ? { lookup: options.egressLookup } : {})
    let hub: HarnessHub | undefined
    const presence = new PresenceService({
      backend: options.presence ?? createPresenceBackend({ codeRoot, policy }),
      hostId,
      audit,
      now,
      blockingTasks: async () =>
        hub ? (await hub.unsandboxedTasks()).map(task => ({ id: task.id, title: task.title, harnessId: task.harnessId })) : [],
    })
    const enrollments = new EnrollmentService({ hostId, devices, presence, audit, directory: authDir, now })
    const relayProfiles = await RelayProfiles.open(dataDir)
    await excludeFromBackup([join(dataDir, 'native')], { log })
    const relayDirectory = await HostRelayDirectory.open({
      dataDir,
      profiles: relayProfiles,
      fetch:
        options.nativeDirectoryFetch
        ?? createEgressFetch({
          allow: () => [],
          ...(options.egressLookup ? { lookup: options.egressLookup } : {}),
          connectTimeoutMs: 5000,
        }),
      changed: () => {
        if (!starting) refresh()
      },
    })
    startupCleanup.push(() => relayDirectory.close())
    const addressBooks = new HostAddressBooks(
      relayProfiles,
      identity,
      () => nativeRoutes.lan(),
      () => relayDirectory.sources(),
    )
    const revokedDiscoveryHash = () =>
      sha256Hex(
        canonicalJson(
          devices
            .list()
            .filter(device => device.status === 'revoked')
            .map(device => ({ id: device.id, revokedAt: device.revokedAt })),
        ),
      )
    const discoveryEpoch = () => sha256Hex(discoveryEpochInput(secretBytes(relayProfiles.snapshot().discoveryKey)))
    await relayProfiles.rotateDiscovery(revokedDiscoveryHash())
    let discoveryRotation: Promise<void> | undefined
    function synchronizeNativeDiscovery(): Promise<void> {
      if (discoveryRotation) return discoveryRotation
      const operation = (async () => {
        let changed = false
        for (;;) {
          const hash = revokedDiscoveryHash(),
            before = relayProfiles.snapshot().discoveryKey
          await relayProfiles.rotateDiscovery(hash)
          changed ||= before !== relayProfiles.snapshot().discoveryKey
          if (hash === revokedDiscoveryHash()) break
        }
        nativeRoutes.invalidate()
        if (changed) refresh()
      })()
      discoveryRotation = operation
      void operation
        .finally(() => {
          if (discoveryRotation === operation) discoveryRotation = undefined
        })
        .catch(() => {})
      return operation
    }
    devices.onRevoked(() => {
      nativeRoutes.invalidate()
      void synchronizeNativeDiscovery().catch(() => log('Native discovery key rotation failed'))
    })
    const limits = createRateLimits(options.rateLimits ?? 'default', now)
    const tlsKeyPath = options.tls ? resolve(options.tls.keyPath) : undefined

    const workspaceGuard: FolderGuardContext = {
      dataDir: realDataDir,
      agentsDir,
      runtimeDir: runtime.runtimeDir,
      home,
      codeRoot,
      ...(tlsKeyPath ? { tlsKeyPath } : {}),
    }
    const defaultFlags = await classifyDefaultWorkspace(realWorkspace, { ...workspaceGuard, existing: [] })
    /** Until the listeners are up: `workspace.disabled` records name the startup check as their actor. */
    let starting = true
    if (defaultFlags.sensitive) throw new AppError(409, 'workspace-overlap', defaultFlags.sensitive.message)
    if (defaultFlags.insideData) log(`工作区位于数据目录内（${realWorkspace}）。迁出之前只能使用内置 Harness。`)
    if (defaultFlags.codeRoot)
      log(`工作区与 Latch 程序目录重叠（${realWorkspace}），内置 Harness 的每次写入都需要在本机确认，ACP Agent 不可用。`)
    // Path spellings (case, firmlinks) differ between APIs; code-root decisions compare canonical forms only.
    const canonicalCodeRoot = await canonicalPath(codeRoot)
    const canonicalWorkspace = await canonicalPath(realWorkspace)
    // Sessions keep their own folder while it stays directly inside the start directory, whatever this run makes.
    const ownFolders = new SessionFolders({
      dataDir,
      root: workspaceRoot,
      canonicalRoot: canonicalWorkspace,
      clock,
      now,
      ...(options.sessionFolderSuffix ? { suffix: options.sessionFolderSuffix } : {}),
      log,
    })
    await ownFolders.start()
    const makeOwnFolders = options.sessionFolders === true
    const worktrees = new Worktrees({ root: worktreesDir, dataDir: realDataDir, avoid: [codeRoot, runtime.runtimeDir, agentsDir], log })
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
    /**
     * The last computed state of each saved project. A project is usable only while every folder passes R1–R7 and the
     * folders still do not overlap; one that fails is kept in settings and listed with its reason.
     */
    const projectStates = new Map<string, ProjectState>()
    /** Projects last seen unusable, so becoming unusable is audited once per transition. */
    const unusableProjects = new Set<string>()

    async function computeProjectState(record: WorkspaceRecord, readable: boolean): Promise<ProjectState> {
      const folders: FolderState[] = []
      let failure: ProjectState['failure']
      if (record.invalid || record.folders[0]?.path !== record.path)
        failure = { reason: 'invalid', message: '这个项目的主文件夹配置不一致，请在这台 Mac 上重新选择主文件夹' }
      for (const [index, folder] of record.folders.entries()) {
        const verdict = await checkFolderCandidate(folder.path, workspaceGuard, { readable }).catch(() => undefined)
        const problem: FolderProblem | undefined = verdict === undefined ? 'invalid' : verdict.ok ? undefined : verdict.problem
        const message = verdict === undefined ? '无法检查这个文件夹' : verdict.ok ? undefined : verdict.error.message
        folders.push({ id: folder.id, path: folder.path, ...(problem ? { problem, message } : {}) })
        if (problem && !failure)
          failure = { index, reason: disabledReason(problem), message: `文件夹「${basename(folder.path) || folder.path}」：${message}` }
      }
      if (!failure && record.folders.length > 1) {
        const project = await checkProjectFolders(
          record.folders.map(folder => folder.path),
          { existing: [] },
        ).catch(() => undefined)
        if (!project?.ok) {
          const index = project?.index ?? 0
          const path = record.folders[index]?.path ?? record.path
          failure = {
            index,
            reason: 'overlap',
            message: `文件夹「${basename(path) || path}」：${project?.error.message ?? '无法检查这个文件夹'}`,
          }
        }
      }
      return { at: now(), key: stateKey(record), folders, ...(failure ? { failure } : {}) }
    }

    /**
     * A project's folder states: reused for up to 5 s for listings; `fresh` (session start, edits) checks again, and
     * `readable` adds R10. A project that turns unusable is logged and audited (`workspace.disabled`, record only).
     */
    async function projectState(record: WorkspaceRecord, check: { fresh?: boolean; readable?: boolean } = {}): Promise<ProjectState> {
      const cached = projectStates.get(record.id)
      if (!check.fresh && !check.readable && cached && cached.key === stateKey(record) && now() - cached.at < PROJECT_STATE_TTL)
        return cached
      const state = await computeProjectState(record, check.readable ?? false)
      projectStates.set(record.id, state)
      if (!state.failure) {
        unusableProjects.delete(record.id)
        return state
      }
      if (unusableProjects.has(record.id)) return state
      unusableProjects.add(record.id)
      log(`项目「${record.name}」暂不可用：${state.failure.message}`)
      // Disabling only removes access, so a failed record never keeps the project usable.
      await audit
        .append({
          action: 'workspace.disabled',
          actor: starting ? startupActor : { listener: 'host' },
          target: record.id,
          detail: {
            workspaceId: record.id,
            reason: state.failure.reason,
            ...(state.failure.index !== undefined ? { folderIndex: state.failure.index } : {}),
          },
        })
        .catch(cause => log(`审计记录写入失败（workspace.disabled）：${errorText(cause)}`))
      return state
    }

    /** Recomputes every saved project now, e.g. at startup and after a settings write. */
    async function refreshProjects(): Promise<void> {
      const ids = new Set(config.settings().workspaces.map(record => record.id))
      for (const id of projectStates.keys()) if (!ids.has(id)) projectStates.delete(id)
      for (const id of unusableProjects) if (!ids.has(id)) unusableProjects.delete(id)
      for (const record of config.settings().workspaces) await projectState(record, { fresh: true })
    }
    await refreshProjects()

    const savedLegacy = config.provider(LEGACY_PROVIDER_ID)
    /**
     * Live `openai-compatible` while `LATCH_MODEL` is set: the environment's connection with the saved
     * name and switch. Owner edits apply to it in memory and to the saved record; the environment's key is never written.
     */
    let envProvider: ProviderRecord | undefined = options.provider && {
      id: LEGACY_PROVIDER_ID,
      name: savedLegacy?.name ?? 'OpenAI 兼容接口',
      kind: 'openai-compatible',
      baseURL: options.provider.baseURL,
      apiKey: options.provider.apiKey,
      ...(options.provider.apiKey ? keyScopeOf(options.provider.baseURL) : {}),
      enabled: savedLegacy?.enabled ?? true,
      models: [options.provider.model.trim()],
      defaultModel: options.provider.model.trim(),
    }
    /**
     * Origins the person who started this Host allowed for this run: `LATCH_BASE_URL` and the process-level outbound
     * entries. Every path on them counts as confirmed until the Host stops; they are never written.
     */
    const processOrigins = new Set<string>([
      ...(envProvider ? [originOf(envProvider.baseURL)] : []),
      ...egressExtra.flatMap(entry => [`http://${entry}`, `https://${entry}`]),
    ])
    /**
     * The fetch of the configured model service at `baseURL`: each request goes only under that base URL (the connectors
     * build every request from it), only while it is a preset's origin or a confirmed address, then through the egress
     * policy. Anything else is refused like an unconfirmed address.
     */
    const providerFetchFor =
      (baseURL: string): FetchLike =>
      (input, init) => {
        let destination: ProviderDestination = 'unconfirmed'
        try {
          if (underBase(input, baseURL)) destination = destinationOf(baseURL)
        } catch {
          // Not an HTTP(S) URL: refused below like an unconfirmed address.
        }
        return destination === 'unconfirmed' ? Promise.reject(new OriginUnconfirmed()) : egressFetch(input, init)
      }
    /** Agent plugin ID → agent ID, so plugin toggles find their definition. */
    const agentPlugins = new Map<string, string>()
    const disabled = new Set(config.settings().plugins.disabled)
    registry.register(
      {
        id: 'standard-harness',
        name: 'Latch 内置',
        version: '0.1.0',
        description: '内置对话与 Agent 执行机制；其他 Harness 可通过插件接入。',
        activate(ctx) {
          ctx.registerHarness(standardHarnessDriver)
        },
      },
      { managed: 'core', revision: executionBuildRevision('standard-harness') },
    )
    await registry.enable('standard-harness')
    const customAgents = await CustomAgents.open({ dataDir, audit, now })
    startupCleanup.push(() => customAgents.close())
    const questions = await Questions.open({ dataDir, changed: id => refresh(id), detail: id => hub!.detail(id) })
    startupCleanup.push(() => questions.close())
    registry.register(createQuestionsPlugin(questions), { managed: 'core', revision: executionBuildRevision('user-questions') })
    await registry.enable('user-questions')
    /** Names and schedules of private definitions: for a device that may read them, and on a phone only while verified. */
    function agentSummaries(caller: Caller, tasks: readonly TaskSummary[]): Pick<AppSnapshot, 'customAgents' | 'automations'> {
      if (!caller.device || devices.get(caller.device.id)?.dataScope !== 'all') return {}
      if (caller.nativeOpening && nativeRoutes.verifiedUntil(caller.nativeOpening) <= now()) return {}
      // Absent, as on a Host without them, while a write is being confirmed: the rest of the app has nothing to wait for.
      if (customAgents.hasPending() || automations.hasPending()) return {}
      return {
        customAgents: customAgents.list().map(agent => agentPlans.summary(agent, tasks)),
        automations: automations.list().map(automationSummary),
      }
    }
    function questionSummary(task: TaskSummary): TaskSummary {
      const { pendingQuestions: _untrustedCount, ...summary } = task
      return { ...summary, pendingQuestions: questions.view(task.id).length }
    }
    const workspaceFiles = createWorkspacePlugin({ protectedPaths: guardedPaths })
    const optional = [
      isWithin(realWorkspace, realDataDir) ? guardDataDir(workspaceFiles, realDataDir, realWorkspace) : workspaceFiles,
      ...(options.demo ? [createToolsPlugin(), createDemoPlugin()] : []),
      ...(options.plugins ?? []),
    ]
    for (const [index, plugin] of optional.entries()) {
      registry.register(plugin, {
        revision:
          index < optional.length - (options.plugins?.length ?? 0)
            ? executionBuildRevision(
                index === 0 ? [plugin.id, realDataDir, realWorkspace, agentsDir, tlsKeyPath ?? null, denyRead] : plugin.id,
              )
            : undefined,
      })
      if (!disabled.has(plugin.id)) await registry.enable(plugin.id)
    }
    // Saved definitions must not prevent the Host from starting; a broken one is logged and left disabled.
    for (const record of effectiveProviders()) {
      try {
        registry.register(buildProviderPlugin(record), { managed: 'provider', revision: providerExecutionRevision(record) })
      } catch (error) {
        log(`模型服务 ${record.id} 未加载：${errorText(error)}`)
        continue
      }
      if (record.enabled) await registry.enable(record.id).catch(error => log(`模型服务 ${record.id} 启用失败：${errorText(error)}`))
    }
    for (const agent of config.settings().agents)
      await installAgent(agent).catch(error => log(`Agent ${agent.id} 未加载：${errorText(error)}`))

    const pluginAssets = await PluginAssets.open(dataDir, { audit })
    startupCleanup.push(() => pluginAssets.close())
    const appData = await AppDataStore.open(dataDir, { now })
    startupCleanup.push(() => appData.close())
    const appDiagnostics = new AppDiagnostics(id => appData.pluginDirectory(id), now)
    const assetPluginIds = new Set<string>()
    // A version the desktop app installed may load other plugin formats: incompatible packages stay off, assets kept.
    const heldPlugins = await HeldPlugins.open(pluginAssets.directory)
    try {
      const newlyHeld = await heldPlugins.settle(
        pluginAssets
          .list()
          .flatMap(record => (record.appliedBundle ? [{ id: record.id, formatVersion: record.appliedBundle.manifest.formatVersion }] : [])),
        { version: LATCH_VERSION, now: now() },
      )
      if (newlyHeld.length)
        await audit
          .append({ action: 'host.update.plugins-held', actor: { listener: 'host', via: 'startup' }, detail: { count: newlyHeld.length } })
          .catch(error => log(`审计记录写入失败（host.update.plugins-held）：${errorText(error)}`))
    } catch (error) {
      log(`无法核对更新后停用的插件：${errorText(error)}`)
    }
    for (const record of pluginAssets.list()) {
      if (!record.appliedBundle) continue
      try {
        registry.register(installedAssetPlugin(pluginAssets, record), { revision: record.appliedRevision })
        assetPluginIds.add(record.id)
        if (record.enabled && !heldPlugins.isHeld(record.id)) await registry.enable(record.id)
      } catch {
        log(`自定义插件 ${record.id} 未加载，请检查本地声明与依赖。`)
      }
    }

    const sessionLifecycle = new SessionLifecycle({ log, ...(options.lifecycleBounds ? { bounds: options.lifecycleBounds } : {}) })
    const lifecycleListeners = sessionLifecycle.listenOnly()
    const harnessHub = await HarnessHub.open({
      dataDir,
      defaultId: defaultHarnessId,
      log,
      now,
      lifecycle: sessionLifecycle,
      service: id => {
        const record = effectiveProvider(id)
        return record && { name: record.name, enabled: record.enabled }
      },
    })
    hub = harnessHub
    const attachmentStore = await AttachmentStore.open(dataDir, { now, deferPrune: true })
    const fileReferences = await FileReferenceStore.open(dataDir)
    const fileTracking = createFileTrackingService({
      protectedPaths: guardedPaths,
      allowedRoot: async root => (await canonicalSet(usablePrimaries())).has(await canonicalPath(root.path)),
    })
    startupCleanup.push(() => fileTracking.close())
    const directoryReader = await FileDirectoryReader.open()
    // A file handle is usable only while the session's original folders remain available.
    async function sessionRoots(sessionId: string): Promise<ProjectFolder[] | 'removed' | undefined> {
      const task = (await harnessHub.listTasks()).find(item => item.id === sessionId)
      if (!task) return undefined
      try {
        await assertSessionWorkspace(sessionId)
      } catch (error) {
        if (error instanceof AppError && ['workspace-changed', 'workspace-disabled'].includes(error.code)) return 'removed'
        throw error
      }
      const available = await canonicalSet(usablePrimaries())
      const folders = scopeFolders(task, workspaceRoot)
      for (const folder of folders) {
        const root = await canonicalPath(folder.path).catch(() => undefined)
        if (root === undefined || !available.has(root)) return 'removed'
      }
      return folders
    }
    const fileRoutes = createFileRoutes({
      requestSignal: caller => (caller as Caller).nativeOpening?.signal,
      contentChunkBytes: caller => ((caller as Caller).nativeOpening?.bulk ? 65_536 : undefined),
      directoryReader,
      contextRevision: context => {
        const projects = config.settings().workspaces
        return sha256Hex(
          JSON.stringify(
            context.kind === 'session'
              ? projects.map(project => [project.id, project.folders])
              : [
                  context.workspaceId === 'default' ? workspaceRoot : projects.find(project => project.id === context.workspaceId),
                  draftHarness(context.harnessId),
                ],
          ),
        )
      },
      async workspaceRoots(workspaceId, harnessId) {
        const harness = draftHarness(harnessId)
        if (!harness || harness.status !== 'ready') throw new AppError(409, 'file-harness-unavailable', '当前 Agent 不可用，请重新选择')
        if (workspaceId === 'default') {
          if ((await canonicalPath(workspaceRoot).catch(() => undefined)) !== canonicalWorkspace) return 'removed'
          return [{ id: 'default', path: workspaceRoot }]
        }
        const record = savedProject(workspaceId)
        if (!record) return undefined
        await assertWorkspaceUsable(record)
        return harness.projectFolders?.access === 'all'
          ? record.folders.map(folder => ({ id: folder.id, path: folder.path }))
          : [{ id: 'default', path: record.folders[0].path }]
      },
      protectedPaths: guardedPaths,
      home,
      now,
      audit,
      limiter: limits.files,
      sessionRoots,
      recheck: (caller, scope) => {
        recheck(caller as Caller, scope)
        if (!caller.device || devices.get(caller.device.id)?.dataScope !== caller.device.dataScope)
          throw new AppError(403, 'file-scope', '这台设备的数据范围已变化，请重新打开文件')
      },
      sessionAccess: (caller, id) => checkPrivateSession(caller as Caller, id),
      sessionDetail: id => harnessHub.detail(id),
      referencePaths: async (id, roots) => fileReferences.references(id, await harnessHub.detail(id), roots, home),
      actorOf: caller => actorOf(caller as Caller),
      edits: {
        assertInput: (caller, id) => routeContext.assertSessionInput(caller as DeviceCaller, id),
        turnRunning: (id, realPath, wait) => changeRoutes.edits.turnRunning(id, realPath, wait),
        writable: id => !harnessHub.personalOf(id),
        record: (id, file, write) => changeRoutes.edits.record(id, file, write),
      },
      ...(options.fileHooks ? { hooks: options.fileHooks } : {}),
      ...(options.fileEditHooks ? { editHooks: options.fileEditHooks } : {}),
      codeRoot: canonicalCodeRoot,
    })
    startupCleanup.push(() => fileRoutes.close())
    async function attachmentCapabilities(
      caller: Caller,
      selection: AttachmentSelection,
      sessionId?: string,
    ): Promise<AttachmentCapabilities> {
      requireScope(caller, 'run')
      recheck(caller, 'run')
      let selected = selection
      if (sessionId) {
        await assertSessionAccess(caller, sessionId)
        assertWritable(sessionId)
        const detail = await hub!.detail(sessionId)
        await assertSessionWorkspace(sessionId)
        selected = {
          harnessId: detail.summary.harnessId,
          ...(detail.summary.workspaceId ? { workspaceId: detail.summary.workspaceId } : {}),
          ...(selection.model
            ? { model: selection.model }
            : detail.summary.providerId && detail.summary.model
              ? { model: { providerId: detail.summary.providerId, model: detail.summary.model } }
              : {}),
        }
      }
      const harness = draftHarness(selected.harnessId)
      if (!harness || harness.status !== 'ready') throw new AppError(409, 'harness-unavailable', '当前 Agent 不可用。')
      const declared = harness.attachments
      if (harness.capabilities.models.owner === 'latch') {
        const choice = selected.model ?? defaultModelRef()
        if (choice) assertModel(choice)
        const provider = choice ? usableProviders().find(item => item.id === choice.providerId) : undefined
        const images = declared?.images === true && Boolean(choice && provider?.modelCapabilities?.[choice.model]?.vision === true)
        return {
          images,
          text: declared?.text === true,
          textBytes: Math.min(declared?.textBytes ?? 256 * 1024, 256 * 1024),
          ...(!images ? { reason: '当前模型不能看图片。' } : {}),
        }
      }
      const agent = config.settings().agents.find(item => item.id === selected.harnessId)
      if (agent || harness.offer) {
        const probe = agent?.lastProbe
        return {
          images: probe?.status === 'ready' && probe.capabilities.images === true,
          text: probe?.status === 'ready' && probe.capabilities.embeddedContext === true,
          textBytes: 25 * 1024 * 1024,
          ...(!probe || probe.status !== 'ready' ? { reason: '请先在 Harness 设置中测试连接，再添加附件。' } : {}),
        }
      }
      return {
        images: declared?.images === true,
        text: declared?.text === true,
        textBytes: Math.min(declared?.textBytes ?? 256 * 1024, 25 * 1024 * 1024),
        ...(!declared ? { reason: '当前 Harness 尚未声明附件能力。' } : {}),
      }
    }
    const attachmentRoutes = createAttachmentRoutes<Caller>({
      store: attachmentStore,
      now,
      audit,
      actorOf,
      authorize: requireScope,
      recheck,
      capabilities: attachmentCapabilities,
      sessionAccess: async (caller, id) => {
        requireScope(caller, 'view')
        await assertSessionAccess(caller, id)
        return hub!.detail(id)
      },
    })
    async function promptAttachments(
      caller: Caller,
      ids: string[] | undefined,
      selection: AttachmentSelection,
      sessionId?: string,
      creationRequestId?: string,
    ): Promise<AttachmentRef[]> {
      requireScope(caller, 'run')
      if (!ids?.length) return []
      const refs = attachmentStore.refs(caller.device.id, ids, sessionId, creationRequestId),
        caps = await attachmentCapabilities(caller, selection, sessionId)
      for (const ref of refs) assertAttachmentCapability(ref, caps)
      return refs
    }

    const templateStore = await PromptTemplateStore.open(dataDir)
    const sessionRoutes = createSessionRoutes<Caller>({
      now,
      templates: templateStore,
      changed: () => refresh(),
      list: async () => (await harnessHub.listTasks()).map(questionSummary),
      detail: id => harnessHub.detail(id),
      patch: (id, patch) => harnessHub.updateMeta(id, patch),
      remove: async id => {
        await harnessHub.remove(id)
        await promptQueues.forgetSession(id)
        await questions.forgetSession(id)
        fileRoutes.forgetSession(id)
        await attachmentStore.removeTask(id).catch(() => log('未能清理已删除会话的附件'))
        await fileReferences.remove(id).catch(() => log('未能清理已删除会话的文件引用记录'))
        summaries.delete(id)
        refresh()
      },
      authorize: requireScope,
      recheck: (caller, scope) => {
        recheck(caller, scope)
        if (caller.device && devices.get(caller.device.id)?.dataScope !== caller.device.dataScope)
          throw new AppError(403, 'agent-scope-required', '设备的数据范围已改变，请重新同步。')
      },
      checkRemove: assertSessionAccess,
      checkEnd: (caller, id) => {
        requireDevice(caller)
        terminalRoutes.checkSessionEnd(caller, id)
      },
      visible: privateVisible,
      checkRead: async (caller, id, write) => {
        checkPrivateSession(caller, id, write)
      },
    })
    startupCleanup.push(() => harnessHub.close())
    const modelGateway = new ModelGatewayServer({ service: gatewayService, fetchFor: providerFetchFor, log })
    await modelGateway.start()
    startupCleanup.push(() => modelGateway.close())
    const requiredHarness = options.harnessId ?? STANDARD
    if (!registry.harnesses().some(driver => driver.id === requiredHarness)) {
      throw new AppError(409, 'harness-unavailable', `请先配置并启用 Harness ${requiredHarness}`)
    }
    for (const driver of registry.harnesses()) await mount(driver, driver.id === requiredHarness)
    await questions.reconcile(id => harnessHub.detail(id))
    if (attachmentStore.hasDrafts())
      for (const task of await hub!.listTasks()) {
        const refs = (await hub!.detail(task.id)).messages.flatMap(message => message.attachments ?? [])
        if (refs.length) await attachmentStore.recoverSession(task.id, refs)
      }
    await attachmentStore.prune()

    let revision = 0
    const streams = new Map<ServerResponse, EventStream>()
    const nativeReplay = new NativeReplay(instanceId)
    const pendingTasks = new Map<string, number>()
    const summaries = new Map<string, string>()
    // One decision per approval at a time, so a retried request sees the first one's outcome.
    const decisionLocks = new Map<string, Promise<void>>()
    // One answer per cancel request at a time, so a copy sent while the first is settling gets the same receipt.
    const cancelFlights = new Map<string, Promise<CancelReceipt>>()
    const traffic = new TrafficMeter(now)
    // A task-state frame goes to every stream that selected its session; its text is the same for all of them.
    const frames = new WeakMap<ChangeEvent | TaskStateEvent, string>()
    let pendingGlobal = false
    let eventTimer: ReturnType<typeof setTimeout> | undefined
    let flushing = false
    let changes: Promise<void> = Promise.resolve()
    const agentProbes = new AgentProbes({ root: runtime.tmpRoot, dataDir, now })
    startupCleanup.push(() => agentProbes.close())
    let closing = false
    const promptQueues = await PromptQueues.open({
      dataDir,
      now,
      detail: id => harnessHub.detail(id),
      check: checkQueuedPrompt,
      async prepare(actor, sessionId, model) {
        await checkQueuedPrompt(actor, sessionId, model, undefined, true)
        const turn = await queuedAgentTurn(sessionId, actor.dataScope)
        return turn?.binding && turn.model ? { binding: turn.binding, model: turn.model } : undefined
      },
      beforeEnqueue: async (actor, sessionId, itemId) => {
        await audited({
          action: 'task.prompt.queued',
          actor: { deviceId: actor.deviceId, listener: actor.listener, via: 'http' },
          detail: { sessionId, itemId },
        })
      },
      send: async (actor, sessionId, input) => {
        await checkQueuedPrompt(actor, sessionId, input.model, input.binding)
        if (input.itemId)
          await audited({
            action: 'task.prompt.sent',
            actor: { deviceId: actor.deviceId, listener: actor.listener, via: 'http' },
            detail: { sessionId, itemId: input.itemId },
          })
        await checkQueuedPrompt(actor, sessionId, input.model, input.binding)
        await input.authorize?.()
        const turn = await queuedAgentTurn(sessionId, actor.dataScope)
        if (turn?.binding !== input.binding) throw queueContextChanged()
        const agentContext = turn?.agentContext
        await harnessHub.prompt(sessionId, input.text, input.requestId, {
          ...(agentContext ? { agentContext } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.queuedAt ? { queuedAt: input.queuedAt } : {}),
        })
      },
      changed: id => refresh(id),
    })
    startupCleanup.push(() => promptQueues.close())
    const configRequests = new ConfigRequests(harnessHub.receipts, now)
    const updateWindow = new UpdateWindow(now)
    let commitTimer: ReturnType<typeof setTimeout> | undefined
    /** A window that ran out (unrenewed, or committed and not followed by a stop): starts and terminals open again, the plugin plan goes, on record. */
    const expireCommit = async () => {
      if (!updateWindow.lapsed()) return
      updateWindow.close()
      clearTimeout(commitTimer)
      terminals.setHeld(false)
      await heldPlugins.unplan().catch(error => log(`无法清除插件计划：${errorText(error)}`))
      await audit
        .append({ action: 'host.update-window', actor: { listener: 'host' }, detail: { state: 'left', reason: 'expired', busy: 0 } })
        .catch(error => log(`审计记录写入失败（host.update-window）：${errorText(error)}`))
    }
    startupCleanup.push(() => clearTimeout(commitTimer))
    /** Session starts and turns by device and request ID: in flight, their outcome is not known yet; accepted, a retry gets its answer. */
    const startRequests = new RequestRecords()
    const turnRequests = new RequestRecords()
    /**
     * Runs a start or a turn as in flight until it has really finished, whether or not a client still waits for it:
     * accepted when it succeeds (its route then answers 2xx), forgotten when it fails, so its retry counts as new.
     */
    async function tracked<T>(records: RequestRecords, key: string, operation: () => Promise<T>): Promise<T> {
      records.begin(key)
      try {
        const result = await operation()
        records.settle(key, true)
        return result
      } catch (error) {
        records.settle(key, false)
        throw error
      }
    }
    /** Git delivery writes running now: they run the user's own git, so the install waits for them. */
    const deliveries = { running: 0 }
    /** While the desktop app installs an update that changes the Host, nothing new starts; what runs settles. */
    const refuseWhileUpdating = (what: 'session' | 'turn') => {
      if (updateWindow.isOpen())
        throw new AppError(
          409,
          'host-updating',
          what === 'session'
            ? '这台电脑正在安装更新，暂时不能开始新会话。安装完成后再试。'
            : '这台电脑正在安装更新，暂时不能开始新一轮。安装完成后再试。',
        )
    }
    startupCleanup.push(() => configRequests.close())
    let shutdown: Promise<void> | undefined
    let listeners: ListenerSet | undefined
    let loopbackOrigin = ''
    let tlsOrigin: string | undefined
    const routeContext: RouteContext = {
      updateGate: { committed: () => updateWindow.isCommitted, deliveries },
      hostId,
      hostId8,
      dataDir,
      codeRoot,
      now,
      clock,
      log,
      audit,
      policy,
      devices,
      enrollments,
      presence,
      config,
      plugins: registry,
      hub: harnessHub,
      guardedPaths,
      sessionRoots,
      async assertSessionInput(caller, sessionId) {
        recheck(caller, 'run')
        await assertSessionAccess(caller, sessionId)
        assertWritable(sessionId)
        await assertSessionWorkspace(sessionId)
        recheck(caller, 'run')
      },
      lifecycle: lifecycleListeners,
      limits,
      closing: () => closing,
      refresh,
      actorOf,
      requireDevice,
      requireScope,
      requireLocal,
      recheck,
      confirm,
      serial,
      audited,
    }
    const { binary: terminalBinary, ...terminalSeams } = options.terminal ?? {}
    const terminals = await TerminalService.open(
      {
        sessionFolder: terminalFolder,
        // The service opens terminals for host.sock alone, so that is where this request came from.
        beforeOpen: async ({ deviceId, ...detail }) => {
          await audited({ action: 'terminal.open', actor: { deviceId, listener: 'unix', via: 'http' }, detail })
        },
        log,
        ...terminalSeams,
      },
      terminalBinary,
    )
    setLoginPrograms(options.loginPrograms)
    const {
      native: nativeRoutes,
      terminal: terminalRoutes,
      agentLogin: agentLoginRoutes,
      apps: appRoutes,
      changes: changeRoutes,
      routes,
    } = createRoutes(routeContext, {
      native: {
        options,
        identity,
        egressExtra,
        relayProfiles,
        relayDirectory,
        addressBooks,
        revokedDiscoveryHash,
        synchronizeDiscovery: synchronizeNativeDiscovery,
        authorizeBulk: (caller, handle, etag) => fileRoutes.authorizeBulk(caller, handle, etag),
      },
      devices: {
        authenticate,
        tls,
        loopbackOrigin: () => loopbackOrigin,
        pairingNearby: (opening, gatewayHash) => nativeRoutes.pairingNearby(opening, gatewayHash),
        rememberNetwork: networkHash => nativeRoutes.rememberNetwork(networkHash),
        hostName: () => options.hostName ?? hostname(),
        tlsOrigin: () => tlsOrigin,
        addressBooks,
        endDisallowedStreams() {
          for (const [stream, info] of streams)
            if (!streamAllowed(info)) {
              stream.end()
              streams.delete(stream)
            }
          terminalRoutes.endDisallowedStreams()
        },
      },
      terminals,
      agents: {
        agents: customAgents,
        plans: () => agentPlans,
        automations: () => automations,
        access: agentAccess,
        sessions: () => hub!.listTasks(),
        plugins: enabledPluginInfo,
      },
      automations: { automations: () => automations, access: agentAccess },
      handoffs: { handoffs: () => handoffs },
      ...(options.gitDelivery ? { git: options.gitDelivery } : {}),
      apps: {
        assets: () => pluginAssets,
        pluginEnabled: id => registry.list().some(plugin => plugin.id === id && plugin.enabled),
        data: appData,
        diagnostics: appDiagnostics,
        async pageSession(caller, sessionId, write = false) {
          requireScope(caller, write ? 'run' : 'view')
          if (isNativeListener(caller.connection.listener) && nativeRoutes.verifiedUntil(caller.nativeOpening) <= now())
            throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
          // From the Host's own records first: a session whose Harness is gone must not slip through as a 404.
          const refusePrivate = () => {
            if (hub!.agentPrivate(sessionId)) throw new AppError(403, 'app-private-session', '插件页面不能使用私有会话。')
          }
          refusePrivate()
          await hub!.harnessOf(sessionId)
          refusePrivate()
          recheck(caller, write ? 'run' : 'view')
        },
        broadcast: (event, restricted) => sendAppData(event, restricted),
      },
      agentLogin: {
        record: (id, caller) =>
          config.settings().agents.find(agent => agent.id === id)
          ?? (caller.device?.scopes.includes('admin') && presetsToOffer().some(offer => offer.id === id) ? presetRecord(id) : undefined),
        login: id => hub?.harnessLogin(id),
        logout: id => hub!.logoutHarness(id),
        ...(options.loginTerminal ? { openTerminal: options.loginTerminal } : {}),
      },
    })

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

    /** Only host.sock counts as this computer (`isLocalListener`); loopback and every other listener are remote. */
    function requireLocal(caller: Caller): void {
      if (!isLocalListener(caller.connection.listener)) throw localOnly()
    }

    /** The desktop app on this computer: a device enrolled on host.sock, calling over host.sock. */
    function requireDesktop(caller: DeviceCaller): void {
      if (caller.connection.listener !== 'unix' || caller.device.listener !== 'unix') throw localOnly()
    }

    /**
     * The body of a folder add, which only the desktop app's main process can sign: a nonce from `POST /folder-grants`
     * (single use, consumed here whatever follows) and the device's signature over the canonical body without
     * `signature`. A page or an older desktop proxy that forwards renderer requests cannot produce it.
     */
    async function signedFolderBody(req: IncomingMessage, caller: DeviceCaller): Promise<Record<string, unknown>> {
      const raw = await jsonBody(req, CONFIG_BODY_LIMIT)
      if (!isRecord(raw)) throw folderGrantInvalid()
      const { signature, ...body } = raw
      let bodyHash: string
      try {
        bodyHash = sha256Hex(canonicalJson(body))
      } catch {
        throw folderGrantInvalid()
      }
      devices.verifyFolderGrant({ deviceId: caller.device.id, nonce: body.nonce, bodyHash, signature })
      return body
    }

    /** Re-checks a caller after an await: a queued or slow request may outlive a revocation or a scope change. */
    function recheck(caller: Caller, scope?: DeviceScope): void {
      if (!caller.device) return
      const native = isNativeListener(caller.connection.listener) ? devices.authenticateNative(caller.device.id) : undefined
      const current = native?.ok ? native.device : devices.get(caller.device.id)
      if (!current || (native ? !native.ok : !devices.isActive(current.id))) throw authFailure('device-revoked')
      if (native?.ok && !caller.nativeWindowExempt && nativeRoutes.verifiedUntil(caller.nativeOpening) <= now())
        throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
      if (scope && !current.scopes.includes(scope)) throw scopeRequired(scope)
    }

    function privateVisible(caller: Caller, summary: TaskSummary): boolean {
      return !privateSession(summary) || (!!caller.device && devices.get(caller.device.id)?.dataScope === 'all')
    }
    /** An agent's session shows that agent's private instructions and memories; an assistant's session is kept as private. */
    function privateSession(summary: Pick<TaskSummary, 'personal' | 'agent' | 'agentPrivate'> | undefined): boolean {
      return !!summary?.personal || !!summary?.agent || !!summary?.agentPrivate
    }
    function privateAccess(caller: Caller, summary: Pick<TaskSummary, 'personal' | 'agent' | 'agentPrivate'> | undefined): void {
      if (privateSession(summary)) agentAccess(caller)
    }
    function enabledPluginInfo() {
      return registry
        .list()
        .filter(plugin => plugin.enabled)
        .map(({ id, name, description, capabilities }) => ({ id, name, description, capabilities }))
    }
    function agentAccess(caller: Caller, write = false): AgentActor {
      requireScope(caller, write ? 'run' : 'view')
      const authorize = () => {
        recheck(caller, write ? 'run' : 'view')
        if (devices.get(caller.device!.id)?.dataScope !== 'all')
          throw new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
      }
      authorize()
      return { actor: { ...actorOf(caller), deviceId: caller.device.id }, authorize }
    }
    const agentPlans = new AgentPlans({
      agents: customAgents,
      harness: id => hub!.info(id),
      plugins: () => registry.list().filter(plugin => plugin.enabled),
      skills: () => registry.skills(),
      skillBodies: ids => registry.skillBodies(ids),
      defaultModel: () => defaultModelRef(),
      modelAvailable,
      providerOwner: id => registry.providerOwner(id),
      revisions(ids) {
        const snapshot = registry.revisionSnapshot(ids),
          assets = pluginAssets.list()
        return {
          revisions: snapshot.revisions,
          persistent: snapshot.persistent,
          hashed: Object.entries(snapshot.revisions).map(([id, revision]) => {
            const asset = assets.find(record => record.id === id)
            return [id, asset?.appliedBundle ? agentPluginRevision(asset.appliedBundle) : revision]
          }),
        }
      },
      projectUsable: id => savedProject(id) !== undefined,
      environment: projectId => ({
        policy: policy.hash(),
        workspace: canonicalWorkspace,
        ...(projectId ? { folders: savedProject(projectId)?.folders.map(folder => folder.path) ?? [] } : {}),
      }),
    })
    function providerExecutionRevision(record: ProviderRecord): string | undefined {
      const { name: _, ...execution } = record
      return executionBuildRevision(execution)
    }
    function checkPrivateSession(caller: Caller, id: string, write = false): void {
      recheck(caller)
      if (hub!.agentPrivate(id)) agentAccess(caller, write)
    }
    /** An assistant's or a group's session only opens to be read: nothing runs its private context any more. */
    function assertWritable(id: string): void {
      if (hub!.personalOf(id)) throw new AppError(409, 'session-read-only', '这个会话来自已移除的 Agent，只能查看。')
    }
    /** Whether this device's authority can still stand behind a run that starts while nobody is looking. */
    function authorizeAutomation(deviceId: string, definition: AutomationConfig): void {
      const device = devices.get(deviceId),
        current = policy.get()
      if (
        !device
        || !devices.standsBehind(deviceId)
        || device.dataScope !== 'all'
        || !device.scopes.includes('run')
        || !levelAtMost('L1', current.unattended.maxLevel)
        || now() - Date.parse(device.lastSeenAt) > current.unattended.pauseAfterIdleDays * 86400000
      )
        throw new AppError(403, 'automation-owner', '这台设备不能开启这个定时任务。')
    }
    const automations = await Automations.open({
      dataDir,
      audit,
      now,
      plan: definition => agentPlans.automation(definition),
      authorize: authorizeAutomation,
      changed: () => refresh(),
      detail: id => hub!.detail(id),
      cancel: (id, runId) => hub!.cancel(id, runId ? { runId } : undefined),
      approvalTtlMs: () => policy.get().unattended.approvalTtlHours.standard * 3600000,
      async start({ requestId, automationId, title, prompt, projectId, plan, authorize }) {
        authorize()
        return projectQueue(projectId ?? 'default', async () => {
          authorize()
          refuseWhileUpdating('session')
          const chosen = projectId ? savedProject(projectId) : undefined
          if (projectId && !chosen) throw new AppError(409, 'workspace-unavailable', '找不到所选项目')
          if (chosen) await assertWorkspaceUsable(chosen)
          const task: HubCreateInput = {
            requestId,
            prompt,
            harnessId: plan.harnessId,
            workspaceId: projectId ?? 'default',
            mode: plan.mode,
            ...(plan.model ? { model: plan.model } : {}),
            automationId,
            initialTitle: title,
            ...(plan.agentContext ? { agentContext: plan.agentContext } : {}),
          }
          const folders = chosen?.folders.map(({ id, path }) => ({ id, path }))
          const own = !chosen && makeOwnFolders && plan.mode === 'agent' ? await ownFolders.allocate(requestId) : undefined
          const cwd = chosen?.folders[0].path ?? own?.path
          /** A run nobody started by hand is still on record as a start, with what it runs. */
          const onRecord = async (): Promise<Pick<HubCreateInput, 'expectedLaunchHash'>> => {
            if (hub!.levelOf(plan.harnessId) !== 'L3') return {}
            const root = await realpath(cwd ?? workspaceRoot)
            const preview = await hub!.launchPreviewOf(plan.harnessId, root, folders ? { workspaceId: projectId!, folders } : undefined)
            const launchHash = preview?.launchHash ?? sha256Hex(canonicalJson({ harnessId: plan.harnessId, automationId }))
            await audited({
              action: 'task.l3.start-requested',
              actor: { listener: 'host', via: 'startup' },
              stepup: 'none',
              detail: { harnessId: plan.harnessId, launchHash, promptHash: sha256Hex(prompt) },
            })
            return { expectedLaunchHash: launchHash }
          }
          const started = await onRecord()
          const created = await (async () => {
            if (chosen) {
              authorize()
              return hub!.createTask({ ...task, ...started, cwd: chosen.folders[0].path, folders: folders! })
            }
            if (own) return createInOwnFolder({ ...task, ...started, cwd: own.path, sessionFolder: own.name }, requestId, authorize)
            authorize()
            return hub!.createTask({ ...task, ...started })
          })()
          if (started.expectedLaunchHash)
            await audited({
              action: 'task.l3.started',
              actor: { listener: 'host', via: 'startup' },
              target: created.sessionId,
              stepup: 'none',
              detail: {
                sessionId: created.sessionId,
                harnessId: plan.harnessId,
                launchHash: started.expectedLaunchHash,
                promptHash: sha256Hex(prompt),
              },
            }).catch(() => {})
          return created
        })
      },
    })
    startupCleanup.push(() => automations.close())
    const handoffs = await Handoffs.open({
      dataDir,
      audit,
      now,
      guardedPaths,
      home,
      log,
      actor: actorOf,
      recheck: (caller, scope) => recheck(caller, scope),
      dataScope: caller => devices.get(caller.device.id)?.dataScope,
      isPrivate: id => hub!.agentPrivate(id),
      async readSession(caller, id) {
        requireScope(caller, 'view')
        checkPrivateSession(caller, id)
        const detail = await hub!.detail(id)
        recheck(caller, 'view')
        privateAccess(caller, detail.summary)
        return detail
      },
      assertSessionInput: (caller, id) => routeContext.assertSessionInput(caller, id),
      sessionRoots,
      defaultHarnessId: () => defaultHarnessId(),
      checkNewTarget(target) {
        const harnessId = target.harnessId ?? defaultHarnessId(),
          harness = hub!.info(harnessId)
        if (!harness || !hub!.has(harnessId)) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 未启用`)
        if (harness.status !== 'ready')
          throw new AppError(409, 'harness-unavailable', harness.statusMessage ?? `${harness.capabilities.display.label} 当前不可用`)
        if (target.projectId && target.projectId !== 'default' && !savedProject(target.projectId))
          throw new AppError(400, 'workspace-unavailable', '找不到所选项目')
        if (target.worktree && (!target.projectId || target.projectId === 'default'))
          throw new AppError(400, 'worktree-project', '新工作树要从一个项目开始，请先选项目。')
      },
      newTargetRoots(target) {
        const chosen = target.projectId && target.projectId !== 'default' ? savedProject(target.projectId) : undefined
        if (!chosen) return [{ id: 'default', path: workspaceRoot }]
        return hub!.info(target.harnessId ?? defaultHarnessId())?.projectFolders?.access === 'all'
          ? chosen.folders.map(({ id, path }) => ({ id, path }))
          : [{ id: 'default', path: chosen.folders[0].path }]
      },
      start: (caller, { requestId, prompt, fileRefs, target, privateFrom, title }, res) =>
        startSession(
          caller,
          {
            requestId,
            prompt,
            ...(fileRefs.length ? { fileRefs } : {}),
            ...(target.harnessId ? { harnessId: target.harnessId } : {}),
            ...(target.projectId ? { workspaceId: target.projectId } : {}),
            ...(target.mode ? { mode: target.mode } : {}),
            ...(target.model ? { model: target.model } : {}),
            ...(target.worktree ? { worktree: true as const } : {}),
            ...(privateFrom ? { privateFrom } : {}),
            ...(title ? { title } : {}),
          },
          res,
        ),
      async send(caller, id, { requestId, prompt, fileRefs }) {
        await sendPrompt(caller, id, { requestId, prompt, ...(fileRefs.length ? { fileRefs } : {}) })
      },
      listTasks: () => hub!.listTasks(),
      detail: id => hub!.detail(id),
      changed: () => refresh(),
    })
    startupCleanup.push(() => handoffs.close())
    lifecycleListeners.on('sessionDeleted', ({ sessionId }) => handoffs.sessionDeleted(sessionId))
    /**
     * One queue per project ID (`'default'` for the start directory): a start cannot enter a project between a removal's
     * in-use check and its committed settings write, and a start in a new worktree holds its project until the session
     * exists there. Another project's starts and changes never wait. A change takes its project's queue, then `serial`;
     * a start never takes `serial`, so the two never wait on each other in a cycle.
     */
    const projectChanges = new Map<string, Promise<void>>()
    function projectQueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
      const result = (projectChanges.get(projectId) ?? Promise.resolve()).then(operation)
      const tail = result.then(
        () => {},
        () => {},
      )
      projectChanges.set(projectId, tail)
      void tail.then(() => {
        if (projectChanges.get(projectId) === tail) projectChanges.delete(projectId)
      })
      return result
    }
    function projectOperation<T>(projectId: string, caller: Caller, scope: DeviceScope, operation: () => Promise<T>): Promise<T> {
      return projectQueue(projectId, () => {
        recheck(caller, scope)
        return operation()
      })
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
      subject: PresenceSubject,
      lines: PreviewLine[],
      warnings: string[] = [],
      target?: string,
    ): Promise<StepupMethod> {
      requireLocal(caller)
      requireDevice(caller)
      const hash = paramsHash(action, params)
      const header = req.headers['x-latch-confirmation']
      if (typeof header === 'string' && header) {
        return presence.consume(header, { action, requesterDeviceId: caller.device.id, paramsHash: hash }).stepup
      }
      const record = await presence.request({
        action,
        paramsHash: hash,
        subject,
        lines,
        warnings,
        requester: {
          deviceId: caller.device.id,
          deviceName: caller.device.name,
          listener: caller.connection.listener,
          remoteAddress: caller.connection.remoteAddress,
        },
        ...(target === undefined ? {} : { target }),
        // Checked against the current record: a refusal names sessions only to a device that may still view them.
        revealBlocking: devices.get(caller.device.id)?.scopes.includes('view') === true,
      })
      throw stepupRequired(publicTicket(record))
    }

    function currentDevice(caller: DeviceCaller): CurrentDevice {
      const native = isNativeListener(caller.connection.listener) ? devices.authenticateNative(caller.device.id) : undefined
      const device = native?.ok ? native.device : (devices.get(caller.device.id) ?? caller.device)
      return {
        ...nativeRoutes.deviceView(device, caller.nativeOpening),
        current: true,
        renewAfter: new Date(caller.renewAfter ?? now() + RENEW_INTERVAL_MS).toISOString(),
      }
    }

    async function presenceStatus(): Promise<HostView['presence']> {
      const availability = await presence.availability()
      return availability.status === 'available'
        ? { status: 'available' }
        : { status: 'unavailable', message: availability.message, reason: availability.reason }
    }

    async function hostView(): Promise<HostView> {
      const current = policy.get()
      return {
        hostId,
        devMode: true,
        presence: await presenceStatus(),
        tls: tlsOrigin ? { origin: tlsOrigin } : null,
        native: {
          enabled: nativeRoutes.enabled(),
          discoveryEpoch: discoveryEpoch(),
          directoryEpoch: relayDirectory.epoch(),
        },
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
        return providerPlugin(record, { fetch: providerFetchFor(record.baseURL) })
      } catch (error) {
        throw error instanceof AppError ? error : new AppError(400, 'invalid-provider', errorText(error))
      }
    }

    function pluginInfo(id: string): PluginInfo | undefined {
      return registry.list().find(plugin => plugin.id === id)
    }

    /**
     * The plugin list as settings shows it, where `activeRuns` counts sessions running on a plugin: the runs that lease
     * it (a provider or tools) plus the running sessions of the harnesses it registers. A mounted harness with no
     * session running is not in use.
     */
    async function pluginList(): Promise<PluginInfo[]> {
      const running = new Map<string, number>()
      for (const task of await hub!.listTasks()) {
        if (task.harnessId && (task.status === 'running' || task.status === 'waiting-approval'))
          running.set(task.harnessId, (running.get(task.harnessId) ?? 0) + 1)
      }
      return registry.list().map(plugin => {
        const sessions = pluginHarnesses(plugin.id).reduce((sum, id) => sum + (running.get(id) ?? 0), 0)
        return { ...plugin, activeRuns: plugin.activeRuns + sessions, ...(pluginAssets.has(plugin.id) ? { editable: true as const } : {}) }
      })
    }

    /**
     * A preset provider's HTTPS origin (any path), an address confirmed on this computer (exactly this origin and path), an
     * origin allowed for this run, or none of them. Throws for anything but an HTTP(S) URL.
     */
    function destinationOf(baseURL: string): ProviderDestination {
      const origin = originOf(baseURL)
      if (isPresetKeyOrigin(origin)) return 'preset'
      if (processOrigins.has(origin)) return 'confirmed'
      return (policy.get().confirmedAddresses ?? []).includes(addressOf(baseURL)) ? 'confirmed' : 'unconfirmed'
    }

    function recordDestination(record: ProviderRecord): ProviderDestination {
      try {
        return destinationOf(record.baseURL)
      } catch {
        return 'unconfirmed'
      }
    }

    function providerView(record: ProviderRecord): ProviderSettings {
      return { ...providerSettings(record), destination: recordDestination(record) }
    }

    /**
     * Why a configured service is not offered: its address is not confirmed (no request is ever sent there), or it is at
     * a preset provider's address, where every request needs a key, without a usable one. Undefined when it is offered.
     */
    function unusableReason(record: ProviderRecord): UnusableProvider['reason'] | undefined {
      const destination = recordDestination(record)
      if (destination === 'unconfirmed') return 'origin-unconfirmed'
      if (destination === 'preset' && !usableKey(record)) return 'key-missing'
      return undefined
    }

    /**
     * Providers sessions may use: every enabled one except configured services with an `unusableReason`. Those stay
     * registered (their settings can still be edited), but they are never offered, and requests to an unconfirmed
     * address are refused.
     */
    function usableProviders(): ReturnType<PluginRegistry['providers']> {
      const managed = new Set(
        registry
          .list()
          .filter(plugin => plugin.managed === 'provider')
          .map(plugin => plugin.id),
      )
      return registry.providers().filter(provider => {
        const record = managed.has(provider.id) ? effectiveProvider(provider.id) : undefined
        return !record || unusableReason(record) === undefined
      })
    }

    /**
     * A saved service as the gateway may forward to it now: enabled, its plugin running, and offered to sessions. The
     * fingerprint changes with its protocol, address, key and where requests to it may go, never with its name or models.
     */
    function gatewayService(id: string): GatewayService | undefined {
      const record = effectiveProvider(id)
      const plugin = pluginInfo(id)
      if (!record?.enabled || plugin?.managed !== 'provider' || !plugin.enabled || unusableReason(record) !== undefined) return undefined
      const apiKey = usableKey(record)
      return {
        kind: record.kind,
        baseURL: record.baseURL,
        apiKey,
        models: record.models.length ? [...record.models] : [record.defaultModel],
        fingerprint: sha256Hex(
          canonicalJson({ kind: record.kind, baseURL: record.baseURL, key: sha256Hex(apiKey), destination: recordDestination(record) }),
        ),
      }
    }

    /**
     * The route a session of `harness` takes to the service of `model`, as the Host computes it from its own records:
     * only a pair that needs no translation, on a service sessions may use, with a model it lists.
     */
    function modelRouteFor(harness: HarnessInfo, model: ModelRef): ModelRoute {
      const name = harness.capabilities.display.label
      const service = gatewayService(model.providerId)
      const record = effectiveProvider(model.providerId)
      if (!service || !record) throw new AppError(409, 'model-route-unavailable', '这个模型服务现在不能用，会话没有开始。')
      const route = pairRoute(harness.capabilities, { kind: record.kind })
      if (route.kind !== 'passthrough')
        throw new AppError(
          400,
          'model-route-unavailable',
          route.kind === 'translate'
            ? `${name} 只说 ${route.speaks.map(wire => WIRE_NAMES[wire]).join('、')} 协议，${record.name} 用 ${WIRE_NAMES[route.from]}，Latch 转换协议尚未实现。`
            : `让 Latch 把 ${name} 的请求转给模型服务，尚未实现。`,
        )
      if (!service.models.includes(model.model))
        throw new AppError(400, 'model-unavailable', `${record.name} 里没有模型「${model.model.slice(0, 64)}」`)
      return { providerId: record.id, model: model.model, wire: route.wire, origin: originOf(record.baseURL) }
    }

    /** Enabled services left out of the catalog, with the reason a page names (at most 20). */
    function unusableProviders(): UnusableProvider[] {
      return effectiveProviders()
        .filter(record => record.enabled)
        .flatMap(record => {
          const reason = unusableReason(record)
          return reason ? [{ id: record.id, name: record.name, reason }] : []
        })
        .slice(0, 20)
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
     * Applies an owner edit to a provider, as [live, saved]. Under `LATCH_MODEL` the same edit applies
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
      const { keyOrigin: _origin, keyPath: _path, ...withoutKey } = live
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
            if (before)
              await registry.replace(plugin, commit, {
                managed: 'provider',
                preserveEnabled: true,
                revision: providerExecutionRevision(live),
              })
            else {
              await commit()
              registry.register(plugin, { managed: 'provider', revision: providerExecutionRevision(live) })
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
          registry.register(buildProviderPlugin(current), { managed: 'provider', revision: providerExecutionRevision(current) })
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
        `Host 不会访问 ${target}：这是本机、局域网或云元数据地址。本机与局域网地址要在运行 Latch 的电脑上确认后才能使用。`,
        { target },
      )
    }

    function originUnconfirmed(): AppError {
      return new AppError(403, 'origin-unconfirmed', new OriginUnconfirmed().message)
    }

    /**
     * Lists remote models; the upstream call stops if the requesting client goes away first. `fetch` is the egress
     * policy for a typed address, or the configured providers' fetch when a saved key goes along.
     */
    async function remoteModels(res: ServerResponse, input: ModelListInput, check = false, fetch: FetchLike = egressFetch) {
      const controller = new AbortController()
      const abort = () => {
        if (!res.writableFinished) controller.abort(new Error('Client disconnected'))
      }
      res.once('close', abort)
      try {
        return check
          ? await checkProvider(input, controller.signal, { fetch })
          : { models: await listProviderModels(input, controller.signal, { fetch }) }
      } catch (error) {
        if (error instanceof AppError) throw error
        const code = codeOf(error) ?? 'provider-error'
        if (code === 'egress-denied') {
          const target =
            error instanceof Error && 'target' in error && typeof error.target === 'string' ? error.target : new URL(input.baseURL).host
          throw egressDenied(target)
        }
        if (code === 'origin-unconfirmed') throw originUnconfirmed()
        const reported = error instanceof Error && error.name === 'ProviderError'
        const status = reported && 'status' in error && typeof error.status === 'number' ? error.status : undefined
        const network = reported && 'networkCode' in error && typeof error.networkCode === 'string' ? error.networkCode : undefined
        throw new AppError(
          reported && PROVIDER_INPUT_ERRORS.has(code) ? 400 : 502,
          code,
          reported ? error.message : '无法连接模型服务，请检查地址与网络',
          {
            ...(code === 'http-error' && status !== undefined ? { upstreamStatus: status } : {}),
            ...(network ? { networkCode: network } : {}),
          },
        )
      } finally {
        res.off('close', abort)
      }
    }

    /** Keys are typed only on the Host's desktop app, which alone holds `secrets`. */
    function requireKeyEntry(caller: Caller): void {
      requireScope(caller, 'secrets')
      requireLocal(caller)
    }

    /**
     * What saving at `baseURL` adds to the policy. The address (origin and path), when it is neither under a preset's
     * HTTPS origin nor confirmed and the save carries a key or asks to confirm; an outbound allowance, when the address is
     * local or private, the allow list lacks it, and the save adds the address or asks to confirm. Nothing is looked up
     * otherwise, so a keyless save at an unconfirmed address just stays unconfirmed.
     */
    async function planDestination(baseURL: string, input: { key: boolean; confirm: boolean }): Promise<DestinationPlan> {
      const origin = originOf(baseURL)
      const plan: DestinationPlan = {
        origin,
        address: addressOf(baseURL),
        hostPort: origin.replace(/^https?:\/\//u, ''),
        addAddress: false,
      }
      const destination = destinationOf(baseURL)
      if (destination === 'preset') return plan
      plan.addAddress = destination === 'unconfirmed' && (input.key || input.confirm)
      if (!plan.addAddress && !input.confirm) return plan
      const need = await inspectEgress(baseURL)
      if (need.allowance === 'never') throw egressDenied(need.target)
      if (need.allowance === 'needed') {
        plan.reason = need.reason
        if (!policy.get().hostEgressAllow.includes(need.target) && !egressExtra.includes(need.target)) plan.egress = need.target
      }
      return plan
    }

    const confirmsDestination = (plan: DestinationPlan | undefined): plan is DestinationPlan =>
      plan !== undefined && (plan.addAddress || plan.egress !== undefined)

    /**
     * The one confirmation for a model-service address: the address, the outbound allowance it needs and a key typed
     * with it share one paramsHash, at the stricter class (A). The preview lists the Host's facts first, then what the
     * device typed.
     */
    async function confirmDestination(
      req: IncomingMessage,
      caller: Caller,
      plan: DestinationPlan,
      input: { baseURL: string; provider?: Pick<ProviderRecord, 'id' | 'name'>; apiKey?: string },
    ): Promise<StepupMethod> {
      requireScope(caller, 'admin')
      requireLocal(caller)
      if (input.apiKey) requireKeyEntry(caller)
      const scope = input.apiKey ? keyScopeOf(input.baseURL) : undefined
      const onThisComputer = plan.reason === 'loopback' || plan.reason === 'local-interface'
      const lines: PreviewLine[] = [
        { label: '地址', value: input.baseURL },
        ...(plan.egress
          ? [{ label: '出站许可', value: `允许 Host 访问 ${plan.egress}（${onThisComputer ? '这台电脑上的地址' : '局域网或私网地址'}）` }]
          : []),
        ...(input.provider
          ? [
              { label: '模型服务', value: `${input.provider.name}（${input.provider.id}）` },
              { label: '密钥', value: scope ? `已填写（不显示），只发往 ${keyScopeText(scope)}` : '未填写' },
            ]
          : []),
      ]
      const warnings = plan.origin.startsWith('http://') && !onThisComputer ? ['这个地址不使用 HTTPS，发给它的内容会以明文经过网络。'] : []
      return confirm(
        req,
        caller,
        'provider.confirm-origin',
        {
          origin: plan.origin,
          address: plan.address,
          baseURL: input.baseURL,
          addAddress: plan.addAddress,
          egress: plan.egress ?? null,
          providerId: input.provider?.id ?? null,
          keyHash: input.apiKey ? sha256Hex(input.apiKey) : null,
        },
        { form: 'origin.confirm', slots: { target: input.baseURL } },
        lines,
        warnings,
        plan.hostPort,
      )
    }

    /**
     * Adds the planned address and allowance in one audited policy change and returns its undo. Undoing only removes, so
     * the audit log never holds it back; the response then says the record is missing.
     */
    async function addDestination(
      caller: Caller,
      plan: DestinationPlan,
      stepup: StepupMethod,
    ): Promise<(res: ServerResponse) => Promise<void>> {
      const current = policy.get()
      const addresses = current.confirmedAddresses ?? []
      const address = plan.addAddress && !addresses.includes(plan.address) ? plan.address : undefined
      const egress = plan.egress && !current.hostEgressAllow.includes(plan.egress) ? plan.egress : undefined
      if (!address && !egress) return async () => {}
      if (address && addresses.length >= 256)
        throw new AppError(409, 'origins-full', '已确认的模型服务地址已有 256 个。请在 设置 › 模型 › 已确认的地址 里移除不再使用的。')
      if (egress && current.hostEgressAllow.length >= 64)
        throw new AppError(409, 'egress-full', '允许访问的地址已有 64 个。请在 设置 › 模型 › 已确认的地址 里移除不再使用的。')
      const next = structuredClone(current)
      if (address) next.confirmedAddresses = [...addresses, address]
      if (egress) next.hostEgressAllow = [...current.hostEgressAllow, egress]
      await policy.update(next, actorOf(caller), stepup)
      return async res => {
        const latest = policy.get()
        const lowered = structuredClone(latest)
        if (address) lowered.confirmedAddresses = (latest.confirmedAddresses ?? []).filter(item => item !== address)
        if (egress) lowered.hostEgressAllow = latest.hostEgressAllow.filter(item => item !== egress)
        try {
          const { audited } = await policy.update(lowered, actorOf(caller), 'none')
          if (!audited && !res.headersSent) res.setHeader('x-latch-audit', 'failed')
        } catch (error) {
          log(`模型服务保存失败后未能撤回它的地址：${errorText(error)}`)
        }
      }
    }

    /**
     * Saves a provider in the order the confirmation promised: the key's audit record, then the policy change that adds
     * its address, then the provider itself. A failed save takes the policy change back.
     */
    async function saveAt(
      caller: Caller,
      res: ServerResponse,
      input: { id: string; plan?: DestinationPlan; stepup: StepupMethod; scope?: KeyScope },
      save: () => Promise<void>,
    ): Promise<void> {
      const seq = input.scope
        ? await audited({
            action: 'provider.secret.set',
            actor: actorOf(caller),
            target: input.id,
            stepup: input.stepup,
            detail: { providerId: input.id, originHash: sha256Hex(input.scope.keyOrigin) },
          })
        : undefined
      let undo: (res: ServerResponse) => Promise<void> = async () => {}
      try {
        if (confirmsDestination(input.plan)) undo = await addDestination(caller, input.plan, input.stepup)
      } catch (error) {
        auditFailed(seq, caller)
        throw error
      }
      try {
        await save()
      } catch (error) {
        await undo(res)
        auditFailed(seq, caller)
        throw error
      }
    }

    // ---- Harnesses and agents --------------------------------------------------------------------

    function kindOf(driver: HarnessDriver): HarnessKind {
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

    /** Whether a Standard call goes to one of the built-in file tools, whose `folder` argument names a session folder. */
    function isBuiltinFileTool(toolName: string): boolean {
      return toolOwner(toolName) === BUILTIN_FILES
    }

    /**
     * A folder root in canonical form and whether it overlaps the code root. The per-call answer is never weaker than
     * the startup classification; a directory that cannot be resolved counts as overlapping, the stricter answer.
     */
    async function folderOf(path: string): Promise<{ codeRoot: boolean; root?: string }> {
      try {
        const root = await canonicalPath(path)
        return { codeRoot: (defaultFlags.codeRoot && root === canonicalWorkspace) || overlaps(root, canonicalCodeRoot), root }
      } catch {
        return { codeRoot: true }
      }
    }

    async function callFolders(session: SessionScope): Promise<CallFolder[]> {
      return Promise.all(scopeFolders(session, workspaceRoot).map(async folder => ({ id: folder.id, ...(await folderOf(folder.path)) })))
    }

    async function classifyCall(input: { toolName: string; arguments: Record<string, unknown> } & SessionScope) {
      return classifyStandardCall({
        pluginId: toolOwner(input.toolName),
        toolName: input.toolName,
        args: input.arguments,
        demo: options.demo,
        folders: await callFolders(input),
      })
    }

    async function classifyToolCall(input: ToolRiskInput): Promise<RiskLevel> {
      return (await classifyCall(input)).risk
    }

    function securityEvent(event: HarnessSecurityEvent): void | Promise<void> {
      if (event.type === 'tool-judged') {
        const { type: _type, ...detail } = event
        const written = audit.append({ action: 'task.tool.judged', actor: { listener: 'host' }, target: event.sessionId, detail })
        written.catch(error => log(`审计记录写入失败：${errorText(error)}`))
        return written.then(() => undefined)
      }
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
        } else if (event.type === 'model-route-bypassed') {
          void audit
            .append({ action: 'task.model.bypassed', actor, target: event.sessionId, detail: { sessionId: event.sessionId } })
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

    /**
     * A driver tracks a run's files right before it sends the run's first prompt. With anyone listening, and when that
     * run is the session's current one and the session is the driver's, `runStarted` goes out with the session's
     * folders as the Host resolves them, and the prompt waits within the bound.
     */
    async function runStarting(harnessId: string, input: FileTrackingInput): Promise<void> {
      if (!sessionLifecycle.listensToRuns()) return
      const { sessionId, runId } = input
      await sessionLifecycle.runStarted({
        sessionId,
        runId,
        cancel: () => harnessHub.cancelRun(harnessId, sessionId, runId),
        lookup: async () => {
          const summary = await harnessHub.runSummary(harnessId, sessionId).catch(() => undefined)
          if (summary?.runId === runId && ACTIVE_STATUSES.has(summary.status))
            return { projectId: projectIdOf(summary), folders: scopeFolders(summary, workspaceRoot) }
          log(`会话 ${sessionId} 报告的运行不是它当前的运行，未通知运行开始`)
          return undefined
        },
      })
    }

    async function mount(driver: HarnessDriver, required = false): Promise<void> {
      const lease = registry.acquireHarness(driver.id)
      await hub!.attach(driver, {
        kind: kindOf(driver),
        required,
        release: () => lease.release(),
        create: () =>
          driver.create({
            dataDir: driver.id === STANDARD ? join(dataDir, 'sessions') : join(dataDir, 'harnesses', driver.id),
            workspaceRoot,
            workspaces: usablePrimaries,
            ...(driver.projectFolders === 'all' ? { projects: usableProjects } : {}),
            registry,
            providerId: defaultProviderId,
            defaultModel: savedDefaultModel,
            tmpRoot: runtime.tmpRoot,
            securityEvent,
            clock,
            // Only a driver that says it can be pointed at a service gets tokens for one.
            ...(hub!.info(driver.id)?.capabilities.models.wires.length ? { modelGateway } : {}),
            trackFiles: async input => {
              await runStarting(driver.id, input)
              return fileTracking.start(input)
            },
            readAttachment: async (ref, signal) => {
              signal?.throwIfAborted()
              const content = await attachmentStore.read(ref)
              signal?.throwIfAborted()
              return content.ref.kind === 'image'
                ? {
                    type: 'image',
                    mimeType: content.ref.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                    data: Buffer.from(content.data).toString('base64'),
                  }
                : { type: 'text', name: content.ref.name, text: content.text! }
            },
            saveAttachment: async input => {
              if (input.data.length > 7_000_000) throw new AppError(413, 'attachment-too-large', 'Agent 图片超过 5 MB。')
              const bytes = Buffer.from(input.data, 'base64')
              if (bytes.toString('base64') !== input.data) throw new AppError(415, 'attachment-image-invalid', 'Agent 图片编码无效。')
              const ref = await attachmentStore.add({
                owner: 'host',
                requestId: randomUUID(),
                name: `Agent-image.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[input.mime] ?? 'image'}`,
                size: bytes.length,
                remote: false,
                stream: (async function* () {
                  yield bytes
                })(),
                recheck: () => {},
                accept: ref => {
                  if (ref.kind !== 'image' || ref.mime !== input.mime)
                    throw new AppError(415, 'attachment-image-invalid', 'Agent 图片类型无效。')
                },
              })
              await attachmentStore.bind('host', [ref.id], input.sessionId)
              return ref
            },
            // Only where Latch decides each call, which the hub has settled by the time it creates the Bridge.
            ...(hub!.levelOf(driver.id) === 'L1' ? { classifyToolCall } : {}),
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
      if (pluginAssets.has(id)) throw new AppError(409, 'plugin-package-settings', '请在「自定义插件」中启停此插件，以保留修改回执。')
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
    function writeSettings(caller: Caller, mutate: (draft: HostSettings) => void, scope: DeviceScope = 'admin'): Promise<void> {
      return config.updateSettings(mutate, async (next, commit) => {
        recheck(caller, scope)
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

    const pluginPackageRoutes = createPluginPackageRoutes<Caller>({
      assets: pluginAssets,
      registry,
      installedIds: assetPluginIds,
      held: heldPlugins,
      authorize(caller) {
        requireScope(caller, 'admin')
        requireDesktop(caller)
        limits.classC.take(caller.device.id)
        const authorize = () => {
          recheck(caller, 'admin')
          if (devices.get(caller.device.id)?.dataScope !== 'all')
            throw new AppError(403, 'plugin-package-scope', '自定义插件只能由这台电脑上拥有完整数据范围的管理设备编辑。')
        }
        authorize()
        return { actor: { ...actorOf(caller), deviceId: caller.device.id }, authorize }
      },
      async confirm(req, caller, input) {
        await confirm(
          req,
          caller,
          'plugin.package.apply',
          {
            id: input.id,
            revision: input.revision,
            ...(input.executionHash ? { executionHash: input.executionHash } : {}),
            ...(input.capabilitiesHash ? { capabilitiesHash: input.capabilitiesHash } : {}),
            ...(input.adoptsData ? { adoptsData: true } : {}),
          },
          input.apps
            ? {
                form: 'plugin.package.apply-pages',
                slots: { plugin: input.name, capabilities: capabilitySummary(input.apps, input.adoptsData === true) },
              }
            : { form: 'plugin.package.apply', slots: { plugin: input.name } },
          [
            { label: '插件', value: input.name },
            ...(input.executionHash
              ? [
                  { label: 'Host 模块', value: String(input.hostModules) },
                  { label: 'React 面板', value: String(input.clientPanels) },
                  { label: '可执行内容摘要', value: input.executionHash },
                ]
              : []),
            ...(input.apps ? capabilityLines(input.apps, id => savedProject(id)?.name ?? id) : []),
            ...(input.adoptsData ? [{ label: '保存的数据', value: '接上之前删除的同 ID 插件留下的数据' }] : []),
          ],
          [
            ...(input.executionHash ? ['插件是可信本机代码，可访问 Host 进程的数据；客户端模块具有当前页面权限。'] : []),
            ...(input.apps ? ['页面只能经 Host 使用上面列出的能力；开始的会话用项目的默认权限。这不是系统隔离。'] : []),
          ],
        )
      },
      dataClaim: plugin => appData.claim(plugin),
      adoptData: plugin => appData.adopt(plugin),
      async appTrust(caller, input) {
        await audited({
          action: 'plugin.package.app-trust',
          actor: actorOf(caller),
          target: input.id,
          detail: { operation: input.operation, trust: input.trust, revision: input.revision, capabilitiesHash: input.capabilitiesHash },
        })
      },
      async removeData(caller, id, remove) {
        if (!remove) {
          appData.forget(id)
          return { audited: true }
        }
        let audited = true
        const documents = await appData.removePlugin(id)
        appDiagnostics.forget(id)
        try {
          await audit.append({ action: 'app.data.removed', actor: actorOf(caller), target: id, detail: { pluginId: id, documents } })
        } catch {
          audited = false
        }
        return { audited }
      },
      serial(actor, operation) {
        const pending = changes.then(() => {
          actor.authorize()
          return operation()
        })
        changes = pending.then(
          () => {},
          () => {},
        )
        return pending
      },
      async unmount(id) {
        try {
          await unmountPlugin(id)
        } catch (cause) {
          await mountPlugin(id)
          if (cause instanceof AppError && cause.code === 'harness-busy')
            throw new AppError(409, 'plugin-in-use', '有会话正在使用此插件，请先停止这些会话，再应用、停用或删除。')
          throw cause
        }
      },
      mount: mountPlugin,
      changed: () => refresh(),
      unavailableReason: id =>
        pluginHarnesses(id).some(harnessId => hub!.info(harnessId)?.status !== 'ready')
          ? '此插件有 Harness 未能启动，请检查模块声明与本地依赖。'
          : undefined,
    })

    /** The start directory and the other projects' primary folders: a new primary folder may equal none of them. */
    function primaries(exceptId?: string): ProjectPrimary[] {
      return [
        { id: 'default', name: START_DIRECTORY, path: workspaceRoot },
        ...config
          .settings()
          .workspaces.filter(record => record.id !== exceptId)
          .map(record => ({ id: record.id, name: record.name, path: record.folders[0].path })),
      ]
    }

    function savedProject(id: string | undefined): WorkspaceRecord | undefined {
      return id === undefined ? undefined : config.settings().workspaces.find(record => record.id === id)
    }

    function requireProject(id: string): WorkspaceRecord {
      const record = savedProject(id)
      if (!record) throw new AppError(404, 'workspace-not-found', '找不到该项目')
      return record
    }

    function startInfo(): WorkspaceInfo {
      return {
        id: 'default',
        name: START_DIRECTORY,
        path: workspaceRoot,
        folders: [{ id: 'default', path: workspaceRoot }],
        ...(defaultFlags.codeRoot ? { codeRoot: true as const } : {}),
      }
    }

    function branchOfProject(path: string): Pick<WorkspaceInfo, 'branch'> {
      const branch = hub?.branchOf(path)
      return branch ? { branch } : {}
    }

    function projectInfo(record: WorkspaceRecord, state: ProjectState): WorkspaceInfo {
      return {
        id: record.id,
        name: record.name,
        path: record.path,
        ...(state.failure ? { unavailable: state.failure.message } : {}),
        folders: state.folders.map(folder => ({
          id: folder.id,
          path: folder.path,
          ...(folder.message ? { unavailable: folder.message } : {}),
        })),
        ...(record.glyph ? { glyph: record.glyph } : {}),
        ...(state.folders.some(folder => folder.problem === 'code-root') ? { codeRoot: true as const } : {}),
        ...branchOfProject(record.path),
      }
    }

    /** The start directory, then every saved project; an unusable one carries its reason, so it can still be edited and removed. */
    async function projectInfos(): Promise<WorkspaceInfo[]> {
      const infos = [startInfo()]
      for (const record of config.settings().workspaces) infos.push(projectInfo(record, await projectState(record)))
      return infos
    }

    /** As last checked, for synchronous callers; a project never checked yet counts as unusable. */
    function lastSeenUsable(record: WorkspaceRecord | undefined): boolean {
      if (!record) return false
      const state = projectStates.get(record.id)
      return state !== undefined && state.key === stateKey(record) && !state.failure
    }

    /**
     * Directories a session may start or continue in: the drivers' own second check against the Host's list. Sessions'
     * own folders lie directly inside the start directory, so listing them grants nothing the start directory does not;
     * they come last, so a project made from one starts its sessions under the project's spelling of the path. A
     * worktree the Host made for a session is listed while its project is usable, and while its start is under way.
     */
    function usablePrimaries(): string[] {
      return [
        workspaceRoot,
        ...config
          .settings()
          .workspaces.filter(record => lastSeenUsable(record))
          .flatMap(record => record.folders.map(folder => folder.path)),
        ...ownFolders.paths(hub?.sessionFolders() ?? []),
        ...(hub?.worktrees() ?? []).filter(entry => lastSeenUsable(savedProject(entry.workspaceId))).map(entry => entry.path),
        ...worktrees.starting(),
      ]
    }

    /** The start directory and the usable saved projects with their folders, for drivers that take every folder. */
    function usableProjects(): HostProject[] {
      return [
        { id: 'default', folders: [{ id: 'default', path: workspaceRoot }] },
        ...config
          .settings()
          .workspaces.filter(record => lastSeenUsable(record))
          .map(record => ({ id: record.id, folders: record.folders.map(folder => ({ id: folder.id, path: folder.path })) })),
      ]
    }

    function workspaceDisabled(record: WorkspaceRecord, state: ProjectState): AppError {
      return new AppError(409, 'workspace-disabled', `项目「${record.name}」暂不可用：${state.failure?.message ?? ''}`)
    }

    /** Session start: every folder passes R1–R7 and R10 now and the folders still do not overlap. */
    async function assertWorkspaceUsable(record: WorkspaceRecord): Promise<void> {
      const state = await projectState(record, { fresh: true, readable: true })
      if (state.failure) throw workspaceDisabled(record, state)
    }

    async function sessionTask(sessionId: string): Promise<TaskSummary | undefined> {
      return (await hub!.listTasks()).find(task => task.id === sessionId)
    }

    /** Where a session's terminals open: its primary folder, while the session may still use it. */
    async function terminalFolder(sessionId: string): Promise<{ path: string } | 'removed' | undefined> {
      const task = await sessionTask(sessionId)
      if (!task) return undefined
      if (task.personal) throw new AppError(409, 'terminal-personal-session', '这个会话来自已移除的 Agent，没有项目文件夹，不能打开终端')
      if (task.archived) throw new AppError(409, 'terminal-session-archived', '这个会话已归档，不能打开终端')
      try {
        await assertSessionWorkspace(sessionId)
      } catch (error) {
        if (error instanceof AppError && error.status === 409) return 'removed'
        throw error
      }
      return { path: sessionFolders(task, workspaceRoot)[0]! }
    }

    /** Whether every folder a session recorded still resolves to a folder of `record`. */
    async function foldersStillIn(task: TaskSummary, record: WorkspaceRecord): Promise<boolean> {
      const current = await canonicalSet(record.folders.map(folder => folder.path))
      for (const path of sessionFolders(task, workspaceRoot)) {
        const canonical = await canonicalPath(path).catch(() => undefined)
        if (canonical === undefined || !current.has(canonical)) return false
      }
      return true
    }

    /**
     * New turns and option changes in an existing session. A session started in a saved project needs every folder it
     * recorded to still be a folder of that project (else 409 `workspace-changed`) and the project to be usable (409
     * `workspace-disabled`). A session in a folder of its own needs that folder still directly inside the start directory
     * (else `workspace-changed`). A session from before projects had several folders is refused while its directory is
     * the primary folder of an unusable project.
     */
    async function assertSessionWorkspace(sessionId: string): Promise<void> {
      const task = await sessionTask(sessionId)
      if (task?.sessionFolder && !(await ownFolders.verify(task.cwd))) throw workspaceChanged()
      // A worktree session needs its project, and the worktree still Latch's and this session's, where it started.
      const worktree = task && hub!.worktreeOf(task.id)
      if (task && worktree) {
        const record = savedProject(task.workspaceId)
        if (!record || task.cwd !== worktree.path || (await worktrees.sessionOf(worktree.path)) !== task.id) throw workspaceChanged()
        const state = await projectState(record)
        if (state.failure) throw workspaceDisabled(record, state)
        return
      }
      if (!task || task.workspaceId === 'default') return
      if (task.workspaceId !== undefined) {
        const record = savedProject(task.workspaceId)
        if (!record || !(await foldersStillIn(task, record))) throw workspaceChanged()
        const state = await projectState(record)
        if (state.failure) throw workspaceDisabled(record, state)
        return
      }
      // An unresolvable directory is refused by the driver itself.
      const root = await canonicalPath(task.cwd ?? workspaceRoot).catch(() => undefined)
      if (root === undefined || root === canonicalWorkspace) return
      for (const record of config.settings().workspaces) {
        const state = await projectState(record)
        if (state.failure && (await canonicalSet(record.folders.map(folder => folder.path))).has(root))
          throw workspaceDisabled(record, state)
      }
    }

    /**
     * Whether a running or waiting session of `record` uses one of `paths`: a session started in the project, by the
     * folders it recorded; one from before projects had several folders, by its directory against the primary folder.
     */
    async function sessionsUsing(record: WorkspaceRecord, paths: readonly string[]): Promise<boolean> {
      const targets = await canonicalSet(paths)
      for (const task of await hub!.listTasks()) {
        if (task.status !== 'running' && task.status !== 'waiting-approval') continue
        if (task.workspaceId === record.id) {
          for (const path of sessionFolders(task, workspaceRoot)) {
            if (paths.includes(path) || targets.has((await canonicalPath(path).catch(() => undefined)) ?? '')) return true
          }
        } else if (task.workspaceId === undefined && task.cwd !== undefined) {
          // Such a session uses only its directory, which was the project's primary folder when it started.
          if (paths.includes(task.cwd) || targets.has((await canonicalPath(task.cwd).catch(() => undefined)) ?? '')) return true
        }
      }
      return false
    }

    /**
     * A new project from the desktop's native picker or a confirmed drop (or `pnpm latch project add`). Each path passes
     * R1–R10 and the project rules in order; the first accepted one is the primary folder. Audited before it is saved.
     */
    async function createProject(
      caller: DeviceCaller,
      input: z.infer<typeof projectCreateSchema>,
    ): Promise<{ workspace: WorkspaceInfo; refused: FolderRefusal[] }> {
      if (input.name !== undefined && !isPrintableText(input.name)) throw unprintableName()
      const plan = await planFolders({ current: [], paths: input.paths, primaries: primaries(), guard: workspaceGuard })
      if (plan.added.length === 0) throw foldersRefused(plan.refused)
      const record = newProject({ ...(input.name !== undefined ? { name: input.name } : {}), folders: plan.folders, taken: takenIds() })
      return { workspace: await saveNewProject(caller, record, input.via), refused: plan.refused }
    }

    function takenIds(): string[] {
      return ['default', ...config.settings().workspaces.map(item => item.id)]
    }

    /** Granting: the project is on record before it is saved, and a failed save marks the record as never committed. */
    async function saveNewProject(caller: DeviceCaller, record: WorkspaceRecord, via: FolderVia): Promise<WorkspaceInfo> {
      const seq = await audited({
        action: 'workspace.added',
        actor: actorOf(caller),
        target: record.id,
        detail: {
          workspaceId: record.id,
          pathHash: sha256Hex(record.path),
          folderCount: record.folders.length,
          foldersHash: foldersHash(record.folders),
          via,
        },
      })
      try {
        await writeSettings(caller, draft => {
          draft.workspaces.push(record)
        })
      } catch (error) {
        auditFailed(seq, caller)
        throw error
      }
      return projectInfo(record, await projectState(record, { fresh: true }))
    }

    /**
     * 存为项目 from the desktop: the folder the Host made for a session becomes the primary folder of a new project, named
     * after the session, after the same checks as a picked folder. The page names the session, never a path. The session
     * keeps the project it started in (the start directory): a session's project is fixed when it is created.
     */
    async function saveSessionProject(
      caller: DeviceCaller,
      input: z.infer<typeof sessionProjectSchema>,
    ): Promise<{ workspace: WorkspaceInfo; refused: FolderRefusal[] }> {
      const task = await sessionTask(input.sessionId)
      if (!task) throw new AppError(404, 'task-not-found', '找不到该会话')
      if (!task.sessionFolder || task.workspaceId !== 'default' || !task.cwd || !(await ownFolders.verify(task.cwd)))
        throw new AppError(409, 'session-folder-none', '这个会话没有自己的文件夹，或文件夹已不在默认文件夹中，不能存为项目')
      const plan = await planFolders({ current: [], paths: [task.cwd], primaries: primaries(), guard: workspaceGuard })
      if (plan.added.length === 0) throw foldersRefused(plan.refused)
      // What is saved is the real path the rules were checked on: it must still be the folder directly inside the start
      // directory that the owner confirmed, not wherever a link put in its place meanwhile points.
      if ((await canonicalPath(dirname(plan.folders[0].path)).catch(() => undefined)) !== canonicalWorkspace)
        throw new AppError(409, 'session-folder-none', '这个会话没有自己的文件夹，或文件夹已不在默认文件夹中，不能存为项目')
      const title = Array.from(task.title.trim()).slice(0, 80).join('').trim()
      const record = newProject({
        ...(title && isPrintableText(title) ? { name: title } : {}),
        idBase: basename(plan.folders[0].path),
        folders: plan.folders,
        taken: takenIds(),
      })
      return { workspace: await saveNewProject(caller, record, 'session'), refused: [] }
    }

    /** More folders for a saved project, or (`replace`) one path in place of a folder, keeping its ID and position. */
    async function addFolders(
      caller: DeviceCaller,
      id: string,
      input: z.infer<typeof folderAddSchema>,
    ): Promise<{ workspace: WorkspaceInfo; refused: FolderRefusal[] }> {
      if (id === 'default') throw new AppError(409, 'workspace-default', '默认文件夹只能包含一个文件夹。要组合多个文件夹，请添加项目。')
      const record = requireProject(id)
      if (input.replace !== undefined) {
        const replaced = record.folders.find(folder => folder.id === input.replace)
        if (!replaced) throw new AppError(404, 'workspace-folder-not-found', '找不到该文件夹')
        if (await sessionsUsing(record, [replaced.path])) throw folderInUse()
      }
      const plan = await planFolders({
        current: record.folders,
        paths: input.paths,
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
        primaries: primaries(record.id),
        guard: workspaceGuard,
      })
      if (plan.added.length === 0) throw foldersRefused(plan.refused)
      const seqs: number[] = []
      const failed = () => {
        for (const seq of seqs) auditFailed(seq, caller)
      }
      try {
        for (const folder of plan.added) {
          const seq = await audited({
            action: 'workspace.folder-added',
            actor: actorOf(caller),
            target: record.id,
            detail: {
              workspaceId: record.id,
              folderId: folder.id,
              pathHash: sha256Hex(folder.path),
              via: input.via,
              replacesFolder: input.replace !== undefined,
            },
          })
          if (seq !== undefined) seqs.push(seq)
        }
        await writeSettings(caller, draft => {
          const target = draft.workspaces.find(item => item.id === record.id)
          if (!target) throw new AppError(404, 'workspace-not-found', '找不到该项目')
          target.folders = plan.folders
          target.path = plan.folders[0].path
          if (input.replace === record.folders[0]?.id) delete target.invalid
        })
      } catch (error) {
        failed()
        throw error
      }
      const updated = requireProject(record.id)
      return { workspace: projectInfo(updated, await projectState(updated, { fresh: true })), refused: plan.refused }
    }

    /** Rename, glyph and folder order (which sets the primary folder): the folder set stays the same. Audited first. */
    async function patchProject(caller: DeviceCaller, id: string, input: z.infer<typeof projectPatchSchema>): Promise<WorkspaceInfo> {
      if (id === 'default') throw new AppError(409, 'workspace-default', '默认文件夹由 Host 的启动参数决定，不能修改')
      if (input.name !== undefined && !isPrintableText(input.name)) throw unprintableName()
      const record = requireProject(id)
      const folders = input.order ? reorderFolders(record.folders, input.order) : record.folders
      const renamed = input.name !== undefined && input.name !== record.name
      const glyphChanged = input.glyph !== undefined && (input.glyph ?? undefined) !== record.glyph
      const primaryChanged = folders[0].id !== record.folders[0].id
      const reordered = folders.some((folder, index) => folder.id !== record.folders[index].id)
      if (!renamed && !glyphChanged && !reordered) return projectInfo(record, await projectState(record))
      if (primaryChanged) {
        const verdict = await checkProjectFolders([folders[0].path], { existing: primaries(record.id) })
        if (!verdict.ok) throw verdict.error
      }
      const seq = await audited({
        action: 'workspace.changed',
        actor: actorOf(caller),
        target: record.id,
        detail: { workspaceId: record.id, renamed, glyphChanged, primaryChanged, reordered },
      })
      try {
        if (primaryChanged) {
          const previous = await canonicalPath(record.path)
          const owners = await Promise.all(
            [workspaceRoot, ...config.settings().workspaces.map(item => item.path)].map(path => canonicalPath(path).catch(() => undefined)),
          )
          if (owners.filter(path => path === previous).length === 1) {
            for (const task of await hub!.listTasks()) {
              if (task.workspaceId === undefined && task.cwd && (await canonicalPath(task.cwd).catch(() => undefined)) === previous) {
                await hub!.recordWorkspace(task.id, record.id)
              }
            }
          }
        }
        await writeSettings(caller, draft => {
          const target = draft.workspaces.find(item => item.id === record.id)
          if (!target) throw new AppError(404, 'workspace-not-found', '找不到该项目')
          if (renamed) target.name = input.name!
          if (glyphChanged) {
            if (input.glyph) target.glyph = input.glyph
            else delete target.glyph
          }
          target.folders = folders
          target.path = folders[0].path
        })
      } catch (error) {
        auditFailed(seq, caller)
        throw error
      }
      const updated = requireProject(record.id)
      return projectInfo(updated, await projectState(updated, { fresh: true }))
    }

    /** Lowering: never blocked by the audit log. The last folder cannot go; the next one becomes primary when the first goes. */
    async function removeFolder(caller: DeviceCaller, id: string, folderId: string, res: ServerResponse): Promise<WorkspaceInfo> {
      if (id === 'default') throw new AppError(409, 'workspace-default', '默认文件夹只能包含一个文件夹，不能移除')
      const record = requireProject(id)
      const index = record.folders.findIndex(folder => folder.id === folderId)
      if (index < 0) throw new AppError(404, 'workspace-folder-not-found', '找不到该文件夹')
      if (record.folders.length === 1) throw new AppError(409, 'workspace-last-folder', '项目至少要有一个文件夹')
      const folder = record.folders[index]
      if (await sessionsUsing(record, [folder.path])) throw folderInUse()
      const folders = record.folders.filter((_, position) => position !== index)
      if (index === 0) {
        const verdict = await checkProjectFolders([folders[0].path], { existing: primaries(record.id) })
        if (!verdict.ok) throw verdict.error
      }
      await audited(
        {
          action: 'workspace.folder-removed',
          actor: actorOf(caller),
          target: record.id,
          detail: { workspaceId: record.id, folderId: folder.id, pathHash: sha256Hex(folder.path) },
        },
        res,
      )
      await writeSettings(caller, draft => {
        const target = draft.workspaces.find(item => item.id === record.id)
        if (!target) throw new AppError(404, 'workspace-not-found', '找不到该项目')
        target.folders = folders
        target.path = folders[0].path
      })
      const updated = requireProject(record.id)
      return projectInfo(updated, await projectState(updated, { fresh: true }))
    }

    async function removeWorkspace(caller: Caller, id: string, res: ServerResponse): Promise<void> {
      if (id === 'default') throw new AppError(409, 'workspace-default', '默认文件夹不能移除')
      const record = requireProject(id)
      if (
        await sessionsUsing(
          record,
          record.folders.map(folder => folder.path),
        )
      )
        throw new AppError(409, 'workspace-in-use', '有会话正在该项目中运行，请结束后再移除')
      const real = await realpath(record.path).catch(() => record.path)
      await audited(
        { action: 'workspace.removed', actor: actorOf(caller), target: id, detail: { workspaceId: id, pathHash: sha256Hex(real) } },
        res,
      )
      await writeSettings(caller, draft => {
        draft.workspaces = draft.workspaces.filter(item => item.id !== id)
        if (draft.defaults.workspaceId === id) delete draft.defaults.workspaceId
      })
      // A later project under this ID is checked afresh.
      projectStates.delete(id)
      unusableProjects.delete(id)
    }

    function modelAvailable(ref: ModelRef): boolean {
      const provider = usableProviders().find(item => item.id === ref.providerId)
      return Boolean(provider && (provider.models?.length ? provider.models : [provider.model]).includes(ref.model))
    }

    /** A model a session may use; otherwise why not, naming the service when it is held back rather than gone. */
    function assertModel(ref: ModelRef): void {
      if (modelAvailable(ref)) return
      const record = effectiveProvider(ref.providerId)
      const reason = record?.enabled ? unusableReason(record) : undefined
      if (reason === 'origin-unconfirmed') throw originUnconfirmed()
      if (reason === 'key-missing') {
        const name = escapeSecurityText(record!.name)
        throw new AppError(
          409,
          'provider-key-missing',
          `「${name}」还没有填写密钥。请在运行 Latch 的电脑上，打开 设置 › 模型服务 › ${name} 填写密钥。`,
        )
      }
      throw new AppError(400, 'model-unavailable', `模型 ${ref.model} 当前不可用，请选择已启用的模型服务与模型`)
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
      const enabled = new Set(usableProviders().map(provider => provider.id))
      const saved = config.settings().defaults.model?.providerId
      if (saved && enabled.has(saved)) return saved
      if (options.demo) return 'demo'
      return effectiveProviders().find(record => enabled.has(record.id))?.id ?? LEGACY_PROVIDER_ID
    }

    function defaultModelRef(): ModelRef | undefined {
      const saved = savedDefaultModel()
      if (saved) return saved
      const provider = usableProviders().find(item => item.id === defaultProviderId())
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
      // What was pinned must still be what starts: when its engine or model cannot, the fallback is not what anyone chose,
      // and the device's own memory takes over. It holds again if they come back.
      const engine = hub?.info(saved.harnessId ?? STANDARD)
      const pinned =
        saved.pinned === true
        && engine?.status === 'ready'
        && (engine.capabilities.models.owner !== 'latch' || saved.model === undefined || savedDefaultModel() !== undefined)
      return {
        harnessId: defaultHarnessId(),
        mode: saved.mode ?? 'agent',
        workspaceId:
          saved.workspaceId && saved.workspaceId !== 'default' && lastSeenUsable(savedProject(saved.workspaceId))
            ? saved.workspaceId
            : 'default',
        ...(model ? { model } : {}),
        ...(pinned ? { pinned: true as const } : {}),
      }
    }

    async function savePreferences(caller: Caller, input: z.infer<typeof preferencesSchema>['defaults']): Promise<void> {
      if (input.harnessId !== undefined && !hub!.has(input.harnessId))
        throw new AppError(400, 'harness-unavailable', `Harness ${input.harnessId} 未启用`)
      if (input.workspaceId !== undefined && input.workspaceId !== 'default') {
        const record = savedProject(input.workspaceId)
        if (!record || (await projectState(record)).failure) throw new AppError(400, 'workspace-unavailable', '找不到该项目，或它暂不可用')
      }
      if (input.model) assertModel(input.model)
      await writeSettings(caller, draft => {
        if (input.harnessId !== undefined) draft.defaults.harnessId = input.harnessId
        if (input.mode !== undefined) draft.defaults.mode = input.mode
        if (input.workspaceId !== undefined) draft.defaults.workspaceId = input.workspaceId
        if (input.pinned === true) draft.defaults.pinned = true
        else if (input.pinned === false) delete draft.defaults.pinned
        if (input.model === null) delete draft.defaults.model
        else if (input.model) draft.defaults.model = { providerId: input.model.providerId, model: input.model.model }
      })
    }

    let presetLookup: { at: number; found: AgentPreset[] } | undefined
    /** Presets found on this computer that have no definition and whose id is free. */
    function presetsToOffer(): HarnessInfo[] {
      const detect = options.detectPreset
      if (!detect) return []
      if (!presetLookup || Date.now() - presetLookup.at > PRESET_LOOKUP_TTL_MS)
        presetLookup = {
          at: Date.now(),
          found: AGENT_PRESETS.filter(preset => detect(preset).found),
        }
      const saved = new Set(config.settings().agents.map(agent => agent.presetId))
      return presetLookup.found.filter(preset => !saved.has(preset.id) && !hub!.info(preset.id)).map(presetOffer)
    }

    /** A saved Harness definition this Host runs and that can start now. */
    function editableHarness(id: string): HarnessInfo {
      const harness = hub!.info(id)
      if (!harness?.editable || !hub!.has(id)) throw new AppError(404, 'agent-not-found', '找不到该 Harness')
      if (harness.status !== 'ready')
        throw new AppError(409, 'harness-unavailable', harness.statusMessage ?? `${harness.capabilities.display.label} 当前不可用`)
      return harness
    }

    /** A draft's Harness, which may not be saved yet: it decides which folders a file search covers. */
    const draftHarness = (id: string): HarnessInfo | undefined => hub!.info(id) ?? presetsToOffer().find(item => item.id === id)

    async function catalog(caller: Caller): Promise<HostCatalog> {
      // Only a device that may save a definition is offered one; everyone else keeps what is defined.
      const mayDefine = caller.device?.scopes.includes('admin') === true
      return {
        promptTemplatesVersion: templateStore.revision(),
        features: {
          agentProbe: true,
          queue: true,
          questions: true,
          messageIdentity: true,
          fork: true,
          attachments: true,
          fileMentions: true,
          search: true,
          sessionBatch: true,
          promptTemplates: true,
          pluginPackages: true,
          usage: true,
          fileSearch: true,
          ...(directoryReader.available ? { fileTree: true as const } : {}),
          filePreview: true,
          configReceipts: true,
          runLiveness: true,
          pinnedDefaults: true,
          ...routes.features(caller),
        },
        harnesses: [...hub!.drivers(), ...(mayDefine ? presetsToOffer() : [])],
        providers: usableProviders().map(provider => summarizeProvider(provider, providerKindOf(provider.id))),
        unusableProviders: unusableProviders(),
        uiPanels: registry.uiPanels(),
        skills: registry.skills(),
        // Disabled workspaces are listed with their reason for settings; session pickers skip any entry marked unavailable.
        workspaces: await projectInfos(),
        defaults: sessionDefaults(),
        projectFolders: { max: PROJECT_FOLDER_LIMIT },
        ...(makeOwnFolders ? { sessionFolders: true as const } : {}),
      }
    }

    // ---- Approvals -------------------------------------------------------------------------------

    /** Builtin: the Host classifier's risk, never lower than the runtime's. Others: advisory R2. */
    /**
     * The approval as clients see it: the Host's own classification, never weaker than what the driver recorded, and for
     * a built-in R2 the reason the classifier gave. A driver's own `riskReason` is dropped; unparsable arguments are R2
     * with `unparsable-arguments`.
     */
    async function decorate(approval: Approval, level: 'L1' | 'L3', session: SessionScope | undefined): Promise<Approval> {
      const { risk: reported, advisory: _advisory, riskReason: _reported, ...rest } = approval
      if (level !== 'L1') return { ...rest, advisory: true, risk: 'R2' }
      const args = parseArguments(approval.arguments)
      const classified = args
        ? await classifyCall({ toolName: approval.toolName, arguments: args, ...session })
        : { risk: 'R2' as const, reason: 'unparsable-arguments' as const }
      const risk = maxRisk(maxRisk(classified.risk, reported ?? 'R1'), 'R1')
      const riskReason = risk === 'R2' && classified.risk === 'R2' ? classified.reason : undefined
      return { ...rest, risk: risk === 'R2' ? 'R2' : 'R1', ...(riskReason ? { riskReason } : {}) }
    }

    async function decorateAll(approvals: Approval[], tasks: TaskSummary[]): Promise<Approval[]> {
      const byId = new Map(tasks.map(task => [task.id, task]))
      return Promise.all(
        approvals.map(async approval => {
          const task = byId.get(approval.sessionId)
          const harnessId = task?.harnessId ?? (await hub!.harnessOf(approval.sessionId).catch(() => undefined))
          return decorate(approval, harnessId ? hub!.levelOf(harnessId) : 'L3', task)
        }),
      )
    }

    async function decoratedDetail(sessionId: string): Promise<TaskDetail> {
      const detail = await hub!.detail(sessionId)
      const level = hub!.levelOf(detail.summary.harnessId)
      return {
        ...detail,
        summary: questionSummary(detail.summary),
        queue: promptQueues.view(sessionId),
        questions: questions.view(sessionId),
        approvals: await Promise.all(detail.approvals.map(approval => decorate(approval, level, detail.summary))),
      }
    }

    function settled(approvalId: string, caller: DeviceCaller): AppError {
      const record = hub!.receipts.approval(approvalId)?.record
      // The name is the device's current one; a device the Host no longer knows is named by nothing.
      const decidedBy = record
        ? {
            kind: 'device',
            self: record.deviceId === caller.device.id,
            deviceName: devices.get(record.deviceId)?.name ?? '',
            decision: record.decision,
            optionKind: record.optionKind,
            at: record.at,
          }
        : { kind: 'system' }
      return new AppError(409, 'approval-settled', '该审批已处理或已失效，请刷新任务', { decidedBy })
    }

    /**
     * Keeps a receipt with its session. The decision or cancel has already taken effect, so a failed write is logged
     * rather than reported: the receipt still answers retries until the Host stops, and goes into the next write.
     */
    async function keepReceipt(sessionId: string, receipt: ApprovalRecord | CancelRecord): Promise<void> {
      await hub!.receipts.record(sessionId, receipt).catch(error => log(`回执未能保存：${errorText(error)}`))
    }

    /**
     * Target realpath, content hashes and risk reason of a Standard call, for the R2 confirmation. Content hashes describe
     * the built-in writer's file only: another tool's `content` or diff is that tool's own, and its arguments show it whole.
     * A built-in file tool's relative path is resolved in the folder its `folder` argument names (the primary folder
     * without one); in a session of several folders that folder is a fact of its own, or `null` when the session has no
     * such folder. Other tools' paths are resolved in the working directory.
     */
    async function approvalFacts(approval: Approval, args: Record<string, unknown> | undefined, session: SessionScope | undefined) {
      const cwd = session?.cwd
      const realCwd = await realpath(cwd ?? workspaceRoot).catch(() => cwd ?? workspaceRoot)
      const folders = scopeFolders(session ?? {}, workspaceRoot)
      const fileTool = isBuiltinFileTool(approval.toolName)
      const targeted = fileTool ? targetFolder(args ?? {}, folders) : undefined
      const base = fileTool ? (targeted ? await realpath(targeted.path).catch(() => targeted.path) : undefined) : realCwd
      const folder = fileTool && folders.length > 1 ? (base ?? null) : undefined
      let target: string | undefined
      if (base !== undefined && args && typeof args.path === 'string' && args.path && !isAbsolute(args.path)) {
        const joined = resolve(base, args.path)
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
        ? (await classifyCall({ toolName: approval.toolName, arguments: args, ...session })).reason
        : ('unparsable-arguments' as const)
      const previewHash = sha256Hex(
        canonicalJson({
          approvalId: approval.id,
          sessionId: approval.sessionId,
          toolName: approval.toolName,
          arguments: args ?? approval.arguments,
          cwd: realCwd,
          ...(folder !== undefined ? { folder } : {}),
          target,
          newTextHash,
          oldTextHash,
        }),
      )
      return { realCwd, folder, target, newTextHash, oldTextHash, reason, previewHash, builtinWrite }
    }

    async function decideApproval(req: IncomingMessage, res: ServerResponse, caller: Caller, approvalId: string): Promise<void> {
      requireScope(caller, 'view')
      const input = decisionSchema.parse(await jsonBody(req))
      if (isNativeListener(caller.connection.listener)) {
        if (input.decision === 'reject' && input.note === undefined) caller.nativeWindowExempt = true
        else if (nativeRoutes.verifiedUntil(caller.nativeOpening) <= now())
          throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
      }
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
      // An approval decided over HTTP never becomes pending again, even while its driver is still settling it, nor
      // after a restart: the decision is kept with its session.
      const record = hub!.receipts.approval(approvalId)?.record
      if (record) {
        if (input.requestId && record.requestId === input.requestId && record.deviceId === caller.device.id) {
          json(res, { accepted: true, receipt: { ...approvalReceipt(record), replay: true } })
          return
        }
        throw settled(approvalId, caller)
      }
      const found = await hub!.findApproval(approvalId)
      if (!found) throw settled(approvalId, caller)
      const level = hub!.levelOf(found.harnessId)
      const session = (await hub!.listTasks()).find(task => task.id === found.approval.sessionId)
      if (input.decision === 'allow' || input.note !== undefined) privateAccess(caller, session)
      if (input.decision === 'allow') assertWritable(found.approval.sessionId)
      const approval = await decorate(found.approval, level, session)
      const option = input.optionId ? approval.options?.find(item => item.id === input.optionId) : undefined
      if (input.optionId && !option) {
        throw approval.advisory
          ? new AppError(400, 'approval-option-hidden', '该选项会持久保存授权，Latch 不提供')
          : new AppError(400, 'invalid-option', '该审批不提供此选项')
      }
      if (option && option.kind.startsWith('allow') !== (input.decision === 'allow'))
        throw new AppError(400, 'invalid-option', '所选选项与决定不一致')
      const optionKind = option?.kind ?? (input.decision === 'allow' ? 'allow_once' : 'reject_once')
      // 「告诉 Agent 改做什么」 goes only with a rejection, and only to a harness that hands it on: an agent's permission answer
      // carries no text. It is checked before anything is recorded.
      let note: string | undefined
      if (input.note !== undefined) {
        if (input.decision !== 'reject') throw new AppError(400, 'invalid-note', '只有拒绝时可以附上说明')
        const checked = rejectionNote(input.note)
        if (checked === null) throw new AppError(400, 'invalid-note', '说明最多 500 个字，不能包含控制字符、不可见字符或改变文字方向的字符')
        if (hub!.info(found.harnessId)?.capabilities.permission.rejectionNote) note = checked
      }
      const args = level === 'L1' ? parseArguments(approval.arguments) : undefined
      // Checked against the current device record: the request may have been opened before a scope change.
      const needed: DeviceScope =
        input.decision === 'reject' ? 'view' : approval.advisory ? 'run' : approval.risk === 'R2' ? 'approve:elevated' : 'approve:standard'
      let previewHash: string | undefined
      if (input.decision === 'reject') limits.classC.take(caller.device.id)
      recheck(caller, needed)
      if (input.decision === 'allow') {
        // Allowing a call acts in the session's folders, so they must still be folders of its project, as for new input.
        await assertSessionWorkspace(approval.sessionId)
      }
      // A note is input to the model, so it needs what typing into the session needs: a device that may only view or
      // reject can still reject, but without a note.
      if (note !== undefined) {
        recheck(caller, 'run')
      }
      if (input.decision === 'allow' && optionKind === 'allow_always' && (approval.advisory || approval.risk === 'R2')) {
        throw new AppError(403, 'approval-always-unavailable', '高风险操作不提供“始终允许”')
      }
      // A standing allowance widens the session as a mode change does: a page may no longer drive it.
      if (input.decision === 'allow' && optionKind === 'allow_always') await hub!.markOriginChanged(approval.sessionId)
      if (input.decision === 'allow' && approval.risk === 'R2' && !approval.advisory) {
        previewHash = (await approvalFacts(approval, args, session)).previewHash
      }
      recheck(caller, needed)
      const at = new Date(now()).toISOString()
      const intent = await audited(
        {
          action: 'approval.decided',
          actor: actorOf(caller),
          target: approvalId,
          stepup: 'none',
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
      try {
        recheck(caller, needed)
        if (input.decision === 'allow') privateAccess(caller, session)
      } catch (error) {
        auditFailed(intent, caller)
        throw error
      }
      const accepted = await hub!.decide(approvalId, input.decision, {
        ...(input.optionId ? { optionId: input.optionId } : {}),
        // The decision record says only where the person was, never which device: names and ids stay in the audit.
        via: isLocalListener(caller.connection.listener) ? 'this-mac' : 'other-device',
        ...(note ? { note } : {}),
      })
      if (!accepted) {
        await audited({ action: 'approval.stale', actor: actorOf(caller), target: approvalId, detail: { approvalId } }, res)
        throw settled(approvalId, caller)
      }
      const recorded: ApprovalRecord = {
        kind: 'approval',
        approvalId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        deviceId: caller.device.id,
        decision: input.decision,
        ...(input.optionId ? { optionId: input.optionId } : {}),
        optionKind,
        at,
      }
      await keepReceipt(approval.sessionId, recorded)
      json(res, { accepted: true, receipt: approvalReceipt(recorded) })
    }

    /**
     * A cancel names the run it means (`runId`), so a late one cannot stop a run that began afterwards, and carries a
     * `requestId`, so a retry, also after a restart, gets the first answer instead of a second cancel.
     */
    async function cancelTask(
      caller: DeviceCaller,
      sessionId: string,
      input: z.infer<typeof cancelSchema>,
      res: ServerResponse,
    ): Promise<CancelReceipt> {
      const { requestId } = input
      const replay = (): CancelReceipt | undefined => {
        const stored = requestId ? hub!.receipts.cancel(sessionId, caller.device.id, requestId) : undefined
        if (!stored) return undefined
        if (stored.runId !== input.runId) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的取消')
        return { ...cancelReceipt(sessionId, stored), replay: true }
      }
      // A stored answer needs no route, so it replays even when the session's driver did not mount after a restart.
      const early = replay()
      if (early) return early
      await hub!.harnessOf(sessionId)
      if (!requestId) return cancelOnce(caller, sessionId, input, res)
      const key = `${sessionId}\n${caller.device.id}\n${requestId}`
      // No await between the last look and claiming the flight, so two copies never both run.
      for (;;) {
        const answer = replay()
        if (answer) return answer
        const flight = cancelFlights.get(key)
        if (!flight) break
        // A copy waits for the first; a first that failed left no receipt, so this one then runs itself.
        await flight.catch(() => undefined)
      }
      const run = cancelOnce(caller, sessionId, input, res)
      cancelFlights.set(key, run)
      try {
        return await run
      } finally {
        if (cancelFlights.get(key) === run) cancelFlights.delete(key)
      }
    }

    async function cancelOnce(
      caller: DeviceCaller,
      sessionId: string,
      input: z.infer<typeof cancelSchema>,
      res: ServerResponse,
    ): Promise<CancelReceipt> {
      const { requestId, runId } = input
      // A driver that cannot list its sessions must not keep a run from being stopped: the driver checks runId itself.
      const before = await hub!.summary(sessionId).catch(() => undefined)
      let outcome: CancelOutcome = 'ended'
      let status: TaskStatus | undefined
      let runEnd: RunEnd | undefined
      if (before && runId !== undefined && before.runId !== runId) {
        // The named run is over and another may be running; its final status is not known here.
      } else if (before && runId !== undefined && !ACTIVE_STATUSES.has(before.status)) {
        status = before.status
        runEnd = before.runEnd && runEndOutline(before.runEnd)
      } else {
        // A cancel without runId keeps its earlier meaning: stop whatever is running, if anything.
        await audited(
          { action: 'task.cancelled', actor: actorOf(caller), target: sessionId, detail: { sessionId, ...(runId ? { runId } : {}) } },
          res,
        )
        // Before the cancel, which can settle the session and let the queue send its next item.
        await promptQueues.stopped(sessionId).catch(() => log('排队状态未能更新，请手动检查队列'))
        const cancelled = await hub!.cancel(sessionId, runId === undefined ? undefined : { runId })
        const stopped = cancelled === true || (cancelled === undefined && (!before || ACTIVE_STATUSES.has(before.status)))
        outcome = stopped ? 'stopped' : 'ended'
        // A different run id afterwards means another run began once this one settled.
        const after = await hub!.summary(sessionId).catch(() => undefined)
        if (after && after.runId === (before ? before.runId : runId)) {
          status = after.status
          runEnd = after.runEnd && runEndOutline(after.runEnd)
        }
      }
      const at = new Date(now()).toISOString()
      if (requestId) {
        await keepReceipt(sessionId, {
          kind: 'cancel',
          requestId,
          deviceId: caller.device.id,
          ...(runId ? { runId } : {}),
          outcome,
          ...(status ? { status } : {}),
          ...(runEnd ? { runEnd } : {}),
          at,
        })
      }
      return cancelReceipt(sessionId, {
        ...(requestId ? { requestId } : {}),
        ...(runId ? { runId } : {}),
        outcome,
        ...(status ? { status } : {}),
        ...(runEnd ? { runEnd } : {}),
        at,
      })
    }

    // ---- Change stream ---------------------------------------------------------------------------

    /**
     * A stream stays open only while the credential that opened it would still be accepted: not past its renewal deadline,
     * not rotated out beyond the grace window, and the device not revoked. The client then reconnects with its current credential.
     */
    function streamAllowed(stream: EventStream): boolean {
      return (
        (!stream.nativeOpening || nativeRoutes.verifiedUntil(stream.nativeOpening) > now())
        && devices.get(stream.deviceId)?.scopes.includes('view') === true
        && devices.streamAllowed(stream.deviceId, stream.credentialHash)
      )
    }

    function send(res: ServerResponse, event: ChangeEvent | TaskStateEvent): void {
      const stream = streams.get(res)
      if (!stream || !streamAllowed(stream)) {
        res.end()
        streams.delete(res)
        return
      }
      if (event.type === 'task-state' && privateSession(event.detail.summary) && devices.get(stream.deviceId)?.dataScope !== 'all') return
      // A connection can join while an older batch awaits an external Bridge.
      // Equal revisions are valid for different events in the same batch.
      if (event.revision < stream.lastSentRevision) return
      // Disconnect lagging readers; this is not a hard per-frame or memory limit.
      if (res.writableLength > 262_144) {
        res.destroy()
        streams.delete(res)
        return
      }
      let frame = frames.get(event)
      if (stream.nativeOpening) {
        if (event.type === 'task-state') stream.nativeOpening.padding?.activity(res, ACTIVE_STATUSES.has(event.detail.summary.status))
        if (!stream.paddingObserved) {
          stream.paddingObserved = true
          res.once('close', () => stream.nativeOpening?.padding?.activity(res, false))
        }
        frame =
          nativeReplay.frame(event)
          ?? `id: ${nativeReplay.cursor()}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, resumeRequired: true })}\n\n`
      }
      if (frame === undefined) {
        frame = `id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        frames.set(event, frame)
      }
      write(res, stream, event.type, frame, event.sessionId)
      stream.lastSentRevision = event.revision
    }

    function write(res: ServerResponse, stream: EventStream, kind: FrameKind, frame: string, sessionId?: string): void {
      res.write(frame)
      traffic.frame(stream.meter, kind, Buffer.byteLength(frame), sessionId)
    }

    /** The Host's own availability goes to every stream whose credential is still accepted, outside the revision order. */
    function sendHostState(res: ServerResponse, event: HostStateEvent): void {
      const stream = streams.get(res)
      if (!stream || !streamAllowed(stream)) {
        if (!res.writableEnded) res.end()
        streams.delete(res)
        return
      }
      write(res, stream, 'host-state', `event: host-state\ndata: ${JSON.stringify(event)}\n\n`)
    }

    /**
     * A plugin page's document changed: to every stream whose device may read it, outside the revision order (a page
     * reads the document again). A session's documents go only where that session may be read.
     */
    function sendAppData(change: Omit<AppDataEvent, 'type' | 'instanceId'>, restricted = false): void {
      const sessionId = change.scope.startsWith('session:') ? change.scope.slice('session:'.length) : undefined
      const isPrivate = restricted || (sessionId !== undefined && hub!.agentPrivate(sessionId))
      const event: AppDataEvent = { type: 'app.data', instanceId, ...change }
      const frame = `event: app.data\ndata: ${JSON.stringify(event)}\n\n`
      for (const [res, stream] of streams) {
        if (!streamAllowed(stream)) continue
        if (isPrivate && devices.get(stream.deviceId)?.dataScope !== 'all') continue
        if (stream.nativeOpening && nativeRoutes.verifiedUntil(stream.nativeOpening) <= now()) continue
        write(res, stream, 'app.data', frame)
      }
    }

    /** Announces the stop on every stream and ends them all, giving the last frames a moment to leave. */
    async function endStreams(event: HostStateEvent): Promise<void> {
      const open = [...streams.keys()]
      for (const res of open) sendHostState(res, event)
      streams.clear()
      await Promise.all(
        open.map(
          res =>
            new Promise<void>(done => {
              const timer = setTimeout(done, 500)
              const finish = () => {
                clearTimeout(timer)
                done()
              }
              res.once('close', finish)
              if (res.writableEnded) finish()
              else res.end(finish)
            }),
        ),
      )
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
        if (global) {
          const event = nativeReplay.publish({
            type: 'refresh',
            instanceId,
            revision: globalRevision,
            discoveryEpoch: discoveryEpoch(),
            directoryEpoch: relayDirectory.epoch(),
          })
          for (const res of streams.keys()) send(res, event)
        }
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
          const signature = JSON.stringify([listSignature(detail.summary), detail.approvals])
          const summaryChanged = summaries.get(sessionId) !== signature
          summaries.set(sessionId, signature)
          const sentAt = hostTime()
          const event = nativeReplay.publish({
            type: 'task-state',
            instanceId,
            revision: globalRevision,
            sessionId,
            detail: { ...detail, sync: { instanceId, revision: globalRevision, hostTime: sentAt } },
            hostTime: sentAt,
          })
          const invalidated = summaryChanged
            ? nativeReplay.publish({ type: 'tasks-invalidated', instanceId, revision: globalRevision, sessionId })
            : undefined
          for (const [res, stream] of streams) {
            if (stream.sessionId === sessionId) send(res, event)
            else if (invalidated) send(res, invalidated)
          }
        }
        for (const [sessionId] of tasks) void promptQueues.changed(sessionId).catch(() => log('排队状态未能更新，请手动检查队列'))
        if (fallback && !global) {
          const event = nativeReplay.publish({
            type: 'refresh',
            instanceId,
            revision: globalRevision,
            discoveryEpoch: discoveryEpoch(),
            directoryEpoch: relayDirectory.epoch(),
          })
          for (const res of streams.keys()) send(res, event)
        }
      } finally {
        flushing = false
        if (pendingGlobal || pendingTasks.size) scheduleEvents()
      }
    }

    function refresh(sessionId?: string): void {
      nativeRoutes.reconcile()
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
        } else write(res, stream, 'heartbeat', stream.nativeOpening ? `id: ${nativeReplay.cursor()}\n: heartbeat\n\n` : ': heartbeat\n\n')
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
          nativeRoutes.opening(req)?.source
          ?? (isSocketTransport(listener.listener)
            ? UNIX_ADDRESS
            : (req.socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, '')),
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
      if (isNativeListener(listener.listener)) {
        const opening = nativeRoutes.opening(req)
        if (!opening || opening.pairing) throw authFailure('unauthorized')
        const result = devices.authenticateNative(opening.deviceId)
        if (!result.ok) throw authFailure(result.code as AuthFailureCode)
        return {
          connection,
          device: result.device,
          credentialHash: result.credentialHash,
          renewAfter: result.renewAfter,
          nativeOpening: opening,
        }
      }
      const presented = presentedCredential(req, listener, hostId8)
      // Without a credential, only host.sock has an identity of its own: the anonymous command line.
      if (isLocalListener(listener.listener) && !hasAuthorization(req)) return { connection }
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

    // ---- Security routes -------------------------------------------------------------------------

    async function handlePublic(
      req: IncomingMessage,
      res: ServerResponse,
      listener: ListenerContext,
      path: string,
      method: string,
    ): Promise<boolean> {
      if (path === '/link/api/health' && method === 'GET') {
        json(res, { ok: true })
        return true
      }
      if (path === '/link/api/host/state') {
        // Only this computer reports sleep, wake and why it is about to stop the Host: the desktop app and the command line.
        if (!isLocalListener(listener.listener)) throw new AppError(404, 'not-found', '接口不存在')
        if (method !== 'POST') throw new AppError(405, 'method-not-allowed', '不支持此操作')
        const event = lifecycle.report(hostStateInputSchema.parse(await jsonBody(req)))
        if (event) {
          for (const stream of [...streams.keys()]) sendHostState(stream, event)
          // Clients resynchronize after a wake; runs the sleep interrupted show as they are now.
          if (event.state === 'awake') refresh()
        }
        json(res, { ok: true })
        return true
      }
      if (path === '/link/api/host-info' && method === 'GET') {
        if (!isLocalListener(listener.listener)) throw new AppError(404, 'not-found', '接口不存在')
        const tasks = (await hub!.listTasks()).map(questionSummary)
        const running = tasks.filter(task => task.status === 'running').length
        const waiting = tasks.filter(task => task.status === 'waiting-approval').length
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
          activeSessions: running + waiting,
          activity: { running, waiting },
          protocol: HOST_PROTOCOL,
        }
        json(res, info)
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
        if (input.hostEgressAllow) {
          const remove = new Set(input.hostEgressAllow.remove ?? [])
          next.hostEgressAllow = [
            ...new Set([...next.hostEgressAllow.filter(entry => !remove.has(entry)), ...(input.hostEgressAllow.add ?? [])]),
          ]
        }
        if (input.confirmedAddresses) {
          const remove = new Set(input.confirmedAddresses.remove)
          next.confirmedAddresses = (next.confirmedAddresses ?? []).filter(origin => !remove.has(origin))
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
        // A change that only adds one outbound address is titled by that address.
        const added = next.hostEgressAllow.filter(entry => !previous.hostEgressAllow.includes(entry))
        const removed = previous.hostEgressAllow.filter(entry => !next.hostEgressAllow.includes(entry))
        const onlyAddress = diff.every(line => line.path === 'hostEgressAllow') && added.length === 1 && removed.length === 0
        const stepup = await confirm(
          req,
          caller,
          'policy.change',
          { baseHash, nextHash: sha256Hex(canonicalJson(next)) },
          policySubject(previous, next),
          diff.map(line => ({ label: line.path, value: `${line.before} → ${line.after}` })),
          [],
          onlyAddress ? added[0] : undefined,
        )
        written = await serial(caller, 'admin', () => policy.update(next, actorOf(caller), stepup, baseHash))
      }
      if (!written.audited) res.setHeader('x-latch-audit', 'failed')
      refresh()
      json(res, { policy: policy.get(), hash: policy.hash() })
    }

    // ---- Tasks -----------------------------------------------------------------------------------

    async function assertSessionAccess(caller: DeviceCaller, sessionId: string): Promise<void> {
      if (isNativeListener(caller.connection.listener) && nativeRoutes.verifiedUntil(caller.nativeOpening) <= now())
        throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
      await checkPrivateSession(caller, sessionId, true)
      await hub!.harnessOf(sessionId)
      if (isNativeListener(caller.connection.listener) && nativeRoutes.verifiedUntil(caller.nativeOpening) <= now())
        throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
    }

    /**
     * A session in the folder made for its request. The folder stays once a session was created in it; a start that
     * created none removes it again while it is empty.
     */
    async function createInOwnFolder(task: HubCreateInput, requestId: string, before?: () => void): Promise<{ sessionId: string }> {
      try {
        await ownFolders.starting(requestId)
        before?.()
        const created = await hub!.createTask(task)
        ownFolders.created(requestId)
        return created
      } catch (error) {
        await ownFolders.release(requestId, error instanceof AppError && error.status >= 400 && error.status < 500 && error.status !== 408)
        throw error
      }
    }

    async function createTask(req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> {
      requireScope(caller, 'run')
      const body = await jsonBody(req, TASK_BODY_LIMIT)
      // An earlier build's phone may still hold a message for an assistant; without the field it would start an ordinary session.
      if (typeof body === 'object' && body !== null && 'assistantId' in body)
        throw new AppError(409, 'assistant-removed', '这条消息是发给已移除的 Agent 的，没有发出。')
      if (typeof body === 'object' && body !== null && 'via' in body) {
        const started = await appRoutes.start(caller, body, start =>
          startSession(caller, { ...createTaskSchema.parse(start), withoutPrivateContext: true }, res),
        )
        json(res, started, 201)
        return
      }
      const input = createTaskSchema.parse(body)
      if (!input.prompt && !input.forkOf && !input.attachmentIds?.length)
        throw new AppError(400, 'invalid-prompt', '请输入任务内容或添加附件。')
      json(res, await startSession(caller, input, res), 201)
    }

    /**
     * Every start of a session, from `POST /tasks` and from a handoff: queues, project checks, worktrees, receipts and
     * the start audits are the same. `privateFrom`: the session carries private material from that session, so it is as
     * private as its source. `res` only marks a missing post-start audit record.
     */
    async function startSession(
      caller: DeviceCaller,
      start: z.infer<typeof createTaskSchema> & { privateFrom?: string; title?: string; withoutPrivateContext?: true },
      res: ServerResponse,
    ): Promise<{ sessionId: string }> {
      // A retry of a start this Host has in flight or accepted gets its original answer, window or not; only new starts
      // are refused (a handoff's start is keyed by its own start request ID). A start that failed is forgotten.
      const startKey = `${caller.device.id}:${start.requestId}`
      if (startRequests.has(startKey)) return startSessionChecked(caller, start, res)
      refuseWhileUpdating('session')
      return tracked(startRequests, startKey, () => startSessionChecked(caller, start, res))
    }

    async function startSessionChecked(
      caller: DeviceCaller,
      start: z.infer<typeof createTaskSchema> & { privateFrom?: string; title?: string; withoutPrivateContext?: true },
      res: ServerResponse,
    ): Promise<{ sessionId: string }> {
      // A plugin page's start carries no private context, as from a device without all data: its reply goes back to the page.
      const { privateFrom, title, withoutPrivateContext, ...requested } = start
      let input = requested
      // A request's folder or worktree is its device's: another device naming the same request ID gets one of its own.
      const folderRequest = `${caller.device.id}:${input.requestId}`
      let made: Worktree | undefined
      let startedIn = false
      recheck(caller, 'run')
      const customAgentId = input.customAgentId
      // A custom Agent's start fixes its project before it queues: the journal keeps one answer per request, so the
      // project's queue is known before entering it. The project itself is checked again inside.
      if (customAgentId) {
        const actor = agentAccess(caller, true)
        const saved = customAgents.get(customAgentId)
        const { harnessId, workspaceId, mode, model } = input
        const start = await customAgents.reserveStart(
          customAgentId,
          input.requestId,
          () =>
            agentPlans.selection(saved, {
              ...(harnessId ? { harnessId } : {}),
              ...(workspaceId ? { workspaceId } : {}),
              ...(mode ? { mode } : {}),
              ...(model ? { model } : {}),
            }),
          actor,
        )
        const { model: startModel, workspaceId: startWorkspace, ...choice } = start
        // Judged on what this start uses, not on defaults it replaced.
        const { defaultProjectId: _project, ...savedRest } = saved
        const reason = agentPlans.unavailable({
          ...savedRest,
          harnessId: start.harnessId,
          ...(startModel ? { model: startModel } : {}),
          ...(startWorkspace ? { defaultProjectId: startWorkspace } : {}),
        })
        if (reason) throw new AppError(409, 'agent-unavailable', reason)
        input = {
          ...input,
          ...choice,
          ...(startModel ? { model: startModel } : {}),
          ...(startWorkspace ? { workspaceId: startWorkspace } : {}),
        }
      }
      // The queue of the project the session starts in; a fork's source session does not choose it.
      return await projectOperation(input.workspaceId ?? 'default', caller, 'run', async () => {
        recheck(caller, 'run')
        const fork = input.forkOf
          ? await (async () => {
              requireScope(caller, 'view')
              checkPrivateSession(caller, input.forkOf!.taskId)
              const detail = await hub!.detail(input.forkOf!.taskId)
              recheck(caller, 'view')
              privateAccess(caller, detail.summary)
              return { ...forkSeed(detail, input.forkOf!.upToMessageId), source: detail.summary }
            })()
          : undefined
        const prompt = fork ? fork.text + (input.prompt || '请接着这个会话继续。') : input.prompt
        const harnessId = input.harnessId ?? defaultHarnessId()
        const agentContext: AgentExecutionContext | undefined =
          (customAgentId
            ? agentPlans.agentContext(customAgentId, harnessId)
            : generalContextFor(withoutPrivateContext ? undefined : devices.get(caller.device.id)?.dataScope, harnessId))
          ?? (fork && privateSession(fork.source)
            ? { instructions: '', revision: sha256Hex(canonicalJson(['fork', fork.source.id])) }
            : undefined)
          ?? (privateFrom ? { instructions: '', revision: sha256Hex(canonicalJson(['handoff', privateFrom])) } : undefined)
        const harness = hub!.info(harnessId)
        if (!harness || !hub!.has(harnessId)) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 未启用`)
        if (harness.status !== 'ready')
          throw new AppError(409, 'harness-unavailable', harness.statusMessage ?? `${harness.capabilities.display.label} 当前不可用`)
        if (input.mode && !harness.modes.includes(input.mode))
          throw new AppError(400, 'mode-unsupported', `${harness.capabilities.display.label} 不支持该会话模式`)
        if (input.model) assertModel(input.model)
        // A harness with its own models takes a service only through the gateway, by the Host's own reckoning of the pair.
        const modelRoute = input.model && harness.capabilities.models.owner !== 'latch' ? modelRouteFor(harness, input.model) : undefined
        if (input.config?.length && (harness.capabilities.models.owner === 'latch' || customAgentId))
          throw new AppError(400, 'config-unsupported', `${harness.capabilities.display.label} 不能在开始前这样设置`)
        const workspaceId = input.workspaceId ?? 'default'
        const chosen = workspaceId === 'default' ? undefined : savedProject(workspaceId)
        if (workspaceId !== 'default' && !chosen) throw new AppError(400, 'workspace-unavailable', '找不到所选项目')
        if (chosen) await assertWorkspaceUsable(chosen)
        const folderCount = chosen?.folders.length ?? 1
        const limit = harness.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
        if (limit !== undefined && folderCount > limit)
          throw new AppError(
            409,
            'harness-folder-limit',
            `${harness.capabilities.display.label} 最多使用 ${limit} 个文件夹，这个项目有 ${folderCount} 个，会话没有开始`,
          )
        // While the start directory is the Host's default, an Agent session outside a saved project gets a new folder of
        // its own there; 只对话 sessions read and write no files and never get one.
        const mode = input.mode ?? (harness.modes.includes('agent') ? 'agent' : harness.modes[0])
        const forkFolder =
          !chosen && fork?.source.workspaceId === 'default' && fork.source.sessionFolder && mode === 'agent' ? fork.source.cwd : undefined
        if (forkFolder && !(await ownFolders.verify(forkFolder))) throw workspaceChanged()
        const ownFolder = makeOwnFolders && !chosen && mode === 'agent' && !forkFolder
        if (input.worktree) {
          if (!chosen) throw new AppError(400, 'worktree-project', '新工作树要从一个项目开始，请先选项目。')
          if (fork) throw new AppError(400, 'worktree-fork', '分叉的会话在原来的项目文件夹里开始，不能新建工作树。')
          if (mode !== 'agent') throw new AppError(400, 'worktree-mode', '只对话的会话不读写文件，不需要工作树。')
          if (chosen.folders.length !== 1)
            throw new AppError(409, 'worktree-project-folders', '这个项目有多个文件夹，新工作树只用于只有一个文件夹的项目。')
        }
        // The session starts in the project's primary folder. Only what the client chose reaches the driver as `cwd`;
        // without a choice the start directory stays the driver's default.
        if (input.fileRefs?.length && (!harness.capabilities.tools.fileMentions || mode === 'chat' || ownFolder))
          throw new AppError(415, 'file-references-unavailable', '当前会话尚不能引用项目文件，请先选择项目与 Agent 模式。')
        if (input.fileRefs?.length && caller.device.dataScope !== 'all') throw new AppError(403, 'file-scope', '此设备不能浏览项目文件。')
        const mentionRoots = chosen
          ? harness.projectFolders?.access === 'all'
            ? chosen.folders
            : [{ id: 'default', path: chosen.folders[0].path }]
          : [{ id: 'default', path: forkFolder ?? workspaceRoot }]
        const fileRefs = await checkedFileMentions(input.fileRefs, mentionRoots, guardedPaths, home)
        recheck(caller, 'run')
        const attachments = await promptAttachments(
          caller,
          input.attachmentIds,
          {
            harnessId,
            workspaceId,
            ...(input.model ? { model: input.model } : {}),
          },
          undefined,
          input.requestId,
        )
        const acceptCreate = async (operation: () => Promise<{ sessionId: string }>) => {
          if (attachments.length) await attachmentStore.claim(caller.device.id, input.attachmentIds!, input.requestId)
          try {
            checkStart()
            return await operation()
          } catch (cause) {
            if (cause instanceof AppError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && attachments.length)
              await attachmentStore.releaseClaim(caller.device.id, input.attachmentIds!, input.requestId)
            throw cause
          }
        }
        const respondCreated = async (created: { sessionId: string }) => {
          if (attachments.length)
            await attachmentStore
              .bind(
                caller.device.id,
                attachments.map(ref => ref.id),
                created.sessionId,
                input.requestId,
              )
              .catch(() => {
                throw new AppError(503, 'attachment-publish-unknown', '会话已开始，附件记录尚未确认。请重试同一次提交。')
              })
          return created
        }
        if (fileRefs.length && devices.get(caller.device.id)?.dataScope !== 'all')
          throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
        let startRefs = fileRefs
        if (input.worktree && chosen) {
          made = await worktrees.create({ source: chosen.folders[0].path, requestId: folderRequest })
          // The session reads them in the worktree, which has the committed files and none of the uncommitted ones.
          if (fileRefs.length)
            startRefs = await checkedFileMentions(
              fileRefs.map(ref => ({ root: 'default', path: ref.path })),
              [{ id: 'default', path: made.path }],
              guardedPaths,
              home,
              '引用的文件不在新工作树里：新工作树只有已提交的文件。请先提交它，或在当前文件夹里开始。',
            )
          recheck(caller, 'run')
        }
        const task: HubCreateInput = {
          prompt,
          ...(fork ? { forkOf: fork.context, initialTitle: input.prompt || `从「${fork.context.title}」分叉` } : {}),
          // A Host-written start (a handoff) names itself; the driver would title it after the first message.
          ...(!fork && title ? { initialTitle: title } : {}),
          // A harness that forks its own record does so only for its own sessions; the text record stays in the prompt
          // for when it cannot.
          ...(fork && harness.capabilities.fork === 'native' && fork.source.harnessId === harnessId
            ? { fork: { taskId: fork.context.taskId, upToMessageId: fork.context.upToMessageId, prefixLength: fork.context.prefixLength } }
            : {}),
          ...(startRefs.length ? { fileRefs: startRefs } : {}),
          ...(attachments.length ? { attachments } : {}),
          requestId: input.requestId,
          ...(agentContext ? { agentContext } : {}),
          harnessId,
          workspaceId,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(modelRoute ? { modelRoute } : {}),
          ...(input.config?.length ? { config: input.config } : {}),
          ...(made
            ? {
                cwd: made.path,
                worktree: { path: made.path, branch: made.branch, ...(made.unfiltered ? { unfiltered: made.unfiltered } : {}) },
              }
            : chosen
              ? { cwd: chosen.folders[0].path }
              : forkFolder
                ? { cwd: forkFolder, sessionFolder: basename(forkFolder) }
                : input.workspaceId === 'default'
                  ? { cwd: workspaceRoot }
                  : {}),
        }
        const checkStart = () => {
          recheck(caller, 'run')
          if (customAgentId) {
            agentAccess(caller, true)
            if (customAgents.definitionHash(customAgentId) !== agentContext?.revision)
              throw new AppError(409, 'agent-changed', '这个 Agent 的设置或记忆已改变，请重新开始。')
          } else if (agentContext) agentAccess(caller, true)
          if (fileRefs.length && devices.get(caller.device.id)?.dataScope !== 'all')
            throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
          if (fork) {
            recheck(caller, 'view')
            privateAccess(caller, fork.source)
          }
        }
        /** The session created in the worktree made for this start owns it from now on. */
        const createInWorktree = async (operation: () => Promise<{ sessionId: string }>) => {
          const created = await operation()
          startedIn = true
          if (made)
            await worktrees
              .bind(made.path, folderRequest, created.sessionId)
              .catch(error =>
                log(`会话 ${created.sessionId} 的工作树标记写入失败：${error instanceof Error ? error.message : String(error)}`),
              )
          return created
        }
        if (hub!.levelOf(harnessId) === 'L1') {
          if (ownFolder) {
            const own = await ownFolders.allocate(folderRequest)
            return await respondCreated(
              await acceptCreate(() => createInOwnFolder({ ...task, cwd: own.path, sessionFolder: own.name }, folderRequest, checkStart)),
            )
          }
          const folders =
            task.cwd === undefined || forkFolder || made ? undefined : chosen ? chosen.folders : [{ id: 'default', path: workspaceRoot }]
          checkStart()
          return await respondCreated(
            await acceptCreate(() =>
              createInWorktree(() => hub!.createTask(folders ? { ...task, folders: folders.map(({ id, path }) => ({ id, path })) } : task)),
            ),
          )
        }
        if (workspaceId === 'default' && defaultFlags.insideData)
          throw new AppError(409, 'workspace-inside-data', '该工作区位于数据目录内，迁出之前只能使用内置 Harness')
        if (workspaceId === 'default' && defaultFlags.codeRoot)
          throw new AppError(409, 'workspace-code-root', '该目录与 Latch 程序目录重叠，不能作为项目')
        const own = ownFolder ? await ownFolders.allocate(folderRequest) : undefined
        // A worktree's project configuration is read there, now that it exists: it is what the session will run with.
        const cwd = await realpath(made?.path ?? own?.path ?? forkFolder ?? chosen?.folders[0].path ?? workspaceRoot)
        // As for L1; the audit below counts the ones the driver says it passes to the agent.
        const folders =
          task.cwd === undefined || own || forkFolder || made
            ? undefined
            : chosen
              ? chosen.folders.map(({ id, path }) => ({ id, path }))
              : [{ id: 'default', path: workspaceRoot }]
        const promptHash = sha256Hex(
          attachments.length || fileRefs.length || agentContext?.brief || agentContext?.skillBodies
            ? canonicalJson({
                prompt,
                // The block goes out with the prompt, so what the record names includes it.
                ...(agentContext?.brief ? { brief: agentContext.brief } : {}),
                ...(agentContext?.skillBodies ? { skills: agentContext.skillBodies } : {}),
                ...(attachments.length ? { attachments: attachments.map(ref => ({ id: ref.id, sha256: ref.sha256 })) } : {}),
                ...(fileRefs.length ? { fileRefs } : {}),
              })
            : prompt,
        )
        const preview = await hub!.launchPreviewOf(harnessId, cwd, folders ? { workspaceId, folders } : undefined, modelRoute)
        // The folders the agent receives besides its working directory, for the audit.
        const passed = [
          ...new Set([
            ...(harness.projectFolders?.access === 'all' ? (folders?.slice(1).map(folder => folder.path) ?? []) : []),
            ...(preview?.folders ?? []),
          ]),
        ]
        const foldersAudited = passed.length ? { folderCount: passed.length + 1 } : {}
        let launchHash: string
        if (preview) launchHash = preview.launchHash
        else {
          const plugin = harnessPlugin(harnessId)
          launchHash = sha256Hex(
            canonicalJson({
              harnessId,
              pluginId: plugin?.id ?? harnessId,
              version: plugin?.version ?? '',
              ...(passed.length ? { folders: passed } : {}),
            }),
          )
        }
        // The session's first row says once what a launch can do, the first time it runs on this Host.
        const firstStart =
          !fork
          && audit.startedBefore({
            launchHash,
            harnessId,
            ...(preview?.definitionHash ? { definitionHash: preview.definitionHash } : {}),
          }) !== 'launch'
        // The intent is on record before the driver can spawn anything; the session id exists only once it has, so the
        // record naming it is a commit that may fail without stopping a session the intent already covers.
        // What the start chose, a wider mode among it, is on record with it; the values are the agent's own words.
        const configAudited = input.config?.length ? { configHash: sha256Hex(canonicalJson(input.config)) } : {}
        // The service its requests go to, by ID, and the route as the launch fingerprint covers it.
        const routeAudited = modelRoute ? { providerId: modelRoute.providerId, routeHash: sha256Hex(canonicalJson(modelRoute)) } : {}
        const intent = await audited({
          action: 'task.l3.start-requested',
          actor: actorOf(caller),
          stepup: 'none',
          detail: { harnessId, launchHash, promptHash, ...foldersAudited, ...configAudited, ...routeAudited },
        })
        let created: { sessionId: string }
        try {
          checkStart()
          created = await acceptCreate(() =>
            own
              ? createInOwnFolder(
                  {
                    ...task,
                    cwd: own.path,
                    sessionFolder: own.name,
                    expectedLaunchHash: launchHash,
                    ...(firstStart ? { firstStart } : {}),
                  },
                  folderRequest,
                  checkStart,
                )
              : createInWorktree(() =>
                  hub!.createTask({
                    ...task,
                    ...(folders ? { folders } : {}),
                    expectedLaunchHash: launchHash,
                    ...(firstStart ? { firstStart } : {}),
                  }),
                ),
          )
        } catch (error) {
          auditFailed(intent, caller)
          throw error
        }
        await audited(
          {
            action: 'task.l3.started',
            actor: actorOf(caller),
            target: created.sessionId,
            stepup: 'none',
            detail: {
              sessionId: created.sessionId,
              harnessId,
              launchHash,
              promptHash,
              ...foldersAudited,
              ...configAudited,
              ...routeAudited,
              ...(preview?.definitionHash ? { definitionHash: preview.definitionHash } : {}),
            },
          },
          res,
        )
        await noteAgentStarted(caller, harnessId)
        return await respondCreated(created)
      }).catch(async (error: unknown) => {
        // A start that definitively did not happen leaves no worktree behind, unless something was already done in it.
        if (made && !startedIn && error instanceof AppError && error.status >= 400 && error.status < 500 && error.status !== 408)
          await worktrees.discard(made, folderRequest).catch(() => false)
        throw error
      })
    }

    /**
     * Every new input to a session, from `POST /tasks/:id/prompt` and from a handoff: access, workspace, private-context,
     * file-reference and attachment checks are the same, and the driver's receipt answers a retry of the same `requestId`.
     */
    async function sendPrompt(
      caller: DeviceCaller,
      id: string,
      input: z.infer<typeof queuedPromptSchema>,
      withoutPrivateContext = false,
    ): Promise<'steered' | 'accepted' | { queued: Awaited<ReturnType<PromptQueues['submit']>> }> {
      // The install window: a retry of a turn this Host has on record gets its original answer; a new plain message, and a
      // queued or steered one on a session that is not running (it would start a turn at once), are refused.
      const turnKey = `${id}:${caller.device.id}:${input.requestId}`
      if (turnRequests.has(turnKey) || promptQueues.knows(id, caller.device.id, input.requestId))
        return sendPromptChecked(caller, id, input, withoutPrivateContext)
      if (updateWindow.isOpen()) {
        if (!(input.queue || input.steer)) refuseWhileUpdating('turn')
        const status = (await hub!.summary(id)).status
        if (status !== 'running' && status !== 'waiting-approval') refuseWhileUpdating('turn')
      }
      return tracked(turnRequests, turnKey, () => sendPromptChecked(caller, id, input, withoutPrivateContext))
    }

    async function sendPromptChecked(
      caller: DeviceCaller,
      id: string,
      input: z.infer<typeof queuedPromptSchema>,
      withoutPrivateContext: boolean,
    ): Promise<'steered' | 'accepted' | { queued: Awaited<ReturnType<PromptQueues['submit']>> }> {
      recheck(caller, 'run')
      await assertSessionAccess(caller, id)
      await assertSessionWorkspace(id)
      if (input.model) {
        const harness = hub!.info(await hub!.harnessOf(id))
        if (harness?.capabilities.models.owner !== 'latch')
          throw new AppError(400, 'model-unsupported', '该会话的 Harness 自行管理模型，不能切换模型服务')
        assertModel(input.model)
      }
      if (!input.prompt && !input.attachmentIds?.length) throw new AppError(400, 'invalid-prompt', '请输入任务内容或添加附件。')
      recheck(caller, 'run')
      checkPrivateSession(caller, id, true)
      assertWritable(id)
      if (input.freshContext && !(await hub!.detail(id)).clearContext)
        throw new AppError(409, 'clear-context-unsupported', '这个会话不能清空上下文。')
      if (input.queue || input.steer) await assertQueueable(id, input.prompt)
      if (input.steer && !input.model && input.prompt) {
        recheck(caller, 'run')
        if ((await hub!.steer(id, input.prompt, input.requestId)) === 'injected') return 'steered'
      }
      if (input.queue || input.steer) return { queued: await promptQueues.submit(queueActor(caller), id, input) }
      const harnessId = await hub!.harnessOf(id),
        agentTurn = turnContext(id, harnessId, withoutPrivateContext ? undefined : devices.get(caller.device.id)?.dataScope),
        attachments = await promptAttachments(
          caller,
          input.attachmentIds,
          { harnessId, ...(input.model ? { model: input.model } : {}) },
          id,
          input.requestId,
        )
      const mentionTask = input.fileRefs?.length ? await hub!.detail(id) : undefined
      if (
        input.fileRefs?.length
        && (caller.device.dataScope !== 'all'
          || !hub!.info(harnessId)?.capabilities.tools.fileMentions
          || mentionTask?.summary.mode === 'chat')
      )
        throw new AppError(403, 'file-references-unavailable', '当前设备或会话不能引用项目文件。')
      const fileRefs = await checkedFileMentions(
        input.fileRefs,
        mentionTask ? scopeFolders(mentionTask.summary, workspaceRoot) : [],
        guardedPaths,
        home,
      )
      recheck(caller, 'run')
      if (fileRefs.length && devices.get(caller.device.id)?.dataScope !== 'all')
        throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
      if (attachments.length) await attachmentStore.claim(caller.device.id, input.attachmentIds!, input.requestId, id)
      try {
        recheck(caller, 'run')
        if (fileRefs.length && devices.get(caller.device.id)?.dataScope !== 'all')
          throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
        if (agentTurn) agentAccess(caller, true)
        await hub!.prompt(id, input.prompt, input.requestId, {
          ...(agentTurn ? { agentContext: agentTurn } : {}),
          ...(fileRefs.length ? { fileRefs } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(input.freshContext ? { freshContext: true as const } : {}),
        })
      } catch (cause) {
        if (cause instanceof AppError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && attachments.length)
          await attachmentStore.releaseClaim(caller.device.id, input.attachmentIds!, input.requestId, id)
        throw cause
      }
      if (attachments.length)
        await attachmentStore
          .bind(
            caller.device.id,
            attachments.map(ref => ref.id),
            id,
          )
          .catch(() => {
            throw new AppError(503, 'attachment-publish-unknown', '会话已开始，附件记录尚未确认。请重试同一次提交。')
          })
      return 'accepted'
    }

    function queueActor(caller: DeviceCaller): QueueActor {
      const native = isNativeListener(caller.connection.listener)
      if (native && nativeRoutes.verifiedUntil(caller.nativeOpening) <= now())
        throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
      return {
        deviceId: caller.device.id,
        listener: caller.connection.listener,
        dataScope: caller.device.dataScope,
        ...(native ? { nativeWindowHash: caller.nativeOpening!.windowHash! } : {}),
      }
    }

    function queueContextChanged(): AppError {
      return new AppError(409, 'queue-context-changed', 'Agent 的设置已改变，请移除此项后重新加入队列。')
    }
    /** 通用's instructions and memories go only to a device that could read them, or its model's reply would carry them there. */
    function generalContextFor(dataScope: 'work' | 'all' | undefined, harnessId: string): AgentExecutionContext | undefined {
      return dataScope === 'all' ? agentPlans.generalContext(harnessId) : undefined
    }
    /** A queued turn of an agent's session runs on the definition it was queued under; 通用 applies as it stands when sent. */
    async function queuedAgentTurn(
      sessionId: string,
      dataScope: 'work' | 'all',
    ): Promise<{ binding?: string; model?: ModelRef; agentContext?: AgentExecutionContext } | undefined> {
      const harnessId = await hub!.harnessOf(sessionId)
      const context = turnContext(sessionId, harnessId, dataScope)
      const owner = hub!.agentOf(sessionId)
      if (!owner) return context ? { agentContext: context } : undefined
      if (hub!.info(harnessId)?.agentContext !== 'private') return undefined
      const session = await hub!.summary(sessionId)
      const model = session.providerId && session.model ? { providerId: session.providerId, model: session.model } : undefined
      if (!context || !model) throw queueContextChanged()
      return { binding: context.revision, model, agentContext: context }
    }
    /** What this turn of a session sends: an engine that got the first-turn block keeps it in its own history. */
    function turnContext(sessionId: string, harnessId: string, dataScope: 'work' | 'all' | undefined): AgentExecutionContext | undefined {
      if (hub!.info(harnessId)?.agentContext !== 'private') return undefined
      const owner = hub!.agentOf(sessionId)
      if (!owner) return generalContextFor(dataScope, harnessId)
      try {
        return agentPlans.agentContext(owner.customAgentId, harnessId)
      } catch (error) {
        if (codeOf(error) === 'agent-not-found') throw new AppError(409, 'agent-deleted', '这个 Agent 已删除，请在新会话中继续。')
        throw error
      }
    }

    async function checkQueuedPrompt(
      actor: QueueActor,
      sessionId: string,
      model?: ModelRef,
      binding?: string,
      preparing = false,
    ): Promise<void> {
      if (closing) throw new AppError(503, 'host-closing', 'Host 正在停止，队列已暂停')
      const native = isNativeListener(actor.listener)
      const authenticated = native ? devices.authenticateNative(actor.deviceId) : undefined
      const device = authenticated?.ok ? authenticated.device : devices.get(actor.deviceId)
      if (
        !device
        || (native ? !authenticated?.ok : !devices.isActive(actor.deviceId) || device.listener !== actor.listener)
        || device.dataScope !== actor.dataScope
      )
        throw authFailure('device-revoked')
      const paused = () => new AppError(409, 'queue-paused', '原手机验证窗口已结束；请移除此项后重新排队')
      const opening: NativeOpening | undefined = native
        ? {
            deviceId: actor.deviceId,
            pairing: false,
            listener: { listener: actor.listener, origin: '' },
            source: '',
            ...(actor.nativeWindowHash ? { windowHash: actor.nativeWindowHash } : {}),
          }
        : undefined
      if (native && nativeRoutes.verifiedUntil(opening) <= now()) throw paused()
      const caller: DeviceCaller = {
        device,
        connection: { listener: actor.listener, origin: '', remoteAddress: '' },
        ...(opening ? { nativeOpening: opening } : {}),
      }
      try {
        requireScope(caller, 'run')
        await assertSessionAccess(caller, sessionId)
        assertWritable(sessionId)
        await assertSessionWorkspace(sessionId)
        const detail = await harnessHub.detail(sessionId)
        if (detail.permission?.drift || detail.summary.permissionDrift) throw new AppError(409, 'permission-drift', '会话权限已变化')
        if (model) {
          if (hub!.info(await hub!.harnessOf(sessionId))?.capabilities.models.owner !== 'latch')
            throw new AppError(400, 'model-unsupported', '该会话不能指定模型服务')
          assertModel(model)
        }
        const turn = await queuedAgentTurn(sessionId, actor.dataScope)
        if (!preparing && turn?.binding !== binding) throw queueContextChanged()
        recheck(caller, 'run')
      } catch (error) {
        if (native && codeOf(error) === 'native-verification-required') throw paused()
        throw error
      }
    }

    /** A command the Harness runs only between turns, such as pi's /compact, is never queued or added to a running turn. */
    async function assertQueueable(sessionId: string, text: string): Promise<void> {
      const named = /^\/(\S+)/u.exec(text)?.[1]
      if (named && (await hub!.detail(sessionId)).commands?.some(command => command.idleOnly && command.name === named))
        throw new AppError(409, 'command-queued', `/${named} 不能排队或追加，请等本轮结束后发送。`)
    }

    async function handleQueue(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      const match = path.match(/^\/link\/api\/tasks\/([^/]+)\/queue\/([^/]+)(\/send)?$/u)
      if (!match) return false
      requireScope(caller, 'run')
      const sessionId = safeDecode(match[1]!),
        itemId = safeDecode(match[2]!)
      if (sessionId.length > 256 || itemId.length > 256) throw new AppError(400, 'invalid-input', '排队标识过长')
      if (method === 'DELETE' && !match[3]) {
        recheck(caller, 'run')
        await audited({ action: 'task.prompt.removed', actor: actorOf(caller), detail: { sessionId, itemId } }, res)
        json(res, await promptQueues.remove(sessionId, itemId, () => recheck(caller, 'run')))
        return true
      }
      const authorize = () => checkQueuedPrompt(queueActor(caller), sessionId, undefined, undefined, true)
      await authorize()
      if (method === 'PATCH' && !match[3]) {
        const input = z.strictObject({ text: z.string().trim().min(1).max(16_000) }).parse(await jsonBody(req, TASK_BODY_LIMIT))
        await assertQueueable(sessionId, input.text)
        await audited({ action: 'task.prompt.edited', actor: actorOf(caller), detail: { sessionId, itemId } })
        await promptQueues.edit(sessionId, itemId, input.text, queueActor(caller), authorize)
        json(res, { edited: true })
        return true
      }
      if (method === 'POST' && match[3]) {
        // 立即发送 starts a turn: not inside the install window, while the item is still waiting to be sent.
        if (updateWindow.isOpen() && promptQueues.view(sessionId).some(item => item.id === itemId)) refuseWhileUpdating('turn')
        await promptQueues.send(sessionId, itemId, authorize)
        json(res, { accepted: true })
        return true
      }
      return false
    }

    async function handleQuestion(
      req: IncomingMessage,
      res: ServerResponse,
      caller: Caller,
      path: string,
      method: string,
    ): Promise<boolean> {
      const match = path.match(/^\/link\/api\/tasks\/([^/]+)\/questions\/([^/]+)\/answer$/u)
      if (!match || method !== 'POST') return false
      requireScope(caller, 'run')
      const sessionId = safeDecode(match[1]!),
        questionId = safeDecode(match[2]!)
      if (sessionId.length > 256 || questionId.length > 256) throw new AppError(400, 'invalid-input', '问答标识过长')
      const authorize = async () => {
        recheck(caller, 'run')
        if (devices.get(caller.device.id)?.dataScope !== caller.device.dataScope) throw scopeRequired('run')
        await assertSessionAccess(caller, sessionId)
        assertWritable(sessionId)
        await assertSessionWorkspace(sessionId)
        const detail = await harnessHub.detail(sessionId)
        if (detail.permission?.drift || detail.summary.permissionDrift) throw new AppError(409, 'permission-drift', '会话权限已变化')
        recheck(caller, 'run')
      }
      await authorize()
      const input = await jsonBody(req, TASK_BODY_LIMIT)
      json(
        res,
        await questions.answer(sessionId, questionId, caller.device.id, input, authorize, async () => {
          try {
            await audited({ action: 'task.question.answered', actor: actorOf(caller), detail: { sessionId, questionId } })
          } catch {
            throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，本次回答尚未接收，请重试')
          }
        }),
      )
      return true
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
        const detail = await decoratedDetail(id)
        recheck(caller, 'view')
        privateAccess(caller, detail.summary)
        traffic.response('detail', json(res, { ...detail, sync: { instanceId, revision: detailRevision } }), id)
        return true
      }
      if (method === 'PATCH' && !action) {
        requireScope(caller, 'run')
        const input = taskPatchSchema.parse(await jsonBody(req))
        recheck(caller, 'run')
        if (input.archived) terminalRoutes.checkSessionEnd(caller, id)
        json(res, { summary: await hub!.updateMeta(id, input) })
        return true
      }
      if (method === 'DELETE' && !action) {
        requireScope(caller, 'run')
        await assertSessionAccess(caller, id)
        terminalRoutes.checkSessionEnd(caller, id)
        await hub!.remove(id)
        await promptQueues.forgetSession(id)
        await questions.forgetSession(id)
        await attachmentStore.removeTask(id).catch(() => log('未能清理已删除会话的附件'))
        summaries.delete(id)
        refresh()
        json(res, { deleted: true })
        return true
      }
      if (method === 'POST' && action === 'prompt') {
        requireScope(caller, 'run')
        const body = await jsonBody(req, TASK_BODY_LIMIT)
        if (typeof body === 'object' && body !== null && 'via' in body) {
          await appRoutes.continueSession(caller, id, body, async input => {
            await sendPrompt(caller, id, queuedPromptSchema.parse(input), true)
          })
          json(res, { accepted: true })
          return true
        }
        const input = queuedPromptSchema.parse(body)
        if ((input.queue || input.steer) && (input.attachmentIds?.length || input.fileRefs?.length))
          throw new AppError(400, 'queue-attachments-unsupported', '附件暂不支持排队，请等本轮结束后发送')
        if (input.freshContext && (input.queue || input.steer))
          throw new AppError(400, 'fresh-context-queued', '清空上下文的消息不能排队或追加，请等本轮结束后发送。')
        const sent = await sendPrompt(caller, id, input)
        if (sent === 'steered') json(res, { steered: true })
        else if (sent === 'accepted') json(res, { accepted: true })
        else json(res, sent.queued, 'queued' in sent.queued ? 202 : 200)
        return true
      }
      if (method === 'POST' && action === 'cancel') {
        requireScope(caller, 'view')
        limits.classC.take(caller.device.id)
        const input = cancelSchema.parse(await optionalJsonBody(req))
        json(res, { accepted: true, receipt: await cancelTask(caller, id, input, res) })
        return true
      }
      if (method === 'POST' && action === 'stop-subagent') {
        // Narrows like a cancel, so it takes what a cancel takes, and an audit failure does not block it.
        requireScope(caller, 'view')
        limits.classC.take(caller.device.id)
        const { subagentId } = stopSubagentSchema.parse(await jsonBody(req))
        const seq = await audited(
          { action: 'task.subagent.stopped', actor: actorOf(caller), target: id, detail: { sessionId: id, subagentId } },
          res,
        )
        let stopped: boolean
        try {
          stopped = await hub!.cancelSubagent(id, subagentId)
        } catch (error) {
          auditFailed(seq, caller)
          throw error
        }
        if (!stopped) {
          auditFailed(seq, caller)
          throw new AppError(409, 'subagent-not-stoppable', '这个子 Agent 已经结束，或它的 Harness 不能单独停止它。')
        }
        json(res, { accepted: true })
        return true
      }
      if (method === 'POST' && action === 'keep-waiting') {
        requireScope(caller, 'view')
        limits.classC.take(caller.device.id)
        json(res, { accepted: true, ...(await hub!.keepWaiting(id, keepWaitingSchema.parse(await jsonBody(req)))) })
        return true
      }
      if (method === 'POST' && action === 'config') {
        requireScope(caller, 'run')
        const input = configSchema.parse(await jsonBody(req)),
          originalWindow = caller.nativeOpening?.windowHash
        let level: 'L1' | 'L3' = 'L3'
        const authority = () => {
          recheck(caller, 'run')
          checkPrivateSession(caller, id, true)
          assertWritable(id)
          if (isNativeListener(caller.connection.listener) && (!originalWindow || caller.nativeOpening?.windowHash !== originalWindow))
            throw new AppError(403, 'native-verification-required', '原手机验证窗口已结束，请查询原请求。')
        }
        const authorize = async () => {
          recheck(caller, 'run')
          await assertSessionAccess(caller, id)
          await assertSessionWorkspace(id)
          authority()
        }
        await authorize()
        // Before the change, and whether or not it lands: a page cannot drive a session whose mode a person touched.
        if (input.configId === 'mode') await hub!.markOriginChanged(id)
        else {
          // A session that cannot be read now is marked too: the driver's own answer to the change comes after this.
          const detail = await hub!.detail(id).catch(() => undefined)
          if (!detail || detail.config?.find(item => item.id === input.configId)?.category === 'mode') await hub!.markOriginChanged(id)
        }
        const execute = async (before: () => Promise<void>) => {
          await authorize()
          const change = await hub!.classifyConfigChange(id, input.configId, input.value)
          if (input.requestId) {
            const current = await hub!.detail(id),
              selectedOption = current.config?.find(row => row.id === input.configId)
            if (!selectedOption) throw new AppError(404, 'config-not-found', '该会话没有这个设置项。')
            if (!selectedOption.options.some(row => row.value === input.value))
              throw new AppError(400, 'config-value-invalid', '设置值不在可选范围内。')
          }
          const apply = async () => {
            await hub!.setConfig(id, input.configId, input.value, { authorize: authority })
            if (input.requestId) {
              authority()
              const actual = await hub!.detail(id)
              authority()
              if (!actual.config?.some(row => row.id === input.configId && row.currentValue === input.value))
                throw new AppError(503, 'config-outcome-unknown', 'Agent 尚未确认采用所选配置，请查询原请求。')
            }
          }
          if (change !== 'wider') {
            await audited({
              action: 'task.config.changed',
              actor: actorOf(caller),
              detail: { sessionId: id, configIdHash: sha256Hex(input.configId), toHash: sha256Hex(input.value) },
            })
            await before()
            authority()
            await apply()
            return
          }
          const seq = await audited({
            action: 'task.mode.widened',
            actor: actorOf(caller),
            target: id,
            stepup: 'none',
            detail: { sessionId: id, toHash: sha256Hex(input.value) },
          })
          try {
            await before()
            authority()
            await apply()
          } catch (error) {
            auditFailed(seq, caller)
            throw error
          }
        }
        if (input.requestId)
          await configRequests.apply(id, { deviceId: caller.device.id, authorize }, { ...input, requestId: input.requestId }, execute)
        else await execute(authorize)
        await authorize()
        json(res, { accepted: true })
        return true
      }
      return false
    }

    // ---- Admin routes ----------------------------------------------------------------------------

    async function handleAdmin(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (path === '/link/api/plugins' && method === 'GET') {
        requireScope(caller, 'admin')
        json(res, { plugins: await pluginList() })
        return true
      }
      const pluginMatch = path.match(/^\/link\/api\/plugins\/([^/]+)$/)
      if (pluginMatch && method === 'POST') {
        requireScope(caller, 'admin')
        const input = z.object({ enabled: z.boolean() }).parse(await jsonBody(req))
        await serial(caller, 'admin', () => setPluginEnabled(caller, safeDecode(pluginMatch[1]!), input.enabled))
        refresh()
        json(res, { plugins: await pluginList() })
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
        if (input.apiKey) requireKeyEntry(caller)
        const plan = await planDestination(input.baseURL, { key: Boolean(input.apiKey), confirm: false })
        const stepup = confirmsDestination(plan)
          ? await confirmDestination(req, caller, plan, {
              baseURL: input.baseURL,
              provider: { id: LEGACY_PROVIDER_ID, name: current?.name ?? 'OpenAI 兼容接口' },
              apiKey: input.apiKey,
            })
          : 'none'
        const scope = keyScopeOf(input.baseURL)
        await serial(caller, 'admin', async () => {
          // This form always replaces the key: saving it without one removes a saved key, a tightening that is recorded.
          if (!input.apiKey && effectiveProvider(LEGACY_PROVIDER_ID)?.apiKey)
            await audited(
              {
                action: 'provider.secret.cleared',
                actor: actorOf(caller),
                target: LEGACY_PROVIDER_ID,
                detail: { providerId: LEGACY_PROVIDER_ID, reason: 'manual' },
              },
              res,
            )
          const keyed = (record: ProviderRecord): ProviderRecord => {
            const { keyOrigin: _origin, keyPath: _path, ...rest } = record
            return {
              ...rest,
              baseURL: input.baseURL,
              apiKey: input.apiKey,
              ...(input.apiKey ? scope : {}),
              defaultModel: input.model,
              models: withModel(record.models, input.model),
            }
          }
          const edited = editProvider(LEGACY_PROVIDER_ID, keyed)
          await saveAt(caller, res, { id: LEGACY_PROVIDER_ID, plan, stepup, ...(input.apiKey ? { scope } : {}) }, () =>
            edited
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
                ),
          )
        })
        refresh()
        json(res, { configured: true })
        return true
      }
      if (path === '/link/api/providers' && method === 'GET') {
        requireScope(caller, 'admin')
        json(res, {
          providers: effectiveProviders().map(providerView),
          presets: PROVIDER_PRESETS,
          // Saving a service at one of these addresses, on one of these origins or at a preset's HTTPS origin needs no
          // confirmation.
          confirmedAddresses: [...(policy.get().confirmedAddresses ?? [])],
          runOrigins: [...processOrigins],
        })
        return true
      }
      if (path === '/link/api/provider-origins' && method === 'POST') {
        // Confirms an address before a service is saved there, so its models can be listed first; still one confirmation.
        requireScope(caller, 'admin')
        requireLocal(caller)
        const input = providerOriginSchema.parse(await jsonBody(req))
        assertBaseURL(input.baseURL)
        recheck(caller, 'admin')
        const plan = await planDestination(input.baseURL, { key: false, confirm: true })
        if (confirmsDestination(plan)) {
          const stepup = await confirmDestination(req, caller, plan, { baseURL: input.baseURL })
          await serial(caller, 'admin', () => addDestination(caller, plan, stepup))
          refresh()
        }
        json(res, {
          origin: plan.origin,
          address: plan.address,
          destination: destinationOf(input.baseURL),
          ...(plan.egress ? { egress: plan.egress } : {}),
        })
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
        if (apiKey) requireKeyEntry(caller)
        const plan = await planDestination(input.baseURL, { key: Boolean(apiKey), confirm: input.confirmOrigin === true })
        const stepup = confirmsDestination(plan)
          ? await confirmDestination(req, caller, plan, {
              baseURL: input.baseURL,
              provider: { id, name: input.name },
              ...(apiKey ? { apiKey } : {}),
            })
          : 'none'
        const scope = apiKey ? keyScopeOf(input.baseURL) : undefined
        const record = await serial(caller, 'admin', async () => {
          if (idTaken(id)) throw new AppError(409, 'provider-exists', `标识 ${id} 已被占用`)
          const next: ProviderRecord = {
            id,
            name: input.name,
            kind: input.kind,
            ...(input.presetId ? { presetId: input.presetId } : {}),
            baseURL: input.baseURL,
            apiKey,
            ...(scope ?? {}),
            enabled: input.enabled ?? true,
            models: withModel(input.models, input.defaultModel),
            ...(input.modelCapabilities ? { modelCapabilities: input.modelCapabilities } : {}),
            defaultModel: input.defaultModel,
          }
          await saveAt(caller, res, { id, plan, stepup, ...(scope ? { scope } : {}) }, () => saveProvider(caller, next))
          return next
        })
        refresh()
        json(res, { provider: providerView(record) }, 201)
        return true
      }
      const providerMatch = path.match(/^\/link\/api\/providers\/([^/]+)(?:\/(models))?$/)
      if (providerMatch) {
        const id = safeDecode(providerMatch[1]!)
        if (method === 'POST' && providerMatch[2] === 'models') {
          requireScope(caller, 'admin')
          const record = effectiveProvider(id)
          if (!record) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
          // A saved provider's own key goes along, so only to a confirmed or preset address.
          json(
            res,
            await remoteModels(
              res,
              { kind: record.kind, baseURL: record.baseURL, apiKey: usableKey(record) },
              false,
              providerFetchFor(record.baseURL),
            ),
          )
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
          if (newKey) requireKeyEntry(caller)
          const confirming = input.confirmOrigin === true
          const plan =
            input.baseURL !== undefined || newKey || confirming
              ? await planDestination(baseURL, { key: Boolean(newKey), confirm: confirming })
              : undefined
          const stepup = confirmsDestination(plan)
            ? await confirmDestination(req, caller, plan, { baseURL, provider: current, ...(newKey ? { apiKey: newKey } : {}) })
            : 'none'
          const record = await serial(caller, 'admin', async () => {
            const before = effectiveProvider(id)
            if (!before) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
            const scope = keyScopeOf(baseURL)
            const bound = keyScopeOf(before.baseURL)
            const hadKey = Boolean(before.apiKey)
            const clearing = input.apiKey === null || input.apiKey === ''
            // A key follows neither a new origin nor a new path; it is removed, as the dialog warned.
            const originChanged = scope.keyOrigin !== (before.keyOrigin ?? bound.keyOrigin)
            const moved = hadKey && !newKey && !clearing && (originChanged || scope.keyPath !== (before.keyPath ?? bound.keyPath))
            if (!newKey && hadKey && (clearing || moved)) {
              await audited(
                {
                  action: 'provider.secret.cleared',
                  actor: actorOf(caller),
                  target: id,
                  detail: { providerId: id, reason: clearing ? 'manual' : originChanged ? 'origin-changed' : 'path-changed' },
                },
                res,
              )
            }
            const edited = editProvider(id, previous => {
              const defaultModel = input.defaultModel ?? previous.defaultModel
              const { keyOrigin: previousOrigin, keyPath: previousPath, ...rest } = previous
              const apiKey = newKey ?? (clearing || moved ? '' : previous.apiKey)
              const kept =
                apiKey && previousOrigin && previousPath !== undefined ? { keyOrigin: previousOrigin, keyPath: previousPath } : undefined
              const binding = newKey ? scope : kept
              return {
                ...rest,
                ...(input.name ? { name: input.name } : {}),
                baseURL,
                apiKey,
                ...(binding ?? {}),
                ...(input.kind ? { kind: input.kind } : {}),
                models: withModel(input.models ?? previous.models, defaultModel),
                modelCapabilities:
                  input.modelCapabilities
                  ?? (input.kind && input.kind !== previous.kind
                    ? withoutThinking(previous.modelCapabilities)
                    : previous.modelCapabilities),
                defaultModel,
                enabled: input.enabled ?? previous.enabled,
              }
            })
            if (!edited) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
            await saveAt(caller, res, { id, ...(plan ? { plan } : {}), stepup, ...(newKey ? { scope } : {}) }, () =>
              saveProvider(caller, ...edited),
            )
            return edited[0]
          })
          refresh()
          json(res, { provider: providerView(record) })
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
        // A typed key goes where it was typed for; a saved key only to its own, confirmed address.
        let fetch: FetchLike = egressFetch
        if (apiKey === undefined && input.providerId) {
          const record = effectiveProvider(input.providerId)
          if (!record) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
          if (record.apiKey) {
            if (!keyBoundTo(record, input.baseURL))
              throw new AppError(409, 'key-origin-mismatch', '已保存的密钥只能发往保存时的地址，请重新输入密钥')
            apiKey = usableKey(record)
            fetch = providerFetchFor(input.baseURL)
          }
        }
        json(res, await remoteModels(res, { kind: input.kind, baseURL: input.baseURL, apiKey: apiKey ?? '' }, true, fetch))
        return true
      }
      if (path === '/link/api/agents' && method === 'GET') {
        requireScope(caller, 'admin')
        // Reading the agent settings is a re-check: the next catalog looks for every command again.
        forgetCommandLookups()
        // Each preset says whether its commands are here, so an agent can be added knowing what is still missing.
        presetLookup = undefined
        const presets: AgentPresetSettings[] = AGENT_PRESETS.map(preset => ({
          ...preset,
          detected: (options.detectPreset ?? detectPresetCommands)(preset),
        }))
        json(res, { agents: config.settings().agents.map(agentSettings), presets })
        return true
      }
      if (path === '/link/api/agents' && method === 'POST') {
        requireScope(caller, 'admin')
        const input = agentCreateSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        recheck(caller, 'admin')
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
          startedHash: null,
        }
        const hash = checkAgent(next)
        const record = await serial(caller, 'admin', async () => {
          if (config.settings().agents.some(agent => agent.id === id)) throw new AppError(409, 'agent-exists', `标识 ${id} 已被占用`)
          const seq = await audited({
            action: 'agent.defined',
            actor: actorOf(caller),
            target: id,
            stepup: 'none',
            detail: { agentId: id, definitionHash: hash, created: true },
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
      const probeMatch = path.match(/^\/link\/api\/agents\/([^/]+)\/probe$/)
      if (probeMatch && method === 'POST') {
        requireScope(caller, 'admin')
        requireScope(caller, 'run')
        const input = z
          .object({ requestId: z.string().min(1).max(256) })
          .strict()
          .parse(await jsonBody(req))
        recheck(caller, 'admin')
        const id = safeDecode(probeMatch[1]!)
        const agent = config.settings().agents.find(agent => agent.id === id)
        if (!agent) throw new AppError(404, 'agent-not-found', '找不到该 Agent')
        const hash = definitionHash(agent)
        const attempt = await agentProbes.prepare({ agent, definitionHash: hash, deviceId: caller.device!.id, requestId: input.requestId })
        const assertCurrent = () => {
          if (closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
          recheck(caller, 'admin')
          recheck(caller, 'run')
          const latest = config.settings().agents.find(agent => agent.id === id)
          if (!latest || definitionHash(latest) !== hash)
            throw new AppError(409, 'agent-definition-changed', 'Agent 定义已变化，请重新测试。')
        }
        if (attempt.flight) {
          const result = await attempt.flight
          assertCurrent()
          json(res, result)
          return true
        }
        const preview = attempt.preview
        const result = await agentProbes.run(
          attempt,
          async () => {
            assertCurrent()
            await audited({
              action: 'agent.probe.requested',
              actor: actorOf(caller),
              target: id,
              stepup: 'none',
              detail: { agentId: id, launchHash: preview.launchHash },
            })
          },
          async result => {
            assertCurrent()
            await audited({
              action: 'agent.probed',
              actor: actorOf(caller),
              target: id,
              stepup: 'none',
              detail: { agentId: id, launchHash: result.launchHash, status: result.status },
            })
            await writeSettings(caller, draft => {
              const latest = draft.agents.find(agent => agent.id === id)
              if (latest && definitionHash(latest) === hash) {
                latest.lastProbe = result
                latest.probedDefinitionHash = hash
              }
            })
            if (result.login) agentLoginRoutes.probed(id, result.login)
            refresh()
          },
        )
        json(res, result)
        return true
      }
      // What a Harness offers, read before a session: the same gate as starting one, since it starts the same program.
      const catalogueMatch = path.match(/^\/link\/api\/agents\/([^/]+)\/catalogue$/)
      if (catalogueMatch && method === 'POST') {
        requireScope(caller, 'run')
        const input = z
          .object({ auto: z.boolean().optional() })
          .strict()
          .parse(await jsonBody(req))
        recheck(caller, 'run')
        const id = safeDecode(catalogueMatch[1]!)
        const harness = editableHarness(id)
        const auto = input.auto === true
        const { ran } = await hub!.readHarnessCatalogue(id, auto, async () => {
          if (closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
          recheck(caller, 'run')
          await audited({
            action: 'agent.catalogue.requested',
            actor: actorOf(caller),
            target: id,
            stepup: 'none',
            detail: { agentId: id, auto },
          })
        })
        const read = hub!.info(id)?.catalogueRead
        if (ran)
          await audited({
            action: 'agent.catalogue.read',
            actor: actorOf(caller),
            target: id,
            stepup: 'none',
            detail: { agentId: id, ok: read?.last?.ok === true },
          })
        json(res, { ran, ...(read ? { catalogueRead: read } : {}), harness: harness.id })
        return true
      }
      const modelsMatch = path.match(/^\/link\/api\/agents\/([^/]+)\/models$/)
      if (modelsMatch && method === 'PUT') {
        requireScope(caller, 'run')
        const input = z
          .object({ models: z.array(z.string().max(1024)).max(64) })
          .strict()
          .parse(await jsonBody(req))
        recheck(caller, 'run')
        const id = safeDecode(modelsMatch[1]!)
        editableHarness(id)
        await hub!.setHarnessModels(id, input.models)
        const count = hub!.info(id)?.customModels?.length ?? 0
        await audited({
          action: 'agent.models.changed',
          actor: actorOf(caller),
          target: id,
          stepup: 'none',
          detail: { agentId: id, count },
        })
        json(res, { models: hub!.info(id)?.customModels ?? [] })
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
        if (changed) {
          next.startedHash = null
          delete next.lastProbe
          delete next.probedDefinitionHash
        }
        const hash = changed ? checkAgent(next) : undefined
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
                stepup: 'none',
                detail: { agentId: id, definitionHash: hash, created: false },
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
      if (path === '/link/api/host/update-window' || path === '/link/api/host/update-window/commit') {
        // Only the desktop app on this Mac, over host.sock: its main process asks and holds the window, never its page
        // (the shell's proxy refuses this path for the renderer) and never another device.
        requireScope(caller, 'run')
        requireDesktop(caller)
        const busy = async () => {
          const tasks = await hub!.listTasks()
          return {
            running: tasks.filter(task => task.status === 'running').length,
            waiting: tasks.filter(task => task.status === 'waiting-approval').length,
            unknown: configRequests.pending() + startRequests.inFlight() + turnRequests.inFlight() + deliveries.running,
            queued: promptQueues.pending(),
            ...terminals.activity(),
          }
        }
        const blocking = (counts: Awaited<ReturnType<typeof busy>>) =>
          counts.running + counts.waiting + counts.unknown + counts.queued + counts.terminals
        // A window the desktop app stopped renewing (or a commit it did not follow up) ends here, plugin plan and all.
        await expireCommit()
        if (path.endsWith('/commit')) {
          if (method !== 'POST') throw new AppError(405, 'method-not-allowed', '不支持此操作')
          if (!updateWindow.isOpen()) throw new AppError(409, 'update-window-closed', '安装窗口已关闭，请重新开始安装。')
          // One step: nothing busy now, and from here on nothing new starts until this Host exits.
          const counts = await busy()
          if (blocking(counts) > 0) throw new AppError(409, 'host-busy', '还有会话或终端在工作，暂不能安装。')
          updateWindow.assertHolder(caller.device.id)
          updateWindow.commit()
          terminals.setHeld(true)
          // A desktop app that quit or crashed before stopping this Host does not keep starts shut: after the commit's
          // two minutes the window ends, starts and terminals are open again, and the plugin plan is dropped.
          clearTimeout(commitTimer)
          commitTimer = setTimeout(() => void expireCommit(), UPDATE_COMMIT_TTL_MS + 50)
          commitTimer.unref()
          await audited({ action: 'host.update-window', actor: actorOf(caller), detail: { state: 'committed', busy: 0 } }, res)
          json(res, { committed: true })
          return true
        }
        if (method !== 'GET' && method !== 'POST') throw new AppError(405, 'method-not-allowed', '不支持此操作')
        if (method === 'POST') {
          const input = updateWindowInputSchema.parse(await jsonBody(req))
          const total = blocking(await busy())
          if (input.open) {
            if (input.pluginFormats && !input.version) throw new AppError(400, 'invalid-input', '插件计划需要目标版本。')
            // Refusing starts takes nothing from anyone; an audit failure does not hold it up.
            const step = updateWindow.open(caller.device.id)
            if (input.pluginFormats && input.version)
              await heldPlugins.plan(input.pluginFormats, input.version, updateWindow.endsAt ?? now())
            if (step === 'entered')
              await audited(
                {
                  action: 'host.update-window',
                  actor: actorOf(caller),
                  detail: { state: 'entered', busy: total, ...(input.pluginFormats ? { planned: true } : {}) },
                },
                res,
              )
          } else {
            updateWindow.assertHolder(caller.device.id)
            const was = updateWindow.close()
            clearTimeout(commitTimer)
            terminals.setHeld(false)
            if (input.reason !== 'installing') await heldPlugins.unplan()
            if (was)
              await audited(
                { action: 'host.update-window', actor: actorOf(caller), detail: { state: 'left', reason: input.reason, busy: total } },
                res,
              )
          }
        }
        json(res, {
          window: updateWindow.view(),
          version: LATCH_VERSION,
          protocol: HOST_PROTOCOL,
          pluginFormats: PLUGIN_PACKAGE_FORMATS,
          busy: await busy(),
          plugins: pluginAssets.list().flatMap(record =>
            record.appliedBundle
              ? [
                  {
                    id: record.id,
                    name: record.appliedBundle.manifest.name,
                    formatVersion: record.appliedBundle.manifest.formatVersion,
                    enabled: record.enabled,
                  },
                ]
              : [],
          ),
          held: heldPlugins.list().flatMap(id => {
            const record = pluginAssets.list().find(item => item.id === id)
            return record ? [{ id, name: record.appliedBundle?.manifest.name ?? record.bundle.manifest.name }] : []
          }),
        })
        return true
      }
      if (path === '/link/api/folder-grants' && method === 'POST') {
        requireScope(caller, 'admin')
        requireDesktop(caller)
        const grant = devices.folderGrant(caller.device.id, caller.credentialHash)
        json(res, { nonce: grant.nonce, expiresAt: new Date(grant.expiresAt).toISOString() })
        return true
      }
      if (path === '/link/api/workspaces' && method === 'POST') {
        requireScope(caller, 'admin')
        requireDesktop(caller)
        const signed = await signedFolderBody(req, caller)
        let result: { workspace: WorkspaceInfo; refused: FolderRefusal[] }
        if (signed.via === 'session') {
          const input = sessionProjectSchema.parse(signed)
          // The folder it saves is a session's own folder in the start directory, so it waits for starts there.
          result = await projectOperation('default', caller, 'admin', () =>
            serial(caller, 'admin', () => saveSessionProject(caller, input)),
          )
        } else {
          const input = projectCreateSchema.parse(signed)
          // A new project has no sessions and no ID yet: no start can be in it, so it waits only for other changes.
          result = await serial(caller, 'admin', () => createProject(caller, input))
        }
        refresh()
        json(res, result, 201)
        return true
      }
      const foldersMatch = path.match(/^\/link\/api\/workspaces\/([^/]+)\/folders$/)
      if (foldersMatch && method === 'POST') {
        requireScope(caller, 'admin')
        requireDesktop(caller)
        const id = safeDecode(foldersMatch[1]!)
        const input = folderAddSchema.parse(await signedFolderBody(req, caller))
        const result = await projectOperation(id, caller, 'admin', () => serial(caller, 'admin', () => addFolders(caller, id, input)))
        refresh()
        json(res, result)
        return true
      }
      const folderMatch = path.match(/^\/link\/api\/workspaces\/([^/]+)\/folders\/([^/]+)$/)
      if (folderMatch && method === 'DELETE') {
        requireScope(caller, 'admin')
        const id = safeDecode(folderMatch[1]!)
        const folderId = safeDecode(folderMatch[2]!)
        const workspace = await projectOperation(id, caller, 'admin', () =>
          serial(caller, 'admin', () => removeFolder(caller, id, folderId, res)),
        )
        refresh()
        json(res, { workspace })
        return true
      }
      const workspaceMatch = path.match(/^\/link\/api\/workspaces\/([^/]+)$/)
      if (workspaceMatch && method === 'PATCH') {
        requireScope(caller, 'admin')
        const id = safeDecode(workspaceMatch[1]!)
        const input = projectPatchSchema.parse(await jsonBody(req))
        const workspace = await projectOperation(id, caller, 'admin', () => serial(caller, 'admin', () => patchProject(caller, id, input)))
        refresh()
        json(res, { workspace })
        return true
      }
      if (workspaceMatch && method === 'DELETE') {
        requireScope(caller, 'admin')
        const id = safeDecode(workspaceMatch[1]!)
        await projectOperation(id, caller, 'admin', () => serial(caller, 'admin', () => removeWorkspace(caller, id, res)))
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

    /** Checks a definition before it is saved, and returns its hash for the audit. Values of its variables are never returned. */
    function checkAgent(next: AgentRecord): string {
      const verdict = validateAgentDefinition(next)
      if (!verdict.ok) throw verdict.error
      buildAgent(next)
      return definitionHash(next)
    }

    /** Records that a full-access session started with the agent's current definition; the start never waits on it. */
    async function noteAgentStarted(caller: Caller, agentId: string): Promise<void> {
      const agent = config.settings().agents.find(item => item.id === agentId)
      if (!agent || agent.startedHash === undefined) return
      const hash = definitionHash(agent)
      if (agent.startedHash === hash) return
      await writeSettings(
        caller,
        draft => {
          const entry = draft.agents.find(item => item.id === agentId)
          // Only the definition that just started: one edited meanwhile stays not started.
          if (entry && definitionHash(entry) === hash) entry.startedHash = hash
        },
        'run',
      ).catch(error => log(`无法记录 Agent ${agentId} 已启动：${errorText(error)}`))
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
      const nativeOpening = nativeRoutes.opening(req)
      const request: RouteRequest = { req, res, listener, connection, opening: nativeOpening, path, method }
      if (await routes.screen(request)) return
      if (await handlePublic(req, res, listener, path, method)) return
      if (await routes.unauthenticated(request)) return
      const caller = await authenticate(req, listener, connection)
      const authenticated: CallerRequest = { ...request, caller }
      if (await routes.authenticated(authenticated)) return
      if (!caller.device) {
        const route = `${method} ${path.replace(/^\/link\/api\/devices\/[^/]+$/u, '/link/api/devices/:id')}`
        if (!ANONYMOUS_UNIX.has(route) || path === '/link/api/devices/current') throw authFailure('unauthorized')
      }
      const privateTaskId = /^\/link\/api\/tasks\/([^/]+)/u.exec(path)?.[1]
      if (privateTaskId && !path.endsWith('/cancel')) {
        const taskId = safeDecode(privateTaskId)
        if (hub!.agentPrivate(taskId)) agentAccess(caller)
      }
      if (await routes.route(authenticated)) return
      if (path === '/link/api/snapshot' && method === 'GET') {
        requireScope(caller, 'view')
        const snapshotRevision = revision
        const defaultId = defaultHarnessId()
        const providerId = defaultProviderId()
        // Only Standard requires a provider from this app's registry; other drivers own their backend.
        const execution: NonNullable<AppSnapshot['execution']> =
          defaultId === STANDARD
            ? {
                ready: usableProviders().some(provider => provider.id === providerId),
                providerId,
                modelConfigurationRequired: providerId === LEGACY_PROVIDER_ID && !effectiveProvider(LEGACY_PROVIDER_ID),
              }
            : { ready: true }
        const tasks = (await hub!.listTasks()).filter(task => privateVisible(caller, task)).map(questionSummary)
        const snapshot: AppSnapshot = {
          instanceId,
          revision: snapshotRevision,
          device: currentDevice(caller),
          host: await hostView(),
          tasks,
          approvals: nativeOpening
            ? []
            : await decorateAll(
                hub!.approvals().filter(approval => tasks.some(task => task.id === approval.sessionId)),
                tasks,
              ),
          demo: options.demo,
          hostName: options.hostName ?? hostname(),
          harness: { id: defaultId, name: hub!.info(defaultId)?.capabilities.display.label ?? defaultId },
          execution,
          catalog: await catalog(caller),
          ...agentSummaries(caller, tasks),
          version: LATCH_VERSION,
          hostTime: hostTime(),
        }
        recheck(caller, 'view')
        snapshot.tasks = snapshot.tasks.filter(task => privateVisible(caller, task))
        snapshot.approvals = snapshot.approvals.filter(approval => snapshot.tasks.some(task => task.id === approval.sessionId))
        const handoffSummaries = handoffs.summaries(new Set(snapshot.tasks.map(task => task.id)))
        if (handoffSummaries?.length) snapshot.handoffs = handoffSummaries
        const appSummaries = await appRoutes.summaries()
        if (appSummaries.length) snapshot.apps = appSummaries
        traffic.response('snapshot', json(res, snapshot))
        return
      }
      if (path === '/link/api/events' && method === 'GET') {
        requireScope(caller, 'view')
        const query = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
        const sessionId = query.get('sessionId') ?? undefined
        if (sessionId && sessionId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
        if (nativeOpening && sessionId) {
          const summary = await hub!.summary(sessionId)
          privateAccess(caller, summary)
          recheck(caller, 'view')
        }
        let resume: ReturnType<NativeReplay['resume']> | undefined
        if (nativeOpening && (query.has('resumeEpoch') || query.has('resumeAfter'))) {
          if (
            [...query.keys()].some(key => !['sessionId', 'resumeEpoch', 'resumeAfter'].includes(key))
            || [...new Set(query.keys())].some(key => query.getAll(key).length !== 1)
          )
            throw new AppError(400, 'invalid-resume', '恢复位置无效')
          const epoch = query.get('resumeEpoch'),
            after = query.get('resumeAfter')
          if (
            !epoch
            || epoch.length > 128
            || !/^[A-Za-z0-9_-]+$/u.test(epoch)
            || !after
            || !/^(?:0|[1-9][0-9]{0,15})$/u.test(after)
            || !Number.isSafeInteger(Number(after))
          )
            throw new AppError(400, 'invalid-resume', '恢复位置无效')
          resume = nativeReplay.resume(epoch, Number(after), sessionId)
        }
        if (!caller.credentialHash) throw authFailure('unauthorized')
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store, no-transform',
          ...(!isNativeListener(listener.listener) ? { connection: 'keep-alive' } : {}),
          'x-accel-buffering': 'no',
        })
        const meter = traffic.stream(caller.connection.listener)
        streams.set(res, {
          deviceId: caller.device.id,
          credentialHash: caller.credentialHash,
          ...(nativeOpening ? { nativeOpening } : {}),
          ...(sessionId ? { sessionId } : {}),
          lastSentRevision: nativeOpening && resume?.kind === 'events' ? 0 : revision,
          meter,
        })
        if (resume?.kind === 'events') {
          for (const event of resume.events) send(res, event)
          const stream = streams.get(res)
          if (stream && streamAllowed(stream)) write(res, stream, 'heartbeat', `id: ${nativeReplay.cursor()}\n: resumed\n\n`)
        } else
          send(res, { type: 'refresh', instanceId, revision, discoveryEpoch: discoveryEpoch(), directoryEpoch: relayDirectory.epoch() })
        req.on('close', () => {
          streams.delete(res)
          traffic.close(meter)
        })
        return
      }
      if (path === '/link/api/traffic' && method === 'GET') {
        // Counts and opaque session IDs only, for the owner: an admin device or the command line on host.sock.
        if (caller.device) requireScope(caller, 'admin')
        json(res, traffic.summary())
        return
      }
      if (path === '/link/api/tasks' && method === 'POST') {
        requireScope(caller, 'run')
        await createTask(req, res, caller)
        return
      }
      if (await handleQueue(req, res, caller, path, method)) return
      if (await handleQuestion(req, res, caller, path, method)) return
      if (await sessionRoutes.handle(req, res, caller, path, method)) return
      if (await attachmentRoutes.handle(req, res, caller, path, method)) return
      if (await fileRoutes.handle(req, res, caller, path, method)) return
      if (await pluginPackageRoutes.handle(req, res, caller, path, method)) return
      const clientPanel = path.match(/^\/link\/api\/ui-modules\/([^/]+)\/([a-f0-9]{64})\.mjs$/u)
      if (clientPanel && method === 'GET') {
        requireScope(caller, 'view')
        const panelId = safeDecode(clientPanel[1]!)
        if (panelId.length > 256) throw new AppError(400, 'invalid-input', '面板标识过长。')
        const lease = registry.acquireClientPanel(panelId, clientPanel[2]!)
        try {
          recheck(caller, 'view')
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin',
          })
          res.end(lease.source)
        } finally {
          lease.release()
        }
        return
      }
      const panelRoute = path.match(/^\/link\/api\/tasks\/([^/]+)\/ui-panels\/([^/]+)$/u)
      if (panelRoute && method === 'GET') {
        requireScope(caller, 'view')
        const sessionId = safeDecode(panelRoute[1]!)
        const panelId = safeDecode(panelRoute[2]!)
        if (sessionId.length > 256 || panelId.length > 256) throw new AppError(400, 'invalid-input', '会话或面板标识过长。')
        const controller = new AbortController()
        const abort = () => {
          controller.abort()
        }
        const lease = registry.acquireUiPanel(panelId)
        try {
          res.once('close', abort)
          const { summary } = await hub!.detail(sessionId)
          recheck(caller, 'view')
          if (
            (summary.personal && !summary.pluginIds?.includes(lease.info.pluginId))
            || (summary.agent && summary.pluginIds && !summary.pluginIds.includes(lease.info.pluginId))
          )
            throw new AppError(404, 'ui-panel-unavailable', '这个 Agent 没有选择此插件。')
          if (lease.info.harnessIds !== undefined && !lease.info.harnessIds.includes(summary.harnessId)) {
            throw new AppError(404, 'ui-panel-unavailable', '这个扩展面板不适用于当前会话。')
          }
          const panel = await lease.render({ session: summary, signal: controller.signal })
          recheck(caller, 'view')
          json(res, { panel })
        } finally {
          res.removeListener('close', abort)
          lease.release()
        }
        return
      }
      const configRequest = /^\/link\/api\/tasks\/([^/]+)\/config-requests\/([A-Za-z0-9_-]{8,128})$/u.exec(path)
      if (configRequest && method === 'GET') {
        requireScope(caller, 'view')
        const id = safeDecode(configRequest[1]!)
        if (id.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长。')
        checkPrivateSession(caller, id)
        await hub!.harnessOf(id)
        recheck(caller, 'view')
        checkPrivateSession(caller, id)
        json(res, { state: configRequests.state(id, caller.device.id, configRequest[2]!) })
        return
      }
      const task = path.match(/^\/link\/api\/tasks\/([^/]+)(?:\/(prompt|cancel|keep-waiting|config|stop-subagent))?$/)
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
        json(res, { workspaces: await projectInfos() })
        return
      }
      const worktreeMatch = path.match(/^\/link\/api\/workspaces\/([^/]+)\/worktree$/)
      if (worktreeMatch && method === 'GET') {
        requireScope(caller, 'run')
        const record = requireProject(safeDecode(worktreeMatch[1]!))
        if (record.folders.length !== 1)
          throw new AppError(409, 'worktree-project-folders', '这个项目有多个文件夹，新工作树只用于只有一个文件夹的项目。')
        json(res, await worktrees.base(record.folders[0].path))
        return
      }
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
      if (isSocketTransport(listener.listener)) return true
      if (isNativeListener(listener.listener)) {
        if (
          !nativeRoutes.opening(req)
          || req.headers.origin
          || req.headers.cookie
          || req.headers.authorization
          || !path.startsWith('/link/api/')
        )
          throw new AppError(403, 'invalid-native-context', '原生请求上下文无效')
        return true
      }
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

    async function serveStatic(
      req: IncomingMessage,
      res: ServerResponse,
      path: string,
      method: string,
      listener: ListenerContext,
    ): Promise<void> {
      if (method !== 'GET' && method !== 'HEAD') throw new AppError(405, 'method-not-allowed', '不支持此操作')
      if (path === '/' || path === '/link') {
        res.writeHead(302, { location: '/link/' })
        res.end()
        return
      }
      // A navigation to an address that is no page (a file name in a reply opened as a link) gets a page, not JSON.
      if (!path.startsWith('/link/')) return sendNotFoundPage(res, method)
      const relativePath = safeDecode(path.slice('/link/'.length)) || 'index.html'
      if (relativePath.startsWith('preview-frame/')) {
        const match = /^preview-frame\/(office|diagram|html|html-script)\.html$/u.exec(relativePath)
        if (!match) throw new AppError(404, 'not-found', '页面不存在')
        if (!isLocalListener(listener.listener) && (match[1] === 'html-script' || req.headers['sec-fetch-dest'] !== 'iframe'))
          throw new AppError(403, 'preview-refused', '请在文档预览中打开这个文件')
        const frame = await readPreviewFrame(resolve(options.uiDir), match[1]!)
        res.removeHeader('x-frame-options')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': frame.csp,
          'x-latch-frame-hash': frame.hash,
          'cache-control': 'no-store',
        })
        res.end(method === 'HEAD' ? undefined : frame.data)
        return
      }
      const root = resolve(options.uiDir)
      const file = resolve(root, relativePath)
      if (!file.startsWith(root + sep)) throw new AppError(403, 'invalid-path', '文件路径无效')
      let data: Buffer
      try {
        if (!(await stat(file)).isFile()) return sendNotFoundPage(res, method)
        data = await readFile(file)
      } catch (error) {
        if (codeOf(error) === 'ENOENT' || codeOf(error) === 'EISDIR' || codeOf(error) === 'ENOTDIR') return sendNotFoundPage(res, method)
        throw error
      }
      res.setHeader('content-security-policy', /\.worker(?:\.min)?-[A-Za-z0-9_-]+\.m?js$/u.test(relativePath) ? WORKER_CSP : UI_CSP)
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
      await serveStatic(req, res, path, method, listener)
    }

    function fail(res: ServerResponse, error: unknown, listener: ListenerContext): void {
      let failure = error
      // Only requests without a usable credential are throttled, per listener class: answers about a known device's
      // credential (renewal-required, revoked, expired) keep their code, so a flood elsewhere cannot hide them.
      if (failure instanceof AppError && failure.status === 401 && failure.code === 'unauthorized' && !isLocalListener(listener.listener)) {
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
      ...(tls && options.tls ? { tls, reloadTls: () => loadTls(options.tls!) } : {}),
      log,
      now,
      handler: (req, res, listener) => {
        void handle(req, res, listener).catch(error => fail(res, error, listener))
      },
    })
    await nativeRoutes.start({ handle, fail, cleanup: dispose => startupCleanup.push(dispose) })
    const started = listeners
    startupCleanup.push(() => started.close())
    loopbackOrigin = started.loopbackOrigin
    tlsOrigin = started.tlsOrigin
    const nativePort = nativeRoutes.port()
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
    starting = false

    await writeProjectContext(dataDir, {
      workspaceRoot: realWorkspace,
      agentsDir,
      codeRoot: resolve(codeRoot),
      ...(tlsKeyPath ? { tlsKeyPath } : {}),
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
      ...(nativePort !== undefined ? { nativePort } : {}),
      socketPath: runtime.socketPath,
      runtimeDir: runtime.runtimeDir,
      startedAt,
      bridge: harnessHub,
      registry,
      config,
      security: { devices, enrollments, presence, audit, policy },
      lifecycle: lifecycleListeners,
      close() {
        return (shutdown ??= (async () => {
          closing = true
          // First, while the engines still answer: a check made against a closing Host would pause on its way out.
          await automations.close()
          await handoffs.close()
          await sessionLifecycle.hostStopping()
          await nativeRoutes.close()
          clearInterval(heartbeat)
          clearTimeout(eventTimer)
          unsubscribe()
          await endStreams(lifecycle.stopping())
          const failures: unknown[] = []
          for (const dispose of [
            () => changes,
            () => configRequests.close(),
            () => promptQueues.close(),
            () => agentProbes.close(),
            () => harnessHub.close(),
            () => modelGateway.close(),
            () => questions.close(),
            () => customAgents.close(),
            () => fileTracking.close(),
            () => fileRoutes.close(),
            () => pluginAssets.close(),
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
            () => discoveryRotation?.catch(() => {}) ?? Promise.resolve(),
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
