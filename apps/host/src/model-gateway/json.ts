import { invalidReply, object } from './ir.ts'

function validateArguments(value: unknown, redact: (text: string) => string, depth = 0): void {
  if (depth > 64) throw invalidReply('工具参数嵌套过深')
  if (typeof value === 'number' && !Number.isFinite(value)) throw invalidReply('工具参数包含不可表示的数值')
  if (Array.isArray(value)) {
    for (const item of value) validateArguments(item, redact, depth + 1)
    return
  }
  const fields = object(value)
  if (!fields) return
  const keys = new Set<string>()
  for (const [key, item] of Object.entries(fields)) {
    const safe = redact(key)
    if (keys.has(safe)) throw invalidReply('脱敏后的工具参数名称冲突')
    keys.add(safe)
    validateArguments(item, redact, depth + 1)
  }
}

/** Parse for structural validation, then change only string tokens: numeric spelling must survive a round trip. */
export function checkedArguments(source: string, redact: (text: string) => string): { fields: Record<string, unknown>; json: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw invalidReply('工具参数不是完整 JSON')
  }
  const fields = object(parsed)
  if (!fields) throw invalidReply('工具参数不是 JSON 对象')
  validateArguments(fields, redact)
  const json = source.replace(/"(?:[^"\\]|\\.)*"/gu, token => {
    const value = JSON.parse(token) as string
    const safe = redact(value)
    return safe === value ? token : JSON.stringify(safe)
  })
  return { fields, json }
}

// Node 24 provides the standardized parse source context and rawJSON. Keep their types local to this Node-only module
// while the shared project's ECMAScript baseline stays older. rawJSON is used only for numeric tokens, never objects.
const jsonWithSource = JSON as typeof JSON & {
  parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown
  rawJSON(text: string): unknown
}

/** Preserve JSON numbers when moving between an object-valued protocol field and a JSON-string-valued one. */
export function exactJson(source: string): unknown {
  return jsonWithSource.parse(source, (_key: string, value: unknown, context: { source?: string }) => {
    if (typeof value !== 'number') return value
    if (!Number.isFinite(value) || !context.source) throw invalidReply('工具参数包含不可表示的数值')
    return jsonWithSource.rawJSON(context.source)
  })
}
