import { z } from 'zod'
import { CODEX_FALLBACK_INSTRUCTIONS } from './codex-fallback.ts'

/** The context window a routed session tells Codex when neither the person nor the service gave the model's. */
export const CODEX_ROUTE_CONTEXT = 512_000
/** Entries added for a service's models: each repeats the instructions, so a long list is cut to the first ones. */
const MAX_ADDED = 32

const bundled = z.object({ models: z.array(z.looseObject({ slug: z.string().min(1).max(256) })).max(512) })

/**
 * Codex's bundled model catalog (`codex debug models --bundled`) with an entry for each of the service's models it does
 * not know, the session's own first. Codex holds a model it has no entry for to 272,000 tokens whatever the thread
 * says, and a catalog replaces the bundled one, so the bundled entries are kept as they are. An added entry is Codex's
 * own fallback (instructions, tools, truncation) with the window the person or the service gave, else
 * `CODEX_ROUTE_CONTEXT`. Undefined: the output is not a catalog, or nothing is to add.
 */
export function codexRouteCatalog(
  stdout: string,
  models: ReadonlyArray<{ id: string; contextTokens?: number }>,
  first: string,
): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const read = bundled.safeParse(parsed)
  if (!read.success) return undefined
  const known = new Set(read.data.models.map(model => model.slug))
  const added = [...models]
    .sort((a, b) => Number(b.id === first) - Number(a.id === first))
    .filter(model => !known.has(model.id))
    .slice(0, MAX_ADDED)
    .map(model => {
      const window = model.contextTokens ?? CODEX_ROUTE_CONTEXT
      return {
        slug: model.id,
        display_name: model.id,
        supported_reasoning_levels: [],
        shell_type: 'default',
        visibility: 'none',
        supported_in_api: true,
        priority: 99,
        base_instructions: CODEX_FALLBACK_INSTRUCTIONS,
        support_verbosity: false,
        truncation_policy: { mode: 'bytes', limit: 10_000 },
        context_window: window,
        max_context_window: window,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
      }
    })
  if (!added.length) return undefined
  return JSON.stringify({ models: [...read.data.models, ...added] })
}
