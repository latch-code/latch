/**
 * Codex's own model list, read from its app-server without a thread, in the shape codex-acp gives a session's options:
 * the same option IDs and values, so a draft's pick applies to the session that follows.
 */
import { z } from 'zod'
import { escapeSecurityText, type HarnessMcpServer, type SessionConfigOption } from '@latch/protocol'
import { AcpWire } from './wires/acp.ts'
import { codexHooks, type CodexHooks } from './wires/codex-hooks.ts'
import { clip } from './mapping.ts'
import { RPC, RpcError } from './protocol.ts'

export const CODEX_MODEL_ID = 'model'
export const CODEX_EFFORT_ID = 'reasoning_effort'
/** Codex's speed: `serviceTier` on a turn, from the tiers `model/list` names for each model. */
export const CODEX_TIER_ID = 'service_tier'
/** Standard speed, as `turn/start` takes it ("default"). */
const STANDARD_TIER = 'default'
/** The one faster tier Latch offers: the ID Codex 0.169's `serviceTiers` gives Fast, and the request value of its old `fast`. */
const FAST_TIER = 'priority'
const MAX_PAGES = 5
const MAX_MODELS = 64

const effort = z.object({ reasoningEffort: z.string().min(1).max(64), description: z.string().nullish() })
export const codexModel = z.object({
  id: z.string().min(1).max(256),
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  hidden: z.boolean().nullish(),
  isDefault: z.boolean().nullish(),
  defaultReasoningEffort: z.string().nullish(),
  supportedReasoningEfforts: z.array(effort).nullish().catch(undefined),
  /** The tiers beyond standard this model takes, each with Codex's own words on what it costs. */
  serviceTiers: z
    .array(z.object({ id: z.string().min(1).max(64), name: z.string().max(64).nullish(), description: z.string().max(400).nullish() }))
    .max(16)
    .nullish()
    .catch(undefined),
})
type CodexModel = z.infer<typeof codexModel>
const page = z.object({ data: z.array(z.unknown()), nextCursor: z.string().max(1024).nullish() })
const configured = z.object({
  config: z
    .object({
      model: z.string().max(256).nullish(),
      model_reasoning_effort: z.string().max(64).nullish(),
      service_tier: z.string().max(64).nullish().catch(undefined),
      // Names, whether each is on, and a remote one's address only: never its command, variables or headers.
      mcp_servers: z
        .record(
          z.string(),
          z.object({ enabled: z.boolean().nullish().catch(undefined), url: z.string().max(2048).nullish().catch(undefined) }).passthrough(),
        )
        .nullish()
        .catch(undefined),
    })
    .nullish(),
})
/** Servers Latch lists at most. */
const MAX_SERVERS = 200

/** A remote server's origin, never its path, query or credentials. */
function origin(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const read = new URL(value).origin
    return read === 'null' ? undefined : read
  } catch {
    return undefined
  }
}

export interface CodexModels {
  models: CodexModel[]
  /** What the person's own configuration starts a thread on, when it says. */
  model?: string
  effort?: string
  /** The tier the person's own configuration or the thread is on, as Codex reports it. */
  tier?: string
  /**
   * Codex's own MCP servers by name as its configuration lists them (`config/read`, which starts none of them, unlike a
   * threadless `mcpServerStatus/list`), and the hooks it would run (`hooks/list`). Absent: it did not say.
   */
  own?: { servers: HarnessMcpServer[]; truncated?: true; hooks?: CodexHooks }
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

/** The gateway thinking value that sends no level: the model service's own default. Never a level a service declares. */
export const GATEWAY_DEFAULT_EFFORT = '~default'

/**
 * Codex's thinking on a model of a service, as the levels that service declared for it: 默认, then each level. The wire
 * offers exactly this and the Host projects it to drafts, so a pick before start is a value the session accepts. No
 * declared level: no option, and the service's default applies.
 */
export function gatewayEffortOption(levels: readonly string[] | undefined, current?: string): SessionConfigOption | undefined {
  if (!levels?.length) return undefined
  return {
    id: CODEX_EFFORT_ID,
    name: '思考',
    category: 'thought_level',
    currentValue: current ?? GATEWAY_DEFAULT_EFFORT,
    options: [{ value: GATEWAY_DEFAULT_EFFORT, name: '默认' }, ...levels.map(value => ({ value, name: capitalize(value) }))],
  }
}

function effortOption(entry: CodexModel, current: string | undefined): SessionConfigOption | undefined {
  const efforts = entry.supportedReasoningEfforts ?? []
  if (!efforts.length) return undefined
  const supported = (value: string | null | undefined) =>
    value && efforts.some(item => item.reasoningEffort === value) ? value : undefined
  return {
    id: CODEX_EFFORT_ID,
    name: 'Reasoning effort',
    category: 'thought_level',
    currentValue: supported(current) ?? supported(entry.defaultReasoningEffort) ?? efforts[0]!.reasoningEffort,
    options: efforts.map(item => ({
      value: item.reasoningEffort,
      name: capitalize(item.reasoningEffort),
      ...(item.description ? { description: clip(item.description, 200) } : {}),
    })),
  }
}

/** Codex's word for a tier, as Latch sends it: its old config value `fast` is the request value `priority`. */
export function tierValue(reported: string | null | undefined): string | undefined {
  if (!reported) return undefined
  return reported === 'fast' ? FAST_TIER : reported
}

/** Whether a model takes Codex's Fast tier: only what `model/list` names, never guessed from the model's name. */
export function fastTierOf(entry: Pick<CodexModel, 'serviceTiers'> | undefined): { description?: string } | undefined {
  const tier = entry?.serviceTiers?.find(item => item.id === FAST_TIER)
  return tier ? { ...(tier.description ? { description: clip(tier.description, 200) } : {}) } : undefined
}

/**
 * 速度 for a model that takes the Fast tier: 标准 or 快速, the tier the thread is on chosen. Faster turns use more of the
 * plan; Codex's own sentence on that is the option's description. Other tiers (Ultrafast) are offered only while the
 * thread is already on one.
 */
export function speedOption(entry: CodexModel, current: string | undefined): SessionConfigOption | undefined {
  const fast = fastTierOf(entry)
  if (!fast) return undefined
  const now = tierValue(current) ?? STANDARD_TIER
  // A thread already on another tier (the person's own configuration) says so, and stays a choice until another is made.
  const other = now === STANDARD_TIER || now === FAST_TIER ? undefined : entry.serviceTiers?.find(item => item.id === now)
  return {
    id: CODEX_TIER_ID,
    name: '速度',
    category: 'model_config',
    currentValue: other || now === FAST_TIER ? now : STANDARD_TIER,
    options: [
      { value: STANDARD_TIER, name: '标准' },
      { value: FAST_TIER, name: '快速', ...(fast.description ? { description: fast.description } : {}) },
      ...(other ? [{ value: other.id, name: clip(other.name || other.id, 64) }] : []),
    ],
  }
}

/**
 * The model and thinking options a new session would show, and thinking for every other model. `speed`: only where the
 * session runs Codex's own app-server on its own login (`wires/codex.ts`), the one route that sends a tier.
 */
export function codexOptions(
  listed: CodexModels,
  speed = false,
): {
  options: SessionConfigOption[]
  perModel: Array<{ model: string; options: SessionConfigOption[] }>
} {
  const models = listed.models.filter(entry => !entry.hidden).slice(0, MAX_MODELS)
  if (!models.length) return { options: [], perModel: [] }
  const current = listed.model ?? models.find(entry => entry.isDefault)?.id ?? models[0]!.id
  const choices = models.map(entry => ({
    value: entry.id,
    name: clip(entry.displayName || entry.id, 200),
    ...(entry.description ? { description: clip(entry.description, 200) } : {}),
  }))
  // codex-acp offers a configured model it does not list in the same place.
  if (!models.some(entry => entry.id === current)) choices.unshift({ value: current, name: clip(current, 200) })
  const thinking = (entry: CodexModel) => effortOption(entry, entry.id === current ? listed.effort : undefined)
  const follows = (entry: CodexModel) =>
    [thinking(entry), speed ? speedOption(entry, listed.tier) : undefined].filter(option => option !== undefined)
  const now = models.find(entry => entry.id === current)
  return {
    options: [
      { id: CODEX_MODEL_ID, name: 'Model', category: 'model', currentValue: current, options: choices },
      ...(now ? follows(now) : []),
    ],
    perModel: models.flatMap(entry => {
      const options = follows(entry)
      return options.length ? [{ model: entry.id, options }] : []
    }),
  }
}

/**
 * Starts the app-server, asks for the configuration, the hooks and the model list, and stops it. Requests from it are
 * refused and nothing it sends besides the answers is read; no thread is started, so it runs no tools, hooks or MCP
 * servers (its MCP servers are named from the configuration: Codex 0.170 starts them to answer `mcpServerStatus/list`).
 */
export async function readCodexModels(
  spec: { command: string; args: readonly string[]; cwd: string; env: Record<string, string>; redact: (text: string) => string },
  options: { timeoutMs: number; signal?: AbortSignal; own?: boolean },
): Promise<CodexModels> {
  const connection = AcpWire.spawn(
    { command: spec.command, args: [...spec.args], cwd: spec.cwd, env: spec.env, maxLineBytes: 4 * 1024 * 1024, redact: spec.redact },
    {
      request: async () => {
        throw new RpcError(RPC.methodNotFound, 'Not supported while listing models')
      },
      notification: () => {},
      exit: () => {},
    },
  )
  const request = (method: string, params: unknown) => connection.request(method, params, options.timeoutMs, options.signal)
  try {
    await request('initialize', {
      clientInfo: { name: 'latch', title: 'Latch', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    let model: string | undefined
    let effort: string | undefined
    let tier: string | undefined
    let own: CodexModels['own']
    try {
      const read = configured.safeParse(await request('config/read', { cwd: spec.cwd }))
      model = read.data?.config?.model ?? undefined
      effort = read.data?.config?.model_reasoning_effort ?? undefined
      tier = tierValue(read.data?.config?.service_tier)
      // Only where Latch shows them (Codex's own wire): the adapter's sessions report none of this.
      const servers = options.own && read.success ? Object.entries(read.data.config?.mcp_servers ?? {}) : undefined
      if (servers)
        own = {
          servers: servers.slice(0, MAX_SERVERS).map(([name, server]) => {
            const at = origin(server.url)
            return {
              name: escapeSecurityText(clip(name, 128)),
              state: server.enabled === false ? ('disabled' as const) : ('unknown' as const),
              ...(at ? { origin: at } : {}),
            }
          }),
          ...(servers.length > MAX_SERVERS ? { truncated: true as const } : {}),
        }
    } catch {
      // An older Codex has no config/read; its default model is then the list's.
    }
    if (own) {
      const hooks = codexHooks(await request('hooks/list', {}).catch(() => undefined))
      if (hooks) own.hooks = hooks
    }
    const models: CodexModel[] = []
    let cursor: string | null | undefined = null
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const parsed = page.safeParse(await request('model/list', { cursor }))
      if (!parsed.success) throw new Error('Codex 的模型列表格式无效')
      for (const entry of parsed.data.data) {
        const item = codexModel.safeParse(entry)
        if (item.success) models.push(item.data)
      }
      cursor = parsed.data.nextCursor
      if (!cursor || models.length >= MAX_MODELS) break
    }
    return { models, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(tier ? { tier } : {}), ...(own ? { own } : {}) }
  } finally {
    await connection.stop('kill', 0)
  }
}
