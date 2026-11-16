import { escapeSecurityText, type HostCatalog, type ProviderKind, type ProviderPreset, type ProviderSettings } from '@latch/protocol'
import { api, ApiError, ApiTimeoutError, errorMessage } from './api.ts'
import { confirmationStore, withConfirmation, type ConfirmationPresenter } from './confirmations.ts'
import { computerName, PROVIDER_COPY, safeTarget } from './securityCopy.ts'

/**
 * Adding and checking a model service, without layout: the settings page and the composer's in-place 「添加模型服务」
 * panel share these requests and words. Display only; the Host decides every rule again (which address needs a
 * confirmation, who may type a key) and refuses what this page offers by mistake.
 */

/**
 * `GET /link/api/providers`. `confirmedAddresses`: origins with their path, each confirmed once on the Host computer;
 * `runOrigins`: origins the Host was started with, every path counting as confirmed. Hosts before confirmed addresses
 * send neither.
 */
/**
 * The words of the one add-service form, the same in each frame it opens in (the settings dialog, the in-place panel of
 * the new-session card and of the composer's model menu): its title, the last choice of the service grid, the field
 * labels and the save words.
 */
export const SERVICE_FORM = {
  title: '添加模型服务',
  custom: '自定义地址…',
  /** The custom choice once picked: the preset's own name (「自定义服务」) stays the editable name. */
  customTitle: '自定义地址',
  address: '地址',
  key: '密钥',
  needAddress: '请先填写地址。',
  needNameAndAddress: '请填写名称和地址。',
  needKey: '这个模型服务需要密钥。',
} as const

/** The grid's order: the presets as the Host lists them, the custom address always last. */
export function servicesToPick(presets: readonly ProviderPreset[]): ProviderPreset[] {
  const isCustom = (preset: ProviderPreset) => preset.id === 'custom' || !preset.baseURL
  return [...presets.filter(preset => !isCustom(preset)), ...presets.filter(isCustom).slice(0, 1)]
}

export interface ProvidersResponse {
  providers: ProviderSettings[]
  presets: ProviderPreset[]
  confirmedAddresses?: string[]
  runOrigins?: string[]
}

/** `scheme://host:port` with the port always written, as the Host compares origins; undefined for anything else. */
export function originOf(baseURL: string): string | undefined {
  try {
    const url = new URL(baseURL.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return undefined
  }
}

/**
 * Where a key saved for `baseURL` may go: the origin, then the path without trailing slashes. Hosts before path
 * binding (`withPath` false) bind the origin only.
 */
export function keyScopeOf(baseURL: string, withPath = true): string | undefined {
  const origin = originOf(baseURL)
  if (origin === undefined || !withPath) return origin
  return `${origin}${new URL(baseURL.trim()).pathname.replace(/\/+$/u, '')}`
}

/**
 * An origin with its path (`https://api.deepseek.com:443/v1`) as a person reads it: the port only when it is not the
 * scheme's own (`https://api.deepseek.com/v1`, `http://127.0.0.1:11434/v1`). Anything else comes back unchanged.
 */
export function shownAddress(address: string): string {
  const origin = originOf(address)
  if (origin === undefined || !address.startsWith(origin)) return address
  const url = new URL(address)
  return `${url.protocol}//${url.host}${address.slice(origin.length)}`
}

/** The HTTPS origins of the presets that need a key: a key there is saved without a confirmation. */
export function presetKeyOrigins(presets: readonly ProviderPreset[]): Set<string> {
  return new Set(
    presets
      .filter(preset => preset.requiresKey && preset.baseURL.startsWith('https://'))
      .flatMap(preset => {
        const origin = originOf(preset.baseURL)
        return origin === undefined ? [] : [origin]
      }),
  )
}

/**
 * Whether saving at `baseURL` will ask for a confirmation: 'preset' and 'confirmed' do not, 'unconfirmed' does (on the
 * desktop) or stays unused until someone confirms it. 'unknown': an older Host that does not say, or no valid address.
 */
export type Destination = 'preset' | 'confirmed' | 'unconfirmed' | 'unknown'

export function destinationOf(
  baseURL: string,
  data: Pick<ProvidersResponse, 'presets' | 'confirmedAddresses' | 'runOrigins'>,
): Destination {
  const origin = originOf(baseURL)
  if (origin === undefined) return 'unknown'
  if (presetKeyOrigins(data.presets).has(origin)) return 'preset'
  if (data.confirmedAddresses === undefined) return 'unknown'
  if (data.runOrigins?.includes(origin)) return 'confirmed'
  // A confirmation covers exactly one origin and path: a gateway tells its tenants apart by the path.
  return data.confirmedAddresses.includes(keyScopeOf(baseURL) ?? '') ? 'confirmed' : 'unconfirmed'
}

/**
 * Why a session has no model although a service is configured: the first one the Host holds back, named, with what it
 * lacks and where that is done. Undefined when the Host holds none back (or is too old to say).
 */
export function heldBackService(
  catalog: Pick<HostCatalog, 'unusableProviders'>,
  hostName?: string,
): { message: string; hint: string } | undefined {
  const first = catalog.unusableProviders?.[0]
  if (!first) return undefined
  const name = `「${escapeSecurityText(first.name)}」`
  const where = `在 ${computerName(hostName)} 的 设置 › 模型 里`
  if (first.reason === 'unsupported') return { message: `${name}用的协议不再支持。`, hint: `${where}换一个模型服务` }
  return first.reason === 'key-missing'
    ? { message: `${name}还没有填写密钥。`, hint: `${where}填写密钥` }
    : { message: `${name}的地址还没有确认。`, hint: `${where}确认地址` }
}

/** A saved service's destination; older Hosts do not report it and enforce their own rules. */
export const isUnconfirmed = (provider: Pick<ProviderSettings, 'destination'>) => provider.destination === 'unconfirmed'

/**
 * A saved service that cannot work until a key is typed on the Host computer: it is at a preset provider's address,
 * where every request needs a key, and has none (the Host does not offer it). Older Hosts do not report the address's
 * kind; there the preset says whether it needs a key.
 */
export function missingKey(
  provider: Pick<ProviderSettings, 'destination' | 'hasKey' | 'presetId'>,
  presets: readonly ProviderPreset[],
): boolean {
  if (provider.hasKey) return false
  if (provider.destination !== undefined) return provider.destination === 'preset'
  return presets.find(preset => preset.id === provider.presetId)?.requiresKey ?? false
}

/**
 * Why a check or a model listing did not work, in one sentence, and what kind of way forward fits: a local address is
 * not an error (it is confirmed with the save); a key that is wrong; a Host that cannot reach the address; a service
 * that answered without a usable model list (`listing`: many gateways have none, and chat may still work); an address
 * that needs fixing; the rest.
 */
export type ProbeFailure =
  | { kind: 'local'; target: string; text: string }
  | { kind: 'key' | 'address' | 'network' | 'listing' | 'other'; text: string }

/** A failure that says the service itself is not reachable or not accepted: a key or the connection. */
export const isConnectionFailure = (failure: ProbeFailure): boolean => failure.kind === 'key' || failure.kind === 'network'

/**
 * What a saved service's failed check offers beside its reason: a new key where keys are typed (a key the service
 * refused), removing a service that was just saved and cannot be reached or accepted, or nothing. A service without a
 * model list is not a failed connection, so it never suggests removing the service.
 */
export function checkAction(
  failure: ProbeFailure | null,
  options: { keyEditable: boolean; justSaved: boolean },
): 'key' | 'remove' | undefined {
  if (failure === null || !isConnectionFailure(failure)) return undefined
  if (failure.kind === 'key' && options.keyEditable) return 'key'
  return options.justSaved ? 'remove' : undefined
}

/** What a service's row says after a listing: `unknown` is a listing that cannot tell, and the row stays quiet. */
export type ServiceHealth = 'checking' | 'ok' | 'key' | 'unreachable' | 'local' | 'unknown'

export const serviceHealth = (failure: ProbeFailure | null): ServiceHealth => {
  if (failure === null) return 'ok'
  return failure.kind === 'key' ? 'key' : failure.kind === 'network' ? 'unreachable' : failure.kind === 'local' ? 'local' : 'unknown'
}

/**
 * Keeps the latest question per key. `ask` returns whether that question is still the latest, so a slow answer from before
 * a key was updated cannot overwrite the answer that came after it.
 */
export function latestQuestions() {
  const latest = new Map<string, number>()
  return {
    ask(key: string): () => boolean {
      const asked = (latest.get(key) ?? 0) + 1
      latest.set(key, asked)
      return () => latest.get(key) === asked
    },
  }
}

const NETWORK_TEXT: Record<string, string> = {
  ECONNREFUSED: 'Latch 连不上这个地址：那里没有服务在监听。确认服务已经启动、端口正确。',
  ECONNRESET: 'Latch 连上了这个地址，但连接被对方断开。检查地址和协议（http 或 https）是否正确。',
  ENOTFOUND: 'Latch 找不到这个地址。检查地址的拼写和网络。',
  EAI_AGAIN: 'Latch 暂时解析不了这个地址。检查网络后重试。',
  ETIMEDOUT: 'Latch 连不上这个地址：等待超时。',
  EHOSTUNREACH: 'Latch 连不上这个地址：网络不可达。',
  ENETUNREACH: 'Latch 连不上这个地址：网络不可达。',
}
const CERTIFICATE = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_)/u

/** One sentence for a failed check or listing, chosen by the Host's code; the Host's own text only as a last resort. */
export function describeProbeFailure(error: unknown): ProbeFailure {
  if (error instanceof ApiTimeoutError) return { kind: 'network', text: 'Latch 没有及时回答。它可能仍在等待这个地址，请稍后重新检测。' }
  if (!(error instanceof ApiError)) return { kind: 'other', text: errorMessage(error) }
  const { code, details } = error
  switch (code) {
    case 'egress-denied': {
      const target = safeTarget(details.target)
      return target === undefined
        ? { kind: 'other', text: error.message }
        : { kind: 'local', target, text: PROVIDER_COPY.localAddress(target) }
    }
    case 'http-error': {
      const status = typeof details.upstreamStatus === 'number' ? details.upstreamStatus : undefined
      if (status === 401) return { kind: 'key', text: '密钥不对或已过期。检查密钥后重新检测。' }
      // A key restricted to chat can get 403 on the listing alone, so this does not say the key is bad.
      if (status === 403)
        return { kind: 'listing', text: '服务拒绝列出模型（HTTP 403）。可能是密钥不对，也可能是它没有列表权限；可以手动添加模型 ID。' }
      if (status === 404)
        return { kind: 'listing', text: '这个地址没有模型列表。检查地址是否完整（常见的以 /v1 结尾），也可以手动添加模型 ID。' }
      if (status === 429) return { kind: 'other', text: '服务拒绝了请求：太频繁，或账户额度不足。' }
      return { kind: 'listing', text: status === undefined ? '模型服务返回了错误。' : `模型服务返回了错误（HTTP ${status}）。` }
    }
    case 'network-error': {
      const network = typeof details.networkCode === 'string' ? details.networkCode : ''
      if (CERTIFICATE.test(network)) return { kind: 'network', text: 'Latch 不信任这个地址的 HTTPS 证书。' }
      return { kind: 'network', text: NETWORK_TEXT[network] ?? 'Latch 连不上这个地址。检查地址和网络。' }
    }
    case 'timeout':
      return { kind: 'network', text: 'Latch 连不上这个地址：10 秒内没有响应。' }
    case 'redirect':
      return { kind: 'address', text: '服务返回了重定向。请填写最终的地址。' }
    case 'invalid-response':
    case 'response-too-large':
    case 'empty-response':
      return { kind: 'listing', text: '这个地址返回的不是模型列表。检查地址是否正确。' }
    case 'invalid-url':
      return { kind: 'address', text: '地址要以 http:// 或 https:// 开头，不能带用户名、密码、? 或 #。' }
    case 'invalid-key':
      return { kind: 'key', text: '密钥里有换行或不可见字符。重新粘贴密钥。' }
    case 'key-origin-mismatch':
      return { kind: 'key', text: '已保存的密钥只发往原来的地址。请重新输入密钥。' }
    default:
      return { kind: 'other', text: error.message }
  }
}

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/u

/** Why a typed model ID cannot be added (the Host's limits: printable, at most 200 characters), or undefined. */
export function modelIdProblem(value: string, existing: readonly string[] = []): string | undefined {
  const id = value.trim()
  if (!id) return '请输入模型 ID。'
  if (id.length > 200) return '模型 ID 不能超过 200 个字符。'
  if (UNPRINTABLE.test(id)) return '模型 ID 不能包含换行或不可见字符。'
  if (existing.includes(id)) return '这个模型已经添加。'
  return undefined
}

export interface ProbeInput {
  kind: ProviderKind
  baseURL: string
  /** A key typed in the form; never one that is saved (the Host uses that one through `providerId`). */
  apiKey?: string
  providerId?: string
}

export interface CheckResult {
  ok: true
  models: string[]
  latencyMs: number
}

/** Lists the models at a typed address (the connection check): spends no tokens. */
export function checkAddress(input: ProbeInput): Promise<CheckResult> {
  return api<CheckResult>('provider-checks', {
    method: 'POST',
    timeoutMs: 20_000,
    body: {
      kind: input.kind,
      baseURL: input.baseURL.trim(),
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
    },
  })
}

/** Lists a saved service's models with its saved key. */
export function listModels(providerId: string): Promise<{ models: string[] }> {
  return api<{ models: string[] }>(`providers/${encodeURIComponent(providerId)}/models`, { method: 'POST', body: {}, timeoutMs: 20_000 })
}

/**
 * One confirmation flow, plus whether it is waiting for the person, so the button that started it can read
 * 「等待 Touch ID…」 in place until the Host's answer comes back.
 */
export function trackedPresenter(onWaiting: (waiting: boolean) => void): ConfirmationPresenter {
  const flow = confirmationStore.begin()
  return {
    show: (view, actions) => {
      flow.show(view, actions)
      onWaiting(view.phase === 'waiting')
    },
    close: () => {
      flow.close()
      onWaiting(false)
    },
  }
}

export interface ConfirmOptions {
  /** Where the confirmation's states show; the active inline card unless the caller provides a presenter. */
  presenter?: ConfirmationPresenter
}

/**
 * Confirms an address before a service is saved there, so its models can be listed first (desktop only). The same
 * single confirmation as at save: the address and the outbound allowance it needs.
 */
export function confirmAddress(
  baseURL: string,
  options: ConfirmOptions = {},
): Promise<{ origin: string; address?: string; egress?: string }> {
  return withConfirmation(
    confirmation =>
      api<{ origin: string; address?: string; egress?: string }>('provider-origins', {
        method: 'POST',
        body: { baseURL: baseURL.trim() },
        ...(confirmation ? { confirmation } : {}),
      }),
    options.presenter ? { presenter: options.presenter } : {},
  )
}

export interface NewProvider {
  name: string
  kind: ProviderKind
  presetId?: string
  baseURL: string
  apiKey?: string
  models: string[]
  defaultModel: string
  /** Desktop with local confirmation: confirm the address in the same request when it needs it. */
  confirmOrigin?: boolean
  addition?: { id: string; requestId: string }
}

/** Saves a new service; a confirmation, when the Host asks for one, resends the identical body. */
export async function createProvider(input: NewProvider, options: ConfirmOptions = {}): Promise<ProviderSettings> {
  const body = {
    ...input.addition,
    name: input.name.trim(),
    kind: input.kind,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    baseURL: input.baseURL.trim(),
    models: input.models,
    defaultModel: input.models.includes(input.defaultModel) ? input.defaultModel : input.models[0],
    enabled: true,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.confirmOrigin ? { confirmOrigin: true } : {}),
  }
  const result = await withConfirmation(
    confirmation => api<{ provider: ProviderSettings }>('providers', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
    options.presenter ? { presenter: options.presenter } : {},
  )
  return result.provider
}

export const changesProviderTarget = (body: Record<string, unknown>) =>
  body.baseURL !== undefined || body.kind !== undefined || !!body.apiKey || body.confirmOrigin === true

/** The same body, including the displayed target, is used for every attempt at confirming this edit. */
export async function updateProvider(
  provider: Pick<ProviderSettings, 'id' | 'baseURL' | 'kind'>,
  body: Record<string, unknown>,
  options: ConfirmOptions = {},
): Promise<ProviderSettings> {
  const { id, baseURL, kind } = provider
  const input = changesProviderTarget(body) ? { ...body, expectedTarget: { baseURL, kind } } : body
  const result = await withConfirmation(
    confirmation =>
      api<{ provider: ProviderSettings }>(`providers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: input,
        ...(confirmation ? { confirmation } : {}),
      }),
    options.presenter ? { presenter: options.presenter } : {},
  )
  return result.provider
}
