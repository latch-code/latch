import { ConfigRequests, notSentConfig, type ConfigBegin } from './config-requests.ts'
import {
  HeldPlugins,
  HOST_PROTOCOL,
  PLUGIN_PACKAGE_FORMATS,
  RequestRecords,
  TurnReceipts,
  UPDATE_COMMIT_TTL_MS,
  UpdateWindow,
  updateWindowInputSchema,
} from './update-window.ts'
import { CustomAgents, harnessFixed, rememberRequest, type AgentActor, type FirstChatStart } from './custom-agents.ts'
import { Automations, automationSummary, type AutomationStartInput } from './automations.ts'
import { Handoffs } from './handoffs.ts'
import { HistoryImports, HistoryReceipts } from './history-import.ts'
import { ReviewNotes } from './review-notes.ts'
import { AgentPlans, canPropose } from './agent-plans.ts'
import { workProposalInputSchema } from './routes/work-proposals.ts'
import { agentDigest } from './agent-digest.ts'
import { resultContent } from './agent-activity.ts'
import { agentPluginRevision } from './agent-revisions.ts'
import { executionBuildRevision } from './execution-build.ts'
import {
  GENERAL_AGENT_ID,
  BOARD_SETTLE_CHARS,
  normalizeBoardTags,
  isMcpToolOn,
  onModelChoice,
  parseModelChoice,
  refusedBeforeAccepting,
  type AgentExecutionContext,
  type AgentNote,
  type AutomationConfig,
  type ModelChoice,
} from '@latch/protocol'
import { readPreviewFrame, WORKER_CSP } from './preview-frames.ts'
import { readAppFrame } from './app-frame.ts'
import { readUiBuild } from './ui-build.ts'
import { PromptQueues, type QueueActor } from './prompt-queues.ts'
import { Questions } from './questions.ts'
import { createQuestionsPlugin } from './plugins/tools/questions/index.ts'
import { forkSeed } from './forks.ts'
import { createFileTrackingService } from './files/output-tracker.ts'
import { checkedFileMentions, fileMentionsSchema } from './file-mentions.ts'
import { AttachmentStore, ATTACHMENT_FILE_LIMIT, ATTACHMENT_IMAGE_LIMIT, ATTACHMENT_REMOTE_LIMIT } from './attachments.ts'
import { createAttachmentRoutes, assertAttachmentCapability } from './attachment-routes.ts'
import { AttachmentUploads } from './attachment-uploads.ts'
import type { AttachmentSelection, AttachmentCapabilities, AttachmentRef } from '@latch/protocol'
import type { LatchWorktree, WorktreeBase, WorktreeInventory, WorktreeRemoval } from '@latch/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
export { loadPluginPackage } from './plugin-packages.ts'
import { existsSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, chmod, open as openFile, readFile, readdir, realpath, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  AGENT_PRESETS,
  BUILTIN_HELPER_CARD,
  type AgentPreset,
  pairRoute,
  canTranslate,
  MAX_MODEL_FALLBACKS,
  MAX_SERVICE_CONCURRENCY,
  PROVIDER_WIRES,
  type ModelFallback,
  type ModelFailureClass,
  PROJECT_GLYPHS,
  WIRE_NAMES,
  escapeSecurityText,
  PROVIDER_KINDS,
  isProviderKind,
  PROVIDER_PRESETS,
  isLocalListener,
  readsProjectFiles,
  type DataScope,
  isNativeListener,
  rejectionNote,
  RISK_REASON_TEXT,
  type AgentPresetSettings,
  type AgentRecord,
  type AgentSettings,
  type AppDataEvent,
  type AppUpdatedEvent,
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
  type ProviderKind,
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
  type ListenerClass,
  type TokenUsage,
} from '@latch/protocol'
import {
  AppError,
  type AskUserInput,
  type HarnessHostOptions,
  type FileTrackingInput,
  type HarnessDriver,
  type HarnessSecurityEvent,
  type HarnessTurnRecord,
  type MemoryProposalInput,
  type MemoryRecallInput,
  type MemoryRecallResult,
  type ScheduleProposalInput,
  type WorkProposalInput,
  type HostProject,
  type ModelProvider,
  type ModelRoute,
  type ProjectFolder,
  type ToolRiskInput,
  type ToolDefinition,
  type HarnessPlugin,
  type SessionFolder,
} from '@latch/sdk'
import { PluginRegistry } from '@latch/core'
import { canonicalJson, sha256Hex, redactKnownSecrets, syncDirectory } from '@latch/core/node-kit'
import {
  assertCommandVersion,
  createAcpAgentPlugin,
  loginShellValues,
  forgetCommandLookups,
  onVersionChange,
  outdatedCommand,
  versionUnread,
  outdatedRefusal,
  recheckVersions,
  presetOffer,
  presetRecord,
  presetRoute,
  commandName,
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
import { DEEPSEEK_ORIGIN, fetchDeepSeekBalance, readDshKey } from './cli-quota.ts'
import { readDshTurnUsage } from './cli-usage.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { loadOrCreateHostIdentity } from './identity.ts'
import { ModelGatewayServer, type GatewayService } from './model-gateway.ts'
import { ModelRequestQueue } from './model-request-queue.ts'
import { ModelScheduler } from './model-scheduler.ts'
import { createModelMeter, ModelSpendStore } from './model-budgets.ts'
import { UsageLedger } from './model-usage.ts'
import { TurnLog, turnLine } from './turn-usage.ts'
import { createModelUsageRoutes } from './model-usage-routes.ts'
import { scheduledProvider, scheduledRequest, type ProviderCandidate } from './scheduled-provider.ts'
import { readSessionSkills, type SessionSkill } from '@latch/protocol'
import type { ExtensionsResponse, HarnessExtensionReport } from '@latch/protocol'
import {
  DENY_READ_HOME_PATHS,
  PROJECT_FOLDER_LIMIT,
  canonicalPath,
  insideRootsSync,
  checkFolderCandidate,
  checkPrivateFile,
  checkProjectFolders,
  classifyDefaultWorkspace,
  isInsidePath,
  isPrintableText,
  latchCodeRoot,
  prepareRuntimeDir,
  resolveLatchPaths,
  type FolderGuardContext,
  type FolderProblem,
} from './paths.ts'
import { GitClones, parseCloneUrl } from './git-clone.ts'
import { foldersHash, newProject, planFolders, reorderFolders, type FolderRefusal, type ProjectPrimary } from './projects.ts'
import { PolicyStore, isLowering, policyDiff, type Policy } from './policy.ts'
import { PresenceService, createPresenceBackend, paramsHash, policySubject, type PresenceBackend } from './presence.ts'
import {
  BROWSER_PLUGIN,
  DEVICE_PLUGIN,
  classifyDeviceCall,
  classifyStandardCall,
  targetFolder,
  type BrowserCallFacts,
  type CallFolder,
} from './risk.ts'
import { BrowserBroker, isBrowserTool, isLoopbackName, type BrokerOutcome, type BrowserTool } from './browser-broker.ts'
import { BROWSER_TOOL_DEFINITIONS, browserFailure, browserResultText, createBrowserToolsPlugin } from './plugins/tools/browser/index.ts'
import {
  DEVICE_TOOL_DEFINITIONS,
  createDeviceToolsPlugin,
  deviceFailure,
  isDeviceTool,
  type DeviceOutcome,
  type DeviceTool,
} from './plugins/tools/device/index.ts'
import { Simulators, isBundleId, isSimulatorUdid, removeStaleSimulatorTemp, simulatorUrl, type SimulatorOptions } from './simulators.ts'
import { addressFacts, bundleHash } from './routes/simulators.ts'
import {
  XCODE_GUIDE_SKILL,
  XCODE_INSTRUCTIONS,
  XCODE_SESSION_END,
  XCODE_SESSION_START,
  xcodeToolRisk,
  type XcodeBridgeOptions,
} from './mcp-xcode.ts'
import {
  MAX_SOCKET_PATH,
  ToolGatewayServer,
  gatewayRefusal,
  type GatewayCall,
  type GatewayResult,
  type McpGatewayHandlers,
} from './tool-gateway.ts'
import {
  MCP_DIRECTORY,
  McpStore,
  TEST_TIMEOUT_MS,
  expandArgs,
  isConfirmed as mcpConfirmed,
  serverEnvironment,
  promptHash,
  toolHash,
  usedIn as mcpUsedIn,
  type McpHttpRecord,
  type McpServerRecord,
} from './mcp.ts'
import { McpOAuth } from './mcp-oauth.ts'
import {
  COMPUTER_DEFAULTS,
  COMPUTER_GUIDE_MODE,
  COMPUTER_GUIDE_SKILL,
  COMPUTER_OFF_HINTS,
  COMPUTER_REFUSAL_TEXT,
  computerDefaultsUpgrade,
  computerGuide,
  computerRefusal,
  computerRules,
  type ComputerDriverOptions,
} from './mcp-computer.ts'
import { McpRemotePool, McpRemoteSession, builtinToolName, maskStrings, remoteFailure, type RemoteAnswer } from './mcp-remote.ts'
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
  MAX_PRESET_BINDINGS,
  type HostSettings,
  type ProviderAddition,
  type ProviderRecord,
  type WorkspaceRecord,
} from './config.ts'
import type { HarnessKind } from './harness-trust.ts'
import { HarnessHub, listSignature, runEndOutline, type HubCreateInput } from './hub.ts'
import { BoardDelivery, boardPlace, type DeliveryTarget } from './board.ts'
import { checkedNote, itemIsPrivate, itemSummary, WorkItemStore, type WorkItemRecord, type WorkProposalRecord } from './work-items.ts'
import { WorkThreadStore } from './work-threads.ts'
import { SessionLifecycle, projectIdOf, type LifecycleBounds, type LifecycleListeners } from './session-lifecycle.ts'
import { RUN_ID, type ApprovalRecord, type CancelRecord } from './session-meta.ts'
import { sendNotFoundPage } from './not-found.ts'
import { SessionFolders } from './session-folders.ts'
import { WORKTREE_NAME, Worktrees, type Worktree } from './worktrees.ts'
import { RepositoryHolds } from './git-delivery.ts'
import { writeProjectContext } from './project-context.ts'
import { AgentProbes } from './agent-probes.ts'
import type { HostInfo } from './host-state.ts'
import { HostLifecycle, hostStateInputSchema } from './lifecycle.ts'
import { HostComputer, KEEP_AWAKE_HOLD_MS, desktopReportSchema } from './computer.ts'
import { TrafficMeter, type FrameKind, type StreamMeter } from './traffic.ts'
import { TaskDeltaCache, TaskDeltaStream } from './task-delta.ts'
import { allApproval, allTaskContent, filesApproval, filesTaskContent, workApproval, workTaskContent } from './task-content.ts'
import { TASK_DELTA_HEADER, TASK_DELTA_PROTOCOL } from '@latch/protocol'
import { DiagnosticLog, diagnosticsBundle, type DiagnosticCategory } from './diagnostics.ts'
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
import { CustomizationStore } from './customization.ts'
import { ShortcutsStore } from './shortcuts.ts'
import { createSessionRoutes } from './session-routes.ts'
import { createFileRoutes } from './files/index.ts'
import { FileDirectoryReader } from './files/directory.ts'
import { FileReferenceStore } from './files/reference-store.ts'
import { PluginAssets } from './plugin-assets.ts'
import { AppDataStore } from './app-data.ts'
import { AppDiagnostics } from './app-diagnostics.ts'
import { AppBuilds } from './app-builds.ts'
import { buildPages, hostBuildTools } from './app-build.ts'
import { APP_DRAFT_DIRECTORY, APP_DRAFT_MANIFEST, readSessionDraft } from './app-import.ts'
import { APP_GUIDE, APP_SDK_DTS, appSkeleton } from './app-sdk-types.ts'
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
/** An Agent's chat is warmed at most once in this long, however often a page opens it. */
const AGENT_WARM_EVERY_MS = 30_000
/** Warm-ups a minute from one device and from all of them, whichever Agents they name. */
const AGENT_WARM_LIMITS = { device: 6, all: 20 } as const
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(['running', 'waiting-approval'])
/** How long after start the Host waits before its one background read of recent sessions' local Git. */
const BOARD_WARM_DELAY_MS = 2_000
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
  'POST /link/api/diagnostics',
  'GET /link/api/customization',
  'POST /link/api/customization/reset',
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
const removeWorktreeSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  /** How many uncommitted files the person agreed to discard; required, and equal to the count now, when there are any. */
  discard: z.number().int().min(1).max(10_000_000).optional(),
  /** The inventory's digest the person confirmed: a removal that discards anything is refused when the listing moved. */
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  /** The dialog said Latch's merged branch goes: without it the branch is always kept. */
  deleteBranch: z.literal(true).optional(),
})

const createTaskSchema = promptSchema.extend({
  prompt: z.string().trim().max(16_000).default(''),
  /** 让 Agent 做: an Agent session in its own folder, where the Host writes a page draft's skeleton before the first input. */
  appDraft: z.literal(true).optional(),
  forkOf: z
    .object({ taskId: z.string().min(1).max(256), upToMessageId: z.string().min(1).max(256) })
    .strict()
    .optional(),
  /**
   * 从这里编辑 on a session's first message: a new session with the edited words, which nothing precedes. The Host reads
   * the source and makes the new session as private as it, and marks it as starting from outside content where the
   * source did (it may hold handed-over material); the page never builds this start from parts.
   */
  editOf: z
    .object({ taskId: z.string().min(1).max(256) })
    .strict()
    .optional(),
  mode: z.enum(['chat', 'agent']).optional(),
  harnessId: z.string().regex(HARNESS_ID).optional(),
  workspaceId: z.string().min(1).max(64).optional(),
  /** The person chose the Harness's own default model: a session choice, so the project's 默认模型 does not replace it. */
  ownModel: z.literal(true).optional(),
  /**
   * Start in a Git worktree of the project's folder: `true` (or `head`) on a new branch from its HEAD, `commit` on a new
   * branch from another local branch or commit, `branch` on an existing local branch, `reuse` in an earlier Latch
   * worktree of the project (docs/BRANCHES.md).
   */
  worktree: z
    .union([
      z.literal(true),
      z.strictObject({ from: z.literal('head') }),
      z.strictObject({ from: z.literal('commit'), ref: z.string().min(1).max(200) }),
      z.strictObject({ from: z.literal('branch'), branch: z.string().min(1).max(200) }),
      z.strictObject({ from: z.literal('reuse'), name: z.string().regex(WORKTREE_NAME) }),
    ])
    .optional(),
  /** One of 我的 Agent, or `general`: a conversation with 通用 that belongs to 我的 Agent (`TaskSummary.generalChat`). */
  customAgentId: z.union([z.literal(GENERAL_AGENT_ID), z.string().regex(/^agt_[a-f0-9-]{36}$/u)]).optional(),
  /** Choices from the harness's catalogue, set before the first prompt. */
  config: z
    .array(z.strictObject({ configId: z.string().min(1).max(128), value: z.string().max(1024) }))
    .max(16)
    .refine(entries => new Set(entries.map(entry => entry.configId)).size === entries.length, '每个设置只能选一次')
    .optional(),
})
/**
 * A start as the Host takes it: the request's choices and the Host's own marks. `pageStart`: a plugin page started it
 * (no board proposals). `outsideStart`: its first message came from outside content (a 待办 an agent proposed from it).
 */
type SessionStart = z.infer<typeof createTaskSchema> & {
  privateFrom?: string
  title?: string
  withoutPrivateContext?: true
  seed?: string
  pageStart?: true
  outsideStart?: true
}
const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    /** Normalised by `normalizeBoardTags` before anything is written; null or empty removes them. */
    tags: z.array(z.string().max(256)).max(64).nullable().optional(),
    /** `mid` is the default: the field goes. */
    priority: z.enum(['high', 'mid', 'low']).optional(),
    /** One line on the board card; null or empty removes it. */
    note: z.string().max(4096).nullable().optional(),
  })
  .refine(
    value =>
      value.title !== undefined
      || value.pinned !== undefined
      || value.archived !== undefined
      || value.tags !== undefined
      || value.priority !== undefined
      || value.note !== undefined,
    '没有要修改的内容',
  )
const attendSchema = z
  .strictObject({
    settle: z.string().min(1).max(BOARD_SETTLE_CHARS),
    opened: z.literal(true).optional(),
    checked: z.literal(true).optional(),
  })
  .refine(value => value.opened || value.checked, '没有要记下的内容')
const TAG_PROBLEMS = {
  'tag-invalid': '标签要 1–24 个字，不能有换行或控制字符。',
  'tag-secret': '标签看起来像密钥，没有保存。',
  'tag-limit': '一个会话最多 8 个标签。',
} as const
const commandCatalogueSchema = createTaskSchema
  .pick({ workspaceId: true, mode: true, model: true, config: true, worktree: true, customAgentId: true })
  .strict()
const publicCommandCatalogue = z
  .object({
    skillsTruncated: z.literal(true).optional(),
    skills: z
      .custom<SessionSkill[]>(value => readSessionSkills(value) !== undefined)
      .transform(value => readSessionSkills(value)!)
      .optional(),
    commands: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
          description: z.string().max(1000).optional(),
          inputHint: z.string().max(500).optional(),
          idleOnly: z.literal(true).optional(),
        }),
      )
      .max(200),
    reportedAt: z.string().datetime(),
    source: z.literal('previous-session'),
  })
  .refine(value => !value.skillsTruncated || value.skills !== undefined, 'A truncated catalogue must include its public skills')
const configSchema = z.strictObject({
  configId: z.string().min(1).max(128),
  value: z.string().max(1024),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u)
    .optional(),
})
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
/** 核对 names what the change asked for; the receipt holds only its hash. */
const configCheckSchema = z.strictObject({ configId: configSchema.shape.configId, value: configSchema.shape.value })
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
/** 停 on 「操控这台 Mac」 in one session: nothing to say. */
const computerStopSchema = z.strictObject({}).optional()
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
const modelFallbacksRecord = z
  .record(modelId, z.array(z.strictObject({ providerId: z.string().regex(PROVIDER_ID), model: modelId })).max(MAX_MODEL_FALLBACKS))
  .refine(value => Object.keys(value).length <= 1000)
const providerCreateSchema = z.object({
  id: z.string().regex(PROVIDER_ID).optional(),
  requestId: requestIdSchema.optional(),
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
  expectedTarget: z.strictObject({ baseURL: z.string().min(1).max(2048), kind: providerKind }).optional(),
  apiKey: apiKeyText.nullable().optional(),
  models: modelList.optional(),
  modelCapabilities: modelCapabilitiesRecord.optional(),
  defaultModel: modelId.optional(),
  enabled: z.boolean().optional(),
  confirmOrigin: z.boolean().optional(),
  /** 「出错时改用」 by model, whole: a model left out has none. Every entry names a saved service's model. */
  fallbacks: modelFallbacksRecord.optional(),
  /** Null: no limit of this service's own. */
  maxConcurrent: z.number().int().min(1).max(MAX_SERVICE_CONCURRENCY).nullable().optional(),
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
/** 克隆: signed by the desktop app's main process like a folder add; `parent` is the folder its native picker chose. */
const cloneSchema = z
  .object({
    nonce: z.string().min(1).max(128),
    via: z.literal('clone'),
    url: z.string().min(1).max(2048),
    parent: z.string().min(1).max(4096),
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
    /** 「默认模型」 of the project's new sessions; null clears it. */
    defaultModel: z
      .strictObject({ providerId: z.string().regex(PROVIDER_ID), model: modelId, effort: modelEffort.optional() })
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    value => value.name !== undefined || value.glyph !== undefined || value.order !== undefined || value.defaultModel !== undefined,
    '没有要修改的内容',
  )
const preferencesSchema = z.object({
  defaults: z.object({
    harnessId: z.string().regex(HARNESS_ID).optional(),
    mode: z.enum(['chat', 'agent']).optional(),
    workspaceId: z.string().min(1).max(64).optional(),
    model: modelRefSchema.nullable().optional(),
    gateway: modelRefSchema.omit({ effort: true }).nullable().optional(),
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
  /** The build this Host started from (ui-build.ts `readCodeBuild`), reported in host-info for the desktop launcher. */
  codeBuild?: string
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
   * The home directory whose DeepSeek Harness key the Host may read for that Harness's DeepSeek balance
   * (`cli-quota.ts`). The start script passes the person's home; left out, as in tests, no CLI credential on this
   * computer is read and no vendor is asked. `cliQuotaFetch` replaces the outbound fetch, for tests only.
   */
  cliQuota?: { home: string; fetch?: FetchLike }
  /**
   * The home directory whose DeepSeek Harness session logs the Host may read for the token counts of turns it ran
   * there (`cli-usage.ts`). The start script passes the person's home; left out, as in tests, no CLI record is read.
   */
  cliUsage?: { home: string }
  /**
   * Where a bare command name is looked for: an agent's command, its adapter, the programs a preset points it at. The
   * start script passes `personCommandDirectories`; left out, as in tests, only absolute commands are found, so no real
   * agent on this computer can be described, offered or started. Tests name their own directories.
   */
  commandDirectories?: () => readonly string[]
  /**
   * The PATH directories (login shell and process) among them: a preset's command found only elsewhere (the extra install
   * directories) is confirmed like a custom one. The start script passes `personPathDirectories`; left out, as in tests,
   * `commandDirectories` counts as PATH.
   */
  pathDirectories?: () => readonly string[]
  /** Tests: receives a harness's login script instead of a terminal opening. Production never sets it. */
  loginTerminal?: (script: string) => Promise<void>
  /** Tests: how long a remote MCP server's login waits for the browser (at most 10 minutes). Production never sets it. */
  mcpLoginTtlMs?: number
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
  /**
   * Where 「操控这台 Mac」 looks for Cua Driver. The start script passes `COMPUTER_APP` on macOS; left out, as in tests
   * that do not name a fake, the preset is not offered and no real driver on this computer is ever run.
   */
  computerDriver?: ComputerDriverOptions
  /**
   * How this Mac's iOS simulators are reached. The start script passes the real `xcrun simctl` runner on macOS; left
   * out, as in tests that name no fake, the 设备 panel and the `device_*` tools are absent and simctl never runs.
   */
  simulators?: SimulatorOptions
  /** Where 「Xcode」 looks for Xcode's MCP bridge. The start script passes it on macOS; left out, no such preset. */
  xcodeBridge?: XcodeBridgeOptions
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
  delta?: TaskDeltaStream
  scope: string
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

/** The `host:port` an outbound allowance names for `url`, as the egress rules write it; undefined for no URL. */
function hostPortOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`
  } catch {
    return undefined
  }
}

/**
 * An MCP tool's name as it may be kept in a report or shown: MCP's spelling, and no saved secret in it (a server could
 * name a tool after one; such a tool is left out rather than shown masked).
 */
function keptToolName(name: string): boolean {
  return /^[A-Za-z0-9_.:/-]{1,128}$/u.test(name) && redactKnownSecrets(name) === name
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

function sameProviderTarget(before: Pick<ProviderRecord, 'kind' | 'baseURL'>, expected: { baseURL: string; kind: ProviderKind }): boolean {
  if (before.kind !== expected.kind) return false
  if (before.baseURL === expected.baseURL) return true
  try {
    assertBaseURL(before.baseURL)
    assertBaseURL(expected.baseURL)
    return addressOf(before.baseURL) === addressOf(expected.baseURL)
  } catch {
    return false
  }
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
function detectCommand(command: string, agent?: string, record?: AgentRecord): CommandDetection {
  const path = resolveCommand(command)
  const outdated = record && path ? outdatedCommand(record, path) : undefined
  return {
    ...(path ? { found: true, path } : { found: false }),
    ...(agent ? { agent: { command: agent, found: resolveCommand(agent) !== undefined } } : {}),
    ...(outdated ? { outdated } : {}),
  }
}

/**
 * The program a definition's adapter drives, for saying it is installed when only the adapter is missing: the preset's
 * `agentCommand`, or for a definition on a preset's `fallback` adapter, the program that adapter drives.
 */
function programOf(agent: Pick<AgentRecord, 'presetId' | 'command'>): string | undefined {
  const preset = AGENT_PRESETS.find(item => item.id === agent.presetId)
  if (!preset) return undefined
  return preset.fallback && commandName(agent.command) !== preset.command ? preset.fallback.drives : preset.agentCommand
}

/**
 * Whether the Host may read this definition's CLI credential for its quota (`cli-quota.ts`) and its record of a session
 * Latch started for that session's tokens (`cli-usage.ts`): DeepSeek Harness's own preset command, exactly as the
 * preset table names it with no variables, bound to a program this Mac confirmed.
 */
function readsCliQuota(agent: AgentRecord): boolean {
  return agent.presetId === 'dsh' && agent.confirmedCommand !== undefined && runsPresetCommand(agent)
}

/**
 * Whether a definition runs exactly what one of the Host's own presets names: its command or its adapter, with exactly
 * those arguments and no variables. Decided from the Host's table, never from what a client says; `presetId` only picks
 * the entry to compare with.
 */
function runsPresetCommand(agent: Pick<AgentRecord, 'presetId' | 'command' | 'args' | 'env'>): boolean {
  const preset = AGENT_PRESETS.find(item => item.id === agent.presetId)
  if (!preset || Object.keys(agent.env).length > 0) return false
  const same = (route: { command: string; args: readonly string[] }) =>
    route.command === agent.command && canonicalJson(route.args) === canonicalJson(agent.args)
  return same(preset) || (preset.fallback !== undefined && same(preset.fallback))
}

/** The first Harness, in the presets' order, that can start now, runs commands and brings its own models. */
function firstReadyHarness(harnesses: readonly HarnessInfo[]): HarnessInfo | undefined {
  const rank = (harness: HarnessInfo) => {
    const index = AGENT_PRESETS.findIndex(preset => preset.id === harness.capabilities.display.mark)
    return index < 0 ? AGENT_PRESETS.length : index
  }
  return harnesses
    .filter(harness => harness.status === 'ready' && harness.capabilities.tools.shell && harness.capabilities.models.owner !== 'latch')
    .toSorted((a, b) => rank(a) - rank(b))[0]
}

/** What this computer has of a preset's commands: its own, or its adapter when a draft would use that. */
export const detectPresetCommands = (preset: AgentPreset): CommandDetection => {
  const route = presetRoute(preset.id) ?? { command: preset.command }
  return detectCommand(route.command, programOf({ presetId: preset.id, command: route.command }))
}

/** A preset's detection with what its command's version says, whichever way it was found. */
function withVersion(preset: AgentPreset, detected: CommandDetection): CommandDetection {
  const record = presetRoute(preset.id)
  const path = detected.found && record ? (detected.path ?? resolveCommand(record.command)) : undefined
  const outdated = record && path ? outdatedCommand(record, path) : undefined
  if (outdated) return { ...detected, outdated }
  return record && versionUnread(record, path) ? { ...detected, versionUnread: true } : detected
}

/** PATH lookups touch the file system and the catalog is read often; as long as a driver's own status keeps one. */
const PRESET_LOOKUP_TTL_MS = 5_000
/** dsh writes its session events in batches 200 ms apart (`enqueueLive`): the wait before its log is read for a turn. */
const TURN_LOG_SETTLE_MS = 1_000
/** How long reading the agent settings waits for commands to print their versions. */
const VERSION_RECHECK_MS = 5_000

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
    detected: detectCommand(agent.command, programOf(agent), agent),
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
  // The recent lines stay in memory for 诊断导出, as redacted as the log itself.
  const diagnosticLog = new DiagnosticLog(options.clock ?? Date.now)
  const log = (text: string) => sink(redactKnownSecrets(text))
  // 诊断导出 keeps no log line: only these Host-written sites note an event, as a category, an ID and an error code.
  const logNoted = (category: DiagnosticCategory, detail: { id?: string; error?: unknown }, text: string) => {
    diagnosticLog.note(category, detail)
    log(text)
  }
  const startedAt = new Date().toISOString()
  const uiBuild = await readUiBuild(resolve(options.uiDir))
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
    // Latch's own MCP servers: definitions and, apart, the values of their variables (docs/MCP.md).
    const mcpStore = await McpStore.open(dataDir, now)
    // Key material, Agent definitions, MCP servers and the Host identity stay out of Time Machine backups; sessions, the
    // audit log and the policy are backed up as usual.
    await excludeFromBackup(
      [authDir, join(dataDir, 'identity'), join(dataDir, MCP_DIRECTORY), ...BACKUP_EXCLUDED_CONFIG_FILES.map(file => join(dataDir, file))],
      { log },
    )
    // 「操控这台 Mac」 from before the current defaults: the switches the person did not move follow them, on record first.
    for (const record of mcpStore.records()) {
      if (record.transport !== 'stdio' || record.preset !== 'computer' || (record.defaults ?? 1) >= COMPUTER_DEFAULTS) continue
      const disabledTools = computerDefaultsUpgrade(record.disabledTools)
      try {
        if (disabledTools)
          await audit.append({
            action: 'mcp.server.changed',
            actor: { listener: 'host' },
            target: record.id,
            detail: { serverId: record.id, kinds: ['tools'], specHash: record.specHash, enabled: record.enabled },
          })
        await mcpStore.change(undefined, ({ servers, stamp }) => {
          const draft = servers.servers.find(item => item.id === record.id)
          if (!draft || draft.transport !== 'stdio') return record.id
          if (disabledTools) {
            draft.disabledTools = disabledTools
            // Shown once in settings: which switches moved.
            const moved = (['run_steps', 'launch_app', 'get_desktop_state'] as const).filter(
              tool => record.disabledTools.includes(tool) !== disabledTools.includes(tool),
            )
            if (moved.length) draft.defaultsMoved = moved
            draft.revision += 1
            draft.updatedAt = stamp
          }
          draft.defaults = COMPUTER_DEFAULTS
          return record.id
        })
      } catch (error) {
        log(`「操控这台 Mac」的默认开关没有更新，下次启动再试：${errorText(error)}`)
      }
    }
    // A policy.json from before confirmed origins: record the origins the owner had already confirmed, once.
    if (policy.needsAddressMigration) {
      await policy
        .migrateConfirmedAddresses(addressesConfirmedBefore(config.providers(), policy.get().hostEgressAllow))
        .catch(error =>
          logNoted(
            'confirmed-addresses-failed',
            { error: error },
            `无法记录已确认的模型服务地址，自定义地址的服务在本次运行中不可用：${errorText(error)}`,
          ),
        )
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
    /**
     * The Host's read of DeepSeek Harness's DeepSeek balance with that CLI's own key (`cli-quota.ts`), for a definition
     * that still is the preset's own when asked. On record before the key leaves; a failed audit sends nothing.
     */
    const cliQuotaReader = (cliQuota: NonNullable<ServerOptions['cliQuota']>) => {
      const fetch =
        cliQuota.fetch
        ?? createEgressFetch({ allow: () => [], ...(options.egressLookup ? { lookup: options.egressLookup } : {}), connectTimeoutMs: 5000 })
      const uid = process.getuid?.()
      return async (agentId: string, input: { cwd?: string; signal: AbortSignal }) => {
        const current = config.settings().agents.find(agent => agent.id === agentId)
        if (!current || !readsCliQuota(current) || uid === undefined) return null
        // What DeepSeek Harness inherits (`agentEnvironment`): `DSH_HOME` from the Host or the login shell.
        const env = {
          DSH_HOME: process.env.DSH_HOME || loginShellValues().DSH_HOME,
          DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? loginShellValues().DEEPSEEK_BASE_URL,
        }
        const read = await readDshKey({ home: cliQuota.home, env, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}), uid })
        // A folder that could send the key elsewhere skips this read and keeps what the others showed.
        if (read === 'skip') return undefined
        if (read === 'none') return null
        const { key } = read
        try {
          await audit.append({
            action: 'agent.quota.read',
            actor: { listener: 'host' },
            target: agentId,
            detail: { agentId, presetId: 'dsh' },
          })
        } catch {
          return undefined
        }
        return fetchDeepSeekBalance(key, fetch, input.signal)
      }
    }
    // The balance goes only to the DeepSeek preset's own HTTPS origin, a named destination that needs no confirmation;
    // were it no longer a preset's, the read is not offered at all.
    const readCliQuota = options.cliQuota && isPresetKeyOrigin(originOf(DEEPSEEK_ORIGIN)) ? cliQuotaReader(options.cliQuota) : undefined
    /**
     * The Host's read of a turn's tokens from DeepSeek Harness's own log of that one session (`cli-usage.ts`), for a
     * definition that still is the preset's own when asked. Only numbers come back; nothing is audited, since nothing
     * leaves this computer and no secret is touched.
     */
    const cliUsageReader = (cliUsage: NonNullable<ServerOptions['cliUsage']>) => {
      const uid = process.getuid?.()
      return async (
        agentId: string,
        input: { sessionId: string; cwd: string; from: number; to: number; signal: AbortSignal },
      ): Promise<TokenUsage | undefined> => {
        const current = config.settings().agents.find(agent => agent.id === agentId)
        if (!current || !readsCliQuota(current) || uid === undefined) return undefined
        await delay(TURN_LOG_SETTLE_MS, undefined, { signal: input.signal }).catch(() => {})
        if (input.signal.aborted) return undefined
        return readDshTurnUsage({
          home: cliUsage.home,
          env: { DSH_HOME: process.env.DSH_HOME || loginShellValues().DSH_HOME },
          uid,
          ...input,
        })
      }
    }
    const readCliUsage = options.cliUsage ? cliUsageReader(options.cliUsage) : undefined
    const buildAgentPlugin =
      options.agentPlugin
      ?? ((agent: AgentRecord) =>
        createAcpAgentPlugin(agent, {
          log,
          requireConfirmedCommand: true,
          ...(readCliQuota && readsCliQuota(agent) ? { readQuota: input => readCliQuota(agent.id, input) } : {}),
          ...(readCliUsage && readsCliQuota(agent) ? { readTurnUsage: input => readCliUsage(agent.id, input) } : {}),
        }))
    const egressExtra = [...(options.egressAllow ?? [])]
    const egressFetch = createEgressFetch({
      allow: () => [...policy.get().hostEgressAllow, ...egressExtra],
      ...(options.egressLookup ? { lookup: options.egressLookup } : {}),
    })
    const inspectEgress = createEgressInspector(options.egressLookup ? { lookup: options.egressLookup } : {})
    /** The Host's sessions with remote MCP servers, through the same outbound rules (docs/MCP.md). */
    const mcpRemote = new McpRemotePool()
    startupCleanup.push(() => mcpRemote.closeAll())
    /** Remote MCP servers' logins (OAuth): the Host is the client, through the same outbound rules. */
    const mcpOAuth = new McpOAuth({
      store: mcpStore,
      fetch: egressFetch,
      now,
      // The device that began a login is its actor; what the Host does by itself (a renewal, a timeout) is the Host's.
      audit: async (action, detail, actor) => {
        await audit.append({
          action,
          actor: (actor as AuditEvent['actor'] | undefined) ?? { listener: 'host' },
          target: String(detail.serverId),
          detail,
        } as AuditEvent)
      },
      initiatorHolds: deviceId => devices.isActive(deviceId) && devices.get(deviceId)?.scopes.includes('admin') === true,
      changed: () => refresh(),
      log,
      ...(options.mcpLoginTtlMs !== undefined ? { ttlMs: options.mcpLoginTtlMs } : {}),
    })
    startupCleanup.push(() => mcpOAuth.close())
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
      void synchronizeNativeDiscovery().catch(() => logNoted('discovery-rotation-failed', {}, 'Native discovery key rotation failed'))
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
    if (defaultFlags.insideData)
      logNoted('workspace-in-data-dir', {}, `工作区位于数据目录内（${realWorkspace}）。迁出之前只能使用内置 Harness。`)
    if (defaultFlags.codeRoot)
      logNoted(
        'workspace-overlaps-code',
        {},
        `工作区与 Latch 程序目录重叠（${realWorkspace}），内置 Harness 的每次写入都需要在本机确认，ACP Agent 不可用。`,
      )
    // Path spellings (case, firmlinks) differ between APIs; code-root decisions compare canonical forms only.
    const canonicalCodeRoot = await canonicalPath(codeRoot)
    const canonicalWorkspace = await canonicalPath(realWorkspace)
    const defaultFolder = await stat(realWorkspace, { bigint: true })
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
    const updateWindow = new UpdateWindow(now)
    /** Host writes that run the user's Git (delivery, pull request, worktree removal): the install waits for them. */
    const repositoryHolds = new RepositoryHolds({ closed: () => updateWindow.isCommitted })
    /** 克隆 into a new project folder: your Git, like a push, with none of the repository's code (docs/GIT-DELIVERY.md). */
    const clones = new GitClones({
      holds: repositoryHolds,
      ...(options.gitDelivery?.git ? { git: options.gitDelivery.git } : {}),
      ...(options.gitDelivery?.hostEnv ? { hostEnv: options.gitDelivery.hostEnv } : {}),
      ...(options.gitDelivery?.shell ? { shell: options.gitDelivery.shell } : {}),
      log,
    })
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
      logNoted('settings-changed-outside', {}, 'settings.json 在 Latch 之外被修改过，已记入审计；其中的项目已重新检查。')
    }
    // A Host-only key for `HarnessInfo.bound.id`: every device gets that digest, and a guessable path must not be read back.
    if (!config.settings().boundKey)
      await config.updateSettings(draft => {
        draft.boundKey = randomBytes(32).toString('hex')
      })
    const boundKey = config.settings().boundKey!
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
      logNoted('project-unavailable', { id: record.id }, `项目「${record.name}」暂不可用：${state.failure.message}`)
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
        .catch(cause => logNoted('audit-write-failed', { error: cause }, `审计记录写入失败（workspace.disabled）：${errorText(cause)}`))
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
    let closing = false
    const modelRequests = new ModelRequestQueue()
    startupCleanup.push(() => modelRequests.close())
    // One scheduler for the gateway and the built-in harness, so both read the same health and limits of a service.
    const modelScheduler = new ModelScheduler({
      limit: id => effectiveProvider(id)?.maxConcurrent,
      // What a service is now: a candidate bound to older settings never touches what is known of it.
      fingerprint: id => {
        const record = effectiveProvider(id)
        return record && providerFingerprint(record)
      },
      changed: () => refresh(),
      queued: sessionId => {
        if (sessionId) refresh(sessionId)
      },
    })
    // One ledger and one set of budgets for the gateway and the built-in harness: usage metadata, never audit.
    const usageLedger = await UsageLedger.open(dataDir, { now, log })
    const turnLog = await TurnLog.open(dataDir, { now, log })
    const modelSpend = await ModelSpendStore.open(dataDir)
    const modelMeter = createModelMeter({
      ledger: usageLedger,
      store: modelSpend,
      session: sessionId => {
        const agentId = sessionOwner(sessionId) ?? hub?.startingAgentId()
        const harness = hub?.ownerOf(sessionId)
        const projectId = hub?.projectOf(sessionId)
        return { ...(agentId ? { agentId } : {}), ...(harness ? { harness } : {}), ...(projectId ? { projectId } : {}) }
      },
      builtIn: STANDARD,
    })
    /** Service providers as their plugins registered them, before scheduling: what another service's fallback calls. */
    const serviceProviders = new Map<string, ModelProvider>()
    /** On record before a request leaves the service it was meant for; a failed write keeps it there. */
    const modelFallback = async (event: { sessionId: string; providerId: string; candidate: number; reason: ModelFailureClass }) => {
      await audit.append({
        action: 'task.model.fallback',
        actor: { listener: 'host' },
        target: event.sessionId,
        detail: { sessionId: event.sessionId, providerId: event.providerId, candidate: event.candidate, errorClass: event.reason },
      })
    }
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
    // A deleted memory's text goes when its undo window ends, whether or not anything is written meanwhile.
    const purgeMemories = () => void customAgents.purgeExpired().catch(error => log(`过期的已删除记忆没有清除：${errorText(error)}`))
    purgeMemories()
    const purgeTimer = setInterval(purgeMemories, 24 * 60 * 60 * 1000)
    purgeTimer.unref()
    startupCleanup.push(() => clearInterval(purgeTimer))
    startupCleanup.push(() => customAgents.close())
    const computer = await HostComputer.open({
      dataDir,
      now,
      changed: () => refresh(),
      setAside: reason => log(`电脑记录无法读取（${reason}），已移到一边，睡眠记录从空开始。`),
    })
    startupCleanup.push(() => computer.close())
    const questions = await Questions.open({ dataDir, changed: id => refresh(id), detail: id => hub!.detail(id), log })
    startupCleanup.push(() => questions.close())
    registry.register(createQuestionsPlugin(questions), { managed: 'core', revision: executionBuildRevision('user-questions') })
    await registry.enable('user-questions')
    // The built-in harness's browser tools reach the desktop app's tabs on this Mac through the broker.
    const browserBroker = new BrowserBroker({
      async auditCall(detail) {
        await audit.append({ action: 'browser.call', actor: { listener: 'host' }, target: detail.sessionId, detail })
      },
      auditProvider(event, deviceId) {
        audit
          .append({
            action: event === 'registered' ? 'browser.provider.registered' : 'browser.provider.ended',
            actor: { deviceId, listener: 'unix', via: 'http' },
            detail: {},
          })
          .catch(error => logNoted('audit-write-failed', { error }, `审计记录写入失败：${errorText(error)}`))
      },
    })
    startupCleanup.push(() => browserBroker.end('stopping'))
    // This Mac's iOS simulators, through simctl and devicectl; the first list, in the background, says whether Xcode is here.
    const simulators = new Simulators({
      ...options.simulators,
      // The Host's own shutdowns of devices it booted: recorded, never blocked by the record (it only ends something).
      onAutoShutdown: async (udid, reason) => {
        await audit
          .append({
            action: 'simulator.action',
            actor: { listener: 'host' },
            target: '',
            detail: { action: 'auto-shutdown', udid, reason },
          })
          .catch(error => logNoted('audit-write-failed', { error }, `审计记录写入失败：${errorText(error)}`))
      },
    })
    /**
     * Whether the device that last sent a session input sees all data: a simulator's picture enters the session, where
     * every device that may read it sees it, so the device tools run only for a turn such a device asked for. A turn
     * nobody sent (an automation's) has no entry and gets none.
     */
    const turnScopes = new Map<string, boolean>()
    const noteTurnScope = (sessionId: string, caller: DeviceCaller) => {
      turnScopes.delete(sessionId)
      turnScopes.set(sessionId, devices.get(caller.device.id)?.dataScope === 'all')
      // Bounded: the oldest sessions go first.
      if (turnScopes.size > 2000) turnScopes.delete(turnScopes.keys().next().value!)
    }
    startupCleanup.push(() => simulators.stop())
    if (simulators.supported) void simulators.list().catch(() => undefined)
    // A picture or recording directory a crashed Host of this user left in the temporary folder.
    if (simulators.supported) void removeStaleSimulatorTemp(tmpdir()).catch(() => undefined)
    if (simulators.supported) {
      registry.register(createDeviceToolsPlugin({ call: (tool, args, context) => deviceCall(tool, args, context) }), {
        managed: 'core',
        revision: executionBuildRevision(DEVICE_PLUGIN),
      })
      await registry.enable(DEVICE_PLUGIN)
    }
    /** The class each session's browser call got right before it ran: main gets the class the call was approved at. */
    const browserRisks = new Map<string, { key: string; risk: RiskLevel }>()
    registry.register(createBrowserToolsPlugin({ call: (tool, args, context) => browserCall(tool, args, context) }), {
      managed: 'core',
      revision: executionBuildRevision(BROWSER_PLUGIN),
    })
    await registry.enable(BROWSER_PLUGIN)
    // External harnesses reach the same tools through their `latch-browser` MCP server and this socket, in a private
    // directory of the runtime directory, whose short path fits a Unix socket's limit as host.sock's does.
    const toolGatewayPath = join(runtime.runtimeDir, 'tools', 'gateway.sock')
    const toolGateway =
      Buffer.byteLength(toolGatewayPath) <= MAX_SOCKET_PATH
        ? new ToolGatewayServer({
            socketPath: toolGatewayPath,
            // Only while this Mac's desktop app is the browser provider: a session opened without it gets the server
            // when it next resumes. Sessions without a project are left out by the driver, and refused on every call.
            admits: () => browserBroker.available(),
            // The simulator tools join while the last list found Xcode on this Mac.
            tools: () =>
              [...BROWSER_TOOL_DEFINITIONS, ...(simulators.ready ? DEVICE_TOOL_DEFINITIONS : [])].map(
                ({ name, description, parameters }) => ({
                  name,
                  description,
                  inputSchema: parameters,
                }),
              ),
            call: input => (isDeviceTool(input.tool) ? gatewayDeviceCall(input) : gatewayBrowserCall(input)),
            mcp: mcpGateway(),
            log,
          })
        : undefined
    await toolGateway?.start()
    startupCleanup.push(() => toolGateway?.close())
    /** Names and schedules of private definitions: for a device that may read them, and on a phone only while verified. */
    function privateAgentView(caller: Caller): boolean {
      return fullData(caller) && (!caller.nativeOpening || nativeRoutes.verifiedUntil(caller.nativeOpening) > now())
    }

    function agentSummaries(
      caller: Caller,
      tasks: readonly TaskSummary[],
    ): Pick<AppSnapshot, 'customAgents' | 'automations' | 'agentProposals' | 'agentResults' | 'computer'> {
      if (!privateAgentView(caller)) return {}
      // Absent, as on a Host without them, while a write is being confirmed: the rest of the app has nothing to wait for.
      if (customAgents.hasPending() || automations.hasPending()) return {}
      return {
        customAgents: customAgents.list().map(agent => agentPlans.summary(agent, tasks)),
        automations: automations.list().map(automationSummary),
        agentProposals: customAgents.proposalStates(),
        agentResults: automations.resultStates(),
        computer: computer.view(),
      }
    }
    /**
     * For the desktop app's 「到点前后保持唤醒」 (host-info, host.sock only): when the next schedule of an Agent that asked
     * for it is due, and how many of their scheduled runs go on. Times and a count only. Nothing while a write is being
     * confirmed, since the definitions cannot be read then.
     */
    function scheduleWake(): { next?: string; running: number } {
      if (customAgents.hasPending() || automations.hasPending()) return { running: 0 }
      const owners = new Set(
        customAgents
          .list()
          .filter(agent => agent.keepAwakeForSchedules)
          .map(agent => agent.id),
      )
      return owners.size ? automations.wakeFor(owners, KEEP_AWAKE_HOLD_MS) : { running: 0 }
    }
    function questionSummary(task: TaskSummary): TaskSummary {
      const { pendingQuestions: _untrustedCount, ...summary } = task
      return { ...summary, pendingQuestions: questions.view(task.id).length }
    }
    const workspaceFiles = createWorkspacePlugin({ protectedPaths: guardedPaths })
    /** Latch's own optional plugins, as 设置 › 扩展 tells them from ones a developer added. */
    const builtInPlugins = new Set<string>()
    const optional = [
      isWithin(realWorkspace, realDataDir) ? guardDataDir(workspaceFiles, realDataDir, realWorkspace) : workspaceFiles,
      ...(options.demo ? [createToolsPlugin(), createDemoPlugin()] : []),
      ...(options.plugins ?? []),
    ]
    for (const [index, plugin] of optional.entries()) {
      if (index < optional.length - (options.plugins?.length ?? 0)) builtInPlugins.add(plugin.id)
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
        logNoted('provider-load-failed', { id: record.id, error: error }, `模型服务 ${record.id} 未加载：${errorText(error)}`)
        continue
      }
      if (record.enabled)
        await registry
          .enable(record.id)
          .catch(error =>
            logNoted('provider-load-failed', { id: record.id, error: error }, `模型服务 ${record.id} 启用失败：${errorText(error)}`),
          )
    }
    for (const agent of config.settings().agents)
      await installAgent(agent).catch(error =>
        logNoted('agent-load-failed', { id: agent.id, error: error }, `Agent ${agent.id} 未加载：${errorText(error)}`),
      )

    const pluginAssets = await PluginAssets.open(dataDir, { audit })
    startupCleanup.push(() => pluginAssets.close())
    const appData = await AppDataStore.open(dataDir, { now })
    startupCleanup.push(() => appData.close())
    const appDiagnostics = new AppDiagnostics(id => appData.pluginDirectory(id), now)
    const appBuilds = await AppBuilds.open(dataDir, now)
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
          .catch(error =>
            logNoted('audit-write-failed', { error: error }, `审计记录写入失败（host.update.plugins-held）：${errorText(error)}`),
          )
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
        logNoted('plugin-load-failed', { id: record.id }, `自定义插件 ${record.id} 未加载，请检查本地声明与依赖。`)
      }
    }

    const sessionLifecycle = new SessionLifecycle({ log, ...(options.lifecycleBounds ? { bounds: options.lifecycleBounds } : {}) })
    const lifecycleListeners = sessionLifecycle.listenOnly()
    /** The sessions with an approval pending, read once per turn of the event loop: a listing presents every session. */
    let approvalMemo: ReadonlySet<string> | undefined
    function approvalSessions(): ReadonlySet<string> {
      if (!approvalMemo) {
        approvalMemo = new Set((hub?.approvals() ?? []).map(approval => approval.sessionId))
        queueMicrotask(() => {
          approvalMemo = undefined
        })
      }
      return approvalMemo
    }
    /** A session the Host reads local Git for in the background: Code, not archived or running, with its folder. */
    async function deliveryTarget(sessionId: string): Promise<DeliveryTarget | undefined> {
      const current = hub
      if (!current) return undefined
      const task = await current.summary(sessionId).catch(() => undefined)
      if (!task || task.archived || task.personal || task.agent || task.generalChat || ACTIVE_STATUSES.has(task.status)) return undefined
      const roots = await sessionRoots(sessionId).catch(() => undefined)
      if (!roots || roots === 'removed' || !roots[0]) return undefined
      // In a folder of its own, or with a pull request bound, the work is its own; in a shared folder only a session the
      // changes record says changed files may hold it.
      const own =
        (task.worktree !== undefined && !task.worktree.removed) || task.sessionFolder === true || current.prOf(sessionId) !== undefined
      const holds = own || (await changeRoutes.changed(sessionId).catch(() => false))
      // A Code session that got 通用's private context is private too, and is shown only beside other private sessions.
      return {
        folder: roots[0].path,
        updatedAt: task.updatedAt,
        holds,
        ...(current.agentPrivate(sessionId) ? { private: true } : {}),
      }
    }
    const boardDelivery = new BoardDelivery({ log, changed: sessionId => refresh(sessionId), target: deliveryTarget })
    const workItems = await WorkItemStore.open(dataDir, { now })
    startupCleanup.push(() => workItems.flush())
    const workThreads = await WorkThreadStore.open(dataDir, { now })
    // Only against a 待办 file read whole: a missing one (moved away after a refusal to start) says nothing of which
    // threads lost their 待办, and pruning then would delete every thread.
    if (workItems.fromFile) await workThreads.prune(itemId => workItems.get(itemId) !== undefined)
    startupCleanup.push(() => workThreads.flush())
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
      // Settings only, never a key: a draft's options for a service's model follow from what was declared for it.
      services: () =>
        usableProviders().flatMap(provider => {
          const service = gatewayService(provider.id)
          return service
            ? [
                {
                  providerId: provider.id,
                  kind: service.kind,
                  models: service.models,
                  ...(service.modelCapabilities ? { modelCapabilities: service.modelCapabilities } : {}),
                },
              ]
            : []
        }),
      queueOf: sessionId => {
        const waiting = modelScheduler.queueOf(sessionId)
        if (!waiting) return undefined
        // A service's name only while its own place is what is waited for; the Host's own limit has no name.
        return waiting.providerId === undefined ? {} : { service: effectiveProvider(waiting.providerId)?.name ?? '模型服务' }
      },
      // The Host's own counts, never the driver's: questions from the question store, approvals from the Host's list.
      board: (summary, record) =>
        boardPlace(summary, {
          questions: questions.view(summary.id).length,
          approval: approvalSessions().has(summary.id),
          ...(record.attended ? { attended: record.attended } : {}),
          ...(record.pr ? { pr: { ...(boardDelivery.prState(summary.id) ? { state: boardDelivery.prState(summary.id)! } : {}) } } : {}),
          delivery: boardDelivery.local(summary.id),
        }),
      itemOf: sessionId => {
        const item = workItems.itemOf(sessionId)
        if (!item || !hub) return undefined
        if (!itemIsPrivate(item, id => hub!.agentPrivate(id))) return item.id
        workItems.notePrivate(item.id, log)
        // A session that is not private, in a private 待办, would name the 待办 to devices that may not read it.
        return hub.agentPrivate(sessionId) ? item.id : undefined
      },
      // A private session leaving by deletion must leave its 待办 private: written before the session goes.
      beforeRemove: async (sessionId, isPrivate) => {
        const item = workItems.itemOf(sessionId)
        if (item && isPrivate && !item.private) await workItems.markPrivate(item.id)
      },
    })
    hub = harnessHub
    const attachmentStore = await AttachmentStore.open(dataDir, { now, deferPrune: true })
    const attachmentUploads = await AttachmentUploads.open(dataDir, attachmentStore, { now })
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
        if (
          error instanceof AppError
          && ['workspace-changed', 'workspace-disabled', 'worktree-removed', 'worktree-removing'].includes(error.code)
        )
          return 'removed'
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
        if (!harness || harness.status !== 'ready') throw new AppError(409, 'file-harness-unavailable', '当前 Harness 不可用，请重新选择')
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
      if (!harness || harness.status !== 'ready') throw new AppError(409, 'harness-unavailable', '当前 Harness 不可用。')
      const declared = harness.attachments
      const limits = {
        fileBytes: isLocalListener(caller.connection.listener) ? ATTACHMENT_FILE_LIMIT : ATTACHMENT_REMOTE_LIMIT,
        imageBytes: ATTACHMENT_IMAGE_LIMIT,
      }
      if (harness.capabilities.models.owner === 'latch') {
        const choice = selected.model ?? defaultModelRef()
        if (choice) assertModel(choice)
        const provider = choice ? usableProviders().find(item => item.id === choice.providerId) : undefined
        // What the Harness reported when it started outranks its declaration here too (`Bridge.promptCapabilities`).
        const taken = harness.attachmentsReported ?? { images: declared?.images === true, text: declared?.text === true }
        const vision = Boolean(choice && provider?.modelCapabilities?.[choice.model]?.vision === true)
        const images = taken.images && vision
        return {
          images,
          text: taken.text,
          textBytes: Math.min(declared?.textBytes ?? 256 * 1024, 256 * 1024),
          ...limits,
          ...(!images ? { reason: taken.images ? '当前模型不能看图片。' : '这个 Harness 不接收图片。' } : {}),
        }
      }
      const agent = config.settings().agents.find(item => item.id === selected.harnessId)
      if (agent || harness.offer) {
        const reported = reportedAttachments(harness)
        const images = reported?.images === true,
          text = reported?.text === true
        return {
          images,
          text,
          textBytes: 25 * 1024 * 1024,
          ...limits,
          ...(!reported
            ? {
                reason: '发出第一条消息后可添加文件',
                reasonDetail: '这个 Harness 还没启动过，还不知道它接收哪些文件。也可以先在 设置 › Harness 里测试启动。',
              }
            : !images && !text
              ? { reason: '这个 Harness 不接收图片和文件。' }
              : !images
                ? { reason: '这个 Harness 不接收图片。' }
                : !text
                  ? { reason: '这个 Harness 只接收图片。' }
                  : {}),
        }
      }
      // A plugin Harness that reports what it took when it started (`Bridge.promptCapabilities`) is held to that.
      const taken =
        harness.attachmentsReported ?? (declared ? { images: declared.images === true, text: declared.text === true } : undefined)
      return {
        images: taken?.images === true,
        text: taken?.text === true,
        textBytes: Math.min(declared?.textBytes ?? 256 * 1024, 25 * 1024 * 1024),
        ...limits,
        ...(!taken?.images && !taken?.text ? { reason: '这个 Harness 不接收图片和文件。' } : {}),
      }
    }
    /**
     * What an agent said it takes when it last started for its current definition: a session or a read before one, else
     * 测试启动 of that same definition. Undefined until one of them ran.
     */
    function reportedAttachments(harness: HarnessInfo): { images: boolean; text: boolean } | undefined {
      if (harness.attachmentsReported) return harness.attachmentsReported
      const agent = config.settings().agents.find(item => item.id === harness.id)
      const probe = agent && agent.probedDefinitionHash === definitionHash(agent) ? agent.lastProbe : undefined
      if (!probe || probe.status === 'failed') return undefined
      return { images: probe.capabilities.images === true, text: probe.capabilities.embeddedContext === true }
    }
    const attachmentRoutes = createAttachmentRoutes<Caller>({
      store: attachmentStore,
      uploads: attachmentUploads,
      now,
      audit,
      actorOf,
      authorize: requireScope,
      recheck,
      capabilities: attachmentCapabilities,
      unused: (caller, reserved) => unusedReservations(caller.device!.id, reserved),
      busy: (caller, requestId) => reservationBusy(caller.device!.id, requestId),
      limit: caller => limits.classC.take(caller.device!.id),
      sessionAccess: async (caller, id) => {
        requireScope(caller, 'view')
        await assertSessionAccess(caller, id)
        return hub!.detail(id)
      },
    })
    /**
     * Of a device's reserved uploads, those the Host proves now that nothing needs, by the rules of the startup cleanup
     * (`pruneAbandonedClaims`): no request carrying them is on its way or was accepted in this run, and the session it was
     * for is listed, not running, and has no message naming the upload or sent by that request. A new session's request
     * names no session, so every session must be listed and read: any Harness that failed to list, is starting or turned
     * off keeps them all, since its sessions might hold that message.
     */
    /**
     * Whether a listing holds every session there is: compared with what is configured, not only with what mounted. Every
     * saved Agent (an Agent turned off lists nothing), every Harness of an enabled plugin, and every applied plugin asset
     * must be mounted and listed; an asset turned off, held after an update or that failed to load, and any built-in
     * plugin turned off, might own sessions nobody listed.
     */
    function wholeListing(listing: { complete: boolean; listed: ReadonlySet<string> }): boolean {
      if (!listing.complete) return false
      const settings = config.settings()
      if (settings.plugins.disabled.length) return false
      if (settings.agents.some(agent => !listing.listed.has(agent.id))) return false
      if (registry.harnesses().some(driver => !listing.listed.has(driver.id))) return false
      return pluginAssets
        .list()
        .every(
          record =>
            !record.appliedBundle
            || (record.enabled
              && !heldPlugins.isHeld(record.id)
              && assetPluginIds.has(record.id)
              && pluginInfo(record.id)?.enabled === true),
        )
    }

    async function migrateAgentChats(caller: Caller, listing?: Awaited<ReturnType<HarnessHub['listTasksProven']>>): Promise<void> {
      const actor = agentAccess(caller)
      if (!customAgents.needsChatMigration()) return
      const current = listing ?? (await hub!.listTasksProven())
      actor.authorize()
      if (!wholeListing(current)) return
      await customAgents.migrateChats(current.tasks, actor.authorize)
      for (const [owner, chat] of Object.entries(customAgents.chats())) {
        if (chat.state === 'ready') void automations?.adoptResults(owner, chat.sessionId).catch(() => log('聊天中的定时成果卡片带入失败'))
      }
    }

    function restrictChatRemoval(id: string): void {
      const owner = hub!.agentOf(id)?.customAgentId ?? (hub!.generalChatOf(id) ? GENERAL_AGENT_ID : undefined)
      if (!owner || hub!.automationOf(id)) return
      const chat = customAgents.chats()[owner]
      if (!chat && (owner === GENERAL_AGENT_ID || customAgents.list().some(agent => agent.id === owner)))
        throw new AppError(503, 'agent-chat-history-unknown', '旧会话尚未核对完成，请稍后再试。')
      if (chat?.state === 'starting') throw new AppError(409, 'agent-chat-starting', '第一条消息仍在确认，请确认聊天后再管理历史。')
      if (chat?.state === 'ready' && chat.sessionId === id)
        throw new AppError(409, 'agent-chat-retained', '这个 Agent 的聊天不能归档或删除。')
    }
    /** A create, prompt or queued prompt with this request ID is on its way, was accepted in this run, or waits in a queue. */
    function reservationBusy(deviceId: string, requestId: string): boolean {
      return (
        startRequests.has(`${deviceId}:${requestId}`)
        || turnRequests.some(key => key.endsWith(`:${deviceId}:${requestId}`))
        // A queue's receipt of the same request: it may be sent from the queue later.
        || promptQueues.knowsRequest(deviceId, requestId)
      )
    }
    async function unusedReservations(deviceId: string, reserved: ReturnType<AttachmentStore['reserved']>): Promise<ReadonlySet<string>> {
      const unused = new Set<string>()
      const quiet = reserved.filter(item => !reservationBusy(deviceId, item.requestId))
      if (!quiet.length) return unused
      const listing = await hub!.listTasksProven()
      const { tasks } = listing
      const everyHarness = wholeListing(listing)
      const details = new Map<string, TaskDetail | null>()
      const read = async (id: string) => {
        if (!details.has(id)) details.set(id, await hub!.detail(id).catch(() => null))
        return details.get(id)!
      }
      const needs = (detail: TaskDetail, item: (typeof reserved)[number]) =>
        detail.messages.some(
          message => message.requestId === item.requestId || message.attachments?.some(ref => ref.id === item.id) === true,
        )
      for (const item of quiet) {
        if (item.sessionId !== undefined) {
          const task = tasks.find(task => task.id === item.sessionId)
          if (!task || task.status === 'running' || task.status === 'waiting-approval') continue
          const detail = await read(task.id)
          if (detail && !needs(detail, item)) unused.add(item.id)
          continue
        }
        if (!everyHarness || tasks.some(task => task.status === 'running' || task.status === 'waiting-approval')) continue
        let named = false
        for (const task of tasks) {
          const detail = await read(task.id)
          if (!detail || needs(detail, item)) {
            named = true
            break
          }
        }
        if (!named) unused.add(item.id)
      }
      return unused
    }
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
    const customization = await CustomizationStore.open(dataDir, { now, log })
    const shortcuts = await ShortcutsStore.open(dataDir, { now, log, known: id => devices.get(id) !== undefined })
    const modelUsageRoutes = createModelUsageRoutes<Caller>({
      ledger: usageLedger,
      turns: turnLog,
      store: modelSpend,
      meter: modelMeter,
      now,
      authorize: requireScope,
      recheck,
      seesAgents: caller => !!caller.device && devices.get(caller.device.id)?.dataScope === 'all',
      requireAgentData,
      sessions: () => harnessHub.listTasks(),
      projects: () => new Set(['default', ...config.settings().workspaces.map(record => record.id)]),
      sessionVisible: (summary, seesAgents) =>
        harnessHub.ownerOf(summary.id) !== undefined && (seesAgents || (!privateSession(summary) && !harnessHub.agentPrivate(summary.id))),
      models: providerId => effectiveProvider(providerId)?.models,
      agentModels: agentId => {
        // 通用 has no model of its own.
        const model = customAgents.list().find(agent => agent.id === agentId)?.model
        const service = model && effectiveProvider(model.providerId)
        return service && model ? [{ providerId: model.providerId, model: model.model }, ...(service.fallbacks?.[model.model] ?? [])] : []
      },
      hasModel: (providerId, model) => effectiveProvider(providerId)?.models.includes(model) === true,
      hasService: providerId => effectiveProvider(providerId) !== undefined,
      hasAgent: agentId => agentId === GENERAL_AGENT_ID || customAgents.list().some(agent => agent.id === agentId),
      changed: () => refresh(),
      actorOf,
      audited,
      auditFailed,
    })
    /**
     * Everything Latch keeps for a session, removed the same way by every delete (one, or a batch of archived ones): the
     * harness's record (an ACP agent is asked to delete its own copy only where it offers that, never for an imported
     * session; docs/HARNESSES.md), queued input, questions, attachments, file references and the session's summary;
     * `sessionDeleted` then removes its change snapshots, review notes and page data. The worktree stays, marked private.
     */
    async function removeSessionRecords(id: string): Promise<void> {
      memoryRefusals.delete(id)
      await keepWorktreePrivacy(id)
      await harnessHub.remove(id)
      await promptQueues.forgetSession(id)
      await questions.forgetSession(id)
      fileRoutes.forgetSession(id)
      await attachmentStore.removeTask(id).catch(() => logNoted('cleanup-failed', {}, '未能清理已删除会话的附件'))
      await fileReferences.remove(id).catch(() => logNoted('cleanup-failed', {}, '未能清理已删除会话的文件引用记录'))
      summaries.delete(id)
      refresh()
    }
    const sessionRoutes = createSessionRoutes<Caller>({
      templates: templateStore,
      changed: () => refresh(),
      list: async () => (await harnessHub.listTasks()).map(questionSummary),
      detail: id => harnessHub.detail(id),
      patch: (id, patch) => {
        if (patch.archived) {
          restrictChatRemoval(id)
          memoryRefusals.delete(id)
        }
        return harnessHub.updateMeta(id, patch)
      },
      remove: async id => {
        restrictChatRemoval(id)
        await removeSessionRecords(id)
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
    const modelGateway = new ModelGatewayServer({
      service: gatewayService,
      fetchFor: providerFetchFor,
      log,
      queue: modelRequests,
      scheduler: modelScheduler,
      fallback: modelFallback,
      meter: modelMeter,
    })
    await modelGateway.start()
    startupCleanup.push(() => modelGateway.close())
    const requiredHarness = options.harnessId ?? STANDARD
    if (!registry.harnesses().some(driver => driver.id === requiredHarness)) {
      throw new AppError(409, 'harness-unavailable', `请先配置并启用 Harness ${requiredHarness}`)
    }
    for (const driver of registry.harnesses()) await mount(driver, driver.id === requiredHarness)
    await questions.reconcile(id => harnessHub.detail(id))
    if (attachmentStore.hasDrafts()) {
      // Only sessions a mounted Harness listed and whose messages were read here: one whose Harness is off or failed to
      // list is absent, so its reserved drafts are kept.
      const listed = new Map<string, ReadonlySet<string>>()
      for (const task of await hub!.listTasks()) {
        const refs = (await hub!.detail(task.id)).messages.flatMap(message => message.attachments ?? [])
        if (refs.length) await attachmentStore.recoverSession(task.id, refs)
        listed.set(task.id, new Set(refs.map(ref => ref.id)))
      }
      await attachmentStore.pruneAbandonedClaims(listed)
    }
    await attachmentStore.prune()

    let revision = 0
    const streams = new Map<ServerResponse, EventStream>()
    const deltaCache = new TaskDeltaCache()
    const nativeReplay = new NativeReplay(instanceId)
    const pendingTasks = new Map<string, number>()
    const summaries = new Map<string, string>()
    // One decision per approval at a time, so a retried request sees the first one's outcome.
    const decisionLocks = new Map<string, Promise<void>>()
    // One answer per cancel request at a time, so a copy sent while the first is settling gets the same receipt.
    const cancelFlights = new Map<string, Promise<CancelReceipt>>()
    const traffic = new TrafficMeter(now)
    // Frames are shared only within one content projection; restricted events have a separate identity.
    const frames = new WeakMap<ChangeEvent | TaskStateEvent, string>()
    const workEvents = new WeakMap<TaskStateEvent, TaskStateEvent>()
    const filesEvents = new WeakMap<TaskStateEvent, TaskStateEvent>()
    // List hints about a private session: only a device that may read it hears them.
    const privateHints = new WeakSet<ChangeEvent | TaskStateEvent>()
    let pendingGlobal = false
    /** Something only devices with the full data scope may hear of changed (a private 待办): a refresh just for them. */
    let pendingPrivate = false
    let eventTimer: ReturnType<typeof setTimeout> | undefined
    let flushing = false
    let changes: Promise<void> = Promise.resolve()
    const agentProbes = new AgentProbes({ root: runtime.tmpRoot, dataDir, now })
    startupCleanup.push(() => agentProbes.close())
    /** The audit records of a queue item sent at once, until it is sent or refused (then marked `action.failed`). */
    const queueAudits = new Map<string, number[]>()
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
        const seq = await audited({
          action: 'task.prompt.queued',
          actor: { deviceId: actor.deviceId, listener: actor.listener, via: 'http' },
          detail: { sessionId, itemId },
        })
        if (seq !== undefined) queueAudits.set(itemId, [seq])
        if (queueAudits.size > 1024) queueAudits.delete(queueAudits.keys().next().value!)
      },
      dropped: (actor, _sessionId, itemId) => {
        const seqs = queueAudits.get(itemId) ?? []
        queueAudits.delete(itemId)
        for (const refSeq of seqs)
          void audit
            .append({
              action: 'action.failed',
              actor: { deviceId: actor.deviceId, listener: actor.listener, via: 'http' },
              detail: { refSeq },
            })
            .catch(error => logNoted('audit-write-failed', { error: error }, `审计记录写入失败：${errorText(error)}`))
      },
      send: async (actor, sessionId, input) => {
        await checkQueuedPrompt(actor, sessionId, input.model, input.binding)
        if (input.itemId) {
          const seq = await audited({
            action: 'task.prompt.sent',
            actor: { deviceId: actor.deviceId, listener: actor.listener, via: 'http' },
            detail: { sessionId, itemId: input.itemId },
          })
          if (seq !== undefined) queueAudits.set(input.itemId, [...(queueAudits.get(input.itemId) ?? []), seq])
        }
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
        if (input.itemId) queueAudits.delete(input.itemId)
        // Only now is it the person's message in the session; a withdrawn one never gets here.
        await rememberFromPerson(
          { deviceId: actor.deviceId, actor: { deviceId: actor.deviceId, listener: actor.listener, via: 'http' } },
          sessionId,
          input.text,
          input.requestId,
        )
      },
      changed: id => refresh(id),
    })
    startupCleanup.push(() => promptQueues.close())
    const configRequests = new ConfigRequests(harnessHub.receipts, now)
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
        .catch(error => logNoted('audit-write-failed', { error: error }, `审计记录写入失败（host.update-window）：${errorText(error)}`))
    }
    startupCleanup.push(() => clearTimeout(commitTimer))
    /** Session starts and turns by device and request ID: in flight, their outcome is not known yet; accepted, a retry gets its answer. */
    const startRequests = new RequestRecords()
    const turnRequests = new RequestRecords()
    /** Turns accepted, by session, device and request, with what was sent: see `sendPromptChecked`. */
    const turnReceipts = new TurnReceipts()
    /** What a turn's retry must repeat to be the same request. */
    const turnBodyHash = (input: z.infer<typeof queuedPromptSchema>) =>
      sha256Hex(
        canonicalJson({
          prompt: input.prompt,
          ...(input.model ? { model: input.model } : {}),
          ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
          ...(input.fileRefs?.length ? { fileRefs: input.fileRefs } : {}),
          ...(input.freshContext ? { freshContext: true } : {}),
        }),
      )
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
      repositoryHolds,
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
      board: boardDelivery,
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
        workspaceFolder: terminalWorkspaceFolder,
        checkWorkingDirectory: cwd => {
          if (worktrees.removingWithin(cwd)) throw new AppError(409, 'worktree-removing', '正在移除这个工作树，不能打开终端。')
        },
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
    // A command found too old after a client read the catalog: clients read it again.
    onVersionChange(() => hub?.changed())
    // Read before the first catalog, so that a client never starts with a Harness too old to run as ready.
    // Only programs this Mac confirmed are run to read their versions.
    if (options.loginPrograms)
      await recheckVersions(
        config.settings().agents.filter(agent => agent.enabled && versionReadable(agent)),
        VERSION_RECHECK_MS,
      )
    const historyImports = new HistoryImports(routeContext, await HistoryReceipts.open(dataDir), {
      project: id => savedProject(id),
      async assertProjectUsable(id) {
        const record = savedProject(id)
        if (!record) throw new AppError(409, 'workspace-unavailable', '找不到所选项目')
        await assertWorkspaceUsable(record)
      },
      startText: (caller, { requestId, seed, harnessId, workspaceId, title, privateFrom }, res) =>
        // A rebuilt record came from outside Latch: what the new session proposes is external.
        startSession(
          caller,
          { requestId, prompt: '', seed, harnessId, workspaceId, mode: 'agent', title, privateFrom, outsideStart: true },
          res,
        ),
    })
    startupCleanup.push(() => historyImports.close())
    const {
      native: nativeRoutes,
      terminal: terminalRoutes,
      agentLogin: agentLoginRoutes,
      apps: appRoutes,
      changes: changeRoutes,
      customization: customizationRoutes,
      workProposals: workProposalRoutes,
      routes,
    } = createRoutes(routeContext, {
      customization: { store: () => customization, auditFailed },
      shortcuts: { store: () => shortcuts },
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
        identity,
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
              forgetStream(stream)
            }
          terminalRoutes.endDisallowedStreams()
        },
      },
      terminals,
      terminalWorkspaceOperation: (workspaceId, caller, operation) => projectOperation(workspaceId, caller, 'run', operation),
      agents: {
        agents: customAgents,
        // Only once it is really gone: a deletion still being confirmed keeps its budget.
        removed: async id => {
          if (customAgents.list().some(agent => agent.id === id)) return
          await modelSpend.forget('agent', id).catch(error => log(`清除预算失败：${errorText(error)}`))
        },
        plans: () => agentPlans,
        automations: () => automations,
        access: agentAccess,
        sessions: () => hub!.listTasks(),
        plugins: enabledPluginInfo,
        detail: id => hub!.detail(id),
        sessionFiles: id => changeRoutes.sessionFiles(id),
        computer: () => computer,
        home: async owner => {
          const record = owner === GENERAL_AGENT_ID ? customAgents.general() : customAgents.get(owner)
          const path = join(workspaceRoot, 'helpers', owner)
          if (!record.home) return { owner, path, available: false, reason: '第一次开始话题时建立' }
          try {
            if (record.home !== `helpers/${owner}` || !(await ownFolders.verify(path))) throw workspaceChanged()
            await assertHelperHome(path)
            return { owner, path: await realpath(path), available: true }
          } catch {
            return { owner, path, available: false, reason: '工作位置无法确认，原文件已保留；请在这台 Mac 上检查' }
          }
        },
        warm: (owner, caller) => warmAgentChat(owner, caller),
      },
      automations: {
        automations: () => automations,
        access: agentAccess,
        proposalCheck(owner, proposalId, replay) {
          const found = customAgents.proposals(owner).find(row => row.id === proposalId)
          if (found?.kind !== 'schedule') throw new AppError(404, 'agent-proposal-not-found', '找不到这条定时提议。')
          // Only a retry of the request that saved it finds it saved; nothing else saves it twice.
          if (found.state === 'dismissed' || (found.state === 'saved' && !replay))
            throw new AppError(409, 'agent-proposal-decided', '这条提议已经处理过了。')
        },
        async proposalSaved(owner, proposalId, input, actor) {
          const marked = await customAgents.scheduleSaved(owner, proposalId, input, actor)
          refresh()
          return marked
        },
      },
      handoffs: { handoffs: () => handoffs },
      workItems: {
        store: workItems,
        start: (req, caller, body, res, { withoutPrivateContext, privateFrom, outsideStart }) =>
          startPersonSession(req, caller, createTaskSchema.parse(body), res, withoutPrivateContext, { privateFrom, outsideStart }),
        projectExists: id => id === 'default' || savedProject(id) !== undefined,
        changed: itemChanged,
        threadRevision: id => workThreads.revisionOf(id),
        deleted: async id => {
          await workThreads.remove(id)
          await workProposalRoutes.itemDeleted(id)
        },
      },
      workProposals: {
        store: workItems,
        projectExists: id => id === 'default' || savedProject(id) !== undefined,
        harnessExists: id => hub?.info(id) !== undefined,
        // As `PATCH /tasks/:id`: the session must be readable by this device, and the change goes through its metadata.
        async changeSession(caller, sessionId, change) {
          checkPrivateSession(caller, sessionId, true)
          recheck(caller, 'run')
          await hub!.updateMeta(sessionId, change)
          checkPrivateSession(caller, sessionId, true)
        },
        itemChanged,
        changed: proposalChanged,
      },
      workThreads: {
        threads: workThreads,
        items: workItems,
        // Never queued or steered: a queued message proposes from its whole text when it is sent.
        async deliver(caller, sessionId, input, agent) {
          const parsed = queuedPromptSchema.safeParse(input)
          if (!parsed.success) throw new AppError(400, 'post-invalid', '这条发言连同引用太长，没有发出。')
          // The quoted replies are model output: any session that can propose marks its context as holding outside content.
          const sent = await sendPrompt(caller, sessionId, parsed.data, false, agent !== undefined || hub!.workProposalsOf(sessionId))
          if (agent && typeof sent !== 'object' && sent !== 'replayed')
            await rememberFromPerson({ deviceId: caller.device.id, actor: actorOf(caller) }, sessionId, agent.remember, input.requestId)
        },
        // Keyed by device and request, so a proposal already made for it is not made again.
        async remember(caller, sessionId, text, requestId) {
          await rememberFromPerson({ deviceId: caller.device.id, actor: actorOf(caller) }, sessionId, text, requestId)
        },
        async agentChat(caller, customAgentId) {
          if (customAgentId !== GENERAL_AGENT_ID && !customAgents.list().some(agent => agent.id === customAgentId)) return undefined
          await migrateAgentChats(caller)
          const chat = customAgents.chats()[customAgentId]
          if (!chat) throw new AppError(503, 'agent-chat-history-unknown', '旧会话尚未核对完成，请稍后再试。')
          return chat.state === 'ready' ? { state: 'ready', sessionId: chat.sessionId } : { state: chat.state }
        },
        agentName: id => (id === GENERAL_AGENT_ID ? '通用' : (customAgents.list().find(agent => agent.id === id)?.name ?? 'Agent')),
        agentAccess: caller => {
          agentAccess(caller, true)
        },
        changed: item => itemChanged(item, []),
      },
      history: { history: () => historyImports },
      reviewNotes: {
        notes: () => reviewNotes,
        async send(caller, id, input) {
          const answer = await sendPrompt(caller, id, input)
          // A queue that was empty with the run already over sends at once: the message is then in the session.
          return typeof answer === 'object' && 'queued' in answer.queued ? { queueId: answer.queued.queued.id } : {}
        },
        queueItem: (id, by) => promptQueues.lookup(id, by),
        // `${session}:${device}:${requestId}`: any device's prompt with this request ID on its way or accepted.
        promptHeld: (id, requestId) => turnRequests.some(key => key.startsWith(`${id}:`) && key.endsWith(`:${requestId}`)),
      },
      ...(options.gitDelivery ? { git: options.gitDelivery } : {}),
      mcp: {
        store: mcpStore,
        resolveCommand,
        forbiddenRoots: () => [
          dataDir,
          codeRoot,
          workspaceRoot,
          ...config.settings().workspaces.flatMap(record => record.folders.map(folder => folder.path)),
        ],
        testForbiddenRoots: async () => [
          dataDir,
          codeRoot,
          workspaceRoot,
          worktreesDir,
          agentsDir,
          ...config.settings().workspaces.flatMap(record => record.folders.map(folder => folder.path)),
          ...(await hub!.listTasks()).flatMap(task => sessionFolders(task, workspaceRoot)),
        ],
        commandDirectories: () => [...(options.commandDirectories?.() ?? [])],
        projectFolders: workspaceId =>
          config
            .settings()
            .workspaces.find(record => record.id === workspaceId)
            ?.folders.map(folder => ({ id: folder.id, path: folder.path })),
        tmpRoot: runtime.tmpRoot,
        revoke: serverId => {
          toolGateway?.revokeMcp(serverId)
          mcpRemote.revoke(serverId)
        },
        // A remote server is judged as a model-service address is: the allowance it needs is in its own confirmation,
        // and one the policy already has (a model service's, the process's) is not asked for again.
        egressFor: async url => {
          const need = await inspectEgress(url)
          if (need.allowance === 'never') throw egressDenied(need.target)
          if (need.allowance === 'none') return { target: need.target }
          if (policy.get().hostEgressAllow.includes(need.target) || egressExtra.includes(need.target)) return { target: need.target }
          return {
            target: need.target,
            egress: need.target,
            ...(need.reason === 'loopback' || need.reason === 'local-interface' ? { local: true } : {}),
          }
        },
        allowEgress: async (caller, target, stepup) => {
          const undo = await addDestination(
            caller,
            { origin: '', address: '', hostPort: target, addAddress: false, egress: target },
            stepup,
          )
          return async () => {
            const res = { headersSent: true, setHeader: () => {} } as unknown as ServerResponse
            await undo(res)
          }
        },
        allowanceOf: serverId => {
          const record = mcpStore.get(serverId)
          if (!record || record.transport !== 'http') return undefined
          const target = hostPortOf(record.url)
          if (!target || !policy.get().hostEgressAllow.includes(target) || egressExtra.includes(target)) return undefined
          const others = [
            // Another server's address, or the authorization server one logs in at.
            ...mcpStore
              .records()
              .flatMap(item =>
                item.transport === 'http' && item.id !== serverId ? [item.url, ...(item.oauth ? [item.oauth.issuer] : [])] : [],
              ),
            ...config.providers().map(provider => provider.baseURL),
          ]
          return others.some(url => hostPortOf(url) === target) ? undefined : target
        },
        removeAllowance: async (caller, target, res) => {
          const current = policy.get()
          if (!current.hostEgressAllow.includes(target)) return
          const lowered = structuredClone(current)
          lowered.hostEgressAllow = current.hostEgressAllow.filter(item => item !== target)
          const { audited } = await policy.update(lowered, actorOf(caller), 'none')
          if (!audited && !res.headersSent) res.setHeader('x-latch-audit', 'failed')
        },
        testRemote: async record => {
          const session = new McpRemoteSession({ ...remoteOptions(record), timeoutMs: TEST_TIMEOUT_MS })
          try {
            const tools = await session.listTools(AbortSignal.timeout(TEST_TIMEOUT_MS))
            return {
              status: 'ok' as const,
              tools: tools
                .map(tool => tool.name)
                .filter(keptToolName)
                .slice(0, 256),
            }
          } catch (error) {
            const reason = remoteFailure(error)
            return { status: 'failed' as const, reason: reason === 'protocol' ? 'protocol' : reason }
          } finally {
            await session.close()
          }
        },
        oauth: mcpOAuth,
        unusedAllowance: address => {
          const target = hostPortOf(address)
          if (!target || !policy.get().hostEgressAllow.includes(target) || egressExtra.includes(target)) return undefined
          const used = [
            ...mcpStore
              .records()
              .flatMap(item => (item.transport === 'http' ? [item.url, ...(item.oauth ? [item.oauth.issuer] : [])] : [])),
            ...config.providers().map(provider => provider.baseURL),
          ]
          return used.some(url => hostPortOf(url) === target) ? undefined : target
        },
        ...(options.computerDriver ? { computer: options.computerDriver } : {}),
        ...(options.xcodeBridge ? { xcode: options.xcodeBridge } : {}),
      },
      simulators,
      browser: {
        broker: browserBroker,
        async readSession(caller, id) {
          requireScope(caller, 'view')
          checkPrivateSession(caller, id)
          const detail = await hub!.detail(id)
          recheck(caller, 'view')
          privateAccess(caller, detail.summary)
          return detail
        },
      },
      apps: {
        assets: () => pluginAssets,
        builtModule: (pluginId, revision, appId) => appBuilds.module(pluginId, revision, appId),
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
          ?? (caller.device?.scopes.includes('admin')
          && isLocalListener(caller.connection.listener)
          && presetsToOffer().some(offer => offer.id === id)
            ? presetRoute(id)
            : undefined),
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
    /** The Agent a session belongs to in 我的 Agent, from the Host's own records: one of yours, `general`, or none. */
    function sessionOwner(sessionId: string): string | undefined {
      return hub?.agentOf(sessionId)?.customAgentId ?? (hub?.generalChatOf(sessionId) ? GENERAL_AGENT_ID : undefined)
    }
    /**
     * A driver's `propose_memory`. The owner is the session's, from the Host's records; a first turn may ask before its
     * start has been recorded, so it waits a little for that. Kept pending for the person, never saved here.
     */
    async function proposeFromAgent(driver: HarnessDriver, input: MemoryProposalInput): Promise<void> {
      const { owner, external } = await proposingSession(driver, input)
      await customAgents.propose({
        owner,
        key: `agent:${input.sessionId}:${input.key}`,
        content: input.content,
        ...(input.reason ? { reason: input.reason } : {}),
        origin: 'agent',
        external,
        source: { sessionId: input.sessionId, ...(input.messageId ? { messageId: input.messageId } : {}) },
        actor: { listener: 'host' },
      })
      refresh()
    }
    /**
     * A driver's `propose_schedule`: through the same session check, caps, secret check, external mark and audit as a
     * memory proposal. Its plan is checked against the scheduler's own schema; refusals are in English, for the agent.
     * Nothing is created: the person opens it in the schedule editor and saves it there.
     */
    async function proposeScheduleFromAgent(driver: HarnessDriver, input: ScheduleProposalInput): Promise<void> {
      const { owner, external } = await proposingSession(driver, input)
      await customAgents.propose({
        owner,
        key: `agent:${input.sessionId}:${input.key}`,
        content: input.prompt,
        schedule: { name: input.name, plan: input.plan },
        origin: 'agent',
        external,
        source: { sessionId: input.sessionId, ...(input.messageId ? { messageId: input.messageId } : {}) },
        actor: { listener: 'host' },
      })
      refresh()
    }
    /**
     * A driver's `propose_todo`, `propose_todos` or `propose_card`, for a session the Host created with `workProposals`
     * and the driver owns (Code sessions, 我的 Agent's and 通用's alike). Who proposed it, whether it is private and
     * whether its turn may have read outside content come from the Host's records; the driver's word that it read nothing
     * counts only from Latch's own loops. Kept pending for the person: nothing is created, changed or started here.
     */
    async function proposeWorkFromAgent(driver: HarnessDriver, raw: WorkProposalInput): Promise<void> {
      const parsed = workProposalInputSchema.safeParse(raw)
      if (!parsed.success) throw new AppError(400, 'proposal-invalid', 'The proposal is not in the expected form.')
      const input = parsed.data
      const own = () => hub?.ownerOf(input.sessionId) === driver.id && hub.workProposalsOf(input.sessionId)
      for (let attempt = 0; !own() && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
      if (!own() || hub!.pageOriginOf(input.sessionId) || hub!.personalOf(input.sessionId))
        throw new AppError(409, 'proposal-session', 'This session cannot propose to the board.')
      const owner = sessionOwner(input.sessionId)
      const trusted = kindOf(driver) !== 'plugin'
      const external =
        input.external
        || !trusted
        // Nobody watched a scheduled run; a session started from outside content has it in its context from the start.
        || hub!.automationOf(input.sessionId) !== undefined
        || hub!.unattended(input.sessionId)
        || hub!.outsideStartOf(input.sessionId)
        || (owner !== undefined && customAgents.hasOutsideMemories(owner))
      await workProposalRoutes.intake(
        {
          sessionId: input.sessionId,
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(owner ? { customAgentId: owner } : {}),
          external,
          private: hub!.agentPrivate(input.sessionId),
          ...(hub!.projectOf(input.sessionId) ? { projectId: hub!.projectOf(input.sessionId)! } : {}),
        },
        { key: input.key, ...(input.todo ? { todo: input.todo } : {}), ...(input.card ? { card: input.card } : {}) },
      )
      refresh(input.sessionId)
    }
    /**
     * A driver's `recall_memory`, read-only: the same session check as a proposal, then only that owner's confirmed
     * memories, bounded. The query is counted in the owner's activity; a count that cannot be written fails nothing.
     */
    async function recallFromAgent(driver: HarnessDriver, input: MemoryRecallInput): Promise<MemoryRecallResult> {
      const { owner } = await proposingSession(driver, { sessionId: input.sessionId, external: false })
      const result = customAgents.recall(owner, input.query, input.limit)
      await recalledByAgent(owner, { sessionId: input.sessionId, ...(input.messageId ? { messageId: input.messageId } : {}) })
      return result
    }
    async function recalledByAgent(owner: string, turn: { sessionId: string; messageId?: string }): Promise<void> {
      await customAgents.noteRecall(owner, turn).catch(error => log(`记忆查询没有计入动态：${errorText(error)}`))
    }
    /**
     * The owner of a session a driver proposes into, from the Host's records; a first turn may ask before its start has
     * been recorded, so it waits a little for that. A driver proposes only into its own sessions, of an Agent or 通用, on a
     * Harness the Host gives `proposals` to.
     */
    async function proposingSession(
      driver: HarnessDriver,
      input: Pick<MemoryProposalInput, 'sessionId' | 'external'>,
    ): Promise<{ owner: string; external: boolean }> {
      const own = () =>
        hub?.ownerOf(input.sessionId) === driver.id && hub.proposalsOf(input.sessionId) && sessionOwner(input.sessionId) !== undefined
      for (let attempt = 0; !own() && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
      const owner = own() ? sessionOwner(input.sessionId) : undefined
      const harness = hub?.info(driver.id)
      if (owner === undefined || !harness || !canPropose(harness))
        throw new AppError(409, 'agent-proposal-session', 'This session cannot propose.')
      // Only Latch's own loops can tell what a turn read; another driver's word that it read nothing is not taken.
      const trusted = kindOf(driver) !== 'plugin'
      // Nobody watched what a scheduled run read; the driver says so too, this covers a run it could not tell. A session
      // whose memories include material (imported, or from outside content, not yet 设为我说的) has it in its context.
      return {
        owner,
        external: input.external || !trusted || hub?.automationOf(input.sessionId) !== undefined || customAgents.hasOutsideMemories(owner),
      }
    }
    /**
     * The person's own 「记住…」 in a session of 我的 Agent: a proposal from their words, which they still save. Their
     * message goes to the Harness either way. Answers why nothing was kept, never with the text.
     */
    async function rememberFromPerson(
      person: { deviceId: string; actor: AuditActor },
      sessionId: string,
      prompt: string,
      requestId: string,
    ): Promise<string | undefined> {
      const content = rememberRequest(prompt)
      const owner = content === undefined ? undefined : sessionOwner(sessionId)
      if (content === undefined || owner === undefined || devices.get(person.deviceId)?.dataScope !== 'all') return undefined
      try {
        await customAgents.propose({
          owner,
          key: `user:${person.deviceId}:${requestId}`,
          content,
          origin: 'user',
          external: false,
          source: { sessionId, requestId },
          actor: person.actor,
        })
        refresh()
        return undefined
      } catch (error) {
        const reason = error instanceof AppError && error.status < 500 ? error.message : '没有记下：提议暂时无法保存。'
        // The turn row says it too, for a message sent from a queue, where no answer goes back to the person.
        const rows = (memoryRefusals.get(sessionId) ?? []).filter(row => row.requestId !== requestId)
        memoryRefusals.set(sessionId, [...rows, { requestId, reason }].slice(-8))
        refresh(sessionId)
        return reason
      }
    }
    /** The person's 「记住…」 the Host did not keep, per session, newest last; in memory only, never the text. */
    const memoryRefusals = new Map<string, Array<{ requestId: string; reason: string }>>()
    function requireAgentData(caller: Caller): void {
      requireDevice(caller)
      if (devices.get(caller.device.id)?.dataScope !== 'all')
        throw new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
    }
    function agentAccess(caller: Caller, write = false): AgentActor {
      requireScope(caller, write ? 'run' : 'view')
      const authorize = () => {
        recheck(caller, write ? 'run' : 'view')
        requireAgentData(caller)
      }
      authorize()
      return { actor: { ...actorOf(caller), deviceId: caller.device.id }, authorize }
    }
    /** 「它做过什么」, set once schedules and handoffs are open; until then no turn carries a digest. */
    let digestOf: ((owner: string) => AgentNote | undefined) | undefined
    const agentPlans = new AgentPlans({
      digest: owner => digestOf?.(owner),
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
      projectModel: (projectId, harnessId) => projectDefaultModel(projectId, harnessId),
      automationAllowed: id => {
        const level = hub!.levelOf(id)
        return !!level && levelAtMost(level, policy.get().unattended.maxLevel)
      },
      environment: projectId => ({
        policy: policy.hash(),
        workspace: canonicalWorkspace,
        ...(projectId ? { folders: savedProject(projectId)?.folders.map(folder => folder.path) ?? [] } : {}),
      }),
    })
    function providerExecutionRevision(record: ProviderRecord): string | undefined {
      // What a run executes: not the service's name, nor how many requests it takes at a time or where a failed request
      // may go next. Those are read as they are when a request is scheduled, and editing them replaces no plugin.
      const { name: _, maxConcurrent: _limit, fallbacks: _fallbacks, ...execution } = record
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
    /** Manual runs need the caller's current authority; background grants also need the unattended ceiling and activity. */
    function authorizeAutomation(deviceId: string, definition: AutomationConfig, trigger: 'schedule' | 'manual'): void {
      const device = devices.get(deviceId),
        current = policy.get()
      const harnessId = definition.customAgentId ? customAgents.get(definition.customAgentId).harnessId : 'standard'
      const level = hub!.levelOf(harnessId)
      if (
        !device
        || !devices.standsBehind(deviceId)
        || device.dataScope !== 'all'
        || !device.scopes.includes('run')
        || (trigger === 'schedule' && now() - Date.parse(device.lastSeenAt) > current.unattended.pauseAfterIdleDays * 86400000)
      )
        throw new AppError(403, 'automation-owner', '这台设备不能开启这个定时任务。')
      // The Harness's own level, not the device, is what keeps it from running unattended.
      if (trigger === 'schedule' && (!level || !levelAtMost(level, current.unattended.maxLevel)))
        throw new AppError(
          403,
          'automation-level',
          level ? `这个 Harness 是 ${level}，后台运行最高 ${current.unattended.maxLevel}。` : '这个 Harness 现在不可用，不能后台运行。',
        )
    }
    const automations = await Automations.open({
      dataDir,
      audit,
      now,
      plan: (definition, trigger) => agentPlans.automation(definition, trigger),
      authorize: authorizeAutomation,
      changed: () => refresh(),
      detail: id => hub!.detail(id),
      cancel: (id, runId) => hub!.cancel(id, runId ? { runId } : undefined),
      approvalTtlMs: () => policy.get().unattended.approvalTtlHours.standard * 3600000,
      /** The owner's interactive chat, and what the run said and touched; read when the run settles. */
      async resultContent(run) {
        const chat = customAgents.hasPending() ? undefined : customAgents.chats()[run.owner]
        const files = run.sessionId && run.detail ? await changeRoutes.sessionFiles(run.sessionId) : undefined
        return {
          ...(chat?.state === 'ready' ? { topicId: chat.sessionId } : {}),
          ...resultContent(run.outcome, run.detail, files, run.refused),
        }
      },
      async exists(id) {
        if (!hub) throw new Error('Sessions are not ready.')
        try {
          await hub.summary(id)
          return true
        } catch (error) {
          if (error instanceof AppError && error.status === 404) return false
          throw error
        }
      },
      resultsChanged: topics => {
        for (const topic of topics) refresh(topic)
        refresh()
      },
      async start({ requestId, automationId, title, prompt, projectId, plan, authorize }) {
        authorize()
        // In flight like any other start until it settles, so the install waits for it.
        refuseWhileUpdating('session')
        return tracked(startRequests, `automation:${automationId}:${requestId}`, () =>
          automationStart({ requestId, automationId, title, prompt, projectId, plan, authorize }),
        )
      },
    })
    async function automationStart({ requestId, automationId, title, prompt, projectId, plan, authorize }: AutomationStartInput) {
      return projectQueue(projectId ?? 'default', async () => {
        authorize()
        refuseWhileUpdating('session')
        const chosen = projectId ? savedProject(projectId) : undefined
        if (projectId && !chosen) throw new AppError(409, 'workspace-unavailable', '找不到所选项目')
        if (chosen) await assertWorkspaceUsable(chosen)
        const harness = hub!.info(plan.harnessId)
        if (!harness) throw new AppError(409, 'harness-unavailable', '这个 Harness 暂时不可用。')
        const modelRoute = plan.model && harness.capabilities.models.owner !== 'latch' ? modelRouteFor(harness, plan.model) : undefined
        const task: HubCreateInput = {
          requestId,
          prompt,
          harnessId: plan.harnessId,
          workspaceId: projectId ?? 'default',
          mode: plan.mode,
          ...(plan.model ? { model: plan.model } : {}),
          ...(modelRoute ? { modelRoute } : {}),
          ...(plan.config?.length ? { config: plan.config } : {}),
          automationId,
          initialTitle: title,
          ...(plan.agentContext ? { agentContext: plan.agentContext } : {}),
          // Only where memory and schedule proposals are already allowed (an Agent's schedule): all it proposes is external.
          ...(plan.agentContext?.proposals && canPropose(harness) ? { workProposals: true as const } : {}),
        }
        const folders = chosen?.folders.map(({ id, path }) => ({ id, path }))
        const own = !chosen
          ? await prepareHelperHome(plan.agentContext?.agent?.customAgentId ?? GENERAL_AGENT_ID, {
              actor: { listener: 'host', via: 'startup' },
              authorize,
            })
          : undefined
        const cwd = chosen?.folders[0].path ?? own?.path
        const configAudited = plan.config?.length ? { configHash: sha256Hex(canonicalJson(plan.config)) } : {}
        const routeAudited = modelRoute ? { providerId: modelRoute.providerId, routeHash: sha256Hex(canonicalJson(modelRoute)) } : {}
        /** A run nobody started by hand is still on record as a start, with what it runs. */
        const onRecord = async (): Promise<Pick<HubCreateInput, 'expectedLaunchHash'>> => {
          if (hub!.levelOf(plan.harnessId) !== 'L3') return {}
          const root = await realpath(cwd ?? workspaceRoot)
          const preview = await hub!.launchPreviewOf(
            plan.harnessId,
            root,
            folders ? { workspaceId: projectId!, folders } : undefined,
            modelRoute,
            plan.config,
          )
          const launchHash = preview?.launchHash ?? sha256Hex(canonicalJson({ harnessId: plan.harnessId, automationId }))
          await audited({
            action: 'task.l3.start-requested',
            actor: { listener: 'host', via: 'startup' },
            stepup: 'none',
            detail: { harnessId: plan.harnessId, launchHash, promptHash: sha256Hex(prompt), ...configAudited, ...routeAudited },
          })
          return { expectedLaunchHash: launchHash }
        }
        const started = await onRecord()
        const created = await (async () => {
          if (chosen) {
            authorize()
            return hub!.createTask({ ...task, ...started, cwd: chosen.folders[0].path, folders: folders! })
          }
          if (own) {
            await assertHelperHome(own.path)
            if (!(await ownFolders.verify(own.path))) throw workspaceChanged()
            authorize()
            return hub!.createTask({ ...task, ...started, cwd: own.path, sessionFolder: own.name })
          }
          authorize()
          return hub!.createTask({ ...task, ...started })
        })()
        if (started.expectedLaunchHash) {
          const mcpSetHash = await mcpSetHashOf(created.sessionId, plan.harnessId)
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
              ...configAudited,
              ...routeAudited,
              ...(mcpSetHash ? { mcpSetHash } : {}),
            },
          }).catch(() => {})
        }
        return created
      })
    }
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
      async checkNewTarget(target) {
        const id = target.harnessId ?? defaultHarnessId()
        await rereadOutdated(id)
        const harnessId = id,
          harness = hub!.info(harnessId)
        if (!harness || !hub!.has(harnessId)) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 未启用`)
        if (harness.status !== 'ready') {
          refuseOutdated(harnessId)
          throw new AppError(409, 'harness-unavailable', harness.statusMessage ?? `${harness.capabilities.display.label} 当前不可用`)
        }
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
            // The handed-over material is another session's output, not the person's words: what it proposes is external.
            outsideStart: true as const,
          },
          res,
        ),
      async send(caller, id, { requestId, prompt, fileRefs }) {
        // The handed-over material is not the person's words: in any session that can propose (an Agent's, 通用's, or a
        // Code session with the board's tools), what that context proposes from now on is external, as a thread's delivery.
        await sendPrompt(
          caller,
          id,
          { requestId, prompt, ...(fileRefs.length ? { fileRefs } : {}) },
          false,
          sessionOwner(id) !== undefined || hub!.workProposalsOf(id),
        )
      },
      listTasks: () => hub!.listTasks(),
      detail: id => hub!.detail(id),
      changed: () => refresh(),
    })
    digestOf = owner => {
      const owns = (sessionId: string) => hub?.agentOf(sessionId)?.customAgentId === owner
      return agentDigest({
        owner,
        now: now(),
        results: automations.results(),
        handoffs: handoffs.summaries({ has: owns }) ?? [],
        owns,
        party: sessionId => {
          if (sessionId === undefined) return '新会话'
          const other = hub?.agentOf(sessionId)?.customAgentId
          if (other) return customAgents.list().find(agent => agent.id === other)?.name ?? '已删除的 Agent'
          return hub?.generalChatOf(sessionId) ? '通用' : 'Code 会话'
        },
      })
    }
    startupCleanup.push(() => handoffs.close())
    const reviewNotes = await ReviewNotes.open({ dataDir, now, log })
    startupCleanup.push(() => reviewNotes.close())
    lifecycleListeners.on('sessionDeleted', ({ sessionId }) => handoffs.sessionDeleted(sessionId))
    // What a deleted session proposed and nobody decided goes with it, as does a change waiting for its card.
    lifecycleListeners.on('sessionDeleted', ({ sessionId }) => {
      void workProposalRoutes.sessionDeleted(sessionId).catch(error => log(`会话 ${sessionId} 删除后提议没有更新：${errorText(error)}`))
    })
    // A deleted session leaves its 待办; an archived one stays in it.
    lifecycleListeners.on('sessionDeleted', ({ sessionId }) => {
      if (!workItems.itemOf(sessionId)) return
      void workItems
        .dropSessions(new Set([sessionId]))
        .then(left => left.forEach(item => itemChanged(item, [])))
        .catch(error => log(`会话 ${sessionId} 删除后待办没有更新：${errorText(error)}`))
    })
    // A session that ended keeps no way to the browser tools, whatever process of it is still running.
    lifecycleListeners.on('sessionDeleted', ({ sessionId }) => toolGateway?.revokeSession(sessionId, 'deleted'))
    lifecycleListeners.on('sessionArchived', ({ sessionId }) => toolGateway?.revokeSession(sessionId, 'archived'))
    lifecycleListeners.on('sessionDeleted', ({ sessionId }) => {
      void automations.sessionDeleted(sessionId).catch(error => log(`会话 ${sessionId} 删除后定时结果没有更新：${errorText(error)}`))
    })
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
        logNoted('audit-write-failed', { error: error }, `审计记录写入失败（${event.action}）：${errorText(error)}`)
        if (!tolerant.headersSent) tolerant.setHeader('x-latch-audit', 'failed')
        return undefined
      }
    }

    /** Best effort: marks an audited intent whose commit then failed. */
    function auditFailed(refSeq: number | undefined, caller: Caller): void {
      if (refSeq === undefined) return
      void audit
        .append({ action: 'action.failed', actor: actorOf(caller), detail: { refSeq } })
        .catch(error => logNoted('audit-write-failed', { error: error }, `审计记录写入失败：${errorText(error)}`))
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

    /**
     * Whether a Harness definition's change runs another program, or the same one differently.
     */
    function runsDifferently(previous: AgentRecord, next: AgentRecord): boolean {
      return (
        previous.command !== next.command
        || canonicalJson(previous.args) !== canonicalJson(next.args)
        // Any variable added, changed or removed: removing `CODEX_PATH` or a `DISABLE_*` flag changes what runs too.
        || canonicalJson(previous.env) !== canonicalJson(next.env)
        // The command now resolves to another program than the one confirmed: saving it again confirms that one.
        || (previous.confirmedCommand !== undefined && resolveCommand(next.command) !== previous.confirmedCommand)
      )
    }

    /**
     * The local confirmation for a Harness definition's program (`harness.command.apply`): only from this Mac's desktop
     * app, and held back while a full-access session runs or waits, as every other one is. The sheet names the command
     * as the Host finds it; the variables' values are bound to the confirmation without being shown.
     */
    async function confirmHarnessCommand(
      req: IncomingMessage,
      caller: Caller,
      next: AgentRecord,
    ): Promise<{ stepup: StepupMethod; found: string | undefined }> {
      requireLocal(caller)
      const resolved = resolveCommand(next.command)
      // A preset's own command, found on PATH, is the program the person installed: it is bound to that path without a
      // confirmation, still only from this Mac and still not while a full-access session runs or waits. A path other than
      // the one this preset was last bound to (also before its definition was removed), or one found only in the extra
      // install directories, asks, as any custom command does.
      // Every path this preset's command was bound to: this definition's, the one kept after a removal, and those of other
      // definitions of the same preset (also ones saved before removals were kept).
      const settings = config.settings()
      const bound = [
        next.confirmedCommand,
        ...(settings.presetBindings ?? [])
          .filter(item => item.presetId === next.presetId && item.command === next.command)
          .map(item => item.path),
        ...settings.agents
          .filter(agent => agent.presetId === next.presetId && agent.command === next.command)
          .map(agent => agent.confirmedCommand),
      ].filter((path): path is string => path !== undefined)
      if (resolved && runsPresetCommand(next) && onPath(resolved) && bound.every(path => path === resolved)) {
        requireDevice(caller)
        await presence.assertNotHeldBack('harness.command.apply', devices.get(caller.device.id)?.scopes.includes('view') === true)
        return { stepup: 'preset', found: resolved }
      }
      const found = resolved ?? next.command
      const names = Object.keys(next.env).sort()
      const stepup = await confirm(
        req,
        caller,
        'harness.command.apply',
        {
          id: next.id,
          name: next.name,
          command: next.command,
          found,
          args: next.args,
          envNames: names,
          envHash: sha256Hex(canonicalJson(next.env)),
        },
        { form: 'harness.command.apply', slots: { command: found, harness: next.name } },
        [
          { label: '命令', value: found },
          { label: '参数', value: next.args.length ? next.args.join(' ') : '无' },
          { label: '环境变量', value: names.length ? names.join('、') : '无' },
          { label: 'Harness', value: `${next.name}（${next.id}）` },
        ],
      )
      // Exactly the path the sheet showed is what the definition is bound to; nothing is looked up again.
      return { stepup, found: resolved }
    }

    /** Whether `found` sits directly in a PATH directory, not only in the extra install directories. */
    function onPath(found: string): boolean {
      const directories = (options.pathDirectories ?? options.commandDirectories)?.() ?? []
      return directories.some(directory => isAbsolute(directory) && resolve(directory) === dirname(found))
    }

    /** Whether a definition's version may be read: its command confirmed on this Mac and still resolving to that program. */
    function versionReadable(record: AgentRecord): boolean {
      return record.confirmedCommand !== undefined && resolveCommand(record.command) === record.confirmedCommand
    }

    /**
     * A start of a definition saved before confirmations: from this Mac's desktop app it takes the confirmation once and
     * is bound to the program it names; from anywhere else it is refused until that has happened.
     */
    async function bindUnconfirmedHarness(req: IncomingMessage, caller: DeviceCaller, harnessId: string | undefined): Promise<void> {
      const record = harnessId ? config.settings().agents.find(agent => agent.id === harnessId) : undefined
      if (!record || record.confirmedCommand !== undefined) return
      if (!isLocalListener(caller.connection.listener))
        throw new AppError(
          409,
          'harness-unconfirmed',
          `${record.name} 还没有在这台 Mac 上确认过：先在这台 Mac 上用它开始一个会话，确认一次后其他设备才能用它`,
        )
      const { stepup, found } = await confirmHarnessCommand(req, caller, record)
      if (!found) throw new AppError(503, 'agent-not-found', `未找到命令 ${record.command}`)
      const next: AgentRecord = { ...record, confirmedCommand: found }
      await serial(caller, 'run', async () => {
        const latest = config.settings().agents.find(agent => agent.id === record.id)
        if (!latest || definitionHash(latest) !== definitionHash(record) || latest.confirmedCommand !== undefined)
          throw new AppError(409, 'agent-changed', 'Agent 定义已被修改，请刷新后重试')
        const seq = await audited({
          action: 'agent.defined',
          actor: actorOf(caller),
          target: record.id,
          stepup,
          detail: { agentId: record.id, definitionHash: definitionHash(next), created: false },
        })
        try {
          await saveAgent(caller, next, false)
        } catch (error) {
          auditFailed(seq, caller)
          throw error
        }
      })
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

    /** What `model` of the service falls back to now, for a run of the built-in harness: saved services only. */
    function providerFallbacks(providerId: string, model: string): ProviderCandidate[] {
      return (effectiveProvider(providerId)?.fallbacks?.[model] ?? []).flatMap(item => {
        const record = effectiveProvider(item.providerId)
        if (!record || (item.providerId === providerId && item.model === model)) return []
        const fingerprint = providerFingerprint(record)
        return [
          {
            providerId: item.providerId,
            model: item.model,
            fingerprint,
            provider: () => {
              const current = gatewayService(item.providerId)
              return current?.fingerprint === fingerprint && current.models.includes(item.model)
                ? serviceProviders.get(item.providerId)
                : undefined
            },
          },
        ]
      })
    }

    /** The service's plugin with its provider behind the scheduler; the provider itself stays reachable for fallbacks. */
    function scheduled(plugin: HarnessPlugin, record: ProviderRecord): HarnessPlugin {
      return {
        ...plugin,
        activate: context =>
          plugin.activate({
            ...context,
            registerProvider: provider => {
              context.registerProvider(
                scheduledProvider(provider, {
                  scheduler: modelScheduler,
                  fallbacks: providerFallbacks,
                  fingerprint: id => {
                    const current = effectiveProvider(id)
                    return current ? providerFingerprint(current) : ''
                  },
                  fallback: modelFallback,
                  meter: modelMeter,
                  now,
                }),
              )
              // After the registry took it: a provider it refused is nobody's fallback.
              if (provider.id === record.id) serviceProviders.set(record.id, provider)
            },
          }),
      }
    }

    function buildProviderPlugin(record: ProviderRecord): HarnessPlugin {
      try {
        return scheduled(
          providerPlugin(record, {
            fetch: async (input, init) => {
              const response = await providerFetchFor(record.baseURL)(input, init)
              // The service answered: its first-byte time is met, however long the model thinks before its first event.
              if (response.ok) scheduledRequest.getStore()?.timer.began()
              return response
            },
            acquire: async (signal, bytes) => {
              const currentFingerprint = () => {
                if (recordDestination(record) === 'unconfirmed') throw new OriginUnconfirmed()
                const current = gatewayService(record.id)
                if (closing || !current || current.fingerprint !== providerFingerprint(record))
                  throw new AppError(409, 'model-route-changed', '模型服务的设置已经变了，请重新选择模型。')
                return current.fingerprint
              }
              const before = currentFingerprint()
              const asking = scheduledRequest.getStore()
              // The service's own place is already held; waiting for the Host's permit is not the service's silence.
              const permit = modelRequests.acquire(
                signal,
                bytes,
                asking?.sessionId ? () => modelScheduler.waiting(asking.sessionId) : undefined,
              )
              const release = await (asking ? asking.timer.waiting(permit) : permit)
              try {
                signal.throwIfAborted()
                if (currentFingerprint() !== before)
                  throw new AppError(409, 'model-route-changed', '模型服务的设置已经变了，请重新选择模型。')
                return release
              } catch (error) {
                release()
                throw error
              }
            },
          }),
          record,
        )
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
        return {
          ...plugin,
          activeRuns: plugin.activeRuns + sessions,
          ...(pluginAssets.has(plugin.id) ? { editable: true as const } : {}),
          ...(builtInPlugins.has(plugin.id) ? { builtIn: true as const } : {}),
        }
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
      const health = modelScheduler.health(record.id)
      return { ...providerSettings(record), destination: recordDestination(record), ...(health ? { health } : {}) }
    }

    function addedProvider(caller: DeviceCaller, requestId: string, inputHash?: string): ProviderRecord | undefined {
      const addition = config.providerAddition(caller.device.id, requestId)
      if (!addition) return undefined
      if (inputHash !== undefined && inputHash !== addition.inputHash)
        throw new AppError(409, 'request-id-conflict', '这次添加请求已用于不同的模型服务配置。')
      const record = config.provider(addition.providerId)
      if (!record || sha256Hex(canonicalJson(record)) !== addition.recordHash)
        throw new AppError(409, 'provider-changed', '这次添加已保存，但模型服务后来有改动或已移除。')
      return record
    }

    function providerAdditionVisible(addition: ProviderAddition): boolean {
      const stored = config.providerAddition(addition.deviceId, addition.requestId)
      if (
        stored?.providerId !== addition.providerId
        || stored.inputHash !== addition.inputHash
        || stored.recordHash !== addition.recordHash
      )
        return false
      const record = config.provider(addition.providerId)
      return record !== undefined && sha256Hex(canonicalJson(record)) === addition.recordHash
    }

    function addedProviderReady(record: ProviderRecord): boolean {
      return pluginInfo(record.id)?.managed === 'provider' && modelAvailable({ providerId: record.id, model: record.defaultModel })
    }

    const providerAdditionUnconfirmed = () => new AppError(503, 'provider-addition-unconfirmed', '模型服务添加结果未确认，请核对这次请求。')

    /** Resume the published configuration without replaying its confirmation or changing the outbound policy. */
    async function settleProviderAddition(caller: DeviceCaller, record: ProviderRecord): Promise<ProviderRecord> {
      recheck(caller, 'admin')
      requireDesktop(caller)
      if (addedProviderReady(record)) return record
      if (!record.enabled) throw providerAdditionUnconfirmed()
      if (record.apiKey) recheck(caller, 'secrets')

      await syncDirectory(dataDir).catch(() => {
        throw providerAdditionUnconfirmed()
      })
      recheck(caller, 'admin')
      if (record.apiKey) recheck(caller, 'secrets')
      const plan = await planDestination(record.baseURL, { key: Boolean(record.apiKey), confirm: true })
      const authorize = () => {
        recheck(caller, 'admin')
        if (record.apiKey) recheck(caller, 'secrets')
        if (
          plan.addAddress
          || plan.egress !== undefined
          || recordDestination(record) === 'unconfirmed'
          || (plan.reason !== undefined && !policy.get().hostEgressAllow.includes(plan.hostPort) && !egressExtra.includes(plan.hostPort))
        )
          throw providerAdditionUnconfirmed()
      }
      authorize()
      const registered = pluginInfo(record.id)
      if (registered && registered.managed !== 'provider') throw new AppError(409, 'provider-changed', '模型服务的标识已被其他插件使用。')
      if (!registered) registerProvider(record, buildProviderPlugin(record))
      authorize()
      if (!pluginInfo(record.id)?.enabled) await registry.enable(record.id)
      authorize()
      if (!addedProviderReady(record)) throw providerAdditionUnconfirmed()
      refresh()
      return record
    }

    /** A service as the catalog lists it for every device: what its models fall back to and how its requests fare, no more. */
    function providerSummary(provider: ModelProvider): ProviderSummary {
      const record = pluginInfo(provider.id)?.managed === 'provider' ? effectiveProvider(provider.id) : undefined
      const health = record ? modelScheduler.health(provider.id) : undefined
      return {
        ...summarizeProvider(provider, providerKindOf(provider.id)),
        ...(record?.fallbacks && Object.keys(record.fallbacks).length ? { fallbacks: structuredClone(record.fallbacks) } : {}),
        ...(health ? { health } : {}),
      }
    }

    /** 「出错时改用」 as a save may keep it: only for the service's own models, each naming a saved service's model, never itself. */
    /** A saved service another one may fall back to: one saved with a protocol Latch no longer speaks counts as gone. */
    function fallbackTarget(id: string): ProviderRecord | undefined {
      const record = effectiveProvider(id)
      return record && isProviderKind(record.kind) ? record : undefined
    }

    function checkedFallbacks(
      id: string,
      models: readonly string[],
      input: Record<string, ModelFallback[]>,
    ): Record<string, ModelFallback[]> {
      const kept: Record<string, ModelFallback[]> = {}
      for (const [model, list] of Object.entries(input)) {
        if (!models.includes(model) || list.length === 0) continue
        const seen = new Set<string>()
        for (const item of list) {
          const key = `${item.providerId}\n${item.model}`
          const other = item.providerId === id ? { models } : fallbackTarget(item.providerId)
          if (seen.has(key) || (item.providerId === id && item.model === model) || !other?.models.includes(item.model))
            throw new AppError(400, 'invalid-fallback', '「出错时改用」里有一个模型不在已保存的模型服务里，或重复了。')
          seen.add(key)
        }
        kept[model] = list.map(({ providerId, model: name }) => ({ providerId, model: name }))
      }
      return kept
    }

    /** A saved list without what is gone by now: a model this service no longer has, a service or model that was removed. */
    function liveFallbacks(id: string, models: readonly string[], saved: Record<string, ModelFallback[]>): Record<string, ModelFallback[]> {
      const kept: Record<string, ModelFallback[]> = {}
      for (const [model, list] of Object.entries(saved)) {
        if (!models.includes(model)) continue
        const live = list.filter(item =>
          (item.providerId === id ? models : (fallbackTarget(item.providerId)?.models ?? [])).includes(item.model),
        )
        if (live.length) kept[model] = live
      }
      return kept
    }

    /**
     * What an edit of 「出错时改用」 changed, for its record: how many models' lists differ, the services the new lists
     * name, and whether anything was added or moved. Undefined when nothing changed.
     */
    function fallbackChange(
      before: Record<string, ModelFallback[]>,
      after: Record<string, ModelFallback[]>,
    ): { models: number; candidates: string[]; widened: boolean } | undefined {
      const key = (item: ModelFallback) => `${item.providerId}\n${item.model}`
      const names = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      const changed = names.filter(name => canonicalJson(before[name] ?? []) !== canonicalJson(after[name] ?? []))
      if (!changed.length) return undefined
      // Only removing entries leaves the rest in the order they had: anything else sends requests somewhere new or sooner.
      const widened = changed.some(name => {
        const old = (before[name] ?? []).map(key)
        let at = 0
        for (const entry of (after[name] ?? []).map(key)) {
          const found = old.indexOf(entry, at)
          if (found < 0) return true
          at = found + 1
        }
        return false
      })
      const candidates = [...new Set(Object.values(after).flatMap(list => list.map(item => item.providerId)))].toSorted().slice(0, 64)
      return { models: changed.length, candidates, widened }
    }

    /** Takes what other services' models fall back to out of their lists once it is gone: a removed service, or models it lost. */
    async function pruneFallbacks(gone: (item: ModelFallback) => boolean): Promise<void> {
      const refers = config.providers().some(record => Object.values(record.fallbacks ?? {}).some(list => list.some(gone)))
      if (!refers) return
      await config.updateProviders(draft => {
        for (const record of draft) {
          if (!record.fallbacks) continue
          const kept = Object.fromEntries(
            Object.entries(record.fallbacks)
              .map(([model, list]) => [model, list.filter(item => !gone(item))] as const)
              .filter(([, list]) => list.length > 0),
          )
          if (Object.keys(kept).length) record.fallbacks = kept
          else delete record.fallbacks
        }
      })
    }

    /**
     * Why a configured service is not offered: it was saved with a protocol Latch no longer speaks, its address is not
     * confirmed (no request is ever sent there), or it is at a preset provider's address, where every request needs a
     * key, without a usable one. Undefined when it is offered.
     */
    function unusableReason(record: ProviderRecord): UnusableProvider['reason'] | undefined {
      if (!isProviderKind(record.kind)) return 'unsupported'
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
     * fingerprint changes with its protocol, address, key, models, capabilities and where requests may go, never its name.
     */
    function providerFingerprint(record: ProviderRecord): string {
      return sha256Hex(
        canonicalJson({
          kind: record.kind,
          baseURL: record.baseURL,
          key: sha256Hex(usableKey(record)),
          destination: recordDestination(record),
          models: record.models.length ? record.models : [record.defaultModel],
          modelCapabilities: record.modelCapabilities ?? {},
        }),
      )
    }

    function gatewayService(id: string): GatewayService | undefined {
      const record = effectiveProvider(id)
      const plugin = pluginInfo(id)
      if (!record?.enabled || plugin?.managed !== 'provider' || !plugin.enabled || unusableReason(record) !== undefined) return undefined
      if (!isProviderKind(record.kind)) return undefined
      const apiKey = usableKey(record)
      const models = record.models.length ? [...record.models] : [record.defaultModel]
      return {
        kind: record.kind,
        baseURL: record.baseURL,
        apiKey,
        models,
        ...(record.modelCapabilities ? { modelCapabilities: structuredClone(record.modelCapabilities) } : {}),
        fingerprint: providerFingerprint(record),
      }
    }

    /**
     * The route a session of `harness` takes to the service of `model`, as the Host computes it from its own records:
     * only an implemented pair, on a service sessions may use, with a model it lists.
     */
    function modelRouteFor(harness: HarnessInfo, model: ModelRef): ModelRoute {
      const name = harness.capabilities.display.label
      const service = gatewayService(model.providerId)
      const record = effectiveProvider(model.providerId)
      const kind = record?.kind
      if (!service || !record || !isProviderKind(kind))
        throw new AppError(409, 'model-route-unavailable', '这个模型服务现在不能用，会话没有开始。')
      const route = pairRoute(harness.capabilities, { kind })
      if (route.kind !== 'passthrough' && route.kind !== 'translate')
        throw new AppError(
          400,
          'model-route-unavailable',
          route.kind === 'incompatible'
            ? `${name} 只说 ${route.speaks.map(wire => WIRE_NAMES[wire]).join('、')} 协议，${record.name} 用 ${WIRE_NAMES[route.from]}，Latch 转换协议尚未实现。`
            : `让 Latch 把 ${name} 的请求转给模型服务，尚未实现。`,
        )
      if (!service.models.includes(model.model))
        throw new AppError(400, 'model-unavailable', `${record.name} 里没有模型「${model.model.slice(0, 64)}」`)
      // 「出错时改用」 as it is now, for every model of the service the session may switch to: fixed with the route, so
      // later changes reach new sessions only. A candidate this harness cannot be given is left out; one that is off or
      // unconfirmed stays, and is passed over while it is.
      const fallbacks: NonNullable<ModelRoute['fallbacks']> = {}
      // The chosen model's own first: the cap leaves out other models of a long list, never the one the session starts on.
      const listed = Object.entries(record.fallbacks ?? {}).toSorted(([a], [b]) => Number(b === model.model) - Number(a === model.model))
      for (const [name, list] of listed.slice(0, 64)) {
        if (!service.models.includes(name)) continue
        const kept = list.flatMap(item => {
          const other = effectiveProvider(item.providerId)
          if (!other || !isProviderKind(other.kind) || (item.providerId === record.id && item.model === name)) return []
          const upstream = PROVIDER_WIRES[other.kind]
          if (upstream !== route.wire && !canTranslate(route.wire, upstream)) return []
          try {
            return [{ providerId: other.id, model: item.model, upstream, origin: originOf(other.baseURL) }]
          } catch {
            return []
          }
        })
        if (kept.length) fallbacks[name] = kept
      }
      return {
        providerId: record.id,
        model: model.model,
        wire: route.wire,
        origin: originOf(record.baseURL),
        ...(route.kind === 'translate' ? { upstream: route.upstream } : {}),
        ...(Object.keys(fallbacks).length ? { fallbacks } : {}),
      }
    }

    /** A service saved with a protocol Latch no longer speaks: it is never sent anything, and can only be removed. */
    function providerUnsupported(record: Pick<ProviderRecord, 'name'>): AppError {
      return new AppError(
        409,
        'provider-unsupported',
        `「${escapeSecurityText(record.name)}」用的协议不再支持，不能再使用或修改，只能移除。`,
      )
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
      if (record && isProviderKind(record.kind) && pluginInfo(id)?.managed === 'provider') return record.kind
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

    function registerProvider(record: ProviderRecord, plugin: HarnessPlugin): void {
      registry.register(plugin, { managed: 'provider', revision: providerExecutionRevision(record) })
    }

    /** Persists `saved` and swaps the live plugin to `live` in one step; a failed write keeps the previous generation. */
    async function saveProvider(caller: Caller, live: ProviderRecord, saved = live, addition?: ProviderAddition): Promise<void> {
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
              registerProvider(live, plugin)
            }
          },
          addition,
        )
      } catch (error) {
        if (disabling)
          await registry
            .enable(live.id)
            .catch(cause =>
              logNoted('provider-restore-failed', { id: live.id, error: cause }, `模型服务 ${live.id} 恢复失败：${errorText(cause)}`),
            )
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
          if (current.enabled)
            await registry
              .enable(id)
              .catch(cause => logNoted('provider-restore-failed', { id: id, error: cause }, `模型服务 ${id} 恢复失败：${errorText(cause)}`))
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
      // What the listing says of each model's context length, for the page to prefill; never saved by the Host itself.
      const contextTokens = new Map<string, number>()
      const listed = (result: { models: string[] }) =>
        contextTokens.size ? { ...result, contextTokens: Object.fromEntries(contextTokens) } : result
      try {
        return listed(
          check
            ? await checkProvider(input, controller.signal, { fetch, contextTokens })
            : { models: await listProviderModels(input, controller.signal, { fetch, contextTokens }) },
        )
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

    /**
     * A key typed for a preset's HTTPS origin takes no confirmation; while a full-access session runs or waits it is
     * refused all the same, as the confirmation it replaces would be.
     */
    async function holdPresetKey(caller: Caller, baseURL: string, key: boolean): Promise<void> {
      if (!key || destinationOf(baseURL) !== 'preset') return
      await presence.assertNotHeldBack(
        'provider.confirm-origin',
        !!caller.device && devices.get(caller.device.id)?.scopes.includes('view') === true,
      )
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
      accepted?: () => boolean,
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
        if (!accepted?.()) {
          await undo(res)
          auditFailed(seq, caller)
        }
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

    async function classifyCall(input: { toolName: string; arguments: Record<string, unknown>; sessionId?: string } & SessionScope) {
      const pluginId = toolOwner(input.toolName)
      const browser = pluginId === BROWSER_PLUGIN && isBrowserTool(input.toolName) ? browserFacts(input) : undefined
      return classifyStandardCall({
        pluginId,
        toolName: input.toolName,
        args: input.arguments,
        demo: options.demo,
        folders: await callFolders(input),
        ...(browser ? { browser } : {}),
      })
    }

    /** What the broker's tab table says about the tab a browser call names. */
    function browserFacts(input: { toolName: string; arguments: Record<string, unknown>; sessionId?: string }): BrowserCallFacts {
      const sessionId = input.sessionId ?? ''
      const tab = browserBroker.tabFacts(sessionId, input.arguments.tabId)
      const sensitive =
        input.toolName === 'browser_type' ? browserBroker.refSensitive(sessionId, input.arguments.tabId, input.arguments.ref) : undefined
      return { ...(tab ? { tab } : {}), ...(sensitive !== undefined ? { sensitive } : {}) }
    }

    function browserKey(tool: string, args: Record<string, unknown>): string {
      try {
        return sha256Hex(canonicalJson([tool, args]))
      } catch {
        return ''
      }
    }

    /**
     * One browser tool call of the built-in harness: only for a session of a project, with the class it was approved at
     * (a class nobody approved, say R2 that came up only now, goes to main as R1, which then refuses a sensitive field).
     */
    async function browserCall(
      tool: BrowserTool,
      args: Record<string, unknown>,
      context: { sessionId: string; callId: string; approvalId?: string; signal: AbortSignal; waitForUser?: () => () => void },
    ): Promise<BrokerOutcome> {
      const summary = (await hub!.detail(context.sessionId)).summary
      if (summary.personal || summary.mode === 'chat' || summary.archived) return { ok: false, error: 'no-project', dispatched: false }
      try {
        await assertSessionWorkspace(context.sessionId)
      } catch {
        return { ok: false, error: 'no-project', dispatched: false }
      }
      const approved = browserRisks.get(context.sessionId)
      browserRisks.delete(context.sessionId)
      const now = classifyStandardCall({
        pluginId: BROWSER_PLUGIN,
        toolName: tool,
        args,
        demo: false,
        folders: [],
        browser: browserFacts({ toolName: tool, arguments: args, sessionId: context.sessionId }),
      }).risk
      const risk = approved && approved.key === browserKey(tool, args) ? approved.risk : now === 'R2' ? 'R1' : now
      const outcome = await browserBroker.call({
        sessionId: context.sessionId,
        projectId: projectIdOf(summary),
        tool,
        args,
        risk,
        ...(opaqueId.safeParse(context.callId).success ? { toolCallId: context.callId } : {}),
        ...(context.approvalId ? { approvalId: context.approvalId } : {}),
        signal: context.signal,
        ...(context.waitForUser ? { waitForUser: context.waitForUser } : {}),
      })
      // What the page says reaches the model with any key in it replaced.
      return outcome.ok ? { ...outcome, text: redactKnownSecrets(outcome.text) } : outcome
    }

    /**
     * One browser call of an external harness, from its `latch-browser` server through the tool gateway. Only a session of
     * a project on an ACP harness, during a turn that runs and is not being stopped (`gatewayRefusal`). Such a session is
     * full access (L3): what only looks (R0) and what acts on this Mac's own
     * addresses (R1) run without Latch asking, since full access is the oversight the person chose, and are audited,
     * taken over and stopped as the built-in harness's are; typing into a password, one-time-code, card or hidden field,
     * or one never read (R2), is refused (`elevated-refused`), whatever the agent's own ask said. The agent's own ask
     * stays its own: an approval given there is named in the audit.
     */
    async function gatewayBrowserCall({ sessionId, tool, args, signal, context }: GatewayCall): Promise<GatewayResult> {
      const failed = (outcome: Extract<BrokerOutcome, { ok: false }>): GatewayResult => ({
        content: [{ type: 'text', text: browserFailure(outcome) }],
        isError: true,
      })
      if (!isBrowserTool(tool)) return failed({ ok: false, error: 'invalid', dispatched: false })
      const summary = await hub!
        .detail(sessionId)
        .then(detail => detail.summary)
        .catch(() => undefined)
      const refusal = gatewayRefusal(summary, summary && hub!.trustOf(summary.harnessId), context.turn)
      if (refusal || !summary) return failed({ ok: false, error: refusal ?? 'no-project', dispatched: false })
      try {
        await assertSessionWorkspace(sessionId)
      } catch {
        return failed({ ok: false, error: 'no-project', dispatched: false })
      }
      const { risk } = classifyStandardCall({
        pluginId: BROWSER_PLUGIN,
        toolName: tool,
        args,
        demo: false,
        folders: [],
        browser: browserFacts({ toolName: tool, arguments: args, sessionId }),
      })
      if (risk === 'R2') return failed({ ok: false, error: 'elevated-refused', dispatched: false })
      const outcome = await browserBroker.call({
        sessionId,
        projectId: projectIdOf(summary),
        tool,
        args,
        risk,
        ...(context.toolCallId && opaqueId.safeParse(context.toolCallId).success ? { toolCallId: context.toolCallId } : {}),
        ...(context.approvalId && opaqueId.safeParse(context.approvalId).success ? { approvalId: context.approvalId } : {}),
        signal,
        ...(context.waitForUser ? { waitForUser: context.waitForUser } : {}),
        via: 'mcp',
      })
      if (!outcome.ok)
        return {
          // Main found the field sensitive only when typing: in a full-access session nobody is asked, so it says so.
          ...failed(outcome.error === 'sensitive-field' ? { ...outcome, error: 'elevated-refused' } : outcome),
          ...(outcome.error === 'result-unknown' ? { unknown: true as const } : {}),
        }
      return {
        content: [
          { type: 'text', text: browserResultText(tool, redactKnownSecrets(outcome.text)) },
          ...(outcome.image ? [{ type: 'image' as const, data: outcome.image.toString('base64'), mimeType: 'image/png' as const }] : []),
        ],
      }
    }

    /**
     * One simulator tool call of the built-in harness: a session of a project, while this Mac's desktop app is open (the
     * panel's own condition), with the class it was approved at.
     */
    async function deviceCall(
      tool: DeviceTool,
      args: Record<string, unknown>,
      context: { sessionId: string; callId: string; approvalId?: string; signal: AbortSignal },
    ): Promise<DeviceOutcome> {
      const summary = (await hub!.detail(context.sessionId)).summary
      if (summary.personal || summary.mode === 'chat' || summary.archived) return { ok: false, error: 'no-project' }
      try {
        await assertSessionWorkspace(context.sessionId)
      } catch {
        return { ok: false, error: 'no-project' }
      }
      return runDeviceCall({
        sessionId: context.sessionId,
        tool,
        args,
        signal: context.signal,
        ...(opaqueId.safeParse(context.callId).success ? { toolCallId: context.callId } : {}),
        ...(context.approvalId ? { approvalId: context.approvalId } : {}),
      })
    }

    /**
     * One simulator call of an external harness through the tool gateway: the same session and turn rules as its browser
     * calls (`gatewayRefusal`). Every simulator tool is R0 or R1, which a full-access session runs without Latch asking.
     */
    async function gatewayDeviceCall({ sessionId, tool, args, signal, context }: GatewayCall): Promise<GatewayResult> {
      const failed = (outcome: Extract<DeviceOutcome, { ok: false }>): GatewayResult => ({
        content: [{ type: 'text', text: deviceFailure(outcome) }],
        isError: true,
      })
      if (!isDeviceTool(tool)) return failed({ ok: false, error: 'invalid-input' })
      const summary = await hub!
        .detail(sessionId)
        .then(detail => detail.summary)
        .catch(() => undefined)
      const refusal = gatewayRefusal(summary, summary && hub!.trustOf(summary.harnessId), context.turn)
      if (refusal || !summary) return failed({ ok: false, error: refusal ?? 'no-project' })
      try {
        await assertSessionWorkspace(sessionId)
      } catch {
        return failed({ ok: false, error: 'no-project' })
      }
      const outcome = await runDeviceCall({
        sessionId,
        tool,
        args,
        signal,
        via: 'mcp',
        ...(context.toolCallId && opaqueId.safeParse(context.toolCallId).success ? { toolCallId: context.toolCallId } : {}),
        ...(context.approvalId && opaqueId.safeParse(context.approvalId).success ? { approvalId: context.approvalId } : {}),
      })
      if (!outcome.ok) return failed(outcome)
      return {
        content: [
          { type: 'text', text: outcome.text },
          ...(outcome.image ? [{ type: 'image' as const, data: outcome.image.toString('base64'), mimeType: 'image/png' as const }] : []),
        ],
      }
    }

    /** Checks a simulator call's arguments, records it, then runs simctl through the Host's module. */
    async function runDeviceCall(input: {
      sessionId: string
      tool: DeviceTool
      args: Record<string, unknown>
      signal: AbortSignal
      toolCallId?: string
      approvalId?: string
      via?: 'mcp'
    }): Promise<DeviceOutcome> {
      const { tool, args } = input
      if (!simulators.supported) return { ok: false, error: 'simulator-unavailable' }
      if (turnScopes.get(input.sessionId) !== true) return { ok: false, error: 'device-scope' }
      // The panel's own condition: this Mac's desktop app is open.
      if (!browserBroker.available()) return { ok: false, error: 'device-unavailable' }
      const udid = args.udid
      if (tool !== 'device_list' && !isSimulatorUdid(udid)) return { ok: false, error: 'invalid-input' }
      let address: { url: string; scheme: string; originHash?: string } | undefined
      if (tool === 'device_open_url') {
        try {
          const url = simulatorUrl(args.url)
          address = { url, ...addressFacts(url) }
        } catch {
          return { ok: false, error: 'invalid-url' }
        }
        // An agent opens only this Mac's own addresses, as its browser tools do: anything else could carry what it read
        // out of the device, and a deep link reaches an app nobody chose. The person opens those from the panel.
        if (address.scheme !== 'http' && address.scheme !== 'https') return { ok: false, error: 'deep-link' }
        if (!isLoopbackName(new URL(address.url).hostname)) return { ok: false, error: 'not-local' }
      }
      const appearance = args.appearance
      if (tool === 'device_set_appearance' && appearance !== 'light' && appearance !== 'dark') return { ok: false, error: 'invalid-input' }
      const direction = args.direction
      if (tool === 'device_rotate' && direction !== 'left' && direction !== 'right') return { ok: false, error: 'invalid-input' }
      // Checked against the device's own list as it runs; only its hash is recorded.
      const bundleId = args.bundleId
      if (tool === 'device_launch' && !isBundleId(bundleId)) return { ok: false, error: 'invalid-input' }
      try {
        await audit.append({
          action: 'simulator.call',
          actor: { listener: 'host' },
          target: input.sessionId,
          detail: {
            sessionId: input.sessionId,
            callId: randomUUID(),
            tool,
            ...(typeof udid === 'string' && tool !== 'device_list' ? { udid } : {}),
            risk: classifyDeviceCall(tool).risk,
            ...(appearance === 'light' || appearance === 'dark' ? { appearance } : {}),
            ...(tool === 'device_rotate' && (direction === 'left' || direction === 'right') ? { direction } : {}),
            ...(tool === 'device_launch' && isBundleId(bundleId) ? { bundleHash: bundleHash(bundleId) } : {}),
            ...(address ? { scheme: address.scheme, ...(address.originHash ? { originHash: address.originHash } : {}) } : {}),
            ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            ...(input.via ? { via: input.via } : {}),
          },
        })
      } catch {
        return { ok: false, error: 'audit-failed' }
      }
      if (input.signal.aborted) return { ok: false, error: 'cancelled' }
      try {
        if (tool === 'device_list') {
          const { xcode, devices: found } = await simulators.list()
          if (!xcode) return { ok: false, error: 'simulator-unavailable' }
          const shown = simulators.shown()
          const lines = found.map(device =>
            [
              device.udid,
              escapeSecurityText(device.name),
              device.os,
              device.state === 'booted' ? 'booted' : device.state,
              ...(device.udid === shown ? ['shown in the Latch 设备 panel'] : []),
            ].join(' · '),
          )
          return { ok: true, text: lines.length ? lines.join('\n') : 'No simulators on this Mac.' }
        }
        if (tool === 'device_screenshot') {
          const image = await simulators.picture(udid, 'png')
          return { ok: true, text: `Screenshot of ${String(udid)}.`, image }
        }
        if (tool === 'device_open_url') {
          await simulators.openUrl(udid, address!.url)
          return { ok: true, text: `Opened in ${String(udid)}.` }
        }
        if (tool === 'device_rotate') {
          const orientation = await simulators.rotate(udid, direction)
          return { ok: true, text: `${String(udid)} is now ${orientation}.` }
        }
        if (tool === 'device_apps') {
          const apps = await simulators.appList(udid)
          const lines = apps.map(app => [app.bundleId, escapeSecurityText(app.name), app.kind].join(' · '))
          return { ok: true, text: lines.length ? lines.join('\n') : 'No apps.' }
        }
        if (tool === 'device_launch') {
          await simulators.launch(udid, bundleId)
          return { ok: true, text: `Launched ${String(bundleId)} on ${String(udid)}.` }
        }
        await simulators.setAppearance(udid, appearance)
        return { ok: true, text: `Appearance of ${String(udid)} is ${String(appearance)}.` }
      } catch (error) {
        if (error instanceof AppError) return { ok: false, error: error.code, detail: error.message }
        return { ok: false, error: 'simulator-failed', detail: errorText(error) }
      }
    }

    async function classifyToolCall(input: ToolRiskInput): Promise<RiskLevel> {
      const { risk } = await classifyCall(input)
      // Right before the call: the class it is approved at goes with it to main.
      if (isBrowserTool(input.toolName)) browserRisks.set(input.sessionId, { key: browserKey(input.toolName, input.arguments), risk })
      return risk
    }

    function securityEvent(event: HarnessSecurityEvent): void | Promise<void> {
      if (event.type === 'tool-judged') {
        const { type: _type, ...detail } = event
        const written = audit.append({ action: 'task.tool.judged', actor: { listener: 'host' }, target: event.sessionId, detail })
        written.catch(error => logNoted('audit-write-failed', { error: error }, `审计记录写入失败：${errorText(error)}`))
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
            .catch(error => logNoted('audit-write-failed', { error: error }, `审计记录写入失败：${errorText(error)}`))
        } else if (event.type === 'model-route-bypassed') {
          void audit
            .append({ action: 'task.model.bypassed', actor, target: event.sessionId, detail: { sessionId: event.sessionId } })
            .catch(error => logNoted('audit-write-failed', { error: error }, `审计记录写入失败：${errorText(error)}`))
        } else if (event.type === 'approval-auto-rejected') {
          void audit
            .append({
              action: 'task.approval-auto-rejected',
              actor,
              target: event.sessionId,
              detail: { sessionId: event.sessionId, reason: event.reason },
            })
            .catch(error => logNoted('audit-write-failed', { error: error }, `审计记录写入失败：${errorText(error)}`))
        } else {
          logNoted('permission-unconfirmed', { id: event.sessionId }, `会话 ${event.sessionId} 无法确认权限模式，未发送输入。`)
        }
        refresh(event.sessionId)
      } catch (error) {
        logNoted('security-event-failed', { error: error }, `安全事件处理失败：${errorText(error)}`)
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

    /**
     * Latch's MCP servers through the tool gateway: which a session gets when its agent starts, each bridge's launch
     * (with the server's secrets, the only place they leave the Host), and the record of every tool call before it is
     * sent. A call is refused once the server was removed, switched off, changed, no longer used in the session, or the
     * tool switched off. See docs/MCP.md.
     */
    /**
     * The Latch MCP servers a session's agent gets as it starts, with the definitions they run, as one hash for its
     * `task.l3.started`: undefined for a Harness that takes none.
     */
    /** The set each session's agent was last given (`select`), by session: what `task.l3.started` names. */
    const mcpSets = new Map<string, string>()
    const setHash = (records: ReadonlyArray<{ id: string; specHash: string }>) =>
      sha256Hex(
        canonicalJson(records.map(record => ({ id: record.id, specHash: record.specHash })).toSorted((a, b) => (a.id < b.id ? -1 : 1))),
      )
    lifecycleListeners.on('sessionDeleted', ({ sessionId }) => {
      mcpSets.delete(sessionId)
      mcpRemote.closeWhere(`std:${sessionId}:`)
    })

    /**
     * Whether a server may be given to this session: 「操控这台 Mac」 never goes to an unattended run (an automation's,
     * which is how 我的 Agent's schedules run), known while the run's session is still being created.
     */
    const mcpGiven = (record: McpServerRecord, sessionId: string) =>
      !(record.transport === 'stdio' && (record.preset === 'computer' || record.preset === 'xcode') && hub!.unattended(sessionId))

    async function mcpSetHashOf(sessionId: string, harnessId: string): Promise<string | undefined> {
      if (hub!.info(harnessId)?.skills !== 'server') return undefined
      const given = mcpSets.get(sessionId)
      if (given) return given
      const summary = await hub!
        .detail(sessionId)
        .then(detail => detail.summary)
        .catch(() => undefined)
      if (!summary) return undefined
      return setHash(
        mcpStore
          .usedIn({ ...(summary.agent ? { agentId: summary.agent.customAgentId } : {}), projectId: projectIdOf(summary) })
          .filter(record => mcpConfirmed(record) && mcpGiven(record, sessionId)),
      )
    }

    /** The Host's session with a remote server for `key`: to its confirmed address, with its headers, through egress. */
    /**
     * Where a remote server's session goes and what it carries, from one reading of the definition as it stands now: the
     * same definition the caller checked (`specHash`) and confirmed, so a header saved with another address never goes to
     * the old one. Throws when it changed meanwhile.
     */
    function remoteOptions(record: Pick<McpHttpRecord, 'id' | 'specHash'>) {
      const latest = mcpStore.get(record.id)
      if (!latest || latest.transport !== 'http' || latest.specHash !== record.specHash || !mcpConfirmed(latest))
        throw new AppError(409, 'mcp-server-gone', 'This MCP server was removed, switched off or changed in Latch.')
      return {
        url: latest.url,
        headers: mcpStore.headersOf(latest.id),
        fetch: egressFetch,
        // A server with a confirmed login carries its token, to this address alone; the Host renews it.
        ...(latest.oauth
          ? {
              authorization: mcpOAuth.authorization(latest.id),
              onRejected: (why: 'rejected' | 'scope') => void mcpOAuth.relogin(latest.id, why),
            }
          : {}),
      }
    }

    function remoteSession(key: string, record: McpHttpRecord) {
      return mcpRemote.session(key, record.id, record.specHash, () => remoteOptions(record))
    }

    async function remoteTools(key: string, record: McpHttpRecord, signal: AbortSignal) {
      const { session, signal: stop } = remoteSession(key, record)
      return session.listTools(AbortSignal.any([signal, stop]))
    }

    /**
     * One call to a remote server, already on record (`mcp.tool.called`): sent to the confirmed address, its outcome
     * recorded after. Stopping the turn, or revoking the server, stops it.
     */
    async function remoteCall(
      key: string,
      record: McpHttpRecord,
      sessionId: string,
      callId: string,
      tool: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<RemoteAnswer> {
      const started = Date.now()
      const settle = (result: 'ok' | 'error' | 'cancelled' | 'failed') =>
        void audit
          .append({
            action: 'mcp.tool.settled',
            actor: { listener: 'host' },
            target: sessionId,
            detail: { serverId: record.id, sessionId, callId, result, ms: Math.max(0, Date.now() - started) },
          })
          .catch(() => {})
      const { session, signal: stop } = remoteSession(key, record)
      try {
        const answer = await session.callTool(tool, args, AbortSignal.any([signal, stop]))
        const isError = 'error' in answer || (answer.result as { isError?: unknown } | null)?.isError === true
        settle(isError ? 'error' : 'ok')
        return answer
      } catch (error) {
        settle(signal.aborted ? 'cancelled' : 'failed')
        throw error
      }
    }

    /**
     * `mcp.tool.called` before a call goes, or a refusal: no record, no call. 「Xcode」's also name their class and device;
     * 「操控这台 Mac」's `run_steps` its step count.
     */
    async function recordCall(record: McpServerRecord, sessionId: string, tool: string, device?: string, steps?: number): Promise<string> {
      const callId = randomUUID()
      const xcode = record.transport === 'stdio' && record.preset === 'xcode'
      try {
        await audit.append({
          action: 'mcp.tool.called',
          actor: { listener: 'host' },
          target: sessionId,
          detail: {
            serverId: record.id,
            sessionId,
            callId,
            toolHash: toolHash(record.id, tool),
            ...(xcode ? { risk: xcodeToolRisk(tool), ...(device ? { udid: device } : {}) } : {}),
            ...(steps !== undefined ? { steps } : {}),
          },
        })
      } catch {
        throw new AppError(503, 'audit-failed', 'Latch could not record this call, so it was not made.')
      }
      return callId
    }

    /** How long the built-in harness waits for a remote server's tools when a run begins. */
    const BUILTIN_LIST_MS = 20_000

    /**
     * The built-in harness's MCP tools for a run: the tools of each remote server used in the session now and confirmed,
     * listed by the Host (its client), named `mcp__<server>__<tool>`. Local commands are not offered: the Host would have
     * to run the person's program itself, and the built-in harness is L1. An Agent with 「可以使用」 set gets only the
     * servers it names as `mcp:<server ID>`. Each call is R2 (the classifier), checked against the definition again, on
     * record before it is sent, and its answer masked.
     */
    async function builtinMcpTools({ sessionId, signal }: { sessionId: string; signal: AbortSignal }): Promise<ToolDefinition[]> {
      const summary = await hub!
        .detail(sessionId)
        .then(detail => detail.summary)
        .catch(() => undefined)
      if (!summary) return []
      const where = { ...(summary.agent ? { agentId: summary.agent.customAgentId } : {}), projectId: projectIdOf(summary) }
      const chosen = mcpStore
        .usedIn(where)
        .filter((record): record is McpHttpRecord => record.transport === 'http' && mcpConfirmed(record))
        .filter(record => !summary.agent || !summary.pluginIds || summary.pluginIds.includes(`mcp:${record.id}`))
      const taken = new Set<string>()
      const lists = await Promise.all(
        chosen.map(async record => {
          const key = `std:${sessionId}:${record.id}`
          // As a bridge's launch: the session opens on record first; no record, no server for this run.
          try {
            await audit.append({
              action: 'mcp.server.started',
              actor: { listener: 'host' },
              target: sessionId,
              detail: { serverId: record.id, sessionId, specHash: record.specHash },
            })
          } catch {
            return { record, key, tools: [] }
          }
          try {
            const tools = await remoteTools(key, record, AbortSignal.any([signal, AbortSignal.timeout(BUILTIN_LIST_MS)]))
            void mcpStore
              .report(record.id, record.specHash, {
                status: 'ok',
                tools: tools
                  .map(tool => tool.name)
                  .filter(keptToolName)
                  .slice(0, 256),
                via: 'session',
              })
              .then(() => refresh())
              .catch(() => {})
            return { record, key, tools: tools.filter(tool => keptToolName(tool.name) && isMcpToolOn(record, tool.name)) }
          } catch (error) {
            if (!signal.aborted) {
              const reason = remoteFailure(error)
              void mcpStore
                .report(record.id, record.specHash, { status: 'failed', tools: [], reason, via: 'session' })
                .then(() => refresh())
                .catch(() => {})
            }
            return { record, key, tools: [] }
          }
        }),
      )
      return lists.flatMap(({ record, key, tools }) =>
        tools.flatMap((tool): ToolDefinition[] => {
          const name = builtinToolName(record.id, record.name, tool.name)
          if (taken.has(name)) return []
          taken.add(name)
          return [
            {
              name,
              // The server's words are outside content: masked, and marked as the server's.
              description: redactKnownSecrets(
                `MCP 服务器「${record.name}」的工具 ${tool.name}。${(tool.description ?? '').slice(0, 2000)}`,
              ),
              parameters:
                tool.inputSchema && tool.inputSchema.type === 'object'
                  ? (maskStrings(tool.inputSchema, redactKnownSecrets) as Record<string, unknown>)
                  : { type: 'object', properties: {} },
              requiresApproval: true,
              kind: 'other',
              title: redactKnownSecrets(`${record.name} · ${tool.name}`).slice(0, 80),
              async execute(args, context) {
                // As at a bridge's call: still there, on, as confirmed, used in this session and the tool on.
                const latest = mcpStore.get(record.id)
                if (
                  !latest
                  || latest.transport !== 'http'
                  || !latest.enabled
                  || latest.specHash !== record.specHash
                  || !mcpConfirmed(latest)
                  || !mcpUsedIn(latest.scope, where)
                )
                  throw new Error('这个 MCP 服务器已在 Latch 里移除、停用或修改。')
                if (!isMcpToolOn(latest, tool.name)) throw new Error('这个工具已在 Latch 里关掉。')
                const callId = await recordCall(latest, sessionId, tool.name)
                let answer: RemoteAnswer
                try {
                  answer = await remoteCall(key, latest, sessionId, callId, tool.name, args, context.signal)
                } catch (error) {
                  if (context.signal.aborted) throw error
                  throw new Error(error instanceof Error && error.name === 'McpRemoteError' ? error.message : 'MCP 服务器调用失败。')
                }
                if ('error' in answer) throw new Error(redactKnownSecrets(answer.error.message))
                const result = answer.result as { content?: unknown; isError?: unknown; structuredContent?: unknown } | null
                const content = Array.isArray(result?.content) ? (result.content as Array<Record<string, unknown>>) : []
                const text =
                  content
                    .map(item =>
                      item.type === 'text' && typeof item.text === 'string' ? item.text : `[${String(item.type ?? 'content')}]`,
                    )
                    .join('\n') || (result?.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : '')
                const masked = redactKnownSecrets(text).slice(0, 256 * 1024)
                if (result?.isError === true) throw new Error(masked || 'MCP 工具报告了错误。')
                return { text: masked }
              },
            },
          ]
        }),
      )
    }

    /** How Latch's text meets the driver's own: tests run the A/B through `computerDriver.guide`. */
    const guideMode = options.computerDriver?.guide ?? COMPUTER_GUIDE_MODE
    /** 「操控这台 Mac」 bridges that took their launch and have not ended, by session: binding → server. */
    const computerLive = new Map<string, Map<string, string>>()
    /** Its calls sent and not yet settled, by session: call ID → when it went. */
    const computerCalls = new Map<string, Map<string, number>>()
    /**
     * Sessions where 停 ended the bridge while a call was in flight: the driver's daemon does not cancel a call when its
     * `mcp` client goes (cua-driver-rs v0.52.3, `serve.rs`), and a batch may run up to 60 s (`MAX_BATCH_MS`). Shown as
     * 「正在停止」 until that long after the last call went.
     */
    const computerStopping = new Map<string, { serverId: string; timer: ReturnType<typeof setTimeout> }>()
    const COMPUTER_CALL_LIMIT_MS = 65_000
    /**
     * Latch's own processes, for the accident guard on 「操控这台 Mac」 calls: the Host, and the desktop app as it last
     * reported itself. Not a boundary (docs/MCP.md).
     */
    const latchPids = () => [process.pid, ...(computer.desktopPid() !== undefined ? [computer.desktopPid()!] : [])]

    function mcpGateway(): McpGatewayHandlers {
      /** Each bridge's empty working folder, removed when its binding ends. */
      const folders = new Map<string, string>()
      const current = (binding: { serverId: string; specHash: string }) => {
        const record = mcpStore.get(binding.serverId)
        return record && record.enabled && record.specHash === binding.specHash && mcpConfirmed(record) ? record : undefined
      }
      const gone = () => new AppError(409, 'mcp-server-gone', 'This MCP server was removed, switched off or changed in Latch.')
      return {
        async remote(binding, method, params, signal) {
          const record = current(binding)
          if (!record || record.transport !== 'http' || !mcpUsedIn(record.scope, binding)) throw gone()
          const reportOn = (report: Parameters<McpGatewayHandlers['report']>[1]) => this.report(binding, report)
          if (method === 'initialize') {
            try {
              const { session, signal: stop } = remoteSession(binding.id, record)
              const result = await session.initialize(AbortSignal.any([signal, stop]))
              // Only what an agent needs from it, masked: the server's version, name and instructions.
              return maskStrings(
                {
                  protocolVersion: result.protocolVersion,
                  ...(result.serverInfo && typeof result.serverInfo === 'object' ? { serverInfo: result.serverInfo } : {}),
                  ...(typeof result.instructions === 'string' ? { instructions: result.instructions.slice(0, 8000) } : {}),
                },
                redactKnownSecrets,
              )
            } catch (error) {
              if (!signal.aborted) reportOn({ ok: false, reason: remoteFailure(error) })
              throw error
            }
          }
          if (method === 'tools/list') {
            const tools = await remoteTools(binding.id, record, signal).catch((error: unknown) => {
              if (!signal.aborted)
                reportOn({ ok: false, reason: remoteFailure(error) === 'protocol' ? 'list-failed' : remoteFailure(error) })
              throw error
            })
            reportOn({ ok: true, tools: tools.map(tool => tool.name) })
            return maskStrings({ tools: tools.filter(tool => isMcpToolOn(record, tool.name)) }, redactKnownSecrets)
          }
          const tool = typeof params.name === 'string' ? params.name : ''
          const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
          const callId = await this.callStarted(binding, tool)
          const answer = await remoteCall(binding.id, record, binding.sessionId, callId, tool, args as Record<string, unknown>, signal)
          return 'error' in answer
            ? { content: [{ type: 'text', text: redactKnownSecrets(answer.error.message) }], isError: true }
            : maskStrings(answer.result, redactKnownSecrets)
        },
        async select(input) {
          const chosen = mcpStore.usedIn(input).filter(record => mcpConfirmed(record) && mcpGiven(record, input.sessionId))
          mcpSets.set(input.sessionId, setHash(chosen))
          return chosen.map(record => ({
            serverId: record.id,
            name: record.name,
            specHash: record.specHash,
            ...(record.transport === 'stdio' && record.preset === 'computer'
              ? { skill: { ...COMPUTER_GUIDE_SKILL, content: computerRules(record.disabledTools) } }
              : record.transport === 'stdio' && record.preset === 'xcode'
                ? { skill: { ...XCODE_GUIDE_SKILL, content: XCODE_INSTRUCTIONS } }
                : {}),
          }))
        },
        async launch(binding) {
          const record = current(binding)
          // Still used in this session: 「用在」 may have changed since the agent started.
          if (!record || !mcpUsedIn(record.scope, binding) || !mcpGiven(record, binding.sessionId)) throw gone()
          // The person's program starts now (a remote server's session opens), on record first: no record, no start.
          try {
            await audit.append({
              action: 'mcp.server.started',
              actor: { listener: 'host' },
              target: binding.sessionId,
              detail: { serverId: record.id, sessionId: binding.sessionId, specHash: record.specHash },
            })
          } catch {
            throw new AppError(503, 'audit-failed', 'Latch could not record this start, so the server was not started.')
          }
          if (record.transport === 'http') return { remote: true, disabledTools: [...record.disabledTools] }
          if (record.preset === 'computer') {
            const live = computerLive.get(binding.sessionId) ?? new Map<string, string>()
            live.set(binding.id, record.id)
            computerLive.set(binding.sessionId, live)
            refresh(binding.sessionId)
          }
          let cwd = binding.cwd
          if (!record.projectCwd) {
            cwd = await mkdtemp(join(runtime.tmpRoot, 'mcp-'))
            folders.set(binding.id, cwd)
          }
          return {
            command: record.command,
            args: expandArgs(record.args, binding.cwd),
            env: serverEnvironment(
              record.command,
              { ...record.env, ...mcpStore.secretsOf(record.id) },
              options.commandDirectories?.() ?? [],
            ),
            cwd,
            disabledTools: [...record.disabledTools],
            ...(record.knownTools ? { knownTools: [...record.knownTools] } : {}),
            ...(record.preset === 'computer'
              ? {
                  instructions: computerGuide(record.disabledTools, guideMode),
                  instructionsMode: guideMode,
                  offHints: { ...COMPUTER_OFF_HINTS },
                  shapes: true as const,
                }
              : record.preset === 'xcode'
                ? { instructions: XCODE_INSTRUCTIONS }
                : {}),
          }
        },
        report(binding, report) {
          void mcpStore
            .report(binding.serverId, binding.specHash, {
              status: report.ok ? 'ok' : 'failed',
              tools: report.ok ? report.tools.filter(keptToolName) : [],
              ...(report.ok ? {} : { reason: report.reason }),
              via: 'session',
            })
            .then(() => refresh())
            .catch(error => log(`MCP 服务器的状态没有保存：${errorText(error)}`))
        },
        async promptStarted(binding, prompt) {
          const record = current(binding)
          if (!record || record.transport !== 'stdio' || !mcpUsedIn(record.scope, binding)) throw gone()
          try {
            await audit.append({
              action: 'mcp.prompt.got',
              actor: { listener: 'host' },
              target: binding.sessionId,
              detail: { serverId: record.id, sessionId: binding.sessionId, promptHash: promptHash(record.id, prompt) },
            })
          } catch {
            throw new AppError(503, 'audit-failed', 'Latch could not record this prompt, so it was not fetched.')
          }
          // Persist provenance before forwarding. The bridge response or cancellation can arrive independently.
          try {
            await hub!.markOutsideContent(binding.sessionId)
            refresh(binding.sessionId)
          } catch {
            throw new AppError(503, 'mcp-prompt-unmarked', 'Latch could not mark this session, so the prompt was not fetched.')
          }
        },
        async callStarted(binding, tool, device, shape) {
          const record = current(binding)
          if (!record || !mcpUsedIn(record.scope, binding) || !mcpGiven(record, binding.sessionId)) throw gone()
          if (!isMcpToolOn(record, tool)) {
            const hint = record.transport === 'stdio' && record.preset === 'computer' ? COMPUTER_OFF_HINTS[tool] : undefined
            throw new AppError(403, 'mcp-tool-off', `This tool is switched off in Latch.${hint ? ` ${hint}` : ''}`)
          }
          if (record.transport === 'stdio' && record.preset === 'computer') {
            // 「操控这台 Mac」: what the call has the driver do, as its bridge read it, checked before anything is sent.
            const refused = computerRefusal(record, tool, shape, latchPids())
            if (refused) {
              await audit
                .append({
                  action: 'mcp.tool.refused',
                  actor: { listener: 'host' },
                  target: binding.sessionId,
                  detail: { serverId: record.id, sessionId: binding.sessionId, toolHash: toolHash(record.id, tool), reason: refused },
                })
                .catch(() => {})
              throw new AppError(403, 'mcp-tool-refused', COMPUTER_REFUSAL_TEXT[refused])
            }
            const callId = await recordCall(record, binding.sessionId, tool, undefined, tool === 'run_steps' ? shape?.stepCount : undefined)
            const calls = computerCalls.get(binding.sessionId) ?? new Map<string, number>()
            calls.set(callId, Date.now())
            computerCalls.set(binding.sessionId, calls)
            return callId
          }
          const callId = await recordCall(record, binding.sessionId, tool, device)
          if (record.transport === 'stdio' && record.preset === 'xcode')
            simulators.agentCall(
              binding.sessionId,
              XCODE_SESSION_START.has(tool) ? 'start' : tool === XCODE_SESSION_END ? 'end' : 'call',
              device,
            )
          return callId
        },
        callEnded(binding, callId, result, ms) {
          const calls = computerCalls.get(binding.sessionId)
          if (calls?.delete(callId) && !calls.size) computerCalls.delete(binding.sessionId)
          void audit
            .append({
              action: 'mcp.tool.settled',
              actor: { listener: 'host' },
              target: binding.sessionId,
              detail: { serverId: binding.serverId, sessionId: binding.sessionId, callId, result, ms },
            })
            .catch(() => {})
        },
        closed(binding) {
          const closing = mcpStore.get(binding.serverId)
          if (closing?.transport === 'stdio' && closing.preset === 'xcode') simulators.agentEnded(binding.sessionId)
          const live = computerLive.get(binding.sessionId)
          if (live?.delete(binding.id)) {
            if (!live.size) computerLive.delete(binding.sessionId)
            refresh(binding.sessionId)
          }
          mcpRemote.close(binding.id)
          const folder = folders.get(binding.id)
          folders.delete(binding.id)
          if (folder) void rm(folder, { recursive: true, force: true })
        },
      }
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
            // A driver that brings sessions in checks their directory against the project too.
            ...(driver.projectFolders === 'all' || driver.historyImport ? { projects: usableProjects } : {}),
            registry,
            providerId: defaultProviderId,
            defaultModel: savedDefaultModel,
            tmpRoot: runtime.tmpRoot,
            securityEvent,
            clock,
            // Turns the gateway does not meter, for 额度与用量: an ACP Harness on its own login, and the built-in harness on
            // a plugin's own provider. Saved services are in the ledger already; the demo model is counted nowhere.
            turnEnded: (turn: HarnessTurnRecord) => {
              const plugin = driver.id === STANDARD
              if (plugin && (!turn.providerId || providerKindOf(turn.providerId) !== 'plugin')) return
              if (!plugin && kindOf(driver) !== 'acp') return
              const agentId = sessionOwner(turn.sessionId)
              const projectId = turn.projectId ?? hub?.projectOf(turn.sessionId)
              const line = turnLine(turn, {
                harness: driver.id,
                ...(agentId ? { agentId } : {}),
                ...(projectId ? { projectId } : {}),
                ...(plugin ? { via: 'plugin' as const } : {}),
              })
              if (line) turnLog.append(line)
            },
            proposeMemory: input => proposeFromAgent(driver, input),
            proposeSchedule: input => proposeScheduleFromAgent(driver, input),
            proposeWork: input => proposeWorkFromAgent(driver, input),
            // Only Latch 内置 searches memories: other Harnesses get them in their first-turn block, as before.
            ...(driver.id === STANDARD ? { recallMemory: (input: MemoryRecallInput) => recallFromAgent(driver, input) } : {}),
            // Only a driver that says it can be pointed at a service gets tokens for one.
            ...(hub!.info(driver.id)?.capabilities.models.wires.length ? { modelGateway } : {}),
            // Only ACP harnesses, which take MCP servers: their agent's `latch-browser` server reaches the browser tools.
            ...(toolGateway?.listening && kindOf(driver) === 'acp' ? { toolGateway } : {}),
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
            // The built-in harness is the remote MCP servers' client through the Host; others get them through the bridge.
            ...(driver.id === STANDARD ? { mcpTools: builtinMcpTools } : {}),
            // The built-in harness asks through its ask_user tool; other harnesses' questions go to the same card.
            ...(driver.id === STANDARD
              ? {}
              : {
                  askUser: ({ sessionId, callId, prompt, questions: asked, signal }: AskUserInput) =>
                    questions.ask({ prompt, questions: asked }, { sessionId, callId, signal }),
                  questionSettled: ({ state, ...context }: Parameters<NonNullable<HarnessHostOptions['questionSettled']>>[0]) =>
                    state === 'unknown' ? questions.resultUnknown(context) : questions.resultCommitted({ ...context, state }),
                }),
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
          await mount(driver).catch(error =>
            logNoted('harness-load-failed', { id: driver.id, error: error }, `Harness ${driver.id} 加载失败：${errorText(error)}`),
          )
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
          keepBinding(draft, next)
        })
      } catch (error) {
        if (previous && !created) await mountPlugin(previous)
        throw error
      }
      await removeAgentPlugin(next.id).catch(error =>
        logNoted('plugin-cleanup-failed', { id: next.id, error: error }, `Agent ${next.id} 旧插件清理失败：${errorText(error)}`),
      )
      registry.register(plugin, { managed: 'agent' })
      agentPlugins.set(plugin.id, next.id)
      if (!next.enabled) return
      await registry.enable(plugin.id)
      await mountPlugin(plugin.id)
    }

    /** The path a preset's command was last bound to outlives its definition: re-adding it elsewhere asks. */
    function keepBinding(draft: HostSettings, record: AgentRecord): void {
      if (!record.presetId || !record.confirmedCommand || !runsPresetCommand(record)) return
      const others = (draft.presetBindings ?? []).filter(item => !(item.presetId === record.presetId && item.command === record.command))
      draft.presetBindings = [...others, { presetId: record.presetId, command: record.command, path: record.confirmedCommand }].slice(
        -MAX_PRESET_BINDINGS,
      )
    }

    async function deleteAgent(caller: Caller, id: string, res: ServerResponse): Promise<void> {
      if (!config.settings().agents.some(agent => agent.id === id)) throw new AppError(404, 'agent-not-found', '找不到该 Agent')
      const pluginId = agentPluginId(id)
      if (pluginId) await unmountPlugin(pluginId)
      await audited({ action: 'agent.deleted', actor: actorOf(caller), target: id, detail: { agentId: id } }, res)
      try {
        await writeSettings(caller, draft => {
          const removed = draft.agents.find(agent => agent.id === id)
          if (removed) keepBinding(draft, removed)
          draft.agents = draft.agents.filter(agent => agent.id !== id)
        })
      } catch (error) {
        if (pluginId) await mountPlugin(pluginId)
        throw error
      }
      await removeAgentPlugin(id).catch(error =>
        logNoted('plugin-cleanup-failed', { id: id, error: error }, `Agent ${id} 插件清理失败：${errorText(error)}`),
      )
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
          await registry
            .disable(id)
            .catch(cause => logNoted('plugin-rollback-failed', { id, error: cause }, `插件 ${id} 回滚失败：${errorText(cause)}`))
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
          cause => logNoted('plugin-rollback-failed', { id, error: cause }, `插件 ${id} 回滚失败：${errorText(cause)}`),
        )
        throw error
      }
    }

    // ---- Workspaces and defaults -----------------------------------------------------------------

    /**
     * Every settings write the Host makes is recorded with its before and after hashes, so the next start can tell it
     * from an edit made outside Latch. The record is a baseline, not the action's own audit, so a failed append only logs.
     */
    function writeSettings(
      caller: Caller,
      mutate: (draft: HostSettings) => void,
      scope: DeviceScope = 'admin',
      authorize?: () => void,
    ): Promise<void> {
      return config.updateSettings(mutate, async (next, commit) => {
        recheck(caller, scope)
        const before = sha256Hex(canonicalJson(config.settings()))
        const after = sha256Hex(canonicalJson(next))
        if (before === after) return
        let seq: number | undefined
        try {
          seq = (await audit.append({ action: 'settings.changed', actor: actorOf(caller), detail: { before, after } })).seq
        } catch (error) {
          logNoted('audit-write-failed', { error: error }, `审计记录写入失败（settings.changed）：${errorText(error)}`)
        }
        try {
          authorize?.()
          await commit()
        } catch (error) {
          auditFailed(seq, caller)
          throw error
        }
      })
    }

    /** The primary folder of a session whose folders are still available, for its page draft. */
    async function draftFolder(sessionId: string): Promise<string> {
      const roots = await sessionRoots(sessionId)
      if (roots === undefined) throw new AppError(404, 'session-not-found', '找不到这个会话。')
      if (roots === 'removed' || !roots[0]) throw new AppError(409, 'app-draft-missing', '这个会话的文件夹找不到了。')
      return roots[0].path
    }
    const pluginPackageRoutes = createPluginPackageRoutes<Caller>({
      assets: pluginAssets,
      registry,
      installedIds: assetPluginIds,
      held: heldPlugins,
      builds: appBuilds,
      // The tools never read the Host's own data, wherever it lives.
      build: bundle => buildPages(bundle, hostBuildTools(), { hidden: [dataDir] }),
      readDraft: async sessionId => readSessionDraft(await draftFolder(sessionId)),
      async hasDraft(sessionId) {
        const folder = await draftFolder(sessionId).catch(() => undefined)
        if (!folder) return false
        const directory = await lstat(join(folder, APP_DRAFT_DIRECTORY)).catch(() => undefined)
        const manifest = directory?.isDirectory()
          ? await lstat(join(folder, APP_DRAFT_DIRECTORY, APP_DRAFT_MANIFEST)).catch(() => undefined)
          : undefined
        return manifest?.isFile() === true
      },
      async auditBuild(actor, id, detail) {
        try {
          await audit.append({ action: 'plugin.package.build', actor: actor.actor, target: id, detail })
          return true
        } catch (error) {
          logNoted('audit-write-failed', { error: error }, `审计记录写入失败（plugin.package.build）：${errorText(error)}`)
          return false
        }
      },
      buildFailed(id, appIds, message) {
        for (const appId of appIds) void appDiagnostics.record(id, { appId, source: 'build', message }).catch(() => {})
      },
      automatedActor(deviceId) {
        const allowed = () => {
          const device = devices.get(deviceId)
          return (
            device !== undefined
            && devices.isActive(deviceId)
            && device.listener === 'unix'
            && device.scopes.includes('admin')
            && device.dataScope === 'all'
          )
        }
        if (!allowed()) return undefined
        return {
          actor: { deviceId, listener: 'unix', via: 'http' },
          authorize: () => {
            if (!allowed()) throw new AppError(403, 'plugin-package-scope', '开启开发中的设备已不能编辑插件。')
          },
        }
      },
      pagesChanged: pluginId => sendAppUpdated(pluginId),
      log,
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
    // 开发中 belongs to the device that turned it on: removing that device turns it off.
    devices.onRevoked(deviceId => {
      void pluginAssets.stopDev(deviceId).then(
        count => {
          if (count) refresh()
        },
        error => log(`开发中没有随设备移除而关闭：${errorText(error)}`),
      )
    })
    // 开发中: a draft's source session that ended a turn is imported and built again when its draft changed.
    lifecycleListeners.on('runSettled', ({ sessionId }) => {
      void pluginPackageRoutes.devTurn(sessionId)
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
        ...(record.defaultModel ? { defaultModel: { ...record.defaultModel } } : {}),
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
        ...(hub?.worktrees() ?? [])
          .filter(entry => !entry.removed && lastSeenUsable(savedProject(entry.workspaceId)))
          .map(entry => entry.path),
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

    /** A saved project with one folder: the only kind a Latch worktree is made from. */
    function worktreeProject(id: string): WorkspaceRecord {
      const record = requireProject(id)
      if (record.folders.length !== 1)
        throw new AppError(409, 'worktree-project-folders', '这个项目有多个文件夹，新工作树只用于只有一个文件夹的项目。')
      return record
    }

    /**
     * Who a worktree's marker names, by the Host's own records (session metadata), not by what the Harnesses list now: a
     * session whose metadata is gone was deleted, so its worktree is a leftover; one with metadata that no Harness lists
     * (its Harness is off) still holds it. `reason`: why it can be neither reused nor removed as a leftover.
     */
    async function worktreeOwner(sessionId: string): Promise<{ state: LatchWorktree['state']; private: boolean; reason?: string }> {
      const kept = hub!.sessionRecord(sessionId)
      const task = await sessionTask(sessionId)
      if (!kept && !task) return { state: 'leftover', private: false }
      const secret = (kept?.private ?? false) || privateSession(task)
      const archived = kept?.archived ?? task?.archived === true
      const state = archived ? 'archived' : 'session'
      if (!task) return { state, private: secret, reason: '这个工作树的会话现在没有列出（它的 Harness 未启用），不能沿用。' }
      if (ACTIVE_STATUSES.has(task.status)) return { state, private: secret, reason: '这个工作树的会话正在运行，没有开始会话。' }
      if (!archived) return { state, private: secret, reason: '这个工作树属于一个未归档的会话。归档那个会话后，才能在新会话里沿用它。' }
      return { state, private: secret }
    }

    /**
     * A private session's worktree stays private after the session is gone: its marker is marked before the session's
     * records go (privacy can come after the start, so this is not only done when the worktree is bound).
     */
    async function keepWorktreePrivacy(sessionId: string): Promise<void> {
      const worktree = harnessHub.worktreeOf(sessionId)
      if (!worktree || worktree.removed || !harnessHub.sessionRecord(sessionId)?.private) return
      await worktrees.markPrivate(worktree.path, sessionId).catch(() => {
        throw new AppError(500, 'worktree-mark-failed', '没有记下这个会话的工作树是私有的，会话没有删除。请稍后再试。')
      })
    }

    const fullData = (caller: Caller) => !!caller.device && devices.get(caller.device.id)?.dataScope === 'all'
    /** The files and changes of the sessions' project folders: a device of scope `files` or `all`. */
    const projectFiles = (caller: Caller) => !!caller.device && readsProjectFiles(devices.get(caller.device.id)?.dataScope)
    /** Whether a path a session's tool names lies in that session's folders, symlinks resolved. */
    const insideSession = (summary: SessionScope) => {
      const roots = scopeFolders(summary, workspaceRoot).map(folder => folder.path)
      const seen = new Map<string, boolean>()
      return (path: string) => {
        let known = seen.get(path)
        if (known === undefined) seen.set(path, (known = insideRootsSync(path, roots)))
        return known
      }
    }
    /** A session's detail as this caller's data scope shows it. */
    const shownDetail = (caller: Caller, detail: TaskDetail): TaskDetail => {
      const scope = caller.device ? devices.get(caller.device.id)?.dataScope : undefined
      if (scope === 'all') return allTaskContent(detail)
      return scope === 'files' ? filesTaskContent(detail, insideSession(detail.summary)) : workTaskContent(detail)
    }

    /** Why this caller may not reuse the worktree a session holds, or undefined when it may. */
    async function worktreeHolder(caller: Caller, sessionId: string | undefined, markedPrivate = false): Promise<string | undefined> {
      const owner = sessionId ? await worktreeOwner(sessionId) : { state: 'leftover' as const, private: false, reason: undefined }
      if (owner.reason) return owner.reason
      if ((owner.private || markedPrivate) && !fullData(caller)) return '这个工作树的会话含有私有内容，只有数据范围为全部的设备能沿用它。'
      return undefined
    }

    /** A turn runs or waits in this folder. */
    async function turnIn(path: string): Promise<boolean> {
      return (await hub!.listTasks()).some(
        task => ACTIVE_STATUSES.has(task.status) && sessionFolders(task, workspaceRoot).some(folder => isInsidePath(folder, path)),
      )
    }

    /**
     * The Latch worktrees of a project, with whose they are and whether this caller may reuse them; a private session's
     * id and branch are left out for a device without the full data scope.
     */
    async function latchWorktrees(record: WorkspaceRecord, caller: Caller): Promise<LatchWorktree[]> {
      const listed: LatchWorktree[] = []
      for (const entry of await worktrees.list(record.folders[0].path)) {
        const owner = entry.sessionId ? await worktreeOwner(entry.sessionId) : { state: 'leftover' as const, private: false }
        // The marker keeps a private session's mark after that session is deleted.
        const secret = owner.private || entry.private
        const hidden = secret && !fullData(caller)
        const reason = worktrees.busy(entry.path)
          ? '这个工作树正在开始会话或正在移除。'
          : await worktreeHolder(caller, entry.sessionId, entry.private)
        listed.push({
          name: entry.name,
          ...(entry.branch && !hidden ? { branch: entry.branch } : {}),
          state: owner.state,
          ...(entry.sessionId && owner.state !== 'leftover' && !hidden ? { sessionId: entry.sessionId } : {}),
          reusable: reason === undefined,
          ...(reason ? { reason } : {}),
        })
      }
      return listed
    }

    /** The sessions whose folder a worktree is, by the Host's records and its marker. */
    /** Every session with a folder that is the worktree or lies in it (a project inside it too), by records and listing. */
    async function worktreeSessions(path: string): Promise<Set<string>> {
      const owners = new Set(
        hub!
          .worktrees()
          .filter(entry => isInsidePath(entry.path, path))
          .map(entry => entry.sessionId),
      )
      for (const task of await hub!.listTasks())
        if (sessionFolders(task, workspaceRoot).some(folder => isInsidePath(folder, path))) owners.add(task.id)
      const marked = await worktrees.sessionOf(path)
      if (marked) owners.add(marked)
      return owners
    }

    /** What removing a worktree would lose (file names among it), and what keeps it from being removed now. */
    async function worktreeFacts(caller: Caller, path: string): Promise<WorktreeInventory> {
      if (!projectFiles(caller)) throw new AppError(403, 'file-scope', '这台设备的数据范围不包括项目文件夹中的文件。')
      const facts = await worktrees.inventory(path)
      const pending = worktrees.busy(path)
      const common = await worktrees.common(path)
      const busy =
        pending
        ?? (repositoryHolds.of(common)
          ? 'delivery'
          : (await turnIn(path))
            ? 'turn'
            : terminals.openIn(await worktreeSessions(path)) || terminals.openInside(await canonicalPath(path))
              ? 'terminal'
              : undefined)
      return { ...facts, ...(busy ? { busy } : {}) }
    }

    /** A removal this Host already made, as its `worktree.result` record says: for a retry after a restart. */
    function earlierRemoval(key: { requestHash: string; deviceId: string } | { worktreeHash: string }): WorktreeRemoval | undefined {
      const found =
        'requestHash' in key ? audit.worktreeRemoval(`request:${key.requestHash}`) : audit.worktreeRemoval(`tree:${key.worktreeHash}`)
      if (!found || ('deviceId' in key && found.actor.deviceId !== key.deviceId)) return undefined
      const branch = found.detail.branch
      return {
        removed: true,
        discarded: typeof found.detail.discarded === 'number' ? found.detail.discarded : 0,
        branch: branch === 'deleted' || branch === 'kept' ? branch : 'none',
      }
    }

    const removals = new Map<string, Promise<WorktreeRemoval>>()

    /**
     * Removes a Latch worktree of `record` (the session's, or a leftover with no session): in the project's queue, with
     * the repository held against delivery, refused while a turn runs there. The audit record comes before Git runs;
     * the same request gets the same answer.
     */
    function removeWorktree(
      caller: Caller,
      res: ServerResponse,
      record: WorkspaceRecord,
      path: string,
      sessionId: string | undefined,
      body: z.infer<typeof removeWorktreeSchema>,
    ): Promise<WorktreeRemoval> {
      requireScope(caller, 'run')
      if (!projectFiles(caller)) throw new AppError(403, 'file-scope', '这台设备的数据范围不包括项目文件夹中的文件。')
      const key = `${caller.device.id}:${body.requestId}`
      const known = removals.get(key)
      if (known) return known
      // Counted as a Git write from here, so the install waits for it; refused once the install window is committed.
      const leave = repositoryHolds.enter()
      const requestHash = sha256Hex(body.requestId)
      const target = { workspaceId: record.id, ...(sessionId ? { sessionId } : {}), worktreeHash: sha256Hex(path), requestHash }
      const removal = (): Promise<WorktreeRemoval> =>
        projectOperation(record.id, caller, 'run', async () => {
          if (!projectFiles(caller)) throw new AppError(403, 'file-scope', '这台设备的数据范围不包括项目文件夹中的文件。')
          if (sessionId) {
            checkPrivateSession(caller, sessionId)
            // Git removed it before and only the session's record was left: finish that.
            const done = !existsSync(path) && earlierRemoval({ worktreeHash: sha256Hex(path) })
            if (done) {
              await hub!.worktreeRemoved(sessionId)
              refresh(sessionId)
              return done
            }
            // Git removed it but the Host stopped before the result was recorded (the marker went with the folder):
            // finish from the record written before Git ran, and say whether its branch is still there.
            const begun = !existsSync(path) && audit.worktreeRemovalBegun(sha256Hex(path))
            if (begun && begun.detail.sessionId === sessionId) {
              // Latch deletes its branch only after Git removed the folder: it may or may not have got that far.
              const left =
                begun.detail.ownBranch === true
                  ? await worktrees.branchLeft(record.folders[0]?.path ?? record.path, basename(path))
                  : undefined
              const branch = begun.detail.ownBranch !== true ? ('none' as const) : left === false ? ('deleted' as const) : ('kept' as const)
              await audited(
                {
                  action: 'worktree.result',
                  actor: actorOf(caller),
                  target: sessionId,
                  stepup: 'none',
                  detail: { ...target, outcome: 'removed', branch },
                },
                res,
              )
              await hub!.worktreeRemoved(sessionId)
              refresh(sessionId)
              return { removed: true as const, discarded: 0, branch }
            }
            if ((await worktrees.sessionOf(path)) !== sessionId)
              throw new AppError(409, 'worktree-owned', '这个工作树已不属于这个会话，没有改动。')
          } else {
            const owner = await worktrees.sessionOf(path)
            if (owner && (await worktreeOwner(owner)).state !== 'leftover')
              throw new AppError(409, 'worktree-owned', '这个工作树属于一个会话，请在那个会话的菜单里移除它。')
          }
          const release = repositoryHolds.take(await worktrees.common(path), 'worktree-remove')
          if (!release) throw new AppError(409, 'worktree-busy', '这个仓库正在进行交付操作，等它结束后再试。')
          try {
            const refuseTurn = async () => {
              if (await turnIn(path)) throw new AppError(409, 'worktree-turn-running', '这个工作树里有一轮正在运行，结束后再试。')
            }
            const owners = await worktreeSessions(path)
            const worktreeDirectory = await canonicalPath(path)
            const refuseTerminal = () => {
              if (terminals.openIn(owners) || terminals.openInside(worktreeDirectory))
                throw new AppError(409, 'worktree-terminal-open', '这个工作树还有打开的终端，关闭后再移除。')
            }
            await refuseTurn()
            let recorded = false
            // No await between this check and remove(), which marks the worktree as removing: no terminal opens after it.
            refuseTerminal()
            const removing = worktrees.remove(path, {
              directory: worktreeDirectory,
              ...(body.discard !== undefined ? { discard: body.discard } : {}),
              ...(body.digest !== undefined ? { digest: body.digest } : {}),
              ...(body.deleteBranch ? { deleteBranch: true } : {}),
              audit: async facts => {
                await refuseTurn()
                refuseTerminal()
                recheck(caller, 'run')
                recorded = true
                await audited({
                  action: 'worktree.remove',
                  actor: actorOf(caller),
                  target: sessionId ?? record.id,
                  stepup: 'none',
                  detail: {
                    ...target,
                    staged: facts.staged,
                    unstaged: facts.unstaged,
                    untracked: facts.untracked,
                    ignored: facts.ignored,
                    forced: facts.files > 0,
                    ownBranch: facts.ownBranch,
                    deleteBranch: body.deleteBranch === true,
                    merged: facts.merged?.into ?? 'none',
                    ...(facts.ahead !== undefined ? { ahead: facts.ahead } : {}),
                    ...(facts.unpushed !== undefined ? { unpushed: facts.unpushed } : {}),
                  },
                })
              },
            })
            const removed = await removing.catch(async (error: unknown) => {
              if (recorded)
                await audited(
                  {
                    action: 'worktree.result',
                    actor: actorOf(caller),
                    target: sessionId ?? record.id,
                    stepup: 'none',
                    detail: { ...target, outcome: 'failed' },
                  },
                  res,
                )
              throw error
            })
            const discarded = removed.facts.files + removed.facts.ignored
            // Recorded before the session is marked, so a retry can finish marking it if that fails.
            await audited(
              {
                action: 'worktree.result',
                actor: actorOf(caller),
                target: sessionId ?? record.id,
                stepup: 'none',
                detail: { ...target, outcome: 'removed', branch: removed.branch, discarded },
              },
              res,
            )
            if (sessionId) await hub!.worktreeRemoved(sessionId)
            refresh(sessionId)
            return {
              removed: true as const,
              discarded,
              branch: removed.branch,
              ...(removed.branchName ? { branchName: removed.branchName } : {}),
            }
          } finally {
            release()
          }
        })
      const answer = (async () => {
        try {
          return await removal()
        } finally {
          leave()
        }
      })()
      removals.set(key, answer)
      while (removals.size > 256) removals.delete(removals.keys().next().value!)
      answer.catch(() => {
        if (removals.get(key) === answer) removals.delete(key)
      })
      return answer
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

    async function terminalWorkspaceFolder(workspaceId: string): Promise<{ path: string; check(opened: BigIntStats): void }> {
      const unavailable = () => new AppError(409, 'terminal-folder-unavailable', '项目的主文件夹已不可用，不能在这里打开终端')
      const record = workspaceId === 'default' ? undefined : requireProject(workspaceId)
      const requested = record?.folders[0].path ?? workspaceRoot
      const path = await realpath(requested).catch(() => {
        throw unavailable()
      })
      const initial = record ? await stat(path, { bigint: true }).catch(() => undefined) : defaultFolder
      if (!initial?.isDirectory()) throw unavailable()
      if (record) await assertWorkspaceUsable(record)
      const check = (opened: BigIntStats) => {
        if (opened.dev !== initial.dev || opened.ino !== initial.ino) throw unavailable()
        try {
          const current = statSync(requested, { bigint: true, throwIfNoEntry: false })
          if (current?.isDirectory() && current.dev === initial.dev && current.ino === initial.ino && realpathSync(requested) === path)
            return
        } catch {
          throw unavailable()
        }
        throw unavailable()
      }
      check(initial)
      return { path, check }
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
      const helperOwner = task?.agent?.customAgentId ?? (task?.generalChat ? GENERAL_AGENT_ID : undefined)
      // A driver's first turn can reach a tool before createTask has returned and the Host's folder marker is durable.
      const helper =
        task?.cwd
        && (hub!.sessionFolderOf(sessionId)?.startsWith('helpers/')
          || (helperOwner
            && (!task.workspaceId || task.workspaceId === 'default')
            && basename(task.cwd) === helperOwner
            && basename(dirname(task.cwd)) === 'helpers'))
      if (helper && task?.cwd) {
        if (!(await ownFolders.verify(task.cwd))) throw workspaceChanged()
        await assertHelperHome(task.cwd)
      }
      // A worktree session needs its project, and the worktree still Latch's and this session's, where it started.
      const worktree = task && hub!.worktreeOf(task.id)
      if (task && worktree) {
        if (worktree.removed) throw new AppError(409, 'worktree-removed', '这个会话的工作树已经移除，会话只能查看。')
        if (worktrees.busy(worktree.path) === 'removing') throw new AppError(409, 'worktree-removing', '正在移除这个会话的工作树。')
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

    /** Evaluated inside the settings write too: an allocation can finish while a folder picker or audit is awaiting. */
    function assertNoHelperProject(paths: readonly string[]): void {
      for (const name of ownFolders.helperNames()) {
        const home = join(canonicalWorkspace, name)
        if (paths.some(path => isInsidePath(path, home) || isInsidePath(home, path)))
          throw new AppError(409, 'helper-home-overlap', 'Agent 的家保留为它自己的工作位置，不能登记成项目。')
      }
    }

    /** Granting: the project is on record before it is saved, and a failed save marks the record as never committed. */
    async function saveNewProject(caller: DeviceCaller, record: WorkspaceRecord, via: FolderVia): Promise<WorkspaceInfo> {
      const paths = await Promise.all(record.folders.map(folder => canonicalPath(folder.path)))
      assertNoHelperProject(paths)
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
          assertNoHelperProject(paths)
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
      const paths = await Promise.all(plan.folders.map(folder => canonicalPath(folder.path)))
      assertNoHelperProject(paths)
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
          assertNoHelperProject(paths)
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
      const modelChanged =
        input.defaultModel !== undefined && canonicalJson(input.defaultModel ?? null) !== canonicalJson(record.defaultModel ?? null)
      // A model it can start on now; clearing never needs one.
      if (modelChanged && input.defaultModel) assertModel(input.defaultModel)
      if (!renamed && !glyphChanged && !reordered && !modelChanged) return projectInfo(record, await projectState(record))
      if (primaryChanged) {
        const verdict = await checkProjectFolders([folders[0].path], { existing: primaries(record.id) })
        if (!verdict.ok) throw verdict.error
      }
      const seq = await audited({
        action: 'workspace.changed',
        actor: actorOf(caller),
        target: record.id,
        detail: { workspaceId: record.id, renamed, glyphChanged, primaryChanged, reordered, ...(modelChanged ? { modelChanged } : {}) },
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
          if (modelChanged) {
            if (input.defaultModel) target.defaultModel = { ...input.defaultModel }
            else delete target.defaultModel
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
      terminals.checkWorkspaceEnd(id)
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
      await terminals.forgetWorkspace(id)
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
      if (reason === 'unsupported') throw providerUnsupported(record!)
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
      if (!saved || !modelAvailable(saved)) return undefined
      const { providerId, model, effort } = saved
      return { providerId, model, ...(effort && declaredThinking(saved).includes(effort) ? { effort } : {}) }
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

    /**
     * The project's 默认模型 for a session of `harnessId` that chose none and whose Agent has none: only while the model
     * can be used now, and by this harness. Otherwise the harness's own default stands.
     */
    function projectDefaultModel(projectId: string | undefined, harnessId: string): ModelRef | undefined {
      const saved = projectId && projectId !== 'default' ? savedProject(projectId)?.defaultModel : undefined
      const harness = hub?.info(harnessId)
      if (!saved || !harness || !modelAvailable(saved)) return undefined
      if (harness.capabilities.models.owner !== 'latch') {
        const record = effectiveProvider(saved.providerId)
        const route = record && isProviderKind(record.kind) ? pairRoute(harness.capabilities, { kind: record.kind }) : undefined
        if (route?.kind !== 'passthrough' && route?.kind !== 'translate') return undefined
        // A thinking level is the built-in harness's to send; another harness sets its own.
        return { providerId: saved.providerId, model: saved.model }
      }
      const declared = declaredThinking(saved)
      return {
        providerId: saved.providerId,
        model: saved.model,
        ...(saved.effort && declared.includes(saved.effort) ? { effort: saved.effort } : {}),
      }
    }

    function declaredThinking(ref: ModelRef): readonly string[] {
      return effectiveProvider(ref.providerId)?.modelCapabilities?.[ref.model]?.thinking ?? []
    }

    function defaultHarnessId(offers: readonly HarnessInfo[] = []): string {
      if (options.harnessId) return options.harnessId
      const saved = config.settings().defaults.harnessId
      if (saved) return hub?.info(saved)?.status === 'ready' ? saved : STANDARD
      // Nothing chosen yet: Latch 内置 while it has a model, otherwise the first ready Harness that runs commands, on its
      // own models. A choice in the composer replaces it.
      if (defaultModelRef()) return STANDARD
      return firstReadyHarness([...(hub?.drivers() ?? []), ...offers])?.id ?? STANDARD
    }

    function savedGateway(harnessId: string): ModelRef | null | undefined {
      const saved = config.settings().defaults
      return saved.harnessId === harnessId && saved.gateway?.harnessId === harnessId ? saved.gateway.model : undefined
    }

    function visibleGateway(harness: HarnessInfo): Pick<SessionDefaults, 'gateway' | 'gatewayUnavailable'> {
      const gateway = savedGateway(harness.id)
      if (gateway === null) return { gateway }
      if (!gateway) return {}
      try {
        modelRouteFor(harness, gateway)
        return { gateway }
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        return { gatewayUnavailable: true }
      }
    }

    function sessionDefaults(offers: readonly HarnessInfo[] = []): SessionDefaults {
      const saved = config.settings().defaults
      const model = defaultModelRef()
      const modelUnavailable = !options.providerId && saved.model !== undefined && !savedDefaultModel()
      // What was pinned must still be what starts: when its engine or model cannot, the fallback is not what anyone chose,
      // and the device's own memory takes over. It holds again if they come back.
      const harnessId = defaultHarnessId(offers)
      const engine = hub?.info(saved.harnessId ?? STANDARD)
      const gateway = engine?.id === harnessId && engine.capabilities.models.owner !== 'latch' ? visibleGateway(engine) : {}
      const pinned =
        saved.pinned === true
        && engine?.status === 'ready'
        && (engine.capabilities.models.owner !== 'latch' || saved.model === undefined || savedDefaultModel() !== undefined)
      return {
        harnessId,
        mode: saved.mode ?? 'agent',
        workspaceId:
          saved.workspaceId && saved.workspaceId !== 'default' && lastSeenUsable(savedProject(saved.workspaceId))
            ? saved.workspaceId
            : 'default',
        ...(model ? { model } : {}),
        ...(modelUnavailable ? { modelUnavailable: true as const } : {}),
        ...gateway,
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
      if (input.model) {
        assertModel(input.model)
        if (input.model.effort && !declaredThinking(input.model).includes(input.model.effort))
          throw new AppError(400, 'model-effort-unavailable', '这个模型没有声明所选的思考深度。')
      }
      const { harnessId, gateway } = input
      if (gateway !== undefined) {
        requireScope(caller, 'admin')
        requireDesktop(caller)
        if (!harnessId) throw new AppError(400, 'harness-required', '保存模型来源时请同时选择它所属的 Harness。')
        const harness = hub!.info(harnessId)
        if (!harness || harness.status !== 'ready' || harness.capabilities.models.owner === 'latch')
          throw new AppError(400, 'model-route-unavailable', '这个 Harness 不能保存外部模型来源。')
        if (gateway !== null) modelRouteFor(harness, gateway)
      }
      await writeSettings(
        caller,
        draft => {
          if (input.harnessId !== undefined) draft.defaults.harnessId = input.harnessId
          if (input.mode !== undefined) draft.defaults.mode = input.mode
          if (input.workspaceId !== undefined) draft.defaults.workspaceId = input.workspaceId
          if (input.pinned === true) draft.defaults.pinned = true
          else if (input.pinned === false) delete draft.defaults.pinned
          if (input.model === null) delete draft.defaults.model
          else if (input.model) draft.defaults.model = input.model
          if (harnessId && gateway !== undefined) draft.defaults.gateway = { harnessId, model: gateway }
        },
        'admin',
      )
    }

    /**
     * A saved definition the cache says is too old is read once more before a start is judged by it: a shim stays the
     * same file when the program behind it is upgraded. Still too old, it is refused (409 `harness-version-unsupported`).
     */
    async function rereadOutdated(id: string): Promise<void> {
      const record = config.settings().agents.find(agent => agent.id === id)
      if (record && versionReadable(record) && outdatedRefusal(record)) await assertCommandVersion(record)
    }

    /** A saved definition whose command is too old is refused as a running session would refuse it: one code, one sentence. */
    function refuseOutdated(id: string): void {
      const record = config.settings().agents.find(agent => agent.id === id)
      const refused = record && outdatedRefusal(record)
      if (refused) throw refused
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
      // One known to be too old is listed too, unavailable with `statusReason: 'outdated'`: a draft shows it greyed with
      // 需要升级 instead of as a choice, and a draft that had chosen it keeps it, with the upgrade command.
      return presetLookup.found.filter(preset => !saved.has(preset.id) && !hub!.info(preset.id)).map(presetOffer)
    }

    /** A saved Harness definition this Host runs and that can start now. */
    function editableHarness(id: string): HarnessInfo {
      const harness = hub!.info(id)
      if (!harness?.editable || !hub!.has(id)) throw new AppError(404, 'agent-not-found', '找不到该 Harness')
      if (harness.status !== 'ready') {
        refuseOutdated(id)
        throw new AppError(409, 'harness-unavailable', harness.statusMessage ?? `${harness.capabilities.display.label} 当前不可用`)
      }
      return harness
    }

    /** A draft's Harness, which may not be saved yet: it decides which folders a file search covers. */
    const draftHarness = (id: string): HarnessInfo | undefined => hub!.info(id) ?? presetsToOffer().find(item => item.id === id)

    async function catalog(caller: Caller): Promise<HostCatalog> {
      // Only a device that may save a definition is offered one; everyone else keeps what is defined.
      const mayDefine = caller.device?.scopes.includes('admin') === true && isLocalListener(caller.connection.listener)
      const offers = mayDefine ? presetsToOffer() : []
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
          singleAgentChat: true,
          usage: true,
          modelUsage: true,
          providerUpdateTarget: true,
          fileSearch: true,
          ...(directoryReader.available ? { fileTree: true as const } : {}),
          filePreview: true,
          configReceipts: true,
          configCheck: true,
          runLiveness: true,
          pinnedDefaults: true,
          worktreeLifecycle: true,
          extensions: true,
          ...routes.features(caller),
        },
        harnesses: [...hub!.drivers(), ...offers].map(harness => {
          const reported = harness.attachmentsReported ?? reportedAttachments(harness)
          const card =
            harness.capabilities.permission.enforcement === 'latch'
              ? BUILTIN_HELPER_CARD
              : AGENT_PRESETS.find(preset => preset.id === harness.capabilities.display.mark)?.helperCard
          const { helperCard: _ignored, ...info } = harness
          const path = config.settings().agents.find(agent => agent.id === harness.id)?.confirmedCommand
          return {
            ...info,
            ...(reported ? { attachmentsReported: reported } : {}),
            ...(card ? { helperCard: card } : {}),
            ...(path
              ? { bound: { id: createHmac('sha256', boundKey).update(path).digest('hex').slice(0, 16), ...(mayDefine ? { path } : {}) } }
              : {}),
          }
        }),
        providers: usableProviders().map(providerSummary),
        unusableProviders: unusableProviders(),
        uiPanels: registry.uiPanels(),
        skills: registry.skills(),
        // Disabled workspaces are listed with their reason for settings; session pickers skip any entry marked unavailable.
        workspaces: await projectInfos(),
        defaults: sessionDefaults(offers),
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
        ? await classifyCall({ toolName: approval.toolName, arguments: args, ...session, sessionId: approval.sessionId })
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
        ...(memoryRefusals.get(sessionId)?.length ? { memoryRefusals: memoryRefusals.get(sessionId)! } : {}),
        // Cards go only into topics of 我的 Agent, which are private: only a device with the full data scope reads them.
        ...(hub!.agentPrivate(sessionId) && automations.resultsIn(sessionId).length ? { results: automations.resultsIn(sessionId) } : {}),
        approvals: await Promise.all(detail.approvals.map(approval => decorate(approval, level, detail.summary))),
        ...(computerStopping.has(sessionId)
          ? { computer: { serverId: computerStopping.get(sessionId)!.serverId, stopping: true as const } }
          : computerLive.get(sessionId)?.size
            ? { computer: { serverId: [...computerLive.get(sessionId)!.values()][0]! } }
            : {}),
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
      await hub!.receipts
        .record(sessionId, receipt)
        .catch(error => logNoted('receipt-save-failed', { error: error }, `回执未能保存：${errorText(error)}`))
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
        ? (await classifyCall({ toolName: approval.toolName, arguments: args, ...session, sessionId: approval.sessionId })).reason
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
            ...(opaqueId.safeParse(approval.toolCallId).success ? { toolCallId: approval.toolCallId } : {}),
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
        await promptQueues.stopped(sessionId).catch(() => logNoted('queue-update-failed', {}, '排队状态未能更新，请手动检查队列'))
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
      const device = devices.get(stream.deviceId)
      const scope = JSON.stringify([device?.dataScope, device?.scopes.toSorted()])
      if (stream.scope !== scope) {
        stream.delta?.clear()
        stream.scope = scope
      }
      const allowed =
        (!stream.nativeOpening || nativeRoutes.verifiedUntil(stream.nativeOpening) > now())
        && device?.scopes.includes('view') === true
        && devices.streamAllowed(stream.deviceId, stream.credentialHash)
      if (!allowed) stream.delta?.clear()
      return allowed
    }

    function forgetStream(res: ServerResponse): void {
      streams.get(res)?.delta?.clear()
      streams.delete(res)
    }

    function send(res: ServerResponse, event: ChangeEvent | TaskStateEvent): void {
      const stream = streams.get(res)
      if (!stream || !streamAllowed(stream)) {
        res.end()
        forgetStream(res)
        return
      }
      const scope = devices.get(stream.deviceId)?.dataScope
      // Private sessions only to `all`; file contents (the work projection) to `files` as well.
      const narrow = scope !== 'all'
      const workOnly = scope !== 'all'
      if (event.type === 'task-state' && privateSession(event.detail.summary) && narrow) {
        stream.delta?.clear()
        return
      }
      // Its list did not change, and even a hint without the ID would say when a private session moved: nothing goes.
      // The native cursor only orders frames, so the gap in sequence is fine.
      if (
        narrow
        && event.type === 'tasks-invalidated'
        && event.sessionId !== undefined
        && (privateHints.has(event) || hub!.agentPrivate(event.sessionId))
      )
        return
      // A refresh for a private 待办's change: a narrower device has nothing to read again.
      if (narrow && event.type === 'refresh' && privateHints.has(event)) return
      // A connection can join while an older batch awaits an external Bridge.
      // Equal revisions are valid for different events in the same batch.
      if (event.revision < stream.lastSentRevision) return
      // Disconnect lagging readers; this is not a hard per-frame or memory limit.
      if (res.writableLength > 262_144) {
        res.destroy()
        forgetStream(res)
        return
      }
      if (stream.nativeOpening) {
        if (event.type === 'task-state') stream.nativeOpening.padding?.activity(res, ACTIVE_STATUSES.has(event.detail.summary.status))
        if (!stream.paddingObserved) {
          stream.paddingObserved = true
          res.once('close', () => stream.nativeOpening?.padding?.activity(res, false))
        }
      }
      const canonical = event
      const nativeCursor = stream.nativeOpening ? nativeReplay.cursorOf(canonical) : undefined
      if (workOnly && event.type === 'task-state') {
        // A `files` reader gets its own view when it was made for this event, and the work view otherwise.
        const projected = (scope === 'files' ? filesEvents.get(event) : undefined) ?? workEvents.get(event)
        if (!projected) {
          stream.delta?.clear()
          return
        }
        event = projected
      }
      if (stream.delta && event.type === 'task-state' && (!stream.nativeOpening || nativeCursor !== undefined)) {
        const projected = stream.delta.encode(event)
        // The stamp belongs only to this reader; neither the shared WeakMap nor native replay may retain it.
        const frame = `id: ${nativeCursor ?? event.revision}\nevent: ${projected.type}\ndata: ${JSON.stringify(projected)}\n\n`
        write(res, stream, projected.type, frame, event.sessionId)
        stream.lastSentRevision = event.revision
        return
      }
      let frame = frames.get(event)
      if (stream.nativeOpening) {
        // An unretained checkpoint cannot become an acknowledged per-reader baseline.
        if (nativeCursor === undefined) stream.delta?.clear()
        frame =
          (event === canonical
            ? nativeReplay.frame(canonical)
            : nativeCursor !== undefined
              ? `id: ${nativeCursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
              : undefined)
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
        forgetStream(res)
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

    /** A plugin's applied pages changed: every stream hears it and reads the snapshot again, where the pages are. */
    function sendAppUpdated(pluginId: string): void {
      const event: AppUpdatedEvent = { type: 'app.updated', instanceId, pluginId }
      const frame = `event: app.updated\ndata: ${JSON.stringify(event)}\n\n`
      for (const [res, stream] of streams) {
        if (!streamAllowed(stream)) continue
        if (stream.nativeOpening && nativeRoutes.verifiedUntil(stream.nativeOpening) <= now()) continue
        write(res, stream, 'app.updated', frame)
      }
    }

    /** Announces the stop on every stream and ends them all, giving the last frames a moment to leave. */
    async function endStreams(event: HostStateEvent): Promise<void> {
      const open = [...streams.keys()]
      for (const res of open) sendHostState(res, event)
      for (const res of open) forgetStream(res)
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
      const privateOnly = pendingPrivate && !global
      const globalRevision = revision
      const tasks = [...pendingTasks]
      pendingGlobal = false
      pendingPrivate = false
      pendingTasks.clear()
      try {
        if (privateOnly) {
          const event = nativeReplay.publish({
            type: 'refresh',
            instanceId,
            revision: globalRevision,
            discoveryEpoch: discoveryEpoch(),
            directoryEpoch: relayDirectory.epoch(),
          })
          privateHints.add(event)
          for (const res of streams.keys()) send(res, event)
        }
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
            for (const stream of streams.values()) if (stream.sessionId === sessionId) stream.delta?.clear()
            summaries.delete(sessionId)
            fallback = true
            continue
          }
          const signature = JSON.stringify([listSignature(detail.summary), detail.approvals])
          const summaryChanged = summaries.get(sessionId) !== signature
          summaries.set(sessionId, signature)
          const sentAt = hostTime()
          const source = { ...detail, sync: { instanceId, revision: globalRevision, hostTime: sentAt } }
          const event = nativeReplay.publish({
            type: 'task-state',
            instanceId,
            revision: globalRevision,
            sessionId,
            detail: allTaskContent(source),
            hostTime: sentAt,
          })
          // Keep the restricted view with the retained canonical event. Neither wire includes Host-only provenance;
          // the immutable copy also prevents later driver mutation from changing a replay's authorized content.
          if (event.type === 'task-state') {
            const restricted = workTaskContent(source)
            workEvents.set(
              event,
              restricted === source ? event : { ...event, detail: JSON.parse(JSON.stringify(restricted)) as TaskDetail },
            )
            if ([...streams.values()].some(stream => devices.get(stream.deviceId)?.dataScope === 'files')) {
              const files = filesTaskContent(source, insideSession(source.summary))
              filesEvents.set(event, files === source ? event : { ...event, detail: JSON.parse(JSON.stringify(files)) as TaskDetail })
            }
          }
          const invalidated = summaryChanged
            ? nativeReplay.publish({ type: 'tasks-invalidated', instanceId, revision: globalRevision, sessionId })
            : undefined
          // Recorded with the event, so a replay after the session is gone still hides it.
          if (invalidated && (privateSession(detail.summary) || hub!.agentPrivate(sessionId))) privateHints.add(invalidated)
          for (const [res, stream] of streams) {
            if (stream.sessionId === sessionId) send(res, event)
            else if (invalidated) send(res, invalidated)
          }
        }
        for (const [sessionId] of tasks)
          void promptQueues.changed(sessionId).catch(() => logNoted('queue-update-failed', {}, '排队状态未能更新，请手动检查队列'))
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
        if (pendingGlobal || pendingPrivate || pendingTasks.size) scheduleEvents()
      }
    }

    function refresh(sessionId?: string): void {
      nativeRoutes.reconcile()
      const nextRevision = ++revision
      if (sessionId) pendingTasks.set(sessionId, nextRevision)
      else pendingGlobal = true
      scheduleEvents()
    }

    function refreshPrivate(): void {
      nativeRoutes.reconcile()
      ++revision
      pendingPrivate = true
      scheduleEvents()
    }

    /** A 待办 changed: clients read the snapshot again, and each named session's summary (its `itemId`). */
    /** A proposal changed: as a 待办's change, a private one only reaches the full data scope's connections. */
    function proposalChanged(row: WorkProposalRecord): void {
      // The same rule as reading it: its session, or the card it waits for, private now.
      if (workProposalRoutes.isPrivate(row)) refreshPrivate()
      else refresh()
    }
    function itemChanged(item: WorkItemRecord, sessionIds: readonly string[]): void {
      const isPrivate = itemIsPrivate(item, id => hub!.agentPrivate(id))
      if (isPrivate) refreshPrivate()
      else refresh()
      // A private 待办's change touches no visible session: those are not refreshed, so their streams hear nothing of it.
      for (const id of sessionIds) if (!isPrivate || hub!.agentPrivate(id)) refresh(id)
    }
    const unsubscribe = harnessHub.subscribe(refresh)
    const heartbeat = setInterval(() => {
      for (const [res, stream] of streams) {
        if (!streamAllowed(stream)) {
          res.end()
          forgetStream(res)
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
        // The hostId is public (the loopback name and enrollment-info carry it): a desktop app checks it before it sends
        // another computer's Host a credential.
        json(res, { ok: true, hostId })
        return true
      }
      if (path === '/link/api/host/state') {
        // Only this computer reports sleep, wake and why it is about to stop the Host: the desktop app and the command line.
        if (!isLocalListener(listener.listener)) throw new AppError(404, 'not-found', '接口不存在')
        if (method !== 'POST') throw new AppError(405, 'method-not-allowed', '不支持此操作')
        const body = await jsonBody(req)
        if (body && typeof body === 'object' && (body as { state?: unknown }).state === 'desktop') {
          // What the desktop app keeps this Mac awake for; it reports this at least every half minute while it runs.
          computer.report(desktopReportSchema.parse(body))
          json(res, { ok: true })
          return true
        }
        const input = hostStateInputSchema.parse(body)
        const event = lifecycle.report(input)
        if (event) {
          for (const stream of [...streams.keys()]) sendHostState(stream, event)
          // Clients resynchronize after a wake; runs the sleep interrupted show as they are now.
          if (event.state === 'awake') refresh()
        }
        // Recorded after the announcement: the Mac may be asleep before a write lands, the clients must hear it first.
        if (input.state === 'sleeping') await computer.sleeping()
        if (input.state === 'awake') await computer.awake()
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
          scheduleWake: scheduleWake(),
          protocol: HOST_PROTOCOL,
          ...(modelGateway.listeningPort === undefined ? {} : { modelGatewayPort: modelGateway.listeningPort }),
          ...(options.codeBuild ? { build: options.codeBuild } : {}),
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

    /** The private home never becomes a public project. Its policy is checked both when allocated and on every new turn. */
    async function assertHelperHome(path: string): Promise<void> {
      const root = await checkFolderCandidate(workspaceRoot, workspaceGuard, { added: true, readable: true })
      if (!root.ok) throw root.error
      const candidate = join(canonicalWorkspace, 'helpers', basename(path))
      for (const project of config.settings().workspaces) {
        for (const folder of project.folders) {
          const registered = await canonicalPath(folder.path).catch(() => folder.path)
          if (isInsidePath(candidate, registered) || isInsidePath(registered, candidate))
            throw new AppError(409, 'helper-home-overlap', 'Agent 的家与已登记的项目重叠，请在这台 Mac 上检查工作文件夹。')
        }
      }
    }

    async function prepareHelperHome(owner: string, actor: { actor: AuditActor; authorize(): void }) {
      const folder = await ownFolders.helperHome(owner, async path => {
        actor.authorize()
        await assertHelperHome(path)
        actor.authorize()
      })
      await customAgents.recordHome(owner, folder.name, actor)
      actor.authorize()
      if (!(await ownFolders.verify(folder.path))) throw workspaceChanged()
      return folder
    }

    /**
     * A page draft's skeleton in a session's new folder, before its first input: the manifest, the SDK's declarations
     * and the guide. A retried start finds them there and leaves them as they are.
     */
    async function writeAppDraft(folder: string, name: string): Promise<void> {
      const directory = join(folder, APP_DRAFT_DIRECTORY)
      try {
        await mkdir(directory)
      } catch (error) {
        if (codeOf(error) === 'EEXIST') return
        throw new AppError(409, 'app-draft-folder', '没能在会话文件夹里写入应用草稿。')
      }
      const files: Array<[string, string]> = [
        [APP_DRAFT_MANIFEST, appSkeleton(`app-${name}`)],
        ['sdk.d.ts', APP_SDK_DTS],
        ['README.md', APP_GUIDE],
      ]
      for (const [file, content] of files) {
        const handle = await openFile(join(directory, file), 'wx', 0o644)
        try {
          await handle.writeFile(content)
        } finally {
          await handle.close()
        }
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
          startSession(caller, { ...createTaskSchema.parse(start), withoutPrivateContext: true, pageStart: true }, res),
        )
        json(res, started, 201)
        return
      }
      const input = createTaskSchema.parse(body)
      if (!input.customAgentId) {
        json(res, await startPersonSession(req, caller, input, res), 201)
        return
      }
      if (!input.prompt && !input.forkOf && !input.attachmentIds?.length)
        throw new AppError(400, 'invalid-prompt', '请输入任务内容或添加附件。')
      if (input.customAgentId) agentAccess(caller, true)
      assertGeneralStartCompatible(input)
      const agentHarness =
        input.customAgentId && input.customAgentId !== GENERAL_AGENT_ID
          ? customAgents.list().find(agent => agent.id === input.customAgentId)?.harnessId
          : undefined
      const recorded = agentHarness ? customAgents.recordedStart(input.customAgentId!, caller.device.id, input.requestId) : undefined
      // An Agent's start on another Harness is refused before anything else: no confirmation is asked and nothing is
      // written for a Harness it will not run on. A retry of a start recorded before this rule keeps its receipt below.
      if (agentHarness && input.harnessId && input.harnessId !== agentHarness && !recorded) throw harnessFixed(400)
      const start = async (dispatched?: () => void) => {
        await bindUnconfirmedHarness(
          req,
          caller,
          recorded?.harnessId
            ?? agentHarness
            ?? (input.customAgentId === GENERAL_AGENT_ID ? 'standard' : (input.harnessId ?? config.settings().defaults.harnessId)),
        )
        return startSession(caller, input, res, dispatched)
      }
      const started = input.customAgentId ? await startAgentChat(caller, input, start) : await start()
      const chat = input.customAgentId && !customAgents.hasPending() ? customAgents.chats()[input.customAgentId] : undefined
      const current = chat?.state === 'ready' && chat.sessionId === started.sessionId
      if (current && input.customAgentId)
        await automations
          .adoptResults(input.customAgentId, started.sessionId)
          .catch(error => log(`Agent 聊天没有收下定时结果：${errorText(error)}`))
      const refused =
        current && input.prompt
          ? await rememberFromPerson(
              { deviceId: caller.device.id, actor: actorOf(caller) },
              started.sessionId,
              input.prompt,
              input.requestId,
            )
          : undefined
      if (input.customAgentId) agentAccess(caller, true)
      json(res, { ...started, ...(refused ? { memoryRefused: refused } : {}) }, 201)
    }

    /**
     * A person's start of a Code session: `POST /tasks` without a custom Agent, and `POST /work/items/:id/start`. One
     * function, so both ask the same confirmations and write the same start audits, take the same project queue,
     * worktree, receipts and checks: an empty prompt is refused, a Harness defined before confirmations is bound on
     * this Mac, then `startSession`.
     */
    async function startPersonSession(
      req: IncomingMessage,
      caller: DeviceCaller,
      input: z.infer<typeof createTaskSchema>,
      res: ServerResponse,
      /** What a narrower device wrote is started as that device's own start would be: no private context. */
      withoutPrivateContext = false,
      /**
       * A 待办's start: `privateFrom` makes the session as private as the 待办 it starts from (its 要求 may hold what a
       * private session wrote); `outsideStart` marks its context as holding outside content from its first turn.
       */
      from: { privateFrom?: string; outsideStart?: boolean } = {},
    ): Promise<{ sessionId: string }> {
      if (input.customAgentId) throw new AppError(400, 'invalid-input', '这里只开始 Code 会话。')
      if (!input.prompt && !input.forkOf && !input.attachmentIds?.length)
        throw new AppError(400, 'invalid-prompt', '请输入任务内容或添加附件。')
      await bindUnconfirmedHarness(req, caller, input.harnessId ?? config.settings().defaults.harnessId)
      return startSession(
        caller,
        {
          ...input,
          ...(withoutPrivateContext ? { withoutPrivateContext: true as const } : {}),
          ...(from.privateFrom ? { privateFrom: from.privateFrom } : {}),
          ...(from.outsideStart ? { outsideStart: true as const } : {}),
        },
        res,
      )
    }

    const firstChatsInFlight = new Map<string, Promise<{ sessionId: string }>>()

    function agentChatUnconfirmed(): AppError {
      return new AppError(503, 'agent-chat-start-unconfirmed', '这个 Agent 的第一条消息尚未确认，请重试同一次提交。')
    }

    async function historicalChat(caller: DeviceCaller, id: string): Promise<boolean> {
      const owner = hub!.agentOf(id)?.customAgentId ?? (hub!.generalChatOf(id) ? GENERAL_AGENT_ID : undefined)
      if (!owner) return false
      await migrateAgentChats(caller)
      const chat = customAgents.chats()[owner]
      if (!chat && (owner === GENERAL_AGENT_ID || customAgents.list().some(agent => agent.id === owner)))
        throw new AppError(503, 'agent-chat-history-unknown', '旧会话尚未核对完成，请稍后再试。')
      return chat?.state !== 'ready' || chat.sessionId !== id
    }

    /**
     * A stored first message is evidence of an accepted start, even if its response or the Host's binding was lost.
     * Another task using the same request ID is ambiguous. Only a whole inventory with readable relevant records can
     * establish absence before replaying a held start.
     */
    async function findAgentChatStart(
      owner: string,
      actor: AgentActor,
      input: z.infer<typeof createTaskSchema>,
    ): Promise<{ sessionId: string } | undefined> {
      const listing = await hub!.listTasksProven()
      const harnessId =
        customAgents.recordedStart(owner, actor.actor.deviceId, input.requestId)?.harnessId
        ?? (owner === GENERAL_AGENT_ID ? STANDARD : customAgents.get(owner).harnessId)
      if (!listing.listed.has(harnessId)) throw agentChatUnconfirmed()
      let found: string | undefined
      for (const task of listing.tasks) {
        if (task.harnessId !== harnessId) continue
        const account = task.agent?.customAgentId ?? (task.generalChat ? GENERAL_AGENT_ID : undefined)
        const detail = await hub!.detail(task.id).catch(() => {
          throw agentChatUnconfirmed()
        })
        actor.authorize()
        const message = detail.messages.find(item => item.role === 'user')
        if (message?.requestId !== input.requestId) continue
        if (account !== owner || task.automationId || task.forkOf || found) throw agentChatUnconfirmed()
        if (
          message.text !== input.prompt
          || canonicalJson(message.attachments?.map(ref => ref.id) ?? []) !== canonicalJson(input.attachmentIds ?? [])
        )
          throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入。')
        if (canonicalJson(message.fileRefs ?? []) !== canonicalJson(input.fileRefs ?? [])) throw agentChatUnconfirmed()
        found = task.id
      }
      if (found) return { sessionId: found }
      if (!wholeListing(listing)) throw agentChatUnconfirmed()
      return undefined
    }

    async function startAgentChat(
      caller: DeviceCaller,
      input: z.infer<typeof createTaskSchema>,
      start: (dispatched: () => void) => Promise<{ sessionId: string }>,
    ): Promise<{ sessionId: string }> {
      const owner = input.customAgentId!
      const actor = agentAccess(caller, true)
      if (input.forkOf || input.editOf || input.appDraft) throw new AppError(409, 'agent-chat-fork', '请在 Code 中复制或继续这个会话。')
      await migrateAgentChats(caller)
      const first: FirstChatStart = {
        deviceId: caller.device.id,
        requestId: input.requestId,
        hash: sha256Hex(canonicalJson(input)),
      }
      if (
        customAgents.recordedStart(owner, first.deviceId, first.requestId)
        && !customAgents.knowsChatStart(owner, first.deviceId, first.requestId)
      ) {
        const existing = await findAgentChatStart(owner, actor, input)
        actor.authorize()
        if (existing) return existing
        throw agentChatUnconfirmed()
      }
      const held = await customAgents.reserveChat(owner, first, actor.authorize)
      if (held.state === 'ready') return { sessionId: held.sessionId }
      const inFlight = firstChatsInFlight.get(owner)
      if (inFlight) {
        const existing = await inFlight
        actor.authorize()
        return existing
      }
      const run = async () => {
        let dispatched = false
        try {
          const recovered = held.fresh ? undefined : await findAgentChatStart(owner, actor, input)
          actor.authorize()
          if (recovered && input.attachmentIds?.length)
            await attachmentStore.bind(first.deviceId, input.attachmentIds, recovered.sessionId, first.requestId)
          const created =
            recovered
            ?? (await start(() => {
              dispatched = true
            }))
          await customAgents.settleChat(owner, first, created.sessionId)
          refresh()
          return created
        } catch (error) {
          if (held.fresh && !dispatched) {
            await customAgents.settleChat(owner, first)
            refresh()
          } else if (error instanceof AppError && refusedBeforeAccepting(error.status, error.code)) {
            if (!held.fresh || (await findAgentChatStart(owner, actor, input))) throw agentChatUnconfirmed()
            await customAgents.settleChat(owner, first)
            refresh()
          }
          throw error
        }
      }
      const operation = run().finally(() => {
        firstChatsInFlight.delete(owner)
      })
      firstChatsInFlight.set(owner, operation)
      const created = await operation
      actor.authorize()
      return created
    }

    // Old General starts had no Host selection receipt. Native and Standard chat requests cannot be replayed through
    // the new Standard Agent/home path: rejection or a payload conflict would incorrectly clear their unknown outcome.
    function assertGeneralStartCompatible(input: z.infer<typeof createTaskSchema>): void {
      if (input.customAgentId !== GENERAL_AGENT_ID) return
      if ((input.harnessId !== undefined && input.harnessId !== 'standard') || input.mode === 'chat')
        throw new AppError(503, 'general-start-unconfirmed', '这次旧版通用启动尚未确认。请核对已有话题，或放弃这次提交后再开始。')
      if (
        input.forkOf
        || input.editOf
        || input.worktree
        || input.appDraft
        || (input.workspaceId !== undefined && input.workspaceId !== 'default')
      )
        throw new AppError(400, 'general-chat-project', '和通用的对话不带项目、工作树或分叉。')
      if (input.config?.length) throw new AppError(400, 'config-unsupported', '通用不使用外部 Harness 的设置。')
    }

    /**
     * Every start of a session, from `POST /tasks` and from a handoff: queues, project checks, worktrees, receipts and
     * the start audits are the same. `privateFrom`: the session carries private material from that session, so it is as
     * private as its source. `res` only marks a missing post-start audit record.
     */
    async function startSession(
      caller: DeviceCaller,
      start: SessionStart,
      res: ServerResponse,
      dispatched?: () => void,
    ): Promise<{ sessionId: string }> {
      // A retry of a start this Host has in flight or accepted gets its original answer, window or not; only new starts
      // are refused (a handoff's start is keyed by its own start request ID). A start that failed is forgotten.
      const startKey = `${caller.device.id}:${start.requestId}`
      const started = (result: { sessionId: string }) => {
        noteTurnScope(result.sessionId, caller)
        return result
      }
      if (startRequests.has(startKey)) return startSessionChecked(caller, start, res, dispatched).then(started)
      refuseWhileUpdating('session')
      return tracked(startRequests, startKey, () => startSessionChecked(caller, start, res, dispatched)).then(started)
    }

    async function startSessionChecked(
      caller: DeviceCaller,
      start: SessionStart,
      res: ServerResponse,
      dispatched?: () => void,
    ): Promise<{ sessionId: string }> {
      // A plugin page's start carries no private context, as from a device without all data: its reply goes back to the page.
      const { privateFrom, title, withoutPrivateContext, seed, pageStart, outsideStart, ...requested } = start
      let input = requested
      // A request's folder or worktree is its device's: another device naming the same request ID gets one of its own.
      const folderRequest = `${caller.device.id}:${input.requestId}`
      let made: Worktree | undefined
      let startedIn = false
      recheck(caller, 'run')
      // New topics of 通用 use Standard Agent; ordinary Code sessions still choose their own Harness and context.
      const generalChat = input.customAgentId === GENERAL_AGENT_ID
      const customAgentId = generalChat ? undefined : input.customAgentId
      if (generalChat) {
        const actor = agentAccess(caller, true)
        assertGeneralStartCompatible(input)
        const chosen = await customAgents.reserveStart(
          GENERAL_AGENT_ID,
          input.requestId,
          () => ({
            harnessId: 'standard',
            mode: 'agent',
            workspaceId: 'default',
            ...(input.model ? { model: input.model } : {}),
          }),
          actor,
        )
        input = { ...input, ...chosen }
      }
      // A custom Agent's start fixes its project before it queues: the journal keeps one answer per request, so the
      // project's queue is known before entering it. The project itself is checked again inside.
      if (customAgentId) {
        if (input.config?.length) throw new AppError(400, 'config-unsupported', '请在这个 Agent 的设置里修改默认选项。')
        const actor = agentAccess(caller, true)
        const saved = customAgents.get(customAgentId)
        const { harnessId, workspaceId, mode, model } = input
        const start = await customAgents.reserveStart(
          customAgentId,
          input.requestId,
          () => {
            // Checked when the start is first chosen; a retry of a recorded start gets the choice recorded then.
            if (harnessId !== undefined && harnessId !== saved.harnessId) throw harnessFixed(400)
            return agentPlans.selection(saved, {
              ...(harnessId ? { harnessId } : {}),
              ...(workspaceId ? { workspaceId } : {}),
              ...(mode ? { mode } : {}),
              ...(model ? { model } : {}),
            })
          },
          actor,
        )
        const { model: startModel, workspaceId: startWorkspace, ...choice } = start
        // Judged on what this start uses, not on defaults it replaced. Only the Agent's own project being gone is the
        // Agent's problem: 'default' is the Host's start folder, and another pick is checked as any session's is, below.
        const { defaultProjectId: ownProject, ...savedRest } = saved
        const reason = agentPlans.unavailable({
          ...savedRest,
          harnessId: start.harnessId,
          ...(startModel ? { model: startModel } : {}),
          ...(ownProject && startWorkspace === ownProject ? { defaultProjectId: ownProject } : {}),
        })
        if (reason) throw new AppError(409, 'agent-unavailable', reason)
        input = {
          ...input,
          ...choice,
          ...(startModel ? { model: startModel } : {}),
          ...(startWorkspace ? { workspaceId: startWorkspace } : {}),
        }
      }
      const harnessId = input.harnessId ?? defaultHarnessId()
      // The session or Agent's explicit choice comes first, then the project, then this Harness's default.
      if (!input.model && !input.ownModel && !input.forkOf) {
        const harness = hub!.info(harnessId)
        const ownPick = input.config?.some(pick =>
          harness?.catalogue?.options.some(option => option.id === pick.configId && option.category === 'model'),
        )
        const gateway =
          !customAgentId && seed === undefined && !withoutPrivateContext && !privateFrom && !ownPick ? savedGateway(harnessId) : undefined
        const project = !input.config?.length ? projectDefaultModel(input.workspaceId, harnessId) : undefined
        const preferred = project ?? gateway
        if (preferred) input = { ...input, model: preferred }
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
        if (input.editOf && input.forkOf) throw new AppError(400, 'edit-invalid', '编辑与分叉不能同时使用')
        // 从这里编辑 on a first message: the source decides how private the new session is and what it starts from.
        const edited = input.editOf
          ? await (async () => {
              requireScope(caller, 'view')
              checkPrivateSession(caller, input.editOf!.taskId)
              const summary = await hub!.summary(input.editOf!.taskId)
              recheck(caller, 'view')
              privateAccess(caller, summary)
              return summary
            })()
          : undefined
        const prompt = fork ? fork.text + (input.prompt || '请接着这个会话继续。') : input.prompt
        const baseContext: AgentExecutionContext | undefined =
          (customAgentId
            ? agentPlans.agentContext(
                customAgentId,
                harnessId,
                withoutPrivateContext ? undefined : devices.get(caller.device.id)?.dataScope,
              )
            : generalContextFor(withoutPrivateContext ? undefined : devices.get(caller.device.id)?.dataScope, harnessId))
          ?? (fork && privateSession(fork.source)
            ? { instructions: '', revision: sha256Hex(canonicalJson(['fork', fork.source.id])) }
            : undefined)
          ?? (edited && privateSession(edited) ? { instructions: '', revision: sha256Hex(canonicalJson(['edit', edited.id])) } : undefined)
          ?? (privateFrom ? { instructions: '', revision: sha256Hex(canonicalJson(['handoff', privateFrom])) } : undefined)
        await rereadOutdated(harnessId)
        // A conversation with 通用 may propose memories, on a Harness that can.
        const agentContext = generalChat ? agentPlans.generalChatContext(harnessId, baseContext) : baseContext
        const harness = hub!.info(harnessId)
        if (!harness || !hub!.has(harnessId)) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 未启用`)
        if (harness.status !== 'ready') {
          refuseOutdated(harnessId)
          throw new AppError(409, 'harness-unavailable', harness.statusMessage ?? `${harness.capabilities.display.label} 当前不可用`)
        }
        if (input.mode && !harness.modes.includes(input.mode))
          throw new AppError(400, 'mode-unsupported', `${harness.capabilities.display.label} 不支持该会话模式`)
        if (input.model) assertModel(input.model)
        // A harness with its own models takes a service only through the gateway, by the Host's own reckoning of the pair.
        const modelRoute = input.model && harness.capabilities.models.owner !== 'latch' ? modelRouteFor(harness, input.model) : undefined
        if (input.config?.length && harness.capabilities.models.owner === 'latch')
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
          !chosen && !customAgentId && fork?.source.workspaceId === 'default' && fork.source.sessionFolder && mode === 'agent'
            ? fork.source.cwd
            : undefined
        if (forkFolder && !(await ownFolders.verify(forkFolder))) throw workspaceChanged()
        const helperHome =
          !chosen && (customAgentId || generalChat)
            ? await prepareHelperHome(customAgentId ?? GENERAL_AGENT_ID, agentAccess(caller, true))
            : undefined
        const ownFolder = makeOwnFolders && !chosen && mode === 'agent' && !forkFolder && !helperHome
        if (input.appDraft) {
          // The page pipeline is this Mac's: the desktop's admin device with all data, as for the plugin assets.
          requireScope(caller, 'admin')
          requireDesktop(caller)
          if (devices.get(caller.device.id)?.dataScope !== 'all')
            throw new AppError(403, 'plugin-package-scope', '自定义插件只能由这台电脑上拥有完整数据范围的管理设备编辑。')
          if (!ownFolder || customAgentId || input.worktree)
            throw new AppError(409, 'app-draft-folder', '应用草稿要在会话自己的文件夹里开始：不选项目，用 Agent 模式。')
        }
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
        if (input.fileRefs?.length && !readsProjectFiles(caller.device.dataScope))
          throw new AppError(403, 'file-scope', '此设备不能浏览项目文件。')
        const mentionRoots = chosen
          ? harness.projectFolders?.access === 'all'
            ? chosen.folders
            : [{ id: 'default', path: chosen.folders[0].path }]
          : [{ id: 'default', path: helperHome?.path ?? forkFolder ?? workspaceRoot }]
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
            if (helperHome) {
              await assertHelperHome(helperHome.path)
              if (!(await ownFolders.verify(helperHome.path))) throw workspaceChanged()
            }
            checkStart()
            dispatched?.()
            return await operation()
          } catch (cause) {
            if (cause instanceof AppError && refusedBeforeAccepting(cause.status, cause.code) && attachments.length)
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
        if (fileRefs.length && !projectFiles(caller)) throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
        let startRefs = fileRefs
        if (input.worktree && chosen) {
          made = await worktrees.create({
            source: chosen.folders[0].path,
            requestId: folderRequest,
            start: input.worktree === true ? { from: 'head' } : input.worktree,
            held: (holder, secret) => worktreeHolder(caller, holder, secret),
          })
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
          // A text rebuild waits for the person's first message, which carries it.
          ...(seed ? { seed } : {}),
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
          ...(generalChat ? { generalChat: true as const } : {}),
          // Its agent may propose for the board, where the Harness takes the tools; never a plugin page's session.
          ...(!pageStart && canPropose(harness) ? { workProposals: true as const } : {}),
          // A fork's first message holds the source's record: outside content when that record carries any tool output,
          // or when the source itself ran unwatched or started from outside content.
          ...(outsideStart
          || (fork
            && (fork.outside
              || fork.source.automationId !== undefined
              || hub!.outsideStartOf(fork.source.id)
              || hub!.unattended(fork.source.id)))
          // An edited first message: the source's own words, which may be what a handoff, fork, import or unwatched
          // run brought in.
          || (edited
            && (edited.automationId !== undefined
              || edited.forkOf !== undefined
              || edited.imported !== undefined
              || hub!.outsideStartOf(edited.id)
              || hub!.unattended(edited.id)))
            ? { outsideStart: true as const }
            : {}),
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
              : helperHome
                ? { cwd: helperHome.path, sessionFolder: helperHome.name }
                : forkFolder
                  ? { cwd: forkFolder, sessionFolder: hub!.sessionFolderOf(fork!.source.id) ?? basename(forkFolder) }
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
          } else if (generalChat || agentContext) agentAccess(caller, true)
          if (fileRefs.length && !projectFiles(caller)) throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
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
              .bind(made.path, folderRequest, created.sessionId, hub!.sessionRecord(created.sessionId)?.private === true)
              .catch(error =>
                logNoted(
                  'worktree-mark-failed',
                  { id: created.sessionId },
                  `会话 ${created.sessionId} 的工作树标记写入失败：${error instanceof Error ? error.message : String(error)}`,
                ),
              )
          return created
        }
        if (hub!.levelOf(harnessId) === 'L1') {
          if (ownFolder) {
            const own = await ownFolders.allocate(folderRequest)
            if (input.appDraft) await writeAppDraft(own.path, own.name)
            return await respondCreated(
              await acceptCreate(() => createInOwnFolder({ ...task, cwd: own.path, sessionFolder: own.name }, folderRequest, checkStart)),
            )
          }
          const folders =
            task.cwd === undefined || helperHome || forkFolder || made
              ? undefined
              : chosen
                ? chosen.folders
                : [{ id: 'default', path: workspaceRoot }]
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
        if (own && input.appDraft) await writeAppDraft(own.path, own.name)
        // A worktree's project configuration is read there, now that it exists: it is what the session will run with.
        const cwd = await realpath(made?.path ?? helperHome?.path ?? own?.path ?? forkFolder ?? chosen?.folders[0].path ?? workspaceRoot)
        // As for L1; the audit below counts the ones the driver says it passes to the agent.
        const folders =
          task.cwd === undefined || helperHome || own || forkFolder || made
            ? undefined
            : chosen
              ? chosen.folders.map(({ id, path }) => ({ id, path }))
              : [{ id: 'default', path: workspaceRoot }]
        const promptHash = sha256Hex(
          attachments.length || fileRefs.length || agentContext?.brief || agentContext?.skillBodies || seed
            ? canonicalJson({
                prompt,
                ...(seed ? { seed } : {}),
                // The block goes out with the prompt, so what the record names includes it.
                ...(agentContext?.brief ? { brief: agentContext.brief } : {}),
                ...(agentContext?.skillBodies ? { skills: agentContext.skillBodies } : {}),
                ...(attachments.length ? { attachments: attachments.map(ref => ({ id: ref.id, sha256: ref.sha256 })) } : {}),
                ...(fileRefs.length ? { fileRefs } : {}),
              })
            : prompt,
        )
        const preview = await hub!.launchPreviewOf(harnessId, cwd, folders ? { workspaceId, folders } : undefined, modelRoute, input.config)
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
        const mcpSetHash = await mcpSetHashOf(created.sessionId, harnessId)
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
              ...(mcpSetHash ? { mcpSetHash } : {}),
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
      /** A 待办 thread's delivery: the turn carries outside content, recorded with it (`PromptOptions.outsideContent`). */
      outsideContent = false,
    ): Promise<'steered' | 'accepted' | 'replayed' | { queued: Awaited<ReturnType<PromptQueues['submit']>> }> {
      // The install window: a retry of a turn this Host has on record gets its original answer; a new plain message, and a
      // queued or steered one on a session that is not running (it would start a turn at once), are refused.
      const turnKey = `${id}:${caller.device.id}:${input.requestId}`
      const sent = <T>(result: T) => {
        noteTurnScope(id, caller)
        return result
      }
      if (turnRequests.has(turnKey) || promptQueues.knows(id, caller.device.id, input.requestId))
        return sendPromptChecked(caller, id, input, withoutPrivateContext, outsideContent).then(sent)
      if (updateWindow.isOpen()) {
        if (!(input.queue || input.steer)) refuseWhileUpdating('turn')
        const status = (await hub!.summary(id)).status
        if (status !== 'running' && status !== 'waiting-approval') refuseWhileUpdating('turn')
      }
      return tracked(turnRequests, turnKey, () => sendPromptChecked(caller, id, input, withoutPrivateContext, outsideContent)).then(sent)
    }

    async function sendPromptChecked(
      caller: DeviceCaller,
      id: string,
      input: z.infer<typeof queuedPromptSchema>,
      withoutPrivateContext: boolean,
      outsideContent = false,
    ): Promise<'steered' | 'accepted' | 'replayed' | { queued: Awaited<ReturnType<PromptQueues['submit']>> }> {
      recheck(caller, 'run')
      await assertSessionAccess(caller, id)
      checkPrivateSession(caller, id, true)
      // A retry of a turn this Host accepted from this device gets its answer before any check that may have changed since
      // (the project, the Harness's version, the model, the data scope): a refusal now would tell the client a delivered
      // message was not, and it would send it again. Only the same device with the same body: another body under the
      // same ID is a conflict, and anything else (another device, a Host that restarted since) goes through as before.
      // Its attachments are bound once more, as the first answer would have.
      const turnKey = `${id}:${caller.device.id}:${input.requestId}`,
        taken = input.queue || input.steer ? undefined : turnReceipts.get(turnKey)
      if (taken !== undefined) {
        if (taken !== turnBodyHash(input)) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入')
        if (input.attachmentIds?.length)
          await attachmentStore.bind(caller.device.id, input.attachmentIds, id).catch(() => {
            throw new AppError(503, 'attachment-publish-unknown', '会话已开始，附件记录尚未确认。请重试同一次提交。')
          })
        return 'accepted'
      }
      if ((input.queue || input.steer) && promptQueues.knows(id, caller.device.id, input.requestId))
        return { queued: await promptQueues.submit(queueActor(caller), id, input, true) }
      if (await historicalChat(caller, id)) {
        // A receipt from before migration may still be retried, including after a Host restart. Nothing new runs here.
        const detail = await hub!.detail(id)
        agentAccess(caller, true)
        const prior = detail.messages.find(message => message.role === 'user' && message.requestId === input.requestId)
        if (!prior) {
          const owner = hub!.agentOf(id)?.customAgentId
          if (owner && !customAgents.list().some(agent => agent.id === owner))
            throw new AppError(409, 'agent-deleted', '这个 Agent 已删除，可以查看旧聊天。')
          throw new AppError(409, 'agent-chat-history-read-only', '之前的聊天仍可查看，请到这个 Agent 的当前聊天发送。')
        }
        if (
          prior.text !== input.prompt
          || canonicalJson(prior.attachments?.map(ref => ref.id) ?? []) !== canonicalJson(input.attachmentIds ?? [])
          || canonicalJson(prior.fileRefs ?? []) !== canonicalJson(input.fileRefs ?? [])
        )
          throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入。')
        if (input.attachmentIds?.length) await attachmentStore.bind(caller.device.id, input.attachmentIds, id)
        agentAccess(caller, true)
        return 'replayed'
      }
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
      // An existing session whose Harness is now too old is refused as a new one would be, before the turn is recorded.
      const sessionHarness = await hub!.harnessOf(id)
      await rereadOutdated(sessionHarness)
      refuseOutdated(sessionHarness)
      const harnessId = sessionHarness,
        agentTurn = turnContext(
          id,
          harnessId,
          withoutPrivateContext ? undefined : devices.get(caller.device.id)?.dataScope,
          input.freshContext,
        ),
        attachmentModel = input.model ?? agentTurn?.defaultModel,
        attachments = await promptAttachments(
          caller,
          input.attachmentIds,
          { harnessId, ...(attachmentModel ? { model: attachmentModel } : {}) },
          id,
          input.requestId,
        )
      const mentionTask = input.fileRefs?.length ? await hub!.detail(id) : undefined
      if (
        input.fileRefs?.length
        && (!readsProjectFiles(caller.device.dataScope)
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
      if (fileRefs.length && !projectFiles(caller)) throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
      if (attachments.length) await attachmentStore.claim(caller.device.id, input.attachmentIds!, input.requestId, id)
      try {
        recheck(caller, 'run')
        if (fileRefs.length && !projectFiles(caller)) throw new AppError(403, 'file-scope', '此设备的数据范围已变化。')
        if (agentTurn) agentAccess(caller, true)
        await hub!.prompt(id, input.prompt, input.requestId, {
          ...(agentTurn ? { agentContext: agentTurn } : {}),
          ...(fileRefs.length ? { fileRefs } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(input.freshContext ? { freshContext: true as const } : {}),
          ...(outsideContent ? { outsideContent: true as const } : {}),
        })
      } catch (cause) {
        if (cause instanceof AppError && refusedBeforeAccepting(cause.status, cause.code) && attachments.length)
          await attachmentStore.releaseClaim(caller.device.id, input.attachmentIds!, input.requestId, id)
        throw cause
      }
      // The driver resolved only once the turn was durable: from now on a retry is answered from this receipt.
      turnReceipts.set(turnKey, turnBodyHash(input))
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
    /** When each Agent's chat was last warmed, and the recent warm-ups per device and in all: a page cannot drive starts. */
    const warmedAt = new Map<string, number>()
    const warmsBy = new Map<string, number[]>()
    let warmsAll: number[] = []
    /**
     * Starts the process of an Agent's one chat before the person's next message (`Bridge.warm`). The route already
     * required `run` and data scope `all`; the session is only ever the Host's own chat slot for that Agent, never one a
     * client names. Audited first (`agent.warm.requested`), failing closed like a probe: binding the session may write
     * its Harness session, a config readback or a drift mark. Then, in the background, the same folder checks a turn runs
     * (`assertSessionWorkspace`); any refusal there or in the driver means only that nothing was warmed. Nothing reaches
     * the model, and the driver keeps its process limit.
     */
    async function warmAgentChat(owner: string, caller: Caller): Promise<boolean> {
      if (owner === GENERAL_AGENT_ID) return false
      const agent = customAgents.get(owner)
      if (agentPlans.unavailable(agent) !== undefined) return false
      const chat = customAgents.chats()[owner]
      if (chat?.state !== 'ready') return false
      const sessionId = chat.sessionId
      if (hub!.agentOf(sessionId)?.customAgentId !== owner || hub!.personalOf(sessionId)) return false
      const device = caller.device?.id
      if (!device) return false
      const at = now(),
        recent = (times: number[] | undefined) => (times ?? []).filter(time => at - time < 60_000)
      const mine = recent(warmsBy.get(device))
      warmsAll = recent(warmsAll)
      if (at - (warmedAt.get(owner) ?? 0) < AGENT_WARM_EVERY_MS) return false
      if (mine.length >= AGENT_WARM_LIMITS.device || warmsAll.length >= AGENT_WARM_LIMITS.all) return false
      await audited({ action: 'agent.warm.requested', actor: actorOf(caller), target: owner, detail: { customAgentId: owner, sessionId } })
      warmedAt.set(owner, at)
      if (warmedAt.size > 256) warmedAt.delete(warmedAt.keys().next().value!)
      warmsBy.set(device, [...mine, at])
      if (warmsBy.size > 256) warmsBy.delete(warmsBy.keys().next().value!)
      warmsAll.push(at)
      void (async () => {
        await assertSessionWorkspace(sessionId)
        await hub!.warm(sessionId)
      })().catch(() => false)
      return true
    }
    function generalContextFor(dataScope: DataScope | undefined, harnessId: string): AgentExecutionContext | undefined {
      return dataScope === 'all' ? agentPlans.generalContext(harnessId) : undefined
    }
    /** A queued turn of an agent's session runs on the definition it was queued under; 通用 applies as it stands when sent. */
    async function queuedAgentTurn(
      sessionId: string,
      dataScope: DataScope,
    ): Promise<{ binding?: string; model?: ModelRef; agentContext?: AgentExecutionContext } | undefined> {
      const harnessId = await hub!.harnessOf(sessionId)
      const context = turnContext(sessionId, harnessId, dataScope)
      const owner = hub!.agentOf(sessionId)
      if (!owner) return context ? { agentContext: context } : undefined
      // A first-turn engine's queued turn carries only the digest note, which applies as it stands when sent.
      if (hub!.info(harnessId)?.agentContext === 'first-turn') return context ? { agentContext: context } : undefined
      if (hub!.info(harnessId)?.agentContext !== 'private') return undefined
      const session = await hub!.summary(sessionId)
      const model =
        context?.defaultModel
        ?? (session.providerId && session.model ? { providerId: session.providerId, model: session.model } : undefined)
      if (!context || !model) throw queueContextChanged()
      return { binding: context.revision, model, agentContext: context }
    }
    /** What this turn of a session sends: an engine that got the first-turn block keeps it in its own history. */
    function turnContext(
      sessionId: string,
      harnessId: string,
      dataScope: DataScope | undefined,
      freshContext = false,
    ): AgentExecutionContext | undefined {
      const contextKind = hub!.info(harnessId)?.agentContext
      const owner = hub!.agentOf(sessionId)
      // A first-turn engine keeps its block in its own history; past the first turn only the digest note goes along.
      const noteOnly = contextKind === 'first-turn' && !freshContext && owner !== undefined && dataScope === 'all'
      if (contextKind !== 'private' && !noteOnly && !(contextKind === 'first-turn' && freshContext && owner && dataScope === 'all'))
        return undefined
      if (!owner) {
        const general = generalContextFor(dataScope, harnessId)
        return dataScope === 'all' && hub!.generalChatOf(sessionId) ? agentPlans.generalChatContext(harnessId, general) : general
      }
      // A deleted Agent's session on a first-turn engine continues without a note, as it did before notes existed.
      if (noteOnly && !customAgents.list().some(agent => agent.id === owner.customAgentId)) return undefined
      try {
        const context = agentPlans.agentContext(owner.customAgentId, harnessId, dataScope)
        if (noteOnly)
          return context.note
            ? { agent: { customAgentId: owner.customAgentId }, instructions: '', note: context.note, revision: context.revision }
            : undefined
        if (harnessId !== STANDARD) return context
        const chat = customAgents.chats()[owner.customAgentId]
        if (chat?.state !== 'ready' || chat.sessionId !== sessionId) return context
        const agent = customAgents.get(owner.customAgentId)
        return agent.harnessId === STANDARD && agent.model ? { ...context, defaultModel: agent.model } : context
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
        const shown = shownDetail(caller, detail)
        traffic.response('detail', json(res, { ...shown, sync: { instanceId, revision: detailRevision } }), id)
        return true
      }
      if (method === 'PATCH' && !action) {
        requireScope(caller, 'run')
        const { tags: rawTags, priority, note: rawNote, ...input } = taskPatchSchema.parse(await jsonBody(req))
        const note = rawNote === null || rawNote?.trim() === '' ? null : rawNote !== undefined ? checkedNote(rawNote) : undefined
        const normalized = rawTags?.length ? normalizeBoardTags(rawTags) : undefined
        if (normalized && 'problem' in normalized) throw new AppError(400, normalized.problem, TAG_PROBLEMS[normalized.problem])
        // The answer carries the session's summary and board place: a private session's only to a device that may read it.
        checkPrivateSession(caller, id, true)
        recheck(caller, 'run')
        if (input.archived) {
          restrictChatRemoval(id)
          terminalRoutes.checkSessionEnd(caller, id)
        }
        const summary = await hub!.updateMeta(id, {
          ...input,
          ...(rawTags !== undefined ? { tags: normalized && 'tags' in normalized ? normalized.tags : null } : {}),
          ...(priority !== undefined ? { priority: priority === 'mid' ? null : priority } : {}),
          ...(note !== undefined ? { note } : {}),
        })
        checkPrivateSession(caller, id, true)
        if (input.archived) memoryRefusals.delete(id)
        json(res, { summary })
        return true
      }
      if (method === 'POST' && action === 'attend') {
        const input = attendSchema.parse(await jsonBody(req))
        // Opening is reading; checking unknown results is a person's conclusion about commands that may have run.
        const scope = input.checked ? 'run' : 'view'
        requireScope(caller, scope)
        limits.classC.take(caller.device.id)
        checkPrivateSession(caller, id, input.checked === true)
        const summary = await hub!.summary(id)
        recheck(caller, scope)
        checkPrivateSession(caller, id, input.checked === true)
        if (summary.board?.settle !== input.settle) throw new AppError(409, 'attend-stale', '会话已有新的结果，请刷新后再试。')
        const recorded = hub!.attendedOf(id)
        const marked = recorded?.settle === input.settle ? recorded : undefined
        if (marked && (!input.opened || marked.opened) && (!input.checked || marked.checked)) {
          json(res, { summary })
          return true
        }
        if (input.checked && !marked?.checked)
          try {
            await audited({
              action: 'task.unknown.checked',
              actor: actorOf(caller),
              target: id,
              detail: { sessionId: id, count: summary.runEnd?.unknownResultCount ?? summary.runEnd?.unknownResults?.length ?? 0 },
            })
          } catch {
            throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，没有记下已核对，请重试。')
          }
        json(res, { summary: await hub!.attend(id, input) })
        return true
      }
      if (method === 'DELETE' && !action) {
        requireScope(caller, 'run')
        await assertSessionAccess(caller, id)
        restrictChatRemoval(id)
        terminalRoutes.checkSessionEnd(caller, id)
        await removeSessionRecords(id)
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
        // A queued message proposes when it is sent from the queue, not now.
        const refused =
          input.prompt && typeof sent !== 'object' && sent !== 'replayed'
            ? await rememberFromPerson({ deviceId: caller.device.id, actor: actorOf(caller) }, id, input.prompt, input.requestId)
            : undefined
        const memory = refused ? { memoryRefused: refused } : {}
        if (sent === 'steered') json(res, { steered: true, ...memory })
        else if (sent === 'accepted' || sent === 'replayed') json(res, { accepted: true, ...memory })
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
      if (method === 'POST' && action === 'computer-stop') {
        // 停 on 「操控这台 Mac」 narrows like a cancel: it takes what a cancel takes, and it is on record before the
        // session's bridge ends. The agent keeps running without the server until its process starts again.
        requireScope(caller, 'view')
        limits.classC.take(caller.device.id)
        computerStopSchema.parse(await optionalJsonBody(req))
        privateAccess(caller, (await hub!.detail(id)).summary)
        const serverId = [...(computerLive.get(id)?.values() ?? [])][0]
        if (!serverId) throw new AppError(409, 'computer-not-in-use', '这个会话没有在使用「操控这台 Mac」。')
        await audited({ action: 'mcp.server.stopped', actor: actorOf(caller), target: id, detail: { serverId, sessionId: id } }, res)
        // A call already sent may run on in the daemon: 「正在停止」 until it must have ended.
        const sent = [...(computerCalls.get(id)?.values() ?? [])]
        computerCalls.delete(id)
        const left = sent.length ? Math.max(...sent) + COMPUTER_CALL_LIMIT_MS - Date.now() : 0
        if (left > 0) {
          clearTimeout(computerStopping.get(id)?.timer)
          const timer = setTimeout(() => {
            computerStopping.delete(id)
            refresh(id)
          }, left)
          timer.unref()
          computerStopping.set(id, { serverId, timer })
        }
        toolGateway?.revokeMcpIn(id, serverId)
        refresh(id)
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
        // A refusal here comes before anything reaches the Harness, so the change certainly did not apply.
        const stillAllowed = () => {
          try {
            authority()
          } catch (error) {
            throw notSentConfig(error)
          }
        }
        /**
         * A model of another service, or one of the harness's own while on a service: the session moves to that route. The
         * Host builds the route from its own records and checks it as a start with that model does, and audits it as one.
         */
        const moveRoute = async (choice: ModelChoice, before: (context?: ConfigBegin) => Promise<void>) => {
          const detail = await hub!.detail(id)
          const option = detail.config?.find(row => row.id === input.configId)
          if (option?.category !== 'model') throw new AppError(404, 'config-not-found', '该会话没有这个设置项。')
          const harness = hub!.info(detail.summary.harnessId)
          const switching = harness?.capabilities.models.routeSwitch
          const from = detail.summary.modelRoute
          if (!harness || !switching) throw new AppError(409, 'model-route-locked', '这个会话不能换到别的模型来源，新开一个会话。')
          if (choice.kind === 'own' && !from) throw new AppError(400, 'config-value-invalid', '设置值不在可选范围内。')
          if (switching === 'services' && (choice.kind === 'own' || !from))
            throw new AppError(
              409,
              'model-route-locked',
              `${harness.capabilities.display.label} 的会话不能在它自己的登录和经 Latch 之间换，新开一个会话。`,
            )
          let route: ModelRoute | undefined
          if (choice.kind === 'service') {
            const ref = { providerId: choice.providerId, model: choice.model }
            assertModel(ref)
            route = modelRouteFor(harness, ref)
          }
          const seq = await audited({
            action: 'task.model.route-changed',
            actor: actorOf(caller),
            target: id,
            stepup: 'none',
            detail: {
              sessionId: id,
              toHash: sha256Hex(input.value),
              ...(route ? { providerId: route.providerId, routeHash: sha256Hex(canonicalJson(route)) } : {}),
            },
          })
          try {
            await before({ prior: option.currentValue, auditSeq: seq })
            stillAllowed()
            const routeName = route ? effectiveProvider(route.providerId)?.name : undefined
            await hub!.setConfig(id, input.configId, input.value, {
              authorize: authority,
              ...(route ? { route } : {}),
              ...(routeName ? { routeName } : {}),
            })
            authority()
            const actual = await hub!.detail(id)
            authority()
            const now = actual.config?.find(row => row.id === input.configId)
            if (!onModelChoice(choice, actual.summary.modelRoute, now?.currentValue))
              throw new AppError(503, 'config-outcome-unknown', 'Agent 尚未确认采用所选模型，请查询原请求。')
          } catch (error) {
            auditFailed(seq, caller)
            throw error
          }
        }
        const execute = async (before: (context?: ConfigBegin) => Promise<void>) => {
          await authorize()
          const choice = parseModelChoice(input.value)
          if (choice) return moveRoute(choice, before)
          const change = await hub!.classifyConfigChange(id, input.configId, input.value)
          // The value before the change: what 核对 reads back when the change did not apply.
          let prior: string | undefined
          if (input.requestId) {
            const current = await hub!.detail(id),
              selectedOption = current.config?.find(row => row.id === input.configId)
            if (!selectedOption) throw new AppError(404, 'config-not-found', '该会话没有这个设置项。')
            if (!selectedOption.options.some(row => row.value === input.value))
              throw new AppError(400, 'config-value-invalid', '设置值不在可选范围内。')
            prior = selectedOption.currentValue
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
            const changed = await audited({
              action: 'task.config.changed',
              actor: actorOf(caller),
              detail: { sessionId: id, configIdHash: sha256Hex(input.configId), toHash: sha256Hex(input.value) },
            })
            await before({ prior, auditSeq: changed })
            stillAllowed()
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
            await before({ prior, auditSeq: seq })
            stillAllowed()
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
        await holdPresetKey(caller, input.baseURL, Boolean(input.apiKey))
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
        const apiKey = input.apiKey ?? ''
        if (apiKey) requireKeyEntry(caller)
        const requestId = input.requestId
        if (requestId) requireDesktop(caller)
        const inputHash = requestId ? sha256Hex(canonicalJson(input)) : undefined
        const replay = requestId && addedProvider(caller, requestId, inputHash)
        if (replay && requestId) {
          const record = await serial(caller, 'admin', () => {
            const current = addedProvider(caller, requestId, inputHash)
            if (!current) throw providerAdditionUnconfirmed()
            return settleProviderAddition(caller, current)
          })
          recheck(caller, 'admin')
          json(res, { provider: providerView(record) })
          return true
        }
        if (requestId) config.requireProviderAdditionRoom()
        const id = input.id ?? newProviderId(input.presetId ?? input.name)
        if (idTaken(id)) throw new AppError(409, 'provider-exists', `标识 ${id} 已被占用`)
        const plan = await planDestination(input.baseURL, { key: Boolean(apiKey), confirm: input.confirmOrigin === true })
        await holdPresetKey(caller, input.baseURL, Boolean(apiKey))
        const stepup = confirmsDestination(plan)
          ? await confirmDestination(req, caller, plan, {
              baseURL: input.baseURL,
              provider: { id, name: input.name },
              ...(apiKey ? { apiKey } : {}),
            })
          : 'none'
        const scope = apiKey ? keyScopeOf(input.baseURL) : undefined
        const record = await serial(caller, 'admin', async () => {
          const replayed = requestId && addedProvider(caller, requestId, inputHash)
          if (replayed) return settleProviderAddition(caller, replayed)
          if (requestId) config.requireProviderAdditionRoom()
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
          const addition =
            requestId && inputHash
              ? { deviceId: caller.device.id, requestId, providerId: id, inputHash, recordHash: sha256Hex(canonicalJson(next)) }
              : undefined
          await saveAt(
            caller,
            res,
            { id, plan, stepup, ...(scope ? { scope } : {}) },
            () => saveProvider(caller, next, next, addition),
            addition ? () => providerAdditionVisible(addition) : undefined,
          )
          if (addition && !addedProviderReady(next)) throw providerAdditionUnconfirmed()
          return next
        })
        if (requestId) recheck(caller, 'admin')
        refresh()
        json(res, { provider: providerView(record) }, 201)
        return true
      }
      const providerAddition = /^\/link\/api\/providers\/additions\/([A-Za-z0-9_-]{8,128})$/u.exec(path)
      if (providerAddition && (method === 'GET' || method === 'POST')) {
        requireScope(caller, 'admin')
        requireDesktop(caller)
        const requestId = providerAddition[1]!
        const record =
          method === 'GET'
            ? addedProvider(caller, requestId)
            : await (async () => {
                z.strictObject({}).parse(await jsonBody(req))
                return serial(caller, 'admin', async () => {
                  const current = addedProvider(caller, requestId)
                  return current && (await settleProviderAddition(caller, current))
                })
              })()
        recheck(caller, 'admin')
        json(res, record && addedProviderReady(record) ? { state: 'saved', provider: providerView(record) } : { state: 'unknown' })
        return true
      }
      const providerMatch = path.match(/^\/link\/api\/providers\/([^/]+)(?:\/(models))?$/)
      if (providerMatch) {
        const id = safeDecode(providerMatch[1]!)
        if (method === 'POST' && providerMatch[2] === 'models') {
          requireScope(caller, 'admin')
          const record = effectiveProvider(id)
          if (!record) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
          const { kind } = record
          if (!isProviderKind(kind)) throw providerUnsupported(record)
          // A saved provider's own key goes along, so only to a confirmed or preset address.
          json(
            res,
            await remoteModels(res, { kind, baseURL: record.baseURL, apiKey: usableKey(record) }, false, providerFetchFor(record.baseURL)),
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
          if (!isProviderKind(current.kind)) throw providerUnsupported(current)
          const newKey = typeof input.apiKey === 'string' && input.apiKey ? input.apiKey : undefined
          if (newKey) requireKeyEntry(caller)
          const confirming = input.confirmOrigin === true
          const changesTarget = input.baseURL !== undefined || input.kind !== undefined || !!newKey || confirming
          if (changesTarget && !input.expectedTarget)
            throw new AppError(409, 'provider-target-required', '请更新并重新打开 Latch 后再修改模型服务的地址、协议或密钥。')
          const checkTarget = (record: ProviderRecord) => {
            if (input.expectedTarget && !sameProviderTarget(record, input.expectedTarget))
              throw new AppError(409, 'provider-target-changed', '模型服务的地址或协议已更改。请核对当前设置后重试。')
          }
          checkTarget(current)
          const plannedURL = input.baseURL ?? current.baseURL
          if (newKey || confirming) assertBaseURL(plannedURL)
          const plan =
            input.baseURL !== undefined || newKey || confirming
              ? await planDestination(plannedURL, { key: Boolean(newKey), confirm: confirming })
              : undefined
          await holdPresetKey(caller, plannedURL, Boolean(newKey))
          const stepup = confirmsDestination(plan)
            ? await confirmDestination(req, caller, plan, { baseURL: plannedURL, provider: current, ...(newKey ? { apiKey: newKey } : {}) })
            : 'none'
          const record = await serial(caller, 'admin', async () => {
            const before = effectiveProvider(id)
            if (!before || (pluginInfo(id) && pluginInfo(id)?.managed !== 'provider'))
              throw new AppError(404, 'provider-not-found', '找不到该模型服务')
            if (!isProviderKind(before.kind)) throw providerUnsupported(before)
            checkTarget(before)
            if (newKey) recheck(caller, 'secrets')
            const baseURL = input.baseURL ?? before.baseURL
            const scope = keyScopeOf(baseURL)
            const bound = keyScopeOf(before.baseURL)
            const hadKey = Boolean(before.apiKey)
            const clearing = input.apiKey === null || input.apiKey === ''
            // A key follows neither a new origin nor a new path; it is removed, as the dialog warned.
            const originChanged = scope.keyOrigin !== (before.keyOrigin ?? bound.keyOrigin)
            const moved = hadKey && !newKey && !clearing && (originChanged || scope.keyPath !== (before.keyPath ?? bound.keyPath))
            const nextModels = withModel(input.models ?? before.models, input.defaultModel ?? before.defaultModel)
            // Only a list this request sends is checked, before anything is on record: a saved entry whose service or
            // model is gone since is dropped, never a reason to refuse renaming, turning off or clearing the key.
            const fallbacks =
              input.fallbacks !== undefined
                ? checkedFallbacks(id, nextModels, input.fallbacks)
                : liveFallbacks(id, nextModels, before.fallbacks ?? {})
            const listChange = input.fallbacks !== undefined ? fallbackChange(before.fallbacks ?? {}, fallbacks) : undefined
            if (listChange) {
              const event: AuditEvent = {
                action: 'provider.fallbacks.changed',
                actor: actorOf(caller),
                target: id,
                detail: { providerId: id, ...listChange },
              }
              // Adding or moving a candidate redirects requests: not without its record. Removing is never held up by it.
              if (listChange.widened) await audited(event)
              else await audited(event, res)
            }
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
              const {
                keyOrigin: previousOrigin,
                keyPath: previousPath,
                fallbacks: _fallbacks,
                maxConcurrent: previousLimit,
                ...rest
              } = previous
              const limit = input.maxConcurrent === undefined ? previousLimit : (input.maxConcurrent ?? undefined)
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
                ...(Object.keys(fallbacks).length ? { fallbacks } : {}),
                ...(limit !== undefined ? { maxConcurrent: limit } : {}),
              }
            })
            if (!edited) throw new AppError(404, 'provider-not-found', '找不到该模型服务')
            // The limit and the fallback list are read when a request is scheduled: saving them replaces no plugin, so
            // nothing that runs on the service, an approved automation among it, is disturbed.
            const schedulingOnly =
              envProvider?.id !== id && Object.keys(input).every(name => name === 'fallbacks' || name === 'maxConcurrent')
            if (schedulingOnly)
              await config.updateProviders(
                draft => {
                  const index = draft.findIndex(item => item.id === id)
                  if (index >= 0) draft[index] = structuredClone(edited[1])
                },
                async () => recheck(caller, 'admin'),
              )
            else
              await saveAt(caller, res, { id, ...(plan ? { plan } : {}), stepup, ...(newKey ? { scope } : {}) }, () =>
                saveProvider(caller, ...edited),
              )
            // Models this service no longer has are no longer anybody's fallback.
            const lost = before.models.filter(model => !edited[0].models.includes(model))
            if (lost.length) await pruneFallbacks(item => item.providerId === id && lost.includes(item.model))
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
            await pruneFallbacks(item => item.providerId === id)
            // What was kept for the service goes with it; a failure here never undoes the deletion.
            await modelSpend.forget('service', id).catch(error => log(`清除单价与预算失败：${errorText(error)}`))
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
        // A command too old for its preset says so in this answer, and in the catalog read after it.
        // Only programs this Mac confirmed are run to read their versions; a preset not added yet is read once it is.
        await recheckVersions(
          config.settings().agents.filter(agent => agent.enabled && versionReadable(agent)),
          VERSION_RECHECK_MS,
        )
        // Each preset says whether its commands are here, so an agent can be added knowing what is still missing.
        presetLookup = undefined
        // A preset is added as a draft would save it: its adapter, when only that can run here.
        const presets: AgentPresetSettings[] = AGENT_PRESETS.map(preset => ({
          ...preset,
          ...(() => {
            const route = presetRoute(preset.id)
            return route && route.command !== preset.command && preset.fallback
              ? { command: route.command, args: [...route.args], description: preset.fallback.description }
              : {}
          })(),
          detected: withVersion(preset, (options.detectPreset ?? detectPresetCommands)(preset)),
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
        let hash = checkAgent(next)
        // Choosing a Harness is the moment its version is read, once: one too old for its preset is refused before
        // anything is saved or started, and the result is kept, so the picker then says it needs an upgrade.
        // A preset whose own program is missing while its adapter is installed is saved on the adapter, which then runs a
        // copy of the program it ships: with the program missing nothing points it elsewhere (`CODEX_PATH`).
        const fallback = AGENT_PRESETS.find(preset => preset.id === next.presetId && preset.command === next.command)?.fallback
        if (fallback && !resolveCommand(next.command) && resolveCommand(fallback.command)) {
          next.command = fallback.command
          next.args = [...fallback.args]
          hash = checkAgent(next)
        }
        // A new definition is a new program sessions start: only this Mac's desktop app saves one, and confirms it. A
        // preset's command too old for it is refused first, so nobody confirms what cannot run.
        requireLocal(caller)
        const { stepup, found } = await confirmHarnessCommand(req, caller, next)
        // Bound to the program the sheet named: one that later resolves elsewhere waits for a new confirmation. Its
        // version is read only now, from that program.
        if (found) next.confirmedCommand = found
        if (next.enabled && found) {
          await assertCommandVersion(next)
          recheck(caller, 'admin')
        }
        const record = await serial(caller, 'admin', async () => {
          if (config.settings().agents.some(agent => agent.id === id)) throw new AppError(409, 'agent-exists', `标识 ${id} 已被占用`)
          const seq = await audited({
            action: 'agent.defined',
            actor: actorOf(caller),
            target: id,
            stepup,
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
      // Previous-session suggestions only: unlike catalogue, this endpoint never starts or probes a program.
      const commandsMatch = path.match(/^\/link\/api\/agents\/([^/]+)\/commands$/u)
      if (commandsMatch && method === 'POST') {
        requireScope(caller, 'view')
        limits.classC.take(caller.device.id)
        const deviceScope = JSON.stringify([caller.device.dataScope, caller.device.scopes.toSorted()])
        const authorize = () => {
          recheck(caller, 'view')
          const current = devices.get(caller.device.id)
          if (JSON.stringify([current?.dataScope, current?.scopes.toSorted()]) !== deviceScope)
            throw new AppError(403, 'device-scope-changed', '设备权限已变化，请重试。')
        }
        const input = commandCatalogueSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        authorize()
        const id = safeDecode(commandsMatch[1]!)
        const workspaceId = input.workspaceId ?? 'default'
        const context = async () => {
          const harness = hub!.info(id)
          if (!harness || !hub!.has(id) || harness.status !== 'ready') return undefined
          const mode = input.mode ?? (harness.modes.includes('agent') ? 'agent' : harness.modes[0])
          if (mode && !harness.modes.includes(mode)) return undefined
          if (workspaceId === 'default' && hub!.levelOf(id) !== 'L1' && (defaultFlags.insideData || defaultFlags.codeRoot)) return undefined
          // A new own folder/worktree has no actual directory yet. A cache read may never allocate one or a helper home.
          if (input.worktree || input.customAgentId || (workspaceId === 'default' && makeOwnFolders && mode === 'agent')) return undefined
          const chosen = workspaceId === 'default' ? undefined : savedProject(workspaceId)
          if (workspaceId !== 'default' && !chosen) return undefined
          if (chosen) await assertWorkspaceUsable(chosen)
          const folders = chosen?.folders.map(({ id, path }) => ({ id, path })) ?? [{ id: 'default', path: workspaceRoot }]
          const identities = []
          for (const folder of folders) {
            const real = await realpath(folder.path)
            const info = await lstat(real, { bigint: true })
            if (!info.isDirectory()) return undefined
            identities.push([folder.id, real, String(info.dev), String(info.ino)])
          }
          authorize()
          const modelRoute = input.model && harness.capabilities.models.owner !== 'latch' ? modelRouteFor(harness, input.model) : undefined
          const current = workspaceId === 'default' ? undefined : savedProject(workspaceId)
          if (JSON.stringify(current) !== JSON.stringify(chosen)) return undefined
          const revision = JSON.stringify([current, modelRoute, hub!.info(id)])
          const stillConfigured = () => {
            try {
              const harnessNow = hub!.info(id)
              if (!harnessNow) return false
              const routeNow =
                input.model && harnessNow.capabilities.models.owner !== 'latch' ? modelRouteFor(harnessNow, input.model) : undefined
              return JSON.stringify([workspaceId === 'default' ? undefined : savedProject(workspaceId), routeNow, harnessNow]) === revision
            } catch {
              return false
            }
          }
          return {
            cwd: identities[0]![1]!,
            folders,
            modelRoute,
            stillConfigured,
            key: JSON.stringify([identities, current, modelRoute, hub!.info(id)]),
          }
        }
        const before = await context()
        if (!before) {
          authorize()
          json(res, { catalogue: null })
          return true
        }
        const lookup = () =>
          hub!.commandCatalogueOf(id, {
            cwd: before.cwd,
            workspaceId,
            folders: before.folders,
            ...(before.modelRoute ? { modelRoute: before.modelRoute } : {}),
            ...(input.config ? { config: input.config } : {}),
          })
        const cached = await lookup()
        authorize()
        const source = cached?.current() ? await sessionTask(cached.sourceSessionId) : undefined
        const canReadSource = () =>
          !!source
          && privateVisible(caller, source)
          && (!hub!.agentPrivate(source.id) || devices.get(caller.device.id)?.dataScope === 'all')
        const sourceAvailable =
          source && cached && canReadSource()
            ? await assertSessionWorkspace(cached.sourceSessionId).then(
                () => true,
                () => false,
              )
            : false
        const after = await context()
        authorize()
        const visible = cached?.current() && sourceAvailable && canReadSource() && after?.key === before.key
        // Source checks also yield: repeat the driver's full launch/configuration check, without probing a program.
        const verified = visible ? await lookup().catch(() => undefined) : undefined
        authorize()
        const current =
          verified?.current() && verified.sourceSessionId === cached?.sourceSessionId && before.stillConfigured() && canReadSource()
        const publicResult = publicCommandCatalogue.safeParse(current && verified ? verified.catalogue : undefined)
        json(res, { catalogue: publicResult.success ? publicResult.data : null })
        return true
      }
      // 设置 › 扩展: per Harness, the newest commands and skills an ordinary session of its current definition reported.
      // Only Latch's own records: no CLI's configuration or storage is read, and no program is started or probed.
      if (path === '/link/api/extensions' && method === 'GET') {
        requireScope(caller, 'admin')
        limits.classC.take(caller.device.id)
        const ordinary = (sessionId: string) => !hub!.agentPrivate(sessionId)
        const harnesses: HarnessExtensionReport[] = []
        for (const harness of hub!.drivers()) {
          if (harness.capabilities.permission.enforcement === 'latch') continue
          const found = await hub!.latestCommandReportOf(harness.id, ordinary).catch(() => undefined)
          recheck(caller, 'admin')
          const source = found?.current() ? await sessionTask(found.sourceSessionId).catch(() => undefined) : undefined
          const usable =
            !!source
            && !!found
            && found.current()
            && (await assertSessionWorkspace(found.sourceSessionId).then(
              () => true,
              () => false,
            ))
          recheck(caller, 'admin')
          const report = usable && found?.current() ? publicCommandCatalogue.safeParse(found.catalogue) : undefined
          const projectId =
            found?.workspaceId && found.workspaceId !== 'default' && savedProject(found.workspaceId) ? found.workspaceId : undefined
          harnesses.push({
            harnessId: harness.id,
            ...(report?.success
              ? {
                  report: {
                    commands: report.data.commands,
                    ...(report.data.skills ? { skills: report.data.skills } : {}),
                    ...(report.data.skillsTruncated ? { skillsTruncated: true as const } : {}),
                    reportedAt: report.data.reportedAt,
                    ...(projectId ? { projectId } : {}),
                  },
                }
              : {}),
          })
        }
        json(res, { harnesses } satisfies ExtensionsResponse)
        return true
      }
      // What a Harness offers, read before a session: the same gate as starting one, since it starts the same program.
      const catalogueMatch = path.match(/^\/link\/api\/agents\/([^/]+)\/catalogue$/)
      if (catalogueMatch && method === 'POST') {
        requireScope(caller, 'run')
        const input = z
          .object({ auto: z.boolean().optional(), model: z.string().min(1).max(256).optional() })
          .strict()
          .parse(await jsonBody(req))
        recheck(caller, 'run')
        const id = safeDecode(catalogueMatch[1]!)
        const harness = editableHarness(id)
        const auto = input.auto === true
        const { ran } = await hub!.readHarnessCatalogue(
          id,
          auto,
          async () => {
            if (closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
            recheck(caller, 'run')
            await audited({
              action: 'agent.catalogue.requested',
              actor: actorOf(caller),
              target: id,
              stepup: 'none',
              detail: { agentId: id, auto },
            })
          },
          input.model,
        )
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
      // 读取 of a Harness's own MCP servers: the same gate as starting a session, since it starts the same program, which
      // then starts the servers it has configured. Only a person asks; never on a timer.
      const ownMcpMatch = path.match(/^\/link\/api\/agents\/([^/]+)\/mcp$/)
      if (ownMcpMatch && method === 'POST') {
        requireScope(caller, 'run')
        z.object({})
          .strict()
          .parse(await jsonBody(req))
        recheck(caller, 'run')
        const id = safeDecode(ownMcpMatch[1]!)
        editableHarness(id)
        let ok = false
        try {
          await hub!.readHarnessMcp(id, async () => {
            if (closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
            recheck(caller, 'run')
            await audited({
              action: 'agent.mcp.requested',
              actor: actorOf(caller),
              target: id,
              stepup: 'none',
              detail: { agentId: id },
            })
          })
          ok = true
        } finally {
          await audited({
            action: 'agent.mcp.read',
            actor: actorOf(caller),
            target: id,
            stepup: 'none',
            detail: { agentId: id, ok },
          }).catch(() => {})
          refresh()
        }
        json(res, { ownMcp: hub!.info(id)?.ownMcp ?? {} })
        return true
      }
      // Someone looks at the limits (额度): each bound Harness that can say them without a model turn is asked, in the
      // background, where what is known is missing or old. The same gate as starting a session, since it may start the
      // same program in a private empty folder with no session; a device without it sees the last values only. Answered
      // at once: what arrives goes out with the catalog.
      if (path === '/link/api/quota/refresh' && method === 'POST') {
        requireScope(caller, 'run')
        const input = z
          .object({ ids: z.array(z.string().min(1).max(256)).max(64).optional(), retry: z.boolean().optional() })
          .strict()
          .parse(await jsonBody(req))
        recheck(caller, 'run')
        const wanted = input.ids ? new Set(input.ids) : undefined
        const bound = new Set(config.settings().agents.flatMap(agent => (agent.confirmedCommand !== undefined ? [agent.id] : [])))
        const asked: string[] = []
        for (const harness of hub!.drivers()) {
          const id = harness.id
          if (wanted && !wanted.has(id)) continue
          if (!harness.editable || harness.status !== 'ready' || !harness.capabilities.models.quota || !bound.has(id)) continue
          const before = async () => {
            if (closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
            recheck(caller, 'run')
            await audited({ action: 'agent.quota.requested', actor: actorOf(caller), target: id, stepup: 'none', detail: { agentId: id } })
          }
          if (hub!.refreshHarnessQuota(id, { retry: input.retry === true, before })) asked.push(id)
        }
        json(res, { asked })
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
        // Another command, other arguments, any variable change or a command that moved: confirmed on this Mac. A new
        // name or switching it on or off changes nothing that runs.
        const legacy = current.confirmedCommand === undefined && input.command !== undefined
        const confirmed = runsDifferently(current, next) || legacy ? await confirmHarnessCommand(req, caller, next) : undefined
        const stepup = confirmed?.stepup ?? 'none'
        if (confirmed) {
          if (confirmed.found) next.confirmedCommand = confirmed.found
          else delete next.confirmedCommand
        }
        const hash = changed || stepup !== 'none' ? checkAgent(next) : undefined
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
                stepup,
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
            unknown: configRequests.pending() + startRequests.inFlight() + turnRequests.inFlight() + repositoryHolds.running,
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
      if (path === '/link/api/workspaces/clone' && method === 'POST') {
        // Like adding a project: only the desktop app on this computer, its body signed by main after the native picker
        // chose where the new folder goes; the page never names a folder.
        requireScope(caller, 'admin')
        requireDesktop(caller)
        const input = cloneSchema.parse(await signedFolderBody(req, caller))
        const address = parseCloneUrl(input.url)
        const clone = await clones.start({
          deviceId: caller.device.id,
          address,
          parent: input.parent,
          hooks: {
            check: async folder => {
              const plan = await planFolders({ current: [], paths: [folder], primaries: primaries(), guard: workspaceGuard })
              if (plan.added.length === 0) throw foldersRefused(plan.refused)
              assertNoHelperProject([await canonicalPath(folder)])
            },
            audit: async detail => {
              recheck(caller, 'admin')
              await audited({ action: 'git.clone', actor: actorOf(caller), detail })
            },
            result: async detail => {
              await audited({ action: 'git.clone.result', actor: actorOf(caller), detail })
            },
            register: async folder => {
              const workspace = await serial(caller, 'admin', async () => {
                const plan = await planFolders({ current: [], paths: [folder], primaries: primaries(), guard: workspaceGuard })
                if (plan.added.length === 0) throw foldersRefused(plan.refused)
                return saveNewProject(caller, newProject({ folders: plan.folders, taken: takenIds() }), 'clone')
              })
              refresh()
              return workspace.id
            },
          },
        })
        json(res, { clone }, 202)
        return true
      }
      const cloneMatch = path.match(/^\/link\/api\/workspaces\/clone\/([0-9a-f-]{36})(\/cancel)?$/u)
      if (cloneMatch && ((method === 'GET' && !cloneMatch[2]) || (method === 'POST' && cloneMatch[2]))) {
        requireScope(caller, 'admin')
        requireDesktop(caller)
        const id = cloneMatch[1]!
        json(res, { clone: cloneMatch[2] ? await clones.cancel(caller.device.id, id) : clones.get(caller.device.id, id) })
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
        const mayDefine = caller.device.scopes.includes('admin') && isLocalListener(caller.connection.listener)
        const defaultId = defaultHarnessId(mayDefine ? presetsToOffer() : [])
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
        const listing = await hub!.listTasksProven()
        if (privateAgentView(caller) && !customAgents.hasPending())
          await migrateAgentChats(caller, listing).catch(error => log(`Agent 聊天未能核对：${errorText(error)}`))
        const tasks = listing.tasks.filter(task => privateVisible(caller, task)).map(questionSummary)
        const whole = wholeListing(listing)
        const snapshot: AppSnapshot = {
          instanceId,
          revision: snapshotRevision,
          device: currentDevice(caller),
          host: await hostView(),
          tasks,
          ...(whole ? { tasksComplete: true as const } : {}),
          approvals: nativeOpening
            ? []
            : await decorateAll(
                hub!.approvals().filter(approval => tasks.some(task => task.id === approval.sessionId)),
                tasks,
              ),
          demo: options.demo,
          hostName: options.hostName ?? hostname(),
          harness: {
            id: defaultId,
            name: (hub!.info(defaultId) ?? presetsToOffer().find(offer => offer.id === defaultId))?.capabilities.display.label ?? defaultId,
          },
          execution,
          catalog: await catalog(caller),
          ...agentSummaries(caller, tasks),
          version: LATCH_VERSION,
          ...(uiBuild ? { build: uiBuild } : {}),
          hostTime: hostTime(),
        }
        recheck(caller, 'view')
        snapshot.tasks = snapshot.tasks.filter(task => privateVisible(caller, task))
        snapshot.approvals = snapshot.approvals.filter(approval => snapshot.tasks.some(task => task.id === approval.sessionId))
        const handoffSummaries = handoffs.summaries(new Set(snapshot.tasks.map(task => task.id)))
        if (handoffSummaries?.length) snapshot.handoffs = handoffSummaries
        const noteCounts = reviewNotes.counts(new Set(snapshot.tasks.map(task => task.id)))
        if (noteCounts.length) snapshot.reviewNotes = noteCounts
        const appSummaries = await appRoutes.summaries()
        if (appSummaries.length) snapshot.apps = appSummaries
        snapshot.customization = customizationRoutes.state()
        recheck(caller, 'view')
        if (snapshot.device.dataScope !== currentDevice(caller).dataScope)
          throw new AppError(403, 'device-scope-changed', '设备的数据范围已变化，请重新读取。')
        if (privateAgentView(caller) && !customAgents.hasPending()) snapshot.agentChats = customAgents.chats()
        snapshot.tasks = snapshot.tasks.filter(task => privateVisible(caller, task))
        snapshot.approvals = snapshot.approvals.filter(approval => snapshot.tasks.some(task => task.id === approval.sessionId))
        const scope = devices.get(caller.device.id)?.dataScope
        snapshot.approvals = snapshot.approvals.map(approval => {
          if (scope === 'all') return allApproval(approval)
          const task = snapshot.tasks.find(item => item.id === approval.sessionId)
          return scope === 'files' && task ? filesApproval(approval, insideSession(task)) : workApproval(approval)
        })
        // 待办 are placed from every session as listed, private ones too; a private 待办 goes to the full data scope only.
        const listedById = new Map(listing.tasks.map(task => [task.id, task]))
        const items = workItems.list().flatMap(record => {
          const isPrivate = itemIsPrivate(record, id => hub!.agentPrivate(id))
          if (isPrivate) workItems.notePrivate(record.id, log)
          if (isPrivate && scope !== 'all') return []
          return [
            itemSummary(
              record,
              {
                summary: id => listedById.get(id),
                prState: id => boardDelivery.prState(id),
                thread: id => workThreads.revisionOf(id),
                originVisible: id => scope === 'all' || !hub!.agentPrivate(id),
              },
              isPrivate,
            ),
          ]
        })
        if (items.length) snapshot.items = items
        const proposals = workProposalRoutes.summaries(scope)
        if (proposals.length) snapshot.workProposals = proposals
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
          scope: JSON.stringify([caller.device.dataScope, caller.device.scopes.toSorted()]),
          ...(sessionId && req.headers[TASK_DELTA_HEADER] === TASK_DELTA_PROTOCOL
            ? { delta: new TaskDeltaStream(randomUUID(), deltaCache) }
            : {}),
        })
        if (resume?.kind === 'events') {
          for (const event of resume.events) send(res, event)
          const stream = streams.get(res)
          if (stream && streamAllowed(stream)) write(res, stream, 'heartbeat', `id: ${nativeReplay.cursor()}\n: resumed\n\n`)
        } else
          send(res, { type: 'refresh', instanceId, revision, discoveryEpoch: discoveryEpoch(), directoryEpoch: relayDirectory.epoch() })
        req.on('close', () => {
          forgetStream(res)
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
      if (path === '/link/api/diagnostics' && method === 'POST') {
        // This computer's owner only: the command line on host.sock, or the desktop app's admin device there. Counts in
        // the audit record, never what the bundle holds.
        requireLocal(caller)
        if (caller.device) {
          requireScope(caller, 'admin')
          requireDesktop(caller)
        }
        await optionalJsonBody(req, 1024)
        const known = devices.list()
        const streamCounts: Partial<Record<ListenerClass, number>> = {}
        for (const stream of streams.values()) {
          const listener = devices.get(stream.deviceId)?.listener
          if (listener) streamCounts[listener] = (streamCounts[listener] ?? 0) + 1
        }
        const bundle = diagnosticsBundle({
          version: LATCH_VERSION,
          startedAt,
          now,
          home,
          harnesses: hub!.drivers(),
          definitions: config.settings().agents.map(agent => ({
            id: agent.id,
            name: agent.name,
            ...(agent.presetId ? { presetId: agent.presetId } : {}),
          })),
          plugins: registry.list(),
          policy: policy.get(),
          devices: {
            active: known.filter(device => device.status === 'active').length,
            revoked: known.filter(device => device.status === 'revoked').length,
          },
          streams: streamCounts,
          log: diagnosticLog,
          private: [
            ...known.map(device => device.name),
            ...config.settings().workspaces.flatMap(record => [record.name ?? '', ...record.folders.map(folder => folder.path)]),
            ...(await hub!.listTasks()).map(task => task.title ?? ''),
            workspaceRoot,
            realWorkspace,
            dataDir,
            realDataDir,
            // Hosts never enter as events; a Harness's status line might still name one.
            ...policy.get().hostEgressAllow.flatMap(entry => [entry, entry.replace(/:\d+$/u, '')]),
            ...(options.egressAllow ?? []).flatMap(entry => [entry, entry.replace(/:\d+$/u, '')]),
          ],
        })
        await audit.append({
          action: 'diagnostics.exported',
          actor: actorOf(caller),
          detail: {
            logLines: bundle.events.length,
            errors: bundle.errors.length,
            harnesses: bundle.harnesses.length,
            plugins: bundle.plugins.length,
          },
        })
        json(res, bundle)
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
      if (await modelUsageRoutes.handle(req, res, caller, path, method)) return
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
      const configCheck = /^\/link\/api\/tasks\/([^/]+)\/config-requests\/([A-Za-z0-9_-]{8,128})\/check$/u.exec(path)
      if (configCheck && method === 'POST') {
        // Reading the agent may end the session's idle process and open the session again, so it takes what a change takes.
        requireScope(caller, 'run')
        limits.classC.take(caller.device.id)
        const id = safeDecode(configCheck[1]!)
        if (id.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长。')
        const body = configCheckSchema.parse(await jsonBody(req))
        const authorize = async () => {
          recheck(caller, 'run')
          checkPrivateSession(caller, id, true)
          await assertSessionAccess(caller, id)
          await assertSessionWorkspace(id)
          assertWritable(id)
        }
        checkPrivateSession(caller, id)
        await hub!.harnessOf(id)
        await authorize()
        const checked = await configRequests.check(
          id,
          { deviceId: caller.device.id, authorize },
          { requestId: configCheck[2]!, configId: body.configId, value: body.value },
          () => hub!.readConfig(id, body.configId, body.value),
        )
        // Every reading that settles a change is on record, linked to the change's own entry, so an entry that said the
        // change failed (\`action.failed\` after an unknown outcome) is followed by what it became.
        if (checked.settled)
          await audited({
            action: 'task.config.checked',
            actor: actorOf(caller),
            target: id,
            detail: {
              sessionId: id,
              configIdHash: sha256Hex(body.configId),
              toHash: sha256Hex(body.value),
              outcome: checked.state === 'applied' ? 'applied' : 'failed',
              ...(checked.auditSeq !== undefined ? { refSeq: checked.auditSeq } : {}),
            },
          })
        json(res, { state: checked.state, ...(checked.reason ? { reason: checked.reason } : {}) })
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
      const task = path.match(/^\/link\/api\/tasks\/([^/]+)(?:\/(prompt|cancel|keep-waiting|config|stop-subagent|attend|computer-stop))?$/)
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
        const record = worktreeProject(safeDecode(worktreeMatch[1]!))
        const base = await worktrees.base(record.folders[0].path)
        const reusable = (await latchWorktrees(record, caller)).filter(entry => entry.reusable)
        recheck(caller, 'run')
        json(res, { ...base, ...(reusable.length ? { reusable } : {}) } satisfies WorktreeBase)
        return
      }
      const leftoversMatch = path.match(/^\/link\/api\/workspaces\/([^/]+)\/worktrees(?:\/(\d{8}-[0-9a-f]{4})(\/remove)?)?$/)
      if (leftoversMatch) {
        requireScope(caller, 'run')
        const record = worktreeProject(safeDecode(leftoversMatch[1]!))
        const name = leftoversMatch[2]
        if (method === 'GET' && name === undefined) {
          json(res, { worktrees: await latchWorktrees(record, caller) })
          return
        }
        if (name === undefined) throw new AppError(405, 'method-not-allowed', '不支持这个方法')
        const body = method === 'POST' && leftoversMatch[3] ? removeWorktreeSchema.parse(await jsonBody(req)) : undefined
        const known = body && caller.device && removals.get(`${caller.device.id}:${body.requestId}`)
        if (known) {
          json(res, await known)
          return
        }
        const entry = (await latchWorktrees(record, caller)).find(item => item.name === name)
        // After a restart a retry finds its removal on record.
        const earlier =
          !entry && body && caller.device
            ? earlierRemoval({ requestHash: sha256Hex(body.requestId), deviceId: caller.device.id })
            : undefined
        if (earlier) {
          json(res, earlier)
          return
        }
        if (!entry) throw new AppError(404, 'worktree-not-found', '找不到这个工作树，或它不是 Latch 新建的。')
        // A worktree a session owns is removed from that session's menu, where its record is.
        if (entry.state !== 'leftover') throw new AppError(409, 'worktree-owned', '这个工作树属于一个会话，请在那个会话的菜单里移除它。')
        const leftover = (await worktrees.list(record.folders[0].path)).find(item => item.name === name)!
        const path = leftover.path
        // A private session's leftover: its file names and its removal stay with devices that may see private content.
        if (leftover.private && !fullData(caller))
          throw new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
        if (method === 'GET' && !leftoversMatch[3]) {
          json(res, await worktreeFacts(caller, path))
          return
        }
        if (body) {
          json(res, await removeWorktree(caller, res, record, path, undefined, body))
          return
        }
        throw new AppError(405, 'method-not-allowed', '不支持这个方法')
      }
      const sessionWorktreeMatch = path.match(/^\/link\/api\/tasks\/([^/]+)\/worktree(\/remove)?$/)
      if (sessionWorktreeMatch) {
        requireScope(caller, 'run')
        const sessionId = safeDecode(sessionWorktreeMatch[1]!)
        checkPrivateSession(caller, sessionId)
        const task = await sessionTask(sessionId)
        const worktree = task && hub!.worktreeOf(sessionId)
        if (!task || !worktree) throw new AppError(404, 'worktree-not-found', '这个会话不在 Latch 新建的工作树里。')
        const body = method === 'POST' && sessionWorktreeMatch[2] ? removeWorktreeSchema.parse(await jsonBody(req)) : undefined
        // A retry of a removal this Host answered gets the same answer.
        const known = body && caller.device && removals.get(`${caller.device.id}:${body.requestId}`)
        if (known) {
          json(res, await known)
          return
        }
        if (worktree.removed) throw new AppError(409, 'worktree-removed', '这个会话的工作树已经移除。')
        const record = worktreeProject(task.workspaceId ?? 'default')
        if (method === 'GET' && !sessionWorktreeMatch[2]) {
          if ((await worktrees.sessionOf(worktree.path)) !== sessionId)
            throw new AppError(409, 'worktree-owned', '这个工作树已不属于这个会话，没有改动。')
          json(res, await worktreeFacts(caller, worktree.path))
          return
        }
        if (body) {
          json(res, await removeWorktree(caller, res, record, worktree.path, sessionId, body))
          return
        }
        throw new AppError(405, 'method-not-allowed', '不支持这个方法')
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
      if (relativePath.startsWith('app-frame/')) {
        // The page runtime is public and fixed; it holds nothing, and a page's code reaches it only from the parent.
        if (relativePath !== 'app-frame/runtime.html') throw new AppError(404, 'not-found', '页面不存在')
        if (!isLocalListener(listener.listener) && req.headers['sec-fetch-dest'] !== 'iframe')
          throw new AppError(403, 'preview-refused', '请在插件页面中打开')
        const frame = await readAppFrame(resolve(options.uiDir))
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
      logNoted('request-failed', { error: failure }, `Request failed: ${errorText(failure)}`)
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
    // Once after start: recent idle sessions' local Git for 可交付, in the background (board.ts).
    const boardWarm = setTimeout(() => {
      void harnessHub
        .listTasks()
        .then(tasks => boardDelivery.warm(tasks, now()))
        .catch(error => log(`交付状态未能预读：${errorText(error)}`))
    }, BOARD_WARM_DELAY_MS)
    boardWarm.unref()
    // Once after start: sessions deleted while the Host was not running leave their 待办, on a whole listing only, so a
    // Harness that has not mounted never strips its sessions. Only members held before the listing are judged.
    const itemsPrune = setTimeout(() => {
      const held = new Set(workItems.list().flatMap(item => item.sessionIds))
      if (!held.size) return
      void harnessHub
        .listTasksProven()
        .then(async listing => {
          if (!wholeListing(listing)) return
          const present = new Set(listing.tasks.map(task => task.id))
          const gone = new Set([...held].filter(id => !present.has(id)))
          if (!gone.size) return
          for (const item of await workItems.dropSessions(gone)) itemChanged(item, [])
        })
        .catch(error => log(`待办的会话未能核对：${errorText(error)}`))
    }, BOARD_WARM_DELAY_MS)
    itemsPrune.unref()

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
          clearTimeout(boardWarm)
          modelRequests.close()
          // First, while the engines still answer: a check made against a closing Host would pause on its way out.
          await automations.close()
          await handoffs.close()
          await reviewNotes.close()
          await sessionLifecycle.hostStopping()
          // A clone under way ends and its folder goes: a half-made folder never becomes a project.
          await clones.close()
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
            // Lines of requests that ended as the Host stops are written before it is gone.
            () => usageLedger.flushed(),
            () => turnLog.flushed(),
            () => toolGateway?.close(),
            () => questions.close(),
            () => clearInterval(purgeTimer),
            () => customAgents.close(),
            // An orderly stop is recorded, so a time missed until the next start reads as Latch not running.
            () => computer.close(),
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
