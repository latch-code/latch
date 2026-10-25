/** Stable product interfaces. No upstream harness types cross this module. */
import type { HarnessDriver } from './harness.ts'

export type { PluginInfo } from '@latch/protocol/types'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  isError?: boolean
}
export type ModelDelta =
  | { type: 'text'; text: string }
  /** Reasoning the model reported. It is shown to the user and never sent back as history. */
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
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  requiresApproval: boolean
  /** Optional presentation hint for tool rows, e.g. `read`, `edit`, `execute`. */
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
    },
  ): Promise<{ text: string }>
}
export interface ModelProvider {
  id: string
  name: string
  /** Default model ID. */
  model: string
  /** Model IDs the user enabled for this provider. Absent means only `model`. */
  models?: string[]
  /** `model` in the request overrides the default; providers must not silently substitute another. */
  stream(request: { messages: ModelMessage[]; tools: ToolDefinition[]; signal: AbortSignal; model?: string }): AsyncIterable<ModelDelta>
}
export interface PluginContext {
  registerProvider(provider: ModelProvider): void
  registerTool(tool: ToolDefinition): void
  registerHarness(driver: HarnessDriver): void
  onDispose(dispose: () => void | Promise<void>): void
}
export interface HarnessPlugin {
  id: string
  name: string
  version: string
  description: string
  activate(context: PluginContext): void | Promise<void>
}
export interface CapabilityLease {
  provider: ModelProvider
  tools: ToolDefinition[]
  release(): void
}
export interface HarnessLease {
  driver: HarnessDriver
  release(): void
}
export interface RuntimeRegistry {
  /** `tools: false` leases only the provider's plugin, e.g. for chat runs. */
  acquire(providerId: string, options?: { tools?: boolean }): CapabilityLease
}
