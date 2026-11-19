/**
 * Latch's runner for Cursor's official TypeScript SDK (`@cursor/sdk`). The SDK runs Cursor's agent loop in the process
 * that loads it, so the Host never loads it: `wires/cursor.ts` starts this file with Node in a process group of its own
 * and speaks one JSON object per line on stdio. Node runs it as it is from the package's sources (type stripping only:
 * nothing here may need more than erasing types) and from `dist/harness/cursor-runner.js` in a build.
 *
 * - The key comes only from `CURSOR_API_KEY` in this process's environment. It is read once, removed from the
 *   environment before the SDK is loaded (the agent's shell commands and MCP servers inherit what is left), and handed
 *   to every SDK call as `apiKey`, so the SDK never falls back to a login stored on this computer. Without it every
 *   request but `hello` is refused. No line this process writes holds it.
 * - The SDK is imported only when a session opens: `--help` and `hello` load nothing of Cursor's.
 * - `--sdk <module>` replaces the SDK with another module of the same shape. Only tests pass it; the wire takes it from
 *   a test-only setter, never from a definition, a session or a device.
 */
import type { Agent as CursorAgent, Cursor as CursorAccount, ModelListItem, ModelSelection, Run, SDKAgent, SDKMessage } from '@cursor/sdk'
import { createInterface } from 'node:readline'

interface Sdk {
  Agent: typeof CursorAgent
  Cursor: typeof CursorAccount
  JsonlLocalAgentStore: new (root: string) => unknown
}

const HELP = `latch-cursor-runner: runs Cursor's SDK for one Latch session, one JSON object per line on stdio.
Requests: hello, open, configure, prompt, cancel, steer. Reads the key from CURSOR_API_KEY only.
`

const MAX_MODELS = 500

/** Each mode's tools and sandbox. Read-only offers no shell, writes, subagents (`task`) or MCP. */
const MODES: Readonly<Record<string, { tools?: string[]; sandbox: boolean }>> = {
  'read-only': { tools: ['read', 'grep', 'glob', 'ls'], sandbox: false },
  sandbox: { sandbox: true },
  full: { sandbox: false },
}

const argv = process.argv.slice(2)
if (argv.includes('--help')) {
  process.stdout.write(HELP)
  process.exit(0)
}
const sdkAt = argv.indexOf('--sdk')
const SDK_MODULE = sdkAt >= 0 ? argv[sdkAt + 1] : undefined

const KEY = process.env.CURSOR_API_KEY ?? ''
delete process.env.CURSOR_API_KEY

function mask(text: string): string {
  return KEY.length >= 8 ? text.split(KEY).join('[redacted]') : text
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function write(message: Record<string, unknown>): void {
  const line = mask(JSON.stringify(message))
  process.stdout.write(`${line.replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')}\n`)
}

function errorOf(error: unknown): { code: string; message: string } {
  const name = error instanceof Error ? error.name : ''
  const code =
    name === 'AgentNotFoundError'
      ? 'not-found'
      : name === 'AuthenticationError'
        ? 'auth'
        : name === 'ConfigurationError'
          ? 'configuration'
          : name === 'AgentBusyError'
            ? 'busy'
            : 'failed'
  return { code, message: clip(mask(error instanceof Error ? error.message : String(error)), 2000) }
}

class Refused extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

let sdk: Sdk | undefined
async function loadSdk(): Promise<Sdk> {
  if (sdk) return sdk
  // A variable, so a bundler leaves the import to run time: the package is resolved where this file is.
  const specifier = SDK_MODULE ?? '@cursor/sdk'
  sdk = (await import(specifier)) as Sdk
  return sdk
}

interface Session {
  cwd: string
  dirs: string[]
  store: string
  mode: string
  model: ModelSelection
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
  agent: SDKAgent
}

let session: Session | undefined
let models: ModelListItem[] = []
let run: Run | undefined
let opening = false
/** A prompt is being sent and has no run yet; a cancel meanwhile is kept for the run it starts. */
let sending = false
let cancelSoon = false

/** A model and its parameters as one option value: `id`, or `id?name=value&…`. */
function valueOf(selection: ModelSelection): string {
  const params = new URLSearchParams()
  for (const param of selection.params ?? []) params.append(param.id, param.value)
  const query = params.toString()
  return query ? `${selection.id}?${query}` : selection.id
}

function selectionOf(value: string): ModelSelection {
  const at = value.indexOf('?')
  if (at < 0) return { id: value }
  const params = [...new URLSearchParams(value.slice(at + 1))].map(([id, param]) => ({ id, value: param }))
  return { id: value.slice(0, at), ...(params.length ? { params } : {}) }
}

/** Every model as the account lists it, each variant its own choice. */
function choices(): Array<{ value: string; name: string; description?: string; isDefault?: boolean }> {
  const listed: Array<{ value: string; name: string; description?: string; isDefault?: boolean }> = []
  for (const item of models) {
    const variants = Array.isArray(item.variants) ? item.variants : []
    if (!variants.length) listed.push({ value: item.id, name: clip(item.displayName || item.id, 200) })
    for (const variant of variants)
      listed.push({
        value: valueOf({ id: item.id, params: variant.params }),
        name: clip(variant.displayName || item.displayName || item.id, 200),
        ...(variant.description ? { description: clip(variant.description, 500) } : {}),
        ...(variant.isDefault ? { isDefault: true } : {}),
      })
    if (listed.length >= MAX_MODELS) break
  }
  return listed.slice(0, MAX_MODELS)
}

function state(): Record<string, unknown> {
  if (!session) throw new Refused('no-session', 'No session is open')
  return {
    agentId: session.agent.agentId,
    mode: session.mode,
    model: valueOf(session.model),
    models: choices().map(({ isDefault: _, ...rest }) => rest),
  }
}

async function create(sdkModule: Sdk, next: Omit<Session, 'agent'>, agentId?: string): Promise<SDKAgent> {
  const mode = MODES[next.mode]
  if (!mode) throw new Refused('mode', `Unknown mode ${clip(next.mode, 64)}`)
  // Not persisted by the SDK: given again on every resume.
  const options = {
    apiKey: KEY,
    model: next.model,
    name: 'Latch',
    ...(mode.tools ? { tools: mode.tools } : {}),
    ...(mode.tools || !Object.keys(next.mcpServers).length ? {} : { mcpServers: next.mcpServers }),
    local: {
      cwd: next.cwd,
      ...(next.dirs.length ? { dirs: next.dirs } : {}),
      // The project's rules, hooks and settings as cursor-agent reads them; never the person's own (`user`).
      settingSources: ['project' as const],
      sandboxOptions: { enabled: mode.sandbox },
      store: new sdkModule.JsonlLocalAgentStore(next.store) as never,
    },
  }
  return agentId ? sdkModule.Agent.resume(agentId, options) : sdkModule.Agent.create(options)
}

async function open(request: Record<string, unknown>): Promise<unknown> {
  if (!KEY) throw new Refused('no-key', 'CURSOR_API_KEY is not set')
  if (session || opening) throw new Refused('busy', 'This process already runs a session')
  const cwd = typeof request.cwd === 'string' ? request.cwd : ''
  const store = typeof request.store === 'string' ? request.store : ''
  if (!cwd || !store) throw new Refused('invalid', 'cwd and store are required')
  const mode = typeof request.mode === 'string' ? request.mode : 'read-only'
  const dirs = Array.isArray(request.dirs) ? request.dirs.filter((dir): dir is string => typeof dir === 'string') : []
  const mcpServers: Session['mcpServers'] = {}
  for (const server of Array.isArray(request.mcpServers) ? request.mcpServers : []) {
    if (!server || typeof server !== 'object') continue
    const { name, command, args, env } = server as Record<string, unknown>
    if (typeof name !== 'string' || typeof command !== 'string') continue
    mcpServers[name] = {
      command,
      args: Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: Object.fromEntries(
        (Array.isArray(env) ? env : []).flatMap(item =>
          item && typeof item === 'object' && typeof item.name === 'string' && typeof item.value === 'string'
            ? [[item.name, item.value]]
            : [],
        ),
      ),
    }
  }
  opening = true
  try {
    const sdkModule = await loadSdk()
    models = (await sdkModule.Cursor.models.list({ apiKey: KEY })).slice(0, MAX_MODELS)
    const listed = choices()
    const asked = typeof request.model === 'string' && request.model ? request.model : undefined
    const fallback = listed.find(item => item.isDefault) ?? listed[0]
    if (!asked && !fallback) throw new Refused('no-models', 'Cursor lists no model for this key')
    const next = { cwd, dirs, store, mode, model: selectionOf(asked ?? fallback!.value), mcpServers }
    const agentId = typeof request.agentId === 'string' && request.agentId ? request.agentId : undefined
    session = { ...next, agent: await create(sdkModule, next, agentId) }
    return state()
  } finally {
    opening = false
  }
}

async function configure(request: Record<string, unknown>): Promise<unknown> {
  if (!session) throw new Refused('no-session', 'No session is open')
  if (run || sending) throw new Refused('busy', 'A turn is running')
  if (typeof request.model === 'string' && request.model) session.model = selectionOf(request.model)
  if (typeof request.mode === 'string' && request.mode !== session.mode) {
    if (!MODES[request.mode]) throw new Refused('mode', `Unknown mode ${clip(request.mode, 64)}`)
    const { agent, ...rest } = session
    const sdkModule = await loadSdk()
    // Tools and the sandbox are fixed when the agent is created or resumed: the same agent, closed and opened again.
    agent.close()
    try {
      session = { ...rest, mode: request.mode, agent: await create(sdkModule, { ...rest, mode: request.mode }, agent.agentId) }
    } catch (error) {
      // Back on the mode it had, or no session at all: never an agent on options nobody asked for.
      session = undefined
      session = { ...rest, agent: await create(sdkModule, rest, agent.agentId) }
      throw error
    }
  }
  return state()
}

function toolEvent(message: Extract<SDKMessage, { type: 'tool_call' }>): Record<string, unknown> {
  return {
    event: 'tool',
    callId: clip(message.call_id, 256),
    name: clip(message.name, 200),
    status: message.status,
    ...(message.args !== undefined ? { args: message.args } : {}),
    ...(message.result !== undefined ? { result: message.result } : {}),
  }
}

async function prompt(request: Record<string, unknown>): Promise<unknown> {
  if (!session) throw new Refused('no-session', 'No session is open')
  if (run || sending) throw new Refused('busy', 'A turn is running')
  const text = typeof request.text === 'string' ? request.text : ''
  const images = (Array.isArray(request.images) ? request.images : []).flatMap(image =>
    image && typeof image === 'object' && typeof image.data === 'string' && typeof image.mimeType === 'string'
      ? [{ data: image.data, mimeType: image.mimeType }]
      : [],
  )
  let streamed = false
  const agent = session.agent
  sending = true
  cancelSoon = false
  const sent = agent.send(images.length ? { text, images } : text, {
    model: session.model,
    onDelta: ({ update }) => {
      const kind = (update as { type?: unknown }).type
      const piece = (update as { text?: unknown }).text
      if (typeof piece !== 'string' || !piece) return
      if (kind === 'text-delta') {
        streamed = true
        write({ event: 'text', text: piece })
      } else if (kind === 'thinking-delta') {
        streamed = true
        write({ event: 'thinking', text: piece })
      }
    },
  })
  let current: Run
  try {
    current = await sent
  } finally {
    sending = false
  }
  run = current
  write({ event: 'run', runId: current.id })
  if (cancelSoon) await current.cancel()
  try {
    try {
      for await (const message of current.stream()) {
        if (message.type === 'tool_call') write(toolEvent(message))
        else if (message.type === 'usage') write({ event: 'usage', usage: message.usage })
        // Whole messages stand in only when the SDK sent no deltas for this run.
        else if (!streamed && message.type === 'assistant') {
          const said = message.message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
          if (said) write({ event: 'text', text: said })
        } else if (!streamed && message.type === 'thinking' && message.text) write({ event: 'thinking', text: message.text })
      }
    } catch (error) {
      // The run's own result says how it ended; a broken stream only ends the events.
      write({ event: 'notice', message: errorOf(error).message })
    }
    const result = await current.wait()
    const usage = result.usage ?? current.usage
    let cost: number | undefined
    try {
      // Billed cost of the whole agent. Local accounts without the feature answer 403, which leaves it unknown.
      const billed = await Promise.race([
        agent.getUsage(),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3_000).unref()),
      ])
      if (billed?.cost && Number.isFinite(billed.cost.chargedCents)) cost = billed.cost.chargedCents
    } catch {
      cost = undefined
    }
    return {
      status: result.status,
      ...(usage ? { usage } : {}),
      ...(cost !== undefined ? { costCents: cost } : {}),
      ...(result.error ? { error: errorOf(new Error(result.error.message)).message } : {}),
    }
  } finally {
    run = undefined
  }
}

async function cancel(): Promise<unknown> {
  // Settled when the prompt's own answer reports the run as cancelled.
  if (run) await run.cancel()
  else if (sending) cancelSoon = true
  return { cancelling: run !== undefined || sending }
}

async function steer(request: Record<string, unknown>): Promise<unknown> {
  if (!run?.steer) return { outcome: 'promptRequired' }
  const outcome = await run.steer(typeof request.text === 'string' ? request.text : '')
  return { outcome: outcome === 'complete_delivered' ? 'injected' : 'promptRequired' }
}

const HANDLERS: Readonly<Record<string, (request: Record<string, unknown>) => Promise<unknown>>> = {
  hello: () => Promise.resolve({ protocol: 1, key: KEY.length > 0 }),
  open,
  configure,
  prompt,
  cancel,
  steer,
}

async function handle(request: Record<string, unknown>): Promise<void> {
  const id = request.id
  const handler = typeof request.type === 'string' ? HANDLERS[request.type] : undefined
  try {
    if (!handler) throw new Refused('unknown', `Unknown request ${clip(String(request.type), 64)}`)
    write({ id, result: await handler(request) })
  } catch (error) {
    write({ id, error: error instanceof Refused ? { code: error.code, message: error.message } : errorOf(error) })
  }
}

async function shutdown(): Promise<void> {
  const agent = session?.agent
  session = undefined
  if (run) await run.cancel().catch(() => {})
  if (agent) await Promise.race([agent[Symbol.asyncDispose]().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2_000).unref())])
  process.exit(0)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  if (!line.trim()) return
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request && typeof request === 'object' && !Array.isArray(request)) void handle(request as Record<string, unknown>)
})
lines.on('close', () => void shutdown())
