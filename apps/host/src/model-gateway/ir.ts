import { AppError } from '@latch/sdk'
import type { GatewayLoss } from '@latch/protocol'
export type { GatewayLoss } from '@latch/protocol'

/** Gateway-only content. Standard's model history is deliberately not used as a translation format. */
export type Content = { type: 'text'; text: string } | { type: 'image'; url: string; detail?: string }

export interface ToolIdentity {
  name: string
  namespace?: string
  kind: 'function' | 'custom'
}

export interface GatewayTool extends ToolIdentity {
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export type GatewayItem =
  | { type: 'message'; role: 'system' | 'user' | 'assistant'; content: Content[] }
  | ({ type: 'call'; id: string; arguments: string } & ToolIdentity)
  | { type: 'result'; id: string; content: Content[] }
  | { type: 'reasoning'; text: string }

export interface GatewayRequest {
  model: string
  stream: boolean
  input: GatewayItem[]
  tools: GatewayTool[]
  choice?: 'auto' | 'none' | 'required' | ToolIdentity
  parallel?: boolean
  effort?: string
  maxOutput?: number
  temperature?: number
  topP?: number
  stop?: string[]
  format?: Record<string, unknown>
  dropped: GatewayLoss[]
}

/** Optional parts stay absent unless the service actually reported them. Output includes reasoning tokens. */
export interface GatewayUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export type GatewayDelta =
  | { type: 'text' | 'reasoning' | 'refusal'; text: string }
  | { type: 'tool'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; usage: GatewayUsage }
  | { type: 'loss'; loss: GatewayLoss }
  | { type: 'finish'; reason: 'stop' | 'tools' | 'length' | 'filter' }

export const invalidRequest = (message: string): AppError => new AppError(400, 'gateway-translation-input', message)
export const invalidReply = (message: string): AppError => new AppError(502, 'gateway-translation-output', message)

export const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export function requiredText(value: unknown, name: string, max = 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > max) throw invalidRequest(`${name} 格式无效或内容过大`)
  return value
}

export const toolKey = (tool: ToolIdentity): string => JSON.stringify([tool.namespace ?? null, tool.name, tool.kind])
