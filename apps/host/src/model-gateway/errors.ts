import { AppError } from '@latch/sdk'
import { invalidReply, object } from './ir.ts'

export function responseError(value: unknown): AppError {
  const error = object(value)
  const description = `${typeof error?.code === 'string' ? error.code : ''} ${typeof error?.message === 'string' ? error.message : ''}`
  if (/context_length_exceeded|maximum context|context window|prompt is too long/iu.test(description))
    return new AppError(400, 'context_length_exceeded', '输入超过模型服务的上下文上限')
  if (/rate_limit_exceeded|slow_down/iu.test(description)) return new AppError(429, 'rate_limit_exceeded', '模型服务暂时限流')
  if (/server_is_overloaded|overloaded_error/iu.test(description)) return new AppError(503, 'server_is_overloaded', '模型服务暂时繁忙')
  return invalidReply('模型服务在回复中报告错误')
}
