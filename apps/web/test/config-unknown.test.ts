import { describe, expect, it, vi } from 'vitest'
import { ApiError, ApiTimeoutError, isUncertain } from '../src/core/api.ts'
import { ConfigRequests, configUncertain } from '../src/core/configRequest.ts'
import { agentConfigBlocked, configUnknownBar, feedbackFor, type SessionConfigFeedback } from '../src/composer/modelReasoning.ts'

const unknown: SessionConfigFeedback = {
  kind: 'unknown',
  message: '没有收到 Agent 的确认。',
  configId: 'model',
  valueName: '模型 opencode/Beam Free',
  at: Date.UTC(2026, 10, 13, 6, 2),
}

describe('an unknown config change in place', () => {
  it('marks only the control it was for, and still blocks every write to the session until it is settled', () => {
    expect(feedbackFor(unknown, ['model'])).toBe(true)
    expect(feedbackFor(unknown, ['effort'])).toBe(false)
    expect(feedbackFor({ kind: 'unknown', message: '' }, ['effort'])).toBe(true)
    expect(feedbackFor(undefined, ['model'])).toBe(false)
    expect(agentConfigBlocked({ busy: null, feedback: unknown })).toBe(true)
  })

  it('says what was asked for, when, and offers 核对 and 重试同一请求; a failure or an old feedback has no bar', () => {
    const check = vi.fn(async () => {}),
      retry = vi.fn(async () => {})
    const bar = configUnknownBar(unknown, 'OpenCode', check, retry)!
    expect(bar).toMatchObject({ what: '模型 opencode/Beam Free', harness: 'OpenCode', at: unknown.at, checking: false })
    bar.onCheck()
    bar.onRetry()
    expect(check).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(configUnknownBar({ ...unknown, checking: true }, 'OpenCode', check, retry)?.checking).toBe(true)
    expect(configUnknownBar({ kind: 'failed', message: '没有切换', configId: 'model' }, 'OpenCode', check, retry)).toBeUndefined()
    expect(configUnknownBar({ kind: 'unknown', message: '' }, 'OpenCode', check, retry)).toBeUndefined()
    expect(configUnknownBar(undefined, 'OpenCode', check, retry)).toBeUndefined()
  })

  it('keeps the original requestId through 核对 that cannot settle, and lets a new pick start only once the Host settles it', () => {
    const requests = new ConfigRequests(),
      request = requests.begin('a', 'model', 'opencode/beam-free')!
    const lost = new ApiError(503, 'config-outcome-unknown', '设置结果未知')
    expect(isUncertain(lost)).toBe(true)
    requests.settle('a', request, lost)
    // 核对 that finds no reading: the same request stays, with its identity.
    expect(requests.reconcile('a', request, [], 'unknown')).toBe(false)
    expect(requests.get('a')?.requestId).toBe(request.requestId)
    // 重试同一请求 with no answer again keeps it too.
    requests.settle('a', request, new ApiTimeoutError())
    expect(requests.get('a')).toBe(request)
    expect(requests.begin('a', 'model', 'opencode/big-pickle')).toBeUndefined()
    // The Host settles it from the agent's reading: only then a new choice, with a new identity.
    expect(requests.reconcile('a', request, [], 'failed')).toBe(true)
    expect(requests.begin('a', 'model', 'opencode/big-pickle')?.requestId).not.toBe(request.requestId)
  })

  it('treats a refusal the Host marks as not applied as a definite failure', () => {
    const requests = new ConfigRequests(),
      request = requests.begin('a', 'model', 'opencode/beam-free')!
    const refused = new ApiError(501, 'not-supported', 'OpenCode 不支持修改该设置', { configOutcome: 'refused' })
    expect(configUncertain(refused)).toBe(false)
    expect(configUncertain(new ApiError(501, 'not-supported', 'OpenCode 不支持修改该设置'))).toBe(true)
    requests.settle('a', request, refused)
    expect(requests.get('a')).toBeUndefined()
  })
})

describe('why 核对 could not settle', () => {
  it('says what holds it up, in a few words', async () => {
    const { checkReasonText } = await import('../src/core/configRequest.ts')
    expect(checkReasonText('running', 'OpenCode')).toBe('会话正在运行或等你处理，结束后再核对。')
    expect(checkReasonText('subagents', 'OpenCode')).toBe('子 Agent 可能还在运行，结束后再核对。')
    expect(checkReasonText('neither', 'OpenCode')).toContain('OpenCode 现在用的既不是原来的值')
    expect(checkReasonText(undefined, 'OpenCode')).toBe('没有读到 OpenCode 的设置，稍后再核对。')
  })
})

describe('放弃这次结果', () => {
  it('is offered only after 核对 could not settle the change', () => {
    const noop = async () => {},
      abandon = vi.fn()
    expect(configUnknownBar(unknown, 'OpenCode', noop, noop, abandon)?.onAbandon).toBeUndefined()
    const stuck = configUnknownBar({ ...unknown, abandonable: true }, 'OpenCode', noop, noop, abandon)!
    stuck.onAbandon!()
    expect(abandon).toHaveBeenCalledTimes(1)
  })

  it('sets the change down on this page only: a new pick gets a new requestId, and the old one is gone for good', () => {
    const requests = new ConfigRequests(),
      request = requests.begin('a', 'model', 'opencode/beam-free')!
    // Only an unknown change can be set down.
    expect(requests.abandon('a', request)).toBe(false)
    requests.settle('a', request, new ApiTimeoutError())
    expect(requests.abandon('a', request)).toBe(true)
    expect(requests.get('a')).toBeUndefined()
    const next = requests.begin('a', 'model', 'opencode/beam-free')!
    expect(next.requestId).not.toBe(request.requestId)
    // A late answer to the abandoned request changes nothing.
    expect(requests.settle('a', request)).toBe(false)
    expect(requests.reconcile('a', request, [], 'applied')).toBe(false)
    expect(requests.get('a')).toBe(next)
  })
})
