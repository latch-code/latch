import { AppError } from '@latch/sdk'
import { invalidReply, object } from './ir.ts'

/** How services say a request does not fit the model's context window. */
export const CONTEXT_OVERFLOW = /context_length_exceeded|maximum context|context window|prompt is too long/iu

/**
 * What Claude Code recognises as a too-long request and recovers from by compacting (code.claude.com/docs/en/errors,
 * "Prompt is too long"): the Anthropic API's own sentence, Amazon Bedrock's, and the stable token a gateway may put in
 * front of a cloud provider's wording.
 */
const CLAUDE_OVERFLOW = /prompt is too long|input is too long for requested model|capability_rejected: prompt_too_long/iu
const CLAUDE_OVERFLOW_TOKEN = 'capability_rejected: prompt_too_long'

export function responseError(value: unknown): AppError {
  const error = object(value)
  const description = `${typeof error?.code === 'string' ? error.code : ''} ${typeof error?.message === 'string' ? error.message : ''}`
  if (CONTEXT_OVERFLOW.test(description)) return new AppError(400, 'context_length_exceeded', '输入超过模型服务的上下文上限')
  if (/rate_limit_exceeded|slow_down/iu.test(description)) return new AppError(429, 'rate_limit_exceeded', '模型服务暂时限流')
  if (/server_is_overloaded|overloaded_error/iu.test(description)) return new AppError(503, 'server_is_overloaded', '模型服务暂时繁忙')
  return invalidReply('模型服务在回复中报告错误')
}

/** The message of a service's error body in any of the three protocols' shapes, else the text as it came. */
export function serviceMessage(text: string): string {
  try {
    const parsed = object(JSON.parse(text))
    const error = object(parsed?.error)
    const message = error?.message ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    // Not JSON: the text is the message.
  }
  return text.trim()
}

/** Whether a refused request was refused for not fitting the context window: never a 429 or a server's own failure. */
export const overflowed = (status: number, text: string) => status >= 400 && status < 500 && status !== 429 && CONTEXT_OVERFLOW.test(text)

/**
 * A context overflow as an Anthropic error Claude Code compacts on, the service's own words kept after the token; none
 * when Claude Code already recognises what the service said, which then goes to it unchanged.
 */
export function claudeOverflow(text: string): string | undefined {
  if (CLAUDE_OVERFLOW.test(text)) return undefined
  const message = serviceMessage(text).slice(0, 1000) || '输入超过模型服务的上下文上限'
  return JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${CLAUDE_OVERFLOW_TOKEN} · ${message}` } })
}
