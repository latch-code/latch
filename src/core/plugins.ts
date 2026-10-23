/** Stable product interfaces. No upstream harness types cross this module. */
import type { HarnessDriver } from './harness.ts'

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
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
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' }
export interface ToolPreview {
  /** Short human summary shown on the tool row and approval card. */
  title?: string
  /** `previous` says whether the file existed: `none` is a new file, `unavailable` existed but is not shown. */
  diffs?: Array<{ path: string; oldText?: string; newText: string; previous?: 'none' | 'text' | 'unavailable' }>
}
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  requiresApproval: boolean
  /** Optional presentation hint for tool rows, e.g. `read`, `edit`, `execute`. */
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'
  /** Optional, side-effect free. Describes a call before it runs, e.g. the diff a write would apply. */
  preview?(args: Record<string, unknown>, context: { workspaceRoot: string; signal: AbortSignal }): Promise<ToolPreview>
  execute(args: Record<string, unknown>, context: {
    sessionId: string; callId: string; workspaceRoot: string; signal: AbortSignal
  }): Promise<{ text: string }>
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
export interface PluginInfo {
  id: string; name: string; version: string; description: string
  enabled: boolean; activeRuns: number; capabilities: string[]
  /** Set when the Host manages the plugin from settings (model providers, agents). */
  managed?: 'provider' | 'agent' | 'core'
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
