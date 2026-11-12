/**
 * Codex's own model list, read from its app-server without a thread, in the shape codex-acp gives a session's options:
 * the same option IDs and values, so a draft's pick applies to the session that follows.
 */
import { z } from 'zod'
import type { SessionConfigOption } from '@latch/protocol'
import { AcpWire } from './wires/acp.ts'
import { clip } from './mapping.ts'
import { RPC, RpcError } from './protocol.ts'

export const CODEX_MODEL_ID = 'model'
export const CODEX_EFFORT_ID = 'reasoning_effort'
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
})
type CodexModel = z.infer<typeof codexModel>
const page = z.object({ data: z.array(z.unknown()), nextCursor: z.string().max(1024).nullish() })
const configured = z.object({
  config: z.object({ model: z.string().max(256).nullish(), model_reasoning_effort: z.string().max(64).nullish() }).nullish(),
})

export interface CodexModels {
  models: CodexModel[]
  /** What the person's own configuration starts a thread on, when it says. */
  model?: string
  effort?: string
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

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

/** The model and thinking options a new session would show, and thinking for every other model. */
export function codexOptions(listed: CodexModels): {
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
  const now = models.find(entry => entry.id === current)
  const nowThinking = now && thinking(now)
  return {
    options: [
      { id: CODEX_MODEL_ID, name: 'Model', category: 'model', currentValue: current, options: choices },
      ...(nowThinking ? [nowThinking] : []),
    ],
    perModel: models.flatMap(entry => {
      const option = thinking(entry)
      return option ? [{ model: entry.id, options: [option] }] : []
    }),
  }
}

/**
 * Starts the app-server, asks for the configuration and the model list, and stops it. Requests from it are refused and
 * nothing it sends besides the answers is read; no thread is started, so it runs no tools, hooks or MCP servers.
 */
export async function readCodexModels(
  spec: { command: string; args: readonly string[]; cwd: string; env: Record<string, string>; redact: (text: string) => string },
  options: { timeoutMs: number; signal?: AbortSignal },
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
    try {
      const read = configured.safeParse(await request('config/read', { cwd: spec.cwd }))
      model = read.data?.config?.model ?? undefined
      effort = read.data?.config?.model_reasoning_effort ?? undefined
    } catch {
      // An older Codex has no config/read; its default model is then the list's.
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
    return { models, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  } finally {
    await connection.stop('kill', 0)
  }
}
