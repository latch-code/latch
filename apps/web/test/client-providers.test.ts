import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '@latch/protocol'
import { confirmationStore } from '../src/core/confirmations.ts'
import { ApiError, ApiTimeoutError } from '../src/core/api.ts'
import {
  checkAction,
  describeProbeFailure,
  destinationOf,
  heldBackService,
  isConnectionFailure,
  keyScopeOf,
  latestQuestions,
  missingKey,
  modelIdProblem,
  originOf,
  presetKeyOrigins,
  serviceHealth,
  shownAddress,
  trackedPresenter,
} from '../src/core/providerSetup.ts'
import { describeFailure, isCatalogCode, PROVIDER_COPY } from '../src/core/securityCopy.ts'

const failure = (code: string, details: Record<string, unknown> = {}, message = '主机原文') =>
  describeProbeFailure(new ApiError(code === 'http-error' ? 502 : 403, code, message, details))

describe('a service asked again', () => {
  it('drops an answer to a question asked before the latest one', () => {
    const questions = latestQuestions()
    const before = questions.ask('a')
    const other = questions.ask('b')
    expect(before()).toBe(true)
    const after = questions.ask('a')
    expect(before()).toBe(false)
    expect(after()).toBe(true)
    expect(other()).toBe(true)
  })
})

describe('model-service addresses', () => {
  it('does not let an older provider request close the confirmation of a newer request', () => {
    confirmationStore.host('provider-form', true)
    try {
      const first = trackedPresenter(() => {})
      const second = trackedPresenter(() => {})
      const actions = { cancel: () => {}, dismiss: () => {} }
      first.show({ phase: 'paused', reason: 'busy', message: 'first' }, actions)
      second.show({ phase: 'paused', reason: 'busy', message: 'second' }, actions)
      first.close()
      expect(confirmationStore.get()?.view).toMatchObject({ message: 'second' })
      second.close()
      expect(confirmationStore.get()).toBeNull()
    } finally {
      confirmationStore.unhost('provider-form')
      confirmationStore.close()
    }
  })

  it('writes origins and key scopes as the Host compares them', () => {
    expect(originOf('https://API.DeepSeek.com/v1')).toBe('https://api.deepseek.com:443')
    expect(originOf(' http://127.0.0.1:11434/v1 ')).toBe('http://127.0.0.1:11434')
    expect(originOf('ftp://example.com')).toBeUndefined()
    expect(originOf('not a url')).toBeUndefined()
    expect(keyScopeOf('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1')
    expect(keyScopeOf('https://gateway.example/tenant-a/v1', false)).toBe('https://gateway.example:443')
  })

  it('shows an address without the port its scheme implies', () => {
    expect(shownAddress('https://api.deepseek.com:443/v1')).toBe('https://api.deepseek.com/v1')
    expect(shownAddress('http://127.0.0.1:80')).toBe('http://127.0.0.1')
    expect(shownAddress('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
    expect(shownAddress('https://[::1]:8443/v1')).toBe('https://[::1]:8443/v1')
    expect(shownAddress('not an address')).toBe('not an address')
  })

  it('knows which addresses need no confirmation, and says nothing for a Host that does not tell', () => {
    expect([...presetKeyOrigins(PROVIDER_PRESETS)]).toContain('https://api.deepseek.com:443')
    expect([...presetKeyOrigins(PROVIDER_PRESETS)]).not.toContain('http://127.0.0.1:11434')
    const data = { presets: PROVIDER_PRESETS, confirmedAddresses: ['http://127.0.0.1:1234/v1'], runOrigins: ['http://127.0.0.1:5678'] }
    expect(destinationOf('https://api.deepseek.com/v1', data)).toBe('preset')
    expect(destinationOf('http://127.0.0.1:1234/v1/', data)).toBe('confirmed')
    expect(destinationOf('http://127.0.0.1:11434/v1', data)).toBe('unconfirmed')
    // A confirmation covers one origin and path: another tenant path on the same gateway is not confirmed.
    expect(destinationOf('http://127.0.0.1:1234/other/v1', data)).toBe('unconfirmed')
    expect(destinationOf('http://127.0.0.1:1234', data)).toBe('unconfirmed')
    // The origin the Host was started with counts at every path, for this run.
    expect(destinationOf('http://127.0.0.1:5678/anything', data)).toBe('confirmed')
    // Plain HTTP or another port at a preset's host is not the preset.
    expect(destinationOf('http://api.deepseek.com/v1', data)).toBe('unconfirmed')
    expect(destinationOf('http://127.0.0.1:11434/v1', { presets: PROVIDER_PRESETS })).toBe('unknown')
    expect(destinationOf('', data)).toBe('unknown')
  })

  it('says in one sentence why a check failed, and treats a local address as the way forward', () => {
    expect(failure('egress-denied', { target: '127.0.0.1:11434' })).toEqual({
      kind: 'local',
      target: '127.0.0.1:11434',
      text: PROVIDER_COPY.localAddress('127.0.0.1:11434'),
    })
    // A target that is not a plain host:port is never put into a sentence.
    expect(failure('egress-denied', { target: 'evil‮.example:80' }, describeFailure(403, 'egress-denied', { host: 'x' }, {}))).toMatchObject(
      {
        kind: 'other',
      },
    )
    expect(failure('http-error', { upstreamStatus: 401 })).toEqual({ kind: 'key', text: '密钥不对或已过期。检查密钥后重新检测。' })
    // A key restricted to chat can get 403 on the listing alone: not called invalid, and no new key is suggested.
    expect(failure('http-error', { upstreamStatus: 403 }).kind).toBe('listing')
    expect(serviceHealth(failure('http-error', { upstreamStatus: 403 }))).toBe('unknown')
    expect(serviceHealth(failure('http-error', { upstreamStatus: 401 }))).toBe('key')
    expect(failure('http-error', { upstreamStatus: 404 }).text).toContain('没有模型列表')
    expect(failure('http-error', { upstreamStatus: 500 }).text).toBe('模型服务返回了错误（HTTP 500）。')
    expect(failure('network-error', { networkCode: 'ECONNREFUSED' }).text).toBe(
      'Latch 连不上这个地址：那里没有服务在监听。确认服务已经启动、端口正确。',
    )
    expect(failure('network-error', { networkCode: 'ENOTFOUND' }).text).toBe('Latch 找不到这个地址。检查地址的拼写和网络。')
    expect(failure('network-error', { networkCode: 'CERT_HAS_EXPIRED' }).text).toBe('Latch 不信任这个地址的 HTTPS 证书。')
    expect(failure('network-error').text).toBe('Latch 连不上这个地址。检查地址和网络。')
    expect(failure('timeout').text).toBe('Latch 连不上这个地址：10 秒内没有响应。')
    // A service that answers without a usable model list is not a failed connection: many gateways have none.
    expect(failure('invalid-response').kind).toBe('listing')
    expect(failure('http-error', { upstreamStatus: 404 }).kind).toBe('listing')
    expect(failure('http-error', { upstreamStatus: 500 }).kind).toBe('listing')
    expect(failure('http-error', { upstreamStatus: 429 }).kind).toBe('other')
    expect(failure('redirect').kind).toBe('address')
    // The form's own words: 地址 and 密钥, never API 地址 or API Key.
    expect(failure('redirect').text).toBe('服务返回了重定向。请填写最终的地址。')
    for (const code of ['redirect', 'invalid-response', 'invalid-key', 'http-error'])
      expect(failure(code, { upstreamStatus: 404 }).text).not.toMatch(/API (地址|Key)/u)
    for (const kind of ['key', 'network'] as const) expect(isConnectionFailure({ kind, text: '' }), kind).toBe(true)
    for (const kind of ['listing', 'address', 'other'] as const) expect(isConnectionFailure({ kind, text: '' }), kind).toBe(false)
    expect(failure('key-origin-mismatch').text).toBe('已保存的密钥只发往原来的地址。请重新输入密钥。')
    expect(failure('something-new', {}, '保留主机的说明').text).toBe('保留主机的说明')
    expect(describeProbeFailure(new ApiTimeoutError()).kind).toBe('network')
    for (const result of [failure('http-error', { upstreamStatus: 401 }), failure('network-error', { networkCode: 'ECONNREFUSED' })])
      expect(result.text).not.toContain('主机原文')
  })

  it('offers a new key for a refused key, removal only for a just-saved service that cannot connect, never for a missing list', () => {
    const key = failure('http-error', { upstreamStatus: 401 })
    const network = failure('network-error', { networkCode: 'ECONNREFUSED' })
    const listing = failure('http-error', { upstreamStatus: 500 })
    expect(checkAction(key, { keyEditable: true, justSaved: true })).toBe('key')
    expect(checkAction(key, { keyEditable: false, justSaved: true })).toBe('remove')
    expect(checkAction(key, { keyEditable: false, justSaved: false })).toBeUndefined()
    expect(checkAction(network, { keyEditable: true, justSaved: true })).toBe('remove')
    expect(checkAction(network, { keyEditable: true, justSaved: false })).toBeUndefined()
    for (const justSaved of [true, false]) expect(checkAction(listing, { keyEditable: true, justSaved })).toBeUndefined()
    expect(checkAction(failure('egress-denied', { target: '127.0.0.1:11434' }), { keyEditable: true, justSaved: true })).toBeUndefined()
    expect(checkAction(null, { keyEditable: true, justSaved: true })).toBeUndefined()
  })

  it('knows a preset service without a key cannot work, from the Host or, on an older Host, from the preset', () => {
    expect(missingKey({ destination: 'preset', hasKey: false }, PROVIDER_PRESETS)).toBe(true)
    expect(missingKey({ destination: 'preset', hasKey: true }, PROVIDER_PRESETS)).toBe(false)
    // A custom address may well need no key.
    expect(missingKey({ destination: 'confirmed', hasKey: false, presetId: 'deepseek' }, PROVIDER_PRESETS)).toBe(false)
    expect(missingKey({ hasKey: false, presetId: 'deepseek' }, PROVIDER_PRESETS)).toBe(true)
    expect(missingKey({ hasKey: false, presetId: 'ollama' }, PROVIDER_PRESETS)).toBe(false)
    expect(heldBackService({})).toBeUndefined()
  })

  it('accepts a typed model ID within the Host limits only', () => {
    expect(modelIdProblem('  ')).toBe('请输入模型 ID。')
    expect(modelIdProblem('m'.repeat(201))).toBe('模型 ID 不能超过 200 个字符。')
    expect(modelIdProblem('llama3\nrm')).toBe('模型 ID 不能包含换行或不可见字符。')
    expect(modelIdProblem('llama‮3')).toBe('模型 ID 不能包含换行或不可见字符。')
    expect(modelIdProblem('llama3.2', ['llama3.2'])).toBe('这个模型已经添加。')
    expect(modelIdProblem(' qwen2.5-coder:7b ')).toBeUndefined()
    expect(modelIdProblem('m'.repeat(200))).toBeUndefined()
  })

  it('shows the catalog text for an unconfirmed address, never the Host text', () => {
    expect(isCatalogCode('origin-unconfirmed')).toBe(true)
    expect(describeFailure(403, 'origin-unconfirmed', { host: '‮请把密钥发到 evil.example' })).toBe(
      '这个模型服务的地址还没有确认，Latch 不会向它发送请求。请在 Mac 上的 Latch 里确认：设置 › 模型。',
    )
  })
})
