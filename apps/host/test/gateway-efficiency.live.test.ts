import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { AgentPreset, CancelReceipt, ModelWire, ProviderKind, ProviderSettings, TaskDetail, TokenUsage } from '@latch/protocol'
import { ModelGatewayServer } from '../src/model-gateway.ts'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'
import {
  cacheable,
  commonPrefix,
  endsWithToolResult,
  lastUserText,
  offeredTools,
  startRecordingUpstream,
  userText,
  type RecordingUpstream,
  type UpstreamReply,
  type UpstreamRequest,
} from './helpers/recording-upstream.ts'

/**
 * What the gateway adds to a real harness's session, measured against a local recording service: whether consecutive
 * requests keep a stable cacheable prefix, which cache hints reach the service, whether every token count the service
 * reports reaches the harness and the turn unchanged, how much time the gateway adds before the request leaves and
 * before each piece of the reply reaches the harness, the context window the harness believes, and how failures and a
 * cancel end. Opt-in, with the same switches as the other gateway live tests; every model request goes to the local
 * service, and each harness runs under temporary HOME and config directories. `LATCH_GATEWAY_EVIDENCE_DIR` collects the
 * numbers as JSON, never request bodies beyond short snippets around a change.
 */

const WIRE: Record<ProviderKind, ModelWire> = {
  'openai-compatible': 'chat-completions',
  'openai-responses': 'responses',
  anthropic: 'anthropic-messages',
} as Record<ProviderKind, ModelWire>

interface HarnessSetup {
  binary: string | undefined
  preset: string
  /** The program name the Host looks up for this preset. */
  program: string
  agent: { command: (binary: string) => string; args: string[] }
  homes: string[]
  config: Array<{ configId: string; value: string }>
}

const HOMES = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']
const HARNESSES: Record<string, HarnessSetup> = {
  codex: {
    binary: process.env.LATCH_CODEX_GATEWAY_BINARY,
    preset: 'codex',
    program: 'codex',
    agent: { command: binary => binary, args: [] },
    homes: [...HOMES, 'CODEX_HOME'],
    config: [{ configId: '~mode', value: 'agent-full-access' }],
  },
  claude: {
    binary: process.env.LATCH_CLAUDE_GATEWAY_BINARY,
    preset: 'claude-agent',
    program: 'claude-agent-acp',
    agent: { command: binary => binary, args: ['--hide-claude-auth'] },
    homes: [...HOMES, 'CLAUDE_CONFIG_DIR'],
    config: [{ configId: '~mode', value: 'bypassPermissions' }],
  },
  opencode: {
    binary: process.env.LATCH_OPENCODE_GATEWAY_BINARY,
    preset: 'opencode',
    program: 'opencode',
    agent: { command: () => 'opencode', args: ['acp'] },
    homes: HOMES,
    config: [],
  },
  pi: {
    binary: process.env.LATCH_PI_GATEWAY_BINARY,
    preset: 'pi',
    program: 'pi',
    agent: { command: () => 'pi', args: [] },
    homes: [...HOMES, 'PI_CODING_AGENT_DIR'],
    config: [],
  },
  dsh: {
    binary: process.env.LATCH_DSH_GATEWAY_BINARY,
    preset: 'dsh',
    program: 'dsh',
    agent: { command: () => 'dsh', args: ['--profile', 'acp'] },
    homes: [...HOMES, 'DSH_HOME'],
    config: [],
  },
}

const COMBOS: Array<{ harness: keyof typeof HARNESSES; kind: ProviderKind }> = [
  { harness: 'codex', kind: 'openai-compatible' },
  { harness: 'codex', kind: 'openai-responses' },
  { harness: 'codex', kind: 'anthropic' },
  { harness: 'claude', kind: 'anthropic' },
  { harness: 'claude', kind: 'openai-compatible' },
  { harness: 'opencode', kind: 'openai-compatible' },
  { harness: 'pi', kind: 'openai-compatible' },
  { harness: 'pi', kind: 'anthropic' },
  { harness: 'dsh', kind: 'openai-compatible' },
]

const MODEL = 'gw-measure-model'
const OPEN_MODEL = 'gw-measure-open'
const WINDOW = 64_000
const PROMPTS = [
  'GWM turn one: answer in one short sentence.',
  'GWM turn two TOOLTURN: run the probe command once with your shell tool, then answer in one short sentence.',
  'GWM turn three: answer in one short sentence.',
  'GWM turn four: answer in one short sentence.',
]
const INFLATE_PROMPT = 'GWM turn five INFLATE: answer in one short sentence.'
const AFTER_PROMPT = 'GWM turn six: answer in one short sentence.'
const HOLD_PROMPT = 'GWM turn seven HOLD: answer in one short sentence.'
const FAIL_PROMPT = 'GWM failing turn: answer in one short sentence.'

// --- What the gateway did with each request, from inside the same process. ---

interface GatewayTrace {
  t0: number
  sessionId?: string
  entry?: ModelWire
  /** The request as the harness sent it (after the gateway's own usage and thinking edits). */
  harness?: string
  /** What each candidate was given. */
  prepared: string[]
  sentAt?: number
  writes: Array<{ t: number; text: string }>
}
const traces: GatewayTrace[] = []
const current = new AsyncLocalStorage<GatewayTrace>()
const leases = new Map<string, { baseURL: string; token: string; entry: ModelWire }>()
/**
 * When the runtime took each session's turn count, and whether it kept it: the end of a turn keeps it (`routedTurn`),
 * any other take drops what came since. A request counts in a turn when the next take after it keeps the count.
 */
const takes = new Map<string, Array<{ at: number; kept: boolean }>>()
type Patched = Record<'handle' | 'prepare' | 'send' | 'open', (...args: unknown[]) => unknown>
const proto = ModelGatewayServer.prototype as unknown as Patched
const original = { handle: proto.handle, prepare: proto.prepare, send: proto.send, open: proto.open }

beforeAll(() => {
  proto.handle = function (this: unknown, ...args: unknown[]) {
    const res = args[1] as ServerResponse
    const trace: GatewayTrace = { t0: performance.now(), prepared: [], writes: [] }
    traces.push(trace)
    const write = res.write.bind(res) as (...a: unknown[]) => boolean
    const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse
    const note = (chunk: unknown) => {
      if (typeof chunk === 'string' && chunk) trace.writes.push({ t: performance.now(), text: chunk })
      else if (chunk instanceof Uint8Array && chunk.length)
        trace.writes.push({ t: performance.now(), text: Buffer.from(chunk).toString('utf8') })
    }
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      note(chunk)
      return write(chunk, ...rest)
    }) as typeof res.write
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'function') note(chunk)
      return end(chunk, ...rest)
    }) as typeof res.end
    return current.run(trace, () => original.handle.apply(this, args as [IncomingMessage, ServerResponse]))
  }
  proto.prepare = function (this: unknown, ...args: unknown[]) {
    const out = original.prepare.apply(this, args) as { body: Buffer }
    const trace = current.getStore()
    if (trace) {
      const binding = args[0] as { sessionId: string; entry: ModelWire }
      const asked = args[3] as { body: Buffer }
      trace.sessionId = binding.sessionId
      trace.entry = binding.entry
      trace.harness ??= asked.body.toString('utf8')
      trace.prepared.push(out.body.toString('utf8'))
    }
    return out
  }
  proto.send = function (this: unknown, ...args: unknown[]) {
    const trace = current.getStore()
    if (trace) trace.sentAt = performance.now()
    return original.send.apply(this, args)
  }
  proto.open = function (this: unknown, ...args: unknown[]) {
    const lease = original.open.apply(this, args) as { baseURL: string; token: string; takeTurn: () => unknown }
    const input = args[0] as { sessionId: string; route: { wire: ModelWire } }
    leases.set(input.sessionId, { baseURL: lease.baseURL, token: lease.token, entry: input.route.wire })
    const take = lease.takeTurn
    lease.takeTurn = () => {
      const kept = /routedTurn/u.test(new Error().stack ?? '')
      takes.set(input.sessionId, [...(takes.get(input.sessionId) ?? []), { at: performance.now(), kept }])
      return take()
    }
    return lease
  }
})
afterAll(() => Object.assign(proto, original))

// --- Reading usage the way each protocol means it. ---

const num = (value: unknown) => (typeof value === 'number' ? value : undefined)

/** A usage object of `wire` as Latch counts tokens: input with cached tokens in it. */
function normalized(wire: ModelWire, usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  if (wire === 'anthropic-messages') {
    const input = num(usage.input_tokens) ?? 0
    const read = num(usage.cache_read_input_tokens)
    const write = num(usage.cache_creation_input_tokens)
    return {
      inputTokens: input + (read ?? 0) + (write ?? 0),
      outputTokens: num(usage.output_tokens) ?? 0,
      ...(read !== undefined ? { cacheReadTokens: read } : {}),
      ...(write !== undefined ? { cacheWriteTokens: write } : {}),
    }
  }
  if (wire === 'responses') {
    const details = usage.input_tokens_details as Record<string, unknown> | undefined
    const out = usage.output_tokens_details as Record<string, unknown> | undefined
    return {
      inputTokens: num(usage.input_tokens) ?? 0,
      outputTokens: num(usage.output_tokens) ?? 0,
      ...(num(details?.cached_tokens) !== undefined ? { cacheReadTokens: num(details?.cached_tokens) } : {}),
      ...(num(details?.cache_write_tokens) !== undefined ? { cacheWriteTokens: num(details?.cache_write_tokens) } : {}),
      ...(num(out?.reasoning_tokens) !== undefined ? { reasoningTokens: num(out?.reasoning_tokens) } : {}),
    }
  }
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
  const out = usage.completion_tokens_details as Record<string, unknown> | undefined
  const read = num(details?.cached_tokens) ?? num(usage.prompt_cache_hit_tokens)
  return {
    inputTokens: num(usage.prompt_tokens) ?? 0,
    outputTokens: num(usage.completion_tokens) ?? 0,
    ...(read !== undefined ? { cacheReadTokens: read } : {}),
    ...(num(details?.cache_write_tokens) !== undefined ? { cacheWriteTokens: num(details?.cache_write_tokens) } : {}),
    ...(num(out?.reasoning_tokens) !== undefined ? { reasoningTokens: num(out?.reasoning_tokens) } : {}),
  }
}

/** The usage the gateway wrote to the harness in its reply, read in the harness's own protocol. */
function deliveredUsage(entry: ModelWire, text: string): TokenUsage | undefined {
  const datas = text.split(/\n\n/u).flatMap(frame =>
    frame
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim()),
  )
  const parsed = (datas.length ? datas : [text]).flatMap(data => {
    try {
      return [JSON.parse(data) as Record<string, unknown>]
    } catch {
      return []
    }
  })
  if (entry === 'anthropic-messages') {
    let usage: Record<string, unknown> | undefined
    for (const event of parsed) {
      const message =
        event.type === 'message_start' ? (event.message as Record<string, unknown>) : event.type === 'message' ? event : undefined
      if (message?.usage) usage = { ...usage, ...(message.usage as object) }
      if (event.type === 'message_delta' && event.usage) usage = { ...usage, ...(event.usage as object) }
    }
    return normalized(entry, usage)
  }
  if (entry === 'responses') {
    const done = parsed.findLast(
      event => event.type === 'response.completed' || event.type === 'response.incomplete' || event.object === 'response',
    )
    const response = (done?.response ?? done) as Record<string, unknown> | undefined
    return normalized(entry, response?.usage as Record<string, unknown> | undefined)
  }
  return normalized(entry, parsed.findLast(event => event.usage)?.usage as Record<string, unknown> | undefined)
}

function addTokens(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!b) return a
  if (!a) return { ...b }
  const sum: TokenUsage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
  for (const part of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const)
    if (a[part] !== undefined && b[part] !== undefined) sum[part] = a[part] + b[part]
  return sum
}

const sameTokens = (a: TokenUsage | undefined, b: TokenUsage | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Only the parts `wire` has a field for: Anthropic's usage says nothing of reasoning tokens. */
function expressible(wire: ModelWire, usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage || wire !== 'anthropic-messages') return usage
  const { reasoningTokens: _, ...rest } = usage
  return rest
}

// --- Cache hints. ---

function hintsOf(wire: ModelWire, text: string): string[] {
  const body = JSON.parse(text) as Record<string, unknown>
  const found: string[] = []
  const marks = text.match(/"cache_control"/gu)?.length ?? 0
  if (marks) found.push(`cache_control×${marks - (body.cache_control ? 1 : 0)}`)
  if (body.cache_control) found.push('cache_control(top)')
  if (body.prompt_cache_key !== undefined) found.push('prompt_cache_key')
  if (body.prompt_cache_retention !== undefined) found.push('prompt_cache_retention')
  if (wire !== 'anthropic-messages' && body.safety_identifier !== undefined) found.push('safety_identifier')
  if (body.metadata !== undefined) found.push('metadata')
  return found
}

// --- Prefix stability. ---

function snippet(a: string, b: string, at: number): { before: string; was: string; now: string } {
  return { before: a.slice(Math.max(0, at - 100), at), was: a.slice(at, at + 140), now: b.slice(at, at + 140) }
}

function prefixPairs(wire: ModelWire, bodies: Array<{ turn: number; text: string }>) {
  return bodies.slice(1).map((item, index) => {
    const previous = bodies[index]!
    const a = cacheable(wire, JSON.parse(previous.text) as Record<string, unknown>)
    const b = cacheable(wire, JSON.parse(item.text) as Record<string, unknown>)
    const at = commonPrefix(a, b)
    const ratio = a.length ? at / a.length : 1
    return {
      from: previous.turn,
      to: item.turn,
      ratio: Math.round(ratio * 10_000) / 10_000,
      ...(ratio < 0.98 ? { change: snippet(a, b, at) } : {}),
    }
  })
}

// --- Driving a session. ---

const shellTool = (body: Record<string, unknown>) => {
  const tools = offeredTools(body)
  const named =
    tools.find(tool => /^(exec_command|shell_command|shell|bash|Bash)$/u.test(tool.name))
    ?? tools.find(tool => {
      const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>
      return 'cmd' in properties || 'command' in properties
    })
  if (!named) return undefined
  const properties = (named.parameters.properties ?? {}) as Record<string, { type?: unknown }>
  const command = 'printf gwm-probe-ok'
  const input: Record<string, unknown> =
    'cmd' in properties ? { cmd: command } : properties.command?.type === 'array' ? { command: ['bash', '-lc', command] } : { command }
  if ('description' in properties) input.description = 'Print a fixed probe text'
  if ('timeout_ms' in properties) input.timeout_ms = 5000
  return { name: named.name, input }
}

/**
 * Main-loop requests carry the tools and the session's first prompt, and ask about one of its prompts or a tool's result;
 * titles, summaries, suggestions of what to type next and other side calls do not.
 */
const isMain = (request: UpstreamRequest) =>
  offeredTools(request.body).length > 0
  && userText(request.wire, request.body).includes(PROMPTS[0]!.slice(0, 12))
  && (endsWithToolResult(request.wire, request.body) || lastUserText(request.wire, request.body).trimStart().startsWith('GWM'))

type Failure = 'rate' | 'server' | 'overflow' | 'cut'

function failureBody(wire: ModelWire, failure: Exclude<Failure, 'cut'>): unknown {
  const message =
    failure === 'rate'
      ? 'Rate limit reached for gw-measure-model; please try again in 2s.'
      : failure === 'server'
        ? 'The server had an error while processing your request.'
        : "This model's maximum context length is 64000 tokens. However, your messages resulted in 70210 tokens."
  if (wire === 'anthropic-messages')
    return {
      type: 'error',
      error: {
        type: failure === 'rate' ? 'rate_limit_error' : failure === 'server' ? 'api_error' : 'invalid_request_error',
        message: failure === 'overflow' ? 'prompt is too long: 70210 tokens > 64000 maximum' : message,
      },
    }
  return {
    error: {
      message,
      type: failure === 'rate' ? 'rate_limit_error' : failure === 'server' ? 'server_error' : 'invalid_request_error',
      code: failure === 'rate' ? 'rate_limit_exceeded' : failure === 'overflow' ? 'context_length_exceeded' : null,
    },
  }
}

function plan(failure?: Failure) {
  return (request: UpstreamRequest): UpstreamReply => {
    const said = userText(request.wire, request.body)
    const latest = [FAIL_PROMPT, HOLD_PROMPT, AFTER_PROMPT, INFLATE_PROMPT, ...PROMPTS.toReversed()].find(prompt => said.includes(prompt))
    const main = offeredTools(request.body).length > 0
    if (failure && main) {
      if (failure === 'cut') return { text: 'This reply will break off after its first words.', cut: true }
      return {
        error: {
          status: failure === 'rate' ? 429 : failure === 'server' ? 500 : 400,
          body: failureBody(request.wire, failure),
          ...(failure === 'rate' ? { retryAfter: '2' } : {}),
        },
      }
    }
    if (latest === HOLD_PROMPT && main) return { text: 'Held reply that waits for the cancel.', hold: true }
    if (main && latest === PROMPTS[1] && !endsWithToolResult(request.wire, request.body)) {
      const tool = shellTool(request.body)
      if (tool) return { reasoning: 'I will run the probe.', tool }
    }
    return {
      reasoning: main ? 'Short thought before answering.' : undefined,
      text: 'Measured gateway answer in one short sentence here.',
      ...(main && latest === INFLATE_PROMPT ? { inflate: Math.round(WINDOW * 0.97) } : {}),
    }
  }
}

async function homes(root: string, names: string[]): Promise<void> {
  vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
  for (const name of names) {
    const path = join(root, name.toLowerCase())
    await mkdir(path, { recursive: true })
    vi.stubEnv(name, path)
  }
}

const evidenceDir = process.env.LATCH_GATEWAY_EVIDENCE_DIR

const runnable = COMBOS.filter(combo => HARNESSES[combo.harness]!.binary)
// A combination whose harness switch is not set is not listed at all; with none set, one skipped case says so.
if (!runnable.length) it.skip('measures harnesses through the gateway (no harness switch set)', () => {})
else
  it.each(runnable)(
    'measures $harness through the gateway to a $kind service',
    async ({ harness, kind }) => {
      const setup = HARNESSES[harness]!
      const binary = setup.binary!
      const upstreamWire = WIRE[kind]
      const root = await mkdtemp(join(tmpdir(), 'latch-gw-efficiency-'))
      await homes(root, setup.homes)
      const ups: RecordingUpstream[] = []
      const upstream = await startRecordingUpstream({ plan: plan(), usageShape: harness === 'dsh' ? 'deepseek' : 'openai' })
      ups.push(upstream)
      traces.length = 0
      const host = await startTestHost({
        demo: false,
        dataDir: join(root, 'host'),
        workspaceRoot: join(root, 'project'),
        commandDirectories: () => [dirname(binary)],
        loginPrograms: (name: string) => (name === (binary.endsWith('/claude') ? 'claude' : setup.program) ? binary : undefined),
        detectPreset: (preset: AgentPreset) => (preset.id === setup.preset ? { found: true, path: binary } : { found: false }),
      })
      const report: Record<string, unknown> = { harness, upstream: kind }
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const service = async (name: string, origin: string) => {
          const added = await owner.confirmed('providers', {
            method: 'POST',
            body: {
              name,
              kind,
              baseURL: `${origin}/v1`,
              apiKey: 'sk-test-gw-efficiency-0123456789',
              models: [MODEL, OPEN_MODEL],
              defaultModel: MODEL,
              modelCapabilities: {
                [MODEL]: { contextTokens: WINDOW, thinking: ['low', 'medium', 'high'] },
                [OPEN_MODEL]: { thinking: ['low', 'medium', 'high'] },
              },
              confirmOrigin: true,
            },
          })
          expect(added.status, await added.clone().text()).toBe(201)
          return ((await added.json()) as { provider: ProviderSettings }).provider
        }
        const provider = await service('Measured service', upstream.origin)
        expect(
          (
            await owner.confirmed('agents', {
              method: 'POST',
              body: {
                id: 'measured',
                name: harness,
                presetId: setup.preset,
                command: setup.agent.command(binary),
                // The person's own `claude` is the Agent SDK wire, which takes no arguments; the adapter keeps its own.
                args: binary.endsWith('/claude') ? [] : setup.agent.args,
                env: {},
              },
            })
          ).status,
        ).toBe(201)
        const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
        /** Waits until the turn opened by `prompt` has settled, allowing every approval; false when `limitMs` passed first. */
        const settle = async (id: string, prompt: string, limitMs = 90_000): Promise<boolean> => {
          const until = Date.now() + limitMs
          while (Date.now() < until) {
            const current = await detail(id)
            for (const approval of current.approvals)
              await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
            const opened = current.messages.findLast(message => message.role === 'user' && message.text.includes(prompt))
            if (opened?.turn?.endedAt && !['running', 'waiting-approval'].includes(current.summary.status)) return true
            await new Promise(resolve => setTimeout(resolve, 150))
          }
          return false
        }
        const start = async (model: string, prompt: string, providerId = provider.id) =>
          (
            await owner.json<{ sessionId: string }>('tasks', {
              method: 'POST',
              body: { harnessId: 'measured', prompt, requestId: randomUUID(), model: { providerId, model }, config: setup.config },
            })
          ).sessionId
        const send = (id: string, prompt: string) =>
          owner.json(`tasks/${id}/prompt`, { method: 'POST', body: { prompt, requestId: randomUUID() } })
        const failureText = (current: TaskDetail) =>
          current.messages
            .filter(message => message.role === 'system')
            .map(message => message.text)
            .join(' | ')
            .slice(0, 600)

        // 1. Four turns: plain, one tool call, plain, plain.
        const turnStarts: number[] = []
        turnStarts.push(performance.now())
        const sessionId = await start(MODEL, PROMPTS[0]!)
        for (const [index, prompt] of PROMPTS.entries()) {
          if (index > 0) {
            turnStarts.push(performance.now())
            await send(sessionId, prompt)
          }
          const settled = await settle(sessionId, prompt)
          const current = await detail(sessionId)
          expect(settled && current.summary.status, failureText(current)).toBe('idle')
        }
        turnStarts.push(performance.now())
        const afterFour = await detail(sessionId)
        const turnOf = (at: number) => turnStarts.findLastIndex(start => start <= at) + 1
        const mainRequests = upstream.requests.filter(isMain)
        const sessionTraces = traces.filter(trace => trace.sessionId === sessionId)
        // The gateway request that sent it: the latest one before it arrived that sent these bytes (a replay repeats a body).
        const traceOf = (request: UpstreamRequest) =>
          sessionTraces.findLast(trace => trace.t0 <= request.at && trace.prepared.includes(request.text))

        // Prefix stability, as the service sees it and as the harness sent it.
        const upstreamBodies = mainRequests
          .filter(request => turnOf(request.at) <= 4)
          .map(request => ({ turn: turnOf(request.at), text: request.text }))
        const harnessBodies = mainRequests
          .filter(request => turnOf(request.at) <= 4)
          .flatMap(request => {
            const trace = traceOf(request)
            return trace?.harness ? [{ turn: turnOf(request.at), text: trace.harness }] : []
          })
        const entry = sessionTraces.find(trace => trace.entry)?.entry ?? upstreamWire
        const upstreamPairs = prefixPairs(upstreamWire, upstreamBodies)
        const harnessPairs = prefixPairs(entry, harnessBodies)
        const minOf = (pairs: Array<{ ratio: number }>) => (pairs.length ? Math.min(...pairs.map(pair => pair.ratio)) : undefined)
        report.entry = entry
        report.requests = { main: mainRequests.length, all: upstream.requests.length, byTurn: upstreamBodies.map(body => body.turn) }
        report.prefix = {
          upstreamMin: minOf(upstreamPairs),
          harnessMin: minOf(harnessPairs),
          upstream: upstreamPairs,
          harness: harnessPairs,
        }

        // Cache hints in and out.
        const hintsIn = new Set<string>()
        const hintsOut = new Set<string>()
        for (const request of mainRequests) {
          for (const hint of hintsOf(upstreamWire, request.text)) hintsOut.add(hint)
          const trace = traceOf(request)
          if (trace?.harness) for (const hint of hintsOf(entry, trace.harness)) hintsIn.add(hint)
        }
        report.hints = { in: [...hintsIn], out: [...hintsOut] }

        // What else the harness sent and what of it went on: the top-level fields, the tools and the size of each.
        const keysIn = new Set<string>()
        const keysOut = new Set<string>()
        for (const request of mainRequests) {
          for (const key of Object.keys(request.body)) keysOut.add(key)
          const trace = traceOf(request)
          if (trace?.harness) for (const key of Object.keys(JSON.parse(trace.harness) as object)) keysIn.add(key)
        }
        const firstMain = mainRequests[0]
        report.hygiene = {
          keysIn: [...keysIn].toSorted(),
          keysOut: [...keysOut].toSorted(),
          notForwarded: [...keysIn].filter(key => !keysOut.has(key)).toSorted(),
          added: [...keysOut].filter(key => !keysIn.has(key)).toSorted(),
          firstMain: firstMain && {
            bytes: firstMain.text.length,
            inputTokens: firstMain.tokens?.inputTokens,
            tools: offeredTools(firstMain.body).map(tool => tool.name),
          },
        }
        // Connections the service saw for the session's main requests: one means every request after the first reused it.
        report.connections = new Set(mainRequests.filter(request => turnOf(request.at) <= 4).map(request => request.connection)).size

        // Usage: what the service said, what the harness was given, what the turn and the ledger keep.
        const perRequest = upstream.requests
          .filter(request => turnOf(request.at) <= 4 && request.tokens && request.usageSent)
          .map(request => {
            const trace = traceOf(request)
            const written = trace?.writes.map(write => write.text).join('') ?? ''
            // Only a reply the harness read to its end: one it left early never got the rest, though the service sent it.
            const read =
              /message_stop|\[DONE\]|response\.completed|response\.incomplete/u.test(written)
              || (!written.includes('data:') && written.trimStart().startsWith('{'))
            const delivered = trace && read ? deliveredUsage(entry, written) : undefined
            return {
              n: request.n,
              turn: turnOf(request.at),
              main: isMain(request),
              upstream: request.tokens,
              delivered,
              read,
              same: !read || sameTokens(expressible(entry, request.tokens), delivered),
            }
          })
        const turns = afterFour.messages.filter(message => message.role === 'user' && message.turn)
        const routedByTurn = turns.slice(0, 4).map((message, index) => {
          const routed = message.turn?.routed
          const routedUsage = routed?.models.reduce<TokenUsage | undefined>((sum, model) => addTokens(sum, model.usage), undefined)
          const expected = upstream.requests
            .filter(request => turnOf(request.at) === index + 1 && request.tokens && request.usageSent)
            .reduce<TokenUsage | undefined>((sum, request) => addTokens(sum, request.tokens), undefined)
          return {
            turn: index + 1,
            upstream: expected,
            routed: routedUsage,
            routedMatches: sameTokens(expected, routedUsage),
            harnessReported: message.turn?.usage,
            requests: routed?.requests,
            measured: routed?.models.reduce((sum, model) => sum + (model.measured ?? 0), 0),
            dropped: routed?.dropped,
          }
        })
        const ledger = await readLedger(join(root, 'host'), sessionId)
        const lastMain = mainRequests.filter(request => turnOf(request.at) <= 4).at(-1)
        report.usage = {
          perRequest,
          deliveredMismatches: perRequest.filter(item => !item.same).length,
          turns: routedByTurn,
          ledger,
          usageReport: afterFour.usageReport,
          lastMainInput: lastMain?.tokens?.inputTokens,
        }
        report.dropped = [...new Set(routedByTurn.flatMap(turn => turn.dropped ?? []))]

        // Time the gateway adds: before the request leaves, and before each piece of the reply reaches the harness.
        const timing = mainRequests
          .filter(request => turnOf(request.at) <= 4 && request.stream)
          .flatMap(request => {
            const trace = traceOf(request)
            if (!trace) return []
            const lags = request.pieces.map(sent => {
              const reached = trace.writes.find(write => write.t >= sent)
              return reached ? reached.t - sent : Number.NaN
            })
            const lastPiece = request.pieces.at(-1) ?? 0
            const before = trace.writes.filter(write => write.t < lastPiece - 50).length
            return [
              {
                n: request.n,
                beforeSend: request.at - trace.t0,
                gatewayToFetch: (trace.sentAt ?? 0) - trace.t0,
                lags,
                writesBeforeLastPiece: before,
                pieces: request.pieces.length,
              },
            ]
          })
        const added = timing.map(item => item.beforeSend).toSorted((a, b) => a - b)
        const lagsAll = timing
          .flatMap(item => item.lags.slice(1))
          .filter(Number.isFinite)
          .toSorted((a, b) => a - b)
        report.latency = {
          firstByteAddedMs: { median: round(added[Math.floor(added.length / 2)]), max: round(added.at(-1)) },
          pieceLagMs: { median: round(lagsAll[Math.floor(lagsAll.length / 2)]), max: round(lagsAll.at(-1)) },
          // Each piece reaches the harness within a fraction of the 100 ms between pieces: forwarded as it comes.
          streaming: lagsAll.length && lagsAll.at(-1)! < 50 ? 'forwarded' : 'buffered',
          perRequest: timing.map(item => ({
            ...item,
            beforeSend: round(item.beforeSend),
            gatewayToFetch: round(item.gatewayToFetch),
            lags: item.lags.map(round),
          })),
        }

        // The same request again from a small client of the session's own lease, and once with 900 KB more in it (one text may hold at most 1 MiB).
        const lease = leases.get(sessionId)
        const sample = harnessBodies.at(-1)?.text
        if (lease && sample) {
          const replay = async (text: string) => {
            const before = upstream.requests.length
            const t0 = performance.now()
            const response = await fetch(`${lease.baseURL.replace(/\/v1$/u, '')}${pathOf(lease.entry)}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${lease.token}`, 'anthropic-version': '2023-06-01' },
              body: text,
            })
            await response.text()
            const arrived = upstream.requests[before]?.at
            return { status: response.status, addedMs: arrived === undefined ? undefined : round(arrived - t0), bytes: text.length }
          }
          report.replay = {
            same: [await replay(sample), await replay(sample), await replay(sample)],
            large: await replay(padded(lease.entry, sample, 900 * 1024)),
          }
        }

        // 2. Context window: what the harness believes for the declared model, and for one without a declared length.
        turnStarts.push(performance.now())
        await send(sessionId, INFLATE_PROMPT)
        await settle(sessionId, INFLATE_PROMPT)
        const inflated = await detail(sessionId)
        const beforeSix = upstream.requests.length
        turnStarts.push(performance.now())
        await send(sessionId, AFTER_PROMPT)
        const sixSettled = await settle(sessionId, AFTER_PROMPT)
        // Requests after the last turn ended belong to a turn that never ends, so no turn counts them.
        const lastTurnEnded = performance.now()
        const six = upstream.requests.slice(beforeSix)
        const sixDetail = await detail(sessionId)
        report.window = {
          declared: WINDOW,
          believedDeclared: afterFour.usageReport?.contextSize,
          afterInflate: inflated.usageReport,
          turnSixRequests: six.map(request => ({
            main: isMain(request),
            tools: offeredTools(request.body).length,
            bytes: request.text.length,
            summaryLike: /summar|compact|condens/iu.test(lastUserText(request.wire, request.body)),
          })),
          turnSixStatus: sixSettled ? sixDetail.summary.status : 'timeout',
          ...(sixDetail.summary.status === 'idle' ? {} : { turnSixFailure: failureText(sixDetail) }),
          // A summary request before the turn's own, or a main request clearly shorter than the conversation was.
          compactedBeforeSending: six.some(
            request =>
              /summar|compact|condens/iu.test(lastUserText(request.wire, request.body))
              || (isMain(request) && request.text.length < (mainRequests.at(-1)?.text.length ?? 0) * 0.8),
          ),
        }
        const openSession = await start(OPEN_MODEL, PROMPTS[0]!)
        const openSettled = await settle(openSession, PROMPTS[0]!, 60_000)
        const openDetail = await detail(openSession)
        ;(report.window as Record<string, unknown>).believedUndeclared = openDetail.usageReport?.contextSize
        ;(report.window as Record<string, unknown>).undeclaredStatus = openSettled ? openDetail.summary.status : 'timeout'
        if (openDetail.summary.status !== 'idle') (report.window as Record<string, unknown>).undeclaredFailure = failureText(openDetail)

        // The whole session's tokens three ways: what the service reported for each of its requests, the usage ledger's
        // lines, and the turns' `routed` counts. A turn counts what arrives while it runs; requests between turns (the
        // replays above, suggestions a harness makes after a turn) belong to none, so only the ledger has every request.
        await new Promise(resolve => setTimeout(resolve, 1500))
        const whole = await detail(sessionId)
        const own = upstream.requests.filter(request => {
          const trace = traces.findLast(item => item.t0 <= request.at && item.prepared.includes(request.text))
          return trace?.sessionId === sessionId && request.tokens && request.usageSent && request.at < lastTurnEnded
        })
        const taken = takes.get(sessionId) ?? []
        const inTurn = own.filter(request => {
          const arrived = traces.findLast(item => item.t0 <= request.at && item.prepared.includes(request.text))!.t0
          return taken.find(take => take.at > arrived)?.kept === true
        })
        const upstreamTotal = own.reduce<TokenUsage | undefined>((sum, request) => addTokens(sum, request.tokens), undefined)
        const inTurnTotal = inTurn.reduce<TokenUsage | undefined>((sum, request) => addTokens(sum, request.tokens), undefined)
        const routedTurns = whole.messages.flatMap(message =>
          message.role === 'user' && message.turn?.routed ? [message.turn.routed] : [],
        )
        const routedTotal = routedTurns
          .flatMap(routed => routed.models)
          .reduce<TokenUsage | undefined>((sum, model) => addTokens(sum, model.usage), undefined)
        const openAtTurnEnd = routedTurns.flatMap(routed => routed.models).reduce((sum, model) => sum + (model.open ?? 0), 0)
        const ledgerTotal = await readLedger(join(root, 'host'), sessionId)
        // 3. Cancel, in a session of its own: a reply held open upstream, and how long the upstream request outlives the cancel.
        const holding = await start(MODEL, HOLD_PROMPT)
        let held: UpstreamRequest | undefined
        await vi.waitFor(
          () => {
            held = upstream.requests.find(request => request.reply?.hold)
            expect(held).toBeDefined()
          },
          { timeout: 30_000, interval: 50 },
        )
        const runId = (await detail(holding)).summary.runId
        const cancelAt = performance.now()
        const stopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${holding}/cancel`, {
          method: 'POST',
          body: { runId, requestId: randomUUID() },
        })
        await vi.waitFor(() => expect(held!.closedAt).toBeDefined(), { timeout: 15_000, interval: 20 })
        report.cancel = { receipt: stopped.receipt.outcome, upstreamClosedMs: round(held!.closedAt! - cancelAt) }

        report.totals = {
          requests: own.length,
          inTurn: inTurn.length,
          takes: taken.map(take => (take.kept ? 'kept' : 'dropped')).join(','),
          upstream: upstreamTotal,
          upstreamInTurns: inTurnTotal,
          ledger: ledgerTotal,
          routed: routedTotal,
          openAtTurnEnd,
          ledgerMatches: sameTokens(upstreamTotal, ledgerTotal.usage),
          routedMatches: sameTokens(inTurnTotal, routedTotal),
        }

        // 4. Failures, each at a service of its own so one's health never touches the next.
        const failures: Record<string, unknown> = {}
        for (const failure of ['overflow', 'cut', 'rate', 'server'] as const) {
          const failing = await startRecordingUpstream({ plan: plan(failure) })
          ups.push(failing)
          const other = await service(`Failing ${failure}`, failing.origin)
          const id = await start(MODEL, FAIL_PROMPT, other.id)
          const t0 = Date.now()
          const ended = await settle(id, FAIL_PROMPT, 75_000)
          const result = await detail(id)
          const main = failing.requests.filter(request => offeredTools(request.body).length > 0)
          const gatewayRequests = traces.filter(trace => trace.sessionId === id).length
          failures[failure] = {
            status: ended ? result.summary.status : 'still running after 75 s',
            seconds: Math.round((Date.now() - t0) / 100) / 10,
            upstreamMainRequests: main.length,
            gatewayRequests,
            reason: failureText(result),
            routed: result.messages.find(message => message.role === 'user')?.turn?.routed,
          }
          if (!ended) {
            await owner
              .json(`tasks/${id}/cancel`, { method: 'POST', body: { runId: result.summary.runId, requestId: randomUUID() } })
              .catch(() => undefined)
          }
        }
        report.failures = failures

        // What the gateway itself owns. Every token count the service reported reaches the harness, the ledger and the turns
        // unchanged (a request still open when its turn was taken is the one way a turn may miss one).
        expect(report.usage).toMatchObject({ deliveredMismatches: 0 })
        expect(report.totals, JSON.stringify(report.totals)).toMatchObject({ ledgerMatches: true })
        if (openAtTurnEnd === 0) expect(report.totals, JSON.stringify(report.totals)).toMatchObject({ routedMatches: true })
        // The gateway keeps the harness's prefix: what the service sees is no less stable than what the harness sent.
        const prefix = report.prefix as { upstreamMin?: number; harnessMin?: number }
        if (prefix.harnessMin !== undefined)
          expect(prefix.upstreamMin! + 0.01, JSON.stringify(report.prefix)).toBeGreaterThanOrEqual(prefix.harnessMin)
        // A harness that asks for caching gets it at a service that caches only marked prefixes: from the second main
        // request on, each reads most of what came before.
        if (hintsIn.size && upstreamWire === 'anthropic-messages') {
          expect([...hintsOut].some(hint => hint.startsWith('cache_control'))).toBe(true)
          for (const request of mainRequests.filter(request => turnOf(request.at) <= 4).slice(1))
            expect(request.tokens!.cacheReadTokens!, `request ${request.n}`).toBeGreaterThan(request.tokens!.inputTokens * 0.8)
        }
        expect(report.cancel).toMatchObject({ receipt: 'stopped' })
        expect((report.cancel as { upstreamClosedMs: number }).upstreamClosedMs).toBeLessThan(1000)
        const failed = report.failures as Record<Failure, { upstreamMainRequests: number; reason: string }>
        if (entry !== upstreamWire) {
          // A converted request carries none of the service's own tools, so a 5xx is tried again in place before the
          // harness hears of it, whatever tools the harness named.
          expect(failed.server.upstreamMainRequests, JSON.stringify(failed.server)).toBeGreaterThanOrEqual(3)
          // A reply that broke off says so, not that converting it failed.
          expect(failed.cut.reason).not.toContain('未完整转换')
        }
      } finally {
        if (evidenceDir) {
          await mkdir(evidenceDir, { recursive: true })
          await writeFile(join(evidenceDir, `efficiency-${harness}-${kind}.json`), JSON.stringify(report, null, 2))
        }
        await host.close()
        for (const item of ups) await item.close()
        try {
          await assertNoGatewayCredentials(root)
        } finally {
          await rm(root, { recursive: true, force: true })
          vi.unstubAllEnvs()
        }
      }
    },
    900_000,
  )

const round = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? undefined : Math.round(value * 10) / 10)

const pathOf = (entry: ModelWire) =>
  entry === 'anthropic-messages' ? '/v1/messages' : entry === 'responses' ? '/v1/responses' : '/v1/chat/completions'

/** The request with `bytes` more text in its first message or instructions, the rest as it was. */
function padded(entry: ModelWire, text: string, bytes: number): string {
  const body = JSON.parse(text) as Record<string, unknown>
  const pad = `\n${'measuring filler '.repeat(Math.ceil(bytes / 17))}`
  if (entry === 'responses' && typeof body.instructions === 'string') body.instructions += pad
  else if (entry === 'anthropic-messages') {
    if (typeof body.system === 'string') body.system += pad
    else if (Array.isArray(body.system)) body.system = [...body.system, { type: 'text', text: pad }]
    else body.system = pad
  } else {
    const list = (entry === 'responses' ? body.input : body.messages) as Array<Record<string, unknown>>
    const first = list.find(item => item.role === 'user' || item.role === 'system' || item.role === 'developer')!
    if (typeof first.content === 'string') first.content += pad
    else (first.content as Array<Record<string, unknown>>).push({ type: entry === 'responses' ? 'input_text' : 'text', text: pad })
  }
  return JSON.stringify(body)
}

/** The ledger's lines for one session: how many, and the tokens they sum to. */
async function readLedger(dataDir: string, sessionId: string): Promise<{ lines: number; usage?: TokenUsage }> {
  const directory = join(dataDir, 'gateway')
  const files = (await readdir(directory).catch(() => [] as string[])).filter(name => /^usage-\d{4}-\d{2}\.jsonl$/u.test(name))
  let lines = 0
  let usage: TokenUsage | undefined
  for (const file of files)
    for (const line of (await readFile(join(directory, file), 'utf8')).split('\n')) {
      if (!line) continue
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.sessionId !== sessionId) continue
      lines++
      if (typeof entry.inputTokens === 'number')
        usage = addTokens(usage, {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens as number,
          ...(typeof entry.cacheReadTokens === 'number' ? { cacheReadTokens: entry.cacheReadTokens } : {}),
          ...(typeof entry.cacheWriteTokens === 'number' ? { cacheWriteTokens: entry.cacheWriteTokens } : {}),
          ...(typeof entry.reasoningTokens === 'number' ? { reasoningTokens: entry.reasoningTokens } : {}),
        })
    }
  return { lines, ...(usage ? { usage } : {}) }
}
