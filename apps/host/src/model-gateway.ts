// The Host's forwarding of model requests for harnesses that bring their own models: a loopback listener of its own with
// model routes only, never part of the API's listeners, so a token holder can never act as a device. A harness gets a
// token, never the service's key; the key goes only to the service, through the same outbound fetch the built-in harness
// uses. A token is bound to two protocols: the one the harness speaks (its entry, which decides the paths it may use and
// the shape of every answer) and the one the service speaks (upstream). Same-protocol requests pass through; only
// explicitly implemented cross-protocol pairs enter the bounded gateway IR.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  MAX_MODEL_FALLBACKS,
  MODEL_WIRES,
  PROVIDER_WIRES,
  canTranslate,
  type GatewayLoss,
  type ModelFailureClass,
  type ModelCapabilities,
  type ModelWire,
  type ProviderKind,
  type RoutedModel,
  type RoutedTurn,
  type TokenUsage,
  type TurnSpend,
  type UsageOutcome,
} from '@latch/protocol'
import { AppError, type ModelGateway, type ModelGatewayLease, type ModelRoute } from '@latch/sdk'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { originOf } from './config.ts'
import { replyReader, type ReplyFacts, type ReplyReader } from './model-reply.ts'
import { anthropicEndpoint, anthropicHeaders } from './plugins/providers/anthropic-wire.ts'
import { chatEndpoint, chatHeaders } from './plugins/providers/chat-wire.ts'
import type { FetchLike } from './plugins/providers/http.ts'
import { ReasoningSeals } from './model-gateway/reasoning.ts'
import { decodeResponses, ResponsesOutput } from './model-gateway/in/responses.ts'
import { decodeAnthropic, AnthropicOutput } from './model-gateway/in/anthropic.ts'
import { decodeChat, decodeChatReply, encodeChat } from './model-gateway/out/chat.ts'
import { encodeResponses } from './model-gateway/out/responses.ts'
import { decodeResponsesReply, decodeResponsesStream } from './model-gateway/out/responses-reply.ts'
import { encodeAnthropic } from './model-gateway/out/anthropic.ts'
import { decodeAnthropicReply, decodeAnthropicStream } from './model-gateway/out/anthropic-reply.ts'
import type { GatewayRequest, GatewayDelta, GatewayReasoning } from './model-gateway/ir.ts'
import type { ToolNames } from './model-gateway/tools.ts'
import { exactJson } from './model-gateway/json.ts'
import { addSpend, type ModelMeter } from './model-budgets.ts'
import { ModelRequestQueue } from './model-request-queue.ts'
import { ModelScheduler, classifyStatus, retryAfterMs, type AttemptResult, type AttemptTimer } from './model-scheduler.ts'

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
  queue?: ModelRequestQueue
  /** Shared with the built-in harness, so both read one health of each service. */
  scheduler?: ModelScheduler
  /**
   * Called before a request goes to another candidate than the one that failed or is held back: the Host puts it on
   * record, and a throw keeps the request where it is.
   */
  fallback?(event: { sessionId: string; providerId: string; candidate: number; reason: ModelFailureClass }): Promise<void>
  /** Monthly budgets and the usage ledger; without it nothing is refused for a budget and no line is written. */
  meter?: ModelMeter
}

/** One service a request may go to: the session's own first, then what the model falls back to. */
interface Candidate {
  providerId: string
  upstream: ModelWire
  /** The model as this service names it. */
  model: string
  fingerprint: string
  /** Its service changed or went away since the token was issued; only this candidate stops. */
  dead?: true
}

/** A request as one candidate gets it. */
interface Prepared {
  body: Buffer
  translated?: { request: GatewayRequest; tools: ToolNames }
}

/** An answer the gateway writes itself, complete: a refusal, or a service's error with the key taken out. */
interface Reply {
  status: number
  headers: Record<string, string>
  body: string
}

/** A reply that began: the service, its response and what was read of it so far. */
interface Opened {
  candidate: Candidate
  service: GatewayService
  prepared: Prepared
  response: Response
  returned: Record<string, string>
  reader?: ReadableStreamDefaultReader<Uint8Array>
  first?: Uint8Array
}

interface Binding {
  sessionId: string
  providerId: string
  /** The protocol the harness speaks to the gateway: the paths it may use and the shape of every answer. */
  entry: ModelWire
  /** The protocol the service speaks. */
  upstream: ModelWire
  models: Set<string>
  /** By a model of the session's service: what it falls back to, in order. */
  fallbacks: Map<string, Candidate[]>
  fingerprint: string
  count: number
  /** What the requests since the last `takeTurn` did. */
  turn: Tally
  closed: boolean
  thinking?: { model: string; effort: string | null }
}

interface Tally {
  requests: number
  models: Map<string, RoutedModel>
  /** Forwarded requests whose result is not counted yet. */
  open: Set<OpenRequest>
  dropped: Set<GatewayLoss>
  /** By model: the candidate this turn moved to, so the rest of the turn stays with it. */
  moved: Map<string, number>
  /** What the turn's settled requests cost, when known, and a budget of theirs that is nearly or fully used. */
  spend?: TurnSpend
}

/** A forwarded request until its result is counted: its reply, once the service answers, is read as it passes. */
interface OpenRequest {
  tally: Tally
  entry: RoutedModel
  apiKey: string
  reply?: ReplyReader
  /** Called once with the result, for the usage ledger. */
  settled?(facts?: ReplyFacts): void
}

/** What the usage ledger reads of a reply, on its own: the reader while the reply passes, and what it said at its end. */
interface Metered {
  reply?: ReplyReader
  facts?: ReplyFacts
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
}
const ANTHROPIC_HEADERS = ['anthropic-version', 'anthropic-beta']
/** What a reply keeps of the service's headers. */
const RETURNED_HEADERS = ['content-type', 'retry-after', 'x-request-id', 'request-id']

const isModelWire = (wire: unknown): wire is ModelWire => (MODEL_WIRES as readonly unknown[]).includes(wire)
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
const newTally = (): Tally => ({ requests: 0, models: new Map(), open: new Set(), dropped: new Set(), moved: new Map() })

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
  request.settled?.(facts)
}

/** The token a harness sent, in whichever header its protocol puts a key. */
function tokenOf(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && /^Bearer\s+/iu.test(authorization)) return authorization.replace(/^Bearer\s+/iu, '').trim()
  const value = req.headers['x-api-key']
  return typeof value === 'string' && value ? value.trim() : undefined
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

/** Scrub strings before another JSON layer escapes them, especially the JSON string inside function.arguments. */
function safeJson(value: unknown, apiKey: string): string {
  return withoutKey(
    JSON.stringify(value, (_key, field: unknown) => (typeof field === 'string' ? withoutKey(field, apiKey) : field)),
    apiKey,
  )
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

/** A monthly budget is used up: 402 in every protocol, so a harness stops instead of trying again as after a 429. */
const BUDGET_EXCEEDED = 'budget-exceeded'
const BUDGET_MESSAGE = '本月预算已用完'

/**
 * An error in the shape the harness's protocol reads: Anthropic's `{type: 'error', error: {type, message}}`, else
 * `error.message`, which the OpenAI protocols read.
 */
function refusal(status: number, code: string, message: string, shape: 'anthropic' | 'openai' = 'openai'): Reply {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(
      shape === 'anthropic'
        ? {
            type: 'error',
            error: {
              type: code === BUDGET_EXCEEDED ? 'billing_error' : (ANTHROPIC_ERRORS[status] ?? 'api_error'),
              message,
              ...(code === 'gateway-busy' || code === BUDGET_EXCEEDED ? { code } : {}),
            },
          }
        : { error: { code, message } },
    ),
  }
}

function answer(res: ServerResponse, reply: Reply): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(reply.status, reply.headers)
  res.end(reply.body)
}

function refuse(res: ServerResponse, status: number, code: string, message: string, shape: 'anthropic' | 'openai' = 'openai'): void {
  answer(res, refusal(status, code, message, shape))
}

/**
 * What a stream that broke after it began ends with, in the protocol the harness reads: the turn failed, and nothing
 * says otherwise. The blank line first ends whatever event the service left unfinished.
 */
function streamError(entry: ModelWire, message: string): string {
  const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`
  if (entry === 'anthropic-messages') return `\n\n${frame({ type: 'error', error: { type: 'api_error', message } }, 'error')}`
  if (entry === 'responses')
    return `\n\n${frame(
      { type: 'response.failed', response: { object: 'response', status: 'failed', error: { code: 'gateway-upstream', message } } },
      'response.failed',
    )}`
  return `\n\n${frame({ error: { message, type: 'server_error', code: 'gateway-upstream' } })}data: [DONE]\n\n`
}

/**
 * Whether a request leans on what the service itself keeps (an earlier response, a stored conversation): another
 * service knows nothing of it, so such a request never leaves the session's own.
 */
function keepsState(fields: Record<string, unknown>): boolean {
  return (
    (fields.previous_response_id !== undefined && fields.previous_response_id !== null)
    || fields.store === true
    || (fields.conversation !== undefined && fields.conversation !== null)
    || (fields.container !== undefined && fields.container !== null)
  )
}

const CLIENT_TOOL_TYPES = new Set(['function', 'custom', 'namespace'])
/** Anthropic's tools that run in the harness though they carry a type: the service only names them. */
const ANTHROPIC_CLIENT_TOOLS = /^(?:custom|bash_|text_editor_|computer_|memory_)/u

/**
 * Whether the service itself would act on the request (a tool it runs, such as a web search or code execution): sent
 * twice, that could happen twice, so a 5xx is not tried again in place.
 */
function runsOnService(fields: Record<string, unknown>): boolean {
  if (fields.web_search_options !== undefined || fields.mcp_servers !== undefined) return true
  const tools = Array.isArray(fields.tools) ? fields.tools : []
  return tools.some(item => {
    if (typeof item !== 'object' || item === null) return false
    const tool = item as Record<string, unknown>
    if (typeof tool.type === 'string') return !CLIENT_TOOL_TYPES.has(tool.type) && !ANTHROPIC_CLIENT_TOOLS.test(tool.type)
    // A tool without a type that is not a plain function declaration is taken as the service's: never sent twice.
    return Object.keys(tool).some(key => key !== 'function')
  })
}

const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

/**
 * Whether a failed fetch never reached the service: no address, or no connection. Anything else, a connection that was
 * reset or closed among them, may have delivered the request.
 */
function neverConnected(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && NEVER_CONNECTED.has(code)) return true
    // The Host's outbound policy refused the address: nothing was sent.
    if (code === 'egress-denied') return true
  }
  return false
}

/** A body that goes on from what was already read of it. */
function resumed(first: Uint8Array | undefined, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let pending = first
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending)
        pending = undefined
        return
      }
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel: reason => reader.cancel(reason),
  })
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
type Target =
  | { list: true }
  | {
      list?: false
      count?: true
      upstream: (baseURL: string, wire: ModelWire, model: string) => string
    }

/** Where a request of `entry` goes at a service that speaks `wire`. */
function endpointOf(wire: ModelWire, base: string): string {
  return wire === 'anthropic-messages'
    ? anthropicEndpoint(base, '/messages')
    : chatEndpoint(base, wire === 'chat-completions' ? '/chat/completions' : '/responses')
}

function targetOf(entry: ModelWire, upstream: ModelWire, method: string, url: URL): Target | undefined {
  const path = url.pathname
  if (method === 'GET' && path === '/v1/models') return { list: true }
  if (method !== 'POST') return undefined
  if (entry === 'responses') return path === '/v1/responses' ? { upstream: (base, wire) => endpointOf(wire, base) } : undefined
  if (entry === 'chat-completions')
    return path === '/v1/chat/completions' ? { upstream: base => chatEndpoint(base, '/chat/completions') } : undefined
  if (entry === 'anthropic-messages') {
    if (path === '/v1/messages') return { upstream: (base, wire) => endpointOf(wire, base) }
    // Only an Anthropic service counts tokens the way Anthropic's clients ask.
    if (path === '/v1/messages/count_tokens' && upstream === 'anthropic-messages')
      return { count: true, upstream: base => anthropicEndpoint(base, '/messages/count_tokens') }
    return undefined
  }
  return undefined
}

/** The service's own headers: its key, and the version header Anthropic requires. */
function authHeaders(wire: ModelWire, apiKey: string): Record<string, string> {
  switch (wire) {
    case 'anthropic-messages':
      return anthropicHeaders(apiKey)
    case 'chat-completions':
    case 'responses':
      return chatHeaders(apiKey)
    default:
      // A key goes out only in the headers of a protocol named here: never by another protocol's rules.
      throw new AppError(400, 'model-route-unsupported', '这个协议 Latch 不转发')
  }
}

/** The session's models in the shape the harness's protocol lists models. */
function listing(entry: ModelWire, models: Iterable<string>): unknown {
  const ids = [...models]
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
 * clients append `/responses` or `/chat/completions` to a base that ends in `/v1`; Anthropic's add the version
 * themselves.
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
  private readonly reasoning = new ReasoningSeals()
  private server?: Server
  private port?: number
  private readonly queue: ModelRequestQueue
  private readonly scheduler: ModelScheduler

  constructor(private readonly deps: ModelGatewayDeps) {
    this.queue = deps.queue ?? new ModelRequestQueue()
    this.scheduler = deps.scheduler ?? new ModelScheduler({ fingerprint: id => deps.service(id)?.fingerprint })
  }

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
    if (!this.deps.queue) this.queue.close()
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
    // A route saved for a protocol Latch no longer forwards is refused by name: it never reaches another protocol's paths.
    if (!isModelWire(route.wire) || (route.upstream !== undefined && !isModelWire(route.upstream)))
      throw new AppError(409, 'model-route-unsupported', '这个会话开始时用的协议 Latch 不再转发。请新开一个会话。')
    const service = this.deps.service(route.providerId)
    if (!service)
      throw new AppError(409, 'model-route-unavailable', '这个会话开始时用的模型服务现在不能用：它被删除或停用了，或地址还没确认。')
    const upstream = route.upstream ?? route.wire
    if (PROVIDER_WIRES[service.kind] !== upstream || originOf(service.baseURL) !== route.origin)
      throw new AppError(409, 'model-route-changed', '这个会话开始时用的模型服务换了协议或地址，不能再经 Latch 用它。请新开一个会话。')
    if (route.wire !== upstream && !canTranslate(route.wire, upstream))
      throw new AppError(400, 'model-route-unsupported', '这两个协议之间的转换尚未实现')
    const models = new Set(service.models.map(model => model))
    if (!models.has(route.model))
      throw new AppError(409, 'model-unavailable', `模型服务里已经没有「${route.model}」，这个会话不能再经 Latch 用它。`)
    // What a model falls back to, as the session fixed it: a candidate that is gone, off or changed by now is left out
    // of this token, never a reason to refuse the session.
    const fallbacks = new Map<string, Candidate[]>()
    for (const [name, listed] of Object.entries(route.fallbacks ?? {})) {
      const key = name
      if (!models.has(key)) continue
      const usable = listed.slice(0, MAX_MODEL_FALLBACKS).flatMap((item): Candidate[] => {
        const other = this.deps.service(item.providerId)
        if (!other || PROVIDER_WIRES[other.kind] !== item.upstream || originOf(other.baseURL) !== item.origin) return []
        if (item.upstream !== route.wire && !canTranslate(route.wire, item.upstream)) return []
        const model = item.model
        if (item.providerId === route.providerId && model === key) return []
        if (!other.models.some(id => id === model)) return []
        return [{ providerId: item.providerId, upstream: item.upstream, model, fingerprint: other.fingerprint }]
      })
      if (usable.length) fallbacks.set(key, usable)
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const hash = hashOf(token)
    const binding: Binding = {
      sessionId,
      providerId: route.providerId,
      entry: route.wire,
      upstream: PROVIDER_WIRES[service.kind],
      models,
      fallbacks,
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
        const { requests, models, open, dropped, spend } = binding.turn
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
        return {
          requests,
          models: [...copies.values()],
          ...(dropped.size ? { dropped: [...dropped] } : {}),
          ...(spend ? { spend } : {}),
        }
      },
      models: [...models],
      setThinking: (model, effort) => {
        const current = this.current(hash, binding)
        if (!current) throw new AppError(409, 'model-route-changed', '模型服务的设置已经变了，请重新连接。')
        if (binding.entry !== 'responses' || !binding.models.has(model))
          throw new AppError(400, 'model-unavailable', '这个模型不能使用当前的思考设置。')
        if (effort !== null && !current.modelCapabilities?.[model]?.thinking?.includes(effort))
          throw new AppError(400, 'effort-unavailable', '这个模型服务没有声明所请求的思考档位')
        binding.thinking = { model, effort }
      },
      ...(service.modelCapabilities
        ? {
            modelCapabilities: Object.fromEntries(
              service.models.flatMap(model => {
                const capabilities = service.modelCapabilities?.[model]
                return capabilities ? [[model, structuredClone(capabilities)]] : []
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

  /** A fallback's service while it is what the token bound; once it changed or went away, that candidate stays out. */
  private candidateService(candidate: Candidate): GatewayService | undefined {
    if (candidate.dead) return undefined
    const service = this.deps.service(candidate.providerId)
    if (service && service.fingerprint === candidate.fingerprint) return service
    candidate.dead = true
    return undefined
  }

  /**
   * The request as `candidate` gets it: converted when its service speaks another protocol than the harness, and naming
   * the model as that service does. Throws what the harness is told when the request cannot be put that way.
   */
  private prepare(
    binding: Binding,
    candidate: Candidate,
    service: GatewayService,
    asked: { model: string; body: Buffer; fields: Record<string, unknown> },
  ): Prepared {
    const first = candidate.providerId === binding.providerId && candidate.model === asked.model
    if (binding.entry === candidate.upstream) {
      if (first) return { body: asked.body }
      const exact = exactJson(asked.body.toString('utf8')) as Record<string, unknown>
      exact.model = candidate.model
      return { body: Buffer.from(JSON.stringify(exact)) }
    }
    const scope = { providerId: candidate.providerId, model: candidate.model, wire: candidate.upstream }
    const openReasoning = (value: string) => this.reasoning.open(scope, value)
    const converted =
      binding.entry === 'anthropic-messages'
        ? decodeAnthropic(asked.body.toString('utf8'), openReasoning)
        : decodeResponses(asked.fields, openReasoning, asked.body.toString('utf8'))
    converted.model = candidate.model
    const allowed = service.modelCapabilities?.[candidate.model]?.thinking
    if (converted.effort && !allowed?.includes(converted.effort)) {
      if (first) throw new AppError(400, 'effort-unavailable', '这个模型服务没有声明所请求的思考档位')
      // Another model has its own levels: it runs with its default rather than not at all.
      delete converted.effort
    }
    const encoded =
      candidate.upstream === 'responses'
        ? encodeResponses(converted)
        : candidate.upstream === 'anthropic-messages'
          ? encodeAnthropic(converted)
          : encodeChat(converted)
    const body = Buffer.from(JSON.stringify(encoded.body))
    if (body.length > MAX_BODY_BYTES) throw new AppError(413, 'body-too-large', '转换后的请求内容过大，Latch 没有转发')
    return { body, translated: { request: converted, tools: encoded.tools } }
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
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return refuse(res, 400, 'invalid-json', '请求不是有效的 JSON', shape)
    }
    const fields = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    const model = typeof fields.model === 'string' ? fields.model : undefined
    body = withUsage(binding.entry, fields) ?? body
    // A token count is forwarded to the session's service like any request, and has no reply of the model to count.
    const entry = model && !target.count ? counted(tally, model) : undefined
    if (!model || !binding.models.has(model)) {
      failed(entry)
      return refuse(res, 403, 'gateway-model', `模型「${(model ?? '').slice(0, 64)}」不在这个会话的模型服务里，Latch 没有转发`, shape)
    }
    if (binding.thinking?.model === model) {
      const reasoning = fields.reasoning
      const values =
        reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning) ? (reasoning as Record<string, unknown>) : undefined
      const effort = values?.effort
      if (
        (effort !== undefined && typeof effort !== 'string')
        || (binding.thinking.effort !== null && effort !== binding.thinking.effort)
      ) {
        failed(entry)
        return refuse(res, 400, 'gateway-thinking-mismatch', 'Codex 发来的思考档位与当前选择不一致。', shape)
      }
      if (binding.thinking.effort === null && values && effort !== undefined) {
        // This is the Host's explicit default intent. Keep unrelated reasoning fields and exact numeric tokens.
        try {
          const exact = exactJson(body.toString('utf8')) as Record<string, unknown>
          delete (exact.reasoning as Record<string, unknown>).effort
          delete values.effort
          body = Buffer.from(JSON.stringify(exact))
        } catch {
          failed(entry)
          return refuse(res, 400, 'gateway-translation-input', '请求包含无法保留的数值，Latch 没有转发。', shape)
        }
      }
    }
    const asked = { model, body, fields }
    const own: Candidate = { providerId: binding.providerId, upstream: binding.upstream, model, fingerprint: binding.fingerprint }
    // The request's line in the usage ledger, written once when its result is known: names and numbers, nothing it said.
    // A token count is no model request and has none.
    const meter = target.count ? undefined : this.deps.meter
    const { clock } = this.scheduler
    const arrived = clock.now()
    const usage: {
      written: boolean
      attempts: number
      /** How it ended when no reply settled it. */
      ending?: UsageOutcome
      candidate: Candidate
      fallback: boolean
      firstByteMs?: number
      apiKey: string
    } & Metered = { written: false, attempts: 0, candidate: own, fallback: false, apiKey: service.apiKey }
    /** The harness went away before the reply was over. */
    let gaveUp = (): boolean => false
    const writeUsage = (given?: ReplyFacts): void => {
      if (!meter || usage.written) return
      usage.written = true
      // The ledger reads the reply itself, whatever the turn's tally kept of it: a request the turn no longer lists is
      // still counted, and what a reply reported before it broke or was given up on still is.
      const facts = given ?? usage.facts ?? usage.reply?.facts()
      const over = given !== undefined || facts?.ended === true
      const spend = meter.record({
        at: arrived,
        sessionId: binding.sessionId,
        providerId: usage.candidate.providerId,
        model: usage.candidate.model,
        ...(facts?.model ? { used: usedModel(facts.model, usage.apiKey) } : {}),
        outcome: over ? (facts?.failed ? 'stream' : 'ok') : (usage.ending ?? (gaveUp() ? 'aborted' : 'stream')),
        attempts: usage.attempts,
        fallback: usage.fallback,
        ...(usage.firstByteMs !== undefined ? { firstByteMs: usage.firstByteMs } : {}),
        totalMs: clock.now() - arrived,
        ...(facts?.usage ? { usage: facts.usage } : {}),
        ...(facts?.cost !== undefined ? { reportedCost: facts.cost } : {}),
      })
      tally.spend = addSpend(tally.spend, spend)
    }
    // An Agent's budget is that Agent's alone: used up, its request goes nowhere, to no other service either.
    if (meter?.agentOver(binding.sessionId)) {
      failed(entry)
      usage.ending = 'budget'
      writeUsage()
      return refuse(res, 402, BUDGET_EXCEEDED, BUDGET_MESSAGE, shape)
    }
    let prepared: Prepared
    try {
      prepared = this.prepare(binding, own, service, asked)
    } catch (error) {
      failed(entry)
      usage.ending = 'request'
      writeUsage()
      return refuse(
        res,
        400,
        'gateway-translation-input',
        error instanceof AppError ? error.message : '请求不能转换为这个服务的协议',
        shape,
      )
    }
    // The body may have arrived over many awaits: a closed process or a changed service must not send its old key.
    service = this.current(hash, binding)
    if (!service) {
      failed(entry)
      usage.ending = 'unavailable'
      writeUsage()
      return refuse(res, 401, 'gateway-token', '模型服务的设置已经变了，这个凭据不再有效。下一条消息会重新连接。', shape)
    }
    // A token count belongs to the session's own service; a model's reply may come from what it falls back to. So does a
    // request that leans on what the service itself keeps: a stored conversation means nothing to another service.
    const stateful = keepsState(fields)
    const listed = [own, ...(target.count ? [] : (binding.fallbacks.get(model) ?? []))]
    // Each with its place among the session's candidates, which is what the record of a switch names. A candidate whose
    // service changed or went away is left out here, before anything is scheduled: it never reaches the scheduler.
    const candidates = listed
      .map((candidate, place) => ({ candidate, place }))
      .filter(
        ({ candidate, place }) =>
          place === 0 || ((!stateful || candidate.providerId === own.providerId) && this.candidateService(candidate) !== undefined),
      )
    const revoked = (): Reply => refusal(401, 'gateway-token', '模型服务的设置已经变了，这个凭据不再有效。下一条消息会重新连接。', shape)
    const controller = new AbortController()
    const disconnected = () => {
      if (!res.writableFinished) controller.abort()
    }
    res.once('close', disconnected)
    if (res.destroyed) controller.abort()
    const { signal } = controller
    gaveUp = () => signal.aborted
    let request: OpenRequest | undefined
    /** The Host-wide permit of the reply that began; a try that failed gave its own back already. */
    let permit: (() => void) | undefined
    /** A candidate was passed over because its service's monthly budget is used up. */
    let overBudget = false
    try {
      signal.throwIfAborted()
      request = entry ? { tally, entry, apiKey: service.apiKey, settled: writeUsage } : undefined
      if (request) tally.open.add(request)
      const moved = tally.moved.get(model)
      const start = moved === undefined ? -1 : candidates.findIndex(item => item.place === moved)
      const result = await this.scheduler.dispatch<Opened, Reply>({
        sessionId: binding.sessionId,
        candidates: candidates.map(item => item.candidate),
        ...(start > 0 ? { start } : {}),
        signal,
        // An answer that comes whole may rightly take longer than any first-byte limit.
        firstByte: fields.stream === true,
        retryServer: !stateful && !runsOnService(fields),
        attempt: async (index, attemptSignal, timer) => {
          const { candidate } = candidates[index]!
          const usable = () => (index === 0 ? this.current(hash, binding) : this.candidateService(candidate))
          if (!usable()) return index === 0 ? { ok: false, class: 'request', reply: revoked() } : { skip: true }
          // A service's budget is used up like its balance at the service: the request goes to the next candidate, on
          // record first, and nothing is sent here.
          if (meter?.serviceOver(candidate.providerId)) {
            overBudget = true
            return { skip: true, reason: 'budget' }
          }
          let body = prepared
          if (index > 0) {
            try {
              body = this.prepare(binding, candidate, usable()!, asked)
            } catch {
              return { skip: true }
            }
          }
          // The service's own place is held by now; the Host-wide permit comes second, on this path as on the built-in
          // harness's, and waiting for it is not the service's silence.
          const held = await timer.waiting(this.queue.acquire(signal, body.body.length, () => this.scheduler.waiting(binding.sessionId)))
          let kept = false
          try {
            attemptSignal.throwIfAborted()
            // Waiting is not authorization: the process and service must still match when its permit arrives.
            const current = usable()
            if (!current) return index === 0 ? { ok: false, class: 'request', reply: revoked() } : { skip: true }
            usage.attempts++
            usage.candidate = candidate
            usage.fallback = candidates[index]!.place > 0
            usage.apiKey = current.apiKey
            const sent = await this.send(
              req,
              binding,
              candidate,
              current,
              body,
              target.upstream(current.baseURL, candidate.upstream, candidate.model),
              attemptSignal,
              timer,
            )
            // A try that lost to its time limit answers nobody: its permit goes back with it.
            if ('ok' in sent && sent.ok && !attemptSignal.aborted) {
              kept = true
              permit?.()
              permit = held
            }
            return sent
          } finally {
            if (!kept) held()
          }
        },
        timedOut: () => refusal(504, 'gateway-timeout', '模型服务没有在时限内开始回复', shape),
        beforeSwitch: async (from, to, reason) => {
          await this.deps.fallback?.({
            sessionId: binding.sessionId,
            providerId: candidates[from]!.candidate.providerId,
            candidate: candidates[to]!.place,
            reason,
          })
          // A position and a class: never a model, a key or anything of the request.
          this.deps.log(`模型请求改用候选 ${candidates[to]!.place}（${reason}）`)
        },
      })
      if (!result.ok) {
        // A candidate that is only held back opens again by itself: that is a pause to wait out, whatever another
        // candidate's budget says. The month's budget is the answer only when nothing else could have answered.
        const refused = overBudget && result.failure === undefined && !result.changed && result.retryAfterMs === undefined
        usage.ending = result.failure ? result.failure.class : result.changed ? 'unavailable' : refused ? 'budget' : 'circuit-open'
        finish(request)
        writeUsage()
        if (result.failure) return answer(res, result.failure.reply)
        // The session's own service is not what this token was issued for any more: as before, the token is what fails.
        if (result.changed) return answer(res, revoked())
        if (refused) return refuse(res, 402, BUDGET_EXCEEDED, BUDGET_MESSAGE, shape)
        const wait = Math.ceil((result.retryAfterMs ?? 1000) / 1000)
        res.setHeader('retry-after', String(wait))
        return refuse(res, 503, 'gateway-circuit-open', '这个模型服务一直出错，Latch 暂时没有向它发送请求。', shape)
      }
      const opened = result.value
      const { place } = candidates[result.index]!
      usage.candidate = opened.candidate
      usage.fallback = place > 0
      usage.apiKey = opened.service.apiKey
      usage.firstByteMs = clock.now() - arrived
      // The rest of the turn stays where this request was answered; the next turn starts from the first candidate again.
      if (place > 0) tally.moved.set(model, place)
      else tally.moved.delete(model)
      if (request) {
        request.apiKey = opened.service.apiKey
        if (place > 0) {
          request.entry.provider = opened.candidate.providerId
          request.entry.fallback = (request.entry.fallback ?? 0) + 1
        }
      }
      for (const loss of opened.prepared.translated?.request.dropped ?? []) tally.dropped.add(loss)
      let end: 'complete' | 'broken' | 'aborted' = 'broken'
      try {
        end = await this.relay(res, binding, opened, request, signal, usage)
      } finally {
        // With no entry of the turn to settle, how the relay ended is all that is known of the reply.
        usage.ending = signal.aborted || end === 'aborted' ? 'aborted' : end === 'complete' ? 'ok' : 'stream'
        finish(request)
        writeUsage()
        result.done(signal.aborted ? 'aborted' : end)
      }
    } catch (error) {
      usage.ending ??= signal.aborted ? 'aborted' : error instanceof AppError && error.code === 'gateway-busy' ? 'busy' : 'request'
      if (request) finish(request)
      else failed(entry)
      writeUsage()
      if (signal.aborted) return
      if (!(error instanceof AppError)) throw error
      if (error.code === 'gateway-busy') res.setHeader('retry-after', '1')
      refuse(res, error.status, error.code, error.message, shape)
    } finally {
      permit?.()
      res.off('close', disconnected)
    }
  }

  /** One try at one candidate: resolves when its reply's first bytes are here, or with how it failed before that. */
  private async send(
    req: IncomingMessage,
    binding: Binding,
    candidate: Candidate,
    service: GatewayService,
    prepared: Prepared,
    upstream: string,
    signal: AbortSignal,
    timer: AttemptTimer,
  ): Promise<AttemptResult<Opened, Reply>> {
    const wire = candidate.upstream
    const shape = binding.entry === 'anthropic-messages' ? 'anthropic' : 'openai'
    const { translated } = prepared
    const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(wire, service.apiKey) }
    // Named protocol headers only, never a credential: what the harness says of its protocol replaces Latch's default.
    const passed = binding.entry === wire && wire === 'anthropic-messages'
    for (const name of [...(translated ? ['accept'] : FORWARDED_HEADERS[binding.entry]), ...(passed ? ANTHROPIC_HEADERS : [])]) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const unreachable = (error: unknown, unsent = false): AttemptResult<Opened, Reply> => {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        class: 'network',
        ...(unsent ? { unsent: true as const } : {}),
        reply: refusal(502, 'gateway-upstream', `连不上模型服务：${withoutKey(detail, service.apiKey).slice(0, 300)}`, shape),
      }
    }
    let response: Response
    try {
      response = await this.deps.fetchFor(service.baseURL)(upstream, {
        method: 'POST',
        headers,
        body: new Uint8Array(prepared.body),
        redirect: 'error',
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      return unreachable(error, neverConnected(error))
    }
    const returned: Record<string, string> = { 'cache-control': 'no-store' }
    for (const name of RETURNED_HEADERS) {
      const value = response.headers.get(name)
      if (value) returned[name] = withoutKey(value, service.apiKey)
    }
    if (!response.ok) {
      const text = response.body ? await errorText(response.body) : ''
      const safe = withoutKey(text, service.apiKey)
      const failure = {
        ok: false as const,
        class: classifyStatus(response.status, safe) as Exclude<ModelFailureClass, 'unavailable' | 'circuit-open'>,
        ...(retryAfterMs(response.headers.get('retry-after'), this.scheduler.clock.now()) !== undefined
          ? { retryAfterMs: retryAfterMs(response.headers.get('retry-after'), this.scheduler.clock.now())! }
          : {}),
      }
      if (!translated) return { ...failure, reply: { status: response.status, headers: returned, body: safe } }
      const status = response.status >= 500 ? 503 : response.status
      const code = /context_length_exceeded|maximum context|context window|prompt is too long/iu.test(safe)
        ? 'context_length_exceeded'
        : status === 429
          ? 'rate_limit_exceeded'
          : status === 503
            ? 'server_is_overloaded'
            : 'gateway-upstream'
      return {
        ...failure,
        reply: {
          status,
          headers: { ...returned, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            ...(shape === 'anthropic' ? { type: 'error' } : {}),
            error: {
              type:
                shape === 'anthropic'
                  ? status === 503
                    ? 'overloaded_error'
                    : (ANTHROPIC_ERRORS[status] ?? 'api_error')
                  : status < 500
                    ? 'invalid_request_error'
                    : 'server_error',
              code,
              message: safe.slice(0, 1000) || '模型服务拒绝了请求',
            },
          }),
        },
      }
    }
    const opened: Opened = { candidate, service, prepared, response, returned }
    // The service answered: a model may think for a long while before its first event, and that is not its silence.
    timer.began()
    if (!response.body) return { ok: true, value: opened }
    // Until the first bytes are here nothing was given to the harness, so a service that accepts and then drops the
    // connection is still one the request may leave. No time limit applies any more.
    const reader = response.body.getReader()
    try {
      const next = await reader.read()
      return { ok: true, value: { ...opened, reader, ...(next.done ? {} : { first: next.value }) } }
    } catch (error) {
      await reader.cancel().catch(() => {})
      if (signal.aborted) throw error
      return unreachable(error)
    }
  }

  /** Gives a reply that began to the harness, as it came or converted, and says how it ended. */
  private async relay(
    res: ServerResponse,
    binding: Binding,
    opened: Opened,
    request: OpenRequest | undefined,
    signal: AbortSignal,
    metered: Metered,
  ): Promise<'complete' | 'broken' | 'aborted'> {
    const { candidate, service, response, returned, reader } = opened
    const gone = () => signal.aborted || res.destroyed
    if (opened.prepared.translated)
      return this.translateReply(
        response,
        reader ? resumed(opened.first, reader) : undefined,
        res,
        binding,
        candidate,
        service,
        request,
        opened.prepared.translated,
        returned,
        signal,
        metered,
      )
    res.writeHead(response.status, returned)
    const reply = replyReader(binding.entry, response.headers.get('content-type'))
    if (request) request.reply = reply
    metered.reply = reply
    if (!reader) {
      finish(request, (metered.facts = reply.end()))
      res.end()
      return 'complete'
    }
    const redactor = replyRedactor(service.apiKey)
    let complete = false
    let ended = false
    try {
      let chunk = opened.first
      for (;;) {
        if (!chunk) {
          const next = await reader.read()
          if (next.done) {
            complete = true
            break
          }
          chunk = next.value
        }
        reply.feed(chunk)
        const safe = redactor.feed(chunk)
        chunk = undefined
        if (safe && !res.write(safe)) await new Promise<void>(resolve => res.once('drain', resolve).once('close', resolve))
        if (res.destroyed) break
      }
    } catch {
      // The service or the harness went away mid-stream; what the harness is told follows.
    } finally {
      // Read before the reply ends, so the turn that waits on it finds it counted. A reply that said it is over counts
      // as such though the stream broke after: the harness may stop reading once it has the last event.
      const facts = (metered.facts = reply.end())
      ended = complete || facts.ended === true
      finish(request, ended ? facts : undefined)
      await reader.cancel().catch(() => {})
      const tail = redactor.end()
      // Never a silent end: a stream that broke says so in the harness's own protocol, and nothing is sent again.
      const broke = !ended && !gone() && response.headers.get('content-type')?.includes('text/event-stream')
      res.end(broke ? `${tail}${streamError(binding.entry, '模型服务的回复中断了，这一轮没有完成。')}` : tail)
    }
    return ended ? 'complete' : gone() ? 'aborted' : 'broken'
  }

  private async translateReply(
    response: Response,
    source: ReadableStream<Uint8Array> | undefined,
    res: ServerResponse,
    binding: Binding,
    candidate: Candidate,
    service: GatewayService,
    request: OpenRequest | undefined,
    translated: { request: GatewayRequest; tools: ToolNames },
    returned: Record<string, string>,
    signal: AbortSignal,
    metered: Metered,
  ): Promise<'complete' | 'broken' | 'aborted'> {
    const { request: input, tools } = translated
    const safe = (text: string) => withoutKey(text, service.apiKey)
    const scope = { providerId: candidate.providerId, model: input.model, wire: candidate.upstream }
    const seal = (state: GatewayReasoning) => this.reasoning.seal(scope, state, safe)
    const output =
      binding.entry === 'anthropic-messages' ? new AnthropicOutput(input, tools, seal, safe) : new ResponsesOutput(input, tools, seal, safe)
    const reply = replyReader(candidate.upstream, response.headers.get('content-type'))
    if (request) request.reply = reply
    metered.reply = reply
    const write = async (events: Array<Record<string, unknown> & { type: string }>) => {
      for (const event of events) {
        if (res.destroyed || signal.aborted) return
        if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'message_stop')
          finish(request, reply.facts())
        const frame = `event: ${event.type}\ndata: ${safeJson(event, service.apiKey)}\n\n`
        if (!res.write(frame)) await new Promise<void>(resolve => res.once('drain', resolve).once('close', resolve))
      }
    }
    try {
      if (!source) throw new AppError(502, 'gateway-upstream', '模型服务没有回复正文')
      const body = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            reply.feed(chunk)
            controller.enqueue(chunk)
          },
        }),
      )
      if (input.stream) {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          await body.cancel()
          throw new AppError(502, 'gateway-upstream', '模型服务没有返回事件流')
        }
        res.writeHead(200, { ...returned, 'content-type': 'text/event-stream; charset=utf-8' })
        await write(output.start())
        // Decode before redaction so a key split across two logical deltas cannot evade the rolling scrubber.
        const scrubbers = { text: replyRedactor(service.apiKey), reasoning: replyRedactor(service.apiKey) }
        const encoder = new TextEncoder()
        const deltas =
          candidate.upstream === 'responses'
            ? decodeResponsesStream(body, signal)
            : candidate.upstream === 'anthropic-messages'
              ? decodeAnthropicStream(body, signal)
              : decodeChat(body, signal)
        for await (const delta of deltas) {
          if (delta.type === 'loss') {
            request?.tally.dropped.add(delta.loss)
            continue
          }
          if (delta.type === 'text' || delta.type === 'reasoning') {
            const text = scrubbers[delta.type].feed(encoder.encode(delta.text))
            if (text) await write(output.push({ ...delta, text }))
          } else {
            if (delta.type === 'reasoning-state' || delta.type === 'text-end') {
              const text = scrubbers.text.end()
              if (text) await write(output.push({ type: 'text', text }))
              scrubbers.text = replyRedactor(service.apiKey)
            }
            if (delta.type === 'finish')
              for (const type of ['text', 'reasoning'] as const) {
                const text = scrubbers[type].end()
                if (text) await write(output.push({ type, text }))
              }
            await write(output.push(delta))
          }
        }
        await write(output.finish())
        finish(request, (metered.facts = reply.end()))
        res.end()
      } else {
        const reader = body.getReader()
        let text = ''
        const decoder = new TextDecoder('utf-8', { fatal: true })
        try {
          for (;;) {
            signal.throwIfAborted()
            const next = await reader.read()
            if (next.done) break
            text += decoder.decode(next.value, { stream: true })
            if (text.length > 8 * 1024 * 1024) throw new AppError(502, 'gateway-upstream', '模型回复过大')
          }
          text += decoder.decode()
        } finally {
          await reader.cancel().catch(() => {})
        }
        const deltas: GatewayDelta[] =
          candidate.upstream === 'responses'
            ? decodeResponsesReply(JSON.parse(text))
            : candidate.upstream === 'anthropic-messages'
              ? decodeAnthropicReply(text)
              : decodeChatReply(JSON.parse(text))
        for (const delta of deltas) {
          if (delta.type === 'loss') request?.tally.dropped.add(delta.loss)
          else output.push(delta)
        }
        output.finish()
        finish(request, (metered.facts = reply.end()))
        res.writeHead(200, { ...returned, 'content-type': 'application/json; charset=utf-8' })
        res.end(safeJson(output.result(), service.apiKey))
      }
      return 'complete'
    } catch (error) {
      metered.facts = reply.facts()
      finish(request)
      if (res.destroyed || signal.aborted) return 'aborted'
      const message = error instanceof AppError ? safe(error.message) : '模型回复未完整转换，本轮没有确认完成'
      if (res.headersSent) {
        await write(output.fail(message, error instanceof AppError ? error.code : 'gateway-upstream'))
        res.end()
      } else
        refuse(
          res,
          error instanceof AppError ? error.status : 502,
          error instanceof AppError ? error.code : 'gateway-translation-output',
          message,
          binding.entry === 'anthropic-messages' ? 'anthropic' : 'openai',
        )
      return 'broken'
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
