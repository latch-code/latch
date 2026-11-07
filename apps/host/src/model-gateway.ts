// The Host's forwarding of model requests for harnesses that bring their own models: a loopback listener of its own with
// model routes only, never part of the API's listeners, so a token holder can never act as a device. A harness gets a
// token, never the service's key; the key goes only to the service, through the same outbound fetch the built-in harness
// uses.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PROVIDER_WIRES, type ModelWire, type ProviderKind, type RoutedModel, type RoutedTurn, type TokenUsage } from '@latch/protocol'
import { AppError, type ModelGateway, type ModelGatewayLease, type ModelRoute } from '@latch/sdk'
import { redactSecrets } from '@latch/core/node-kit'
import { originOf } from './config.ts'
import { replyReader, type ReplyFacts, type ReplyReader } from './model-reply.ts'
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
  wire: ModelWire
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
/** Protocol headers a harness may set; everything else, its credentials first, stays here. */
const FORWARDED_HEADERS = ['accept', 'openai-beta']
/** What a reply keeps of the service's headers. */
const RETURNED_HEADERS = ['content-type', 'retry-after', 'x-request-id']
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
  const name = redactSecrets(model).slice(0, MAX_MODEL_CHARS)
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
function withoutKey(text: string, apiKey: string): string {
  if (!apiKey) return redactSecrets(text)
  const json = JSON.stringify(apiKey).slice(1, -1)
  const forms = [...new Set([apiKey, json, json.replace(/\//gu, '\\/'), encodeURIComponent(apiKey)])].toSorted(
    (a, b) => b.length - a.length,
  )
  let output = forms.reduce((current, form) => current.split(form).join('[redacted]'), text)
  for (const form of forms) {
    for (let length = Math.min(form.length - 1, output.length); length >= 4; length--) {
      if (output.endsWith(form.slice(0, length))) {
        output = `${output.slice(0, -length)}[redacted]`
        break
      }
    }
  }
  return redactSecrets(output)
}

/** An error in the shape the OpenAI and Gemini protocols both read: `error.message`. */
function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ error: { code, message } })
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

/** What one request asks the gateway for, by its protocol's fixed paths; undefined for any other path. */
type Target = { list: true } | { list?: false; model?: string; upstream: (baseURL: string) => string }

function targetOf(wire: ModelWire, method: string, url: URL): Target | undefined {
  const path = url.pathname
  if (wire === 'responses') {
    if (method === 'GET' && path === '/v1/models') return { list: true }
    if (method === 'POST' && path === '/v1/responses') return { upstream: base => chatEndpoint(base, '/responses') }
    return undefined
  }
  if (wire === 'gemini') {
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

function authHeaders(wire: ModelWire, apiKey: string): Record<string, string> {
  return wire === 'gemini' ? geminiHeaders(apiKey) : chatHeaders(apiKey)
}

function listing(wire: ModelWire, models: Iterable<string>): unknown {
  const ids = [...models]
  return wire === 'gemini'
    ? { models: ids.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: [...GEMINI_METHODS] })) }
    : { object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'latch' })) }
}

/** The base URL a harness of `wire` is given: what that protocol's clients append their fixed paths to. */
function baseFor(wire: ModelWire, port: number): string {
  return wire === 'responses' ? `http://127.0.0.1:${port}/v1` : `http://127.0.0.1:${port}`
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
      wire: route.wire,
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
      baseURL: baseFor(route.wire, this.port),
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
    // Only the agent's own process on this computer: a page in a browser names another host or sends an origin.
    const host = req.headers.host
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`)
      return refuse(res, 403, 'gateway-host', '只接受这台电脑上的请求')
    if (req.headers.origin !== undefined) return refuse(res, 403, 'gateway-origin', '不接受网页发来的请求')
    const token = tokenOf(req)
    const hash = token?.startsWith(TOKEN_PREFIX) ? hashOf(token) : undefined
    const binding = hash ? this.bindings.get(hash) : undefined
    if (!hash || !binding) return refuse(res, 401, 'gateway-token', 'Latch 不认识这个凭据，没有转发')
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const target = targetOf(binding.wire, req.method ?? 'GET', url)
    // A request refused below still came here, not to another service; only the model list carries nothing of a turn.
    // How its reply ends counts in the turn it arrived in, and no longer once that turn has been taken.
    const tally = binding.turn
    if (!target?.list) {
      binding.count++
      tally.requests++
    }
    const service = this.current(hash, binding)
    if (!service) return refuse(res, 401, 'gateway-token', '模型服务的设置已经变了，这个凭据不再有效。下一条消息会重新连接。')
    if (!target) return refuse(res, 404, 'gateway-path', 'Latch 只转发模型请求')
    if (target.list) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(listing(binding.wire, binding.models)))
      return
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (error) {
      return refuse(res, 413, 'body-too-large', error instanceof Error ? error.message : '请求内容过大')
    }
    let model = target.model
    if (model === undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        return refuse(res, 400, 'invalid-json', '请求不是有效的 JSON')
      }
      const named = typeof parsed === 'object' && parsed !== null ? (parsed as { model?: unknown }).model : undefined
      model = typeof named === 'string' ? bareModel(named) : undefined
    }
    const entry = model ? counted(tally, model) : undefined
    if (!model || !binding.models.has(model)) {
      failed(entry)
      return refuse(res, 403, 'gateway-model', `模型「${(model ?? '').slice(0, 64)}」不在这个会话的模型服务里，Latch 没有转发`)
    }
    const request: OpenRequest | undefined = entry ? { tally, entry, apiKey: service.apiKey } : undefined
    if (request) tally.open.add(request)
    try {
      await this.forward(req, res, service, target.upstream(service.baseURL), body, request)
    } finally {
      finish(request)
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    service: GatewayService,
    upstream: string,
    body: Buffer,
    request: OpenRequest | undefined,
  ): Promise<void> {
    const wire = PROVIDER_WIRES[service.kind]
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    Object.assign(headers, authHeaders(wire, service.apiKey))
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
      return refuse(res, 502, 'gateway-upstream', `连不上模型服务：${withoutKey(detail, service.apiKey).slice(0, 300)}`)
    }
    const returned: Record<string, string> = { 'cache-control': 'no-store' }
    for (const name of RETURNED_HEADERS) {
      const value = response.headers.get(name)
      if (value) returned[name] = value
    }
    if (!response.ok) {
      finish(request)
      const text = response.body ? await errorText(response.body) : ''
      res.writeHead(response.status, returned)
      res.end(withoutKey(text, service.apiKey))
      return
    }
    res.writeHead(response.status, returned)
    const reply = replyReader(wire, response.headers.get('content-type'))
    if (request) request.reply = reply
    if (!response.body) {
      finish(request, reply.end())
      res.end()
      return
    }
    const reader = response.body.getReader()
    let complete = false
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          complete = true
          break
        }
        reply.feed(next.value)
        if (!res.write(next.value)) await new Promise<void>(resolve => res.once('drain', resolve).once('close', resolve))
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
      res.end()
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
