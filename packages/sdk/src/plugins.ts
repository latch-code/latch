/** Stable product interfaces. No upstream harness types cross this module. */
import type { HarnessDriver } from './harness.ts'
import type { TransportDriver } from './transports.ts'
export type * from './transports.ts'
import type { ModelCapabilities, TaskSummary, UiPanelDocument, UiPanelInfo } from '@latch/protocol/types'

export type { PluginInfo } from '@latch/protocol/types'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /**
   * Opaque text the provider keeps with the call, such as a thought signature or the signed reasoning of the
   * response that made it, and `by`, who made it: protocol, service and model. The session's history keeps it, at most
   * 1 MiB, out of what clients see; a provider sends it back only where `by` names itself. `scope: 'turn'` says the
   * provider sends it back only within the turn that made it, so the history drops it once the next user message comes.
   */
  signature?: { by: string; value: string; scope?: 'turn' }
}
export type AttachmentContent =
  | { type: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
  | { type: 'text'; text: string; name: string }
export interface ModelMessage {
  attachments?: AttachmentContent[]
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  isError?: boolean
}
export type ModelDelta =
  | { type: 'text'; text: string }
  /** Another service answered than the one asked: a 「出错时改用」 candidate, by ID and model. Sent before its reply. */
  | { type: 'route'; providerId: string; model: string }
  /** Reasoning the model reported, shown to the user. This text is never sent back; a signed copy may be, in `ToolCall.signature`. */
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  /**
   * Tokens of this request. `inputTokens` is all input and `outputTokens` all output; the optional parts say how much
   * of them was a cache read or write, or reasoning, when the service reports it.
   */
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
    }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' }
export interface ToolPreview {
  /** Short human summary shown on the tool row and approval card. */
  title?: string
  /**
   * What this one call will do, as a short label for its approval card in place of the general sentence: 「在
   * localhost:5173 点击 "保存"」. Display only; it never changes the Host's risk class.
   */
  summary?: string
  /** `previous` says whether the file existed: `none` is a new file, `unavailable` existed but is not shown. */
  diffs?: Array<{ path: string; oldText?: string; newText: string; previous?: 'none' | 'text' | 'unavailable' }>
}
/** A folder of the session's project, as a tool sees it. */
export interface SessionFolder {
  /** The folder's ID inside the project; the model passes it to select the folder. */
  id: string
  /** Absolute path. */
  path: string
  /** The primary folder: the session's working directory and `workspaceRoot`. */
  primary: boolean
}
/** An image a tool returns with its text, base64 encoded: the Host keeps it as a private attachment of the session. */
export interface ToolImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  data: string
}
/**
 * What `execute` resolves to. `images` reach the model with the result: inside the tool result where its protocol takes
 * images there, otherwise in a user message right after the results that names the tool. A run whose model cannot see
 * images (`vision`) does not offer a tool that declares `returnsImages`, and drops images from any other tool.
 */
export interface ToolResult {
  text: string
  /** A result's public status/metadata without file contents, for devices whose data scope is work. Not model input. */
  textWithoutFiles?: string
  images?: ToolImage[]
}
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  requiresApproval: boolean
  /** A cooperative user-input tool: waiting time is excluded from the run's working duration. Does not change risk. */
  waitsForUser?: boolean
  /** It answers with images (`ToolResult.images`): a run whose model cannot see images does not offer it. */
  returnsImages?: boolean
  /** Called after the tool result is durably stored, before the model continues. Never acknowledges an uncommitted result. */
  resultCommitted?(context: { sessionId: string; callId: string; state: 'completed' | 'failed' | 'cancelled' }): Promise<void>
  /**
   * Optional short name of what the tool does, in the product's language: 「读取文件」, 「写入文件」. Tool rows and approval
   * cards show it with the call's object; without it they show `name`. Display only: it never changes the Host's risk
   * class, and invisible or direction-changing characters in it are shown escaped.
   */
  title?: string
  /** Optional presentation hint for tool rows' icons and verbs, e.g. `read`, `edit`, `execute`. */
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'
  /** Optional, side-effect free. Describes a call before it runs, e.g. the diff a write would apply. */
  preview?(
    args: Record<string, unknown>,
    context: { workspaceRoot: string; workspaceFolders?: ReadonlyArray<SessionFolder>; signal: AbortSignal },
  ): Promise<ToolPreview>
  execute(
    args: Record<string, unknown>,
    context: {
      sessionId: string
      callId: string
      /** The primary folder of the session's project. */
      workspaceRoot: string
      /** Every folder of the session, primary first. Latch's runtime always sets it; absent from older drivers, where `workspaceRoot` is the only folder. */
      workspaceFolders?: ReadonlyArray<SessionFolder>
      signal: AbortSignal
      /** The approval the person gave this call, when it asked for one. */
      approvalId?: string
      /**
       * Marks time the call spends waiting for a person (a takeover, say) as waiting rather than working: calling it
       * opens such a wait, and calling what it returns closes it. Absent from older drivers.
       */
      waitForUser?: () => () => void
    },
  ): Promise<ToolResult>
}
export interface ModelProvider {
  modelCapabilities?: Readonly<Record<string, ModelCapabilities>>
  id: string
  name: string
  /** Default model ID. */
  model: string
  /** Model IDs the user enabled for this provider. Absent means only `model`. */
  models?: string[]
  /**
   * `model` in the request overrides the default; providers must not silently substitute another. `effort` is one of
   * `modelCapabilities[model].thinking`; absent leaves the model's default, and a level the model does not declare fails.
   */
  stream(request: {
    messages: ModelMessage[]
    tools: ToolDefinition[]
    signal: AbortSignal
    model?: string
    effort?: string
    /** The run asking, for a provider that schedules its requests by session and turn; never a credential. */
    run?: { sessionId: string; runId: string }
  }): AsyncIterable<ModelDelta>
}
export interface PluginContext {
  registerProvider(provider: ModelProvider): void
  registerTool(tool: ToolDefinition): void
  registerHarness(driver: HarnessDriver): void
  registerTransport(driver: TransportDriver): void
  registerUiPanel(panel: UiPanelDefinition): void
  registerClientPanel(panel: ClientPanelDefinition): void
  registerSkill(skill: SkillDefinition): void
  onDispose(dispose: () => void | Promise<void>): void
}
export interface SkillDefinition {
  /** Local to this package. Enabled skills are included in each Standard run, including chat. */
  id: string
  name: string
  description: string
  content: string
}
/** A bundled ESM component, with React and Latch primitives supplied by the client. No runtime compilation. */
export interface ClientPanelDefinition {
  id: string
  title: string
  description?: string
  harnessIds?: string[]
  source: string
}
export interface ClientPanelLease {
  info: UiPanelInfo
  source: string
  release(): void
}
/** A side-effect-free view of one session. It runs on the Host and returns client-independent presentation data. */
export interface UiPanelContext {
  session: TaskSummary
  signal: AbortSignal
}
export interface UiPanelDefinition {
  /** Local to the plugin; the published panel ID is `<plugin id>:<id>`. */
  id: string
  title: string
  description?: string
  harnessIds?: string[]
  /** False keeps this as a package data source without adding another visible tab. It is still view-authorized. */
  listed?: boolean
  render(context: UiPanelContext): UiPanelDocument | Promise<UiPanelDocument>
}
export interface UiPanelLease {
  info: UiPanelInfo
  render(context: UiPanelContext): Promise<UiPanelDocument>
  release(): void
}
export interface LatchPlugin {
  id: string
  name: string
  version: string
  description: string
  /** Present for a directory package loaded from latch-plugin.json; legacy module plugins remain supported. */
  package?: { formatVersion: 1 | 2 }
  activate(context: PluginContext): void | Promise<void>
}
/** Compatibility name for existing plugin modules. A plugin may contribute a whole feature. */
export type HarnessPlugin = LatchPlugin

export interface CapabilityLease {
  provider: ModelProvider
  tools: ToolDefinition[]
  /** A detached, run-stable snapshot; IDs are namespaced by the owning package. */
  skills?: SkillDefinition[]
  release(): void
}
export interface HarnessLease {
  driver: HarnessDriver
  release(): void
}
export interface RuntimeRegistry {
  /** `tools: false` leases only the provider's plugin, e.g. for chat runs. */
  acquire(
    providerId: string,
    options?: { tools?: boolean; pluginIds?: ReadonlyArray<string>; expectedRevisions?: Readonly<Record<string, string>> },
  ): CapabilityLease
}
