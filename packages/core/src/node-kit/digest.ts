import { createHash } from 'node:crypto'

/** Strings are hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex')
}

/**
 * Deterministic JSON: object keys sorted recursively by UTF-16 code unit, no whitespace, primitives as
 * `JSON.stringify` writes them (so U+202E and other non-ASCII characters stay raw). Undefined object members
 * are dropped; anything JSON cannot represent unambiguously throws.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set())
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`)
  }
  const object = value as object
  if (seen.has(object)) throw new TypeError('canonicalJson: circular structure')
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      return `[${object
        .map(item => {
          if (item === undefined) throw new TypeError('canonicalJson: undefined array element')
          return encode(item, seen)
        })
        .join(',')}]`
    }
    const withJson = object as { toJSON?: () => unknown }
    if (typeof withJson.toJSON === 'function') return encode(withJson.toJSON(), seen)
    const record = object as Record<string, unknown>
    const members = Object.keys(record)
      .sort()
      .flatMap(key => (record[key] === undefined ? [] : [`${JSON.stringify(key)}:${encode(record[key], seen)}`]))
    return `{${members.join(',')}}`
  } finally {
    seen.delete(object)
  }
}
