// The Host's forwarding of model requests for harnesses that bring their own models: a loopback listener of its own with
// model routes only, never part of the API's listeners, so a token holder can never act as a device. A harness gets a
// token, never the service's key; the key goes only to the service, through the same outbound fetch the built-in harness
// uses. A token is bound to two protocols: the one the harness speaks (its entry, which decides the paths it may use and
// the shape of every answer) and the one the service speaks (upstream). Today they are always the same: requests pass
// through as they came, with only the key and the protocol's own headers changed.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  PROVIDER_WIRES,
  type ModelCapabilities,
  type ModelWire,
  type ProviderKind,
  type RoutedModel,
  type RoutedTurn,
  type TokenUsage,
} from '@latch/protocol'
import { AppError, type ModelGateway, type ModelGatewayLease, type ModelRoute } from '@latch/sdk'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { originOf } from './config.ts'
import { replyReader, type ReplyFacts, type ReplyReader } from './model-reply.ts'
import { anthropicEndpoint, anthropicHeaders } from './plugins/providers/anthropic-wire.ts'
import { chatEndpoint, chatHeaders } from './plugins/providers/chat-wire.ts'
import { geminiEndpoint, geminiHeaders } from './plugins/providers/gemini-wire.ts'
import type { FetchLike } from './plugins/providers/http.ts'

/** A saved service as the gateway may use it now: undefined from `service` when sessions may not use it. */
export interface GatewayService {
  kind: ProviderKind
  baseURL: string
  /** '' for a service at a confirmed address that takes none. */
  apiKey: string
  models: string[]
  modelCapabilities?: Record<string, ModelCapabilities>
  /** Changes whenever the protocol, address, key or the service being usable does; a token issued before stops working. */
  fingerprint: string
}

export interface ModelGatewayDeps {
  service(providerId: string): GatewayService | undefined
  /** The service's outbound fetch: only under its base URL, only to a preset or confirmed address, through egress policy. */
  fetchFor(baseURL: string): FetchLike
  log(text: string): void
}

interface Binding {
  sessionId: string
  providerId: string
  /** The protocol the harness speaks to the gateway: the paths it may use and the shape of every answer. */
  entry: ModelWire
  /** The protocol the service speaks. */
  upstream: ModelWire
  models: Set<string>
  fingerprint: string
  count: number
  /** What the requests since the last `takeTurn` did. */
  turn: Tally
  closed: boolean
}

interface Tally {
  requests: number
  models: Map<string, RoutedModel>
  /** Forwarded requests whose result is not counted yet. */
  open: Set<OpenRequest>
}

/** A forwarded request until its result is counted: its reply, once the service answers, is read as it passes. */
interface OpenRequest {
  tally: Tally
  entry: RoutedModel
  apiKey: string
  reply?: ReplyReader
}

/** How many models one turn lists; requests naming yet another are counted in the turn's total only. */
const MAX_TURN_MODELS = 16
const MAX_MODEL_CHARS = 200
const PARTS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/** Codex sends whole conversations, images included, on every request. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const TOKEN_PREFIX = 'lmg1.'
/**
 * Protocol headers a harness may set, by the protocol it speaks; everything else, its credentials first, stays here.
 * Anthropic's version and beta headers mean something only to an Anthropic service, so only a request passed through
 * as it came keeps them.
 */
const FORWARDED_HEADERS: Readonly<Record<ModelWire, readonly string[]>> = {
  'chat-completions': ['accept', 'openai-beta'],
  responses: ['accept', 'openai-beta'],
  'anthropic-messages': ['accept'],
  gemini: ['accept'],
}
const ANTHROPIC_HEADERS = ['anthropic-version', 'anthropic-beta']
/** What a reply keeps of the service's headers. */
const RETURNED_HEADERS = ['content-type', 'retry-after', 'x-request-id', 'request-id']
const GEMINI_METHODS = new Set(['generateContent', 'streamGenerateContent', 'countTokens'])

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
const bareModel = (model: string) => model.replace(/^models\//u, '')
const newTally = (): Tally => ({ requests: 0, models: new Map(), open: new Set() })

/** Adds a reply's tokens; a part stays only while every reply added reported it, so it never claims tokens it does not cover. */
function addUsage(total: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  const sum: TokenUsage = {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
  }
  for (const part of PARTS) {
    const value = usage[part]
    if (value !== undefined && (total === undefined || total[part] !== undefined)) sum[part] = (total?.[part] ?? 0) + value
  }
  return sum
}

/** The turn's entry for `model`, counting one more request; undefined once the turn lists as many models as it may. */
function counted(tally: Tally, model: string): RoutedModel | undefined {
  const name = redactKnownSecrets(model).slice(0, MAX_MODEL_CHARS)
  let entry = tally.models.get(name)
  if (!entry) {
    if (tally.models.size >= MAX_TURN_MODELS) return undefined
    entry = { model: name, requests: 0 }
    tally.models.set(name, entry)
  }
  entry.requests++
  return entry
}

const failed = (entry: RoutedModel | undefined) => {
  if (entry) entry.failed = (entry.failed ?? 0) + 1
}

/** The model a reply names, as the turn keeps it: without the key or other secrets, cut to length. */
const usedModel = (model: string, apiKey: string) => withoutKey(model, apiKey).slice(0, MAX_MODEL_CHARS)

/** Counts a reply that is over: the model it names and the tokens it reports, never its content. */
function settle(entry: RoutedModel, facts: ReplyFacts, apiKey: string): void {
  if (facts.failed) failed(entry)
  if (facts.model) entry.used = usedModel(facts.model, apiKey)
  if (facts.usage) {
    entry.usage = addUsage(entry.usage, facts.usage)
    entry.measured = (entry.measured ?? 0) + 1
  }
}

/** Counts a forwarded request's result once: what its reply said when given, else that it did not complete. */
function finish(request: OpenRequest | undefined, facts?: ReplyFacts): void {
  if (!request?.tally.open.delete(request)) return
  if (facts) settle(request.entry, facts, request.apiKey)
  else failed(request.entry)
}

/** The token a harness sent, in whichever header its protocol puts a key. */
function tokenOf(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && /^Bearer\s+/iu.test(authorization)) return authorization.replace(/^Bearer\s+/iu, '').trim()
  for (const name of ['x-goog-api-key', 'x-api-key']) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) return value.trim()
  }
  return undefined
}

/**
 * A service's error text with its key taken out in every form it may be echoed in, Latch's own secrets too. The text may
 * have been cut short, so a tail that is still the start of the key goes as well.
 */
function keyForms(apiKey: string): string[] {
  if (!apiKey) return []
  const json = JSON.stringify(apiKey).slice(1, -1)
  return [...new Set([apiKey, json, json.replace(/\//gu, '\\/'), encodeURIComponent(apiKey)])].toSorted((a, b) => b.length - a.length)
}

function withoutKey(text: string, apiKey: string): string {
  const forms = keyForms(apiKey)
  let output = forms.reduce((current, form) => current.split(form).join('[redacted]'), text)
  for (const form of forms) {
    for (let length = Math.min(form.length - 1, output.length); length >= 4; length--) {
      if (output.endsWith(form.slice(0, length))) {
        output = `${output.slice(0, -length)}[redacted]`
        break
      }
    }
  }
  return redactKnownSecrets(output)
}

/** A successful JSON or SSE response may carry errors too; keep only a possible key prefix between UTF-8 chunks. */
function replyRedactor(apiKey: string) {
  const decoder = new TextDecoder()
  const forms = keyForms(apiKey)
  let pending = ''
  return {
    feed(chunk: Uint8Array): string {
      pending += decoder.decode(chunk, { stream: true })
      pending = forms.reduce((text, form) => text.split(form).join('[redacted]'), pending)
      let held = 0
      for (const form of forms) {
        for (let size = Math.min(form.length - 1, pending.length); size > held; size--) {
          if (pending.endsWith(form.slice(0, size))) {
            held = size
            break
          }
        }
      }
      const safe = pending.slice(0, pending.length - held)
      pending = pending.slice(pending.length - held)
      return redactKnownSecrets(safe)
    },
    end(): string {
      return withoutKey(pending + decoder.decode(), apiKey)
    },
  }
}

/** Anthropic's error types by status, as its clients read them. */
const ANTHROPIC_ERRORS: Readonly<Record<number, string>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
}

/** Whether a path is one of Anthropic's, so that an answer to it is in Anthropic's shape before its token is read. */
const anthropicPath = (path: string) => path === '/v1/messages' || path.startsWith('/v1/messages/')

/**
 * An error in the shape the harness's protocol reads: Anthropic's `{type: 'error', error: {type, message}}`, else
 * `error.message`, which the OpenAI and Gemini protocols both read.
 */
function refuse(res: ServerResponse, status: number, code: string, message: string, shape: 'anthropic' | 'openai' = 'openai'): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify(
    shape === 'anthropic'
      ? { type: 'error', error: { type: ANTHROPIC_ERRORS[status] ?? 'api_error', message } }
      : { error: { code, message } },
  )
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new AppError(413, 'body-too-large', '请求内容过大，Latch 没有转发')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * What one request asks the gateway for, by the fixed paths of the protocol its token speaks; undefined for any other
 * path. `count`: a token count, forwarded but no model reply to read.
 */
type Target = { list: true } | { list?: false; model?: string; count?: true; upstream: (baseURL: string) => string }

function targetOf(entry: ModelWire, upstream: ModelWire, method: string, url: URL): Target | undefined {
  const path = url.pathname
  if (entry !== 'gemini' && method === 'GET' && path === '/v1/models') return { list: true }
  if (method !== 'POST' && entry !== 'gemini') return undefined
  if (entry === 'responses') return path === '/v1/responses' ? { upstream: base => chatEndpoint(base, '/responses') } : undefined
  if (entry === 'chat-completions')
    return path === '/v1/chat/completions' ? { upstream: base => chatEndpoint(base, '/chat/completions') } : undefined
  if (entry === 'anthropic-messages') {
    if (path === '/v1/messages') return { upstream: base => anthropicEndpoint(base, '/messages') }
    // Only an Anthropic service counts tokens the way Anthropic's clients ask.
    if (path === '/v1/messages/count_tokens' && upstream === 'anthropic-messages')
      return { count: true, upstream: base => anthropicEndpoint(base, '/messages/count_tokens') }
    return undefined
  }
  if (entry === 'gemini') {
    if (method === 'GET' && /^\/v1(?:beta|alpha)?\/models$/u.test(path)) return { list: true }
    const match = /^\/v1(?:beta|alpha)?\/models\/([^/:]+):([A-Za-z]+)$/u.exec(path)
    if (method !== 'POST' || !match || !GEMINI_METHODS.has(match[2]!)) return undefined
    let model: string
    try {
      model = bareModel(decodeURIComponent(match[1]!))
    } catch {
      return undefined
    }
    const alt = url.searchParams.get('alt')
    return {
      model,
      upstream: base => {
        const target = geminiEndpoint(base, `/models/${encodeURIComponent(model)}:${match[2]}`)
        if (alt === 'sse') target.searchParams.set('alt', 'sse')
        return target.toString()
      },
    }
  }
  return undefined
}

/** The service's own headers: its key, and the version header Anthropic requires. */
function authHeaders(wire: ModelWire, apiKey: string): Record<string, string> {
  return wire === 'gemini' ? geminiHeaders(apiKey) : wire === 'anthropic-messages' ? anthropicHeaders(apiKey) : chatHeaders(apiKey)
}

/** The session's models in the shape the harness's protocol lists models. */
function listing(entry: ModelWire, models: Iterable<string>): unknown {
  const ids = [...models]
  if (entry === 'gemini')
    return { models: ids.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: [...GEMINI_METHODS] })) }
  if (entry === 'anthropic-messages')
    return {
      data: ids.map(id => ({ type: 'model', id, display_name: id })),
      has_more: false,
      first_id: ids[0] ?? null,
      last_id: ids.at(-1) ?? null,
    }
  return { object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'latch' })) }
}

/**
 * The base URL a harness of `entry` is given: what that protocol's clients append their fixed paths to. OpenAI's
 * clients append `/responses` or `/chat/completions` to a base that ends in `/v1`; Anthropic's and Gemini's add the
 * version themselves.
 */
function baseFor(entry: ModelWire, port: number): string {
  return entry === 'responses' || entry === 'chat-completions' ? `http://127.0.0.1:${port}/v1` : `http://127.0.0.1:${port}`
}

/**
 * A streamed Chat Completions request asks for usage in its last chunk, as every Chat client of Latch's reads it, so the
 * turn's tokens are known. Undefined: the body goes as it came.
 */
function withUsage(entry: ModelWire, body: Record<string, unknown>): Buffer | undefined {
  if (entry !== 'chat-completions' || body.stream !== true) return undefined
  const options = body.stream_options
  if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) return undefined
  if ((options as Record<string, unknown> | undefined)?.include_usage !== undefined) return undefined
  return Buffer.from(JSON.stringify({ ...body, stream_options: { ...(options as object | undefined), include_usage: true } }))
}

export class ModelGatewayServer implements ModelGateway {
  private readonly bindings = new Map<string, Binding>()
  private server?: Server
  private port?: number

  constructor(private readonly deps: ModelGatewayDeps) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(error => {
        this.deps.log(`模型转发失败：${error instanceof Error ? error.message : String(error)}`)
        refuse(res, 502, 'gateway-error', 'Latch 转发这个请求时出错')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  /** The loopback port it listens on, once started. */
  get listeningPort(): number | undefined {
    return this.port
  }

  async close(): Promise<void> {
    for (const binding of this.bindings.values()) binding.closed = true
    this.bindings.clear()
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  open(input: { sessionId: string; route: ModelRoute }): ModelGatewayLease {
    const { sessionId, route } = input
    if (this.port === undefined) throw new AppError(503, 'model-gateway-unavailable', 'Latch 现在不能转发模型请求')
    const service = this.deps.service(route.providerId)
    if (!service)
      throw new AppError(409, 'model-route-unavailable', '这个会话开始时用的模型服务现在不能用：它被删除或停用了，或地址还没确认。')
    // Passed through as it came: the harness speaks the service's own protocol.
    if (PROVIDER_WIRES[service.kind] !== route.wire || originOf(service.baseURL) !== route.origin)
      throw new AppError(409, 'model-route-changed', '这个会话开始时用的模型服务换了协议或地址，不能再经 Latch 用它。请新开一个会话。')
    const models = new Set(service.models.map(bareModel))
    if (!models.has(bareModel(route.model)))
      throw new AppError(409, 'model-unavailable', `模型服务里已经没有「${route.model}」，这个会话不能再经 Latch 用它。`)
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const hash = hashOf(token)
    const binding: Binding = {
      sessionId,
      providerId: route.providerId,
      entry: route.wire,
      upstream: PROVIDER_WIRES[service.kind],
      models,
      fingerprint: service.fingerprint,
      count: 0,
      turn: newTally(),
      closed: false,
    }
    this.bindings.set(hash, binding)
    const close = () => {
      binding.closed = true
      this.bindings.delete(hash)
    }
    return {
      baseURL: baseFor(binding.entry, this.port),
      token,
      requests: () => binding.count,
      takeTurn: (): RoutedTurn => {
        const { requests, models, open } = binding.turn
        binding.turn = newTally()
        // Copies: a reply still under way settles into the counts just taken, which nobody reads again, never into what
        // the caller keeps.
        const copies = new Map(
          [...models.values()].map(entry => [entry, { ...entry, ...(entry.usage ? { usage: { ...entry.usage } } : {}) }]),
        )
        // A harness may end its turn on a reply's last event while the service has yet to close the stream: a reply that
        // said it is over counts as it will settle. Any other is still under way.
        for (const request of open) {
          const copy = copies.get(request.entry)!
          const facts = request.reply?.facts()
          if (facts?.ended) settle(copy, facts, request.apiKey)
          else {
            copy.open = (copy.open ?? 0) + 1
            if (facts?.model) copy.used = usedModel(facts.model, request.apiKey)
          }
        }
        return { requests, models: [...copies.values()] }
      },
      models: [...models],
      ...(service.modelCapabilities
        ? {
            modelCapabilities: Object.fromEntries(
              service.models.flatMap(model => {
                const capabilities = service.modelCapabilities?.[model]
                return capabilities ? [[bareModel(model), structuredClone(capabilities)]] : []
              }),
            ),
          }
        : {}),
      active: () => this.current(hash, binding) !== undefined,
      close,
    }
  }

  /** The service a binding still may use, or undefined after revoking it: closed, or its service changed or went away. */
  private current(hash: string, binding: Binding): GatewayService | undefined {
    if (binding.closed) return undefined
    const service = this.deps.service(binding.providerId)
    if (service && service.fingerprint === binding.fingerprint) return service
    binding.closed = true
    this.bindings.delete(hash)
    return undefined
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const early = anthropicPath(url.pathname) ? 'anthropic' : 'openai'
    // Only the agent's own process on this computer: a page in a browser names another host, sends an origin, or says
    // where it was fetched from (`Sec-Fetch-*`, which no page can leave out). Node's own fetch sends
    // `Sec-Fetch-Mode: cors` alone, as many harnesses do. That transport marker is allowed, but never authenticates a caller.
    const host = req.headers.host
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`)
      return refuse(res, 403, 'gateway-host', '只接受这台电脑上的请求', early)
    const fetched = Object.keys(req.headers).filter(name => name.startsWith('sec-fetch-'))
    const browser = fetched.some(name => name !== 'sec-fetch-mode') || (fetched.length > 0 && req.headers['sec-fetch-mode'] !== 'cors')
    if (req.headers.origin !== undefined || browser) return refuse(res, 403, 'gateway-origin', '不接受网页发来的请求', early)
    // Any token but Latch's own, another program's login among them, is refused unread: never hashed, logged or sent on.
    const token = tokenOf(req)
    const hash = token?.startsWith(TOKEN_PREFIX) ? hashOf(token) : undefined
    const binding = hash ? this.bindings.get(hash) : undefined
    if (!hash || !binding) return refuse(res, 401, 'gateway-token', 'Latch 不认识这个凭据，没有转发', early)
    const shape = binding.entry === 'anthropic-messages' ? 'anthropic' : 'openai'
    const target = targetOf(binding.entry, binding.upstream, req.method ?? 'GET', url)
    // A request refused below still came here, not to another service; only the model list carries nothing of a turn.
    // How its reply ends counts in the turn it arrived in, and no longer once that turn has been taken.
    const tally = binding.turn
    if (!target?.list) {
      binding.count++
      tally.requests++
    }
    let service = this.current(hash, binding)
    if (!service) return refuse(res, 401, 'gateway-token', '模型服务的设置已经变了，这个凭据不再有效。下一条消息会重新连接。', shape)
    if (!target) return refuse(res, 404, 'gateway-path', 'Latch 只转发模型请求', shape)
    if (target.list) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(listing(binding.entry, binding.models)))
      return
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (error) {
      return refuse(res, 413, 'body-too-large', error instanceof Error ? error.message : '请求内容过大', shape)
    }
    let model = target.model
    if (model === undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        return refuse(res, 400, 'invalid-json', '请求不是有效的 JSON', shape)
      }
      const fields = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
      model = typeof fields.model === 'string' ? bareModel(fields.model) : undefined
      body = withUsage(binding.entry, fields) ?? body
    }
    // A token count is forwarded to the session's service like any request, and has no reply of the model to count.
    const entry = model && !target.count ? counted(tally, model) : undefined
    if (!model || !binding.models.has(model)) {
      failed(entry)
      return refuse(res, 403, 'gateway-model', `模型「${(model ?? '').slice(0, 64)}」不在这个会话的模型服务里，Latch 没有转发`, shape)
    }
    // The body may have arrived over many awaits: a closed process or a changed service must not send its old key.
    service = this.current(hash, binding)
    if (!service) {
      failed(entry)
      return refuse(res, 401, 'gateway-token', '模型服务的设置已经变了，这个凭据不再有效。下一条消息会重新连接。', shape)
    }
    const request: OpenRequest | undefined = entry ? { tally, entry, apiKey: service.apiKey } : undefined
    if (request) tally.open.add(request)
    try {
      await this.forward(req, res, binding, service, target.upstream(service.baseURL), body, request)
    } finally {
      finish(request)
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    binding: Binding,
    service: GatewayService,
    upstream: string,
    body: Buffer,
    request: OpenRequest | undefined,
  ): Promise<void> {
    const wire = binding.upstream
    const shape = binding.entry === 'anthropic-messages' ? 'anthropic' : 'openai'
    const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(wire, service.apiKey) }
    // Named protocol headers only, never a credential: what the harness says of its protocol replaces Latch's default.
    const passed = binding.entry === binding.upstream && wire === 'anthropic-messages'
    for (const name of [...FORWARDED_HEADERS[binding.entry], ...(passed ? ANTHROPIC_HEADERS : [])]) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    // A request the harness gave up on, a cancel among them, stops at the service too.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    let response: Response
    try {
      response = await this.deps.fetchFor(service.baseURL)(upstream, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      finish(request)
      if (controller.signal.aborted) return
      const detail = error instanceof Error ? error.message : String(error)
      return refuse(res, 502, 'gateway-upstream', `连不上模型服务：${withoutKey(detail, service.apiKey).slice(0, 300)}`, shape)
    }
    const returned: Record<string, string> = { 'cache-control': 'no-store' }
    for (const name of RETURNED_HEADERS) {
      const value = response.headers.get(name)
      if (value) returned[name] = withoutKey(value, service.apiKey)
    }
    if (!response.ok) {
      finish(request)
      const text = response.body ? await errorText(response.body) : ''
      res.writeHead(response.status, returned)
      res.end(withoutKey(text, service.apiKey))
      return
    }
    res.writeHead(response.status, returned)
    const reply = replyReader(binding.entry, response.headers.get('content-type'))
    if (request) request.reply = reply
    if (!response.body) {
      finish(request, reply.end())
      res.end()
      return
    }
    const reader = response.body.getReader()
    const redactor = replyRedactor(service.apiKey)
    let complete = false
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          complete = true
          break
        }
        reply.feed(next.value)
        const safe = redactor.feed(next.value)
        if (safe && !res.write(safe)) await new Promise<void>(resolve => res.once('drain', resolve).once('close', resolve))
        if (res.destroyed) break
      }
    } catch {
      // The service or the harness went away mid-stream; neither can be told more.
    } finally {
      // Read before the reply ends, so the turn that waits on it finds it counted. A reply that said it is over counts
      // as such though the stream broke after: the harness may stop reading once it has the last event.
      const facts = reply.end()
      finish(request, complete || facts.ended ? facts : undefined)
      await reader.cancel().catch(() => {})
      res.end(redactor.end())
    }
  }
}

/** An error response's text, at most 64 KiB, before the key is taken out of it. */
async function errorText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (length < MAX_ERROR_BYTES) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
      length += next.value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_ERROR_BYTES)
}
